import { createHash } from "node:crypto";
import { lstatSync, openSync, fstatSync, readSync, closeSync, opendirSync } from "node:fs";
import { join, resolve } from "node:path";
import { publishConfigFile } from "../config-files.ts";
import { refuseLinks } from "./task-revision.ts";
import { ACTIONS, id, object, text, enumeration, validateTask, type Task } from "./task-types.ts";
import type { FixedExecution } from "./task-execution.ts";
import { validateAssignment } from "./assignment.ts";
import { FIXED_CREW } from "./roster.ts";
import { completionExecutions } from "./task-journal-archive.ts";

export const archiveHash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const archiveJson = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
export const byteIdentity = (bytes: string | Buffer) => ({ bytes: Buffer.byteLength(bytes), hash: archiveHash(bytes) });
export function archivePath(root: string, tabId: string, taskId?: string, leaf?: string): string {
  id(tabId);
  if (taskId !== undefined) id(taskId);
  if (leaf !== undefined && !["source.json", "task.json", "manifest.json", "complete.json"].includes(leaf)) throw new Error("Invalid archive leaf.");
  const path = join(resolve(root), "tasks", "finished", tabId, ...(taskId ? [taskId] : []), ...(leaf ? [leaf] : []));
  refuseLinks(path);
  return path;
}
export function executionArchivePath(root: string, tabId: string, runId: string): string {
  id(runId);
  const path = join(archivePath(root, tabId), "_executions", `${runId}.json`);
  refuseLinks(path);
  return path;
}
// Bound the opened handle as well as the directory entry before parsing JSON.
export function readArchiveBytes(file: string, maximum = 4 * 1024 * 1024): Buffer {
  refuseLinks(file);
  const info = lstatSync(file);
  if (!info.isFile() || info.size > maximum) throw new Error("Archive file exceeds its read budget or is not a regular file.");
  const fd = openSync(file, "r");
  try {
    const opened = fstatSync(fd);
    if (opened.size !== info.size || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error("Archive source changed while opening.");
    const bytes = Buffer.alloc(info.size + 1);
    // readFileSync on a pathname could follow a replacement. This bounded read
    // uses the already validated handle, with an extra byte detecting growth.
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size !== info.size || fstatSync(fd).size !== info.size) throw new Error("Archive source changed during read.");
    refuseLinks(file);
    const result = bytes.subarray(0, size);
    if (!Buffer.from(result.toString("utf8")).equals(result)) throw new Error("Invalid UTF-8 task/archive source.");
    return result;
  } finally { closeSync(fd); }
}
export function optionalArchiveBytes(file: string, maximum?: number): Buffer | null {
  try { return readArchiveBytes(file, maximum); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function verifyArchiveBytes(file: string, expected: string | Buffer): void {
  if (!readArchiveBytes(file, Math.max(Buffer.byteLength(expected), 1)).equals(Buffer.from(expected))) throw new Error(`Archive bytes conflict: ${file}`);
}
export function publishImmutable(file: string, bytes: string): void {
  refuseLinks(file);
  publishConfigFile(bytes, file);
  verifyArchiveBytes(file, bytes);
}
export type ArchiveManifest = {
  version: 1; tabId: string; taskId: string; planVersion: number; recordRevision: number;
  reason: string; completedAt: string; source: ReturnType<typeof byteIdentity>; task: ReturnType<typeof byteIdentity>;
  executions: { id: string; bytes: number; hash: string }[];
};
export function assertArchiveBinding(tabId: string, taskId: string, manifest: ArchiveManifest, task: Task): void {
  id(tabId); id(taskId);
  if (manifest.version !== 1 || manifest.tabId !== tabId || manifest.taskId !== taskId
    || task.tabId !== tabId || task.id !== taskId || task.stage !== "complete"
    || task.planVersion !== manifest.planVersion || task.recordRevision !== manifest.recordRevision) throw new Error("Archive identity mismatch.");
}
function verifyIdentity(bytes: Buffer, identity: { bytes: number; hash: string }): void {
  object(identity, ["bytes", "hash"]);
  if (bytes.length !== identity.bytes || archiveHash(bytes) !== identity.hash) throw new Error("Archive hash mismatch.");
}
export function readExecutionArchive(root: string, tabId: string, runId: string): FixedExecution {
  const raw = JSON.parse(readArchiveBytes(executionArchivePath(root, tabId, runId)).toString("utf8"));
  object(raw, ["version", "tabId", "runId", "execution", "hash"]);
  if (raw.version !== 1 || raw.tabId !== tabId || raw.runId !== runId || raw.execution?.id !== runId
    || raw.execution.tabId !== tabId || raw.hash !== archiveHash(archiveJson(raw.execution))) throw new Error("Execution archive identity mismatch.");
  const run = raw.execution;
  object(run, ["id", "tabId", "taskId", "planVersion", "role", "selectedSlot", "selectionReason", "assignment", "kind", "status", "processEnded", "consumed", "logPath"]);
  id(run.id); id(run.tabId); if (run.taskId !== null) id(run.taskId);
  if (!Number.isSafeInteger(run.planVersion) || run.planVersion < (run.taskId === null ? 0 : 1)) throw new Error("Invalid archived execution version.");
  for (const role of [run.role, run.selectedSlot]) enumeration(role, FIXED_CREW.map((slot) => slot.slot));
  enumeration(run.kind, [...ACTIONS, "planning", "triage"]); enumeration(run.status, ["done", "failed"]);
  enumeration(run.processEnded, [true]); enumeration(run.consumed, [true, false]);
  if (run.status === "done" && !run.consumed) throw new Error("Unconsumed success cannot be retired.");
  text(run.selectionReason); validateAssignment(run.assignment);
  if (run.logPath !== null) text(run.logPath);
  return raw.execution;
}
export function readTaskArchive(root: string, tabId: string, taskId: string) {
  const manifestBytes = readArchiveBytes(archivePath(root, tabId, taskId, "manifest.json"));
  const manifest: ArchiveManifest = JSON.parse(manifestBytes.toString("utf8"));
  object(manifest, ["version", "tabId", "taskId", "planVersion", "recordRevision", "reason", "completedAt", "source", "task", "executions"]);
  text(manifest.reason);
  if (typeof manifest.completedAt !== "string" || !manifest.completedAt.trim() || manifest.completedAt.length > 64
    || !Number.isFinite(Date.parse(manifest.completedAt))) throw new Error("Invalid archive completion time.");
  const receipt = JSON.parse(readArchiveBytes(archivePath(root, tabId, taskId, "complete.json"), 4096).toString("utf8"));
  object(receipt, ["version", "tabId", "taskId", "manifestHash"]);
  if (receipt.version !== 1 || receipt.tabId !== tabId || receipt.taskId !== taskId || receipt.manifestHash !== archiveHash(manifestBytes)) throw new Error("Archive receipt mismatch.");
  const sourceBytes = readArchiveBytes(archivePath(root, tabId, taskId, "source.json"));
  const taskBytes = readArchiveBytes(archivePath(root, tabId, taskId, "task.json"), 4 * 1024 * 1024 + 64);
  verifyIdentity(sourceBytes, manifest.source); verifyIdentity(taskBytes, manifest.task);
  const source = validateTask(JSON.parse(sourceBytes.toString("utf8")));
  const task = validateTask(JSON.parse(taskBytes.toString("utf8")));
  assertArchiveBinding(tabId, taskId, manifest, task);
  if (archiveJson({ ...source, stage: "complete" }) !== archiveJson(task)) throw new Error("Completed snapshot differs from original history.");
  if (!Array.isArray(manifest.executions) || manifest.executions.length > 2000
    || new Set(manifest.executions.map((e) => e.id)).size !== manifest.executions.length) throw new Error("Invalid archived execution inventory.");
  const executions = manifest.executions.map((entry) => {
    id(entry.id);
    const bytes = readArchiveBytes(executionArchivePath(root, tabId, entry.id));
    verifyIdentity(bytes, { bytes: entry.bytes, hash: entry.hash });
    return readExecutionArchive(root, tabId, entry.id);
  });
  const bound = completionExecutions(root, tabId, task, { version: 1, activeExecutionId: null, executions });
  if (bound.length !== executions.length) throw new Error("Archived execution inventory is incomplete.");
  return { task, executions, manifest };
}
// The shared id validator, asked as a yes/no question about a directory entry's name; archive readers' own errors are never caught.
function isArchiveId(name: string): boolean {
  try { id(name); return true; } catch { return false; }
}
export function listTaskArchives(root: string, tabId: string, kind: "task" | "execution", cursor: string | null = null, limit = 50) {
  if (!["task", "execution"].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Archive page limit must be 1..50.");
  if (cursor !== null) id(cursor);
  const base = kind === "task" ? archivePath(root, tabId) : join(archivePath(root, tabId), "_executions");
  refuseLinks(base);
  const selected: string[] = [];
  let dir;
  try { dir = opendirSync(base); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], nextCursor: null }; throw error; }
  try {
    for (let entry; (entry = dir.readSync()) !== null;) {
      if (kind === "task" && entry.name === "_executions") continue;
      const name = kind === "task" ? entry.name : entry.name.endsWith(".json") ? entry.name.slice(0, -5) : null;
      // Only an ID-shaped candidate is an archive; anything else in the folder (Thumbs.db, a stray name) is ignored and never touched.
      if (!name || name.startsWith(".") || !isArchiveId(name)) continue;
      // A candidate that is a link still refuses, before its type can make it disappear from the list.
      refuseLinks(join(base, entry.name));
      if (kind === "task" ? !entry.isDirectory() : !entry.isFile()) continue;
      if (cursor !== null && name <= cursor) continue;
      if (kind === "task" && !optionalArchiveBytes(archivePath(root, tabId, name, "complete.json"), 4096)) continue;
      selected.push(name); selected.sort();
      if (selected.length > limit + 1) selected.pop();
    }
  } finally { dir.closeSync(); }
  const items = selected.map((id) => {
    if (kind === "execution") { readExecutionArchive(root, tabId, id); return { id, kind }; }
    const archive = readTaskArchive(root, tabId, id);
    return { id, kind, scope: archive.task.plan.scope, completedAt: archive.manifest.completedAt };
  });
  return { items: items.slice(0, limit), nextCursor: selected.length > limit ? selected[limit - 1] : null };
}
