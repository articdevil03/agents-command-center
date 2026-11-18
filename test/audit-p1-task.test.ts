import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { recoveryFixture, assertOtherTabLaunch } from "./pack26-review1-run3-helpers.ts";
import { runLeaderTool } from "../server/leader-tools.ts";

type Fixture = Awaited<ReturnType<typeof recoveryFixture>>;
function report(f: Fixture, runId = f.runId) {
  const task = f.server.fixedTasks.get(f.tabId);
  return { version: 1, runId, taskId: task.id, planVersion: task.planVersion,
    evidence: ["owned.txt"], plan: null, findings: [], resolved: [], baseFinal: null, unchanged: [], decisions: [] };
}
async function finish(f: Fixture, runId: string, output: string) {
  f.server.emitOutput(runId, output);
  f.server.closeRun(runId, 0);
  const deadline = Date.now() + 3000;
  while (f.journal().executions.find((e: any) => e.id === runId)?.status !== "done" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const execution = f.journal().executions.find((e: any) => e.id === runId);
  assert.equal(execution.status, "done"); assert.equal(execution.processEnded, true);
  assert.equal(f.server.isRunning(runId), false);
}
const block = (value: unknown) => `CC_REPORT_BEGIN\n${JSON.stringify(value)}\nCC_REPORT_END\n`;
const verify = (f: Fixture, runId = f.runId, checkName: string | null = null) => runLeaderTool(f.specs,
  "verify_task_evidence", { expected: f.expected(), runId, checkName });
function assertAbandoned(f: Fixture, runId = f.runId) {
  const run = f.server.fixedTasks.get(f.tabId).executions.find((e: any) => e.id === runId);
  assert.equal(run.status, "failed"); assert.equal(run.processEnd, "confirmed");
  assert.equal(run.verified, false); assert.deepEqual([...run.evidence], []); assert.equal(run.resultRevision, null);
  const execution = f.journal().executions.find((e: any) => e.id === runId);
  assert.equal(execution.status, "failed"); assert.equal(execution.consumed, true);
  assert.equal(f.journal().activeExecutionId, null);
}

for (const invalid of ["malformed", "missing", "stale-report", "stale-content", "non-review-findings"] as const) {
  test(`P1 C-1 rejected ${invalid} report reconciles through leader tool without restart`, async (t) => {
    const f = await recoveryFixture(t, { running: true });
    let runId = f.runId;
    if (invalid === "stale-content") {
      await finish(f, runId, block(report(f)));
      assert.equal((await verify(f)).isError, false);
      const started = await runLeaderTool(f.specs, "request_task_action", { expected: f.expected(),
        kind: "check", brief: "Check the owned file" });
      assert.equal(started.isError, false, started.text); runId = JSON.parse(started.text).runId;
    }
    await finish(f, runId, invalid === "missing" ? "No report supplied\n"
      : invalid === "malformed" ? "CC_REPORT_BEGIN\n{broken}\nCC_REPORT_END\n"
      : block({ ...report(f, runId), ...(invalid === "stale-report" ? { planVersion: 999 } : {}),
        ...(invalid === "non-review-findings" ? { findings: [{ id: "finding", executionId: runId, text: "Bad worker finding", real: true, minimal: false }] } : {}) }));
    if (invalid === "stale-content") writeFileSync(join(f.folder, "owned.txt"), "edited");
    const rejected = await verify(f, runId, invalid === "stale-content" ? "focused" : null);
    assert.equal(rejected.isError, true, rejected.text);
    if (invalid === "stale-content") assert.match(rejected.text, /Evidence is stale/);
    if (invalid === "non-review-findings") assert.match(rejected.text, /Only reviews can supply findings/);
    assert.equal(f.server.fixedTasks.get(f.tabId).executions.at(-1).status, invalid === "non-review-findings" ? "success" : "running");
    assert.equal(f.journal().executions.at(-1).consumed, false);
    const result = await f.call({ runId });
    assert.equal(result.isError, false, result.text); assertAbandoned(f, runId);
    assert.equal((await verify(f, runId)).isError, true, "abandoned report cannot become evidence");
    await assertOtherTabLaunch(f);
  });
}

test("P1 R-3 unknown execution refuses even when an unused Planner is last", async t => {
  const f = await recoveryFixture(t, { task: false });
  f.setJournal(j => { j.activeExecutionId = null; j.executions.at(-1).status = "done"; });
  const before = f.disk();
  const result = await f.call({ runId: "foreign-execution" });
  assert.equal(result.isError, true, result.text); assert.deepEqual(f.disk(), before);
});

for (const failure of ["task", "journal"] as const) test(`P1 C-1 ${failure} publication failure holds brake and retries safely`, async (t) => {
  const f = await recoveryFixture(t, { running: true });
  await finish(f, f.runId, "No report\n");
  const before = f.disk().task, store = f.server.fixedTasks, apply = store.apply;
  if (failure === "task") store.apply = () => { throw new Error("injected task publication failure"); };
  else f.failJournalAt(2);
  const result = await f.call();
  assert.equal(result.isError, true); assert.match(result.text, /publication failure/);
  assert.equal(f.journal().activeExecutionId, f.runId);
  assert.equal(f.journal().executions.at(-1).consumed, false);
  if (failure === "task") assert.equal(f.disk().task, before, "failed task publication leaves its source intact");
  const retainedTask = f.disk().task;
  store.apply = apply;
  const retry = await f.call(); assert.equal(retry.isError, false, retry.text); assertAbandoned(f);
  if (failure === "journal") assert.equal(f.disk().task, retainedTask, "retry does not republish settled task");
  await assertOtherTabLaunch(f);
});

for (const refused of ["live", "consumed", "verified", "foreign", "unknown-ended"] as const) {
  test(`P1 C-1 refuses ${refused} successful execution without publication`, async (t) => {
    const f = await recoveryFixture(t, { running: true });
    if (refused !== "live") await finish(f, f.runId, block(report(f)));
    if (refused === "verified") {
      assert.equal((await verify(f)).isError, false);
      f.setJournal((j) => { j.executions.at(-1).consumed = false; });
    }
    if (refused === "consumed") f.setJournal((j) => { j.executions.at(-1).consumed = true; });
    if (refused === "unknown-ended") f.setJournal((j) => { j.executions.at(-1).processEnded = false; });
    const before = f.disk();
    const result = await f.call(refused === "foreign" ? { runId: "foreign-execution" } : {});
    assert.equal(result.isError, true, result.text); assert.deepEqual(f.disk(), before);
  });
}
