// NOTE: @opencode-ai/plugin is intentionally NOT imported at module top level. It is loaded lazily
// inside the factory (see `await import("@opencode-ai/plugin")` below) so that importing this entry
// — e.g. `import { LoopPlugin } from "./loop.js"` in a plugin-level test — does not pull opencode
// infrastructure into the module graph. The pure event-normalization and status helpers live in the
// opencode-free core, so tests reach them through a direct core import plus the factory's test
// properties rather than through anything that loads opencode.
import {
  DEFAULT_CAPS, buildIterationPrompt, bumpGeneration, clampDelaySeconds,
  createMonotonicClock, createRegistry, decideNextAction, getSessionID, isIdleEvent,
  normalizeEvent, parseLoopArgs, registerLoopCommand, resolveLoopCaps, sanitizeDisplayText,
  statusText,
} from "./loop-core.js";
import { createLoopDiagnostics } from "./diagnostics.js";

const monotonicNow = createMonotonicClock();
function now() { return monotonicNow(); }

function textPart(text, options = {}) {
  return {
    type: "text",
    text,
    synthetic: options.synthetic ?? true,
    ignored: options.ignored ?? false,
    metadata: { source: "loop-plugin", ...(options.metadata ?? {}) },
  };
}

// The visible "/loop ..." echo, ignored by the model.
function displayPart(input) {
  const args = sanitizeDisplayText(input.arguments).trim();
  return textPart(args ? `/${input.command} ${args}` : `/${input.command}`, {
    synthetic: false, ignored: true, metadata: { kind: "display" },
  });
}

async function toast(client, message, variant = "info") {
  try { await client.tui.showToast({ body: { title: "/loop", message, variant, duration: 5000 } }); }
  catch { /* best effort; transcript is the source of truth */ }
}

function safeGet(value, key) {
  try { return value?.[key]; }
  catch { return undefined; }
}

function readProperty(value, key) {
  try { return { ok: true, value: value?.[key] }; }
  catch (error) { return { ok: false, error }; }
}

function safeString(value, fallback = "error") {
  try {
    if (value === undefined || value === null || value === "") return fallback;
    return String(value);
  } catch {
    return fallback;
  }
}

function safeErrorName(error) {
  return safeString(safeGet(error, "name"), "error");
}

function safeErrorMessage(error) {
  const message = safeGet(error, "message");
  if (message !== undefined && message !== null && message !== "") return safeString(message, "error");
  return typeof error === "string" ? safeString(error, "error") : "error";
}

function safeEventType(event) {
  const type = safeGet(event, "type");
  if (type === undefined || type === null) return undefined;
  try { return String(type); }
  catch { return undefined; }
}

const NO_ACTIVE_DYNAMIC_LOOP_MESSAGE = "No active dynamic /loop in this session; schedule_wakeup has no effect.";

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
let activeHookInstances = 0;
const activeRuntimes = new Set();

function currentRuntime() {
  return activeRuntimes.values().next().value;
}

function clearLoopTimer(state) {
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.timerDueAt = null;
  state.pausedTimer = null;
}

function clearRegistryState() {
  for (const state of registry.all()) {
    clearLoopTimer(state);
    registry.stop(state.sessionID);
  }
}

class PromptAsyncTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`client.session.promptAsync timed out after ${timeoutMs}ms`);
    this.name = "PromptAsyncTimeoutError";
    this.code = "PROMPT_ASYNC_TIMEOUT";
  }
}

async function callPromptAsyncWithTimeout(promptAsync, sessionClient, request, timeoutMs) {
  if (timeoutMs <= 0) throw new PromptAsyncTimeoutError(0);
  let timeout;
  try {
    return await Promise.race([
      promptAsync.call(sessionClient, request),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new PromptAsyncTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// The @opencode-ai/sdk client.session.promptAsync call shape is not part of the stable
// @opencode-ai/plugin contract and may migrate from a v1 nested REST-style envelope
// (`{ path: { id }, query: { directory }, body }`) to a flat v2 envelope
// (`{ sessionID, directory, ...body }`). Probe an out-of-band shape hint before falling
// back to "v1" (today's shipped shape), so this call site can be steered to the new
// shape without an emergency patch once opencode ships it.
function loopSessionShape(ctx) {
  return ctx.__loopSessionShape ??
    ctx.client?.__loopSessionShape ??
    ctx.__workflowSessionShape ??
    ctx.client?.__workflowSessionShape ??
    "v1";
}

function buildPromptAsyncRequest(ctx, sessionID, parts) {
  return loopSessionShape(ctx) === "v2"
    ? { sessionID, directory: ctx.directory, parts }
    : { path: { id: sessionID }, query: { directory: ctx.directory }, body: { parts } };
}

export const LoopPlugin = async (ctx, options = {}) => {
  // Load the opencode tool helper lazily so that importing this entry never pulls
  // @opencode-ai/plugin into the module graph (see the top-of-file note). opencode awaits the
  // factory, so the tool definition is ready before any hook is invoked.
  const { tool } = await import("@opencode-ai/plugin");
  const diagnostics = createLoopDiagnostics(ctx);
  const { caps, warnings } = resolveLoopCaps(options);
  for (const warning of warnings) {
    await diagnostics.emit({
      level: "warn",
      event: "invalid_plugin_option",
      message: warning.message,
      operation: "resolve_plugin_options",
      outcome: "fallback",
      data: { field: warning.field },
    });
  }
  let disposed = false;
  let loopCommandRegistrationChecked = false;
  let loopCommandOwned = true;

  async function failPromptIteration(sessionID, state, generation, details) {
    if (registry.get(sessionID) !== state || state.generation !== generation) return;
    registry.stop(sessionID);
    await diagnostics.emit({
      level: "error",
      event: details.event,
      message: details.message,
      sessionID,
      operation: "fire_next_iteration",
      outcome: "failure",
      error: details.error,
      data: { generation },
    });
    await toast(ctx.client, details.toastMessage, "error");
  }

  async function fireNextIteration(sessionID) {
    const state = registry.get(sessionID);
    if (!state || state.status !== "running") return;
    bumpGeneration(state);
    state.awaitingIdle = false;
    state.iterationCount += 1;
    state.lastFireAt = now();
    const gen = state.generation;
    try {
      const promptAsync = ctx.client?.session?.promptAsync;
      if (typeof promptAsync !== "function") throw new TypeError("client.session.promptAsync is unavailable");
      const timeoutMs = Math.max(0, state.startedAt + state.caps.maxWallClockMs - now());
      const res = await callPromptAsyncWithTimeout(promptAsync, ctx.client.session, buildPromptAsyncRequest(
        ctx,
        sessionID,
        [textPart(buildIterationPrompt(state), { metadata: { kind: "loop-iteration", generation: gen } })],
      ), timeoutMs);
      if (res?.error) {
        await failPromptIteration(sessionID, state, gen, {
          event: "prompt_async_failed",
          message: "Loop stopped after promptAsync returned an error",
          error: res.error,
          toastMessage: `Loop stopped: re-prompt failed (${safeErrorName(res.error)}).`,
        });
        return;
      }
      if (registry.get(sessionID) !== state || state.generation !== gen || state.status !== "running") return;
      state.awaitingIdle = true;
    } catch (error) {
      await failPromptIteration(sessionID, state, gen, {
        event: "prompt_async_threw",
        message: "Loop stopped after promptAsync threw",
        error,
        toastMessage: `Loop stopped: ${safeErrorMessage(error)}`,
      });
    }
  }

  function reportTimerFailure(sessionID, error) {
    void diagnostics.emit({
      level: "error",
      event: "timer_callback_error",
      message: "Suppressed unexpected /loop timer callback error",
      sessionID,
      operation: "timer_callback",
      outcome: "failure",
      error,
    });
  }

  function armTimer(sessionID, state, delayMs, armedGen, handlers = {}) {
    const injectedHandlers = Object.keys(handlers).length > 0;
    state.timerDueAt = now() + delayMs;
    state.timer = setTimeout(() => {
      const s = registry.get(sessionID);
      if (s === state) {
        s.timer = null;
        s.timerDueAt = null;
      }
      if (!s || s.status !== "running" || s.generation !== armedGen) return;
      const runtime = injectedHandlers
        ? {
            applyAction: handlers.applyAction ?? applyAction,
            fireNextIteration: handlers.fireNextIteration ?? fireNextIteration,
            reportTimerFailure: handlers.reportTimerFailure ?? reportTimerFailure,
          }
        : currentRuntime();
      if (!runtime) return;
      if (now() - s.startedAt >= s.caps.maxWallClockMs) {
        void runtime.applyAction(sessionID, { kind: "terminate", reason: "max-wallclock" }).catch((error) => runtime.reportTimerFailure(sessionID, error));
        return;
      }
      void runtime.fireNextIteration(sessionID).catch((error) => runtime.reportTimerFailure(sessionID, error));
    }, delayMs);
  }

  function scheduleNextFire(sessionID, delayMs) {
    const state = registry.get(sessionID);
    if (!state) return;
    state.awaitingIdle = false;     // consume this idle; dedupe further idles for this generation
    state.pendingWakeup = null;     // dynamic mode must re-arm via schedule_wakeup each iteration
    clearLoopTimer(state);
    const armedGen = state.generation;
    armTimer(sessionID, state, delayMs, armedGen);
    void diagnostics.emit({
      level: "info",
      event: "wakeup_scheduled",
      message: "Scheduled next /loop iteration",
      sessionID,
      operation: "schedule_next_fire",
      outcome: "success",
      data: { delayMs, generation: armedGen, mode: state.mode },
    });
  }

  async function applyAction(sessionID, action) {
    const state = registry.get(sessionID);
    switch (action.kind) {
      case "ignore": return;
      case "schedule": scheduleNextFire(sessionID, action.delayMs); return;
      case "pause":
        if (state) {
          state.status = "paused"; state.pauseReason = action.reason;
          if (state.timer) {
            const remainingMs = Math.max(0, (state.timerDueAt ?? now()) - now());
            state.pausedTimer = { delayMs: remainingMs, generation: state.generation };
            clearTimeout(state.timer);
            state.timer = null;
            state.timerDueAt = null;
          }
          await diagnostics.emit({
            level: action.reason === "error" ? "error" : "warn",
            event: "loop_paused",
            message: `Loop paused: ${action.reason}`,
            sessionID,
            hook: "event",
            operation: "apply_action",
            outcome: action.reason === "error" ? "failure" : "blocked",
          });
        }
        return;
      case "resume":
        if (state) {
          const pausedTimer = state.pausedTimer;
          state.status = "running"; state.pauseReason = null;
          state.pausedTimer = null;
          if (pausedTimer && pausedTimer.generation === state.generation && !state.awaitingIdle && !state.timer) {
            armTimer(sessionID, state, pausedTimer.delayMs, pausedTimer.generation);
          }
          await diagnostics.emit({ level: "info", event: "loop_resumed", message: "Loop resumed", sessionID, hook: "event", operation: "apply_action", outcome: "success" });
        }
        return;
      case "terminate": {
        const removed = registry.stop(sessionID);
        clearLoopTimer(removed);
        await diagnostics.emit({
          level: action.reason === "completed" ? "info" : "warn",
          event: "loop_terminated",
          message: terminateMessage(action.reason, removed),
          sessionID,
          hook: "event",
          operation: "apply_action",
          outcome: action.reason,
        });
        await toast(ctx.client, terminateMessage(action.reason, removed), terminateVariant(action.reason));
        return;
      }
    }
  }

  // CRITICAL (spike finding A): mutate output.parts IN PLACE (splice), never reassign. opencode holds
  // a reference to the original array, so `output.parts = [...]` is silently dropped and the model
  // receives the raw commands/loop.md body instead.
  function outputParts(output) {
    if (!output || (typeof output !== "object" && typeof output !== "function")) {
      throw new TypeError("output must be an object");
    }
    const parts = output.parts;
    if (parts === undefined || parts === null) {
      const created = [];
      output.parts = created;
      return created;
    }
    if (!Array.isArray(parts) || typeof parts.splice !== "function") {
      throw new TypeError("output.parts must be an array");
    }
    return parts;
  }

  function replaceParts(output, ...parts) {
    const target = outputParts(output);
    target.splice(0, target.length, ...parts);
  }

  function hasHandledStop(output) {
    return outputParts(output).some((part) =>
      part?.metadata?.source === "loop-plugin" &&
      part?.metadata?.kind === "stop-result" &&
      part?.metadata?.outcome === "stopped");
  }

  async function handleLoopCommand(input, output) {
    const sessionID = input.sessionID;
    const intent = parseLoopArgs(input.arguments ?? "");
    if (intent.verb === "error") { replaceParts(output, displayPart(input), textPart(intent.message)); return; }
    if (intent.verb === "status") {
      // Toast as well as the turn: a status request leaves the auto-fire timer armed, so at fast
      // cadences the next iteration can race and override the status turn. The toast is race-free.
      const status = statusText(registry.get(sessionID), now());
      await toast(ctx.client, status, "info");
      replaceParts(output, displayPart(input), textPart(status));
      return;
    }
    if (intent.verb === "stop") {
      const removed = registry.stop(sessionID);
      if (!removed && hasHandledStop(output)) {
        await diagnostics.emit({ level: "info", event: "loop_stop_duplicate", message: "Ignored duplicate stop after an active loop was already stopped", sessionID, command: "loop", operation: "handle_loop_command", outcome: "skipped" });
        return;
      }
      clearLoopTimer(removed);
      await diagnostics.emit({ level: "info", event: "loop_stopped", message: removed ? "Loop stopped by command" : "Stop requested with no active loop", sessionID, command: "loop", operation: "handle_loop_command", outcome: removed ? "success" : "skipped" });
      await toast(ctx.client, removed ? "Loop stopped." : "No active loop.", "info");
      replaceParts(
        output,
        displayPart(input),
        textPart(removed ? "Stopped the active /loop." : "No active /loop in this session.", {
          metadata: { kind: "stop-result", outcome: removed ? "stopped" : "no-active" },
        }),
      );
      return;
    }
    // start: replace any existing loop, then make THIS turn iteration 1
    if (intent.mode === "fixed" && intent.intervalMs >= caps.maxWallClockMs) {
      const minutes = Math.round(caps.maxWallClockMs / 60_000);
      replaceParts(
        output,
        displayPart(input),
        textPart(`Choose an interval under ${minutes} minutes so at least one follow-up iteration can fit within the /loop time limit.`),
      );
      return;
    }
    const existing = registry.stop(sessionID);
    clearLoopTimer(existing);
    const state = registry.start(sessionID, {
      mode: intent.mode, intervalMs: intent.intervalMs ?? null,
      loopPrompt: intent.prompt, startedAt: now(), caps,
    });
    const label = intent.mode === "fixed" ? `fixed, ${Math.round(intent.intervalMs / 1000)}s` : "dynamic";
    await toast(ctx.client, `Loop started (${label}).`, "success");
    await diagnostics.emit({
      level: "info",
      event: "loop_started",
      message: `Loop started (${label})`,
      sessionID,
      command: "loop",
      operation: "handle_loop_command",
      outcome: "success",
      data: { mode: state.mode, intervalMs: state.intervalMs },
    });
    replaceParts(output, displayPart(input), textPart(buildIterationPrompt(state)));
  }

  const hooks = {
    // The event hook is fire-and-forget: opencode does not await it (AGENTS.md), so any unexpected
    // rejection becomes an unhandled promise rejection. Internal helpers (toast, diagnostics.emit)
    // already catch their own errors, but a top-level guard ensures no code path can ever throw out
    // of this handler.
    event: async (input) => {
      let event;
      try {
        event = input?.event;
        const sessionID = getSessionID(event);
        if (typeof sessionID !== "string" || !registry.has(sessionID)) return;
        const norm = normalizeEvent(event);
        if (norm.kind === "other") return;
        await applyAction(sessionID, decideNextAction(registry.get(sessionID), norm, now()));
      } catch (error) {
        await diagnostics.emit({
          level: "error",
          event: "event_hook_error",
          message: "Suppressed unexpected /loop event hook error",
          hook: "event",
          operation: "event_hook",
          outcome: "failure",
          error,
          data: { eventType: safeEventType(event) },
        });
      }
    },
  };

  hooks.config = async (cfg) => {
    const result = await registerLoopCommand(cfg, import.meta.dirname, { diagnostics });
    loopCommandRegistrationChecked = true;
    loopCommandOwned = result.registered;
  };

  hooks["command.execute.before"] = async (input, output) => {
    let command;
    try {
      command = input?.command;
      if (command !== "loop") return;
      if (loopCommandRegistrationChecked && !loopCommandOwned) {
        void diagnostics.emit({
          level: "info",
          event: "loop_command_not_owned",
          message: "Skipped /loop interception because another command definition already exists",
          command: "loop",
          hook: "command.execute.before",
          operation: "handle_loop_command",
          outcome: "skipped",
        });
        return;
      }
      outputParts(output);
      await handleLoopCommand(input, output);
    } catch (error) {
      await diagnostics.emit({
        level: "error",
        event: "command_hook_error",
        message: "Suppressed unexpected /loop command hook error",
        command: safeString(command, undefined),
        hook: "command.execute.before",
        operation: "handle_loop_command",
        outcome: "failure",
        error,
      });
    }
  };

  hooks.tool = {
    schedule_wakeup: tool({
      description: `Continue the active /loop in THIS session: schedule the next iteration after delaySeconds (clamped to 60-3600). Call this only when the looped task should keep going. Finish your turn WITHOUT calling it to END the loop. No effect outside a dynamic /loop.`,
      args: {
        delaySeconds: tool.schema.number().describe("Seconds until the next loop iteration (clamped to 60-3600)."),
      },
      async execute(args, toolContext) {
        let sessionID;
        try {
          const sessionRead = readProperty(toolContext, "sessionID");
          if (!sessionRead.ok) throw sessionRead.error;
          sessionID = sessionRead.value;
          if (typeof sessionID !== "string") return NO_ACTIVE_DYNAMIC_LOOP_MESSAGE;
          const state = registry.get(sessionID);
          if (!state || state.mode !== "dynamic" || state.status !== "running") {
            return NO_ACTIVE_DYNAMIC_LOOP_MESSAGE;
          }
          const delayRead = readProperty(args, "delaySeconds");
          if (!delayRead.ok) throw delayRead.error;
          const secs = clampDelaySeconds(delayRead.value);
          state.pendingWakeup = { delaySeconds: secs, generation: state.generation };
          await diagnostics.emit({
            level: "info",
            event: "wakeup_requested",
            message: "Dynamic /loop wakeup requested",
            sessionID,
            tool: "schedule_wakeup",
            operation: "schedule_wakeup",
            outcome: "success",
            data: { delaySeconds: secs, generation: state.generation },
          });
          return `Loop will continue in ${secs}s after this turn ends.`;
        } catch (error) {
          await diagnostics.emit({
            level: "error",
            event: "schedule_wakeup_error",
            message: "Suppressed unexpected /loop schedule_wakeup tool error",
            sessionID: typeof sessionID === "string" ? sessionID : undefined,
            tool: "schedule_wakeup",
            operation: "schedule_wakeup",
            outcome: "failure",
            error,
          });
          return NO_ACTIVE_DYNAMIC_LOOP_MESSAGE;
        }
      },
    }),
  };

  const runtime = { applyAction, fireNextIteration, reportTimerFailure };

  // opencode may instantiate this factory more than once, so instance-local dispose cannot clear the
  // module-level singleton until all live hook objects have been disposed.
  hooks.dispose = () => {
    if (disposed) return;
    disposed = true;
    activeRuntimes.delete(runtime);
    activeHookInstances = activeRuntimes.size;
    if (activeRuntimes.size > 0) return;
    clearRegistryState();
  };

  // Test-only internals must NOT ride on the live Hooks object (opencode receives `hooks` verbatim).
  // Expose the per-instance closures on the factory function itself instead; each instantiation
  // overwrites this with its own closures, which is exactly what a test wants right after it calls
  // LoopPlugin(ctx). Mirrors the static LoopPlugin.__moduleTest below.
  LoopPlugin.__innerTest = { registry, fireNextIteration, scheduleNextFire, applyAction, armTimer, DEFAULT_CAPS };
  activeRuntimes.add(runtime);
  activeHookInstances = activeRuntimes.size;
  return hooks;
};

// The registry is a module-level singleton shared across instances, so tests must clear it between
// cases. A top-level beforeEach in the test file calls this.
function __resetRegistryForTests() {
  clearRegistryState();
  activeRuntimes.clear();
  activeHookInstances = 0;
}

// opencode boots EVERY exported function in a plugin module as a plugin (Object.values(module)),
// so this entrypoint must export ONLY LoopPlugin — exporting the helpers above made opencode call
// e.g. __resetRegistryForTests() as a plugin, which returns undefined and crashed PluginBoot with
// "undefined is not an object (evaluating 'N.event')". Test-only helpers ride on a property instead,
// keeping the module's single exported function.
LoopPlugin.__moduleTest = { normalizeEvent, isIdleEvent, getSessionID, statusText, __resetRegistryForTests };
