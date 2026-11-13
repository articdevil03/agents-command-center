import { unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { publishConfigFile } from "../config-files.ts";
import { assertTaskComplete } from "./task-completion.ts";
import { invalidateJournal, saveJournal, type FixedExecution, type Journal } from "./task-execution.ts";
import { completionExecutions, executionArchiveBytes, publishExecutionArchive } from "./task-journal-archive.ts";
import { archiveHash, archiveJson, archivePath, byteIdentity, executionArchivePath, optionalArchiveBytes,
  publishImmutable, readTaskArchive, verifyArchiveBytes, type ArchiveManifest } from "./task-archive-files.ts";
import { refuseLinks } from "./task-revision.ts";
import { id, object, text, validateTask, type Task } from "./task-types.ts";

type Transaction = {
  version: 1; tabId: string; taskId: string; source: string; completed: string;
  journalBefore: string | null; journalAfter: string; executions: FixedExecution[];
  manifest: ArchiveManifest; target: "null\n";
};
function transactionPath(root: string, tabId: string): string {
  id(tabId);
  const path = join(resolve(root), "tasks", `${tabId}.rollover.json`);
  refuseLinks(path);
  return path;
}
function manifestFor(tx: Omit<Transaction, "manifest">, reason: string, completedAt: string): ArchiveManifest {
  const task = validateTask(JSON.parse(tx.source));
  return { version: 1, tabId: tx.tabId, taskId: tx.taskId, planVersion: task.planVersion,
    recordRevision: task.recordRevision, reason, completedAt, source: byteIdentity(tx.source), task: byteIdentity(tx.completed),
    executions: tx.executions.map((run) => ({ id: run.id, ...byteIdentity(executionArchiveBytes(run)) })) };
}
function validateTransaction(root: string, value: unknown, tabId: string): Transaction {
  object(value, ["version", "tabId", "taskId", "source", "completed", "journalBefore", "journalAfter", "executions", "manifest", "target"]);
  if (value.version !== 1 || value.tabId !== tabId || value.target !== "null\n") throw new Error("Invalid rollover transaction identity.");
  id(value.taskId); text(value.manifest?.reason);
  if (typeof value.manifest.completedAt !== "string" || !Number.isFinite(Date.parse(value.manifest.completedAt))) throw new Error("Invalid completion time.");
  if (typeof value.source !== "string" || typeof value.completed !== "string" || typeof value.journalAfter !== "string"
    || value.journalBefore !== null && typeof value.journalBefore !== "string"
    || !Array.isArray(value.executions) || value.executions.length > 2000) throw new Error("Invalid rollover payload.");
  const task = validateTask(JSON.parse(value.source));
  if (task.tabId !== tabId || task.id !== value.taskId || Buffer.byteLength(value.source) > 4 * 1024 * 1024) throw new Error("Invalid rollover source.");
  assertTaskComplete(task);
  const completed = validateTask(JSON.parse(value.completed));
  if (archiveJson({ ...task, stage: "complete" }) !== archiveJson(completed)) throw new Error("Rollover completion history changed.");
  const tx = value as Transaction;
  if (archiveJson(manifestFor(tx, tx.manifest.reason, tx.manifest.completedAt)) !== archiveJson(tx.manifest)) throw new Error("Rollover manifest mismatch.");
  const before: Journal = tx.journalBefore === null ? { version: 1, activeExecutionId: null, executions: [] } : JSON.parse(tx.journalBefore);
  if (before.version !== 1 || !Array.isArray(before.executions)) throw new Error("Invalid rollover journal.");
  const expectedRuns = completionExecutions(root, tabId, task, before);
  if (archiveJson(expectedRuns) !== archiveJson(tx.executions)) throw new Error("Rollover task execution inventory mismatch.");
  const removed = new Set(tx.executions.map((run) => run.id));
  if (removed.size !== tx.executions.length || tx.executions.some((run) => run.tabId !== tabId)) throw new Error("Invalid rollover execution identities.");
  const after = { ...before, executions: before.executions.filter((run) => !removed.has(run.id)) };
  if (archiveJson(after) !== tx.journalAfter) throw new Error("Rollover removal inventory mismatch.");
  for (const run of before.executions.filter((run) => removed.has(run.id))) {
    if (archiveJson(run) !== archiveJson(tx.executions.find((entry) => entry.id === run.id))) throw new Error("Rollover journal provenance mismatch.");
  }
  return tx;
}
function sourceMatches(file: string, expected: string | null, maximum: number): boolean {
  const actual = optionalArchiveBytes(file, maximum);
  return expected === null ? actual === null : !!actual?.equals(Buffer.from(expected));
}
function completeTransaction(root: string, tx: Transaction): void {
  const file = join(resolve(root), "tasks", `${tx.tabId}.json`);
  const journalFile = join(resolve(root), "executions", `${tx.tabId}.json`);
  const marker = transactionPath(root, tx.tabId);
  const liveOriginal = sourceMatches(file, tx.source, 4 * 1024 * 1024);
  const liveEmpty = sourceMatches(file, tx.target, 4 * 1024 * 1024);
  const journalOriginal = sourceMatches(journalFile, tx.journalBefore, 32 * 1024 * 1024);
  const journalPruned = sourceMatches(journalFile, tx.journalAfter, 32 * 1024 * 1024);
  if ((!liveOriginal && !liveEmpty) || (!journalOriginal && !journalPruned) || liveOriginal && !journalOriginal) throw new Error("Rollover source changed; all bytes remain held.");
  // A missing required archive after destructive replacement is corruption,
  // not a prepared transaction. Never recreate it from a malformed state.
  if (liveEmpty) verifyPublishedArchive(root, tx);
  else {
    publishImmutable(archivePath(root, tx.tabId, tx.taskId, "source.json"), tx.source);
    publishImmutable(archivePath(root, tx.tabId, tx.taskId, "task.json"), tx.completed);
    for (const execution of tx.executions) publishExecutionArchive(root, tx.tabId, execution);
    publishImmutable(archivePath(root, tx.tabId, tx.taskId, "manifest.json"), archiveJson(tx.manifest));
    verifyPublishedArchive(root, tx);
  }
  if (liveOriginal) {
    if (!sourceMatches(file, tx.source, 4 * 1024 * 1024) || !sourceMatches(journalFile, tx.journalBefore, 32 * 1024 * 1024)) throw new Error("Rollover source changed before replacement.");
    publishConfigFile(tx.target, file, true);
  }
  if (!sourceMatches(file, tx.target, 4 * 1024 * 1024)) throw new Error("Empty task publication failed verification.");
  if (sourceMatches(journalFile, tx.journalBefore, 32 * 1024 * 1024)) saveJournal(root, tx.tabId, JSON.parse(tx.journalAfter));
  else if (!sourceMatches(journalFile, tx.journalAfter, 32 * 1024 * 1024)) throw new Error("Journal changed during rollover.");
  verifyArchiveBytes(file, tx.target);
  verifyArchiveBytes(journalFile, tx.journalAfter);
  invalidateJournal(root, tx.tabId);
  publishImmutable(archivePath(root, tx.tabId, tx.taskId, "complete.json"), archiveJson({ version: 1, tabId: tx.tabId,
    taskId: tx.taskId, manifestHash: archiveHash(archiveJson(tx.manifest)) }));
  readTaskArchive(root, tx.tabId, tx.taskId);
  verifyArchiveBytes(marker, archiveJson(tx));
  unlinkSync(marker);
}
function verifyPublishedArchive(root: string, tx: Transaction): void {
  verifyArchiveBytes(archivePath(root, tx.tabId, tx.taskId, "source.json"), tx.source);
  verifyArchiveBytes(archivePath(root, tx.tabId, tx.taskId, "task.json"), tx.completed);
  verifyArchiveBytes(archivePath(root, tx.tabId, tx.taskId, "manifest.json"), archiveJson(tx.manifest));
  for (const run of tx.executions) verifyArchiveBytes(executionArchivePath(root, tx.tabId, run.id), executionArchiveBytes(run));
}
export function resumeTaskArchive(root: string, tabId: string): boolean {
  // Two bounded 32-MiB journal snapshots, two task snapshots and execution
  // facts can expand when encoded as JSON strings. This is a transaction read
  // budget, not an increase to any active task or journal limit.
  const bytes = optionalArchiveBytes(transactionPath(root, tabId), 192 * 1024 * 1024);
  if (!bytes) return false;
  const tx = validateTransaction(root, JSON.parse(bytes.toString("utf8")), tabId);
  completeTransaction(root, tx);
  return true;
}
export function archiveFinishedTask(root: string, task: Task, source: string, journal: Journal, reason: string) {
  text(reason); assertTaskComplete(task);
  const executions = completionExecutions(root, task.tabId, task, journal);
  const journalFile = join(resolve(root), "executions", `${task.tabId}.json`);
  const journalBefore = optionalArchiveBytes(journalFile, 32 * 1024 * 1024)?.toString("utf8") ?? null;
  const diskJournal = journalBefore === null ? { version: 1, activeExecutionId: null, executions: [] } : JSON.parse(journalBefore);
  if (archiveJson(diskJournal) !== archiveJson(journal)) throw new Error("Journal disk/cache source mismatch.");
  const removed = new Set(executions.map((run) => run.id));
  const base = { version: 1 as const, tabId: task.tabId, taskId: task.id, source,
    // Compact serialization keeps even a valid minified source at its byte
    // limit archivable. Only the stage label and final newline can add bytes.
    completed: JSON.stringify({ ...task, stage: "complete" }) + "\n", journalBefore,
    journalAfter: archiveJson({ ...journal, executions: journal.executions.filter((run) => !removed.has(run.id)) }), executions, target: "null\n" as const };
  const tx = validateTransaction(root, { ...base, manifest: manifestFor(base, reason, new Date().toISOString()) }, task.tabId);
  publishImmutable(transactionPath(root, task.tabId), archiveJson(tx));
  completeTransaction(root, tx);
  return readTaskArchive(root, task.tabId, task.id);
}
