import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isSafeSeatId, acpKindOf, isAcpKind, type LaunchStamp } from "../config.ts";
import { runSeat, logsDir, type RunnerRun } from "../runner.ts";
import type { LaunchResult } from "../leader-tools.ts";
import type { RateLimitWindows } from "../agent-usage.ts";
import { runEvent } from "../process.ts";
import { endRunWindow } from "./activity.ts";
import { askerOf, denyRunApprovals, leaderNameOf } from "./approvals.ts";
import { addRunUsage, appendRunOutput, broadcast, broadcastUsageState, stateMessage } from "./broadcast.ts";
import { LAUNCH_WINDOW_MS, LEADER_LAUNCH_LIMIT, MAX_LAUNCH_NOTICES, NOTICE_BRIEF_MAX } from "./launch-gates.ts";
import { addUnconfirmed, clearConfirmedKill, endLiveRun, persistLaunchSafety } from "./launch-safety.ts";
import {
  RUN_RECORDS_KEPT, settingsService, acpClis, blockedSeatKeys, dataRoot, describeError, folderActivity, launchSafety, runBridgeRevokers,
  runContexts, runOutput, runRecords, runUsage, runWindows, stallTrackers, tabs, unconfirmedRunIds, fixedTasks, type Launcher,
  type RunRecord,
} from "./state.ts";
import { crewDefinition, tabLocation } from "./tabs.ts";
import { refreshTabDetails } from "./workspace.ts";
import { isFixedTab } from "../fixed-crew/runtime.ts";
import { executionJournal, saveJournal } from "../fixed-crew/task-execution.ts";
import { assertFixedTaskLaunch, fixedExecution, fixedRunLog, fixedRunStatus, fixedTreeEnd, fixedWorkerPrompt, type FixedLaunchContext } from "./fixed-task-launch.ts";

// Who started a run, as the page shows it: the leader, a seat (a planner that runs the process), or null for the user's own Run.
function launchedByFor(tabId: string, source: "client" | "leader" | "seat", launcher?: Launcher): { kind: "leader" | "seat"; slot: string; name: string } | null {
  if (source === "leader") return askerOf(tabId, { kind: "leader", instance: {} });
  if (source === "seat" && launcher) return askerOf(tabId, { kind: "seat", runId: launcher.runId, slot: launcher.slot });
  return null;
}
export function launchedByOfRun(tabId: string, runId: string): { kind: "leader" | "seat"; slot: string; name: string } | null {
  const context = runContexts.get(runId);
  return context ? launchedByFor(tabId, context.source, context.launcher) : null;
}
// A seat's run that ends (every way it can) takes its bridge entry and what it was waiting on with it.
export function revokeRunBridge(runId: string): void {
  runBridgeRevokers.get(runId)?.();
  runBridgeRevokers.delete(runId);
}
export function endRunRecord(runId: string, status: RunRecord["status"], exitCode?: number, outcome?: string): void {
  const record = runRecords.get(runId);
  if (!record) return;
  record.status = status;
  record.outcome = outcome ?? (status === "done" ? "done" : status === "stopped" ? "stopped" : exitCode === undefined ? "spawn error" : `exit ${exitCode}`);
}
export function trimRunRecords(): void {
  for (const [id, record] of runRecords) { if (runRecords.size <= RUN_RECORDS_KEPT) break; if (record.status !== "working") runRecords.delete(id); }
}
export function launchWorker(tabId: string, slot: string, prompt: string, source: "client" | "leader" | "seat" = "client", headsUp?: string, launcher?: Launcher, launchContext?: FixedLaunchContext): LaunchResult {
  const location = tabLocation(tabId);
  if (!location) return { ok: false, error: "This tab no longer exists. Choose an existing tab and position." };
  try { assertFixedTaskLaunch(tabId, slot, launchContext); }
  catch (error) { return { ok: false, error: describeError(error) }; }
  const fixed = isFixedTab(location.tab);
  // Only a fixed crew starts workers, and only through its current leader (assertFixedTaskLaunch above).
  if (!fixed) return { ok: false, error: "Only a fixed crew can start workers." };
  const selected = fixed && launchContext ? fixedExecution(tabId, launchContext.executionId) : null;
  const task = fixedTasks.get(tabId);
  const reservation = launchContext ? task?.executions.find((entry) => entry.id === launchContext.executionId) : undefined;
  const executionCapability = selected && !isAcpKind(selected.assignment.cli) && task && reservation && selected.taskId === task.id
    && reservation.taskId === selected.taskId && reservation.planVersion === selected.planVersion
    && selected.planVersion === task.planVersion && reservation.kind === selected.kind
    && reservation.role === selected.role && selected.role === "leader" && slot === "leader"
    && ["check", "visualCheck"].includes(selected.kind) && reservation.executionCapability === "run-commands"
    ? "run-commands" as const : undefined;
  const member = selected ? { ...crewDefinition(location.tab, slot)!, ...selected.assignment } : crewDefinition(location.tab, slot);
  const definition = crewDefinition(location.tab, slot);
  if (!member || !definition) return { ok: false, error: `This position is no longer available in ${location.tab.name}. Choose an existing position.` };
  if (selected && ["check", "visualCheck"].includes(selected.kind) && isAcpKind(member.cli)) return { ok: false,
    error: `The ${definition.role} position in ${location.tab.name} cannot run checks with this CLI. Choose a Claude, OpenCode or Codex position for checks.` };
  // A CLI added in Settings that was since removed: say so before anything is counted or saved.
  let acp: import("../config-acp.ts").AcpCli | undefined;
  if (isAcpKind(member.cli)) {
    const added = acpClis.find((cli) => acpKindOf(cli) === member.cli);
    if (!added) return { ok: false, error: `The CLI "${member.cli.slice(4)}" was removed in Settings. Pick another CLI for ${member.name}.` };
    acp = { ...added, args: [...added.args] };
  }
  if (typeof prompt !== "string" || !prompt.trim()) return { ok: false, error: "run prompt is required" };
  const seatKey = `${tabId}.${slot}`;
  const position = `The ${definition.role} position in ${location.tab.name}`;
  if (!isSafeSeatId(seatKey)) return { ok: false, error: "unsafe seat key" };
  if (unconfirmedRunIds.has(seatKey) || launchSafety.uncertain.some((row) => row.seatId === seatKey)) {
    return { ok: false, error: `${position} cannot start: an earlier process may still be running. In Needs you, choose Try to stop again to stop it, or review the warning before choosing Release.` };
  }
  // An old row from before seat keys named their tab belongs to no tab, so it blocks every launch: say which one it is.
  const legacyUnconfirmed = launchSafety.uncertain.find((row) => !row.seatId.includes("."));
  if (legacyUnconfirmed) return { ok: false, error: `${position} cannot start: an earlier position may still be running and blocks all launches. In Needs you, choose Try to stop again to stop it, or review the warning before choosing Release.` };
  if (blockedSeatKeys.has(seatKey)) return { ok: false, error: `${position} cannot start: launch blocked after a prior stop. In Needs you, choose Allow again for this position.` };
  const legacyBlock = [...blockedSeatKeys].find((key) => !key.includes("."));
  if (legacyBlock) return { ok: false, error: `${position} cannot start: an earlier position blocks all launches after a previous stop. In Needs you, choose Allow again for that position.` };

  const previousTimestamps = [...launchSafety.timestamps];
  const previousNotices = [...launchSafety.notices];
  const previousNextNoticeId = launchSafety.nextNoticeId;
  const previousLive = [...launchSafety.live];
  const now = Date.now();
  const cutoff = now - LAUNCH_WINDOW_MS;
  // The budget is per tab: another tab's launches never use this one up. A bare number (a stamp from before this) names no tab and is dropped.
  launchSafety.timestamps = launchSafety.timestamps.filter((stamp): stamp is LaunchStamp => typeof stamp !== "number" && stamp.at >= cutoff);
  const mine = launchSafety.timestamps.filter((stamp) => stamp.tabId === tabId);
  if (mine.length >= LEADER_LAUNCH_LIMIT) {
    const waitMs = Math.min(...mine.map((stamp) => stamp.at)) + LAUNCH_WINDOW_MS - now;
    const clearsInSeconds = Math.max(1, Math.ceil(waitMs / 1000));
    return { ok: false, error: `launch budget exceeded: ${LEADER_LAUNCH_LIMIT} launches in ${LAUNCH_WINDOW_MS / 60000} minutes on tab "${location.tab.name}", and your own Run counts too; the next one is allowed in ${clearsInSeconds} s` };
  }
  launchSafety.timestamps.push({ tabId, at: now });

  const run: RunnerRun = {
    runId: selected?.id ?? randomUUID(), seatKey, slotId: slot, name: member.name, cli: member.cli, model: member.model,
    effort: member.effort, folder: location.tab.folder, canWrite: definition.canWrite === true, startedAt: Date.now(),
    ...(executionCapability ? { executionCapability } : {}),
    // Only a Claude run can have an advisor; a CLI added in Settings runs through its own start command.
    ...(member.cli === "claude" && member.advisor ? { advisor: member.advisor } : {}),
    ...(acp ? { acp } : {}),
    ...(member.role.trim() === "Researcher" ? { webSearch: true } : {}),
    lowPriority: true,
  };
  launchSafety.live.push({ seatId: seatKey, runId: run.runId });
  const notice = {
    type: "leaderLaunch" as const,
    id: launchSafety.nextNoticeId++,
    seatId: seatKey,
    seatName: member.name,
    // The notice is a reminder of what was launched, not the brief itself (the run's log keeps that): a huge brief would otherwise ride in every state message.
    brief: prompt.length > NOTICE_BRIEF_MAX ? `${prompt.slice(0, NOTICE_BRIEF_MAX)}...` : prompt,
    source: source === "leader" ? leaderNameOf(tabId) : source === "seat" ? launchedByFor(tabId, "seat", launcher)?.name ?? "A seat" : "Local client",
    pending: true,
    // Kept with the notice, so it survives a reload and is never part of the leader's chat.
    ...(headsUp ? { headsUp } : {}),
  };
  launchSafety.notices.push(notice);
  if (launchSafety.notices.length > MAX_LAUNCH_NOTICES) launchSafety.notices = launchSafety.notices.slice(-MAX_LAUNCH_NOTICES);
  try { persistLaunchSafety(); }
  catch (err) {
    launchSafety.timestamps = previousTimestamps;
    launchSafety.notices = previousNotices;
    launchSafety.nextNoticeId = previousNextNoticeId;
    launchSafety.live = previousLive;
    return { ok: false, error: `could not persist launch safety: ${describeError(err)}` };
  }
  const rollbackLaunch = (): void => {
    launchSafety.timestamps = previousTimestamps;
    launchSafety.notices = previousNotices;
    launchSafety.nextNoticeId = previousNextNoticeId;
    launchSafety.live = previousLive;
    try { persistLaunchSafety(); }
    catch (err) { broadcast({ type: "error", message: `could not release rejected launch reservation: ${describeError(err)}` }); }
  };
  const context = { tabId, slot, run, prompt, source, launcher };
  runContexts.set(run.runId, context);
  const startedBy = launchedByFor(tabId, source, launcher);
  runRecords.set(run.runId, { tabId, seatKey, status: "working", outcome: null, logPath: null });
  trimRunRecords();
  let result: ReturnType<typeof runSeat>;
  // The fixed role prompt goes in front of every launch here, the one place they all pass.
  try {
    let workerPrompt = fixedWorkerPrompt(tabId, run.runId, prompt);
    if (executionCapability) workerPrompt = workerPrompt.replace("You are read-only. Do not edit project files.",
      "You can run commands and may write files while executing the approved checks. Report commands, results and any files changed. Stay within the assigned folder and approved scope. Do not run git commit or git push: shipping happens only through the app's own commit and push actions.");
    result = runSeat(run, workerPrompt, {
    onTreeEnd: (startedRun, evidence) => { if (fixed) fixedTreeEnd(tabId, startedRun.runId, evidence === "confirmed"); },
    onOutput: (startedRun, chunk) => {
      appendRunOutput(startedRun.runId, chunk);
      const wasStalled = tabs.get(tabId)?.stalledRuns.has(startedRun.runId) ?? false;
      const recovered = stallTrackers.noteOutput(startedRun.runId, Buffer.byteLength(chunk, "utf8"), Date.now(), wasStalled);
      if (recovered) tabs.get(tabId)?.stalledRuns.delete(startedRun.runId);
      broadcast({ type: "output", tabId, runId: startedRun.runId, seatKey: startedRun.seatKey, chunk });
    },
    onUsage: (_startedRun, delta) => { addRunUsage(run.runId, delta); broadcastUsageState(); },
    onRateLimit: (windows: RateLimitWindows) => broadcast({ type: "rateLimit", tabId, runId: run.runId, windows }),
    onUnconfirmedKill: (startedRun, pid) => {
      addUnconfirmed(startedRun, pid);
      tabs.get(tabId)?.stalledRuns.add(startedRun.runId);
      broadcast(stateMessage());
    },
    onReleasedClose: (startedRun) => {
      revokeRunBridge(startedRun.runId); denyRunApprovals(startedRun.runId);
      endRunWindow(startedRun.runId);
      runOutput.delete(startedRun.runId);
      runUsage.delete(startedRun.runId);
      stallTrackers.finishRun(startedRun.runId);
      clearConfirmedKill(startedRun.runId);
      broadcast(stateMessage());
    },
    onStatus: (startedRun, status, exitCode) => {
      const runtime = tabs.get(tabId);
      if (status === "working") {
        if (!runWindows.has(startedRun.runId)) runWindows.set(startedRun.runId, folderActivity.beginOwn(startedRun.folder));
        if (!runtime) return;
        runtime.state = runEvent(runtime.state, { type: "start", run: { id: startedRun.runId, seatSlotId: slot, label: prompt.slice(0, 120), startedAt: startedRun.startedAt } });
        stallTrackers.startRun(startedRun.runId, startedRun.startedAt);
        broadcast({ type: "runStart", tabId, runId: startedRun.runId, seatKey, cli: startedRun.cli, model: startedRun.model, effort: startedRun.effort, folder: startedRun.folder, startedAt: startedRun.startedAt, canWrite: startedRun.canWrite, launchedBy: startedBy });
        broadcast(stateMessage());
        return;
      }
      const finalizationErrors: unknown[] = [];
      try {
        if (fixed) fixedRunStatus(tabId, startedRun.runId, status);
      } catch (error) {
        finalizationErrors.push(error);
        // Tree confirmation may already have released admission. Keep a durable
        // brake until reconcile_task_execution abandons this unpublished result.
        try {
          const journal = executionJournal(dataRoot, tabId);
          const execution = journal.executions.find((entry) => entry.id === startedRun.runId);
          if (execution && !execution.consumed) {
            execution.status = "interrupted";
            journal.activeExecutionId = execution.id;
            saveJournal(dataRoot, tabId, journal);
          }
        } catch (brakeError) {
          finalizationErrors.push(brakeError);
        } finally {
          broadcast({ type: "error", message: "The run ended, but its task result could not be saved. Ask the leader to reconcile the execution before continuing." });
        }
      } finally {
        for (const cleanup of [
          () => endLiveRun(startedRun.runId), () => endRunWindow(startedRun.runId),
          () => revokeRunBridge(startedRun.runId), () => denyRunApprovals(startedRun.runId),
          () => endRunRecord(startedRun.runId, status, exitCode),
          () => runContexts.delete(startedRun.runId), () => clearConfirmedKill(startedRun.runId),
          () => runOutput.delete(startedRun.runId), () => runUsage.delete(startedRun.runId),
          () => stallTrackers.finishRun(startedRun.runId),
        ]) {
          try { cleanup(); } catch (error) { finalizationErrors.push(error); }
        }
        try { if (runtime) {
          runtime.stalledRuns.delete(startedRun.runId);
          if (status === "stopped") runtime.state = runEvent(runtime.state, { type: "stop", runId: startedRun.runId, endedAt: Date.now() });
          else if (status === "done") runtime.state = runEvent(runtime.state, { type: "finish", runId: startedRun.runId, endedAt: Date.now(), outcome: "done" });
          else runtime.state = runEvent(runtime.state, { type: "fail", runId: startedRun.runId, endedAt: Date.now(), outcome: exitCode === undefined ? "spawn error" : `exit ${exitCode}` });
          broadcast({ type: status === "stopped" ? "runStop" : status === "done" ? "runFinish" : "runFail", tabId, runId: startedRun.runId, seatKey, outcome: status, exitCode });
          broadcast(stateMessage());
          void refreshTabDetails(tabId);
        } } catch (error) { finalizationErrors.push(error); }
      }
      if (finalizationErrors.length) throw new AggregateError(finalizationErrors,
        finalizationErrors.map(describeError).join("; "));
    },
  }, undefined, { keyLaunch: acp ? settingsService.cliKeys.launch(acp) : undefined }); } catch (err) {
    runContexts.delete(run.runId); runRecords.delete(run.runId); revokeRunBridge(run.runId);
    rollbackLaunch();
    return { ok: false, error: describeError(err) };
  }
  if (!result.ok) {
    runContexts.delete(run.runId); runRecords.delete(run.runId); revokeRunBridge(run.runId);
    rollbackLaunch();
    return { ok: false, error: result.error };
  }
  const record = runRecords.get(run.runId);
  if (record) record.logPath = join(logsDir, `${seatKey}-${result.timestamp}.log`);
  if (fixed && record?.logPath) fixedRunLog(tabId, run.runId, record.logPath);
  notice.pending = false;
  try { persistLaunchSafety(); }
  catch (err) { broadcast({ type: "error", message: `launch started but its outcome could not be saved: ${describeError(err)}` }); }
  broadcast(notice);
  return { ok: true, runId: run.runId };
}
