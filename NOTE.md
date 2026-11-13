# Training Run Monitor — submission note

- Live: https://training-run-monitor-one.vercel.app/
- Repository: https://github.com/resad505/training-run-monitor
- Tests and output: `npm run test` → [docs/test-output.txt](docs/test-output.txt) (275 tests, 16 files, all passing at commit `f8ed5e1`)
- Performance traces: [perf/before.trace.json.gz](perf/before.trace.json.gz), [perf/after.trace.json.gz](perf/after.trace.json.gz)
- Design, trade-offs, limits of every module: [ARCHITECTURE.md](ARCHITECTURE.md) · AI use: [ai-use.md](ai-use.md)

## 1. What was built

Vanilla JS + Vite, canvas charts, no chart library. 20 seeded runs (19 of 200
steps, one of 1,000,000 with a single spike) with injected spikes, NaN,
±Infinity, plateaus, duplicates, gaps and unsorted blocks. Run list with sort
and filter, three charts, summary cards, loading / empty / error / stale
states, linear and log axis, smoothing slider, zoom / pan / crosshair by
mouse and keyboard, responsive layout, WCAG AA contrast.

## 2. Is the chart truthful?

One rule: **the chart may show less detail than the data, never different
data.** Decimation keeps each pixel bucket's min and max plus every flagged
and non-finite point; nothing is averaged.

Each claim is a test that runs the whole chain (generator → sanitizer →
downsampler → renderer) and is run twice: with the real code (must pass) and
with a deliberately broken stand-in (must fail for the named reason).

| Claim | Broken stand-ins that make the test fail |
| --- | --- |
| (a) The 1M spike and each window's min/max survive at four zoom levels, on the main thread and through the worker module | bucket averaging; every n-th point |
| (b) NaN / ±Infinity leave the sanitizer bit-identical, survive decimation, and the smoothed line neither covers nor bridges them | coerce to 0; drop non-finite; EMA carried across holes |
| (c) Shuffled input with exact and stale duplicates gives the same columns, flags and drawing as clean sorted data | no sort; first-write-wins |
| (d) Ticks lie inside the data bounds, labels read back exactly as their tick, drawn labels sit at the right pixel | ticks past the bounds; rounded labels; padded domain |

**What the tests would NOT catch**

- Pixels: the canvas is a recording stub, so tests prove which calls are
  made, not what the result looks like (overlapping `≤0` badges on run 14).
- `main.js` (no DOM test environment): keyboard flow, focus, the stale
  indicator and the worker wiring were checked by hand.
- The stand-ins replace a whole stage; they are not mutations of the real
  source, so they do not show that every bug would be caught.
- Thresholds are tuned on the synthetic generator. No real log was used.

## 3. Performance (4x CPU throttle, headless Chrome 157, 1M-point run)

Same script (`scripts/measure.mjs`) before and after. After = dataset built
in a Web Worker, decimation reused when unchanged, pointer redraws coalesced.

| Metric | Before | After |
| --- | ---: | ---: |
| First chart on screen | 3,041 ms | 471 ms |
| Longest main-thread block at start-up | 2,848 ms | 218 ms |
| Hover redraw, median / p95 | 34.6 / 38.3 ms | 5.1 / 8.1 ms |
| Zoom redraw at full range, median / p95 | 35.1 / 55.0 ms | 38.7 / 59.0 ms |
| Renderer process after start-up | 372 MB | 316 MB |
| Renderer process, 1M run on screen, after GC | 165 MB | **341 MB** |

**Failed or unimproved results, not hidden:** zoom did not get faster (each
step still rescans the visible window); steady-state memory got **worse** by
about 175 MB even though the worker is terminated, and the cause is not
confirmed; CPU throttling does not slow workers, so the worker-side time is
optimistic. One machine, one to three runs per figure.

## 4. Silent failures: what looks fine but is wrong

| Failure | What was done | How it was checked |
| --- | --- | --- |
| Request race on fast run switching | Generation token + abort; title and data change together, only on success | Unit tests incl. a reproduction of the unguarded race; rapid clicks in the browser |
| Stale data | Body dimmed, `aria-busy`, indicator names both the loading and the displayed run | By hand; the loader is in-memory, so the state lasts milliseconds |
| Locale / time zone | One formatter module fixed to `en-US` and UTC with an explicit suffix | Unit tests; a test scans the source for locale-dependent APIs elsewhere. A second OS locale was not actually run |
| Smoothing hides divergence | EMA computed on raw data, resets at gaps / non-finite; raw line and min–max band always drawn; weight shown, slider goes to "off" | Unit tests; at weight 0.95 the lag behind the raw line is visible |
| Log scale with zeros | Values ≤ 0 return `null`, break the line, get a `≤0` marker; heading counts them | Unit tests; run 14 has 18 such values |

**Known and not fixed**

1. Anomaly flags are computed from `loss` only but drawn on all three charts.
2. A **sustained** rise in loss is not flagged: the outlier rule detects
   spikes, and a level shift of six or more points becomes the new baseline.
3. The y-axis rescales on zoom, so heights are not comparable across zooms.
4. The data is generated once in the browser. There is no live stream, so
   "stale" here means a pending selection, not a run that stopped reporting.

## 5. Verdict

**DON'T SHIP** — not as the thing someone looks at to decide whether to stop
a $500 run.

What it shows, it shows honestly: no spike, NaN, gap or duplicate is hidden
or altered on the way to the screen, and that is tested against broken
implementations. But the decision it is meant to support is "is this run
going wrong?", and the commonest way a run goes wrong — loss drifting up over
many steps — is the one case the anomaly rule does not flag. A clean-looking
summary ("1 flagged point") on a diverging run is worse than no summary. It
also has no live data, so it cannot yet be a monitor at all.

I would ship it today as a read-only viewer for finished runs, with that
limit stated on the page.

**Change first:** (1) detect sustained divergence and compute flags per
metric instead of from `loss` alone; (2) a min/max pyramid, so zoom costs
`O(pixels)` instead of rescanning the window; (3) generate straight into typed
arrays, which removes the million temporary objects behind the memory result.

## What surprised me, and what still concerns me

The result I did not expect was that the "obvious" optimisation made one
number worse: moving generation into a worker cut first render from about 3 s
to under half a second, and the renderer still ended up holding roughly
175 MB more than before, with the worker confirmed gone. Without the
measurement harness I would have reported that change as a clean win. The
same thing happened on the truthfulness side: the charts looked right while
the crosshair was reporting a point a few pixels away from the cursor, and
the first proof suite passed without ever having been shown to fail on broken
code. A confident sentence from the AI tool was also simply wrong — it wrote
that the dataset contains no values ≤ 0; a one-line check found 62. What
still concerns me is everything that only a person looking at the screen can
catch, since no test sees pixels; the memory result I can describe but not
explain; and slow divergence, where the tool would stay quiet at exactly the
moment it is needed.
