import { join } from "node:path";
import { assertJournalCapacity, journalHasCapacity, executionJournal, saveJournal, type FixedExecution, type Journal } from "./task-execution.ts";
import { archiveHash, archiveJson, executionArchivePath, optionalArchiveBytes, publishImmutable, readExecutionArchive } from "./task-archive-files.ts";
import { digest } from "./task-revision.ts";
import type { Task } from "./task-types.ts";
import { authenticTaskRequest, cancelledTaskOnly, taskOnlyResultProvenance } from "./task-request-proof.ts";

export function settledExecution(run: FixedExecution): boolean {
  return run.processEnded === true && (run.status === "failed" || run.status === "done" && run.consumed);
}
export function executionArchiveBytes(execution: FixedExecution): string {
  return archiveJson({ version: 1, tabId: execution.tabId, runId: execution.id, execution, hash: archiveHash(archiveJson(execution)) });
}
export function publishExecutionArchive(root: string, tabId: string, execution: FixedExecution): void {
  if (execution.tabId !== tabId || !settledExecution(execution)) throw new Error("Cannot archive an unsettled execution.");
  publishImmutable(executionArchivePath(root, tabId, execution.id), executionArchiveBytes(execution));
  if (archiveJson(readExecutionArchive(root, tabId, execution.id)) !== archiveJson(execution)) throw new Error("Execution archive verification failed.");
}
export function completionExecutions(root: string, tabId: string, task: Task, journal: Journal): FixedExecution[] {
  if (journal.activeExecutionId || journal.executions.some((run) => !settledExecution(run))) throw new Error("Journal has active, unended, interrupted or unconsumed successful work.");
  const selected = journal.executions.filter((run) => run.taskId === task.id || task.coordinatorSessions.includes(run.id));
  for (const run of task.executions) {
    let bound = journal.executions.find((entry) => entry.id === run.id);
    if (!bound) {
      try { bound = readExecutionArchive(root, tabId, run.id); }
      catch (error) {
        // Only true absence permits the authenticated task-only exception.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && cancelledTaskOnly(run)
          && authenticTaskRequest(task, run) && !taskOnlyResultProvenance(task, run)) continue;
        throw error;
      }
    }
    if (bound.tabId !== tabId || bound.taskId !== task.id || bound.planVersion !== run.planVersion
      || bound.role !== run.role || bound.kind !== run.kind || !settledExecution(bound)
      || run.verified && (!bound.consumed || bound.status !== "done")) throw new Error("Task/journal execution provenance mismatch.");
    if (!selected.some((entry) => entry.id === bound!.id)) selected.push(bound);
  }
  for (const session of task.coordinatorSessions) {
    const live = journal.executions.find((run) => run.id === session);
    let run = live;
    if (!run) {
      try { run = readExecutionArchive(root, tabId, session); }
      catch (error) {
        // createTask records its accepting Planner first. Later entries may
        // be Leader tool sessions, which legitimately have no worker journal.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && session !== task.coordinatorSessions[0]) continue;
        throw error;
      }
    }
    if (run.role === "planner") {
      if (!run.consumed || !settledExecution(run) || run.status !== "done"
        || !(run.taskId === task.id && run.planVersion <= task.planVersion || run.taskId === null && run.planVersion === 0)) throw new Error("Accepted Planner provenance mismatch.");
      if (!selected.some((entry) => entry.id === run!.id)) selected.push(run);
    }
  }
  for (const run of selected) {
    if (run.tabId !== tabId || !settledExecution(run) || run.taskId !== task.id
      && !(run.role === "planner" && run.taskId === null && run.planVersion === 0 && task.coordinatorSessions.includes(run.id))) throw new Error("Foreign archived execution.");
    if (run.taskId === task.id && run.planVersion > task.planVersion) throw new Error("Future archived execution version.");
    if (!task.executions.some((entry) => entry.id === run.id)
      && !(run.role === "planner" && ["planning", "triage"].includes(run.kind)
        && (run.status === "failed" || run.consumed && task.coordinatorSessions.includes(run.id)))) throw new Error("Journal execution has no accepted task provenance.");
  }
  return selected;
}
// Run before any task reservation is created. Only settled rows whose facts
// are no longer task evidence can leave, and only after immutable verification.
export function admitJournalExecution(root: string, tabId: string, task: Task | null, runtimeBlocked: (runId: string) => boolean): void {
  const journal = executionJournal(root, tabId);
  if (journalHasCapacity(journal.executions.length + 1)) return;
  const sourceFile = join(root, "executions", `${tabId}.json`);
  const source = optionalArchiveBytes(sourceFile, 32 * 1024 * 1024);
  const removable = journal.executions.filter((run) => run.id !== journal.activeExecutionId && settledExecution(run)
    && !runtimeBlocked(run.id) && !task?.executions.some((entry) => entry.id === run.id));
  if (!removable.length) { assertJournalCapacity(journal.executions.length + 1); return; }
  for (const run of removable) publishExecutionArchive(root, tabId, run);
  const current = optionalArchiveBytes(sourceFile, 32 * 1024 * 1024);
  if (!source || !current?.equals(source)) throw new Error("Journal source changed before reclamation.");
  const removed = new Set(removable.map((run) => run.id));
  const next = { ...journal, executions: journal.executions.filter((run) => !removed.has(run.id)) };
  assertJournalCapacity(next.executions.length + 1);
  saveJournal(root, tabId, next);
}
