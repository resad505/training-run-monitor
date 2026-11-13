/**
 * Chart Interactions — Issue #15.
 *
 * Provides zoom, pan, crosshair inspection, and keyboard controls.
 *
 * Guarantees (Issue #15 acceptance criteria):
 *   1. Wheel/drag and keyboard zoom, pan, and reset.
 *   2. The crosshair reports the RAW value from the original dataset,
 *      never the decimated/bucket value. When one pixel covers several raw
 *      points it also reports their raw min/max and anomaly flags, so a spike
 *      under the cursor is never hidden behind its neighbour's value.
 *   3. Canvas has an accessible name and a live text alternative for the
 *      inspected point; points can be inspected from the keyboard
 *      (Shift+Arrow steps through points, [ and ] jump between anomalies).
 */

import { binarySearchFirstGe, binarySearchLastLe } from './downsample.js'
import { formatInteger, formatTickNumber } from '../formatters.js'
import { ANOMALY } from '../pipeline/sanitizer.js'

const ANOMALY_NAMES = [
  [ANOMALY.NON_FINITE, 'non-finite value'],
  [ANOMALY.OUTLIER, 'outlier'],
  [ANOMALY.COLLISION, 'duplicate step'],
  [ANOMALY.GAP, 'gap before this step'],
  [ANOMALY.PLATEAU, 'plateau'],
]

/**
 * Human-readable list of the anomaly kinds set in a flag bitmask.
 * @param {number} flags
 * @returns {string} '' when clean
 */
export function describeAnomaly(flags) {
  return ANOMALY_NAMES.filter(([bit]) => flags & bit)
    .map(([, name]) => name)
    .join(', ')
}

const KEY_HELP =
  'Arrow keys pan, Up and Down zoom, Home resets. ' +
  'Shift with Left or Right steps through points, [ and ] jump to the previous or next anomaly, Escape clears.'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the nearest index in a sorted steps array.
 *
 * @param {ArrayLike<number>} steps
 * @param {number} target
 * @returns {number}
 */
export function binarySearchNearest(steps, target) {
  const n = steps.length
  if (n === 0) return -1
  if (n === 1) return 0

  const geIdx = binarySearchFirstGe(steps, target)
  if (geIdx === 0) return 0
  if (geIdx >= n) return n - 1

  const distBefore = Math.abs(steps[geIdx - 1] - target)
  const distAfter = Math.abs(steps[geIdx] - target)
  return distBefore <= distAfter ? geIdx - 1 : geIdx
}

/**
 * Format a metric value for crosshair display.
 *
 * @param {number} val
 * @returns {string}
 */
export function formatMetricValue(val) {
  if (Number.isNaN(val)) return 'NaN (Dropout)'
  if (val === Infinity) return '+Infinity'
  if (val === -Infinity) return '-Infinity'
  return formatTickNumber(val)
}

// ---------------------------------------------------------------------------
// View State Controller
// ---------------------------------------------------------------------------

/**
 * Create a state controller for zoom and pan.
 *
 * @param {[number, number]} fullRange - [xMin, xMax]
 * @returns {ViewStateController}
 */
export function createViewState(fullRange) {
  const [fMin, fMax] = fullRange
  const minSpan = Math.min(5, Math.max(1, (fMax - fMin) / 1000))
  let currentRange = [fMin, fMax]

  function getRange() {
    return [currentRange[0], currentRange[1]]
  }

  function reset() {
    currentRange = [fMin, fMax]
    return getRange()
  }

  function pan(deltaSteps) {
    const span = currentRange[1] - currentRange[0]
    let new0 = currentRange[0] + deltaSteps
    let new1 = currentRange[1] + deltaSteps

    if (new0 < fMin) {
      new0 = fMin
      new1 = new0 + span
    }
    if (new1 > fMax) {
      new1 = fMax
      new0 = new1 - span
    }

    currentRange = [Math.max(fMin, new0), Math.min(fMax, new1)]
    return getRange()
  }

  function zoomAt(centerStep, factor) {
    const span = currentRange[1] - currentRange[0]
    const targetSpan = Math.max(minSpan, Math.min(fMax - fMin, span * factor))

    const ratio = span > 0 ? (centerStep - currentRange[0]) / span : 0.5
    let new0 = centerStep - ratio * targetSpan
    let new1 = new0 + targetSpan

    if (new0 < fMin) {
      new0 = fMin
      new1 = new0 + targetSpan
    }
    if (new1 > fMax) {
      new1 = fMax
      new0 = new1 - targetSpan
    }

    currentRange = [Math.max(fMin, new0), Math.min(fMax, new1)]
    return getRange()
  }

  function isZoomed() {
    return currentRange[0] > fMin || currentRange[1] < fMax
  }

  return {
    getRange,
    reset,
    pan,
    zoomAt,
    isZoomed,
    fullRange: [fMin, fMax],
  }
}

// ---------------------------------------------------------------------------
// Crosshair & Raw Point Inspection
// ---------------------------------------------------------------------------

/**
 * Build the crosshair record for one raw index. When `xScale` is given, also
 * summarise every raw point that falls in the same screen pixel.
 *
 * @param {object} rawSeries - { steps, values, anomaly }
 * @param {number} rawIdx
 * @param {object} [xScale]
 * @returns {{ step: number, value: number, anomaly: number, rawIndex: number,
 *            pixel: null | { count: number, min: number, max: number, anomaly: number } }}
 */
export function rawPointAt(rawSeries, rawIdx, xScale) {
  const point = {
    step: rawSeries.steps[rawIdx],
    value: rawSeries.values[rawIdx], // RAW value from original dataset!
    anomaly: rawSeries.anomaly ? rawSeries.anomaly[rawIdx] : 0,
    rawIndex: rawIdx,
    pixel: null,
  }

  const px = xScale ? xScale.scale(point.step) : null
  if (px === null) return point

  const s0 = xScale.invert(px - 0.5)
  const s1 = xScale.invert(px + 0.5)
  if (s0 === null || s1 === null) return point
  const lo = binarySearchFirstGe(rawSeries.steps, Math.min(s0, s1))
  const hi = binarySearchLastLe(rawSeries.steps, Math.max(s0, s1))
  if (hi - lo < 1) return point

  let min = Infinity
  let max = -Infinity
  let flags = 0
  for (let i = lo; i <= hi; i++) {
    const v = rawSeries.values[i]
    if (Number.isFinite(v)) {
      if (v < min) min = v
      if (v > max) max = v
    }
    if (rawSeries.anomaly) flags |= rawSeries.anomaly[i]
  }
  point.pixel = { count: hi - lo + 1, min, max, anomaly: flags }
  return point
}

/**
 * Inspect raw data at a given mouse pixel X.
 *
 * @param {number} mousePx
 * @param {object} xScale - Active scale mapping steps to pixels
 * @param {object} rawSeries - Original un-decimated series { steps, values, anomaly }
 * @returns {null | ReturnType<typeof rawPointAt>}
 */
export function inspectRawPoint(mousePx, xScale, rawSeries) {
  if (!xScale || !rawSeries || !rawSeries.steps || rawSeries.steps.length === 0) {
    return null
  }

  const targetStep = xScale.invert(mousePx)
  if (targetStep === null || !Number.isFinite(targetStep)) {
    return null
  }

  const rawIdx = binarySearchNearest(rawSeries.steps, targetStep)
  if (rawIdx < 0 || rawIdx >= rawSeries.steps.length) {
    return null
  }

  return rawPointAt(rawSeries, rawIdx, xScale)
}

/**
 * Text alternative for an inspected point (also used for the tooltip).
 * @param {ReturnType<typeof rawPointAt>} info
 * @returns {string}
 */
export function describePoint(info) {
  let text = `Step ${formatInteger(info.step)}: value ${formatMetricValue(info.value)}`
  const kinds = describeAnomaly(info.anomaly)
  if (kinds) text += ` (anomaly: ${kinds})`
  if (info.pixel) {
    const { count, min, max, anomaly } = info.pixel
    const range = Number.isFinite(min) ? `${formatMetricValue(min)} to ${formatMetricValue(max)}` : 'no finite values'
    text += `. This pixel covers ${formatInteger(count)} points, range ${range}`
    const pixelKinds = describeAnomaly(anomaly & ~info.anomaly)
    if (pixelKinds) text += `, including ${pixelKinds}`
  }
  return text
}

// ---------------------------------------------------------------------------
// Canvas Interaction Attacher
// ---------------------------------------------------------------------------

/**
 * Attach zoom, pan, crosshair, and keyboard controls to a canvas element.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {object} options.rawSeries - Original un-decimated data
 * @param {object} options.viewState - createViewState() instance
 * @param {() => { xScale: object, yScale: object }} options.getScales - Get active scales
 * @param {() => void} options.onRender - Re-render callback
 * @param {HTMLElement} [options.a11yTarget] - Screen reader announcement container
 * @param {string} [options.accessibleName='Training run metric chart']
 * @returns {{ destroy: () => void, getCrosshair: () => object | null }}
 */
export function attachInteractions(canvas, options) {
  const { rawSeries, viewState, getScales, onRender, a11yTarget, accessibleName = 'Training run metric chart' } = options
  // Pointer and wheel events can arrive many times per frame. They only need
  // the chart redrawn "soon", so the host may coalesce them (for example one
  // redraw per animation frame). Keyboard paths keep the synchronous
  // `onRender`, because they read the new scales straight afterwards.
  const scheduleRender = options.scheduleRender || onRender

  // Accessible name + keyboard focus. role="application" lets screen readers
  // pass arrow keys through to the chart instead of using them to browse.
  canvas.setAttribute('role', 'application')
  canvas.setAttribute('aria-roledescription', 'chart')
  canvas.setAttribute('tabindex', '0')
  canvas.setAttribute('aria-label', `${accessibleName}. ${KEY_HELP}`)
  if (a11yTarget) {
    a11yTarget.setAttribute('role', 'status')
    a11yTarget.setAttribute('aria-live', 'polite')
    if (a11yTarget.id) canvas.setAttribute('aria-describedby', a11yTarget.id)
  }

  let activeCrosshair = null
  let isDragging = false
  let dragStartX = 0
  let dragStartRange = null

  function announce(text) {
    if (a11yTarget && a11yTarget.textContent !== text) a11yTarget.textContent = text
  }

  function updateA11yText(info) {
    announce(info ? describePoint(info) : `${accessibleName}. ${KEY_HELP}`)
  }

  function announceRange() {
    const [r0, r1] = viewState.getRange()
    announce(`Showing steps ${formatInteger(Math.round(r0))} to ${formatInteger(Math.round(r1))}`)
  }

  /** Move the crosshair to a raw index, panning so it stays in view. */
  function moveCrosshairTo(rawIdx) {
    const n = rawSeries.steps.length
    if (n === 0) return
    const idx = Math.max(0, Math.min(n - 1, rawIdx))
    const step = rawSeries.steps[idx]
    const [r0, r1] = viewState.getRange()
    if (step < r0 || step > r1) viewState.pan(step - (r0 + r1) / 2)
    onRender()
    activeCrosshair = rawPointAt(rawSeries, idx, getScales().xScale)
    updateA11yText(activeCrosshair)
    onRender()
  }

  /** Step by one point, or by one pixel's worth of points when zoomed out. */
  function stepCrosshair(direction) {
    const { xScale } = getScales()
    if (!activeCrosshair) {
      const [r0, r1] = viewState.getRange()
      moveCrosshairTo(binarySearchNearest(rawSeries.steps, direction > 0 ? r0 : r1))
      return
    }
    const cur = activeCrosshair.rawIndex
    let next = cur + direction
    if (xScale) {
      const px = xScale.scale(rawSeries.steps[cur])
      const target = px === null ? null : xScale.invert(px + direction)
      if (target !== null) {
        const byPixel = binarySearchNearest(rawSeries.steps, target)
        if (direction > 0 ? byPixel > next : byPixel < next) next = byPixel
      }
    }
    moveCrosshairTo(next)
  }

  /** Jump to the previous/next raw point with any anomaly flag set. */
  function jumpToAnomaly(direction) {
    const flags = rawSeries.anomaly
    if (!flags) return announce('No anomaly data for this series')
    const n = rawSeries.steps.length
    const from = activeCrosshair ? activeCrosshair.rawIndex : direction > 0 ? -1 : n
    for (let i = from + direction; i >= 0 && i < n; i += direction) {
      if (flags[i]) return moveCrosshairTo(i)
    }
    announce(direction > 0 ? 'No later anomaly' : 'No earlier anomaly')
  }

  updateA11yText(null)

  // 1. Wheel Zoom
  function handleWheel(e) {
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const mousePx = e.clientX - rect.left
    const { xScale } = getScales()
    if (!xScale) return

    // Anchor on the view state, not on the last drawn scale: with coalesced
    // redraws the scale can be one or more wheel events behind, and using it
    // would make the point under the cursor drift while zooming.
    const [p0, p1] = xScale.range
    const [r0, r1] = viewState.getRange()
    if (p1 === p0) return
    const centerStep = r0 + ((mousePx - p0) / (p1 - p0)) * (r1 - r0)
    if (!Number.isFinite(centerStep)) return

    const factor = e.deltaY < 0 ? 0.8 : 1.25
    viewState.zoomAt(centerStep, factor)
    scheduleRender()
  }

  // 2. Drag Pan
  function handlePointerDown(e) {
    if (e.button !== 0) return // Left button only
    isDragging = true
    dragStartX = e.clientX
    dragStartRange = viewState.getRange()
    if (canvas.setPointerCapture) {
      canvas.setPointerCapture(e.pointerId)
    }
  }

  function handlePointerMove(e) {
    const rect = canvas.getBoundingClientRect()
    const mousePx = e.clientX - rect.left
    const { xScale } = getScales()

    if (isDragging && dragStartRange && xScale) {
      // `pan` moves the current range, so each move applies only the distance
      // travelled since the previous one. Applying the whole distance since
      // pointerdown every time would compound and outrun the pointer.
      const deltaPx = e.clientX - dragStartX
      dragStartX = e.clientX
      const span = dragStartRange[1] - dragStartRange[0]
      const plotW = xScale.range ? Math.abs(xScale.range[1] - xScale.range[0]) : 800
      const deltaSteps = -(deltaPx * (span / plotW))
      viewState.pan(deltaSteps)
      scheduleRender()
      return
    }

    // Crosshair inspection (raw value)
    if (xScale) {
      activeCrosshair = inspectRawPoint(mousePx, xScale, rawSeries)
      updateA11yText(activeCrosshair)
      scheduleRender()
    }
  }

  function handlePointerUp(e) {
    if (isDragging) {
      isDragging = false
      if (canvas.releasePointerCapture) {
        canvas.releasePointerCapture(e.pointerId)
      }
    }
  }

  function handlePointerLeave() {
    if (!isDragging) {
      activeCrosshair = null
      updateA11yText(null)
      scheduleRender()
    }
  }

  // 3. Double Click Reset
  function handleDblClick() {
    viewState.reset()
    activeCrosshair = null
    onRender()
  }

  // 4. Keyboard Controls
  function handleKeyDown(e) {
    const range = viewState.getRange()
    const span = range[1] - range[0]
    const stepCenter = (range[0] + range[1]) / 2

    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      stepCrosshair(e.key === 'ArrowRight' ? 1 : -1)
      return
    }
    if (e.key === '[' || e.key === ']') {
      e.preventDefault()
      jumpToAnomaly(e.key === ']' ? 1 : -1)
      return
    }
    if (e.key === 'Escape' && activeCrosshair) {
      e.preventDefault()
      activeCrosshair = null
      updateA11yText(null)
      onRender()
      return
    }

    let handled = true

    switch (e.key) {
      case 'ArrowLeft':
        viewState.pan(-span * 0.1) // Pan left 10%
        break
      case 'ArrowRight':
        viewState.pan(span * 0.1) // Pan right 10%
        break
      case 'PageUp':
        viewState.pan(-span * 0.5) // Pan left 50%
        break
      case 'PageDown':
        viewState.pan(span * 0.5) // Pan right 50%
        break
      case 'ArrowUp':
      case '+':
      case '=':
        viewState.zoomAt(stepCenter, 0.8) // Zoom in
        break
      case 'ArrowDown':
      case '-':
        viewState.zoomAt(stepCenter, 1.25) // Zoom out
        break
      case 'Home':
      case 'r':
      case 'R':
      case '0':
        viewState.reset() // Reset zoom
        break
      default:
        handled = false
        break
    }

    if (handled) {
      e.preventDefault()
      onRender()
      announceRange()
    }
  }

  // Attach event listeners
  canvas.addEventListener('wheel', handleWheel, { passive: false })
  canvas.addEventListener('pointerdown', handlePointerDown)
  canvas.addEventListener('pointermove', handlePointerMove)
  canvas.addEventListener('pointerup', handlePointerUp)
  canvas.addEventListener('pointercancel', handlePointerUp)
  canvas.addEventListener('pointerleave', handlePointerLeave)
  canvas.addEventListener('dblclick', handleDblClick)
  canvas.addEventListener('keydown', handleKeyDown)

  return {
    destroy: () => {
      canvas.removeEventListener('wheel', handleWheel)
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerup', handlePointerUp)
      canvas.removeEventListener('pointercancel', handlePointerUp)
      canvas.removeEventListener('pointerleave', handlePointerLeave)
      canvas.removeEventListener('dblclick', handleDblClick)
      canvas.removeEventListener('keydown', handleKeyDown)
    },
    getCrosshair: () => activeCrosshair,
  }
}

/**
 * Draw crosshair overlay on canvas.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} crosshair - { step, value, anomaly }
 * @param {object} xScale
 * @param {object} yScale
 * @param {object} margins
 * @param {number} plotW
 * @param {number} plotH
 */
export function renderCrosshairOverlay(ctx, crosshair, xScale, yScale, margins, plotW, plotH) {
  if (!crosshair || !xScale || !yScale) return

  const px = xScale.scale(crosshair.step)
  if (px === null || !Number.isFinite(px)) return

  ctx.save()

  // Vertical crosshair hair
  ctx.strokeStyle = 'rgba(100, 116, 139, 0.7)'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(px, margins.top)
  ctx.lineTo(px, margins.top + plotH)
  ctx.stroke()
  ctx.setLineDash([])

  // Horizontal hair if value is plottable
  const py = yScale.scale(crosshair.value)
  if (py !== null && Number.isFinite(py)) {
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.5)'
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(margins.left, py)
    ctx.lineTo(margins.left + plotW, py)
    ctx.stroke()
    ctx.setLineDash([])

    // Focus point highlight
    ctx.fillStyle = '#2563eb'
    ctx.beginPath()
    ctx.arc(px, py, 4, 0, Math.PI * 2)
    ctx.fill()
  }

  // Floating tooltip card
  let label = `Step ${formatInteger(crosshair.step)}: ${formatMetricValue(crosshair.value)}`
  if (crosshair.pixel && Number.isFinite(crosshair.pixel.min)) {
    const { count, min, max } = crosshair.pixel
    label += `  (${formatInteger(count)} pts in px: ${formatMetricValue(min)} – ${formatMetricValue(max)})`
  }
  const kinds = describeAnomaly(crosshair.anomaly)
  if (kinds) label += `  ⚠ ${kinds}`
  ctx.font = 'bold 12px sans-serif'
  const textW = ctx.measureText ? ctx.measureText(label).width : 120
  const boxW = textW + 16
  const boxH = 24
  let boxX = px + 10
  if (boxX + boxW > margins.left + plotW) {
    // Flip to the left of the cursor, but never past the plot's left edge:
    // the label starts with the step and value, which must stay readable.
    boxX = Math.max(margins.left, px - boxW - 10)
  }
  const boxY = margins.top + 10

  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)' // Dark slate
  ctx.fillRect(boxX, boxY, boxW, boxH)

  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, boxX + 8, boxY + boxH / 2)

  ctx.restore()
}
