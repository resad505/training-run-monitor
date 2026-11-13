/**
 * Extrema-preserving downsampler — Issue #13.
 *
 * Reduces large time-series buffers to a target pixel width while guaranteeing:
 *   1. The global min and max of any window survive for ANY target width (including
 *      single-point outlier spikes, defending Issue #19 proof a).
 *   2. Non-finite points (NaN, ±Infinity) and gap boundaries are NEVER merged into
 *      a bucket's line (defending Issue #19 proof b).
 *   3. Output size has a documented upper bound:
 *        output_length <= 2 * targetWidth + 2 * num_segments + num_non_finite
 *      (For clean contiguous data: <= 2 * targetWidth + 2).
 *   4. Pure function with zero DOM access — safe for Web Workers (Issue #20).
 */

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

function createEmptyResult() {
  return {
    steps: new Float64Array(0),
    values: new Float64Array(0),
    anomaly: new Uint8Array(0),
    length: 0,
    envelope: {
      steps: new Float64Array(0),
      mins: new Float64Array(0),
      maxs: new Float64Array(0),
      length: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Downsampler
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DownsampledResult
 * @property {Float64Array} steps     - Step indices for decimated points
 * @property {Float64Array} values    - Values at decimated points (NaN/Infinity preserved)
 * @property {Uint8Array}   anomaly   - Anomaly flags (1 = anomaly, 0 = clean)
 * @property {number}       length    - Number of decimated points
 * @property {Object}       envelope  - Min/max envelope bands per bucket
 * @property {Float64Array} envelope.steps - Bucket step positions
 * @property {Float64Array} envelope.mins  - Bucket minimum finite values
 * @property {Float64Array} envelope.maxs  - Bucket maximum finite values
 * @property {number}       envelope.length
 */

/**
 * Downsample a series while strictly preserving extrema, non-finites, and gaps.
 *
 * @param {object} input
 * @param {ArrayLike<number>} input.steps    - Ascending step indices
 * @param {ArrayLike<number>} input.values   - Metric values (loss, grad_norm, etc.)
 * @param {ArrayLike<number>} [input.anomaly]- Anomaly flags (0 or 1)
 * @param {number} input.targetWidth         - Target number of pixel buckets (> 0)
 * @param {[number, number]} [input.xRange]  - Optional [minStep, maxStep] slice window
 * @returns {DownsampledResult}
 */
export function downsample({ steps, values, anomaly, targetWidth, xRange }) {
  const total = steps.length
  if (total === 0) {
    return createEmptyResult()
  }

  const width = Math.max(1, Math.floor(targetWidth || 500))

  // 1. Determine window indices
  let startIdx = 0
  let endIdx = total - 1

  if (xRange && xRange.length === 2) {
    const [xMin, xMax] = xRange
    if (xMin > steps[total - 1] || xMax < steps[0] || xMin > xMax) {
      return createEmptyResult()
    }

    const lo = binarySearchFirstGe(steps, xMin)
    const hi = binarySearchLastLe(steps, xMax)

    if (lo > hi) {
      return createEmptyResult()
    }

    // Expand by 1 on each side to avoid clipping line segments at viewport edge
    startIdx = Math.max(0, lo > 0 ? lo - 1 : 0)
    endIdx = Math.min(total - 1, hi < total - 1 ? hi + 1 : total - 1)
  }

  const windowLen = endIdx - startIdx + 1
  if (windowLen <= 0) {
    return createEmptyResult()
  }

  // 2. If the window is already smaller than or equal to 2 * targetWidth, pass through directly
  if (windowLen <= width * 2) {
    const outSteps = new Float64Array(windowLen)
    const outValues = new Float64Array(windowLen)
    const outAnomaly = new Uint8Array(windowLen)

    for (let i = 0; i < windowLen; i++) {
      const src = startIdx + i
      outSteps[i] = steps[src]
      outValues[i] = values[src]
      outAnomaly[i] = anomaly ? anomaly[src] : 0
    }

    return {
      steps: outSteps,
      values: outValues,
      anomaly: outAnomaly,
      length: windowLen,
      envelope: {
        steps: outSteps,
        mins: outValues,
        maxs: outValues,
        length: windowLen,
      },
    }
  }

  // 3. Partition window into contiguous finite segments separated by:
  //    - non-finite points (NaN, Infinity, -Infinity)
  //    - step gaps (step[i] - step[i-1] > 1)
  // Non-finite points and gap boundaries are preserved explicitly and never merged into buckets.

  const selectedIndices = []
  const envSteps = []
  const envMins = []
  const envMaxs = []

  let segStart = startIdx

  for (let i = startIdx; i <= endIdx; i++) {
    const v = values[i]
    const isFiniteVal = Number.isFinite(v)
    const isGap = i > startIdx && steps[i] - steps[i - 1] > 1

    if (!isFiniteVal || isGap) {
      // Process any preceding contiguous segment [segStart, i - 1]
      if (i - 1 >= segStart) {
        downsampleSegment(
          segStart,
          i - 1,
          steps,
          values,
          width,
          windowLen,
          selectedIndices,
          envSteps,
          envMins,
          envMaxs,
        )
      }

      if (!isFiniteVal) {
        // Non-finite point: explicitly emit it as its own point (NEVER coerced to 0)
        selectedIndices.push(i)
        segStart = i + 1
      } else {
        // Gap: start the new segment here
        segStart = i
      }
    }
  }

  // Process trailing segment
  if (endIdx >= segStart) {
    downsampleSegment(
      segStart,
      endIdx,
      steps,
      values,
      width,
      windowLen,
      selectedIndices,
      envSteps,
      envMins,
      envMaxs,
    )
  }

  // 4. Build output typed arrays from selected indices
  const outLen = selectedIndices.length
  const outSteps = new Float64Array(outLen)
  const outValues = new Float64Array(outLen)
  const outAnomaly = new Uint8Array(outLen)

  for (let k = 0; k < outLen; k++) {
    const idx = selectedIndices[k]
    outSteps[k] = steps[idx]
    outValues[k] = values[idx]
    outAnomaly[k] = anomaly ? anomaly[idx] : 0
  }

  const envLen = envSteps.length
  const outEnvSteps = new Float64Array(envLen)
  const outEnvMins = new Float64Array(envLen)
  const outEnvMaxs = new Float64Array(envLen)

  for (let k = 0; k < envLen; k++) {
    outEnvSteps[k] = envSteps[k]
    outEnvMins[k] = envMins[k]
    outEnvMaxs[k] = envMaxs[k]
  }

  return {
    steps: outSteps,
    values: outValues,
    anomaly: outAnomaly,
    length: outLen,
    envelope: {
      steps: outEnvSteps,
      mins: outEnvMins,
      maxs: outEnvMaxs,
      length: envLen,
    },
  }
}

/**
 * Downsample a contiguous segment of finite values where steps have stride 1.
 * Uses extrema-preserving bucketing:
 * For each bucket, selects both the min and max in chronological order.
 * Guarantees segment start and segment end (boundary points) always survive.
 */
function downsampleSegment(
  start,
  end,
  steps,
  values,
  totalWidth,
  windowLen,
  selectedIndices,
  envSteps,
  envMins,
  envMaxs,
) {
  const segLen = end - start + 1
  if (segLen <= 0) return

  // Allocate buckets proportionally to segment's share of window
  const numBuckets = Math.max(1, Math.round((totalWidth * segLen) / windowLen))

  if (segLen <= numBuckets * 2) {
    // Segment is already small: emit all points
    for (let i = start; i <= end; i++) {
      selectedIndices.push(i)
      envSteps.push(steps[i])
      envMins.push(values[i])
      envMaxs.push(values[i])
    }
    return
  }

  const bucketSize = segLen / numBuckets
  const segIndices = []

  for (let b = 0; b < numBuckets; b++) {
    const bStart = start + Math.floor(b * bucketSize)
    const bEnd = start + Math.min(segLen - 1, Math.floor((b + 1) * bucketSize) - 1)

    if (bStart > bEnd) continue

    let minVal = values[bStart]
    let maxVal = values[bStart]
    let minIdx = bStart
    let maxIdx = bStart

    for (let j = bStart; j <= bEnd; j++) {
      const v = values[j]
      if (v < minVal) {
        minVal = v
        minIdx = j
      }
      if (v > maxVal) {
        maxVal = v
        maxIdx = j
      }
    }

    // Record envelope
    const midStep = steps[Math.floor((bStart + bEnd) / 2)]
    envSteps.push(midStep)
    envMins.push(minVal)
    envMaxs.push(maxVal)

    // Emit min and max in chronological order to preserve wave shape and direction
    if (minIdx === maxIdx) {
      segIndices.push(minIdx)
    } else if (minIdx < maxIdx) {
      segIndices.push(minIdx)
      segIndices.push(maxIdx)
    } else {
      segIndices.push(maxIdx)
      segIndices.push(minIdx)
    }
  }

  // Ensure segment boundary points (start and end) always survive
  if (segIndices[0] !== start) {
    segIndices.unshift(start)
  }
  if (segIndices[segIndices.length - 1] !== end) {
    segIndices.push(end)
  }

  for (let i = 0; i < segIndices.length; i++) {
    selectedIndices.push(segIndices[i])
  }
}
