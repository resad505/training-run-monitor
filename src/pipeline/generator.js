/**
 * Deterministic training-run generator — Issue #10.
 *
 * Produces 20 synthetic training runs, each identified by a numeric id and a
 * seed derived from that id so the full dataset is reproducible from a single
 * root seed without shared PRNG state between runs.
 *
 * Each run is an array of step objects:
 *   { step: number, loss: number, lr: number, grad_norm: number, corrupt: boolean }
 *
 * Corruption kinds injected deterministically:
 *   - spike     : loss jumps to an extreme value for one step
 *   - dropout   : loss set to NaN (missing / dropped measurement)
 *   - plateau   : loss freezes at the same value for several consecutive steps
 *   - duplicate : a step index is emitted twice (out-of-order ingestion sim.)
 *   - infinity  : loss set to +Infinity or -Infinity for one step
 *   - gap       : skip 2–5 consecutive step indices (gap in sequence)
 *   - unsorted  : a block of 3–6 consecutive entries arrives in reverse order
 *                 (values stay valid; only arrival order is wrong)
 *
 * Every run's first event kind is KINDS[runId % KINDS.length], so the
 * standard 20-run dataset is guaranteed to contain every corruption kind.
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

/** Steps per run before corruption expansion (used for runs 0–18). */
export const STEPS_PER_RUN = 200

/**
 * Root seed used by generateDataset().
 * Override via the `rootSeed` option to reproduce a different dataset family.
 */
export const DEFAULT_ROOT_SEED = 0xdeadbeef

/**
 * Run id for the large 1M-step run.
 * Run 19 is generated with LARGE_RUN_STEPS steps instead of STEPS_PER_RUN.
 */
export const LARGE_RUN_ID = 19

/**
 * Number of steps for the large run (run id 19).
 */
export const LARGE_RUN_STEPS = 1_000_000

/**
 * Fixed step index where a "1M spike" is injected in the large run.
 * Exported so tests and downstream consumers can reference the documented position.
 */
export const LARGE_RUN_SPIKE_STEP = 500_000

/** Corruption kinds, in the order used for the per-run guaranteed first event. */
export const KINDS = Object.freeze(['spike', 'dropout', 'plateau', 'duplicate', 'infinity', 'gap', 'unsorted'])

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
 * Generate the "clean" exponentially-decaying loss curve with lr and grad_norm
 * for a single run.
 *
 * Loss follows:  L(t) = base + (peak − base) · exp(−t / τ) + noise
 * LR:            cosine decay from lrPeak to lrMin over `steps`
 * grad_norm:     correlated with loss but slightly noisier
 *
 * @param {{ next: () => number }} rng
 * @param {number} steps
 * @returns {Array<{ step: number, loss: number, lr: number, grad_norm: number, corrupt: boolean }>}
 */
function generateCleanSteps(rng, steps) {
  const peak = 2.5 + rng.next() * 1.5         // loss at step 0: [2.5, 4.0]
  const base = 0.05 + rng.next() * 0.15       // asymptotic floor: [0.05, 0.20]
  const tau = 30 + rng.next() * 70            // time constant in steps: [30, 100]
  const noiseScale = 0.02 + rng.next() * 0.08 // per-step noise amplitude

  // LR schedule parameters (cosine decay)
  const lrPeak = 1e-3 + rng.next() * 9e-3     // initial lr: [1e-3, 1e-2]
  const lrMin = 1e-5 + rng.next() * 9e-5      // final lr: [1e-5, 1e-4]

  const result = []
  for (let t = 0; t < steps; t++) {
    const trend = base + (peak - base) * Math.exp(-t / tau)
    const noise = (rng.next() - 0.5) * 2 * noiseScale
    const loss = Math.max(0, trend + noise)

    // Cosine-decay LR (always positive and finite)
    const cosinePhase = (Math.PI * t) / Math.max(1, steps - 1)
    const lr = lrMin + 0.5 * (lrPeak - lrMin) * (1 + Math.cos(cosinePhase))

    // grad_norm correlated with loss, plus extra noise
    const gradNoise = (rng.next() - 0.5) * 2 * noiseScale * 2
    const grad_norm = Math.max(0, loss * (0.8 + rng.next() * 0.4) + gradNoise)

    result.push({ step: t, loss, lr, grad_norm, corrupt: false })
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
 * @param {Array<{ step: number, loss: number, lr: number, grad_norm: number, corrupt: boolean }>} steps
 * @param {string} firstKind - kind used for the first event (guarantees coverage)
 * @returns {{ steps: Array<{ step: number, loss: number, lr: number, grad_norm: number, corrupt: boolean }>, manifest: Array<{ kind: string, pos: number }> }}
 */
function injectCorruption(rng, steps, firstKind) {
  const count = rng.nextInt(2, 5)

  // Work on a shallow copy so the original is unchanged.
  const out = steps.slice()

  // Keep track of used positions to avoid stacking two events on the same step.
  const usedPositions = new Set()

  /** @type {Array<{ kind: string, pos: number }>} */
  const manifest = []

  // Reorderings are applied after all other events so that index-based
  // mutations (duplicate splice, gap renumbering) operate on ordered data.
  /** @type {Array<{ step: number, length: number }>} */
  const pendingReorders = []

  for (let i = 0; i < count; i++) {
    const drawn = KINDS[rng.nextInt(0, KINDS.length - 1)]
    const kind = i === 0 ? firstKind : drawn

    // Pick a position away from the very first and last 5 steps so the
    // corruption is never clipped by boundary conditions.
    let pos
    let attempts = 0
    do {
      pos = rng.nextInt(5, out.length - 6)
      attempts++
    } while ((usedPositions.has(pos) || out[pos].corrupt) && attempts < 20)
    usedPositions.add(pos)

    // Record the step index (not the array index) for the manifest.
    const stepIndexAtPos = out[pos].step

    switch (kind) {
      case 'spike': {
        // Loss jumps to 3–8× its current value for exactly one step.
        const factor = 3 + rng.next() * 5
        out[pos] = {
          ...out[pos],
          loss: out[pos].loss * factor,
          corrupt: true,
        }
        manifest.push({ kind, pos: stepIndexAtPos })
        break
      }

      case 'dropout': {
        // Measurement missing — NaN signals "no data" to the sanitizer.
        out[pos] = { ...out[pos], loss: NaN, lr: NaN, grad_norm: NaN, corrupt: true }
        manifest.push({ kind, pos: stepIndexAtPos })
        break
      }

      case 'plateau': {
        // Loss freezes for 3–8 consecutive steps (simulate stuck optimizer).
        const length = rng.nextInt(3, 8)
        const frozenLoss = out[pos].loss
        const frozenGradNorm = out[pos].grad_norm
        // Stop early rather than overwrite an earlier event.
        for (let j = pos; j < Math.min(pos + length, out.length); j++) {
          if (j > pos && out[j].corrupt) break
          out[j] = { ...out[j], loss: frozenLoss, grad_norm: frozenGradNorm, corrupt: true }
          usedPositions.add(j)
        }
        manifest.push({ kind, pos: stepIndexAtPos })
        break
      }

      case 'duplicate': {
        // Insert a copy of this step immediately after it (same step index).
        const dup = { ...out[pos], corrupt: true }
        out.splice(pos + 1, 0, dup)
        manifest.push({ kind, pos: stepIndexAtPos })
        break
      }

      case 'infinity': {
        // Set loss to +Infinity or -Infinity (alternating based on rng).
        const sign = rng.next() < 0.5 ? 1 : -1
        out[pos] = {
          ...out[pos],
          loss: sign * Infinity,
          corrupt: true,
        }
        manifest.push({ kind, pos: stepIndexAtPos })
        break
      }

      case 'gap': {
        // Skip 2–5 consecutive step indices by renumbering subsequent steps.
        const gapSize = rng.nextInt(2, 5)
        // Renumber all steps after pos by adding gapSize to their step index.
        for (let j = pos + 1; j < out.length; j++) {
          out[j] = { ...out[j], step: out[j].step + gapSize }
        }
        // Keep earlier manifest entries pointing at the (renumbered) steps.
        for (const m of manifest) if (m.pos > stepIndexAtPos) m.pos += gapSize
        for (const r of pendingReorders) if (r.step > stepIndexAtPos) r.step += gapSize
        // Mark surrounding steps as corrupt to signal context.
        out[pos] = { ...out[pos], corrupt: true }
        if (pos + 1 < out.length) {
          out[pos + 1] = { ...out[pos + 1], corrupt: true }
        }
        manifest.push({ kind, pos: stepIndexAtPos })
        break
      }

      case 'unsorted': {
        // Defer: reverse a block of 3–6 entries starting at this step.
        pendingReorders.push({ step: stepIndexAtPos, length: rng.nextInt(3, 6) })
        manifest.push({ kind, pos: stepIndexAtPos })
        break
      }
    }
  }

  for (const { step, length } of pendingReorders) {
    const start = out.findIndex((s) => s.step === step)
    const end = Math.min(start + length, out.length)
    const block = out.slice(start, end).reverse()
    out.splice(start, block.length, ...block)
  }

  return { steps: out, manifest }
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
 *   steps: Array<{ step: number, loss: number, lr: number, grad_norm: number, corrupt: boolean }>,
 *   manifest: Array<{ kind: string, pos: number }>
 * }}
 */
export function generateRun(runId, { rootSeed = DEFAULT_ROOT_SEED, steps = STEPS_PER_RUN } = {}) {
  const seed = deriveRunSeed(rootSeed, runId)
  const rng = mulberry32(seed)

  const clean = generateCleanSteps(rng, steps)
  const { steps: corrupted, manifest } = injectCorruption(rng, clean, KINDS[runId % KINDS.length])

  // For the large run (id 19), inject the documented spike at LARGE_RUN_SPIKE_STEP
  // only when this run is generated with LARGE_RUN_STEPS steps.
  if (runId === LARGE_RUN_ID && steps === LARGE_RUN_STEPS) {
    const spikeIdx = corrupted.findIndex((s) => s.step === LARGE_RUN_SPIKE_STEP)
    if (spikeIdx !== -1) {
      corrupted[spikeIdx] = {
        ...corrupted[spikeIdx],
        loss: corrupted[spikeIdx].loss * 10,
        corrupt: true,
      }
      manifest.push({ kind: 'spike', pos: LARGE_RUN_SPIKE_STEP })
    }
  }

  return { id: runId, seed, steps: corrupted, manifest }
}

/**
 * Generate the full dataset of RUN_COUNT training runs.
 *
 * Runs 0–18 use STEPS_PER_RUN steps.
 * Run 19 uses LARGE_RUN_STEPS (1,000,000) steps and includes the documented
 * spike at LARGE_RUN_SPIKE_STEP.
 *
 * Each run uses an independent PRNG derived from `rootSeed` so runs can be
 * generated in any order and still produce identical results.
 *
 * @param {object} [opts]
 * @param {number} [opts.rootSeed=DEFAULT_ROOT_SEED]
 * @returns {Array<ReturnType<typeof generateRun>>}
 */
export function generateDataset({ rootSeed = DEFAULT_ROOT_SEED } = {}) {
  return Array.from({ length: RUN_COUNT }, (_, id) => {
    const steps = id === LARGE_RUN_ID ? LARGE_RUN_STEPS : STEPS_PER_RUN
    return generateRun(id, { rootSeed, steps })
  })
}
