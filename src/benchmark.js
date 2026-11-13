import { downsample } from './chart/downsample.js'
import { downsampleInWorker } from './chart/worker-downsample.js'

function now() {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

export function downsampleObjectPath(input) {
  return downsample({
    ...input,
    steps: Array.from(input.steps),
    values: Array.from(input.values),
    anomaly: input.anomaly ? Array.from(input.anomaly) : undefined,
  })
}

function equalArray(left, right) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (Object.is(left[i], right[i])) continue
    if (Number.isNaN(left[i]) && Number.isNaN(right[i])) continue
    return false
  }
  return true
}

export function equivalentDownsample(left, right) {
  return (
    equalArray(left.steps, right.steps) &&
    equalArray(left.values, right.values) &&
    equalArray(left.anomaly, right.anomaly) &&
    equalArray(left.index, right.index) &&
    equalArray(left.breakBefore, right.breakBefore) &&
    equalArray(left.gapBefore, right.gapBefore) &&
    equalArray(left.envelope.steps, right.envelope.steps) &&
    equalArray(left.envelope.mins, right.envelope.mins) &&
    equalArray(left.envelope.maxs, right.envelope.maxs) &&
    equalArray(left.envelope.breakBefore, right.envelope.breakBefore)
  )
}

export async function benchmarkDownsampling(input, workerFactory) {
  const beforeStart = now()
  const before = downsampleObjectPath(input)
  const beforeMs = now() - beforeStart

  const afterStart = now()
  const after = await downsampleInWorker(input, workerFactory ? workerFactory() : undefined)
  const afterMs = now() - afterStart

  return {
    beforeMs,
    afterMs,
    beforePoints: before.length,
    afterPoints: after.length,
    equivalent: equivalentDownsample(before, after),
  }
}
