import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { neverFixture, assertCancelled, waitFor } from "./pack26-review2-never-launched-helpers.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";

test("P26R7N page Run has no task reservation", async t => {
  const f = await neverFixture(t), before = f.taskBytes(), workers = f.server.launched.length;
  f.ws.message({ type: "run", tabId: f.tabId, slot: "coder", prompt: "Read the plan first" });
  await f.idle();
  assert.equal(f.ws.messages.some(m => m.type === "fixedRunRequested"), true, "FOUND page Run reply");
  assert.deepEqual(f.taskBytes(), before); f.assertNoLaunch(workers);
});

test("P26R7N denial and successful no-tool reply cancellation", async t => {
  for (const deny of [false, true]) {
    console.log(`FOUND ${deny ? "owner Deny" : "no-tool reply"}`);
    const f = await neverFixture(t), workers = f.server.launched.length;
    const runId = await f.request();
    assert.equal(f.last().status, "reserved");
    if (deny) {
      await f.server.leaders.get(f.tabId).setPermissionMode("ask");
      const pending = f.call("request_task_action", { expected: f.expected(), kind: "build", reservedExecutionId: runId, brief: "Owner approval" });
      try {
        await waitFor(() => f.server.pendingApprovals.size === 1, "real pending approval");
        await f.refused("pending approval", /Runtime or persisted launch facts/, runId);
      } finally {
        for (const [approvalId] of f.server.pendingApprovals) f.ws.message({ type: "answerApproval", requestId: "deny", tabId: f.tabId, approvalId, allow: false });
      }
      assert.equal((await pending).isError, true, "Deny refuses the real pending action");
      assert.equal(f.server.pendingApprovals.size, 0);
      assert.equal(f.ws.messages.some(m => m.type === "actionResult" && m.action === "answerApproval"), true);
    }
    const before = f.task(); await assertCancelled(f, runId);
    assert.equal(f.task().stage, before.stage); f.assertNoLaunch(workers);
  }
});

test("P26R7N legacy interrupted reservation cancellation", async t => {
  const f = await neverFixture(t); const id = await f.request();
  f.rewrite(task => { task.stage = "interrupted"; task.executions.at(-1).status = "interrupted"; });
  await assertCancelled(f, id); assert.equal(f.task().stage, "planned");
});

test("P26R7N cold restart preserves task-only stage", async t => {
  for (const stage of ["planned", "inspected", "review", "shipping"] as const) {
    const f = await neverFixture(t, stage === "inspected");
    if (stage === "inspected") { await f.worker("rough"); await f.worker("visualCheck"); await f.worker("inspect");
      f.ws.message({ type: "approveFixedRough", requestId: "rough-approval", tabId: f.tabId, ...f.expected(), roughRevision: f.task().roughRevision }); }
    if (["review", "shipping"].includes(stage)) await f.ready();
    f.rewrite(task => { task.stage = stage; });
    const id = await f.request(stage === "inspected" ? "polish" : "build");
    const before = f.task(), workers = f.server.launched.length;
    const cold = f.restart();
    assert.equal(cold.stage, stage, `FOUND cold stage ${stage}`); assert.equal(cold.executions.at(-1).status, "interrupted");
    assert.equal(cold.recordRevision, before.recordRevision + 1);
    for (const key of ["ownerScopeApproval", "ownerRoughApproval", "roughRevision", "checks", "reviews", "findings", "revisions"]) assert.deepEqual(cold[key], before[key]);
    await assertCancelled(f, id); assert.equal(f.task().stage, stage);
    f.assertNoLaunch(workers); assert.deepEqual(createTaskStore(f.data, () => f.folder).get(f.tabId), f.task());
  }
});

test("P26R7N publication failure and exact fresh retry", async t => {
  const f = await neverFixture(t), id = await f.request();
  const before = f.snapshot();
  const failed = await f.withPublishFailure(() => f.reconcile(id));
  assert.equal(failed.isError, true); assert.match(failed.text, /F1 task publication failed/);
  assert.deepEqual(f.snapshot(), before, "failed replacement keeps disk and cache brake");
  f.restart(); assert.equal(f.last().status, "interrupted"); await assertCancelled(f, id);
  const settled = f.snapshot(); assert.equal((await f.reconcile(id)).isError, false);
  assert.deepEqual(f.snapshot(), settled, "fresh exact retry is byte-identical with no revision/request increment");
});

test("P26R7N historical stage clears only after final unresolved execution", async t => {
  const f = await neverFixture(t), first = await f.request();
  // assist is an ordinary production action permitted while another reservation exists.
  const current = f.task();
  const second = f.server.fixedTasks.apply({ tabId: f.tabId, ...f.expected(), requestId: "second-intent" },
    { type: "action", action: { kind: "assist", route: "normal", change: "none" }, sessionId: "second-unlaunched", batch: [] }, f.server.fixedTasks.actor("leader", "retained-second")).executionId!;
  assert.equal(f.task().executions.length, current.executions.length + 1);
  f.rewrite(task => { task.stage = "interrupted"; for (const run of task.executions.filter(e => [first, second].includes(e.id))) run.status = "interrupted"; });
  await assertCancelled(f, first); assert.equal(f.task().stage, "interrupted");
  await assertCancelled(f, second); assert.equal(f.task().stage, "planned");
});

test("P26R7N direct and browser cancellation completion", async t => {
  for (const direct of [false, true]) {
    console.log(`FOUND completion ${direct ? "direct" : "browser"}`);
    const f = await neverFixture(t); await f.ready();
    const id = direct ? await f.direct() : await f.request();
    f.restart(); await assertCancelled(f, id);
    const workers = f.server.launched.length;
    const result = await f.finish(); assert.equal(result.isError, false, result.text);
    const taskId = JSON.parse(result.text).taskId;
    const archive = await f.tool("get_task_archive", { kind: "task", id: taskId });
    assert.equal(archive.task.executions.find(e => e.id === id).status, "failed");
    assert.equal(archive.task.executions.find(e => e.id === id).verified, false);
    assert.deepEqual(await f.tool("get_task_archive", { kind: "task", id: taskId }), archive);
    f.assertNoLaunch(workers);
  }
});

test("P26R7N cold Deny no-tool worker and Git admission failures", async t => {
  for (const variant of ["deny", "reply", "worker", "git", "before-delivery"]) {
    console.log(`FOUND cold recovery ${variant}`);
    const f = await neverFixture(t); if (variant === "git") await f.ready();
    let id: string;
    if (["worker", "git"].includes(variant)) id = await f.direct(variant === "git" ? "commit" : "build");
    else {
      id = await f.request("build", variant === "before-delivery" ? () => {} : undefined);
      if (variant === "deny") {
        await f.server.leaders.get(f.tabId).setPermissionMode("ask");
        const pending = f.call("request_task_action", { expected: f.expected(), kind: "build", reservedExecutionId: id, brief: "Deny then restart" });
        try { await waitFor(() => f.server.pendingApprovals.size === 1, "Deny approval"); }
        finally { for (const [approvalId] of f.server.pendingApprovals) f.ws.message({ type: "answerApproval", requestId: "deny-cold", tabId: f.tabId, approvalId, allow: false }); }
        assert.equal((await pending).isError, true, "Deny refuses action");
        assert.equal(f.server.pendingApprovals.size, 0);
      }
    }
    const workers = f.server.launched.length, chats = f.server.chats.length;
    f.restart(); assert.equal(f.last().status, "interrupted");
    assert.equal(f.server.chats.length, chats, "cold normalization never replays delivery");
    await assertCancelled(f, id); f.assertNoLaunch(workers);
  }
});

test("P26R7N delivery cancellation publication failure remains explicitly recoverable", async t => {
  const f = await neverFixture(t), leader = f.server.leaders.get(f.tabId), send = leader.send;
  leader.send = () => { throw new Error("delivery failed"); };
  const store = f.server.fixedTasks, apply = store.apply;
  store.apply = (expected, event, actor) => {
    if (event.type === "cancelRequest") throw new Error("F1 delivery cancellation publication failure");
    return apply(expected, event, actor);
  };
  try { await f.request(); }
  finally { leader.send = send; store.apply = apply; }
  assert.equal(f.last().status, "reserved");
  assert.equal(f.ws.messages.some(m => m.type === "error" && m.message.includes("F1 delivery cancellation publication failure")), true);
  f.restart(); await assertCancelled(f, f.last().id);
});

test("P26R7N durable cancellation response failure and stale continuation", async t => {
  const f = await neverFixture(t), id = await f.request(), stale = f.expected();
  const store = f.server.fixedTasks, get = store.get; let published = false;
  store.get = (tabId: string) => {
    const value = get(tabId);
    if (value?.executions.find(e => e.id === id)?.status === "failed" && !published) { published = true; throw new Error("post-publication state response failure"); }
    return value;
  };
  try { assert.equal((await f.reconcile(id)).isError, true); }
  finally { store.get = get; }
  assert.equal(published, true); const bytes = f.taskBytes(), settled = f.task();
  assert.equal((await f.reconcile(id)).isError, false); assert.deepEqual(f.taskBytes(), bytes); assert.deepEqual(f.task(), settled);
  assert.equal((await f.reconcile(id, { expected: stale })).isError, true);
  const resumed = await f.call("request_task_action", { expected: stale, kind: "build", reservedExecutionId: id, brief: "Late old continuation" });
  assert.equal(resumed.isError, true); assert.deepEqual(f.taskBytes(), bytes);
});


test("P26R7N warm admissions reply failure and authenticated retry", async t => {
  for (const kind of ["build", "commit", "reply"]) {
    const f = await neverFixture(t); if (kind === "commit") await f.ready();
    const id = kind === "reply" ? await f.request("build", () => {}) : await f.direct(kind);
    const workers = f.server.launched.length;
    await assertCancelled(f, id);
    const before = f.taskBytes();
    f.server.runRecords.set(id, { tabId: f.tabId });
    try { await f.refused("retry rechecks runtime", /Runtime or persisted launch facts/, id); }
    finally { f.server.runRecords.delete(id); }
    assert.equal((await f.reconcile(id)).isError, false); assert.deepEqual(f.taskBytes(), before);
    f.rewrite(task => { task.requests.find(r => r.result.executionId === id).digest = "a".repeat(64); });
    await f.refused("retry reauthenticates receipt", /authentic original action receipt/, id); f.assertNoLaunch(workers);
  }
});


test("P26R7N approved waiting continuation loses its cancelled revision", async t => {
  const f = await neverFixture(t), id = await f.request(), workers = f.server.launched.length;
  await f.server.leaders.get(f.tabId).setPermissionMode("ask");
  const continuation = f.call("request_task_action", { expected: f.expected(), kind: "build", reservedExecutionId: id, brief: "Previously waiting continuation" });
  let cancellation: ReturnType<typeof f.reconcile> | undefined;
  try {
    await waitFor(() => f.server.pendingApprovals.size === 1, "waiting continuation approval");
    const approvalId = [...f.server.pendingApprovals.keys()][0];
    f.ws.message({ type: "answerApproval", requestId: "allow-before-cancel", tabId: f.tabId, approvalId, allow: true });
    // The service publishes synchronously before the approved promise resumes.
    cancellation = f.reconcile(id);
  } finally {
    for (const [approvalId] of f.server.pendingApprovals) f.ws.message({ type: "answerApproval", requestId: "clear-held", tabId: f.tabId, approvalId, allow: false });
  }
  assert.ok(cancellation); assert.equal((await cancellation).isError, false);
  assert.equal((await continuation).isError, true, "approved continuation refuses its stale reservation revision");
  assert.equal(f.last().status, "failed"); f.assertNoLaunch(workers);
});

test("P26R7N cancellations preserve completion brakes", async t => {
  for (const missing of ["checks", "review", "shipping", "unresolved"]) {
    const f = await neverFixture(t); await f.ready();
    if (missing === "checks") f.rewrite(task => { task.checks = []; });
    if (missing === "review") f.rewrite(task => { task.reviews = []; });
    if (missing === "shipping") f.rewrite(task => { const commit = task.executions.find(e => e.kind === "commit"); commit.status = "failed"; commit.verified = false; });
    const id = await f.request(); await assertCancelled(f, id);
    if (missing === "unresolved") {
      f.server.fixedTasks.apply({ tabId: f.tabId, ...f.expected(), requestId: "unresolved-finish" }, { type: "action", action: { kind: "assist", route: "normal", change: "none" }, sessionId: "unresolved", batch: [] }, f.server.fixedTasks.actor("leader", "finish-hold"));
    }
    const before = f.taskBytes(); assert.equal((await f.finish()).isError, true, `FOUND completion brake ${missing}`);
    assert.deepEqual(f.taskBytes(), before);
  }
});
