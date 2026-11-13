# AI Use

## Decisions

I decided to:

- Create a separate `feat/dashboard-ui` branch for the dashboard UI.
- Use columnar `Float64Array` output from the sanitizer.
- Keep unit tests next to each module and reserve `test/truthfulness` for proofs a–d.

These decisions keep the UI work separate, make large numeric datasets more efficient, and keep the test structure clear.

## Issue 9: CI Quality Gate

I reviewed, understood, and accepted the CI workflow and quality gate setup:

- Implemented GitHub Actions CI workflow in `.github/workflows/ci.yml` running on both `pull_request` and `push` to `main`.
- Pinned Node.js to version `22.12.0` via `.nvmrc` and cached npm dependencies to guarantee deterministic builds.
- Enforced automated verification pipeline: clean dependency installation (`npm ci`), linting (`npm run lint`), testing (`npm run test`), and production build (`npm run build`).
- Configured branch protection on `main` requiring passing CI checks prior to merging.

I understand and accept that this quality gate prevents broken or red commits from reaching the `main` branch.

## Tools, and where each was used

Taken from the `Co-Authored-By` trailers in the commit history, so it can be
checked with `git log`.

| Stage | Tool | What it produced |
| --- | --- | --- |
| Setup, CI (#22) | Claude Haiku 5.5 | Housekeeping commit; the scaffold and workflow are described above |
| Data pipeline (#23), chart engine (#24) | Claude Opus 5.5 | Review-driven fix commits: trend-relative outliers, plateau flags, truthful line breaks, raw-series EMA |
| Dashboard, race guard, formatting, first proofs, worker benchmark (#25–#29) | GitHub Copilot (plus Claude Sonnet 5.5 on #27) | First implementation of each issue |
| Audit, controls, deployment, performance, notes (#30–#32) | Claude Code (Claude Fable 5.2) | See below |

## How I worked

- I wrote the plan first: issues #8–#21, each with acceptance criteria and the
  scoring area it defends, one branch per area, a pull request per branch, CI
  required before merge.
- The acceptance criteria were the contract. AI output was accepted when it
  met them, not when it looked finished.
- For the last stage I asked Claude Code to audit the repository against the
  open issues and then against the task brief, instead of asking it to "finish
  the project". Each step ended with a question to me; I chose what happened
  next and approved every merge.

## Where the tools were unreliable, and how it was caught

1. **"Done" that was not done.** PRs #25–#29 implemented issues #16–#20, and
   the local checklist marked them complete. The audit against the acceptance
   criteria found otherwise: selecting a run dropped keyboard focus; metric
   cards left non-finite points out of their counts; the title switched to
   the new run while the old run's data was still underneath; and nothing
   showed that a truthfulness proof would fail on broken code. Fixed in #30.
2. **Bugs that passed every test.** The crosshair reported a point offset
   from the cursor (canvas drawn at the wrong width), and drag-pan compounded
   and outran the pointer. Both were in AI-written code with green tests; they
   were found by checking the page, not the suite.
3. **A confident false statement.** While writing the architecture notes the
   tool stated that the dataset contains no finite value ≤ 0. A one-line
   check found 62. The sentence was removed and the log-axis behaviour was
   then verified on real data (run 14).
4. **An optimisation assumed to help.** Moving generation to a Web Worker was
   expected to lower memory. Measured, steady-state memory went **up** by
   about 175 MB. The result is reported as it is, with the cause marked
   unconfirmed.
5. **A measurement that could not be trusted.** The first timings were taken
   in an embedded browser pane that was not rendering frames. They were
   discarded and replaced by `scripts/measure.mjs`, which drives headless
   Chrome with CPU throttling and writes a trace.

## What I accepted, changed or rejected

- **Accepted:** the fixes in #30; proofs that must fail against a broken
  stand-in; y-scale and smoothing controls (#31); worker-built dataset, reuse
  of unchanged decimation and coalesced redraws (#32).
- **Changed:** the tool set up a GitHub Pages workflow; I chose Vercel
  instead and the workflow was removed.
- **Not adopted:** running decimation in the worker on every redraw (it makes
  rendering asynchronous and brings the run-switch race into every pan and
  zoom); a min/max pyramid for zoom (deferred, listed as the next change).

## What was verified, and how

Checks in the last stage were run by the tool at my request; their outputs
are in the repository rather than in my memory.

- 275 automated tests, including each proof run against deliberately broken
  implementations: [docs/test-output.txt](docs/test-output.txt).
- Performance before and after from one script, with traces: `perf/`.
- Keyboard flow, stale indicator, crosshair accuracy and the log axis were
  exercised in a browser against the running app.
- CI passed on every pull request before merge; the harness was run once
  against the live deployment after the last merge.
- [NOTE.md](NOTE.md) was drafted with Claude Code from the results in this
  repository.

## What AI did not do

It did not see the screen the way a person does: no automated check looks at
rendered pixels, and no screen reader was used. Those limits are listed in
[ARCHITECTURE.md](ARCHITECTURE.md) under "what the tests do not catch".
