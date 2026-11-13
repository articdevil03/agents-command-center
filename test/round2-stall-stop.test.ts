import test from "node:test";
import assert from "node:assert/strict";
import * as stall from "../server/stall.ts";
import { tempWorkspaceFolders, loadServer, loadFixed, connect, lastState, tick, waitFor, flushMicrotasks, startHelper, endRun } from "./round2-helpers.ts";

const refusal = (promise: Promise<unknown>) => promise.then(() => "launched", (error: Error) => error.message);
const stalledFor = (server: any, runId: string) => server.stallTrackers.startRun(runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
const escalated = (ws: any, runId: string) => ws.messages.some((message: any) => message.type === "runStalled" && message.runId === runId && message.action === "escalate");
const treeEnded = (server: any, what: string) => waitFor(() => server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId === null, what);

test("run output replay stays under 200 KB and trims only at UTF-8 boundaries through the real callback", async () => {
  const server = await loadFixed({ skipHealth: true });
  connect(server);
  await startHelper(server, "alpha-dev", "helper", "inspect output");
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
  await endRun(server, entry.run.runId);
  await startHelper(server, "alpha-dev", "helper", "short output");
  const short = server.launched[1];
  server.emitOutput(short.run.runId, "abc");
  server.emitOutput(short.run.runId, "界😀");
  assert.equal(server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === short.run.runId).output, "abc界😀");
  await endRun(server, short.run.runId);
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

test("a stalled fixed run is never stopped or restarted by the timer: it escalates once and keeps running", async () => {
  const server = await loadFixed({ skipHealth: true });
  const ws = connect(server);
  await startHelper(server, "alpha-dev", "helper", "review this");
  const first = server.launched[0];
  assert.equal(first.run.cli, "codex"); assert.equal(first.run.canWrite, false, "control: a read-only Codex position");
  stalledFor(server, first.run.runId);
  server.tick();
  server.tick(); server.tick();
  assert.equal(server.launched.length, 1, "no second launch");
  assert.equal(server.kills.length, 0, "the timer never stops a run because its output is flat");
  assert.equal(server.isRunning(first.run.runId), true, "the flat run is still running after several ticks");
  assert.ok(escalated(ws, first.run.runId), "the stall is escalated to the user");
  assert.deepEqual(ws.messages.filter((message: any) => message.type === "runStalled").map((message: any) => message.action), ["escalate"], "one stalled notice, only ever an escalation");
  assert.equal(ws.messages.some((message: any) => message.type === "runStop" || message.type === "runFail"), false, "no run end was broadcast by the timer");
  await endRun(server, first.run.runId);
});

test("Stop seat stops a fixed run's position, blocks its next launch and settles the run only on its close", async () => {
  const server = await loadFixed({ skipHealth: true, deferKill: true }), ws = connect(server);
  await startHelper(server, "alpha-dev", "helper", "stalling run");
  const stalled = server.launched[0];
  stalledFor(server, stalled.run.runId);
  server.tick();
  ws.message({ type: "stopSeat", tabId: "alpha-dev", slot: "helper" });
  assert.ok(server.safety().blocked.includes(stalled.run.seatKey));
  assert.equal(server.isRunning(stalled.run.runId), true, "a live run is not settled before its close");
  server.closeRun(stalled.run.runId);
  await treeEnded(server, "the stopped run's process tree to be confirmed ended");
  assert.equal(server.stateMessage().projects[0].tabs[0].runs.find((run: any) => run.runId === stalled.run.runId).status, "stopped");
  assert.equal(server.launched.length, 1);
  assert.match(await refusal(startHelper(server, "alpha-dev", "helper", "start anyway")), /launch blocked/);
});

test("Stop all stops the leader and the worker, blocks the worker's seat and settles it only on its close", async () => {
  const server = await loadFixed({ skipHealth: true, deferKill: true, hangLeader: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start leader" });
  await startHelper(server, "alpha-dev", "helper", "stalling run");
  const stalled = server.launched[0];
  stalledFor(server, stalled.run.runId);
  server.tick();
  ws.message({ type: "stopAll" });
  assert.ok(ws.messages.some((message: any) => message.type === "stopAllAccepted"), JSON.stringify(ws.messages));
  assert.equal(server.isRunning(stalled.run.runId), true, "a live run is not settled before its close");
  assert.deepEqual(server.safety().blocked, [stalled.run.seatKey]);
  assert.ok(server.leaderHandles[0].stopCalls > 0);
  server.closeRun(stalled.run.runId);
  await treeEnded(server, "the stopped run's process tree to be confirmed ended");
  assert.equal(server.stateMessage().projects[0].tabs[0].runs.find((run: any) => run.runId === stalled.run.runId).status, "stopped");
  assert.equal(server.launched.length, 1);
});

test("Stop seat on an idle worker position still blocks its next launch", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "stopSeat", tabId: "alpha-dev", slot: "helper" });
  assert.ok(server.safety().blocked.includes("alpha-dev.helper"));
  assert.match(await refusal(startHelper(server, "alpha-dev", "helper", "start anyway")), /launch blocked/);
  assert.equal(server.launched.length, 0);
  assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "the blocked launch left no reservation");
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
  const server = await loadFixed({ skipHealth: true, hangSave: true, writeHandover: true, workspaces: tempWorkspaceFolders() }), ws = connect(server);
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
  assert.ok(server.chats.some((entry: any) => entry.tabId === "beta-dev" && entry.text.includes("Save a concise handover")), "the Save queue is free again");
  ws.message({ type: "clear", tabId: "beta-dev" });
  await tick(10);
});


test("a thrown runner start rolls back its launch-budget reservation, pending notice and reservation", async () => {
  const server = await loadFixed({ skipHealth: true });
  const priorTimestamps = [...server.safety().timestamps], priorNotices = [...server.safety().notices];
  server.createTabLeader("alpha-dev");
  server.throwRun();
  assert.match(await refusal(startHelper(server, "alpha-dev", "helper", "crashing start")), /injected runner crash/);
  assert.deepEqual(server.safety().timestamps, priorTimestamps);
  assert.deepEqual(server.safety().notices, priorNotices);
  assert.equal(server.runContexts.size, 0);
  assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "the crashed start left no reservation");
});

test("a closed run leaves no per-run output, usage, or kill flags behind", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  await startHelper(server, "alpha-dev", "helper", "finishes");
  const done = server.launched[0].run.runId;
  server.emitOutput(done, "some output");
  assert.equal(server.runOutput.has(done), true);
  await endRun(server, done, "alpha-dev", 0);
  await startHelper(server, "alpha-dev", "helper", "killed");
  const killed = server.launched[1].run.runId;
  server.emitOutput(killed, "more output");
  assert.equal(server.runOutput.has(killed), true);
  ws.message({ type: "killRun", runId: killed });
  await treeEnded(server, "the killed run's process tree to be confirmed ended");
  for (const runId of [done, killed]) {
    for (const [name, map] of Object.entries({ runOutput: server.runOutput, runUsage: server.runUsage, runContexts: server.runContexts })) {
      assert.equal((map as any).has(runId), false, `${name} still holds ${runId}`);
    }
    const replay = server.stateMessage().projects[0].tabs[0].runs.find((run: any) => run.runId === runId);
    assert.equal(replay.output, "");
    assert.equal(replay.usage, undefined);
  }
  assert.equal(server.runOutput.size, 0);
  assert.equal(server.runUsage.size, 0);
});
