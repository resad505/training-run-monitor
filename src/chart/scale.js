/**
 * Scales — Issue #12.
 *
 * Provides linear and safe-log continuous scales with tick generation.
 *
 * Guarantees (Issue #12 acceptance criteria):
 *   1. No scale ever returns a non-finite pixel coordinate (NaN, ±Infinity).
 *      Non-finite inputs and non-plottable values return `null`.
 *   2. Values <= 0 on a log scale are reported as not plottable (`isPlottable() === false`),
 *      and return `null` from `scale(x)`. They are NEVER silently clamped to epsilon.
 *   3. Ticks lie strictly within [domainMin, domainMax].
 *   4. Tick labels round-trip back to the tick value via Number(label).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a number nicely so that Number(str) === num (round-trip guarantee).
 * Strips floating-point noise (e.g. 0.30000000000000004 -> 0.3).
 *
 * @param {number} num
 * @returns {string}
 */
export function formatTickNumber(num) {
  if (!Number.isFinite(num)) return ''
  if (num === 0) return '0'

  const abs = Math.abs(num)

  // For very small or very large numbers, use standard scientific notation
  if (abs >= 1e9 || (abs < 1e-4 && abs > 0)) {
    const expStr = num.toExponential(4)
    // Clean up trailing zeros in scientific notation e.g. 1.0000e-5 -> 1e-5
    const cleaned = expStr.replace(/\.0+e/, 'e').replace(/(\.\d+?)0+e/, '$1e')
    if (Number(cleaned) === num) return cleaned
    return expStr
  }

  // Round to at most 10 decimal digits to remove binary float representation artifacts
  const rounded = Number(num.toPrecision(10))
  const str = String(rounded)
  if (Number(str) === num) return str

  // Fallback to max precision that matches
  return String(num)
}

/**
 * Calculate a "nice" step size for linear ticks.
 *
 * @param {number} min
 * @param {number} max
 * @param {number} count
 * @returns {number}
 */
function niceStep(min, max, count) {
  const span = Math.abs(max - min)
  if (span === 0) return 1
  const rawStep = span / Math.max(1, count)
  const power = Math.floor(Math.log10(rawStep))
  const magnitude = Math.pow(10, power)
  const fraction = rawStep / magnitude

  let niceFraction
  if (fraction < 1.5) {
    niceFraction = 1
  } else if (fraction < 3) {
    niceFraction = 2
  } else if (fraction < 7) {
    niceFraction = 5
  } else {
    niceFraction = 10
  }

  return niceFraction * magnitude
}

// ---------------------------------------------------------------------------
// Linear Scale
// ---------------------------------------------------------------------------

/**
 * Create a linear scale mapping domain [d0, d1] to range [r0, r1].
 *
 * @param {object} options
 * @param {[number, number]} options.domain - [min, max] in data space
 * @param {[number, number]} options.range  - [r0, r1] in pixel space
 * @param {boolean} [options.clamp=false]   - Whether to clamp pixel output to range
 * @returns {LinearScale}
 */
export function createLinearScale({ domain, range, clamp = false }) {
  const [d0, d1] = domain
  const [r0, r1] = range

  const dSpan = d1 - d0
  const rSpan = r1 - r0

  /**
   * Check if a value can be plotted.
   * @param {unknown} val
   * @returns {boolean}
   */
  function isPlottable(val) {
    return typeof val === 'number' && Number.isFinite(val)
  }

  /**
   * Project data value to pixel coordinate.
   * Returns finite pixel number or null. NEVER returns NaN or Infinity.
   *
   * @param {number} val
   * @returns {number | null}
   */
  function scale(val) {
    if (!isPlottable(val)) return null

    let pixel
    if (dSpan === 0) {
      pixel = (r0 + r1) / 2
    } else {
      const ratio = (val - d0) / dSpan
      pixel = r0 + ratio * rSpan
    }

    if (!Number.isFinite(pixel)) return null

    if (clamp) {
      const minR = Math.min(r0, r1)
      const maxR = Math.max(r0, r1)
      return Math.max(minR, Math.min(maxR, pixel))
    }

    return pixel
  }

  /**
   * Invert pixel coordinate to data value.
   * @param {number} pixel
   * @returns {number | null}
   */
  function invert(pixel) {
    if (typeof pixel !== 'number' || !Number.isFinite(pixel)) return null
    if (rSpan === 0) return (d0 + d1) / 2
    const ratio = (pixel - r0) / rSpan
    const val = d0 + ratio * dSpan
    return Number.isFinite(val) ? val : null
  }

  /**
   * Generate ticks strictly lying within [domainMin, domainMax].
   *
   * @param {number} [count=5]
   * @returns {number[]}
   */
  function ticks(count = 5) {
    const min = Math.min(d0, d1)
    const max = Math.max(d0, d1)
    if (min === max) return [min]

    const step = niceStep(min, max, count)
    const first = Math.ceil(min / step) * step
    const result = []

    // Guard against floating point infinite loop
    const epsilon = step * 1e-12
    let curr = first
    while (curr <= max + epsilon) {
      // Clean float rounding
      const rounded = Number(curr.toPrecision(12))
      if (rounded >= min - epsilon && rounded <= max + epsilon) {
        // Clamp strictly to domain bounds
        const strictlyInDomain = Math.max(min, Math.min(max, rounded))
        result.push(strictlyInDomain)
      }
      curr += step
    }

    // Deduplicate if clamping created identical entries
    const deduped = []
    for (const t of result) {
      if (deduped.length === 0 || Math.abs(t - deduped[deduped.length - 1]) > epsilon) {
        deduped.push(t)
      }
    }

    return deduped
  }

  /**
   * Format a tick value into a string that round-trips via Number(str).
   * @param {number} tick
   * @returns {string}
   */
  function tickFormat(tick) {
    return formatTickNumber(tick)
  }

  return {
    type: 'linear',
    domain: [d0, d1],
    range: [r0, r1],
    clamp,
    scale,
    invert,
    isPlottable,
    ticks,
    tickFormat,
  }
}

// ---------------------------------------------------------------------------
// Log Scale
// ---------------------------------------------------------------------------

/**
 * Create a safe log10 scale.
 * Values <= 0 are reported as NOT plottable and map to null.
 *
 * @param {object} options
 * @param {[number, number]} options.domain - [min, max] where min and max should be > 0
 * @param {[number, number]} options.range  - [r0, r1] in pixel space
 * @param {number} [options.base=10]
 * @param {boolean} [options.clamp=false]
 * @returns {LogScale}
 */
export function createLogScale({ domain, range, base = 10, clamp = false }) {
  const [d0, d1] = domain
  const [r0, r1] = range

  // Validate positive domain for log scale
  const safeD0 = d0 > 0 ? d0 : 1e-4
  const safeD1 = d1 > 0 ? d1 : 1

  const logBase = Math.log(base)
  const logD0 = Math.log(safeD0) / logBase
  const logD1 = Math.log(safeD1) / logBase
  const logSpan = logD1 - logD0
  const rSpan = r1 - r0

  /**
   * Check if a value can be plotted on a log scale.
   * Strictly false for non-finite values and values <= 0.
   *
   * @param {unknown} val
   * @returns {boolean}
   */
  function isPlottable(val) {
    return typeof val === 'number' && Number.isFinite(val) && val > 0
  }

  /**
   * Project data value to pixel coordinate.
   * Returns finite pixel number or null. NEVER returns NaN, Infinity, or -Infinity.
   * Values <= 0 are NOT clamped; they return null.
   *
   * @param {number} val
   * @returns {number | null}
   */
  function scale(val) {
    if (!isPlottable(val)) return null

    const logVal = Math.log(val) / logBase
    let pixel
    if (logSpan === 0) {
      pixel = (r0 + r1) / 2
    } else {
      const ratio = (logVal - logD0) / logSpan
      pixel = r0 + ratio * rSpan
    }

    if (!Number.isFinite(pixel)) return null

    if (clamp) {
      const minR = Math.min(r0, r1)
      const maxR = Math.max(r0, r1)
      return Math.max(minR, Math.min(maxR, pixel))
    }

    return pixel
  }

  /**
   * Invert pixel coordinate to data value.
   * @param {number} pixel
   * @returns {number | null}
   */
  function invert(pixel) {
    if (typeof pixel !== 'number' || !Number.isFinite(pixel)) return null
    if (rSpan === 0) return safeD0
    const ratio = (pixel - r0) / rSpan
    const logVal = logD0 + ratio * logSpan
    const val = Math.pow(base, logVal)
    return Number.isFinite(val) && val > 0 ? val : null
  }

  /**
   * Generate ticks strictly within [domainMin, domainMax].
   * Emits powers of the base (e.g. 10^-2, 10^-1, 1, 10, 100).
   * If domain span is narrow, adds intermediate steps (1, 2, 5).
   *
   * @returns {number[]}
   */
  function ticks() {
    const min = Math.min(safeD0, safeD1)
    const max = Math.max(safeD0, safeD1)
    if (min === max) return [min]

    const minPower = Math.floor(Math.log(min) / logBase)
    const maxPower = Math.ceil(Math.log(max) / logBase)
    const powerSpan = maxPower - minPower

    const result = []

    if (powerSpan <= 2) {
      // Narrow span: emit [1, 2, 5] * base^p
      const subSteps = [1, 2, 5]
      for (let p = minPower; p <= maxPower; p++) {
        const magnitude = Math.pow(base, p)
        for (const s of subSteps) {
          const val = Number((s * magnitude).toPrecision(10))
          if (val >= min && val <= max) {
            result.push(val)
          }
        }
      }
    } else {
      // Wide span: emit base^p
      for (let p = minPower; p <= maxPower; p++) {
        const val = Number(Math.pow(base, p).toPrecision(10))
        if (val >= min && val <= max) {
          result.push(val)
        }
      }
    }

    return result
  }

  /**
   * Format a tick value into a string that round-trips via Number(str).
   * @param {number} tick
   * @returns {string}
   */
  function tickFormat(tick) {
    return formatTickNumber(tick)
  }

  return {
    type: 'log',
    domain: [safeD0, safeD1],
    range: [r0, r1],
    base,
    clamp,
    scale,
    invert,
    isPlottable,
    ticks,
    tickFormat,
  }
}
