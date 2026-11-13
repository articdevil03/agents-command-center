import test from "node:test";
import assert from "node:assert/strict";
import { importWithTempDataRoot } from "./temp-root.ts";
const { modules: { bulk, prefs, roster } } = await importWithTempDataRoot(async () => ({
  bulk: await import("../server/fixed-crew/bulk-assignment.ts"),
  prefs: await import("../server/fixed-crew/preferences.ts"),
  roster: await import("../server/fixed-crew/roster.ts"),
}));
const catalogue = { clis: [
  { id: "codex", installed: true, models: ["gpt-6.1-sol"], efforts: ["low", "medium", "high"], advisor: false },
  { id: "claude", installed: true, models: ["claude-sonnet-5-5[1m]"], efforts: ["low", "medium", "high"], advisor: true },
  { id: "opencode", installed: true, efforts: ["low", "medium"], advisor: false },
  { id: "acp:local", installed: true, models: ["default"], efforts: ["default"], advisor: false },
], claudeModels: [{ value: "claude-fable-5-1", displayName: "Fable" }] };
const model = { cli: "codex", model: "gpt-6.1-sol", effort: "medium" } as const;
function apply(crew = prefs.freshFixedCrew(), options: any = {}) {
  return bulk.bulkAssignment(crew, options.catalogue ?? catalogue, options.cli ?? model.cli,
    Object.hasOwn(options, "model") ? options.model : model.model, options.digest ?? bulk.assignmentsDigest(crew), options.confirm ?? true, options.busy ?? (() => false));
}

test("FCB stale digest, installed inventory, model and envelope values are validated", () => {
  assert.throws(() => apply(undefined, { digest: "stale" }), /Crew choices changed/);
  for (const installed of [false, null, undefined]) {
    assert.throws(() => apply(undefined, { catalogue: { clis: [{ ...catalogue.clis[0], installed }] } }), /unavailable/);
  }
  assert.throws(() => apply(undefined, { cli: "missing" }), /unavailable/);
  for (const model of ["gpt-unknown", "--bad", null, {}, 1]) assert.throws(() => apply(undefined, { model }));
  assert.throws(() => apply(undefined, { confirm: "true" }), /confirmReplace/);
  assert.equal(apply(undefined, { cli: "opencode", model: "provider/custom-model" }).changed.length, 18);
  assert.equal(apply(undefined, { cli: "acp:local", model: "default" }).crew.preferences.coder.assignment?.effort, "default");
  assert.throws(() => apply(undefined, { cli: "acp:local", model: "other" }), /ACP/);
});

test("FCB user choices including deliberate null require confirmation and auto fill preserves them", () => {
  for (const assignment of [null, { ...model, model: "gpt-old" }]) {
    const crew = prefs.setCrewAssignment(prefs.freshFixedCrew(), "coder", assignment);
    const before = structuredClone(crew);
    assert.throws(() => apply(crew, { confirm: false }), /Confirm replacing/);
    assert.deepEqual(crew, before);
    const result = apply(crew);
    assert.deepEqual(result.crew.preferences.coder, { assignment: model, source: "user" });
    assert.deepEqual(prefs.fillCrew(crew, catalogue, true).preferences.coder, crew.preferences.coder);
  }
  const once = apply().crew;
  assert.equal(apply(once, { confirm: false }).changed.length, 0);
  assert.throws(() => apply(once, { digest: bulk.assignmentsDigest(prefs.freshFixedCrew()) }), /Crew choices changed/);
});

test("FCB detached setter preserves extras and definitions, reports labeled busy positions", () => {
  const crew = prefs.freshFixedCrew(); crew.roleExtras = { coder: "  literal </textarea>\n", leader: "keep" };
  const before = structuredClone(crew), definitions = structuredClone(roster.FIXED_CREW);
  const result = apply(crew, { busy: (slot: string) => slot === "coder" });
  assert.equal(result.changed.length, 17);
  assert.deepEqual(result.skipped, [{ slot: "coder", label: "Coder" }]);
  assert.deepEqual(result.crew.preferences.coder, before.preferences.coder);
  for (const { slot, label } of result.changed) {
    assert.ok(label); assert.deepEqual(result.crew.preferences[slot], { assignment: model, source: "user" }, slot);
  }
  assert.deepEqual(result.crew.roleExtras, before.roleExtras);
  assert.notEqual(result.crew.roleExtras, crew.roleExtras);
  assert.deepEqual(crew, before); assert.deepEqual(roster.FIXED_CREW, definitions);
  const all = apply(crew, { busy: () => true });
  assert.deepEqual(all.crew, before); assert.equal(all.changed.length, 0); assert.equal(all.skipped.length, 18);
  assert.equal(all.notice, "All positions are busy. No choices changed.");
});

test("FCB effort and advisor conversion uses each position's supported values", () => {
  let crew = prefs.freshFixedCrew();
  crew = prefs.setCrewAssignment(crew, "coder", { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "high", advisor: "claude-fable-5-1" });
  crew = prefs.setCrewAssignment(crew, "helper", { ...model, effort: "obsolete" });
  const claude = apply(crew, { cli: "claude", model: "claude-sonnet-5-5[1m]" }).crew;
  assert.equal(claude.preferences.coder.assignment?.advisor, "claude-fable-5-1");
  assert.equal(claude.preferences.coder.assignment?.effort, "high");
  assert.equal(claude.preferences.helper.assignment?.effort, "medium");
  const codex = apply(crew).crew;
  assert.equal(codex.preferences.coder.assignment?.advisor, undefined);
  assert.equal(codex.preferences.coder.assignment?.effort, "high");
  const without = apply(crew, { cli: "claude", model: "claude-sonnet-5-5[1m]", catalogue: { ...catalogue, claudeModels: [] } }).crew;
  assert.equal(without.preferences.coder.assignment?.advisor, undefined);
  const digest = bulk.assignmentsDigest(crew);
  crew.roleExtras.coder = "different extras"; assert.equal(bulk.assignmentsDigest(crew), digest);
  crew.preferences.coder.source = "auto"; assert.notEqual(bulk.assignmentsDigest(crew), digest);
});
