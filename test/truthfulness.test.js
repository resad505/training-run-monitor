/**
 * Truthfulness proofs (a–d) — Issue #19.
 *
 * Each proof runs the assembled chain (generator -> sanitizer -> downsampler
 * -> EMA / scale / renderer) and takes the stage it guards as a parameter.
 * Every proof is therefore run twice:
 *
 *   1. with the real implementation, where it must hold, and
 *   2. with a deliberately broken stand-in ("mutant") for that stage, where
 *      it must fail — otherwise the proof would not be guarding anything.
 *
 * Proof (a) is additionally run through the real Web Worker entry module.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { computeEMA, renderChart } from '../src/chart/renderer.js'
import { downsample } from '../src/chart/downsample.js'
import { createLinearScale } from '../src/chart/scale.js'
import { downsampleInWorker } from '../src/chart/worker-downsample.js'
import {
  generateRun,
  LARGE_RUN_ID,
  LARGE_RUN_SPIKE_STEP,
  LARGE_RUN_STEPS,
  RUN_COUNT,
} from '../src/pipeline/generator.js'
import { mulberry32 } from '../src/pipeline/prng.js'
import { ANOMALY, sanitizeRun } from '../src/pipeline/sanitizer.js'

const METRICS = ['loss', 'lr', 'grad_norm']
const SMALL_RUN_IDS = Array.from({ length: RUN_COUNT }, (_, id) => id).filter((id) => id !== LARGE_RUN_ID)

/**
 * A proof "fails" when one of its expect() calls throws. The message must
 * match `reason`, so a mutant cannot pass this check by crashing somewhere
 * unrelated to the property under test.
 */
async function mustFail(proof, reason) {
  await expect(Promise.resolve().then(proof)).rejects.toThrow(reason)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function finiteBounds(steps, values, xRange) {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < values.length; i++) {
    if (xRange && (steps[i] < xRange[0] || steps[i] > xRange[1])) continue
    const v = values[i]
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

/** Last-arrival-wins value per step, straight from the generator output. */
function rawLossByStep(raw) {
  const byStep = new Map()
  for (const entry of raw.steps) byStep.set(entry.step, entry.loss)
  return byStep
}

/** Independent reference: deduplicated (last wins) and sorted by step. */
function cleanSorted(raw) {
  const byStep = new Map()
  for (const entry of raw.steps) byStep.set(entry.step, entry)
  return [...byStep.values()].sort((a, b) => a.step - b.step)
}

function shuffled(items, seed) {
  const rng = mulberry32(seed)
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(0, i)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Canvas context stub that records text labels and rejects non-finite paths. */
function recordingContext() {
  const labels = []
  const finite = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`non-finite coordinate (${x}, ${y})`)
  }
  const noop = () => {}
  return {
    labels,
    moveTo: finite,
    lineTo: finite,
    fillText: (text, x, y) => labels.push({ text, x, y }),
    clearRect: noop,
    beginPath: noop,
    closePath: noop,
    stroke: noop,
    fill: noop,
    strokeRect: noop,
    fillRect: noop,
    rect: noop,
    clip: noop,
    setLineDash: noop,
    save: noop,
    restore: noop,
  }
}

/**
 * Runs the real worker entry module (downsample.worker.js) in-process: its
 * `self` is stubbed and messages are structured-cloned with their transfer
 * lists, exactly as the browser would do across the thread boundary.
 */
async function createInProcessWorker() {
  // The worker module reads `self` on every message, so the stub stays in
  // place until the calling test removes it with vi.unstubAllGlobals().
  const scope = { onmessage: null, postMessage: null }
  vi.stubGlobal('self', scope)
  vi.resetModules()
  await import('../src/chart/downsample.worker.js')

  const worker = { onmessage: null, onerror: null, terminate() {} }
  scope.postMessage = (payload, transfer = []) => {
    const data = structuredClone(payload, { transfer })
    queueMicrotask(() => worker.onmessage?.({ data }))
  }
  worker.postMessage = (input, transfer = []) => {
    const data = structuredClone(input, { transfer })
    queueMicrotask(() => scope.onmessage({ data }))
  }
  return worker
}

// ---------------------------------------------------------------------------
// Mutants: deliberately broken stand-ins for the guarded stages
// ---------------------------------------------------------------------------

/** Windowed bucket means — the classic decimator that erases spikes. */
function meanDecimator({ steps, values, targetWidth, xRange }) {
  const picked = []
  for (let i = 0; i < steps.length; i++) {
    if (!xRange || (steps[i] >= xRange[0] && steps[i] <= xRange[1])) picked.push(i)
  }
  const size = Math.max(2, Math.ceil(picked.length / targetWidth))
  const outSteps = []
  const outValues = []
  for (let b = 0; b < picked.length; b += size) {
    const bucket = picked.slice(b, b + size)
    outSteps.push(steps[bucket[0]])
    outValues.push(bucket.reduce((sum, i) => sum + values[i], 0) / bucket.length)
  }
  return { steps: Float64Array.from(outSteps), values: Float64Array.from(outValues), length: outSteps.length }
}

/** Every n-th point — keeps real values but drops whatever falls between. */
function strideDecimator({ steps, values, targetWidth, xRange }) {
  const picked = []
  for (let i = 0; i < steps.length; i++) {
    if (!xRange || (steps[i] >= xRange[0] && steps[i] <= xRange[1])) picked.push(i)
  }
  const stride = Math.max(2, Math.ceil(picked.length / targetWidth))
  const kept = picked.filter((_, k) => k % stride === 1)
  return {
    steps: Float64Array.from(kept, (i) => steps[i]),
    values: Float64Array.from(kept, (i) => values[i]),
    length: kept.length,
  }
}

/** Sanitizer that "cleans" missing or infinite measurements to 0. */
function coercingSanitize(run) {
  const zeroed = (v) => (Number.isFinite(v) ? v : 0)
  return sanitizeRun({
    ...run,
    steps: run.steps.map((s) => ({ ...s, loss: zeroed(s.loss), lr: zeroed(s.lr), grad_norm: zeroed(s.grad_norm) })),
  })
}

/** Decimator that silently drops non-finite points before bucketing. */
function finiteOnlyDecimator(input) {
  const keep = []
  for (let i = 0; i < input.values.length; i++) if (Number.isFinite(input.values[i])) keep.push(i)
  return downsample({
    ...input,
    steps: Float64Array.from(keep, (i) => input.steps[i]),
    values: Float64Array.from(keep, (i) => input.values[i]),
    anomaly: Uint8Array.from(keep, (i) => input.anomaly[i]),
  })
}

/** EMA that carries the previous average across missing data. */
function bridgingEMA(steps, values, weight = 0.8) {
  const out = new Float64Array(values.length)
  let ema = null
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) ema = ema === null ? values[i] : ema * weight + values[i] * (1 - weight)
    out[i] = ema ?? 0
  }
  return out
}

/** Columnar conversion with the sort and/or the last-write-wins rule removed. */
function naiveSanitize({ sort, lastWins }) {
  return (run) => {
    const ordered = sort ? run.steps.slice().sort((a, b) => a.step - b.step) : run.steps
    const entries = []
    const position = new Map()
    for (const entry of ordered) {
      if (position.has(entry.step)) {
        if (lastWins) entries[position.get(entry.step)] = entry
        continue
      }
      position.set(entry.step, entries.length)
      entries.push(entry)
    }
    return {
      id: run.id,
      length: entries.length,
      steps: Float64Array.from(entries, (e) => e.step),
      loss: Float64Array.from(entries, (e) => e.loss),
      lr: Float64Array.from(entries, (e) => e.lr),
      grad_norm: Float64Array.from(entries, (e) => e.grad_norm),
      anomaly: new Uint8Array(entries.length),
    }
  }
}

/** Scale whose ticks are "nice" numbers extended past the data bounds. */
function overshootingScale(options) {
  const scale = createLinearScale(options)
  return {
    ...scale,
    ticks: (count) => {
      const ticks = scale.ticks(count)
      const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1
      return [ticks[0] - step, ...ticks, ticks[ticks.length - 1] + step]
    },
  }
}

/** Scale whose labels are rounded for looks (0.0002 becomes "0.00"). */
function roundingScale(options) {
  return { ...createLinearScale(options), tickFormat: (tick) => tick.toFixed(2) }
}

/** Scale built on a domain padded to round numbers, so the ends miss the data. */
function paddedDomainScale({ domain, range }) {
  const span = domain[1] - domain[0]
  return createLinearScale({ domain: [domain[0] - span, domain[1] + span], range })
}

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

const SPIKE_WINDOWS = [
  { targetWidth: 800 },
  { targetWidth: 500, xRange: [450_000, 550_000] },
  { targetWidth: 200, xRange: [499_500, 500_500] },
  { targetWidth: 50, xRange: [0, 999_999] },
]

/** (a) The spike and the window extrema survive decimation at every zoom. */
async function proofSpikeSurvives(large, decimate) {
  const spikeIdx = large.steps.indexOf(LARGE_RUN_SPIKE_STEP)
  const spikeValue = large.loss[spikeIdx]
  expect(spikeIdx).toBeGreaterThan(0)
  expect(spikeValue).toBeGreaterThan(large.loss[spikeIdx - 1] * 5)

  for (const window of SPIKE_WINDOWS) {
    const label = JSON.stringify(window)
    const decimated = await decimate({ steps: large.steps, values: large.loss, anomaly: large.anomaly, ...window })

    const at = decimated.steps.indexOf(LARGE_RUN_SPIKE_STEP)
    expect(at, `spike step missing in ${label}`).toBeGreaterThanOrEqual(0)
    expect(decimated.values[at], `spike value altered in ${label}`).toBe(spikeValue)

    const raw = finiteBounds(large.steps, large.loss, window.xRange)
    const kept = finiteBounds(decimated.steps, decimated.values, window.xRange)
    expect(kept.max, `window max lost in ${label}`).toBe(raw.max)
    expect(kept.min, `window min lost in ${label}`).toBe(raw.min)
  }
}

/** (b) NaN and ±Infinity are never coerced to 0, dropped or smoothed over. */
function proofNonFinitePreserved({ sanitize = sanitizeRun, decimate = downsample, ema = computeEMA } = {}) {
  let nonFiniteSeen = 0

  for (const id of SMALL_RUN_IDS) {
    const raw = generateRun(id)
    const truth = rawLossByStep(raw)
    const run = sanitize(raw)

    // Sanitizer: every value is bit-for-bit what the generator emitted.
    for (let i = 0; i < run.length; i++) {
      expect(Object.is(run.loss[i], truth.get(run.steps[i])), `run ${id} step ${run.steps[i]} loss changed`).toBe(true)
    }

    const nonFinite = []
    for (let i = 0; i < run.length; i++) if (!Number.isFinite(run.loss[i])) nonFinite.push(i)
    for (const i of nonFinite) expect(run.anomaly[i] & ANOMALY.NON_FINITE).toBeTruthy()

    // Downsampler: forced to decimate (25 buckets for ~200 points), yet every
    // non-finite point is still there with its exact value.
    const decimated = decimate({ steps: run.steps, values: run.loss, anomaly: run.anomaly, targetWidth: 25 })
    expect(decimated.length).toBeLessThan(run.length)
    for (const i of nonFinite) {
      const at = decimated.steps.indexOf(run.steps[i])
      expect(at, `run ${id}: non-finite step ${run.steps[i]} dropped by decimation`).toBeGreaterThanOrEqual(0)
      expect(Object.is(decimated.values[at], run.loss[i])).toBe(true)
    }

    // Smoothing: the EMA is non-finite exactly where the data is, and restarts
    // from the raw value afterwards instead of bridging the hole.
    const smoothed = ema(run.steps, run.loss)
    for (const i of nonFinite) {
      expect(Object.is(smoothed[i], run.loss[i]), `run ${id}: EMA smoothed over step ${run.steps[i]}`).toBe(true)
      if (i + 1 < run.length && Number.isFinite(run.loss[i + 1])) {
        expect(smoothed[i + 1], `run ${id}: EMA bridged across step ${run.steps[i]}`).toBe(run.loss[i + 1])
      }
    }
    nonFiniteSeen += nonFinite.length
  }

  // The dataset must actually exercise NaN, +Infinity and -Infinity.
  expect(nonFiniteSeen).toBeGreaterThan(5)
}

/** (c) Unsorted and duplicated input gives the same output as clean sorted data. */
function proofOrderAndDuplicatesNormalised(sanitize = sanitizeRun) {
  for (const id of SMALL_RUN_IDS) {
    const raw = generateRun(id)
    const clean = cleanSorted(raw)
    const expected = sanitize({ id, steps: clean })

    // Arrival order scrambled, exact duplicates added, and stale readings
    // (wrong loss) that arrive first and must lose to the later, true entry.
    const stale = clean.slice(10, 15).map((entry) => ({ ...entry, loss: entry.loss + 1 }))
    const scrambled = [...stale, ...shuffled([...clean, ...clean.slice(20, 30)], 1000 + id)]

    for (const [name, steps] of [
      ['generator output', raw.steps],
      ['scrambled', scrambled],
    ]) {
      const actual = sanitize({ id, steps })
      const label = `run ${id} (${name})`
      expect(Array.from(actual.steps), `${label}: steps differ`).toEqual(Array.from(expected.steps))
      for (const metric of METRICS) {
        expect(Array.from(actual[metric]), `${label}: ${metric} differs`).toEqual(Array.from(expected[metric]))
      }

      // Only the COLLISION bit may differ: it records that a duplicate existed.
      const strip = (flags) => Array.from(flags, (f) => f & ~ANOMALY.COLLISION)
      expect(strip(actual.anomaly), `${label}: flags differ`).toEqual(strip(expected.anomaly))

      // Identical data must draw identically.
      const draw = (run) => downsample({ steps: run.steps, values: run.loss, targetWidth: 25 })
      expect(Array.from(draw(actual).values)).toEqual(Array.from(draw(expected).values))
    }

    const flagged = sanitize({ id, steps: scrambled })
    expect(flagged.anomaly[10] & ANOMALY.COLLISION, `run ${id}: resolved duplicate not flagged`).toBeTruthy()
  }
}

/** (d) Axis ticks and their labels match the bounds of the data they describe. */
function proofTicksMatchBounds(createScale = createLinearScale) {
  for (const id of [0, 7, 13]) {
    const run = sanitizeRun(generateRun(id))
    for (const metric of METRICS) {
      const decimated = downsample({ steps: run.steps, values: run[metric], anomaly: run.anomaly, targetWidth: 25 })
      const raw = finiteBounds(run.steps, run[metric])
      const drawn = finiteBounds(decimated.steps, decimated.values)
      const label = `run ${id} ${metric}`

      // What reaches the axis is the raw extent, not a decimated approximation.
      expect(drawn, `${label}: decimation changed the bounds`).toEqual(raw)

      const scale = createScale({ domain: [drawn.min, drawn.max], range: [300, 0] })
      expect(scale.scale(raw.min), `${label}: min is not on the axis end`).toBe(300)
      expect(scale.scale(raw.max), `${label}: max is not on the axis end`).toBe(0)

      const ticks = scale.ticks(5)
      expect(ticks.length).toBeGreaterThan(0)
      for (const tick of ticks) {
        expect(tick, `${label}: tick below the data`).toBeGreaterThanOrEqual(raw.min)
        expect(tick, `${label}: tick above the data`).toBeLessThanOrEqual(raw.max)
        expect(Number(scale.tickFormat(tick)), `${label}: label does not read back as its tick`).toBe(tick)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('truthfulness proofs (generator -> sanitizer -> chart)', () => {
  let large

  beforeAll(() => {
    large = sanitizeRun(generateRun(LARGE_RUN_ID, { steps: LARGE_RUN_STEPS }))
  })

  describe('(a) the 1M-point spike survives decimation', () => {
    it('holds on the main-thread path across zoom windows', async () => {
      await proofSpikeSurvives(large, downsample)
    })

    it('holds on the Web Worker path across zoom windows', async () => {
      const before = large.loss.length
      const worker = await createInProcessWorker()
      try {
        await proofSpikeSurvives(large, (input) => downsampleInWorker(input, worker))
      } finally {
        vi.unstubAllGlobals()
      }
      // Transferring buffers to the worker must not detach the caller's data.
      expect(large.loss.length).toBe(before)
    })

    it('fails when buckets are averaged', async () => {
      await mustFail(() => proofSpikeSurvives(large, meanDecimator), /spike value altered|spike step missing/)
    })

    it('fails when every n-th point is sampled', async () => {
      await mustFail(() => proofSpikeSurvives(large, strideDecimator), /spike step missing/)
    })
  })

  describe('(b) NaN and Infinity are never coerced or smoothed over', () => {
    it('holds for every generated run', () => {
      proofNonFinitePreserved()
    })

    it('fails when the sanitizer coerces non-finite values to 0', async () => {
      await mustFail(() => proofNonFinitePreserved({ sanitize: coercingSanitize }), /loss changed/)
    })

    it('fails when the downsampler drops non-finite points', async () => {
      await mustFail(() => proofNonFinitePreserved({ decimate: finiteOnlyDecimator }), /dropped by decimation/)
    })

    it('fails when smoothing bridges missing data', async () => {
      await mustFail(() => proofNonFinitePreserved({ ema: bridgingEMA }), /EMA smoothed over/)
    })
  })

  describe('(c) unsorted and duplicate steps normalise to the clean series', () => {
    it('holds for every generated run', () => {
      proofOrderAndDuplicatesNormalised()
    })

    it('fails without the sort', async () => {
      await mustFail(
        () => proofOrderAndDuplicatesNormalised(naiveSanitize({ sort: false, lastWins: true })),
        /steps differ/,
      )
    })

    it('fails when the first duplicate wins instead of the last', async () => {
      await mustFail(
        () => proofOrderAndDuplicatesNormalised(naiveSanitize({ sort: true, lastWins: false })),
        /loss differs/,
      )
    })
  })

  describe('(d) axis tick labels match the data bounds', () => {
    it('holds for every metric', () => {
      proofTicksMatchBounds()
    })

    it('fails when ticks overshoot the data', async () => {
      await mustFail(() => proofTicksMatchBounds(overshootingScale), /tick (below|above) the data/)
    })

    it('fails when labels are rounded', async () => {
      await mustFail(() => proofTicksMatchBounds(roundingScale), /does not read back as its tick/)
    })

    it('fails when the domain is padded away from the data', async () => {
      await mustFail(() => proofTicksMatchBounds(paddedDomainScale), /not on the axis end/)
    })

    it('holds for the labels the renderer actually draws', () => {
      const margins = { top: 20, right: 30, bottom: 40, left: 60 }
      for (const metric of METRICS) {
        const run = sanitizeRun(generateRun(3))
        const xRange = [run.steps[0], run.steps[run.length - 1]]
        const ctx = recordingContext()
        const { yScale, plotH } = renderChart(
          ctx,
          { steps: run.steps, values: run[metric], anomaly: run.anomaly },
          { width: 800, height: 300, xRange, margins },
        )
        const raw = finiteBounds(run.steps, run[metric])
        const [yMin, yMax] = yScale.domain

        // The y domain covers all the data and adds at most the 5% padding.
        expect(yMin).toBeLessThanOrEqual(raw.min)
        expect(yMax).toBeGreaterThanOrEqual(raw.max)
        expect(yMax - yMin).toBeLessThanOrEqual((raw.max - raw.min) * 1.1 + 1e-12)

        const yLabels = ctx.labels.filter((l) => l.x === margins.left - 8)
        const xLabels = ctx.labels.filter((l) => l.y === margins.top + plotH + 6)
        expect(yLabels.length).toBeGreaterThan(1)
        expect(xLabels.length).toBeGreaterThan(1)

        for (const { text, y } of yLabels) {
          const value = Number(text)
          expect(value).toBeGreaterThanOrEqual(yMin)
          expect(value).toBeLessThanOrEqual(yMax)
          // The label sits at the pixel its value maps to.
          expect(yScale.scale(value)).toBeCloseTo(y, 9)
        }
        for (const { text } of xLabels) {
          expect(Number(text)).toBeGreaterThanOrEqual(xRange[0])
          expect(Number(text)).toBeLessThanOrEqual(xRange[1])
        }
      }
    })
  })
})
