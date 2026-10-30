import { readdirSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { WebSocket } from "ws";
import { writeWorkspaces } from "../config.ts";
import { isRunning, logsDir } from "../runner.ts";
import { isTabSlug, readChatRequestId } from "../chat-store.ts";
import { readGitChanges, readTabNotes } from "../changes.ts";
import type { CliId } from "../settings.ts";
import { hasPendingApproval } from "./approvals.ts";
import { broadcast, sendError, stateMessage } from "./broadcast.ts";
import { persistLaunchSafety } from "./launch-safety.ts";
import { stopLeaderSession } from "./leader-session.ts";
import {
  activeLeaderTurns, blockedSeatKeys, changeGeneration, changesByTab, chatClearGenerations, chatStore, cliRunner, describeError, expiredClearUndos,
  handoverReadTurns, launchSafety, notesByTab, pendingClearUndos, pendingHandoverReads, requestActions, requestsStore, runContexts, savingTabs,
  selectedTabId, setSelectedTabId, setWorkspaces, settingsService, tabs, workspaces, type WorkspacesShape,
} from "./state.ts";
import { clone, runtimeFor, tabLocation, watchTabFolders } from "./tabs.ts";

export function requiredRequestId(value: unknown): string {
  const requestId = readChatRequestId(value);
  if (!requestId) throw new Error("requestId is required");
  return requestId;
}
export function readCliId(value: unknown): CliId {
  if (value !== "claude" && value !== "codex" && value !== "opencode" && value !== "gemini") throw new Error("unknown CLI");
  return value;
}
export function validateFolderPath(value: unknown, label = "folder"): string {
  if (typeof value === "string" && !value.trim()) throw new Error(`${label} is required`);
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be an absolute directory path`);
  const input = value.trim();
  if (!isAbsolute(input) || input.split(/[\\/]+/).includes("..")) throw new Error(`${label} must be an absolute directory path without traversal`);
  let canonical: string;
  try { canonical = realpathSync(input); } catch { throw new Error(`${label} folder does not exist`); }
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}
export function rememberRequestAction(requestId: string, status: "running" | "done" | "failed", message: string): void {
  if (status !== "running") delete requestActions[requestId]; // Order finished history by completion, not start.
  requestActions[requestId] = { requestId, status, message };
  const ids = Object.keys(requestActions).filter((id) => requestActions[id].status !== "running");
  for (const old of ids.slice(0, Math.max(0, ids.length - 32))) delete requestActions[old];
}
export function runAsyncAction(
  ws: WebSocket,
  action: string,
  requestId: string,
  work: () => unknown | Promise<unknown>,
  failure?: { cli?: unknown; tabId?: unknown },
): void {
  rememberRequestAction(requestId, "running", "Working");
  broadcast(stateMessage());
  void Promise.resolve().then(work).then((result) => {
    rememberRequestAction(requestId, "done", "Done");
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "actionResult", action, requestId, ...(result && typeof result === "object" ? result as Record<string, unknown> : {}) }));
    } catch { /* a disconnected client cannot change the outcome of completed work */ }
    broadcast(stateMessage());
  }, (error) => {
    const message = describeError(error);
    rememberRequestAction(requestId, "failed", message);
    settingsService.recordFailure(action, failure?.cli, failure?.tabId, requestId, message);
    sendError(ws, message, { action, requestId });
    broadcast(stateMessage());
  });
}
export async function refreshTabDetails(tabId: string): Promise<void> {
  const location = tabLocation(tabId);
  if (!location) return;
  const folder = location.tab.folder;
  const generation = (changeGeneration.get(tabId) ?? 0) + 1;
  changeGeneration.set(tabId, generation);
  if (tabId === selectedTabId) settingsService.refreshProjectInstructions(folder);
  const [changes, notes] = await Promise.all([readGitChanges(folder, cliRunner), readTabNotes(folder, tabId)]);
  const current = tabLocation(tabId);
  if (!current || current.tab.folder !== folder || changeGeneration.get(tabId) !== generation) return;
  changesByTab.set(tabId, changes);
  notesByTab.set(tabId, notes);
  broadcast(stateMessage());
}
export function syncWorkspace(next: WorkspacesShape): void {
  const nextTabIds = new Set(next.projects.flatMap((project) => project.tabs.map((tab) => tab.id)));
  const removedTabs = workspaces.projects.flatMap((project) => project.tabs).filter((tab) => !nextTabIds.has(tab.id));
  writeWorkspaces(next);
  // Only after the write holds: a failed write must leave the removed tabs' saved Ask/Plan modes alone.
  try { settingsService.removePermissionModes(removedTabs.map((tab) => tab.id)); }
  catch (err) { broadcast({ type: "error", message: `could not clear saved modes for removed tabs: ${describeError(err)}` }); }
  for (const tab of removedTabs) {
    try { requestsStore.markDestinationRemoved(tab.id); }
    catch (err) { broadcast({ type: "error", message: `could not update requests for removed tab: ${describeError(err)}` }); }
    stopLeaderSession(tab.id, true);
    pendingHandoverReads.delete(tab.id);
    tabs.delete(tab.id);
    changesByTab.delete(tab.id); notesByTab.delete(tab.id); changeGeneration.set(tab.id, (changeGeneration.get(tab.id) ?? 0) + 1);
    // Nothing of a removed tab may linger in memory. Its chat file stays on disk (no transcript is deleted), and its id is never handed out again (makeTabId).
    chatStore.forget(tab.id); chatClearGenerations.delete(tab.id); expiredClearUndos.delete(tab.id); handoverReadTurns.delete(tab.id);
    const undo = pendingClearUndos.get(tab.id);
    if (undo) { clearTimeout(undo.timer); pendingClearUndos.delete(tab.id); }
  }
  if (removedTabs.length) {
    const belongsToRemoved = (seatKey: string) => removedTabs.some((tab) => seatKey.startsWith(`${tab.id}.`));
    const blockedBefore = blockedSeatKeys.size, noticesBefore = launchSafety.notices.length;
    for (const key of [...blockedSeatKeys]) if (belongsToRemoved(key)) blockedSeatKeys.delete(key);
    launchSafety.notices = launchSafety.notices.filter((notice) => !belongsToRemoved(notice.seatId));
    if (blockedSeatKeys.size !== blockedBefore || launchSafety.notices.length !== noticesBefore) {
      try { persistLaunchSafety(); } catch (err) { broadcast({ type: "error", message: `could not clear launch blocks of removed tabs: ${describeError(err)}` }); }
    }
  }
  setWorkspaces(next);
  for (const project of workspaces.projects) for (const tab of project.tabs) runtimeFor(tab);
  watchTabFolders();
  if (!tabLocation(selectedTabId)) setSelectedTabId(workspaces.projects[0]?.tabs[0]?.id ?? "");
  settingsService.refreshProjectInstructions(tabLocation(selectedTabId)?.tab.folder ?? null);
}
export function saveWorkspaceDraft(): WorkspacesShape { return clone(workspaces); }
export function tabHasActiveWork(tabId: string, allowApprovalStop = false): boolean {
  const runtime = tabs.get(tabId);
  // A process from an earlier session that was never confirmed closed may still be working in this tab's folder.
  return launchSafety.uncertain.some((row) => row.seatId.startsWith(`${tabId}.`)) || savingTabs.has(tabId) || (activeLeaderTurns.has(tabId) && !(allowApprovalStop && hasPendingApproval(tabId))) || [...runContexts.values()].some((context) => context.tabId === tabId && isRunning(context.run.runId)) || (runtime?.state.runs.some((run) => run.status === "working") ?? false);
}
// A launch counts from the moment it starts (runContexts), the engine's working run from its start event; a stall relaunch is queued (pendingRelaunch) while the old run still holds the lock, and the replacement launches only after the old run's close, so pendingRelaunch needs no check.
// A stop that was not confirmed may still be running, so its seat stays locked until the exit is confirmed or the owner releases it (a legacy row with no "." names no seat).
export function seatIsWorking(tabId: string, slot: string): boolean {
  return launchSafety.uncertain.some((row) => row.seatId === `${tabId}.${slot}`) || [...runContexts.values()].some((context) => context.tabId === tabId && context.slot === slot && isRunning(context.run.runId)) || (tabs.get(tabId)?.state.runs.some((run) => run.seatSlotId === slot && run.status === "working") ?? false);
}
function allTabIds(): Set<string> { return new Set(workspaces.projects.flatMap((project) => project.tabs.map((tab) => tab.id.toLowerCase()))); }
// An id that already has a saved chat or run history belongs to that history: handing it to a new tab would show the old chat and logs there.
function tabIdHasHistory(id: string): boolean {
  try { statSync(join(chatStore.directory, `${id}.jsonl`)); return true; } catch { /* no chat file */ }
  try { return readdirSync(logsDir).some((name) => name.toLowerCase().startsWith(`${id.toLowerCase()}.`)); } catch { return false; }
}
export function makeTabId(requested: unknown, prefix: string): string {
  const id = requested === undefined ? `${prefix}-${randomUUID().slice(0, 8)}` : requested;
  if (!isTabSlug(id) || allTabIds().has(id.toLowerCase())) throw new Error(`invalid or duplicate tab id: ${String(id)}`);
  if (requested !== undefined && tabIdHasHistory(id)) throw new Error(`tab id was used before and still has history: ${id}`);
  return id;
}
