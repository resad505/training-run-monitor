# Training Run Monitor

A dashboard for inspecting machine-learning training runs (`loss`, `lr`,
`grad_norm`) that shows corrupted data as it is: NaN, Infinity, gaps,
duplicates and spikes are flagged and drawn, never hidden or smoothed away.

- Live: https://training-run-monitor-one.vercel.app/
- Design decisions, trade-offs, edge cases and the limits of the tests:
  [ARCHITECTURE.md](ARCHITECTURE.md)

## Run it

```bash
npm ci
npm run dev     # local app
npm run lint
npm run test    # unit tests and the truthfulness proofs (a-d)
npm run build
```

Keyboard: Tab reaches the run list, arrow keys / Home / End move through it,
Enter selects. On a focused chart, arrows pan and zoom, Shift+Left/Right step
through points, `[` and `]` jump between anomalies, Home resets.

## Performance: before and after

Measured by [`scripts/measure.mjs`](scripts/measure.mjs), which drives a local
headless Chrome over the DevTools Protocol with **4x CPU throttling**, loads
the production build, opens the 1,000,000-point run, sends 40 wheel events
(zoom) and 80 pointer moves (hover) to the loss chart, and records a
Performance trace.

- Chrome 157, 1280x900 @1x, chart 823 px wide, 13 Nov 2026, one laptop.
- Raw results and traces: [`perf/before.json`](perf/before.json),
  [`perf/after.json`](perf/after.json), `perf/*.trace.json.gz` (DevTools >
  Performance > Load profile; timed sections appear in the Timings track).
- **Before** = commit `a377ef0`: everything on the main thread, every pointer
  or wheel event re-decimates and redraws synchronously.
- **After** = this version: dataset built in a Web Worker and delivered
  smallest run first; decimation reused when its inputs are unchanged; pointer
  and wheel redraws coalesced to one per frame.

| Metric (4x CPU throttle) | Before | After |
| --- | ---: | ---: |
| First chart on screen | 3,041 ms | 471 ms |
| Longest main-thread block during start-up | 2,848 ms | 218 ms |
| All 20 runs available (incl. 1M points) | 3,187 ms | 916 ms ¹ |
| Hover: redraw, median / p95 | 34.6 / 38.3 ms | 5.1 / 8.1 ms |
| Zoom at full 1M range: redraw, median / p95 | 35.1 / 55.0 ms | 38.7 / 59.0 ms |
| Open the 1M run (three charts) | 400 ms | 596 ms ² |
| Main-thread JS heap after start-up | 150.9 MB | 1.1 MB |
| Renderer process after start-up | 372 MB | 316 MB |
| Renderer process, 1M run on screen, after GC | 165 MB | 341 MB ³ |

The table is from the two traced runs so every figure is backed by a committed
file. Tracing itself slows the page: without it, first chart was 2,849–2,870 ms
before and 337–364 ms after (two and three runs).

**What did not improve, and what the numbers do not show**

1. ¹ CPU throttling applies to the main thread only. The worker ran at full
   speed, so 916 ms understates what a genuinely slow device would see; the
   main-thread figures are the comparable ones.
2. **Zoom is unchanged.** Each zoom step still rescans the visible window,
   which at full range is all 1M points (~35–40 ms throttled). Coalescing only helps when several events land in one frame.
   Fixing this needs a precomputed min/max pyramid so a redraw costs
   `O(pixels)` — the first thing to change next.
3. ² Opening the 1M run shows no reliable change: 400–522 ms before and
   328–622 ms after across runs. The work (three decimations and three EMA
   passes over 1M points) is the same code in both versions.
4. ³ **Steady-state memory got worse.** The worker is terminated once the
   dataset is delivered (the harness confirms no worker is alive), but the
   renderer process stays about 175 MB higher than before, and neither waiting
   15 s nor a simulated memory-pressure signal brings it down. My reading is
   that memory freed by the terminated worker is not returned to the OS, but I
   have not confirmed the mechanism. The 1M objects the generator creates are
   the cause in both versions; generating directly into typed arrays would
   remove them.
5. Headless Chrome on one machine, one or a few runs per figure. These show
   direction and rough size, not a guarantee.

To reproduce:

```bash
npm run build
```

```bash
npm run preview
```

```bash
npm run measure -- --label=after
```

## Decimation micro-benchmark

This is a narrower, older measurement of the decimation function alone (the
app-level numbers are above). Issue #20 provides one harness for comparing the legacy object-array main-thread
path with the TypedArray Web Worker path:

```js
import { benchmarkDownsampling } from './src/benchmark.js'
import { generateRun, LARGE_RUN_ID, LARGE_RUN_STEPS } from './src/pipeline/generator.js'
import { sanitizeRun } from './src/pipeline/sanitizer.js'

const run = sanitizeRun(generateRun(LARGE_RUN_ID, { steps: LARGE_RUN_STEPS }))
const result = await benchmarkDownsampling({
  steps: run.steps,
  values: run.loss,
  anomaly: run.anomaly,
  targetWidth: 800,
})
console.table(result)
```

`downsampleInWorker` copies typed inputs before transferring them, so this
benchmark does not detach or mutate `run.steps`, `run.loss`, or `run.anomaly`.

The harness reports both durations, output point counts and an equivalence
boolean. Both paths use the same 1,000,000-point input and the same
extrema-preserving algorithm; only the transport and input representation
differ.

### Recorded result

Measured in Chromium on 2026-11-13 with DevTools **4x CPU throttling**, an
800-pixel target and the deterministic 1,000,000-point run:

| Path | Duration | Output points |
| --- | ---: | ---: |
| Before: object arrays on main thread | 345.7 ms | 1,607 |
| After: TypedArray + Web Worker | 53.4 ms | 1,607 |

`equivalent` was `true`. Timings are a reference measurement, not a
performance contract; rerun the harness on the target browser and hardware.

### 4x CPU throttling method

1. Run `npm run dev`.
2. Open the DevTools console on the local app.
3. Paste the benchmark snippet above.
4. Set **Performance > CPU throttling > 4x slowdown** before running it.
5. Record `beforeMs`, `afterMs`, `beforePoints`, `afterPoints`, and `equivalent`
   from the console output. The equivalence field must remain `true`; timings
   are machine- and browser-specific and must not be treated as constants.