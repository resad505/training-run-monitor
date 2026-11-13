/**
 * Lightweight timing instrumentation.
 *
 * Every timed section is recorded twice:
 *   - as a `performance.measure`, so it shows up in the "Timings" track of a
 *     DevTools Performance trace (including under CPU throttling), and
 *   - in an in-memory sample list, summarised by `window.__perf.summary()`,
 *     so the same numbers can be read from the console.
 *
 * The cost per sample is two `performance.now()` calls and an array push.
 */

const MAX_SAMPLES = 2000
const samples = new Map()

function now() {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/** Record one duration (or point-in-time value) in milliseconds. */
export function record(name, ms) {
  let list = samples.get(name)
  if (!list) samples.set(name, (list = []))
  list.push(ms)
  if (list.length > MAX_SAMPLES) list.shift()
}

/** Run `fn`, record how long it took under `name`, and return its result. */
export function timed(name, fn) {
  const start = now()
  try {
    return fn()
  } finally {
    const duration = now() - start
    record(name, duration)
    if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
      try {
        performance.measure(name, { start, duration })
      } catch {
        // Older engines reject the options form; the sample is still recorded.
      }
    }
  }
}

/** Record the time since navigation start, once per name. */
export function milestone(name) {
  if (samples.has(name)) return
  record(name, now())
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') performance.mark(name)
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

/** `{ name: { count, median, p95, max, total } }`, all in milliseconds. */
export function summary() {
  const out = {}
  for (const [name, list] of samples) {
    const sorted = list.slice().sort((a, b) => a - b)
    out[name] = {
      count: sorted.length,
      median: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted[sorted.length - 1],
      total: sorted.reduce((sum, value) => sum + value, 0),
    }
  }
  return out
}

export function reset(name) {
  if (name === undefined) samples.clear()
  else samples.delete(name)
}

/**
 * Track main-thread blocks of 50 ms or more ("long tasks"): the time during
 * which the page cannot respond to input at all.
 */
export function observeLongTasks() {
  if (typeof PerformanceObserver === 'undefined') return
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record('longtask', entry.duration)
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    // Not supported in this browser; the other measurements still work.
  }
}

/** Expose the summary on `window.__perf` for manual and scripted measurement. */
export function install(target) {
  target.__perf = { summary, reset }
}
