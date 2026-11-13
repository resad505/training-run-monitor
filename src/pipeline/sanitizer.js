/**
 * Sanitizer — Issue #11.
 *
 * Accepts the raw step array produced by the generator (Issue #10) and returns
 * a normalised, columnar representation ready for the canvas engine.
 *
 * Pipeline (applied in order):
 *   1. Sort by step index (guards against out-of-order / duplicate injection).
 *   2. Deduplicate: when two entries share the same step index, keep the one
 *      where `corrupt === false`; if both are corrupt keep the first.
 *   3. Flag anomalies: mark each step as an anomaly when any metric is NaN,
 *      non-finite, or is a statistical outlier (|z-score| > Z_THRESHOLD among
 *      finite values). Anomalies are NOT removed — the renderer decides how to
 *      draw them.
 *   4. Emit columnar output: parallel Float64Array buffers — one element per
 *      step — so downstream code can slice, transfer to a Worker, or pass
 *      directly to WebGL without object allocation.
 *
 * Design constraints
 *   - No external dependencies.
 *   - Pure functions only (same input → same output).
 *   - NaN is preserved in the output buffers; callers must guard with
 *     Number.isFinite() before arithmetic.
 *   - The `anomaly` column uses 1.0 for true, 0.0 for false (Float64Array
 *     does not support booleans).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Z-score threshold for outlier detection among finite values.
 * Steps whose |z-score| exceeds this are flagged as anomalies.
 * 3.5 is a common robust-statistics threshold (less aggressive than 3.0).
 */
export const Z_THRESHOLD = 3.5

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the mean and standard deviation of an array of finite numbers.
 * Returns { mean: 0, std: 0 } for empty or single-element arrays.
 *
 * @param {number[]} values - Only finite numbers; caller must filter.
 * @returns {{ mean: number, std: number }}
 */
function stats(values) {
  if (values.length < 2) return { mean: values[0] ?? 0, std: 0 }
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  return { mean, std: Math.sqrt(variance) }
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
 * Remove duplicate step indices.
 * When both entries for a given index are corrupt, the first (earlier in the
 * sorted order) is kept.  When one is not corrupt, that one wins.
 *
 * @param {Array<{ step: number, corrupt: boolean }>} sorted - Already sorted.
 * @returns {Array<{ step: number, corrupt: boolean }>}
 */
function dedupeSteps(sorted) {
  const seen = new Map() // step index → array position in `out`
  const out = []

  for (const entry of sorted) {
    if (!seen.has(entry.step)) {
      seen.set(entry.step, out.length)
      out.push(entry)
    } else {
      // Prefer the non-corrupt entry.
      const idx = seen.get(entry.step)
      if (out[idx].corrupt && !entry.corrupt) {
        out[idx] = entry
      }
      // else keep the existing entry (first-seen wins among corrupt pairs)
    }
  }

  return out
}

/**
 * Flag anomalies based on two criteria:
 *   a) the step is already marked corrupt by the generator, OR
 *   b) the loss value is non-finite (NaN, Infinity), OR
 *   c) the loss z-score among finite values exceeds Z_THRESHOLD.
 *
 * Returns a new array with an added `anomaly: boolean` field on each step.
 *
 * @param {Array<{ loss: number, corrupt: boolean }>} deduped
 * @returns {Array<{ loss: number, corrupt: boolean, anomaly: boolean }>}
 */
function flagAnomalies(deduped) {
  const finiteLosses = deduped.map((s) => s.loss).filter(Number.isFinite)
  const { mean, std } = stats(finiteLosses)

  return deduped.map((s) => {
    const nonFinite = !Number.isFinite(s.loss)
    const outlier = std > 0 && Number.isFinite(s.loss) && Math.abs(s.loss - mean) / std > Z_THRESHOLD
    return { ...s, anomaly: s.corrupt || nonFinite || outlier }
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SanitizedRun
 * @property {number}       id       - Run id (passed through from the input).
 * @property {number}       length   - Number of steps after dedup.
 * @property {Float64Array} steps    - Step indices (integers, as floats).
 * @property {Float64Array} loss     - Loss values; NaN where data is missing.
 * @property {Float64Array} accuracy - Accuracy values; NaN where data is missing.
 * @property {Float64Array} anomaly  - 1.0 = anomaly, 0.0 = clean.
 */

/**
 * Sanitize a single run produced by `generateRun()`.
 *
 * @param {{ id: number, steps: Array<{ step: number, loss: number, accuracy: number, corrupt: boolean }> }} run
 * @returns {SanitizedRun}
 */
export function sanitizeRun(run) {
  const sorted = sortSteps(run.steps)
  const deduped = dedupeSteps(sorted)
  const flagged = flagAnomalies(deduped)

  const n = flagged.length
  const stepsBuf = new Float64Array(n)
  const lossBuf = new Float64Array(n)
  const accBuf = new Float64Array(n)
  const anomalyBuf = new Float64Array(n)

  for (let i = 0; i < n; i++) {
    const s = flagged[i]
    stepsBuf[i] = s.step
    lossBuf[i] = s.loss           // NaN propagates naturally into Float64Array
    accBuf[i] = s.accuracy
    anomalyBuf[i] = s.anomaly ? 1.0 : 0.0
  }

  return {
    id: run.id,
    length: n,
    steps: stepsBuf,
    loss: lossBuf,
    accuracy: accBuf,
    anomaly: anomalyBuf,
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
