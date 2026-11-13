import { describe, expect, it } from 'vitest'
import { createRunSelectionController } from './run-loader.js'

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('run selection controller', () => {
  it('does not paint a superseded result', async () => {
    const first = deferred()
    const second = deferred()
    const painted = []
    const pending = new Map([
      [1, first],
      [2, second],
    ])
    const controller = createRunSelectionController((id) => pending.get(id).promise, {
      onSuccess: (run) => painted.push(run.id),
    })

    const firstSelection = controller.select(1)
    const secondSelection = controller.select(2)
    first.resolve({ id: 1 })
    second.resolve({ id: 2 })

    await Promise.all([firstSelection, secondSelection])
    expect(painted).toEqual([2])
  })

  it('aborts the previous loader when selection changes', () => {
    const signals = []
    const controller = createRunSelectionController((_id, signal) => {
      signals.push(signal)
      return new Promise(() => {})
    })

    controller.select(1)
    controller.select(2)

    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
  })
})

describe('run selection controller — failure and ordering', () => {
  it('ignores a slow earlier run that resolves after the newer one', async () => {
    const first = deferred()
    const second = deferred()
    const painted = []
    const pending = new Map([
      [1, first],
      [2, second],
    ])
    const controller = createRunSelectionController((id) => pending.get(id).promise, {
      onSuccess: (run) => painted.push(run.id),
    })

    const firstSelection = controller.select(1)
    const secondSelection = controller.select(2)
    second.resolve({ id: 2 })
    await secondSelection
    first.resolve({ id: 1 })

    expect(await firstSelection).toBe(false)
    expect(painted).toEqual([2])
  })

  it('reports where the selection points before any data arrives', () => {
    const started = []
    const controller = createRunSelectionController(() => new Promise(() => {}), {
      onStart: (id) => started.push(id),
    })

    controller.select(1)
    controller.select(2)

    expect(started).toEqual([1, 2])
  })

  it('surfaces a failed load of the current selection', async () => {
    const errors = []
    const controller = createRunSelectionController(() => Promise.reject(new Error('boom')), {
      onError: (error) => errors.push(error.message),
    })

    expect(await controller.select(1)).toBe(false)
    expect(errors).toEqual(['boom'])
  })

  it('does not surface a failure from a superseded load', async () => {
    const errors = []
    const painted = []
    let rejectFirst
    const controller = createRunSelectionController(
      (id) =>
        id === 1
          ? new Promise((_resolve, reject) => {
              rejectFirst = reject
            })
          : Promise.resolve({ id }),
      { onSuccess: (run) => painted.push(run.id), onError: (error) => errors.push(error.message) },
    )

    const firstSelection = controller.select(1)
    await controller.select(2)
    rejectFirst(new Error('stale failure'))

    expect(await firstSelection).toBe(false)
    expect(errors).toEqual([])
    expect(painted).toEqual([2])
  })

  it('paints nothing after cancel', async () => {
    const pending = deferred()
    const painted = []
    const controller = createRunSelectionController(() => pending.promise, {
      onSuccess: (run) => painted.push(run.id),
    })

    const selection = controller.select(1)
    controller.cancel()
    pending.resolve({ id: 1 })

    expect(await selection).toBe(false)
    expect(painted).toEqual([])
  })
})

describe('the race the controller guards against', () => {
  // The same scenario without the generation token: this is the failure the
  // fix removes, kept as a test so the guard is shown to be load-bearing.
  it('is reproduced by an unguarded loader: the slow first run paints last', async () => {
    const first = deferred()
    const second = deferred()
    const pending = new Map([
      [1, first],
      [2, second],
    ])
    const painted = []
    const unguardedSelect = async (id) => painted.push((await pending.get(id).promise).id)

    const selections = [unguardedSelect(1), unguardedSelect(2)]
    second.resolve({ id: 2 })
    first.resolve({ id: 1 })
    await Promise.all(selections)

    // Run 2 is selected, but run 1's data is what ended up on screen.
    expect(painted.at(-1)).toBe(1)
  })
})
