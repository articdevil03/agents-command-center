import { digest } from "./task-revision.ts";
import { validatePlan, validateTask, type Plan, type Task, type Revision } from "./task-types.ts";
import type { Assignment, FixedSlot } from "./roster.ts";

export function mustHaveFinal(plan: Plan): boolean {
  return ["high", "unknown"].includes(plan.risk.level) || plan.large || plan.integration;
}
export function createTask(id: string, tabId: string, raw: Plan, seats: Partial<Record<FixedSlot, Assignment>>, revision: Revision): Task {
  const plan = validatePlan(raw);
  return validateTask({ schemaVersion: 1, id, tabId, plan, planVersion: 1, planDigest: digest({ plan, seats }), recordRevision: 1,
    stage: "planned", reviewPolicy: { finalRequired: mustHaveFinal(plan), reason: plan.reviewReason }, seats, coordinatorSessions: [],
    ownerScopeApproval: null, ownerRoughApproval: null, roughRevision: null, revision,
    revisions: [revision], executions: [], checks: [], reviews: [], checkpoints: [], findings: [], triage: {}, requests: [] });
}
export function revisePlan(current: Task, raw: Plan, seats = current.seats): Task {
  if (current.executions.some((run) => ["reserved", "running", "interrupted"].includes(run.status))) throw new Error("Reconcile executions before revising the plan");
  const plan = validatePlan(raw);
  const next = structuredClone(current);
  const nextDigest = digest({ plan, seats });
  if (nextDigest === current.planDigest) return next;
  next.plan = plan;
  next.seats = structuredClone(seats);
  next.planVersion = current.planVersion + 1;
  next.planDigest = nextDigest;
  next.reviewPolicy.finalRequired = mustHaveFinal(plan);
  next.reviewPolicy.reason = plan.reviewReason;
  next.ownerScopeApproval = null;
  next.ownerRoughApproval = null;
  next.roughRevision = null;
  next.stage = "planned";
  return next;
}
