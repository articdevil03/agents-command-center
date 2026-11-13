import { exactKeys } from "../../fixed-crew/preferences.ts";
import { ACTIONS, enumeration, id, integer, type ActionKind } from "../../fixed-crew/task-types.ts";
import { dataRoot, fixedTasks, selectedTabId } from "../state.ts";
import { listTaskArchives, readTaskArchive } from "../../fixed-crew/task-archive-files.ts";
import { broadcast, stateMessage } from "../broadcast.ts";
import { ownerTaskActor, requestSession, requestTaskActor, assertRequestLeaderIdle, deliverTaskRequest } from "../fixed-tasks.ts";
import { tabLocation } from "../tabs.ts";
import type { MessageHandler } from "./types.ts";
import { admitJournalExecution } from "../../fixed-crew/task-journal-archive.ts";
import { fixedArchiveRuntimeBlocked } from "../fixed-task-launch.ts";

export function fixedTaskMessages(): Array<[string, MessageHandler]> {
  return ["listFixedTaskArchives", "getFixedTaskArchive", "getFixedTask", "approveFixedPlan", "approveFixedRough", "requestFixedTaskAction"].map((type) => [type, (ws, message) => {
    if (type === "listFixedTaskArchives" || type === "getFixedTaskArchive") {
      exactKeys(message, ["type", "requestId", "tabId", ...(type === "listFixedTaskArchives" ? ["cursor", "limit"] : ["taskId"])]);
      id(message.requestId); id(message.tabId);
      const tab = tabLocation(message.tabId)?.tab;
      if (!tab?.fixedCrew || tab.fixedCrew.version !== 1) throw new Error("A current fixed crew tab is required");
      if (type === "listFixedTaskArchives") ws.send(JSON.stringify({ type: "fixedTaskArchives", requestId: message.requestId, tabId: message.tabId,
        ...listTaskArchives(dataRoot, message.tabId, "task", message.cursor, message.limit) }));
      else ws.send(JSON.stringify({ type: "fixedTaskArchive", requestId: message.requestId, tabId: message.tabId, taskId: message.taskId,
        ...readTaskArchive(dataRoot, message.tabId, message.taskId) }));
      return;
    }
    const read = type === "getFixedTask";
    exactKeys(message, ["type", "requestId", "tabId", ...(read ? [] : ["taskId", "planVersion", "recordRevision"]),
      ...(type === "approveFixedRough" ? ["roughRevision"] : []), ...(type === "requestFixedTaskAction" ? ["action"] : [])]);
    id(message.requestId); id(message.tabId);
    const tab = tabLocation(message.tabId)?.tab;
    if (!tab?.fixedCrew || tab.fixedCrew.version !== 1) throw new Error("A current fixed crew tab is required");
    if (read) {
      ws.send(JSON.stringify({ type: "fixedTask", requestId: message.requestId, tabId: message.tabId, task: fixedTasks.get(message.tabId) }));
      return;
    }
    if (message.tabId !== selectedTabId) throw new Error("Select this tab before changing its task");
    id(message.taskId); integer(message.planVersion); integer(message.recordRevision);
    const expected = { requestId: message.requestId, tabId: message.tabId, taskId: message.taskId, planVersion: message.planVersion, recordRevision: message.recordRevision };
    let result;
    let replay = false;
    if (type === "requestFixedTaskAction") {
      enumeration(message.action, ACTIONS);
      replay = !!fixedTasks.get(message.tabId)?.requests.some((r) => r.id === message.requestId);
      if (!replay) assertRequestLeaderIdle(message.tabId);
      if (!replay) {
        const task = fixedTasks.get(message.tabId);
        if (!task || task.id !== message.taskId || task.planVersion !== message.planVersion || task.recordRevision !== message.recordRevision) throw new Error("Stale task identity or revision.");
        admitJournalExecution(dataRoot, message.tabId, task, (runId) => fixedArchiveRuntimeBlocked(message.tabId, runId));
      }
      // This records intent only. No action is executed or automatically retried.
      result = fixedTasks.apply(expected, { type: "action", action: { kind: message.action as ActionKind, route: "normal", change: "none" }, sessionId: requestSession(message.requestId), batch: [] }, requestTaskActor());
    } else result = fixedTasks.apply(expected, type === "approveFixedPlan" ? { type: "approvePlan" } : { type: "approveRough", roughRevision: message.roughRevision }, ownerTaskActor());
    ws.send(JSON.stringify({ type: "fixedTaskResult", requestId: message.requestId, tabId: message.tabId, taskId: message.taskId, ...result, executionAvailable: true }));
    broadcast(stateMessage());
    if (type === "requestFixedTaskAction" && !replay && result.executionId) void deliverTaskRequest(message.tabId, message.requestId, message.taskId, message.planVersion, result.executionId);
  }]);
}
