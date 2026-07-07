# loop

An unofficial opencode plugin that re-runs a prompt in **your own session** on a
recurring interval, or at a cadence the model paces itself — until you stop it.
It drives the current session by re-injecting prompt text each time the session
goes idle, carrying the conversation context forward.

This project is a community plugin and is not affiliated with or endorsed by
opencode.ai.

The loop is **in-memory only**: closing or restarting opencode ends every active
loop with no respawn.

## Installation / registration

The plugin is a self-contained ESM module whose entry file is `loop.js`. Register
it in your `opencode.json` under the singular `"plugin"` key.

For a local clone or copied checkout, register `loop.js` by an absolute path or
by a path relative to the `opencode.json` file that declares it:

```json
{
  "plugin": [
    "/path/to/opencode-loop/loop.js"
  ]
}
```

For the npm package, install it where opencode resolves plugins and register the
package name:

```json
{
  "plugin": [
    "@mcrescenzo/opencode-loop"
  ]
}
```

The `"plugin"` value is an array, so add the entry alongside any other plugins
you already register. After registering or changing the plugin, **restart
opencode** — running sessions keep already-loaded plugin code.

Register this plugin once. Do not load both a path copy and the published
package in the same opencode config. If another plugin or user command already
owns `/loop`, this plugin leaves that command definition and execution alone.

This package requires Node 20.11 or newer for its local test/package scripts. The
runtime plugin dependency is `@opencode-ai/plugin@^1.17.7`; the current release
candidate was smoke-tested against opencode `1.17.13`. opencode does not install
dependencies for path-spec plugins, so run `bun install` or `npm install` in this
directory before using a path registration during development.

## Hooks

`loop.js` registers five opencode plugin hooks:

| Hook | Purpose |
|---|---|
| `config` | Registers the bundled `/loop` command (`commands/loop.md`) if no other plugin or user command already owns it. |
| `event` | Watches for the session going idle (or a permission prompt being asked/answered/rejected) to drive the next iteration, pause, or stop of an active loop. |
| `command.execute.before` | Intercepts `/loop ...` invocations owned by this plugin, parses the arguments, and rewrites the command output into the fixed-interval or dynamic loop prompt. |
| `tool` | Exposes the `schedule_wakeup` tool that dynamic-mode loops call to request the next iteration. |
| `dispose` | Clears this plugin instance's timers and runtime registration when the instance is torn down. |

### Dependency license review

This package declares one runtime dependency, `@opencode-ai/plugin@^1.17.7`.
The current local install resolves the direct dependency and its transitive
runtime packages (`@opencode-ai/sdk@1.17.7`, `effect@4.0.0-beta.74`, and
`zod@4.1.8`) with `MIT` license metadata in each installed `package.json`.
Refresh that inventory from approved package metadata whenever dependency
versions change; `package.json` and `bun.lock` alone do not carry the full
transitive license record.

## Running the tests

The suite uses `node:test` with no test runner dependency. From this directory:

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

Use Node, not `bun test`, for validation. The plugin runs inside opencode's Bun
runtime, but this repository's test suite targets Node's `node:test` mock-timer
APIs; Bun `1.3.13` currently fails those timer tests with
`ERR_NOT_IMPLEMENTED`. `bun.lock` is kept for local Bun/path-plugin dependency
installs. There is intentionally no committed `package-lock.json`; npm package
consumers should resolve this plugin through their own application lockfile, and
the public CI workflow uses `npm install --ignore-scripts --no-audit --no-fund`
before `npm test`.

## `/loop` command syntax

| Form | Behavior |
|---|---|
| `/loop <interval> <prompt>` | **Fixed-interval.** `<interval>` is `<n>s\|m\|h` (e.g. `5m`), clamped to 5s–24h and rejected when it cannot fit within the 60-minute loop time limit. Idle-gated: the next iteration fires at least `<interval>` after the previous one finishes, so an overrun delays rather than stacks. |
| `/loop <prompt>` | **Dynamic / self-pacing.** Each iteration may call the `schedule_wakeup` tool with `delaySeconds` (clamped to 60–3600) to continue. Finishing a turn **without** calling `schedule_wakeup` ends the loop. |
| `/loop status` | Show the active loop: mode, iteration count, and elapsed time. Alias: `info`. |
| `/loop stop` | Stop the active loop. Aliases: `off`, `cancel`, `clear`, `end`. |

Examples:

```text
/loop 5m run the test suite and report any failures
/loop keep refactoring this module until it is clean, then stop
/loop status
/loop stop
```

Looped content is re-injected as prompt text. Re-running slash commands such as
`/loop 5m /some-command` is not part of the v1 support contract unless a future
opencode smoke test proves that injected leading-slash text executes as a
command.

### Safety

- A loop stops automatically after **50 iterations** or **60 minutes**.
  The time cap is enforced before scheduling or injecting the next iteration.
- It **pauses** while a permission prompt is open and **resumes** when the prompt
  is answered; a **rejected** permission ends the loop.
- Closing or deleting a session clears that session's in-memory loop state.
- If a running iteration reports `session.error`, the loop pauses and stays
  paused until you run `/loop stop` (an error-pause is sticky). If the plugin
  cannot dispatch the next prompt through opencode, it stops that loop instead
  and emits a diagnostic record.
- The loop drives the current session, carrying conversation context forward.

## Diagnostics environment variables

The plugin writes local structured JSONL diagnostic records
(`opencode.plugin.diagnostic.v1`). Records are generated by this plugin only and
are not uploaded by the plugin. The redaction heuristics are adapted from the
author's local opencode diagnostics tooling and are kept self-contained in this
package. Default storage root:

```text
Linux:   ${XDG_STATE_HOME:-~/.local/state}/opencode/plugin-diagnostics/<project>-<hash>/loop/
macOS:   ~/Library/Application Support/opencode/plugin-diagnostics/<project>-<hash>/loop/
Windows: %LOCALAPPDATA%\opencode\plugin-diagnostics\<project>-<hash>\loop\
```

- `OPENCODE_PLUGIN_DIAGNOSTICS_DIR` — override the diagnostics root directory
  with an absolute path or `~` path (useful for tests or local debugging).
- `OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED=1` — disable diagnostics writes entirely.

Diagnostic files are named `loop-YYYY-MM-DD-<pid>.jsonl` and rotate before they
exceed roughly 1 MB.

## Support

This is a community plugin, not an official opencode feature. Report bugs and
compatibility issues at
<https://github.com/mcrescenzo/opencode-loop/issues>. Public compatibility is
limited to the versions documented above until newer opencode/plugin versions
are tested.

To uninstall, remove `@mcrescenzo/opencode-loop` or the local `loop.js` path
from the `plugin` array in `opencode.json`, then restart opencode. Existing
loops are in-memory only, so restart also clears any active loop state.

Contributor-facing design rationale and invariants live in the repository:
<https://github.com/mcrescenzo/opencode-loop/blob/main/AGENTS.md> and
<https://github.com/mcrescenzo/opencode-loop/blob/main/docs/design.md>.
Security and contribution guidance live at
<https://github.com/mcrescenzo/opencode-loop/blob/main/SECURITY.md> and
<https://github.com/mcrescenzo/opencode-loop/blob/main/CONTRIBUTING.md>.
