import { describe, expect, it } from 'vitest'
import {
  generateRun,
  generateDataset,
  RUN_COUNT,
  STEPS_PER_RUN,
  DEFAULT_ROOT_SEED,
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

  it('each run step array has at least STEPS_PER_RUN entries (duplicates may add more)', () => {
    for (const run of dataset) {
      expect(run.steps.length).toBeGreaterThanOrEqual(STEPS_PER_RUN)
    }
  })
})

// ---------------------------------------------------------------------------
// Step structure
// ---------------------------------------------------------------------------

describe('generateRun — step structure', () => {
  const run = generateRun(3)

  it('every step has the required keys', () => {
    for (const s of run.steps) {
      expect(s).toHaveProperty('step')
      expect(s).toHaveProperty('loss')
      expect(s).toHaveProperty('accuracy')
      expect(s).toHaveProperty('corrupt')
    }
  })

  it('step indices start at 0', () => {
    expect(run.steps[0].step).toBe(0)
  })

  it('non-corrupt loss values are finite and positive', () => {
    for (const s of run.steps) {
      if (!s.corrupt) {
        expect(Number.isFinite(s.loss)).toBe(true)
        expect(s.loss).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('non-corrupt accuracy is in [0, 1]', () => {
    for (const s of run.steps) {
      if (!s.corrupt) {
        expect(s.accuracy).toBeGreaterThanOrEqual(0)
        expect(s.accuracy).toBeLessThanOrEqual(1)
      }
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
      const corruptCount = run.steps.filter((s) => s.corrupt).length
      expect(corruptCount).toBeGreaterThan(0)
    }
  })

  it('corrupt steps include dropout (NaN) in at least one run across the dataset', () => {
    const dataset = generateDataset()
    const hasNaN = dataset.some((run) =>
      run.steps.some((s) => s.corrupt && Number.isNaN(s.loss)),
    )
    expect(hasNaN).toBe(true)
  })

  it('corrupt steps include spikes (loss >> normal) in at least one run', () => {
    const dataset = generateDataset()
    const hasSpike = dataset.some((run) => {
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
})

// ---------------------------------------------------------------------------
// Performance (smoke)
// ---------------------------------------------------------------------------

describe('generateRun — performance', () => {
  it('generates a 1 000 000-step run in under 2 s', () => {
    const start = Date.now()
    generateRun(0, { steps: 1_000_000 })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000)
  })
})
