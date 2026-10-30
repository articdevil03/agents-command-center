import test from "node:test";
import assert from "node:assert/strict";
import * as stall from "../server/stall.ts";
import { tempWorkspaceFolders, loadServer, connect, lastState, tick, flushMicrotasks } from "./round2-helpers.ts";

test("run output replay stays under 200 KB and trims only at UTF-8 boundaries through the real callback", async () => {
  const server = await loadServer({ skipHealth: true });
  connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "inspect output");
  const entry = server.launched[0];
  const cap = 200 * 1024;
  for (const text of ["x".repeat(cap + 1), "😀".repeat(cap), "界".repeat(cap), "😀" + "a".repeat(cap - 1)]) {
    server.emitOutput(entry.run.runId, text);
    const run = server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
    const bytes = Buffer.byteLength(run.output, "utf8");
    assert.ok(bytes <= cap && bytes >= cap - 3, `output bytes=${bytes} for input bytes=${Buffer.byteLength(text, "utf8")}`);
    assert.equal(run.output.isWellFormed(), true);
    assert.doesNotMatch(run.output, /�/);
    assert.ok(text.endsWith(run.output), "the replay is a whole-character suffix of the input");
  }
  const run = server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
  assert.equal(run.output.endsWith("a"), true);
  assert.ok(Buffer.byteLength(run.output, "utf8") <= cap);
  server.launchWorker("alpha-dev", "reviewer2", "short output");
  const short = server.launched[1];
  server.emitOutput(short.run.runId, "abc");
  server.emitOutput(short.run.runId, "界😀");
  assert.equal(server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === short.run.runId).output, "abc界😀");
});

test("slow clients skip output and state, receive small errors, then quiet resync with a drop notice", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.bufferedAmount = 8 * 1024 * 1024 + 1;
  server.broadcast({ type: "output", runId: "run-a", chunk: "missed output" });
  server.broadcast({ type: "state" });
  server.broadcast({ type: "error", message: "small control event" });
  assert.deepEqual(ws.messages.map((message: any) => message.type), ["error"]);
  ws.bufferedAmount = 0;
  server.tickResync();
  assert.equal(ws.messages.at(-1).type, "state");
  assert.equal(ws.messages.at(-1).notice, "[output dropped: client fell behind]");
});

test("real stall timer relaunches a silent read-only Codex run once and escalates the next stall", async () => {
  const server = await loadServer({ relaunchable: true, skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "review this" });
  const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.launched.length, 2);
  assert.equal(server.launched[1].prompt, "review this");
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === first.run.runId && message.action === "relaunch"));
  assert.ok(ws.messages.some((message: any) => message.type === "runStop" && message.runId === first.run.runId && message.internal === true));
  assert.equal(server.safety().notices.at(-1)?.source, "Stall relaunch");

  const second = server.launched[1];
  const tracker = server.stallTrackers.trackers.get(second.run.runId);
  tracker.lastGrowthAt = Date.now() - stall.STALL_THRESHOLD_MS - 1;
  server.tick();
  assert.equal(server.launched.length, 2);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === second.run.runId && message.action === "escalate"));
});

test("a stalled run is never relaunched by itself: the real canRunWrite counts every run as able to write, so a silent read-only Codex run escalates at once", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "review this" });
  const first = server.launched[0];
  assert.equal(first.run.cli, "codex"); assert.equal(first.run.canWrite, false, "control: a read-only Codex slot");
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.launched.length, 1, "no second launch");
  assert.equal(server.pendingRelaunch.size, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === first.run.runId && message.action === "escalate"), "the stall is escalated to the user");
  assert.equal(ws.messages.some((message: any) => message.type === "runStalled" && message.action === "relaunch"), false);
});

test("output after a stall cancels the queued relaunch before the real child closes", async () => {
  const server = await loadServer({ relaunchable: true, skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "recover before relaunch");
  const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.pendingRelaunch.has(first.run.runId), true);
  server.emitOutput(first.run.runId, "late recovery output");
  assert.equal(server.pendingRelaunch.has(first.run.runId), false);
  server.closeRun(first.run.runId);
  assert.equal(server.launched.length, 1);
  assert.ok(ws.messages.some((message: any) => message.type === "output" && message.chunk === "late recovery output"));
});

test("Stop seat stops only its engine seat and cancels its queued stall relaunch", async () => {
  const server = await loadServer({ relaunchable: true, skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "stalling run");
  server.launchWorker("beta-dev", "coder", "other tab run");
  const stalled = server.launched[0], other = server.launched[1];
  server.stallTrackers.startRun(stalled.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.pendingRelaunch.has(stalled.run.runId), true);
  ws.message({ type: "stopSeat", tabId: "alpha-dev", slot: "reviewer2" });
  assert.equal(server.pendingRelaunch.has(stalled.run.runId), false);
  const engine = () => server.tabs.get("alpha-dev").state;
  assert.equal(engine().seats.find((seat: any) => seat.slotId === "reviewer2").status, "stopped", "the stop request shows at once");
  assert.equal(engine().runs.find((run: any) => run.id === stalled.run.runId).status, "working", "a live run is not settled before its close");
  assert.ok(server.safety().blocked.includes(stalled.run.seatKey));
  assert.equal(server.userKilledRuns.has(stalled.run.runId), true);
  assert.equal(server.stallTrackers.isKilled(stalled.run.runId), true);
  assert.equal(server.isRunning(other.run.runId), true);
  server.closeRun(stalled.run.runId);
  assert.equal(engine().runs.find((run: any) => run.id === stalled.run.runId).status, "stopped");
  assert.equal(server.launched.length, 2);
});

test("Stop all stops the engine, leaders, and workers and cancels a queued stall relaunch", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true, hangLeader: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start leader" });
  server.launchWorker("alpha-dev", "reviewer2", "stalling run");
  server.launchWorker("beta-dev", "coder", "second run");
  const stalled = server.launched[0], second = server.launched[1];
  server.stallTrackers.startRun(stalled.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  ws.message({ type: "stopAll" });
  assert.ok(ws.messages.some((message: any) => message.type === "stopAllAccepted"), JSON.stringify(ws.messages));
  assert.equal(server.pendingRelaunch.has(stalled.run.runId), false);
  const runStatus = (tabId: string, runId: string) => server.tabs.get(tabId).state.runs.find((run: any) => run.id === runId).status;
  assert.equal(runStatus("alpha-dev", stalled.run.runId), "working", "a live run is not settled before its close");
  assert.equal(runStatus("beta-dev", second.run.runId), "working");
  assert.equal(server.tabs.get("alpha-dev").state.seats.find((seat: any) => seat.slotId === "reviewer2").status, "stopped");
  assert.deepEqual(new Set(server.safety().blocked), new Set([stalled.run.seatKey, second.run.seatKey]));
  assert.equal(server.userKilledRuns.has(stalled.run.runId), true);
  assert.equal(server.stallTrackers.isKilled(stalled.run.runId), true);
  assert.ok(server.leaderHandles[0].stopCalls > 0);
  server.closeRun(stalled.run.runId); server.closeRun(second.run.runId);
  assert.equal(runStatus("alpha-dev", stalled.run.runId), "stopped");
  assert.equal(runStatus("beta-dev", second.run.runId), "stopped");
  assert.equal(server.launched.length, 2);
});

function approvedLookWithWorker(server: any, ws: any, tabId: string) {
  for (let i = 0; i < 8 && server.tabs.get(tabId).state.approval.state !== "pending"; i++) ws.message({ type: "advanceStep", tabId });
  assert.equal(server.launchWorker(tabId, "coder", "still editing").ok, true);
  ws.message({ type: "approveLook", tabId });
  assert.equal(server.tabs.get(tabId).state.approval.reviewWaits, true, "review waits for the working coder");
  return server.launched.at(-1).run.runId;
}

const reviewerStatus = (server: any, tabId: string) => server.tabs.get(tabId).state.seats.find((seat: any) => seat.slotId === "reviewer1").status;

test("Stop seat keeps the review gate closed until the stopped worker's close is confirmed", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true }), ws = connect(server);
  const runId = approvedLookWithWorker(server, ws, "alpha-dev");
  ws.message({ type: "stopSeat", tabId: "alpha-dev", slot: "coder" });
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, true, "the reviewer must not start while the worker may still edit");
  assert.notEqual(reviewerStatus(server, "alpha-dev"), "working");
  server.closeRun(runId);
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, false);
  assert.equal(reviewerStatus(server, "alpha-dev"), "working");
});

test("Stop all pauses a waiting review: it stays closed when each stopped worker's close is confirmed", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true }), ws = connect(server);
  const runId = approvedLookWithWorker(server, ws, "alpha-dev");
  ws.message({ type: "stopAll" });
  // Stop all pauses the waiting review at once: it never opens by itself, neither now nor when the stopped worker's close is confirmed.
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, false);
  assert.equal(reviewerStatus(server, "alpha-dev"), "stopped", "the reviewer must not start while the worker may still edit");
  server.closeRun(runId);
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, false);
  assert.equal(reviewerStatus(server, "alpha-dev"), "stopped", "the confirmed close does not open the paused review");
  assert.equal(server.tabs.get("alpha-dev").state.seats.find((seat: any) => seat.slotId === "leader").status, "stopped");
  assert.equal(server.stateMessage().projects[0].tabs[0].derived.busy, false, "a stopped tab is not busy");
});

test("Stop all settles a stopped worker on explicit release when its close is never confirmed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const server = await loadServer({ skipHealth: true, deferKill: true }), ws = connect(server);
  const runId = approvedLookWithWorker(server, ws, "alpha-dev");
  ws.message({ type: "stopAll" });
  t.mock.timers.tick(5_000);
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, false);
  ws.message({ type: "releaseUnconfirmed", runId, confirm: "release may leave a process running and editing files" });
  assert.equal(server.tabs.get("alpha-dev").state.runs.find((run: any) => run.id === runId).status, "failed");
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, false);
  assert.equal(reviewerStatus(server, "alpha-dev"), "stopped", "releasing the worker does not open the paused review");
  server.closeRun(runId);
});

test("Stop seat on an idle worker seat still blocks its next launch", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "stopSeat", tabId: "alpha-dev", slot: "reviewer1" });
  assert.ok(server.safety().blocked.includes("alpha-dev.reviewer1"));
  const refused = server.leaderLaunch("alpha-dev", "reviewer1", "start anyway");
  assert.match(refused.ok ? "launched" : refused.error, /launch blocked/);
  assert.equal(server.launched.length, 0);
});

test("changing process or kind banks and stops the live leader, and the next chat starts a fresh one", async () => {
  const server = await loadServer({ skipHealth: true, usageDelta: { modelId: "claude-opus-5-5[1m]", contextTokens: 10, contextWindow: 1_000_000, costUsd: 0.5 } }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "before" });
  await tick();
  const first = server.leaders.get("alpha-dev");
  ws.message({ type: "useSetup", tabId: "alpha-dev", templateId: "duo" });
  assert.equal(server.leaders.has("alpha-dev"), false, "the old leader must not keep answering for the new process");
  assert.equal(server.leaderHandles[0].stopCalls, 1);
  assert.ok(lastState(ws).projects[0].tabs[0].leaderUsage, "the stopped leader's spend stays banked");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "after" });
  await tick();
  assert.notEqual(server.leaders.get("alpha-dev"), first);
  assert.equal(server.leaderCreates.length, 2);
  ws.message({ type: "useSetup", tabId: "alpha-dev", templateId: "design" });
  assert.equal(server.leaders.has("alpha-dev"), false);
  assert.equal(server.leaderHandles[1].stopCalls, 1);
});

test("an SDK error result during Save is a failed handover, never a saved one", async () => {
  const sdkLeader = (args: any) => {
    const turns = (async function* () {
      for await (const message of args.prompt) {
        const text = message.message.content[0].text;
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "reply" } } };
        yield text.startsWith("Save a concise handover")
          ? { type: "result", subtype: "error_during_execution", is_error: true }
          : { type: "result", subtype: "success", is_error: false };
      }
    })();
    return Object.assign(turns, { setModel: async () => {} });
  };
  const server = await loadServer({ skipHealth: true, sdkLeader }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "work" });
  await tick();
  assert.ok(ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "alpha-dev"), "an ordinary result still completes");
  ws.message({ type: "save", tabId: "alpha-dev" });
  await tick(40);
  assert.equal(lastState(ws).projects[0].tabs[0].savedRevision, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)));
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false);
  server.leaders.get("alpha-dev").stop();
});

test("Clear recovers the same tab while its own Save is hung", async () => {
  const server = await loadServer({ skipHealth: true, hangSave: true, writeHandover: true, workspaces: tempWorkspaceFolders() }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "work" });
  await tick(10);
  ws.message({ type: "save", tabId: "alpha-dev" });
  await flushMicrotasks();
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), true, "the Save turn is hung");
  ws.message({ type: "clear", tabId: "alpha-dev" });
  assert.ok(ws.messages.some((message: any) => message.type === "chatCleared" && message.tabId === "alpha-dev"));
  await tick(10);
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), false);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)), "the hung Save ends as a failure");
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false);
  assert.equal(lastState(ws).projects[0].tabs[0].savedRevision, 0);
  ws.message({ type: "chat", tabId: "beta-dev", text: "other" });
  await tick(10);
  ws.message({ type: "save", tabId: "beta-dev" });
  await tick(20);
  assert.ok(server.chats.some((entry: any) => entry.tabId === "beta-dev" && entry.text.startsWith("Save a concise handover")), "the Save queue is free again");
  ws.message({ type: "clear", tabId: "beta-dev" });
  await tick(10);
});

test("a thrown runner start rolls back its launch-budget reservation and pending notice", async () => {
  const server = await loadServer({ skipHealth: true });
  const priorTimestamps = [...server.safety().timestamps], priorNotices = [...server.safety().notices];
  server.throwRun();
  const refused = server.launchWorker("alpha-dev", "reviewer2", "crashing start");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /injected runner crash/);
  assert.deepEqual(server.safety().timestamps, priorTimestamps);
  assert.deepEqual(server.safety().notices, priorNotices);
  assert.equal(server.runContexts.size, 0);
});

test("a closed run leaves no per-run output, usage, or kill flags behind", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "finishes");
  server.launchWorker("alpha-dev", "reviewer2", "killed");
  const [done, killed] = server.launched.map((entry: any) => entry.run.runId);
  server.emitOutput(done, "some output");
  server.emitOutput(killed, "more output");
  assert.equal(server.runOutput.has(done), true);
  assert.equal(server.runOutput.has(killed), true);
  server.closeRun(done, 0);
  ws.message({ type: "killRun", runId: killed });
  for (const runId of [done, killed]) {
    for (const [name, map] of Object.entries({ runOutput: server.runOutput, runUsage: server.runUsage, userKilledRuns: server.userKilledRuns, stallKillRuns: server.stallKillRuns, pendingRelaunch: server.pendingRelaunch, runContexts: server.runContexts })) {
      assert.equal((map as any).has(runId), false, `${name} still holds ${runId}`);
    }
    const replay = server.stateMessage().projects[0].tabs[0].runs.find((run: any) => run.runId === runId);
    assert.equal(replay.output, "");
    assert.equal(replay.usage, undefined);
  }
  assert.equal(server.runOutput.size, 0);
  assert.equal(server.runUsage.size, 0);
});
