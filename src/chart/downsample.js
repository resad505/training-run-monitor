/**
 * Extrema-preserving downsampler — Issue #13.
 *
 * Reduces large time-series buffers to a target pixel width while guaranteeing:
 *   1. The min and max of every bucket survive, so the global min and max of
 *      any window survive for ANY target width (single-point spikes included).
 *   2. Non-finite points (NaN, ±Infinity) and step gaps are never merged into
 *      a bucket: the window is split into finite, gap-free segments that are
 *      bucketed independently, and every output point carries explicit
 *      `breakBefore` / `gapBefore` flags. Consumers MUST use these flags rather
 *      than comparing decimated step indices (decimated neighbours are far
 *      apart by construction).
 *   3. Every anomalous point (anomaly !== 0) survives, so markers do not
 *      disappear when zooming out.
 *   4. Documented upper bound, with W = targetWidth, S = number of finite
 *      segments in the window, F = non-finite points, A = anomalous points:
 *        length          <= 2·W + 4·S + F + A
 *        envelope.length <= 2·(W + S)
 *      For clean contiguous data (S = 1, F = A = 0): length <= 2·W + 4.
 *   5. Pure function with zero DOM access — safe for Web Workers.
 */

import { EXPECTED_STRIDE } from '../pipeline/sanitizer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Binary search for the index of the first step >= target.
 *
 * @param {ArrayLike<number>} steps
 * @param {number} target
 * @returns {number}
 */
export function binarySearchFirstGe(steps, target) {
  let lo = 0
  let hi = steps.length - 1
  let ans = steps.length

  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (steps[mid] >= target) {
      ans = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }

  return ans
}

/**
 * Binary search for the index of the last step <= target.
 *
 * @param {ArrayLike<number>} steps
 * @param {number} target
 * @returns {number}
 */
export function binarySearchLastLe(steps, target) {
  let lo = 0
  let hi = steps.length - 1
  let ans = -1

  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (steps[mid] <= target) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return ans
}

/** True when a step gap (larger than the expected stride) precedes index i. */
function gapBefore(steps, i) {
  return i > 0 && steps[i] - steps[i - 1] > EXPECTED_STRIDE
}

// ---------------------------------------------------------------------------
// Downsampler
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DownsampledResult
 * @property {Float64Array} steps       - Step indices of the kept points
 * @property {Float64Array} values      - Values of the kept points (NaN/±Infinity preserved)
 * @property {Uint8Array}   anomaly     - Anomaly flags of the kept points (bitmask, 0 = clean)
 * @property {Float64Array} index       - Source index of each kept point
 * @property {Uint8Array}   breakBefore - 1 = do not connect this point to the previous one
 * @property {Uint8Array}   gapBefore   - 1 = a step gap precedes this point in the source data
 * @property {number}       length
 * @property {Object}       envelope    - Raw min/max band, one entry per bucket
 * @property {Float64Array} envelope.steps
 * @property {Float64Array} envelope.mins
 * @property {Float64Array} envelope.maxs
 * @property {Uint8Array}   envelope.breakBefore - 1 = start of a new segment
 * @property {number}       envelope.length
 */

/**
 * Downsample a series while strictly preserving extrema, anomalies,
 * non-finite points and gaps.
 *
 * @param {object} input
 * @param {ArrayLike<number>} input.steps     - Ascending step indices
 * @param {ArrayLike<number>} input.values    - Metric values (loss, grad_norm, etc.)
 * @param {ArrayLike<number>} [input.anomaly] - Anomaly flags (bitmask, 0 = clean)
 * @param {number} input.targetWidth          - Target number of pixel buckets (> 0)
 * @param {[number, number]} [input.xRange]   - Optional [minStep, maxStep] slice window
 * @returns {DownsampledResult}
 */
export function downsample({ steps, values, anomaly, targetWidth, xRange }) {
  const out = createCollector()
  const total = steps.length
  if (total === 0) return out.build()

  const width = Math.max(1, Math.floor(targetWidth || 500))

  // 1. Window indices (expanded by one point per side so lines reach the edge).
  let startIdx = 0
  let endIdx = total - 1

  if (xRange && xRange.length === 2) {
    const [xMin, xMax] = xRange
    if (xMin > steps[total - 1] || xMax < steps[0] || xMin > xMax) return out.build()
    const lo = binarySearchFirstGe(steps, xMin)
    const hi = binarySearchLastLe(steps, xMax)
    if (lo > hi) return out.build()
    startIdx = Math.max(0, lo - 1)
    endIdx = Math.min(total - 1, hi + 1)
  }

  const windowLen = endIdx - startIdx + 1
  const passthrough = windowLen <= width * 2
  const ctx = { steps, values, anomaly, width, windowLen, passthrough, out }

  // 2. Split into finite, gap-free segments; non-finite points stand alone.
  let segStart = startIdx
  for (let i = startIdx; i <= endIdx; i++) {
    const finite = Number.isFinite(values[i])
    const gap = i > startIdx && gapBefore(steps, i)
    if (!finite || gap) {
      if (i > segStart) emitSegment(ctx, segStart, i - 1)
      if (!finite) {
        out.point(steps, values, anomaly, i, true)
        segStart = i + 1
      } else {
        segStart = i
      }
    }
  }
  if (endIdx >= segStart) emitSegment(ctx, segStart, endIdx)

  return out.build()
}

/**
 * Emit one finite, gap-free segment [start, end].
 * Each bucket keeps its min, its max and any anomalous points, in
 * chronological order; the segment's first and last points always survive.
 */
function emitSegment(ctx, start, end) {
  const { steps, values, anomaly, width, windowLen, passthrough, out } = ctx
  const segLen = end - start + 1
  const numBuckets = Math.max(1, Math.round((width * segLen) / windowLen))

  if (passthrough || segLen <= numBuckets * 2) {
    for (let i = start; i <= end; i++) {
      out.point(steps, values, anomaly, i, i === start)
      out.envelope(steps[i], values[i], values[i], i === start)
    }
    return
  }

  const bucketSize = segLen / numBuckets
  const picked = [start]

  for (let b = 0; b < numBuckets; b++) {
    const bStart = start + Math.floor(b * bucketSize)
    const bEnd = start + Math.min(segLen - 1, Math.floor((b + 1) * bucketSize) - 1)
    if (bStart > bEnd) continue

    let minIdx = bStart
    let maxIdx = bStart
    const bucketPicks = []
    for (let j = bStart; j <= bEnd; j++) {
      if (values[j] < values[minIdx]) minIdx = j
      if (values[j] > values[maxIdx]) maxIdx = j
      if (anomaly && anomaly[j]) bucketPicks.push(j)
    }
    bucketPicks.push(minIdx, maxIdx)
    bucketPicks.sort((a, z) => a - z)
    for (const j of bucketPicks) {
      if (j !== picked[picked.length - 1]) picked.push(j)
    }

    out.envelope(steps[(bStart + bEnd) >> 1], values[minIdx], values[maxIdx], b === 0)
  }

  if (picked[picked.length - 1] !== end) picked.push(end)
  for (const j of picked) out.point(steps, values, anomaly, j, j === start)
}

/** Growable output buffers, converted to typed arrays at the end. */
function createCollector() {
  const p = { steps: [], values: [], anomaly: [], index: [], breakBefore: [], gapBefore: [] }
  const e = { steps: [], mins: [], maxs: [], breakBefore: [] }

  return {
    point(steps, values, anomaly, i, isBreak) {
      p.steps.push(steps[i])
      p.values.push(values[i])
      p.anomaly.push(anomaly ? anomaly[i] : 0)
      p.index.push(i)
      p.breakBefore.push(isBreak || p.steps.length === 1 ? 1 : 0)
      p.gapBefore.push(gapBefore(steps, i) ? 1 : 0)
    },
    envelope(step, min, max, isBreak) {
      e.steps.push(step)
      e.mins.push(min)
      e.maxs.push(max)
      e.breakBefore.push(isBreak || e.steps.length === 1 ? 1 : 0)
    },
    build() {
      return {
        steps: Float64Array.from(p.steps),
        values: Float64Array.from(p.values),
        anomaly: Uint8Array.from(p.anomaly),
        index: Float64Array.from(p.index),
        breakBefore: Uint8Array.from(p.breakBefore),
        gapBefore: Uint8Array.from(p.gapBefore),
        length: p.steps.length,
        envelope: {
          steps: Float64Array.from(e.steps),
          mins: Float64Array.from(e.mins),
          maxs: Float64Array.from(e.maxs),
          breakBefore: Uint8Array.from(e.breakBefore),
          length: e.steps.length,
        },
      }
    },
  }
}
