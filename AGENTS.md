# Loop Plugin Notes

**Contract version:** `@opencode-ai/plugin@1.17.7` (declared range: `^1.17.7`)
**Verified against runtime:** opencode 1.17.13

- This repository is an independent local OpenCode plugin repo; keep it standalone and commit plugin code and tests here.
- `loop.js` is the entry file that wires opencode hooks (`config`, `event`, `command.execute.before`, `tool`, `dispose`); `loop-core.js` holds the pure, opencode-free decision logic (`parseLoopArgs`, `createRegistry`, `decideNextAction`, `buildIterationPrompt`, …). Keep `@opencode-ai/plugin` usage out of `loop-core.js` so the logic stays unit-testable under plain `node --test`.
- User-facing `/loop` docs live in the bundled `commands/loop.md` inside this plugin (self-registered via the `config` hook). After changing this plugin or its OpenCode registration, restart OpenCode — running sessions keep already-loaded plugin code.
- Run the suite from this directory: `node --test tests/*.test.mjs`.
- The mechanism uses idle-driven `client.session.promptAsync(...)` re-injection into the user's own visible session, bounded by a per-fire generation guard. Full rationale: [docs/design.md](docs/design.md); the live verification that the four unknowns hold (and the two bugs that produced invariants 2 and 3 below): [docs/spike-results.md](docs/spike-results.md).
- Loop state is in-memory and ephemeral by design: an opencode process restart ends active loops with no respawn. Do not add disk persistence without a design decision.

## Invariants — do not violate

These are hard guardrails for any agent editing this plugin. Treat a
violation as a failing change. Each one is load-bearing — removing it
reintroduces a bug that was actually observed on a live session (see
[docs/spike-results.md](docs/spike-results.md)).

1. **The loop registry is a single module-level singleton — never a
   factory-closure variable.** The registry lives at module scope in `loop.js`
   (`const registry = createRegistry();`, defined *outside* `LoopPlugin`), so
   every instantiation of the factory shares one `Map<sessionID, LoopState>`.
   *Rationale:* opencode invokes plugin hooks roughly twice per occurrence and
   may instantiate the factory more than once (spike finding B — every `event`,
   `command.execute.before`, and toast was observed logging twice in a single
   process). A per-factory-closure registry would be two competing registries
   under double-instantiation, and the doubled `/loop` command and doubled
   `session.idle` events would spawn two competing loops that double-fire every
   iteration. One module-level registry is the single source of truth.

2. **Doubled events must be absorbed by the `awaitingIdle` + `generation`
   dedup; never assume one event per turn.** Because the plugin's own
   `promptAsync` call produces a real new turn whose `session.idle` the plugin
   *also* receives (spike finding 2 — re-injection fired two further idles), and
   because hooks fire twice per occurrence (finding B), the idle handler must be
   idempotent per generation. Every fire calls `bumpGeneration(state)` and sets
   `awaitingIdle = true`; `scheduleNextFire` clears `awaitingIdle` so the second
   idle for that generation is ignored (`decideNextAction` returns `ignore` when
   `!state.awaitingIdle`), and the armed `setTimeout` re-checks
   `s.generation === armedGen` before firing. This generation guard is
   load-bearing from day one — do not weaken it, and do not act on an idle event
   without checking it.

3. **In `command.execute.before`, mutate `output.parts` IN PLACE (splice) —
   never reassign.** Use the `replaceParts` helper
   (`output.parts.splice(0, output.parts.length, ...parts)`). *Rationale:* opencode holds a reference to the
   original `output.parts` array, so `output.parts = [...]` (reassignment) is
   silently dropped and the model receives the raw `commands/loop.md` body
   instead of the iteration prompt. This was spike finding A: the probe's
   reassignment caused exactly this failure on a live run.

4. **No test-only helpers as plugin hooks or extra module exports — they ride on
   out-of-band `__innerTest` / `__moduleTest` properties.** opencode boots *every*
   exported function in a plugin module as a plugin factory
   (`Object.values(module)`), so the module must export **exactly one** factory
   (`LoopPlugin`). Exporting a test helper (e.g. `__resetRegistryForTests`) as a
   second module export made opencode call it as a plugin factory; it returned
   `undefined` and crashed `PluginBoot` with
   `"undefined is not an object (evaluating 'N.event')"`. Likewise, test
   internals must not be added as named keys on the returned `hooks` object that
   opencode would treat as lifecycle hooks. Instead, test surface attaches to
   properties opencode ignores: instance internals on `LoopPlugin.__innerTest`
   (`{ registry, fireNextIteration, scheduleNextFire, applyAction, armTimer, DEFAULT_CAPS }`)
   and module helpers on `LoopPlugin.__moduleTest`
   (`{ normalizeEvent, isIdleEvent, getSessionID, statusText, __resetRegistryForTests }`).
   Because the registry is a module-level singleton (invariant 1), tests must
   clear it between cases via `__resetRegistryForTests` in a `beforeEach`.
