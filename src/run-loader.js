/**
 * Prevents an older asynchronous run load from painting after a newer
 * selection. Superseded requests are aborted where the loader supports it.
 */
export function createRunSelectionController(loadRun, { onStart, onSuccess, onError } = {}) {
  let generation = 0
  let activeController = null

  async function select(id) {
    const requestGeneration = ++generation
    activeController?.abort()
    const controller = new AbortController()
    activeController = controller
    onStart?.(id)

    try {
      const run = await loadRun(id, controller.signal)
      if (requestGeneration !== generation || controller.signal.aborted) return false
      onSuccess?.(run)
      return true
    } catch (error) {
      if (requestGeneration !== generation || controller.signal.aborted) return false
      onError?.(error)
      return false
    }
  }

  function cancel() {
    generation++
    activeController?.abort()
    activeController = null
  }

  return { select, cancel }
}
