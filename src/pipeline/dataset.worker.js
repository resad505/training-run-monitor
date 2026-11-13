/**
 * Builds the dataset off the main thread.
 *
 * Generating and sanitizing the 1M-step run takes seconds and allocates a
 * million short-lived objects. Doing it here keeps the page responsive, and
 * the garbage stays in this worker's heap, which is released when the worker
 * is terminated.
 *
 * Protocol (worker -> page):
 *   { type: 'start', total }        once, before any run
 *   { type: 'run', run }            one per run; typed-array buffers transferred
 *   { type: 'done' }                all runs sent
 *   { type: 'error', message }      generation failed; nothing more follows
 */

import { DEFAULT_ROOT_SEED, generateRun } from './generator.js'
import { sanitizeRun } from './sanitizer.js'
import { buildPlan, transferList } from './dataset-plan.js'

self.onmessage = ({ data }) => {
  try {
    const rootSeed = data?.rootSeed ?? DEFAULT_ROOT_SEED
    const plan = buildPlan()
    self.postMessage({ type: 'start', total: plan.length })
    for (const { id, steps } of plan) {
      const run = sanitizeRun(generateRun(id, { rootSeed, steps }))
      self.postMessage({ type: 'run', run }, transferList(run))
    }
    self.postMessage({ type: 'done' })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Dataset generation failed.' })
  }
}
