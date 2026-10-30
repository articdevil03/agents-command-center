import { stat } from "node:fs/promises";
import type { WebSocket } from "ws";
import { handoverPath } from "../../changes.ts";
import { approvalWaitMessage, hasPendingApproval } from "../approvals.ts";
import { broadcast, sendError, stateMessage } from "../broadcast.ts";
import { stopLeaderSession } from "../leader-session.ts";
import {
  acceptChat, recordLeaderSession, sendLeaderTurn, serializeChatOperation, steerLeaderTurn, waitForLeaderTurnToFinish, withChatOperationTimeout,
} from "../leader-turn.ts";
import type { MessageHandler } from "./types.ts";
import {
  CLEAR_UNDO_MS, activeLeaderTurns, chatClearGenerations, chatStore, describeError, expiredClearUndos, handoverReadTurns, leaders, pendingClearUndos,
  pendingHandoverReads, reportedChatProblems, savingTabs,
} from "../state.ts";
import { tabLocation } from "../tabs.ts";
import { refreshTabDetails } from "../workspace.ts";

function onChat(ws: WebSocket, message: any): void {
  acceptChat(ws, message); return;
}
function onSteer(ws: WebSocket, message: any): void {
  steerLeaderTurn(ws, message); return;
}
function onSave(ws: WebSocket, message: any): void {
  const tabId = message.tabId;
  const saveError = (text: string) => sendError(ws, text, { action: "save", tabId });
  if (!tabLocation(tabId)) { saveError(`unknown tab: ${String(tabId)}`); return; }
  if (hasPendingApproval(tabId)) { saveError(approvalWaitMessage(tabId)); return; }
  savingTabs.set(tabId, (savingTabs.get(tabId) ?? 0) + 1);
  broadcast(stateMessage());
  void serializeChatOperation(tabId, async () => {
    try {
      await waitForLeaderTurnToFinish(tabId);
      const leader = leaders.get(tabId);
      if (!leader || leader.isDead()) { saveError("this tab has no live leader session to save yet"); return; }
      const location = tabLocation(tabId);
      if (!location) { saveError("tab was removed before Save started"); return; }
      // A leader that has not read RESUME.md yet knows nothing: saving now would overwrite the good handover.
      if (pendingHandoverReads.has(tabId)) { saveError("send a message first so the leader reads the saved handover; saving now would overwrite it"); return; }
      const ownHandover = handoverPath(location.tab.folder, tabId);
      const saveStartedAt = Date.now();
      const clearGeneration = chatClearGenerations.get(tabId) ?? 0;
      // True only when the handover file is newer than Save's start and no Clear or Undo swapped the transcript meanwhile.
      const startFolder = location.tab.folder;
      // A late confirm (after the Save timeout) must not mark a tab saved once its folder changed, its leader was replaced, or it is waiting to re-read the handover.
      const confirmSaved = async (): Promise<boolean> => {
        const savedRevision = chatStore.snapshot(tabId).revision;
        let handover;
        try { handover = await stat(ownHandover); } catch { return false; }
        if (!handover.isFile() || handover.mtimeMs <= saveStartedAt) return false;
        if ((chatClearGenerations.get(tabId) ?? 0) !== clearGeneration) return false;
        if (tabLocation(tabId)?.tab.folder !== startFolder || leaders.get(tabId) !== leader || pendingHandoverReads.has(tabId)) return false;
        // The history entry exists before "saved" goes out: the page asks for the list on "saved" and must already see it.
        try { await recordLeaderSession(tabId, ownHandover); }
        catch (err) { broadcast({ type: "error", message: `could not record this saved session in the leader's history: ${describeError(err)}` }); }
        // A Clear during the history write replaced the chat: that history entry stays (it records this Save), but the cleared chat is not "saved".
        if ((chatClearGenerations.get(tabId) ?? 0) !== clearGeneration) return false;
        const saved = chatStore.markSaved(tabId, savedRevision);
        broadcast({ type: "saved", tabId, revision: saved.revision, savedRevision: saved.savedRevision });
        broadcast(stateMessage());
        void refreshTabDetails(tabId);
        return true;
      };
      const turn = sendLeaderTurn(tabId, `Save a concise handover of this tab's current work to ${ownHandover}. Include current decisions, open work, and exact files changed. Create the folder if it does not exist.`);
      let ok: boolean;
      try { ok = await withChatOperationTimeout(turn, "leader Save timed out", tabId); }
      catch (err) {
        // The turn keeps running after the timeout: if it still finishes OK and wrote the handover, mark it saved ("saved" clears the failed card).
        void turn.then((late) => late ? confirmSaved() : false).catch(() => {});
        throw err;
      }
      if (!ok || !(await confirmSaved().catch(() => false))) saveError("leader could not save the handover");
    } finally {
      const pendingSaves = (savingTabs.get(tabId) ?? 1) - 1;
      if (pendingSaves > 0) savingTabs.set(tabId, pendingSaves);
      else savingTabs.delete(tabId);
      broadcast(stateMessage());
    }
  }).catch((err) => saveError(`save failed: ${describeError(err)}`));
  return;
}
function onClear(ws: WebSocket, message: any): void {
  const tabId = message.tabId;
  if (!tabLocation(tabId)) throw new Error(`unknown tab: ${String(tabId)}`);
  // A transcript that cannot be read has no good snapshot to restore, so that Clear offers no Undo.
  const damaged = chatStore.setAsideIfUnreadable(tabId);
  reportedChatProblems.delete(tabId);
  const previous = damaged ? undefined : chatStore.snapshot(tabId);
  stopLeaderSession(tabId, true);
  const snapshot = chatStore.clear(tabId);
  chatClearGenerations.set(tabId, (chatClearGenerations.get(tabId) ?? 0) + 1);
  const previousUndo = pendingClearUndos.get(tabId);
  if (previousUndo) clearTimeout(previousUndo.timer);
  expiredClearUndos.delete(tabId);
  if (previous) {
    const undo = { snapshot: previous, expiresAt: Date.now() + CLEAR_UNDO_MS, timer: undefined as unknown as ReturnType<typeof setTimeout> };
    undo.timer = setTimeout(() => {
      if (pendingClearUndos.get(tabId) === undo) {
        pendingClearUndos.delete(tabId);
        expiredClearUndos.add(tabId);
      }
    }, CLEAR_UNDO_MS);
    undo.timer.unref?.();
    pendingClearUndos.set(tabId, undo);
  } else pendingClearUndos.delete(tabId);
  pendingHandoverReads.add(tabId);
  broadcast({ type: "chatCleared", tabId, revision: snapshot.revision, savedRevision: snapshot.savedRevision, ...(damaged ? { noUndo: true } : {}) });
  broadcast(stateMessage());
  return;
}
function onUndoClear(ws: WebSocket, message: any): void {
  const tabId = message.tabId;
  if (!tabLocation(tabId)) throw new Error(`unknown tab: ${String(tabId)}`);
  const undo = pendingClearUndos.get(tabId);
  if (!undo || Date.now() >= undo.expiresAt) {
    if (undo) { clearTimeout(undo.timer); pendingClearUndos.delete(tabId); expiredClearUndos.add(tabId); }
    const reason = expiredClearUndos.delete(tabId) ? "expired" : "unavailable";
    ws.send(JSON.stringify({ type: "chatUndoRejected", tabId, reason }));
    return;
  }
  // The leader is answering a new message or a Save is writing: restoring now would cut it off. The undo stays until it expires.
  if (activeLeaderTurns.has(tabId) || savingTabs.has(tabId)) { ws.send(JSON.stringify({ type: "chatUndoRejected", tabId, reason: "busy" })); return; }
  stopLeaderSession(tabId, true);
  pendingHandoverReads.add(tabId);
  handoverReadTurns.delete(tabId);
  const restored = chatStore.restore(tabId, undo.snapshot);
  chatClearGenerations.set(tabId, (chatClearGenerations.get(tabId) ?? 0) + 1);
  clearTimeout(undo.timer);
  pendingClearUndos.delete(tabId);
  expiredClearUndos.delete(tabId);
  broadcast({ type: "chatRestored", tabId, ...restored });
  broadcast(stateMessage());
  return;
}
export function chatMessages(): Array<[string, MessageHandler]> {
  return [
    ["chat", onChat],
    ["steer", onSteer],
    ["save", onSave],
    ["clear", onClear],
    ["undoClear", onUndoClear],
  ];
}
