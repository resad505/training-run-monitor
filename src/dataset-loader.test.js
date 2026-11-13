import { describe, expect, it, vi } from 'vitest'
import { loadDataset } from './dataset-loader.js'
import { generateDataset, generateRun, LARGE_RUN_ID, RUN_COUNT, STEPS_PER_RUN } from './pipeline/generator.js'
import { buildPlan, transferList } from './pipeline/dataset-plan.js'
import { sanitizeDataset, sanitizeRun } from './pipeline/sanitizer.js'

function fakeWorker() {
  const worker = {
    onmessage: null,
    onerror: null,
    posted: [],
    terminated: false,
    postMessage: (message) => worker.posted.push(message),
    terminate: () => {
      worker.terminated = true
    },
    emit: (data) => worker.onmessage?.({ data }),
  }
  return worker
}

function recorder() {
  const events = []
  return {
    events,
    handlers: {
      onStart: (total) => events.push(['start', total]),
      onRun: (run) => events.push(['run', run.id]),
      onDone: () => events.push(['done']),
      onError: (error) => events.push(['error', error.message]),
    },
  }
}

describe('dataset plan', () => {
  it('builds every run exactly once, the 1M-step run last', () => {
    const plan = buildPlan()

    expect(plan.map((entry) => entry.id).sort((a, b) => a - b)).toEqual(Array.from({ length: RUN_COUNT }, (_, i) => i))
    expect(plan.at(-1).id).toBe(LARGE_RUN_ID)
    expect(plan.slice(0, -1).every((entry) => entry.steps === STEPS_PER_RUN)).toBe(true)
  })

  it('lists each buffer of a run once for transfer', () => {
    const run = sanitizeRun(generateRun(0))
    const buffers = transferList(run)

    expect(new Set(buffers).size).toBe(5)
    expect(buffers).toContain(run.loss.buffer)
    expect(buffers).toContain(run.anomaly.buffer)
  })
})

describe('dataset loader', () => {
  it('forwards the request and delivers runs in arrival order', () => {
    const worker = fakeWorker()
    const { events, handlers } = recorder()
    loadDataset(worker, handlers, { rootSeed: 7 })

    worker.emit({ type: 'start', total: 2 })
    worker.emit({ type: 'run', run: { id: 4 } })
    worker.emit({ type: 'run', run: { id: 19 } })
    worker.emit({ type: 'done' })

    expect(worker.posted).toEqual([{ rootSeed: 7 }])
    expect(events).toEqual([['start', 2], ['run', 4], ['run', 19], ['done']])
    expect(worker.terminated).toBe(true)
  })

  it('reports a worker-side failure once and stops listening', () => {
    const worker = fakeWorker()
    const { events, handlers } = recorder()
    loadDataset(worker, handlers)

    worker.emit({ type: 'run', run: { id: 1 } })
    worker.emit({ type: 'error', message: 'out of memory' })
    worker.emit({ type: 'run', run: { id: 2 } })

    expect(events).toEqual([['run', 1], ['error', 'out of memory']])
    expect(worker.terminated).toBe(true)
  })

  it('reports a crashed worker', () => {
    const worker = fakeWorker()
    const { events, handlers } = recorder()
    loadDataset(worker, handlers)

    worker.onerror({ message: 'script failed to load' })

    expect(events).toEqual([['error', 'script failed to load']])
  })

  it('delivers nothing after cancel, so a retry cannot receive stale runs', () => {
    const worker = fakeWorker()
    const { events, handlers } = recorder()
    const load = loadDataset(worker, handlers)
    const deliver = worker.onmessage

    worker.emit({ type: 'run', run: { id: 1 } })
    load.cancel()
    // A message already in flight when the worker was terminated.
    deliver({ data: { type: 'run', run: { id: 2 } } })
    deliver({ data: { type: 'done' } })

    expect(events).toEqual([['run', 1]])
    expect(worker.terminated).toBe(true)
  })

  it('turns a handler that throws into an error instead of a half-painted page', () => {
    const worker = fakeWorker()
    const onError = vi.fn()
    loadDataset(worker, {
      onRun: () => {
        throw new Error('render failed')
      },
      onError,
    })

    worker.emit({ type: 'run', run: { id: 1 } })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('render failed')
    expect(worker.terminated).toBe(true)
  })

  it('rejects a message it does not understand', () => {
    const worker = fakeWorker()
    const { events, handlers } = recorder()
    loadDataset(worker, handlers)

    worker.emit({ type: 'surprise' })

    expect(events).toEqual([['error', 'Unexpected message from the dataset worker.']])
  })
})

describe('dataset worker module', () => {
  it('delivers the same data as building the dataset on the main thread', async () => {
    // Run the real worker module in-process: `self` is stubbed and every
    // message crosses a structuredClone with its transfer list, as it would
    // between threads.
    const scope = { onmessage: null, postMessage: null }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('./pipeline/dataset.worker.js')

    const worker = { onmessage: null, onerror: null, terminate() {} }
    scope.postMessage = (payload, transfer = []) => {
      const data = structuredClone(payload, { transfer })
      worker.onmessage?.({ data })
    }
    worker.postMessage = (request) => scope.onmessage({ data: request })

    const received = []
    let done = false
    try {
      loadDataset(worker, { onRun: (run) => received.push(run), onDone: () => (done = true) })
    } finally {
      vi.unstubAllGlobals()
    }

    const expected = sanitizeDataset(generateDataset())
    expect(done).toBe(true)
    expect(received.map((run) => run.id)).toEqual(buildPlan().map((entry) => entry.id))

    for (const run of received) {
      const reference = expected[run.id]
      expect(run.length).toBe(reference.length)
      expect(run.collisions).toBe(reference.collisions)
      expect(run.gaps).toBe(reference.gaps)
      for (const column of ['steps', 'loss', 'lr', 'grad_norm', 'anomaly']) {
        expect(run[column].constructor).toBe(reference[column].constructor)
        expect(run[column].length).toBe(reference[column].length)
        // Object.is on every element: NaN must still be NaN, -0 still -0.
        let identical = true
        for (let i = 0; i < run[column].length && identical; i++) {
          identical = Object.is(run[column][i], reference[column][i])
        }
        expect(identical, `run ${run.id} ${column} differs after transfer`).toBe(true)
      }
    }
  }, 30_000)
})
