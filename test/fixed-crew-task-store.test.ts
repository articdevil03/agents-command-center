import { saveJournal } from "../server/fixed-crew/task-execution.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixed-crew-task-plan.test.ts";
const test = (name: string, check: (t: TestContext) => void) => nodeTest(name, (t) => assert.doesNotThrow(() => check(t), name));
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

test("FCS3 atomic detached publication writes real bytes before cache", (t) => {
  const f = fixture(t); const file = join(f.root, "tasks/tab1.json");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).id, f.get().id);
  const detached = f.get(); detached.plan.scope = "not saved"; assert.equal(f.get().plan.scope, "Implement task");
  f.approve(); assert.equal(JSON.parse(readFileSync(file, "utf8")).ownerScopeApproval.digest, f.get().planDigest);
  const before = f.get(), bytes = readFileSync(file), original = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === file) throw new Error("publication failed");
    return original(from, to);
  });
  syncBuiltinESMExports();
  try { assert.throws(f.approve, /publication failed/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(f.get(), before); assert.deepEqual(readFileSync(file), bytes);
});
test("FCS3 absent corrupt future and mismatched files fail closed without replacing bytes", (t) => {
  const f = fixture(t); const file = join(f.root, "tasks/tab1.json");
  const original = readFileSync(file, "utf8");
  for (const contents of ["{bad", JSON.stringify({ ...f.get(), schemaVersion: 2 }), JSON.stringify({ ...f.get(), extra: true }), JSON.stringify({ ...f.get(), tabId: "tab2" })]) {
    writeFileSync(file, contents); const store = createTaskStore(f.root, () => f.project);
    assert.throws(() => store.get("tab1"), /blocked/);
    assert.throws(() => store.create("tab1", f.plan, f.seats, store.actor("planner")));
    assert.equal(readFileSync(file, "utf8"), contents);
  }
  writeFileSync(file, original); const store = createTaskStore(f.root, () => f.project); assert.equal(store.get("tab2"), null);
});
test("FCS3 restart interrupts unfinished actions and never repeats them", (t) => {
  const f = fixture(t); f.approve(); const executionId = f.action("build"); f.apply({ type: "start", executionId });
  const store = createTaskStore(f.root, () => f.project);
  const task = store.get("tab1")!; assert.equal(task.stage, "interrupted"); assert.equal(task.executions[0].status, "interrupted");
  assert.equal(task.executions.length, 1); assert.equal(task.recordRevision, f.get().recordRevision + 1);
  const expected = { taskId: task.id, tabId: "tab1", planVersion: 1, recordRevision: task.recordRevision, requestId: "resume1" };
  assert.throws(() => store.apply(expected, { type: "action", action: { kind: "build", route: "normal", change: "none" }, sessionId: "new-session", batch: [] }, store.actor("leader")), /interrupted/);
  assert.doesNotThrow(() => store.apply(expected, { type: "reconcile", executionId, processEnd: "confirmed", reason: "Tracked tree has ended; inspect external files before retry" }, store.actor("leader")));
  assert.equal(store.get("tab1")!.executions[0].status, "failed");
  assert.equal(createTaskStore(f.root, () => f.project).get("tab1")!.executions.length, 1);
});
test("FCS3 recovery preserves original backup and creates only unapproved task", (t) => {
  const f = fixture(t); const file = join(f.root, "tasks/tab1.json"); writeFileSync(file, "broken");
  const store = createTaskStore(f.root, () => f.project); assert.throws(() => store.get("tab1"));
  const next = store.recover("tab1", f.plan, f.seats, store.actor("planner"));
  assert.equal(next.ownerScopeApproval, null); assert.notEqual(next.id, f.get().id);
  const backups = readdirSync(join(f.root, "tasks")).filter((name) => name.includes(".bad-"));
  assert.equal(backups.length, 1); assert.equal(readFileSync(join(f.root, "tasks", backups[0]), "utf8"), "broken");
  // Removing the original after load forces the actual backup operation to fail.
  writeFileSync(file, "again"); const failed = createTaskStore(f.root, () => f.project); assert.throws(() => failed.get("tab1")); unlinkSync(file);
  assert.throws(() => failed.recover("tab1", f.plan, f.seats, failed.actor("planner")));
  assert.equal(failed.summary("tab1")?.blocked, true);
});
test("FCS3 restart requires reconciliation for reserved and unverified external results", (t) => {
  for (const outcome of ["reserved", "success", "unknown", "failed-end"] as const) {
    const f = fixture(t); f.approve(); const run = f.action("build");
    if (outcome === "reserved") saveJournal(f.root, "tab1", { version: 1, activeExecutionId: run, executions: [{
      id: run, tabId: "tab1", taskId: f.get().id, planVersion: 1, role: "coder", selectedSlot: "coder", selectionReason: "Journal admitted reservation",
      assignment: f.seats.coder, kind: "build", status: "reserved", processEnded: false, consumed: false, logPath: null,
    }] });
    if (outcome !== "reserved") f.finish(run, { processEnd: outcome === "unknown" ? "unknown" : outcome === "failed-end" ? "failed" : "confirmed" });
    const store = createTaskStore(f.root, () => f.project), task = store.get("tab1")!;
    assert.equal(task.executions[0].status, "interrupted", outcome); assert.equal(task.stage, "interrupted", outcome);
    assert.equal(task.executions.length, 1, "no repeated writer");
  }
});
import nodeTest, { type TestContext } from "node:test";
