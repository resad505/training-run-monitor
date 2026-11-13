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
