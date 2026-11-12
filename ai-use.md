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
