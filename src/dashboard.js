import { ANOMALY } from './pipeline/sanitizer.js'

export const METRICS = ['loss', 'lr', 'grad_norm']

export function anomalyCount(run) {
  return run.anomaly.reduce((count, flags) => count + (flags > 0 ? 1 : 0), 0)
}

export function summarizeMetric(run, metric) {
  const values = run[metric]
  let min = Infinity
  let max = -Infinity
  let last = NaN

  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (!Number.isFinite(value)) continue
    min = Math.min(min, value)
    max = Math.max(max, value)
    last = value
  }

  return {
    min: Number.isFinite(min) ? min : NaN,
    max: Number.isFinite(max) ? max : NaN,
    last,
    anomalyCount: run.anomaly.reduce((count, flags, index) => {
      return count + (flags > 0 && Number.isFinite(values[index]) ? 1 : 0)
    }, 0),
  }
}

export function filterAndSortRuns(runs, query = '', sort = 'id', direction = 'asc') {
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = runs.filter((run) => normalizedQuery === '' || String(run.id).includes(normalizedQuery))
  const multiplier = direction === 'desc' ? -1 : 1

  return filtered.toSorted((a, b) => {
    const aValue = sort === 'anomalies' ? anomalyCount(a) : sort === 'length' ? a.length : a.id
    const bValue = sort === 'anomalies' ? anomalyCount(b) : sort === 'length' ? b.length : b.id
    return (aValue - bValue) * multiplier
  })
}

export function countAnomaliesByKind(run) {
  return {
    nonFinite: run.anomaly.reduce((count, flags) => count + ((flags & ANOMALY.NON_FINITE) ? 1 : 0), 0),
    outlier: run.anomaly.reduce((count, flags) => count + ((flags & ANOMALY.OUTLIER) ? 1 : 0), 0),
    other: run.anomaly.reduce(
      (count, flags) =>
        count +
        ((flags & (ANOMALY.COLLISION | ANOMALY.GAP | ANOMALY.PLATEAU)) ? 1 : 0),
      0,
    ),
  }
}
