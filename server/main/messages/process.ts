import type { WebSocket } from "ws";
import { writeClientPrefs, applyClientPrefUpdate, isSafeSeatId } from "../../config.ts";
import { isRunning, unconfirmedPid, releaseUnconfirmedRun } from "../../runner.ts";
import { runEvent, approveLook, advanceStep, reviewFindings, finishFix, reviewClean, selectFixer } from "../../process.ts";
import { endRunWindow } from "../activity.ts";
import { denyRunApprovals } from "../approvals.ts";
import { broadcast, sendError, stateMessage } from "../broadcast.ts";
import { listHistory, loadHistoryRun } from "../http.ts";
import { endRunRecord, revokeRunBridge } from "../launch.ts";
import { markUserKilled } from "../launch-gates.ts";
import { persistLaunchSafety } from "../launch-safety.ts";
import type { MessageHandler } from "./types.ts";
import { updateProcessState } from "../seats.ts";
import {
  blockedSeatKeys, clientPrefs, describeError, launchSafety, pendingRelaunch, runContexts, runOutput, runUsage, setClientPrefs, stallKillRuns,
  stallTrackers, tabs, unconfirmedRunIds,
} from "../state.ts";

function onApproveLook(ws: WebSocket, message: any): void {
  updateProcessState(message.tabId, approveLook); return;
}
function onAdvanceStep(ws: WebSocket, message: any): void {
  updateProcessState(message.tabId, (state) => advanceStep(state)); return;
}
function onReviewFindings(ws: WebSocket, message: any): void {
  updateProcessState(message.tabId, reviewFindings); return;
}
function onFinishFix(ws: WebSocket, message: any): void {
  updateProcessState(message.tabId, finishFix); return;
}
function onReviewClean(ws: WebSocket, message: any): void {
  updateProcessState(message.tabId, reviewClean); return;
}
function onSelectFixer(ws: WebSocket, message: any): void {
  updateProcessState(message.tabId, (state) => selectFixer(state, message.slot)); return;
}
function onUpdateClientPref(ws: WebSocket, message: any): void {
  const result = applyClientPrefUpdate(clientPrefs, message.key, message.value);
  if (!result.ok) throw new Error(result.error);
  setClientPrefs(result.prefs); writeClientPrefs(clientPrefs); broadcast(stateMessage()); return;
}
function onClearLaunchBlock(ws: WebSocket, message: any): void {
  const seatKey = message.seatKey ?? message.seatId;
  if (typeof seatKey !== "string" || !isSafeSeatId(seatKey)) throw new Error("invalid seat key");
  if (message.confirm !== "allow this seat to launch again") throw new Error("explicit launch-block confirmation is required");
  if (!blockedSeatKeys.has(seatKey)) {
    ws.send(JSON.stringify({ type: "launchBlockCleared", seatKey, cleared: false }));
    return;
  }
  blockedSeatKeys.delete(seatKey);
  try { persistLaunchSafety(); }
  catch (err) { blockedSeatKeys.add(seatKey); launchSafety.blocked = [...blockedSeatKeys]; throw err; }
  broadcast(stateMessage());
  ws.send(JSON.stringify({ type: "launchBlockCleared", seatKey, cleared: true }));
  return;
}
function onAckLaunchNotices(ws: WebSocket, message: any): void {
  const rawIds = message.type === "ackLaunchNotice" ? [message.id] : message.ids;
  if (!Array.isArray(rawIds) || rawIds.some((id: unknown) => !Number.isSafeInteger(id) || (id as number) < 1)) throw new Error("notice ids must be positive integers");
  const ids = new Set(rawIds as number[]);
  const previous = launchSafety.notices;
  launchSafety.notices = previous.filter((notice) => !ids.has(notice.id));
  try { persistLaunchSafety(); }
  catch (err) { launchSafety.notices = previous; throw err; }
  broadcast(stateMessage());
  ws.send(JSON.stringify({ type: "launchNoticesAcked", ids: [...ids] }));
  return;
}
function onHistoryList(ws: WebSocket, message: any): void {
  void listHistory(message.seatKey).then((runs) => ws.send(JSON.stringify({ type: "historyList", seatKey: message.seatKey, runs }))).catch((err) => sendError(ws, describeError(err)));
  return;
}
function onHistoryRun(ws: WebSocket, message: any): void {
  void loadHistoryRun(message.seatKey, message.timestamp, message.full === true).then((run) => ws.send(JSON.stringify({ type: "historyRun", seatKey: message.seatKey, timestamp: message.timestamp, ...run, full: message.full === true }))).catch((err) => sendError(ws, describeError(err)));
  return;
}
function onReleaseUnconfirmed(ws: WebSocket, message: any): void {
  const seatMode = message.type === "releaseUnconfirmedSeat";
  if (message.confirm !== "release may leave a process running and editing files") throw new Error("explicit release confirmation is required");
  if (!seatMode && typeof message.runId !== "string") throw new Error("runId is required");
  const rows = launchSafety.uncertain.filter((row) => seatMode ? row.seatId === message.seatId : row.runId === message.runId);
  if (!rows.length) throw new Error(seatMode ? `seat has no unconfirmed process: ${String(message.seatId)}` : "process is not tracked as unconfirmed");
  // Every row is checked before anything changes: a refusal half-way must not leave some rows released.
  for (const row of rows) if (row.runId && isRunning(row.runId) && unconfirmedPid(row.runId) === undefined) throw new Error(`process is not tracked as unconfirmed: ${row.runId}`);
  const previousUncertain = [...launchSafety.uncertain];
  const previousReleased = [...launchSafety.released];
  const previousLive = [...launchSafety.live];
  const previousBlocked = new Set(blockedSeatKeys);
  for (const row of rows) {
    blockedSeatKeys.add(row.seatId);
    if (row.runId) { const context = runContexts.get(row.runId); if (context) blockedSeatKeys.add(context.run.seatKey); }
    const identity = row.runId ?? `${row.seatId}:${row.pid}`;
    if (!launchSafety.released.some((item) => (item.runId ?? `${item.seatId}:${item.pid}`) === identity)) launchSafety.released.push(row);
  }
  launchSafety.uncertain = previousUncertain.filter((row) => !rows.includes(row));
  launchSafety.live = previousLive.filter((live) => !rows.some((row) => row.runId === live.runId));
  try { persistLaunchSafety(); }
  catch (err) {
    launchSafety.uncertain = previousUncertain;
    launchSafety.released = previousReleased;
    launchSafety.live = previousLive;
    blockedSeatKeys.clear();
    for (const key of previousBlocked) blockedSeatKeys.add(key);
    launchSafety.blocked = [...blockedSeatKeys];
    throw err;
  }
  // Saved: now the live side (the runner's entry, the run's context, the engine's run) follows.
  for (const row of rows) {
    unconfirmedRunIds.delete(row.runId ?? row.seatId);
    if (row.runId) endRunWindow(row.runId);
    if (!row.runId || !isRunning(row.runId)) continue;
    if (!releaseUnconfirmedRun(row.runId)) { broadcast({ type: "error", message: `process could not be released from the runner: ${row.runId}` }); continue; }
    const context = runContexts.get(row.runId);
    pendingRelaunch.delete(row.runId);
    stallTrackers.markKilled(row.runId);
    markUserKilled(row.runId);
    runOutput.delete(row.runId);
    runUsage.delete(row.runId);
    stallKillRuns.delete(row.runId);
    if (context) {
      const runtime = tabs.get(context.tabId);
      if (runtime) {
        runtime.state = runEvent(runtime.state, { type: "fail", runId: row.runId, endedAt: Date.now(), outcome: "released" });
        runtime.stalledRuns.delete(row.runId);
      }
      endRunRecord(row.runId, "failed", undefined, "released"); revokeRunBridge(row.runId); denyRunApprovals(row.runId);
      broadcast({ type: "runFail", tabId: context.tabId, runId: row.runId, seatKey: context.run.seatKey, outcome: "released" });
      runContexts.delete(row.runId);
    }
  }
  broadcast(stateMessage());
  ws.send(JSON.stringify({ type: "unconfirmedReleased", runId: message.runId, seatId: message.seatId })); return;
}
export function processMessages(): Array<[string, MessageHandler]> {
  return [
    ["approveLook", onApproveLook],
    ["advanceStep", onAdvanceStep],
    ["reviewFindings", onReviewFindings],
    ["finishFix", onFinishFix],
    ["reviewClean", onReviewClean],
    ["selectFixer", onSelectFixer],
    ["updateClientPref", onUpdateClientPref],
    ["setClientPref", onUpdateClientPref],
    ["clearLaunchBlock", onClearLaunchBlock],
    ["unblockSeat", onClearLaunchBlock],
    ["ackLaunchNotices", onAckLaunchNotices],
    ["ackLaunchNotice", onAckLaunchNotices],
    ["historyList", onHistoryList],
    ["historyRun", onHistoryRun],
    ["releaseUnconfirmed", onReleaseUnconfirmed],
    ["releaseUnconfirmedSeat", onReleaseUnconfirmed],
  ];
}
