import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { publishConfigFile } from "../config-files.ts";
import { keepBadCopy } from "../safe-file.ts";
import type { Assignment, FixedSlot } from "./roster.ts";
import { createTask, mustHaveFinal } from "./task-plan.ts";
import { digest, fingerprint, refuseLinks } from "./task-revision.ts";
import { transitionTask, type Actor, type Event } from "./task-transitions.ts";
import { id, integer, validateTask, type Task, type Plan } from "./task-types.ts";
import { archiveFinishedTask, resumeTaskArchive } from "./task-archive.ts";
import { archiveHash, readArchiveBytes, optionalArchiveBytes, executionArchivePath } from "./task-archive-files.ts";
import { readJournalSnapshot, type Journal } from "./task-execution.ts";
import { authenticTaskRequest, taskOnlyResultProvenance } from "./task-request-proof.ts";

export type ExpectedTask = { tabId: string; taskId: string; planVersion: number; recordRevision: number; requestId: string };
export function createTaskStore(dataRoot: string, folderFor: (tabId: string) => string) {
  const cache = new Map<string, Task | null>();
  const sourceHashes = new Map<string, string>();
  const blocked = new Map<string, string>();
  const actors = new WeakSet<object>();
  const noAdmissionCancellations = new WeakSet<object>();
  const taskDir = join(resolve(dataRoot), "tasks");
  function fileFor(tabId: string): string { id(tabId); const file = join(taskDir, `${tabId}.json`); refuseLinks(file); return file; }
  function authority(actor: Actor): void {
    if (!actors.has(actor)) throw new Error("Server actor authority required");
  }
  function validate(raw: unknown): Task {
    const task = validateTask(raw);
    if (task.planDigest !== digest({ plan: task.plan, seats: task.seats })) throw new Error("Task plan digest mismatch");
    if (task.reviewPolicy.finalRequired !== mustHaveFinal(task.plan)) throw new Error("Invalid final review policy");
    for (const revision of [task.revision, ...task.revisions]) if (digest(revision.files) !== revision.digest) throw new Error("Task coverage digest mismatch");
    return task;
  }
  function publish(task: Task): Task {
    const detached = validate(task);
    const serialized = JSON.stringify(detached, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error("Task file exceeds storage limit");
    const file = fileFor(task.tabId);
    publishConfigFile(serialized, file, true);
    sourceHashes.set(task.tabId, archiveHash(serialized));
    cache.set(task.tabId, detached);
    return structuredClone(detached);
  }
  function load(tabId: string): Task | null {
    const file = fileFor(tabId);
    try {
      if (resumeTaskArchive(dataRoot, tabId)) { cache.delete(tabId); sourceHashes.delete(tabId); blocked.delete(tabId); }
    } catch (error) {
      blocked.set(tabId, `Task rollover incomplete: ${(error as Error).message}`);
      throw error;
    }
    if (blocked.has(tabId)) throw new Error(blocked.get(tabId));
    if (cache.has(tabId)) return structuredClone(cache.get(tabId)!);
    let raw: string;
    try {
      raw = readArchiveBytes(file).toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { cache.set(tabId, null); return null; }
      blocked.set(tabId, `Task blocked: ${(error as Error).message}`); throw error;
    }
    try {
      if (raw === "null\n") { cache.set(tabId, null); sourceHashes.set(tabId, archiveHash(raw)); return null; }
      const task = validate(JSON.parse(raw));
      if (task.tabId !== tabId) throw new Error("Task belongs to a different tab");
      let interrupted = false;
      let stageInterrupted = task.executions.some((action) => action.status === "interrupted");
      for (const action of task.executions) {
        if (["reserved", "running"].includes(action.status) || action.status === "success" && !action.verified || action.processEnd !== "confirmed" && ["success", "failed"].includes(action.status)) {
          let taskOnly = false;
          try {
            const journal = readJournalSnapshot(dataRoot, tabId);
            const safetyBytes = optionalArchiveBytes(join(dataRoot, "config", "launch-safety.json"));
            const safety = safetyBytes ? JSON.parse(safetyBytes.toString("utf8")) : {};
            if (![safety.live ?? [], safety.uncertain ?? []].every(Array.isArray)) throw new Error("Unreadable launch facts");
            const launched = [...(safety.live ?? []), ...(safety.uncertain ?? [])].some((row) => !row || row.runId === action.id
              || row.seatId?.startsWith(`${tabId}.`) && !row.runId);
            taskOnly = !launched && action.status === "reserved" && action.processEnd === "unknown" && authenticTaskRequest(task, action)
              && !taskOnlyResultProvenance(task, action) && !journal.executions.some((run) => run.id === action.id)
              && !journal.activeExecutionId && !optionalArchiveBytes(executionArchivePath(dataRoot, tabId, action.id));
          } catch { /* Unreadable admission facts keep the conservative interruption. */ }
          if (!taskOnly) stageInterrupted = true;
          action.status = "interrupted";
          interrupted = true;
        }
      }
      if (interrupted) { if (stageInterrupted) task.stage = "interrupted"; task.recordRevision++; return publish(task); }
      sourceHashes.set(tabId, archiveHash(raw));
      cache.set(tabId, task); return structuredClone(task);
    } catch (error) {
      blocked.set(tabId, `Task blocked: ${(error as Error).message}`);
      throw new Error(blocked.get(tabId));
    }
  }
  function refresh(task: Task): void {
    task.revision = fingerprint(folderFor(task.tabId), task.plan);
    if (!task.revisions.some((r) => r.digest === task.revision.digest)) task.revisions.push(structuredClone(task.revision));
  }
  return {
    // Only server integrations get this factory. Browser handlers never accept
    // actor objects, role labels or worker evidence from a client.
    actor(role: Actor["role"], sessionId = randomUUID()): Actor {
      id(sessionId);
      const actor = Object.freeze({ role, sessionId }); actors.add(actor); return actor;
    },
    get: load,
    finish(expected: Omit<ExpectedTask, "requestId">, reason: string, actor: Actor, journal: Journal) {
      authority(actor);
      if (actor.role !== "leader") throw new Error("Only the server Leader can complete a task.");
      id(expected.tabId); id(expected.taskId); integer(expected.planVersion); integer(expected.recordRevision);
      const task = load(expected.tabId);
      const source = readArchiveBytes(fileFor(expected.tabId)).toString("utf8");
      if (!task || task.id !== expected.taskId || task.planVersion !== expected.planVersion || task.recordRevision !== expected.recordRevision
        || archiveHash(source) !== sourceHashes.get(expected.tabId)
        || digest(validate(JSON.parse(source))) !== digest(task)) throw new Error("Stale task identity, version or source bytes.");
      if (fingerprint(folderFor(task.tabId), task.plan).digest !== task.revision.digest) throw new Error("Task content changed before completion.");
      try {
        const archived = archiveFinishedTask(dataRoot, task, source, journal, reason);
        cache.set(task.tabId, null);
        return archived;
      } catch (error) {
        cache.delete(task.tabId);
        if (existsSync(join(taskDir, `${task.tabId}.rollover.json`))) blocked.set(task.tabId, `Task rollover incomplete: ${(error as Error).message}`);
        throw error;
      }
    },
    summary(tabId: string) {
      const task = cache.get(tabId);
      return blocked.has(tabId) ? { blocked: true, notice: blocked.get(tabId) }
        : task ? { taskId: task.id, planVersion: task.planVersion, detailRevision: task.recordRevision, stage: task.stage } : null;
    },
    create(tabId: string, plan: Plan, seats: Partial<Record<FixedSlot, Assignment>>, actor: Actor) {
      authority(actor);
      if (actor.role !== "planner") throw new Error("Only the Planner creates implementation plans");
      if (load(tabId)) throw new Error("A task already exists for this tab");
      const task = createTask(randomUUID(), tabId, plan, seats, fingerprint(folderFor(tabId), plan));
      task.coordinatorSessions.push(actor.sessionId);
      return publish(task);
    },
    apply(expected: ExpectedTask, event: Event, actor: Actor) {
      authority(actor); id(expected.requestId); id(expected.taskId); integer(expected.recordRevision); integer(expected.planVersion);
      const task = load(expected.tabId);
      if (!task || task.id !== expected.taskId) throw new Error("Task identity changed");
      const requestDigest = digest({ expected, event, actor });
      const previous = task.requests.find((r) => r.id === expected.requestId);
      if (previous) {
        if (previous.digest !== requestDigest) throw new Error("Request ID was reused with different contents");
        return structuredClone(previous.result);
      }
      if (task.recordRevision !== expected.recordRevision || task.planVersion !== expected.planVersion) throw new Error("Stale task revision");
      // Abandonment keeps the last valid revision. A plan scans its proposed coverage below.
      if (!["plan", "cancelRequest", "reconcile"].includes(event.type)) refresh(task);
      if (["leader", "planner"].includes(actor.role) && !task.coordinatorSessions.includes(actor.sessionId)) task.coordinatorSessions.push(actor.sessionId);
      const result = transitionTask(task, event, actor, noAdmissionCancellations.has(event));
      if (event.type === "plan") refresh(result.task);
      result.task.recordRevision++;
      const saved = { recordRevision: result.task.recordRevision, executionId: result.executionId };
      result.task.requests.push({ id: expected.requestId, digest: requestDigest, result: saved });
      publish(result.task);
      return structuredClone(saved);
    },
    // Only the synchronous reconciliation service supplies this no-admission
    // capability. Ordinary cancelRequest events retain reserved-only eligibility.
    cancelUnlaunched(expected: ExpectedTask, executionId: string, sessionId: string, reason: string, actor: Actor) {
      const event: Event = { type: "cancelRequest", executionId, sessionId, reason };
      noAdmissionCancellations.add(event);
      try { return this.apply(expected, event, actor); }
      finally { noAdmissionCancellations.delete(event); }
    },
    recover(tabId: string, plan: Plan, seats: Partial<Record<FixedSlot, Assignment>>, actor: Actor) {
      authority(actor);
      if (actor.role !== "planner" || !blocked.has(tabId)) throw new Error("Only the Planner can recover a blocked task");
      const file = fileFor(tabId);
      keepBadCopy(file);
      // A backup failure above leaves both the cache and original untouched.
      const next = createTask(randomUUID(), tabId, plan, seats, fingerprint(folderFor(tabId), plan));
      const task = publish(next);
      blocked.delete(tabId);
      return task;
    },
  };
}
export type TaskStore = ReturnType<typeof createTaskStore>;
