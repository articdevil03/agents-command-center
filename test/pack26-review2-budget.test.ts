import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, truncateSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import { ownedTemp, testPlan } from "./pack26-review1-run2-helpers.ts";

function fixture(t: any) {
  const root = ownedTemp(t), folder = join(root, "work"), data = join(root, "data");
  mkdirSync(folder); mkdirSync(join(folder, "covered"));
  const input = join(folder, "covered/owned.txt"); writeFileSync(input, "one");
  const store = createTaskStore(data, () => folder);
  const seats = Object.fromEntries(FIXED_CREW.map(s => [s.slot, s.preferred]));
  store.create("tab", testPlan(["covered"]), seats, store.actor("planner", "planner"));
  let n = 0;
  const task = () => store.get("tab")!;
  const apply = (event: any, role: any = "leader", session = "leader") => {
    const current = task(); return store.apply({ tabId: "tab", taskId: current.id, planVersion: current.planVersion,
      recordRevision: current.recordRevision, requestId: `req-${++n}` }, event, store.actor(role, session));
  };
  apply({ type: "approvePlan" }, "owner");
  const oversize = () => {
    for (let n = 0; n < 65; n++) { const file = join(folder, `covered/large-${n}`); writeFileSync(file, ""); truncateSync(file, 1024 * 1024); }
  };
  const disk = () => readFileSync(join(data, "tasks/tab.json"));
  return { store, folder, data, input, task, apply, oversize, disk };
}
test("P26R6H replan oversized old coverage", t => {
  const f = fixture(t); f.oversize(); const before = f.disk(), cached = f.task();
  assert.throws(() => f.apply({ type: "plan", plan: { ...testPlan(["covered"]), scope: "Still oversized" } }, "planner"), /fingerprint budget/);
  assert.deepEqual(f.disk(), before); assert.deepEqual(f.task(), cached);
  assert.doesNotThrow(() => f.apply({ type: "plan", plan: testPlan(["covered/owned.txt"]) }, "planner"), "a narrowed valid plan must not scan the oversized old coverage");
  assert.equal(f.task().planVersion, 2); assert.equal(f.task().ownerScopeApproval, null);
  assert.deepEqual(Object.keys(f.task().revision.files), ["covered/owned.txt"]);
  const restarted = createTaskStore(f.data, () => f.folder); assert.deepEqual(restarted.get("tab"), f.task());
  assert.throws(() => f.apply({ type: "action", action: { kind: "build", route: "normal", change: "none" }, sessionId: "worker", batch: [] }), /approv/i);
});
for (const event of ["cancel", "reconcile"] as const) test(`P26R6H ${event} oversized old coverage`, t => {
  const f = fixture(t);
  const runId = f.apply({ type: "action", action: { kind: "build", route: "normal", change: "none" }, sessionId: "worker", batch: [] }).executionId;
  if (event === "reconcile") f.apply({ type: "start", executionId: runId });
  const before = f.task(); f.oversize();
  assert.doesNotThrow(() => f.apply(event === "cancel" ? { type: "cancelRequest", executionId: runId, sessionId: "worker", reason: "Not delivered" }
    : { type: "reconcile", executionId: runId, processEnd: "confirmed", reason: "Abandon confirmed run" }), "abandonment must not scan oversized old coverage");
  assert.equal(f.task().executions.at(-1)!.status, "failed");
  assert.deepEqual(f.task().revision, before.revision); assert.deepEqual(f.task().revisions, before.revisions);
  assert.deepEqual(f.task().ownerScopeApproval, before.ownerScopeApproval);
  assert.deepEqual(createTaskStore(f.data, () => f.folder).get("tab"), f.task());
  const disk = f.disk(); assert.throws(() => f.apply({ type: "approvePlan" }, "owner"), /fingerprint budget/); assert.deepEqual(f.disk(), disk);
});
test("P26R6H ordinary evidence remains fingerprinted", t => {
  const f = fixture(t);
  const runId = f.apply({ type: "action", action: { kind: "build", route: "normal", change: "none" }, sessionId: "worker", batch: [] }).executionId!;
  f.apply({ type: "start", executionId: runId });
  f.apply({ type: "result", executionId: runId, taskId: f.task().id, planVersion: 1, role: "coder", success: true, processEnd: "confirmed", evidence: ["proof.txt"] }, "coder", "worker");
  const at = statSync(f.input); writeFileSync(f.input, "two"); utimesSync(f.input, at.atime, at.mtime);
  const disk = f.disk();
  assert.throws(() => f.apply({ type: "verify", executionId: runId, checkName: null, findings: [], resolved: [], baseFinal: null, unchanged: [] }), /current/);
  assert.deepEqual(f.disk(), disk); assert.equal(f.task().executions.at(-1)!.verified, false);
});
