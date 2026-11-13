import { createTaskStore } from "../fixed-crew/task-store.ts";
import { digest } from "../fixed-crew/task-revision.ts";
import { dataRoot, fixedTasks, setFixedTasks, workspaces } from "./state.ts";
import { tabLocation } from "./tabs.ts";
import type { WebSocket } from "ws";
import { knownSlot } from "../fixed-crew/preferences.ts";
import { fixedCrewOf, isFixedTab } from "../fixed-crew/runtime.ts";
import { requireFixedAssignment } from "./fixed-task-launch.ts";
import { activeLeaderTurns } from "./state.ts";
import { sendLeaderTurn } from "./leader-turn.ts";
import { broadcast, stateMessage } from "./broadcast.ts";
import { refuseIfFolderBusy } from "./launch-gates.ts";
import { executionJournal } from "../fixed-crew/task-execution.ts";
import { applyTaskEvent } from "./fixed-task-launch.ts";

export function initializeFixedTasks(): void {
  setFixedTasks(createTaskStore(dataRoot, (tabId) => {
    const tab = tabLocation(tabId)?.tab;
    if (!tab || !isFixedTab(tab)) throw new Error("A current fixed crew tab is required");
    fixedCrewOf(tab);
    return tab.folder;
  }));
  for (const tab of workspaces.projects.flatMap((p) => p.tabs)) {
    if (!isFixedTab(tab)) continue;
    try { fixedTasks.get(tab.id); } catch (error) { console.error(`Task unavailable for ${tab.id}: ${(error as Error).message}`); }
  }
}
// Owner identity is minted here, never read from the browser's payload. The
// launch adapter in 3b must supply its own server actor and execution identity.
export function ownerTaskActor() { return fixedTasks.actor("owner", "browser-owner"); }
export function requestTaskActor() { return fixedTasks.actor("leader", "browser-request"); }
export function requestSession(requestId: string): string {
  // The reservation id must be stable across a replay. It is not a CLI session.
  return `pending-${digest(requestId)}`;
}
export function assertRequestLeaderIdle(tabId: string): void {
  if (activeLeaderTurns.has(tabId)) throw new Error("The leader is still answering. Wait before requesting an action.");
}
export async function deliverTaskRequest(tabId: string, requestId: string, taskId: string, planVersion: number, executionId: string): Promise<void> {
  const store = fixedTasks, root = dataRoot, tab = tabLocation(tabId)?.tab, folder = tab?.folder;
  const sessionId = requestSession(requestId);
  try {
    const task = fixedTasks.get(tabId);
    const execution = task?.executions.find((e) => e.id === executionId && e.sessionId === requestSession(requestId) && e.status === "reserved");
    if (!task || task.id !== taskId || task.planVersion !== planVersion || !execution) throw new Error("The saved action request is no longer available.");
    const delivered = await sendLeaderTurn(tabId, `The owner requested ${execution.kind}. Read get_fixed_task. Execute the identified reservation ${execution.id} using request_task_action with reservedExecutionId, after checking the approved task. Do not create another reservation.`);
    if (!delivered) throw new Error("The leader did not receive the action request. It was not retried.");
  } catch (error) {
    let message = (error as Error).message;
    try {
      const task = store.get(tabId);
      const execution = task?.executions.find((e) => e.id === executionId && e.sessionId === sessionId && e.taskId === taskId && e.planVersion === planVersion);
      // A journal entry means the leader consumed the reservation. Never release it
      // here, even if its process has not started yet.
      if (fixedTasks === store && dataRoot === root && tabLocation(tabId)?.tab === tab && tab?.folder === folder
        && task?.id === taskId && task.planVersion === planVersion && task.requests.some((r) => r.id === requestId && r.result.executionId === executionId)
        && execution?.status === "reserved" && !executionJournal(root, tabId).executions.some((e) => e.id === executionId)) {
        applyTaskEvent(tabId, task, { type: "cancelRequest", executionId, sessionId, reason: "Leader delivery failed before execution was consumed." }, requestTaskActor());
      }
    } catch (releaseError) { message += ` Reservation release failed: ${(releaseError as Error).message}`; }
    broadcast({ type: "error", action: "requestFixedTaskAction", tabId, requestId, message });
    broadcast(stateMessage());
  }
}
export function requestFixedRun(ws: WebSocket, message: any): void {
  knownSlot(message.slot);
  requireFixedAssignment(message.tabId, message.slot);
  requireFixedAssignment(message.tabId, "leader");
  if (typeof message.prompt !== "string" || !message.prompt.trim() || message.prompt.length > 200_000) throw new Error("A bounded task brief is required.");
  if (activeLeaderTurns.has(message.tabId)) throw new Error("The leader is still answering. Steer this request into its reply or wait.");
  if (refuseIfFolderBusy(ws, message, "run", tabLocation(message.tabId)!.tab.folder)) return;
  void sendLeaderTurn(message.tabId, `The owner requests work from ${message.slot}. Use the saved task and approval gates before any execution. This is a request, not permission to bypass a plan.\n\n${message.prompt}`)
    .catch((error) => broadcast({ type: "chatError", tabId: message.tabId, message: (error as Error).message }));
  ws.send(JSON.stringify({ type: "fixedRunRequested", tabId: message.tabId, slot: message.slot }));
}
