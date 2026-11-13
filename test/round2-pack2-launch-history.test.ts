import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import * as usage from "../server/usage.ts";
import * as history from "../server/history.ts";
import { tempRoot } from "./temp-root.ts";
import { config } from "./round2-setup.ts";
import { fixtureWorkspaces, tempWorkspaceFolders, source, loadFixed, startHelper, endRun, fixedCreation, connect, lastState, settleLeaderTurns, tick, waitFor } from "./round2-helpers.ts";

test("pack 2: a launch notice keeps a 4000-character reminder of a long brief while the run gets the whole brief; state carries no duplicate notices list", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  const brief = "b".repeat(10_000);
  await startHelper(server, "alpha-dev", "helper", brief);
  assert.ok(server.launched[0].prompt.includes(brief), "the run itself gets the whole brief");
  const notice = server.launchSafety.notices[0];
  assert.equal(notice.brief, `${"b".repeat(4000)}...`);
  ws.message({ type: "hello" });
  assert.equal(Object.hasOwn(lastState(ws), "launchNotices"), false);
  assert.equal(lastState(ws).launchSafety.notices.length, 1);
  server.stopLeaderSession("alpha-dev");
});

test("pack 2: the launch budget refusal says it counts your own Run too and when the next launch is allowed", async () => {
  const server = await loadFixed({ skipHealth: true });
  for (let i = 0; i < 8; i++) await endRun(server, (await startHelper(server, "alpha-dev", "helper", `manual ${i}`)).runId);
  assert.equal(server.launched.length, 8, "each launch uses the budget");
  const refusal = await startHelper(server, "alpha-dev", "helper", "one too many").then(() => "", (error: any) => error.message);
  assert.match(refusal, /^launch budget exceeded: 8 launches in 5 minutes on tab "[^"]+", and your own Run counts too; the next one is allowed in \d+ s$/);
  const seconds = Number(/in (\d+) s/.exec(refusal)![1]);
  assert.ok(seconds >= 295 && seconds <= 300, `the oldest launch clears in about 5 minutes, not ${seconds}`);
  assert.equal(server.launched.length, 8, "the refused launch started nothing");
  server.stopLeaderSession("alpha-dev");
});

test("pack 2: an old unconfirmed or blocked row from before seat keys blocks every launch and the refusal names that row", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  config.writeLaunchSafety({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [{ seatId: "sonny", pid: 9 }], live: [] }, safetyPath);
  const first = await loadFixed({ skipHealth: true, safetyPath });
  await assert.rejects(startHelper(first, "alpha-dev", "reviewer2", "go"), /old unconfirmed process \(sonny\) blocks every launch/);
  const blockedPath = path.join(tempRoot(), "launch-safety.json");
  config.writeLaunchSafety({ blocked: ["vera"], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] }, blockedPath);
  const second = await loadFixed({ skipHealth: true, safetyPath: blockedPath });
  await assert.rejects(startHelper(second, "alpha-dev", "reviewer2", "go"), /old launch block \(vera\) blocks every launch/);
  assert.equal(second.launched.length, 0);
  assert.equal(first.executionJournal(first.testRoot, "alpha-dev").activeExecutionId, null, "the refused launch released its reservation");
  first.stopLeaderSession("alpha-dev"); second.stopLeaderSession("alpha-dev");
});

test("pack 2: a run the last session never saw end blocks its seat on the next start; a clean exit leaves nothing to block", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  const first = await loadFixed({ skipHealth: true, safetyPath });
  const { runId } = await startHelper(first);
  assert.deepEqual(config.readLaunchSafety(safetyPath).live, [{ seatId: "alpha-dev.helper", runId }], "recorded before the process starts");
  await endRun(first, runId);
  assert.deepEqual(config.readLaunchSafety(safetyPath).live, [], "and forgotten when it ends");

  // A crash: the run was live and nobody saw it end.
  const crashPath = path.join(tempRoot(), "launch-safety.json");
  const crashed = await loadFixed({ skipHealth: true, safetyPath: crashPath });
  await startHelper(crashed);
  const restarted = await loadFixed({ skipHealth: true, safetyPath: crashPath });
  await assert.rejects(startHelper(restarted, "alpha-dev", "helper", "again"), /launch blocked after a prior stop: alpha-dev\.helper/);
  assert.equal(typeof (await startHelper(restarted, "alpha-dev", "reviewer1", "other seat")).runId, "string", "only that seat is blocked");
  assert.ok(config.readLaunchSafety(crashPath).blocked.includes("alpha-dev.helper"), "the block is saved");
  assert.deepEqual(config.readLaunchSafety(crashPath).live.map((row) => row.seatId), ["alpha-dev.reviewer1"], "the stale rows were replaced by what runs now");

  // A clean exit: the workers were asked to stop, nothing is left to block.
  const cleanPath = path.join(tempRoot(), "launch-safety.json");
  const clean = await loadFixed({ skipHealth: true, safetyPath: cleanPath });
  await startHelper(clean);
  clean.processHandlers.exit(1);
  assert.equal(config.readLaunchSafety(cleanPath).live.length, 1, "a failing exit code is not a clean exit");
  clean.processHandlers.exit(0);
  assert.deepEqual(config.readLaunchSafety(cleanPath).live, []);
  const afterClean = await loadFixed({ skipHealth: true, safetyPath: cleanPath });
  assert.equal(typeof (await startHelper(afterClean, "alpha-dev", "helper", "fresh")).runId, "string");
  for (const server of [first, crashed, restarted, clean, afterClean]) server.stopLeaderSession("alpha-dev");
});

test("pack 2: a release whose save fails changes nothing, and the same release then succeeds", async () => {
  let fail = false;
  const server = await loadFixed({ skipHealth: true, releaseUnconfirmed: () => true, failSafety: () => fail }), ws = connect(server);
  await startHelper(server, "alpha-dev", "reviewer2", "uncertain run"); const entry = server.launched[0];
  entry.callback.onUnconfirmedKill(entry.run, 4321);
  const engineRun = () => server.tabs.get("alpha-dev").state.runs.find((run: any) => run.id === entry.run.runId);
  fail = true;
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.match(ws.messages.at(-1).message, /safety disk failed/);
  assert.equal(server.launchSafety.uncertain.length, 1, "still unconfirmed");
  assert.equal(server.launchSafety.released.length, 0, "not released (the rollback restores the list it pushed to)");
  assert.equal(server.blockedSeatKeys.has("alpha-dev.reviewer2"), false, "no block added");
  assert.equal(server.unconfirmedRunIds.has(entry.run.runId), true);
  assert.equal(engineRun().status, "working", "the engine still sees the run");
  assert.equal(server.runContexts.has(entry.run.runId), true);
  assert.equal(server.stateMessage().releasedProcesses.length, 0);
  fail = false;
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.equal(server.launchSafety.uncertain.length, 0);
  assert.equal(server.launchSafety.released.length, 1);
  assert.equal(engineRun().status, "failed");
  assert.equal(server.launchSafety.live.length, 0, "a released run is no longer a live one");
  server.stopLeaderSession("alpha-dev");
});

test("pack 2: a release with one row the runner does not hold unconfirmed releases none of them", async () => {
  const server = await loadFixed({ skipHealth: true, releaseUnconfirmed: () => false }), ws = connect(server);
  await startHelper(server, "alpha-dev", "reviewer2", "first");
  const [one] = server.launched;
  // A stale row (its run is long gone, so the runner has nothing to check) sits before the run's own row; the runner does not hold the real run as unconfirmed.
  server.launchSafety.uncertain.push({ seatId: one.run.seatKey, pid: 99, runId: "stale-run-id" });
  one.callback.onUnconfirmedKill(one.run, 4321);
  ws.message({ type: "releaseUnconfirmedSeat", seatId: one.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.match(ws.messages.at(-1).message, new RegExp(`process is not tracked as unconfirmed: ${one.run.runId}`));
  assert.equal(server.launchSafety.uncertain.length, 2, "neither row is released");
  assert.equal(server.launchSafety.released.length, 0);
  assert.equal(server.runContexts.has(one.run.runId), true, "the run keeps its context");
  assert.equal(server.tabs.get("alpha-dev").state.runs.find((run: any) => run.id === one.run.runId).status, "working", "and its engine run");
  assert.equal(server.blockedSeatKeys.has("alpha-dev.reviewer2"), false);
  server.stopLeaderSession("alpha-dev");
});

test("pack 2: the retired crew-editing messages and an old-style tab creation are refused on a fixed crew before the leader is touched", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" });
  await tick(20);
  assert.equal(server.leaders.size, 1);
  const before = JSON.stringify(server.getWorkspaces());
  for (const bad of [{ type: "useSetup", templateId: "nope" }, { type: "useSetup", setupId: "nope" }, { type: "setSetup", crew: [] }, { type: "saveSetup", name: "mine" }, { type: "updateSeat", slot: "reviewer1", name: "Changed" }]) {
    ws.message({ ...bad, tabId: "alpha-dev" });
    assert.match(ws.messages.at(-1).message, /^Fixed crews use task decisions\. Legacy crew editing and step\/review messages are unavailable\.$/, JSON.stringify(bad));
  }
  assert.equal(server.leaderHandles[0].stopCalls, 0, "the leader was never stopped for a request that could not succeed");
  assert.equal(server.leaders.size, 1);
  assert.equal(JSON.stringify(server.getWorkspaces()), before, "nothing was saved");
  ws.message({ ...fixedCreation(), type: "addProject", id: "extra", name: "Extra", folder: server.testRoot, template: "nope" });
  assert.match(ws.messages.at(-1).message, /Unknown or locked crew field/, "the fixed creation form carries no template field");
  assert.equal(server.getWorkspaces().projects.some((project: any) => project.id === "extra"), false);
  ws.message({ ...fixedCreation(), type: "addProject", id: "extra", name: "Extra", folder: server.testRoot });
  assert.equal(server.getWorkspaces().projects.some((project: any) => project.id === "extra"), true, "the fixed form creates it");
});

test("pack 2: removing a tab whose workspace write fails keeps the tab and its leader; a removal that holds drops every trace and its id is not reused", async () => {
  let failWrite = false;
  const server = await loadFixed({ skipHealth: true, failWorkspaceWrite: () => failWrite, workspaces: tempWorkspaceFolders("fixed") }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-design", text: "hello" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "alpha-design"), "a chat exists for the tab");
  server.blockedSeatKeys.add("alpha-design.designer");
  server.launchSafety.notices.push({ type: "leaderLaunch", id: 5, seatId: "alpha-design.designer", seatName: "Terra", brief: "old", source: "Atlas" }); server.launchSafety.nextNoticeId = 6;
  failWrite = true;
  ws.message({ type: "removeTab", tabId: "alpha-design" });
  assert.match(ws.messages.at(-1).message, /workspace disk failed/);
  assert.equal(server.leaderHandles[0].stopCalls, 0, "the leader of a tab that stays is not stopped");
  assert.equal(server.leaders.has("alpha-design"), true);
  assert.ok(server.getWorkspaces().projects[0].tabs.some((tab: any) => tab.id === "alpha-design"));

  failWrite = false;
  ws.message({ type: "removeTab", tabId: "alpha-design" });
  assert.equal(server.getWorkspaces().projects[0].tabs.some((tab: any) => tab.id === "alpha-design"), false);
  assert.equal(server.leaderHandles[0].stopCalls, 1);
  assert.equal(server.blockedSeatKeys.has("alpha-design.designer"), false, "its launch blocks go with it");
  assert.equal(server.launchSafety.notices.some((notice: any) => notice.seatId.startsWith("alpha-design.")), false, "and its launch notices");
  assert.equal(config.readLaunchSafety(path.join(server.testRoot, "launch-safety.json")).blocked.includes("alpha-design.designer"), false, "saved too");
  assert.equal(server.pendingHandoverReads.has("alpha-design"), false);
  assert.ok(existsSync(path.join(server.testRoot, "chats", "alpha-design.jsonl")), "the chat file itself is never deleted");
  appendFileSync(path.join(server.testRoot, "chats", "alpha-design.jsonl"), `${JSON.stringify({ type: "message", tabId: "alpha-design", revision: 3, role: "user", text: "late", at: 1 })}\n`);
  assert.equal(server.chatStore.counters("alpha-design").revision, 3, "the removed tab's transcript is no longer held in memory");

  ws.message({ ...fixedCreation(), type: "addTab", projectId: "alpha", tabId: "alpha-design", name: "Again" });
  assert.match(ws.messages.at(-1).message, /tab id was used before and still has history: alpha-design/);
  ws.message({ ...fixedCreation(), type: "addTab", projectId: "alpha", tabId: "alpha-fresh", name: "Fresh", folder: server.testRoot });
  assert.equal(server.getWorkspaces().projects[0].tabs.some((tab: any) => tab.id === "alpha-fresh"), true, "an id with no history is fine");
  ws.message({ ...fixedCreation(), type: "addTab", projectId: "alpha", name: "Random", folder: server.testRoot });
  assert.equal(server.getWorkspaces().projects[0].tabs.length, 4, "a generated id never collides");
});

test("pack 2: the leader's saved-session history ids are not shared with a tab id that had a history", async () => {
  const server = await loadFixed({ skipHealth: true, workspaces: tempWorkspaceFolders("fixed") }), ws = connect(server);
  writeFileSync(path.join(server.testRoot, "logs", "alpha-ghost.leader-1.log"), "old");
  ws.message({ ...fixedCreation(), type: "addTab", projectId: "alpha", tabId: "alpha-ghost", name: "Ghost", folder: server.testRoot });
  assert.match(ws.messages.at(-1).message, /tab id was used before/, "a log of that id's seats counts as history");
});

test("pack 2: history lists and stats only the asked seat's files, newest first, at most 200", async () => {
  const stats: string[] = [];
  const server = await loadFixed({ skipHealth: true, stat: async (file: any, ...rest: any[]) => { stats.push(path.basename(String(file))); return (stat as any)(file, ...rest); } });
  const logs = path.join(server.testRoot, "logs");
  for (const name of ["beta-dev.coder-5.log", "beta-dev.coder-5.brief.txt", "alpha-dev.coder-3.log", "alpha-dev.coder-3.brief.txt", "alpha-dev.reviewer1-4.log"]) writeFileSync(path.join(logs, name), "x");
  stats.length = 0;
  const list = await server.listHistory("alpha-dev.coder");
  assert.deepEqual(JSON.parse(JSON.stringify(list.map((entry: any) => entry.timestamp))), [3]);
  assert.deepEqual([...stats], ["alpha-dev.coder-3.log"], "no other seat's log is looked at");
  for (let i = 0; i < 210; i++) writeFileSync(path.join(logs, `alpha-dev.coder-${1000 + i}.log`), "x");
  const many = await server.listHistory("alpha-dev.coder");
  assert.equal(many.length, 200);
  assert.equal(many[0].timestamp, 1209, "newest first");
  assert.equal(many.at(-1).timestamp, 1010, "the 10 oldest of the 210 are past the cap");
});

test("pack 2: a fixed crew workspace runs no paid startup health check and leaves no record of one", async () => {
  const fresh = await loadFixed({ query: undefined });
  assert.equal(fresh.queryCount(), 0, "no paid turn at start-up: the fixed leader starts on its first chat");
  assert.equal(existsSync(path.join(fresh.testRoot, "leader-check.json")), false, "and nothing is remembered as passed");
  const stale = await loadFixed({ preload: (root) => writeFileSync(path.join(root, "leader-check.json"), JSON.stringify({ model: "claude-sonnet-5-5[1m]", cli: "", at: Date.now() - 2 * 24 * 3600_000 })) });
  assert.equal(stale.queryCount(), 0, "a stale record does not start a check either");
  assert.equal(fresh.leaders.size, 0);
});

test("pack 2: an uncaught error or a server error before the server listens ends the process; once it listens they are only reported", async () => {
  const early = await loadFixed({ skipHealth: true, neverListen: true });
  early.processHandlers.uncaughtException(new Error("never came up"));
  assert.deepEqual([...early.exitCodes], [1]);
  early.server.emit("error", new Error("listen EADDRINUSE"));
  assert.deepEqual([...early.exitCodes], [1, 1]);
  const up = await loadFixed({ skipHealth: true }), ws = connect(up);
  up.processHandlers.uncaughtException(new Error("a later fault"));
  up.server.emit("error", new Error("a later server error"));
  assert.deepEqual([...up.exitCodes], [], "a running server stays up");
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /a later fault/.test(message.message)), "and says so");
});

test("pack 3: a client that fell behind and recovers is sent the full state once, not that state plus the output chunk that triggered the resync", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  const { runId } = await startHelper(server, "alpha-dev", "reviewer2", "stream output");
  ws.bufferedAmount = 8 * 1024 * 1024 + 1;
  server.emitOutput(runId, "dropped-");
  ws.bufferedAmount = 0;
  ws.messages.length = 0;
  server.emitOutput(runId, "trigger");
  assert.equal(ws.messages.filter((message: any) => message.type === "output").length, 0, "the chunk is inside the resynced state, so it is not sent again");
  const resync = ws.messages.find((message: any) => message.type === "state" && message.notice);
  assert.ok(resync, "the client got the full state with the drop notice");
  assert.equal(resync.projects[0].tabs[0].runs.find((run: any) => run.runId === runId).output, "dropped-trigger");
  await endRun(server, runId);
  server.stopLeaderSession("alpha-dev");
});

test("pack 3: stopping a tab's leader with spend on it banks the total; the next leader's spend is added on top", async () => {
  const server = await loadFixed({ skipHealth: true, usageDelta: { modelId: "claude-opus-5-5[1m]", contextTokens: 10, contextWindow: 1_000_000, costUsd: 0.5 } }), ws = connect(server);
  const leaderUsage = () => lastState(ws).projects[0].tabs[0].leaderUsage;
  ws.message({ type: "chat", tabId: "alpha-dev", text: "before" });
  await tick();
  assert.equal(leaderUsage().contextTokens, 10, "control: the live leader's own figures are shown");
  ws.message({ type: "stopSeat", tabId: "alpha-dev", slot: "leader" });
  assert.equal(leaderUsage().contextTokens, null, "stopping banks the usage: the per-instance figures are cleared");
  assert.equal(leaderUsage().costUsd, 0.5, "and the spend stays");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "after" });
  await tick();
  assert.equal(leaderUsage().costUsd, 1, "the new leader's 0.5 is added to the banked 0.5, not shown instead of it");
  await settleLeaderTurns(server);
});

const claudeReviewer = () => {
  const workspaces = fixtureWorkspaces("fixed");
  workspaces.projects[0].tabs[0].fixedCrew!.preferences.reviewer1.assignment = { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "high" };
  return workspaces;
};

test("pack 3: a worker run's usage reports add up through the server instead of the second starting over", async () => {
  const server = await loadFixed({ skipHealth: true, workspaces: claudeReviewer() }), ws = connect(server);
  await startHelper(server, "alpha-dev", "reviewer1", "claude worker");
  const run = server.launched[0].run;
  assert.equal(run.cli, "claude");
  const result = (extra: object) => JSON.stringify({ type: "result", usage: { input_tokens: 7 }, modelUsage: { [run.model]: { contextWindow: 1_000_000 } }, ...extra }) + "\n";
  server.emitOutput(run.runId, result({ total_cost_usd: 0.02 }));
  server.emitOutput(run.runId, result({}));
  const usage = server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === run.runId).usage;
  assert.equal(usage.turns, 2, "two reports counted");
  assert.equal(usage.costUsd, 0.02, "the second report had no cost, so the first one's stays");
  await endRun(server, run.runId);
  server.stopLeaderSession("alpha-dev");
});

test("pack 3: a worker's plan-limit report is broadcast to the page as a rateLimit message", async () => {
  const server = await loadFixed({ skipHealth: true, workspaces: claudeReviewer() }), ws = connect(server);
  await startHelper(server, "alpha-dev", "reviewer1", "claude worker");
  const run = server.launched[0].run;
  server.emitOutput(run.runId, JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 123 } } } }) + "\n");
  const sent = ws.messages.find((message: any) => message.type === "rateLimit");
  assert.ok(sent, "a rateLimit message reached the client");
  assert.deepEqual([sent.tabId, sent.runId, sent.windows], ["alpha-dev", run.runId, { five_hour: { utilization: 0.2, resetsAt: 123 } }]);
  await endRun(server, run.runId);
  server.stopLeaderSession("alpha-dev");
});

test("pack 3: a launch the runner refuses leaves no run context and no stall tracker behind", async () => {
  const server = await loadFixed({ skipHealth: true });
  server.rejectRun();
  await assert.rejects(startHelper(server, "alpha-dev", "reviewer2", "refused brief"), /injected runner refusal/);
  assert.equal(server.runContexts.size, 0, "no context for a run that never started");
  assert.equal(server.stallTrackers.trackers.size, 0, "no stall tracker for a run that never started");
  assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "and the heavy reservation is released");
  server.stopLeaderSession("alpha-dev");
});

test("pack 3: a killRun message whose run id holds a control character is refused as an invalid run id", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "killRun", runId: "run\u0001id" });
  const error = ws.messages.find((message: any) => message.type === "error");
  assert.match(error?.message ?? "", /invalid run id/);
  assert.equal(ws.messages.some((message: any) => message.type === "killAccepted"), false);
});

test("pack 9: a heads-up line in the chat is never part of the saved session log, and is not something the leader is sent", async () => {
  const server = await loadFixed({ skipHealth: true, leaderDelayMs: 10, writeHandover: true, workspaces: tempWorkspaceFolders("fixed"), preload: (root) => {
    mkdirSync(path.join(root, "chats"), { recursive: true });
    writeFileSync(path.join(root, "chats", "alpha-dev.jsonl"), [
      { type: "message", tabId: "alpha-dev", revision: 1, role: "notice", text: "Heads up: a Codex session outside Command Center is active in this folder.", at: 1 },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  } }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "decide the plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "alpha-dev"), "first answer");
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"), "Save done");
  let entries: any[] = [];
  const deadline = Date.now() + 2_000;
  while ((entries = await server.listHistory("alpha-dev.leader")).length !== 1) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for the history lists the saved session");
    await tick(10);
  }
  const log = readFileSync(path.join(server.testRoot, "logs", entries[0].logFile), "utf8");
  assert.match(log, /^You: decide the plan/, "the log starts with the person's words: the notice line is not in it");
  assert.equal(log.includes("Heads up"), false);
  assert.equal(server.chats.some((turn: any) => String(turn.text).includes("Heads up")), false, "nothing the leader was sent carries it");
});
