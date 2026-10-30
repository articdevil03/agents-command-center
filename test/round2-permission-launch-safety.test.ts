import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tempRoot } from "./temp-root.ts";
import { config } from "./round2-setup.ts";
import { source, loadServer, connect, lastState, tick, waitFor, flushMicrotasks } from "./round2-helpers.ts";
import { launchGateServer, pendingFor } from "./round2-gate-helpers.ts";

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
  const server = await loadServer({ skipHealth: true, hangLeader: true, setPermissionResult: false }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start a long answer" });
  await waitFor(() => server.leaderHandles.length === 1, "leader created");
  server.leaderHandles[0].callbacks.onDelta("partial answer");

  ws.message({ type: "setPermissionMode", requestId: "perm_partial", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "perm_partial"), "permission failure with active turn");
  const savedPartial = ws.messages.findLast((message: any) => message.type === "chatMessage" && message.tabId === "alpha-dev" && message.text.includes("partial answer"));
  assert.equal(savedPartial.text, "partial answer\nPermission mode change failed.");
  assert.equal(server.pendingHandoverReads.has("alpha-dev"), true, "the next session is marked to read RESUME.md");

  ws.message({ type: "chat", tabId: "alpha-dev", text: "continue" });
  await waitFor(() => server.chats.some((entry: any) => entry.text.startsWith("Before replying, first read the existing handover")), "next turn handover read");
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

test("leader launch budget is durable and a failed durable reservation prevents spawn", async () => {
  let fail = true;
  const server = await loadServer({ skipHealth: true, failSafety: () => fail });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create leader" });
  await tick();
  const deps = server.leaderDeps.get("Development");
  assert.equal((await deps.launch("coder", "run")).ok, false);
  assert.equal(server.launched.length, 0);
  fail = false;
  for (let i = 0; i < 8; i++) assert.equal((await deps.launch("coder", `run ${i}`)).ok, true);
  assert.equal((await deps.launch("coder", "over budget")).ok, false);
  assert.equal(server.safety().timestamps.length, 8);
});

test("client, leader, and stall relaunches persist pending launch notices with their source", async () => {
  const writes: config.LaunchSafety[] = [];
  const server = await loadServer({ skipHealth: true, onSafetyWrite: (value) => writes.push(value) });
  const ws = connect(server);
  const client = server.launchWorker("alpha-dev", "reviewer2", "client work");
  assert.equal(client.ok, true);
  assert.deepEqual([writes[0].notices.at(-1)?.source, writes[0].notices.at(-1)?.pending], ["Local client", true]);
  assert.deepEqual([server.safety().notices.at(-1)?.source, server.safety().notices.at(-1)?.pending], ["Local client", false]);
  assert.ok(ws.messages.some((message: any) => message.type === "leaderLaunch" && message.source === "Local client"));
  server.leaderLaunch("alpha-dev", "coder", "leader work");
  assert.equal(writes.at(-2)?.notices.at(-1)?.source, "Atlas");
  assert.equal(writes.at(-2)?.notices.at(-1)?.pending, true);
  assert.equal(server.safety().notices.at(-1)?.source, "Atlas");
  assert.ok(ws.messages.some((message: any) => message.type === "leaderLaunch" && message.source === "Atlas"));
});

test("a renamed leader is named in the approval-wait refusal and in the launch notice, never a hard-coded name", async () => {
  const { server, ws, deps } = await launchGateServer("ask");
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", name: "Ada" }); await tick();
  assert.equal(lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader").name, "Ada", "control: the leader is renamed");
  const waiting = deps.launch("coder", "Needs an answer");
  await waitFor(() => pendingFor(server).length === 1, "launch approval");
  ws.message({ type: "save", tabId: "alpha-dev" });
  await tick();
  assert.equal(ws.messages.filter((message: any) => message.type === "error").at(-1)?.message, "Ada is waiting for your answer on a change", "the save refusal names the renamed leader");
  ws.message({ type: "answerApproval", requestId: "rename_allow", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
  assert.equal((await waiting).ok, true);
  assert.equal(server.safety().notices.at(-1)?.source, "Ada", "the launch notice names the renamed leader");
});

test("a launch-safety disk failure never suppresses a requested Kill", async () => {
  let fail = false;
  const server = await loadServer({ skipHealth: true, failSafety: () => fail });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create leader" });
  await tick();
  await server.leaderDeps.get("Development").launch("coder", "work");
  const runId = server.launched[0].run.runId;
  fail = true;
  ws.message({ type: "killRun", runId });
  assert.deepEqual(server.kills, [runId]);
  assert.ok(ws.messages.some((message: any) => message.type === "killAccepted" && message.runId === runId));
});

test("leader launch budget and seat stop block survive a fresh server instance", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  const first = await loadServer({ skipHealth: true, safetyPath });
  const ws = connect(first);
  assert.equal(first.leaderLaunch("alpha-dev", "coder", "first task").ok, true);
  const runId = first.launched[0].run.runId;
  ws.message({ type: "killRun", runId });
  assert.deepEqual(config.readLaunchSafety(safetyPath).blocked, ["alpha-dev.coder"]);
  assert.equal(config.readLaunchSafety(safetyPath).timestamps.length, 1);
  assert.equal(config.readLaunchSafety(safetyPath).notices[0].seatId, "alpha-dev.coder");

  const restarted = await loadServer({ skipHealth: true, safetyPath });
  const rejected = restarted.leaderLaunch("alpha-dev", "coder", "must stay blocked");
  assert.match(rejected.ok ? "unexpected launch" : rejected.error, /launch blocked/);
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
  const server = await loadServer({ skipHealth: true, safetyPath });
  const state = server.stateMessage().launchSafety as config.LaunchSafety;
  assert.deepEqual(state.blocked, ["sonny"]);
  assert.deepEqual(state.uncertain, [{ seatId: "sonny", pid: 9876 }]);
  assert.equal(state.notices[0].seatId, "sonny");

  const rejectedClient = server.launchWorker("alpha-dev", "coder", "new work");
  const rejectedLeader = server.leaderLaunch("alpha-dev", "reviewer2", "new work");
  assert.equal(rejectedClient.ok, false);
  assert.equal(rejectedLeader.ok, false);
  assert.match(rejectedClient.error, /unconfirmed process/);
  assert.match(rejectedLeader.error, /unconfirmed process/);
  assert.equal(server.launched.length, 0);
  const unblocked = await loadServer({ skipHealth: true, safetyPath });
  const unblockWs = connect(unblocked);
  unblockWs.message({ type: "clearLaunchBlock", seatKey: "sonny", confirm: "allow this seat to launch again" });
  assert.equal(unblocked.leaderLaunch("alpha-dev", "reviewer2", "still uncertain").ok, false);
  assert.equal(unblocked.launched.length, 0);
  unblockWs.message({ type: "releaseUnconfirmedSeat", seatId: "sonny", confirm: "release may leave a process running and editing files" });
  unblockWs.message({ type: "clearLaunchBlock", seatKey: "sonny", confirm: "allow this seat to launch again" });
  const released = await loadServer({ skipHealth: true, safetyPath });
  assert.equal(released.leaderLaunch("alpha-dev", "reviewer2", "released bare id").ok, true);
  const saved = config.readLaunchSafety(safetyPath);
  assert.deepEqual(saved.blocked, []);
  assert.deepEqual(saved.uncertain, []);
  assert.deepEqual(saved.released, [{ seatId: "sonny", pid: 9876 }]);
  assert.equal(saved.notices.at(-1)?.seatId, "alpha-dev.reviewer2");
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
