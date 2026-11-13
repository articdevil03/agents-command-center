import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateFixedCrew } from "../server/fixed-crew/preferences.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import { fixedProject, fixedTab, fixedWorkspaces, launchConfig } from "./fixed-server-fixture.ts";
import { tempRoot } from "./temp-root.ts";

const coder = { cli: "codex", model: "gpt-6.1-sol", effort: "medium" } as const;

test("fixedTab builds a valid saved fixed tab with explicit choices and empty compatibility fields", () => {
  const tab = fixedTab("alpha-development", "C:/work/alpha", { coder });
  assert.deepEqual(validateFixedCrew(tab.fixedCrew), tab.fixedCrew, "the crew passes the production validator unchanged");
  assert.deepEqual([tab.crew, tab.steps, tab.lookPause, tab.kind, tab.setupName], [[], [], false, "dev", "Fixed crew"]);
  assert.deepEqual(tab.fixedCrew!.preferences.coder, { assignment: coder, source: "user" });
  const others = FIXED_CREW.filter((seat) => seat.slot !== "coder");
  assert.equal(others.length, FIXED_CREW.length - 1, "control: the roster has other slots to check");
  for (const seat of others) assert.deepEqual(tab.fixedCrew!.preferences[seat.slot], { assignment: null, source: "auto" }, seat.slot);
});

test("every fixed tab and workspace owns independent objects", () => {
  const first = fixedTab("a-one", "C:/a", { coder }), second = fixedTab("a-two", "C:/a", { coder });
  first.fixedCrew!.preferences.coder.assignment!.model = "changed";
  first.fixedCrew!.roleExtras.coder = "extra";
  first.crew.push({} as any);
  assert.equal(coder.model, "gpt-6.1-sol", "the caller's choice is copied, never aliased");
  assert.equal(second.fixedCrew!.preferences.coder.assignment!.model, "gpt-6.1-sol");
  assert.deepEqual(second.fixedCrew!.roleExtras, {});
  assert.deepEqual(second.crew, []);
  const one = fixedWorkspaces(), two = fixedWorkspaces();
  one.projects[0].tabs[0].fixedCrew!.preferences.leader.source = "user";
  assert.equal(two.projects[0].tabs[0].fixedCrew!.preferences.leader.source, "auto");
  assert.equal(fixedProject("beta", "C:/b").tabs[0].id, "beta-development");
});

test("the builder never loads config.ts at run time", () => {
  const source = readFileSync("test/fixed-server-fixture.ts", "utf8");
  const imports = source.split("\n").filter((line) => /^import .* from "\.\.\/server\/config\.ts"/.test(line));
  assert.ok(imports.length > 0, "control: the scan found the config.ts import line");
  assert.ok(imports.every((line) => line.startsWith("import type ")), imports.join("\n"));
});

test("launchConfig evaluates the fixed crew modules and seeds a fixed example workspace in its own data folder", () => {
  const copy = tempRoot(["server", "config"]), data = tempRoot();
  const loaded = launchConfig(copy, data);
  const seeded = JSON.parse(readFileSync(loaded.workspacesPath, "utf8"));
  assert.equal(loaded.workspacesPath.startsWith(data), true, "the seed is under the scratch data folder");
  assert.equal(seeded.projects[0].tabs[0].fixedCrew.version, 1);
  assert.equal(loaded.workspaceRecovery().blocked, false);
});
