function createWorker() {
  return new Worker(new URL('./downsample.worker.js', import.meta.url), { type: 'module' })
}

function toTypedInput(input) {
  return {
    steps: input.steps instanceof Float64Array ? input.steps : Float64Array.from(input.steps),
    values: input.values instanceof Float64Array ? input.values : Float64Array.from(input.values),
    anomaly: input.anomaly
      ? input.anomaly instanceof Uint8Array
        ? input.anomaly
        : Uint8Array.from(input.anomaly)
      : undefined,
    targetWidth: input.targetWidth,
    xRange: input.xRange,
  }
}

function fromWorkerPayload(payload) {
  if (payload.error) throw new Error(payload.error)
  return {
    steps: new Float64Array(payload.steps),
    values: new Float64Array(payload.values),
    anomaly: new Uint8Array(payload.anomaly),
    index: new Float64Array(payload.index),
    breakBefore: new Uint8Array(payload.breakBefore),
    gapBefore: new Uint8Array(payload.gapBefore),
    length: payload.length,
    envelope: {
      steps: new Float64Array(payload.envelope.steps),
      mins: new Float64Array(payload.envelope.mins),
      maxs: new Float64Array(payload.envelope.maxs),
      breakBefore: new Uint8Array(payload.envelope.breakBefore),
      length: payload.envelope.length,
    },
  }
}

export function downsampleInWorker(input, worker = createWorker()) {
  const typed = toTypedInput(input)
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.onmessage = null
      worker.onerror = null
      if (typeof worker.terminate === 'function') worker.terminate()
    }
    worker.onmessage = ({ data }) => {
      try {
        const result = fromWorkerPayload(data)
        cleanup()
        resolve(result)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    worker.onerror = (error) => {
      cleanup()
      reject(error instanceof Error ? error : new Error('Worker downsampling failed.'))
    }
    const transfer = [typed.steps.buffer, typed.values.buffer]
    if (typed.anomaly) transfer.push(typed.anomaly.buffer)
    worker.postMessage(typed, transfer)
  })
}
