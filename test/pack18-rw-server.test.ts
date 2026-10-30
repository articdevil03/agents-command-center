// Pack 18 rework, through a real server and the page's own messages: D2 a crew of a Coder and a Reviewer gets derived steps and its rounds start without a look,
// D3 the role refusals reach setSetup and updateSeat and leave the file alone, D4 a seat's new role re-derives the steps.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { importWithTempDataRoot } from "./temp-root.ts";
import { boot, client, clone, tabOf, workspaceBytes, workspaceFile, type Client, type Server } from "./pack18-harness.ts";

const { modules: { config } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));
const OUR = config.templateCopy("our-process"), BLANK = config.templateCopy("blank");

const member = (slot: string, name: string, role: string, canWrite: boolean) => ({ slot, name, role, cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium", canWrite, isLeader: false });
let srv: Server, c: Client;
before(async () => {
  srv = await boot({
    tabs: (work) => [
      tabOf("rw-d2", work, BLANK), tabOf("rw-d3", work, OUR),
      tabOf("rw-d4", work, BLANK, (setup) => { setup.crew.push(member("coder", "Cody", "Coder", true), member("helper", "Hal", "Helper", false), member("extra", "Ed", "Helper", false)); }),
    ],
  });
  c = await client(srv);
});
after(async () => { c?.close(); await srv?.stop(); });

const plain = (tabId: string) => clone(c.tab(tabId).crew).map(({ seatKey: _k, status: _s, task: _t, runs: _r, ...rest }: any) => rest);
const fileTab = (id: string) => workspaceFile(srv).projects[0].tabs.find((tab: any) => tab.id === id);
const step = async (tabId: string, type: string, until: (tab: any) => boolean) => { c.send({ type, tabId }); await c.wait(() => until(c.tab(tabId)), `${type} took effect`); return c.tab(tabId); };

test("D2 setSetup with a Coder and a Reviewer: the steps are the derived ones (sent steps are ignored), Gate goes straight into round 1 with no look, findings go to the coder", { timeout: 60_000 }, async () => {
  const id = "rw-d2";
  assert.deepEqual(c.tab(id).steps, [], "control: a leader alone has no steps");
  const crew = [...plain(id), member("coder", "Cody", "Coder", true), member("reviewer", "Rae", "Reviewer", false)];
  const bogus = [{ id: "bogus", label: "Bogus", type: "work", owners: ["ghost"] }];
  c.send({ type: "setSetup", tabId: id, crew, lookPause: false, steps: bogus });
  await c.wait(() => c.tab(id).steps.length > 0, "the crew is saved");
  const tab = c.tab(id);
  assert.deepEqual(tab.steps.map((item: any) => [item.id, item.owners ?? item.pairs]), [["plan", ["leader"]], ["build", ["coder"]], ["gate", ["leader"]], ["review", [{ reviewer: "reviewer", fixers: ["coder"] }]], ["final", ["leader"]], ["ship", ["leader"]]]);
  assert.equal(tab.lookPause, false);
  assert.deepEqual(fileTab(id).steps, tab.steps, "and the file holds the same derived steps, not the sent ones");
  assert.deepEqual(c.state().roles.map((role: any) => role.name), ["Planner", "Coder", "Design coder", "Fixer", "Reviewer", "Final reviewer", "Researcher", "Helper"], "the state carries the roles, Helper last");
  assert.match((await c.attempt({ type: "setSetup", tabId: id, crew })).error ?? "", /lookPause must be true or false/);
  await step(id, "advanceStep", (t) => t.processState.currentStepIndex === 1);
  await step(id, "advanceStep", (t) => t.processState.currentStepIndex === 2);
  const entered = await step(id, "advanceStep", (t) => t.processState.currentStepIndex === 3);
  assert.deepEqual([entered.processState.approval.state, entered.processState.phase, entered.processState.round], ["approved", "review", 1], "no look step: Gate opens round 1 itself");
  const fixing = await step(id, "reviewFindings", (t) => t.processState.phase === "fix");
  assert.equal(fixing.processState.roundHistory[0].fixerSlotId, "coder", "with no Fixer the coder fixes");
  const next = await step(id, "finishFix", (t) => t.processState.round === 2);
  assert.equal(next.processState.phase, "review");
  await step(id, "reviewClean", (t) => t.processState.currentStepIndex === 4);
});

test("D3 the role refusals reach setSetup and updateSeat, name their reason, and leave the file and the page as they were", { timeout: 90_000 }, async () => {
  const id = "rw-d3";
  const base = plain(id), before = workspaceBytes(srv), crewBefore = JSON.stringify(c.tab(id).crew);
  const setWith = (change: (crew: any[]) => void) => { const crew = clone(base); change(crew); return c.attempt({ type: "setSetup", tabId: id, crew, lookPause: true }); };
  const slotOf = (crew: any[], slot: string) => crew.find((seat) => seat.slot === slot);
  assert.match((await setWith((crew) => { slotOf(crew, "coder").orchestrates = true; })).error ?? "", /only a Planner can run the process/);
  assert.match((await setWith((crew) => { slotOf(crew, "reviewer1").role = "Planner"; })).error ?? "", /at most one Planner/);
  assert.match((await setWith((crew) => { slotOf(crew, "coder").role = "Leader"; })).error ?? "", /only the leader can have the role Leader/);
  assert.match((await setWith((crew) => { for (let i = 0; i < 7; i++) crew.push(member(`more${i}`, `More ${i}`, "Reviewer", false)); })).error ?? "", /at most 8 Reviewers and 8 Fixers/);
  assert.match((await c.attempt({ type: "updateSeat", tabId: id, slot: "coder", orchestrates: true })).error ?? "", /only a Planner can run the process/);
  assert.match((await c.attempt({ type: "updateSeat", tabId: id, slot: "coder", role: "Planner" })).error ?? "", /at most one Planner/);
  assert.match((await c.attempt({ type: "updateSeat", tabId: id, slot: "coder", role: "Leader" })).error ?? "", /only the leader can have the role Leader/);
  assert.equal(workspaceBytes(srv), before, "seven refusals, and the file is byte for byte what it was");
  assert.equal(JSON.stringify(c.tab(id).crew), crewBefore, "and the page's crew is the same");
  assert.equal(c.tab(id).steps.length, 7, "control: the tab still has Our process's steps");
});

test("D4 updateSeat that gives a Helper the Reviewer role re-derives the steps and starts the process again; a role that changes no step does not", { timeout: 60_000 }, async () => {
  const id = "rw-d4";
  const pairs = () => c.tab(id).steps.find((item: any) => item.type === "rounds").pairs;
  assert.deepEqual(pairs(), [{ reviewer: "leader", fixers: ["coder"] }], "control: with no Reviewer the leader reviews");
  const generation = c.tab(id).processState.crewGenerationId;
  assert.deepEqual(await c.attempt({ type: "updateSeat", tabId: id, slot: "extra", role: "Researcher" }), {});
  await c.wait(() => c.tab(id).crew.find((seat: any) => seat.slot === "extra").role === "Researcher", "the Researcher role arrives");
  assert.equal(c.tab(id).processState.crewGenerationId, generation, "a role that changes no step leaves the process alone");
  c.send({ type: "updateSeat", tabId: id, slot: "helper", role: "Reviewer" });
  await c.wait(() => pairs()[0].reviewer === "helper", "the Review pair names the new Reviewer");
  const tab = await c.wait(() => (c.tab(id).processState.crewGenerationId === generation + 1 ? c.tab(id) : undefined), "the process starts again on the new steps");
  assert.deepEqual(tab.processState.steps, tab.steps, "the engine runs the new steps");
  assert.deepEqual(fileTab(id).steps.find((item: any) => item.type === "rounds").pairs, [{ reviewer: "helper", fixers: ["coder"] }], "and the file holds them");
});
