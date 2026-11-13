import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixed, connect, tick, tempWorkspaceFolders, settleLeaderTurns, waitFor, source } from "./round2-helpers.ts";
import { plan, fixedServer } from "./fixed-crew-execution-helpers.ts";
import { askAction, probe, installReviewDependencies } from "./pack26-review1-helpers.ts";
import { taskFixture } from "./pack18-editor-task-fixture.ts";
installReviewDependencies();

async function requestFixture(visible = false) {
  const workspaces = tempWorkspaceFolders();
  const server = await loadFixed({ skipHealth: true, workspaces, serverSource: source + `
    const deliveryWork = new Set();
    const originalDelivery = deliverTaskRequest;
    deliverTaskRequest = (...args) => {
      const work = originalDelivery(...args); deliveryWork.add(work);
      void work.then(() => deliveryWork.delete(work), () => deliveryWork.delete(work));
      return work;
    };
    fixedTasks.deliveryIdle = () => deliveryWork.size === 0;
  `, preload(root) {
    if (visible) {
      mkdirSync(join(root, "tasks"));
      writeFileSync(join(root, "tasks", "alpha-dev.json"), JSON.stringify(taskFixture(workspaces.projects[0].tabs[0].folder, "alpha-dev", "roughApproved")));
    }
  } });
  const ws = connect(server), tabId = "alpha-dev";
  const tab = server.tabLocation(tabId).tab;
  const seats = Object.fromEntries(Object.entries(tab.fixedCrew.preferences).map(([slot, p]: [string, any]) => [slot, p.assignment]));
  if (!visible) server.fixedTasks.create(tabId, plan(), seats, server.fixedTasks.actor("planner", "planning"));
  const expected = () => { const t = server.fixedTasks.get(tabId); return { taskId: t.id, planVersion: t.planVersion, recordRevision: t.recordRevision }; };
  if (!visible) server.fixedTasks.apply({ tabId, ...expected(), requestId: "approve" }, { type: "approvePlan" }, server.fixedTasks.actor("owner", "owner"));
  const message = { type: "requestFixedTaskAction", requestId: "request-one", tabId, ...expected(), action: visible ? "polish" : "build" };
  const disk = () => JSON.parse(readFileSync(join(server.testRoot, "tasks", `${tabId}.json`), "utf8"));
  const close = async () => { server.activeLeaderTurns.clear(); server.stopLeaderSession(tabId); await settleLeaderTurns(server); };
  return { server, ws, tabId, message, disk, close };
}

test("P26 busy action request refuses before reservation", async () => {
  const f = await requestFixture();
  try {
    const before = f.disk(); f.server.activeLeaderTurns.add(f.tabId);
    f.ws.message(f.message); await tick();
    const reply = f.ws.messages.find((m: any) => m.requestId === f.message.requestId);
    assert.equal(reply.type, "error", "busy action must be refused");
    assert.match(reply.message, /still answering/);
    assert.deepEqual(f.disk(), before, "busy refusal creates no reservation on disk");
    assert.equal(f.server.launched.length, 0);
  } finally { await f.close(); }
});

test("P26 delivery outside planned cancels without discarding the inspected stage", async () => {
  const f = await requestFixture(true);
  try {
    f.server.createTabLeader(f.tabId);
    f.server.leaders.get(f.tabId).send = () => { throw new Error("injected delivery rejection"); };
    f.ws.message(f.message); await waitFor(() => f.ws.messages.some((m: any) => m.requestId === f.message.requestId && m.type === "error"), "correlated delivery error");
    const error = f.ws.messages.find((m: any) => m.type === "error" && m.requestId === f.message.requestId);
    assert.ok(error, "delivery failure is reported");
    assert.equal(f.disk().stage, "inspected", "never reset the inspected rough to planned");
    assert.equal(f.disk().executions.at(-1).status, "failed", "unconsumed reservation is cancelled without losing the stage");
    assert.equal(f.server.launched.length, 0);
  } finally { await f.close(); }
});

test("P26 failed reservation release reports a correlated error and retains disk state", async () => {
  const f = await requestFixture();
  try {
    f.server.createTabLeader(f.tabId);
    f.server.leaders.get(f.tabId).send = () => { throw new Error("injected delivery rejection"); };
    const apply = f.server.fixedTasks.apply;
    f.server.fixedTasks.apply = (expected: any, event: any, actor: any) => {
      if (event.type === "cancelRequest") throw new Error("injected task write failure");
      return apply(expected, event, actor);
    };
    f.ws.message(f.message); await waitFor(() => f.ws.messages.some((m: any) => m.requestId === f.message.requestId && m.type === "error"), "correlated delivery error");
    const error = f.ws.messages.find((m: any) => m.type === "error" && m.requestId === f.message.requestId);
    assert.equal(error?.tabId, f.tabId);
    assert.match(error?.message ?? "", /Reservation release failed: injected task write failure/);
    assert.equal(f.disk().executions.at(-1).status, "reserved", "failed write never claims cancellation");
    assert.equal(f.server.launched.length, 0);
  } finally { await f.close(); }
});

for (const delivery of ["idle", "false", "rejection", "consumed", "newer"] as const) test(`P26 action delivery ${delivery} preserves exact reservation and replay identity`, async () => {
  const f = await requestFixture();
  try {
    f.server.createTabLeader(f.tabId);
    const leader = f.server.leaders.get(f.tabId), send = leader.send.bind(leader);
    if (["rejection", "consumed", "newer"].includes(delivery)) leader.send = () => { throw new Error("injected delivery rejection"); };
    const apply = f.server.fixedTasks.apply;
    f.server.fixedTasks.apply = (expected: any, event: any, actor: any) => {
      const result = apply(expected, event, actor);
      if (event.type === "action") {
        // The active-turn race occurs after intent is durably saved, before delivery.
        if (delivery === "false") f.server.activeLeaderTurns.add(f.tabId);
        if (delivery === "consumed") f.server.reserveFixedExecution(f.server.currentActor(f.tabId), { kind: "build", route: "normal", change: "none" }, undefined, result.executionId);
        if (delivery === "newer") apply({ ...expected, recordRevision: result.recordRevision, requestId: "newer-owner-event" }, { type: "approvePlan" }, f.server.fixedTasks.actor("owner", "owner"));
        f.ws.message({ type: "selectTab", tabId: "alpha-design" });
      }
      return result;
    };
    f.ws.message(f.message); await waitFor(() => f.ws.messages.some((m: any) => m.requestId === f.message.requestId && m.type === "fixedTaskResult"), "correlated saved request");
    await f.server.getQueue();
    await waitFor(() => f.server.fixedTasks.deliveryIdle(), "actual delivery promise settled");
    const reply = f.ws.messages.find((m: any) => m.type === "fixedTaskResult" && m.requestId === f.message.requestId);
    assert.ok(reply?.executionId, "handler saves and acknowledges one reservation");
    const task = f.disk(), execution = task.executions.find((e: any) => e.id === reply.executionId);
    assert.equal(task.executions.length, 1);
    assert.equal(execution.status, delivery === "idle" || delivery === "consumed" ? "reserved" : "failed", "only an unconsumed failed delivery is released");
    assert.equal(execution.processEnd, delivery === "idle" || delivery === "consumed" ? "unknown" : "confirmed");
    if (delivery === "idle") {
      assert.ok(f.server.chats.some((c: any) => c.tabId === f.tabId && c.text.includes(reply.executionId)), "nudge reaches the explicit original tab and exact reservation");
    } else {
      const error = f.ws.messages.find((m: any) => m.type === "error" && m.requestId === f.message.requestId);
      assert.equal(error?.tabId, f.tabId, "failed delivery reports correlated error");
      assert.equal(error?.action, "requestFixedTaskAction");
      assert.ok(f.ws.messages.some((m: any) => m.type === "state" && m.projects), "failure publishes updated state");
    }
    if (delivery === "newer") assert.ok(task.requests.some((r: any) => r.id === "newer-owner-event"), "newer state survives failure release");
    const before = readFileSync(join(f.server.testRoot, "tasks", `${f.tabId}.json`));
    const turns = f.server.chats.length;
    f.server.fixedTasks.apply = apply; leader.send = send; f.server.activeLeaderTurns.clear();
    f.ws.message({ type: "selectTab", tabId: f.tabId }); f.ws.message(f.message); await tick();
    assert.deepEqual(readFileSync(join(f.server.testRoot, "tasks", `${f.tabId}.json`)), before, "replay preserves disk bytes");
    assert.equal(f.server.chats.length, turns, "replay never dispatches again");
    assert.equal(f.server.launched.length, 0, "request and failure release never spawn");
    if (delivery !== "consumed") assert.equal(existsSync(join(f.server.testRoot, "executions", `${f.tabId}.json`)), false, "no execution journal or orphan process");
  } finally { await f.close(); }
});

test("P26 trusted approval names selected reviewer and server Git ahead of misleading brief", { timeout: 90_000 }, async () => {
  const f = await fixedServer({ git: true, shipping: ["commit", "push"], assignments: { leader: { cli: "opencode", model: "opencode/mimo-v2.6-flash-free", effort: "max" }, reviewer2: { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium" } } });
  try {
    await f.planning(); await f.approve();
    for (const kind of ["build", "check"]) {
      f.worker({}); const r = await f.action(kind); assert.equal(r.ok, true, r.text);
      await f.ended(r.value.runId); assert.equal((await f.verify(r.value.runId, kind === "check" ? "focused" : null)).ok, true);
    }
    const before = f.journal().executions.length;
    const review = await askAction(f, "review", "Look at this code");
    assert.match(review.item.summary, /^Action: review\nPosition: Reviewer \(reviewer2\)\nExecution: claude \/ claude-sonnet-5-5\[1m\] \/ medium\nFolder:/);
    assert.equal(f.journal().executions.length, before, "approval creates no reservation");
    const run = await review.answer(true); assert.equal(run.ok, true, String(run.value));
    assert.equal(run.value.selectedSlot, "reviewer2", "execution uses the approved reviewer");
    await f.ended(run.value.runId); assert.equal((await f.verify(run.value.runId)).ok, true);
    await f.c.request({ type: "setPermissionMode", tabId: "fixed", mode: "bypass", confirm: true });
    const commit = await f.action("commit"); assert.equal(commit.ok, true, commit.text);
    assert.equal((await f.verify(commit.value.runId)).ok, true);
    const push = await askAction(f, "push", "Review the code");
    assert.match(push.item.summary, /^Action: push\nPosition: Leader \(leader\)\nExecution: server Git\nFolder:/);
    assert.ok(push.item.summary.endsWith("Leader brief:\nReview the code"));
    const commandsBefore = readFileSync(join(f.server.temp, "git-observed.jsonl"), "utf8");
    assert.equal((await push.answer(false)).ok, false);
    assert.equal(readFileSync(join(f.server.temp, "git-observed.jsonl"), "utf8"), commandsBefore, "denial executes no Git");
  } finally { await f.close(); }
});

test("P26 live fixed writer warns other tabs through probe chat Run and announcement", { timeout: 90_000 }, async () => {
  const f = await fixedServer({ secondTab: true });
  try {
    await f.planning(); await f.approve();
    f.worker({ delay: 1200 });
    const read = await f.assist("researcher");
    assert.deepEqual(await probe(f, "fixed-second"), [], "read-only executions are excluded");
    await f.ended(read.runId); assert.equal((await f.verify(read.runId)).ok, true);
    f.worker({ delay: 9000 }); const build = await f.action("build"); assert.equal(build.ok, true, build.text);
    await f.c.wait(() => f.observation(build.value.runId), "writer CLI recorded its input");
    assert.deepEqual(await probe(f, "fixed"), [], "own tab excluded");
    const expected = { seatName: "Coder", roleLabel: "Coder", tabName: f.c.tab("fixed").name };
    assert.deepEqual((await probe(f, "fixed-second")).map((i: any) => i.writer), [expected], "live Coder is a writer");
    const headsUp = await f.control("announce", { tabId: "fixed-second" });
    assert.match(headsUp, /Coder \(Coder\).*tab is writing/);
    assert.equal(await f.control("announce", { tabId: "fixed-second" }), "", "same announcement snoozes once");
    // A separate tab can chat while the global heavy slot belongs to Coder.
    const held = await f.c.attempt({ type: "chat", tabId: "fixed-second", text: "held", requestId: "writer-chat" });
    assert.deepEqual(held, {});
    let warning = f.c.messages.find((m) => m.type === "folderBusy" && m.requestId === "writer-chat");
    // toAnnounce and remember share snoozes, so reset only the shown warning via a new writer below.
    if (!warning) {
      await f.ended(build.value.runId); assert.equal((await f.verify(build.value.runId)).ok, true);
      f.worker({ delay: 9000 }); const next = await f.action("build"); assert.equal(next.ok, true, next.text);
      await f.c.attempt({ type: "chat", tabId: "fixed-second", text: "held new", requestId: "writer-chat-new" });
      warning = f.c.messages.find((m) => m.type === "folderBusy" && m.requestId === "writer-chat-new");
    }
    assert.deepEqual(warning?.items.map((i: any) => i.writer), [expected], "chat receives writer details");
    let from = f.c.messages.length;
    f.c.send({ type: "run", tabId: "fixed-second", slot: "coder", prompt: "work" });
    const runReply = await f.c.wait(() => f.c.messages.slice(from).find((m) => ["folderBusy", "fixedRunRequested", "error"].includes(m.type)), "manual Run response");
    assert.equal(runReply.type, "folderBusy", "manual Run is held by the live writer");
    assert.deepEqual(runReply.items.map((i: any) => i.writer), [expected]);
    f.c.send({ type: "chat", tabId: "fixed-second", text: "continue", requestId: "writer-continue", confirmBusy: true });
    await f.c.wait(() => f.c.messages.find((m) => m.type === "chatDone" && m.tabId === "fixed-second"), "continued chat completes");
    assert.deepEqual(await probe(f, "fixed-second"), [], "same run snoozed after Continue");
    const active = f.journal().activeExecutionId;
    await f.ended(active); assert.equal((await f.verify(active)).ok, true);
    f.worker({ delay: 9000 }); const again = await f.action("build"); assert.equal(again.ok, true, again.text);
    assert.deepEqual((await probe(f, "fixed-second")).map((i: any) => i.writer), [expected], "a new run warns again");
    for (const folder of [join(f.server.temp, "unrelated"), f.server.work + "-lookalike", join(f.server.work, "child")]) {
      mkdirSync(folder, { recursive: true });
      assert.deepEqual(await f.c.attempt({ type: "changeFolder", tabId: "fixed-second", folder }), {});
      const items = await probe(f, "fixed-second");
      assert.equal(items.some((i: any) => i.writer), folder.endsWith("child"), `folder relationship ${folder}`);
    }
  } finally { await f.close(); }
});
