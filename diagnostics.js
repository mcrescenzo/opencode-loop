import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Redaction heuristics are adapted from the author's local OpenCode diagnostics tooling and
// kept self-contained here so this package has no private repository dependency.
const SCHEMA = "opencode.plugin.diagnostic.v1";
const PLUGIN = "loop";
const LEVELS = new Set(["debug", "info", "warn", "error"]);
const MAX_STRING = 4_000;
const MAX_RECORD = 16_000;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 100;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const SECRET_KEY_RE = /(^|_|-|\.)(authorization|auth|cookie|password|passwd|secret|token|id[_-]?token|jwt|api[_-]?key|apikey|access[_-]?key|private[_-]?key|refresh[_-]?token|server[_-]?password|aws[_-]?secret[_-]?access[_-]?key)($|_|-|\.)/i;
const SECRET_PATTERNS = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replace: "-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----" },
  { re: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: "<jwt-redacted>" },
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: "<aws-access-key-redacted>" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: "<gcp-api-key-redacted>" },
  { re: /\bnpm_[A-Za-z0-9]{36,}\b/g, replace: "npm_<redacted>" },
  { re: /\b(sk|pk)_(live|test)_[A-Za-z0-9]{12,}\b/g, replace: "$1_$2_<redacted>" },
  { re: /\b(ghp|gho)_[A-Za-z0-9]{20,}\b/g, replace: "$1_<redacted>" },
  { re: /\b(github_pat)_[A-Za-z0-9_]{20,}\b/g, replace: "$1_<redacted>" },
  { re: /\b(xox[baprs])(?:-[A-Za-z0-9]{6,}){2,}\b/g, replace: "$1-<redacted>" },
  { re: /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, replace: "$1<redacted>$2" },
  { re: /\b(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+(@)/gi, replace: "$1<redacted>$2" },
  { re: /\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, replace: "$1: <redacted>" },
  { re: /\b(connect\.sid|session(?:id)?|sid|csrf(?:_token)?|xsrf-token|auth(?:_token)?|refresh_token)=["']?[^;\s"',]+/gi, replace: "$1=<redacted>" },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: "Bearer <redacted>" },
  { re: /\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, replace: "Basic <redacted>" },
  { re: /\b(sk|pk|ghp|gho|github_pat|xox[baprs])-[A-Za-z0-9_-]{12,}(?:-[A-Za-z0-9_-]{6,})*\b/g, replace: "$1-<redacted>" },
  { re: /\b(api[_-]?key|token|secret|password|passwd|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["']?[^\s"'`,;]{8,}/gi, replace: (_match, key) => `${key}=<redacted>` },
];

function normalizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function isSecretKey(key) {
  return SECRET_KEY_RE.test(normalizeKey(key));
}

function redactText(value) {
  if (value === undefined || value === null) return "";
  let text;
  try { text = String(value); }
  catch { text = "[unstringifiable]"; }
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern.re, pattern.replace);
  if (text.length <= MAX_STRING) return text;
  return `${text.slice(0, MAX_STRING)}\n[truncated ${text.length - MAX_STRING} chars]`;
}

function safeGet(value, key) {
  try { return value?.[key]; }
  catch { return undefined; }
}

function redactValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[function]";
  if (typeof value !== "object") return redactText(String(value));
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[max-depth]";
  seen.add(value);
  if (Array.isArray(value)) {
    let items;
    let length;
    try {
      length = value.length;
      items = value.slice(0, MAX_ENTRIES).map((item) => redactValue(item, seen, depth + 1));
    } catch {
      seen.delete(value);
      return "[uninspectable]";
    }
    if (length > MAX_ENTRIES) items.push(`[${length - MAX_ENTRIES} more items]`);
    seen.delete(value);
    return items;
  }
  const out = {};
  let count = 0;
  let entries;
  try { entries = Object.entries(value); }
  catch {
    seen.delete(value);
    return "[uninspectable]";
  }
  for (const [key, item] of entries) {
    if (count >= MAX_ENTRIES) {
      out.__truncated_entries = "more";
      break;
    }
    out[key] = isSecretKey(key) ? "[redacted]" : redactValue(item, seen, depth + 1);
    count += 1;
  }
  seen.delete(value);
  return out;
}

export function summarizeError(error) {
  if (!error) return undefined;
  if (typeof error === "string") return { message: redactText(error) };
  const ctor = safeGet(error, "constructor");
  return redactValue({
    name: safeGet(error, "name") || safeGet(ctor, "name") || "Error",
    message: safeGet(error, "message") || redactText(error),
    code: safeGet(error, "code"),
  });
}

function pathApiFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function expandHome(value, platform, homedir) {
  const text = String(value || "");
  if (!text.startsWith("~")) return text;
  const pathApi = pathApiFor(platform);
  if (text === "~") return homedir;
  if (text.startsWith("~/") || text.startsWith("~\\")) return pathApi.join(homedir, text.slice(2));
  return text;
}

function absoluteEnvPath(value, { platform = process.platform, homedir = os.homedir() } = {}) {
  if (!value) return null;
  const pathApi = pathApiFor(platform);
  const expanded = expandHome(value, platform, homedir);
  if (!pathApi.isAbsolute(expanded)) return null;
  return pathApi.normalize(expanded);
}

function diagnosticsRoot(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const pathApi = pathApiFor(platform);
  const override = absoluteEnvPath(env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR, { platform, homedir });
  if (override) return override;
  if (platform === "win32") {
    const base = absoluteEnvPath(env.LOCALAPPDATA, { platform, homedir }) ?? pathApi.join(homedir, "AppData", "Local");
    return pathApi.join(base, "opencode", "plugin-diagnostics");
  }
  if (platform === "darwin") {
    return pathApi.join(homedir, "Library", "Application Support", "opencode", "plugin-diagnostics");
  }
  const xdg = absoluteEnvPath(env.XDG_STATE_HOME, { platform, homedir });
  const base = xdg ?? pathApi.join(homedir, ".local", "state");
  return pathApi.join(base, "opencode", "plugin-diagnostics");
}

function safeName(value, fallback = "project") {
  return (String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || fallback);
}

async function projectKey(directory) {
  const resolved = path.resolve(directory || process.cwd());
  let canonical = resolved;
  try { canonical = await realpath(resolved); } catch {}
  return `${safeName(path.basename(canonical || resolved))}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

function jsonLine(record) {
  let text = JSON.stringify(record);
  if (text.length <= MAX_RECORD) return `${text}\n`;
  text = JSON.stringify({ ...record, data: record.data === undefined ? undefined : "[omitted: record too large]" });
  if (text.length <= MAX_RECORD) return `${text}\n`;
  text = JSON.stringify({
    schema: SCHEMA,
    ts: record.ts,
    plugin: PLUGIN,
    level: "error",
    event: "diagnostic_record_omitted",
    message: "Diagnostic record omitted because it exceeded the maximum size.",
    data: "[omitted: record too large]",
  });
  return `${text}\n`;
}

function shouldHardenPermissions(platform = process.platform) {
  return platform !== "win32";
}

async function chmodIfSupported(target, mode, platform) {
  if (!shouldHardenPermissions(platform)) return;
  try {
    await chmod(target, mode);
  } catch {
    /* best effort */
  }
}

function fileNameFor(date, index) {
  const suffix = index === 0 ? "" : `.${index}`;
  return `${PLUGIN}-${date}-${process.pid}${suffix}.jsonl`;
}

const diagnosticsCache = new Map();

function normalizeDiagnosticsContext(ctx = {}) {
  const platform = ctx.platform ?? process.platform;
  const env = ctx.env ?? process.env;
  const root = ctx.root ?? diagnosticsRoot({ platform, env, homedir: ctx.homedir });
  const directory = path.resolve(ctx.directory || process.cwd());
  const maxFileBytes = ctx.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return { directory, platform, env, root, maxFileBytes };
}

function createLoopDiagnosticsInstance(context) {
  const { directory, platform, env, root, maxFileBytes } = context;
  const pathApi = pathApiFor(platform);
  let fileStatePromise;
  let writeQueue = Promise.resolve();

  async function fileState() {
    if (!fileStatePromise) {
      fileStatePromise = (async () => {
        const dir = pathApi.join(root, await projectKey(directory), PLUGIN);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmodIfSupported(dir, 0o700, platform);
        return { dir, date: new Date().toISOString().slice(0, 10), index: 0 };
      })();
    }
    return fileStatePromise;
  }

  async function rotateTarget(line) {
    const state = await fileState();
    const today = new Date().toISOString().slice(0, 10);
    if (state.date !== today) {
      state.date = today;
      state.index = 0;
    }
    const lineBytes = Buffer.byteLength(line);
    for (;;) {
      const target = pathApi.join(state.dir, fileNameFor(state.date, state.index));
      let currentSize = 0;
      try {
        currentSize = (await stat(target)).size;
      } catch {
        currentSize = 0;
      }
      if (currentSize === 0 || currentSize + lineBytes <= maxFileBytes) return target;
      state.index += 1;
    }
  }

  async function appendRecord(record) {
    const line = jsonLine(record);
    const target = await rotateTarget(line);
    await appendFile(target, line, { mode: 0o600 });
    await chmodIfSupported(target, 0o600, platform);
  }

  function appendRecordQueued(record) {
    const write = writeQueue.then(async () => {
      try {
        await appendRecord(record);
      } catch (error) {
        fileStatePromise = undefined;
        throw error;
      }
    });
    writeQueue = write.catch(() => {});
    return write;
  }

  return {
    async emit(input = {}) {
      if (env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED === "1") return;
      try {
        const record = redactValue({
          schema: SCHEMA,
          ts: new Date().toISOString(),
          plugin: PLUGIN,
          level: LEVELS.has(input.level) ? input.level : "info",
          event: input.event || "plugin_event",
          message: input.message || "",
          sessionID: input.sessionID,
          tool: input.tool,
          hook: input.hook,
          command: input.command,
          operation: input.operation,
          outcome: input.outcome,
          durationMs: input.durationMs,
          error: summarizeError(input.error),
          data: input.data,
        });
        await appendRecordQueued(record);
      } catch {
        /* diagnostics are best effort */
      }
    },
  };
}

export function createLoopDiagnostics(ctx = {}) {
  const context = normalizeDiagnosticsContext(ctx);
  const { platform, root, directory, maxFileBytes } = context;
  const key = `${platform}\0${root}\0${directory}\0${maxFileBytes}`;
  let diagnostics = diagnosticsCache.get(key);
  if (!diagnostics) {
    diagnostics = createLoopDiagnosticsInstance(context);
    diagnosticsCache.set(key, diagnostics);
  }
  return diagnostics;
}

function clearDiagnosticsCache() {
  diagnosticsCache.clear();
}

export const __test = {
  redactText,
  redactValue,
  projectKey,
  diagnosticsRoot,
  normalizeDiagnosticsContext,
  shouldHardenPermissions,
  clearDiagnosticsCache,
};
