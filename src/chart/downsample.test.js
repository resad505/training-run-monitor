import { describe, expect, it } from 'vitest'
import { downsample, binarySearchFirstGe, binarySearchLastLe } from './downsample.js'
import { generateRun, LARGE_RUN_ID, LARGE_RUN_STEPS, LARGE_RUN_SPIKE_STEP } from '../pipeline/generator.js'
import { sanitizeRun } from '../pipeline/sanitizer.js'

describe('binarySearch helpers', () => {
  const steps = [10, 20, 30, 40, 50]

  it('binarySearchFirstGe finds exact and upper bounds', () => {
    expect(binarySearchFirstGe(steps, 20)).toBe(1)
    expect(binarySearchFirstGe(steps, 25)).toBe(2)
    expect(binarySearchFirstGe(steps, 5)).toBe(0)
    expect(binarySearchFirstGe(steps, 55)).toBe(5)
  })

  it('binarySearchLastLe finds exact and lower bounds', () => {
    expect(binarySearchLastLe(steps, 40)).toBe(3)
    expect(binarySearchLastLe(steps, 35)).toBe(2)
    expect(binarySearchLastLe(steps, 55)).toBe(4)
    expect(binarySearchLastLe(steps, 5)).toBe(-1)
  })
})

describe('downsample — Issue #13 acceptance criteria', () => {
  it('global min and max of any window survive for any target width', () => {
    const N = 10000
    const steps = new Float64Array(N)
    const values = new Float64Array(N)

    for (let i = 0; i < N; i++) {
      steps[i] = i
      values[i] = 1.0 + Math.sin(i / 50) * 0.5 // range [0.5, 1.5]
    }

    // Plant global min and max at arbitrary positions
    const minIdx = 3421
    const maxIdx = 8742
    values[minIdx] = -999.0
    values[maxIdx] = 9999.0

    // Test across a variety of narrow and wide target widths
    for (const targetWidth of [50, 100, 250, 500, 1000, 2000]) {
      const result = downsample({ steps, values, targetWidth })

      let foundMin = false
      let foundMax = false

      for (let k = 0; k < result.length; k++) {
        if (result.steps[k] === minIdx && result.values[k] === -999.0) foundMin = true
        if (result.steps[k] === maxIdx && result.values[k] === 9999.0) foundMax = true
      }

      expect(foundMin).toBe(true)
      expect(foundMax).toBe(true)
    }
  })

  it('CRITICAL: 1M-point outlier spike survives decimation across multiple zoom windows', () => {
    // Generate the 1M-step run
    const rawRun = generateRun(LARGE_RUN_ID, { steps: LARGE_RUN_STEPS })
    const sanitized = sanitizeRun(rawRun)

    // Full zoom-out (all 1M points -> targetWidth 800)
    const full = downsample({
      steps: sanitized.steps,
      values: sanitized.loss,
      anomaly: sanitized.anomaly,
      targetWidth: 800,
    })

    const hasSpikeAtFullZoom = Array.from(full.steps).includes(LARGE_RUN_SPIKE_STEP)
    expect(hasSpikeAtFullZoom).toBe(true)

    // Mid zoom window around spike [450_000, 550_000]
    const midZoom = downsample({
      steps: sanitized.steps,
      values: sanitized.loss,
      anomaly: sanitized.anomaly,
      targetWidth: 500,
      xRange: [450_000, 550_000],
    })
    expect(Array.from(midZoom.steps).includes(LARGE_RUN_SPIKE_STEP)).toBe(true)

    // Tight zoom window [499_500, 500_500]
    const tightZoom = downsample({
      steps: sanitized.steps,
      values: sanitized.loss,
      anomaly: sanitized.anomaly,
      targetWidth: 200,
      xRange: [499_500, 500_500],
    })
    expect(Array.from(tightZoom.steps).includes(LARGE_RUN_SPIKE_STEP)).toBe(true)
  })

  it('non-finite points (NaN, Infinity, -Infinity) are never coerced to 0 or merged into buckets', () => {
    const N = 1000
    const steps = new Float64Array(N)
    const values = new Float64Array(N)

    for (let i = 0; i < N; i++) {
      steps[i] = i
      values[i] = 1.0
    }

    values[200] = NaN
    values[500] = Infinity
    values[700] = -Infinity

    const result = downsample({ steps, values, targetWidth: 100 })

    let foundNaN = false
    let foundInf = false
    let foundNegInf = false

    for (let i = 0; i < result.length; i++) {
      if (result.steps[i] === 200 && Number.isNaN(result.values[i])) foundNaN = true
      if (result.steps[i] === 500 && result.values[i] === Infinity) foundInf = true
      if (result.steps[i] === 700 && result.values[i] === -Infinity) foundNegInf = true
    }

    expect(foundNaN).toBe(true)
    expect(foundInf).toBe(true)
    expect(foundNegInf).toBe(true)
  })

  it('step gaps are not merged into a continuous line', () => {
    // 50 points, then a gap of 20 steps, then 50 points
    const steps = []
    const values = []
    for (let i = 0; i < 50; i++) {
      steps.push(i)
      values.push(1.0)
    }
    for (let i = 70; i < 120; i++) {
      steps.push(i)
      values.push(1.0)
    }

    const result = downsample({
      steps: new Float64Array(steps),
      values: new Float64Array(values),
      targetWidth: 30,
    })

    // Both gap boundaries (step 49 and step 70) must be present in the output
    expect(Array.from(result.steps)).toContain(49)
    expect(Array.from(result.steps)).toContain(70)
  })

  it('output size has a documented upper bound', () => {
    const N = 50000
    const steps = new Float64Array(N)
    const values = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      steps[i] = i
      values[i] = Math.cos(i)
    }

    const targetWidth = 400
    const result = downsample({ steps, values, targetWidth })

    // For clean data: length <= 2 * targetWidth + 2 (documented upper bound)
    expect(result.length).toBeLessThanOrEqual(2 * targetWidth + 2)
    expect(result.envelope.length).toBeLessThanOrEqual(targetWidth)
  })

  it('handles empty input gracefully', () => {
    const result = downsample({
      steps: new Float64Array(0),
      values: new Float64Array(0),
      targetWidth: 100,
    })
    expect(result.length).toBe(0)
    expect(result.steps).toBeInstanceOf(Float64Array)
  })

  it('window out of bounds returns empty output', () => {
    const steps = new Float64Array([10, 20, 30])
    const values = new Float64Array([1, 2, 3])
    const result = downsample({ steps, values, targetWidth: 50, xRange: [100, 200] })
    expect(result.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Break flags, anomaly survival, bound
// ---------------------------------------------------------------------------

import { sanitizeRun as _sanitizeRun, ANOMALY as _ANOMALY } from '../pipeline/sanitizer.js'
import { generateRun as _generateRun, LARGE_RUN_ID as _BIG, LARGE_RUN_STEPS as _BIG_N } from '../pipeline/generator.js'

describe('downsample — explicit break flags', () => {
  const big = _sanitizeRun(_generateRun(_BIG, { steps: _BIG_N }))
  const full = downsample({ steps: big.steps, values: big.loss, anomaly: big.anomaly, targetWidth: 700 })

  it('gapBefore is set only where the source data has a real step gap', () => {
    const flagged = Array.from(full.gapBefore).filter(Boolean).length
    expect(flagged).toBe(big.gaps)
  })

  it('breakBefore is rare on clean data (decimated neighbours are not gaps)', () => {
    const breaks = Array.from(full.breakBefore).filter(Boolean).length
    // one per finite segment + one per non-finite point
    expect(breaks).toBeLessThan(20)
    expect(full.breakBefore[0]).toBe(1)
  })

  it('breaks before and after a non-finite point', () => {
    const steps = Float64Array.from({ length: 2000 }, (_, i) => i)
    const values = Float64Array.from({ length: 2000 }, (_, i) => Math.sin(i / 7))
    values[1000] = NaN
    const r = downsample({ steps, values, targetWidth: 100 })
    const k = Array.from(r.steps).indexOf(1000)
    expect(r.breakBefore[k]).toBe(1)
    expect(r.breakBefore[k + 1]).toBe(1)
    expect(r.steps[k + 1]).toBe(1001)
  })

  it('every anomalous point in the window survives', () => {
    const kept = new Set(Array.from(full.index))
    for (let i = 0; i < big.length; i++) {
      if (big.anomaly[i]) expect(kept.has(i), `raw index ${i}`).toBe(true)
    }
  })

  it('index maps each output point back to its source', () => {
    for (let k = 0; k < full.length; k += 97) {
      expect(big.steps[full.index[k]]).toBe(full.steps[k])
    }
  })

  it('envelope starts a new polygon at every segment', () => {
    const steps = Float64Array.from({ length: 4000 }, (_, i) => (i < 2000 ? i : i + 50))
    const values = Float64Array.from({ length: 4000 }, (_, i) => Math.cos(i / 9))
    const r = downsample({ steps, values, targetWidth: 100 })
    expect(Array.from(r.envelope.breakBefore).filter(Boolean).length).toBe(2)
  })

  it('respects the documented bound on adversarial input', () => {
    const N = 50_000
    const steps = new Float64Array(N)
    const values = new Float64Array(N)
    const anomaly = new Uint8Array(N)
    let step = 0
    let S = 1
    let F = 0
    let A = 0
    for (let i = 0; i < N; i++) {
      if (i > 0 && i % 997 === 0) {
        step += 5
        S++
      }
      steps[i] = step++
      values[i] = i % 1301 === 0 ? NaN : Math.sin(i)
      if (!Number.isFinite(values[i])) {
        F++
        S++
      }
      if (i % 2003 === 0) {
        anomaly[i] = _ANOMALY.OUTLIER
        A++
      }
    }
    const W = 300
    const r = downsample({ steps, values, anomaly, targetWidth: W })
    expect(r.length).toBeLessThanOrEqual(2 * W + 4 * S + F + A)
    expect(r.envelope.length).toBeLessThanOrEqual(2 * (W + S))
  })
})
