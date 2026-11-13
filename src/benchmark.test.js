import { describe, expect, it } from 'vitest'
import { benchmarkDownsampling, downsampleObjectPath } from './benchmark.js'
import { downsample } from './chart/downsample.js'
import { downsampleInWorker } from './chart/worker-downsample.js'

class MockWorker {
  constructor() {
    this.onmessage = null
    this.onerror = null
    this.terminated = false
  }

  postMessage(input, transfer = []) {
    expect(new Set(transfer).size).toBe(transfer.length)
    this.detachedInput = input
    const clonedInput = structuredClone(input, { transfer })
    queueMicrotask(() => {
      try {
        const result = downsample({
          steps: new Float64Array(clonedInput.steps),
          values: new Float64Array(clonedInput.values),
          anomaly: clonedInput.anomaly ? new Uint8Array(clonedInput.anomaly) : undefined,
          targetWidth: clonedInput.targetWidth,
          xRange: clonedInput.xRange,
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
    const worker = new MockWorker()
    const result = await benchmarkDownsampling(input, () => worker)

    expect(result.equivalent).toBe(true)
    expect(result.beforePoints).toBe(result.afterPoints)
    expect(result.beforeMs).toBeGreaterThanOrEqual(0)
    expect(result.afterMs).toBeGreaterThanOrEqual(0)
    expect(worker.detachedInput.steps.byteLength).toBe(0)
    expect(worker.detachedInput.values.byteLength).toBe(0)
    expect(worker.detachedInput.anomaly.byteLength).toBe(0)
  })

  it('does not detach or mutate caller-owned typed arrays', async () => {
    const input = {
      steps: Float64Array.from([0, 1, 2, 3]),
      values: Float64Array.from([1, 4, 2, 3]),
      anomaly: Uint8Array.from([0, 1, 0, 0]),
      targetWidth: 2,
    }
    const snapshots = {
      steps: Array.from(input.steps),
      values: Array.from(input.values),
      anomaly: Array.from(input.anomaly),
    }

    await downsampleInWorker(input, new MockWorker())

    expect(input.steps.length).toBe(4)
    expect(input.values.length).toBe(4)
    expect(input.anomaly.length).toBe(4)
    expect(Array.from(input.steps)).toEqual(snapshots.steps)
    expect(Array.from(input.values)).toEqual(snapshots.values)
    expect(Array.from(input.anomaly)).toEqual(snapshots.anomaly)
  })

  it('can benchmark the same input twice without detached buffers', async () => {
    const input = {
      steps: Float64Array.from({ length: 10_000 }, (_, i) => i),
      values: Float64Array.from({ length: 10_000 }, (_, i) => Math.sin(i / 20)),
      anomaly: new Uint8Array(10_000),
      targetWidth: 250,
    }

    const first = await benchmarkDownsampling(input, () => new MockWorker())
    const second = await benchmarkDownsampling(input, () => new MockWorker())

    expect(first.equivalent).toBe(true)
    expect(second.equivalent).toBe(true)
    expect(input.steps.length).toBe(10_000)
    expect(input.values.length).toBe(10_000)
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
