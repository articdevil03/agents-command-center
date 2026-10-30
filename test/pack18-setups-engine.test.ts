// Pack 18, Block 1, through a real server: S1 rounds alternate by pair, S2 the picked fixer, S5 a new Development tab is Our process,
// S7 an ACP CLI on a crew seat, S14 who may run the process (the updateSeat message), S15 every new seat field reaches the page, the engine and the file.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importWithTempDataRoot } from "./temp-root.ts";
import { boot, client, tabOf, workspaceFile, type Client, type Server } from "./pack18-harness.ts";

const { modules: { config } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));
const OUR = config.templateCopy("our-process"), MARKETING = config.templateCopy("marketing");

let server: Server, c: Client;
before(async () => {
  server = await boot({
    tabs: (work) => [
      tabOf("p18-rounds", work, OUR), tabOf("p18-mkt", work, MARKETING), tabOf("p18-acp", work, OUR),
      tabOf("p18-orch", work, OUR), tabOf("p18-fields", work, OUR), tabOf("p18-setters", work, OUR),
    ],
  });
  c = await client(server);
});
after(async () => { c?.close(); await server?.stop(); });

const seatOf = (tab: any, slot: string) => tab.crew.find((seat: any) => seat.slot === slot);
const engineSeat = (tab: any, slot: string) => tab.processState.seats.find((seat: any) => seat.slotId === slot);
const fileSeat = (tabId: string, slot: string) => workspaceFile(server).projects[0].tabs.find((tab: any) => tab.id === tabId).crew.find((seat: any) => seat.slot === slot);
// The barrier confirms the handler finished even when a message must change nothing.
async function process(tabId: string, message: string, extra: Record<string, unknown> = {}, until?: (tab: any) => boolean): Promise<any> {
  assert.deepEqual(await c.attempt({ type: message, tabId, ...extra }), {});
  if (until) await c.wait(() => until(c.tab(tabId)), `${message} took effect`);
  return c.tab(tabId);
}
async function toLook(tabId: string, steps: number) {
  for (let i = 0; i < steps; i++) { const at = c.tab(tabId).processState.currentStepIndex; await process(tabId, "advanceStep", {}, (tab) => tab.processState.currentStepIndex === at + 1); }
  assert.equal(c.tab(tabId).processState.approval.state, "pending", "the process waits on the user's look");
}

test("S1 Our process: rounds 1, 2, 3 go Vera/Juno, Sol/Nova, Vera/Juno, with the names in the step bar and in the round history", { timeout: 60_000 }, async () => {
  const id = "p18-rounds";
  await toLook(id, 3);
  assert.deepEqual(c.tab(id).derived.stepBar.map((step: any) => [step.stepId, step.type]), [["plan", "work"], ["build", "work"], ["gate", "work"], ["look", "look"], ["review", "rounds"], ["final", "work"], ["ship", "finish"]]);
  let tab = await process(id, "approveLook", {}, (t) => t.processState.approval.state === "approved");
  const review = () => c.tab(id).derived.stepBar[4].label;
  assert.equal(review(), "Review · round 1 · Vera reviewing");
  tab = await process(id, "reviewFindings", {}, (t) => t.processState.phase === "fix");
  assert.equal(review(), "Review · round 1 · Juno fixing");
  tab = await process(id, "finishFix", {}, (t) => t.processState.round === 2);
  assert.equal(review(), "Review · round 2 · Sol reviewing");
  tab = await process(id, "reviewFindings", {}, (t) => t.processState.phase === "fix");
  assert.equal(review(), "Review · round 2 · Nova fixing");
  tab = await process(id, "finishFix", {}, (t) => t.processState.round === 3);
  assert.equal(review(), "Review · round 3 · Vera reviewing", "round 3 is the first pair again");
  assert.equal(tab.derived.roundFlag, "↻ Round 3");
  tab = await process(id, "reviewClean", {}, (t) => t.processState.phase === "clean");
  assert.deepEqual(tab.processState.roundHistory.map((row: any) => [row.round, row.reviewerName, row.outcome, row.fixerName]), [[1, "Vera", "findings", "Juno"], [2, "Sol", "findings", "Nova"], [3, "Vera", "clean", null]]);
  assert.equal(tab.derived.stepBar[5].state, "current", "a clean round moves to the step after the rounds step (found by type)");
});

test("S2 Marketing: the three makers take the fixes in turn, the second opinion reviews every round", { timeout: 60_000 }, async () => {
  const id = "p18-mkt";
  assert.equal(c.tab(id).processState.selectedFixer, null, "every pair has one fixer now, so nobody is picked");
  assert.deepEqual(c.tab(id).steps.find((step: any) => step.type === "rounds").pairs, [{ reviewer: "secondOpinion", fixers: ["socialMedia"] }, { reviewer: "secondOpinion", fixers: ["image"] }, { reviewer: "secondOpinion", fixers: ["videoAndMotion"] }]);
  await toLook(id, 3);
  await process(id, "approveLook", {}, (t) => t.processState.approval.state === "approved");
  const fixers: string[] = [];
  for (const round of [1, 2, 3]) {
    const tab = await process(id, "reviewFindings", {}, (t) => t.processState.phase === "fix");
    assert.equal(tab.derived.stepBar[4].label, `Review · round ${round} · ${tab.processState.roundHistory.at(-1).fixerName} fixing`);
    fixers.push(tab.processState.roundHistory.at(-1).fixerName);
    await process(id, "finishFix", {}, (t) => t.processState.round === round + 1);
  }
  assert.deepEqual(fixers, ["Vera", "X", "Terra"], "makers fix in turn");
  assert.equal(c.tab(id).processState.roundHistory.every((row: any) => row.reviewerName === "Astra"), true);
});

test("S5 a new Development tab (a real addTab) is Our process, field by field", { timeout: 60_000 }, async () => {
  const before = new Set(c.state().projects[0].tabs.map((tab: any) => tab.id));
  c.send({ type: "addTab", projectId: "p18", kind: "dev", folder: server.work });
  const tab = await c.wait(() => c.state().projects[0].tabs.find((item: any) => !before.has(item.id)), "the new tab");
  // Written out by hand from the roster table, not read from the template.
  const ROSTER: [string, string, string, string, string | undefined, boolean, true | undefined][] = [
    ["leader", "claude", "claude-opus-5-5[1m]", "low", "claude-fable-5-1", false, undefined],
    ["planner", "claude", "claude-opus-5-5[1m]", "high", "claude-fable-5-1", false, true],
    ["coder", "claude", "claude-sonnet-5-5[1m]", "medium", undefined, true, undefined],
    ["reviewer1", "codex", "gpt-6.1-sol", "low", undefined, false, undefined],
    ["fixer1", "codex", "gpt-6.1-sol", "low", undefined, true, undefined],
    ["reviewer2", "claude", "claude-opus-5-5[1m]", "medium", undefined, false, undefined],
    ["fixer2", "claude", "claude-sonnet-5-5[1m]", "medium", undefined, true, undefined],
    ["final", "claude", "claude-opus-5-5[1m]", "medium", undefined, false, undefined],
  ];
  assert.equal(tab.setupName, "Our process");
  assert.equal("process" in tab, false);
  assert.deepEqual(tab.crew.map((seat: any) => [seat.slot, seat.cli, seat.model, seat.effort, seat.advisor, seat.canWrite, seat.orchestrates]), ROSTER);
  assert.deepEqual(tab.crew.map((seat: any) => seat.isLeader), [true, false, false, false, false, false, false, false]);
  assert.deepEqual(tab.crew.map((seat: any) => seat.role), ["Leader", "Planner", "Coder", "Reviewer", "Fixer", "Reviewer", "Fixer", "Final reviewer"]);
  assert.equal(tab.lookPause, true);
  assert.deepEqual(tab.steps, [
    { id: "plan", label: "Plan", type: "work", owners: ["planner"] },
    { id: "build", label: "Build", type: "work", owners: ["coder"] },
    { id: "gate", label: "Gate", type: "work", owners: ["planner"] },
    { id: "look", label: "Your look", type: "look", owners: ["user"] },
    { id: "review", label: "Review", type: "rounds", pairs: [{ reviewer: "reviewer1", fixers: ["fixer1"] }, { reviewer: "reviewer2", fixers: ["fixer2"] }] },
    { id: "final", label: "Final review", type: "work", owners: ["final"] },
    { id: "ship", label: "Ship", type: "finish", owners: ["planner"] },
  ]);
  assert.deepEqual(c.state().templates.map((t: any) => t.id), ["blank", "our-process", "duo", "design", "marketing"], "Start blank comes first; the hidden old crew is not offered");
  assert.deepEqual(c.state().clis.map((cli: any) => [cli.id, cli.advisor, cli.readOnlyEnforced, cli.crewTools]), [["claude", true, true, true], ["codex", false, false, true], ["opencode", false, true, true]]);
  const saved = workspaceFile(server).projects[0].tabs.find((item: any) => item.id === tab.id);
  assert.deepEqual([saved.setupName, saved.steps.length, saved.crew.length], ["Our process", 7, 8], "and it is on disk");
});

test("S7 an ACP CLI goes on a crew seat only with the Full access confirmation, and only if it is in the list", { timeout: 60_000 }, async () => {
  const id = "p18-acp";
  assert.deepEqual(await c.request({ type: "addAcpCli", name: "Fake basic", command: "fake-acp --scenario=basic" }), { ok: true });
  const kind = "acp:fake-basic";
  const refused = await c.attempt({ type: "updateSeat", tabId: id, slot: "coder", cli: kind, model: "default" });
  assert.match(refused.error ?? "", /Full access confirmation is required/);
  assert.equal(seatOf(c.tab(id), "coder").cli, "claude", "nothing changed without the confirm");
  const unknown = await c.attempt({ type: "updateSeat", tabId: id, slot: "coder", cli: "acp:nope", model: "default", confirm: true });
  assert.match(unknown.error ?? "", /not in your ACP CLIs list/);
  assert.equal(seatOf(c.tab(id), "coder").cli, "claude");
  c.send({ type: "updateSeat", tabId: id, slot: "coder", cli: kind, model: "default", confirm: true });
  const coder = await c.wait(() => (seatOf(c.tab(id), "coder").cli === kind ? seatOf(c.tab(id), "coder") : null), "the coder seat moved to the ACP CLI");
  assert.deepEqual([coder.model, coder.effort], ["default", "default"]);
  assert.deepEqual([fileSeat(id, "coder").cli, fileSeat(id, "coder").model, fileSeat(id, "coder").effort], [kind, "default", "default"], "and it is saved");
  assert.equal(c.state().clis.find((cli: any) => cli.id === kind).label, "Fake basic");
  assert.deepEqual(c.state().clis.find((cli: any) => cli.id === kind), { id: kind, label: "Fake basic", advisor: false, readOnlyEnforced: false, crewTools: true, customModel: null, installed: true, models: ["default"], efforts: ["default"] });
  // The CLI cannot be removed while a crew seat uses it.
  const removal = await c.request({ type: "removeAcpCli", id: "fake-basic" });
  assert.equal(removal.ok, false);
  assert.match(removal.message ?? "", /Fake basic is used by Sonny \(Coder\) in "p18-acp"/);
});

test("S14 the updateSeat message keeps the process runner single: never the leader, one seat, an ACP seat must write", { timeout: 60_000 }, async () => {
  const id = "p18-orch";
  assert.equal(seatOf(c.tab(id), "planner").orchestrates, true, "control: the planner runs the process");
  const second = await c.attempt({ type: "updateSeat", tabId: id, slot: "coder", orchestrates: true });
  assert.match(second.error ?? "", /only a Planner can run the process/);
  const leader = await c.attempt({ type: "updateSeat", tabId: id, slot: "leader", orchestrates: true });
  assert.match(leader.error ?? "", /only a Planner can run the process/);
  const tabBefore = JSON.stringify(c.tab(id).crew);
  assert.deepEqual(await c.request({ type: "addAcpCli", name: "Fake orch", command: "fake-acp --scenario=basic" }), { ok: true });
  const readOnlyAcp = await c.attempt({ type: "updateSeat", tabId: id, slot: "planner", cli: "acp:fake-orch", model: "default", confirm: true });
  assert.match(readOnlyAcp.error ?? "", /must be able to write/);
  assert.equal(JSON.stringify(c.tab(id).crew), tabBefore, "every refusal left the crew alone");
  // The Planner role moves first (a crew has one Planner), then the new Planner may run the process.
  c.send({ type: "updateSeat", tabId: id, slot: "planner", role: "Helper", orchestrates: false });
  await c.wait(() => !seatOf(c.tab(id), "planner").orchestrates, "the planner stopped running the process");
  c.send({ type: "updateSeat", tabId: id, slot: "coder", role: "Planner" });
  await c.wait(() => seatOf(c.tab(id), "coder").role === "Planner", "the coder is the Planner now");
  c.send({ type: "updateSeat", tabId: id, slot: "coder", orchestrates: true });
  await c.wait(() => seatOf(c.tab(id), "coder").orchestrates === true, "the coder runs the process now");
  assert.equal(fileSeat(id, "coder").orchestrates, true);
  assert.equal("orchestrates" in fileSeat(id, "planner"), false);
});

test("S15 role, write permission, advisor and runs-the-process reach the page, the engine and the file; a bad advisor is refused", { timeout: 60_000 }, async () => {
  const id = "p18-fields";
  const settle = (check: (seat: any) => boolean, slot: string, label: string) => c.wait(() => check(seatOf(c.tab(id), slot)), label);
  c.send({ type: "updateSeat", tabId: id, slot: "reviewer1", role: "Checker", canWrite: true });
  await settle((seat) => seat.role === "Checker" && seat.canWrite === true, "reviewer1", "role and canWrite arrive");
  assert.deepEqual([engineSeat(c.tab(id), "reviewer1").roleLabel, engineSeat(c.tab(id), "reviewer1").canWrite], ["Checker", true], "the engine seat follows");
  assert.deepEqual([fileSeat(id, "reviewer1").role, fileSeat(id, "reviewer1").canWrite], ["Checker", true], "the file follows");

  c.send({ type: "updateSeat", tabId: id, slot: "planner", advisor: "claude-sonnet-5-5[1m]" });
  await settle((seat) => seat.advisor === "claude-sonnet-5-5[1m]", "planner", "the advisor is set");
  assert.equal(engineSeat(c.tab(id), "planner").advisor, "claude-sonnet-5-5[1m]");
  assert.equal(fileSeat(id, "planner").advisor, "claude-sonnet-5-5[1m]");
  c.send({ type: "updateSeat", tabId: id, slot: "planner", advisor: null });
  await settle((seat) => seat.advisor === undefined, "planner", "the advisor is removed");
  assert.equal("advisor" in engineSeat(c.tab(id), "planner"), false);
  assert.equal("advisor" in fileSeat(id, "planner"), false);

  assert.match((await c.attempt({ type: "updateSeat", tabId: id, slot: "planner", advisor: "not a model" })).error ?? "", /invalid advisor model/);
  assert.match((await c.attempt({ type: "updateSeat", tabId: id, slot: "fixer1", advisor: "claude-fable-5-1" })).error ?? "", /cannot have an advisor/, "Codex has no advisor");
  assert.equal(seatOf(c.tab(id), "fixer1").advisor, undefined);

  c.send({ type: "updateSeat", tabId: id, slot: "planner", orchestrates: false });
  await settle((seat) => seat.orchestrates === undefined, "planner", "the planner stops running the process");
  assert.equal("orchestrates" in engineSeat(c.tab(id), "planner"), false);
  assert.equal("orchestrates" in fileSeat(id, "planner"), false);
  c.send({ type: "updateSeat", tabId: id, slot: "planner", orchestrates: true });
  await settle((seat) => seat.orchestrates === true, "planner", "and starts again");
  assert.equal(engineSeat(c.tab(id), "planner").orchestrates, true);
  assert.equal(fileSeat(id, "planner").orchestrates, true);
  assert.ok(readFileSync(join(server.data, "config", "workspaces.json"), "utf8").includes('"orchestrates": true'));
});

test("S16 name, model, effort, CLI and write permission each reach the engine seat on their own, without the engine restarting", { timeout: 60_000 }, async () => {
  // One field per message and the role untouched: the steps do not change, so the engine is not rebuilt from the crew and only updateRuntimeSeat can carry the change.
  const id = "p18-setters", kind = "acp:fake-setters";
  assert.deepEqual(await c.request({ type: "addAcpCli", name: "Fake setters", command: "fake-acp --scenario=basic" }), { ok: true });
  const generation = c.tab(id).processState.crewGenerationId, stepsBefore = JSON.stringify(c.tab(id).steps);
  assert.equal(typeof generation, "number", "the engine's generation is on the page (found)");
  const cases: [string, Record<string, unknown>, (seat: any) => unknown, unknown][] = [
    ["name", { name: "Kit" }, (seat) => seat.name, "Kit"],
    ["model", { model: "claude-opus-5-5[1m]" }, (seat) => seat.model, "claude-opus-5-5[1m]"],
    ["effort", { effort: "low" }, (seat) => seat.effort, "low"],
    ["cli", { cli: kind, model: "default", confirm: true }, (seat) => seat.cli, kind],
    ["canWrite", { canWrite: false }, (seat) => seat.canWrite, false],
  ];
  for (const [field, change, read, expected] of cases) {
    assert.notDeepEqual(read(engineSeat(c.tab(id), "coder")), expected, `${field}: the engine seat starts different (control)`);
    c.send({ type: "updateSeat", tabId: id, slot: "coder", ...change });
    await c.wait(() => read(seatOf(c.tab(id), "coder")) === expected, `${field} reached the crew`);
    assert.equal(c.tab(id).processState.crewGenerationId, generation, `${field}: the engine did not restart`);
    assert.equal(JSON.stringify(c.tab(id).steps), stepsBefore, `${field}: the steps did not change`);
    assert.equal(read(engineSeat(c.tab(id), "coder")), expected, `${field}: the engine seat follows`);
    console.log(`S16 ${field}: crew and engine seat both read ${JSON.stringify(expected)}, generation ${generation} unchanged`);
  }
});
