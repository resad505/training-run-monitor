import { describe, expect, it } from 'vitest'
import { generateRun, generateDataset, STEPS_PER_RUN } from './generator.js'
import { sanitizeRun, sanitizeDataset, Z_THRESHOLD } from './sanitizer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal raw step for unit tests that don't need a full run. */
function makeStep(step, loss, accuracy = 0.5, corrupt = false) {
  return { step, loss, accuracy, corrupt }
}

/** Build a minimal run object. */
function makeRun(id, steps) {
  return { id, seed: 0, steps }
}

// ---------------------------------------------------------------------------
// Output types — Float64Array columns
// ---------------------------------------------------------------------------

describe('sanitizeRun — output shape', () => {
  const run = generateRun(0)
  const result = sanitizeRun(run)

  it('returns id, length, steps, loss, accuracy, anomaly', () => {
    expect(result).toHaveProperty('id')
    expect(result).toHaveProperty('length')
    expect(result).toHaveProperty('steps')
    expect(result).toHaveProperty('loss')
    expect(result).toHaveProperty('accuracy')
    expect(result).toHaveProperty('anomaly')
  })

  it('all buffers are Float64Array', () => {
    expect(result.steps).toBeInstanceOf(Float64Array)
    expect(result.loss).toBeInstanceOf(Float64Array)
    expect(result.accuracy).toBeInstanceOf(Float64Array)
    expect(result.anomaly).toBeInstanceOf(Float64Array)
  })

  it('all buffers have the same length as result.length', () => {
    expect(result.steps.length).toBe(result.length)
    expect(result.loss.length).toBe(result.length)
    expect(result.accuracy.length).toBe(result.length)
    expect(result.anomaly.length).toBe(result.length)
  })

  it('id is passed through', () => {
    expect(result.id).toBe(run.id)
  })
})

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

describe('sanitizeRun — sort', () => {
  it('step indices are in ascending order after sanitization', () => {
    // Build deliberately out-of-order steps.
    const raw = makeRun(0, [makeStep(5, 1.0), makeStep(2, 1.1), makeStep(8, 0.9), makeStep(1, 1.2)])
    const result = sanitizeRun(raw)
    for (let i = 1; i < result.length; i++) {
      expect(result.steps[i]).toBeGreaterThan(result.steps[i - 1])
    }
  })

  it('already-sorted input is unchanged in order', () => {
    const raw = makeRun(0, [makeStep(0, 1.0), makeStep(1, 0.9), makeStep(2, 0.8)])
    const result = sanitizeRun(raw)
    expect(Array.from(result.steps)).toEqual([0, 1, 2])
  })
})

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('sanitizeRun — deduplication', () => {
  it('removes exact duplicate step indices', () => {
    const raw = makeRun(0, [makeStep(0, 1.0), makeStep(0, 1.0), makeStep(1, 0.9)])
    const result = sanitizeRun(raw)
    expect(result.length).toBe(2)
    expect(result.steps[0]).toBe(0)
    expect(result.steps[1]).toBe(1)
  })

  it('when one duplicate is non-corrupt, keeps the non-corrupt entry', () => {
    const corruptEntry = makeStep(3, 999, 0.0, true)   // corrupt spike
    const cleanEntry = makeStep(3, 1.5, 0.6, false)    // clean reading
    const raw = makeRun(0, [cleanEntry, corruptEntry])  // clean comes first
    const result = sanitizeRun(raw)
    expect(result.length).toBe(1)
    // The clean entry's loss should be kept
    expect(result.loss[0]).toBeCloseTo(1.5)
  })

  it('when both duplicates are corrupt, keeps the first (sorted) entry', () => {
    const a = makeStep(5, 10.0, 0.1, true)
    const b = makeStep(5, 20.0, 0.05, true)
    const raw = makeRun(0, [a, b])
    const result = sanitizeRun(raw)
    expect(result.length).toBe(1)
    expect(result.loss[0]).toBeCloseTo(10.0)
  })

  it('real generator output length is <= raw length after dedup', () => {
    const run = generateRun(2)
    const result = sanitizeRun(run)
    expect(result.length).toBeLessThanOrEqual(run.steps.length)
  })
})

// ---------------------------------------------------------------------------
// Anomaly flagging
// ---------------------------------------------------------------------------

describe('sanitizeRun — anomaly flagging', () => {
  it('anomaly column contains only 0.0 or 1.0', () => {
    const result = sanitizeRun(generateRun(1))
    for (const v of result.anomaly) {
      expect(v === 0.0 || v === 1.0).toBe(true)
    }
  })

  it('NaN loss is flagged as anomaly', () => {
    const raw = makeRun(0, [
      makeStep(0, 1.0), makeStep(1, NaN, NaN, true), makeStep(2, 0.8),
    ])
    const result = sanitizeRun(raw)
    expect(result.anomaly[1]).toBe(1.0)
  })

  it('Infinity loss is flagged as anomaly', () => {
    const raw = makeRun(0, [
      makeStep(0, 1.0), makeStep(1, Infinity, 0, true), makeStep(2, 0.9),
    ])
    const result = sanitizeRun(raw)
    expect(result.anomaly[1]).toBe(1.0)
  })

  it('corrupt flag causes anomaly even if value is finite', () => {
    const raw = makeRun(0, [makeStep(0, 1.0, 0.5, true)])
    const result = sanitizeRun(raw)
    expect(result.anomaly[0]).toBe(1.0)
  })

  it(`z-score outlier beyond ${Z_THRESHOLD} is flagged as anomaly`, () => {
    // 99 normal steps around loss=1.0, then one spike at 100.0
    const steps = Array.from({ length: 99 }, (_, i) => makeStep(i, 1.0 + (i % 3) * 0.01))
    steps.push(makeStep(99, 100.0)) // extreme outlier, not marked corrupt
    const raw = makeRun(0, steps)
    const result = sanitizeRun(raw)
    expect(result.anomaly[99]).toBe(1.0)
  })

  it('normal steps are not flagged as anomalies', () => {
    // Uniform loss — no outliers, no corrupt, no NaN
    const steps = Array.from({ length: 50 }, (_, i) => makeStep(i, 1.0))
    const raw = makeRun(0, steps)
    const result = sanitizeRun(raw)
    for (const v of result.anomaly) {
      expect(v).toBe(0.0)
    }
  })

  it('real dataset has anomalies in every run', () => {
    const dataset = sanitizeDataset(generateDataset())
    for (const run of dataset) {
      const hasAnomaly = Array.from(run.anomaly).some((v) => v === 1.0)
      expect(hasAnomaly).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// NaN propagation
// ---------------------------------------------------------------------------

describe('sanitizeRun — NaN preservation', () => {
  it('NaN loss is preserved in the output loss buffer', () => {
    const raw = makeRun(0, [makeStep(0, NaN, NaN, true)])
    const result = sanitizeRun(raw)
    expect(Number.isNaN(result.loss[0])).toBe(true)
    expect(Number.isNaN(result.accuracy[0])).toBe(true)
  })

  it('NaN does not corrupt the step index', () => {
    const raw = makeRun(0, [makeStep(7, NaN, NaN, true)])
    const result = sanitizeRun(raw)
    expect(result.steps[0]).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// sanitizeDataset
// ---------------------------------------------------------------------------

describe('sanitizeDataset', () => {
  it('returns one result per input run', () => {
    const dataset = generateDataset()
    const results = sanitizeDataset(dataset)
    expect(results).toHaveLength(dataset.length)
  })

  it('ids match the input run ids', () => {
    const dataset = generateDataset()
    const results = sanitizeDataset(dataset)
    for (let i = 0; i < dataset.length; i++) {
      expect(results[i].id).toBe(dataset[i].id)
    }
  })

  it('each result has at least STEPS_PER_RUN - 5 steps (dedup may remove a few)', () => {
    // The generator injects 2–5 duplicates; dedup removes them.
    const results = sanitizeDataset(generateDataset())
    for (const r of results) {
      expect(r.length).toBeGreaterThanOrEqual(STEPS_PER_RUN - 5)
    }
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('sanitizeRun — determinism', () => {
  it('same run produces identical sanitized output', () => {
    const run = generateRun(5)
    const a = sanitizeRun(run)
    const b = sanitizeRun(run)
    expect(Array.from(a.loss)).toEqual(Array.from(b.loss))
    expect(Array.from(a.anomaly)).toEqual(Array.from(b.anomaly))
  })
})
