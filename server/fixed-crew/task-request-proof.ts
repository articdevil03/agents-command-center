import { digest } from "./task-revision.ts";
import type { Task, Execution } from "./task-types.ts";

// Receipts bind the original action and pre-action revision. A UUID alone is
// never admission proof. Browser intent has one exact, deterministic session.
export function authenticTaskRequest(task: Task, run: Execution): boolean {
  if (run.taskId !== task.id) return false;
  return task.requests.some((request) => {
    if (request.result.executionId !== run.id || request.result.recordRevision < 2) return false;
    const expected = { tabId: task.tabId, taskId: run.taskId, planVersion: run.planVersion,
      recordRevision: request.result.recordRevision - 1, requestId: request.id };
    const event = { type: "action", action: { kind: run.kind, route: run.route, change: run.change }, sessionId: run.sessionId, batch: run.batch };
    const sessions = run.sessionId.startsWith("pending-")
      ? run.sessionId === `pending-${digest(request.id)}` ? ["browser-request"] : []
      : task.coordinatorSessions.filter((session) => session !== "browser-request");
    return sessions.some((sessionId) => digest({ expected, event, actor: { role: "leader", sessionId } }) === request.digest);
  });
}

export function taskOnlyResultProvenance(task: Task, run: Execution): boolean {
  return run.verified || run.evidence.length > 0 || run.resultRevision !== null || run.findings.length > 0
    || task.findings.some((finding) => finding.executionId === run.id)
    || [...task.checks, ...task.reviews, ...task.checkpoints].some((entry) => entry.executionId === run.id)
    || task.coordinatorSessions.includes(run.id);
}

export function cancelledTaskOnly(run: Execution): boolean {
  return run.status === "failed" && run.processEnd === "confirmed" && !run.verified
    && !run.evidence.length && !run.findings.length && run.resultRevision === null;
}
