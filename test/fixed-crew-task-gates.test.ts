import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixed-crew-task-plan.test.ts";
import type { Plan } from "../server/fixed-crew/task-types.ts";
const test = (name: string, check: (t: TestContext) => void) => nodeTest(name, (t) => assert.doesNotThrow(() => check(t), name));
import { assertTaskGate } from "../server/fixed-crew/task-gates.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

test("FCG owner and revision gates refuse unapproved or stale requests", (t) => {
  const f = fixture(t); assert.throws(() => f.action("build"), /Approve this plan/);
  f.approve(); const expected = f.expected(); f.apply({ type: "plan", plan: { ...f.plan, scope: "Changed" } }, f.actors.planner);
  assert.throws(() => f.store.apply(expected, { type: "approvePlan" }, f.actors.owner), /Stale/);
  assert.throws(() => f.action("build"), /Approve this plan/);
  assert.doesNotThrow(() => assertTaskGate(null, { kind: "assist", route: "normal", change: "none" }));
  assert.throws(() => assertTaskGate(null, { kind: "build", route: "normal", change: "none" }), /plan/);
});
test("FCG rough gates require visual run inspection and actual-revision approval", (t) => {
  const f = fixture(t, { visibleWork: true }); f.approve(); f.run("rough");
  assert.throws(() => f.action("inspect"), /visually check/);
  f.run("visualCheck"); f.run("inspect");
  assert.throws(() => f.action("polish"), /Approve the rough/);
  assert.throws(() => f.apply({ type: "approveRough", roughRevision: "bad" }, f.actors.owner), /revision/);
  writeFileSync(join(f.project, "a.txt"), "two");
  assert.throws(() => f.apply({ type: "approveRough", roughRevision: f.get().roughRevision! }, f.actors.owner), /revision/);
});
test("FCG shipping requires fresh review checks triage and final only when needed", (t) => {
  const f = fixture(t, { integration: true }); f.approve(); f.run("build");
  assert.throws(() => f.action("review"), /checks/);
  f.run("check", { checkName: "unit" });
  assert.throws(() => f.action("commit"), /fresh review/);
  f.run("review"); assert.throws(() => f.action("commit"), /final review/);
  f.run("final"); f.run("commit");
  const small = fixture(t); small.approve(); small.run("build"); small.run("check", { checkName: "unit" }); small.run("review");
  assert.doesNotThrow(() => small.run("commit")); assert.equal(small.get().reviews.length, 1);
});
test("FCG identity failed unknown and unverified evidence cannot open the gate", (t) => {
  for (const options of [{ success: false }, { processEnd: "unknown" as const }, { processEnd: "failed" as const }]) {
    const f = fixture(t); f.approve(); const run = f.action("build"); f.finish(run, options);
    assert.throws(() => f.verify(run), /successful, ended/);
  }
  const f = fixture(t); f.approve(); f.run("build"); const run = f.action("check"); f.finish(run);
  assert.throws(() => f.action("review"), /checks/); f.verify(run, { checkName: "unit" });
  assert.throws(() => f.action("review", { sessionId: "planner-session" }) , /fresh|session/);
});
test("FCG sessions are fresh independent from every writer and prior review", (t) => {
  const f = fixture(t); f.approve(); const build = f.run("build"); f.run("check", { checkName: "unit" });
  const session = f.get().executions.find((e) => e.id === build)!.sessionId;
  assert.throws(() => f.action("review", { sessionId: session }), /fresh independent/);
  const review = f.run("review");
  assert.throws(() => f.action("review", { sessionId: f.get().executions.find((e) => e.id === review)!.sessionId }), /fresh independent/);
});
function findingPack(t: Parameters<typeof fixture>[0], final = false, minimal = false, overrides: Partial<Plan> = {}) {
  const f = fixture(t, { integration: final, ...overrides }); f.approve(); f.run("build"); f.run("check", { checkName: "unit" });
  if (final) f.run("review");
  const review = f.action(final ? "final" : "review"); f.finish(review);
  f.verify(review, { findings: [{ id: "f1", executionId: review, text: "Fix this", real: true, minimal }] });
  return { ...f, review };
}
test("FCG findings require complete triage and outstanding FIX blocks shipping", (t) => {
  const f = findingPack(t);
  assert.throws(() => f.action("commit"), /Planner must triage/);
  f.apply({ type: "triage", decisions: [{ findingId: "f1", outcome: "FIX", reason: "Wrong behavior" }] }, f.actors.planner);
  assert.throws(() => f.action("commit"), /accepted fixes/);
  assert.throws(() => f.action("fix", { batch: ["f1"] }), /checkpoint/);
  f.run("checkpoint");
  assert.throws(() => f.action("fix", { batch: [] }), /one sequential batch/);
  const fix = f.action("fix", { batch: ["f1"], change: "logic" });
  assert.throws(() => f.action("fix", { batch: ["f1"] }), /reservation/);
  f.finish(fix); f.verify(fix);
  f.run("check", { checkName: "unit" }); f.run("review", { resolved: ["f1"] }); f.run("commit");
});
test("FCG fingerprints catch same-size edits names additions deletions and shared inputs", (t) => {
  const f = fixture(t, { paths: ["a.txt", "new.txt", "nested"], consumers: ["consumer"], sharedInputs: ["shared"] });
  f.approve(); f.run("build"); f.run("check", { checkName: "unit" }); f.run("review");
  const initial = f.get().revision.digest;
  writeFileSync(join(f.project, "unrelated"), "outside coverage"); f.run("commit"); assert.equal(f.get().revision.digest, initial);
  for (const mutate of [() => writeFileSync(join(f.project, "a.txt"), "two"), () => writeFileSync(join(f.project, "new.txt"), "new"), () => unlinkSync(join(f.project, "a.txt")), () => { mkdirSync(join(f.project, "nested")); writeFileSync(join(f.project, "nested/child"), "new"); }, () => writeFileSync(join(f.project, "consumer"), "read"), () => writeFileSync(join(f.project, "shared"), "shared")]) {
    mutate(); assert.throws(() => f.action("commit"), /fresh review/);
    f.run("check", { checkName: "unit" }); f.run("review"); f.run("commit");
  }
});
test("FCG interruption prevents all action boundaries until explicit reconciliation", (t) => {
  const f = fixture(t); f.approve(); const executionId = f.action("build"); f.apply({ type: "start", executionId }); const store = createTaskStore(f.root, () => f.project); const task = store.get("tab1")!;
  assert.throws(() => store.apply({ tabId: "tab1", taskId: task.id, planVersion: 1, recordRevision: task.recordRevision, requestId: "new1" },
    { type: "action", action: { kind: "build", route: "normal", change: "none" }, sessionId: "another", batch: [] }, store.actor("leader")), /interrupted/);
});
test("FCG both post-final routes require checkpoint fresh correction and unchanged coverage", (t) => {
  for (const design of [false, true]) for (const minimal of [true, false]) {
    const f = findingPack(t, true, minimal, { design });
    f.apply({ type: "triage", decisions: [{ findingId: "f1", outcome: "FIX", reason: "Visible error" }] }, f.actors.planner);
    f.run("checkpoint");
    assert.throws(() => f.action("fix", { batch: ["f1"], change: "logic" }), /post-final/);
    assert.throws(() => f.action("fix", { batch: ["f1"], route: "minimal", change: "logic" }), /Logic/);
    const old = f.get().revision;
    const fix = f.action("fix", { batch: ["f1"], route: minimal ? "minimal" : "postFinal", change: minimal ? "minimal" : "logic" });
    assert.equal(f.get().executions.at(-1)!.role, minimal ? "minimalFixer" : design ? "fixer1" : "fixer2");
    f.apply({ type: "start", executionId: fix }); writeFileSync(join(f.project, "a.txt"), minimal ? "typo" : "logic");
    const run = f.get().executions.at(-1)!;
    f.apply({ type: "result", executionId: fix, taskId: f.get().id, planVersion: 1, role: run.role, success: true, processEnd: "confirmed", evidence: ["logs/fix"] }, f.store.actor(run.role, run.sessionId));
    f.verify(fix); f.run("check", { checkName: "unit" });
    const correction = f.action("review"); assert.equal(f.get().executions.at(-1)!.role, minimal ? "minimalReviewer" : design ? "reviewer2" : "reviewer1"); f.finish(correction);
    const unchanged = Object.keys(old.files).filter((p) => old.files[p] === f.get().revision.files[p]);
    f.verify(correction, { resolved: ["f1"], baseFinal: f.review, unchanged }); f.run("commit");
  }
});
test("FCG rejects linked filesystem metadata and escaped approved paths", (t) => {
  const f = fixture(t); f.approve(); const original = fs.lstatSync;
  const mock = t.mock.method(fs, "lstatSync", (file: fs.PathLike, ...args: any[]) => {
    const stat = (original as any)(file, ...args);
    if (String(file) === f.project) stat.isSymbolicLink = () => true;
    return stat;
  });
  syncBuiltinESMExports();
  try { assert.throws(() => f.action("build"), /Linked task paths/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  for (const path of ["../other", "a/../other", "/absolute", "C:/absolute", "a\\other", "con", "a."]) {
    assert.throws(() => f.apply({ type: "plan", plan: { ...f.plan, paths: [path] } }, f.actors.planner), /path/);
  }
});
test("FCG a scoped correction cannot claim unverified unchanged final coverage", (t) => {
  const f = findingPack(t, true, true, { consumers: ["untouched.txt"] });
  f.apply({ type: "triage", decisions: [{ findingId: "f1", outcome: "FIX", reason: "Typo" }] }, f.actors.planner);
  f.run("checkpoint"); const fix = f.action("fix", { batch: ["f1"], route: "minimal", change: "minimal" });
  f.apply({ type: "start", executionId: fix }); writeFileSync(join(f.project, "a.txt"), "typo fixed");
  const run = f.get().executions.at(-1)!;
  f.apply({ type: "result", executionId: fix, taskId: f.get().id, planVersion: 1, role: run.role, success: true, processEnd: "confirmed", evidence: ["logs/fix"] }, f.store.actor(run.role, run.sessionId));
  f.verify(fix); f.run("check", { checkName: "unit" }); f.run("review", { resolved: ["f1"], baseFinal: f.review, unchanged: [] });
  assert.throws(() => f.action("commit"), /final review/);
});
test("FCG a reviewer cannot report evidence after changing its input files", (t) => {
  const f = fixture(t); f.approve(); f.run("build"); f.run("check", { checkName: "unit" });
  const executionId = f.action("review"); f.apply({ type: "start", executionId });
  const run = f.get().executions.at(-1)!; writeFileSync(join(f.project, "a.txt"), "two");
  assert.throws(() => f.apply({ type: "result", executionId, taskId: f.get().id, planVersion: 1, role: run.role, success: true, processEnd: "confirmed", evidence: ["logs/review"] },
    f.store.actor(run.role, run.sessionId)), /covered revision/);
});
import nodeTest, { type TestContext } from "node:test";
