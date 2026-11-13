/**
 * Sanitizer — Issue #11.
 *
 * Accepts the raw step array produced by the generator (Issue #10) and returns
 * a normalised, columnar representation ready for the canvas engine.
 *
 * Pipeline (applied in order):
 *   1. Sort by step index (guards against out-of-order / duplicate injection).
 *   2. Deduplicate: when two entries share the same step index, the LAST one
 *      seen (after sort, so last in original arrival order among same step)
 *      wins (last-write-wins). The winning entry for a colliding step gets
 *      `anomaly: true`. Collisions are counted.
 *   3. Gap detection: after dedup, detect step index gaps (jump > 1). Flag the
 *      step immediately after the gap with `anomaly: true`. Count gaps.
 *   4. Flag anomalies: mark each step as an anomaly when any metric is NaN,
 *      non-finite, or is a statistical outlier (|loss − median| > MAD_THRESHOLD
 *      × MAD in a rolling window of 20 steps). Anomalies are NOT removed —
 *      the renderer decides how to draw them. The `corrupt` field from the
 *      generator is NOT used for anomaly detection.
 *   5. Emit columnar output: parallel typed-array buffers — one element per
 *      step — so downstream code can slice, transfer to a Worker, or pass
 *      directly to WebGL without object allocation.
 *
 * Design constraints
 *   - No external dependencies.
 *   - Pure functions only (same input → same output).
 *   - NaN is preserved in the output buffers; callers must guard with
 *     Number.isFinite() before arithmetic.
 *   - The `anomaly` column uses a Uint8Array with 1 for true, 0 for false.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Z-score threshold (kept for API compatibility).
 * Detection now uses MAD instead of z-score; see MAD_THRESHOLD.
 */
export const Z_THRESHOLD = 3.5

/**
 * Median Absolute Deviation threshold for rolling outlier detection.
 * Steps where |loss − median| > MAD_THRESHOLD × MAD are flagged as anomalies.
 */
export const MAD_THRESHOLD = 3.5

/**
 * Rolling window size for the median + MAD outlier detection.
 */
const ROLLING_WINDOW = 20

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the median of an array of numbers (must be pre-sorted or unsorted).
 * Returns 0 for an empty array.
 *
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Compute the Median Absolute Deviation (MAD) of an array of finite numbers.
 * MAD = median(|x_i − median(x)|)
 *
 * @param {number[]} values - Finite numbers only.
 * @param {number} med      - Pre-computed median of values.
 * @returns {number}
 */
function mad(values, med) {
  if (values.length === 0) return 0
  const deviations = values.map((v) => Math.abs(v - med))
  return median(deviations)
}

/**
 * Sort a step array by step index, ascending.
 * Returns a new array; does not mutate the input.
 *
 * @param {Array<{ step: number }>} steps
 * @returns {Array<{ step: number }>}
 */
function sortSteps(steps) {
  return steps.slice().sort((a, b) => a.step - b.step)
}

/**
 * Remove duplicate step indices using last-write-wins semantics.
 * When two entries share the same step index, the LAST one in the sorted
 * order wins. The winning entry for any colliding step index is flagged
 * with a `_collision` marker so the caller can set `anomaly: true`.
 *
 * Returns the deduped array and a collision count.
 *
 * @param {Array<{ step: number }>} sorted - Already sorted ascending.
 * @returns {{ deduped: Array<{ step: number }>, collisions: number }}
 */
function dedupeSteps(sorted) {
  const seen = new Map() // step index → index in `out`
  const out = []
  let collisions = 0

  for (const entry of sorted) {
    if (!seen.has(entry.step)) {
      seen.set(entry.step, out.length)
      out.push({ ...entry, _collision: false })
    } else {
      // Last-write-wins: replace the existing entry with this one.
      const idx = seen.get(entry.step)
      out[idx] = { ...entry, _collision: true }
      collisions++
    }
  }

  return { deduped: out, collisions }
}

/**
 * Detect step-index gaps (jumps > 1 between consecutive step indices).
 * Flags the step immediately after a gap with `_gap: true`.
 * Returns the annotated array and a gap count.
 *
 * @param {Array<{ step: number }>} deduped
 * @returns {{ gapped: Array<{ step: number, _gap: boolean }>, gaps: number }}
 */
function detectGaps(deduped) {
  const gapped = deduped.map((s) => ({ ...s, _gap: false }))
  let gaps = 0

  for (let i = 1; i < gapped.length; i++) {
    if (gapped[i].step - gapped[i - 1].step > 1) {
      gapped[i]._gap = true
      gaps++
    }
  }

  return { gapped, gaps }
}

/**
 * Flag anomalies based on three criteria (the `corrupt` field is NOT used):
 *   a) the loss value is non-finite (NaN, ±Infinity), OR
 *   b) the step was flagged by collision or gap detection, OR
 *   c) the loss is a rolling-MAD outlier: |loss − median| > MAD_THRESHOLD × MAD
 *      within a window of ROLLING_WINDOW steps centred on the current step.
 *      If MAD is 0 and the value is non-finite, it is flagged.
 *
 * Returns a new array with added `anomaly: boolean` field on each step.
 * Internal `_collision` and `_gap` markers are stripped.
 *
 * @param {Array<{ loss: number, _collision: boolean, _gap: boolean }>} steps
 * @returns {Array<{ loss: number, anomaly: boolean }>}
 */
function flagAnomalies(steps) {
  const n = steps.length
  const half = Math.floor(ROLLING_WINDOW / 2)

  return steps.map((s, i) => {
    // Strip internal markers from output.
    // eslint-disable-next-line no-unused-vars
    const { _collision, _gap, ...rest } = s

    const nonFinite = !Number.isFinite(s.loss)
    const isCollisionOrGap = Boolean(s._collision || s._gap)

    // Build rolling window of finite loss values.
    const lo = Math.max(0, i - half)
    const hi = Math.min(n - 1, i + half)
    const windowFinite = []
    for (let j = lo; j <= hi; j++) {
      if (Number.isFinite(steps[j].loss)) windowFinite.push(steps[j].loss)
    }

    let outlier = false
    if (!nonFinite && windowFinite.length > 0) {
      const med = median(windowFinite)
      const madVal = mad(windowFinite, med)
      if (madVal === 0) {
        // If all window values are identical, flag only genuinely different values.
        outlier = s.loss !== med
      } else {
        outlier = Math.abs(s.loss - med) > MAD_THRESHOLD * madVal
      }
    }

    return { ...rest, anomaly: nonFinite || isCollisionOrGap || outlier }
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SanitizedRun
 * @property {number}       id         - Run id (passed through from the input).
 * @property {number}       length     - Number of steps after dedup.
 * @property {Float64Array} steps      - Step indices (integers, as floats).
 * @property {Float64Array} loss       - Loss values; NaN where data is missing.
 * @property {Float64Array} lr         - Learning rate values.
 * @property {Float64Array} grad_norm  - Gradient L2 norm values.
 * @property {Uint8Array}   anomaly    - 1 = anomaly, 0 = clean.
 * @property {number}       collisions - Number of duplicate step indices resolved.
 * @property {number}       gaps       - Number of step-index gaps detected.
 */

/**
 * Sanitize a single run produced by `generateRun()`.
 *
 * @param {{ id: number, steps: Array<{ step: number, loss: number, lr: number, grad_norm: number, corrupt: boolean }> }} run
 * @returns {SanitizedRun}
 */
export function sanitizeRun(run) {
  const sorted = sortSteps(run.steps)
  const { deduped, collisions } = dedupeSteps(sorted)
  const { gapped, gaps } = detectGaps(deduped)
  const flagged = flagAnomalies(gapped)

  const n = flagged.length
  const stepsBuf = new Float64Array(n)
  const lossBuf = new Float64Array(n)
  const lrBuf = new Float64Array(n)
  const gradNormBuf = new Float64Array(n)
  const anomalyBuf = new Uint8Array(n)

  for (let i = 0; i < n; i++) {
    const s = flagged[i]
    stepsBuf[i] = s.step
    lossBuf[i] = s.loss           // NaN propagates naturally into Float64Array
    lrBuf[i] = s.lr ?? NaN
    gradNormBuf[i] = s.grad_norm ?? NaN
    anomalyBuf[i] = s.anomaly ? 1 : 0
  }

  return {
    id: run.id,
    length: n,
    steps: stepsBuf,
    loss: lossBuf,
    lr: lrBuf,
    grad_norm: gradNormBuf,
    anomaly: anomalyBuf,
    collisions,
    gaps,
  }
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
