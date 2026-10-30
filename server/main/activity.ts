import { broadcast, stateMessage } from "./broadcast.ts";
import { activeLeaderTurns, folderActivity, leaderActivity, leaderTurnResolvers, leaderTurnText, runWindows, turnWindows } from "./state.ts";
import { tabLocation } from "./tabs.ts";

export function setLeaderActivity(tabId: string, label: string | null): void {
  if ((label ?? undefined) === leaderActivity.get(tabId)) return;
  if (label === null) leaderActivity.delete(tabId); else leaderActivity.set(tabId, label);
  broadcast({ type: "leaderActivity", tabId, label });
}
// A Claude CLI that starts a turn by itself (a background job finished) has no message of ours waiting: the reply is opened here like a normal one, so it is shown,
// counts as replying everywhere activeLeaderTurns is read, and is saved when its result comes. Codex and OpenCode never do this (they only talk inside a turn we sent).
export function openUnpromptedReply(tabId: string): void {
  if (activeLeaderTurns.has(tabId) || leaderTurnResolvers.has(tabId)) return;
  activeLeaderTurns.add(tabId);
  beginTurnWindow(tabId);
  leaderTurnText.set(tabId, "");
  leaderTurnResolvers.set(tabId, { resolve: () => {}, text: "", unprompted: true });
  broadcast(stateMessage());
}
export function beginTurnWindow(tabId: string): void { const folder = tabLocation(tabId)?.tab.folder; if (folder) turnWindows.set(tabId, folderActivity.beginOwn(folder)); }
export function endTurnWindow(tabId: string): void { folderActivity.endOwn(turnWindows.get(tabId)); turnWindows.delete(tabId); }
export function endRunWindow(runId: string): void { folderActivity.endOwn(runWindows.get(runId)); runWindows.delete(runId); }
