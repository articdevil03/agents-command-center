import { randomUUID } from "node:crypto";
import type { Assignment, FixedSlot } from "./roster.ts";
import { assertTaskGate, allFindingsTriaged, newReviewSession, selectedRole, type TaskAction } from "./task-gates.ts";
import { revisePlan } from "./task-plan.ts";
import { assertTaskComplete } from "./task-completion.ts";
import { ACTIONS, STAGES, object, id, text, unique, path, enumeration, type Task, type Plan, type Execution, type Stage, type Decision, type Finding, type Review, type Check } from "./task-types.ts";

export type Actor = Readonly<{ role: FixedSlot | "owner"; sessionId: string }>;
export type Event =
  | { type: "plan"; plan: Plan; seats?: Partial<Record<FixedSlot, Assignment>> }
  | { type: "approvePlan" }
  | { type: "approveRough"; roughRevision: string }
  | { type: "stage"; stage: Stage }
  | { type: "action"; action: TaskAction; sessionId: string; batch: string[] }
  | { type: "start"; executionId: string }
  | { type: "result"; executionId: string; taskId: string; planVersion: number; role: FixedSlot; success: boolean; processEnd: Execution["processEnd"]; evidence: string[] }
  | { type: "verify"; executionId: string; checkName: string | null; findings: Finding[]; resolved: string[]; baseFinal: string | null; unchanged: string[] }
  | { type: "triage"; decisions: { findingId: string; outcome: "FIX" | "PASS"; reason: string }[] }
  | { type: "cancelRequest"; executionId: string; sessionId: string; reason: string }
  | { type: "reconcile"; executionId: string; processEnd: "confirmed"; reason: string };

function requireRole(actor: Actor, role: Actor["role"]): void {
  if (actor.role !== role) throw new Error("This actor cannot record this task event.");
}
function eventKeys(event: Event): void {
  const keys: Record<Event["type"], string[]> = {
    plan: ["plan", ...(Object.hasOwn(event, "seats") ? ["seats"] : [])], approvePlan: [], approveRough: ["roughRevision"], stage: ["stage"], action: ["action", "sessionId", "batch"],
    start: ["executionId"], result: ["executionId", "taskId", "planVersion", "role", "success", "processEnd", "evidence"],
    verify: ["executionId", "checkName", "findings", "resolved", "baseFinal", "unchanged"], triage: ["decisions"], reconcile: ["executionId", "processEnd", "reason"],
    cancelRequest: ["executionId", "sessionId", "reason"],
  };
  if (!Object.hasOwn(keys, event.type)) throw new Error("Unknown task event");
  object(event, ["type", ...keys[event.type]]);
}
function executionOf(task: Task, executionId: string): Execution {
  id(executionId);
  const execution = task.executions.find((e) => e.id === executionId && e.planVersion === task.planVersion);
  if (!execution) throw new Error("Unknown current execution");
  return execution;
}
function moveStage(next: Task, stage: Stage): void {
  enumeration(stage, STAGES);
  const revision = next.revision.digest;
  const success = (kind: string) => next.executions.some((e) => e.kind === kind && e.planVersion === next.planVersion && e.resultRevision === revision && e.verified);
  if (stage === "rough" && !success("rough")) throw new Error("Run the rough first");
  if (stage === "inspected" && (next.stage !== "rough" || !success("inspect"))) throw new Error("Run and inspect the rough first");
  if (stage === "polish") assertTaskGate(next, { kind: "polish", route: "normal", change: "none" });
  if (stage === "checks" && !success("build") && !success("polish") && !success("fix")) throw new Error("Finish implementation first");
  if (stage === "review") assertTaskGate(next, { kind: "review", route: "normal", change: "none" });
  if (stage === "final") assertTaskGate(next, { kind: "final", route: "normal", change: "none" });
  if (stage === "complete") assertTaskComplete(next);
  if (stage === "shipping") {
    const kind = next.plan.shipping[0];
    if (!kind) throw new Error("No shipping scope approved");
    assertTaskGate(next, { kind, route: "normal", change: "none" });
  }
  if (["planned", "discussion", "interrupted", "fix"].includes(stage)) throw new Error("This stage is set by its owning event");
}
export function transitionTask(current: Task, event: Event, actor: Actor, interruptedCancellation = false): { task: Task; executionId: string | null } {
  eventKeys(event);
  let next = structuredClone(current);
  let executionId: string | null = null;
  if (event.type === "plan") { requireRole(actor, "planner"); next = revisePlan(next, event.plan, event.seats); }
  else if (event.type === "approvePlan") {
    requireRole(actor, "owner");
    const approval = { planVersion: next.planVersion, digest: next.planDigest, revision: null };
    next.ownerScopeApproval = approval;
  } else if (event.type === "approveRough") {
    requireRole(actor, "owner");
    if (next.stage !== "inspected" || !next.roughRevision || event.roughRevision !== next.roughRevision || event.roughRevision !== next.revision.digest) throw new Error("The inspected rough revision changed");
    const approval = { planVersion: next.planVersion, digest: next.planDigest, revision: event.roughRevision };
    next.ownerRoughApproval = approval;
  } else if (event.type === "stage") {
    requireRole(actor, "leader"); moveStage(next, event.stage);
    next.stage = event.stage;
  } else if (event.type === "action") {
    requireRole(actor, "leader"); object(event.action, ["kind", "route", "change"]);
    enumeration(event.action.kind, ACTIONS); enumeration(event.action.route, ["normal", "minimal", "postFinal"]); enumeration(event.action.change, ["none", "minimal", "logic"]);
    id(event.sessionId); unique(event.batch, id);
    const execution: Execution = { id: randomUUID(), taskId: next.id, planVersion: next.planVersion, role: selectedRole(next, event.action), sessionId: event.sessionId,
      ...event.action, status: "reserved", revision: next.revision.digest, resultRevision: null, processEnd: "unknown", verified: false, evidence: [], findings: [], batch: event.batch };
    assertTaskGate(next, event.action, execution);
    next.executions.push(execution); executionId = execution.id;
    if (execution.kind === "fix") next.stage = "fix";
  } else if (event.type === "triage") {
    requireRole(actor, "planner");
    if (!Array.isArray(event.decisions) || event.decisions.length > 500 || new Set(event.decisions.map((d) => d.findingId)).size !== event.decisions.length) throw new Error("Duplicate triage decisions");
    for (const raw of event.decisions) {
      object(raw, ["findingId", "outcome", "reason"]); id(raw.findingId); text(raw.reason); enumeration(raw.outcome, ["FIX", "PASS"]);
      const finding = next.findings.find((f) => f.id === raw.findingId && f.real);
      if (!finding || next.triage[finding.id]) throw new Error("Unknown or already triaged finding");
      const decision: Decision = { outcome: raw.outcome, reason: raw.reason };
      next.triage[finding.id] = decision;
    }
    if (!allFindingsTriaged(next)) throw new Error("Triage every real finding in one record");
  } else {
    const execution = executionOf(next, event.executionId);
    if (event.type === "start") {
      requireRole(actor, "leader");
      if (execution.status !== "reserved") throw new Error("Execution already started");
      assertTaskGate(next, execution, execution);
      execution.status = "running";
    } else if (event.type === "result") {
      requireRole(actor, execution.role);
      if (actor.sessionId !== execution.sessionId || event.taskId !== next.id || event.planVersion !== next.planVersion || event.role !== execution.role) throw new Error("Evidence identity does not match the server execution");
      if (execution.status !== "running") throw new Error("Only a running execution can report a result");
      if (!["rough", "build", "polish", "fix"].includes(execution.kind) && execution.revision !== next.revision.digest) throw new Error("Read-only evidence changed its covered revision");
      enumeration(event.success, [true, false]); enumeration(event.processEnd, ["unknown", "confirmed", "failed"]); unique(event.evidence, path);
      execution.status = event.success ? "success" : "failed";
      execution.processEnd = event.processEnd; execution.evidence = event.evidence; execution.resultRevision = next.revision.digest;
    } else if (event.type === "cancelRequest") {
      requireRole(actor, "leader"); id(event.sessionId); text(event.reason);
      if (!(execution.status === "reserved" || interruptedCancellation && execution.status === "interrupted") || execution.sessionId !== event.sessionId) throw new Error("Only the exact unconsumed request can be cancelled");
      // The owning service proves no admission. Confirmed means no process launched.
      execution.status = "failed"; execution.processEnd = "confirmed"; execution.verified = false; execution.evidence = []; execution.resultRevision = null;
      if (interruptedCancellation && next.stage === "interrupted" && !next.executions.some((e) => ["reserved", "running", "interrupted"].includes(e.status) || e.processEnd !== "confirmed" || e.status === "success" && !e.verified)) next.stage = "planned";
    } else if (event.type === "reconcile") {
      requireRole(actor, "leader"); text(event.reason); enumeration(event.processEnd, ["confirmed"]);
      if (execution.status !== "interrupted" && execution.processEnd === "confirmed") throw new Error("No interrupted result to reconcile");
      if (execution.verified) throw new Error("Accepted evidence cannot be abandoned");
      execution.status = "failed"; execution.processEnd = "confirmed"; execution.evidence = []; execution.verified = false; execution.resultRevision = null;
      if (next.stage === "interrupted" && !next.executions.some((e) => ["reserved", "running", "interrupted"].includes(e.status) || e.processEnd !== "confirmed")) next.stage = "planned";
    } else {
      requireRole(actor, "leader");
      if (actor.sessionId === execution.sessionId) throw new Error("The leader must independently verify the result");
      if (execution.verified || execution.status !== "success" || execution.processEnd !== "confirmed" || !execution.evidence.length || execution.resultRevision !== next.revision.digest) throw new Error("Evidence must be successful, ended and current");
      if (["review", "final"].includes(execution.kind) && !newReviewSession(next, execution)) throw new Error("Review session is not fresh");
      unique(event.resolved, id); unique(event.unchanged, path);
      if (!Array.isArray(event.findings) || event.findings.length > 500) throw new Error("Invalid findings");
      if (!["review", "final"].includes(execution.kind) && (event.findings.length || event.resolved.length || event.baseFinal !== null || event.unchanged.length)) throw new Error("Only reviews can supply findings or coverage");
      for (const finding of event.findings) {
        object(finding, ["id", "executionId", "text", "real", "minimal"]); id(finding.id); text(finding.text);
        enumeration(finding.real, [true, false]); enumeration(finding.minimal, [true, false]);
        if (finding.executionId !== execution.id || next.findings.some((f) => f.id === finding.id)) throw new Error("Duplicate or mismatched finding");
        next.findings.push(structuredClone(finding));
      }
      for (const findingId of event.resolved) {
        const fix = next.executions.findLast((e) => e.kind === "fix" && e.verified && e.resultRevision === next.revision.digest && e.batch.includes(findingId));
        if (!fix || next.triage[findingId]?.outcome !== "FIX" || selectedRole(next, execution) !== execution.role) throw new Error("A fresh follow-up must verify the accepted batch");
      }
      execution.verified = true;
      execution.findings = event.findings.map((f) => f.id);
      const evidence = { executionId: execution.id, revision: next.revision.digest, evidence: [...execution.evidence] };
      if (execution.kind === "check") {
        if (!next.plan.checks.includes(event.checkName!)) throw new Error("Unknown required check");
        const check: Check = { ...evidence, name: event.checkName! };
        next.checks.push(check);
      } else if (event.checkName !== null) throw new Error("Only checks have a check name");
      if (execution.kind === "review" || execution.kind === "final") {
        const review: Review = { ...evidence, final: execution.kind === "final", findings: execution.findings, resolved: event.resolved, baseFinal: event.baseFinal, unchanged: event.unchanged };
        if (event.baseFinal !== null && !next.reviews.some((r) => r.final && r.executionId === event.baseFinal)) throw new Error("Unknown base final review");
        next.reviews.push(review);
      }
      if (execution.kind === "checkpoint") next.checkpoints.push(evidence);
      if (execution.kind === "rough") { next.roughRevision = next.revision.digest; next.ownerRoughApproval = null; next.stage = "rough"; }
      if (execution.kind === "inspect") {
        if (next.stage !== "rough" || next.roughRevision !== next.revision.digest) throw new Error("Only the current rough can be inspected");
        next.stage = "inspected";
      }
      // A verification is a record, never a worker launch or an automatic round.
    }
  }
  return { task: next, executionId };
}
