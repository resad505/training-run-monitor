import { describe, expect, it } from 'vitest'
import { renderChart, setupCanvas, computeEMA } from './renderer.js'
import { generateRun, LARGE_RUN_ID, LARGE_RUN_STEPS, LARGE_RUN_SPIKE_STEP } from '../pipeline/generator.js'
import { sanitizeRun, ANOMALY } from '../pipeline/sanitizer.js'

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
    rect: (x, y, w, h) => calls.push({ method: 'rect', args: [x, y, w, h] }),
    clip: () => calls.push({ method: 'clip', args: [] }),
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

    // 4. A diamond anomaly marker is drawn on the spike (right vertex at px+5, py)
    const spikePx = renderXScale(ctx, decimated, spikeIdx)
    expect(hasDiamondAt(ctx, spikePx, spikePy)).toBe(true)
  })

  it('zoomed-out 1M run is one continuous line, not shaded as gaps', () => {
    const ctx = createMockContext()
    const s = sanitizeRun(generateRun(LARGE_RUN_ID, { steps: LARGE_RUN_STEPS }))
    renderChart(ctx, { steps: s.steps, values: s.loss, anomaly: s.anomaly }, { width: 800, height: 400 })

    const gapShades = ctx.calls.filter(
      (c) => c.method === 'fillRect' && c.args[3] === 340 && c.args[1] === 20,
    )
    expect(gapShades.length).toBeLessThanOrEqual(s.gaps)
    // A handful of path starts (segments, markers, grid) — not one per point.
    expect(ctx.moveToCoords.length).toBeLessThan(150)
  })
})

/** x pixel of decimated point k, derived from the drawn chart. */
function renderXScale(ctx, decimated, k) {
  const ctx2 = createMockContext()
  const { xScale } = renderChart(ctx2, decimated, { width: 800, height: 400, smoothing: 0 })
  return xScale.scale(decimated.steps[k])
}

function hasDiamondAt(ctx, px, py) {
  return ctx.lineToCoords.some(([x, y]) => Math.abs(x - (px + 5)) < 1e-6 && Math.abs(y - py) < 1e-6)
}

describe('renderChart — markers, envelope, smoothing, axes', () => {
  const N = 4000
  const steps = Float64Array.from({ length: N }, (_, i) => (i < 2000 ? i : i + 50))
  const values = Float64Array.from({ length: N }, (_, i) => 1 + Math.sin(i / 25) * 0.2)

  it('anomaly bitmask (OUTLIER = 2) draws a diamond', () => {
    const ctx = createMockContext()
    const a = new Uint8Array(N)
    a[500] = ANOMALY.OUTLIER
    const { xScale, yScale } = renderChart(ctx, { steps, values, anomaly: a }, { width: 800, height: 400 })
    expect(hasDiamondAt(ctx, xScale.scale(steps[500]), yScale.scale(values[500]))).toBe(true)
  })

  it('envelope is filled per segment, never across a gap', () => {
    const ctx = createMockContext()
    renderChart(ctx, { steps, values }, { width: 800, height: 400 })
    // 2 segments → 2 envelope polygons
    const fills = ctx.calls.filter((c) => c.method === 'fill')
    expect(fills.length).toBe(2)
  })

  it('smoothed curve is computed on raw data and does not change with zoom', () => {
    const full = renderChart(createMockContext(), { steps, values }, { width: 800, height: 400 })
    const zoom = renderChart(createMockContext(), { steps, values }, { width: 800, height: 400, xRange: [900, 1100] })
    const step = zoom.decimated.steps[50]
    const kFull = Array.from(full.decimated.steps).indexOf(step)
    if (kFull >= 0) {
      expect(zoom.smoothed[50]).toBe(full.smoothed[kFull])
    }
    // Directly: equals the raw EMA at that step.
    const ema = computeEMA(steps, values, 0.8)
    expect(zoom.smoothed[50]).toBe(ema[zoom.decimated.index[50]])
  })

  it('negative values stay inside the plot (no clamp at 0)', () => {
    const neg = Float64Array.from({ length: 100 }, (_, i) => -5 + i * 0.01)
    const st = Float64Array.from({ length: 100 }, (_, i) => i)
    const { yScale } = renderChart(createMockContext(), { steps: st, values: neg }, { width: 800, height: 400 })
    const py = yScale.scale(-5)
    expect(py).toBeGreaterThanOrEqual(20)
    expect(py).toBeLessThanOrEqual(360)
  })

  it('log scale marks finite values <= 0 as not plottable', () => {
    const ctx = createMockContext()
    const st = Float64Array.from({ length: 10 }, (_, i) => i)
    const v = Float64Array.from({ length: 10 }, () => 0.5)
    v[4] = 0
    v[7] = -1
    renderChart(ctx, { steps: st, values: v }, { width: 800, height: 400, scaleType: 'log' })
    const badges = ctx.calls.filter((c) => c.method === 'fillText' && c.args[0] === '≤0')
    expect(badges.length).toBe(2)
  })

  it('data drawing is clipped to the plot area', () => {
    const ctx = createMockContext()
    renderChart(ctx, { steps, values }, { width: 800, height: 400, xRange: [100, 200] })
    expect(ctx.calls.some((c) => c.method === 'clip')).toBe(true)
  })
})

describe('renderChart — user-selectable scale and smoothing', () => {
  const steps = Float64Array.from({ length: 40 }, (_, i) => i)
  // Decays to exactly zero and dips negative: both are impossible on a log axis.
  const values = Float64Array.from(steps, (i) => (i === 20 ? 0 : i === 30 ? -0.5 : 4 * Math.exp(-i / 8) + 0.01))
  const series = { steps, values, anomaly: new Uint8Array(40) }

  it('log scale: zeros and negatives are marked, never clamped onto the axis', () => {
    const ctx = createMockContext()
    const { yScale, decimated } = renderChart(ctx, series, { width: 400, height: 300, scaleType: 'log' })

    // The gate in the mock context has already rejected any non-finite path.
    expect(yScale.type).toBe('log')
    expect(yScale.domain[0]).toBeGreaterThan(0)
    expect(yScale.scale(0)).toBeNull()
    expect(yScale.scale(-0.5)).toBeNull()
    // Both points are still in the data handed to the renderer...
    expect(Array.from(decimated.values)).toContain(0)
    expect(Array.from(decimated.values)).toContain(-0.5)
    // ...and each gets its own "≤0" badge instead of a point on the line.
    const badges = ctx.calls.filter((call) => call.method === 'fillText' && call.args[0] === '≤0')
    expect(badges).toHaveLength(2)
  })

  it('log scale: the line is broken at an unplottable value, not drawn through it', () => {
    const linear = createMockContext()
    const log = createMockContext()
    renderChart(linear, series, { width: 400, height: 300, scaleType: 'linear', smoothing: 0 })
    renderChart(log, series, { width: 400, height: 300, scaleType: 'log', smoothing: 0 })

    const strokes = (ctx) => ctx.calls.filter((call) => call.method === 'stroke').length
    expect(strokes(log)).toBeGreaterThan(strokes(linear))
  })

  it('smoothing 0 draws the raw series only', () => {
    const result = renderChart(createMockContext(), series, { width: 400, height: 300, smoothing: 0 })

    expect(result.smoothed).toBeNull()
  })

  it('changing the smoothing weight changes the curve and is reversible', () => {
    const draw = (smoothing) =>
      Array.from(renderChart(createMockContext(), series, { width: 400, height: 300, smoothing }).smoothed)

    const light = draw(0.5)
    const heavy = draw(0.9)
    expect(heavy).not.toEqual(light)
    // Heavier smoothing lags further behind the decaying raw value.
    expect(heavy[10]).toBeGreaterThan(light[10])
    expect(draw(0.5)).toEqual(light)
  })

  it('smoothing never alters the raw values that are drawn', () => {
    const raw = (smoothing) =>
      Array.from(renderChart(createMockContext(), series, { width: 400, height: 300, smoothing }).decimated.values)

    expect(raw(0.95)).toEqual(raw(0))
    expect(raw(0)).toEqual(Array.from(values))
  })
})
