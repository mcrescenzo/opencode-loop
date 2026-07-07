import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkg = JSON.parse(
  readFileSync(path.join(fileURLToPath(new URL("../", import.meta.url)), "package.json"), "utf8")
);
const readme = readFileSync(path.join(fileURLToPath(new URL("../", import.meta.url)), "README.md"), "utf8");

test("scoped package is configured for public publish", () => {
  assert.equal(pkg.name, "@mcrescenzo/opencode-loop");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "./loop.js");
  assert.deepStrictEqual(pkg.exports, { ".": "./loop.js" });
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.publishConfig?.access, "public");
  assert.equal(pkg.engines?.node, ">=20.11.0");
  assert.doesNotMatch(pkg.description, /slash command/i);
  assert.equal(pkg.author, "Michael Crescenzo");
  assert.equal(pkg.repository?.type, "git");
  assert.equal(pkg.repository?.url, "https://github.com/mcrescenzo/opencode-loop");
  assert.equal(pkg.homepage, "https://github.com/mcrescenzo/opencode-loop#readme");
  assert.equal(pkg.bugs?.url, "https://github.com/mcrescenzo/opencode-loop/issues");
  assert.deepStrictEqual(pkg.opencode, { tested: "1.17.13", pluginApi: "^1.17.7" });
  assert.match(pkg.dependencies?.["@opencode-ai/plugin"], /^\^/);
  assert.equal(pkg.dependencies?.["@opencode-ai/plugin"], "^1.17.7");
  assert.deepStrictEqual([...pkg.keywords].sort(), ["loop", "opencode", "opencode-plugin"]);
  assert.match(pkg.scripts?.prepack, /\bnpm test\b/);
  assert.match(pkg.scripts?.prepublishOnly, /\bnpm test\b/);
  assert.equal(pkg.scripts?.test, "node --test tests/*.test.mjs");
  assert.match(pkg.scripts?.["smoke:package"], /package-smoke\.mjs/);
});

test("package files and README links are self-contained for npm", () => {
  assert.deepStrictEqual(
    [...pkg.files].sort(),
    [
      "CHANGELOG.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "commands",
      "diagnostics.js",
      "loop-core.js",
      "loop.js",
    ].sort(),
  );
  const relativeLinks = [...readme.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g)].map((match) => match[1]);
  assert.deepStrictEqual(relativeLinks, []);
  assert.match(readme, /unofficial opencode plugin/);
  assert.match(readme, /not affiliated with or endorsed by\s+opencode\.ai/);
  assert.match(readme, /opencode `1\.17\.13`/);
  assert.match(readme, /not `bun test`/);
  assert.match(readme, /no committed `package-lock\.json`/);
  assert.match(readme, /local opencode diagnostics tooling/);
  assert.match(readme, /To uninstall/);
  assert.match(readme, /## Hooks/);
  assert.match(readme, /`command\.execute\.before`/);
});
