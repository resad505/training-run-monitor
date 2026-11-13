/**
 * Page-side half of the dataset worker protocol (see dataset.worker.js).
 *
 * Runs are delivered one at a time as they are ready. After `done`, an error
 * or `cancel()` the worker is terminated and every later message is ignored,
 * so a cancelled load (for example on Retry) can never deliver stale runs
 * into the new one.
 *
 * @param {Worker} worker
 * @param {object} handlers
 * @param {(total: number) => void} [handlers.onStart]
 * @param {(run: object) => void} [handlers.onRun]
 * @param {() => void} [handlers.onDone]
 * @param {(error: Error) => void} [handlers.onError]
 * @param {object} [request] - forwarded to the worker, e.g. `{ rootSeed }`
 * @returns {{ cancel: () => void }}
 */
export function loadDataset(worker, { onStart, onRun, onDone, onError } = {}, request = {}) {
  let finished = false

  const finish = () => {
    finished = true
    worker.onmessage = null
    worker.onerror = null
    worker.terminate?.()
  }

  const fail = (error) => {
    if (finished) return
    finish()
    onError?.(error)
  }

  worker.onmessage = ({ data }) => {
    if (finished) return
    try {
      switch (data?.type) {
        case 'start':
          onStart?.(data.total)
          break
        case 'run':
          onRun?.(data.run)
          break
        case 'done':
          finish()
          onDone?.()
          break
        case 'error':
          fail(new Error(data.message))
          break
        default:
          fail(new Error('Unexpected message from the dataset worker.'))
      }
    } catch (error) {
      // A handler threw while painting; report it instead of leaving the UI
      // half-updated with no explanation.
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  }
  worker.onerror = (event) => {
    fail(event instanceof Error ? event : new Error(event?.message || 'The dataset worker failed.'))
  }

  worker.postMessage(request)
  return { cancel: finish }
}
