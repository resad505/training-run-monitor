/**
 * Sanitizer — Issue #11.
 *
 * Accepts the raw step array produced by the generator (Issue #10) and returns
 * a normalised, columnar representation ready for the canvas engine.
 *
 * Pipeline (applied in order):
 *   1. Sort by step index. The sort is stable, so entries that share a step
 *      index keep their arrival order.
 *   2. Deduplicate, last-write-wins by arrival order: for a repeated step
 *      index, the entry that arrived last is kept. The kept entry is flagged
 *      COLLISION and every collision is counted.
 *   3. Gap detection: a jump between consecutive step indices larger than
 *      EXPECTED_STRIDE flags the step after the gap with GAP and is counted.
 *   4. Value checks on `loss` (the generator's `corrupt` field is never read):
 *        NON_FINITE — NaN or ±Infinity.
 *        PLATEAU    — PLATEAU_MIN_RUN or more consecutive steps with exactly
 *                     the same finite loss. Real float losses essentially never
 *                     repeat bit-for-bit, so this indicates a stuck logger or
 *                     optimiser.
 *        OUTLIER    — the residual against a rolling median (TREND_WINDOW
 *                     neighbours, which follows the decaying trend; at the
 *                     first/last steps a Theil–Sen line through the nearest
 *                     EDGE_FIT neighbours) exceeds OUTLIER_THRESHOLD robust
 *                     standard deviations. The step itself is excluded from
 *                     its own baseline. The robust
 *                     σ is 1.4826 × MAD of the residuals, estimated per block
 *                     of SCALE_BLOCK steps so it adapts to the run's noise.
 *      Values are never dropped or replaced.
 *   5. Emit columnar output: one Float64Array per field plus a Uint8Array of
 *      anomaly flags (bitmask of ANOMALY values; 0 = clean).
 *
 * Design constraints
 *   - No external dependencies.
 *   - Pure functions only (same input → same output).
 *   - NaN / ±Infinity are preserved in the output buffers; callers must guard
 *     with Number.isFinite() before arithmetic.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Anomaly bit flags stored in the `anomaly` Uint8Array. */
export const ANOMALY = Object.freeze({
  NON_FINITE: 1,
  OUTLIER: 2,
  COLLISION: 4,
  GAP: 8,
  PLATEAU: 16,
})

/** Expected distance between consecutive step indices. Larger jumps are gaps. */
export const EXPECTED_STRIDE = 1

/** Residual threshold, in robust standard deviations, for OUTLIER. */
export const OUTLIER_THRESHOLD = 3.5

/** Rolling-median window (odd) used to follow the loss trend. */
export const TREND_WINDOW = 11

/** Block size over which the residual noise scale (robust σ) is estimated. */
export const SCALE_BLOCK = 1024

/** Minimum number of consecutive identical losses flagged as PLATEAU. */
export const PLATEAU_MIN_RUN = 3

/** Neighbours used for the robust line fit at the first/last steps. */
const EDGE_FIT = 6

/** Converts MAD to a standard-deviation estimate for Gaussian noise. */
const MAD_TO_SIGMA = 1.4826

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Median of the first `n` entries of a scratch buffer (sorted in place).
 * @param {Float64Array} buf
 * @param {number} n
 * @returns {number}
 */
function medianInPlace(buf, n) {
  const view = buf.subarray(0, n).sort()
  const mid = n >> 1
  return n % 2 === 0 ? (view[mid - 1] + view[mid]) / 2 : view[mid]
}

/**
 * Sort by step index (stable) and resolve duplicates last-write-wins.
 * @param {Array<{ step: number }>} raw
 * @returns {{ entries: Array<object>, collided: Uint8Array, collisions: number }}
 */
function sortAndDedupe(raw) {
  const sorted = raw.slice().sort((a, b) => a.step - b.step)
  const entries = []
  const collidedList = []
  let collisions = 0

  for (const entry of sorted) {
    const last = entries.length - 1
    if (last >= 0 && entries[last].step === entry.step) {
      // Same step; stable sort means `entry` arrived later → it wins.
      entries[last] = entry
      collidedList[last] = 1
      collisions++
    } else {
      entries.push(entry)
      collidedList.push(0)
    }
  }

  return { entries, collided: Uint8Array.from(collidedList), collisions }
}

/**
 * Predict loss at index `at` from a Theil–Sen line fitted to the finite
 * values in [lo, hi], excluding `at` itself. Returns NaN with no data.
 * @param {Float64Array} loss
 * @param {number} lo
 * @param {number} hi
 * @param {number} at
 * @returns {number}
 */
function theilSenAt(loss, lo, hi, at) {
  const xs = []
  for (let j = lo; j <= hi; j++) {
    if (j !== at && Number.isFinite(loss[j])) xs.push(j)
  }
  if (xs.length === 0) return NaN
  if (xs.length === 1) return loss[xs[0]]

  const slopes = new Float64Array((xs.length * (xs.length - 1)) / 2)
  let k = 0
  for (let a = 0; a < xs.length; a++) {
    for (let b = a + 1; b < xs.length; b++) {
      slopes[k++] = (loss[xs[b]] - loss[xs[a]]) / (xs[b] - xs[a])
    }
  }
  const slope = medianInPlace(slopes, k)
  const intercepts = Float64Array.from(xs, (x) => loss[x] - slope * x)
  return medianInPlace(intercepts, intercepts.length) + slope * at
}

/**
 * Flag OUTLIER using rolling-median residuals and a block-wise robust σ.
 * @param {Float64Array} loss
 * @param {Uint8Array} flags - mutated
 */
function flagOutliers(loss, flags) {
  const n = loss.length
  const half = TREND_WINDOW >> 1
  const win = new Float64Array(TREND_WINDOW)
  const residual = new Float64Array(n).fill(NaN)

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(loss[i])) continue
    // The step itself is left out of its own baseline, otherwise it pulls the
    // estimate toward itself, shrinks the residuals and hides the outlier.
    if (i >= half && i < n - half) {
      let k = 0
      for (let j = i - half; j <= i + half; j++) {
        if (j !== i && Number.isFinite(loss[j])) win[k++] = loss[j]
      }
      if (k > 0) residual[i] = loss[i] - medianInPlace(win, k)
    } else {
      // Near the edges a one-sided median is biased by the trend, so
      // extrapolate a robust line through the nearest EDGE_FIT neighbours
      // instead (few points, so the curve's bend barely matters).
      const lo = Math.max(0, Math.min(i - (EDGE_FIT >> 1), n - 1 - EDGE_FIT))
      const hi = Math.min(n - 1, lo + EDGE_FIT)
      const predicted = theilSenAt(loss, lo, hi, i)
      if (Number.isFinite(predicted)) residual[i] = loss[i] - predicted
    }
  }

  const scratch = new Float64Array(Math.min(SCALE_BLOCK, n))
  for (let start = 0; start < n; start += SCALE_BLOCK) {
    const end = Math.min(start + SCALE_BLOCK, n)
    let k = 0
    for (let i = start; i < end; i++) {
      if (Number.isFinite(residual[i])) scratch[k++] = Math.abs(residual[i])
    }
    if (k === 0) continue
    const sigma = MAD_TO_SIGMA * medianInPlace(scratch, k)
    const limit = OUTLIER_THRESHOLD * sigma
    for (let i = start; i < end; i++) {
      const r = Math.abs(residual[i])
      // With zero noise any deviation from the trend is an outlier.
      if (sigma === 0 ? r > 0 : r > limit) flags[i] |= ANOMALY.OUTLIER
    }
  }
}

/**
 * Flag PLATEAU: runs of PLATEAU_MIN_RUN+ consecutive identical finite losses.
 * @param {Float64Array} loss
 * @param {Uint8Array} flags - mutated
 */
function flagPlateaus(loss, flags) {
  const n = loss.length
  let start = 0
  for (let i = 1; i <= n; i++) {
    if (i < n && Number.isFinite(loss[i]) && loss[i] === loss[start]) continue
    if (i - start >= PLATEAU_MIN_RUN) {
      for (let j = start; j < i; j++) flags[j] |= ANOMALY.PLATEAU
    }
    start = i
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SanitizedRun
 * @property {number}       id         - Run id (passed through from the input).
 * @property {number}       length     - Number of steps after dedup.
 * @property {Float64Array} steps      - Step indices (integers, as floats).
 * @property {Float64Array} loss       - Loss values; NaN/±Infinity kept as-is.
 * @property {Float64Array} lr         - Learning rate values.
 * @property {Float64Array} grad_norm  - Gradient L2 norm values.
 * @property {Uint8Array}   anomaly    - Bitmask of ANOMALY flags; 0 = clean.
 * @property {number}       collisions - Number of duplicate step entries resolved.
 * @property {number}       gaps       - Number of step-index gaps detected.
 */

/**
 * Sanitize a single run produced by `generateRun()`.
 *
 * @param {{ id: number, steps: Array<{ step: number, loss: number, lr: number, grad_norm: number }> }} run
 * @returns {SanitizedRun}
 */
export function sanitizeRun(run) {
  const { entries, collided, collisions } = sortAndDedupe(run.steps)

  const n = entries.length
  const steps = new Float64Array(n)
  const loss = new Float64Array(n)
  const lr = new Float64Array(n)
  const gradNorm = new Float64Array(n)
  const anomaly = new Uint8Array(n)
  let gaps = 0

  for (let i = 0; i < n; i++) {
    const e = entries[i]
    steps[i] = e.step
    loss[i] = e.loss
    lr[i] = e.lr ?? NaN
    gradNorm[i] = e.grad_norm ?? NaN

    if (collided[i]) anomaly[i] |= ANOMALY.COLLISION
    if (!Number.isFinite(e.loss)) anomaly[i] |= ANOMALY.NON_FINITE
    if (i > 0 && steps[i] - steps[i - 1] > EXPECTED_STRIDE) {
      anomaly[i] |= ANOMALY.GAP
      gaps++
    }
  }

  flagPlateaus(loss, anomaly)
  flagOutliers(loss, anomaly)

  return { id: run.id, length: n, steps, loss, lr, grad_norm: gradNorm, anomaly, collisions, gaps }
}

/**
 * Sanitize every run in a dataset array.
 *
 * @param {Array<ReturnType<import('./generator.js').generateRun>>} dataset
 * @returns {SanitizedRun[]}
 */
export function sanitizeDataset(dataset) {
  return dataset.map(sanitizeRun)
}
