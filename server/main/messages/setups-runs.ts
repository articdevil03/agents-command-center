import type { WebSocket } from "ws";
import { isSafeSeatId } from "../../config.ts";
import { isRunning, stopAllRunning } from "../../runner.ts";
import { isSafeRequestId } from "../../chat-store.ts";
import { stopAll as stopProcessAll } from "../../process.ts";
import { denyRunApprovals } from "../approvals.ts";
import { broadcast, stateMessage } from "../broadcast.ts";
import { launchWorker, revokeRunBridge } from "../launch.ts";
import { folderBusyMessage, gatedLeaderLaunch, markUserKilled, pendingFor, refuseIfFolderBusy } from "../launch-gates.ts";
import { persistLaunchSafety } from "../launch-safety.ts";
import { leadersAndWaitingTurns, stopLeaderSession } from "../leader-session.ts";
import type { MessageHandler } from "./types.ts";
import { applyRunKill, stopRunsForSeat } from "../runs.ts";
import { crewSetup, updateSeatPrefs } from "../seats.ts";
import { blockedSeatKeys, describeError, leaderInstances, pendingRelaunch, runContexts, stallKillRuns, stallTrackers, tabs } from "../state.ts";
import { crewDefinition, tabLocation } from "../tabs.ts";

function onUseSetup(ws: WebSocket, message: any): void {
  crewSetup.useSetup(message); return;
}
function onSetSetup(ws: WebSocket, message: any): void {
  crewSetup.setSetup(message); return;
}
function onSaveSetup(ws: WebSocket, message: any): void {
  crewSetup.saveSetup(message);
  ws.send(JSON.stringify({ type: "setupSaved", tabId: message.tabId, ...(isSafeRequestId(message.requestId) ? { requestId: message.requestId } : {}) }));
  return;
}
function onRemoveSetup(ws: WebSocket, message: any): void {
  crewSetup.removeSetup(message); return;
}
function onTestGatedLaunch(ws: WebSocket, message: any): void {
  // Test seam, fake-CLI runner only: drives the real launch_seat gate (Plan refusal, Ask approval) without a model calling the tool.
  if (process.env.CC_TEST_FAKE_CLI !== "1") throw new Error(`unknown message type: ${message.type}`);
  const instance = leaderInstances.get(message.tabId);
  if (!instance) throw new Error("no live leader for that tab");
  void gatedLeaderLaunch(message.tabId, instance, message.slot, message.brief).then((result) => ws.send(JSON.stringify({ type: "testGatedLaunchResult", tabId: message.tabId, ...result })));
  return;
}
function onTestFolderBusy(ws: WebSocket, message: any): void {
  // Test seam, fake-CLI runner only: what the next message in this tab would be warned about, read without sending anything (a file watch event can arrive late, so tests retry on this).
  if (process.env.CC_TEST_FAKE_CLI !== "1") throw new Error(`unknown message type: ${message.type}`);
  const folder = tabLocation(message.tabId)?.tab.folder;
  if (!folder) throw new Error(`unknown tab: ${String(message.tabId)}`);
  ws.send(JSON.stringify({ ...folderBusyMessage(message.tabId, "chat", undefined, pendingFor(message.tabId, folder)), type: "testFolderBusyResult" })); return;
}
function onUpdateSeat(ws: WebSocket, message: any): void {
  updateSeatPrefs(message); return;
}
function onRun(ws: WebSocket, message: any): void {
  const runLocation = tabLocation(message.tabId);
  if (runLocation && typeof message.prompt === "string" && message.prompt.trim() && crewDefinition(runLocation.tab, message.slot)?.isLeader === false && refuseIfFolderBusy(ws, message, "run", runLocation.tab.folder)) return;
  const result = launchWorker(message.tabId, message.slot, message.prompt, "client");
  if (!result.ok) throw new Error(result.error);
  ws.send(JSON.stringify({ type: "runAccepted", tabId: message.tabId, runId: result.runId })); return;
}
function onKillRun(ws: WebSocket, message: any): void {
  const result = applyRunKill(message.runId); if (!result.ok) throw new Error(result.error);
  ws.send(JSON.stringify({ type: "killAccepted", runId: message.runId })); return;
}
function onStopSeat(ws: WebSocket, message: any): void {
  stopRunsForSeat(message.tabId, message.slot); return;
}
function onKillSeat(ws: WebSocket, message: any): void {
  if (typeof message.seatId !== "string" || !isSafeSeatId(message.seatId)) throw new Error("invalid seat key");
  const separator = message.seatId.lastIndexOf(".");
  if (separator < 1 || separator === message.seatId.length - 1) throw new Error("invalid tab-scoped seat key");
  stopRunsForSeat(message.seatId.slice(0, separator), message.seatId.slice(separator + 1));
  return;
}
function onStopAll(ws: WebSocket, message: any): void {
  const now = Date.now();
  for (const runtime of tabs.values()) {
    const closing = new Set(runtime.state.runs.filter((run) => isRunning(run.id)).map((run) => run.id));
    runtime.state = stopProcessAll(runtime.state, now, closing);
  }
  for (const tabId of leadersAndWaitingTurns()) stopLeaderSession(tabId);
  for (const [runId, context] of runContexts) {
    markUserKilled(runId);
    stallTrackers.markKilled(runId);
    pendingRelaunch.delete(runId);
    stallKillRuns.delete(runId);
    revokeRunBridge(runId); denyRunApprovals(runId);
    blockedSeatKeys.add(context.run.seatKey);
  }
  if (runContexts.size) {
    try { persistLaunchSafety(); } catch (err) { broadcast({ type: "error", message: `could not persist stop block: ${describeError(err)}` }); }
  }
  stopAllRunning();
  broadcast(stateMessage());
  ws.send(JSON.stringify({ type: "stopAllAccepted" })); return;
}
export function setupMessages(): Array<[string, MessageHandler]> {
  return [
    ["useSetup", onUseSetup],
    ["setSetup", onSetSetup],
    ["saveSetup", onSaveSetup],
    ["removeSetup", onRemoveSetup],
    ["testGatedLaunch", onTestGatedLaunch],
    ["testFolderBusy", onTestFolderBusy],
    ["updateSeat", onUpdateSeat],
    ["run", onRun],
    ["killRun", onKillRun],
    ["stopSeat", onStopSeat],
    ["killSeat", onKillSeat],
    ["stopAll", onStopAll],
  ];
}
