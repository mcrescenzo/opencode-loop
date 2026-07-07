# Release Smoke

The default test suite stays token-free:

```sh
npm test
```

Use Node 20.11 or newer for this suite. Do not use `bun test` as a release signal
until Bun implements the `node:test` mock-timer APIs used by the timer and
double-instantiation tests.

## Token-Free Package Smoke

Run this before release:

```sh
node scripts/package-smoke.mjs
```

The script packs the npm tarball, extracts it into a temporary package install,
loads the packed `loop.js`, and verifies:

- the tarball contains only the expected runtime files;
- the module exports exactly `LoopPlugin`;
- the returned hook shape matches OpenCode plugin expectations;
- the config hook registers the bundled `/loop` command;
- `command.execute.before` mutates `output.parts` in place;
- fixed-mode re-prompt dispatch reaches `client.session.promptAsync`;
- dynamic mode exposes and records `schedule_wakeup`.

This is a package smoke, not a model-backed OpenCode runtime smoke.

## Live OpenCode Smoke

Run this manually from a scratch project before publishing or flipping the repo
public:

```sh
npm pack
mkdir -p /tmp/opencode-loop-live-smoke
cd /tmp/opencode-loop-live-smoke
npm init -y
npm install /path/to/mcrescenzo-opencode-loop-0.1.0.tgz
cat > opencode.json <<'JSON'
{
  "plugin": ["@mcrescenzo/opencode-loop"]
}
JSON
opencode .
```

In the fresh OpenCode session:

1. Run `/loop status`; it should report no active loop without needing a model turn.
2. Run `/loop 60s reply with the current time in one short sentence`; after the
   turn goes idle, confirm one re-injection, then run `/loop stop`.
3. Run `/loop count from 1, one number per turn, and stop at 3`; confirm the
   model calls `schedule_wakeup` between turns and stops cleanly.
4. Confirm the `/loop` command appears with the bundled command description.
5. Stop OpenCode and confirm no child process or scratch runtime remains.

## Current Evidence

Recorded on 2026-07-03 in this checkout:

- `opencode --version` -> `1.17.13`.
- `npm pack --dry-run --json` -> 11 package files:
  `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `LICENSE`,
  `README.md`, `SECURITY.md`, `commands/loop.md`, `diagnostics.js`,
  `loop-core.js`, `loop.js`, `package.json`.
- `node scripts/package-smoke.mjs` -> pass, including packed-file,
  single-export, hook-shape, config-registration, command-interception,
  foreign-command non-interception, fixed-reprompt, and dynamic
  `schedule_wakeup` checks.
- `node --test tests/*.test.mjs` -> pass.
- `bun --version` -> `1.3.13`; `bun test tests/*.test.mjs` -> expected fail on
  eight timer/mock-timer tests with `ERR_NOT_IMPLEMENTED`.

The live OpenCode smoke was not run in this automated pass because fixed and
dynamic loop validation can create model turns and use provider credentials. The
manual smoke above is the release gate for visible-session `promptAsync`
reinjection and real model use of `schedule_wakeup`.

## Residual Risks

- The GitHub visibility flip and npm publish were not performed by these checks.
- Live model-backed OpenCode smoke remains manual/provider-gated; the token-free
  package smoke verifies package loading and hook behavior but does not spend
  model tokens.
- `bun test` is not a supported validation signal until Bun implements the
  `node:test` mock-timer APIs used by this suite.
