import nodeTest, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixed-crew-task-plan.test.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempRoot, importWithTempDataRoot } from "./temp-root.ts";
const test = (name: string, check: (t: TestContext) => void) => nodeTest(name, (t) => assert.doesNotThrow(() => check(t), name));

test("FCT approval check review and stage setters form a complete lifecycle", (t) => {
  const f = fixture(t);
  assert.doesNotThrow(f.approve); assert.equal(f.get().ownerScopeApproval?.planVersion, 1);
  f.run("build"); f.run("check", { checkName: "unit" }); assert.equal(f.get().checks.length, 1);
  assert.doesNotThrow(() => f.apply({ type: "stage", stage: "review" })); assert.equal(f.get().stage, "review");
  f.run("review"); assert.equal(f.get().reviews.length, 1);
  for (const kind of ["commit", "push", "publish"] as const) f.run(kind);
  f.apply({ type: "stage", stage: "complete" }); assert.equal(f.get().stage, "complete");
});
test("FCT visible rough approval is revision bound and does not spawn", (t) => {
  const f = fixture(t, { visibleWork: true }); f.approve(); f.run("rough");
  f.run("visualCheck"); f.run("inspect"); const roughRevision = f.get().roughRevision!;
  const count = f.get().executions.length;
  assert.doesNotThrow(() => f.apply({ type: "approveRough", roughRevision }, f.actors.owner));
  assert.equal(f.get().ownerRoughApproval?.revision, roughRevision); assert.equal(f.get().executions.length, count);
  f.run("polish"); f.run("check", { checkName: "unit" }); f.run("review"); f.run("commit");
});
test("FCT review findings and Planner triage use real setters", (t) => {
  const f = fixture(t); f.approve(); f.run("build"); f.run("check", { checkName: "unit" });
  const review = f.action("review"); f.finish(review);
  f.verify(review, { findings: [{ id: "finding1", executionId: review, text: "Harmless style", real: true, minimal: true }] });
  assert.throws(() => f.apply({ type: "triage", decisions: [] }, f.actors.planner), /every/);
  const decision = { findingId: "finding1", outcome: "PASS" as const, reason: "Style only" };
  assert.throws(() => f.apply({ type: "triage", decisions: [decision, decision] }, f.actors.planner), /Duplicate/);
  assert.throws(() => f.apply({ type: "triage", decisions: [{ ...decision, reason: "" }] }, f.actors.planner), /text/);
  assert.throws(() => f.apply({ type: "triage", decisions: [decision] }, f.actors.owner), /actor/);
  assert.doesNotThrow(() => f.apply({ type: "triage", decisions: [decision] }, f.actors.planner));
  assert.equal(f.get().triage.finding1.outcome, "PASS"); f.run("commit");
});
test("FCT rejects browser-style evidence and wrong server identities", (t) => {
  const f = fixture(t); f.approve(); const run = f.action("build"); f.apply({ type: "start", executionId: run });
  const record = f.get().executions[0];
  const result = { type: "result" as const, executionId: run, taskId: f.get().id, planVersion: 1, role: record.role, success: true, processEnd: "confirmed" as const, evidence: ["logs/evidence"] };
  assert.throws(() => f.apply(result, f.actors.owner), /actor/);
  assert.throws(() => f.apply(result, f.store.actor(record.role, "wrong-session")), /identity/);
  assert.throws(() => f.apply({ ...result, taskId: "wrong" }, f.store.actor(record.role, record.sessionId)), /identity/);
  f.apply(result, f.store.actor(record.role, record.sessionId));
  assert.throws(() => f.verify(run, { findings: [{ id: "bad", executionId: run, text: "claim", real: true, minimal: false }] }), /Only reviews/);
  f.verify(run); assert.equal(f.get().executions[0].verified, true);
});
nodeTest("FCT browser dispatch limits authority and broadcasts only compact task summary", async (t) => {
  await assert.doesNotReject(async () => {
    const f = fixture(t), copy = tempRoot(["server"]);
    const load = (file: string) => import(pathToFileURL(join(copy, "server", file)).href);
    const { modules: { state, config, messages, broadcast, tasks } } = await importWithTempDataRoot(async () => ({
      state: await load("main/state.ts"), config: await load("config.ts"), messages: await load("main/messages/index.ts"), broadcast: await load("main/broadcast.ts"), tasks: await load("main/fixed-tasks.ts"),
    }));
    const workspace = config.defaultWorkspaces(f.project); workspace.projects[0].tabs[0].id = "tab1";
    state.setWorkspaces(workspace); state.setSelectedTabId("tab1"); state.setFixedTasks(f.store); state.setDataRoot(f.root);
    assert.notEqual(tasks.requestSession("a".repeat(127) + "1"), tasks.requestSession("a".repeat(127) + "2"));
    state.setLaunchSafety({ blocked: [], uncertain: [], released: [], notices: [], live: [] });
    state.setChatStore({ counters: () => ({ revision: 0, savedRevision: 0 }) });
    state.setRequestsStore({ list: () => [], pendingCount: () => 0 });
    state.setSettingsService({ state: { tools: { claude: {}, codex: {}, opencode: {} }, permissionActions: {}, uploads: {} }, snapshot: () => ({}), permissionMode: () => "ask" });
    const replies: any[] = [], socket = { send: (raw: string) => replies.push(JSON.parse(raw)) };
    const dispatch = (type: string, extra: Record<string, unknown> = {}) => {
      messages.handleMessage(socket, JSON.stringify({ type, requestId: `browser${replies.length}`, tabId: "tab1", ...extra })); return replies.at(-1);
    };
    const detail = dispatch("getFixedTask"); assert.equal(detail.type, "fixedTask"); assert.equal(detail.task.id, f.get().id); assert.equal(detail.tabId, "tab1");
    for (const key of ["actor", "role", "sessionId", "triage", "findings", "leader", "planner", "reviewer"]) assert.equal(dispatch("approveFixedPlan", { taskId: f.get().id, planVersion: 1, recordRevision: f.get().recordRevision, [key]: "forged" }).type, "error", key);
    assert.equal(dispatch("approveFixedPlan").type, "error");
    const expected = { taskId: f.get().id, planVersion: 1, recordRevision: f.get().recordRevision };
    const approval = dispatch("approveFixedPlan", expected); assert.equal(approval.type, "fixedTaskResult"); assert.equal(f.get().executions.length, 0);
    assert.equal(dispatch("approveFixedPlan", expected).type, "error", "stale revision refuses");
    const request = { type: "requestFixedTaskAction", requestId: "same-request", tabId: "tab1", taskId: f.get().id, planVersion: 1, recordRevision: f.get().recordRevision, action: "build" };
    messages.handleMessage(socket, JSON.stringify(request)); const result = replies.at(-1); assert.equal(result.type, "fixedTaskResult"); assert.equal(result.executionAvailable, true);
    messages.handleMessage(socket, JSON.stringify(request)); assert.deepEqual(replies.at(-1), result); assert.equal(f.get().executions.length, 1); assert.equal(f.get().executions[0].status, "reserved");
    const view = broadcast.stateMessage().projects[0].tabs[0];
    assert.deepEqual(Object.keys(view.fixedTask).sort(), ["detailRevision", "planVersion", "stage", "taskId"]);
    assert.deepEqual(view.crew, []); assert.deepEqual(view.steps, []); assert.equal(view.fixedCrew.plan, undefined);
    assert.doesNotMatch(JSON.stringify(view), /Implement task|Focused check|coordinatorSessions/);
    assert.equal(dispatch("reviewClean").type, "error");
  });
});
