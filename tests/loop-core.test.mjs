import assert from "node:assert/strict";
import test from "node:test";
import { parseLoopArgs, parseInterval, clampDelaySeconds, createRegistry, bumpGeneration, decideNextAction, buildIterationPrompt, DYNAMIC_CONTROL_BLOCK, createMonotonicClock, sanitizeDisplayText, LOOP_PROMPT_MAX_CHARS, statusText } from "../loop-core.js";

test("createMonotonicClock resists wall-clock and monotonic source regressions", () => {
  let wall = 1_000;
  let mono = 10;
  const clock = createMonotonicClock({ wallNow: () => wall, monotonicNow: () => mono });
  assert.equal(clock(), 1_000);
  wall = 500;
  mono = 15;
  assert.equal(clock(), 1_005);
  mono = 12;
  assert.equal(clock(), 1_005);
  mono = 25;
  assert.equal(clock(), 1_015);
});

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
  assert.deepStrictEqual(parseLoopArgs(12345), { verb: "start", mode: "dynamic", prompt: "12345" });
  assert.deepStrictEqual(parseLoopArgs("stop"), { verb: "stop" });
  assert.deepStrictEqual(parseLoopArgs("status"), { verb: "status" });
  assert.deepStrictEqual(parseLoopArgs("5m run the tests"), { verb: "start", mode: "fixed", intervalMs: 300_000, prompt: "run the tests" });
  assert.equal(parseLoopArgs("5m").verb, "error");   // interval but no prompt
  assert.deepStrictEqual(parseLoopArgs("keep triaging"), { verb: "start", mode: "dynamic", prompt: "keep triaging" });
  assert.deepStrictEqual(parseLoopArgs("do 5m stuff"), { verb: "start", mode: "dynamic", prompt: "do 5m stuff" }); // leading token not an interval
});

test("parseLoopArgs preserves fixed prompt whitespace and caps prompt length", () => {
  assert.deepStrictEqual(parseLoopArgs("5m Do:\n1. First\n2. Second   step"), {
    verb: "start",
    mode: "fixed",
    intervalMs: 300_000,
    prompt: "Do:\n1. First\n2. Second   step",
  });
  assert.equal(parseLoopArgs(`5m ${"x".repeat(LOOP_PROMPT_MAX_CHARS + 1)}`).verb, "error");
});

test("sanitizeDisplayText strips terminal controls and truncates display text", () => {
  assert.equal(sanitizeDisplayText("ok\x1b[2J\x1b]0;title\x07!\x00"), "ok!");
  assert.equal(sanitizeDisplayText("abcdef", 3), "abc\n[truncated 3 chars]");
});

test("parsing edge cases: zero/null intervals, clamp bounds, case-insensitive units, verb synonyms", () => {
  // parseInterval
  assert.equal(parseInterval("0m"), null);
  assert.equal(parseInterval("0h"), null);
  assert.equal(parseInterval(null), null);
  assert.equal(parseInterval(undefined), null);
  // clampDelaySeconds lower bound
  assert.equal(clampDelaySeconds(0), 60);
  assert.equal(clampDelaySeconds(-5), 60);
  assert.equal(clampDelaySeconds(Infinity), 60);
  // parseLoopArgs: whitespace-only -> error
  assert.equal(parseLoopArgs("   ").verb, "error");
  // case-insensitive interval unit
  assert.deepStrictEqual(parseLoopArgs("5M run tests"), { verb: "start", mode: "fixed", intervalMs: 300_000, prompt: "run tests" });
  // stop/status synonyms
  assert.deepStrictEqual(parseLoopArgs("off"), { verb: "stop" });
  assert.deepStrictEqual(parseLoopArgs("info"), { verb: "status" });
});

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
  assert.deepStrictEqual(decideNextAction(baseState({ status: "paused", pauseReason: "permission" }), { kind: "permissionReplied", rejected: false }, 0), { kind: "resume" });
  assert.deepStrictEqual(decideNextAction(baseState({ status: "paused", pauseReason: "error" }), { kind: "permissionReplied", rejected: false }, 0), { kind: "ignore" }); // error-pause is sticky; needs /loop stop
  assert.deepStrictEqual(decideNextAction(baseState({ status: "paused", pauseReason: "error" }), { kind: "permissionReplied", rejected: true }, 0), { kind: "ignore" });
  assert.deepStrictEqual(decideNextAction(baseState({ status: "paused", pauseReason: "permission" }), { kind: "permissionReplied", rejected: true }, 0), { kind: "terminate", reason: "stopped" });
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

test("decideNextAction: scheduled delays cannot cross the wall-clock cap", () => {
  const caps = { maxIterations: 50, maxWallClockMs: 60_000 };
  assert.deepStrictEqual(
    decideNextAction(baseState({ caps, intervalMs: 120_000, lastFireAt: 0 }), { kind: "idle" }, 1_000),
    { kind: "terminate", reason: "max-wallclock" },
  );
  assert.deepStrictEqual(
    decideNextAction(baseState({ caps, mode: "dynamic", intervalMs: null, pendingWakeup: { delaySeconds: 60, generation: 1 } }), { kind: "idle" }, 1_000),
    { kind: "terminate", reason: "max-wallclock" },
  );
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

test("statusText sanitizes the displayed prompt", () => {
  assert.doesNotMatch(statusText(baseState({ loopPrompt: "go\x1b[2J\x1b]0;title\x07" })), /\x1b|\x07/);
});

test("statusText clamps elapsed time when startedAt is ahead of now", () => {
  assert.match(statusText(baseState({ startedAt: 10_000 }), 5_000), /Elapsed: 0s/);
});
