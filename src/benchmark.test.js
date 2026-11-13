import { describe, expect, it } from 'vitest'
import { benchmarkDownsampling, downsampleObjectPath } from './benchmark.js'
import { downsample } from './chart/downsample.js'

class MockWorker {
  constructor() {
    this.onmessage = null
    this.onerror = null
    this.terminated = false
  }

  postMessage(input) {
    queueMicrotask(() => {
      try {
        const result = downsample({
          steps: new Float64Array(input.steps),
          values: new Float64Array(input.values),
          anomaly: input.anomaly ? new Uint8Array(input.anomaly) : undefined,
          targetWidth: input.targetWidth,
          xRange: input.xRange,
        })
        this.onmessage?.({
          data: {
            steps: result.steps.buffer,
            values: result.values.buffer,
            anomaly: result.anomaly.buffer,
            index: result.index.buffer,
            breakBefore: result.breakBefore.buffer,
            gapBefore: result.gapBefore.buffer,
            length: result.length,
            envelope: {
              steps: result.envelope.steps.buffer,
              mins: result.envelope.mins.buffer,
              maxs: result.envelope.maxs.buffer,
              breakBefore: result.envelope.breakBefore.buffer,
              length: result.envelope.length,
            },
          },
        })
      } catch (error) {
        this.onerror?.(error)
      }
    })
  }

  terminate() {
    this.terminated = true
  }
}

describe('downsample benchmark harness', () => {
  it('uses the same metrics for object and typed worker paths', async () => {
    const input = {
      steps: Float64Array.from({ length: 10_000 }, (_, i) => i),
      values: Float64Array.from({ length: 10_000 }, (_, i) => Math.sin(i / 20)),
      anomaly: new Uint8Array(10_000),
      targetWidth: 250,
    }
    const result = await benchmarkDownsampling(input, () => new MockWorker())

    expect(result.equivalent).toBe(true)
    expect(result.beforePoints).toBe(result.afterPoints)
    expect(result.beforeMs).toBeGreaterThanOrEqual(0)
    expect(result.afterMs).toBeGreaterThanOrEqual(0)
  })

  it('converts the before path to object arrays without changing output', () => {
    const input = {
      steps: Float64Array.from([0, 1, 2, 3]),
      values: Float64Array.from([1, 4, 2, 3]),
      targetWidth: 2,
    }
    expect(downsampleObjectPath(input)).toEqual(downsample(input))
  })
})
