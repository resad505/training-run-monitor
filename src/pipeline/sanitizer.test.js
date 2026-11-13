import { describe, expect, it } from 'vitest'
import {
  generateRun,
  generateDataset,
  STEPS_PER_RUN,
  LARGE_RUN_ID,
  LARGE_RUN_STEPS,
  LARGE_RUN_SPIKE_STEP,
} from './generator.js'
import {
  sanitizeRun,
  sanitizeDataset,
  ANOMALY,
  EXPECTED_STRIDE,
  OUTLIER_THRESHOLD,
  PLATEAU_MIN_RUN,
} from './sanitizer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal raw step for unit tests that don't need a full run. */
function makeStep(step, loss, lr = 1e-3, grad_norm = 0.5, corrupt = false) {
  return { step, loss, lr, grad_norm, corrupt }
}

/** Loss with small, non-repeating variation (avoids triggering PLATEAU). */
function wobble(i, base = 1.0) {
  return base + ((i * 7) % 5) * 0.002
}

/** True when `flag` is set in an anomaly bitmask value. */
function has(value, flag) {
  return (value & flag) !== 0
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
    expect(has(result.anomaly[0], ANOMALY.COLLISION)).toBe(true)
    expect(result.loss[0]).toBeCloseTo(1.1)
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
    expect(has(result.anomaly[2], ANOMALY.GAP)).toBe(true)
    expect(has(result.anomaly[1], ANOMALY.GAP)).toBe(false)
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

  it('EXPECTED_STRIDE is documented as 1', () => {
    expect(EXPECTED_STRIDE).toBe(1)
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
  it('anomaly column contains only known flag bits', () => {
    const known = Object.values(ANOMALY).reduce((a, b) => a | b, 0)
    const result = sanitizeRun(generateRun(1))
    for (const v of result.anomaly) {
      expect(v & ~known).toBe(0)
    }
  })

  it('NaN loss is flagged as anomaly', () => {
    const raw = makeRun(0, [
      makeStep(0, 1.0), makeStep(1, NaN, NaN, NaN, true), makeStep(2, 0.8),
    ])
    const result = sanitizeRun(raw)
    expect(has(result.anomaly[1], ANOMALY.NON_FINITE)).toBe(true)
  })

  it('Infinity loss is flagged as anomaly', () => {
    const raw = makeRun(0, [
      makeStep(0, 1.0), makeStep(1, Infinity, 1e-3, 0.5, true), makeStep(2, 0.9),
    ])
    const result = sanitizeRun(raw)
    expect(has(result.anomaly[1], ANOMALY.NON_FINITE)).toBe(true)
    expect(result.loss[1]).toBe(Infinity)
  })

  it('-Infinity loss is flagged and preserved', () => {
    const raw = makeRun(0, [makeStep(0, 1.0), makeStep(1, -Infinity), makeStep(2, 0.9)])
    const result = sanitizeRun(raw)
    expect(has(result.anomaly[1], ANOMALY.NON_FINITE)).toBe(true)
    expect(result.loss[1]).toBe(-Infinity)
  })

  it('corrupt-flagged step with normal finite loss is NOT flagged as anomaly by sanitizer', () => {
    // 50 uniform steps, one marked corrupt=true but with normal loss
    const steps = Array.from({ length: 50 }, (_, i) => makeStep(i, wobble(i), 1e-3, 0.5, false))
    // Mark step 25 as corrupt but keep its loss normal
    steps[25] = makeStep(25, wobble(25), 1e-3, 0.5, true)
    const raw = makeRun(0, steps)
    const result = sanitizeRun(raw)
    // The sanitizer must NOT use the corrupt flag; a normal finite loss must not be flagged
    expect(result.anomaly[25]).toBe(0)
  })

  it(`outlier beyond ${OUTLIER_THRESHOLD} robust σ is flagged`, () => {
    // 99 normal steps around loss=1.0, then one spike at 100.0
    const steps = Array.from({ length: 99 }, (_, i) => makeStep(i, wobble(i)))
    steps.push(makeStep(99, 100.0)) // extreme outlier, not marked corrupt
    const result = sanitizeRun(makeRun(0, steps))
    expect(has(result.anomaly[99], ANOMALY.OUTLIER)).toBe(true)
  })

  it('a small late spike on a decaying curve is flagged (trend-relative)', () => {
    // Steep early decay; a global statistic would hide a late 3x spike.
    const steps = Array.from({ length: 200 }, (_, i) =>
      makeStep(i, 0.1 + 3 * Math.exp(-i / 30) + (((i * 7) % 5) - 2) * 0.002),
    )
    steps[170] = makeStep(170, steps[170].loss * 3)
    const result = sanitizeRun(makeRun(0, steps))
    expect(has(result.anomaly[170], ANOMALY.OUTLIER)).toBe(true)
    // ...and the steep early part is not flagged.
    expect(Array.from(result.anomaly.slice(0, 20)).every((v) => v === 0)).toBe(true)
  })

  it('normal steps are not flagged as anomalies', () => {
    const steps = Array.from({ length: 50 }, (_, i) => makeStep(i, wobble(i)))
    const result = sanitizeRun(makeRun(0, steps))
    for (const v of result.anomaly) {
      expect(v).toBe(0)
    }
  })

  it(`${PLATEAU_MIN_RUN}+ identical consecutive losses are flagged as PLATEAU`, () => {
    const steps = Array.from({ length: 40 }, (_, i) => makeStep(i, wobble(i)))
    for (let i = 20; i < 25; i++) steps[i] = makeStep(i, 0.777)
    const result = sanitizeRun(makeRun(0, steps))
    for (let i = 0; i < 40; i++) {
      expect(has(result.anomaly[i], ANOMALY.PLATEAU)).toBe(i >= 20 && i < 25)
    }
  })

  it('two identical consecutive losses are not a plateau', () => {
    const steps = Array.from({ length: 40 }, (_, i) => makeStep(i, wobble(i)))
    steps[21] = makeStep(21, steps[20].loss)
    const result = sanitizeRun(makeRun(0, steps))
    expect(has(result.anomaly[20], ANOMALY.PLATEAU)).toBe(false)
  })

  it('real dataset has anomalies in every run (excluding 1M run for performance)', () => {
    const dataset = generateDataset().filter((r) => r.id !== 19)
    const sanitized = sanitizeDataset(dataset)
    for (const run of sanitized) {
      const hasAnomaly = Array.from(run.anomaly).some((v) => v !== 0)
      expect(hasAnomaly).toBe(true)
    }
  })

  it('OUTLIER_THRESHOLD and PLATEAU_MIN_RUN are exported', () => {
    expect(OUTLIER_THRESHOLD).toBe(3.5)
    expect(PLATEAU_MIN_RUN).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Truthfulness against the generator's ground truth
// ---------------------------------------------------------------------------

/** Strip the generator's `corrupt` label so the sanitizer cannot see it. */
function unlabelled(run) {
  return { ...run, steps: run.steps.map(({ corrupt, ...s }) => s) }
}

describe('sanitizeRun — truthfulness', () => {
  const runs = generateDataset().filter((r) => r.id !== LARGE_RUN_ID)

  it('output does not depend on the generator corrupt label', () => {
    for (const run of runs.slice(0, 5)) {
      const a = sanitizeRun(run)
      const b = sanitizeRun(unlabelled(run))
      expect(Array.from(b.anomaly)).toEqual(Array.from(a.anomaly))
    }
  })

  it('every injected event in the manifest is flagged', () => {
    for (const run of runs) {
      const result = sanitizeRun(unlabelled(run))
      const index = new Map(Array.from(result.steps, (s, i) => [s, i]))
      for (const { kind, pos } of run.manifest) {
        if (kind === 'unsorted') continue // valid values; resolved by the sort
        const i = index.get(pos) + (kind === 'gap' ? 1 : 0)
        expect(result.anomaly[i], `run ${run.id} ${kind}@${pos}`).not.toBe(0)
      }
    }
  })

  it('no clean (un-injected) step is flagged', () => {
    for (const run of runs) {
      const corrupt = new Set(run.steps.filter((s) => s.corrupt).map((s) => s.step))
      const result = sanitizeRun(unlabelled(run))
      for (let i = 0; i < result.length; i++) {
        if (!corrupt.has(result.steps[i])) {
          expect(result.anomaly[i], `run ${run.id} step ${result.steps[i]}`).toBe(0)
        }
      }
    }
  })

  it('flags the documented spike in the 1M-point run quickly and without noise', () => {
    const run = generateRun(LARGE_RUN_ID, { steps: LARGE_RUN_STEPS })
    const t0 = performance.now()
    const result = sanitizeRun(run)
    const elapsed = performance.now() - t0
    const i = Array.from(result.steps).indexOf(LARGE_RUN_SPIKE_STEP)
    expect(has(result.anomaly[i], ANOMALY.OUTLIER)).toBe(true)
    let flagged = 0
    for (const v of result.anomaly) if (v !== 0) flagged++
    expect(flagged).toBeLessThan(50)
    expect(elapsed).toBeLessThan(3000)
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
  it('shuffled + duplicated input produces output identical to clean sorted input', () => {
    // Clean sorted input (with a NaN and a spike so every column is exercised).
    const clean = Array.from({ length: 60 }, (_, i) =>
      makeStep(i, wobble(i, 2 - i * 0.02), 1e-3 * (1 - i / 100), 0.5 + i * 0.001),
    )
    clean[10] = makeStep(10, NaN, NaN, NaN)
    clean[40] = makeStep(40, 9.0)

    // Duplicate some entries (re-sent copies) and shuffle the arrival order.
    const withDups = [...clean, clean[5], clean[10], clean[33], clean[33]]
    const shuffled = deterministicShuffle(withDups, 0xabcdef01)

    const expected = sanitizeRun(makeRun(0, clean))
    const actual = sanitizeRun(makeRun(0, shuffled))

    for (const col of ['steps', 'loss', 'lr', 'grad_norm']) {
      expect(Array.from(actual[col]), col).toEqual(Array.from(expected[col]))
    }
    // Anomaly flags are identical apart from the collision bit on re-sent steps.
    const withoutCollision = Array.from(actual.anomaly, (v) => v & ~ANOMALY.COLLISION)
    expect(withoutCollision).toEqual(Array.from(expected.anomaly))
    expect(actual.collisions).toBe(4)
    expect(expected.collisions).toBe(0)
  })
})
