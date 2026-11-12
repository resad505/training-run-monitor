# AI Use

## Decisions

I decided to:

- Create a separate `feat/dashboard-ui` branch for the dashboard UI.
- Use columnar `Float64Array` output from the sanitizer.
- Keep unit tests next to each module and reserve `test/truthfulness` for proofs a–d.

These decisions keep the UI work separate, make large numeric datasets more efficient, and keep the test structure clear.
