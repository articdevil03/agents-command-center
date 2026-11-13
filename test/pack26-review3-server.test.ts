import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { refusedStartFixture } from "./pack26-review3-server-helpers.ts";

test("P26R8S duplicate journal admission refuses before publication", async t => {
  const f = await refusedStartFixture(t);
  // Restore covered bytes so selection otherwise passes. The owning duplicate
  // guard, rather than the stale review gate, must supply this refusal.
  fs.writeFileSync(join(f.folder, "owned.txt"), "before");
  const before = [f.taskBytes(), f.journalBytes()];
  const result = await f.retry(); assert.equal(result.isError, true);
  assert.match(result.text, /already has a journal execution and must be reconciled/);
  assert.deepEqual([f.taskBytes(), f.journalBytes()], before);
  assert.equal(f.server.launched.length, f.workers);
});

test("P26R8S refused start explicitly reconciles without replay", async t => {
  for (const failure of ["none", "task", "journal"]) {
    const f = await refusedStartFixture(t);
    if (failure === "task") {
      const original = fs.renameSync;
      const mock = t.mock.method(fs, "renameSync", (from: any, to: any) => {
        if (String(to) === join(f.data, "tasks", `${f.tabId}.json`)) throw new Error("R8 task publication failure");
        return original(from, to);
      }); syncBuiltinESMExports();
      try { const result = await f.reconcile(); assert.equal(result.isError, true); assert.match(result.text, /R8 task publication failure/); }
      finally { mock.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(f.journal().activeExecutionId, f.runId);
    }
    if (failure === "journal") {
      f.failJournal(2); const result = await f.reconcile(); assert.equal(result.isError, true); assert.match(result.text, /R8 journal publication failure/);
      assert.equal(f.task().executions.at(-1).status, "failed"); assert.equal(f.journal().activeExecutionId, f.runId);
    }
    const settled = await f.reconcile(); assert.equal(settled.isError, false, settled.text);
    assert.equal(f.task().executions.at(-1).status, "failed"); assert.equal(f.task().executions.at(-1).processEnd, "confirmed");
    const row = f.journal().executions.find(e => e.id === f.runId)!;
    assert.equal(row.consumed, true); assert.equal(row.status, "failed"); assert.equal(f.journal().activeExecutionId, null);
    const bytes = [f.taskBytes(), f.journalBytes()]; f.cold(); assert.deepEqual([f.taskBytes(), f.journalBytes()], bytes);
    assert.equal((await f.retry()).isError, true); assert.equal(f.server.launched.length, f.workers);
    await f.worker("build"); assert.notEqual(f.task().executions.at(-1).id, f.runId);
    console.log(`REFUSED START ${failure}: recovered, cold durable, no replay, fresh ID allowed`);
  }
});

test("P26R8S refused start recovery keeps contradictory admissions held", async t => {
  for (const contradiction of ["done", "unknown-end", "consumed", "log", "record", "positive", "receipt"]) {
    const f = await refusedStartFixture(t), j = f.journal(), row = j.executions.find(e => e.id === f.runId)!;
    if (contradiction === "done") row.status = "done";
    if (contradiction === "unknown-end") row.processEnded = false;
    if (contradiction === "consumed") row.consumed = true;
    if (contradiction === "log") row.logPath = "launched.log";
    f.setJournal(j);
    if (contradiction === "record") f.server.runRecords.set(f.runId, { tabId: f.tabId });
    if (contradiction === "positive" || contradiction === "receipt") {
      const task = f.task();
      if (contradiction === "positive") task.executions.at(-1).evidence = ["owned.txt"];
      else task.requests.find(r => r.result.executionId === f.runId).digest = "a".repeat(64);
      // Keep the warm reserved state; a cold store independently interrupts it.
      const store = f.server.fixedTasks, get = store.get;
      store.get = id => id === f.tabId ? structuredClone(task) : get(id);
      t.after(() => { store.get = get; });
    }
    const bytes = [f.taskBytes(), f.journalBytes()];
    try { const result = await f.reconcile(); assert.equal(result.isError, true, `${contradiction}: ${result.text}`); }
    finally { f.server.runRecords.delete(f.runId); }
    assert.deepEqual([f.taskBytes(), f.journalBytes()], bytes); assert.equal(f.server.launched.length, f.workers);
  }
});
