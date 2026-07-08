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
which Bun `1.3.13` does not implement (`ERR_NOT_IMPLEMENTED`). `bun.lock` is
kept only for local Bun/path-plugin dependency installs.

Avoid adding new runtime dependencies without maintainer review.

### Running the tests

The suite uses `node:test` with no test runner dependency. From the repo root:

```sh
node --test tests/*.test.mjs
```

`npm test` runs the same command and is also the `prepack`/`prepublishOnly`
guard. The pure decision logic lives in `loop-core.js` (no
`@opencode-ai/plugin` import), so most behavior is unit-testable without
opencode infrastructure.

Run `npm run smoke:package` separately before a release: it packs the npm
tarball, extracts it into a scratch directory, and imports the packed
`loop.js` to verify the shipped hook shape and command interception. It is
not part of `npm test`/`prepack` so that packing under `--dry-run` or
`--ignore-scripts` never spawns its own nested `npm pack`.

There is intentionally no committed `package-lock.json`; npm package consumers
should resolve this plugin through their own application lockfile. The public
CI workflow uses `npm install --ignore-scripts --no-audit --no-fund` before
`npm test`.

### Dependency license review

This package declares one runtime dependency, `@opencode-ai/plugin@^1.17.7`.
The current local install resolves the direct dependency and its transitive
runtime packages (`@opencode-ai/sdk@1.17.7`, `effect@4.0.0-beta.74`, and
`zod@4.1.8`) with `MIT` license metadata in each installed `package.json`.
Refresh that inventory from approved package metadata whenever dependency
versions change; `package.json` and `bun.lock` alone do not carry the full
transitive license record.

## Design Constraints

- Keep OpenCode imports out of `loop-core.js`; that file must remain unit
  testable under plain Node.
- Preserve the module-level loop registry singleton in `loop.js`.
- Preserve in-place `output.parts` mutation in `command.execute.before`.
- Keep test-only helpers off the returned hooks object and off module exports.
- Do not add disk persistence for loop state without an accepted design change.

See `AGENTS.md` for the load-bearing invariants and `docs/design.md` for the
mechanism rationale.
