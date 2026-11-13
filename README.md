# Training Run Monitor

## Decimation benchmark

Issue #20 provides one harness for comparing the legacy object-array main-thread
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