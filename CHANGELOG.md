# Changelog

## Unreleased

- Add plugin tuple options for safety caps: `maxIterations` accepts 1–50
  (default 50), and `maxWallClockMinutes` accepts 1–1440 (default 60).
- Invalid fields now independently fall back to safe defaults with redacted
  warning diagnostics. Effective caps are immutable for each loop lifetime and
  are shown by `/loop status`.

## 0.1.1 - 2026-07-08

- Documentation-only release: README now leads with the value proposition, adds
  a "Why use loop" scenario list, promotes the `/loop` syntax table and usage
  examples to a Quick Start, and adds a worked `/loop status` example plus a
  short "For AI agents" note.
- Moved the hook reference and dependency license review to `docs/design.md`
  and test-running detail to `CONTRIBUTING.md`. No runtime changes.

## 0.1.0 - 2026-07-03

- Initial public release candidate for `@mcrescenzo/opencode-loop`.
- Adds fixed-interval and model-paced `/loop` modes for the current OpenCode session.
- Includes token-free unit tests and package smoke coverage for command registration,
  command interception, fixed re-prompting, and dynamic `schedule_wakeup`.
