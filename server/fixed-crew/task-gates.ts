import type { FixedSlot } from "./roster.ts";
import { mustHaveFinal } from "./task-plan.ts";
import { changedPaths } from "./task-revision.ts";
import { type Task, type Execution, type ActionKind, type Review } from "./task-types.ts";

export type TaskAction = { kind: ActionKind; route: Execution["route"]; change: Execution["change"] };
export const ownerApproved = (task: Task) => task.ownerScopeApproval?.planVersion === task.planVersion && task.ownerScopeApproval.digest === task.planDigest;
export function needsRoughApproval(task: Task, action: TaskAction): boolean {
  return task.plan.visibleWork && ["polish", "check", "review", "final", "commit", "push", "publish"].includes(action.kind)
    && (!task.roughRevision || task.ownerRoughApproval?.revision !== task.roughRevision || !ownerApproved(task));
}
function accepted(task: Task, executionId: string, revision?: string): Execution | undefined {
  return task.executions.find((e) => e.id === executionId && e.taskId === task.id && e.planVersion === task.planVersion
    && e.status === "success" && e.processEnd === "confirmed" && e.verified && e.evidence.length > 0
    && (revision === undefined || e.resultRevision === revision));
}
function clean(task: Task, review: Review): boolean {
  return review.findings.every((id) => {
    const finding = task.findings.find((f) => f.id === id);
    return finding && (!finding.real || task.triage[id]?.outcome === "PASS");
  });
}
export function allFindingsTriaged(task: Task): boolean {
  return task.findings.every((f) => !f.real || (!!task.triage[f.id]?.reason.trim() && ["FIX", "PASS"].includes(task.triage[f.id].outcome)));
}
export function hasOpenFix(task: Task): boolean {
  return task.findings.some((f) => f.real && task.triage[f.id]?.outcome === "FIX" && !task.reviews.some((r) => r.resolved.includes(f.id)
    && accepted(task, r.executionId) && clean(task, r)));
}
export function freshReview(task: Task, revision: string): boolean {
  return task.reviews.some((r) => !r.final && r.revision === revision && accepted(task, r.executionId, revision) && clean(task, r));
}
export const needsFinal = (task: Task) => task.reviewPolicy.finalRequired || mustHaveFinal(task.plan);
export function freshFinal(task: Task, revision: string): boolean {
  return task.reviews.some((r) => r.final && accepted(task, r.executionId) && (r.revision === revision && clean(task, r)
    || task.reviews.some((correction) => correction.baseFinal === r.executionId && correction.revision === revision
      && accepted(task, correction.executionId, revision) && clean(task, correction) && finalCorrectionCoverage(task, r, correction))));
}
export function finalCorrectionCoverage(task: Task, final: Review, correction: Review): boolean {
  const before = task.revisions.find((r) => r.digest === final.revision);
  const after = task.revisions.find((r) => r.digest === correction.revision);
  if (!before || !after) return false;
  const changes = changedPaths(before, after);
  const unchanged = Object.keys(before.files).filter((p) => !changes.includes(p)).sort();
  const run = accepted(task, correction.executionId);
  const fix = task.executions.findLast((e) => e.kind === "fix" && e.resultRevision === correction.revision && accepted(task, e.id));
  return !!run && !!fix && changes.length > 0 && JSON.stringify([...correction.unchanged].sort()) === JSON.stringify(unchanged)
    && final.findings.every((id) => task.triage[id]?.outcome === "PASS" || correction.resolved.includes(id))
    && correction.resolved.every((id) => fix.batch.includes(id)) && run.role === (fix.route === "minimal" ? "minimalReviewer" : task.plan.design ? "reviewer2" : "reviewer1");
}
export function allChecksPassed(task: Task, revision: string): boolean {
  return task.plan.checks.every((name) => task.checks.some((c) => c.name === name && c.revision === revision && accepted(task, c.executionId, revision)));
}
export function validCheckpoint(task: Task): boolean {
  return task.checkpoints.some((c) => c.revision === task.revision.digest && accepted(task, c.executionId, c.revision));
}
export function newReviewSession(task: Task, execution: Execution): boolean {
  return !!execution.sessionId && !task.coordinatorSessions.includes(execution.sessionId)
    && !task.executions.some((e) => e.id !== execution.id && e.sessionId === execution.sessionId);
}
export function selectedRole(task: Task, action: TaskAction): FixedSlot {
  if (action.kind === "fix") {
    if (action.route === "minimal") return "minimalFixer";
    if (action.route === "postFinal") return task.plan.design ? "fixer1" : "fixer2";
    const last = task.reviews.at(-1);
    return last && task.executions.find((e) => e.id === last.executionId)?.role === "reviewer2" ? "fixer2" : "fixer1";
  }
  if (action.kind === "review") {
    const lastFix = task.executions.findLast((e) => e.kind === "fix");
    if (lastFix?.route === "minimal") return "minimalReviewer";
    if (lastFix?.route === "postFinal") return task.plan.design ? "reviewer2" : "reviewer1";
    return lastFix?.role === "fixer1" ? "reviewer2" : "reviewer1";
  }
  if (action.kind === "final") return task.plan.design ? "designFinal" : "final";
  if (["rough", "build", "polish"].includes(action.kind)) return task.plan.design ? "designCoder" : "coder";
  return action.kind === "assist" ? "helper" : "leader";
}
export function assertTaskGate(task: Task | null, action: TaskAction, execution?: Execution): void {
  if (!task) { if (action.kind === "assist") return; throw new Error("An implementation plan is required."); }
  if (task.stage === "interrupted") throw new Error("Check the interrupted action before continuing.");
  if (action.kind === "assist") return;
  if (!ownerApproved(task)) throw new Error("Approve this plan before building.");
  if (needsRoughApproval(task, action)) throw new Error("Approve the rough before polish or review.");
  if (task.executions.some((e) => (["running", "reserved", "interrupted"].includes(e.status) || e.processEnd !== "confirmed") && e.id !== execution?.id)) throw new Error("Reconcile the active reservation before another action.");
  const revision = task.revision.digest;
  if (!task.seats[selectedRole(task, action)]) throw new Error("Assign the selected role before acting.");
  if (task.plan.visibleWork && action.kind === "build") throw new Error("Visible work starts with a rough.");
  if (action.kind === "visualCheck" && (!task.roughRevision || task.roughRevision !== revision)) throw new Error("Run the current rough before its visual check.");
  if (action.kind === "inspect" && !task.executions.some((e) => e.kind === "visualCheck" && accepted(task, e.id, revision))) throw new Error("Run and visually check the rough before leader inspection.");
  if (action.kind === "polish" && task.stage !== "inspected" && task.stage !== "polish") throw new Error("Inspect the rough before polishing.");
  if (["review", "final"].includes(action.kind)) {
    if (!task.executions.some((e) => ["build", "polish", "fix"].includes(e.kind) && accepted(task, e.id))) throw new Error("Implementation has not been executed and verified.");
    if (!allChecksPassed(task, revision)) throw new Error("Required checks are missing, failed or stale.");
    if (execution && !newReviewSession(task, execution)) throw new Error("Review needs a fresh independent session.");
  }
  if (action.kind === "final" && !freshReview(task, revision)) throw new Error("Run the ordinary review before final.");
  if (["review", "final", "fix", "checkpoint", "commit", "push", "publish"].includes(action.kind)) {
    if (!allFindingsTriaged(task)) throw new Error("The Planner must triage every finding.");
  }
  if (action.kind === "fix" && !validCheckpoint(task)) throw new Error("Create and verify the local checkpoint before fixing.");
  if (action.kind === "fix") {
    const fixes = task.findings.filter((f) => f.real && task.triage[f.id]?.outcome === "FIX" && !task.reviews.some((r) => r.resolved.includes(f.id) && accepted(task, r.executionId) && clean(task, r)));
    if (!fixes.length) throw new Error("No accepted fixes require a batch.");
    const postFinal = task.reviews.some((r) => r.final);
    if (postFinal !== (action.route !== "normal")) throw new Error("Use the required post-final route.");
    if (action.route === "minimal" && (action.change !== "minimal" || fixes.some((f) => !f.minimal))) throw new Error("Logic changes cannot use the minimal route.");
    if (execution && JSON.stringify([...execution.batch].sort()) !== JSON.stringify(fixes.map((f) => f.id).sort())) throw new Error("Fix every accepted finding in one sequential batch.");
  }
  if (["commit", "push", "publish"].includes(action.kind)) {
    if (hasOpenFix(task)) throw new Error("Finish the accepted fixes before shipping.");
    if (!freshReview(task, revision)) throw new Error("A fresh review of this revision is required.");
    if (needsFinal(task) && !freshFinal(task, revision)) throw new Error("A final review of this revision is required.");
    if (!allChecksPassed(task, revision)) throw new Error("Shipping checks are missing, failed or stale.");
    if (!task.plan.shipping.includes(action.kind as "commit")) throw new Error("This shipping action is outside the approved scope.");
  }
}
