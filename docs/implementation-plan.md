# `/loop` Plugin Implementation Plan

> Historical implementation plan. The plugin is already implemented; use
> `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, and `docs/design.md` for current
> contributor guidance. Paths in older task notes may include the former
> `plugins/loop/` checkout prefix; in this standalone repository, paths are
> relative to the repository root.

**Goal:** Add an opencode plugin exposing a `/loop` command that re-prompts the user's current session on a fixed-interval or model-paced cadence, carrying context forward, until stopped or a safety cap trips.

**Architecture:** A resident plugin split into pure logic (`loop-core.js`, opencode-free, fully unit-tested) and a thin live shell (`loop.js`) that wires the `event`, `command.execute.before`, and `tool` hooks. The shell drives the user's own session via `client.session.promptAsync(...)` keyed off `session.idle`, guarded by a per-session generation counter. Dynamic mode is gated on a registered `schedule_wakeup` tool.

**Tech Stack:** Node ESM, `@opencode-ai/plugin@1.17.7` (`tool` + `tool.schema`/zod), `node:test` + `node:assert/strict`. No new dependencies.

## Global Constraints

- ES modules only; no TypeScript. Register `loop.js` in the user's OpenCode `plugin` array by package name or by path.
- No new npm dependencies. Use only `@opencode-ai/plugin` and Node built-ins.
- Tests run via `node --test tests/*.test.mjs`; keep fake clients small and test internals off the live hooks object.
- Loop state is **in-memory only** (ephemeral); no disk persistence, no restart survival.
- The loop drives **the user's own session** (the session that ran `/loop`), carrying context forward — never a child session.
- Delay clamp: dynamic `delaySeconds` ∈ **[60, 3600]**. Default safety caps: **`maxIterations = 50`**, **`maxWallClockMs = 3_600_000`** (60 min).
- Follow AGENTS.md: surgical changes only, no unrelated refactors. After config-time changes, the user must **restart opencode**.
- **Spike finding A (verified live):** `command.execute.before` must mutate `output.parts` **IN PLACE** (`output.parts.splice(0, output.parts.length, ...parts)`), never reassign (`output.parts = [...]`) — opencode holds a reference to the original array and silently drops a reassignment, so the model would receive the raw command body.
- **Spike finding B (verified live):** opencode invokes plugin hooks ~**twice** per occurrence and may instantiate the plugin factory more than once. Therefore all loop state is a **module-level singleton** registry, and idle handling is **idempotent** (a 2nd idle for a generation is ignored via `awaitingIdle`/generation). Tests reset the shared registry via a top-level `beforeEach`.
- Spec: `docs/design.md`. Spike results: `docs/spike-results.md`.

---

## Task 1: Spike — verify the five unknowns before building

The whole design rests on host idle/re-prompt behavior. Before building, prove the four (plus one) assumptions from spec §8 against a **live** opencode. This task is **manual integration verification**, not a `node:test`. Deliverable: a temporary probe plugin, a timer-accuracy script, and recorded findings with a go/no-go.

**Files:**
- Create: `plugins/loop/scripts/probe.js` (temporary — removed at end of task)
- Create: `plugins/loop/scripts/timer-accuracy.mjs`
- Create: `plugins/loop/docs/spike-results.md`
- Modify (temporarily): `opencode.json` (add then remove the probe registration)

- [ ] **Step 1: Write the probe plugin**

```javascript
// plugins/loop/scripts/probe.js
// TEMPORARY spike probe. Remove from opencode.json and delete after the spike.
import fs from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const LOG = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".probe-events.log");
const probeState = new Map();
function log(line) { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {} }
function sidOf(event) {
  const p = event?.properties ?? {};
  return p.sessionID ?? p.sessionId ?? p.session?.id ?? p.message?.info?.sessionID ?? p.message?.sessionID;
}
function isIdle(event) {
  if (event?.type === "session.idle") return true;
  if (event?.type !== "session.status") return false;
  const s = event?.properties?.status ?? event?.properties?.session?.status;
  return s === "idle" || s?.type === "idle";
}

export const LoopProbe = async (ctx) => ({
  "command.execute.before": async (input, output) => {
    if (input.command !== "probe") return;
    probeState.set(input.sessionID, { armed: true, fires: 0 });
    log(`probe start session=${input.sessionID} agent=${input.agent ?? "?"}`);
    output.parts = [{ type: "text", text: "Probe iteration 1. Reply with the single word: pong.", synthetic: true, metadata: { source: "loop-probe" } }];
  },
  event: async ({ event }) => {
    const sid = sidOf(event);
    log(`event type=${event?.type} session=${sid ?? "?"}`);
    if (!isIdle(event)) return;
    const st = sid ? probeState.get(sid) : undefined;
    if (!st || !st.armed || st.fires >= 1) return; // fire exactly ONCE; a second idle after this proves recursion exists
    st.fires += 1; st.armed = false;
    log(`IDLE -> re-injecting once into session=${sid}`);
    await ctx.client.tui.showToast({ body: { title: "/probe", message: "idle seen; re-injecting once", variant: "info", duration: 4000 } });
    await ctx.client.session.promptAsync({
      path: { id: sid }, query: { directory: ctx.directory },
      body: { parts: [{ type: "text", text: "Probe re-injection. Reply: pong2. (To test command-looping, this could instead be a /command.)", synthetic: true }] },
    });
  },
  tool: {
    echo_wakeup: tool({
      description: "Probe-only: echo a requested delay so we can confirm a custom tool's value reaches the host.",
      args: { delaySeconds: tool.schema.number().describe("seconds") },
      async execute(args, tc) {
        log(`echo_wakeup delaySeconds=${args.delaySeconds} session=${tc.sessionID}`);
        await ctx.client.tui.showToast({ body: { title: "/probe", message: `echo_wakeup(${args.delaySeconds})`, variant: "info", duration: 4000 } });
        return `recorded ${args.delaySeconds}`;
      },
    }),
  },
});
```

- [ ] **Step 2: Write the timer-accuracy script** (unknown #3)

```javascript
// plugins/loop/scripts/timer-accuracy.mjs
// Run: node plugins/loop/scripts/timer-accuracy.mjs
const target = 60_000;
const start = Date.now();
setTimeout(() => {
  const actual = Date.now() - start;
  console.log(`target=${target}ms actual=${actual}ms drift=${actual - target}ms`);
}, target);
```

- [ ] **Step 3: Run the timer script and record drift**

Run: `node plugins/loop/scripts/timer-accuracy.mjs`
Expected: prints a line; drift within a few hundred ms is acceptable for "at least N" semantics. Record the number in `spike-results.md`.

- [ ] **Step 4: Temporarily register the probe and restart opencode**

Add `"./plugins/loop/scripts/probe.js"` to the `plugin` array in `opencode.json` (after the existing entries). Tell the user to restart opencode (config changes don't apply to running sessions).

- [ ] **Step 5: Exercise the probe live and observe**

In a fresh opencode session run `/probe`. Then watch toasts and `tail -f plugins/loop/.probe-events.log`. Verify and record in `spike-results.md`:
1. **(unknown #1)** `session.idle` (or `session.status` idle) events appear for *this* session. Try it under both `build` and `plan` agents.
2. **(unknown #2)** After the probe's single re-injection, does a *second* idle event arrive for the same session? (Expected: yes → confirms the generation/`awaitingIdle` guard is mandatory.)
3. **(unknown #4)** Ask the model to call `echo_wakeup` (e.g. "call echo_wakeup with 120"); confirm the toast + log line fire, proving a custom tool's argument reaches host code.
4. **(unknown #5, optional)** Change the probe's re-injection text to a real slash command (e.g. `/help`) and confirm whether opencode *executes* it. Record yes/no — this gates whether `/loop 5m /somecommand` runs the command vs. just re-injects literal text.

- [ ] **Step 6: De-register and remove the probe**

Remove the `"./plugins/loop/scripts/probe.js"` line from `opencode.json`, delete `plugins/loop/scripts/probe.js` and `plugins/loop/.probe-events.log`. Keep `timer-accuracy.mjs` and `spike-results.md`.

- [ ] **Step 7: Go/no-go**

In `spike-results.md`, write the verdict. If #1/#2/#4 behave as expected, proceed to Task 2. If any contradicts the design (e.g. no idle events under some agent, or custom-tool values don't reach host), STOP and revise the design before continuing.

- [ ] **Step 8: Commit**

```bash
git add plugins/loop/scripts/timer-accuracy.mjs plugins/loop/docs/spike-results.md
git commit -m "chore(loop): record spike findings for /loop mechanism"
```

---

## Task 2: `loop-core.js` — argument & interval parsing

**Files:**
- Create: `plugins/loop/loop-core.js`
- Test: `plugins/loop/tests/loop-core.test.mjs`

**Interfaces:**
- Produces: `parseLoopArgs(argString) -> { verb:"start", mode:"fixed", intervalMs:number, prompt:string } | { verb:"start", mode:"dynamic", prompt:string } | { verb:"stop" } | { verb:"status" } | { verb:"error", message:string }`; `parseInterval(token) -> number|null` (ms, clamped); `clampDelaySeconds(value) -> number` (∈[60,3600]); constants `DELAY_MIN_SECONDS`, `DELAY_MAX_SECONDS`, `INTERVAL_MIN_MS`, `INTERVAL_MAX_MS`, `DEFAULT_CAPS`, `DYNAMIC_CONTROL_BLOCK`.

- [ ] **Step 1: Write the failing test**

```javascript
// plugins/loop/tests/loop-core.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { parseLoopArgs, parseInterval, clampDelaySeconds } from "../loop-core.js";

test("parseInterval handles units and clamps", () => {
  assert.equal(parseInterval("5m"), 300_000);
  assert.equal(parseInterval("1h"), 3_600_000);
  assert.equal(parseInterval("30s"), 30_000);
  assert.equal(parseInterval("2s"), 5_000);          // clamped up to INTERVAL_MIN_MS
  assert.equal(parseInterval("0s"), null);
  assert.equal(parseInterval("abc"), null);
  assert.equal(parseInterval("100h"), 86_400_000);   // clamped to INTERVAL_MAX_MS
});

test("clampDelaySeconds clamps to 60..3600 and defaults invalid to 60", () => {
  assert.equal(clampDelaySeconds(30), 60);
  assert.equal(clampDelaySeconds(120), 120);
  assert.equal(clampDelaySeconds(99999), 3600);
  assert.equal(clampDelaySeconds(Number.NaN), 60);
  assert.equal(clampDelaySeconds("200"), 200);
});

test("parseLoopArgs classifies verbs and modes", () => {
  assert.equal(parseLoopArgs("").verb, "error");
  assert.deepStrictEqual(parseLoopArgs("stop"), { verb: "stop" });
  assert.deepStrictEqual(parseLoopArgs("status"), { verb: "status" });
  assert.deepStrictEqual(parseLoopArgs("5m run the tests"), { verb: "start", mode: "fixed", intervalMs: 300_000, prompt: "run the tests" });
  assert.equal(parseLoopArgs("5m").verb, "error");   // interval but no prompt
  assert.deepStrictEqual(parseLoopArgs("keep triaging"), { verb: "start", mode: "dynamic", prompt: "keep triaging" });
  assert.deepStrictEqual(parseLoopArgs("do 5m stuff"), { verb: "start", mode: "dynamic", prompt: "do 5m stuff" }); // leading token not an interval
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/loop/tests/loop-core.test.mjs`
Expected: FAIL — `Cannot find module '../loop-core.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// plugins/loop/loop-core.js
// Pure, opencode-free logic for the /loop plugin. Fully unit-testable.

export const DELAY_MIN_SECONDS = 60;
export const DELAY_MAX_SECONDS = 3600;
export const INTERVAL_MIN_MS = 5_000;
export const INTERVAL_MAX_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CAPS = { maxIterations: 50, maxWallClockMs: 60 * 60 * 1000 };

export const DYNAMIC_CONTROL_BLOCK = [
  "---",
  "This message is one iteration of an autonomous /loop.",
  "To CONTINUE the loop, call the `schedule_wakeup` tool with `delaySeconds`",
  "(clamped to 60-3600) for how long to wait before the next iteration.",
  "To END the loop, finish your turn WITHOUT calling `schedule_wakeup`.",
  "End the loop when the task is complete, blocked, or no further progress is useful.",
].join("\n");

export function clampDelaySeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DELAY_MIN_SECONDS;
  return Math.min(DELAY_MAX_SECONDS, Math.max(DELAY_MIN_SECONDS, Math.round(n)));
}

const INTERVAL_RE = /^(\d+)(s|m|h)$/i;

export function parseInterval(token) {
  const m = INTERVAL_RE.exec(token ?? "");
  if (!m) return null;
  const factor = m[2].toLowerCase() === "h" ? 3_600_000 : m[2].toLowerCase() === "m" ? 60_000 : 1_000;
  const ms = Number(m[1]) * factor;
  if (ms <= 0) return null;
  return Math.min(INTERVAL_MAX_MS, Math.max(INTERVAL_MIN_MS, ms));
}

const STOP_VERBS = new Set(["stop", "off", "cancel", "clear", "end"]);
const STATUS_VERBS = new Set(["status", "info"]);

export function parseLoopArgs(argString) {
  const args = (argString ?? "").trim();
  if (!args) return { verb: "error", message: "Usage: /loop [interval] <prompt>  |  /loop status  |  /loop stop" };
  const tokens = args.split(/\s+/);
  const first = tokens[0].toLowerCase();
  if (tokens.length === 1 && STOP_VERBS.has(first)) return { verb: "stop" };
  if (tokens.length === 1 && STATUS_VERBS.has(first)) return { verb: "status" };

  const intervalMs = parseInterval(tokens[0]);
  if (intervalMs != null) {
    const prompt = tokens.slice(1).join(" ").trim();
    if (!prompt) return { verb: "error", message: "Provide a prompt after the interval, e.g. /loop 5m run the tests" };
    return { verb: "start", mode: "fixed", intervalMs, prompt };
  }
  return { verb: "start", mode: "dynamic", prompt: args };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/loop/tests/loop-core.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/loop/loop-core.js plugins/loop/tests/loop-core.test.mjs
git commit -m "feat(loop): add argument and interval parsing"
```

---

## Task 3: `loop-core.js` — registry & generation counter

**Files:**
- Modify: `plugins/loop/loop-core.js` (append)
- Test: `plugins/loop/tests/loop-core.test.mjs` (append)

**Interfaces:**
- Consumes: `DEFAULT_CAPS` from Task 2.
- Produces: `createRegistry() -> { map, has(id), get(id), all(), start(id, {mode, intervalMs?, loopPrompt, startedAt, caps?}) -> state, stop(id) -> state|undefined }`; `bumpGeneration(state) -> number`. A `state` has: `sessionID, mode, loopPrompt, intervalMs, generation, awaitingIdle, iterationCount, startedAt, lastFireAt, status('running'|'paused'|'stopped'), pauseReason, pendingWakeup, timer, caps`.

- [ ] **Step 1: Write the failing test** (append)

```javascript
import { createRegistry, bumpGeneration } from "../loop-core.js";

test("registry start initializes iteration 1 state", () => {
  const r = createRegistry();
  const s = r.start("ses_1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "x", startedAt: 1000 });
  assert.equal(s.generation, 1);
  assert.equal(s.awaitingIdle, true);
  assert.equal(s.iterationCount, 1);
  assert.equal(s.lastFireAt, 1000);
  assert.equal(s.status, "running");
  assert.equal(s.caps.maxIterations, 50);
  assert.equal(r.has("ses_1"), true);
});

test("registry stop removes and returns state; bumpGeneration increments", () => {
  const r = createRegistry();
  const s = r.start("ses_1", { mode: "dynamic", loopPrompt: "x", startedAt: 0 });
  assert.equal(bumpGeneration(s), 2);
  const removed = r.stop("ses_1");
  assert.equal(removed.status, "stopped");
  assert.equal(r.has("ses_1"), false);
  assert.equal(r.stop("ses_1"), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/loop/tests/loop-core.test.mjs`
Expected: FAIL — `createRegistry` / `bumpGeneration` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `loop-core.js`)

```javascript
export function createRegistry() {
  const map = new Map();
  return {
    map,
    has: (id) => map.has(id),
    get: (id) => map.get(id),
    all: () => [...map.values()],
    start(sessionID, { mode, intervalMs = null, loopPrompt, startedAt, caps = DEFAULT_CAPS }) {
      const state = {
        sessionID, mode, loopPrompt, intervalMs,
        generation: 1, awaitingIdle: true, iterationCount: 1,
        startedAt, lastFireAt: startedAt,
        status: "running", pauseReason: null,
        pendingWakeup: null, timer: null, caps,
      };
      map.set(sessionID, state);
      return state;
    },
    stop(sessionID) {
      const state = map.get(sessionID);
      if (state) { state.status = "stopped"; map.delete(sessionID); }
      return state;
    },
  };
}

export function bumpGeneration(state) {
  state.generation += 1;
  return state.generation;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/loop/tests/loop-core.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/loop/loop-core.js plugins/loop/tests/loop-core.test.mjs
git commit -m "feat(loop): add per-session registry and generation counter"
```

---

## Task 4: `loop-core.js` — `decideNextAction` & `buildIterationPrompt` (the brain)

**Files:**
- Modify: `plugins/loop/loop-core.js` (append)
- Test: `plugins/loop/tests/loop-core.test.mjs` (append)

**Interfaces:**
- Consumes: `clampDelaySeconds`, `DYNAMIC_CONTROL_BLOCK`, registry `state` shape.
- Produces: `decideNextAction(state, event, nowMs) -> Action`, where `event = { kind:"idle"|"permissionAsked"|"permissionReplied"|"error"|"other", rejected?:boolean }` and `Action = { kind:"ignore" } | { kind:"schedule", delayMs } | { kind:"pause", reason:"permission"|"error" } | { kind:"resume" } | { kind:"terminate", reason:"completed"|"max-iterations"|"max-wallclock"|"stopped" }`. Also `buildIterationPrompt(state) -> string`.

- [ ] **Step 1: Write the failing test** (append)

```javascript
import { decideNextAction, buildIterationPrompt, DYNAMIC_CONTROL_BLOCK } from "../loop-core.js";

function baseState(over = {}) {
  return {
    sessionID: "s", mode: "fixed", loopPrompt: "p", intervalMs: 30_000,
    generation: 1, awaitingIdle: true, iterationCount: 1,
    startedAt: 0, lastFireAt: 0, status: "running", pauseReason: null,
    pendingWakeup: null, timer: null, caps: { maxIterations: 50, maxWallClockMs: 3_600_000 },
    ...over,
  };
}

test("decideNextAction: lifecycle/permission events", () => {
  assert.deepStrictEqual(decideNextAction(undefined, { kind: "idle" }, 0), { kind: "ignore" });
  assert.deepStrictEqual(decideNextAction(baseState(), { kind: "permissionAsked" }, 0), { kind: "pause", reason: "permission" });
  assert.deepStrictEqual(decideNextAction(baseState(), { kind: "error" }, 0), { kind: "pause", reason: "error" });
  assert.deepStrictEqual(decideNextAction(baseState({ status: "paused" }), { kind: "permissionReplied", rejected: false }, 0), { kind: "resume" });
  assert.deepStrictEqual(decideNextAction(baseState({ status: "paused" }), { kind: "permissionReplied", rejected: true }, 0), { kind: "terminate", reason: "stopped" });
  assert.deepStrictEqual(decideNextAction(baseState(), { kind: "permissionReplied", rejected: false }, 0), { kind: "ignore" }); // not paused
});

test("decideNextAction: idle guards (status, awaitingIdle, caps)", () => {
  assert.deepStrictEqual(decideNextAction(baseState({ status: "paused" }), { kind: "idle" }, 0), { kind: "ignore" });
  assert.deepStrictEqual(decideNextAction(baseState({ awaitingIdle: false }), { kind: "idle" }, 0), { kind: "ignore" });
  assert.deepStrictEqual(decideNextAction(baseState({ iterationCount: 50 }), { kind: "idle" }, 0), { kind: "terminate", reason: "max-iterations" });
  assert.deepStrictEqual(decideNextAction(baseState(), { kind: "idle" }, 3_600_001), { kind: "terminate", reason: "max-wallclock" });
});

test("decideNextAction: fixed schedules at least the interval", () => {
  assert.deepStrictEqual(decideNextAction(baseState({ lastFireAt: 0 }), { kind: "idle" }, 10_000), { kind: "schedule", delayMs: 20_000 });
  assert.deepStrictEqual(decideNextAction(baseState({ lastFireAt: 0 }), { kind: "idle" }, 40_000), { kind: "schedule", delayMs: 0 });
});

test("decideNextAction: dynamic requires a matching pendingWakeup", () => {
  assert.deepStrictEqual(decideNextAction(baseState({ mode: "dynamic", intervalMs: null }), { kind: "idle" }, 0), { kind: "terminate", reason: "completed" });
  assert.deepStrictEqual(
    decideNextAction(baseState({ mode: "dynamic", intervalMs: null, pendingWakeup: { delaySeconds: 90, generation: 1 } }), { kind: "idle" }, 0),
    { kind: "schedule", delayMs: 90_000 },
  );
  assert.deepStrictEqual(
    decideNextAction(baseState({ mode: "dynamic", intervalMs: null, pendingWakeup: { delaySeconds: 90, generation: 0 } }), { kind: "idle" }, 0),
    { kind: "terminate", reason: "completed" }, // stale generation = treated as no wakeup
  );
});

test("buildIterationPrompt appends control block only in dynamic mode", () => {
  assert.equal(buildIterationPrompt(baseState({ loopPrompt: "go" })), "go");
  assert.equal(buildIterationPrompt(baseState({ mode: "dynamic", loopPrompt: "go" })), `go\n\n${DYNAMIC_CONTROL_BLOCK}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/loop/tests/loop-core.test.mjs`
Expected: FAIL — `decideNextAction` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `loop-core.js`)

```javascript
export function buildIterationPrompt(state) {
  if (state.mode === "dynamic") return `${state.loopPrompt}\n\n${DYNAMIC_CONTROL_BLOCK}`;
  return state.loopPrompt;
}

export function decideNextAction(state, event, nowMs) {
  if (!state) return { kind: "ignore" };

  switch (event.kind) {
    case "permissionAsked":
      return state.status === "running" ? { kind: "pause", reason: "permission" } : { kind: "ignore" };
    case "error":
      return state.status === "running" ? { kind: "pause", reason: "error" } : { kind: "ignore" };
    case "permissionReplied":
      if (state.status !== "paused") return { kind: "ignore" };
      return event.rejected ? { kind: "terminate", reason: "stopped" } : { kind: "resume" };
    case "idle":
      break;
    default:
      return { kind: "ignore" };
  }

  // idle:
  if (state.status !== "running") return { kind: "ignore" };
  if (!state.awaitingIdle) return { kind: "ignore" };
  if (state.iterationCount >= state.caps.maxIterations) return { kind: "terminate", reason: "max-iterations" };
  if (nowMs - state.startedAt >= state.caps.maxWallClockMs) return { kind: "terminate", reason: "max-wallclock" };

  if (state.mode === "dynamic") {
    const w = state.pendingWakeup;
    if (!w || w.generation !== state.generation) return { kind: "terminate", reason: "completed" };
    return { kind: "schedule", delayMs: clampDelaySeconds(w.delaySeconds) * 1000 };
  }
  const elapsed = state.lastFireAt == null ? Infinity : nowMs - state.lastFireAt;
  return { kind: "schedule", delayMs: Math.max(0, state.intervalMs - elapsed) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/loop/tests/loop-core.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/loop/loop-core.js plugins/loop/tests/loop-core.test.mjs
git commit -m "feat(loop): add decideNextAction decision core and iteration prompt builder"
```

---

## Task 5: `loop.js` — plugin shell, event engine, and firing

**Files:**
- Create: `plugins/loop/loop.js`
- Test: `plugins/loop/tests/loop-plugin.test.mjs`

**Interfaces:**
- Consumes: everything from `loop-core.js`.
- Produces: `LoopPlugin(ctx) -> hooks`. The returned `hooks` object carries `hooks.__test = { registry, fireNextIteration, scheduleNextFire, applyAction }` for tests. The `event` hook normalizes server events and applies `decideNextAction`. Module helpers (exported for direct test): `getSessionID`, `isIdleEvent`, `normalizeEvent`, `textPart`.

- [ ] **Step 1: Write the failing test**

```javascript
// plugins/loop/tests/loop-plugin.test.mjs
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { LoopPlugin, normalizeEvent, isIdleEvent, getSessionID, __resetRegistryForTests } from "../loop.js";

// The registry is a module-level singleton (robust against opencode's double-instantiation), so each
// test must start from a clean registry.
beforeEach(() => __resetRegistryForTests());

function fakeClient(calls = {}) {
  calls.prompts = calls.prompts ?? [];
  calls.toasts = calls.toasts ?? [];
  return {
    tui: { showToast: async ({ body }) => { calls.toasts.push(body); } },
    session: { promptAsync: async (req) => { calls.prompts.push(req); return {}; } },
  };
}
async function pluginFor(calls) {
  return LoopPlugin({ directory: "/tmp/x", client: fakeClient(calls) });
}

test("normalizeEvent maps raw event types", () => {
  assert.equal(normalizeEvent({ type: "session.idle" }).kind, "idle");
  assert.equal(normalizeEvent({ type: "session.error" }).kind, "error");
  assert.equal(normalizeEvent({ type: "permission.asked" }).kind, "permissionAsked");
  assert.equal(normalizeEvent({ type: "permission.replied", properties: { reply: "deny" } }).rejected, true);
  assert.equal(normalizeEvent({ type: "message.updated" }).kind, "other");
  assert.equal(getSessionID({ properties: { sessionID: "s1" } }), "s1");
  assert.equal(isIdleEvent({ type: "session.status", properties: { status: { type: "idle" } } }), true);
});

test("fireNextIteration re-injects the iteration prompt and bumps generation", async () => {
  const calls = {};
  const hooks = await pluginFor(calls);
  const { registry, fireNextIteration } = hooks.__test;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "do x", startedAt: 0 });
  await fireNextIteration("s1");
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].path.id, "s1");
  assert.equal(calls.prompts[0].body.parts[0].text, "do x");
  const s = registry.get("s1");
  assert.equal(s.generation, 2);
  assert.equal(s.iterationCount, 2);
  assert.equal(s.awaitingIdle, true);
});

test("event idle schedules and fires the next iteration after the interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  hooks.__test.registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(calls.prompts.length, 0);              // scheduled, not yet fired
  t.mock.timers.tick(30_000);
  await Promise.resolve();                            // flush the async fire
  assert.equal(calls.prompts.length, 1);
  assert.equal(hooks.__test.registry.get("s1").awaitingIdle, true);
});

test("recursion guard: a duplicate idle after scheduling is ignored", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  hooks.__test.registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } }); // awaitingIdle now false -> ignored
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(calls.prompts.length, 1);              // exactly one fire, not two
});

test("events for an untracked session are ignored", async () => {
  const calls = {};
  const hooks = await pluginFor(calls);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "unknown" } } });
  assert.equal(calls.prompts.length, 0);
});

test("max-iterations terminates with a toast", async () => {
  const calls = {};
  const hooks = await pluginFor(calls);
  const s = hooks.__test.registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: 0 });
  s.iterationCount = s.caps.maxIterations;
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(hooks.__test.registry.has("s1"), false);
  assert.match(calls.toasts.at(-1).message, /50 iterations/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/loop/tests/loop-plugin.test.mjs`
Expected: FAIL — `Cannot find module '../loop.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// plugins/loop/loop.js
import { tool } from "@opencode-ai/plugin";
import {
  DEFAULT_CAPS, buildIterationPrompt, bumpGeneration, clampDelaySeconds,
  createRegistry, decideNextAction, parseLoopArgs,
} from "./loop-core.js";

const PERMISSION_ASKED_EVENTS = new Set(["permission.asked", "permission.v2.asked"]);
const PERMISSION_REPLIED_EVENTS = new Set(["permission.replied", "permission.v2.replied"]);

function now() { return Date.now(); }

export function textPart(text, options = {}) {
  return {
    type: "text",
    text,
    synthetic: options.synthetic ?? true,
    ignored: options.ignored ?? false,
    metadata: { source: "loop-plugin", ...(options.metadata ?? {}) },
  };
}

// The visible "/loop ..." echo (ignored by the model).
function displayPart(input) {
  const args = (input.arguments ?? "").trim();
  return textPart(args ? `/${input.command} ${args}` : `/${input.command}`, {
    synthetic: false, ignored: true, metadata: { kind: "display" },
  });
}

export function getSessionID(event) {
  const p = event?.properties ?? {};
  return p.sessionID ?? p.sessionId ?? p.session?.id ?? p.info?.sessionID ??
    p.permission?.sessionID ?? p.message?.info?.sessionID ?? p.message?.sessionID;
}

export function isIdleEvent(event) {
  if (event?.type === "session.idle") return true;
  if (event?.type !== "session.status") return false;
  const status = event?.properties?.status ?? event?.properties?.session?.status;
  return status === "idle" || status?.type === "idle";
}

function permissionRejected(event) {
  const p = event?.properties ?? {};
  const reply = String(p.reply ?? p.response ?? p.status ?? p.decision ?? "").toLowerCase();
  return ["reject", "rejected", "deny", "denied"].includes(reply);
}

export function normalizeEvent(event) {
  const type = event?.type;
  if (PERMISSION_ASKED_EVENTS.has(type)) return { kind: "permissionAsked" };
  if (PERMISSION_REPLIED_EVENTS.has(type)) return { kind: "permissionReplied", rejected: permissionRejected(event) };
  if (type === "session.error") return { kind: "error" };
  if (isIdleEvent(event)) return { kind: "idle" };
  return { kind: "other" };
}

async function toast(client, message, variant = "info") {
  try { await client.tui.showToast({ body: { title: "/loop", message, variant, duration: 5000 } }); }
  catch { /* best effort; transcript is the source of truth */ }
}

function terminateMessage(reason, state) {
  switch (reason) {
    case "completed": return "Loop complete.";
    case "max-iterations": return `Loop stopped: reached ${state?.caps?.maxIterations ?? "max"} iterations.`;
    case "max-wallclock": return "Loop stopped: reached the time limit.";
    default: return "Loop stopped.";
  }
}
function terminateVariant(reason) {
  if (reason === "completed") return "success";
  if (reason === "max-iterations" || reason === "max-wallclock") return "warning";
  return "info";
}

// Module-level shared registry. opencode invokes plugin hooks ~twice per occurrence (spike finding B)
// and may instantiate the factory more than once; one module-level registry
// is the single source of truth, so doubled events/commands cannot spawn two competing loops. The
// awaitingIdle/generation dedup absorbs the doubled idle events (2nd idle for a generation -> ignored).
const registry = createRegistry();

export const LoopPlugin = async (ctx) => {
  async function fireNextIteration(sessionID) {
    const state = registry.get(sessionID);
    if (!state || state.status !== "running") return;
    bumpGeneration(state);
    state.awaitingIdle = true;
    state.iterationCount += 1;
    state.lastFireAt = now();
    const gen = state.generation;
    try {
      const res = await ctx.client.session.promptAsync({
        path: { id: sessionID },
        query: { directory: ctx.directory },
        body: { parts: [textPart(buildIterationPrompt(state), { metadata: { kind: "loop-iteration", generation: gen } })] },
      });
      if (res?.error) {
        registry.stop(sessionID);
        await toast(ctx.client, `Loop stopped: re-prompt failed (${res.error.name || "error"}).`, "error");
      }
    } catch (error) {
      registry.stop(sessionID);
      await toast(ctx.client, `Loop stopped: ${String(error?.message || error)}`, "error");
    }
  }

  function scheduleNextFire(sessionID, delayMs) {
    const state = registry.get(sessionID);
    if (!state) return;
    state.awaitingIdle = false;     // consume this idle; dedupe further idles for this generation
    state.pendingWakeup = null;     // dynamic mode must re-arm via schedule_wakeup each iteration
    if (state.timer) clearTimeout(state.timer);
    const armedGen = state.generation;
    state.timer = setTimeout(() => {
      state.timer = null;
      const s = registry.get(sessionID);
      if (!s || s.status !== "running" || s.generation !== armedGen) return;
      fireNextIteration(sessionID);
    }, delayMs);
  }

  async function applyAction(sessionID, action) {
    const state = registry.get(sessionID);
    switch (action.kind) {
      case "ignore": return;
      case "schedule": scheduleNextFire(sessionID, action.delayMs); return;
      case "pause":
        if (state) {
          state.status = "paused"; state.pauseReason = action.reason;
          if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        }
        return;
      case "resume":
        if (state) { state.status = "running"; state.pauseReason = null; }
        return;
      case "terminate": {
        const removed = registry.stop(sessionID);
        if (removed?.timer) clearTimeout(removed.timer);
        await toast(ctx.client, terminateMessage(action.reason, removed), terminateVariant(action.reason));
        return;
      }
    }
  }

  const hooks = {
    event: async ({ event }) => {
      const sessionID = getSessionID(event);
      if (typeof sessionID !== "string" || !registry.has(sessionID)) return;
      const norm = normalizeEvent(event);
      if (norm.kind === "other") return;
      await applyAction(sessionID, decideNextAction(registry.get(sessionID), norm, now()));
    },
  };

  hooks.__test = { registry, fireNextIteration, scheduleNextFire, applyAction, DEFAULT_CAPS };
  return hooks;
};

// The registry is a module-level singleton shared across instances, so tests must clear it between
// cases. A top-level beforeEach in the test file calls this.
export function __resetRegistryForTests() { registry.map.clear(); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/loop/tests/loop-plugin.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/loop/loop.js plugins/loop/tests/loop-plugin.test.mjs
git commit -m "feat(loop): add plugin shell, idle event engine, and iteration firing"
```

---

## Task 6: `loop.js` — `/loop` command dispatch (start/stop/status)

**Files:**
- Modify: `plugins/loop/loop.js` (add `command.execute.before` hook + helpers)
- Test: `plugins/loop/tests/loop-plugin.test.mjs` (append)

**Interfaces:**
- Consumes: `registry`, `now`, `textPart`, `buildIterationPrompt`, `parseLoopArgs`, `DEFAULT_CAPS`.
- Produces: a `"command.execute.before"` hook on `hooks`. On `start`, it rewrites `output.parts` to the first iteration's prompt (the command turn *is* iteration 1). Module helper `statusText(state) -> string` (exported for test). `commandInput(sessionID, args) = { command:"loop", arguments:args, sessionID }`.

- [ ] **Step 1: Write the failing test** (append)

```javascript
import { statusText } from "../loop.js";

function commandInput(sessionID, args) { return { command: "loop", arguments: args, sessionID }; }
function emptyOutput() { return { parts: [] }; }
// Join only the model-facing parts; the ignored displayPart echo ("/loop …") is excluded.
function outText(output) { return output.parts.filter((p) => !p.ignored).map((p) => p.text).join("\n"); }

test("command start (fixed) registers iteration 1 and rewrites parts to the plain prompt", async () => {
  const calls = {};
  const hooks = await LoopPlugin({ directory: "/tmp/x", client: (() => { const c = {}; return Object.assign(c, { tui: { showToast: async () => {} }, session: { promptAsync: async () => ({}) } }); })() });
  const out = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "30s do the thing"), out);
  const s = hooks.__test.registry.get("s1");
  assert.equal(s.mode, "fixed");
  assert.equal(s.iterationCount, 1);
  assert.equal(outText(out), "do the thing");          // no control block in fixed mode
});

test("command start (dynamic) appends the control block to iteration 1", async () => {
  const hooks = await LoopPlugin({ directory: "/tmp/x", client: { tui: { showToast: async () => {} }, session: { promptAsync: async () => ({}) } });
  const out = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "keep going"), out);
  assert.equal(hooks.__test.registry.get("s1").mode, "dynamic");
  assert.match(outText(out), /schedule_wakeup/);
});

test("command stop removes the loop; status reports state; error shows usage", async () => {
  const hooks = await LoopPlugin({ directory: "/tmp/x", client: { tui: { showToast: async () => {} }, session: { promptAsync: async () => ({}) } });
  await hooks["command.execute.before"](commandInput("s1", "30s go"), emptyOutput());

  const statusOut = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "status"), statusOut);
  assert.match(outText(statusOut), /Active \/loop/);

  const stopOut = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "stop"), stopOut);
  assert.equal(hooks.__test.registry.has("s1"), false);
  assert.match(outText(stopOut), /Stopped/);

  const errOut = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", ""), errOut);
  assert.match(outText(errOut), /Usage/);
});

test("statusText handles no active loop", () => {
  assert.match(statusText(undefined), /No active/);
});

test("command handler mutates output.parts IN PLACE and includes the /loop display echo", async () => {
  const hooks = await LoopPlugin({ directory: "/tmp/x", client: { tui: { showToast: async () => {} }, session: { promptAsync: async () => ({}) } });
  const original = [];
  const out = { parts: original };
  await hooks["command.execute.before"](commandInput("s1", "30s go"), out);
  assert.equal(out.parts, original, "must mutate the SAME array reference opencode holds, not reassign (spike finding A)");
  assert.ok(out.parts.some((p) => p.ignored && p.text === "/loop 30s go"), "includes the ignored '/loop …' display echo");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/loop/tests/loop-plugin.test.mjs`
Expected: FAIL — `hooks["command.execute.before"]` is undefined / `statusText` not exported.

- [ ] **Step 3: Write minimal implementation**

Add this exported helper at module scope (near `terminateMessage`):

```javascript
export function statusText(state) {
  if (!state) return "No active /loop in this session.";
  const elapsed = Math.round((now() - state.startedAt) / 1000);
  const mode = state.mode === "fixed" ? `fixed (${Math.round(state.intervalMs / 1000)}s)` : "dynamic";
  return [
    `Active /loop: ${mode}, status ${state.status}.`,
    `Iterations: ${state.iterationCount}/${state.caps.maxIterations}. Elapsed: ${elapsed}s.`,
    `Prompt: ${state.loopPrompt}`,
  ].join("\n");
}
```

Inside the factory (before `const hooks = {...}`), add the handler:

```javascript
  // CRITICAL (spike finding A): mutate output.parts IN PLACE (splice), never reassign. opencode holds
  // a reference to the original array, so `output.parts = [...]` is silently dropped and the model
  // receives the raw commands/loop.md body instead.
  function replaceParts(output, ...parts) {
    output.parts = output.parts ?? [];
    output.parts.splice(0, output.parts.length, ...parts);
  }

  async function handleLoopCommand(input, output) {
    const sessionID = input.sessionID;
    const intent = parseLoopArgs(input.arguments ?? "");
    if (intent.verb === "error") { replaceParts(output, displayPart(input), textPart(intent.message)); return; }
    if (intent.verb === "status") { replaceParts(output, displayPart(input), textPart(statusText(registry.get(sessionID)))); return; }
    if (intent.verb === "stop") {
      const removed = registry.stop(sessionID);
      if (removed?.timer) clearTimeout(removed.timer);
      await toast(ctx.client, removed ? "Loop stopped." : "No active loop.", "info");
      replaceParts(output, displayPart(input), textPart(removed ? "Stopped the active /loop." : "No active /loop in this session."));
      return;
    }
    // start: replace any existing loop, then make THIS turn iteration 1
    const existing = registry.stop(sessionID);
    if (existing?.timer) clearTimeout(existing.timer);
    const state = registry.start(sessionID, {
      mode: intent.mode, intervalMs: intent.intervalMs ?? null,
      loopPrompt: intent.prompt, startedAt: now(), caps: DEFAULT_CAPS,
    });
    const label = intent.mode === "fixed" ? `fixed, ${Math.round(intent.intervalMs / 1000)}s` : "dynamic";
    await toast(ctx.client, `Loop started (${label}).`, "success");
    replaceParts(output, displayPart(input), textPart(buildIterationPrompt(state)));
  }
```

Then register it on `hooks`:

```javascript
  hooks["command.execute.before"] = async (input, output) => {
    if (input.command !== "loop") return;
    await handleLoopCommand(input, output);
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/loop/tests/loop-plugin.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/loop/loop.js plugins/loop/tests/loop-plugin.test.mjs
git commit -m "feat(loop): add /loop command dispatch for start, stop, and status"
```

---

## Task 7: `loop.js` — `schedule_wakeup` tool for dynamic mode

**Files:**
- Modify: `plugins/loop/loop.js` (add `tool` hook)
- Test: `plugins/loop/tests/loop-plugin.test.mjs` (append)

**Interfaces:**
- Consumes: `registry`, `clampDelaySeconds`, `tool` from `@opencode-ai/plugin`.
- Produces: a `tool.schedule_wakeup` registration on `hooks`. `execute({delaySeconds}, {sessionID})` records `state.pendingWakeup = { delaySeconds: clamped, generation: state.generation }` for an active **dynamic running** loop and returns a status string; otherwise it no-ops with an explanatory string.

- [ ] **Step 1: Write the failing test** (append)

```javascript
test("schedule_wakeup records a clamped wakeup for an active dynamic loop", async () => {
  const hooks = await LoopPlugin({ directory: "/tmp/x", client: { tui: { showToast: async () => {} }, session: { promptAsync: async () => ({}) } });
  hooks.__test.registry.start("s1", { mode: "dynamic", loopPrompt: "go", startedAt: 0 });
  const msg = await hooks.tool.schedule_wakeup.execute({ delaySeconds: 30 }, { sessionID: "s1" });
  const s = hooks.__test.registry.get("s1");
  assert.deepStrictEqual(s.pendingWakeup, { delaySeconds: 60, generation: 1 }); // clamped up to 60
  assert.match(msg, /continue in 60s/);
});

test("schedule_wakeup no-ops for fixed or absent loops", async () => {
  const hooks = await LoopPlugin({ directory: "/tmp/x", client: { tui: { showToast: async () => {} }, session: { promptAsync: async () => ({}) } });
  hooks.__test.registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  const fixedMsg = await hooks.tool.schedule_wakeup.execute({ delaySeconds: 120 }, { sessionID: "s1" });
  assert.match(fixedMsg, /no effect/);
  assert.equal(hooks.__test.registry.get("s1").pendingWakeup, null);
  const absentMsg = await hooks.tool.schedule_wakeup.execute({ delaySeconds: 120 }, { sessionID: "nope" });
  assert.match(absentMsg, /no effect/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/loop/tests/loop-plugin.test.mjs`
Expected: FAIL — `hooks.tool` is undefined.

- [ ] **Step 3: Write minimal implementation**

Register the tool on `hooks` (after the `command.execute.before` registration, inside the factory):

```javascript
  hooks.tool = {
    schedule_wakeup: tool({
      description:
        "Continue the active /loop in THIS session: schedule the next iteration after delaySeconds " +
        "(clamped to 60-3600). Call this only when the looped task should keep going. Finish your turn " +
        "WITHOUT calling it to END the loop. No effect outside a dynamic /loop.",
      args: {
        delaySeconds: tool.schema.number().describe("Seconds until the next loop iteration (clamped to 60-3600)."),
      },
      async execute(args, toolContext) {
        const state = registry.get(toolContext.sessionID);
        if (!state || state.mode !== "dynamic" || state.status !== "running") {
          return "No active dynamic /loop in this session; schedule_wakeup has no effect.";
        }
        const secs = clampDelaySeconds(args.delaySeconds);
        state.pendingWakeup = { delaySeconds: secs, generation: state.generation };
        return `Loop will continue in ${secs}s after this turn ends.`;
      },
    }),
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/loop/tests/loop-plugin.test.mjs`
Expected: PASS (13 tests).

- [ ] **Step 5: Run the full suite**

Run: `node --test plugins/loop/tests/*.test.mjs`
Expected: PASS (all loop-core + loop-plugin tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/loop/loop.js plugins/loop/tests/loop-plugin.test.mjs
git commit -m "feat(loop): add schedule_wakeup tool for dynamic self-pacing"
```

---

## Task 8: Command file, registration, and live verification

**Files:**
- Create: `commands/loop.md`
- Modify: the user's OpenCode config (add the plugin to the `plugin` array)
- Modify: `package.json` (add a `test:loop` script — optional convenience)

**Interfaces:**
- Consumes: the finished `plugins/loop/loop.js`.
- Produces: a discoverable `/loop` command wired to the plugin.

- [ ] **Step 1: Write the command file**

```markdown
---
description: Repeatedly re-run a prompt in this session on a fixed interval or model-paced cadence until you stop it
---

Run an autonomous /loop in this session with arguments: `$ARGUMENTS`.

The loop plugin intercepts this command before it reaches the model. If you are reading this as a normal prompt, the plugin is not loaded; restart OpenCode and confirm the plugin entry file exists at the registered `loop.js` path. Runtime plugin discovery paths are host-specific and should not be treated as source locations.

Forms:

- `/loop <interval> <prompt>` — fixed-interval, e.g. `/loop 5m run the test suite and report failures`. Interval is `<n>s|m|h`. Idle-gated: the next iteration fires at least `<interval>` after the previous one finishes (so an overrun delays rather than stacks).
- `/loop <prompt>` — dynamic self-pacing. Each iteration may call the `schedule_wakeup` tool to continue; finishing a turn without calling it ends the loop.
- `/loop status` — show the active loop (mode, iteration count, elapsed).
- `/loop stop` — stop the active loop (aliases: `off`, `cancel`, `clear`, `end`).

Safety: a loop stops automatically after 50 iterations or 60 minutes. It pauses while a permission/question prompt is open and resumes when answered; a rejected permission ends the loop. The loop drives THIS session, carrying conversation context forward. It is in-memory only — closing or restarting OpenCode ends it.
```

- [ ] **Step 2: Register the plugin**

In the user's OpenCode config, add the published package name or a path to `loop.js` to the `plugin` array.

- [ ] **Step 3: Add a test script** (optional convenience)

In `package.json` `scripts`, add: `"test": "node --test tests/*.test.mjs"`.

- [ ] **Step 4: Run the full plugin suite**

Run: `node --test tests/*.test.mjs`
Expected: PASS (all tests).

- [ ] **Step 5: Restart opencode and verify live**

Tell the user to restart opencode. Then in a fresh session:
1. `/loop 60s reply with the current time in one short sentence` → confirm it re-fires roughly every ~60s (idle-gated); run `/loop status`; then `/loop stop` and confirm it halts.
2. `/loop count from 1, one number per turn, and stop at 3` (dynamic) → confirm the model calls `schedule_wakeup` between turns and the loop ends on its own at 3 (terminate "Loop complete" toast).
3. Confirm `/loop` with no args shows usage, and that a loop pauses on a permission prompt and resumes after you answer.

Record any deviations; if behavior differs from the unit-tested expectations, debug before claiming done.

- [ ] **Step 6: Commit**

```bash
git add commands/loop.md opencode.json package.json
git commit -m "feat(loop): register /loop command and plugin"
```

---

## Deferred / out of scope (tracked, not built)

- **`doom_loop:'ask'` gating on start.** Spec §7 mentioned honoring it, but no plugin-facing enforcement API was found for `command.execute.before` (only the tool-context `ask()` exists). v1 treats an explicit `/loop` invocation as consent and relies on the hard caps as the safety net. Wire `doom_loop` enforcement if/when its API is identified. *(Deviation from spec §7 — confirmed acceptable with the user.)*
- **Looping a slash command (`/loop 5m /foo`).** The plugin stores and re-injects the literal prompt text; whether a leading `/command` actually *executes* on re-injection depends on opencode (spike unknown #5). If the spike shows it does not, command-looping is unsupported in v1 and only plain-text prompts loop.
- **Restart survival.** Out of scope by decision (ephemeral).
- **`/loop resume`.** Not in the v1 command surface; transient permission pauses auto-resume, and a rejected permission ends the loop.
- **Auto-pause on a manual user message mid-loop.** Deferred; `/loop stop` is the explicit control.

## Self-review notes

- Spec coverage: modes (Tasks 2,4,6,7), LoopState (Task 3), action set (Task 4), recursion guard (Tasks 4–5), session keying (Task 5 `registry.has` gate), pause/resume (Tasks 4–5), caps (Task 4), command surface (Task 6), spike unknowns (Task 1), placement (Task 8). The two spec items not built (`doom_loop`, command-looping) are listed above with rationale.
- Type consistency: `decideNextAction` action kinds (`ignore`/`schedule`/`pause`/`resume`/`terminate`) are produced in Task 4 and consumed by `applyAction` in Task 5; `state.pendingWakeup` shape `{delaySeconds, generation}` is written by the tool (Task 7) and read by `decideNextAction` (Task 4); `registry`/`fireNextIteration` names are stable across Tasks 5–7.
