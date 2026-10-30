import type { WebSocket } from "ws";
import { originAnswerable } from "../approvals.ts";
import { broadcast, sendState, stateMessage } from "../broadcast.ts";
import type { MessageHandler } from "./types.ts";
import { chatStore, leaders, pendingApprovals, selectedTabId, setSelectedTabId, settingsService } from "../state.ts";
import { tabLocation } from "../tabs.ts";
import { refreshTabDetails, rememberRequestAction, requiredRequestId } from "../workspace.ts";

function onAnswerApproval(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  const item = pendingApprovals.get(message.approvalId);
  const leader = leaders.get(message.tabId);
  // The leader's approval needs that very leader alive; a seat's needs its run still going.
  const answerable = item !== undefined && (item.origin.kind === "seat" || Boolean(leader && !leader.isDead())) && originAnswerable(message.tabId, item.origin);
  if (!item || item.tabId !== message.tabId || !tabLocation(message.tabId) || !answerable) throw new Error("This approval is no longer available");
  if (typeof message.allow !== "boolean") throw new Error("allow must be a boolean");
  item.settle(message.allow);
  rememberRequestAction(requestId, "done", "Done");
  ws.send(JSON.stringify({ type: "actionResult", action: "answerApproval", requestId, tabId: message.tabId, approvalId: message.approvalId }));
  broadcast(stateMessage()); return;
}
function onHello(ws: WebSocket, message: any): void {
  const recovery = settingsService.takeRecoveryNotice();
  if (recovery) broadcast({ type: "error", message: recovery });
  sendState(ws);
  ws.send(JSON.stringify({ type: "chatHistory", tabId: selectedTabId, ...chatStore.snapshotOrEmpty(selectedTabId) }));
  return;
}
function onSelectTab(ws: WebSocket, message: any): void {
  if (!tabLocation(message.tabId)) throw new Error(`unknown tab: ${String(message.tabId)}`);
  setSelectedTabId(message.tabId);
  settingsService.refreshProjectInstructions(tabLocation(selectedTabId)!.tab.folder);
  ws.send(JSON.stringify({ type: "chatHistory", tabId: selectedTabId, ...chatStore.snapshotOrEmpty(selectedTabId) }));
  broadcast(stateMessage());
  void refreshTabDetails(selectedTabId);
  return;
}
export function approvalMessages(): Array<[string, MessageHandler]> {
  return [
    ["answerApproval", onAnswerApproval],
    ["hello", onHello],
    ["selectTab", onSelectTab],
  ];
}
