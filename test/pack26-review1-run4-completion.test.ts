import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run4Fixture } from "./pack26-review1-run4-helpers.ts";
import { waitFor } from "./round2-helpers.ts";
import { assertFinishRefused, rewriteTask } from "./pack26-review1-run4-completion-helpers.ts";

for (const shipping of [[], ["commit"]] as const) test(`P26R4 completion actual tools, owner reads and fresh planning shipping=${shipping.length}`, async (t) => {
  const f = await run4Fixture(t, { shipping: [...shipping] });
  await f.ready();
  const previous = f.task(), original = f.disk();
  const preferences = JSON.stringify(f.server.tabLocation(f.tabId).tab.fixedCrew);
  const callbacks = f.server.launched.map((e: any) => e);
  const result = await f.finish(); assert.equal(result.isError, false, result.text);
  assert.equal(f.disk().task, "null\n"); assert.equal(f.task(), null);
  assert.equal(f.server.fixedTasks.summary(f.tabId), null);
  assert.equal(f.journal().executions.length, 0);
  assert.equal(JSON.stringify(f.server.tabLocation(f.tabId).tab.fixedCrew), preferences, "rollover preserves assignments and role extras");
  const archived = await f.tool("get_task_archive", { kind: "task", id: previous.id });
  assert.deepEqual(archived.task, { ...previous, stage: "complete" });
  assert.equal(readFileSync(join(f.data, "tasks", "finished", f.tabId, previous.id, "source.json"), "utf8"), original.task);
  assert.equal(archived.executions.length, JSON.parse(original.journal).executions.length);
  assert.deepEqual(await f.tool("get_fixed_task"), { task: null, executions: [] });
  const page = await f.tool("list_task_archives", { kind: "task", cursor: null, limit: 1 });
  assert.deepEqual(page.items, [{ id: previous.id, kind: "task", scope: previous.plan.scope, completedAt: archived.manifest.completedAt }]);
  f.ws.message({ type: "getFixedTaskArchive", requestId: "archive-read", tabId: f.tabId, taskId: previous.id });
  const reply = f.ws.messages.find((m: any) => m.requestId === "archive-read");
  assert.equal(reply.type, "fixedTaskArchive"); assert.deepEqual(reply.task, archived.task);
  f.ws.message({ type: "listFixedTaskArchives", requestId: "archive-list", tabId: f.tabId, cursor: null, limit: 50 });
  assert.equal(f.ws.messages.find((m: any) => m.requestId === "archive-list").items[0].id, previous.id);
  const currentPlanner = f.server.tabLocation(f.tabId).tab.fixedCrew.preferences.planner.assignment;
  currentPlanner.effort = "high";
  await f.worker("planning", { plan: f.plan });
  const next = f.task();
  assert.notEqual(next.id, previous.id);
  assert.deepEqual(next.seats.planner, currentPlanner, "fresh planning snapshots the current assignments");
  for (const field of ["ownerScopeApproval", "ownerRoughApproval", "roughRevision"]) assert.equal(next[field], null);
  for (const field of ["executions", "checks", "reviews", "checkpoints", "findings", "requests"]) assert.equal(next[field].length, 0, field);
  assert.deepEqual(next.triage, {});
  const refused = await f.call("request_task_action", { expected: f.expected(), kind: "build", brief: "Try without new approval" });
  assert.equal(refused.isError, true); assert.match(refused.text, /Approve/);
  const newBytes = f.disk();
  const replay = await f.finish({ expected: { taskId: previous.id, planVersion: previous.planVersion, recordRevision: previous.recordRevision } });
  assert.equal(replay.isError, true);
  assert.deepEqual(f.disk(), newBytes, "replay never clears the new task");
  console.log("P26R4_ROLLOVER_EVIDENCE " + JSON.stringify({ oldTaskId: previous.id, newTaskId: next.id,
    archivedExecutionIds: archived.executions.map((run: any) => run.id), liveJournalAfterRollover: [],
    nextPlannerExecutionIds: f.journal().executions.map((run: any) => run.id),
    ownerScopeApproval: next.ownerScopeApproval, ownerRoughApproval: next.ownerRoughApproval, roughRevision: next.roughRevision,
    replayError: replay.text, replayPreservedBytes: true, nextBuildWithoutApproval: refused.text }));
  for (const entry of callbacks) {
    entry.callback.onTreeEnd(entry.run, "unknown");
    entry.callback.onStatus(entry.run, "done", 0);
    f.controls.callbacks.log(f.tabId, entry.run.runId, "late.log");
  }
  assert.deepEqual(f.disk(), newBytes, "late real callback objects never recreate retired rows or mutate the next task");
  f.server.createTabLeader("beta-dev");
  const other = await f.server.launchFixedAction(f.server.currentActor("beta-dev"), null, { kind: "assist", route: "normal", change: "none" }, "Read another tab");
  assert.ok(other.runId); f.server.closeRun(other.runId, 0);
});

test("P26R4 only Run24's exact failed undelivered request may lack journal provenance", async (t) => {
  for (const stable of [true, false]) {
    const f = await run4Fixture(t); await f.ready(); f.controls.failDelivery();
    f.ws.message({ type: "requestFixedTaskAction", requestId: "cancelled-browser", tabId: f.tabId, ...f.expected(), action: "build" });
    await waitFor(() => f.task().executions.at(-1).status === "failed", "Run24 undelivered request cancellation");
    const run = f.task().executions.at(-1);
    assert.equal(run.processEnd, "confirmed"); assert.equal(run.verified, false); assert.deepEqual(run.evidence, []); assert.equal(run.resultRevision, null);
    assert.equal(f.journal().executions.some((entry: any) => entry.id === run.id), false);
    if (!stable) rewriteTask(f, (task) => { task.executions.at(-1).sessionId = "unbound-cancellation"; });
    const result = await f.finish(); assert.equal(result.isError, !stable, result.text);
  }
});

test("P26R4 an actual held runner overrides contradictory settled task and journal facts", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const result = await f.tool("request_task_action", { expected: f.expected(), kind: "assist", brief: "Owned live runner contradiction" });
  assert.equal(f.server.isRunning(result.runId), true);
  rewriteTask(f, (task) => { Object.assign(task.executions.at(-1), { status: "failed", processEnd: "confirmed", verified: false, evidence: [], resultRevision: null }); });
  const journal = f.journal(); journal.activeExecutionId = null;
  Object.assign(journal.executions.at(-1), { status: "failed", processEnded: true, consumed: true }); f.setJournal(journal);
  await assertFinishRefused(f);
  // The joined-server VM has its own Error constructor; runLeaderTool keeps
  // its public refusal generic. Inspect the registered handler's real cause.
  await assert.rejects(() => f.specs.find((spec: any) => spec.name === "finish_fixed_task")!.handler({ expected: f.expected(), reason: "Refuse a live runner" }),
    (error: any) => /Runtime/.test(error.message));
  f.server.closeRun(result.runId, 1);
});

test("P26R4 missing initial Planner provenance and foreign run facts cannot be archived", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const original = f.journal();
  f.setJournal({ ...original, executions: original.executions.filter((run: any) => run.kind !== "planning") });
  await assertFinishRefused(f);
  for (const field of ["taskId", "planVersion", "role", "kind"]) {
    const journal = structuredClone(original), run = journal.executions.find((entry: any) => entry.kind === "build");
    run[field] = field === "planVersion" ? 99 : field === "role" ? "helper" : field === "kind" ? "assist" : "foreign-task";
    f.setJournal(journal); await assertFinishRefused(f);
  }
});

test("P26R4 completion rejects every unresolved task disposition including saved older versions", async (t) => {
  for (const state of ["reserved", "running", "interrupted", "unknown", "failed-end", "unverified", "interrupted-stage", "complete-label"]) {
    const f = await run4Fixture(t); await f.ready();
    const journal = f.journal();
    rewriteTask(f, (task) => {
      if (state === "interrupted-stage") { task.stage = "interrupted"; return; }
      if (state === "complete-label") { task.stage = "complete"; task.checks = []; return; }
      task.planVersion = 2; task.ownerScopeApproval.planVersion = 2;
      for (const run of task.executions) run.planVersion = 2;
      const previous = { ...task.executions[0], id: `old-${state}`, sessionId: `old-session-${state}`, planVersion: 1,
        status: ["reserved", "running", "interrupted"].includes(state) ? state : state === "unverified" ? "success" : "failed",
        processEnd: state === "unknown" ? "unknown" : state === "failed-end" ? "failed" : "confirmed", verified: false };
      task.executions.push(previous);
    });
    if (!["interrupted-stage", "complete-label"].includes(state)) {
      for (const run of journal.executions) if (run.taskId !== null) run.planVersion = 2;
      const writer = journal.executions.find((run: any) => run.kind === "build");
      journal.executions.push({ ...writer, id: `old-${state}`, planVersion: 1, status: "failed", processEnded: true, consumed: true });
      f.setJournal(journal);
    }
    await assertFinishRefused(f);
  }
});

for (const risk of ["high", "unknown"] as const) test(`P26R4 completion requires final for ${risk}`, async (t) => {
  const f = await run4Fixture(t, { risk: { level: risk, reason: "Stored data", paths: ["owned.txt"], verification: ["focused"] } });
  await f.worker("build"); await f.worker("check"); await f.worker("review");
  assert.match((await f.finish()).text, /final review/);
  await f.worker("final"); assert.equal((await f.finish()).isError, false);
});
