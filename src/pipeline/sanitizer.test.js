import { describe, expect, it } from 'vitest'
import { generateRun, generateDataset, STEPS_PER_RUN } from './generator.js'
import { sanitizeRun, sanitizeDataset, Z_THRESHOLD, MAD_THRESHOLD } from './sanitizer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal raw step for unit tests that don't need a full run. */
function makeStep(step, loss, lr = 1e-3, grad_norm = 0.5, corrupt = false) {
  return { step, loss, lr, grad_norm, corrupt }
}

/** Build a minimal run object. */
function makeRun(id, steps) {
  return { id, seed: 0, steps }
}

/**
 * Deterministic Fisher-Yates shuffle using a simple LCG PRNG.
 * Returns a new array; does not mutate the input.
 *
 * @param {any[]} arr
 * @param {number} seed
 * @returns {any[]}
 */
function deterministicShuffle(arr, seed) {
  const out = arr.slice()
  let s = seed >>> 0
  function lcg() {
    s = Math.imul(s, 1664525) + 1013904223
    return (s >>> 0) / 0x100000000
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(lcg() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ---------------------------------------------------------------------------
// Output types — typed array columns
// ---------------------------------------------------------------------------

describe('sanitizeRun — output shape', () => {
  const run = generateRun(0)
  const result = sanitizeRun(run)

  it('returns id, length, steps, loss, lr, grad_norm, anomaly, collisions, gaps', () => {
    expect(result).toHaveProperty('id')
    expect(result).toHaveProperty('length')
    expect(result).toHaveProperty('steps')
    expect(result).toHaveProperty('loss')
    expect(result).toHaveProperty('lr')
    expect(result).toHaveProperty('grad_norm')
    expect(result).toHaveProperty('anomaly')
    expect(result).toHaveProperty('collisions')
    expect(result).toHaveProperty('gaps')
  })

  it('steps, loss, lr, grad_norm are Float64Array; anomaly is Uint8Array', () => {
    expect(result.steps).toBeInstanceOf(Float64Array)
    expect(result.loss).toBeInstanceOf(Float64Array)
    expect(result.lr).toBeInstanceOf(Float64Array)
    expect(result.grad_norm).toBeInstanceOf(Float64Array)
    expect(result.anomaly).toBeInstanceOf(Uint8Array)
  })

  it('all buffers have the same length as result.length', () => {
    expect(result.steps.length).toBe(result.length)
    expect(result.loss.length).toBe(result.length)
    expect(result.lr.length).toBe(result.length)
    expect(result.grad_norm.length).toBe(result.length)
    expect(result.anomaly.length).toBe(result.length)
  })

  it('id is passed through', () => {
    expect(result.id).toBe(run.id)
  })

  it('collisions and gaps are non-negative integers', () => {
    expect(typeof result.collisions).toBe('number')
    expect(result.collisions).toBeGreaterThanOrEqual(0)
    expect(typeof result.gaps).toBe('number')
    expect(result.gaps).toBeGreaterThanOrEqual(0)
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
// Deduplication — last-write-wins
// ---------------------------------------------------------------------------

describe('sanitizeRun — deduplication (last-write-wins)', () => {
  it('removes exact duplicate step indices', () => {
    const raw = makeRun(0, [makeStep(0, 1.0), makeStep(0, 1.0), makeStep(1, 0.9)])
    const result = sanitizeRun(raw)
    expect(result.length).toBe(2)
    expect(result.steps[0]).toBe(0)
    expect(result.steps[1]).toBe(1)
  })

  it('last entry wins regardless of corrupt flag — corrupt last wins', () => {
    // cleanEntry at step 3 comes first; corruptEntry comes second → last wins
    const cleanEntry = makeStep(3, 1.5, 1e-3, 0.5, false)
    const corruptEntry = makeStep(3, 999, 1e-3, 0.5, true)
    // After sort, same step index; corruptEntry is last in original order
    const raw = makeRun(0, [cleanEntry, corruptEntry])
    const result = sanitizeRun(raw)
    expect(result.length).toBe(1)
    // Last entry (corruptEntry, loss=999) wins
    expect(result.loss[0]).toBeCloseTo(999)
  })

  it('last entry wins regardless of corrupt flag — clean last wins', () => {
    const corruptEntry = makeStep(3, 999, 1e-3, 0.5, true)
    const cleanEntry = makeStep(3, 1.5, 1e-3, 0.5, false)
    // corruptEntry first, cleanEntry last → clean wins
    const raw = makeRun(0, [corruptEntry, cleanEntry])
    const result = sanitizeRun(raw)
    expect(result.length).toBe(1)
    expect(result.loss[0]).toBeCloseTo(1.5)
  })

  it('collision is flagged as anomaly', () => {
    const a = makeStep(5, 1.0, 1e-3, 0.5, false)
    const b = makeStep(5, 1.1, 1e-3, 0.5, false)
    const raw = makeRun(0, [a, b])
    const result = sanitizeRun(raw)
    expect(result.length).toBe(1)
    // The winning (last) entry must be flagged anomaly due to collision
    expect(result.anomaly[0]).toBe(1)
  })

  it('collisions counter equals number of duplicate resolutions', () => {
    // 2 duplicates at step 0, 2 duplicates at step 5 → 2 collisions
    const steps = [
      makeStep(0, 1.0), makeStep(0, 1.1),  // collision 1
      makeStep(5, 2.0), makeStep(5, 2.1),  // collision 2
      makeStep(10, 0.5),
    ]
    const raw = makeRun(0, steps)
    const result = sanitizeRun(raw)
    expect(result.collisions).toBe(2)
  })

  it('no collision → collisions is 0', () => {
    const raw = makeRun(0, [makeStep(0, 1.0), makeStep(1, 0.9), makeStep(2, 0.8)])
    const result = sanitizeRun(raw)
    expect(result.collisions).toBe(0)
  })

  it('real generator output length is <= raw length after dedup', () => {
    const run = generateRun(2)
    const result = sanitizeRun(run)
    expect(result.length).toBeLessThanOrEqual(run.steps.length)
  })
})

// ---------------------------------------------------------------------------
// Gap detection
// ---------------------------------------------------------------------------

describe('sanitizeRun — gap detection', () => {
  it('detects a gap and flags step after the gap as anomaly', () => {
    // Steps 0, 1, 5, 6 — gap between 1 and 5
    const steps = [makeStep(0, 1.0), makeStep(1, 0.9), makeStep(5, 0.8), makeStep(6, 0.7)]
    const raw = makeRun(0, steps)
    const result = sanitizeRun(raw)
    // Step 5 (index 2) should be flagged as anomaly (after gap)
    expect(result.anomaly[2]).toBe(1)
  })

  it('gaps counter equals number of gaps detected', () => {
    // Gaps: 1→5, 6→10, 10→20 = 3 gaps
    const steps = [
      makeStep(0, 1.0), makeStep(1, 0.9),
      makeStep(5, 0.8), makeStep(6, 0.7),
      makeStep(10, 0.6),
      makeStep(20, 0.5), makeStep(21, 0.4),
    ]
    const raw = makeRun(0, steps)
    const result = sanitizeRun(raw)
    expect(result.gaps).toBe(3)
  })

  it('no gap → gaps is 0', () => {
    const raw = makeRun(0, [makeStep(0, 1.0), makeStep(1, 0.9), makeStep(2, 0.8)])
    const result = sanitizeRun(raw)
    expect(result.gaps).toBe(0)
  })

  it('consecutive steps (stride 1) are not flagged as gaps', () => {
    const steps = Array.from({ length: 10 }, (_, i) => makeStep(i, 1.0 - i * 0.05))
    const raw = makeRun(0, steps)
    const result = sanitizeRun(raw)
    expect(result.gaps).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Anomaly flagging
// ---------------------------------------------------------------------------

describe('sanitizeRun — anomaly flagging', () => {
  it('anomaly column contains only 0 or 1', () => {
    const result = sanitizeRun(generateRun(1))
    for (const v of result.anomaly) {
      expect(v === 0 || v === 1).toBe(true)
    }
  })

  it('NaN loss is flagged as anomaly', () => {
    const raw = makeRun(0, [
      makeStep(0, 1.0), makeStep(1, NaN, NaN, NaN, true), makeStep(2, 0.8),
    ])
    const result = sanitizeRun(raw)
    expect(result.anomaly[1]).toBe(1)
  })

  it('Infinity loss is flagged as anomaly', () => {
    const raw = makeRun(0, [
      makeStep(0, 1.0), makeStep(1, Infinity, 1e-3, 0.5, true), makeStep(2, 0.9),
    ])
    const result = sanitizeRun(raw)
    expect(result.anomaly[1]).toBe(1)
  })

  it('corrupt-flagged step with normal finite loss is NOT flagged as anomaly by sanitizer', () => {
    // 50 uniform steps, one marked corrupt=true but with normal loss
    const steps = Array.from({ length: 50 }, (_, i) => makeStep(i, 1.0, 1e-3, 0.5, false))
    // Mark step 25 as corrupt but keep its loss normal
    steps[25] = makeStep(25, 1.0, 1e-3, 0.5, true)
    const raw = makeRun(0, steps)
    const result = sanitizeRun(raw)
    // The sanitizer must NOT use the corrupt flag; a normal finite loss must not be flagged
    expect(result.anomaly[25]).toBe(0)
  })

  it(`rolling MAD outlier beyond ${MAD_THRESHOLD} × MAD is flagged as anomaly`, () => {
    // 99 normal steps around loss=1.0, then one spike at 100.0
    const steps = Array.from({ length: 99 }, (_, i) => makeStep(i, 1.0 + (i % 3) * 0.01))
    steps.push(makeStep(99, 100.0)) // extreme outlier, not marked corrupt
    const raw = makeRun(0, steps)
    const result = sanitizeRun(raw)
    expect(result.anomaly[99]).toBe(1)
  })

  it('normal steps are not flagged as anomalies', () => {
    // Uniform loss — no outliers, no corrupt, no NaN
    const steps = Array.from({ length: 50 }, (_, i) => makeStep(i, 1.0))
    const raw = makeRun(0, steps)
    const result = sanitizeRun(raw)
    for (const v of result.anomaly) {
      expect(v).toBe(0)
    }
  })

  it('real dataset has anomalies in every run (excluding 1M run for performance)', () => {
    const dataset = generateDataset().filter((r) => r.id !== 19)
    const sanitized = sanitizeDataset(dataset)
    for (const run of sanitized) {
      const hasAnomaly = Array.from(run.anomaly).some((v) => v === 1)
      expect(hasAnomaly).toBe(true)
    }
  })

  it('Z_THRESHOLD and MAD_THRESHOLD are exported and equal 3.5', () => {
    expect(Z_THRESHOLD).toBe(3.5)
    expect(MAD_THRESHOLD).toBe(3.5)
  })
})

// ---------------------------------------------------------------------------
// NaN propagation
// ---------------------------------------------------------------------------

describe('sanitizeRun — NaN preservation', () => {
  it('NaN loss is preserved in the output loss buffer', () => {
    const raw = makeRun(0, [makeStep(0, NaN, NaN, NaN, true)])
    const result = sanitizeRun(raw)
    expect(Number.isNaN(result.loss[0])).toBe(true)
  })

  it('NaN does not corrupt the step index', () => {
    const raw = makeRun(0, [makeStep(7, NaN, NaN, NaN, true)])
    const result = sanitizeRun(raw)
    expect(result.steps[0]).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// sanitizeDataset
// ---------------------------------------------------------------------------

describe('sanitizeDataset', () => {
  it('returns one result per input run', () => {
    // Use only runs 0–5 for speed
    const dataset = Array.from({ length: 6 }, (_, id) => generateRun(id))
    const results = sanitizeDataset(dataset)
    expect(results).toHaveLength(dataset.length)
  })

  it('ids match the input run ids', () => {
    const dataset = Array.from({ length: 6 }, (_, id) => generateRun(id))
    const results = sanitizeDataset(dataset)
    for (let i = 0; i < dataset.length; i++) {
      expect(results[i].id).toBe(dataset[i].id)
    }
  })

  it('each result has at least STEPS_PER_RUN - 5 steps (dedup may remove a few)', () => {
    // The generator injects 2–5 duplicates; dedup removes them.
    const dataset = Array.from({ length: 10 }, (_, id) => generateRun(id))
    const results = sanitizeDataset(dataset)
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

// ---------------------------------------------------------------------------
// Shuffle-equivalence
// ---------------------------------------------------------------------------

describe('sanitizeRun — shuffle-equivalence', () => {
  it('shuffled + duplicate input produces same step indices as sorted input after sanitization', () => {
    // 1. Create a clean sorted run of 30 steps.
    const baseSteps = Array.from({ length: 30 }, (_, i) =>
      makeStep(i, 1.0 - i * 0.02),
    )

    // 2. Add manual duplicates at step 5 and step 15.
    const withDups = [
      ...baseSteps,
      makeStep(5, 1.5, 1e-3, 0.5, true),   // duplicate at 5
      makeStep(15, 0.8, 1e-3, 0.5, false),  // duplicate at 15
    ]

    // 3. Shuffled version using a deterministic shuffle.
    const shuffled = deterministicShuffle(withDups, 0xabcdef01)

    // 4. Sanitize both.
    const sortedResult = sanitizeRun(makeRun(0, withDups))
    const shuffledResult = sanitizeRun(makeRun(0, shuffled))

    // 5. The step index buffers must be identical.
    expect(Array.from(sortedResult.steps)).toEqual(Array.from(shuffledResult.steps))
  })
})
