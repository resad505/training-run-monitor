import { downsample } from './downsample.js'

self.onmessage = ({ data }) => {
  try {
    const result = downsample({
      steps: new Float64Array(data.steps),
      values: new Float64Array(data.values),
      anomaly: data.anomaly ? new Uint8Array(data.anomaly) : undefined,
      targetWidth: data.targetWidth,
      xRange: data.xRange,
    })

    const payload = {
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
    }
    const transfer = [
      payload.steps,
      payload.values,
      payload.anomaly,
      payload.index,
      payload.breakBefore,
      payload.gapBefore,
      payload.envelope.steps,
      payload.envelope.mins,
      payload.envelope.maxs,
      payload.envelope.breakBefore,
    ]
    self.postMessage(payload, transfer)
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Worker downsampling failed.' })
  }
}
