/**
 * Deterministic training-run generator — Issue #10.
 *
 * Produces 20 synthetic training runs, each identified by a numeric id and a
 * seed derived from that id so the full dataset is reproducible from a single
 * root seed without shared PRNG state between runs.
 *
 * Each run is an array of step objects:
 *   { step: number, loss: number, accuracy: number, corrupt: boolean }
 *
 * Corruption kinds injected deterministically:
 *   - spike   : loss jumps to an extreme value for one step
 *   - dropout : loss set to NaN (missing / dropped measurement)
 *   - plateau : loss freezes at the same value for several consecutive steps
 *   - duplicate : a step index is emitted twice (out-of-order ingestion sim.)
 *
 * Design constraints
 *   - No external dependencies; uses only the project's own mulberry32 PRNG.
 *   - All outputs are plain JS (no TypeScript); the sanitizer (Issue #11) will
 *     convert them to Float64Arrays.
 *   - Every public function is pure (same inputs → same outputs).
 */

import { mulberry32 } from './prng.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of training runs produced by generateDataset(). */
export const RUN_COUNT = 20

/** Steps per run before corruption expansion. */
export const STEPS_PER_RUN = 200

/**
 * Root seed used by generateDataset().
 * Override via the `rootSeed` option to reproduce a different dataset family.
 */
export const DEFAULT_ROOT_SEED = 0xdeadbeef

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive a per-run seed that is stable regardless of evaluation order.
 * Uses a simple bijection so adjacent run ids produce unrelated seeds.
 *
 * @param {number} rootSeed - uint32
 * @param {number} runId    - 0-based run index
 * @returns {number} uint32 seed
 */
function deriveRunSeed(rootSeed, runId) {
  // Mix runId into rootSeed with a couple of non-linear operations so that
  // run 0 and run 1 do not produce nearly identical sequences.
  const mixed = Math.imul((rootSeed ^ (runId * 0x9e3779b9)) >>> 0, 0x517cc1b7)
  return mixed >>> 0
}

/**
 * Generate the "clean" exponentially-decaying loss + mirrored accuracy curve
 * for a single run.
 *
 * Loss follows:  L(t) = base + (peak − base) · exp(−t / τ) + noise
 * Accuracy:      A(t) = 1 − L(t) / peak  (clamped to [0, 1])
 *
 * @param {{ next: () => number }} rng
 * @param {number} steps
 * @returns {Array<{ step: number, loss: number, accuracy: number, corrupt: boolean }>}
 */
function generateCleanSteps(rng, steps) {
  const peak = 2.5 + rng.next() * 1.5   // loss at step 0: [2.5, 4.0]
  const base = 0.05 + rng.next() * 0.15  // asymptotic floor: [0.05, 0.20]
  const tau = 30 + rng.next() * 70       // time constant in steps: [30, 100]
  const noiseScale = 0.02 + rng.next() * 0.08  // per-step noise amplitude

  const result = []
  for (let t = 0; t < steps; t++) {
    const trend = base + (peak - base) * Math.exp(-t / tau)
    const noise = (rng.next() - 0.5) * 2 * noiseScale
    const loss = Math.max(0, trend + noise)
    const accuracy = Math.min(1, Math.max(0, 1 - loss / peak))
    result.push({ step: t, loss, accuracy, corrupt: false })
  }
  return result
}

/**
 * Inject corruption events into a clean step array.
 * Mutations happen in-place; corrupted entries get `corrupt: true`.
 *
 * Corruption budget: 2–5 events per run, positions chosen deterministically.
 *
 * @param {{ next: () => number, nextInt: (lo: number, hi: number) => number }} rng
 * @param {Array<{ step: number, loss: number, accuracy: number, corrupt: boolean }>} steps
 * @returns {Array<{ step: number, loss: number, accuracy: number, corrupt: boolean }>}
 *   A new array (may be longer than `steps` if duplicates are injected).
 */
function injectCorruption(rng, steps) {
  const KINDS = ['spike', 'dropout', 'plateau', 'duplicate']
  const count = rng.nextInt(2, 5)

  // Work on a shallow copy so the original is unchanged.
  const out = steps.slice()

  // Keep track of used positions to avoid stacking two events on the same step.
  const usedPositions = new Set()

  for (let i = 0; i < count; i++) {
    const kind = KINDS[rng.nextInt(0, KINDS.length - 1)]

    // Pick a position away from the very first and last 5 steps so the
    // corruption is never clipped by boundary conditions.
    let pos
    let attempts = 0
    do {
      pos = rng.nextInt(5, out.length - 6)
      attempts++
    } while (usedPositions.has(pos) && attempts < 20)
    usedPositions.add(pos)

    switch (kind) {
      case 'spike': {
        // Loss jumps to 3–8× its current value for exactly one step.
        const factor = 3 + rng.next() * 5
        out[pos] = {
          ...out[pos],
          loss: out[pos].loss * factor,
          accuracy: Math.max(0, out[pos].accuracy * (1 / factor)),
          corrupt: true,
        }
        break
      }

      case 'dropout': {
        // Measurement missing — NaN signals "no data" to the sanitizer.
        out[pos] = { ...out[pos], loss: NaN, accuracy: NaN, corrupt: true }
        break
      }

      case 'plateau': {
        // Loss freezes for 3–8 consecutive steps (simulate stuck optimizer).
        const length = rng.nextInt(3, 8)
        const frozenLoss = out[pos].loss
        const frozenAcc = out[pos].accuracy
        for (let j = pos; j < Math.min(pos + length, out.length); j++) {
          out[j] = { ...out[j], loss: frozenLoss, accuracy: frozenAcc, corrupt: true }
          usedPositions.add(j)
        }
        break
      }

      case 'duplicate': {
        // Insert a copy of this step immediately after it (same step index).
        const dup = { ...out[pos], corrupt: true }
        out.splice(pos + 1, 0, dup)
        break
      }
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a single synthetic training run.
 *
 * @param {number} runId   - 0-based index (0–19 for the standard dataset)
 * @param {object} [opts]
 * @param {number} [opts.rootSeed=DEFAULT_ROOT_SEED] - uint32 root seed
 * @param {number} [opts.steps=STEPS_PER_RUN]        - clean steps before corruption
 * @returns {{
 *   id: number,
 *   seed: number,
 *   steps: Array<{ step: number, loss: number, accuracy: number, corrupt: boolean }>
 * }}
 */
export function generateRun(runId, { rootSeed = DEFAULT_ROOT_SEED, steps = STEPS_PER_RUN } = {}) {
  const seed = deriveRunSeed(rootSeed, runId)
  const rng = mulberry32(seed)

  const clean = generateCleanSteps(rng, steps)
  const corrupted = injectCorruption(rng, clean)

  return { id: runId, seed, steps: corrupted }
}

/**
 * Generate the full dataset of RUN_COUNT training runs.
 *
 * Each run uses an independent PRNG derived from `rootSeed` so runs can be
 * generated in any order and still produce identical results.
 *
 * @param {object} [opts]
 * @param {number} [opts.rootSeed=DEFAULT_ROOT_SEED]
 * @param {number} [opts.steps=STEPS_PER_RUN]
 * @returns {Array<ReturnType<typeof generateRun>>}
 */
export function generateDataset({ rootSeed = DEFAULT_ROOT_SEED, steps = STEPS_PER_RUN } = {}) {
  return Array.from({ length: RUN_COUNT }, (_, id) => generateRun(id, { rootSeed, steps }))
}
