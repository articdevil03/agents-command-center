import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProcessDefinition } from "../server/process.ts";
import type { Workspaces } from "../server/config.ts";
import { importWithTempDataRoot } from "./temp-root.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

// config.ts reads its data root at import: it is loaded on a fresh temp folder, never on the repo's own (live) config/.
const { modules: { config: { CLAUDE_MODEL_INFO, EFFORT_OPTIONS, MODEL_OPTIONS, migrateWorkspaces, readWorkspaces, writeWorkspaces, templateCopy } } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));

function tempDir(): string { return mkdtempSync(join(tmpdir(), "cc-workspaces-test-")); }
function defaults(kind: "dev" | "design" | "mkt", process: "main" | "duo" | "solo") {
  return getProcessDefinition(kind, process).seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort }));
}
// The fixtures below are files in the OLD shape (a process id, no steps): reading one migrates it, and that is the shape a write takes.
function modern(value: unknown): Workspaces {
  const dir = tempDir();
  try { const path = join(dir, "old.json"); writeFileSync(path, JSON.stringify(value)); return readWorkspaces(path); } finally { removeWithRetry(dir); }
}
function fixture(): any {
  return { projects: [{ id: "alpha", name: "Alpha", folder: "C:/work/alpha", tabs: [
    { id: "alpha-development", name: "Development", kind: "dev", process: "main", folder: "C:/work/alpha", crew: defaults("dev", "main") },
  ] }] };
}

test("workspace schema validates unique project/tab/seat identities and exact process slots", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "workspaces.json");
    writeFileSync(path, JSON.stringify(fixture()));
    assert.deepEqual(readWorkspaces(path).projects[0].tabs[0].crew.map((seat) => seat.slot), defaults("dev", "main").map((seat) => seat.slot));
    const duplicateTab = fixture();
    duplicateTab.projects.push({ id: "beta", name: "Beta", folder: "C:/work/beta", tabs: [duplicateTab.projects[0].tabs[0]] });
    writeFileSync(path, JSON.stringify(duplicateTab));
    assert.throws(() => readWorkspaces(path), /duplicate tab id/);
    const duplicateProject = fixture();
    duplicateProject.projects.push({ ...duplicateProject.projects[0], name: "Other" });
    writeFileSync(path, JSON.stringify(duplicateProject));
    assert.throws(() => readWorkspaces(path), /duplicate project id/);
    const missingSlot = fixture();
    missingSlot.projects[0].tabs[0].crew.pop();
    writeFileSync(path, JSON.stringify(missingSlot));
    assert.throws(() => readWorkspaces(path), /crew slot count/);
    // reviewer1 and fixer share CLI, model, and effort, so only duplicate
    // detection can reject a fixer relabelled as a second reviewer1.
    const duplicateSlot = fixture();
    const crew = duplicateSlot.projects[0].tabs[0].crew;
    const reviewer1 = crew.find((seat) => seat.slot === "reviewer1")!, fixer = crew.find((seat) => seat.slot === "fixer")!;
    assert.deepEqual([fixer.cli, fixer.model, fixer.effort], [reviewer1.cli, reviewer1.model, reviewer1.effort]);
    fixer.slot = "reviewer1";
    writeFileSync(path, JSON.stringify(duplicateSlot));
    assert.throws(() => readWorkspaces(path), /invalid slot\/model\/effort for "alpha-development\.reviewer1"/);
    const emptyTabs = fixture();
    emptyTabs.projects[0].tabs = [];
    writeFileSync(path, JSON.stringify(emptyTabs));
    assert.throws(() => readWorkspaces(path), /at least one tab/);
  } finally { removeWithRetry(dir); }
});

test("workspace loader names unknown kind/process and rejects invalid models, efforts, and seat keys", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "workspaces.json");
    const value = fixture();
    value.projects[0].tabs[0].kind = "unknown" as any;
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => readWorkspaces(path), /unknown kind\/process/);
    const unknownProcess = fixture();
    unknownProcess.projects[0].tabs[0].process = "bad";
    writeFileSync(path, JSON.stringify(unknownProcess));
    assert.throws(() => readWorkspaces(path), /unknown kind\/process "dev\/bad"/);
    const badModel = fixture();
    badModel.projects[0].tabs[0].crew.find((seat) => seat.slot === "coder")!.model = "gpt-6-luna & injected";
    writeFileSync(path, JSON.stringify(badModel));
    assert.throws(() => readWorkspaces(path), /invalid slot\/model\/effort/);
    const badEffort = fixture();
    badEffort.projects[0].tabs[0].crew.find((seat) => seat.slot === "coder")!.effort = "turbo & x";
    writeFileSync(path, JSON.stringify(badEffort));
    assert.throws(() => readWorkspaces(path), /invalid slot\/model\/effort/);
    // Was: effort "turbo" (safe but unlisted) threw at load. A load checks shape only (round 8); a write still checks the live list.
    badEffort.projects[0].tabs[0].crew.find((seat) => seat.slot === "coder")!.effort = "turbo";
    writeFileSync(path, JSON.stringify(badEffort));
    assert.equal(readWorkspaces(path).projects[0].tabs[0].crew.find((seat) => seat.slot === "coder")!.effort, "turbo");
    assert.throws(() => writeWorkspaces(modern(badEffort), path), /invalid slot\/model\/effort/);
    const unsafeTab = fixture();
    unsafeTab.projects[0].tabs[0].id = "bad.tab";
    writeFileSync(path, JSON.stringify(unsafeTab));
    assert.throws(() => readWorkspaces(path), /bad tab/);
    const badAdvisor = fixture();
    badAdvisor.projects[0].tabs[0].advisor = { model: "not a model" } as any; // was "not-a-claude-model": safe shapes load now
    writeFileSync(path, JSON.stringify(badAdvisor));
    assert.throws(() => readWorkspaces(path), /invalid advisor/);
    const badPic = fixture();
    badPic.projects[0].tabs[0].crew[0].pic = "bad\u0000pic";
    writeFileSync(path, JSON.stringify(badPic));
    assert.throws(() => readWorkspaces(path), /invalid pic/);
  } finally { removeWithRetry(dir); }
});

test("fallback model lists contain only the probed Codex IDs and the Claude 5.5 1M option", () => {
  assert.deepEqual(MODEL_OPTIONS.codex, ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol"]);
  assert.ok(MODEL_OPTIONS.claude?.includes("claude-opus-5-5[1m]"));
  assert.ok(MODEL_OPTIONS.claude?.includes("claude-sonnet-5-5[1m]") && MODEL_OPTIONS.claude?.includes("claude-fable-5-1"), "the models Our process uses are in the built-in list");
  assert.ok(CLAUDE_MODEL_INFO.some((model) => model.value === "claude-opus-5-5[1m]" && model.supportsEffort));
  assert.ok(EFFORT_OPTIONS.codex.includes("max"));
});

test("migration creates one default Development tab per project and ignores old seat picks", () => {
  const dir = tempDir();
  try {
    const projectsPath = join(dir, "projects.json"), destination = join(dir, "workspaces.json");
    writeFileSync(projectsPath, JSON.stringify([
      { id: "alpha", name: "Alpha", dir: "C:/work/alpha" },
      { id: "beta", name: "Beta", dir: "C:/work/beta" },
    ]));
    const seatsPath = join(dir, "seats.json"), oldSeats = '[{"id":"ignored-old-pick","model":"old"}]\n';
    const undergroundPath = join(dir, "underground.json"), oldUnderground = '[{"custom":"leave untouched"}]\n';
    writeFileSync(seatsPath, oldSeats);
    writeFileSync(undergroundPath, oldUnderground);
    assert.equal(migrateWorkspaces(projectsPath, destination), true);
    const migrated = readWorkspaces(destination);
    assert.deepEqual(migrated.projects.map((project) => project.tabs[0].id), ["alpha-development", "beta-development"]);
    for (const project of migrated.projects) {
      assert.equal(project.tabs.length, 1);
      assert.equal(project.tabs[0].kind, "dev");
      assert.equal("process" in project.tabs[0], false);
      assert.equal(project.tabs[0].setupName, "Our process");
      assert.deepEqual(project.tabs[0].crew, templateCopy("our-process").crew);
      assert.deepEqual(project.tabs[0].steps, templateCopy("our-process").steps);
    }
    assert.equal(readFileSync(seatsPath, "utf8"), oldSeats);
    assert.equal(readFileSync(undergroundPath, "utf8"), oldUnderground);
  } finally { removeWithRetry(dir); }
});

test("migration is a write: a generated default that is safe-shaped but not in its live list is refused and nothing is published", () => {
  const dir = tempDir();
  const live = MODEL_OPTIONS.claude;
  try {
    const projectsPath = join(dir, "projects.json"), destination = join(dir, "workspaces.json");
    writeFileSync(projectsPath, JSON.stringify([{ id: "alpha", name: "Alpha", dir: "C:/work/alpha" }]));
    const claudeDefaults = new Set(templateCopy("our-process").crew.filter((seat) => seat.cli === "claude").map((seat) => seat.model));
    assert.ok(claudeDefaults.size > 0, "control: the default crew has Claude models");
    MODEL_OPTIONS.claude = live!.filter((model) => !claudeDefaults.has(model));
    assert.throws(() => migrateWorkspaces(projectsPath, destination), /invalid slot\/model\/effort/);
    assert.equal(existsSync(destination), false, "nothing was published");
  } finally { MODEL_OPTIONS.claude = live; removeWithRetry(dir); }
});

test("migration never replaces an existing workspaces file", () => {
  const dir = tempDir();
  try {
    const projectsPath = join(dir, "projects.json"), destination = join(dir, "workspaces.json");
    writeFileSync(projectsPath, JSON.stringify([{ id: "alpha", name: "Alpha", dir: "C:/alpha" }]));
    const existing = '{"projects":[]}\n';
    writeFileSync(destination, existing);
    assert.equal(migrateWorkspaces(projectsPath, destination), false);
    assert.equal(readFileSync(destination, "utf8"), existing);
  } finally { removeWithRetry(dir); }
});

test("workspace writes validate before publishing any invalid shape", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "workspaces.json");
    const value = modern(fixture());
    writeWorkspaces(value, path);
    const invalid = modern(fixture());
    invalid.projects[0].tabs[0].crew[0].cli = "opencode" as any;
    invalid.projects[0].tabs[0].crew[0].model = "no-slash-model";
    invalid.projects[0].tabs[0].crew[0].effort = "max";
    assert.throws(() => writeWorkspaces(invalid, path), /invalid slot\/model\/effort/);
    assert.deepEqual(readWorkspaces(path), value);
  } finally { removeWithRetry(dir); }
});

test("a seat moved to another CLI is a valid saved workspace, and its model must belong to that CLI", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "workspaces.json");
    const moved = modern(fixture());
    const seat = moved.projects[0].tabs[0].crew[0];
    seat.cli = seat.cli === "codex" ? "opencode" as any : "codex" as any;
    seat.model = seat.cli === "codex" ? "gpt-6-sol" : "vendor/model-v1";
    seat.effort = seat.cli === "codex" ? "high" : "max";
    writeWorkspaces(moved, path);
    assert.deepEqual(readWorkspaces(path), moved);
    seat.model = "claude-opus-5-5[1m]";
    assert.throws(() => writeWorkspaces(moved, path), /invalid slot\/model\/effort/);
  } finally { removeWithRetry(dir); }
});

test("readWorkspaces migrates the earlier leader preset and old photo presets saved WITH a leading slash too (the page accepts both forms)", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "workspaces.json");
    const data = fixture();
    const crew = data.projects[0].tabs[0].crew;
    const old = ["boo", "gie"].join("");
    const worker = 2; // neither of the two seats below
    crew[worker].pic = `/avatars/${old}.svg`;
    crew[0].pic = `/avatars/${old}.jpg`;
    crew[1].pic = "/avatars/astra.png";
    writeFileSync(path, JSON.stringify(data));
    const read = readWorkspaces(path).projects[0].tabs[0].crew;
    assert.equal(read[worker].pic, "avatars/atlas.svg", "a non-leader seat saved with a slash loads as the atlas preset");
    assert.equal(read[0].pic, "avatars/atlas.svg");
    assert.equal("pic" in read[1], false, "an old photo with no flat SVG is dropped");
  } finally { removeWithRetry(dir); }
});

test("readWorkspaces moves old photo presets to the flat SVG, drops presets with no SVG, and leaves uploads and other fields alone", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "workspaces.json");
    const data = fixture();
    const crew = data.projects[0].tabs[0].crew;
    const upload = "/api/avatar/avatar-12345678-1234-1234-1234-123456789abc.png";
    const old = ["boo", "gie"].join(""); // the leader's earlier default name, saved in older workspaces
    crew[0].pic = `avatars/${old}.jpg`;
    crew[4].pic = `avatars/${old}.svg`;
    crew[5].name = old[0].toUpperCase() + old.slice(1);
    crew[1].pic = "avatars/astra.png";
    crew[2].pic = upload;
    crew[3].pic = "avatars/me-3.jpg";
    writeFileSync(path, JSON.stringify(data));
    const read = readWorkspaces(path).projects[0].tabs[0].crew;
    assert.equal(read[0].pic, "avatars/atlas.svg");
    assert.equal(read[4].pic, "avatars/atlas.svg", "a saved flat preset of the earlier name moves too");
    assert.equal(read[5].name, crew[5].name, "a seat the user saved under the earlier default name keeps it");
    assert.equal("pic" in read[1], false);
    assert.equal(read[2].pic, upload);
    assert.equal("pic" in read[3], false);
    assert.equal(read[1].name, crew[1].name);
    assert.equal(read[1].model, crew[1].model);
    writeWorkspaces(readWorkspaces(path), path);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).projects[0].tabs[0].crew[0].pic, "avatars/atlas.svg");
  } finally { removeWithRetry(dir); }
});
