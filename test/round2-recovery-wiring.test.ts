import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as stall from "../server/stall.ts";
import { tempRoot } from "./temp-root.ts";
import { config } from "./round2-setup.ts";
import { loadServer, connect, lastState } from "./round2-helpers.ts";
import { tabState } from "./round2-gate-helpers.ts";

test("every recovery alias requires its confirmation phrase and leaves state unchanged when refused", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const server = await loadServer({ skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "will not die");
  const run = server.launched[0].run;
  ws.message({ type: "killRun", runId: run.runId });
  t.mock.timers.tick(5_000);
  assert.equal(server.safety().uncertain.length, 1);
  const before = JSON.stringify(server.safety());
  for (const message of [
    { type: "releaseUnconfirmed", runId: run.runId },
    { type: "releaseUnconfirmed", runId: run.runId, confirm: "yes" },
    { type: "releaseUnconfirmed", runId: run.runId, confirm: "release may leave a process running and editing files " },
    { type: "releaseUnconfirmedSeat", seatId: run.seatKey },
  ]) {
    ws.message(message);
    assert.match(ws.messages.at(-1).message, /explicit release confirmation/, JSON.stringify(message));
    assert.equal(JSON.stringify(server.safety()), before);
    assert.equal(server.isRunning(run.runId), true);
    assert.equal(server.runContexts.has(run.runId), true);
  }
  for (const message of [
    { type: "clearLaunchBlock", seatKey: run.seatKey },
    { type: "clearLaunchBlock", seatId: run.seatKey, confirm: "ok" },
    { type: "clearLaunchBlock", seatKey: run.seatKey, confirm: "allow this seat to launch again " },
    { type: "unblockSeat", seatKey: run.seatKey },
  ]) {
    ws.message(message);
    assert.match(ws.messages.at(-1).message, /explicit launch-block confirmation/, JSON.stringify(message));
    assert.equal(JSON.stringify(server.safety()), before);
  }
  ws.message({ type: "releaseUnconfirmed", runId: run.runId, confirm: "release may leave a process running and editing files" });
  assert.equal(server.isRunning(run.runId), false);
  ws.message({ type: "clearLaunchBlock", seatKey: run.seatKey, confirm: "allow this seat to launch again" });
  assert.equal(server.safety().blocked.includes(run.seatKey), false);
  server.closeRun(run.runId);
});

test("unconfirmed kill grace and recovery use the real runner, and refusals require both phrases", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const server = await loadServer({ relaunchable: true, skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "unconfirmed stall");
  const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.pendingRelaunch.has(entry.run.runId), true);
  t.mock.timers.tick(4_999);
  assert.equal(server.safety().uncertain.length, 0);
  t.mock.timers.tick(1);
  assert.equal(server.pendingRelaunch.has(entry.run.runId), false);
  assert.equal(server.stallTrackers.isKilled(entry.run.runId), true);
  assert.equal(server.safety().uncertain.length, 1);
  assert.equal(server.isRunning(entry.run.runId), true);
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey });
  assert.match(ws.messages.at(-1).message, /explicit release confirmation/);
  ws.message({ type: "unblockSeat", seatId: entry.run.seatKey });
  assert.match(ws.messages.at(-1).message, /explicit launch-block confirmation/);
  assert.equal(server.safety().uncertain.length, 1);
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.equal(server.isRunning(entry.run.runId), false);
  assert.equal(server.tabs.get("alpha-dev").state.runs.find((run: any) => run.id === entry.run.runId).status, "failed");
  assert.equal(server.runContexts.has(entry.run.runId), false);
  assert.equal(server.pendingRelaunch.has(entry.run.runId), false);
  assert.equal(server.stallTrackers.isKilled(entry.run.runId), true);
  assert.ok(server.safety().blocked.includes(entry.run.seatKey));
  server.closeRun(entry.run.runId);
  assert.equal(server.safety().released.length, 0);
  assert.equal(server.launched.length, 1);
});

test("release refuses when the real runner does not own an unconfirmed kill", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "still running");
  const run = server.launched[0].run;
  const row = { seatId: run.seatKey, pid: server.runnerProcesses.get(run.runId).pid, runId: run.runId };
  server.launchSafety.uncertain.push(row);
  ws.message({ type: "releaseUnconfirmedSeat", seatId: run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.match(ws.messages.at(-1).message, /process is not tracked as unconfirmed/);
  assert.deepEqual(server.launchSafety.uncertain, [row]);
  assert.deepEqual(server.launchSafety.released, []);
  assert.equal(server.isRunning(run.runId), true);
  assert.equal(server.runContexts.has(run.runId), true);
  assert.equal(server.tabs.get("alpha-dev").state.runs.find((entry: any) => entry.id === run.runId).status, "working");
  server.closeRun(run.runId);
});

test("real stall timer never kills or relaunches a writable slot", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "edit carefully" });
  const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.launched.length, 1);
  assert.equal(server.kills.length, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === entry.run.runId && message.action === "escalate"));
  assert.equal(server.stateMessage().projects[0].tabs[0].crew.find((seat: any) => seat.slot === "coder").status, "stalled");
});

test("a manual Kill that arrives during a stall kill wins over the queued relaunch", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "review this" });
  const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  ws.message({ type: "killRun", runId: first.run.runId });
  server.closeRun(first.run.runId);
  assert.equal(server.launched.length, 1, "a user Kill during the automatic kill must suppress the relaunch");
});

test("any real output at the runner callback disqualifies a stall relaunch", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "review this" });
  const entry = server.launched[0];
  server.emitOutput(entry.run.runId, "progress");
  server.stallTrackers.trackers.get(entry.run.runId).lastGrowthAt = Date.now() - stall.STALL_THRESHOLD_MS - 1;
  server.tick();
  assert.equal(server.launched.length, 1);
  assert.equal(server.kills.length, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === entry.run.runId && message.action === "escalate"));
});

test("tab process state transitions and client message validation are wired at the WebSocket call site", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "hello" });
  for (const raw of ["null", "[]", "3", '"text"', "true", "{}", '{"type":3}', "{"]) {
    assert.doesNotThrow(() => ws.message(raw));
    assert.equal(ws.messages.at(-1).type, "error");
  }
  for (let i = 0; i < 8 && lastState(ws).projects[0].tabs[0].processState.approval.state !== "pending"; i++) ws.message({ type: "advanceStep", tabId: "alpha-dev" });
  ws.message({ type: "approveLook", tabId: "alpha-dev" });
  assert.equal(lastState(ws).projects[0].tabs[0].processState.approval.state, "approved");
  ws.message({ type: "reviewFindings", tabId: "alpha-dev" });
  assert.equal(lastState(ws).projects[0].tabs[0].processState.phase, "fix");
  ws.message({ type: "selectFixer", tabId: "alpha-marketing", slot: "image" });
  assert.equal(lastState(ws).projects[0].tabs.find((tab: any) => tab.id === "alpha-marketing").processState.selectedFixer, "image");
});

test("reviewClean is wired at the WebSocket call site: a clean review closes the round once the look is approved, and before that nothing happens", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  const processOf = () => lastState(ws).projects[0].tabs[0].processState;
  ws.message({ type: "reviewClean", tabId: "alpha-dev" });
  assert.deepEqual([processOf().phase === "clean", processOf().roundHistory.length], [false, 0], "control: before the review stage the message changes nothing");
  for (let i = 0; i < 8 && processOf().approval.state !== "pending"; i++) ws.message({ type: "advanceStep", tabId: "alpha-dev" });
  ws.message({ type: "approveLook", tabId: "alpha-dev" });
  assert.equal(processOf().phase, "review");
  ws.message({ type: "reviewClean", tabId: "alpha-dev" });
  assert.equal(processOf().phase, "clean");
  assert.deepEqual(processOf().roundHistory.map((round: any) => round.outcome), ["clean"]);
  assert.equal(lastState(ws).projects[1].tabs[0].processState.roundHistory.length, 0, "another tab's process is untouched");
  ws.message({ type: "reviewClean", tabId: "no-such-tab" });
  assert.equal(ws.messages.at(-1).type, "error");
  assert.match(ws.messages.at(-1).message, /unknown tab/);
});

test("renameTab is wired at the WebSocket call site: it trims the name and saves it, and a blank, missing or non-string name or an unknown tab is refused with nothing changed", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  const before = tabState(ws, "alpha-dev").name;
  ws.message({ type: "renameTab", tabId: "alpha-dev", name: "  Fresh name  " });
  assert.equal(tabState(ws, "alpha-dev").name, "Fresh name");
  assert.equal(server.getWorkspaces().projects[0].tabs[0].name, "Fresh name", "saved to the workspace");
  assert.equal(tabState(ws, "alpha-design").name, "Design", "another tab keeps its name");
  for (const bad of [{ tabId: "alpha-dev", name: "   " }, { tabId: "alpha-dev", name: 5 }, { tabId: "alpha-dev" }, { tabId: "no-such-tab", name: "Anything" }]) {
    ws.message({ type: "renameTab", ...bad });
    assert.equal(ws.messages.at(-1).type, "error", JSON.stringify(bad));
    assert.match(ws.messages.at(-1).message, /invalid tab or name/);
  }
  assert.equal(tabState(ws, "alpha-dev").name, "Fresh name", "every refusal left the name alone");
  // A save that fails keeps the old name, on the page and in the file.
  let fail = false;
  const failing = await loadServer({ skipHealth: true, failWorkspaceWrite: () => fail }), failingWs = connect(failing);
  failingWs.message({ type: "hello" });
  fail = true;
  failingWs.message({ type: "renameTab", tabId: "alpha-dev", name: "Never saved" });
  assert.equal(failingWs.messages.at(-1).type, "error");
  assert.match(failingWs.messages.at(-1).message, /workspace disk failed/);
  assert.equal(tabState(failingWs, "alpha-dev").name, before);
  assert.equal(failing.getWorkspaces().projects[0].tabs[0].name, before);
});

test("ackLaunchNotices is wired at the WebSocket call site: it removes exactly the listed notices, saves that, answers with the ids, and a bad list or a failed save removes nothing", async () => {
  let fail = false;
  const safetyPath = path.join(tempRoot(), "launch-safety.json"), server = await loadServer({ skipHealth: true, safetyPath, failSafety: () => fail }), ws = connect(server);
  for (const brief of ["notice one", "notice two", "notice three"]) assert.equal(server.leaderLaunch("alpha-dev", "coder", brief).ok, true);
  ws.message({ type: "hello" });
  const ids = lastState(ws).launchSafety.notices.map((notice: any) => notice.id);
  assert.equal(ids.length, 3, "control: three notices are waiting");
  const sent = (type: string) => ws.messages.filter((message: any) => message.type === type);
  for (const bad of [{ ids: [0] }, { ids: [1.5] }, { ids: ["1"] }, { ids: [ids[0], -2] }, { ids: "all" }, {}]) {
    ws.message({ type: "ackLaunchNotices", ...bad });
    assert.equal(ws.messages.at(-1).type, "error", JSON.stringify(bad));
    assert.match(ws.messages.at(-1).message, /notice ids must be positive integers/);
  }
  assert.equal(server.launchSafety.notices.length, 3, "a bad list removed nothing");
  fail = true;
  ws.message({ type: "ackLaunchNotices", ids: [ids[0]] });
  assert.equal(ws.messages.at(-1).type, "error");
  assert.match(ws.messages.at(-1).message, /safety disk failed/);
  assert.equal(server.launchSafety.notices.length, 3, "a failed save puts the notices back");
  assert.equal(sent("launchNoticesAcked").length, 0, "and nothing was reported as acknowledged");
  fail = false;
  ws.message({ type: "ackLaunchNotices", ids: [ids[0], ids[1], 9999] });
  assert.deepEqual(sent("launchNoticesAcked").at(-1).ids, [ids[0], ids[1], 9999], "the reply carries the ids it was given");
  assert.deepEqual(config.readLaunchSafety(safetyPath).notices.map((notice: any) => notice.id), [ids[2]], "only the unlisted notice is left on disk");
  assert.deepEqual(lastState(ws).launchSafety.notices.map((notice: any) => notice.id), [ids[2]], "and in the state the page gets");
  ws.message({ type: "ackLaunchNotices", ids: [] });
  assert.deepEqual(config.readLaunchSafety(safetyPath).notices.map((notice: any) => notice.id), [ids[2]], "an empty list removes nothing");
});

test("uncertain kill PIDs stay visible in server state and release requires the real run id", async () => {
  const server = await loadServer({ skipHealth: true });
  server.launchSafety.uncertain.push({ seatId: "old-seat", pid: 777 });
  const ws = connect(server);
  ws.message({ type: "hello" });
  assert.deepEqual(lastState(ws).launchSafety.uncertain, [{ seatId: "old-seat", pid: 777 }]);
  ws.message({ type: "releaseUnconfirmed", runId: "unknown-run", confirm: "release may leave a process running and editing files" });
  assert.match(ws.messages.at(-1).message, /not tracked as unconfirmed/);
});

test("an advisor chosen on a seat validates model ids, and only a Claude seat can have one", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  const leader = () => lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader");
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", advisor: "nope" });
  assert.match(ws.messages.at(-1).message, /invalid advisor/);
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", advisor: "claude-opus-5-5[1m]" });
  assert.equal(leader().advisor, "claude-opus-5-5[1m]");
  assert.equal("advisor" in lastState(ws).projects[0].tabs[0], false, "the advisor is a seat's now, not the tab's");
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", advisor: "claude-opus-5-5[1m]" });
  assert.match(ws.messages.at(-1).message, /cannot have an advisor/, "the classic coder is on Codex");
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", advisor: null });
  assert.equal(leader().advisor, undefined);
});
