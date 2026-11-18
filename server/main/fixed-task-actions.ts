import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprint } from "../fixed-crew/task-revision.ts";
import { assertTaskGate, type TaskAction } from "../fixed-crew/task-gates.ts";
import { type Task } from "../fixed-crew/task-types.ts";
import { type WorkerReport } from "../fixed-crew/task-reports.ts";
import { assertFixedTaskLaunch, fixedRunLog, fixedRunStatus, fixedTreeEnd, isCurrentFixedLeader,
  reserveFixedExecution, applyTaskEvent, type FixedLeaderActor } from "./fixed-task-launch.ts";
import { dataRoot, fixedTasks, runRecords, leaders } from "./state.ts";
import { tabLocation, effectiveMode } from "./tabs.ts";
import { fixedCrewOf } from "../fixed-crew/runtime.ts";
import { createGitOperations } from "../fixed-crew/git-operations.ts";
import { runGitCommand, type GitCommandResult } from "../fixed-crew/git-process.ts";
import { executionJournal, saveJournal } from "../fixed-crew/task-execution.ts";
import { safeGitText } from "../fixed-crew/git-log.ts";

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
  let logReady = false, reconciliationRequired = false, stagingRecovered = false, pushRemote = "";
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
  const execute = async (args: string[]): Promise<GitCommandResult> => {
    let result: GitCommandResult;
    lastResult = null;
    if (command) {
      try { result = { command: "success", treeEnded: true, stdout: await command(folder, args), stderr: "", reason: null, code: 0, signal: null }; }
      catch (error) { result = { command: "failure", treeEnded: true, stdout: "", stderr: "", reason: String(error), code: null, signal: null }; }
    } else result = await runGitCommand(operation, folder, args);
    lastResult = result;
    // Retain observed command facts even when authority or cleanup verification rejects the operation.
    appendFileSync(logPath, safeGitText(JSON.stringify({ type: "git-command", args, ...result })) + "\n");
    return result;
  };
  const requireSuccess = (result: GitCommandResult): string => {
    if (result.command !== "success" || !result.treeEnded || result.reason) {
      if (result.command === "failure" && result.treeEnded && !result.reason) {
        if (/identity unknown|unable to auto-detect email|no (?:name|email) was given|empty ident|ident name.*empty/i.test(result.stderr)) throw new Error("Your Git name or email is missing. Give the Leader in this app your Git name and email to save for this project, then try again. The app cannot invent your identity.");
        if (/non-fast-forward|fetch first|tip of your current branch is behind/i.test(result.stderr)) throw new Error("The remote has newer commits. Ask the Leader in this app to bring in those changes and resolve any conflicts, then review and try pushing again.");
      }
      throw new Error(result.reason ?? `Git failed (${result.code}); tree end ${result.treeEnded ? "confirmed" : "unknown"}.`);
    }
    return result.stdout;
  };
  const run = async (...args: string[]) => {
    authority();
    const result = await execute(args);
    authority();
    return requireSuccess(result);
  };
  // Undo of our own `git add` only: it skips the cancelled and authority checks (Stop or a leader change must not leave
  // pack files staged) but still demands a successful command with the whole process tree ended.
  const recover = async (...args: string[]) => {
    fixedGitOperations.assertOpen();
    const wasCancelled = operation.cancelled;
    operation.cancelled = false;
    try { return requireSuccess(await execute(args)); }
    finally { operation.cancelled = wasCancelled || operation.cancelled; }
  };
  const probe = async (...args: string[]) => {
    authority(); const result = await execute(args); authority();
    if (result.command === "failure" && result.treeEnded && !result.reason && [1, 128].includes(result.code!)) return null;
    return requireSuccess(result);
  };
  const head = async (git = run): Promise<string | null> => {
    try { return (await git("rev-parse", "HEAD")).trim(); }
    catch (error) {
      // Only an absent branch ref proves an unborn HEAD; other failures remain failures.
      if (lastResult?.command !== "failure" || !lastResult.treeEnded || lastResult.reason || lastResult.code !== 128) throw error;
      const ref = (await git("symbolic-ref", "--quiet", "HEAD")).trim();
      if (!ref.startsWith("refs/heads/")) throw error;
      try { await git("show-ref", "--verify", "--quiet", ref); }
      catch {
        if (lastResult?.command === "failure" && lastResult.treeEnded && !lastResult.reason && lastResult.code === 1) return null;
      }
      throw error;
    }
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
    const before = await head();
    if (before !== null && !/^[a-f0-9]{40,64}$/.test(before)) throw new Error("Git did not identify the current commit.");
    const owned = task.plan.paths;
    if (action.kind !== "push") {
      const staged = (await run("diff", "--cached", "--name-only", "-z")).split("\0").filter(Boolean);
      if (staged.some((name) => owned.some((p) => name === p || name.startsWith(p + "/")))) throw new Error("Pack files already have staged changes. Separate them before the checkpoint.");
      const pending = await run("status", "--porcelain=v1", "-z", "--", ...owned);
      if (!pending) throw new Error("There are no pack-owned changes to commit.");
      fresh();
      // --only leaves unrelated staged content out of the commit.
      let commitStarted = false, commitResult: GitCommandResult | null = null;
      try {
        await run("add", "--", ...owned);
        fresh();
        commitStarted = true;
        reconciliationRequired = true;
        try { await run("commit", "--only", "-m", action.kind === "checkpoint" ? `checkpoint: ${task.plan.scope}` : task.plan.scope, "--", ...owned); }
        finally { commitResult = lastResult; }
      } catch (error) {
        try {
          // An ended, unsuccessful command and unchanged HEAD are required before changing the index.
          if (!operation.treesEnded || operation.cleanup.size || (commitStarted && (!commitResult
            || commitResult.command !== "failure" || !commitResult.treeEnded))) throw new Error("Commit completion needs reconciliation.");
          const git = commitStarted ? run : recover;
          if (await head(git) !== before) throw new Error("The commit may have completed. Reconcile it before continuing.");
          if (before === null) await git("rm", "--cached", "-f", "-r", "--ignore-unmatch", "--", ...owned);
          else await git("reset", "-q", before, "--", ...owned);
          reconciliationRequired = false;
          stagingRecovered = commitStarted;
        } catch (recoveryError) {
          reconciliationRequired = true;
          throw new Error(`${String(error)}; staging recovery is incomplete: ${String(recoveryError)}`);
        }
        throw error;
      }
      const hash = (await run("rev-parse", "HEAD")).trim();
      const committed = (await run("diff-tree", ...(before === null ? ["--root"] : []), "--no-commit-id", "--name-only", "-r", "-z", hash)).split("\0").filter(Boolean);
      if (!/^[a-f0-9]{40,64}$/.test(hash) || hash === before || !committed.length
        || committed.some((name) => !owned.some((p) => name === p || name.startsWith(p + "/")))) throw new Error("Git did not verify a commit containing only pack-owned files.");
      if (action.kind === "checkpoint" && (await run("log", "-1", "--format=%s")).replace(/\r?\n$/, "") !== `checkpoint: ${task.plan.scope}`) throw new Error("Git did not verify the checkpoint name.");
    } else {
      if (before === null) throw new Error("Create a checkpoint or commit in this app before pushing.");
      if (await run("status", "--porcelain=v1", "-z", "--", ...owned)) throw new Error("Commit the reviewed pack before pushing.");
      const branchRef = (await probe("symbolic-ref", "--quiet", "HEAD"))?.trim();
      const branch = branchRef?.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : "";
      if (!branch) throw new Error("This project is viewing a commit without a branch. Ask the Leader in this app to select the intended branch, then try pushing again.");
      let firstPush = false, remote = "", target = "", range = [`@{upstream}..${before}`];
      if (await probe("rev-parse", "@{upstream}") === null) {
        // A broken configured upstream must not silently become a different destination.
        if ((await run("for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`)).trim()) throw new Error("The saved remote branch is unavailable. Ask the Leader in this app to check the Git remote and refresh its branches, then try again.");
        const remotes = (await run("remote")).trim().split(/\r?\n/).filter(Boolean);
        if (remotes.length !== 1) throw new Error(remotes.length === 0
          ? "No Git remote is configured. Ask the Leader in this app to connect the intended remote, then try pushing again."
          : "Several Git remotes are configured. Ask the Leader in this app to choose the intended remote and tracking branch, then try pushing again.");
        firstPush = true; remote = remotes[0]; target = `refs/heads/${branch}`;
        range = [before, "--not", `--remotes=${remote}`];
      } else {
        const upstream = (await run("for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", `refs/heads/${branch}`)).trim().split("\0");
        if (upstream.length !== 2) throw new Error("Git did not identify the saved remote branch.");
        [remote, target] = upstream;
      }
      if (!remote || remote.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(remote) || !target.startsWith("refs/heads/")) throw new Error("Git did not identify a safe remote branch. Push was refused.");
      pushRemote = remote;
      const url = (await run("remote", "get-url", "--push", "--", remote)).trim();
      appendFileSync(logPath, `Push destination: ${remote} (${safeGitText(url)})\n`);
      const pushArgs = ["push", "--no-follow-tags", ...(firstPush ? ["-u"] : []), "--", remote, `${before}:${target}`];
      const count = (await run("rev-list", "--count", ...range)).trim();
      const history = await run("rev-list", ...range);
      const commits = history.trim() ? history.trim().split(/\r?\n/) : [];
      if (!/^\d+$/.test(count) || Number(count) !== commits.length || new Set(commits).size !== commits.length
        || commits.some((hash) => !/^[a-f0-9]{40,64}$/.test(hash)) || (history && !history.endsWith("\n"))) throw new Error("Git history is incomplete. Push was refused.");
      for (const hash of commits) {
        // -m compares merges to every parent; disabling renames includes both old and new paths.
        const output = await run("diff-tree", "--root", "-m", "--no-renames", "--no-commit-id", "--name-only", "-r", "-z", hash);
        if (output && !output.endsWith("\0")) throw new Error("Git history is incomplete. Push was refused.");
        const outgoing = output.split("\0").filter(Boolean);
        const outside = outgoing.find((name) => !owned.some((p) => name === p || name.startsWith(p + "/")));
        if (outside) throw new Error(`The outgoing commits include files outside this pack. Commit ${hash}, file ${outside.split(/[\\/]/).at(-1)}. Separate it before pushing.`);
      }
      fresh();
      if ((await run("rev-parse", "HEAD")).trim() !== before) throw new Error("HEAD changed during the Git action. Push was refused.");
      await run(...pushArgs);
      // A SHA refspec has no local branch name, so -u alone cannot save tracking.
      if (firstPush) await run("branch", `--set-upstream-to=${remote}/${target.slice("refs/heads/".length)}`, "--", branch);
      if ((await run("rev-parse", "@{upstream}")).trim() !== before) throw new Error("Git did not verify the pushed commit.");
      appendFileSync(logPath, `Push to ${remote} succeeded.\n`);
    }
    fresh();
    const report: WorkerReport = { version: 1, runId: execution.id, taskId: task.id, planVersion: task.planVersion,
      evidence: [...task.plan.paths], plan: null, findings: [], resolved: [], baseFinal: null, unchanged: [], decisions: [] };
    appendFileSync(logPath, `CC_REPORT_BEGIN\n${JSON.stringify(report)}\nCC_REPORT_END\n`);
    authority();
    accepted = true;
  } catch (error) {
    failure = new Error(safeGitText(`${pushRemote ? `Push to ${pushRemote}: ` : ""}${error instanceof Error ? error.message : String(error)}`));
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
      // A failed hook may save pack files. Record abandonment without accepting stale evidence,
      // only after our staging was recovered and the whole process tree was confirmed ended.
      if (stagingRecovered && !accepted && operation.treesEnded && !operation.cleanup.size
        && fingerprint(folder, task.plan).digest !== revision) applyTaskEvent(actor.tabId, current,
        { type: "reconcile", executionId: execution.id, processEnd: "confirmed", reason: "Failed commit staging recovered; saved file changes require fresh checks." }, store.actor("leader", actor.sessionId));
      fixedRunStatus(actor.tabId, execution.id, accepted && !operation.cancelled ? "done" : "failed");
      const record = runRecords.get(execution.id);
      if (record) record.status = accepted && !operation.cancelled ? "done" : "failed";
      persisted = true;
      if (reconciliationRequired && !accepted) retainFinalizationBrake();
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
  return { runId: execution.id, ...(pushRemote ? { message: `Push to ${pushRemote} succeeded.` } : {}) };
}
