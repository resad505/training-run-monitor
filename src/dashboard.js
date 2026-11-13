import { ANOMALY } from './pipeline/sanitizer.js'

export const METRICS = ['loss', 'lr', 'grad_norm']

/** Anomaly kinds in display order. Labels are shown in the run summary. */
export const ANOMALY_KINDS = Object.freeze([
  { key: 'nonFinite', flag: ANOMALY.NON_FINITE, label: 'non-finite' },
  { key: 'outlier', flag: ANOMALY.OUTLIER, label: 'outlier' },
  { key: 'collision', flag: ANOMALY.COLLISION, label: 'duplicate step' },
  { key: 'gap', flag: ANOMALY.GAP, label: 'gap' },
  { key: 'plateau', flag: ANOMALY.PLATEAU, label: 'plateau' },
])

export function anomalyCount(run) {
  return run.anomaly.reduce((count, flags) => count + (flags > 0 ? 1 : 0), 0)
}

/**
 * Summary of one metric column. `min`, `max` and `last` only consider finite
 * values, so the points that were left out are reported next to them as
 * `nonFiniteCount` instead of disappearing from the card.
 */
export function summarizeMetric(run, metric) {
  const values = run[metric]
  let min = Infinity
  let max = -Infinity
  let last = NaN
  let finiteCount = 0

  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (!Number.isFinite(value)) continue
    min = Math.min(min, value)
    max = Math.max(max, value)
    last = value
    finiteCount++
  }

  return {
    min: finiteCount ? min : NaN,
    max: finiteCount ? max : NaN,
    last,
    finiteCount,
    nonFiniteCount: values.length - finiteCount,
  }
}

export function filterAndSortRuns(runs, query = '', sort = 'id', direction = 'asc') {
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = runs.filter((run) => normalizedQuery === '' || String(run.id).includes(normalizedQuery))
  const multiplier = direction === 'desc' ? -1 : 1

  return filtered.toSorted((a, b) => {
    const aValue = sort === 'anomalies' ? anomalyCount(a) : sort === 'length' ? a.length : a.id
    const bValue = sort === 'anomalies' ? anomalyCount(b) : sort === 'length' ? b.length : b.id
    // Ties fall back to the run id so the order never depends on input order.
    return (aValue - bValue) * multiplier || a.id - b.id
  })
}

/**
 * Flagged points per anomaly kind. A point with several flags is counted once
 * per kind, so the kinds can add up to more than `total` (flagged points).
 */
export function countAnomaliesByKind(run) {
  const counts = { total: 0 }
  for (const { key } of ANOMALY_KINDS) counts[key] = 0

  for (let i = 0; i < run.anomaly.length; i++) {
    const flags = run.anomaly[i]
    if (!flags) continue
    counts.total++
    for (const { key, flag } of ANOMALY_KINDS) {
      if (flags & flag) counts[key]++
    }
  }
  return counts
}

/**
 * Index the run list should focus after a key press (listbox pattern), or
 * `null` when the key is not a navigation key.
 */
export function nextOptionIndex(key, current, count) {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, current + 1)
    case 'ArrowUp':
      return Math.max(0, current - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** Smoothing weights offered by the UI; 0 draws the raw series only. */
export const SMOOTHING = Object.freeze({ min: 0, max: 0.95, step: 0.05, initial: 0.8 })

/**
 * Finite values a log axis cannot place (zero or negative). They are drawn as
 * markers by the renderer; this count lets the UI say how many there are.
 */
export function countNonPositive(values) {
  let count = 0
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i]) && values[i] <= 0) count++
  }
  return count
}

/**
 * One-line description of how a chart is currently drawn, so a reader never
 * has to guess whether they are looking at raw or smoothed data, or whether a
 * log axis has left points out.
 *
 * @param {{ scaleType: 'linear' | 'log', smoothing: number, nonPositive: number }} mode
 * @param {{ integer: (n: number) => string, number: (n: number) => string }} format
 */
export function describeChartMode({ scaleType, smoothing, nonPositive }, format) {
  const parts = [smoothing > 0 ? `Raw + smoothed (EMA ${format.number(smoothing)})` : 'Raw only, no smoothing']
  if (scaleType === 'log') {
    parts.push(
      nonPositive > 0
        ? `log scale: ${format.integer(nonPositive)} ${nonPositive === 1 ? 'value' : 'values'} ≤ 0 cannot be placed, marked ≤0`
        : 'log scale',
    )
  }
  return parts.join(' · ')
}
