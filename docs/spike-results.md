# `/loop` spike results

Pre-build verification of the unknowns from `design.md` §8, plus two bugs the live run surfaced.
Run on 2026-06-19 against the live opencode (session `ses_11ff101bfffemc3c0YvzMznYbX`, agent `build`).

| # | Unknown | Method | Result | Verdict |
|---|---------|--------|--------|---------|
| 1 | `session.idle` delivered for the user's own primary session | `/probe` live; `.probe-events.log` | 3 distinct `session.idle` fired for the originating session | ✅ go |
| 2 | A `promptAsync`-injected turn itself emits a further idle (→ recursion guard required) | `/probe` re-injected once; watched for later idles | Re-injection produced a real new turn (`pong2`); **2 more `session.idle` fired afterward** | ✅ go — guard is load-bearing |
| 3 | `setTimeout` accuracy for multi-minute intervals | `node scripts/timer-accuracy.mjs` | 60s target → 60059ms, **59ms drift** | ✅ go |
| 4 | A custom tool's argument reaches host code | not exercised live | confirmed by precedent: other local opencode plugins have working custom tools with the same `tool({args, execute})` shape | ✅ go (by precedent) |
| 5 | A leading `/command` re-executes when injected via `promptAsync` | not tested | — | deferred (command-looping stays spike-gated; v1 loops plain text) |

## Two bugs the live run caught

**A. `command.execute.before` must mutate `output.parts` IN PLACE.**
In the probe run the model received the raw `commands/probe.md` body, not the probe's rewritten
text. Cause: the probe did `output.parts = [...]` (reassignment), which opencode does not pick up —
it holds a reference to the original array. The fix mutates in place:
`output.parts.splice(0, output.parts.length, ...parts)`. The opencode agent independently diagnosed
this and patched the probe to use a display echo plus in-place splice.
→ **Plan Task 6 corrected** to use in-place splice + `displayPart`.

**B. Plugin hooks fire twice per occurrence.**
Every `event`, `command.execute.before`, and toast is logged twice within a single process
(all pre-child, so not the child server). Whether double-instantiation or double-invocation, the
safe pattern is **module-level shared state**. The probe's module-level `probeState`
re-injected only ONCE despite the doubled idle
events. A per-factory-closure registry would be two registries under double-instantiation and would
double-fire iterations.
→ **Plan Task 5 corrected**: the registry moves to module scope; the existing `awaitingIdle`/
generation dedup already absorbs doubled idle events (2nd idle for a generation → ignored).

## Go / no-go

**GO**, with bugs A and B folded into the plan. The core mechanism — idle-driven `promptAsync`
re-injection into the user's own visible session, bounded by a generation guard — is confirmed
working end to end.

## Raw notes

- timer-accuracy.mjs: `target=60000ms actual=60059ms drift=59ms`.
- `.probe-events.log` (2799 lines; events doubled): `session.idle` ×6 (3 real) at 13:27:23.722,
  13:27:31.495, 13:27:31.541; `IDLE -> re-injecting once` logged once at 13:27:23.722; the two
  later idles are the injected turn's own completion → recursion confirmed.
- The child-session repro hit `ProviderModelNotFoundError: openai/gpt-5.5` — a child provider-catalog
  quirk (resolves `gpt-5.5` without the `openai/` prefix), unrelated to the plugin.
