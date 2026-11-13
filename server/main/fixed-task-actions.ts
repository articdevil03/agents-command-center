import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprint } from "../fixed-crew/task-revision.ts";
import { assertTaskGate, type TaskAction } from "../fixed-crew/task-gates.ts";
import { type Task } from "../fixed-crew/task-types.ts";
import { type WorkerReport } from "../fixed-crew/task-reports.ts";
import { assertFixedTaskLaunch, fixedRunLog, fixedRunStatus, fixedTreeEnd, isCurrentFixedLeader,
  reserveFixedExecution, type FixedLeaderActor } from "./fixed-task-launch.ts";
import { dataRoot, fixedTasks, runRecords, leaders } from "./state.ts";
import { tabLocation, effectiveMode } from "./tabs.ts";
import { fixedCrewOf } from "../fixed-crew/runtime.ts";
import { createGitOperations } from "../fixed-crew/git-operations.ts";
import { runGitCommand, type GitCommandResult } from "../fixed-crew/git-process.ts";
import { executionJournal, saveJournal } from "../fixed-crew/task-execution.ts";

export const fixedGitOperations = createGitOperations();
export type GitBoundary = (folder: string, args: string[]) => string | Promise<string>;
let fixedGitCommand: GitBoundary | undefined;
export function setFixedGitBoundaryForTests(command: GitBoundary): void {
  if (process.env.CC_TEST_FAKE_CLI !== "1") throw new Error("Git injection requires the fake CLI harness.");
  fixedGitCommand = command;
}
export function assertFixedTaskAction(task: Task, action: TaskAction, actor: FixedLeaderActor, revision: string, reservedExecutionId?: string): void {
  if (!isCurrentFixedLeader(actor)) throw new Error("Only the current leader may launch this action.");
  if (task.tabId !== actor.tabId || task.revision.digest !== revision) throw new Error("The reviewed content changed. Run the required checks and review again.");
  assertTaskGate(task, action, reservedExecutionId ? task.executions.find((e) => e.id === reservedExecutionId) : undefined);
}
// The operation is a fixed argv, never a command string supplied by a model.
// Arbitrary CLI commands remain outside Command Center's operation gate.
export async function executeFixedGit(actor: FixedLeaderActor, task: Task, action: TaskAction, command: GitBoundary | undefined = fixedGitCommand, reservedExecutionId?: string) {
  task = structuredClone(task); action = { ...action };
  const tab = tabLocation(actor.tabId)!.tab;
  const folder = tab.folder, store = fixedTasks, root = dataRoot, leader = leaders.get(actor.tabId)!;
  const revision = fingerprint(folder, task.plan).digest;
  assertFixedTaskAction(task, action, actor, revision, reservedExecutionId);
  if (!["checkpoint", "commit", "push"].includes(action.kind)) throw new Error("No approved publish target is configured. History rewrites, live database migrations and store submissions require separate owner approval.");
  if (command && process.env.CC_TEST_FAKE_CLI !== "1") throw new Error("Git injection requires the fake CLI harness.");
  fixedGitOperations.assertOpen();
  const savedMode = effectiveMode(actor.tabId), liveMode = leader.getPermissionMode();
  const assignments = JSON.stringify(fixedCrewOf(tab));
  const { execution, context } = reserveFixedExecution(actor, action, undefined, reservedExecutionId);
  const operation = fixedGitOperations.register(execution.id, actor.tabId, actor.instance);
  let expectedRevision = task.recordRevision + (reservedExecutionId ? 0 : 1);
  let lastResult: GitCommandResult | null = null, accepted = false, failure: unknown;
  const logPath = join(root, "execution-logs", `${execution.id}.log`);
  let logReady = false;
  function retainFinalizationBrake(): void {
    const journal = executionJournal(root, actor.tabId), old = journal.executions.find((e) => e.id === execution.id);
    if (!old || old.taskId !== task.id || old.planVersion !== task.planVersion) return;
    old.status = "interrupted";
    old.processEnded = operation.treesEnded && !operation.cleanup.size;
    // Finalization uncertainty is separate from process uncertainty. Keep the reservation even for a known-ended tree.
    if (!journal.activeExecutionId || journal.activeExecutionId === execution.id) journal.activeExecutionId = execution.id;
    saveJournal(root, actor.tabId, journal);
  }
  function authority(): Task {
    if (operation.cancelled) throw new Error("Git operation was cancelled.");
    if (!isCurrentFixedLeader(actor) || leaders.get(actor.tabId) !== leader) throw new Error("The current Leader changed during Git.");
    if (fixedTasks !== store || dataRoot !== root || tabLocation(actor.tabId)?.tab !== tab || tab.folder !== folder) throw new Error("The task store, tab or folder changed during Git.");
    const current = store.get(actor.tabId);
    if (!current || current.id !== task.id || current.planVersion !== task.planVersion || current.recordRevision !== expectedRevision
      || current.revision.digest !== revision) throw new Error("The task identity, version or expected revision changed during Git.");
    if (effectiveMode(actor.tabId) !== savedMode || leader.getPermissionMode() !== liveMode || JSON.stringify(fixedCrewOf(tab)) !== assignments
      || JSON.stringify(current.seats) !== JSON.stringify(task.seats)) throw new Error("The approved permission, assignment or selection changed during Git.");
    const journal = executionJournal(root, actor.tabId), bound = journal.executions.find((e) => e.id === execution.id);
    if (journal.activeExecutionId !== execution.id || !bound || bound.status !== "running" || bound.processEnded
      || bound.taskId !== task.id || bound.planVersion !== task.planVersion || bound.selectedSlot !== execution.selectedSlot
      || JSON.stringify(bound.assignment) !== JSON.stringify(execution.assignment)) throw new Error("The Git execution reservation changed.");
    assertTaskGate(current, action, current.executions.find((e) => e.id === execution.id));
    return current;
  }
  function fresh(): void {
    authority();
    if (fingerprint(folder, task.plan).digest !== revision) throw new Error("Pack content changed during the Git action.");
  }
  const run = async (...args: string[]) => {
    authority();
    lastResult = null;
    if (command) {
      try { lastResult = { command: "success", treeEnded: true, stdout: await command(folder, args), stderr: "", reason: null, code: 0, signal: null }; }
      catch (error) { lastResult = { command: "failure", treeEnded: true, stdout: "", stderr: "", reason: String(error), code: null, signal: null }; }
    } else lastResult = await runGitCommand(operation, folder, args);
    // Retain observed command facts even when authority or cleanup verification rejects the operation.
    appendFileSync(logPath, JSON.stringify({ type: "git-command", args, ...lastResult }) + "\n");
    authority();
    if (lastResult.command !== "success" || !lastResult.treeEnded || lastResult.reason) throw new Error(lastResult.reason ?? `Git failed (${lastResult.code}); tree end ${lastResult.treeEnded ? "confirmed" : "unknown"}.`);
    return lastResult.stdout;
  };
  try {
    assertFixedTaskLaunch(actor.tabId, "leader", context);
    expectedRevision++;
    authority();
    mkdirSync(join(root, "execution-logs"), { recursive: true });
    writeFileSync(logPath, "", "utf8"); logReady = true;
    fixedRunLog(actor.tabId, execution.id, logPath);
    runRecords.set(execution.id, { tabId: actor.tabId, seatKey: `${actor.tabId}.leader`, status: "working", outcome: null, logPath });
    if ((await run("rev-parse", "--is-inside-work-tree")).trim() !== "true") throw new Error("Git checkpoint and shipping are unavailable outside a Git repository.");
    const before = (await run("rev-parse", "HEAD")).trim();
    if (!/^[a-f0-9]{40,64}$/.test(before)) throw new Error("Git did not identify the current commit.");
    const owned = task.plan.paths;
    if (action.kind !== "push") {
      const staged = (await run("diff", "--cached", "--name-only", "-z")).split("\0").filter(Boolean);
      if (staged.some((name) => owned.some((p) => name === p || name.startsWith(p + "/")))) throw new Error("Pack files already have staged changes. Separate them before the checkpoint.");
      const pending = await run("status", "--porcelain=v1", "-z", "--", ...owned);
      if (!pending) throw new Error("There are no pack-owned changes to commit.");
      fresh();
      // --only leaves unrelated staged content out of the commit.
      await run("add", "--", ...owned);
      fresh();
      await run("commit", "--only", "-m", action.kind === "checkpoint" ? `checkpoint: ${task.plan.scope}` : task.plan.scope, "--", ...owned);
      const hash = (await run("rev-parse", "HEAD")).trim();
      const committed = (await run("diff-tree", "--no-commit-id", "--name-only", "-r", "-z", hash)).split("\0").filter(Boolean);
      if (!/^[a-f0-9]{40,64}$/.test(hash) || hash === before || !committed.length
        || committed.some((name) => !owned.some((p) => name === p || name.startsWith(p + "/")))) throw new Error("Git did not verify a commit containing only pack-owned files.");
      if (action.kind === "checkpoint" && (await run("log", "-1", "--format=%s")).replace(/\r?\n$/, "") !== `checkpoint: ${task.plan.scope}`) throw new Error("Git did not verify the checkpoint name.");
    } else {
      if (await run("status", "--porcelain=v1", "-z", "--", ...owned)) throw new Error("Commit the reviewed pack before pushing.");
      const outgoing = (await run("diff", "--name-only", "-z", "@{upstream}", "HEAD")).split("\0").filter(Boolean);
      if (outgoing.some((name) => !owned.some((p) => name === p || name.startsWith(p + "/")))) throw new Error("The outgoing commits include files outside this pack. Separate them before pushing.");
      fresh();
      await run("push");
      if ((await run("rev-parse", "@{upstream}")).trim() !== before) throw new Error("Git did not verify the pushed commit.");
    }
    fresh();
    const report: WorkerReport = { version: 1, runId: execution.id, taskId: task.id, planVersion: task.planVersion,
      evidence: [...task.plan.paths], plan: null, findings: [], resolved: [], baseFinal: null, unchanged: [], decisions: [] };
    appendFileSync(logPath, `CC_REPORT_BEGIN\n${JSON.stringify(report)}\nCC_REPORT_END\n`);
    authority();
    accepted = true;
  } catch (error) {
    failure = error;
  } finally {
    // No new child can start after this point, including after cancellation or a late callback.
    operation.terminal = true;
    let persisted = false;
    try {
      if (!logReady) { mkdirSync(join(root, "execution-logs"), { recursive: true }); writeFileSync(logPath, "", "utf8"); }
      // Authenticate the old execution without borrowing authority from a replacement Leader/store/task.
      if (fixedTasks !== store || dataRoot !== root) throw new Error("The old Git store is no longer installed; finalization is incomplete.");
      const current = store.get(actor.tabId), run = current?.executions.find((e) => e.id === execution.id);
      if (!current || current.id !== task.id || current.planVersion !== task.planVersion || current.recordRevision !== expectedRevision || !run || run.status !== "running") throw new Error("The old Git task changed; terminal task finalization is incomplete.");
      fixedRunLog(actor.tabId, execution.id, logPath);
      fixedTreeEnd(actor.tabId, execution.id, operation.treesEnded && !operation.cleanup.size);
      fixedRunStatus(actor.tabId, execution.id, accepted && !operation.cancelled ? "done" : "failed");
      const record = runRecords.get(execution.id);
      if (record) record.status = accepted && !operation.cancelled ? "done" : "failed";
      persisted = true;
    } catch (error) {
      accepted = false;
      failure = new Error(`Git finalization INCOMPLETE: ${String(error)}; original result: ${String(failure ?? "none")}`);
      const record = runRecords.get(execution.id);
      if (record) record.status = "failed";
      try { retainFinalizationBrake(); } catch (brakeError) { failure = new Error(`${String(failure)}; could not persist the finalization brake: ${String(brakeError)}`); }
    }
    try {
      // Write the ONE terminal record after durable finalization, so it cannot claim acceptance of a failed journal write.
      appendFileSync(logPath, JSON.stringify({ type: "git-terminal", command: lastResult?.command ?? "failure",
        treeEnd: operation.treesEnded ? "confirmed" : "unknown", verification: accepted && !operation.cancelled ? "accepted" : "rejected",
        finalized: persisted, cancelled: operation.cancelled, error: failure ? String(failure).slice(0, 2000) : null }) + "\n");
      operation.finalized = persisted;
    } catch (error) {
      accepted = false;
      failure = new Error(`Git terminal log INCOMPLETE: ${String(error)}; original result: ${String(failure ?? "none")}`);
      const record = runRecords.get(execution.id);
      if (record) record.status = "failed";
      try { retainFinalizationBrake(); } catch (brakeError) { failure = new Error(`${String(failure)}; finalization brake failed: ${String(brakeError)}`); }
    } finally { fixedGitOperations.complete(operation); }
  }
  if (failure || !accepted || operation.cancelled) throw failure ?? new Error("Git operation was cancelled.");
  return { runId: execution.id };
}
