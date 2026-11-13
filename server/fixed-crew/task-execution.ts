import { join } from "node:path";
import { publishConfigFile } from "../config-files.ts";
import { refuseLinks } from "./task-revision.ts";
import { ACTIONS, id, object, enumeration, text } from "./task-types.ts";
import { validateAssignment } from "./assignment.ts";
import { FIXED_CREW, type Assignment, type FixedSlot } from "./roster.ts";
import type { ActionKind } from "./task-types.ts";
import { optionalArchiveBytes, readExecutionArchive } from "./task-archive-files.ts";

export type FixedExecution = {
  id: string; tabId: string; taskId: string | null; planVersion: number;
  role: FixedSlot; selectedSlot: FixedSlot; selectionReason: string; assignment: Assignment;
  kind: ActionKind | "planning" | "triage"; status: "reserved" | "running" | "done" | "failed" | "interrupted";
  processEnded: boolean; consumed: boolean; logPath: string | null;
};
export type Journal = { version: 1; activeExecutionId: string | null; executions: FixedExecution[] };
export const journalHasCapacity = (count: number): boolean => count <= 2000;
export function assertJournalCapacity(count: number): void {
  if (!journalHasCapacity(count)) throw new Error("Fixed execution journal capacity (2,000) reached; no safe settled entries can be reclaimed.");
}
const journals = new Map<string, Journal>();
const fileFor = (root: string, tabId: string) => { id(tabId); const file = join(root, "executions", `${tabId}.json`); refuseLinks(file); return file; };
export function invalidateJournal(root: string, tabId: string): void { journals.delete(fileFor(root, tabId)); }
export function readJournalSnapshot(root: string, tabId: string): Journal {
  const file = fileFor(root, tabId);
  const bytes = optionalArchiveBytes(file, 32 * 1024 * 1024);
  const journal: Journal = bytes ? JSON.parse(bytes.toString("utf8")) : { version: 1, activeExecutionId: null, executions: [] };
  object(journal, ["version", "activeExecutionId", "executions"]);
  if (journal.version !== 1 || !Array.isArray(journal.executions)) throw new Error("Invalid fixed execution journal.");
  assertJournalCapacity(journal.executions.length);
  if (journal.activeExecutionId !== null) id(journal.activeExecutionId);
  for (const execution of journal.executions) {
    object(execution, ["id", "tabId", "taskId", "planVersion", "role", "selectedSlot", "selectionReason", "assignment", "kind", "status", "processEnded", "consumed", "logPath"]);
    id(execution.id); if (execution.tabId !== tabId) throw new Error("Execution belongs to another tab.");
    if (execution.taskId !== null) id(execution.taskId);
    if (!Number.isSafeInteger(execution.planVersion) || execution.planVersion < (execution.taskId === null ? 0 : 1)) throw new Error("Invalid journal execution version.");
    for (const role of [execution.role, execution.selectedSlot]) enumeration(role, FIXED_CREW.map((slot) => slot.slot));
    enumeration(execution.kind, [...ACTIONS, "planning", "triage"]); text(execution.selectionReason);
    if (execution.logPath !== null) text(execution.logPath);
    validateAssignment(execution.assignment);
    enumeration(execution.status, ["reserved", "running", "done", "failed", "interrupted"]);
    enumeration(execution.processEnded, [true, false]); enumeration(execution.consumed, [true, false]);
  }
  if (new Set(journal.executions.map((entry) => entry.id)).size !== journal.executions.length) throw new Error("Duplicate journal execution.");
  if (journal.activeExecutionId && !journal.executions.some((e) => e.id === journal.activeExecutionId)) throw new Error("Missing active fixed execution.");
  return journal;
}
export function executionJournal(root: string, tabId: string): Journal {
  const file = fileFor(root, tabId);
  if (journals.has(file)) return structuredClone(journals.get(file)!);
  const journal = readJournalSnapshot(root, tabId);
  let changed = false;
  for (const execution of journal.executions) {
    // A restart never replays an operation, including an external operation with an unknown outcome.
    if (["reserved", "running"].includes(execution.status) || !execution.processEnded) {
      execution.status = "interrupted"; changed = true;
    }
  }
  if (journal.activeExecutionId && !journal.executions.some((e) => e.id === journal.activeExecutionId)) throw new Error("Missing active fixed execution.");
  if (changed) saveJournal(root, tabId, journal);
  else journals.set(file, journal);
  return structuredClone(journal);
}
export function saveJournal(root: string, tabId: string, journal: Journal): void {
  assertJournalCapacity(journal.executions.length);
  const file = fileFor(root, tabId);
  publishConfigFile(JSON.stringify(journal, null, 2) + "\n", file, true);
  journals.set(file, structuredClone(journal));
}
export function assertExecutionEnded(execution: FixedExecution): void {
  if (!execution.processEnded) throw new Error("The previous process tree has not been confirmed ended.");
}
export function recordTreeEnd(root: string, tabId: string, runId: string, confirmed: boolean): void {
  const next = executionJournal(root, tabId);
  const execution = next.executions.find((e) => e.id === runId);
  if (!execution) { assertRetiredExecution(root, tabId, runId); return; }
  if (execution.consumed) return;
  execution.processEnded = confirmed;
  if (!confirmed) execution.status = "interrupted";
  if (confirmed && next.activeExecutionId === runId) next.activeExecutionId = null;
  saveJournal(root, tabId, next);
}
export function assertRetiredExecution(root: string, tabId: string, runId: string): void {
  const archived = readExecutionArchive(root, tabId, runId);
  if (!archived.processEnded || !["done", "failed"].includes(archived.status)
    || archived.status === "done" && !archived.consumed) throw new Error("Unknown or unsettled retired execution.");
}
