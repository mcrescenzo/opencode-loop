# `/loop` plugin — design spec

- **Date:** 2026-06-19
- **Status:** Implemented v1 design; historical notes preserved where marked deferred
- **Author:** Michael Crescenzo (with Claude)

## 1. Goal

Add an opencode plugin exposing a `/loop` slash command that replicates
Claude Code's `/loop`: it re-prompts **the user's current session** on a cadence, carrying
conversation context forward, until the user stops it or a safety cap trips.

Two cadence modes:
- **Fixed-interval** — `/loop 5m <prompt>` fires on a wall-clock cadence.
- **Dynamic self-pacing** — `/loop <prompt>` where the model decides when (and whether) to
  continue, a faithful port of Claude's `ScheduleWakeup`.

## 2. Scope

**In scope**
- Drive the user's own visible session via `client.session.promptAsync(...)` keyed off
  `session.idle`.
- Both modes above.
- `/loop stop` and `/loop status` control.
- Safety: recursion guard, permission/error pause, and hard iteration + wall-clock caps.

**Out of scope** (explicitly deferred)
- `/schedule`-style cloud/cron agents.
- Background/child-session looping (the loop runs in the user's own session only).
- Re-running slash commands. V1 re-injects literal prompt text; leading-slash command
  execution remains spike-gated until live OpenCode evidence proves support.
- Start-time `doom_loop:'ask'` enforcement. No plugin-facing enforcement API was found
  for `command.execute.before`; explicit `/loop` invocation is treated as consent and
  hard caps remain the enforced safety net.
- Surviving an opencode **process restart** — loop state is in-memory and ephemeral by
  decision; a restart ends active loops with no respawn.

## 3. Confirmed decisions

| Fork | Decision |
|---|---|
| Which session does the loop drive? | The **user's own visible session** (Claude-style). |
| Cadence modes | **Both** fixed-interval and dynamic self-pacing. |
| Restart survival | **No** — in-memory, ephemeral. |

## 4. How opencode makes this possible (grounding)

- A plugin is an ES-module factory `(ctx) => Promise<Hooks>` whose returned hooks stay
  **resident** for the process lifetime, so host-side `setTimeout`/`setInterval` keep firing
  across turns. OpenCode may instantiate the factory more than once in a process; module-level
  state is required to absorb duplicate factories/hooks. There is **no native scheduler/cron/wakeup**
  in the SDK.
- `ctx.client` is the full opencode REST facade.
  `client.session.promptAsync({ path:{id: sessionID}, query:{directory}, body:{ parts:[...] } })`
  injects a fresh user turn into **any** session, including the user's own.
- The `event` hook is an async fan-out of every server SSE event. Turn completion arrives as
  `session.idle` (and/or `session.status` with `properties.status.type === 'idle'`); there is
  no `turn.complete` event. Session IDs sit at varying event paths, so a `getSessionID(event)`
  normalizer is required.
- A plugin owns a slash command via the `command.execute.before` hook, rewriting
  `output.parts`. `config` registers the bundled `/loop` command.
- Historical note: an earlier local configuration defined a `doom_loop:'ask'` permission
  intended to gate looping, but v1 does not implement that start gate because no
  plugin-facing command-hook enforcement API was identified.

The `/loop` plugin combines idle-driven re-prompting of the user's own session, a generation
counter to cancel stale continuations, self-pacing delay, permission/error pausing,
argument parsing, stop conditions, and a `schedule_wakeup` tool.

## 5. Architecture & components

A single resident plugin, `loop.js`, wiring small **isolated, unit-testable
units**. The decision logic is pure functions over state + an injected clock, so the live
opencode surface is a thin shell.

| Unit | Responsibility | Isolation |
|---|---|---|
| `parseLoopArgs(argString)` | `[interval] <prompt>` and subcommands `stop`/`status` → structured intent. | pure |
| `resolveLoopCaps(options)` | Validates plugin tuple options independently and returns immutable effective caps plus redacted warnings. | pure |
| `loopRegistry` | In-memory `Map<sessionID, LoopState>`; `start`/`stop`/`get`; generation bump. | pure |
| `decideNextAction(state, event, now)` | The brain: state + idle/permission/error event + clock → an Action. | pure (fake clock) |
| `buildIterationPrompt(state)` | Builds the text to re-fire; appends the dynamic-mode control block. | pure |
| `fireNextIteration(sessionID)` | Factory-local shell over `client.session.promptAsync(...)`; bumps generation and dispatches the next prompt. | shell |
| `scheduleNextFire(sessionID, delayMs)` / `armTimer(...)` | Timer shell that consumes an idle event, arms a guarded wakeup, and re-checks generation/wall-clock state before firing. | shell |
| `schedule_wakeup` tool | LLM tool; records the model's requested `delaySeconds` into the active loop's current generation. | pure record fn |
| plugin entry | Wires `config`, `command.execute.before`, `event`, `tool`, and cleanup. | live |

**Data flow:** `/loop …` → `command.execute.before` → `parseLoopArgs` → `loopRegistry.start`
→ rewrite `output.parts` to iteration 1's prompt (the command's own turn **is** iteration 1).
Then each `session.idle` → `decideNextAction` → either `scheduleNextFire` + `fireNextIteration`
(next generation) or terminate. `schedule_wakeup` writes `pendingWakeup`; the idle handler reads it.

### 5.1 LoopState

```
{
  sessionID:    string,
  mode:         'fixed' | 'dynamic',
  loopPrompt:   string,          // prompt text (or resolved command text) to re-fire
  intervalMs:   number | null,   // fixed mode only
  generation:   number,          // bumped each fire; recursion/staleness guard
  awaitingIdle: boolean,         // true after a fire until that iteration's idle is consumed
  iterationCount: number,
  startedAt:    number,          // ms epoch (injected clock)
  lastFireAt:   number | null,
  status:       'running' | 'paused' | 'stopped',
  pauseReason:  'permission' | 'error' | null,
  pendingWakeup: { delaySeconds: number, generation: number } | null,  // dynamic mode
  timer:        TimerHandle | null,  // active setTimeout handle, for cleanup
  timerDueAt:   number | null,       // ms epoch for re-arming after permission pause
  pausedTimer:  { delayMs: number, generation: number } | null,
  caps:         { maxIterations: number, maxWallClockMs: number },
}
```

### 5.2 `decideNextAction` outcomes

- `{ kind: 'ignore' }` — not our session, wrong/stale generation, duplicate idle, or paused.
- `{ kind: 'schedule', delayMs }` — wait `delayMs`, then fire the next generation.
  - fixed: `delayMs = max(0, intervalMs − (now − lastFireAt))` (idle-gated → never stacks).
  - dynamic: `delayMs = clamp(pendingWakeup.delaySeconds, 60, 3600) * 1000`.
  - schedules that would fire at or beyond the wall-clock cap terminate instead.
- `{ kind: 'terminate', reason }` — `reason ∈ { completed, max-iterations, max-wallclock, stopped }`.
  - dynamic + no `pendingWakeup` for the current generation ⇒ `completed` (model chose to stop).
- `{ kind: 'pause', reason }` — `permission` or `error`.

Caps are resolved once per plugin instance and copied into an immutable snapshot
when a loop starts. They are checked before scheduling and before timer-triggered prompt injection:
`iterationCount ≥ maxIterations` → `max-iterations`; `now − startedAt ≥ maxWallClockMs`
or a candidate delay crossing that deadline → `max-wallclock`.

## 6. The two modes (exact behavior)

**Command grammar**
```
/loop 30s check the build       → fixed-interval, plain prompt
/loop keep triaging until empty → dynamic (no leading interval token)
/loop stop      |  /loop status → control
```
Interval = the first whitespace token matching `^\d+(s|m|h)$` **with** more text after it;
otherwise the whole argument string is a dynamic prompt.

**Fixed-interval.** Idle-gated: on each iteration's idle, wait `max(0, intervalMs − elapsed)`,
then fire the next generation. Never fires while busy, never stacks ⇒ **"at least N"**
semantics (matches Claude). Runs until `/loop stop`, rejected permission, prompt dispatch
failure, session teardown, or a safety cap; `session.error` pauses instead of stopping. The model
is **not** consulted about continuation. `schedule_wakeup` is a no-op in fixed mode.

**Dynamic self-pacing.** Faithful `ScheduleWakeup` port. `buildIterationPrompt` appends a short
control block teaching the contract: *"To continue the loop, call `schedule_wakeup({delaySeconds})`
(60–3600s). To end the loop, simply don't call it."* On idle: if `pendingWakeup` is set for the
current generation → schedule after the clamped delay, then fire; otherwise → **terminate
(`completed`)**. Termination is a clean model decision (absence of a tool call), exactly like
Claude.

## 7. Lifecycle, control & safety

- **Recursion guard (the #1 risk).** Every fire bumps `generation`; the idle handler acts on
  the awaited generation **once** (deduping `session.idle` vs `session.status{idle}`). Because
  the plugin's own `promptAsync` produces turns whose idle events it also receives, this guard
  is mandatory from day one.
- **Strict session keying.** The `event` hook sees all sessions; state is keyed by originating
  `sessionID` so a loop never injects into an unrelated session.
- **Pause / resume.** On permission asked/update events or `session.error` for the loop session
  → pause (no firing); resume on permission reply. If a timer was already armed, permission
  resume re-arms that consumed-idle wakeup instead of resetting `awaitingIdle`. Prevents
  spamming a blocked session without weakening duplicate-idle deduplication.
- **Hard caps.** Defaults: **`maxIterations = 50`** and
  **`maxWallClockMs = 60 min`**. Plugin tuple options accept positive integer
  `maxIterations` values from 1–50 and `maxWallClockMinutes` values from 1–1440.
  Invalid fields independently fall back to their default and emit a warning
  diagnostic without retaining or recording the rejected value. Each loop keeps
  its start-time cap snapshot for its lifetime. On hit: terminate + notify.
- **Wall-clock semantics.** Permission pauses continue counting against elapsed
  wall time. A longer cap permits longer loops but does not guarantee 50
  iterations; completion, errors, rejected permissions, restart/session closure,
  or manual stop can terminate earlier.
- **Control.** `/loop stop` (clears timers, sets `stopped`); `/loop status` (mode, iteration
  count, elapsed). `stop`/`status` are handled in-plugin and short-circuit
  the model.
- **Cleanup.** Session teardown events remove that session's loop state and clear any timer.
  Plugin-instance `dispose` clears the module-level singleton only after the final live hooks
  object is disposed, because OpenCode may instantiate the factory more than once.

## 8. Risks & the required spike (verify before full build)

The design rests on host idle/re-prompt behavior, but four points are **assumptions until proven
on a live session**. The plan leads with a thin smoke spike to verify them before building out:

1. `event`/`session.idle` is delivered reliably for the user's primary session across **all
   agents** (not just `build`).
2. `promptAsync`-injected turns emit idle events the plugin sees — i.e. the recursion guard is
   **necessary and sufficient**, and iteration↔idle correlation is reliable (no double-fire, no
   missed termination).
3. Bun `setTimeout`/`setInterval` accuracy and survival across turns for multi-minute intervals.
4. A custom tool's requested delay can drive a host wakeup (the `schedule_wakeup` round-trip),
   given there is no native scheduler to lean on.

If any fail, adjust the mechanism before committing to the full build.

**Other risks**
- Idle-event ambiguity (no `turn.complete`; IDs at varying paths) → normalize + dedupe.
- Fixed-interval drift: Bun timer accuracy unverified; an iteration longer than the interval
  makes `5m` mean "at least 5m" (accepted semantics).
- Cross-session leakage if keyed wrong → strict `sessionID` keying (above).
- Cleanup: session teardown is the per-session fallback path; `dispose` is process/plugin-instance
  cleanup and is guarded for duplicate factory instantiation.

## 9. Testing

`node --test tests/*.test.mjs` runs four suites:
- `loop-core.test.mjs` covers parsing, registry behavior, decision tables, prompt building,
  sanitization, status text, clocks, and `schedule_wakeup` delay clamping.
- `loop-plugin.test.mjs` covers the live hook shell: singleton registry behavior across double
  instantiation, event/timer handling, diagnostics, command interception, stop/status paths, and
  the `schedule_wakeup` tool wrapper.
- `command-registration.test.mjs` covers bundled command parsing/registration and graceful
  degradation when command docs or diagnostics are unavailable.
- `publish-metadata.test.mjs` covers package metadata and public package file inclusion.

The pure-function split (decision logic vs live client/event bus, with an injected clock) is
what makes these real unit tests rather than mocks of everything.

## 10. Placement & rollout

- Plugin entrypoint: `loop.js`; command docs: `commands/loop.md`; tests:
  `tests/*.test.mjs`.
- After it lands, **restart opencode** — running sessions keep old config (per AGENTS.md).
- Configure caps through the plugin tuple, for example
  `["./plugins/loop/loop.js", { "maxIterations": 50, "maxWallClockMinutes": 1440 }]`.
  Restart after option changes; already active loops retain their start-time cap snapshot.
- Surgical changes per AGENTS.md; no unrelated refactoring.

## Appendix A: Hook reference

`loop.js` registers five opencode plugin hooks:

| Hook | Purpose |
|---|---|
| `config` | Registers the bundled `/loop` command (`commands/loop.md`) if no other plugin or user command already owns it. |
| `event` | Watches for the session going idle (or a permission prompt being asked/answered/rejected) to drive the next iteration, pause, or stop of an active loop. |
| `command.execute.before` | Intercepts `/loop ...` invocations owned by this plugin, parses the arguments, and rewrites the command output into the fixed-interval or dynamic loop prompt. |
| `tool` | Exposes the `schedule_wakeup` tool that dynamic-mode loops call to request the next iteration. |
| `dispose` | Clears this plugin instance's timers and runtime registration when the instance is torn down. |

## Appendix B: Dependency license review

This package declares one runtime dependency, `@opencode-ai/plugin@^1.17.7`.
The current local install resolves the direct dependency and its transitive
runtime packages (`@opencode-ai/sdk@1.17.7`, `effect@4.0.0-beta.74`, and
`zod@4.1.8`) with `MIT` license metadata in each installed `package.json`.
Refresh that inventory from approved package metadata whenever dependency
versions change; `package.json` and `bun.lock` alone do not carry the full
transitive license record.

## 11. Open / deferred items

- Whether injected leading-slash text executes as an OpenCode command — unsupported in v1
  until package-installed/live smoke evidence proves it.
- `doom_loop:'ask'` start-time permission enforcement — unsupported in v1 until a
  command-hook enforcement API is identified.
- Whether a manual user message mid-loop should auto-pause the loop — deferred; `/loop stop` is
  the explicit control for v1.
- Restart durability (disk-persisted descriptors + startup re-arm) — explicitly out of scope.
