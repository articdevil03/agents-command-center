import test from "node:test";
import assert from "node:assert/strict";
import { plannerRetryFixture } from "./pack26-review3-planner-helpers.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJournalSnapshot } from "../server/fixed-crew/task-execution.ts";

for (const [title, cold] of [["P26R8S accepted Planner consumption retry", false], ["P26R8S accepted Planner consumption retry persists", true]] as const) {
  test(title, async t => {
    for (const kind of ["initial", "plan", "triage"] as const) {
      const f = await plannerRetryFixture(t, kind), file = join(f.data, "tasks", `${f.tabId}.json`);
      const before = readFileSync(file), task = f.task();
      assert.equal((await f.call("reconcile_task_execution", { expected: f.expected(), runId: f.runId, reason: "Accepted history must stay protected" })).isError, true);
      if (cold) f.cold();
      if (!cold) { const failed = await f.accept(); assert.equal(failed.isError, true); assert.match(failed.text, /R8 consume publication failure/); }
      assert.deepEqual(readFileSync(file), before); assert.deepEqual(f.task(), task);
      f.allow(); const accepted = await f.accept(); assert.equal(accepted.isError, false, accepted.text);
      assert.equal(readJournalSnapshot(f.data, f.tabId).executions.find(e => e.id === f.runId)?.consumed, true, "actual retry consume setter reaches disk");
      f.cold(); assert.equal(f.journal().executions.find(e => e.id === f.runId)?.consumed, true);
      assert.deepEqual(readFileSync(file), before); assert.deepEqual(f.task(), task);
      const journal = f.disk().journal; assert.equal((await f.accept()).isError, false); assert.equal(f.disk().journal, journal);
      assert.deepEqual(readFileSync(file), before);
      if (kind !== "triage") {
        f.approve(); await f.ready(); const finished = await f.finish(); assert.equal(finished.isError, false, finished.text);
      }
      console.log(`PLANNER ${kind} ${cold ? "cold" : "warm"}: repeated consume failure, retry durable, task byte-exact, already consumed no-write`);
    }
  });
}

test("P26R8S Planner consumption retry requires accepted provenance", async t => {
  for (const invalid of ["membership", "foreign", "future", "role", "kind", "failed", "unended", "live", "active"]) {
    const f = await plannerRetryFixture(t, "initial"); f.allow();
    const journal = f.journal(), row = journal.executions.find(e => e.id === f.runId)!;
    if (invalid === "membership") { const task = f.task(); task.coordinatorSessions = ["another-accepted-planner"]; f.writeTask(task); }
    if (invalid === "foreign") { row.taskId = "foreign-task"; row.planVersion = 1; }
    if (invalid === "future") { row.taskId = f.task().id; row.planVersion = f.task().planVersion + 1; }
    if (invalid === "role") row.role = "helper";
    if (invalid === "kind") row.kind = "assist";
    if (invalid === "failed") row.status = "failed";
    if (invalid === "unended") row.processEnded = false;
    if (invalid === "active") journal.activeExecutionId = f.runId;
    f.setJournal(journal);
    if (invalid === "live") f.controls.runContexts.set(f.runId, { tabId: f.tabId, run: { runId: f.runId } });
    const before = f.disk();
    try { const result = await f.accept(); assert.equal(result.isError, true, `${invalid}: ${result.text}`); }
    finally { f.controls.runContexts.delete(f.runId); }
    assert.deepEqual(f.disk(), before, `${invalid}: no publication`);
  }
});
