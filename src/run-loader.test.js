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
