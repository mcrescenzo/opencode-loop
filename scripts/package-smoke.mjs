#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-package-smoke-"));

function modelText(output) {
  return output.parts.filter((part) => !part.ignored).map((part) => part.text).join("\n");
}

// Strip any npm_config_* values inherited from a parent npm invocation (e.g. a
// `--dry-run` parent that reached this script via the prepack/prepublishOnly
// lifecycle, or a caller who ran `smoke:package` under one). Without this, the
// nested `npm pack` below silently inherits flags like npm_config_dry_run=true
// and never writes a tarball, which then fails the assertion below with a
// misleading "npm pack did not create a tarball" error instead of the real cause.
function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_config_")) delete env[key];
  }
  return { ...env, ...overrides };
}

try {
  await exec("npm", ["pack", "--ignore-scripts", "--pack-destination", tmp], {
    cwd: root,
    env: childEnv({ npm_config_cache: path.join(tmp, "npm-cache") }),
    maxBuffer: 1024 * 1024,
  });
  const tarballName = (await readdir(tmp)).find((file) => file.endsWith(".tgz"));
  assert.ok(tarballName, "npm pack did not create a tarball");
  const { stdout: tarList } = await exec("tar", ["-tzf", path.join(tmp, tarballName)]);
  assert.deepStrictEqual(
    tarList.trim().split(/\r?\n/).map((file) => file.replace(/^package\//, "")).sort(),
    [
      "CHANGELOG.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "commands/loop.md",
      "diagnostics.js",
      "loop-core.js",
      "loop.js",
      "package.json",
    ],
  );

  const extractDir = path.join(tmp, "extract");
  await mkdir(extractDir);
  await exec("tar", ["-xzf", path.join(tmp, tarballName), "-C", extractDir]);

  const packageDir = path.join(extractDir, "package");
  const sourcePkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const pkg = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  assert.equal(pkg.name, "@mcrescenzo/opencode-loop");
  assert.equal(pkg.version, sourcePkg.version);
  const depDir = path.join(packageDir, "node_modules", "@opencode-ai");
  await mkdir(depDir, { recursive: true });
  await symlink(path.join(root, "node_modules", "@opencode-ai", "plugin"), path.join(depDir, "plugin"), "dir");

  const mod = await import(pathToFileURL(path.join(packageDir, "loop.js")).href);
  assert.deepStrictEqual(Object.keys(mod), ["LoopPlugin"]);

  const calls = { prompts: [], toasts: [] };
  const hooks = await mod.LoopPlugin({
    directory: packageDir,
    client: {
      tui: { showToast: async ({ body }) => { calls.toasts.push(body); } },
      session: {
        promptAsync: async (request) => {
          calls.prompts.push(request);
          return {};
        },
      },
    },
  });

  assert.deepStrictEqual(Object.keys(hooks).sort(), ["command.execute.before", "config", "dispose", "event", "tool"]);

  const cfg = {};
  await hooks.config(cfg);
  assert.equal(cfg.command.loop.description, "Repeatedly re-run a prompt in this session on a fixed interval or model-paced cadence until you stop it");
  assert.match(cfg.command.loop.template, /\$ARGUMENTS/);

  const fixedOut = { parts: [] };
  const fixedParts = fixedOut.parts;
  await hooks["command.execute.before"]({ command: "loop", arguments: "5s check package smoke", sessionID: "smoke-fixed" }, fixedOut);
  assert.equal(fixedOut.parts, fixedParts, "command hook must mutate output.parts in place");
  assert.equal(modelText(fixedOut), "check package smoke");

  await mod.LoopPlugin.__innerTest.fireNextIteration("smoke-fixed");
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].path.id, "smoke-fixed");
  assert.equal(calls.prompts[0].body.parts[0].text, "check package smoke");

  const dynamicOut = { parts: [] };
  await hooks["command.execute.before"]({ command: "loop", arguments: "keep going until done", sessionID: "smoke-dynamic" }, dynamicOut);
  assert.match(modelText(dynamicOut), /schedule_wakeup/);
  const wakeup = await hooks.tool.schedule_wakeup.execute({ delaySeconds: 30 }, { sessionID: "smoke-dynamic" });
  assert.match(wakeup, /60s/);

  const foreignHooks = await mod.LoopPlugin({
    directory: packageDir,
    client: {
      tui: { showToast: async () => {} },
      session: { promptAsync: async () => ({}) },
    },
  });
  const foreignCfg = { command: { loop: { description: "foreign", template: "foreign $ARGUMENTS" } } };
  await foreignHooks.config(foreignCfg);
  const foreignOut = { parts: [{ type: "text", text: "foreign" }] };
  await foreignHooks["command.execute.before"]({ command: "loop", arguments: "5s should not run", sessionID: "foreign" }, foreignOut);
  assert.deepStrictEqual(foreignOut.parts, [{ type: "text", text: "foreign" }]);

  hooks.dispose?.();

  console.log(JSON.stringify({
    ok: true,
    package: `${pkg.name}@${pkg.version}`,
    fileCount: 11,
    checks: [
      "packed-files",
      "single-export",
      "hook-shape",
      "config-registration",
      "foreign-command-noninterception",
      "command-interception",
      "fixed-reprompt",
      "dynamic-schedule-wakeup",
    ],
  }, null, 2));
} finally {
  await rm(tmp, { recursive: true, force: true });
}
