import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tempRoot } from "./temp-root.ts";
import { config } from "./round2-setup.ts";
import { source, loadServer, loadFixed, fixedGateServer, startHelper, endRun, connect, lastState, tick, waitFor, flushMicrotasks } from "./round2-helpers.ts";
import { pendingFor } from "./round2-gate-helpers.ts";

test("permission mode persists per tab, applies live, requires bypass confirmation, and reaches a new session", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "setPermissionMode", requestId: "bypass_unconfirmed", tabId: "alpha-design", mode: "bypass" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "bypass_unconfirmed"), "bypass confirmation refusal");
  assert.equal(server.settingsService.permissionMode("alpha-design"), "accept");

  ws.message({ type: "setPermissionMode", requestId: "bypass_confirmed", tabId: "alpha-design", mode: "bypass", confirm: true });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "bypass_confirmed"), "bypass mode result").catch((error) => assert.fail(`${error.message}; recent messages: ${JSON.stringify(ws.messages.slice(-8))}`));
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start with default" });
  await tick();
  assert.equal(server.leaderModes[0], "accept");

  ws.message({ type: "setPermissionMode", requestId: "plan_live", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "plan_live"), "live plan result");
  assert.deepEqual(server.leaderHandles[0].permissionCalls, ["plan"]);
  assert.equal(server.settingsService.permissionMode("alpha-dev"), "plan");

  ws.message({ type: "chat", tabId: "alpha-design", text: "start with saved bypass" });
  await tick();
  assert.equal(server.leaderModes[1], "bypass");
  assert.equal(server.settingsService.permissionMode("alpha-design"), "bypass");
});

test("the WebSocket permission call site stops a leader exactly once when live apply returns false", async () => {
  const server = await loadServer({ skipHealth: true, setPermissionResult: false }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create leader" });
  await tick();
  const leader = server.leaderHandles[0];
  ws.message({ type: "setPermissionMode", requestId: "perm_false_callsite", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "perm_false_callsite"), "false live permission apply");
  const failure = ws.messages.findLast((message: any) => message.type === "error" && message.requestId === "perm_false_callsite");
  assert.match(failure.message, /permission mode change failed/i);
  assert.equal(leader.stopCalls, 1, "the live leader is stopped exactly once");
  assert.equal(server.leaders.has("alpha-dev"), false, "the failed live leader is removed");
  assert.equal(server.settingsService.permissionMode("alpha-dev"), "accept", "saved mode stays unchanged");
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionModes, "alpha-dev"), false);
  assert.equal(server.stateMessage().settings.permissionActions["alpha-dev"].status, "failed");
});

test("a queued permission request looks up a leader created after it was queued", async () => {
  const server = await loadServer({ skipHealth: true, deferFirstPermission: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create first leader" });
  await tick();
  const firstLeader = server.leaderHandles[0];
  ws.message({ type: "setPermissionMode", requestId: "perm_hold", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => typeof firstLeader.resolvePermission === "function", "first permission apply is pending");

  ws.message({ type: "clear", tabId: "alpha-dev" });
  ws.message({ type: "setPermissionMode", requestId: "perm_queued", tabId: "alpha-dev", mode: "ask" });
  await flushMicrotasks();
  assert.equal(server.leaders.has("alpha-dev"), false, "the second request is queued while no leader exists");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create replacement leader" });
  await waitFor(() => server.leaderHandles.length === 2, "replacement leader created before queued apply");
  const replacement = server.leaderHandles[1];

  firstLeader.resolvePermission!(true);
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "perm_queued"), "queued permission result");
  assert.deepEqual(replacement.permissionCalls, ["ask"], "the queued ask mode reaches the replacement leader");
  assert.equal(server.settingsService.permissionMode("alpha-dev"), "ask");
});

test("a failed stale permission request does not stop a replacement leader", async () => {
  const server = await loadServer({ skipHealth: true, deferFirstPermission: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create first leader" });
  await tick();
  const firstLeader = server.leaderHandles[0];
  ws.message({ type: "setPermissionMode", requestId: "perm_stale", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => typeof firstLeader.resolvePermission === "function", "stale permission apply is pending");

  ws.message({ type: "clear", tabId: "alpha-dev" });
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create replacement leader" });
  await waitFor(() => server.leaderHandles.length === 2, "replacement leader created");
  const replacement = server.leaderHandles[1];
  firstLeader.resolvePermission!(false);

  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "perm_stale"), "stale permission failure");
  assert.equal(firstLeader.stopCalls, 1, "Clear stopped the old leader");
  assert.equal(replacement.stopCalls, 0, "the stale failure leaves the replacement leader alone");
  assert.equal(server.leaders.has("alpha-dev"), true);
  assert.equal(server.settingsService.permissionMode("alpha-dev"), "accept");
});

test("a permission failure saves the partial answer and makes the next leader read the handover", async () => {
  const server = await loadFixed({ skipHealth: true, hangLeader: true, setPermissionResult: false }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start a long answer" });
  await waitFor(() => server.leaderHandles.length === 1, "leader created");
  server.leaderHandles[0].callbacks.onDelta("partial answer");

  ws.message({ type: "setPermissionMode", requestId: "perm_partial", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "perm_partial"), "permission failure with active turn");
  const savedPartial = ws.messages.findLast((message: any) => message.type === "chatMessage" && message.tabId === "alpha-dev" && message.text.includes("partial answer"));
  assert.equal(savedPartial.text, "partial answer\nPermission mode change failed.");
  assert.equal(server.pendingHandoverReads.has("alpha-dev"), true, "the next session is marked to read RESUME.md");

  ws.message({ type: "chat", tabId: "alpha-dev", text: "continue" });
  await waitFor(() => server.chats.some((entry: any) => entry.text.includes("Before replying, first read the existing handover")), "next turn handover read");
  assert.match(server.chats.findLast((entry: any) => entry.tabId === "alpha-dev").text, /\.command-center[\\/]alpha-dev[\\/]RESUME\.md/);
});

test("removing a tab during a live permission request deletes its saved mode and blocks a late save", async () => {
  const server = await loadServer({ skipHealth: true, deferFirstPermission: true }), ws = connect(server);
  ws.message({ type: "setPermissionMode", requestId: "perm_seed", tabId: "alpha-design", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "perm_seed"), "seed permission mode");
  ws.message({ type: "chat", tabId: "alpha-design", text: "create design leader" });
  await tick();
  const leader = server.leaderHandles[0];
  ws.message({ type: "setPermissionMode", requestId: "perm_removed", tabId: "alpha-design", mode: "ask" });
  await waitFor(() => typeof leader.resolvePermission === "function", "tab permission apply is pending");

  ws.message({ type: "removeTab", tabId: "alpha-design" });
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionModes, "alpha-design"), false);
  leader.resolvePermission!(true);
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "perm_removed"), "removed tab permission refusal");

  const persisted = JSON.parse(readFileSync(path.join(server.testRoot, "settings.json"), "utf8"));
  assert.equal(Object.hasOwn(persisted.permissionModes, "alpha-design"), false, "disk has no mode for the removed tab");
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionModes, "alpha-design"), false, "the late completion does not restore the mode");
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionActions, "alpha-design"), false, "the removed tab has no orphaned action state");
});

const refusal = (promise: Promise<unknown>) => promise.then(() => "launched", (error: Error) => error.message);
const confirmRelease = "release may leave a process running and editing files";

test("leader launch budget is durable and a failed durable reservation prevents spawn", async () => {
  let fail = true;
  const server = await loadFixed({ skipHealth: true, failSafety: () => fail });
  assert.match(await refusal(startHelper(server, "alpha-dev", "helper", "run")), /could not persist launch safety/);
  assert.equal(server.launched.length, 0);
  assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "the failed save left no reservation");
  fail = false;
  for (let i = 0; i < 8; i++) await endRun(server, (await startHelper(server, "alpha-dev", "helper", `run ${i}`)).runId);
  assert.match(await refusal(startHelper(server, "alpha-dev", "helper", "over budget")), /budget/);
  assert.equal(server.safety().timestamps.length, 8);
});

test("a leader launch persists its pending notice with the leader as its source", async () => {
  const writes: config.LaunchSafety[] = [];
  const server = await loadFixed({ skipHealth: true, onSafetyWrite: (value) => writes.push(value) });
  const ws = connect(server);
  const started = await startHelper(server, "alpha-dev", "helper", "leader work");
  const source = writes[0].notices.at(-1)?.source;
  assert.ok(source, "a source is recorded");
  assert.equal(writes[0].notices.at(-1)?.pending, true);
  assert.deepEqual([server.safety().notices.at(-1)?.source, server.safety().notices.at(-1)?.pending], [source, false]);
  assert.ok(ws.messages.some((message: any) => message.type === "leaderLaunch" && message.source === source));
  await endRun(server, started.runId);
});

test("the approval-wait refusal and the launch notice name the same leader", async () => {
  const { server, ws, deps } = await fixedGateServer("ask");
  const waiting = deps.launch("helper", "Needs an answer");
  await waitFor(() => pendingFor(server).length === 1, "launch approval");
  ws.message({ type: "save", tabId: "alpha-dev" });
  await tick();
  const waitingName = ws.messages.filter((message: any) => message.type === "error").at(-1)?.message.replace(/ is waiting for your answer on a change$/, "");
  assert.match(ws.messages.filter((message: any) => message.type === "error").at(-1)?.message, / is waiting for your answer on a change$/);
  ws.message({ type: "answerApproval", requestId: "rename_allow", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
  const result = await waiting;
  assert.equal(result.ok, true);
  assert.equal(server.safety().notices.at(-1)?.source, waitingName, "the launch notice names the same leader the refusal names");
  await endRun(server, result.runId);
});

test("a launch-safety disk failure never suppresses a requested Kill", async () => {
  let fail = false;
  const server = await loadFixed({ skipHealth: true, failSafety: () => fail });
  const ws = connect(server);
  const runId = (await startHelper(server, "alpha-dev", "helper", "work")).runId;
  fail = true;
  ws.message({ type: "killRun", runId });
  assert.deepEqual(server.kills, [runId]);
  assert.ok(ws.messages.some((message: any) => message.type === "killAccepted" && message.runId === runId));
});

test("leader launch budget and seat stop block survive a fresh server instance", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  const first = await loadFixed({ skipHealth: true, safetyPath });
  const ws = connect(first);
  const runId = (await startHelper(first, "alpha-dev", "helper", "first task")).runId;
  ws.message({ type: "killRun", runId });
  assert.deepEqual(config.readLaunchSafety(safetyPath).blocked, ["alpha-dev.helper"]);
  assert.equal(config.readLaunchSafety(safetyPath).timestamps.length, 1);
  assert.equal(config.readLaunchSafety(safetyPath).notices[0].seatId, "alpha-dev.helper");

  const restarted = await loadFixed({ skipHealth: true, safetyPath });
  assert.match(await refusal(startHelper(restarted, "alpha-dev", "helper", "must stay blocked")), /launch blocked/);
  assert.equal(restarted.launched.length, 0);
  assert.equal(restarted.safety().timestamps.length, 1);
});

test("legacy bare-id launch safety stays visible while new records use tab-scoped keys", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  const old: config.LaunchSafety = {
    blocked: ["sonny"], timestamps: [Date.now()],
    notices: [{ type: "leaderLaunch", id: 1, seatId: "sonny", seatName: "Sonny", brief: "old work", source: "alpha" }],
    nextNoticeId: 2, released: [], uncertain: [{ seatId: "sonny", pid: 9876 }],
  };
  config.writeLaunchSafety(old, safetyPath);
  const server = await loadFixed({ skipHealth: true, safetyPath });
  const state = server.stateMessage().launchSafety as config.LaunchSafety;
  assert.deepEqual(state.blocked, ["sonny"]);
  assert.deepEqual(state.uncertain, [{ seatId: "sonny", pid: 9876 }]);
  assert.equal(state.notices[0].seatId, "sonny");

  assert.match(await refusal(startHelper(server, "alpha-dev", "helper", "new work")), /unconfirmed process/);
  assert.equal(server.launched.length, 0);
  assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "the refused launch left no reservation");
  const unblocked = await loadFixed({ skipHealth: true, safetyPath });
  const unblockWs = connect(unblocked);
  unblockWs.message({ type: "clearLaunchBlock", seatKey: "sonny", confirm: "allow this seat to launch again" });
  assert.match(await refusal(startHelper(unblocked, "alpha-dev", "helper", "still uncertain")), /unconfirmed process/);
  assert.equal(unblocked.launched.length, 0);
  unblockWs.message({ type: "releaseUnconfirmedSeat", seatId: "sonny", confirm: confirmRelease });
  unblockWs.message({ type: "clearLaunchBlock", seatKey: "sonny", confirm: "allow this seat to launch again" });
  const released = await loadFixed({ skipHealth: true, safetyPath });
  const started = await startHelper(released, "alpha-dev", "helper", "released bare id");
  const saved = config.readLaunchSafety(safetyPath);
  assert.deepEqual(saved.blocked, []);
  assert.deepEqual(saved.uncertain, []);
  assert.deepEqual(saved.released, [{ seatId: "sonny", pid: 9876 }]);
  assert.equal(saved.notices.at(-1)?.seatId, "alpha-dev.helper");
  await endRun(released, started.runId);
});

test("corrupt launch safety refuses server startup instead of resetting brakes", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  await writeFile(safetyPath, "{");
  await assert.rejects(loadServer({ skipHealth: true, safetyPath }), /JSON|Unexpected/);
  await writeFile(safetyPath, "{}");
  await assert.rejects(loadServer({ skipHealth: true, safetyPath }), /launch safety|malformed|blocked/i);
  await writeFile(safetyPath, JSON.stringify({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [{ seatId: "alpha.dev", pid: "not-a-pid", runId: "run-1" }] }));
  await assert.rejects(loadServer({ skipHealth: true, safetyPath }), /launch safety|malformed|unconfirmed/i);
});
