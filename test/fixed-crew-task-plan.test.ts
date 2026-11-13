import nodeTest, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, lstatSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import type { Plan, ActionKind, Execution, Task } from "../server/fixed-crew/task-types.ts";
import type { Actor, Event } from "../server/fixed-crew/task-transitions.ts";

function checkedTest(name: string, check: (t: TestContext) => void) {
  return nodeTest(name, (t) => assert.doesNotThrow(() => check(t), `Public task service: ${name}`));
}
const test = checkedTest;

// Shared public-service test driver. No prepared record is installed into the
// service: every approval, result and gate comes through its real setter.
export function fixture(t: { after: (fn: () => void) => void }, overrides: Partial<Plan> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cc-task3-"));
  const project = join(root, "project"); mkdirSync(project); writeFileSync(join(project, "a.txt"), "one");
  const remove = (dir: string) => {
    assert.equal(lstatSync(dir).isSymbolicLink(), false);
    for (const name of readdirSync(dir)) {
      const file = join(dir, name), info = lstatSync(file);
      if (info.isDirectory() && !info.isSymbolicLink()) remove(file); else unlinkSync(file);
    }
    assert.deepEqual(readdirSync(dir), []); rmdirSync(dir);
  };
  t.after(() => remove(root));
  const plan: Plan = { id: "plan1", scope: "Implement task", criteria: ["Works"], blocks: [{ id: "b1", scope: "Task", paths: ["a.txt"] }],
    risk: { level: "small", reason: "Contained", paths: ["a.txt"], verification: ["Focused check"] }, visibleWork: false, large: false, integration: false, design: false,
    paths: ["a.txt"], consumers: [], sharedInputs: [], checks: ["unit"], shipping: ["commit", "push", "publish"], reviewReason: "Independent review", ...overrides };
  const seats = Object.fromEntries(FIXED_CREW.map((s) => [s.slot, { ...s.preferred }]));
  const store = createTaskStore(root, () => project);
  const actors = { planner: store.actor("planner", "planner-session"), owner: store.actor("owner", "owner-session"), leader: store.actor("leader", "leader-session") };
  store.create("tab1", plan, seats, actors.planner);
  let sequence = 0;
  const get = () => store.get("tab1")!;
  const expected = (requestId = `request${++sequence}`) => { const task = get(); return { tabId: "tab1", taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision, requestId }; };
  const apply = (event: Event, actor: Actor = actors.leader) => store.apply(expected(), event, actor);
  const approve = () => apply({ type: "approvePlan" }, actors.owner);
  const verify = (executionId: string, options: Partial<Extract<Event, { type: "verify" }>> = {}) => apply({ type: "verify", executionId, checkName: null, findings: [], resolved: [], baseFinal: null, unchanged: [], ...options });
  const action = (kind: ActionKind, options: { route?: Execution["route"]; change?: Execution["change"]; sessionId?: string; batch?: string[] } = {}) => {
    const sessionId = options.sessionId ?? `worker${++sequence}`;
    return apply({ type: "action", action: { kind, route: options.route ?? "normal", change: options.change ?? "none" }, sessionId, batch: options.batch ?? [] }).executionId!;
  };
  const finish = (executionId: string, options: { success?: boolean; processEnd?: Execution["processEnd"] } = {}) => {
    const run = get().executions.find((e) => e.id === executionId)!;
    apply({ type: "start", executionId });
    apply({ type: "result", executionId, taskId: get().id, planVersion: get().planVersion, role: run.role, success: options.success ?? true, processEnd: options.processEnd ?? "confirmed", evidence: ["evidence/result.log"] }, store.actor(run.role, run.sessionId));
  };
  const run = (kind: ActionKind, options: Partial<Extract<Event, { type: "verify" }>> = {}) => { const executionId = action(kind); finish(executionId); verify(executionId, options); return executionId; };
  return { root, project, plan, seats, store, actors, get, expected, apply, approve, verify, action, finish, run };
}

if (import.meta.main) {
test("FCP material plan setters invalidate approvals and require final", (t) => {
  const f = fixture(t); f.approve(); const old = f.get();
  assert.doesNotThrow(() => f.apply({ type: "plan", plan: { ...f.plan, integration: true } }, f.actors.planner));
  const next = f.get(); assert.equal(next.planVersion, old.planVersion + 1); assert.equal(next.ownerScopeApproval, null);
  assert.equal(next.reviewPolicy.finalRequired, true); assert.notEqual(next.planDigest, old.planDigest);
  assert.doesNotThrow(() => f.apply({ type: "plan", plan: next.plan }, f.actors.planner));
  assert.equal(f.get().planVersion, next.planVersion);
});
test("FCP high unknown large and integrated work requires final coverage", (t) => {
  for (const override of [{ risk: { level: "high", reason: "Data", paths: ["a.txt"], verification: ["Check"] } }, { risk: { level: "unknown", reason: "Unknown", paths: ["a.txt"], verification: ["Check"] } }, { large: true }, { integration: true }] as Partial<Plan>[]) {
    const f = fixture(t, override); assert.equal(f.get().reviewPolicy.finalRequired, true);
  }
});
test("FCP rejects malformed keys bounds paths enums and references", (t) => {
  const f = fixture(t);
  for (const plan of [{ ...f.plan, unknown: true }, { ...f.plan, criteria: [] }, { ...f.plan, paths: ["../escape"] }, { ...f.plan, paths: ["a.txt", "a.txt"] }, { ...f.plan, blocks: [{ id: "b", scope: "s", paths: ["outside"] }] }, { ...f.plan, risk: { ...f.plan.risk, level: "safe" } }]) {
    assert.throws(() => f.apply({ type: "plan", plan: plan as Plan }, f.actors.planner));
  }
});
test("FCP actor and stale revision are server enforced; replay is exact", (t) => {
  const f = fixture(t); const expected = f.expected("replay1");
  assert.throws(() => f.store.apply(expected, { type: "approvePlan" }, { role: "owner", sessionId: "forged" }), /authority/);
  assert.throws(() => f.apply({ type: "plan", plan: f.plan }, f.actors.owner), /actor/);
  const result = f.store.apply(expected, { type: "approvePlan" }, f.actors.owner);
  assert.deepEqual(f.store.apply(expected, { type: "approvePlan" }, f.actors.owner), result);
  assert.equal(f.get().recordRevision, result.recordRevision);
  assert.throws(() => f.store.apply({ ...expected, requestId: "stale1" }, { type: "approvePlan" }, f.actors.owner), /Stale/);
  assert.throws(() => f.store.apply(expected, { type: "approveRough", roughRevision: "wrong" }, f.actors.owner), /reused/);
  assert.throws(() => f.store.apply({ ...f.expected(), planVersion: 99 }, { type: "approvePlan" }, f.actors.owner), /Stale/);
});
}
