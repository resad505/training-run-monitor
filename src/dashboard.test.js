import { describe, expect, it } from 'vitest'
import { anomalyCount, filterAndSortRuns, summarizeMetric } from './dashboard.js'

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

  it('summarizes only finite metric values', () => {
    const value = summarizeMetric(run(1, [NaN, 4, Infinity, 2], [1, 0, 1, 0]), 'loss')

    expect(value).toEqual({ min: 2, max: 4, last: 2, anomalyCount: 0 })
  })

  it('counts flagged points', () => {
    expect(anomalyCount(run(1, [1, 2], [0, 4]))).toBe(1)
  })
})
