import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recoveryFixture, assertOtherTabLaunch } from "./pack26-review1-run3-helpers.ts";
import { runLeaderTool } from "../server/leader-tools.ts";
import { recoveryGitFixture } from "./pack26-review1-run3-recovery-helpers.ts";
import { deliveryFixture } from "./pack26-review1-run3-delivery-helpers.ts";
import { saveJournal } from "../server/fixed-crew/task-execution.ts";

test("P26R3R tool confirmed recovery durably abandons evidence and releases another tab", async (t) => {
  const f = await recoveryFixture(t);
  const before = f.server.fixedTasks.get(f.tabId);
  const read = await runLeaderTool(f.specs, "get_fixed_task", {});
  assert.equal(read.isError, false); assert.equal(JSON.parse(read.text).executions.at(-1).processEnded, true);
  assert.equal(f.specs.length, 9);
  const result = await f.call(); assert.equal(result.isError, false, result.text);
  const task = f.server.fixedTasks.get(f.tabId), run = task.executions.at(-1), journal = f.journal();
  assert.equal(run.status, "failed"); assert.equal(run.processEnd, "confirmed");
  assert.equal(run.verified, false); assert.deepEqual([...run.evidence], []); assert.equal(run.resultRevision, null);
  assert.equal(task.stage, before.stage, "reconciliation outside interrupted preserves the current stage");
  assert.deepEqual(task.ownerScopeApproval, before.ownerScopeApproval);
  assert.deepEqual(task.checks, before.checks); assert.deepEqual(task.reviews, before.reviews);
  assert.equal(journal.activeExecutionId, null); assert.equal(journal.executions.at(-1).status, "failed");
  assert.equal(journal.executions.at(-1).consumed, true);
  const settled = f.disk();
  assert.equal((await f.call()).isError, true); assert.deepEqual(f.disk(), settled, "repeat never replays work or changes bytes");
  assert.equal((await runLeaderTool(f.specs, "verify_task_evidence", { expected: f.expected(), runId: f.runId })).isError, true, "abandoned report cannot be verified later");
  f.controls.tree(f.tabId, f.runId, false); f.controls.status(f.tabId, f.runId, "done");
  assert.deepEqual(f.disk(), settled, "late callbacks cannot overwrite the abandoned journal");
  await assertOtherTabLaunch(f);
});

for (const changed of ["unknown", "run", "task", "version", "revision", "leader", "foreign-active", "journal-tab", "journal-task", "journal-version", "execution-role", "missing-action", "verified"] as const) {
  test(`P26R3R identity tree refusal ${changed} changes no bytes`, async (t) => {
    const f = await recoveryFixture(t, { confirmed: changed !== "unknown" });
    const args: any = {};
    if (changed === "run") args.runId = "foreign-run";
    if (["task", "version", "revision"].includes(changed)) {
      args.expected = { ...f.expected(), ...(changed === "task" ? { taskId: "foreign" } : changed === "version" ? { planVersion: 2 } : { recordRevision: 1 }) };
    }
    if (changed === "leader") f.server.leaderInstances.set(f.tabId, {});
    if (changed.startsWith("journal-") || changed === "execution-role") f.setJournal((j) => {
      if (changed === "journal-tab") j.executions.at(-1).tabId = "beta-dev";
      if (changed === "journal-task") j.executions.at(-1).taskId = "foreign";
      if (changed === "journal-version") j.executions.at(-1).planVersion++;
      if (changed === "execution-role") j.executions.at(-1).role = "helper";
    });
    if (changed === "foreign-active") f.setJournal((j) => { j.executions.push({ ...j.executions.at(-1), id: "other-execution" }); j.activeExecutionId = "other-execution"; });
    if (changed === "missing-action" || changed === "verified") {
      const store = f.server.fixedTasks, get = store.get;
      store.get = (tab: string) => {
        const task = get(tab);
        if (changed === "missing-action") task.executions = [];
        else task.executions.at(-1).verified = true;
        return task;
      };
    }
    const before = f.disk(); const result = await f.call(args);
    assert.equal(result.isError, true, `unsafe ${changed} request must refuse: ${result.text}`);
    assert.deepEqual(f.disk(), before, "refusal changes neither task nor journal bytes");
    if (changed === "unknown") {
      f.restart(); const restarted = f.disk(); assert.equal((await f.call()).isError, true); assert.deepEqual(f.disk(), restarted);
      f.server.createTabLeader("beta-dev");
      await assert.rejects(() => f.server.launchFixedAction(f.server.currentActor("beta-dev"), null, { kind: "assist", route: "normal", change: "none" }, "Read"), /tree|reserved/);
    }
  });
}

for (const restart of [false, true]) test(`P26R3R partial journal publication failure bridge fresh retry restart=${restart}`, { timeout: 90_000 }, async () => {
  const f = await recoveryGitFixture({ editAfterAdd: true });
  try {
    assert.equal((await f.call()).body.result.isError, true);
    const runId = f.journal().activeExecutionId; assert.ok(runId);
    await f.control3("fail-journal", { fail: true });
    const failure = await f.reconcile(runId); assert.equal(failure.isError, true);
    assert.match(failure.content[0].text, /journal publication failure/);
    assert.equal(f.task().executions.at(-1).status, "failed", "task disposition is durable before journal publication failure");
    assert.equal(f.journal().activeExecutionId, runId); assert.equal(f.journal().executions.at(-1).consumed, false);
    assert.notEqual(await f.control3("registry", { runId }), null, "retained registry is not retired on partial publication");
    await f.otherTab(false);
    const taskBytes = f.taskBytes();
    await f.control3("fail-journal", { fail: false });
    if (restart) await f.restart();
    const retry = await f.reconcile(runId); assert.notEqual(retry.isError, true, retry.content[0].text);
    assert.deepEqual(f.taskBytes(), taskBytes, "fresh retry finishes only the journal without reapplying task work");
    assert.equal(f.journal().activeExecutionId, null); assert.equal(await f.control3("registry", { runId }), null);
    await f.otherTab(true);
  } finally { await f.close(); }
});

test("P26R3R Run23 rejected finalization unknown tree stays held across real restart", { timeout: 90_000 }, async () => {
  const f = await recoveryGitFixture({ editAfterAdd: true, unknownAfterAdd: true });
  try {
    assert.equal((await f.call()).body.result.isError, true);
    const runId = f.journal().activeExecutionId; assert.ok(runId);
    assert.equal(f.journal().executions.at(-1).processEnded, false);
    for (const restart of [false, true]) {
      if (restart) await f.restart();
      await f.tool("get_fixed_task"); const before = f.taskBytes(), journal = f.journal();
      assert.equal((await f.reconcile(runId)).isError, true);
      assert.deepEqual(f.taskBytes(), before); assert.deepEqual(f.journal(), journal);
      await f.otherTab(false);
    }
  } finally { await f.close(); }
});

for (const state of ["gap", "cleanup", "cancel-child", "unknown-git"] as const) test(`P26R3R Git refuses unsettled ${state}`, async (t) => {
  const f = await recoveryFixture(t), op = f.registry.register(f.runId, f.tabId, {});
  op.terminal = state !== "gap"; op.treesEnded = state !== "unknown-git";
  if (state === "cleanup") op.cleanup.add(Promise.resolve());
  if (state === "cancel-child") op.cancelChild = () => {};
  const before = f.disk(), result = await f.call();
  assert.equal(result.isError, true, `Git ${state} must stay held`); assert.deepEqual(f.disk(), before);
  assert.throws(() => f.registry.retireConfirmed(f.runId), /unsettled/, "registry independently enforces terminal tree cleanup");
  op.terminal = true; op.treesEnded = true; op.cleanup.clear(); op.cancelChild = null;
  assert.equal((await f.call()).isError, false); assert.equal(f.registry.get(f.runId), undefined);
});

test("P26R3R live runner inventory contradicts confirmation and refuses recovery", async (t) => {
  const f = await recoveryFixture(t);
  // This fake runner owns a real running-entry slot, with a synthetic process handle.
  const j = f.journal(); j.activeExecutionId = null;
  f.controls.journal(f.tabId, { ...j, executions: j.executions.map((e: any) => ({ ...e, processEnded: true })) });
  const store = f.server.fixedTasks, get = store.get;
  store.get = () => null;
  const result = await f.server.launchFixedAction(f.server.currentActor(f.tabId), null, { kind: "assist", route: "normal", change: "none" }, "Read");
  store.get = get;
  const target = f.journal().executions.find((e: any) => e.id === result.runId);
  target.status = "interrupted"; target.processEnded = true;
  const all = f.journal(); all.executions = all.executions.map((e: any) => e.id === target.id ? target : e); all.activeExecutionId = target.id;
  // Journal-only planning legitimately lacks a task-action entry, but cannot waive runner ownership.
  target.kind = "planning"; target.taskId = null; target.planVersion = 0;
  store.get = () => null; f.controls.journal(f.tabId, all);
  try {
    const before = f.disk();
    const rejected = await f.call({ expected: null, runId: target.id });
    assert.equal(rejected.isError, true, "a live runner must refuse recovery despite a contradictory ended journal"); assert.deepEqual(f.disk(), before);
  } finally { store.get = get; f.server.closeRun(result.runId, 1); }
});

for (const kind of ["planning", "triage"] as const) test(`P26R3R journal-only ${kind} exact identity and restart`, async (t) => {
  const f = await recoveryFixture(t, { task: kind !== "planning", kind });
  f.restart();
  const result = await f.call(); assert.equal(result.isError, false, result.text);
  assert.equal(f.journal().activeExecutionId, null); assert.equal(f.journal().executions.at(-1).consumed, true);
  await assertOtherTabLaunch(f);
});

for (const failure of ["task", "journal"] as const) test(`P26R3R publication ${failure} failure stays held fresh retry settles exact target`, async (t) => {
  const f = await recoveryFixture(t), op = f.registry.register(f.runId, f.tabId, {}); op.terminal = true;
  f.setJournal((j) => { j.activeExecutionId = null; });
  const store = f.server.fixedTasks, apply = store.apply;
  if (failure === "task") store.apply = () => { throw new Error("injected task publication failure"); };
  else f.failJournalAt(2);
  const result = await f.call(); assert.equal(result.isError, true, result.text);
  assert.equal(f.journal().activeExecutionId, f.runId, "pre-task journal brake survives publication failure");
  assert.equal(f.journal().executions.at(-1).consumed, false);
  assert.equal(store.get(f.tabId).executions.at(-1).status, failure === "task" ? "running" : "failed");
  assert.equal(f.registry.get(f.runId), op, "registry survives either publication failure");
  store.apply = apply;
  const retry = await f.call(); assert.equal(retry.isError, false, retry.text);
  assert.equal(f.registry.get(f.runId) === undefined, true, "the exact retained Git operation must be retired"); assert.equal(f.journal().activeExecutionId, null);
  assert.equal(store.get(f.tabId).executions.at(-1).status, "failed");
  await assertOtherTabLaunch(f);
});

test("P26R3R reconcile preserves another unresolved execution and outside stage", async (t) => {
  const f = await recoveryFixture(t);
  const file = join(f.data, "tasks", `${f.tabId}.json`), task = JSON.parse(readFileSync(file, "utf8"));
  task.executions.push({ ...task.executions.at(-1), id: "unresolved-other", status: "reserved" });
  writeFileSync(file, JSON.stringify(task)); f.restart();
  assert.equal(f.server.fixedTasks.get(f.tabId).stage, "interrupted");
  assert.equal((await f.call()).isError, false);
  const after = f.server.fixedTasks.get(f.tabId);
  assert.equal(after.stage, "interrupted", "another unresolved execution retains interrupted stage");
  assert.equal(after.executions.at(-1).status, "interrupted");
});

test("P26R3R reconciliation outside interrupted preserves review and approvals", async (t) => {
  const f = await deliveryFixture(t, "review");
  const before = f.task();
  f.server.tabLocation(f.tabId).tab.fixedCrew.preferences.coder.assignment = structuredClone(before.seats.coder);
  const actor = f.server.currentActor(f.tabId);
  const { execution, context } = f.server.reserveFixedExecution(actor, { kind: "build", route: "normal", change: "none" });
  f.server.assertFixedTaskLaunch(f.tabId, execution.role, context);
  const journal = f.server.executionJournal(f.data, f.tabId);
  journal.executions.at(-1).status = "interrupted"; journal.executions.at(-1).processEnded = true;
  saveJournal(f.data, f.tabId, journal);
  const specs = f.server.leaderDeps.get("Development").fixedSpecs();
  const result = await runLeaderTool(specs, "reconcile_task_execution", { expected: f.expected(), runId: execution.id, reason: "Abandon ended review-stage build" });
  assert.equal(result.isError, false, result.text);
  assert.equal(f.task().stage, "review"); assert.deepEqual(f.task().ownerScopeApproval, before.ownerScopeApproval);
});

test("P26R3R late production worker callbacks cannot reopen a reconciled execution", async (t) => {
  const f = await recoveryFixture(t, { running: true });
  const entry = f.server.launched[0];
  f.server.closeRun(f.runId, 0);
  const until = Date.now() + 2000;
  while (f.journal().executions.at(-1).status !== "done" && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.journal().executions.at(-1).processEnded, true, "production tree callback must settle first");
  assert.equal(f.server.isRunning(f.runId), false);
  f.restart();
  const result = await f.call(); assert.equal(result.isError, false, result.text);
  const before = f.disk();
  entry.callback.onTreeEnd(entry.run, "unknown");
  entry.callback.onStatus(entry.run, "done", 0);
  assert.deepEqual(f.disk(), before, "late production callbacks cannot reopen abandoned task or journal state");
});

test("P26R3R tool validation bounds run and reason before writes", async (t) => {
  const f = await recoveryFixture(t), before = f.disk();
  for (const args of [{ reason: " " }, { reason: "x".repeat(8193) }, { runId: "../foreign" }, { runId: "" }, { expected: null }]) {
    assert.equal((await f.call(args)).isError, true);
    assert.deepEqual(f.disk(), before);
  }
});

test("P26R3R known gap existing owner release changes runner safety but leaves fixed journal held", async (t) => {
  const f = await recoveryFixture(t, { confirmed: false, running: true });
  assert.equal(f.server.isRunning(f.runId), true);
  f.ws.message({ type: "killRun", runId: f.runId });
  const until = Date.now() + 7000;
  while (!f.server.launchSafety.uncertain.some((row: any) => row.runId === f.runId) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(f.server.launchSafety.uncertain.some((row: any) => row.runId === f.runId), "the actual fake runner reports an unconfirmed kill");
  const before = f.disk();
  f.ws.message({ type: "releaseUnconfirmed", runId: f.runId, confirm: "release may leave a process running and editing files" });
  assert.ok(f.ws.messages.some((m: any) => m.type === "unconfirmedReleased"));
  assert.deepEqual(f.disk(), before, "existing owner release does not reconcile task or journal");
  assert.equal(f.journal().executions.at(-1).processEnded, false);
  assert.equal(f.journal().activeExecutionId, f.runId);
  assert.equal(f.server.isRunning(f.runId), false, "existing owner release removes the real runner-inventory entry");
  console.log("KNOWN GAP: owner release removes the runner entry and uncertain safety row; fixed task and journal bytes are unchanged, processEnded=false and active reservation remains.");
});

for (const failure of ["covered-edit", "result-write"] as const) for (const restart of [false, true]) {
  test(`P26R3R Run23 ${failure} recovery through bridge restart=${restart}`, { timeout: 90_000 }, async () => {
    const f = await recoveryGitFixture(failure === "covered-edit" ? { editAfterAdd: true } : { exit: 7, kind: "rev-parse" });
    try {
      if (failure === "result-write") await f.control3("fail-result", { fail: true });
      const response = await f.call(); assert.equal(response.body.result.isError, true);
      const journal = f.journal(), runId = journal.activeExecutionId;
      assert.ok(runId, "rejected finalization retains its journal brake");
      assert.equal(journal.executions.at(-1).status, "interrupted"); assert.equal(journal.executions.at(-1).processEnded, true);
      assert.equal(f.task().executions.at(-1).status, "running");
      assert.equal((await f.control3("registry", { runId })).finalized, false);
      const originalLog = readFileSync(journal.executions.at(-1).logPath);
      const commands = f.rows("git-process-start.jsonl");
      if (failure === "covered-edit") assert.equal(commands.some((c) => c.args[0] === "commit"), false);
      assert.equal(f.terminal()[0].finalized, false); assert.equal(f.terminal()[0].verification, "rejected");
      await f.otherTab(false);
      if (failure === "result-write") await f.control3("fail-result", { fail: false });
      if (restart) {
        await f.restart();
        assert.equal(f.task().stage, "interrupted"); assert.equal(f.journal().executions.at(-1).processEnded, true);
      }
      const result = await f.reconcile(runId); assert.notEqual(result.isError, true, result.content[0].text);
      const after = f.task().executions.at(-1);
      assert.equal(after.status, "failed"); assert.equal(after.verified, false); assert.deepEqual(after.evidence, []); assert.equal(after.resultRevision, null);
      assert.equal(f.journal().activeExecutionId, null); assert.equal(f.journal().executions.at(-1).consumed, true);
      assert.deepEqual(f.journal().executions.slice(0, -1), journal.executions.slice(0, -1), "other journal entries are preserved");
      assert.equal(await f.control3("registry", { runId }), null);
      assert.deepEqual(readFileSync(journal.executions.at(-1).logPath), originalLog, "original command and terminal facts remain byte-identical");
      assert.deepEqual(f.rows("git-process-start.jsonl"), commands, "no Git command is retried");
      await f.otherTab(true);
    } finally { await f.close(); }
  });
}
