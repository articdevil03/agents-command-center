import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { sep } from "node:path";
import { archiveJson, archiveHash, byteIdentity, archivePath, publishImmutable } from "../server/fixed-crew/task-archive-files.ts";
import { executionArchiveBytes, publishExecutionArchive } from "../server/fixed-crew/task-journal-archive.ts";
import type { Task } from "../server/fixed-crew/task-types.ts";
import type { FixedExecution } from "../server/fixed-crew/task-execution.ts";

// Inject at real synced publication boundaries. Restore builtins before a
// retry or another test; no production-only fault injection seam is added.
export async function failPublication<T>(suffix: string, operation: () => Promise<T>, after = false) {
  const original = { linkSync: fs.linkSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync };
  let matched = 0;
  const matches = (file: fs.PathLike) => String(file).split(sep).join("/").endsWith(suffix);
  const wrap = (name: "linkSync" | "renameSync") => ((from: fs.PathLike, to: fs.PathLike) => {
    if (matches(to) && ++matched === 1) {
      if (after) original[name](from, to);
      throw new Error(`Run 4 injected publication failure: ${suffix}`);
    }
    return original[name](from, to);
  });
  fs.linkSync = wrap("linkSync"); fs.renameSync = wrap("renameSync");
  fs.unlinkSync = ((file: fs.PathLike) => {
    if (matches(file) && ++matched === 1) throw new Error(`Run 4 injected retirement failure: ${suffix}`);
    return original.unlinkSync(file);
  });
  syncBuiltinESMExports();
  try {
    const result = await operation();
    assert.equal(matched, 1, `publication target found exactly once: ${suffix}`);
    return result;
  } finally { Object.assign(fs, original); syncBuiltinESMExports(); }
}

// Fixture data for the directory-count contract, built from history that was
// actually completed through tools. Each archive has distinct bound run IDs.
export function archiveCopy(root: string, tabId: string, taskId: string, task: Task, executions: FixedExecution[]) {
  const ids = new Map(executions.map((run, n) => [run.id, `${taskId}-run-${n}`]));
  const source = structuredClone(task);
  source.id = taskId;
  source.coordinatorSessions = source.coordinatorSessions.map((id) => ids.get(id) ?? id);
  for (const run of source.executions) { run.id = ids.get(run.id)!; run.taskId = taskId; }
  for (const entry of [...source.checks, ...source.reviews, ...source.checkpoints, ...source.findings]) entry.executionId = ids.get(entry.executionId)!;
  for (const review of source.reviews) if (review.baseFinal) review.baseFinal = ids.get(review.baseFinal)!;
  for (const request of source.requests) if (request.result.executionId) request.result.executionId = ids.get(request.result.executionId)!;
  const runs = executions.map((run) => ({ ...run, id: ids.get(run.id)!, taskId: run.taskId === task.id ? taskId : run.taskId }));
  const sourceBytes = archiveJson(source), completed = archiveJson({ ...source, stage: "complete" });
  const manifest = { version: 1, tabId, taskId, planVersion: source.planVersion, recordRevision: source.recordRevision,
    reason: "Distinct pagination fixture from an accepted task", completedAt: new Date().toISOString(),
    source: byteIdentity(sourceBytes), task: byteIdentity(completed), executions: runs.map((run) => ({ id: run.id, ...byteIdentity(executionArchiveBytes(run)) })) };
  publishImmutable(archivePath(root, tabId, taskId, "source.json"), sourceBytes);
  publishImmutable(archivePath(root, tabId, taskId, "task.json"), completed);
  for (const run of runs) publishExecutionArchive(root, tabId, run);
  const bytes = archiveJson(manifest);
  publishImmutable(archivePath(root, tabId, taskId, "manifest.json"), bytes);
  publishImmutable(archivePath(root, tabId, taskId, "complete.json"), archiveJson({ version: 1, tabId, taskId, manifestHash: archiveHash(bytes) }));
}
