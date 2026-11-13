import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import { importWithTempDataRoot } from "./temp-root.ts";
import { fixedProject, fixedTab, fixedWorkspaces } from "./fixed-server-fixture.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

// config.ts reads its data root at import: it is loaded on a fresh temp folder, never on the repo's own (live) config/.
const { modules: { config: { CLAUDE_MODEL_INFO, EFFORT_OPTIONS, MODEL_OPTIONS, fixedCrewRecovery, readWorkspaces, writeWorkspaces } } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));

function tempDir(): string { return mkdtempSync(join(tmpdir(), "cc-workspaces-test-")); }
const alphaFolder = "C:/work/alpha";
function fixture(): any { return fixedWorkspaces([fixedProject("alpha", alphaFolder)]); }
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const codexCoder = { cli: "codex", model: "gpt-6-sol", effort: "high" } as const;

test("workspace schema validates unique project and tab identities and at least one tab", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "workspaces.json");
    save(path, fixture());
    const all = readWorkspaces(path);
    assert.equal(all.projects.length, 1, "the saved project is loaded, never an empty list");
    const loaded = all.projects[0].tabs[0];
    assert.deepEqual(Object.keys(loaded.fixedCrew!.preferences), FIXED_CREW.map((seat) => seat.slot), "every fixed slot is present on a loaded tab");
    assert.deepEqual([loaded.crew, loaded.steps, loaded.lookPause], [[], [], false], "the compatibility fields stay empty");
    const duplicateTab = fixture();
    duplicateTab.projects.push(fixedProject("beta", "C:/work/beta", [fixedTab("alpha-development", "C:/work/beta")]));
    save(path, duplicateTab);
    assert.throws(() => readWorkspaces(path), /duplicate tab id/);
    const duplicateProject = fixture();
    duplicateProject.projects.push({ ...fixedProject("alpha", alphaFolder), name: "Other" });
    save(path, duplicateProject);
    assert.throws(() => readWorkspaces(path), /duplicate project id/);
    const emptyTabs = fixture();
    emptyTabs.projects[0].tabs = [];
    save(path, emptyTabs);
    assert.throws(() => readWorkspaces(path), /at least one tab/);
  } finally { removeWithRetry(dir); }
});

test("workspace loader names an unknown kind and an unsafe tab id; a damaged fixed crew recovers instead of failing the load", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "workspaces.json");
    const unknownKind = fixture();
    unknownKind.projects[0].tabs[0].kind = "unknown";
    save(path, unknownKind);
    assert.throws(() => readWorkspaces(path), /unknown kind/);
    const unsafeTab = fixture();
    unsafeTab.projects[0].tabs[0].id = "bad.tab";
    save(path, unsafeTab);
    assert.throws(() => readWorkspaces(path), /bad tab/);
    // A damaged fixed crew is never a thrown load (the old reader threw): the tab loads on a fresh crew and the damage is recorded.
    const damaged: Array<[string, (preferences: any) => void]> = [
      ["unsafe model", (preferences) => { preferences.coder = { assignment: { ...codexCoder, model: "gpt-6-luna & injected" }, source: "user" }; }],
      ["unsafe Claude model", (preferences) => { preferences.leader = { assignment: { cli: "claude", model: "claude-opus & injected", effort: "high" }, source: "user" }; }],
      ["unsafe effort", (preferences) => { preferences.coder = { assignment: { ...codexCoder, effort: "turbo & x" }, source: "user" }; }],
      ["unsafe advisor", (preferences) => { preferences.leader = { assignment: { cli: "claude", model: "claude-opus-5-5[1m]", effort: "high", advisor: "not a model" }, source: "user" }; }],
      ["unknown slot", (preferences) => { preferences.ghost = { assignment: null, source: "auto" }; }],
    ];
    for (const [name, damage] of damaged) {
      const value = fixture();
      damage(value.projects[0].tabs[0].fixedCrew.preferences);
      save(path, value);
      const tab = readWorkspaces(path).projects[0].tabs[0];
      assert.ok(fixedCrewRecovery(tab.id, path), `${name}: the damage is recorded`);
      assert.ok(Object.values(tab.fixedCrew!.preferences).every((preference) => preference.assignment === null), `${name}: the tab loads on a fresh crew`);
      assert.throws(() => writeWorkspaces(value, path), /Invalid crew|Unknown crew slot|Unknown or locked/, `${name}: a write refuses it`);
    }
    // Was: effort "turbo" (safe but unlisted) threw at load. A load checks shape only (round 8).
    const unlisted = fixture();
    unlisted.projects[0].tabs[0].fixedCrew.preferences.coder = { assignment: { ...codexCoder, effort: "turbo" }, source: "user" };
    save(path, unlisted);
    assert.equal(readWorkspaces(path).projects[0].tabs[0].fixedCrew!.preferences.coder.assignment!.effort, "turbo");
  } finally { removeWithRetry(dir); }
});

test("fallback model lists contain only the probed Codex IDs and the Claude 5.5 1M option", () => {
  assert.deepEqual(MODEL_OPTIONS.codex, ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol"]);
  assert.ok(MODEL_OPTIONS.claude?.includes("claude-opus-5-5[1m]"));
  assert.ok(MODEL_OPTIONS.claude?.includes("claude-sonnet-5-5[1m]") && MODEL_OPTIONS.claude?.includes("claude-fable-5-1"), "the models Our process uses are in the built-in list");
  assert.ok(CLAUDE_MODEL_INFO.some((model) => model.value === "claude-opus-5-5[1m]" && model.supportsEffort));
  assert.ok(EFFORT_OPTIONS.codex.includes("max"));
});

test("workspace writes validate before publishing any invalid shape", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "workspaces.json");
    const value = fixedWorkspaces([fixedProject("alpha", alphaFolder, [fixedTab("alpha-development", alphaFolder, { coder: codexCoder })])]);
    writeWorkspaces(value, path);
    const before = readFileSync(path, "utf8");
    const invalid = fixedWorkspaces([fixedProject("alpha", alphaFolder, [fixedTab("alpha-development", alphaFolder, { coder: { cli: "opencode", model: "no-slash-model", effort: "max" } })])]);
    assert.throws(() => writeWorkspaces(invalid, path), /Invalid crew model/);
    assert.equal(readFileSync(path, "utf8"), before, "the saved bytes are untouched");
    assert.deepEqual(readWorkspaces(path), value);
  } finally { removeWithRetry(dir); }
});

test("a seat moved to another CLI is a valid saved workspace, and its model must belong to that CLI", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "workspaces.json");
    const moved = fixedWorkspaces([fixedProject("alpha", alphaFolder, [fixedTab("alpha-development", alphaFolder, { coder: { cli: "opencode", model: "vendor/model-v1", effort: "max" } })])]);
    writeWorkspaces(moved, path);
    assert.deepEqual(readWorkspaces(path), moved);
    moved.projects[0].tabs[0].fixedCrew!.preferences.coder.assignment = { cli: "codex", model: "claude-opus-5-5[1m]", effort: "high" };
    assert.throws(() => writeWorkspaces(moved, path), /Invalid crew model/);
    assert.equal(existsSync(path), true);
  } finally { removeWithRetry(dir); }
});
