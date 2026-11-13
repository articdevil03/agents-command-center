import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recoveryFixture, assertOtherTabLaunch } from "./pack26-review1-run3-helpers.ts";
import { testPlan } from "./pack26-review1-run2-helpers.ts";
import { run4Fixture } from "./pack26-review1-run4-helpers.ts";
import { invalidateJournal } from "../server/fixed-crew/task-execution.ts";

test("P26R6R unused Planner abandonment", async t => {
  for (const initial of [true, false]) {
    const f = await recoveryFixture(t, { task: !initial, kind: "planning" });
    f.setJournal(j => { j.executions.at(-1).status = "done"; j.activeExecutionId = null; });
    if (initial) f.server.fixedTasks.create(f.tabId, testPlan(), {}, f.server.fixedTasks.actor("planner", "another-plan"));
    else {
      const task = f.server.fixedTasks.get(f.tabId);
      f.server.fixedTasks.apply({ tabId: f.tabId, ...f.expected(), requestId: "new-plan" }, { type: "plan", plan: { ...task.plan, scope: "Narrowed plan" } }, f.server.fixedTasks.actor("planner", "another-plan"));
    }
    const before = f.server.fixedTasks.get(f.tabId), bytes = readFileSync(join(f.data, "tasks", `${f.tabId}.json`));
    f.failJournalAt(2);
    assert.equal((await f.call()).isError, true, "failed terminal publication retains brake");
    assert.equal(f.journal().activeExecutionId, f.runId); assert.equal(f.journal().executions.at(-1).consumed, false);
    invalidateJournal(f.data, f.tabId); f.restart();
    assert.equal((await f.call()).isError, false, "fresh task store and cold journal cache recover from disk");
    assert.equal(f.journal().activeExecutionId, null); assert.equal(f.journal().executions.at(-1).consumed, true);
    assert.equal(f.journal().executions.at(-1).status, "failed");
    assert.deepEqual(f.server.fixedTasks.get(f.tabId), before); assert.deepEqual(readFileSync(join(f.data, "tasks", `${f.tabId}.json`)), bytes);
    await assertOtherTabLaunch(f);
  }
});
test("P26R6R accepted Planner cannot be abandoned", async t => {
  for (const provenance of ["consumed", "coordinator"]) {
    const f = await recoveryFixture(t, { kind: "planning" });
    f.setJournal(j => { j.executions.at(-1).status = "done"; j.activeExecutionId = null; j.executions.at(-1).consumed = provenance === "consumed"; });
    if (provenance === "coordinator") {
      const file = join(f.data, "tasks", `${f.tabId}.json`), task = f.server.fixedTasks.get(f.tabId);
      task.coordinatorSessions.push(f.runId); writeFileSync(file, JSON.stringify(task)); f.restart();
    }
    const bytes = f.disk(); assert.equal((await f.call()).isError, true); assert.deepEqual(f.disk(), bytes);
  }
});

test("P26R6R unrelated future and invalid Planner versions stay held", async t => {
  for (const invalid of ["foreign-task", "future", "zero", "negative", "fractional", "wrong-role"]) {
    const f = await recoveryFixture(t, { kind: "planning" });
    f.setJournal(j => {
      const run = j.executions.at(-1); run.status = "done"; j.activeExecutionId = null;
      if (invalid === "foreign-task") run.taskId = "foreign";
      if (invalid === "future") run.planVersion++;
      if (invalid === "zero") run.planVersion = 0;
      if (invalid === "negative") run.planVersion = -1;
      if (invalid === "fractional") run.planVersion = 0.5;
      if (invalid === "wrong-role") run.role = "helper";
    });
    const reasons = { "foreign-task": /journal execution does not match the current task identity/,
      future: /journal execution does not match the current task identity/, zero: /journal execution does not match the current task identity/,
      negative: /journal execution does not match the current task identity/, fractional: /journal execution does not match the current task identity/,
      "wrong-role": /Only Planner reports/ };
    const before = f.disk(), result = await f.call(); assert.equal(result.isError, true, `${invalid} stays held`);
    console.log(`REFUSAL Planner ${invalid}: expected=${reasons[invalid]} observed=${result.text}`);
    assert.match(result.text, reasons[invalid]); assert.deepEqual(f.disk(), before);
  }
});

test("P26R6R abandonment frees capacity and completion only after all reports settle", async t => {
  const f = await run4Fixture(t); await f.ready();
  const journal = f.journal(), planner = journal.executions[0];
  const unused = { ...planner, id: "unused-planner", consumed: false };
  const other = { ...unused, id: "other-unused", taskId: f.task().id, planVersion: f.task().planVersion };
  f.setJournal({ ...journal, executions: [...journal.executions, unused, other,
    ...Array.from({ length: 1998 - journal.executions.length }, (_, n) => ({ ...planner, id: `settled-${n}`, status: "failed" }))] });
  assert.equal(f.journal().executions.length, 2000);
  assert.equal((await f.finish()).isError, true);
  const abandon = (runId: string) => f.call("reconcile_task_execution", { expected: f.expected(), runId, reason: "Unused Planner report" });
  assert.equal((await abandon(unused.id)).isError, false);
  assert.equal((await f.finish()).isError, true, "the other unresolved report still blocks completion");
  assert.equal((await abandon(other.id)).isError, false);
  await f.worker("build");
  assert.ok(f.journal().executions.length < 2000, "admission reclaimed settled records");
  const archived = await f.tool("get_task_archive", { kind: "execution", id: unused.id });
  assert.equal(archived.status, "failed"); assert.equal(archived.consumed, true);
  const result = await f.finish(); assert.equal(result.isError, false, result.text);
  assert.equal(f.task(), null);
});
