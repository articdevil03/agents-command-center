import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LeaderToolSpec, ToolContent } from "../leader-tools.ts";
import { fixedCrewOf, isFixedTab } from "../fixed-crew/runtime.ts";
import { FIXED_CREW, type Assignment, type FixedSlot } from "../fixed-crew/roster.ts";
import { executionJournal, saveJournal, readJournalSnapshot, type Journal } from "../fixed-crew/task-execution.ts";
import { authenticTaskRequest, cancelledTaskOnly, taskOnlyResultProvenance } from "../fixed-crew/task-request-proof.ts";
import { readWorkerReport } from "../fixed-crew/task-reports.ts";
import { fingerprint } from "../fixed-crew/task-revision.ts";
import type { TaskAction } from "../fixed-crew/task-gates.ts";
import { id, text, type Task } from "../fixed-crew/task-types.ts";
import { isRunning } from "../runner.ts";
import { askApproval } from "./approvals.ts";
import { broadcast, stateMessage } from "./broadcast.ts";
import { launchWorker } from "./launch.ts";
import { announceFolderBusy } from "./launch-gates.ts";
import { executeFixedGit, fixedGitOperations } from "./fixed-task-actions.ts";
import { applyTaskEvent, fixedExecution, fixedArchiveRuntimeBlocked, isCurrentFixedLeader, requireFixedAssignment, selectFixedExecution, reserveFixedExecution, rejectFixedLaunch, type FixedLeaderActor } from "./fixed-task-launch.ts";
import { listTaskArchives, readTaskArchive, readExecutionArchive, optionalArchiveBytes, readArchiveBytes } from "../fixed-crew/task-archive-files.ts";
import { join } from "node:path";
import { completionExecutions } from "../fixed-crew/task-journal-archive.ts";
import { effectiveMode, tabLocation } from "./tabs.ts";
import { dataRoot, fixedTasks, leaders, runRecords, launchSafety } from "./state.ts";
import { assertTaskRecoveryReady, assertWorkspaceRecoveryReady } from "../fixed-crew/recovery.ts";

type Expected = { taskId: string; planVersion: number; recordRevision: number } | null;
function currentTask(actor: FixedLeaderActor, expected: Expected): Task | null {
  assertTaskRecoveryReady();
  if (!isCurrentFixedLeader(actor)) throw new Error("The leader instance is no longer current.");
  const task = fixedTasks.get(actor.tabId);
  if (expected === null ? task !== null : !task || expected.taskId !== task.id || expected.planVersion !== task.planVersion || expected.recordRevision !== task.recordRevision) throw new Error("Stale task identity or version. Read the current task first.");
  return task;
}
function cancelUnlaunchedTask(actor: FixedLeaderActor, task: Task, runId: string, reason: string, journal: Journal) {
  // Journal-backed executions always use the existing process-ended route.
  if (journal.executions.some((entry) => entry.id === runId)) return null;
  const store = fixedTasks, root = dataRoot, tab = tabLocation(actor.tabId)?.tab, folder = tab?.folder;
  const leader = leaders.get(actor.tabId), run = task.executions.find((entry) => entry.id === runId)!;
  if (!tab || !isFixedTab(tab) || !folder || run.taskId !== task.id || run.planVersion !== task.planVersion) throw new Error("The task-only reservation identity changed.");
  fixedCrewOf(tab);
  const fixedSnapshot = JSON.stringify(tab.fixedCrew);
  if (!authenticTaskRequest(task, run)) throw new Error("No authentic original action receipt for this reservation.");
  if (taskOnlyResultProvenance(task, run)) throw new Error("Positive result provenance cannot be abandoned as never launched.");
  const settled = cancelledTaskOnly(run);
  if (!settled && (!["reserved", "interrupted"].includes(run.status) || run.processEnd !== "unknown")) throw new Error("Not an unconsumed task-only reservation.");
  const diskJournal = readJournalSnapshot(root, actor.tabId);
  const diskTask = JSON.parse(readArchiveBytes(join(root, "tasks", `${actor.tabId}.json`)).toString("utf8"));
  if (JSON.stringify(diskTask) !== JSON.stringify(task)) throw new Error("The task source changed before cancellation.");
  if (JSON.stringify(diskJournal) !== JSON.stringify(journal)) throw new Error("Current journal disk facts differ from the retained journal.");
  if (journal.activeExecutionId && journal.activeExecutionId !== runId) throw new Error("Another execution owns the active reservation.");
  let archiveAbsent = false;
  try { readExecutionArchive(root, actor.tabId, runId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") archiveAbsent = true; else throw error; }
  if (!archiveAbsent) throw new Error("An archived admission cannot be cancelled as never launched.");
  if (taskOnlyRuntimeBlocked(actor.tabId, runId, root)) throw new Error("Runtime or persisted launch facts contradict no admission.");
  // No await: bind the captured authority/location and exact task again at publication.
  if (fixedTasks !== store || dataRoot !== root || tabLocation(actor.tabId)?.tab !== tab || tab.folder !== folder
    || !isFixedTab(tab) || JSON.stringify(tab.fixedCrew) !== fixedSnapshot || leaders.get(actor.tabId) !== leader || !isCurrentFixedLeader(actor)
    || JSON.stringify(store.get(actor.tabId)) !== JSON.stringify(task)) throw new Error("Captured task-only authority or location changed.");
  if (!settled) store.cancelUnlaunched({ tabId: actor.tabId, taskId: task.id, planVersion: task.planVersion,
    recordRevision: task.recordRevision, requestId: randomUUID() }, runId, run.sessionId, reason, store.actor("leader", actor.sessionId));
  broadcast(stateMessage());
  return { runId, reconciled: true, task: store.get(actor.tabId) };
}
function taskOnlyRuntimeBlocked(tabId: string, runId: string, root: string, checkRecord = true): boolean {
  const bytes = optionalArchiveBytes(join(root, "config", "launch-safety.json"));
  const saved = bytes ? JSON.parse(bytes.toString("utf8")) : { live: [], uncertain: [] };
  for (const key of ["live", "uncertain"]) if (saved[key] !== undefined && !Array.isArray(saved[key])) throw new Error("Unreadable persisted launch facts.");
  return fixedArchiveRuntimeBlocked(tabId, runId) || checkRecord && runRecords.has(runId)
    || [...launchSafety.live, ...launchSafety.uncertain, ...(saved.live ?? []), ...(saved.uncertain ?? [])]
      .some((entry) => !entry || entry.runId === runId || entry.seatId?.startsWith(`${tabId}.`) && !entry.runId);
}
export function reconcileTaskExecution(actor: FixedLeaderActor, expected: Expected, runId: string, reason: string) {
  assertWorkspaceRecoveryReady("task-reconciliation");
  id(runId); text(reason);
  const task = currentTask(actor, expected);
  const tab = tabLocation(actor.tabId)?.tab;
  if (!tab || !isFixedTab(tab)) throw new Error("A current fixed crew tab is required.");
  fixedCrewOf(tab);
  // All checks and both publications are synchronous on the current store/root/tab.
  const journal = executionJournal(dataRoot, actor.tabId);
  const execution = journal.executions.find((e) => e.id === runId);
  if (task?.executions.some((entry) => entry.id === runId)) {
    const cancelled = cancelUnlaunchedTask(actor, task, runId, reason, journal);
    if (cancelled) return cancelled;
  }
  const unusedPlanner = execution?.role === "planner" && ["planning", "triage"].includes(execution.kind)
    && (execution.taskId === null && execution.planVersion === 0 && execution.kind === "planning"
      || task && execution.taskId === task.id && Number.isSafeInteger(execution.planVersion)
        && execution.planVersion >= 1 && execution.planVersion <= task.planVersion);
  if (!execution || execution.tabId !== actor.tabId || !unusedPlanner && (execution.taskId !== (task?.id ?? null)
    || execution.planVersion !== (task?.planVersion ?? 0))) throw new Error("The journal execution does not match the current task identity.");
  if (journal.activeExecutionId && journal.activeExecutionId !== runId) throw new Error("Another execution owns the active reservation.");
  const run = task?.executions.find((e) => e.id === runId);
  const journalOnly = ["planning", "triage"].includes(execution.kind);
  if (journalOnly && execution.role !== "planner") throw new Error("Only Planner reports may have journal-only provenance.");
  if (journalOnly ? !!run : !run || run.taskId !== task?.id || run.planVersion !== task?.planVersion || run.kind !== execution.kind || run.role !== execution.role) {
    throw new Error("The task execution does not match the journal execution.");
  }
  if (!task && execution.kind !== "planning") throw new Error("Only planning may precede the first task.");
  const operation = fixedGitOperations.get(runId);
  if (operation && (operation.tabId !== actor.tabId || !operation.terminal || !operation.treesEnded || operation.cancelChild || operation.cleanup.size !== 0)) {
    throw new Error("Git operation still has an unsettled process tree or cleanup.");
  }
  if (isRunning(runId)) throw new Error("The runner still holds this execution as running.");
  if (execution.processEnded !== true) throw new Error("The app has not confirmed this whole process tree ended.");
  const refusedStart = !!task && !!run && run.status === "reserved" && run.processEnd === "unknown"
    && execution.status === "failed" && execution.processEnded && !execution.consumed && execution.logPath === null
    && authenticTaskRequest(task, run) && !taskOnlyResultProvenance(task, run)
    && !taskOnlyRuntimeBlocked(actor.tabId, runId, dataRoot)
    && JSON.stringify(readJournalSnapshot(dataRoot, actor.tabId)) === JSON.stringify(journal)
    && JSON.stringify(JSON.parse(readArchiveBytes(join(dataRoot, "tasks", `${actor.tabId}.json`)).toString("utf8"))) === JSON.stringify(task);
  const acceptedPlanner = journalOnly && (execution.consumed || !!task?.coordinatorSessions.includes(runId));
  if (acceptedPlanner || !journalOnly && execution.consumed || run?.verified || !(refusedStart || unusedPlanner && ["done", "failed"].includes(execution.status) || execution.status === "interrupted" || run?.status === "interrupted" || operation && !operation.finalized && operation.terminal)) {
    throw new Error("No interrupted execution or finalization brake to reconcile.");
  }
  // Publish the exact brake FIRST. A failed task write must keep all tabs held.
  journal.activeExecutionId = runId;
  execution.status = "interrupted";
  saveJournal(dataRoot, actor.tabId, journal);
  // A failed journal publication can leave this exact failed task disposition.
  // A fresh retry completes it without re-running the action or re-applying evidence.
  const taskSettled = run?.status === "failed" && run.processEnd === "confirmed" && !run.verified && !run.evidence.length && run.resultRevision === null;
  if (task && run && !taskSettled) applyTaskEvent(actor.tabId, task,
    { type: "reconcile", executionId: runId, processEnd: "confirmed", reason }, fixedTasks.actor("leader", actor.sessionId));
  execution.status = "failed"; execution.consumed = true;
  if (journal.activeExecutionId === runId) journal.activeExecutionId = null;
  saveJournal(dataRoot, actor.tabId, journal);
  fixedGitOperations.retireConfirmed(runId);
  broadcast(stateMessage());
  return { runId, reconciled: true, task: fixedTasks.get(actor.tabId) };
}
export async function launchFixedAction(actor: FixedLeaderActor, expected: Expected, action: TaskAction | "planning" | "triage", brief: string, slot?: FixedSlot, reservedExecutionId?: string) {
  const task = currentTask(actor, expected);
  if (typeof brief !== "string" || !brief.trim() || brief.length > 200_000) throw new Error("A bounded task brief is required.");
  if (slot !== undefined && !FIXED_CREW.some((seat) => seat.slot === slot)) throw new Error("Unknown crew position.");
  const before = JSON.stringify(fixedCrewOf(tabLocation(actor.tabId)!.tab));
  const leader = leaders.get(actor.tabId)!;
  const liveMode = () => {
    if (!isCurrentFixedLeader(actor) || leaders.get(actor.tabId) !== leader) throw new Error("The leader instance is no longer current.");
    return leader.getPermissionMode();
  };
  const planNow = () => effectiveMode(actor.tabId) === "plan" || liveMode() === "plan";
  if (planNow()) throw new Error("Switch out of Plan mode before starting fixed work.");
  const { selection } = selectFixedExecution(actor, action, slot, reservedExecutionId);
  const approvedSelection = JSON.stringify(selection);
  const kind = typeof action === "object" ? action.kind : action;
  const git = ["checkpoint", "commit", "push"].includes(kind);
  const position = FIXED_CREW.find((seat) => seat.slot === selection.selectedSlot)!;
  const summary = `Action: ${kind}\nPosition: ${position.role} (${selection.selectedSlot})\nExecution: ${git ? "server Git" : `${selection.assignment.cli} / ${selection.assignment.model} / ${selection.assignment.effort}`}\nFolder: ${tabLocation(actor.tabId)!.tab.folder}\n\nLeader brief:\n${brief}`;
  if (effectiveMode(actor.tabId) === "ask" || liveMode() === "default") {
    const allow = await askApproval(actor.tabId, { kind: "leader", instance: actor.instance }, "fixed-action", { command: summary });
    if (!allow) throw new Error("The owner denied this action.");
  }
  currentTask(actor, expected);
  if (planNow() || JSON.stringify(fixedCrewOf(tabLocation(actor.tabId)!.tab)) !== before) throw new Error("The assignment or permission changed while approving.");
  if (JSON.stringify(selectFixedExecution(actor, action, slot, reservedExecutionId).selection) !== approvedSelection) throw new Error("The selected position changed while approving.");
  if (typeof action === "object" && ["checkpoint", "commit", "push", "publish"].includes(action.kind)) {
    if (!task) throw new Error("A task plan is required.");
    const result = await executeFixedGit(actor, task, action, undefined, reservedExecutionId);
    broadcast(stateMessage()); return result;
  }
  const { execution, context } = reserveFixedExecution(actor, action, slot, reservedExecutionId, approvedSelection);
  const result = launchWorker(actor.tabId, execution.role, brief, "leader", announceFolderBusy(actor.tabId), undefined, context);
  if (!result.ok) { rejectFixedLaunch(actor.tabId, execution.id); throw new Error(result.error); }
  broadcast(stateMessage());
  return { runId: result.runId, selectedSlot: execution.selectedSlot, assignment: execution.assignment, reason: execution.selectionReason };
}
function boundReport(actor: FixedLeaderActor, runId: string) {
  const execution = fixedExecution(actor.tabId, runId);
  if (execution.consumed) throw new Error("This report was already accepted.");
  const record = runRecords.get(runId);
  if (!record || record.tabId !== actor.tabId || record.seatKey !== `${actor.tabId}.${execution.role}`) throw new Error("Missing server-bound run record.");
  const report = readWorkerReport(execution, record);
  return { execution, report };
}
function consume(actor: FixedLeaderActor, runId: string): void {
  const next = executionJournal(dataRoot, actor.tabId);
  next.executions.find((e) => e.id === runId)!.consumed = true;
  saveJournal(dataRoot, actor.tabId, next);
  broadcast(stateMessage());
}
export function acceptPlannerReport(actor: FixedLeaderActor, expected: Expected, runId: string) {
  const task = currentTask(actor, expected);
  const retained = executionJournal(dataRoot, actor.tabId);
  const accepted = retained.executions.find((entry) => entry.id === runId);
  if (task?.coordinatorSessions.includes(runId) && accepted?.tabId === actor.tabId
    && accepted.role === "planner" && ["planning", "triage"].includes(accepted.kind)
    && (accepted.taskId === null && accepted.planVersion === 0 && accepted.kind === "planning"
      || accepted.taskId === task.id && accepted.planVersion >= 1 && accepted.planVersion <= task.planVersion)) {
    if (accepted.status !== "done" || !accepted.processEnded || taskOnlyRuntimeBlocked(actor.tabId, runId, dataRoot, false)
      || retained.activeExecutionId !== null || runRecords.get(runId)?.status === "working"
      || JSON.stringify(readJournalSnapshot(dataRoot, actor.tabId)) !== JSON.stringify(retained)
      || JSON.stringify(JSON.parse(readArchiveBytes(join(dataRoot, "tasks", `${actor.tabId}.json`)).toString("utf8"))) !== JSON.stringify(task)) {
      throw new Error("Accepted Planner report still has contradictory journal or live reservation facts.");
    }
    if (!accepted.consumed) consume(actor, runId);
    return task;
  }
  const { execution, report } = boundReport(actor, runId);
  if (execution.role !== "planner" || !["planning", "triage"].includes(execution.kind)) throw new Error("Only the identified Planner run may supply planning or triage.");
  if (execution.taskId !== (task?.id ?? null) || execution.planVersion !== (task?.planVersion ?? 0)) throw new Error("The Planner report is stale.");
  const planner = fixedTasks.actor("planner", execution.id);
  if (execution.kind === "triage") {
    if (!task || report.plan !== null || report.findings.length) throw new Error("Expected a Planner triage report.");
    applyTaskEvent(actor.tabId, task, { type: "triage", decisions: report.decisions }, planner);
  } else {
    if (!report.plan || report.decisions.length) throw new Error("Expected a Planner plan report.");
    const seats = Object.fromEntries(FIXED_CREW.flatMap(({ slot }) => {
      const assignment = fixedCrewOf(tabLocation(actor.tabId)!.tab).preferences[slot].assignment;
      return assignment ? [[slot, assignment]] : [];
    })) as Partial<Record<FixedSlot, Assignment>>;
    // Historical executions still need their role snapshot after unassignment.
    // Live assignment checks continue to govern every future launch.
    for (const run of task?.executions ?? []) if (!seats[run.role]) seats[run.role] = task!.seats[run.role];
    if (!task) fixedTasks.create(actor.tabId, report.plan, seats, planner);
    else {
      applyTaskEvent(actor.tabId, task, { type: "plan", plan: report.plan, seats }, planner);
    }
  }
  consume(actor, runId);
  return fixedTasks.get(actor.tabId);
}
export function verifyFixedEvidence(actor: FixedLeaderActor, expected: Expected, runId: string, checkName: string | null) {
  let task = currentTask(actor, expected);
  if (!task) throw new Error("No task evidence is available.");
  const { execution, report } = boundReport(actor, runId);
  const run = task.executions.find((e) => e.id === runId);
  if (!run || execution.taskId !== task.id || execution.planVersion !== task.planVersion) throw new Error("Evidence belongs to another task version.");
  if (["review", "final", "check"].includes(run.kind) && fingerprint(tabLocation(actor.tabId)!.tab.folder, task.plan).digest !== run.revision) throw new Error("Evidence is stale. The covered content changed.");
  if (report.plan !== null || report.decisions.length || !report.evidence.length) throw new Error("Expected bounded execution evidence.");
  if (run.status === "running") {
    applyTaskEvent(actor.tabId, task, { type: "result", executionId: runId, taskId: task.id, planVersion: task.planVersion,
      role: run.role, success: true, processEnd: "confirmed", evidence: report.evidence }, fixedTasks.actor(run.role, run.sessionId));
    task = fixedTasks.get(actor.tabId)!;
  }
  applyTaskEvent(actor.tabId, task, { type: "verify", executionId: runId, checkName, findings: report.findings,
    resolved: report.resolved, baseFinal: report.baseFinal, unchanged: report.unchanged }, fixedTasks.actor("leader", actor.sessionId));
  consume(actor, runId);
  return fixedTasks.get(actor.tabId);
}
export function fixedLeaderSpecs(tabId: string, instance: object): LeaderToolSpec[] {
  const expectedShape = z.object({ taskId: z.string(), planVersion: z.number().int().positive(), recordRevision: z.number().int().positive() }).nullable();
  const actor: FixedLeaderActor = Object.freeze({ tabId, instance, sessionId: randomUUID() });
  const archiveTabReady = () => {
    assertTaskRecoveryReady();
    const tab = tabLocation(tabId)?.tab;
    if (!tab || !isFixedTab(tab)) throw new Error("A current fixed crew tab is required.");
    fixedCrewOf(tab);
  };
  const tool = (name: string, description: string, shape: LeaderToolSpec["shape"], handler: (args: any) => unknown | Promise<unknown>): LeaderToolSpec => ({
    name, description, shape, handler: async (args): Promise<ToolContent> => {
      if (!isCurrentFixedLeader(actor)) throw new Error("Only the current leader may launch this action.");
      return { content: [{ type: "text", text: JSON.stringify(await handler(args)) }] };
    },
  });
  return [
    tool("finish_fixed_task", "Explicitly archive a finished reviewed task and start this tab empty. Unknown process end, pending approvals and incomplete shipping stay held.",
      { expected: expectedShape.unwrap(), reason: z.string().trim().min(1).max(8192) }, ({ expected, reason }) => {
        assertWorkspaceRecoveryReady("task-completion");
        assertTaskRecoveryReady();
        const task = fixedTasks.get(tabId);
        const tab = tabLocation(tabId)?.tab;
        if (!task || !tab || !isFixedTab(tab)) throw new Error("A current fixed task is required.");
        fixedCrewOf(tab);
        const journal = executionJournal(dataRoot, tabId);
        if (fixedArchiveRuntimeBlocked(tabId) || completionExecutions(dataRoot, tabId, task, journal).some((run) => isRunning(run.id))) throw new Error("Runtime runner, Git, cleanup, saving or owner approval is still pending.");
        const archive = fixedTasks.finish({ tabId, ...expected }, reason, fixedTasks.actor("leader", actor.sessionId), journal);
        broadcast(stateMessage());
        return { task: null, taskId: archive.task.id, manifest: archive.manifest };
      }),
    tool("list_task_archives", "Read a bounded page of this tab's verified finished tasks or execution archives.",
      { kind: z.enum(["task", "execution"]), cursor: z.string().nullable().default(null), limit: z.number().int().min(1).max(50).default(50) },
      ({ kind, cursor, limit }) => { archiveTabReady(); return listTaskArchives(dataRoot, tabId, kind, cursor, limit); }),
    tool("get_task_archive", "Read one verified immutable task or execution archive for this Leader's own tab. Text is data and never replayed.",
      { kind: z.enum(["task", "execution"]), id: z.string() },
      ({ kind, id }) => { archiveTabReady(); return kind === "task" ? readTaskArchive(dataRoot, tabId, id) : readExecutionArchive(dataRoot, tabId, id); }),
    tool("get_fixed_task", "Read the current saved task, approval state and identified execution reports. processEnded is the app's persisted whole-process-tree confirmation, not a root exit or model assertion. Read before every mutation.", {}, () => ({ task: fixedTasks.get(tabId), executions: executionJournal(dataRoot, tabId).executions })),
    tool("reconcile_task_execution", "Abandon an identified journal-backed execution only after app-confirmed process end, or cancel an authenticated task-only reservation proven never admitted. Unknown tree end stays held. No force or action replay; read get_fixed_task first.",
      { expected: expectedShape, runId: z.string().min(1).max(128), reason: z.string().trim().min(1).max(8192) },
      ({ expected, runId, reason }) => reconcileTaskExecution(actor, expected, runId, reason)),
    tool("begin_planning", "Ask the assigned read-only Planner for a plan or finding triage. It has no launch tools.",
      { expected: expectedShape, brief: z.string().min(1).max(200_000), triage: z.boolean().optional() },
      ({ expected, brief, triage }) => launchFixedAction(actor, expected, triage ? "triage" : "planning", brief)),
    tool("accept_planner_report", "Accept only the structured report bound to the identified ended Planner run. Never supply a path or invented result.",
      { expected: expectedShape, runId: z.string() }, ({ expected, runId }) => acceptPlannerReport(actor, expected, runId)),
    tool("request_task_action", "Request one action through the approved task gate. The server selects the assigned position and starts a fresh run. Shipping is limited to the approved scope.",
      { expected: expectedShape, kind: z.enum(["assist", "rough", "build", "polish", "check", "visualCheck", "inspect", "review", "checkpoint", "fix", "final", "commit", "push", "publish"]),
        route: z.enum(["normal", "minimal", "postFinal"]).default("normal"), change: z.enum(["none", "minimal", "logic"]).default("none"), brief: z.string().min(1).max(200_000), reservedExecutionId: z.string().optional() },
      ({ expected, kind, route, change, brief, reservedExecutionId }) => launchFixedAction(actor, expected, { kind, route, change }, brief, undefined, reservedExecutionId)),
    tool("verify_task_evidence", "Record your independent verification of the identified successful, ended, current run. Findings and coverage come from that run's report.",
      { expected: expectedShape, runId: z.string(), checkName: z.string().nullable().default(null) },
      ({ expected, runId, checkName }) => verifyFixedEvidence(actor, expected, runId, checkName)),
  ];
}
