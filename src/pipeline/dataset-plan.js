import { LARGE_RUN_ID, LARGE_RUN_STEPS, RUN_COUNT, STEPS_PER_RUN } from './generator.js'

/**
 * Order in which the dataset is built: every small run first, the 1M-step
 * run last. The dashboard can then show 19 runs almost immediately instead of
 * waiting behind the one run that takes nearly all of the time.
 *
 * @returns {Array<{ id: number, steps: number }>}
 */
export function buildPlan() {
  const plan = Array.from({ length: RUN_COUNT }, (_, id) => ({
    id,
    steps: id === LARGE_RUN_ID ? LARGE_RUN_STEPS : STEPS_PER_RUN,
  }))
  return plan.sort((a, b) => a.steps - b.steps || a.id - b.id)
}

/** The buffers of a sanitized run, for a zero-copy transfer between threads. */
export function transferList(run) {
  return [run.steps.buffer, run.loss.buffer, run.lr.buffer, run.grad_norm.buffer, run.anomaly.buffer]
}
