# Contributing

Thanks for improving `opencode-loop`. This is a standalone OpenCode plugin
repository; contributor instructions should work from this checkout alone.

## Development Setup

1. Install dependencies with `bun install` or `npm install`.
2. Use Node 20.11 or newer for tests and package checks.
3. Run `npm test` (`node --test tests/*.test.mjs`) before opening a pull request.
4. Run `npm run smoke:package` when changing package metadata, command
   registration, plugin entrypoints, or public docs.

Do not use `bun test` as the release signal yet. OpenCode runs plugins in a Bun
runtime, but this repository's tests rely on Node's `node:test` mock timers,
which Bun `1.3.13` does not implement.

Avoid adding new runtime dependencies without maintainer review.

## Design Constraints

- Keep OpenCode imports out of `loop-core.js`; that file must remain unit
  testable under plain Node.
- Preserve the module-level loop registry singleton in `loop.js`.
- Preserve in-place `output.parts` mutation in `command.execute.before`.
- Keep test-only helpers off the returned hooks object and off module exports.
- Do not add disk persistence for loop state without an accepted design change.

See `AGENTS.md` for the load-bearing invariants and `docs/design.md` for the
mechanism rationale.
