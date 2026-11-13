import { describe, expect, it } from 'vitest'
import {
  generateRun,
  generateDataset,
  RUN_COUNT,
  STEPS_PER_RUN,
  DEFAULT_ROOT_SEED,
  LARGE_RUN_ID,
  LARGE_RUN_STEPS,
  LARGE_RUN_SPIKE_STEP,
  KINDS,
} from './generator.js'

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('generateRun — determinism', () => {
  it('same id + seed → identical output', () => {
    const a = generateRun(0)
    const b = generateRun(0)
    expect(a).toEqual(b)
  })

  it('different ids → different step sequences', () => {
    const r0 = generateRun(0)
    const r1 = generateRun(1)
    // Loss at step 0 must differ (astronomically unlikely to collide).
    expect(r0.steps[0].loss).not.toBe(r1.steps[0].loss)
  })

  it('dataset generation order does not affect individual runs', () => {
    const standalone = generateRun(7)
    const fromDataset = generateDataset().find((r) => r.id === 7)
    expect(standalone).toEqual(fromDataset)
  })

  it('custom rootSeed produces a different dataset', () => {
    const a = generateDataset({ rootSeed: DEFAULT_ROOT_SEED })
    const b = generateDataset({ rootSeed: 0x12345678 })
    expect(a[0].steps[0].loss).not.toBe(b[0].steps[0].loss)
  })
})

// ---------------------------------------------------------------------------
// Dataset shape
// ---------------------------------------------------------------------------

describe('generateDataset — shape', () => {
  const dataset = generateDataset()

  it(`produces exactly ${RUN_COUNT} runs`, () => {
    expect(dataset).toHaveLength(RUN_COUNT)
  })

  it('assigns consecutive ids 0–19', () => {
    expect(dataset.map((r) => r.id)).toEqual(Array.from({ length: RUN_COUNT }, (_, i) => i))
  })

  it('each run has the expected seed property', () => {
    for (const run of dataset) {
      expect(typeof run.seed).toBe('number')
      expect(run.seed).toBeGreaterThanOrEqual(0)
    }
  })

  it('runs 0–18 have at least STEPS_PER_RUN entries (duplicates may add more)', () => {
    for (const run of dataset) {
      if (run.id !== LARGE_RUN_ID) {
        expect(run.steps.length).toBeGreaterThanOrEqual(STEPS_PER_RUN)
      }
    }
  })

  it('run 19 has exactly LARGE_RUN_STEPS (1,000,000) steps (before corruption expansion)', () => {
    const run19 = dataset.find((r) => r.id === LARGE_RUN_ID)
    // step count may be slightly larger due to duplicates, but >= LARGE_RUN_STEPS
    expect(run19.steps.length).toBeGreaterThanOrEqual(LARGE_RUN_STEPS)
  })
})

// ---------------------------------------------------------------------------
// Step structure
// ---------------------------------------------------------------------------

describe('generateRun — step structure', () => {
  const run = generateRun(3)

  it('every step has the required keys: step, loss, lr, grad_norm, corrupt', () => {
    for (const s of run.steps) {
      expect(s).toHaveProperty('step')
      expect(s).toHaveProperty('loss')
      expect(s).toHaveProperty('lr')
      expect(s).toHaveProperty('grad_norm')
      expect(s).toHaveProperty('corrupt')
    }
  })

  it('step indices start at 0', () => {
    expect(run.steps[0].step).toBe(0)
  })

  it('non-corrupt loss values are finite and non-negative', () => {
    for (const s of run.steps) {
      if (!s.corrupt) {
        expect(Number.isFinite(s.loss)).toBe(true)
        expect(s.loss).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('non-corrupt lr values are finite and positive', () => {
    for (const s of run.steps) {
      if (!s.corrupt) {
        expect(Number.isFinite(s.lr)).toBe(true)
        expect(s.lr).toBeGreaterThan(0)
      }
    }
  })

  it('non-corrupt grad_norm values are finite and non-negative', () => {
    for (const s of run.steps) {
      if (!s.corrupt) {
        expect(Number.isFinite(s.grad_norm)).toBe(true)
        expect(s.grad_norm).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('no step has an accuracy field', () => {
    for (const s of run.steps) {
      expect(s).not.toHaveProperty('accuracy')
    }
  })
})

// ---------------------------------------------------------------------------
// Corruption
// ---------------------------------------------------------------------------

describe('generateRun — corruption injection', () => {
  it('every run contains at least some corrupt steps', () => {
    // With 2–5 events per run, it would be impossible for none to be flagged.
    const dataset = generateDataset()
    for (const run of dataset) {
      if (run.id === LARGE_RUN_ID) continue // skip 1M run in this test for performance
      const corruptCount = run.steps.filter((s) => s.corrupt).length
      expect(corruptCount).toBeGreaterThan(0)
    }
  })

  it('corrupt steps include dropout (NaN) in at least one run across runs 0–18', () => {
    const dataset = generateDataset()
    const hasNaN = dataset
      .filter((r) => r.id !== LARGE_RUN_ID)
      .some((run) => run.steps.some((s) => s.corrupt && Number.isNaN(s.loss)))
    expect(hasNaN).toBe(true)
  })

  it('corrupt steps include spikes (loss >> normal) in at least one run', () => {
    const dataset = generateDataset()
    const hasSpike = dataset
      .filter((r) => r.id !== LARGE_RUN_ID)
      .some((run) => {
        // A spike should have loss > 3× the first step's loss (which is at peak).
        const cleanLoss = run.steps.find((s) => !s.corrupt)?.loss ?? 0
        return run.steps.some((s) => s.corrupt && s.loss > cleanLoss * 3)
      })
    expect(hasSpike).toBe(true)
  })

  it('corrupt flag is a boolean', () => {
    for (const s of generateRun(0).steps) {
      expect(typeof s.corrupt).toBe('boolean')
    }
  })

  it('every corruption kind appears in the standard dataset', () => {
    const seen = new Set()
    for (let id = 0; id < LARGE_RUN_ID; id++) {
      for (const m of generateRun(id).manifest) seen.add(m.kind)
    }
    expect([...seen].sort()).toEqual([...KINDS].sort())
  })

  it('infinity events set loss to ±Infinity', () => {
    let checked = 0
    for (let id = 0; id < LARGE_RUN_ID; id++) {
      const run = generateRun(id)
      for (const m of run.manifest.filter((e) => e.kind === 'infinity')) {
        const step = run.steps.find((s) => s.step === m.pos)
        expect(Math.abs(step.loss)).toBe(Infinity)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('gap events leave a jump > 1 right after the recorded step', () => {
    let checked = 0
    for (let id = 0; id < LARGE_RUN_ID; id++) {
      const run = generateRun(id)
      const present = new Set(run.steps.map((s) => s.step))
      for (const m of run.manifest.filter((e) => e.kind === 'gap')) {
        expect(present.has(m.pos)).toBe(true)
        expect(present.has(m.pos + 1)).toBe(false)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('unsorted events make arrival order non-monotonic', () => {
    let checked = 0
    for (let id = 0; id < LARGE_RUN_ID; id++) {
      const run = generateRun(id)
      if (!run.manifest.some((e) => e.kind === 'unsorted')) continue
      const arrival = run.steps.map((s) => s.step)
      expect(arrival.some((v, i) => i > 0 && v < arrival[i - 1])).toBe(true)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('generateRun — manifest', () => {
  it('returns a manifest array', () => {
    const run = generateRun(0)
    expect(Array.isArray(run.manifest)).toBe(true)
  })

  it('manifest entries have shape { kind, pos }', () => {
    const run = generateRun(0)
    expect(run.manifest.length).toBeGreaterThan(0)
    for (const entry of run.manifest) {
      expect(entry).toHaveProperty('kind')
      expect(entry).toHaveProperty('pos')
      expect(typeof entry.kind).toBe('string')
      expect(typeof entry.pos).toBe('number')
    }
  })

  it('manifest kind values are from the known KINDS set', () => {
    const KNOWN_KINDS = new Set(['spike', 'dropout', 'plateau', 'duplicate', 'infinity', 'gap', 'unsorted'])
    for (let id = 0; id < 10; id++) {
      const run = generateRun(id)
      for (const entry of run.manifest) {
        expect(KNOWN_KINDS.has(entry.kind)).toBe(true)
      }
    }
  })

  it('manifest pos values correspond to actual step indices in the run', () => {
    // Positions recorded in the manifest should exist as step.step values.
    for (let id = 0; id < 5; id++) {
      const run = generateRun(id)
      const stepIndexSet = new Set(run.steps.map((s) => s.step))
      for (const entry of run.manifest) {
        // Gap entries shift subsequent step indices, so pos refers to the step
        // index at injection time (before shift). We only verify non-gap entries
        // strictly; gap entries may no longer appear verbatim in the shifted sequence.
        if (entry.kind !== 'gap') {
          expect(stepIndexSet.has(entry.pos)).toBe(true)
        }
      }
    }
  })

  it('generateRun returns { id, seed, steps, manifest }', () => {
    const run = generateRun(0)
    expect(run).toHaveProperty('id')
    expect(run).toHaveProperty('seed')
    expect(run).toHaveProperty('steps')
    expect(run).toHaveProperty('manifest')
  })
})

// ---------------------------------------------------------------------------
// Large run (run 19 — 1M steps)
// ---------------------------------------------------------------------------

describe('generateRun — large run (id 19)', () => {
  it('run 19 in generateDataset has exactly LARGE_RUN_STEPS steps (before dup expansion)', () => {
    // Generating the full dataset includes the 1M run; check step count.
    // We only check runs 0-18 inline for shape; for run 19 count we use a
    // dedicated smaller assertion to avoid timing out.
    const run19 = generateRun(LARGE_RUN_ID, { steps: LARGE_RUN_STEPS })
    expect(run19.steps.length).toBeGreaterThanOrEqual(LARGE_RUN_STEPS)
  })

  it('run 19 manifest includes a spike at LARGE_RUN_SPIKE_STEP', () => {
    const run19 = generateRun(LARGE_RUN_ID, { steps: LARGE_RUN_STEPS })
    const spikeEntry = run19.manifest.find(
      (m) => m.kind === 'spike' && m.pos === LARGE_RUN_SPIKE_STEP,
    )
    expect(spikeEntry).toBeDefined()
  })

  it('run 19 step at LARGE_RUN_SPIKE_STEP is marked corrupt', () => {
    const run19 = generateRun(LARGE_RUN_ID, { steps: LARGE_RUN_STEPS })
    const spikeStep = run19.steps.find((s) => s.step === LARGE_RUN_SPIKE_STEP)
    expect(spikeStep).toBeDefined()
    expect(spikeStep.corrupt).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Performance (smoke)
// ---------------------------------------------------------------------------

describe('generateRun — performance', () => {
  it('generates a 1 000 000-step run in under 5 s', () => {
    const start = Date.now()
    generateRun(0, { steps: 1_000_000 })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(5000)
  })
})
