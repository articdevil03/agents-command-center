import test from "node:test";
import assert from "node:assert/strict";
import { run4Fixture } from "./pack26-review1-run4-helpers.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionJournal, invalidateJournal } from "../server/fixed-crew/task-execution.ts";
import { failPublication } from "./pack26-review1-run4-archive-helpers.ts";

test("P26R4 full settled taskless journal is archived before a new reservation", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const current = f.journal(), planner = current.executions[0];
  const retained = current.executions.filter((run: any) => run.kind !== "planning");
  f.setJournal({ version: 1, activeExecutionId: null, executions: [...current.executions,
    ...Array.from({ length: 2000 - current.executions.length }, (_, n) => ({ ...planner, id: `old-${n}`, taskId: null, planVersion: 0 }))] });
  await f.worker("build");
  assert.equal(f.journal().executions.length, retained.length + 1);
  assert.deepEqual(f.journal().executions.slice(0, retained.length), retained, "current writer/check/review facts stay live");
  const page = await f.tool("list_task_archives", { kind: "execution", limit: 50 });
  assert.equal(page.items.length, 50); assert.ok(page.nextCursor);
  const old = await f.tool("get_task_archive", { kind: "execution", id: "old-0" });
  assert.equal(old.id, "old-0"); assert.equal(old.consumed, true);
  const taskId = f.task().id;
  const finished = await f.finish(); assert.equal(finished.isError, false, finished.text);
  const archive = await f.tool("get_task_archive", { kind: "task", id: taskId });
  assert.ok(archive.executions.some((run: any) => run.id === planner.id && run.taskId === null && run.planVersion === 0), "the accepted initial Planner is recovered from its verified execution archive");
});

test("P26R4 failed restart-normalization publication never installs a fictitious journal cache", async (t) => {
  const f = await run4Fixture(t), before = f.journal();
  const raw = { ...before, activeExecutionId: before.executions[0].id,
    executions: [{ ...before.executions[0], status: "running", processEnded: false, consumed: false }] };
  const file = join(f.data, "executions", `${f.tabId}.json`), bytes = JSON.stringify(raw, null, 2) + "\n";
  writeFileSync(file, bytes); invalidateJournal(f.data, f.tabId);
  await failPublication("/executions/alpha-dev.json", async () => {
    assert.throws(() => executionJournal(f.data, f.tabId), /publication failure/);
    assert.equal(readFileSync(file, "utf8"), bytes); return null;
  });
  assert.equal(executionJournal(f.data, f.tabId).executions[0].status, "interrupted");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).executions[0].status, "interrupted", "fresh retry really publishes rather than returning a fictitious cached normalization");
});

test("P26R4 full unconsumed journal refuses before task reservation and spawn", async (t) => {
  const f = await run4Fixture(t), planner = f.journal().executions[0];
  f.setJournal({ version: 1, activeExecutionId: null, executions: Array.from({ length: 2000 }, (_, n) => ({ ...planner, id: `held-${n}`, consumed: false })) });
  const before = f.disk(), count = f.server.launched.length;
  const reply = await f.call("request_task_action", { expected: f.expected(), kind: "build", brief: "Capacity must refuse" });
  assert.equal(reply.isError, true); assert.match(reply.text, /capacity.*2,000/);
  assert.deepEqual(f.disk(), before); assert.equal(f.server.launched.length, count);
  assert.throws(() => f.setJournal({ ...f.journal(), executions: [...f.journal().executions, { ...planner, id: "overflow" }] }), /capacity/);
  assert.deepEqual(f.disk(), before);
});
