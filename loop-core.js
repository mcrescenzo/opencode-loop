// Pure, opencode-free logic for the /loop plugin. Fully unit-testable.
import { readFile } from "node:fs/promises";
import path from "node:path";

const LOOP_COMMAND_OWNER = Symbol.for("opencode-loop.command-owner");

export const DELAY_MIN_SECONDS = 60;
export const DELAY_MAX_SECONDS = 3600;
export const INTERVAL_MIN_MS = 5_000;
export const INTERVAL_MAX_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CAPS = { maxIterations: 50, maxWallClockMs: 60 * 60 * 1000 };
export const LOOP_PROMPT_MAX_CHARS = 20_000;
export const DISPLAY_PROMPT_MAX_CHARS = 1_000;

export function createMonotonicClock(options = {}) {
  const wallNow = options.wallNow ?? (() => Date.now());
  const monotonicNow = options.monotonicNow ?? (() => globalThis.performance?.now?.() ?? Date.now());
  const wallBase = Number(wallNow());
  const monoBase = Number(monotonicNow());
  let last = Number.isFinite(wallBase) ? wallBase : Date.now();
  return () => {
    const monoElapsed = Number(monotonicNow()) - monoBase;
    const wallCandidate = Number(wallNow());
    const monoCandidate = Number.isFinite(monoElapsed) ? wallBase + Math.max(0, monoElapsed) : wallCandidate;
    const candidate = Math.max(
      Number.isFinite(wallCandidate) ? wallCandidate : monoCandidate,
      Number.isFinite(monoCandidate) ? monoCandidate : wallCandidate,
    );
    if (!Number.isFinite(candidate)) return last;
    last = Math.max(last, candidate);
    return last;
  };
}

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
  const unit = m[2].toLowerCase();
  const factor = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
  const ms = Number(m[1]) * factor;
  if (ms <= 0) return null;
  return Math.min(INTERVAL_MAX_MS, Math.max(INTERVAL_MIN_MS, ms));
}

const STOP_VERBS = new Set(["stop", "off", "cancel", "clear", "end"]);
const STATUS_VERBS = new Set(["status", "info"]);
const ANSI_CSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizeDisplayText(value, maxChars = DISPLAY_PROMPT_MAX_CHARS) {
  let text;
  try { text = String(value ?? ""); }
  catch { text = "[unstringifiable]"; }
  text = text.replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "").replace(CONTROL_RE, "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function promptTooLong(prompt) {
  return prompt.length > LOOP_PROMPT_MAX_CHARS
    ? { verb: "error", message: `Prompt is too long (${prompt.length}/${LOOP_PROMPT_MAX_CHARS} characters).` }
    : null;
}

export function parseLoopArgs(argString) {
  const args = String(argString ?? "").trim();
  if (!args) return { verb: "error", message: "Usage: /loop [interval] <prompt>  |  /loop status  |  /loop stop" };
  const firstToken = args.match(/^\S+/)[0];
  const first = firstToken.toLowerCase();
  const rest = args.slice(firstToken.length);
  const restTrimmed = rest.trim();
  if (!restTrimmed && STOP_VERBS.has(first)) return { verb: "stop" };
  if (!restTrimmed && STATUS_VERBS.has(first)) return { verb: "status" };

  const intervalMs = parseInterval(firstToken);
  if (intervalMs != null) {
    const prompt = restTrimmed;
    if (!prompt) return { verb: "error", message: "Provide a prompt after the interval, e.g. /loop 5m run the tests" };
    const lengthError = promptTooLong(prompt);
    if (lengthError) return lengthError;
    return { verb: "start", mode: "fixed", intervalMs, prompt };
  }
  const lengthError = promptTooLong(args);
  if (lengthError) return lengthError;
  return { verb: "start", mode: "dynamic", prompt: args };
}

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
        pendingWakeup: null, timer: null, timerDueAt: null, pausedTimer: null, caps,
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

export function buildIterationPrompt(state) {
  if (state.mode === "dynamic") return `${state.loopPrompt}\n\n${DYNAMIC_CONTROL_BLOCK}`;
  return state.loopPrompt;
}

// --- Event normalization & status rendering (pure; opencode-free) ------------
// These were previously defined in the entry (loop.js). They are pure helpers, so they live in the
// core where the plugin-level test can exercise them via a direct core import — without importing the
// entry (which wires opencode hooks). The entry re-imports them for use inside its hooks.
export const PERMISSION_ASKED_EVENTS = new Set(["permission.asked", "permission.v2.asked", "permission.updated"]);
export const PERMISSION_REPLIED_EVENTS = new Set(["permission.replied", "permission.v2.replied"]);
export const SESSION_TEARDOWN_EVENTS = new Set([
  "session.closed", "session.deleted", "session.removed", "session.destroyed",
  "session.close", "session.delete", "session.remove", "session.destroy",
]);

export function getSessionID(event) {
  const p = event?.properties ?? {};
  return p.sessionID ?? p.sessionId ?? p.session?.id ?? p.info?.sessionID ??
    p.info?.id ?? p.permission?.sessionID ?? p.message?.info?.sessionID ?? p.message?.sessionID;
}

export function isIdleEvent(event) {
  if (event?.type === "session.idle") return true;
  if (event?.type !== "session.status") return false;
  const status = event?.properties?.status ?? event?.properties?.session?.status;
  return status === "idle" || status?.type === "idle";
}

export function permissionRejected(event) {
  const p = event?.properties ?? {};
  const reply = String(p.reply ?? p.response ?? p.status ?? p.decision ?? "").toLowerCase();
  return ["reject", "rejected", "deny", "denied"].includes(reply);
}

export function normalizeEvent(event) {
  const type = event?.type;
  if (SESSION_TEARDOWN_EVENTS.has(type)) return { kind: "sessionTeardown" };
  if (PERMISSION_ASKED_EVENTS.has(type)) return { kind: "permissionAsked" };
  if (PERMISSION_REPLIED_EVENTS.has(type)) return { kind: "permissionReplied", rejected: permissionRejected(event) };
  if (type === "session.error") return { kind: "error" };
  if (isIdleEvent(event)) return { kind: "idle" };
  return { kind: "other" };
}

export function statusText(state, nowMs = Date.now()) {
  if (!state) return "No active /loop in this session.";
  const elapsed = Math.max(0, Math.round((nowMs - state.startedAt) / 1000));
  const mode = state.mode === "fixed" ? `fixed (${Math.round(state.intervalMs / 1000)}s)` : "dynamic";
  return [
    `Active /loop: ${mode}, status ${state.status}.`,
    `Iterations: ${state.iterationCount}/${state.caps.maxIterations}. Elapsed: ${elapsed}s.`,
    `Prompt: ${sanitizeDisplayText(state.loopPrompt)}`,
  ].join("\n");
}

export function decideNextAction(state, event, nowMs) {
  if (!state) return { kind: "ignore" };

  switch (event.kind) {
    case "sessionTeardown":
      return { kind: "terminate", reason: "stopped" };
    case "permissionAsked":
      return state.status === "running" ? { kind: "pause", reason: "permission" } : { kind: "ignore" };
    case "error":
      return state.status === "running" ? { kind: "pause", reason: "error" } : { kind: "ignore" };
    case "permissionReplied":
      if (state.status !== "paused") return { kind: "ignore" };
      // Only a permission-pause reacts to a permission reply; an error-pause is sticky (needs /loop stop).
      if (state.pauseReason !== "permission") return { kind: "ignore" };
      if (event.rejected) return { kind: "terminate", reason: "stopped" };
      return { kind: "resume" };
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
  const remainingWallClockMs = state.startedAt + state.caps.maxWallClockMs - nowMs;

  if (state.mode === "dynamic") {
    const w = state.pendingWakeup;
    if (!w || w.generation !== state.generation) return { kind: "terminate", reason: "completed" };
    const delayMs = clampDelaySeconds(w.delaySeconds) * 1000;
    if (delayMs >= remainingWallClockMs) return { kind: "terminate", reason: "max-wallclock" };
    return { kind: "schedule", delayMs };
  }
  const elapsed = state.lastFireAt == null ? Infinity : nowMs - state.lastFireAt;
  const delayMs = Math.max(0, state.intervalMs - elapsed);
  if (delayMs >= remainingWallClockMs) return { kind: "terminate", reason: "max-wallclock" };
  return { kind: "schedule", delayMs };
}

export function parseCommandMarkdown(source, fallbackDescription) {
  const normalized = String(source ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { description: fallbackDescription, template: normalized.trim() };
  const rawDescription = match[1].match(/^description:\s*(.+?)\s*$/m)?.[1];
  const description = rawDescription === undefined ? fallbackDescription : stripBalancedQuotes(rawDescription);
  return { description, template: match[2].trimStart() };
}

function stripBalancedQuotes(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) return value.slice(1, -1);
  return value;
}

// Self-register /loop from the plugin's bundled commands/loop.md. No-clobber, fail-soft.
export async function registerLoopCommand(cfg, moduleDir, options = {}) {
  cfg.command =
    cfg.command && typeof cfg.command === "object" && !Array.isArray(cfg.command) ? cfg.command : {};
  if (cfg.command.loop) {
    return cfg.command.loop?.[LOOP_COMMAND_OWNER]
      ? { registered: true, reason: "already-registered" }
      : { registered: false, reason: "exists" };
  }
  try {
    const source = await readFile(path.join(moduleDir, "commands", "loop.md"), "utf8");
    const command = parseCommandMarkdown(source, "Re-run a prompt on a recurring or self-paced interval");
    Object.defineProperty(command, LOOP_COMMAND_OWNER, { value: true });
    cfg.command.loop = command;
    return { registered: true, reason: "registered" };
  } catch (error) {
    try {
      await options?.diagnostics?.emit?.({
        level: "error",
        event: "command_registration_failed",
        message: "Failed to register bundled /loop command",
        hook: "config",
        command: "loop",
        operation: "register_loop_command",
        outcome: "failure",
        error,
      });
    } catch {
      /* diagnostics are best effort */
    }
    return { registered: false, reason: "failed" };
  }
}
