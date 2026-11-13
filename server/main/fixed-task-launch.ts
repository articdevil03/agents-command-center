import { randomUUID } from "node:crypto";
import { requireAssignment, assignmentCompany, independenceNotice } from "../fixed-crew/assignment.ts";
import { fixedCrewOf, isFixedTab } from "../fixed-crew/runtime.ts";
import { FIXED_CREW, type FixedSlot } from "../fixed-crew/roster.ts";
import { assertTaskGate, selectedRole, type TaskAction } from "../fixed-crew/task-gates.ts";
import { executionJournal, readJournalSnapshot, saveJournal, type Journal, assertExecutionEnded, assertRetiredExecution, recordTreeEnd, type FixedExecution } from "../fixed-crew/task-execution.ts";
import { admitJournalExecution } from "../fixed-crew/task-journal-archive.ts";
import { isRunning } from "../runner.ts";
import { fixedGitOperations } from "./fixed-task-actions.ts";
import { composeCrewRolePrompt } from "../fixed-crew/role-prompts.ts";
import { reportInstructions } from "../fixed-crew/task-reports.ts";
import type { Actor, Event } from "../fixed-crew/task-transitions.ts";
import type { Task } from "../fixed-crew/task-types.ts";
import { dataRoot, fixedTasks, leaderInstances, leaders, runRecords, workspaces, runContexts, savingTabs, pendingApprovals } from "./state.ts";
import { tabLocation } from "./tabs.ts";
import { assertTaskRecoveryReady, assertWorkspaceRecoveryReady } from "../fixed-crew/recovery.ts";

export type FixedLeaderActor = { tabId: string; instance: object; sessionId: string };
export const isCurrentFixedLeader = (actor: FixedLeaderActor): boolean => leaderInstances.get(actor.tabId) === actor.instance
  && !!leaders.get(actor.tabId) && !leaders.get(actor.tabId)!.isDead();
export type FixedLaunchContext = { actor: FixedLeaderActor; executionId: string; assignmentDigest: string };
const contexts = new WeakSet<object>();
export function fixedArchiveRuntimeBlocked(tabId: string, runId?: string): boolean {
  return [...runContexts.values()].some((context) => context.tabId === tabId && (!runId || context.run.runId === runId))
    || (runId ? isRunning(runId) || !!fixedGitOperations.get(runId) : fixedGitOperations.ids(`${tabId}.leader`).length > 0)
    || savingTabs.has(tabId) || [...pendingApprovals.values()].some((entry) => entry.tabId === tabId);
}
export function applyTaskEvent(tabId: string, task: Task, event: Event, actor: Actor) {
  assertTaskRecoveryReady();
  return fixedTasks.apply({ tabId, taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision, requestId: randomUUID() }, event, actor);
}
export function requireFixedAssignment(tabId: string, slot: FixedSlot) {
  const tab = tabLocation(tabId)?.tab;
  if (!tab) throw new Error("This tab no longer exists.");
  const fixed = fixedCrewOf(tab);
  try {
    const assignment = requireAssignment(fixed.preferences[slot]);
    return assignment;
  } catch (error) {
    if (fixed.preferences[slot]?.assignment === null) throw new Error(`${FIXED_CREW.find((s) => s.slot === slot)?.role ?? slot} has no model. Choose one in Settings before continuing.`);
    throw error;
  }
}
export function assertHeavySlotFree(): void {
  for (const tab of workspaces.projects.flatMap((p) => p.tabs).filter(isFixedTab)) {
    const journal = executionJournal(dataRoot, tab.id);
    for (const execution of journal.executions) assertExecutionEnded(execution);
    if (journal.activeExecutionId) throw new Error("A fixed crew execution is already reserved.");
  }
}
function reviewerSelection(task: Task, role: FixedSlot, tabId: string) {
  const writers = task.executions.filter((e) => FIXED_CREW.find((s) => s.slot === e.role)?.canWrite)
    .map((e) => executionJournal(dataRoot, tabId).executions.find((run) => run.id === e.id)?.assignment ?? task.seats[e.role]).filter((s) => s !== undefined);
  const preferred = requireFixedAssignment(tabId, role);
  const different = (candidate: typeof preferred) => writers.length > 0 && assignmentCompany(candidate) !== null
    && writers.every((writer) => assignmentCompany(writer) !== null && assignmentCompany(writer) !== assignmentCompany(candidate));
  const selected = different(preferred) ? role : FIXED_CREW.filter((s) => s.reviews).find((s) => {
    const seat = fixedCrewOf(tabLocation(tabId)!.tab).preferences[s.slot].assignment;
    return seat && task.seats[s.slot] && JSON.stringify(seat) === JSON.stringify(task.seats[s.slot]) && different(seat);
  })?.slot ?? role;
  const assignment = requireFixedAssignment(tabId, selected);
  return { selectedSlot: selected, assignment, selectionReason: different(assignment) ? "Selected an assigned different-company reviewer for the actual writers."
    : independenceNotice(writers.at(-1) ?? null, assignment).message + " A fresh execution is required and will be used." };
}
export function selectFixedExecution(actor: FixedLeaderActor, kind: TaskAction | "planning" | "triage", slot?: FixedSlot, reservedExecutionId?: string) {
  assertTaskRecoveryReady();
  if (!isCurrentFixedLeader(actor)) throw new Error("Only the current leader may launch this action.");
  const task = fixedTasks.get(actor.tabId);
  const action = typeof kind === "object" ? kind : null;
  const reserved = reservedExecutionId ? task?.executions.find((e) => e.id === reservedExecutionId && e.status === "reserved" && e.planVersion === task.planVersion) : undefined;
  if (reservedExecutionId && (!reserved || !action || reserved.kind !== action.kind || reserved.route !== action.route || reserved.change !== action.change)) throw new Error("The requested reservation does not match this action.");
  const role = action ? task ? selectedRole(task, action) : "helper" : "planner";
  if (slot && slot !== role && !(action?.kind === "assist" && !FIXED_CREW.find((s) => s.slot === slot)?.canWrite && slot !== "leader")) throw new Error("This position does not own the approved action.");
  const requested = slot ?? role;
  const assignment = requireFixedAssignment(actor.tabId, requested);
  if (action) assertTaskGate(task, action, reserved);
  if (kind === "triage" && !task) throw new Error("No task needs triage.");
  if (task && action && JSON.stringify(task.seats[requested]) !== JSON.stringify(assignment)) throw new Error("The assignment changed. Ask the Planner for a new approved plan.");
  const selection = task && action && ["review", "final"].includes(action.kind) ? reviewerSelection(task, requested, actor.tabId)
    : { selectedSlot: requested, assignment, selectionReason: "Selected the assigned position without a fallback." };
  return { task, action, reserved, requested, selection };
}
function assertNoJournalExecution(tabId: string, executionId?: string, journal: Journal = readJournalSnapshot(dataRoot, tabId)): void {
  if (executionId && journal.executions.some((entry) => entry.id === executionId)) {
    throw new Error("This reservation already has a journal execution and must be reconciled, never relaunched under that ID.");
  }
}
export function reserveFixedExecution(actor: FixedLeaderActor, kind: TaskAction | "planning" | "triage", slot?: FixedSlot, reservedExecutionId?: string, approvedSelection?: string): { execution: FixedExecution; context: FixedLaunchContext } {
  assertNoJournalExecution(actor.tabId, reservedExecutionId);
  assertHeavySlotFree();
  const { task, action, reserved, requested, selection } = selectFixedExecution(actor, kind, slot, reservedExecutionId);
  if (approvedSelection !== undefined && JSON.stringify(selection) !== approvedSelection) throw new Error("The selected position changed while approving.");
  admitJournalExecution(dataRoot, actor.tabId, task, (runId) => fixedArchiveRuntimeBlocked(actor.tabId, runId));
  let executionId = reserved?.id ?? randomUUID();
  if (action && task && !reserved) {
    const result = applyTaskEvent(actor.tabId, task, { type: "action", action, sessionId: executionId,
      batch: action.kind === "fix" ? task.findings.filter((f) => f.real && task.triage[f.id]?.outcome === "FIX" && !task.reviews.some((r) => r.resolved.includes(f.id))).map((f) => f.id) : [] }, fixedTasks.actor("leader", actor.sessionId));
    executionId = result.executionId!;
  }
  const execution: FixedExecution = { id: executionId, tabId: actor.tabId, taskId: task?.id ?? null, planVersion: task?.planVersion ?? 0,
    role: requested, ...selection, kind: action?.kind ?? kind as "planning" | "triage", status: "reserved", processEnded: false, consumed: false, logPath: null };
  const next = executionJournal(dataRoot, actor.tabId);
  assertNoJournalExecution(actor.tabId, execution.id, next);
  next.activeExecutionId = execution.id;
  next.executions.push(execution);
  saveJournal(dataRoot, actor.tabId, next);
  const context = { actor, executionId, assignmentDigest: JSON.stringify(fixedCrewOf(tabLocation(actor.tabId)!.tab).preferences[execution.selectedSlot]) };
  contexts.add(context);
  return { execution, context };
}
export function fixedExecution(tabId: string, runId: string): FixedExecution {
  const execution = executionJournal(dataRoot, tabId).executions.find((e) => e.id === runId);
  if (!execution) throw new Error("Unknown server-bound fixed execution.");
  return execution;
}
export function assertFixedTaskLaunch(tabId: string, slot: string, context?: FixedLaunchContext): void {
  assertWorkspaceRecoveryReady("worker-launch");
  const tab = tabLocation(tabId)?.tab;
  if (!tab || !isFixedTab(tab)) return;
  fixedCrewOf(tab);
  if (!context || !contexts.has(context) || context.actor.tabId !== tabId || !isCurrentFixedLeader(context.actor)) throw new Error("Fixed actions must be requested through the current leader.");
  const execution = fixedExecution(tabId, context.executionId);
  if (execution.role !== slot || execution.status !== "reserved" || executionJournal(dataRoot, tabId).activeExecutionId !== execution.id) throw new Error("Invalid or stale fixed reservation.");
  if (JSON.stringify(fixedCrewOf(tab).preferences[execution.selectedSlot]) !== context.assignmentDigest) throw new Error("The assignment changed while approving. Request this action again.");
  requireFixedAssignment(tabId, execution.selectedSlot);
  const task = fixedTasks.get(tabId);
  if (execution.taskId !== (task?.id ?? null) || execution.planVersion !== (task?.planVersion ?? 0)) throw new Error("The task changed while approving.");
  if (task && !["planning", "triage"].includes(execution.kind)) {
    applyTaskEvent(tabId, task, { type: "start", executionId: execution.id }, fixedTasks.actor("leader", context.actor.sessionId));
  }
  const next = executionJournal(dataRoot, tabId);
  next.executions.find((e) => e.id === execution.id)!.status = "running";
  saveJournal(dataRoot, tabId, next);
  contexts.delete(context);
}
export function fixedWorkerPrompt(tabId: string, runId: string, brief: string): string {
  const execution = fixedExecution(tabId, runId);
  const fixed = fixedCrewOf(tabLocation(tabId)!.tab);
  return composeCrewRolePrompt(execution.role, fixed.roleExtras[execution.role] ?? "", `${brief}\n\n${reportInstructions(execution)}`);
}
export function fixedRunLog(tabId: string, runId: string, logPath: string): void {
  const next = executionJournal(dataRoot, tabId);
  const execution = next.executions.find((e) => e.id === runId);
  if (!execution) { assertRetiredExecution(dataRoot, tabId, runId); return; }
  execution.logPath = logPath;
  saveJournal(dataRoot, tabId, next);
}
export function fixedRunStatus(tabId: string, runId: string, status: "done" | "failed" | "stopped"): void {
  const next = executionJournal(dataRoot, tabId);
  const execution = next.executions.find((e) => e.id === runId);
  if (!execution) { assertRetiredExecution(dataRoot, tabId, runId); return; }
  if (execution.consumed) return;
  execution.status = execution.processEnded ? status === "done" ? "done" : "failed" : "interrupted";
  saveJournal(dataRoot, tabId, next);
  if (status !== "done") {
    const task = fixedTasks.get(tabId), run = task?.executions.find((e) => e.id === runId);
    if (task && run?.status === "running") applyTaskEvent(tabId, task, { type: "result", executionId: runId, taskId: task.id, planVersion: task.planVersion,
      role: run.role, success: false, processEnd: execution.processEnded ? "confirmed" : "unknown", evidence: [] }, fixedTasks.actor(run.role, run.sessionId));
  }
}
export function fixedTreeEnd(tabId: string, runId: string, confirmed: boolean): void { recordTreeEnd(dataRoot, tabId, runId, confirmed); }
export function rejectFixedLaunch(tabId: string, runId: string): void {
  fixedTreeEnd(tabId, runId, true);
  fixedRunStatus(tabId, runId, "failed");
  const task = fixedTasks.get(tabId), execution = task?.executions.find((e) => e.id === runId);
  if (task && execution?.status === "running") applyTaskEvent(tabId, task, { type: "result", executionId: runId, taskId: task.id, planVersion: task.planVersion,
    role: execution.role, success: false, processEnd: "confirmed", evidence: [] }, fixedTasks.actor(execution.role, execution.sessionId));
}
