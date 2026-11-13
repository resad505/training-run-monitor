/**
 * Chart Interactions — Issue #15.
 *
 * Provides zoom, pan, crosshair inspection, and keyboard controls.
 *
 * Guarantees (Issue #15 acceptance criteria):
 *   1. Wheel/drag and keyboard zoom, pan, and reset.
 *   2. The crosshair reports the RAW value from the original dataset,
 *      never the decimated/bucket value.
 *   3. Canvas has an accessible name and a live text alternative for the hovered point.
 */

import { binarySearchFirstGe } from './downsample.js'
import { formatTickNumber } from './scale.js'

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
 * Inspect raw data at a given mouse pixel X.
 *
 * @param {number} mousePx
 * @param {object} xScale - Active scale mapping steps to pixels
 * @param {object} rawSeries - Original un-decimated series { steps, values, anomaly }
 * @returns {null | { step: number, value: number, anomaly: number, rawIndex: number }}
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

  return {
    step: rawSeries.steps[rawIdx],
    value: rawSeries.values[rawIdx], // RAW value from original dataset!
    anomaly: rawSeries.anomaly ? rawSeries.anomaly[rawIdx] : 0,
    rawIndex: rawIdx,
  }
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

  // Ensure accessible attributes on canvas
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('tabindex', '0')
  canvas.setAttribute('aria-label', accessibleName)

  let activeCrosshair = null
  let isDragging = false
  let dragStartX = 0
  let dragStartRange = null

  function updateA11yText(info) {
    if (!a11yTarget) return
    if (!info) {
      a11yTarget.textContent = `${accessibleName}. Interactive chart. Use arrow keys to pan and zoom.`
      return
    }

    const statusText = info.anomaly ? ' [Anomaly detected]' : ''
    a11yTarget.textContent = `Step ${info.step}: Value ${formatMetricValue(info.value)}${statusText}`
  }

  updateA11yText(null)

  // 1. Wheel Zoom
  function handleWheel(e) {
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const mousePx = e.clientX - rect.left
    const { xScale } = getScales()
    if (!xScale) return

    const centerStep = xScale.invert(mousePx)
    if (centerStep === null) return

    const factor = e.deltaY < 0 ? 0.8 : 1.25
    viewState.zoomAt(centerStep, factor)
    onRender()
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
      const deltaPx = e.clientX - dragStartX
      const span = dragStartRange[1] - dragStartRange[0]
      const plotW = xScale.range ? Math.abs(xScale.range[1] - xScale.range[0]) : 800
      const deltaSteps = -(deltaPx * (span / plotW))
      viewState.pan(deltaSteps)
      onRender()
      return
    }

    // Crosshair inspection (raw value)
    if (xScale) {
      activeCrosshair = inspectRawPoint(mousePx, xScale, rawSeries)
      updateA11yText(activeCrosshair)
      onRender()
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
      onRender()
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
  const label = `Step ${crosshair.step}: ${formatMetricValue(crosshair.value)}`
  ctx.font = 'bold 12px sans-serif'
  const textW = ctx.measureText ? ctx.measureText(label).width : 120
  const boxW = textW + 16
  const boxH = 24
  let boxX = px + 10
  if (boxX + boxW > margins.left + plotW) {
    boxX = px - boxW - 10
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
