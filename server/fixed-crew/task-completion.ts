import { allChecksPassed, allFindingsTriaged, freshFinal, freshReview, hasOpenFix, needsFinal, ownerApproved } from "./task-gates.ts";
import type { Task } from "./task-types.ts";

// Completion is shared by the stage transition and durable rollover. A saved
// stage label alone never certifies evidence or permission.
export function assertTaskComplete(task: Task): void {
  const revision = task.revision.digest;
  if (task.stage === "interrupted") throw new Error("Reconcile the interrupted task before completion.");
  if (!ownerApproved(task) || task.plan.visibleWork && (!task.roughRevision
    || task.ownerRoughApproval?.planVersion !== task.planVersion
    || task.ownerRoughApproval.digest !== task.planDigest
    || task.ownerRoughApproval.revision !== task.roughRevision)) throw new Error("Owner scope and required rough approval are required.");
  if (task.executions.some((run) => ["reserved", "running", "interrupted"].includes(run.status)
    || run.processEnd !== "confirmed" || run.status === "success" && !run.verified)) throw new Error("Unresolved or unverified task execution.");
  if (!allChecksPassed(task, revision)) throw new Error("Required current checks are missing.");
  if (!freshReview(task, revision)) throw new Error("A fresh accepted ordinary review is required.");
  if (needsFinal(task) && !freshFinal(task, revision)) throw new Error("A fresh accepted final review is required.");
  if (!allFindingsTriaged(task) || hasOpenFix(task)) throw new Error("Triage and resolve every accepted FIX before completion.");
  if (!task.plan.shipping.every((kind) => task.executions.some((run) => run.kind === kind
    && run.taskId === task.id && run.planVersion === task.planVersion && run.status === "success"
    && run.processEnd === "confirmed" && run.verified && run.evidence.length > 0
    && run.resultRevision === revision))) throw new Error("Approved shipping is unfinished.");
}
