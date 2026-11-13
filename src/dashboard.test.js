import { describe, expect, it } from 'vitest'
import {
  anomalyCount,
  countAnomaliesByKind,
  countNonPositive,
  describeChartMode,
  filterAndSortRuns,
  nextOptionIndex,
  SMOOTHING,
  summarizeMetric,
} from './dashboard.js'
import { ANOMALY } from './pipeline/sanitizer.js'

const run = (id, loss, anomaly = [0, 0]) => ({
  id,
  length: loss.length,
  loss: Float64Array.from(loss),
  lr: Float64Array.from(loss),
  grad_norm: Float64Array.from(loss),
  anomaly: Uint8Array.from(anomaly),
})

describe('dashboard helpers', () => {
  it('sorts by anomaly count and filters by run id', () => {
    const runs = [run(2, [1, 2], [1, 0]), run(12, [1, 2], [0, 0]), run(1, [1, 2], [1, 1])]

    expect(filterAndSortRuns(runs, '1', 'anomalies', 'desc').map((item) => item.id)).toEqual([1, 12])
  })

  it('breaks sort ties by run id regardless of input order', () => {
    const runs = [run(7, [1, 2]), run(3, [1, 2]), run(5, [1, 2])]

    expect(filterAndSortRuns(runs, '', 'anomalies', 'asc').map((item) => item.id)).toEqual([3, 5, 7])
    expect(filterAndSortRuns(runs, '', 'length', 'desc').map((item) => item.id)).toEqual([3, 5, 7])
  })

  it('returns no runs when nothing matches the filter', () => {
    expect(filterAndSortRuns([run(1, [1, 2])], '9')).toEqual([])
  })

  it('summarizes finite values and reports how many were non-finite', () => {
    const value = summarizeMetric(run(1, [NaN, 4, Infinity, 2], [1, 0, 1, 0]), 'loss')

    expect(value).toEqual({ min: 2, max: 4, last: 2, finiteCount: 2, nonFiniteCount: 2 })
  })

  it('never reports 0 for a metric with no finite values', () => {
    const value = summarizeMetric(run(1, [NaN, -Infinity]), 'loss')

    expect(value.min).toBeNaN()
    expect(value.max).toBeNaN()
    expect(value.last).toBeNaN()
    expect(value.nonFiniteCount).toBe(2)
  })

  it('counts flagged points', () => {
    expect(anomalyCount(run(1, [1, 2], [0, 4]))).toBe(1)
  })

  it('counts every anomaly kind, including non-finite points', () => {
    const flags = [
      ANOMALY.NON_FINITE,
      ANOMALY.OUTLIER | ANOMALY.COLLISION,
      ANOMALY.GAP,
      ANOMALY.PLATEAU,
      ANOMALY.PLATEAU,
      0,
    ]
    const counts = countAnomaliesByKind(run(1, [NaN, 9, 1, 1, 1, 1], flags))

    expect(counts).toEqual({ total: 5, nonFinite: 1, outlier: 1, collision: 1, gap: 1, plateau: 2 })
    expect(counts.total).toBe(anomalyCount(run(1, [NaN, 9, 1, 1, 1, 1], flags)))
  })

  it('moves run list focus with arrow, Home and End keys', () => {
    expect(nextOptionIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextOptionIndex('ArrowDown', 2, 3)).toBe(2)
    expect(nextOptionIndex('ArrowUp', 0, 3)).toBe(0)
    expect(nextOptionIndex('ArrowUp', 2, 3)).toBe(1)
    expect(nextOptionIndex('Home', 2, 3)).toBe(0)
    expect(nextOptionIndex('End', 0, 3)).toBe(2)
    expect(nextOptionIndex('a', 0, 3)).toBeNull()
    expect(nextOptionIndex('ArrowDown', 0, 0)).toBeNull()
  })
})

describe('chart mode helpers', () => {
  const format = { integer: (n) => `#${n}`, number: (n) => `~${n}` }

  it('counts only finite values a log axis cannot place', () => {
    expect(countNonPositive(Float64Array.from([1, 0, -2, NaN, -Infinity, Infinity, 1e-9]))).toBe(2)
    expect(countNonPositive(new Float64Array(0))).toBe(0)
  })

  it('says when no smoothing is applied', () => {
    expect(describeChartMode({ scaleType: 'linear', smoothing: 0, nonPositive: 3 }, format)).toBe(
      'Raw only, no smoothing',
    )
  })

  it('names the smoothing weight', () => {
    expect(describeChartMode({ scaleType: 'linear', smoothing: 0.8, nonPositive: 0 }, format)).toBe(
      'Raw + smoothed (EMA ~0.8)',
    )
  })

  it('reports how many values a log axis leaves out', () => {
    expect(describeChartMode({ scaleType: 'log', smoothing: 0.8, nonPositive: 2 }, format)).toContain(
      'log scale: #2 values ≤ 0 cannot be placed',
    )
    expect(describeChartMode({ scaleType: 'log', smoothing: 0, nonPositive: 1 }, format)).toContain('#1 value ≤ 0')
    expect(describeChartMode({ scaleType: 'log', smoothing: 0, nonPositive: 0 }, format)).toBe(
      'Raw only, no smoothing · log scale',
    )
  })

  it('offers a smoothing range that includes "off" and never reaches 1', () => {
    expect(SMOOTHING.min).toBe(0)
    expect(SMOOTHING.max).toBeLessThan(1)
    expect(SMOOTHING.initial).toBeGreaterThanOrEqual(SMOOTHING.min)
    expect(SMOOTHING.initial).toBeLessThanOrEqual(SMOOTHING.max)
  })
})
