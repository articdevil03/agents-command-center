import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { importWithTempDataRoot } from "./temp-root.ts";
import { noVendor, ownedTemp } from "./opencode-models.setup.ts";

const { modules: { config, prefs, assignments, bulk, main } } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"), prefs: await import("../server/fixed-crew/preferences.ts"),
  assignments: await import("../server/fixed-crew/assignment.ts"), bulk: await import("../server/fixed-crew/bulk-assignment.ts"),
  main: await import("../server/main/fixed-crew.ts"),
}));
const info = (value: string, variants: string[]) => ({ value, providerID: value.split("/")[0], modelID: value.split("/")[1], displayName: value, variants });
const catalogue = (models = [info("provider/old", ["thinking"]), info("provider/new", []), info("provider/control", ["thinking"])]) => ({
  clis: [{ id: "opencode", installed: true, models: null, efforts: ["thinking"], advisor: false }],
  opencodeSuggestions: models.map((m) => m.value), opencodeModelInfo: models,
});
const pair = { cli: "opencode" as const, model: "provider/old", effort: "thinking" };

test("saved pairs, deliberate nulls, automatic choices and future crews survive load, refresh, restart and unrelated saves", (t) => {
  noVendor(t);
  assert.deepEqual(config.OPENCODE_MODEL_SUGGESTIONS_FALLBACK, [], "fresh discovery has no fabricated models");
  const root = ownedTemp(t), file = join(root, "workspaces.json");
  let workspace = config.defaultWorkspaces(root);
  const fixed = workspace.projects[0].tabs[0].fixedCrew!;
  for (const slot of Object.keys(fixed.preferences)) fixed.preferences[slot] = { assignment: { ...pair }, source: "auto" };
  fixed.preferences.leader = { assignment: { ...pair }, source: "user" };
  fixed.preferences.coder = { assignment: null, source: "user" };
  const future = { ...structuredClone(workspace.projects[0].tabs[0]), id: "future-tab", fixedCrew: { version: 99, untouched: { opaque: ["keep", null] } } };
  workspace.projects[0].tabs.push(future as any);
  writeFileSync(file, JSON.stringify(workspace));
  const original = structuredClone(workspace.projects[0].tabs.map((tab) => tab.fixedCrew));
  workspace = config.readWorkspaces(file); config.adoptSavedValues(workspace);
  assert.equal(config.isValidEffort("opencode", "thinking", pair.model), true, "startup adopts the saved pair");
  assert.equal(config.isValidEffort("opencode", "thinking", "provider/new"), false, "saved effort belongs to its original model");
  config.applyOpenCodeModels([info("provider/new", [])], {});
  config.applyOpenCodeModels(null, { stale: true, error: "synthetic failure" });
  assert.deepEqual(config.OPENCODE_MODEL_INFO, [info("provider/new", [])], "failed refresh keeps live metadata");
  assert.ok(config.OPENCODE_MODEL_SUGGESTIONS.includes("provider/new"), "failed refresh keeps the last live list");
  assert.equal(config.isValidEffort("opencode", "thinking", pair.model), true, "missing pair remains valid after refresh");
  assert.ok(config.OPENCODE_MODEL_SUGGESTIONS.includes(pair.model));
  const service = main.createFixedCrewService({ workspace: () => workspace, selectedTabId: () => "example-development",
    catalogue: () => catalogue([info("provider/new", [])]), seatBusy: () => false, leaderActive: () => false,
    writeWorkspace: (draft) => config.writeWorkspaces(draft, file), setWorkspace: (draft) => { workspace = draft; }, announce() {} });
  service.refresh();
  assert.deepEqual(workspace.projects[0].tabs.map((tab) => tab.fixedCrew), original, "refresh preserves every source, null and future version");
  service.change("example-development", "setCrewRoleExtra", "leader", "unrelated instructions");
  workspace.projects[0].name = "Unrelated rename"; config.writeWorkspaces(workspace, file);
  const loaded = config.readWorkspaces(file);
  for (let i = 0; i < original.length; i++) assert.deepEqual(loaded.projects[0].tabs[i].fixedCrew!.preferences, (original[i] as any).preferences);
  assert.deepEqual(loaded.projects[0].tabs[1].fixedCrew, future.fixedCrew);
  const restart = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const c = await import('./server/config.ts');
    const saved = c.readWorkspaces(process.env.CC_SAVED_FIXTURE); c.adoptSavedValues(saved);
    c.applyOpenCodeModels([], {});
    console.log(JSON.stringify({ saved, valid: c.isValidEffort('opencode', 'thinking', 'provider/old'),
      borrowed: c.isValidEffort('opencode', 'thinking', 'provider/new') }));
  `], { encoding: "utf8", windowsHide: true, env: { ...process.env, CC_DATA_DIR: root, CC_TEST_FORCE_PACKAGED: "1", CC_SAVED_FIXTURE: file } });
  assert.equal(restart.status, 0, restart.stderr);
  const restarted = JSON.parse(restart.stdout.trim());
  assert.deepEqual(restarted.saved, loaded); assert.equal(restarted.valid, true); assert.equal(restarted.borrowed, false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).projects[0].tabs[1].fixedCrew.version, 99);
});

test("manual model changes cannot inherit a saved missing effort; supported control stays selectable", (t) => {
  noVendor(t);
  config.applyOpenCodeModels(catalogue().opencodeModelInfo, {});
  assert.equal(config.isValidEffort("opencode", "thinking", "provider/control"), true);
  assert.equal(config.isValidEffort("opencode", "thinking", "provider/new"), false);
  const root = ownedTemp(t); let workspace = config.defaultWorkspaces(root);
  workspace.projects[0].tabs[0].fixedCrew = prefs.setCrewAssignment(prefs.freshFixedCrew(), "coder", pair);
  const service = main.createFixedCrewService({ workspace: () => workspace, selectedTabId: () => "example-development",
    catalogue: () => catalogue([info("provider/new", []), info("provider/control", ["thinking"])]), seatBusy: () => false, leaderActive: () => false, writeWorkspace() {},
    setWorkspace: (draft) => { workspace = draft; }, announce() {} });
  assert.doesNotThrow(() => service.change("example-development", "setCrewAssignment", "coder", pair), "a missing saved pair remains selectable on the same model");
  assert.throws(() => service.change("example-development", "setCrewAssignment", "coder", { ...pair, model: "provider/new" }), /Unknown crew effort/);
  service.change("example-development", "setCrewAssignment", "coder", { ...pair, model: "provider/control" });
  assert.equal(workspace.projects[0].tabs[0].fixedCrew!.preferences.coder.assignment!.effort, "thinking");
});

test("Auto assign recomputes efforts for each candidate, including independence alternatives", (t) => {
  noVendor(t);
  const models = [info("opencode/claude-sonnet-5-5", ["medium"]), info("opencode/gpt-6.1-sol", [])];
  const cat = catalogue(models);
  cat.clis.push({ id: "acp:fixture", installed: true, models: ["default"], efforts: ["default"], advisor: false } as any);
  const selected = prefs.fillCrew(prefs.freshFixedCrew(), cat, true);
  const picked = Object.values(selected.preferences).flatMap((p) => p.assignment ? [p.assignment] : []);
  assert.ok(picked.length > 0);
  for (const pick of picked) if (pick.cli === "opencode") assert.ok(assignments.effortChoices(cat.clis[0], pick.model, cat).includes(pick.effort), JSON.stringify(pick));
  // Ensure an alternative of the SAME CLI is actually chosen for independence.
  const writer = { assignment: { cli: "opencode", model: models[0].value, effort: "medium" }, source: "user" } as const;
  const next = assignments.autoFillPreferences({ coder: writer } as any, cat);
  const alternatives = Object.values(next).flatMap((p) => p.assignment?.model === models[1].value ? [p.assignment] : []);
  assert.ok(alternatives.length, "control: the alternate OpenCode model was selected");
  for (const pick of alternatives) assert.equal(pick.effort, "", "an alternate model cannot borrow medium");
  const control = prefs.fillCrew(prefs.freshFixedCrew(), catalogue([info("opencode/gpt-6.1-sol", ["medium"])]), true);
  assert.equal(control.preferences.coder.assignment!.effort, "medium", "reported effort stays on its supporting model");
});

test("bulk assignment keeps supported efforts and clears unsupported efforts on the destination model", (t) => {
  noVendor(t);
  const crew = prefs.setCrewAssignment(prefs.freshFixedCrew(), "coder", pair);
  for (const [model, expected] of [["provider/new", ""], ["provider/control", "thinking"]]) {
    const result = bulk.bulkAssignment(crew, catalogue(), "opencode", model, bulk.assignmentsDigest(crew), true, () => false);
    assert.deepEqual(result.crew.preferences.coder.assignment, { ...pair, model, effort: expected });
    assert.deepEqual(crew.preferences.coder.assignment, pair, "input was not rewritten");
  }
});
