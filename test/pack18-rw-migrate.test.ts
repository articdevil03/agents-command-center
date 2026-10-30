// Pack 18 rework, D5: a real server started on files written before the crew's roles decided the steps (custom steps, no steps, the pack 18 shape of Our process,
// and a saved setup with custom steps). Every one loads, its roles are mapped, its steps are derived, one console line names each, and the one-time backup
// workspaces.before-roles.json is written before the first write and left alone after.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importWithTempDataRoot } from "./temp-root.ts";
import { boot, client, workspaceBytes, workspaceFile, type Client, type Server } from "./pack18-harness.ts";

const { modules: { config } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));
const OUR = config.templateCopy("our-process");
const { deriveSteps } = await import("../server/process.ts");
const currentCrew = [seatForCurrent("leader", "Leader"), seatForCurrent("coder", "Coder"), seatForCurrent("custom", "Coder 2"), seatForCurrent("odd", "Reviewer (odd rounds)")];
function seatForCurrent(slot: string, role: string) { return { slot, name: slot, role, cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium", canWrite: slot === "coder", isLeader: slot === "leader" }; }
const currentSteps = deriveSteps(currentCrew as any, true);

const seat = (slot: string, name: string, role: string, canWrite: boolean, extra: Record<string, unknown> = {}) => ({ slot, name, role, cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium", canWrite, isLeader: slot === "leader", ...extra });
const work = (id: string, label: string, ...owners: string[]) => ({ id, label, type: "work", owners });
const look = { id: "look", label: "Your look", type: "look", owners: ["user"] };
const rounds = (id: string, label: string, ...pairs: object[]) => ({ id, label, type: "rounds", pairs });
const finish = (id: string, label: string, ...owners: string[]) => ({ id, label, type: "finish", owners });

const CUSTOM = {
  crew: [seat("leader", "Lia", "Leads the design", false), seat("designer", "Dee", "UI designer", true), seat("second", "Sam", "Second opinion and research", false)],
  steps: [work("brief", "Brief", "leader"), work("mock", "Mock", "designer"), work("second", "Second opinion", "second"), look, rounds("review", "Review", { reviewer: "second", fixers: ["designer"] }), finish("handOff", "Hand off", "leader")],
};
const ZERO = { crew: [seat("leader", "Zed", "Leader", false), seat("writer", "Wes", "Writer", true)], steps: [] as object[] };
// Our process as pack 18 stored it: numbered roles, a Brief step and a "finalReview" id, and no look switch.
const PACK18 = {
  crew: OUR.crew.map((member: any) => ({ ...member, role: { Reviewer: `Reviewer ${member.slot.endsWith("2") ? 2 : 1}`, Fixer: `Fixer ${member.slot.endsWith("2") ? 2 : 1}` }[member.role as string] ?? member.role })),
  steps: [work("brief", "Brief", "planner"), work("build", "Build", "coder"), work("gate", "Gate", "planner"), look, rounds("review", "Review", { reviewer: "reviewer1", fixers: ["fixer1"] }, { reviewer: "reviewer2", fixers: ["fixer2"] }), work("finalReview", "Final review", "final"), finish("ship", "Ship", "planner")],
};
const SAVED = {
  id: "mine", name: "Mine", kind: "dev",
  crew: [seat("leader", "Lou", "Leader", false), seat("maker", "Max", "Maker", true), seat("checker", "Chi", "Checker", false)],
  steps: [work("brief", "Brief", "leader"), work("build", "Build", "maker"), look, rounds("review", "Review", { reviewer: "checker", fixers: ["maker"] }), finish("ship", "Ship", "leader")],
};

// A pack 18 tab and saved setup (lookPause is there) of Leader + Reviewer + a custom "Coder 2", with the steps as the derive gave them BEFORE the rule "nobody reviews
// their own work" (the leader did the final review): the steps are derived again on read, and the custom role name is never re-mapped.
const KEPT_CREW = [seat("leader", "Lia", "Leader", false), seat("rev", "Rae", "Reviewer", false), seat("custom", "Cody", "Coder 2", true)];
const KEPT_STEPS = [work("plan", "Plan", "leader"), work("build", "Build", "leader"), work("gate", "Gate", "leader"), rounds("review", "Review", { reviewer: "rev", fixers: ["leader"] }), work("final", "Final review", "leader"), finish("ship", "Ship", "leader")];
const KEPT = { id: "kept", name: "Kept", kind: "dev", crew: KEPT_CREW, lookPause: false, steps: KEPT_STEPS };

let srv: Server, c: Client, original = "";
before(async () => {
  srv = await boot({
    extra: ({ data }) => writeFileSync(join(data, "config", "setups.json"), JSON.stringify({ setups: [SAVED, KEPT] })),
    tabs: (folder) => [
      { id: "m-current", name: "current", kind: "dev", folder, setupName: "Custom", crew: currentCrew, lookPause: true, steps: currentSteps },
      { id: "m-oldcoder", name: "old coder", kind: "dev", folder, setupName: "Old", crew: [seat("leader", "L", "Leader", false), seat("coder", "C", "Coder 2", true)], steps: [] },
      { id: "m-custom", name: "custom", kind: "dev", folder, setupName: "Mine", crew: CUSTOM.crew, steps: CUSTOM.steps },
      { id: "m-zero", name: "zero", kind: "dev", folder, setupName: "Mine", crew: ZERO.crew, steps: ZERO.steps },
      { id: "m-kept", name: "kept", kind: "dev", folder, setupName: "Kept", crew: KEPT_CREW, lookPause: false, steps: KEPT_STEPS },
      { id: "m-p18", name: "p18", kind: "dev", folder, setupName: "Our process", crew: PACK18.crew, steps: PACK18.steps },
    ],
  });
  original = workspaceBytes(srv);
  c = await client(srv);
});
after(async () => { c?.close(); await srv?.stop(); });

const rolesOf = (tabId: string) => c.tab(tabId).crew.map((member: any) => [member.slot, member.role]);
const stepsOf = (steps: any[]) => steps.map((step) => [step.id, step.owners ?? step.pairs.map((pair: any) => `${pair.reviewer}>${pair.fixers}`)]);
const backup = () => join(srv.data, "config", "workspaces.before-roles.json");

test("D5 old tabs and a saved setup load: roles mapped, steps derived, one console line each, and the file is untouched until the first write", { timeout: 60_000 }, async () => {
  // Custom steps (Brief, Mock, Second opinion): the designer who builds becomes a Coder, the pair's reviewer a Reviewer, the look switch is on because a look step was there.
  assert.deepEqual(rolesOf("m-custom"), [["leader", "Leader"], ["designer", "Coder"], ["second", "Reviewer"]]);
  assert.equal(c.tab("m-custom").lookPause, true);
  assert.deepEqual(stepsOf(c.tab("m-custom").steps), [["plan", ["leader"]], ["build", ["designer"]], ["gate", ["leader"]], ["look", ["user"]], ["review", ["second>designer"]], ["final", ["leader"]], ["ship", ["leader"]]]);
  // No steps at all: nothing explains the Writer, so its text stays (a custom role) and the tab just chats with its leader.
  assert.deepEqual(rolesOf("m-zero"), [["leader", "Leader"], ["writer", "Writer"]]);
  assert.deepEqual([c.tab("m-zero").lookPause, c.tab("m-zero").steps], [false, []]);
  // The pack 18 shape of Our process: the numbers are stripped and it derives exactly what Our process derives now.
  assert.deepEqual(rolesOf("m-p18").map(([, role]: string[]) => role), OUR.crew.map((member: any) => member.role));
  assert.deepEqual([c.tab("m-p18").lookPause, c.tab("m-p18").steps], [true, OUR.steps]);
  // The saved setup with custom steps.
  const saved = c.state().savedSetups.find((item: any) => item.id === "mine");
  assert.deepEqual(saved.crew.map((member: any) => [member.slot, member.role]), [["leader", "Leader"], ["maker", "Coder"], ["checker", "Reviewer"]]);
  assert.deepEqual([saved.lookPause, saved.steps.map((step: any) => step.id)], [true, ["plan", "build", "gate", "look", "review", "final", "ship"]]);

  const log = srv.log();
  const lines = [
    ["tab m-custom", "brief, mock, second, look, review, handOff"], ["tab m-zero", "none"], ["tab m-p18", "brief, build, gate, look, review, finalReview, ship"],
    ["saved setup mine", "brief, build, look, review, ship"],
  ];
  for (const [who, was] of lines) {
    const line = `${who}: steps are now derived from the crew's roles (was: ${was})`;
    assert.equal(log.split(line).length - 1, 1, `exactly one console line: ${line}`);
  }
  console.log(`D5 console lines:\n  ${log.split(/\r?\n/).filter((line) => line.includes("steps are now derived")).join("\n  ")}`);
  assert.equal(workspaceBytes(srv), original, "starting the server wrote nothing");
  assert.equal(existsSync(backup()), false, "and no backup yet");
});

test("D5 the first write keeps the old file once (workspaces.before-roles.json), the new shape is on disk, and a second write leaves the copy alone", { timeout: 60_000 }, async () => {
  c.send({ type: "updateSeat", tabId: "m-custom", slot: "designer", name: "Dee Dee" });
  await c.wait(() => c.tab("m-custom").crew.find((member: any) => member.slot === "designer").name === "Dee Dee", "the rename arrives");
  assert.ok(existsSync(backup()), "the one-time backup is on disk after the first write");
  assert.equal(readFileSync(backup(), "utf8"), original, "the backup is the old file, byte for byte");
  assert.equal(existsSync(join(srv.data, "config", "workspaces.before-setups.json")), false, "the other backup is for another shape");
  const tabs = workspaceFile(srv).projects[0].tabs;
  for (const tab of tabs) assert.equal(typeof tab.lookPause, "boolean", `${tab.id}: lookPause is on disk`);
  assert.deepEqual(tabs.find((tab: any) => tab.id === "m-custom").steps.map((step: any) => step.id), ["plan", "build", "gate", "look", "review", "final", "ship"]);
  assert.deepEqual(tabs.find((tab: any) => tab.id === "m-p18").crew.map((member: any) => member.role), OUR.crew.map((member: any) => member.role));
  c.send({ type: "updateSeat", tabId: "m-zero", slot: "writer", name: "Wes Two" });
  await c.wait(() => c.tab("m-zero").crew.find((member: any) => member.slot === "writer").name === "Wes Two", "a second write");
  assert.equal(readFileSync(backup(), "utf8"), original, "written only if missing: the second write keeps the first copy");
  assert.equal(srv.log().split("steps are now derived").length - 1, 5, "and no tab was announced twice");
});

test("D5 current custom role suffixes and steps survive reads, while old Coder 2 migrates", () => {
  assert.deepEqual(c.tab("m-current").crew.map((member: any) => member.role), currentCrew.map((member) => member.role));
  assert.deepEqual(c.tab("m-current").steps, currentSteps);
  assert.equal(c.tab("m-oldcoder").crew.find((member: any) => member.slot === "coder").role, "Coder");
});

test("D5 a tab and a saved setup that carry lookPause keep their custom role names, get the new derived steps, and are never announced or backed up", () => {
  const steps = (list: any[]) => list.find((step: any) => step.id === "final").owners;
  const saved = c.state().savedSetups.find((item: any) => item.id === "kept");
  for (const [who, crew, list] of [["tab", c.tab("m-kept").crew, c.tab("m-kept").steps], ["saved setup", saved.crew, saved.steps]] as const) {
    assert.deepEqual(crew.map((member: any) => member.role), ["Leader", "Reviewer", "Coder 2"], `${who}: "Coder 2" stays`);
    assert.deepEqual(steps(list), ["rev"], `${who}: the Reviewer does the final review now, not the leader`);
  }
  assert.equal(srv.log().includes("tab m-kept:") || srv.log().includes("saved setup kept:"), false, "no console line names them");
  assert.deepEqual(workspaceFile(srv).projects[0].tabs.find((tab: any) => tab.id === "m-kept").crew.map((member: any) => member.role), ["Leader", "Reviewer", "Coder 2"], "and the file keeps the role too");
});
