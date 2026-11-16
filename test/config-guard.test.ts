import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "./temp-root.ts";
import { configSnapshot, compareConfig, guardConfig, runTests } from "../scripts/config-guard.mjs";

test("config guard finds changed, added and deleted files and only warns on identical rewrites", async () => {
  const root = scratchDir(); mkdirSync(join(root, "nested"));
  const path = join(root, "nested", "settings.json"); writeFileSync(path, "original");
  utimesSync(path, 1, 1);
  const before = configSnapshot(root), warnings: string[] = [];
  assert.deepEqual(compareConfig(before, configSnapshot(root)), []);
  writeFileSync(path, "original");
  assert.deepEqual(compareConfig(before, configSnapshot(root), (line) => warnings.push(line)), []);
  assert.match(warnings.join("\n"), /WARNING.*nested[\\/]settings.json/);
  writeFileSync(path, "changed"); writeFileSync(join(root, "added.json"), "new");
  assert.deepEqual(compareConfig(before, configSnapshot(root), () => {}).sort(), ["added.json", join("nested", "settings.json")].sort());
  unlinkSync(path);
  assert.deepEqual(compareConfig(before, configSnapshot(root), () => {}).sort(), ["added.json", join("nested", "settings.json")].sort());
  const previous = process.exitCode;
  try {
    assert.equal(await guardConfig(root, async () => { writeFileSync(join(root, "added.json"), "again"); return 0; }, () => {}), 0);
    assert.equal(process.exitCode, 1, "a successful test command cannot hide a config change");
    process.exitCode = undefined;
    await assert.rejects(guardConfig(root, async () => { writeFileSync(join(root, "added.json"), "throw"); throw new Error("test failed"); }, () => {}), /test failed/);
    assert.equal(process.exitCode, 1, "comparison still runs when the test command throws");
  } finally { process.exitCode = previous; }
});

test("the guard's wrapped test run refuses a narrowed browser run, as npm test does", async () => {
  const script = 'import { NARROWED, narrowedRunError } from "./test/browser-constants.ts"; const error = narrowedRunError(process.env, NARROWED); if (error) { console.error(error); process.exit(3); }';
  const args = ["--input-type=module", "-e", script];
  const env = { ...process.env, npm_lifecycle_event: "verify" };
  delete env.CC_BROWSER_WIDTHS; delete env.CC_BROWSER_DEBUG_ONLY;
  assert.equal(await runTests(args, { ...env, CC_BROWSER_PHASES: "b2" }, "ignore"), 3, "a leftover narrowing variable is refused");
  delete env.CC_BROWSER_PHASES;
  assert.equal(await runTests(args, env, "ignore"), 0, "control: an unnarrowed run passes the same stand-in");
});
