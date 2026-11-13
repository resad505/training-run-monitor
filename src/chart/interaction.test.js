import { describe, expect, it } from 'vitest'
import {
  binarySearchNearest,
  formatMetricValue,
  createViewState,
  inspectRawPoint,
  attachInteractions,
  describeAnomaly,
  describePoint,
} from './interaction.js'
import { ANOMALY } from '../pipeline/sanitizer.js'
import { createLinearScale } from './scale.js'

describe('binarySearchNearest', () => {
  const steps = [0, 10, 20, 30, 40, 50]

  it('finds exact matches', () => {
    expect(binarySearchNearest(steps, 20)).toBe(2)
    expect(binarySearchNearest(steps, 0)).toBe(0)
    expect(binarySearchNearest(steps, 50)).toBe(5)
  })

  it('finds nearest index for values between steps', () => {
    expect(binarySearchNearest(steps, 23)).toBe(2) // 20 is closer than 30
    expect(binarySearchNearest(steps, 28)).toBe(3) // 30 is closer than 20
    expect(binarySearchNearest(steps, -10)).toBe(0)
    expect(binarySearchNearest(steps, 100)).toBe(5)
  })
})

describe('formatMetricValue — Truthful representations', () => {
  it('formats non-finite values explicitly without concealing', () => {
    expect(formatMetricValue(NaN)).toBe('NaN (Dropout)')
    expect(formatMetricValue(Infinity)).toBe('+Infinity')
    expect(formatMetricValue(-Infinity)).toBe('-Infinity')
  })

  it('formats finite numbers cleanly', () => {
    expect(formatMetricValue(0.425)).toBe('0.425')
    expect(formatMetricValue(100)).toBe('100')
  })
})

describe('createViewState — Zoom, Pan, Reset', () => {
  it('initializes to full range', () => {
    const view = createViewState([0, 1000])
    expect(view.getRange()).toEqual([0, 1000])
    expect(view.isZoomed()).toBe(false)
  })

  it('pans within bounds', () => {
    const view = createViewState([0, 1000])
    view.zoomAt(500, 0.5) // zoom in to [250, 750]
    expect(view.isZoomed()).toBe(true)

    view.pan(50)
    const [r0, r1] = view.getRange()
    expect(r0).toBe(300)
    expect(r1).toBe(800)

    // Pan past upper bound is clamped
    view.pan(500)
    const [clamped0, clamped1] = view.getRange()
    expect(clamped1).toBe(1000)
    expect(clamped0).toBe(500)
  })

  it('zooms centered around target step', () => {
    const view = createViewState([0, 1000])
    view.zoomAt(500, 0.5) // Zoom in 2x centered at 500
    const [r0, r1] = view.getRange()
    expect(r0).toBeCloseTo(250)
    expect(r1).toBeCloseTo(750)
  })

  it('resets back to full range', () => {
    const view = createViewState([0, 1000])
    view.zoomAt(500, 0.2)
    expect(view.isZoomed()).toBe(true)
    view.reset()
    expect(view.getRange()).toEqual([0, 1000])
    expect(view.isZoomed()).toBe(false)
  })
})

describe('inspectRawPoint — Issue #15 acceptance criteria', () => {
  it('CRITICAL: reports the RAW value, not the decimated one', () => {
    const N = 1000
    const rawSteps = new Float64Array(N)
    const rawValues = new Float64Array(N)
    const rawAnomaly = new Uint8Array(N)

    for (let i = 0; i < N; i++) {
      rawSteps[i] = i
      rawValues[i] = 1.0 + Math.sin(i / 10) * 0.1
    }

    // Plant a raw outlier value at step 342 with an anomaly flag
    rawValues[342] = 42.1234
    rawAnomaly[342] = 1

    // Plant a NaN at step 600
    rawValues[600] = NaN
    rawAnomaly[600] = 1

    const rawSeries = {
      steps: rawSteps,
      values: rawValues,
      anomaly: rawAnomaly,
    }

    // Create active scale
    const xScale = createLinearScale({
      domain: [0, 999],
      range: [0, 800],
    })

    // Mouse is over step 342
    const mousePx = xScale.scale(342)
    const point = inspectRawPoint(mousePx, xScale, rawSeries)

    expect(point).not.toBeNull()
    expect(point.step).toBe(342)
    // The point value MUST be the exact raw un-decimated value
    expect(point.value).toBe(42.1234)
    expect(point.anomaly).toBe(1)

    // Mouse is over step 600 (NaN dropout)
    const nanPx = xScale.scale(600)
    const nanPoint = inspectRawPoint(nanPx, xScale, rawSeries)
    expect(nanPoint).not.toBeNull()
    expect(nanPoint.step).toBe(600)
    expect(Number.isNaN(nanPoint.value)).toBe(true)
  })

  it('reports the raw min/max of every point under the pixel (spike next to cursor)', () => {
    const N = 100_000
    const steps = Float64Array.from({ length: N }, (_, i) => i)
    const values = new Float64Array(N).fill(0.2)
    const anomaly = new Uint8Array(N)
    values[50_000] = 9.5
    anomaly[50_000] = ANOMALY.OUTLIER

    const xScale = createLinearScale({ domain: [0, N - 1], range: [0, 800] })
    // Cursor lands on a neighbour of the spike, inside the same pixel.
    const point = inspectRawPoint(xScale.scale(50_010), xScale, { steps, values, anomaly })

    expect(point.value).toBe(0.2)
    expect(point.pixel.count).toBeGreaterThan(100)
    expect(point.pixel.max).toBe(9.5)
    expect(point.pixel.anomaly & ANOMALY.OUTLIER).toBeTruthy()
    expect(describePoint(point)).toContain('including outlier')
  })

  it('inspectRawPoint returns null for invalid coordinates', () => {
    const rawSeries = { steps: new Float64Array([0, 1]), values: new Float64Array([1, 2]) }
    const xScale = createLinearScale({ domain: [0, 1], range: [0, 100] })

    expect(inspectRawPoint(NaN, xScale, rawSeries)).toBeNull()
  })
})

describe('describeAnomaly', () => {
  it('decodes the sanitizer bitmask into names', () => {
    expect(describeAnomaly(0)).toBe('')
    expect(describeAnomaly(ANOMALY.OUTLIER | ANOMALY.PLATEAU)).toBe('outlier, plateau')
    expect(describeAnomaly(ANOMALY.NON_FINITE)).toBe('non-finite value')
  })
})

/** Minimal DOM-ish element recording attributes. */
function mockElement(extra = {}) {
  const attrs = {}
  const listeners = {}
  return {
    attrs,
    listeners,
    textContent: '',
    setAttribute: (k, v) => {
      attrs[k] = v
    },
    addEventListener: (evt, fn) => {
      listeners[evt] = fn
    },
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }),
    ...extra,
  }
}

function key(k, extra = {}) {
  return { key: k, shiftKey: false, preventDefault: () => {}, ...extra }
}

describe('attachInteractions — keyboard inspection', () => {
  function setup() {
    const canvas = mockElement()
    const live = mockElement({ id: 'chart-status' })
    const viewState = createViewState([0, 9])
    const steps = Float64Array.from({ length: 10 }, (_, i) => i)
    const values = Float64Array.from({ length: 10 }, (_, i) => 1 + i / 10)
    const anomaly = new Uint8Array(10)
    values[6] = NaN
    anomaly[6] = ANOMALY.NON_FINITE
    anomaly[8] = ANOMALY.OUTLIER
    const xScale = createLinearScale({ domain: [0, 9], range: [0, 800] })
    const api = attachInteractions(canvas, {
      rawSeries: { steps, values, anomaly },
      viewState,
      getScales: () => ({ xScale, yScale: null }),
      onRender: () => {},
      a11yTarget: live,
      accessibleName: 'Loss Chart',
    })
    return { canvas, live, api }
  }

  it('Shift+Arrow steps through raw points and announces them', () => {
    const { canvas, live, api } = setup()
    canvas.listeners.keydown(key('ArrowRight', { shiftKey: true }))
    expect(api.getCrosshair().step).toBe(0)
    canvas.listeners.keydown(key('ArrowRight', { shiftKey: true }))
    expect(api.getCrosshair().step).toBe(1)
    expect(live.textContent).toContain('Step 1')
    canvas.listeners.keydown(key('ArrowLeft', { shiftKey: true }))
    expect(api.getCrosshair().step).toBe(0)
  })

  it('] and [ jump between anomalies; Escape clears', () => {
    const { canvas, live, api } = setup()
    canvas.listeners.keydown(key(']'))
    expect(api.getCrosshair().step).toBe(6)
    expect(live.textContent).toContain('NaN')
    canvas.listeners.keydown(key(']'))
    expect(api.getCrosshair().step).toBe(8)
    expect(live.textContent).toContain('outlier')
    canvas.listeners.keydown(key(']'))
    expect(live.textContent).toBe('No later anomaly')
    canvas.listeners.keydown(key('['))
    expect(api.getCrosshair().step).toBe(6)
    canvas.listeners.keydown(key('Escape'))
    expect(api.getCrosshair()).toBeNull()
  })

  it('wires the live region to the canvas', () => {
    const { canvas, live } = setup()
    expect(live.attrs['aria-live']).toBe('polite')
    expect(live.attrs['role']).toBe('status')
    expect(canvas.attrs['aria-describedby']).toBe('chart-status')
  })
})

describe('attachInteractions — Accessibility & Keyboard Controls', () => {
  it('sets accessible role, tabindex, and aria-label on canvas', () => {
    const listeners = {}
    const attrs = {}

    const mockCanvas = {
      setAttribute: (k, v) => {
        attrs[k] = v
      },
      addEventListener: (evt, fn) => {
        listeners[evt] = fn
      },
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }),
    }

    const mockA11y = { textContent: '', setAttribute: () => {} }
    const viewState = createViewState([0, 100])
    const rawSeries = { steps: new Float64Array([0, 50, 100]), values: new Float64Array([1, 2, 3]) }
    const xScale = createLinearScale({ domain: [0, 100], range: [0, 800] })

    attachInteractions(mockCanvas, {
      rawSeries,
      viewState,
      getScales: () => ({ xScale, yScale: null }),
      onRender: () => {},
      a11yTarget: mockA11y,
      accessibleName: 'Loss Chart',
    })

    expect(attrs['role']).toBe('application')
    expect(attrs['aria-roledescription']).toBe('chart')
    expect(attrs['tabindex']).toBe('0')
    expect(attrs['aria-label']).toContain('Loss Chart')
    expect(attrs['aria-label']).toContain('Shift')
    expect(mockA11y.textContent).toContain('Loss Chart')

    // Zoom in first so there is room to pan
    viewState.zoomAt(50, 0.5)
    const [initial0] = viewState.getRange()

    // Test keyboard pan
    listeners['keydown']({
      key: 'ArrowRight',
      preventDefault: () => {},
    })

    const [panned0] = viewState.getRange()
    expect(panned0).toBeGreaterThan(initial0)
    expect(mockA11y.textContent).toMatch(/^Showing steps/)
  })
})
