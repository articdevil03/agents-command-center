// Pack 18, Block 1b, the step tools and the stall clock, through real servers: S13 advance_step waits for the owners' runs, O10 report_round and finish_fix run the page's
// engine, O12 every bridge call of a waiting planner counts as output. The fake planner and the helpers are in pack18-orch-harness.ts.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boot, client, RUN_END_MS, type Client, type Server } from "./pack18-harness.ts";
import { tabIn, fakeClis, orchKit } from "./pack18-orch-harness.ts";

let srv: Server, c: Client;
before(async () => {
  srv = await boot({ fakeLeader: true, env: { FAKE_SLEEP_CLAUDE: "4", FAKE_SLEEP_OPENCODE: "9" }, extra: fakeClis, tabs: (work) => [tabIn(work, "o-steps")] });
  c = await client(srv);
});
after(async () => { c?.close(); await srv?.stop(); });

const { planPath, results, runPlanner, mode, planDone, endedRuns, dirOf } = orchKit(() => ({ srv, c }));

test("S13 tool half: advance_step is refused while either of two coder runs works, allowed once both end; and a coder gets no crew tools", { timeout: 150_000 }, async () => {
  const id = "o-steps";
  await mode(id, "bypass");
  runPlanner(id, [
    { parallel: [{ call: "launch_seat", args: { slot: "coderA", brief: "TEST ONLY: A" }, save: "a" }, { call: "launch_seat", args: { slot: "coderB", brief: "TEST ONLY: B" }, save: "b" }] },
    { call: "advance_step", args: { fromStepId: "build" } },                       // 2: not the current step (it is plan)
    { call: "advance_step", args: { fromStepId: "plan" } },                        // 3: plan -> build (the planner's own run is excepted)
    { call: "advance_step", args: { fromStepId: "build" } },                       // 4: both coders work
    { call: "wait_for_runs", args: { runIds: ["{{RUN:a}}"], maxWaitSeconds: 30 } }, // 5: coderA ends first
    { call: "advance_step", args: { fromStepId: "build" } },                       // 6: coderB still works
    { call: "wait_for_runs", args: { runIds: ["{{RUN:b}}"], maxWaitSeconds: 40 } }, // 7
    { call: "advance_step", args: { fromStepId: "build" } },                       // 8: both ended (build -> gate)
    { call: "advance_step", args: { fromStepId: "gate" } },                        // 9: gate -> the user's look
  ]);
  await planDone(id, 10);
  const out = results(id);
  const bar = (r: any) => JSON.parse(r.text);
  assert.equal(out[2].isError, true);
  assert.match(bar(out[2]).reason, /current step is "plan", not "build"/);
  assert.equal(bar(out[3]).changed, true, out[3].text);
  assert.equal(bar(out[3]).stepBar.find((s: any) => s.state === "current").stepId, "build");
  assert.equal(bar(out[4]).changed, false, "both coders work");
  assert.match(bar(out[4]).reason, /Ann and Ben still have runs working on Build/);
  assert.equal(bar(out[6]).changed, false, "coderA ended but coderB still works");
  assert.match(bar(out[6]).reason, /Ben still has a run working on Build/);
  assert.equal(bar(out[8]).changed, true, out[8].text);
  assert.equal(bar(out[8]).stepBar.find((s: any) => s.state === "current").stepId, "gate");
  assert.equal(bar(out[9]).changed, true, out[9].text);
  assert.equal(bar(out[9]).stepBar.find((s: any) => s.state === "current").stepId, "look");
  await c.wait(() => c.tab(id).processState.currentStepIndex === 3, `${id}: the page's state shows the look`);
  // The coders are not the seat that runs the process: no crew tools in their environment.
  assert.equal(readFileSync(join(dirOf(id), "env-crew-opencode.txt"), "utf8").trim(), "[]", "the OpenCode coder got no crew url");
  assert.equal(readFileSync(join(dirOf(id), "env-crew-claude.txt"), "utf8").trim(), "[]");
  console.log(`S13 tool: refused with "${bar(out[4]).reason}" / "${bar(out[6]).reason}"; then ${bar(out[9]).stepBar.find((s: any) => s.state === "current").stepId}`);
});

test("O10 report_round and finish_fix run the page's engine: findings go to the round's own pair, the round number must match, the planner's own run never holds the review", { timeout: 180_000 }, async () => {
  const id = "o-steps";
  // The tab stands on the look step (the S13 test moved it there); the user approves, then a fresh planner run takes the rounds.
  await c.wait(() => c.tab(id).processState.approval.state === "pending", "waiting on the look");
  c.send({ type: "approveLook", tabId: id });
  await c.wait(() => c.tab(id).processState.approval.state === "approved", "the look is approved");
  // Nothing may still be working on the tab when the rounds open: the previous test's planner and coder runs are reported over only after the runner's cleanup sweep,
  // and a worker run still going would hold every round's review back (the plan below would then be refused). Waited for here, by the page's own state.
  await c.wait(() => !c.tab(id).runs.some((run: any) => run.status === "working"), `${id}: every earlier run on the tab ended`, RUN_END_MS);
  unlinkSync(planPath(srv.temp, id, "result")); unlinkSync(planPath(srv.temp, id, "session"));
  const workingBefore = c.tab(id).runs.filter((run: any) => run.status === "working").length;
  runPlanner(id, [
    { call: "report_round", args: { round: 5, outcome: "findings" } },  // 0: not the current round
    { call: "report_round", args: { round: 1, outcome: "findings" } },  // 1: round 1 -> pair 1's fixer (Ann)
    { call: "report_round", args: { round: 1, outcome: "clean" } },     // 2: the fix comes first
    { call: "finish_fix", args: { round: 2 } },                         // 3: not the current round
    { call: "finish_fix", args: { round: 1 } },                         // 4: round 2 opens although the planner's own run is working
    { call: "report_round", args: { round: 2, outcome: "findings" } },  // 5: round 2 -> pair 2's fixer (Ben)
    { call: "finish_fix", args: { round: 2 } },                         // 6
    { call: "report_round", args: { round: 3, outcome: "clean" } },     // 7: the first pair again; clean moves on to the final review
    { call: "advance_step", args: { fromStepId: "final" } },            // 8: final -> ship
    { call: "advance_step", args: { fromStepId: "ship" } },             // 9: the last step
  ]);
  await planDone(id, 10);
  const doneAt = Date.now();
  const caughtUp = () => { const s = c.tab(id).processState; return s.roundHistory.length === 3 && s.currentStepIndex === 6; };
  const seenAtOnce = caughtUp(); // evidence for the race: is the page's state already complete the moment the planner's last answer is on file?
  const out = results(id).map((r: any) => JSON.parse(r.text));
  assert.deepEqual(out.map((r: any) => r.changed), [false, true, false, false, true, true, true, true, true, false], results(id).map((r: any) => r.text.slice(0, 160)).join(" | "));
  assert.match(out[0].reason, /round 5 is not the current round \(it is round 1\)/);
  assert.match(out[2].reason, /round 1 is in the fix phase: finish_fix comes first/);
  assert.match(out[3].reason, /round 2 is not the current round \(it is round 1\)/);
  assert.match(out[9].reason, /this is the last step/);
  // The planner's answer reaches the file a moment before the page's last state message reaches this client: the state is waited for, never read once.
  const state = await c.wait(() => { const s = c.tab(id).processState; return s.roundHistory.length === 3 && s.currentStepIndex === 6 ? s : undefined; }, `${id}: the page's state shows three rounds and Ship`);
  console.log(`O10 evidence: working runs when the rounds opened ${workingBefore}; round-3 report changed=${out[7].changed}; state complete at once: ${seenAtOnce}; the page's state caught up ${Date.now() - doneAt} ms after the planner's last answer`);
  assert.deepEqual(state.roundHistory.map((h: any) => [h.round, h.reviewerSlotId, h.outcome, h.fixerSlotId]), [[1, "reviewer", "findings", "coderA"], [2, "reviewer", "findings", "coderB"], [3, "reviewer", "clean", null]]);
  assert.equal(out[7].stepBar.find((s: any) => s.state === "current").stepId, "final");
  assert.equal(out[8].stepBar.find((s: any) => s.state === "current").stepId, "ship");
  await endedRuns(id, 3);
  console.log(`O10: history=${JSON.stringify(state.roundHistory.map((h: any) => [h.round, h.outcome, h.fixerSlotId]))}`);
});

// A busy PC can take seconds to start a fake planner, so the clock is long and every wait below is derived from it.
const STALL_MS = 8000;

test("O12 every bridge call a waiting planner makes counts as output: it is not marked stalled, while a silent one (the control) is", { timeout: 120_000 }, async () => {
  const b = await boot({
    env: { CC_TEST_STALL_THRESHOLD_MS: String(STALL_MS), CC_TEST_STALL_CHECK_MS: "300" }, extra: fakeClis,
    tabs: (work) => ["s-alive", "s-silent"].map((id) => tabIn(work, id)),
  });
  const bc = await client(b);
  try {
    const plan = (id: string, steps: unknown[]) => writeFileSync(planPath(b.temp, id, "plan"), JSON.stringify(steps));
    const pings = Math.ceil(STALL_MS * 2.5 / 400); // the waiting planner calls for 2.5 times the threshold
    plan("s-silent", [{ sleep: pings * 400 }]);
    plan("s-alive", [{ ping: pings, every: 400 }]);
    bc.send({ type: "run", confirmBusy: true, tabId: "s-silent", slot: "planner", prompt: "TEST ONLY: say nothing" });
    bc.send({ type: "run", confirmBusy: true, tabId: "s-alive", slot: "planner", prompt: "TEST ONLY: keep calling" });
    // Control: the silent planner is called stalled (so the clock really is short).
    await bc.wait(() => bc.messages.find((m) => m.type === "runStalled" && m.tabId === "s-silent"), "the silent planner is marked stalled", 30_000);
    await bc.wait(() => bc.runEnds("s-alive") >= 1 && bc.runEnds("s-silent") >= 1, "both ended", RUN_END_MS);
    const calls = JSON.parse(readFileSync(planPath(b.temp, "s-alive", "result"), "utf8")).filter((r: any) => r.call === "ping");
    assert.equal(calls.length, pings, "the waiting planner kept calling for 2.5 times the stall threshold");
    assert.equal(bc.messages.some((m) => m.type === "runStalled" && m.tabId === "s-alive"), false, "its calls kept it from being marked stalled");
    console.log(`O12: alive planner made ${calls.length} calls, 0 stalls; silent planner stalled`);
  } finally { bc.close(); await b.stop(); }
});

test("O12 approval waits exempt a planner from stalls and answering restarts its clock", { timeout: 120_000 }, async () => {
  const b = await boot({
    env: { CC_TEST_STALL_THRESHOLD_MS: String(STALL_MS), CC_TEST_STALL_CHECK_MS: "300" },
    extra: (paths) => {
      fakeClis(paths);
      const script = join(paths.temp, "fake-planner.cjs");
      const source = readFileSync(script, "utf8").replace("const url = process.env.CC_CREW_URL, token = process.env.CC_CREW_TOKEN;", 'const mcp = JSON.parse(fs.readFileSync(process.env.CC_MCP_CONFIG, "utf8")).mcpServers["tab-crew"]; const url = mcp.url, token = mcp.headers.Authorization.slice(7);');
      writeFileSync(script, source);
      writeFileSync(join(paths.bin, "claude.cmd"), '@echo off\r\nnode "%~dp0..\\fake-planner.cjs"\r\nexit /b 0\r\n');
    },
    tabs: (work) => ["s-approval-yes", "s-approval-no", "s-control"].map((id) => {
      const tab = tabIn(work, id);
      Object.assign(tab.crew.find((seat) => seat.slot === "planner")!, { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium" });
      return tab;
    }),
  });
  const bc = await client(b);
  try {
    for (const id of ["s-approval-yes", "s-approval-no", "s-control"]) {
      assert.deepEqual(await bc.request({ type: "setPermissionMode", tabId: id, mode: "ask", confirm: true }), { ok: true });
      const steps = id === "s-control" ? [{ sleep: 2 * STALL_MS }] : [{ call: "launch_seat", args: { slot: "coderB", brief: "TEST ONLY: await approval" } }, { sleep: 2 * STALL_MS }];
      writeFileSync(planPath(b.temp, id, "plan"), JSON.stringify(steps));
      bc.send({ type: "run", confirmBusy: true, tabId: id, slot: "planner", prompt: "TEST ONLY: wait" });
    }
    for (const id of ["s-approval-yes", "s-approval-no"]) await bc.wait(() => bc.tab(id).pendingApprovals?.[0], `${id}: approval pending`);
    const stalled = (id: string) => bc.messages.find((m) => m.type === "runStalled" && m.tabId === id);
    await bc.wait(() => stalled("s-control"), "the silent control stalls", 30_000);
    await new Promise((done) => setTimeout(done, STALL_MS + 700));
    for (const [id, allow] of [["s-approval-yes", true], ["s-approval-no", false]] as const) {
      assert.equal(stalled(id), undefined, "waiting longer than the threshold is not a stall");
      const item = bc.tab(id).pendingApprovals[0];
      assert.deepEqual(await bc.request({ type: "answerApproval", tabId: id, approvalId: item.approvalId, allow }), { ok: true });
    }
    await new Promise((done) => setTimeout(done, 1000));
    for (const id of ["s-approval-yes", "s-approval-no"]) assert.equal(stalled(id), undefined, "answering gives the planner a fresh stall clock");
    for (const id of ["s-approval-yes", "s-approval-no"]) await bc.wait(() => stalled(id), `${id}: silence after the answer eventually stalls`, STALL_MS + 12_000);
  } finally { bc.close(); await b.stop(); }
});
