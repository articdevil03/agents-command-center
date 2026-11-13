import type { WebSocket } from "ws";
import { chatMessageEvent, isSafeRequestId } from "../chat-store.ts";
import { relatedFolders, type Outside } from "../folder-activity.ts";
import { broadcast } from "./broadcast.ts";
import { chatStore, folderActivity, runContexts } from "./state.ts";
import { crewDefinition, tabLocation } from "./tabs.ts";

// Per tab, within the window: a planner that runs the process starts several seats, and no other tab uses this tab's launches up.
export const LEADER_LAUNCH_LIMIT = 8;
export const LAUNCH_WINDOW_MS = 5 * 60 * 1000;
export const MAX_LAUNCH_NOTICES = 50;
export const NOTICE_BRIEF_MAX = 4000;
// Another agent working in this folder: the person decides when they are at the keyboard (their message or Run is held until they answer);
// a leader-started run has nobody to ask, so it launches and says so once per outside session per 10 minutes.
export function folderBusyMessage(tabId: string, action: "chat" | "run", requestId: string | undefined, items: Outside[]): Record<string, unknown> {
  const now = Date.now();
  return { type: "folderBusy", action, tabId, ...(requestId ? { requestId } : {}), items: items.map((item) => { const agoMs = now - item.lastActiveAt; return { tool: item.tool, agoSeconds: Math.max(0, Math.round(agoMs / 1000)), ...(item.writer ? { writer: item.writer } : {}) }; }) };
}
// Another tab writing in a related folder: a writing seat. Reviewers and the asking tab never count.
function otherTabWriters(tabId: string, folder: string): Outside[] {
  const writers: Outside[] = [], now = Date.now();
  for (const context of runContexts.values()) {
    if (context.tabId === tabId || !context.run.canWrite || !relatedFolders(folder, context.run.folder)) continue;
    const other = tabLocation(context.tabId), roleLabel = other && crewDefinition(other.tab, context.slot)?.role;
    if (other && roleLabel) writers.push({ tool: null, sessionKey: context.run.runId, lastActiveAt: now, writer: { seatName: context.run.name, roleLabel, tabName: other.tab.name } });
  }
  return writers;
}
export const pendingFor = (tabId: string, folder: string): Outside[] => folderActivity.pending(tabId, folder, otherTabWriters(tabId, folder));
export function refuseIfFolderBusy(ws: WebSocket, message: any, action: "chat" | "run", folder: string): boolean {
  if (message.confirmBusy === true) folderActivity.snoozeShown(message.tabId);
  const busy = pendingFor(message.tabId, folder);
  if (!busy.length) return false;
  folderActivity.remember(message.tabId, busy);
  ws.send(JSON.stringify(folderBusyMessage(message.tabId, action, isSafeRequestId(message.requestId) ? message.requestId : undefined, busy)));
  return true;
}
// Returns the heads-up text so the launch notice can keep it; "" when there is nothing to say. It is also a quiet line in the tab's chat (saved with it, never told to the leader); no pop-up, the line says it.
export function announceFolderBusy(tabId: string): string {
  try {
    const folder = tabLocation(tabId)?.tab.folder;
    const fresh = folder ? folderActivity.toAnnounce(tabId, folder, otherTabWriters(tabId, folder)) : [];
    if (!fresh.length) return "";
    const what = fresh.map((item) => item.writer ? `${item.writer.seatName} (${item.writer.roleLabel}) in your ${item.writer.tabName} tab is writing code in this folder right now`
      : item.tool ? `${"AEIOU".includes(item.tool[0]) ? "an" : "a"} ${item.tool} session outside Command Center is active in this folder` : "something outside Command Center changed files in this folder");
    const message = `Heads up: ${what.join("; ")}.`;
    try { broadcast(chatMessageEvent(chatStore.appendMessage(tabId, "notice", message))); } catch { /* an unreadable chat still launches, and the Activity notice keeps the text */ }
    return what.join("; ");
  } catch { return ""; /* a notice that cannot be made never stops the launch */ }
}
