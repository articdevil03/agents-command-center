// Pack 18 follow-up 2 (the owner 2026-10-29: "nobody reviews their own work"): when the leader builds (no Coder, no Design coder) and fixes (no Fixer), it never reviews.
// W1 walks every subset of the real role list through validateSetup and checks the steps with a checker of its own; OW the real server: the three save-site refusals,
// the tab that was saved before the rule still loads, and a Leader + Planner tab run from first step to Ship.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROLES, TEMPLATES, HIDDEN_TEMPLATES, deriveSteps, validateSetup, reviewsOwnWork, type Seat, type Step } from "../server/process.ts";
import { boot, client, clone, workspaceBytes, type Client, type Server } from "./pack18-harness.ts";
import { seat, fakeClis, orchKit } from "./pack18-orch-harness.ts";

// ---- The test's own checker: a seat that reviews (a round's reviewer, a Final review owner) and also writes (Build owner, a round's fixer). ----
function ownWorkOf(steps: readonly Step[]): string[] {
  const writers = new Set<string>(), readers = new Set<string>();
  for (const step of steps) {
    if (step.type === "rounds") for (const pair of step.pairs) { readers.add(pair.reviewer); for (const slot of pair.fixers) writers.add(slot); }
    if (step.type === "work" && step.id === "build") for (const slot of step.owners) writers.add(slot);
    if (step.type === "work" && step.id === "final") for (const slot of step.owners) readers.add(slot);
  }
  return [...readers].filter((slot) => writers.has(slot));
}
// Why one seat per role is enough: the leader writes if and only if no seat has the role Coder or Design coder (it builds) or, failing that builder, no Fixer (it fixes);
// how many seats share a role changes who is paired with whom, never whether the leader is among the writers.
const expectedRefused = (roles: string[]): boolean => !["Coder", "Design coder", "Planner", "Reviewer", "Final reviewer"].some((role) => roles.includes(role)) && roles.includes("Fixer");

const leader: Seat = { slot: "L", name: "Lead", role: "Leader", cli: "claude", model: "claude-opus-5-5[1m]", effort: "low", canWrite: false, isLeader: true };
const crewOf = (roles: readonly string[]): Seat[] => [leader, ...roles.map((role) => ({ slot: `r${ROLES.findIndex((item) => item.name === role)}`, name: role, role, cli: "claude" as const, model: "claude-sonnet-5-5[1m]", effort: "medium", canWrite: ROLES.find((item) => item.name === role)!.canWrite, isLeader: false }))];
const rowOf = (roles: string[]) => {
  const steps = validateSetup({ crew: crewOf(roles), lookPause: false }).steps;
  const owners = (id: string) => (steps.find((step) => step.id === id) as { owners: string[] }).owners;
  const rounds = steps.find((step) => step.type === "rounds");
  return { build: owners("build"), pairs: rounds?.type === "rounds" ? rounds.pairs.map((pair) => `${pair.reviewer}>${pair.fixers.join("+")}`) : [], final: owners("final") };
};

test("W1 every subset of the roles: nobody reviews their own work, except the crews a save refuses", () => {
  const names = ROLES.map((role) => role.name);
  let visited = 0, leaderBuilt = 0, withSteps = 0;
  const refused: string[][] = [];
  for (let mask = 0; mask < 2 ** names.length; mask++) {
    const roles = names.filter((_, bit) => mask & (2 ** bit));
    const { steps } = validateSetup({ crew: crewOf(roles), lookPause: false });
    visited++;
    if (steps.length) withSteps++;
    if (steps.some((step) => step.id === "build" && step.type === "work" && step.owners.includes("L"))) leaderBuilt++;
    const own = ownWorkOf(steps), flagged = reviewsOwnWork(steps);
    assert.deepEqual(flagged === null ? [] : [flagged], own.slice(0, 1), `[${roles}]: reviewsOwnWork and the test's checker agree`);
    if (own.length) refused.push(roles);
    assert.equal(own.length > 0, steps.length > 0 && expectedRefused(roles), `[${roles}]: ${own.length ? `${own} reviews its own work` : "no seat reviews its own work"}`);
  }
  console.log(`W1 visited ${visited} crews, ${withSteps} with steps, leader built in ${leaderBuilt}, refused ${refused.length}: ${refused.map((roles) => `[${roles}]`).join(" ")}`);
  assert.equal(visited, 2 ** ROLES.length, "the walk visited every subset");
  assert.ok(leaderBuilt > 0, "control: some crews have the leader building");
  assert.deepEqual(refused.map((roles) => roles.filter((role) => role !== "Researcher" && role !== "Helper").join(",")), ["Fixer", "Fixer", "Fixer", "Fixer"], "exactly the 4 [Fixer] shapes (with or without a Researcher and Helper)");
  const planted: Step[] = [{ id: "build", label: "Build", type: "work", owners: ["L"] }, { id: "review", label: "Review", type: "rounds", pairs: [{ reviewer: "L", fixers: ["s1"] }] }];
  assert.deepEqual([ownWorkOf(planted), reviewsOwnWork(planted)], [["L"], "L"], "control: both checkers flag the leader in Build and in the rounds");
});

test("W1 every template passes the checker, and the owner's three cases derive as agreed", () => {
  for (const template of [...TEMPLATES, ...HIDDEN_TEMPLATES]) {
    assert.deepEqual(ownWorkOf(template.steps), [], `${template.id}: nobody reviews their own work`);
    assert.deepEqual(deriveSteps(template.crew, template.lookPause), template.steps, `${template.id}: the steps are unchanged`);
  }
  assert.deepEqual(rowOf(["Planner"]), { build: ["L"], pairs: ["r0>L"], final: ["r0"] }, "[Planner]: the leader builds and fixes, the Planner reviews the rounds and the final");
  assert.deepEqual(rowOf(["Reviewer"]), { build: ["L"], pairs: ["r4>L"], final: ["r4"] }, "[Reviewer]: the final goes to that Reviewer");
  assert.deepEqual(rowOf(["Final reviewer"]), { build: ["L"], pairs: ["r5>L"], final: ["r5"] }, "[Final reviewer]: the rounds go to that Final reviewer");
  assert.deepEqual(rowOf(["Planner", "Reviewer"]), { build: ["L"], pairs: ["r4>L"], final: ["r0"] }, "Planner before Reviewer for final");
  assert.deepEqual(rowOf(["Planner", "Final reviewer"]), { build: ["L"], pairs: ["r0>L"], final: ["r5"] }, "Planner before Final reviewer for rounds");
});

// ---- The real server ----
const lead = (cli = "claude") => seat("leader", "Lia", "Leader", cli, cli === "claude" ? "claude-opus-5-5[1m]" : "gpt-6-sol", cli === "claude" ? "low" : "high", false);
const FIXER = seat("fixer", "Fay", "Fixer", "claude", "claude-sonnet-5-5[1m]", "medium", true);
const CODER = seat("coder", "Cy", "Coder", "claude", "claude-sonnet-5-5[1m]", "medium", true);
const tabOfCrew = (work: string, id: string, crew: any[]) => { mkdirSync(join(work, id), { recursive: true }); return { id, name: id, kind: "dev", folder: join(work, id), setupName: "Own work", crew, lookPause: false, steps: deriveSteps(crew, false) }; };

let srv: Server, c: Client, orch: Server, o: Client;
const kit = orchKit(() => ({ srv: orch, c: o }));
before(async () => {
  srv = await boot({
    extra: ({ data }) => writeFileSync(join(data, "config", "setups.json"), JSON.stringify({ setups: [{ id: "fixer-only", name: "Fixer only", kind: "dev", crew: [lead(), FIXER], lookPause: false, steps: [] }] })),
    tabs: (work) => [tabOfCrew(work, "ow-save", [lead(), CODER, FIXER]), tabOfCrew(work, "ow-seat", [lead(), CODER, FIXER]), tabOfCrew(work, "ow-use", [lead(), CODER]), tabOfCrew(work, "ow-loaded", [lead(), FIXER])],
  });
  c = await client(srv);
  orch = await boot({ fakeLeader: true, env: { FAKE_SLEEP_CLAUDE: "5" }, extra: fakeClis, tabs: (work) => [tabOfCrew(work, "ow-e2e", [lead("codex"), seat("planner", "Sage", "Planner", "codex", "gpt-6-sol", "high", false, { orchestrates: true })]), tabOfCrew(work, "ow-other", [lead("codex"), seat("planner", "Sage", "Planner", "codex", "gpt-6-sol", "high", false, { orchestrates: true }), CODER, seat("reviewer", "Rae", "Reviewer", "claude", "claude-opus-5-5[1m]", "medium", false)])] });
  o = await client(orch);
});
after(async () => { c?.close(); o?.close(); await srv?.stop(); await orch?.stop(); });

const REFUSAL = /Lia would review its own work: add a Planner, Reviewer or Final reviewer, or a Coder to build/;

test("OW1 the three places a user makes a crew refuse a leader who would review its own work, and write nothing", { timeout: 60_000 }, async () => {
  const before = workspaceBytes(srv);
  const setupsPath = join(srv.data, "config", "setups.json");
  const setupsBefore = readFileSync(setupsPath, "utf8");
  const crew = clone([lead(), FIXER]);
  assert.match((await c.attempt({ type: "setSetup", tabId: "ow-save", crew, lookPause: false })).error ?? "", REFUSAL, "the editor's Save");
  assert.match((await c.attempt({ type: "updateSeat", tabId: "ow-seat", slot: "coder", role: "Helper" })).error ?? "", REFUSAL, "a seat role change (Coder to Helper)");
  assert.match((await c.attempt({ type: "useSetup", tabId: "ow-use", setupId: "fixer-only" })).error ?? "", REFUSAL, "a saved setup of that shape");
  assert.equal(workspaceBytes(srv), before, "three refusals, and the workspace file is byte for byte what it was");
  assert.deepEqual([c.tab("ow-seat").crew.find((item: any) => item.slot === "coder").role, c.tab("ow-save").crew.length], ["Coder", 3], "the page's crews are as they were");
  assert.match((await c.attempt({ type: "saveSetup", tabId: "ow-loaded", name: "Refused own work" })).error ?? "", REFUSAL, "Save as refuses an older loaded crew");
  assert.equal(readFileSync(setupsPath, "utf8"), setupsBefore, "Save as refusal leaves setups.json byte for byte unchanged");
  assert.equal((await c.attempt({ type: "updateSeat", tabId: "ow-loaded", slot: "fixer", name: "Faye" })).error, undefined, "loaded crew seat rename accepted");
  assert.equal((await c.attempt({ type: "updateSeat", tabId: "ow-loaded", slot: "fixer", model: "claude-opus-5-5[1m]" })).error, undefined, "loaded crew model change accepted");
  const fixerOf = (tab: any) => tab.crew.find((item: any) => item.slot === "fixer");
  const renamed = await c.wait(() => { const tab = c.tab("ow-loaded"); return fixerOf(tab).name === "Faye" && fixerOf(tab).model === "claude-opus-5-5[1m]" ? tab : undefined; }, "the page's copy of ow-loaded shows the fixer Faye on model claude-opus-5-5[1m]");
  const edited = clone(renamed.crew);
  fixerOf({ crew: edited }).name = "Faye editor";
  assert.equal((await c.attempt({ type: "setSetup", tabId: "ow-loaded", crew: edited, lookPause: false })).error, undefined, "loaded crew editor rename accepted");
  const loaded = await c.wait(() => { const tab = c.tab("ow-loaded"); return fixerOf(tab).name === "Faye editor" && fixerOf(tab).model === "claude-opus-5-5[1m]" ? tab : undefined; }, "the page's copy of ow-loaded shows the fixer Faye editor, model still claude-opus-5-5[1m]");
  assert.deepEqual(fixerOf(loaded).name, "Faye editor");
  assert.deepEqual([loaded.crew.length, loaded.steps.find((step: any) => step.id === "build").owners, loaded.steps.find((step: any) => step.id === "final").owners], [2, ["leader"], ["leader"]], "control: a tab of that shape saved before the rule still loads");
});

test("OW2 a Leader + Planner tab: the Planner hands Build and the fix to the leader, reports the round it reviewed while its own run works, and advances the Final review it owns", { timeout: 120_000 }, async () => {
  const id = "ow-e2e";
  const step = (call: string, args: object, save?: string) => ({ call, args, ...(save ? { save } : {}) });
  const hand = (say: string, save: string) => step("launch_seat", { slot: "leader", brief: JSON.stringify([{ say }]) }, save);
  const wait = (save: string) => step("wait_for_runs", { runIds: [`{{RUN:${save}}}`], maxWaitSeconds: 60 });
  kit.runPlanner(id, [
    step("advance_step", { fromStepId: "plan" }), hand("BUILT", "b"), wait("b"), step("advance_step", { fromStepId: "build" }), step("advance_step", { fromStepId: "gate" }),
    { sleep: 8000 }, // the window for the page's two 300 ms attempts below, before the planner's next call
    step("report_round", { round: 1, outcome: "findings" }), hand("FIXED", "f"), wait("f"), step("finish_fix", { round: 1 }),
    step("report_round", { round: 2, outcome: "clean" }), step("advance_step", { fromStepId: "final" }),
  ]);
  await kit.planDone(id, 5);
  await o.wait(() => { const s = o.tab(id).processState; return s.steps[s.currentStepIndex]?.id === "review" && s.phase === "review"; }, "the page's state shows the rounds in review");
  assert.ok(o.tab(id).runs.some((run: any) => run.seatSlotId === "planner" && run.status === "working"), "the Planner is still reviewing");
  for (const type of ["reviewClean", "reviewFindings"]) {
    await o.attempt({ type, tabId: id });
    assert.equal(o.tab(id).processState.phase, "review", `${type}: the page cannot report the Planner's working review`);
    assert.equal(o.tab(id).processState.roundHistory.length, 0, "the page recorded no round outcome");
  }
  await kit.planDone(id, 11);
  const doneAt = Date.now();
  const seenAtOnce = o.tab(id).processState.steps[o.tab(id).processState.currentStepIndex]?.id === "ship";
  const out = kit.results(id).map((item: any) => (item.text.startsWith("{") ? JSON.parse(item.text) : item));
  for (const at of [3, 4, 5, 8, 9, 10]) assert.equal(out[at].changed, true, `call ${at}${at === 5 ? " (report_round findings while the Planner's own run works)" : ""}: ${JSON.stringify(out[at])}`);
  // The server's answer reaches the file before the page's last state message.
  const state = await o.wait(() => { const s = o.tab(id); return s.processState.steps[s.processState.currentStepIndex]?.id === "ship" ? s : undefined; }, "the page's state shows the process at Ship");
  console.log(`OW2 evidence: state complete at once: ${seenAtOnce}; the page's state caught up ${Date.now() - doneAt} ms after the planner's last answer`);
  const owners = (stepId: string) => state.processState.steps.find((item: any) => item.id === stepId).owners;
  assert.deepEqual([owners("build"), owners("final")], [["leader"], ["planner"]], "the server's Build owner is the leader and its Final review owner the Planner");
  const pair = state.processState.steps.find((item: any) => item.id === "review").pairs[0];
  assert.deepEqual([pair.reviewer, pair.fixers], ["planner", ["leader"]], "the round's reviewer is the Planner and the fix goes to the leader");
  assert.deepEqual([state.processState.roundHistory[0].reviewerSlotId, state.processState.roundHistory[0].fixerSlotId], ["planner", "leader"], "round 1 was reported by the Planner for the leader to fix");
  assert.equal(out[9].stepBar.find((s: any) => s.state === "current").stepId, "final");
  assert.equal(out[10].stepBar.find((s: any) => s.state === "current").stepId, "ship");
  await kit.endedRuns(id, 1);
});

test("OW3 a Planner cannot report another working reviewer's round", { timeout: 120_000 }, async () => {
  const id = "ow-other";
  await kit.mode(id, "bypass");
  kit.runPlanner(id, [
    { call: "advance_step", args: { fromStepId: "plan" } },
    { call: "advance_step", args: { fromStepId: "build" } },
    { call: "advance_step", args: { fromStepId: "gate" } },
    { call: "launch_seat", args: { slot: "reviewer", brief: "TEST ONLY: review" }, save: "r" },
    { sleep: 2000 },
    { call: "report_round", args: { round: 1, outcome: "clean" } },
    { sleep: 2000 },
    { call: "wait_for_runs", args: { runIds: ["{{RUN:r}}"], maxWaitSeconds: 60 } },
    { call: "report_round", args: { round: 1, outcome: "clean" } },
  ]);
  await kit.planDone(id, 5);
  assert.ok(o.tab(id).runs.some((run: any) => run.seatSlotId === "reviewer" && run.status === "working"), "Reviewer still working when Planner reports");
  assert.equal(JSON.parse(kit.results(id)[4].text).changed, false, "Planner is not the working reviewer");
  assert.equal(o.tab(id).processState.phase, "review", "refused report leaves review phase unchanged");
  await kit.planDone(id, 7);
  assert.equal(JSON.parse(kit.results(id)[6].text).changed, true, "Planner report accepted after reviewer ends");
  await kit.endedRuns(id, 2);
});
