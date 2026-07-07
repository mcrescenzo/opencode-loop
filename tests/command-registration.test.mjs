import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCommandMarkdown, registerLoopCommand } from "../loop-core.js";

async function withCommandDir(markdown, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-cmd-"));
  try {
    if (markdown !== null) {
      await mkdir(path.join(dir, "commands"), { recursive: true });
      await writeFile(path.join(dir, "commands", "loop.md"), markdown);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseCommandMarkdown splits frontmatter from body", () => {
  const out = parseCommandMarkdown("---\ndescription: Loop it\n---\nBody $ARGUMENTS\n", "fb");
  assert.equal(out.description, "Loop it");
  assert.equal(out.template, "Body $ARGUMENTS\n");
});

test("parseCommandMarkdown handles CRLF frontmatter and body", () => {
  const out = parseCommandMarkdown("---\r\ndescription: Loop it\r\n---\r\nBody $ARGUMENTS\r\n", "fb");
  assert.equal(out.description, "Loop it");
  assert.equal(out.template, "Body $ARGUMENTS\n");
});

test("parseCommandMarkdown handles BOM and only strips balanced description quotes", () => {
  const quoted = parseCommandMarkdown("\uFEFF---\ndescription: \"Loop it\"\n---\nBody\n", "fb");
  assert.equal(quoted.description, "Loop it");
  assert.equal(quoted.template, "Body\n");

  const leading = parseCommandMarkdown("---\ndescription: \"unterminated\n---\nBody\n", "fb");
  assert.equal(leading.description, "\"unterminated");

  const trailing = parseCommandMarkdown("---\ndescription: unterminated\"\n---\nBody\n", "fb");
  assert.equal(trailing.description, "unterminated\"");
});

test("parseCommandMarkdown falls back on malformed or missing frontmatter", () => {
  assert.deepStrictEqual(parseCommandMarkdown("Body only\n", "fallback"), {
    description: "fallback",
    template: "Body only",
  });
  assert.deepStrictEqual(parseCommandMarkdown("---\ndescription: missing close\nBody\n", "fallback"), {
    description: "fallback",
    template: "---\ndescription: missing close\nBody",
  });
  assert.deepStrictEqual(parseCommandMarkdown("---\nname: loop\n---\nBody\n", "fallback"), {
    description: "fallback",
    template: "Body\n",
  });
});

test("registerLoopCommand registers cfg.command.loop from a bundled file", async () => {
  await withCommandDir("---\ndescription: Loop\n---\nLoop $ARGUMENTS\n", async (dir) => {
    const cfg = {};
    const result = await registerLoopCommand(cfg, dir);
    assert.deepStrictEqual(result, { registered: true, reason: "registered" });
    assert.equal(cfg.command.loop.description, "Loop");
    assert.match(cfg.command.loop.template, /\$ARGUMENTS/);
  });
});

test("registerLoopCommand normalizes malformed command config shapes", async () => {
  await withCommandDir("---\ndescription: Loop\n---\nLoop $ARGUMENTS\n", async (dir) => {
    for (const command of [null, "bad", []]) {
      const cfg = { command };
      const result = await registerLoopCommand(cfg, dir);
      assert.deepStrictEqual(result, { registered: true, reason: "registered" });
      assert.equal(cfg.command.loop.description, "Loop");
      assert.match(cfg.command.loop.template, /\$ARGUMENTS/);
    }
  });
});

test("registerLoopCommand does not clobber a user-provided loop command", async () => {
  await withCommandDir("---\ndescription: bundled\n---\nb\n", async (dir) => {
    const cfg = { command: { loop: { description: "user", template: "user" } } };
    const result = await registerLoopCommand(cfg, dir);
    assert.deepStrictEqual(result, { registered: false, reason: "exists" });
    assert.equal(cfg.command.loop.description, "user");
  });
});

test("registerLoopCommand emits diagnostics while degrading when bundled file is missing", async () => {
  await withCommandDir(null, async (dir) => {
    const cfg = {};
    const records = [];
    const result = await registerLoopCommand(cfg, dir, { diagnostics: { emit: async (record) => { records.push(record); } } });
    assert.deepStrictEqual(result, { registered: false, reason: "failed" });
    assert.equal(cfg.command.loop, undefined);
    assert.equal(records.length, 1);
    assert.equal(records[0].event, "command_registration_failed");
    assert.equal(records[0].command, "loop");
  });
});

test("registerLoopCommand still degrades when diagnostics emit fails", async () => {
  await withCommandDir(null, async (dir) => {
    const cfg = {};
    const diagnostics = {
      emit: async () => {
        throw new Error("diagnostics unavailable");
      },
    };
    const result = await registerLoopCommand(cfg, dir, { diagnostics });
    assert.deepStrictEqual(result, { registered: false, reason: "failed" });
    assert.equal(cfg.command.loop, undefined);
  });
});

test("the REAL bundled commands/loop.md registers and contains $ARGUMENTS", async () => {
  const cfg = {};
  await registerLoopCommand(cfg, new URL("../", import.meta.url).pathname);
  assert.ok(cfg.command.loop);
  assert.match(cfg.command.loop.template, /\$ARGUMENTS/);
});

test("LoopPlugin config hook self-registers /loop", async () => {
  const { LoopPlugin } = await import("../loop.js");
  const hooks = await LoopPlugin({ client: {}, directory: process.cwd() });
  const cfg = {};
  await hooks.config(cfg);
  assert.ok(cfg.command.loop, "config hook must self-register /loop");
});
