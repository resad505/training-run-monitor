# Training-Run Monitor — TODO

Local checklist (git-ignored). Tick items as they land.

## Before any code

- [x] Decide: add 7th branch `feat/dashboard-ui` (or fold UI into `feat/canvas-engine`)
- [x] Decide: columnar `Float64Array` output from the sanitizer (Branch 2)
- [x] Decide: unit tests ship with each module; `test/truthfulness` holds only proofs a–d
- [x] Create labels: `type:*`, `priority:*`, `area:*`
- [x] Issues #8–#21 opened on GitHub (old #1–#7 closed as not planned)

## Issues

- [x] #8 Scaffold Vite + Tailwind + Vitest toolchain
- [x] #9 CI quality gate (lint, test, build)
- [ ] #10 Deterministic seeded run generator with corruption injection
- [ ] #11 Sanitizer: sort, dedupe, flag anomalies, emit columnar output
- [ ] #12 Linear and safe-log scales with truthful ticks
- [ ] #13 Extrema-preserving downsampler
- [ ] #14 Canvas renderer: broken segments, anomaly markers, smoothing envelope
- [ ] #15 Chart interaction: zoom, pan, crosshair, keyboard
- [ ] #16 Dashboard UI: run list, metric cards, loading/empty/error states
- [ ] #17 Race guards for rapid run switching, plus stale indicator
- [ ] #18 Deterministic `en-US` number and UTC time formatting
- [ ] #19 Truthfulness proof suite (a–d)
- [ ] #20 TypedArray + Worker path and Before/After benchmark harness
- [ ] #21 ARCHITECTURE.md and defense notes

## Every branch

- Start: `git checkout main && git pull && git checkout -b <branch>`
- Push `-u` after commit 1 and open a draft PR; push after each later green commit
- Pre-PR: `npm run lint`, `npm run test`, `npm run build`, `git log --oneline main..HEAD`, browser check with zero console warnings
- PR body: Closes / What changed / Trade-offs / Edge cases / What the tests do NOT catch / How I verified
- Merge with a merge commit (not squash): `gh pr merge --merge --delete-branch`
- Cleanup: `git checkout main && git pull && git branch -d <branch> && git fetch --prune`

## Branch 1 — `feat/setup` (#8, #9)

- [x] `chore(setup): scaffold vite project with pinned node version`
- [x] `chore(setup): add tailwind and base design tokens`
- [x] `chore(setup): add vitest, eslint and prettier`
- [x] `ci: run lint, test and build on pull requests`
- [ ] PR: `chore(setup): project scaffold and CI quality gate`
- [ ] Gate: clean clone passes lint, test, build; CI green; `main` protected

## Branch 2 — `feat/data-pipeline` (#10, #11)

- [ ] `feat(pipeline): add seeded prng`
- [ ] `feat(pipeline): generate 20 deterministic runs with injected corruption`
- [ ] `feat(pipeline): sanitize runs into columnar series with anomaly flags`
- [ ] PR: `feat(pipeline): deterministic generator and truthful sanitizer`
- [ ] Gate: determinism and shuffle-equivalence tests pass; 1M run generates in acceptable time

## Branch 3 — `feat/canvas-engine` (#12, #13, #14, #15)

- [ ] `feat(chart): add linear and safe log scales with tick generation`
- [ ] `feat(chart): add extrema-preserving downsampler`
- [ ] `feat(chart): render series with gap breaks, anomaly markers and envelope`
- [ ] `feat(chart): add zoom, pan, crosshair and keyboard controls`
- [ ] PR: `feat(chart): truthful canvas engine`
- [ ] Gate: spike visible at full zoom-out; no non-finite coordinate reaches `lineTo`

## Branch 4 — `feat/dashboard-ui` (#16)

- [ ] `feat(ui): add app state store and run list with sort and filter`
- [ ] `feat(ui): add metric cards and three chart panels`
- [ ] `feat(ui): add loading, empty and error states with live announcements`
- [ ] PR: `feat(ui): dashboard shell, run list and accessible states`
- [ ] Gate: whole app usable by keyboard alone

## Branch 5 — `fix/silent-failures` (#17, #18)

- [ ] `test(race): reproduce stale paint on rapid run switching`
- [ ] `fix(race): guard run loads with abort signal and generation token`
- [ ] `fix(ui): surface stale and updating state in the chart header`
- [ ] `fix(format): centralise en-US number and UTC time formatting`
- [ ] PR: `fix: eliminate run-switch races and locale drift`
- [ ] Gate: race test failed before the fix and passes after

## Branch 6 — `test/truthfulness` (#19)

- [ ] `test(truth): prove 1M spike survives decimation across zoom windows`
- [ ] `test(truth): prove non-finite values are never coerced or smoothed`
- [ ] `test(truth): prove unsorted and duplicate input normalises identically`
- [ ] `test(truth): prove tick labels match data bounds`
- [ ] PR: `test: end-to-end truthfulness proofs`
- [ ] Gate: each proof fails when the code it guards is deliberately broken

## Branch 7 — `perf/optimization` (#20, #21)

- [ ] `perf(bench): add harness with object-array main-thread baseline`
- [ ] `perf(worker): move decimation to a web worker with transferable buffers`
- [ ] `perf(bench): wire optimised path into harness and record results`
- [ ] `docs: add architecture and defense notes`
- [ ] PR: `perf: typed-array worker decimation with before/after benchmark`
- [ ] Gate: proof suite green on the worker path; 4x-throttle results recorded in README
