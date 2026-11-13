/**
 * Canvas Renderer — Issue #14.
 *
 * Renders training runs on HTML5 Canvas while defending Data Truthfulness:
 *   1. Path breaks at every non-finite point (NaN, ±Infinity) and step gap.
 *      Explicit markers are drawn at these locations so missing data is never hidden.
 *   2. The smoothed curve (EMA) is always drawn over the raw min-max envelope,
 *      ensuring variance and spikes are visible even with aggressive smoothing.
 *   3. Rendering is crisp on high-DPI screens via devicePixelRatio backing-store scaling.
 *   4. GATE: No non-finite coordinate (NaN, Infinity, -Infinity) EVER reaches lineTo or moveTo.
 */

import { createLinearScale, createLogScale } from './scale.js'
import { downsample } from './downsample.js'

// ---------------------------------------------------------------------------
// High-DPI Canvas Setup
// ---------------------------------------------------------------------------

/**
 * Configure an HTML5 Canvas for crisp high-DPI rendering.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {number} [dpr]
 * @returns {CanvasRenderingContext2D}
 */
export function setupCanvas(canvas, cssWidth, cssHeight, dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1) {
  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`

  const ctx = canvas.getContext('2d')
  if (ctx && typeof ctx.scale === 'function') {
    ctx.scale(dpr, dpr)
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Smoothing (EMA)
// ---------------------------------------------------------------------------

/**
 * Compute Exponential Moving Average (EMA) over a series.
 * Resets at non-finite points and gaps to prevent false interpolation.
 *
 * @param {ArrayLike<number>} steps
 * @param {ArrayLike<number>} values
 * @param {number} [weight=0.8] - Smoothing weight in [0, 1)
 * @returns {Float64Array}
 */
export function computeEMA(steps, values, weight = 0.8) {
  const n = values.length
  const out = new Float64Array(n)
  if (n === 0) return out

  let ema = null

  for (let i = 0; i < n; i++) {
    const v = values[i]
    const isGap = i > 0 && steps[i] - steps[i - 1] > 1

    if (!Number.isFinite(v) || isGap) {
      // Reset smoothing across gaps and non-finite values
      ema = null
      out[i] = v
      continue
    }

    if (ema === null) {
      ema = v
    } else {
      ema = ema * weight + v * (1 - weight)
    }
    out[i] = ema
  }

  return out
}

// ---------------------------------------------------------------------------
// Chart Renderer
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RenderOptions
 * @property {number} width - CSS width of the chart
 * @property {number} height - CSS height of the chart
 * @property {object} margins - { top, right, bottom, left }
 * @property {'linear' | 'log'} [scaleType='linear'] - Y-axis scale type
 * @property {number} [smoothing=0.8] - Smoothing weight for EMA line (0 = raw only)
 * @property {[number, number]} [xRange] - Optional zoom/pan window [xMin, xMax]
 * @property {[number, number]} [yRange] - Optional fixed Y domain [yMin, yMax]
 * @property {string} [theme='light']
 */

const DEFAULT_MARGINS = { top: 20, right: 30, bottom: 40, left: 60 }

/**
 * Render a complete training-run chart to a Canvas 2D context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} series - Sanitized series with { steps, values, anomaly }
 * @param {RenderOptions} options
 */
export function renderChart(ctx, series, options = {}) {
  const width = options.width || 800
  const height = options.height || 400
  const margins = { ...DEFAULT_MARGINS, ...(options.margins || {}) }
  const scaleType = options.scaleType || 'linear'
  const smoothing = typeof options.smoothing === 'number' ? options.smoothing : 0.8
  const xRange = options.xRange
  const theme = options.theme || 'light'

  const plotW = Math.max(10, width - margins.left - margins.right)
  const plotH = Math.max(10, height - margins.top - margins.bottom)

  // 1. Downsample for plotting area
  const decimated = downsample({
    steps: series.steps,
    values: series.values,
    anomaly: series.anomaly,
    targetWidth: plotW,
    xRange,
  })

  // Clear canvas
  ctx.clearRect(0, 0, width, height)

  if (decimated.length === 0) {
    drawEmptyState(ctx, width, height, theme)
    return { xScale: null, yScale: null, decimated }
  }

  // 2. Compute scales
  // X Domain: from xRange or decimated steps
  const xMin = xRange ? xRange[0] : decimated.steps[0]
  const xMax = xRange ? xRange[1] : decimated.steps[decimated.length - 1]

  const xScale = createLinearScale({
    domain: [xMin, xMax],
    range: [margins.left, margins.left + plotW],
  })

  // Y Domain: compute from finite values in decimated stream
  let yMin = Infinity
  let yMax = -Infinity

  for (let i = 0; i < decimated.length; i++) {
    const v = decimated.values[i]
    if (Number.isFinite(v)) {
      if (scaleType === 'log') {
        if (v > 0) {
          if (v < yMin) yMin = v
          if (v > yMax) yMax = v
        }
      } else {
        if (v < yMin) yMin = v
        if (v > yMax) yMax = v
      }
    }
  }

  // If no plottable values exist
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    yMin = scaleType === 'log' ? 0.01 : 0
    yMax = 1
  }

  if (yMin === yMax) {
    if (scaleType === 'log') {
      yMin = yMin * 0.5
      yMax = yMax * 2
    } else {
      yMin = yMin - 1
      yMax = yMax + 1
    }
  }

  // Add small padding to Y domain for aesthetics
  if (scaleType === 'linear') {
    const pad = (yMax - yMin) * 0.05
    yMin = Math.max(0, yMin - pad) // Loss is typically non-negative
    yMax = yMax + pad
  }

  const yScale = scaleType === 'log'
    ? createLogScale({
        domain: [yMin, yMax],
        range: [margins.top + plotH, margins.top],
      })
    : createLinearScale({
        domain: [yMin, yMax],
        range: [margins.top + plotH, margins.top],
      })

  // 3. Render Grid & Axes
  renderGridAndAxes(ctx, xScale, yScale, margins, plotW, plotH, theme)

  // 4. Render Raw Min-Max Envelope (underneath the lines)
  renderEnvelope(ctx, decimated.envelope, xScale, yScale)

  // 5. Render Raw Series Line with gap & non-finite breaks
  renderBrokenLine(ctx, decimated.steps, decimated.values, xScale, yScale, {
    color: 'rgba(59, 130, 246, 0.45)', // subtle raw line
    lineWidth: 1,
  })

  // 6. Render Smoothed EMA Curve (drawn over the envelope)
  if (smoothing > 0) {
    const smoothedValues = computeEMA(decimated.steps, decimated.values, smoothing)
    renderBrokenLine(ctx, decimated.steps, smoothedValues, xScale, yScale, {
      color: '#2563eb', // bold primary curve
      lineWidth: 2,
    })
  }

  // 7. Render Gap breaks and Non-finite Markers
  renderMarkers(ctx, decimated.steps, decimated.values, decimated.anomaly, xScale, yScale, margins, plotH)

  return { xScale, yScale, decimated }
}

// ---------------------------------------------------------------------------
// Internal Drawing Routines
// ---------------------------------------------------------------------------

function drawEmptyState(ctx, width, height, theme) {
  ctx.save()
  ctx.fillStyle = theme === 'dark' ? '#94a3b8' : '#64748b'
  ctx.font = '14px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('No plottable points in current window', width / 2, height / 2)
  ctx.restore()
}

/**
 * Render grid lines, ticks, and axis labels.
 */
function renderGridAndAxes(ctx, xScale, yScale, margins, plotW, plotH, theme) {
  ctx.save()
  const isDark = theme === 'dark'
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)'
  const textColor = isDark ? '#94a3b8' : '#64748b'
  const axisColor = isDark ? '#475569' : '#cbd5e1'

  // X Ticks & vertical grid
  const xTicks = xScale.ticks(6)
  ctx.font = '11px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'

  for (const t of xTicks) {
    const px = xScale.scale(t)
    if (px === null || !Number.isFinite(px)) continue

    // Vertical grid line
    ctx.strokeStyle = gridColor
    ctx.beginPath()
    ctx.moveTo(px, margins.top)
    ctx.lineTo(px, margins.top + plotH)
    ctx.stroke()

    // X Tick label
    ctx.fillStyle = textColor
    ctx.fillText(xScale.tickFormat(t), px, margins.top + plotH + 6)
  }

  // Y Ticks & horizontal grid
  const yTicks = yScale.ticks(5)
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'

  for (const t of yTicks) {
    const py = yScale.scale(t)
    if (py === null || !Number.isFinite(py)) continue

    // Horizontal grid line
    ctx.strokeStyle = gridColor
    ctx.beginPath()
    ctx.moveTo(margins.left, py)
    ctx.lineTo(margins.left + plotW, py)
    ctx.stroke()

    // Y Tick label
    ctx.fillStyle = textColor
    ctx.fillText(yScale.tickFormat(t), margins.left - 8, py)
  }

  // Outer plot frame
  ctx.strokeStyle = axisColor
  ctx.lineWidth = 1
  ctx.strokeRect(margins.left, margins.top, plotW, plotH)

  ctx.restore()
}

/**
 * Render raw min-max envelope band.
 */
function renderEnvelope(ctx, env, xScale, yScale) {
  if (!env || env.length < 2) return

  ctx.save()
  ctx.fillStyle = 'rgba(59, 130, 246, 0.12)' // Translucent blue band

  ctx.beginPath()
  let inPath = false

  // Forward along maxs
  for (let i = 0; i < env.length; i++) {
    const px = xScale.scale(env.steps[i])
    const pyMax = yScale.scale(env.maxs[i])

    if (px !== null && pyMax !== null && Number.isFinite(px) && Number.isFinite(pyMax)) {
      if (!inPath) {
        ctx.moveTo(px, pyMax)
        inPath = true
      } else {
        ctx.lineTo(px, pyMax)
      }
    }
  }

  // Backward along mins
  for (let i = env.length - 1; i >= 0; i--) {
    const px = xScale.scale(env.steps[i])
    const pyMin = yScale.scale(env.mins[i])

    if (px !== null && pyMin !== null && Number.isFinite(px) && Number.isFinite(pyMin)) {
      ctx.lineTo(px, pyMin)
    }
  }

  if (inPath) {
    ctx.closePath()
    ctx.fill()
  }

  ctx.restore()
}

/**
 * Render a line series breaking paths at non-finite values and step gaps.
 * Strictly guarantees that no non-finite coordinate ever reaches lineTo or moveTo.
 */
function renderBrokenLine(ctx, steps, values, xScale, yScale, { color, lineWidth }) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  let inPath = false

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const v = values[i]

    const isGap = i > 0 && steps[i] - steps[i - 1] > 1
    const px = xScale.scale(s)
    const py = yScale.scale(v)

    const isValid =
      px !== null &&
      py !== null &&
      Number.isFinite(px) &&
      Number.isFinite(py)

    if (!isValid || isGap) {
      if (inPath) {
        ctx.stroke()
        inPath = false
      }
    }

    if (isValid) {
      if (!inPath) {
        ctx.beginPath()
        ctx.moveTo(px, py)
        inPath = true
      } else {
        ctx.lineTo(px, py)
      }
    }
  }

  if (inPath) {
    ctx.stroke()
  }

  ctx.restore()
}

/**
 * Draw explicit markers for non-finite points (NaN, ±Infinity), gaps, and anomalies.
 */
function renderMarkers(ctx, steps, values, anomaly, xScale, yScale, margins, plotH) {
  ctx.save()

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const v = values[i]
    const a = anomaly ? anomaly[i] : 0
    const px = xScale.scale(s)

    if (px === null || !Number.isFinite(px)) continue

    // 1. Non-finite marker (NaN or ±Infinity)
    if (!Number.isFinite(v)) {
      const isNaNVal = Number.isNaN(v)
      const badgeText = isNaNVal ? 'NaN' : v > 0 ? '+∞' : '-∞'
      const markerColor = isNaNVal ? '#ef4444' : '#f59e0b'

      // Dashed vertical line across plot area indicating missing/infinite point
      ctx.strokeStyle = markerColor
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(px, margins.top)
      ctx.lineTo(px, margins.top + plotH)
      ctx.stroke()
      ctx.setLineDash([])

      // Badge at top of the line
      ctx.fillStyle = markerColor
      ctx.fillRect(px - 12, margins.top + 2, 24, 14)
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 9px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(badgeText, px, margins.top + 9)
    }

    // 2. Step gap indicator
    if (i > 0 && steps[i] - steps[i - 1] > 1) {
      const prevPx = xScale.scale(steps[i - 1])
      if (prevPx !== null && Number.isFinite(prevPx)) {
        // Shaded gap region
        ctx.fillStyle = 'rgba(239, 68, 68, 0.07)'
        ctx.fillRect(prevPx, margins.top, px - prevPx, plotH)

        // Dotted boundary line
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)'
        ctx.setLineDash([2, 4])
        ctx.beginPath()
        ctx.moveTo(px, margins.top)
        ctx.lineTo(px, margins.top + plotH)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    // 3. Anomaly marker (outlier spikes, collisions)
    if (a === 1 && Number.isFinite(v)) {
      const py = yScale.scale(v)
      if (py !== null && Number.isFinite(py)) {
        // Draw diamond marker
        ctx.fillStyle = '#ef4444' // Red/amber
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.5

        ctx.beginPath()
        ctx.moveTo(px, py - 5)
        ctx.lineTo(px + 5, py)
        ctx.lineTo(px, py + 5)
        ctx.lineTo(px - 5, py)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }
    }
  }

  ctx.restore()
}
