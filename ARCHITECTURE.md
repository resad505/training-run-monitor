# Architecture and defense notes

This document records why each module is built the way it is, which edge cases
it handles, and — just as important — what its tests do **not** prove.

## The one rule

**The chart may show less detail than the data, but never different data.**
Every design decision below follows from it:

- A value is never changed, dropped, or replaced on its way to the screen.
  `NaN` stays `NaN`; it does not become `0`, a gap in the array, or a smoothed
  guess.
- Anything the pipeline cannot draw honestly is drawn as an explicit marker
  and counted in the UI, not skipped.
- When a pixel stands for many points, the reader is told so (min–max
  envelope, "this pixel covers N points").

## Data flow

```
generator.js      20 seeded runs as arrays of {step, loss, lr, grad_norm}
     │            with injected corruption (spike, NaN, ±Infinity, plateau,
     │            duplicate, gap, unsorted block)
     ▼
sanitizer.js      sort → dedupe (last write wins) → flag anomalies
     │            output: Float64Array per column + Uint8Array flag bitmask
     ▼
downsample.js     window → split at gaps / non-finite → per-bucket min + max
     │            + every flagged point; explicit breakBefore / gapBefore
     ▼
scale.js          value → pixel, or null when it cannot be plotted
     ▼
renderer.js       envelope, raw line, EMA of the RAW series, markers, axes
     ▼
interaction.js    zoom / pan / crosshair; crosshair reads the RAW arrays

main.js           DOM shell: run list, summary, cards, three chart panels
dashboard.js      pure helpers behind main.js (sort, filter, counts)
run-loader.js     race guard for run switching
formatters.js     the only place numbers and times become text
worker-downsample.js + downsample.worker.js + benchmark.js
                  TypedArray/Worker decimation path and its before/after harness
```

Everything except `main.js` is a pure function or a small closure with no DOM
access, which is why it can be unit-tested in plain Node and reused inside a
Web Worker.

---

## Modules

### `pipeline/prng.js` — mulberry32

- **Why:** `Math.random()` cannot be seeded, so tests could not pin a dataset.
  Mulberry32 is a few lines, has no dependency, and is good enough for
  simulation.
- **Trade-offs:** 32 bits of state (period 2³²) and not cryptographically
  secure. Irrelevant here; it would be the wrong choice for anything
  security-related.
- **Edge cases:** the seed is coerced to uint32, so negative or fractional
  seeds are valid and deterministic.
- **Tests do not catch:** statistical quality beyond a coarse distribution
  check. A subtly biased generator would pass.

### `pipeline/generator.js` — synthetic runs

- **Why:** each run's seed is derived from `(rootSeed, runId)`, so runs are
  independent: generating run 7 alone gives the same data as generating all 20.
  The first corruption of run `i` is `KINDS[i % 7]`, which guarantees every
  kind appears in the standard dataset.
- **Trade-offs:**
  - Output is an array of objects, including the 1,000,000-step run. That is
    slow and memory-hungry on purpose: it models a realistic ingest format and
    is the "before" shape the sanitizer converts away from.
  - A `manifest` of injected events and a `corrupt` flag are emitted for
    tests. The sanitizer never reads either — it must detect problems from the
    values alone.
- **Edge cases:** events avoid the first and last five steps; `gap`
  renumbers later steps and patches earlier manifest entries; `unsorted`
  blocks are applied last so index-based events operate on ordered data.
- **Tests do not catch:**
  - Realism. The loss curve is a noisy exponential; real runs have level
    shifts, warm restarts and divergence that are not modelled.
  - Generated duplicates are exact copies, so the generator alone cannot tell
    first-write-wins from last-write-wins. Proof (c) adds stale duplicates by
    hand to cover that.
  - Corruption only targets `loss` (dropout also blanks `lr` and `grad_norm`).

### `pipeline/sanitizer.js` — sort, dedupe, flag

- **Why columnar typed arrays:** one `Float64Array` per field is ~8 bytes per
  value, cache-friendly to scan, transferable to a Worker without copying, and
  it represents `NaN` and `±Infinity` exactly. Flags are a `Uint8Array`
  bitmask so one point can carry several anomaly kinds.
- **Why flag instead of fix:** removing or replacing a bad value is a silent
  edit. Flagging keeps the evidence and lets the UI count it.
- **Trade-offs:**
  - Duplicates are resolved last-write-wins by arrival order (relies on the
    stable sort). It assumes a later write is a correction. The kept entry is
    flagged `COLLISION`, but the losing value is discarded and cannot be
    inspected afterwards.
  - Outliers use a rolling median (11 neighbours, the point itself excluded)
    with a robust σ from the MAD of residuals per 1,024-step block. This
    follows a decaying trend and is not fooled by the spike it is testing, but
    a **sustained** shift of six or more points becomes the median and is not
    flagged — by design it detects spikes, not regime changes.
  - `EXPECTED_STRIDE` is fixed at 1. A run logged every 10 steps would be
    reported as all gaps.
  - **Anomaly flags are computed from `loss` only.** They are shown on the
    `lr` and `grad_norm` charts too (same step), and the UI says so. A NaN
    that exists only in `lr` is preserved and counted on its metric card, but
    carries no flag.
- **Edge cases:** empty run; all-NaN run; zero noise (σ = 0 → any deviation
  is an outlier); first/last five steps use a Theil–Sen line through nearby
  points because a one-sided median is biased by the trend; plateaus need
  three or more bit-identical finite values.
- **Tests do not catch:**
  - A `step` that is itself `NaN` or non-integer. The comparator would return
    `NaN` and the order would be unspecified.
  - Detection quality on real data: the thresholds (3.5σ, window 11) are
    tuned against the synthetic generator, so the tests share its assumptions.
  - Memory and time at sizes beyond 1M points.

### `chart/scale.js` — linear and log scales

- **Why `null` instead of a number:** a scale that returns `NaN` or clamps to
  an epsilon lets a bad coordinate reach the canvas, where it either vanishes
  silently or draws a line to a made-up position. Returning `null` forces
  every caller to decide what to do with an unplottable value.
- **Trade-offs:**
  - Ticks are generated strictly inside the domain. The axis therefore does
    not always have a tick at its ends, which looks less tidy than "nice"
    rounded axes but never implies data exists beyond the real bounds.
  - Tick labels must read back exactly (`Number(label) === tick`), so they are
    not grouped or rounded for looks.
  - Log scales throw on a non-positive domain rather than substituting one —
    a wrong domain is a caller bug.
- **Edge cases:** zero-width domain maps to the middle of the range; log
  values `<= 0` are reported unplottable, never clamped; very narrow log
  domains label their bounds.
- **Tests do not catch:** label overlap or legibility at real pixel sizes,
  and the `base` option of the log scale other than 10.

### `chart/downsample.js` — extrema-preserving decimation

- **Why min + max per bucket:** averaging or taking every n-th point erases
  single-step spikes, which are exactly what the reader is looking for. Keeping
  each bucket's min and max guarantees the extrema of any window survive at
  any width.
- **Why explicit `breakBefore` / `gapBefore`:** after decimation neighbouring
  output points are far apart by construction, so "is there a gap?" can no
  longer be answered by comparing steps. The decimator knows, so it says.
- **Trade-offs:**
  - Every flagged point and every non-finite point is kept. Output is bounded
    by `2·W + 4·S + F + A` (W buckets, S segments, F non-finite, A anomalous),
    not by `2·W`. A run with a very large number of flagged points would
    produce a large output; truthfulness was chosen over a hard cap.
  - Not LTTB: the result preserves extremes, not visual shape. For dense noisy
    series the line looks like a band — which is what the data is.
  - Stateless: every redraw rescans the visible window (`O(window)`). There is
    no multi-resolution pyramid, so a full-range redraw of the 1M run scans 1M
    values each time.
- **Edge cases:** empty input; window outside the data; inverted range;
  windows short enough to pass through untouched; one extra point on each side
  of the window so lines reach the plot edges.
- **Tests do not catch:**
  - Unsorted input: binary search assumes ascending steps. The sanitizer
    guarantees it; calling `downsample` on raw data is undefined.
  - Performance. No test asserts a time budget.

### `chart/renderer.js` — canvas drawing

- **Why the EMA is computed on the raw series:** smoothing the decimated
  points would make the curve change shape with zoom level. It is computed
  once per `(values buffer, weight)` and cached in a `WeakMap`.
- **Why the EMA resets:** at a non-finite value or a gap, the average restarts
  from the next real value. Carrying it across would draw a confident line
  through data that does not exist.
- **Trade-offs:**
  - The y-domain is recomputed from the visible window on every draw, with 5%
    padding. Zooming therefore rescales the y-axis; it is easy to read detail,
    harder to compare heights between two zoom levels.
  - The raw line is drawn faint under a bold smoothed line. The raw data
    carries the truth but has lower contrast; the envelope and the anomaly
    markers are what make spikes stand out.
  - Markers are drawn for everything the line cannot show: `NaN`, `+∞`, `−∞`,
    `≤0` on a log scale, gaps (shaded), and flagged points (diamond).
- **Edge cases:** no plottable points (empty-state text); constant series;
  negative values (padding never clamps them to zero); the point right after a
  gap is drawn but does not seed the average — the average restarts on the
  following point.
- **Tests do not catch:**
  - Pixels. Tests use a recording stub for the 2D context: they prove which
    calls are made and that no non-finite coordinate reaches `moveTo` /
    `lineTo`, not what the result looks like.
  - Overlapping badges when several non-finite points fall on the same pixel.
  - The `dark` theme, which exists in code but is not wired into the UI.

### `chart/interaction.js` — zoom, pan, crosshair, keyboard

- **Why the crosshair reads raw arrays:** the decimated value under the
  cursor is whichever point happened to survive. The crosshair looks up the
  nearest raw point and, when a pixel covers several, also reports their count,
  min, max and combined flags — so a spike is announced even when the cursor
  lands on its quiet neighbour.
- **Why `role="application"`:** screen readers must pass arrow keys to the
  chart. The price is that the chart must describe itself, so each canvas has
  a label listing its keys and a live region with the inspected point.
- **Trade-offs:**
  - Every pointer move triggers a full redraw, including decimation. Simple
    and always consistent; not throttled to animation frames.
  - The wheel always zooms, so the page cannot be scrolled while the pointer
    is over a chart.
  - Tooltip values are printed at full precision (round-trippable), which is
    long.
- **Edge cases:** empty series; crosshair outside the view (the view pans to
  it); `[` / `]` with no anomaly in that direction (announced); minimum zoom
  span.
- **Tests do not catch:** real pointer events, `getBoundingClientRect`
  geometry, touch/pinch gestures, and actual screen-reader output. Those were
  checked by hand in a browser.

### `chart/worker-downsample.js`, `downsample.worker.js`, `benchmark.js`

- **Why:** the "after" path of the benchmark — typed arrays transferred to a
  Worker — against the "before" path of object arrays on the main thread. Both
  run the same algorithm; only representation and thread differ, and the
  harness asserts their outputs are identical.
- **Trade-offs:**
  - Inputs are **copied** before transfer so the caller's buffers are not
    detached. That costs one copy of each column per call.
  - A new Worker is created and terminated per call. Fine for a benchmark;
    interactive use would want one long-lived worker.
  - **The dashboard itself still decimates on the main thread.** The Worker
    path is proven equivalent and measured, but not wired into `renderChart`,
    because that would make rendering asynchronous and bring the race problem
    of `run-loader.js` into every pan and zoom.
  - The recorded numbers are a single run on one machine, including Worker
    start-up and the conversion cost of each path. They show direction, not a
    guarantee.
- **Edge cases:** worker errors reject the promise; missing `anomaly` column.
- **Tests do not catch:** a real thread or the Vite worker bundle. Tests use
  an in-process stand-in (`structuredClone` with transfer lists reproduces the
  detach semantics, and the truthfulness suite loads the real worker module),
  but timing and bundling were only verified by hand.

### `run-loader.js` — race guard

- **Why both a generation token and an `AbortController`:** the token is the
  correctness guarantee — a result is painted only if no newer selection
  exists. Abort is an optimisation that lets a loader stop work early; it
  cannot be relied on because a loader may ignore the signal.
- **Trade-offs:** only the latest selection can ever paint. Intermediate
  selections are dropped, not queued.
- **Edge cases:** a superseded load that later **fails** is ignored too (no
  stale error); `cancel()`; an exception thrown while painting is reported
  through `onError`.
- **In the app:** `main.js` changes the title, summary, cards and charts
  together and only on success. Until then the body is dimmed, marked
  `aria-busy`, and the indicator names both the run being loaded and the run
  still on screen.
- **Tests do not catch:** the DOM wiring in `main.js`. The controller is unit
  tested (including a reproduction of the unguarded race); that the app paints
  atomically was checked by hand. The current loader resolves immediately from
  memory, so the stale state lasts a few milliseconds in practice.

### `formatters.js` — numbers and times

- **Why one module:** `toLocaleString()` and `Date` getters depend on the
  viewer's locale and timezone, so two people would read different text from
  the same data. Everything goes through `Intl` fixed to `en-US` and `UTC`,
  and times carry a `UTC` suffix.
- **Trade-offs:**
  - Summary numbers are limited to five significant digits, so cards round
    (`1,234,567.89` → `1,234,600`). Exact values are available from the
    crosshair.
  - Axis ticks and crosshair values use `formatTickNumber`, which is **not**
    `Intl` — grouping and rounding would break the exact read-back that proof
    (d) depends on. It uses `String()` / `toExponential()`, which the language
    defines independently of locale.
- **Edge cases:** `NaN`, `+Infinity`, `-Infinity`, `null`/`undefined`
  (`Unknown`) and invalid dates all render as words — never `0`, never blank.
- **Tests do not catch:** a different OS locale is not actually simulated.
  Instead a test scans the source for locale-dependent APIs outside this
  module. A number interpolated directly into a template string would slip
  past that scan.

### `dashboard.js` and `main.js` — the UI

- **Why split:** sorting, filtering, summaries and keyboard navigation are
  pure functions in `dashboard.js` and unit tested; `main.js` is DOM glue.
- **Trade-offs:**
  - No framework. The run list is re-rendered as a string on each change; with
    20 rows this is cheap, and focus is restored explicitly afterwards.
  - All 20 runs, including the 1M-step one, are generated and sanitized
    synchronously on the main thread at start-up. The loading state is painted
    first, but the page is unresponsive while it runs.
  - The run list is a listbox with a roving tab stop: one Tab stop, arrows /
    Home / End move, Enter or Space selects. Selection does not follow focus,
    so arrowing through the list does not redraw three charts per key press.
  - Metric cards summarise finite values only and print how many values were
    non-finite next to them. The run summary shows every anomaly kind,
    including the ones with a count of zero.
- **Edge cases:** filter with no matches (empty state, and the tab stop moves
  to the first visible row when the filter changes); sort ties fall back to
  run id; a metric with no finite values shows `NaN`, not `0`.
- **Tests do not catch:**
  - `main.js` has no automated tests — there is no DOM test environment.
    Keyboard flow, focus restoration, live-region announcements and the stale
    indicator were verified by hand in a browser.
  - Contrast is tested as a list of colour pairs checked against the
    stylesheet and renderer source, not as measured pixels. A new colour that
    is not added to the list is not checked, and neither is the faint raw line.
  - No screen reader was used; ARIA roles follow the authoring patterns but
    real announcements are unverified.

### CI (`.github/workflows/ci.yml`)

- Runs `lint`, `test` and `build` on every pull request and on pushes to
  `main`, with Node pinned through `.nvmrc`.
- **Does not catch:** anything that needs a browser (no end-to-end tests), and
  there is no coverage threshold.

---

## Truthfulness proofs (`test/truthfulness.test.js`)

Each proof runs the assembled chain and takes the stage it guards as a
parameter, so it is executed with the real code (must pass) and with a
deliberately broken stand-in (must fail, with the expected message).

| Proof | Claim | Broken stand-ins that make it fail |
| --- | --- | --- |
| (a) | The 1M-point spike, and each window's min and max, survive decimation at four zoom levels — on the main thread and through the Worker module | bucket averaging; every n-th point |
| (b) | Every value leaves the sanitizer bit-identical; non-finite points survive decimation; the EMA neither smooths over nor bridges them | coercing to 0; dropping non-finite points; an EMA that carries across holes |
| (c) | Shuffled input with exact and stale duplicates gives the same columns, flags and drawing as clean sorted data | no sort; first-write-wins |
| (d) | Ticks lie inside the data bounds, labels read back as their tick, and the labels the renderer draws sit at the right pixel | ticks past the bounds; rounded labels; padded domain |

**Limit of this approach:** the stand-ins replace a whole stage; they are not
mutations of the real source. They show each proof is sensitive to the failure
it names, not that every possible bug in the real code would be caught.

---

## Likely questions

**Why not LTTB?** It optimises for visual similarity and may drop a one-point
spike. This tool exists to find such spikes, so the guarantee matters more
than the shape.

**Why keep NaN instead of interpolating?** An interpolated point is a
fabricated measurement. A missing value is information ("the logger dropped
here"); the chart shows it as a broken line with a marker.

**What happens with 10M points?** It would still be correct, but slow: the
generator and sanitizer work on object arrays, start-up is synchronous, and
each redraw rescans the window. The next steps would be to sanitize in a
Worker and to precompute a min/max pyramid so a redraw costs `O(width)`.

**Where can this still mislead?**
1. Flags come from `loss` only but appear on all three charts.
2. A sustained level shift is not flagged as an outlier.
3. The y-axis rescales on zoom, so heights are not comparable across zooms.
4. The faint raw line is easy to overlook next to the bold smoothed line.

**What is tested by hand rather than by CI?** Everything in `main.js`, real
pointer and keyboard events, the real Worker thread, and visual appearance.
