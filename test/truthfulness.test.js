import { describe, expect, it } from 'vitest'
import { computeEMA } from '../src/chart/renderer.js'
import { downsample } from '../src/chart/downsample.js'
import { createLinearScale } from '../src/chart/scale.js'
import {
  generateRun,
  LARGE_RUN_ID,
  LARGE_RUN_SPIKE_STEP,
  LARGE_RUN_STEPS,
} from '../src/pipeline/generator.js'
import { ANOMALY, sanitizeRun } from '../src/pipeline/sanitizer.js'

function makeStep(step, loss, lr = 0.001, grad_norm = 0.5) {
  return { step, loss, lr, grad_norm }
}

describe('truthfulness proofs (generator -> sanitizer -> chart)', () => {
  it('(a) preserves the 1M-point spike across zoom windows', () => {
    const sanitized = sanitizeRun(generateRun(LARGE_RUN_ID, { steps: LARGE_RUN_STEPS }))
    const windows = [
      { targetWidth: 800 },
      { targetWidth: 500, xRange: [450_000, 550_000] },
      { targetWidth: 200, xRange: [499_500, 500_500] },
    ]

    for (const options of windows) {
      const decimated = downsample({
        steps: sanitized.steps,
        values: sanitized.loss,
        anomaly: sanitized.anomaly,
        ...options,
      })
      const spikeIndex = Array.from(decimated.steps).indexOf(LARGE_RUN_SPIKE_STEP)
      expect(spikeIndex, `spike missing in ${JSON.stringify(options)}`).toBeGreaterThanOrEqual(0)
      expect(decimated.values[spikeIndex]).toBeGreaterThan(1)
    }
  })

  it('(b) preserves non-finite values and resets smoothing at their boundaries', () => {
    const raw = {
      id: 1,
      steps: [
        makeStep(0, 1),
        makeStep(1, NaN, NaN, NaN),
        makeStep(2, 3),
        makeStep(3, Infinity),
        makeStep(4, 5),
        makeStep(5, -Infinity),
      ],
    }
    const sanitized = sanitizeRun(raw)
    const decimated = downsample({
      steps: sanitized.steps,
      values: sanitized.loss,
      anomaly: sanitized.anomaly,
      targetWidth: 10,
    })
    const ema = computeEMA(sanitized.steps, sanitized.loss)

    expect(Array.from(decimated.values)).toEqual([1, NaN, 3, Infinity, 5, -Infinity])
    expect(Number.isNaN(ema[1])).toBe(true)
    expect(ema[2]).toBe(3)
    expect(ema[3]).toBe(Infinity)
    expect(ema[4]).toBe(5)
    expect(ema[5]).toBe(-Infinity)
    expect(sanitized.anomaly[1] & ANOMALY.NON_FINITE).toBeTruthy()
  })

  it('(c) normalizes unsorted and duplicate input to the clean series values', () => {
    const clean = [0, 1, 2, 3, 4].map((step) => makeStep(step, 10 - step))
    const corrupted = [clean[3], clean[1], clean[2], makeStep(2, 8), clean[4], clean[0]]
    const expected = sanitizeRun({ id: 1, steps: clean })
    const actual = sanitizeRun({ id: 1, steps: corrupted })

    expect(Array.from(actual.steps)).toEqual(Array.from(expected.steps))
    expect(Array.from(actual.loss)).toEqual(Array.from(expected.loss))
    expect(Array.from(actual.lr)).toEqual(Array.from(expected.lr))
    expect(Array.from(actual.grad_norm)).toEqual(Array.from(expected.grad_norm))
    expect(actual.anomaly[2] & ANOMALY.COLLISION).toBeTruthy()
  })

  it('(d) keeps axis labels tied to the finite data domain', () => {
    const values = [0.0002, 0.001, 0.004, 0.009]
    const scale = createLinearScale({
      domain: [values[0], values[values.length - 1]],
      range: [0, 400],
    })

    expect(scale.domain).toEqual([0.0002, 0.009])
    expect(scale.scale(values[0])).toBe(0)
    expect(scale.scale(values[values.length - 1])).toBe(400)
    for (const tick of scale.ticks(5)) {
      expect(tick).toBeGreaterThanOrEqual(values[0])
      expect(tick).toBeLessThanOrEqual(values[values.length - 1])
      expect(Number(scale.tickFormat(tick))).toBe(tick)
    }
  })
})
