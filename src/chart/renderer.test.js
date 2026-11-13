import { describe, expect, it } from 'vitest'
import { renderChart, setupCanvas, computeEMA } from './renderer.js'
import { generateRun, LARGE_RUN_ID, LARGE_RUN_STEPS, LARGE_RUN_SPIKE_STEP } from '../pipeline/generator.js'
import { sanitizeRun } from '../pipeline/sanitizer.js'

/**
 * Create a mock CanvasRenderingContext2D that records operations
 * and enforces the GATE check: no non-finite coordinate reaches lineTo or moveTo.
 */
function createMockContext() {
  const calls = []
  const lineToCoords = []
  const moveToCoords = []

  return {
    calls,
    lineToCoords,
    moveToCoords,
    scale: (sx, sy) => calls.push({ method: 'scale', args: [sx, sy] }),
    clearRect: (x, y, w, h) => calls.push({ method: 'clearRect', args: [x, y, w, h] }),
    beginPath: () => calls.push({ method: 'beginPath', args: [] }),
    closePath: () => calls.push({ method: 'closePath', args: [] }),
    moveTo: (x, y) => {
      // GATE CHECK: No non-finite coordinate may reach moveTo
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`Non-finite coordinate reached moveTo: (${x}, ${y})`)
      }
      moveToCoords.push([x, y])
      calls.push({ method: 'moveTo', args: [x, y] })
    },
    lineTo: (x, y) => {
      // GATE CHECK: No non-finite coordinate may reach lineTo
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`Non-finite coordinate reached lineTo: (${x}, ${y})`)
      }
      lineToCoords.push([x, y])
      calls.push({ method: 'lineTo', args: [x, y] })
    },
    stroke: () => calls.push({ method: 'stroke', args: [] }),
    fill: () => calls.push({ method: 'fill', args: [] }),
    strokeRect: (x, y, w, h) => calls.push({ method: 'strokeRect', args: [x, y, w, h] }),
    fillRect: (x, y, w, h) => calls.push({ method: 'fillRect', args: [x, y, w, h] }),
    fillText: (text, x, y) => calls.push({ method: 'fillText', args: [text, x, y] }),
    setLineDash: (segments) => calls.push({ method: 'setLineDash', args: [segments] }),
    save: () => calls.push({ method: 'save', args: [] }),
    restore: () => calls.push({ method: 'restore', args: [] }),
  }
}

describe('setupCanvas — High-DPI support', () => {
  it('configures canvas dimensions and backing-store scale for dpr=2', () => {
    const mockCanvas = {
      style: {},
      width: 0,
      height: 0,
      getContext: () => ({ scale: (x, y) => ({ x, y }) }),
    }

    setupCanvas(mockCanvas, 800, 400, 2)
    expect(mockCanvas.width).toBe(1600)
    expect(mockCanvas.height).toBe(800)
    expect(mockCanvas.style.width).toBe('800px')
    expect(mockCanvas.style.height).toBe('400px')
  })
})

describe('computeEMA — Smoothing', () => {
  it('resets EMA across non-finite points to avoid false interpolation', () => {
    const steps = [0, 1, 2, 3, 4]
    const values = [1.0, 1.0, NaN, 2.0, 2.0]
    const ema = computeEMA(steps, values, 0.5)

    expect(ema[0]).toBe(1.0)
    expect(ema[1]).toBe(1.0)
    expect(Number.isNaN(ema[2])).toBe(true)
    // Step 3 starts clean at 2.0 (not smoothed from 1.0)
    expect(ema[3]).toBe(2.0)
    expect(ema[4]).toBe(2.0)
  })

  it('resets EMA across step gaps', () => {
    const steps = [0, 1, 10, 11]
    const values = [1.0, 1.0, 5.0, 5.0]
    const ema = computeEMA(steps, values, 0.5)

    // Step 10 is after gap (1 -> 10): must start fresh at 5.0
    expect(ema[2]).toBe(5.0)
  })
})

describe('renderChart — Issue #14 & GATE acceptance criteria', () => {
  it('CRITICAL GATE: no non-finite coordinate ever reaches lineTo or moveTo', () => {
    const ctx = createMockContext()

    // Series containing all types of corruptions: NaNs, Infinities, negative log inputs, gaps
    const steps = [0, 1, 2, 3, 4, 10, 11, 12]
    const values = [1.0, NaN, Infinity, -Infinity, -5.0, 2.0, NaN, 3.0]
    const anomaly = new Uint8Array([0, 1, 1, 1, 1, 0, 1, 0])

    // Test both linear and log scale modes
    for (const scaleType of ['linear', 'log']) {
      expect(() => {
        renderChart(
          ctx,
          {
            steps: new Float64Array(steps),
            values: new Float64Array(values),
            anomaly,
          },
          { width: 800, height: 400, scaleType },
        )
      }).not.toThrow()
    }

    // Every recorded coordinate in lineTo and moveTo must be finite
    for (const [x, y] of ctx.lineToCoords) {
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
    }
    for (const [x, y] of ctx.moveToCoords) {
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
    }
  })

  it('path breaks at non-finite points and step gaps', () => {
    const ctx = createMockContext()

    // 2 valid points, then NaN, then 2 valid points, then gap, then 2 valid points
    const steps = [0, 1, 2, 3, 4, 20, 21]
    const values = [1.0, 1.1, NaN, 1.2, 1.3, 1.4, 1.5]

    renderChart(
      ctx,
      {
        steps: new Float64Array(steps),
        values: new Float64Array(values),
      },
      { width: 800, height: 400, smoothing: 0 },
    )

    // There should be multiple beginPath() calls due to segment breaks
    const beginPaths = ctx.calls.filter((c) => c.method === 'beginPath')
    expect(beginPaths.length).toBeGreaterThan(2)

    // Explicit non-finite marker badge must be drawn (fillText 'NaN')
    const nanBadge = ctx.calls.find((c) => c.method === 'fillText' && c.args[0] === 'NaN')
    expect(nanBadge).toBeDefined()
  })

  it('CRITICAL GATE: 1M spike is visible at full zoom-out', () => {
    const ctx = createMockContext()
    const rawRun = generateRun(LARGE_RUN_ID, { steps: LARGE_RUN_STEPS })
    const sanitized = sanitizeRun(rawRun)

    const { decimated, yScale } = renderChart(
      ctx,
      {
        steps: sanitized.steps,
        values: sanitized.loss,
        anomaly: sanitized.anomaly,
      },
      { width: 800, height: 400 },
    )

    // 1. Spike step index 500_000 must be present in decimated output
    const spikeIdx = Array.from(decimated.steps).indexOf(LARGE_RUN_SPIKE_STEP)
    expect(spikeIdx).toBeGreaterThanOrEqual(0)

    // 2. The spike's loss value must be significantly higher than surrounding baseline (~0.16)
    const spikeLoss = decimated.values[spikeIdx]
    expect(spikeLoss).toBeGreaterThan(1.0)

    // 3. The Y scale maps this spike to a finite pixel coordinate in plot area
    const spikePy = yScale.scale(spikeLoss)
    expect(Number.isFinite(spikePy)).toBe(true)
    expect(spikePy).toBeGreaterThanOrEqual(20) // margins.top is 20
    expect(spikePy).toBeLessThanOrEqual(380)

    // 4. Anomaly marker was drawn
    const hasAnomalyMarker = ctx.calls.some((c) => c.method === 'fillStyle' || c.method === 'fillRect')
    expect(hasAnomalyMarker).toBe(true)
  })
})
