// Pack 26 final cleanup: the dead crewTools capability is gone from the live output, and removed files stay removed.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importWithTempDataRoot } from "./temp-root.ts";

const FIELDS = ["advisor", "customModel", "efforts", "id", "installed", "label", "models", "readOnlyEnforced"];

test("P26F live CLI capabilities omit crewTools", async () => {
  const { modules: config } = await importWithTempDataRoot(() => import("../server/config.ts"));
  const clis = config.buildClis((cli) => cli === "codex", [{ id: "custom", name: "Custom", program: "custom", args: [] }]);
  assert.deepEqual(clis.map((cli) => cli.id), ["claude", "codex", "opencode", "acp:custom"]);
  for (const cli of clis) assert.deepEqual(Object.keys(cli).sort(), FIELDS, `${cli.id}: every other capability field is kept and crewTools is gone`);
  const by = Object.fromEntries(clis.map((cli) => [cli.id, cli]));
  assert.deepEqual([by.claude!.advisor, by.claude!.readOnlyEnforced, by.claude!.customModel, by.claude!.installed], [true, true, null, false]);
  assert.deepEqual([by.codex!.advisor, by.codex!.readOnlyEnforced, by.codex!.installed], [false, false, true]);
  assert.match(by.codex!.customModel!, /^\^gpt-/);
  assert.match(by.opencode!.customModel!, /\//);
  assert.deepEqual(by["acp:custom"], { id: "acp:custom", label: "Custom", advisor: false, readOnlyEnforced: false, customModel: null, installed: true, models: ["default"], efforts: ["default"] });
  assert.ok(by.claude!.models!.length > 0 && by.claude!.efforts.length > 0, "models and efforts still come from the option tables");
});

// Searches build the retired names from pieces so this file never matches its own scan.
const RETIRED_FIXTURE = ["fake-planner", "cli.cjs"].join("-");
const RETIRED_PROOF = ["electron", "process", "proof"].join("-");
const CAP_FIELD = ["crew", "Tools"].join("");

test("P26F deleted capability and proof tooling stays deleted and unreferenced", () => {
  assert.equal(existsSync(join("test", RETIRED_FIXTURE)), false);
  assert.equal(existsSync(join("scripts", `${RETIRED_PROOF}.mjs`)), false);
  const roots = ["server", "public", "test", "scripts", "electron"];
  const files: string[] = ["package.json", "README.md", "PROTOCOL.md", "CONTRIBUTING.md"];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && !entry.name.startsWith(".cc-test-")) walk(path); } else if (/\.(ts|mjs|cjs|js|json|md)$/.test(entry.name)) files.push(path);
    }
  };
  for (const root of roots) walk(root);
  assert.ok(files.length > 300, `control: the scan must find the source files (found ${files.length})`);
  // This test, its mutation row and that row's test mapping name the retired field on purpose.
  const named = ["pack26-final-cleanup.test.ts", "pack26-final.mjs", "tooling-sweep-proof-final.ts"];
  const hits = files.filter((file) => !named.some((name) => file.endsWith(name))).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [RETIRED_FIXTURE, RETIRED_PROOF, CAP_FIELD].filter((needle) => text.includes(needle)).map((needle) => `${file}: ${needle}`);
  });
  assert.deepEqual(hits, []);
});
