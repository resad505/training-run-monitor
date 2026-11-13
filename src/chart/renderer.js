/**
 * Canvas Renderer — Issue #14.
 *
 * Renders training runs on HTML5 Canvas while defending Data Truthfulness:
 *   1. Path breaks at every non-finite point (NaN, ±Infinity) and step gap,
 *      using the downsampler's explicit break flags (never by comparing
 *      decimated step indices). Explicit markers are drawn at these locations
 *      so missing data is never hidden. Finite values that a log scale cannot
 *      plot (<= 0) get their own marker.
 *   2. The smoothed curve (EMA) is computed on the RAW series — so it does not
 *      change with zoom level — and is always drawn over the raw min-max
 *      envelope, ensuring variance and spikes stay visible.
 *   3. Rendering is crisp on high-DPI screens via devicePixelRatio backing-store scaling.
 *   4. GATE: No non-finite coordinate (NaN, Infinity, -Infinity) EVER reaches lineTo or moveTo.
 */

import { createLinearScale, createLogScale } from './scale.js'
import { downsample } from './downsample.js'
import { ANOMALY, EXPECTED_STRIDE } from '../pipeline/sanitizer.js'

/** Anomaly kinds drawn as a diamond on the point (gaps/non-finite have their own markers). */
const DIAMOND_FLAGS = ANOMALY.OUTLIER | ANOMALY.COLLISION | ANOMALY.PLATEAU

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
  // setTransform (not scale) so repeated calls on resize never compound.
  if (ctx && typeof ctx.setTransform === 'function') {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  } else if (ctx && typeof ctx.scale === 'function') {
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
    const isGap = i > 0 && steps[i] - steps[i - 1] > EXPECTED_STRIDE

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

/** EMA of the raw series, cached per (values buffer, weight). */
const emaCache = new WeakMap()

function rawEMA(series, weight) {
  let byWeight = emaCache.get(series.values)
  if (!byWeight) {
    byWeight = new Map()
    emaCache.set(series.values, byWeight)
  }
  if (!byWeight.has(weight)) byWeight.set(weight, computeEMA(series.steps, series.values, weight))
  return byWeight.get(weight)
}

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

  const geometry = { margins, plotW, plotH }

  if (decimated.length === 0) {
    drawEmptyState(ctx, width, height, theme)
    return { xScale: null, yScale: null, decimated, ...geometry }
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

  // Add small padding to Y domain for aesthetics. Only clamp at 0 when the
  // data itself is non-negative, so negative values are never pushed off-plot.
  if (scaleType === 'linear') {
    const pad = (yMax - yMin) * 0.05
    yMin = yMin >= 0 ? Math.max(0, yMin - pad) : yMin - pad
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

  // Everything data-driven is clipped to the plot area (the window includes
  // one extra point per side so lines reach the edges).
  ctx.save()
  ctx.beginPath()
  ctx.rect(margins.left, margins.top, plotW, plotH)
  ctx.clip()

  // 4. Render Raw Min-Max Envelope (underneath the lines)
  renderEnvelope(ctx, decimated.envelope, xScale, yScale)

  // 5. Render Raw Series Line with gap & non-finite breaks
  renderBrokenLine(ctx, decimated, decimated.values, xScale, yScale, {
    color: 'rgba(59, 130, 246, 0.45)', // subtle raw line
    lineWidth: 1,
  })

  // 6. Render Smoothed EMA Curve (computed on raw data, drawn over the envelope)
  let smoothed = null
  if (smoothing > 0) {
    const ema = rawEMA(series, smoothing)
    smoothed = Float64Array.from(decimated.index, (i) => ema[i])
    renderBrokenLine(ctx, decimated, smoothed, xScale, yScale, {
      color: '#2563eb', // bold primary curve
      lineWidth: 2,
    })
  }

  // 7. Render Gap breaks, Non-finite / non-plottable and Anomaly Markers
  renderMarkers(ctx, decimated, xScale, yScale, margins, plotH)

  ctx.restore()

  return { xScale, yScale, decimated, smoothed, ...geometry }
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
 * Render raw min-max envelope band, one closed polygon per segment so the
 * band is never filled across a gap or a non-finite point.
 */
function renderEnvelope(ctx, env, xScale, yScale) {
  if (!env || env.length < 2) return

  ctx.save()
  ctx.fillStyle = 'rgba(59, 130, 246, 0.12)' // Translucent blue band

  let segStart = 0
  for (let i = 1; i <= env.length; i++) {
    if (i < env.length && !env.breakBefore[i]) continue
    fillEnvelopeSegment(ctx, env, segStart, i - 1, xScale, yScale)
    segStart = i
  }

  ctx.restore()
}

function fillEnvelopeSegment(ctx, env, from, to, xScale, yScale) {
  const upper = []
  const lower = []
  for (let i = from; i <= to; i++) {
    const px = xScale.scale(env.steps[i])
    const pyMax = yScale.scale(env.maxs[i])
    const pyMin = yScale.scale(env.mins[i])
    if (px === null || pyMax === null || pyMin === null) continue
    upper.push([px, pyMax])
    lower.push([px, pyMin])
  }
  if (upper.length < 2) return

  ctx.beginPath()
  ctx.moveTo(upper[0][0], upper[0][1])
  for (let k = 1; k < upper.length; k++) ctx.lineTo(upper[k][0], upper[k][1])
  for (let k = lower.length - 1; k >= 0; k--) ctx.lineTo(lower[k][0], lower[k][1])
  ctx.closePath()
  ctx.fill()
}

/**
 * Render a line series breaking paths at non-finite values and step gaps.
 * Breaks come from the downsampler's explicit `breakBefore` flags.
 * Strictly guarantees that no non-finite coordinate ever reaches lineTo or moveTo.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ steps: ArrayLike<number>, breakBefore: ArrayLike<number> }} points
 * @param {ArrayLike<number>} values
 */
function renderBrokenLine(ctx, points, values, xScale, yScale, { color, lineWidth }) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  let inPath = false

  for (let i = 0; i < points.length; i++) {
    const px = xScale.scale(points.steps[i])
    const py = yScale.scale(values[i])
    const isValid = px !== null && py !== null

    if ((!isValid || points.breakBefore[i]) && inPath) {
      ctx.stroke()
      inPath = false
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
 * Draw explicit markers for non-finite points (NaN, ±Infinity), values a log
 * scale cannot plot (<= 0), step gaps, and anomalies.
 */
function renderMarkers(ctx, points, xScale, yScale, margins, plotH) {
  ctx.save()
  const { steps, values, anomaly, gapBefore } = points

  for (let i = 0; i < points.length; i++) {
    const v = values[i]
    const a = anomaly[i]
    const px = xScale.scale(steps[i])
    if (px === null) continue

    // 1. Non-finite marker (NaN or ±Infinity), or finite but not plottable (log <= 0)
    const notPlottable = Number.isFinite(v) && !yScale.isPlottable(v)
    if (!Number.isFinite(v) || notPlottable) {
      const isNaNVal = Number.isNaN(v)
      const badgeText = notPlottable ? '≤0' : isNaNVal ? 'NaN' : v > 0 ? '+∞' : '-∞'
      const markerColor = isNaNVal ? '#ef4444' : notPlottable ? '#8b5cf6' : '#f59e0b'
      drawVerticalBadge(ctx, px, badgeText, markerColor, margins, plotH)
    }

    // 2. Step gap indicator (shade from the last point before the gap)
    if (gapBefore[i] && i > 0) {
      const prevPx = xScale.scale(steps[i - 1])
      if (prevPx !== null) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.07)'
        ctx.fillRect(prevPx, margins.top, px - prevPx, plotH)

        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)'
        ctx.lineWidth = 1
        ctx.setLineDash([2, 4])
        ctx.beginPath()
        ctx.moveTo(px, margins.top)
        ctx.lineTo(px, margins.top + plotH)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    // 3. Anomaly marker (outliers, collisions, plateaus)
    if (a & DIAMOND_FLAGS) {
      const py = yScale.scale(v)
      if (py !== null) {
        ctx.fillStyle = '#ef4444'
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

function drawVerticalBadge(ctx, px, text, color, margins, plotH) {
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(px, margins.top)
  ctx.lineTo(px, margins.top + plotH)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.fillStyle = color
  ctx.fillRect(px - 12, margins.top + 2, 24, 14)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 9px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, px, margins.top + 9)
}
