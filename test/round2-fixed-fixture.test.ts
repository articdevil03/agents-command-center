import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { config } from "./round2-setup.ts";
import { connect, fixtureWorkspaces, flushMicrotasks, loadServer, settleLeaderTurns, source, waitFor } from "./round2-helpers.ts";
import { isFixedTab } from "../server/fixed-crew/runtime.ts";
import { validateFixedCrew } from "../server/fixed-crew/preferences.ts";

// Assertion ledger: support-only additions; no existing assertion is retired or weakened.
// Catalogue 1724 -> 1724, page 431, browser 8. No proof rows change.
const assist = { kind: "assist", route: "normal", change: "none" };
const quiet = { ...console, log() {} };
const options = { fixed: true, skipHealth: true, console: quiet };
const journal = (f: any) => f.executionJournal(f.testRoot, "alpha-dev");

test("Round2 fixed mode uses valid independent preferences and real current-leader and reservation guards", async () => {
  const workspaces = fixtureWorkspaces("fixed");
  for (const tab of workspaces.projects.flatMap((project) => project.tabs)) {
    assert.equal(isFixedTab(tab), true);
    assert.deepEqual(validateFixedCrew(tab.fixedCrew), tab.fixedCrew);
    assert.deepEqual([tab.crew, tab.steps, tab.lookPause], [[], [], false]);
  }
  workspaces.projects[0].tabs[0].fixedCrew!.roleExtras.helper = "Only inspect evidence";
  assert.equal(workspaces.projects[1].tabs[0].fixedCrew!.roleExtras.helper, undefined);
  const f = await loadServer({ ...options, workspaces });
  f.createTabLeader("alpha-dev");
  const actor = f.currentActor("alpha-dev");
  assert.equal(actor.instance, f.leaderInstances.get("alpha-dev"));
  await assert.rejects(f.launchFixedAction({ ...actor, instance: {} }, null, assist, "Inspect"), /no longer current/);
  const forged = f.launchWorker("alpha-dev", "helper", "Inspect", "leader");
  assert.equal(forged.ok, false); assert.match(forged.error, /current leader/);
  assert.equal(journal(f).executions.length, 0);
  const reserved = f.reserveFixedExecution(actor, assist, "helper");
  const changed = f.tabLocation("alpha-dev").tab.fixedCrew.preferences.helper.assignment;
  changed.effort = "medium";
  assert.throws(() => f.assertFixedTaskLaunch("alpha-dev", "helper", reserved.context), /assignment changed/i);
  changed.effort = "low";
  f.leaderInstances.set("alpha-dev", {});
  assert.throws(() => f.assertFixedTaskLaunch("alpha-dev", "helper", reserved.context), /current leader/);
  assert.equal(f.launched.length, 0);
  f.stopLeaderSession("alpha-dev");
});

test("Round2 fixed launch executes production prompt, log, report and close callbacks with separate injected tree evidence", async () => {
  let confirmTree!: (count: number) => void;
  const tree = new Promise<number>((resolve) => { confirmTree = resolve; });
  const f = await loadServer({ ...options, treeWatch: () => ({ sweep: () => tree, release() {}, failed: 0 }) });
  f.createTabLeader("alpha-dev");
  const actor = f.currentActor("alpha-dev");
  const started = await f.launchFixedAction(actor, null, "planning", "Inspect and return a plan");
  const runId = started.runId;
  assert.equal(f.launched.length, 1); assert.equal(f.active.size, 1);
  const launched = f.launched[0];
  assert.equal(launched.run.runId, runId); assert.equal(launched.run.canWrite, false);
  assert.match(launched.prompt, /You are the Planner/); assert.match(launched.prompt, /CC_REPORT_BEGIN/);
  assert.equal(journal(f).activeExecutionId, runId);
  const execution = journal(f).executions[0];
  assert.equal(execution.status, "running"); assert.equal(execution.processEnded, false);
  assert.equal(execution.logPath, f.runRecords.get(runId).logPath);
  assert.match(readFileSync(execution.logPath.replace(/\.log$/, ".brief.txt"), "utf8"), /Inspect and return a plan/);
  const { plan } = await import("./fixed-crew-execution-helpers.ts");
  const report = { version: 1, runId, taskId: null, planVersion: 0, evidence: ["owned.txt"],
    plan: plan(), findings: [], resolved: [], baseFinal: null, unchanged: [], decisions: [] };
  f.emitOutput(runId, `CC_REPORT_BEGIN\n${JSON.stringify(report)}\nCC_REPORT_END\n`);
  f.closeRun(runId, 0);
  assert.equal(journal(f).executions[0].processEnded, false, "close alone cannot confirm a tree");
  assert.equal(journal(f).activeExecutionId, runId);
  // This is explicit injected tree evidence for synthetic pids, never Windows ownership proof.
  confirmTree(0);
  await waitFor(() => f.active.size === 0, "injected tree result callback");
  assert.equal(journal(f).executions[0].processEnded, true);
  assert.equal(journal(f).executions[0].status, "done"); assert.equal(journal(f).activeExecutionId, null);
  assert.equal(f.runRecords.get(runId).status, "done");
  const accepted = f.acceptPlannerReport(actor, null, runId);
  assert.equal(accepted.tabId, "alpha-dev"); assert.equal(accepted.plan.scope, report.plan.scope);
  assert.equal(journal(f).executions[0].consumed, true);
  f.stopLeaderSession("alpha-dev");
});

test("Round2 fixed runner refusal executes rejection callbacks and releases the real reservation", async () => {
  const f = await loadServer({ ...options, rejectNextRun: true });
  f.createTabLeader("alpha-dev");
  await assert.rejects(f.launchFixedAction(f.currentActor("alpha-dev"), null, assist, "Inspect", "researcher"), /injected runner refusal/);
  const saved = journal(f);
  assert.equal(saved.executions.length, 1); assert.equal(saved.activeExecutionId, null);
  assert.equal(saved.executions[0].status, "failed"); assert.equal(saved.executions[0].processEnded, true);
  assert.equal(f.launched.length, 0); assert.equal(f.active.size, 0);
  assert.equal(f.runRecords.size, 0); assert.equal(f.runContexts.size, 0);
  assert.equal(f.safety().live.length, 0);
  f.stopLeaderSession("alpha-dev");
});

test("Round2 close without tree evidence remains interrupted and blocks the next reservation", async () => {
  const f = await loadServer(options);
  try {
    f.createTabLeader("alpha-dev");
    const actor = f.currentActor("alpha-dev");
    const started = await f.launchFixedAction(actor, null, assist, "Inspect", "researcher");
    f.closeRun(started.runId, 0);
    assert.equal(f.active.size, 0);
    const saved = journal(f);
    assert.equal(saved.executions[0].status, "interrupted");
    assert.equal(saved.executions[0].processEnded, false);
    assert.equal(saved.activeExecutionId, started.runId);
    await assert.rejects(f.launchFixedAction(actor, null, assist, "Inspect again"), /process tree has not been confirmed ended/);
    assert.equal(f.launched.length, 1);
  } finally { f.stopLeaderSession("alpha-dev"); }
});

test("Round2 composed fixed Current message recognizes Save without treating earlier Save text as current", async () => {
  const f = await loadServer({ ...options, writeHandover: true });
  const ws = connect(f);
  try {
    const folder = f.getWorkspaces().projects[0].tabs[0].folder;
    // A real scratch destination, never the fixture's C:/work display folder.
    const destination = `${f.testRoot}/handover.md`;
    const saved = await f.sendLeaderTurn("alpha-dev", `Save a concise handover to ${destination}. Include current decisions`);
    assert.equal(saved, true); assert.equal(readFileSync(destination, "utf8"), "test handover");
    assert.equal(f.maxSaveActive(), 1);
    assert.match(f.chats[0].text, /You are the Leader/);
    assert.match(f.chats[0].text, /Current message:\nSave a concise handover/);
    assert.equal(await f.sendLeaderTurn("alpha-dev", "Continue discussing"), true);
    assert.equal(f.maxSaveActive(), 1); assert.equal(f.chats.length, 2);
    assert.equal(folder, "C:/work/alpha");
    assert.deepEqual(config.readClientPrefs(`${f.testRoot}/client-prefs.json`), config.DEFAULT_CLIENT_PREFS);
    ws.message({ type: "updateClientPref", key: "sidebarCollapsed", value: true });
    await f.flush();
    assert.equal(config.readClientPrefs(`${f.testRoot}/client-prefs.json`).sidebarCollapsed, true);
  } finally { ws.emit("close"); await settleLeaderTurns(f); f.stopLeaderSession("alpha-dev"); }
});

test("Round2 composed Save failure remains a failed leader turn", async () => {
  const f = await loadServer({ ...options, failSave: true });
  try {
    assert.equal(await f.sendLeaderTurn("alpha-dev", `Save a concise handover to ${f.testRoot}/handover.md. Include current decisions`), false);
    assert.equal(f.maxSaveActive(), 1);
    assert.equal(f.activeLeaderTurns.size, 0);
    assert.equal(f.chatStore.snapshot("alpha-dev").messages.some((message: any) => message.text === "handover saved"), false);
  } finally { await settleLeaderTurns(f); f.stopLeaderSession("alpha-dev"); }
});

test("Round2 fixture observations catch removed tree, status, rejection and current-leader wiring by assertion", async () => {
  async function observeClose(serverSource: string) {
    const f = await loadServer({ ...options, serverSource,
      treeWatch: () => ({ sweep: async () => 0, release() {}, failed: 0 }) });
    try {
      f.createTabLeader("alpha-dev");
      const started = await f.launchFixedAction(f.currentActor("alpha-dev"), null, assist, "Inspect", "helper");
      f.closeRun(started.runId, 0);
      await flushMicrotasks();
      assert.equal(journal(f).executions[0].processEnded, true, "tree-end callback must update journal");
      assert.equal(journal(f).executions[0].status, "done", "status callback must update journal");
    } finally { f.stopLeaderSession("alpha-dev"); }
  }
  async function observeRejection(serverSource: string) {
    const f = await loadServer({ ...options, serverSource, rejectNextRun: true });
    try {
      f.createTabLeader("alpha-dev");
      await assert.rejects(f.launchFixedAction(f.currentActor("alpha-dev"), null, assist, "Inspect"), /injected runner refusal/);
      assert.equal(journal(f).activeExecutionId, null, "rejection callback must release reservation");
    } finally { f.stopLeaderSession("alpha-dev"); }
  }
  async function observeActor(serverSource: string) {
    const f = await loadServer({ ...options, serverSource, rejectNextRun: true });
    try {
      f.createTabLeader("alpha-dev");
      await assert.rejects(f.launchFixedAction({ ...f.currentActor("alpha-dev"), instance: {} }, null, assist, "Inspect"),
        /no longer current/, "stale current actor must be rejected before runner");
    } finally { f.stopLeaderSession("alpha-dev"); }
  }
  const cases = [
    { from: 'if (fixed) fixedTreeEnd(tabId, startedRun.runId, evidence === "confirmed");', to: "", observe: observeClose, message: /tree-end callback must update journal/ },
    { from: 'if (fixed && status !== "working") fixedRunStatus(tabId, startedRun.runId, status);', to: "", observe: observeClose, message: /status callback must update journal/ },
    { from: 'rejectFixedLaunch(actor.tabId, execution.id); throw new Error(result.error);', to: 'throw new Error(result.error);', observe: observeRejection, message: /rejection callback must release reservation/ },
    { from: 'leaderInstances.get(actor.tabId) === actor.instance', to: 'true', observe: observeActor, message: /stale current actor must be rejected before runner/ },
  ];
  for (const entry of cases) {
    assert.equal(source.split(entry.from).length - 1, 1, `mutation anchor: ${entry.from}`);
    await entry.observe(source);
    await assert.rejects(entry.observe(source.replace(entry.from, entry.to)), (error: any) => {
      assert.equal(error.code, "ERR_ASSERTION"); assert.match(error.message, entry.message);
      console.log(`INTENDED ASSERTION RED: ${entry.from} -> ${error.message.split("\n")[0]}`);
      return true;
    });
    await entry.observe(source);
  }
});
