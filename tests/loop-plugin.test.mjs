import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { getSessionID, isIdleEvent, normalizeEvent, statusText } from "../loop-core.js";
import { createLoopDiagnostics, __test as diagnosticsTest } from "../diagnostics.js";
import * as loopModule from "../loop.js";
import { LoopPlugin } from "../loop.js";
// Pure event/status helpers come straight from the opencode-free core (the direct core import above).
// Importing the entry here only exposes the factory and its test-only properties (__innerTest /
// __moduleTest); because the entry loads @opencode-ai/plugin lazily inside the factory, this import
// does not pull opencode infrastructure into the test's module graph. Only the module-level registry
// reset — which is bound to the entry's singleton registry — comes from the factory property.
const { __resetRegistryForTests } = LoopPlugin.__moduleTest;

// The registry is a module-level singleton (robust against opencode's double-instantiation), so each
// test must start from a clean registry.
beforeEach(() => {
  __resetRegistryForTests();
  diagnosticsTest.clearDiagnosticsCache();
});

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

function deferred() {
  return Promise.withResolvers();
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function withDiagnosticsEnv(options, fn) {
  if (typeof options === "function") {
    fn = options;
    options = {};
  }
  const dir = await mkdtemp(options.prefix ?? path.join(os.tmpdir(), "loop-diagnostics-test-"));
  const root = options.rootName ? path.join(dir, options.rootName) : dir;
  const previous = process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR;
  const previousDisabled = process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
  process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = root;
  delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
  try {
    return await fn(root, dir);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR;
    else process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = previous;
    if (previousDisabled === undefined) delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
    else process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED = previousDisabled;
    await rm(dir, { recursive: true, force: true });
  }
}

async function diagnosticLines(root) {
  const projects = await readDirOrEmpty(root);
  const lines = [];
  for (const project of projects) {
    const pluginDir = path.join(root, project, "loop");
    for (const file of await readDirOrEmpty(pluginDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const content = await readFile(path.join(pluginDir, file), "utf8");
      lines.push(...content.trim().split(/\r?\n/).filter(Boolean));
    }
  }
  return lines;
}

async function readDirOrEmpty(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("loop diagnostics emit standardized redacted JSONL", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const diagnostics = createLoopDiagnostics({ directory: "/tmp/x" });
    const bearer = `Bearer ${"abcdefghijklmnop"}`;
    await diagnostics.emit({
      level: "error",
      event: "prompt_async_failed",
      message: `Failed with ${bearer}`,
      sessionID: "ses_1",
      command: "loop",
      error: new Error("token=abc123456789"),
      data: { apiKey: "sk-secretsecretsecret123" },
    });
    const lines = await diagnosticLines(diagRoot);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.schema, "opencode.plugin.diagnostic.v1");
    assert.equal(record.plugin, "loop");
    assert.equal(record.level, "error");
    assert.equal(record.event, "prompt_async_failed");
    assert.equal(record.message, "Failed with Bearer <redacted>");
    assert.equal(record.sessionID, "ses_1");
    assert.equal(record.command, "loop");
    assert.deepStrictEqual(record.error, { name: "Error", message: "token=<redacted>" });
    assert.equal(record.data.apiKey, "[redacted]");
    assert.doesNotMatch(lines[0], /abcdefghijklmnop|abc123456789|secretsecretsecret/);
  });
});

test("diagnostics redacts compound keys and common credential formats", () => {
  const slack = ["xoxb", "111111111111", "222222222222", "333333333333"].join("-");
  const jwt = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join(".");
  const awsAccess = `AKIA${"IOSFODNN7EXAMPLE"}`;
  const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const gcp = `AI${"za"}${"Sy"}${"B".repeat(33)}`;
  const stripe = `sk_${"live"}_${"51H8secretsecretsecret"}`;
  const npm = `npm_${"abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"}`;
  const databasePassword = "supersecret";
  const mysqlPassword = "mysqlsecret";
  const cookieSecret = "cookie-session-secret-123456";
  const setCookieSecret = "set-cookie-secret-123456";
  const freeSessionSecret = "free-session-secret-123456";
  const input = {
    authorizationHeader: "opaqueauthorization123456",
    apiKeyValue: "plainkey123456",
    secretConfig: { nested: "plainsecret123456" },
    userApiKey: "plainuserapikey123456",
    idToken: "plainidtoken123456",
    slack,
    jwt,
    awsAccess,
    awsSecretAccessKey: awsSecret,
    gcp,
    stripe,
    npm,
    databaseUrl: `postgres://alice:${databasePassword}@localhost/db`,
    mysqlUrl: `mysql://alice:${mysqlPassword}@localhost/db`,
    cookieHeader: `Cookie: session=${cookieSecret}; theme=light`,
    setCookieHeader: `Set-Cookie: connect.sid=${setCookieSecret}; Path=/; HttpOnly`,
    freeTextSession: `request failed with session=${freeSessionSecret}`,
  };

  const redacted = diagnosticsTest.redactValue(input);
  assert.equal(redacted.authorizationHeader, "[redacted]");
  assert.equal(redacted.apiKeyValue, "[redacted]");
  assert.equal(redacted.secretConfig, "[redacted]");
  assert.equal(redacted.userApiKey, "[redacted]");
  assert.equal(redacted.idToken, "[redacted]");
  assert.equal(redacted.awsSecretAccessKey, "[redacted]");
  const json = JSON.stringify(redacted);
  const secrets = [
    input.authorizationHeader,
    input.apiKeyValue,
    input.secretConfig.nested,
    input.userApiKey,
    input.idToken,
    ...slack.split("-").slice(1),
    jwt.split(".")[0],
    awsAccess,
    awsSecret.slice(0, 10),
    gcp.slice(0, 6),
    "51H8secret",
    npm.slice(4),
    databasePassword,
    mysqlPassword,
    cookieSecret,
    setCookieSecret,
    freeSessionSecret,
  ];
  assert.doesNotMatch(json, new RegExp(secrets.map(escapeRegExp).join("|")));
});

test("diagnostics redaction preserves shared acyclic objects and detects true cycles", () => {
  const shared = { detail: "same-object" };
  const redacted = diagnosticsTest.redactValue({ first: shared, second: shared });
  assert.deepStrictEqual(redacted, {
    first: { detail: "same-object" },
    second: { detail: "same-object" },
  });

  const cycle = { name: "cycle" };
  cycle.self = cycle;
  assert.deepStrictEqual(diagnosticsTest.redactValue(cycle), { name: "cycle", self: "[circular]" });
});

test("diagnostics redaction handles hostile object enumeration", () => {
  const hostile = new Proxy({}, {
    ownKeys() {
      throw new Error("cannot enumerate");
    },
  });
  assert.equal(diagnosticsTest.redactValue(hostile), "[uninspectable]");

  const hostileArray = new Proxy([], {
    get(target, prop, receiver) {
      if (prop === "slice") throw new Error("cannot slice");
      return Reflect.get(target, prop, receiver);
    },
  });
  assert.equal(diagnosticsTest.redactValue(hostileArray), "[uninspectable]");
});

test("diagnostics bounds long strings, arrays, and object entries", () => {
  const long = diagnosticsTest.redactText("x".repeat(4_050));
  assert.match(long, /\[truncated 50 chars\]$/);
  assert.equal(long.length, 4_021);

  const array = diagnosticsTest.redactValue(Array.from({ length: 105 }, (_value, index) => index));
  assert.equal(array.length, 101);
  assert.equal(array.at(-1), "[5 more items]");

  const object = Object.fromEntries(Array.from({ length: 105 }, (_value, index) => [`k${index}`, index]));
  const redacted = diagnosticsTest.redactValue(object);
  assert.equal(Object.keys(redacted).length, 101);
  assert.equal(redacted.__truncated_entries, "more");
});

test("loop diagnostics are no-op on disabled and invalid storage", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED = "1";
    await createLoopDiagnostics({ directory: "/tmp/x" }).emit({ level: "error", event: "disabled", message: "disabled" });
    assert.deepStrictEqual(await diagnosticLines(diagRoot), []);

    delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
    const fileRoot = path.join(diagRoot, "not-a-directory");
    await writeFile(fileRoot, "x", "utf8");
    process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = fileRoot;
    await assert.doesNotReject(() => createLoopDiagnostics({ directory: "/tmp/x" }).emit({ level: "error", event: "bad_storage", message: "bad" }));
  });
});

test("loop diagnostics are module-level per project/root and retry after storage recovers", async () => {
  await withDiagnosticsEnv({
    prefix: path.join(os.tmpdir(), "loop-diagnostics-retry-"),
    rootName: "diagnostics-root",
  }, async (root) => {
    await writeFile(root, "not a directory", "utf8");
    const first = createLoopDiagnostics({ directory: "/tmp/x" });
    const second = createLoopDiagnostics({ directory: "/tmp/x" });
    assert.equal(first, second);

    await first.emit({ level: "error", event: "expected_failure", message: "cannot write yet" });
    await rm(root, { force: true });
    await second.emit({ level: "info", event: "storage_recovered", message: "ok" });

    const records = (await diagnosticLines(root)).map((line) => JSON.parse(line));
    assert.deepStrictEqual(records.map((record) => record.event), ["storage_recovered"]);
  });
});

test("loop diagnostics key symlinked and real project paths to one directory", async (t) => {
  await withDiagnosticsEnv({ rootName: "diagnostics-root" }, async (diagRoot, tmpRoot) => {
    const realProject = path.join(tmpRoot, "project-real");
    const linkProject = path.join(tmpRoot, "project-link");
    await mkdir(realProject);
    try {
      await symlink(realProject, linkProject, "dir");
    } catch {
      t.skip("directory symlink unavailable");
      return;
    }

    await createLoopDiagnostics({ directory: realProject }).emit({ level: "info", event: "real_path" });
    await createLoopDiagnostics({ directory: linkProject }).emit({ level: "info", event: "link_path" });

    const projects = await readDirOrEmpty(diagRoot);
    assert.equal(projects.length, 1);
    const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
    assert.deepStrictEqual(records.map((record) => record.event).sort(), ["link_path", "real_path"]);
  });
});

test("diagnostics rotate by size cap", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const diagnostics = createLoopDiagnostics({ directory: "/tmp/x", maxFileBytes: 700 });
    await diagnostics.emit({ level: "info", event: "first", data: { blob: "a".repeat(320) } });
    await diagnostics.emit({ level: "info", event: "second", data: { blob: "b".repeat(320) } });
    const projects = await readdir(diagRoot);
    const files = await readdir(path.join(diagRoot, projects[0], "loop"));
    assert.equal(files.filter((file) => file.endsWith(".jsonl")).length, 2);
  });
});

test("diagnostics serialize concurrent rotation by size cap", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const diagnostics = createLoopDiagnostics({ directory: "/tmp/x", maxFileBytes: 700 });
    await Promise.all([
      diagnostics.emit({ level: "info", event: "first", data: { blob: "a".repeat(320) } }),
      diagnostics.emit({ level: "info", event: "second", data: { blob: "b".repeat(320) } }),
    ]);

    const projects = await readdir(diagRoot);
    const files = await readdir(path.join(diagRoot, projects[0], "loop"));
    assert.equal(files.filter((file) => file.endsWith(".jsonl")).length, 2);
  });
});

test("diagnostics emits a bounded fallback when non-data fields exceed the record cap", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const diagnostics = createLoopDiagnostics({ directory: "/tmp/x" });
    const long = "x".repeat(10_000);
    await diagnostics.emit({
      level: "info",
      event: long,
      message: long,
      sessionID: long,
      command: long,
      operation: long,
      data: { blob: long },
    });

    const [line] = await diagnosticLines(diagRoot);
    assert.ok(line.length + 1 <= 16_000);
    const record = JSON.parse(line);
    assert.equal(record.event, "diagnostic_record_omitted");
    assert.equal(record.data, "[omitted: record too large]");
  });
});

test("diagnostics omits bulky data when that is enough to fit the record cap", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const diagnostics = createLoopDiagnostics({ directory: "/tmp/x" });
    const data = Object.fromEntries(
      Array.from({ length: 20 }, (_value, index) => [`k${index}`, "x".repeat(4_000)]),
    );
    await diagnostics.emit({
      level: "info",
      event: "oversized_data",
      message: "small metadata",
      data,
    });

    const [line] = await diagnosticLines(diagRoot);
    assert.ok(line.length + 1 <= 16_000);
    const record = JSON.parse(line);
    assert.equal(record.event, "oversized_data");
    assert.equal(record.data, "[omitted: record too large]");
  });
});

test("diagnosticsRoot uses platform state dirs and validates env roots", () => {
  assert.equal(
    diagnosticsTest.diagnosticsRoot({
      platform: "linux",
      env: { OPENCODE_PLUGIN_DIAGNOSTICS_DIR: "relative", XDG_STATE_HOME: "also-relative" },
      homedir: "/home/me",
    }),
    "/home/me/.local/state/opencode/plugin-diagnostics",
  );
  assert.equal(
    diagnosticsTest.diagnosticsRoot({
      platform: "linux",
      env: { OPENCODE_PLUGIN_DIAGNOSTICS_DIR: "~/loop-diag" },
      homedir: "/home/me",
    }),
    "/home/me/loop-diag",
  );
  assert.equal(
    diagnosticsTest.diagnosticsRoot({
      platform: "linux",
      env: { XDG_STATE_HOME: "/state" },
      homedir: "/home/me",
    }),
    "/state/opencode/plugin-diagnostics",
  );
  assert.equal(
    diagnosticsTest.diagnosticsRoot({
      platform: "darwin",
      env: {},
      homedir: "/Users/me",
    }),
    "/Users/me/Library/Application Support/opencode/plugin-diagnostics",
  );
  assert.equal(
    diagnosticsTest.diagnosticsRoot({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      homedir: "C:\\Users\\me",
    }),
    "C:\\Users\\me\\AppData\\Local\\opencode\\plugin-diagnostics",
  );
  assert.equal(diagnosticsTest.shouldHardenPermissions("linux"), true);
  assert.equal(diagnosticsTest.shouldHardenPermissions("win32"), false);
});

test("loop diagnostics harden POSIX directory and file modes", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits are not meaningful on Windows");
    return;
  }
  await withDiagnosticsEnv(async (diagRoot) => {
    const diagnostics = createLoopDiagnostics({ directory: "/tmp/x" });
    await diagnostics.emit({ level: "info", event: "permissions_check" });

    const [project] = await readDirOrEmpty(diagRoot);
    const pluginDir = path.join(diagRoot, project, "loop");
    const [file] = (await readDirOrEmpty(pluginDir)).filter((entry) => entry.endsWith(".jsonl"));

    assert.equal((await stat(pluginDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(pluginDir, file))).mode & 0o777, 0o600);
  });
});

test("module exports exactly one plugin factory and hooks expose no test-only keys", async () => {
  assert.deepStrictEqual(Object.keys(loopModule), ["LoopPlugin"]);
  assert.deepStrictEqual(Object.values(loopModule), [LoopPlugin]);

  const hooks = await pluginFor({});
  assert.deepStrictEqual(Object.keys(hooks).sort(), ["command.execute.before", "config", "dispose", "event", "tool"]);
  assert.equal(Object.hasOwn(hooks, "__test"), false);
  assert.equal(Object.hasOwn(hooks, "__innerTest"), false);
});

test("promptAsync errors emit a diagnostic and stop the loop", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const calls = { prompts: [], toasts: [] };
    const hooks = await LoopPlugin({
      directory: "/tmp/x",
      client: {
        tui: { showToast: async ({ body }) => { calls.toasts.push(body); } },
        session: { promptAsync: async (req) => { calls.prompts.push(req); return { error: { name: "Boom", message: "token=abc123456789" } }; } },
      },
    });
    LoopPlugin.__innerTest.registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
    await LoopPlugin.__innerTest.fireNextIteration("s1");
    assert.equal(LoopPlugin.__innerTest.registry.has("s1"), false);
    const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.event === "prompt_async_failed" && record.sessionID === "s1"));
    assert.doesNotMatch(JSON.stringify(records), /abc123456789/);
  });
});

test("missing promptAsync emits a diagnostic and stops the loop", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const calls = { toasts: [] };
    await LoopPlugin({
      directory: "/tmp/x",
      client: {
        tui: { showToast: async ({ body }) => { calls.toasts.push(body); } },
        session: {},
      },
    });
    const { registry, fireNextIteration } = LoopPlugin.__innerTest;
    registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
    await fireNextIteration("s1");

    assert.equal(registry.has("s1"), false);
    assert.match(calls.toasts.at(-1).message, /promptAsync is unavailable/);
    const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.event === "prompt_async_threw" && record.sessionID === "s1"));
  });
});

test("promptAsync timeout stops a loop when dispatch never settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = { prompts: [], toasts: [] };
  await LoopPlugin({
    directory: "/tmp/x",
    client: {
      tui: { showToast: async ({ body }) => { calls.toasts.push(body); } },
      session: {
        promptAsync: async (req) => {
          calls.prompts.push(req);
          return Promise.withResolvers().promise;
        },
      },
    },
  });
  const { registry, fireNextIteration, DEFAULT_CAPS } = LoopPlugin.__innerTest;
  registry.start("s1", {
    mode: "fixed",
    intervalMs: 30_000,
    loopPrompt: "go",
    startedAt: Date.now() - DEFAULT_CAPS.maxWallClockMs + 5_000,
  });

  const fire = fireNextIteration("s1");
  assert.equal(calls.prompts.length, 1);
  t.mock.timers.tick(6_000);
  await fire;

  assert.equal(registry.has("s1"), false);
  assert.match(calls.toasts.at(-1).message, /timed out/);
  assert.equal(calls.toasts.at(-1).variant, "error");
});

test("stale promptAsync errors cannot stop a replacement loop", async () => {
  const pending = deferred();
  const calls = { prompts: [], toasts: [] };
  await LoopPlugin({
    directory: "/tmp/x",
    client: {
      tui: { showToast: async ({ body }) => { calls.toasts.push(body); } },
      session: { promptAsync: async (req) => { calls.prompts.push(req); return pending.promise; } },
    },
  });
  const { registry, fireNextIteration } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "old", startedAt: Date.now() });
  const fire = fireNextIteration("s1");
  assert.equal(calls.prompts.length, 1);

  registry.stop("s1");
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "new", startedAt: 1 });
  pending.resolve({ error: { name: "OldPromptFailed" } });
  await fire;

  assert.equal(registry.has("s1"), true);
  assert.equal(registry.get("s1").loopPrompt, "new");
  assert.equal(calls.toasts.length, 0);
});

test("stale promptAsync success cannot mutate a replacement loop", async () => {
  const pending = deferred();
  const calls = { prompts: [], toasts: [] };
  await LoopPlugin({
    directory: "/tmp/x",
    client: {
      tui: { showToast: async ({ body }) => { calls.toasts.push(body); } },
      session: { promptAsync: async (req) => { calls.prompts.push(req); return pending.promise; } },
    },
  });
  const { registry, fireNextIteration } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "old", startedAt: Date.now() });
  const fire = fireNextIteration("s1");
  assert.equal(calls.prompts.length, 1);

  registry.stop("s1");
  const replacement = registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "new", startedAt: Date.now() });
  replacement.awaitingIdle = false;
  pending.resolve({});
  await fire;

  assert.equal(registry.get("s1"), replacement);
  assert.equal(replacement.awaitingIdle, false);
  assert.equal(calls.toasts.length, 0);
});

test("promptAsync success while permission-paused does not mark the loop awaiting idle", async () => {
  const pending = deferred();
  const calls = { prompts: [], toasts: [] };
  const hooks = await LoopPlugin({
    directory: "/tmp/x",
    client: {
      tui: { showToast: async ({ body }) => { calls.toasts.push(body); } },
      session: { promptAsync: async (req) => { calls.prompts.push(req); return pending.promise; } },
    },
  });
  const { registry, fireNextIteration } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  const fire = fireNextIteration("s1");
  assert.equal(calls.prompts.length, 1);

  await hooks.event({ event: { type: "permission.asked", properties: { sessionID: "s1" } } });
  assert.equal(registry.get("s1").status, "paused");
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  pending.resolve({});
  await fire;

  assert.equal(registry.get("s1").status, "paused");
  assert.equal(registry.get("s1").awaitingIdle, false);
});

test("promptAsync hostile error values do not reject from failure handling", async () => {
  const calls = { prompts: [], toasts: [] };
  const hostileReturned = {};
  Object.defineProperty(hostileReturned, "name", {
    enumerable: true,
    get() { throw new Error("name getter boom"); },
  });
  let mode = "return";
  await LoopPlugin({
    directory: "/tmp/x",
    client: {
      tui: { showToast: async ({ body }) => { calls.toasts.push(body); } },
      session: {
        promptAsync: async (req) => {
          calls.prompts.push(req);
          if (mode === "throw") {
            const hostileThrown = {};
            Object.defineProperty(hostileThrown, "message", {
              enumerable: true,
              get() { throw new Error("message getter boom"); },
            });
            throw hostileThrown;
          }
          return { error: hostileReturned };
        },
      },
    },
  });
  const { registry, fireNextIteration } = LoopPlugin.__innerTest;

  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await assert.doesNotReject(() => fireNextIteration("s1"));
  assert.equal(registry.has("s1"), false);
  assert.match(calls.toasts.at(-1).message, /re-prompt failed \(error\)/);

  mode = "throw";
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await assert.doesNotReject(() => fireNextIteration("s1"));
  assert.equal(registry.has("s1"), false);
  assert.match(calls.toasts.at(-1).message, /Loop stopped: error/);
});

test("promptAsync hostile response inspection stops the loop cleanly", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const calls = { prompts: [], toasts: [] };
    const hostileResponse = {};
    Object.defineProperty(hostileResponse, "error", {
      get() { throw new Error("response getter boom token=abc123456789"); },
    });
    await LoopPlugin({
      directory: "/tmp/x",
      client: {
        tui: { showToast: async ({ body }) => { calls.toasts.push(body); } },
        session: { promptAsync: async (req) => { calls.prompts.push(req); return hostileResponse; } },
      },
    });
    const { registry, fireNextIteration } = LoopPlugin.__innerTest;
    registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });

    await assert.doesNotReject(() => fireNextIteration("s1"));

    assert.equal(registry.has("s1"), false);
    assert.match(calls.toasts.at(-1).message, /response getter boom/);
    const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.event === "prompt_async_threw" && record.sessionID === "s1"));
    assert.doesNotMatch(JSON.stringify(records), /abc123456789/);
  });
});

test("normalizeEvent maps raw event types", () => {
  assert.equal(normalizeEvent({ type: "session.idle" }).kind, "idle");
  assert.equal(normalizeEvent({ type: "session.error" }).kind, "error");
  assert.equal(normalizeEvent({ type: "permission.asked" }).kind, "permissionAsked");
  assert.equal(normalizeEvent({ type: "permission.updated" }).kind, "permissionAsked");
  assert.equal(normalizeEvent({ type: "permission.replied", properties: { reply: "deny" } }).rejected, true);
  assert.equal(normalizeEvent({ type: "session.deleted" }).kind, "sessionTeardown");
  assert.equal(normalizeEvent({ type: "message.updated" }).kind, "other");
  assert.equal(getSessionID({ properties: { sessionID: "s1" } }), "s1");
  assert.equal(getSessionID({ type: "session.deleted", properties: { info: { id: "s2" } } }), "s2");
  assert.equal(isIdleEvent({ type: "session.status", properties: { status: { type: "idle" } } }), true);
});

test("fireNextIteration re-injects the iteration prompt and bumps generation", async () => {
  const calls = {};
  const hooks = await pluginFor(calls);
  const { registry, fireNextIteration } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "do x", startedAt: Date.now() });
  await fireNextIteration("s1");
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].path.id, "s1");
  assert.equal(calls.prompts[0].body.parts[0].text, "do x");
  const s = registry.get("s1");
  assert.equal(s.generation, 2);
  assert.equal(s.iterationCount, 2);
  assert.equal(s.awaitingIdle, true);
});

test("fireNextIteration uses the flat v2 promptAsync envelope when the shape hint says v2", async () => {
  const calls = {};
  const hooks = await LoopPlugin({
    directory: "/tmp/x",
    __loopSessionShape: "v2",
    client: fakeClient(calls),
  });
  const { registry, fireNextIteration } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "do x", startedAt: Date.now() });
  await fireNextIteration("s1");
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].path, undefined);
  assert.equal(calls.prompts[0].query, undefined);
  assert.equal(calls.prompts[0].body, undefined);
  assert.equal(calls.prompts[0].sessionID, "s1");
  assert.equal(calls.prompts[0].directory, "/tmp/x");
  assert.equal(calls.prompts[0].parts[0].text, "do x");
});

test("event idle schedules and fires the next iteration after the interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  LoopPlugin.__innerTest.registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(calls.prompts.length, 0);              // scheduled, not yet fired
  t.mock.timers.tick(30_000);
  await flushAsyncWork();                             // flush the async fire
  assert.equal(calls.prompts.length, 1);
  assert.equal(LoopPlugin.__innerTest.registry.get("s1").awaitingIdle, true);
});

test("idle delivered while promptAsync is in flight is ignored until dispatch resolves", async () => {
  const pending = deferred();
  const calls = { prompts: [], toasts: [] };
  const hooks = await LoopPlugin({
    directory: "/tmp/x",
    client: {
      tui: { showToast: async ({ body }) => { calls.toasts.push(body); } },
      session: { promptAsync: async (req) => { calls.prompts.push(req); return pending.promise; } },
    },
  });
  const { registry, fireNextIteration } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "dynamic", intervalMs: null, loopPrompt: "go", startedAt: Date.now() });

  const fire = fireNextIteration("s1");
  assert.equal(registry.get("s1").awaitingIdle, false);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(registry.has("s1"), true, "stray idle must not complete the dynamic loop");

  pending.resolve({});
  await fire;
  assert.equal(registry.get("s1").awaitingIdle, true);

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(registry.has("s1"), false, "post-dispatch idle can complete the loop normally");
  assert.match(calls.toasts.at(-1).message, /Loop complete/);
  assert.equal(calls.toasts.at(-1).variant, "success");
});

test("timer callback enforces wall-clock cap before firing another prompt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  await pluginFor(calls);
  const { registry, scheduleNextFire, DEFAULT_CAPS } = LoopPlugin.__innerTest;
  registry.start("s1", {
    mode: "fixed",
    intervalMs: 30_000,
    loopPrompt: "go",
    startedAt: Date.now() - DEFAULT_CAPS.maxWallClockMs,
  });

  scheduleNextFire("s1", 1);
  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(registry.has("s1"), false);
  assert.equal(calls.prompts.length, 0);
});

test("timer callback reports fireNextIteration and terminate-action rejections", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pluginFor({});
  const { registry, armTimer, DEFAULT_CAPS } = LoopPlugin.__innerTest;
  const failures = [];

  const fireState = registry.start("fire", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  armTimer("fire", fireState, 1, fireState.generation, {
    fireNextIteration: async () => { throw new Error("fire failed"); },
    reportTimerFailure: (sessionID, error) => { failures.push({ sessionID, message: error.message }); },
  });
  t.mock.timers.tick(1);
  await Promise.resolve();

  const terminateState = registry.start("terminate", {
    mode: "fixed",
    intervalMs: 30_000,
    loopPrompt: "go",
    startedAt: Date.now() - DEFAULT_CAPS.maxWallClockMs,
  });
  armTimer("terminate", terminateState, 1, terminateState.generation, {
    applyAction: async () => { throw new Error("terminate failed"); },
    reportTimerFailure: (sessionID, error) => { failures.push({ sessionID, message: error.message }); },
  });
  t.mock.timers.tick(1);
  await Promise.resolve();

  assert.deepStrictEqual(failures, [
    { sessionID: "fire", message: "fire failed" },
    { sessionID: "terminate", message: "terminate failed" },
  ]);
});

test("permission resume re-arms a wakeup timer that was paused after idle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  const { registry } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(registry.get("s1").awaitingIdle, false);
  assert.ok(registry.get("s1").timer, "timer is armed before permission pause");

  await hooks.event({ event: { type: "permission.asked", properties: { sessionID: "s1" } } });
  assert.equal(registry.get("s1").status, "paused");
  assert.equal(registry.get("s1").timer, null);
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  assert.equal(calls.prompts.length, 0, "permission pause prevents timer-driven prompts");

  await hooks.event({ event: { type: "permission.replied", properties: { sessionID: "s1", reply: "allow" } } });
  assert.equal(registry.get("s1").status, "running");
  assert.ok(registry.get("s1").timer, "timer is re-armed on permission resume");
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(calls.prompts.length, 1);
});

test("session.error pauses an armed loop until explicit stop or restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  const { registry } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.ok(registry.get("s1").timer, "timer is armed before session error");

  await hooks.event({ event: { type: "session.error", properties: { sessionID: "s1" } } });
  assert.equal(registry.get("s1").status, "paused");
  assert.equal(registry.get("s1").pauseReason, "error");
  assert.equal(registry.get("s1").timer, null);
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  assert.equal(calls.prompts.length, 0, "error pause prevents timer-driven prompts");

  await hooks.event({ event: { type: "permission.replied", properties: { sessionID: "s1", reply: "allow" } } });
  assert.equal(registry.get("s1").status, "paused", "permission replies do not resume sticky error pauses");
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  assert.equal(calls.prompts.length, 0);
});

test("permission rejection stops a paused armed loop and clears its timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  const { registry } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  const state = registry.get("s1");
  assert.ok(state.timer, "timer is armed before permission rejection");

  await hooks.event({ event: { type: "permission.asked", properties: { sessionID: "s1" } } });
  await hooks.event({ event: { type: "permission.replied", properties: { sessionID: "s1", reply: "deny" } } });

  assert.equal(registry.has("s1"), false);
  assert.equal(state.timer, null);
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  assert.equal(calls.prompts.length, 0);
  assert.match(calls.toasts.at(-1).message, /Loop stopped/);
});

test("recursion guard: a duplicate idle after scheduling is ignored", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  LoopPlugin.__innerTest.registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } }); // awaitingIdle now false -> ignored
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(calls.prompts.length, 1);              // exactly one fire, not two
});

test("double-instantiated hooks absorb the same idle event once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const firstCalls = {};
  const secondCalls = {};
  const firstHooks = await pluginFor(firstCalls);
  const secondHooks = await pluginFor(secondCalls);
  const { registry } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  const idle = { type: "session.idle", properties: { sessionID: "s1" } };

  await firstHooks.event({ event: idle });
  await secondHooks.event({ event: idle });
  t.mock.timers.tick(30_000);
  await flushAsyncWork();

  assert.equal(firstCalls.prompts.length + secondCalls.prompts.length, 1);
  assert.equal(registry.get("s1").awaitingIdle, true);
});

test("events for an untracked session are ignored", async () => {
  const calls = {};
  const hooks = await pluginFor(calls);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "unknown" } } });
  assert.equal(calls.prompts.length, 0);
});

test("session teardown removes loop state and clears an active timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  const { registry } = LoopPlugin.__innerTest;
  const state = registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.ok(state.timer, "timer is armed before teardown");

  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
  assert.equal(registry.has("s1"), false);
  assert.equal(state.timer, null);
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(calls.prompts.length, 0);
});

test("event hook emits diagnostics for suppressed unexpected errors", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const hooks = await LoopPlugin({
      directory: "/tmp/x",
      client: { tui: { showToast: async () => {} }, session: { promptAsync: async () => ({}) } },
    });
    await assert.doesNotReject(() => hooks.event({
      event: {
        type: "session.idle",
        get properties() { throw new Error("getter boom token=abc123456789"); },
      },
    }));
    const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
    assert.ok(records.some((record) =>
      record.event === "event_hook_error" &&
      record.data.eventType === "session.idle"));
    assert.doesNotMatch(JSON.stringify(records), /abc123456789/);
  });
});

test("event hook catches malformed hook payload before reading event", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const hooks = await LoopPlugin({
      directory: "/tmp/x",
      client: { tui: { showToast: async () => {} }, session: { promptAsync: async () => ({}) } },
    });
    await assert.doesNotReject(() => hooks.event({
      get event() { throw new Error("event getter boom token=abc123456789"); },
    }));
    const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.event === "event_hook_error"));
    assert.doesNotMatch(JSON.stringify(records), /abc123456789/);
  });
});

test("max-iterations terminates with a toast", async () => {
  const calls = {};
  const hooks = await pluginFor(calls);
  const s = LoopPlugin.__innerTest.registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  s.iterationCount = s.caps.maxIterations;
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(LoopPlugin.__innerTest.registry.has("s1"), false);
  assert.match(calls.toasts.at(-1).message, /50 iterations/);
  assert.equal(calls.toasts.at(-1).variant, "warning");
});

test("showToast rejection does not break command start or termination", async () => {
  const hooks = await LoopPlugin({
    directory: "/tmp/x",
    client: {
      tui: { showToast: async () => { throw new Error("toast unavailable"); } },
      session: { promptAsync: async () => ({}) },
    },
  });
  const out = emptyOutput();
  await assert.doesNotReject(() => hooks["command.execute.before"](commandInput("s1", "30s go"), out));
  const state = LoopPlugin.__innerTest.registry.get("s1");
  assert.equal(state.mode, "fixed");
  assert.equal(outText(out), "go");

  state.iterationCount = state.caps.maxIterations;
  await assert.doesNotReject(() => hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } }));
  assert.equal(LoopPlugin.__innerTest.registry.has("s1"), false);
});

test("dispose clears shared state only after the final plugin instance is disposed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = { prompts: [] };
  const firstHooks = await pluginFor({});
  const secondHooks = await pluginFor(calls);
  const { registry } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await secondHooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  const armed1 = registry.get("s1");
  assert.ok(armed1.timer, "timer is armed before dispose");

  firstHooks.dispose();
  assert.equal(registry.has("s1"), true, "first dispose does not clear another live instance's loop");
  assert.ok(armed1.timer, "timer remains armed while another instance is live");

  secondHooks.dispose();
  assert.equal(registry.has("s1"), false, "registry entry s1 removed");
  assert.equal(registry.map.size, 0, "registry is empty after dispose");
  assert.equal(armed1.timer, null, "s1 timer handle cleared");
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(calls.prompts.length, 0, "no iteration fires after dispose");
});

test("dispose rehomes armed timer callbacks to a remaining live instance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const firstCalls = {};
  const secondCalls = {};
  const firstHooks = await pluginFor(firstCalls);
  const secondHooks = await pluginFor(secondCalls);
  const { registry } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });

  await firstHooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.ok(registry.get("s1").timer, "timer is armed by the first instance");
  firstHooks.dispose();

  t.mock.timers.tick(30_000);
  await Promise.resolve();

  assert.equal(firstCalls.prompts.length, 0);
  assert.equal(secondCalls.prompts.length, 1);
  secondHooks.dispose();
});

test("dispose is idempotent while another plugin instance remains live", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = { prompts: [] };
  const firstHooks = await pluginFor({});
  const secondHooks = await pluginFor(calls);
  const { registry } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  await secondHooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  const armed = registry.get("s1");
  assert.ok(armed.timer, "timer is armed before dispose");

  firstHooks.dispose();
  firstHooks.dispose();
  assert.equal(registry.has("s1"), true, "double dispose on one instance does not clear another live instance");
  assert.ok(armed.timer, "timer remains armed after duplicate dispose");

  secondHooks.dispose();
  assert.equal(registry.has("s1"), false);
  assert.equal(armed.timer, null);
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(calls.prompts.length, 0);
});

function commandInput(sessionID, args) { return { command: "loop", arguments: args, sessionID }; }
function emptyOutput() { return { parts: [] }; }
// Join only the model-facing parts; the ignored displayPart echo ("/loop …") is excluded.
function outText(output) { return output.parts.filter((p) => !p.ignored).map((p) => p.text).join("\n"); }

test("command start (fixed) registers iteration 1 and rewrites parts to the plain prompt", async () => {
  const hooks = await pluginFor({});
  const out = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "30s do the thing"), out);
  const s = LoopPlugin.__innerTest.registry.get("s1");
  assert.equal(s.mode, "fixed");
  assert.equal(s.iterationCount, 1);
  assert.equal(outText(out), "do the thing");          // no control block in fixed mode
});

test("command start (dynamic) appends the control block to iteration 1", async () => {
  const hooks = await pluginFor({});
  const out = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "keep going"), out);
  assert.equal(LoopPlugin.__innerTest.registry.get("s1").mode, "dynamic");
  assert.match(outText(out), /schedule_wakeup/);
});

test("command stop removes the loop; status reports state; error shows usage", async () => {
  const hooks = await pluginFor({});
  await hooks["command.execute.before"](commandInput("s1", "30s go"), emptyOutput());

  const statusOut = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "status"), statusOut);
  assert.match(outText(statusOut), /Active \/loop/);

  const stopOut = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "stop"), stopOut);
  assert.equal(LoopPlugin.__innerTest.registry.has("s1"), false);
  assert.match(outText(stopOut), /Stopped/);

  const errOut = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", ""), errOut);
  assert.equal(errOut.parts.find((part) => part.ignored).text, "/loop");
  assert.match(outText(errOut), /Usage/);
});

test("command stop with no active loop reports the no-op path", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const calls = {};
    const hooks = await pluginFor(calls);
    const out = emptyOutput();
    await hooks["command.execute.before"](commandInput("s1", "stop"), out);

    assert.equal(LoopPlugin.__innerTest.registry.has("s1"), false);
    assert.match(outText(out), /No active \/loop/);
    assert.match(calls.toasts.at(-1).message, /No active loop/);
    const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
    assert.ok(records.some((record) =>
      record.event === "loop_stopped" &&
      record.operation === "handle_loop_command" &&
      record.outcome === "skipped"));
  });
});

test("duplicate command stop preserves the successful stop output", async () => {
  const firstHooks = await pluginFor({});
  const secondHooks = await pluginFor({});
  await firstHooks["command.execute.before"](commandInput("s1", "30s go"), emptyOutput());

  const out = emptyOutput();
  await firstHooks["command.execute.before"](commandInput("s1", "stop"), out);
  assert.match(outText(out), /Stopped the active \/loop/);

  await secondHooks["command.execute.before"](commandInput("s1", "stop"), out);
  assert.match(outText(out), /Stopped the active \/loop/);
  assert.doesNotMatch(outText(out), /No active/);
});

test("statusText handles no active loop", () => {
  assert.match(statusText(undefined), /No active/);
});

test("/loop status surfaces the status via a race-free toast", async () => {
  const calls = {};
  const hooks = await pluginFor(calls);
  await hooks["command.execute.before"](commandInput("s1", "30s go"), emptyOutput());
  await hooks["command.execute.before"](commandInput("s1", "status"), emptyOutput());
  assert.match(calls.toasts.at(-1).message, /Active \/loop/);
});

test("/loop status preserves an already-armed timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  await hooks["command.execute.before"](commandInput("s1", "30s go"), emptyOutput());
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });

  const state = LoopPlugin.__innerTest.registry.get("s1");
  const timer = state.timer;
  const timerDueAt = state.timerDueAt;
  assert.ok(timer, "timer is armed before status");

  await hooks["command.execute.before"](commandInput("s1", "status"), emptyOutput());
  assert.equal(state.timer, timer);
  assert.equal(state.timerDueAt, timerDueAt);

  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(calls.prompts.length, 1);
});

test("command restart clears an armed timer from the previous loop state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  await hooks["command.execute.before"](commandInput("s1", "30s old"), emptyOutput());
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  const oldState = LoopPlugin.__innerTest.registry.get("s1");
  assert.ok(oldState.timer, "old loop timer is armed");

  await hooks["command.execute.before"](commandInput("s1", "30s new"), emptyOutput());
  const replacement = LoopPlugin.__innerTest.registry.get("s1");
  assert.notEqual(replacement, oldState);
  assert.equal(oldState.timer, null);
  assert.equal(replacement.loopPrompt, "new");

  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  assert.equal(calls.prompts.length, 0, "old armed timer did not fire against the replacement loop");
});

test("command stop clears an armed timer and prevents autonomous prompts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  await hooks["command.execute.before"](commandInput("s1", "30s go"), emptyOutput());
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  const state = LoopPlugin.__innerTest.registry.get("s1");
  assert.ok(state.timer, "timer is armed before stop");

  const stopOut = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "stop"), stopOut);

  assert.equal(LoopPlugin.__innerTest.registry.has("s1"), false);
  assert.equal(state.timer, null);
  assert.match(outText(stopOut), /Stopped/);
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  assert.equal(calls.prompts.length, 0);
});

test("command handler mutates output.parts IN PLACE and includes the /loop display echo", async () => {
  const hooks = await pluginFor({});
  const original = [];
  const out = { parts: original };
  await hooks["command.execute.before"](commandInput("s1", "30s go"), out);
  assert.equal(out.parts, original, "must mutate the SAME array reference opencode holds, not reassign (spike finding A)");
  assert.ok(out.parts.some((p) => p.ignored && p.text === "/loop 30s go"), "includes the ignored '/loop …' display echo");
});

test("command hook ignores non-loop commands without mutating output", async () => {
  const hooks = await pluginFor({});
  const original = [{ type: "text", text: "keep" }];
  const out = { parts: original };
  await hooks["command.execute.before"]({ command: "other", arguments: "30s go", sessionID: "s1" }, out);
  assert.equal(out.parts, original);
  assert.deepStrictEqual(out.parts, [{ type: "text", text: "keep" }]);
  assert.equal(LoopPlugin.__innerTest.registry.has("s1"), false);
});

test("command hook catches malformed command payloads", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const hooks = await pluginFor({});
    await assert.doesNotReject(() => hooks["command.execute.before"]({
      get command() { throw new Error("command getter boom token=abc123456789"); },
      arguments: "30s go",
      sessionID: "s1",
    }, emptyOutput()));

    assert.equal(LoopPlugin.__innerTest.registry.has("s1"), false);
    const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.event === "command_hook_error"));
    assert.doesNotMatch(JSON.stringify(records), /abc123456789/);
  });
});

test("command hook catches invalid output parts before mutating loop state", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const hooks = await pluginFor({});
    await assert.doesNotReject(() => hooks["command.execute.before"](commandInput("s1", "30s go"), { parts: {} }));

    assert.equal(LoopPlugin.__innerTest.registry.has("s1"), false);
    const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.event === "command_hook_error" && record.command === "loop"));
  });
});

test("command display echo sanitizes control bytes without changing the loop prompt", async () => {
  const hooks = await pluginFor({});
  const out = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "30s go\x1b[2J"), out);
  assert.equal(out.parts.find((part) => part.ignored).text, "/loop 30s go");
  assert.equal(outText(out), "go\x1b[2J");
});

test("command hook does not intercept /loop when config found a foreign command owner", async () => {
  const hooks = await pluginFor({});
  const cfg = { command: { loop: { description: "foreign", template: "foreign $ARGUMENTS" } } };
  await hooks.config(cfg);

  const original = [{ type: "text", text: "foreign command body" }];
  const out = { parts: original };
  await hooks["command.execute.before"](commandInput("s1", "30s go"), out);

  assert.equal(out.parts, original);
  assert.deepStrictEqual(out.parts, [{ type: "text", text: "foreign command body" }]);
  assert.equal(LoopPlugin.__innerTest.registry.has("s1"), false);
});

test("double-instantiated config hooks keep ownership of the plugin-registered /loop command", async () => {
  const firstHooks = await pluginFor({});
  const secondHooks = await pluginFor({});
  const cfg = {};
  await firstHooks.config(cfg);
  await secondHooks.config(cfg);
  firstHooks.dispose();

  const out = emptyOutput();
  await secondHooks["command.execute.before"](commandInput("s1", "30s go"), out);

  assert.equal(LoopPlugin.__innerTest.registry.has("s1"), true);
  assert.equal(outText(out), "go");
});

test("command start rejects fixed intervals that cannot fit within the wall-clock cap", async () => {
  const hooks = await pluginFor({});
  const out = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "90m go"), out);
  assert.equal(LoopPlugin.__innerTest.registry.has("s1"), false);
  assert.match(outText(out), /under 60 minutes/);
});

test("invalid fixed restart preserves the existing active loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  await hooks["command.execute.before"](commandInput("s1", "30s keep"), emptyOutput());
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  const existing = LoopPlugin.__innerTest.registry.get("s1");
  assert.ok(existing.timer, "existing loop timer is armed before invalid restart");

  const out = emptyOutput();
  await hooks["command.execute.before"](commandInput("s1", "90m replace"), out);

  assert.equal(LoopPlugin.__innerTest.registry.get("s1"), existing);
  assert.equal(existing.loopPrompt, "keep");
  assert.ok(existing.timer, "invalid restart must not clear the previous timer");
  assert.match(outText(out), /under 60 minutes/);

  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].body.parts[0].text, "keep");
});

test("schedule_wakeup records a clamped wakeup for an active dynamic loop", async () => {
  const hooks = await pluginFor({});
  LoopPlugin.__innerTest.registry.start("s1", { mode: "dynamic", loopPrompt: "go", startedAt: Date.now() });
  const msg = await hooks.tool.schedule_wakeup.execute({ delaySeconds: 30 }, { sessionID: "s1" });
  const s = LoopPlugin.__innerTest.registry.get("s1");
  assert.deepStrictEqual(s.pendingWakeup, { delaySeconds: 60, generation: 1 }); // clamped up to 60
  assert.match(msg, /continue in 60s/);

  const defaultMsg = await hooks.tool.schedule_wakeup.execute({}, { sessionID: "s1" });
  assert.deepStrictEqual(s.pendingWakeup, { delaySeconds: 60, generation: 1 });
  assert.match(defaultMsg, /continue in 60s/);

  const maxMsg = await hooks.tool.schedule_wakeup.execute({ delaySeconds: 99_999 }, { sessionID: "s1" });
  assert.deepStrictEqual(s.pendingWakeup, { delaySeconds: 3600, generation: 1 });
  assert.match(maxMsg, /continue in 3600s/);
});

test("dynamic schedule_wakeup is consumed by idle and fires exactly one later prompt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = {};
  const hooks = await pluginFor(calls);
  const { registry } = LoopPlugin.__innerTest;
  registry.start("s1", { mode: "dynamic", loopPrompt: "go", startedAt: Date.now() });

  const msg = await hooks.tool.schedule_wakeup.execute({ delaySeconds: 60 }, { sessionID: "s1" });
  assert.match(msg, /continue in 60s/);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(calls.prompts.length, 0);
  assert.equal(registry.get("s1").pendingWakeup, null);
  assert.ok(registry.get("s1").timer, "dynamic wakeup is armed after idle");

  t.mock.timers.tick(60_000);
  await flushAsyncWork();

  assert.equal(calls.prompts.length, 1);
  assert.match(calls.prompts[0].body.parts[0].text, /schedule_wakeup/);
  assert.equal(registry.get("s1").awaitingIdle, true);
});

test("schedule_wakeup no-ops for fixed or absent loops", async () => {
  const hooks = await pluginFor({});
  LoopPlugin.__innerTest.registry.start("s1", { mode: "fixed", intervalMs: 30_000, loopPrompt: "go", startedAt: Date.now() });
  const fixedMsg = await hooks.tool.schedule_wakeup.execute({ delaySeconds: 120 }, { sessionID: "s1" });
  assert.match(fixedMsg, /no effect/);
  assert.equal(LoopPlugin.__innerTest.registry.get("s1").pendingWakeup, null);
  const paused = LoopPlugin.__innerTest.registry.start("s2", { mode: "dynamic", loopPrompt: "go", startedAt: Date.now() });
  paused.status = "paused";
  const pausedMsg = await hooks.tool.schedule_wakeup.execute({ delaySeconds: 120 }, { sessionID: "s2" });
  assert.match(pausedMsg, /no effect/);
  assert.equal(LoopPlugin.__innerTest.registry.get("s2").pendingWakeup, null);
  const absentMsg = await hooks.tool.schedule_wakeup.execute({ delaySeconds: 120 }, { sessionID: "nope" });
  assert.match(absentMsg, /no effect/);
});

test("schedule_wakeup fail-softs on unusable tool inputs", async () => {
  await withDiagnosticsEnv(async (diagRoot) => {
    const hooks = await pluginFor({});
    LoopPlugin.__innerTest.registry.start("s1", { mode: "dynamic", loopPrompt: "go", startedAt: Date.now() });

    const missingContextMsg = await hooks.tool.schedule_wakeup.execute({ delaySeconds: 120 }, undefined);
    assert.match(missingContextMsg, /no effect/);
    assert.equal(LoopPlugin.__innerTest.registry.get("s1").pendingWakeup, null);

    const hostileArgs = {};
    Object.defineProperty(hostileArgs, "delaySeconds", {
      get() { throw new Error("delay getter boom token=abc123456789"); },
    });
    const hostileArgsMsg = await hooks.tool.schedule_wakeup.execute(hostileArgs, { sessionID: "s1" });
    assert.match(hostileArgsMsg, /no effect/);
    assert.equal(LoopPlugin.__innerTest.registry.get("s1").pendingWakeup, null);

    const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.event === "schedule_wakeup_error" && record.sessionID === "s1"));
    assert.doesNotMatch(JSON.stringify(records), /abc123456789/);
  });
});
