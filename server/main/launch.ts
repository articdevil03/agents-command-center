import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isSafeSeatId, acpKindOf, isAcpKind, type LaunchStamp } from "../config.ts";
import { runSeat, isRunning, logsDir, type RunnerRun } from "../runner.ts";
import { buildLeaderToolSpecs, type LaunchResult } from "../leader-tools.ts";
import type { RateLimitWindows } from "../agent-usage.ts";
import { runEvent, withRoleInstruction } from "../process.ts";
import { endRunWindow } from "./activity.ts";
import { askerOf, denyRunApprovals, leaderNameOf } from "./approvals.ts";
import { addRunUsage, appendRunOutput, broadcast, broadcastUsageState, stateMessage } from "./broadcast.ts";
import { noteRunActivity, openBridge, runToolDeps } from "./crew-tools.ts";
import { LAUNCH_WINDOW_MS, LEADER_LAUNCH_LIMIT, MAX_LAUNCH_NOTICES, NOTICE_BRIEF_MAX } from "./launch-gates.ts";
import { addUnconfirmed, clearConfirmedKill, endLiveRun, persistLaunchSafety } from "./launch-safety.ts";
import {
  HOST, RUN_RECORDS_KEPT, acpClis, blockedSeatKeys, boundPort, describeError, folderActivity, launchSafety, pendingRelaunch, runBridgeRevokers,
  runContexts, runOutput, runRecords, runUsage, runWindows, stallKillRuns, stallTrackers, tabs, unconfirmedRunIds, userKilledRuns, type Launcher,
  type RunRecord,
} from "./state.ts";
import { crewDefinition, tabLocation } from "./tabs.ts";
import { refreshTabDetails } from "./workspace.ts";

// Who started a run, as the page shows it: the leader, a seat (a planner that runs the process), or null for the user's own Run.
function launchedByFor(tabId: string, source: "client" | "leader" | "seat", launcher?: Launcher): { kind: "leader" | "seat"; slot: string; name: string } | null {
  if (source === "leader") return askerOf(tabId, { kind: "leader", instance: {} });
  if (source === "seat" && launcher) return askerOf(tabId, { kind: "seat", runId: launcher.runId, slot: launcher.slot });
  return null;
}
export function launchedByOfRun(tabId: string, runId: string): { kind: "leader" | "seat"; slot: string; name: string } | null {
  const context = runContexts.get(runId);
  if (context) return launchedByFor(tabId, context.source === "stall" ? "client" : context.source, context.launcher);
  const pending = pendingRelaunch.get(runId);
  return pending ? launchedByFor(tabId, pending.originSource, pending.launcher) : null;
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
export function launchWorker(tabId: string, slot: string, prompt: string, source: "client" | "leader" | "seat" | "stall" = "client", relaunchUsed = false, originSource?: "client" | "leader" | "seat", headsUp?: string, launcher?: Launcher): LaunchResult {
  const location = tabLocation(tabId);
  if (!location) return { ok: false, error: `unknown tab: ${tabId}` };
  const member = location.tab.crew.find((seat) => seat.slot === slot);
  const definition = crewDefinition(location.tab, slot);
  if (!member || !definition) return { ok: false, error: `unknown slot: ${slot}` };
  if (definition.isLeader) return { ok: false, error: "the tab leader runs in-process and cannot be launched as a worker" };
  // A CLI added in Settings that was since removed: say so before anything is counted or saved.
  let acp: { name: string; program: string; args: string[] } | undefined;
  if (isAcpKind(member.cli)) {
    const added = acpClis.find((cli) => acpKindOf(cli) === member.cli);
    if (!added) return { ok: false, error: `The CLI "${member.cli.slice(4)}" was removed in Settings. Pick another CLI for ${member.name}.` };
    acp = { name: added.name, program: added.program, args: [...added.args] };
  }
  if (typeof prompt !== "string" || !prompt.trim()) return { ok: false, error: "run prompt is required" };
  const seatKey = `${tabId}.${slot}`;
  if (!isSafeSeatId(seatKey)) return { ok: false, error: "unsafe seat key" };
  if (unconfirmedRunIds.has(seatKey) || launchSafety.uncertain.some((row) => row.seatId === seatKey)) {
    return { ok: false, error: `seat has an unconfirmed process: ${seatKey}` };
  }
  // An old row from before seat keys named their tab belongs to no tab, so it blocks every launch: say which one it is.
  const legacyUnconfirmed = launchSafety.uncertain.find((row) => !row.seatId.includes("."));
  if (legacyUnconfirmed) return { ok: false, error: `an old unconfirmed process (${legacyUnconfirmed.seatId}) blocks every launch; release it first` };
  if (blockedSeatKeys.has(seatKey)) return { ok: false, error: `launch blocked after a prior stop: ${seatKey}` };
  const legacyBlock = [...blockedSeatKeys].find((key) => !key.includes("."));
  if (legacyBlock) return { ok: false, error: `an old launch block (${legacyBlock}) blocks every launch; allow it again first` };
  // One run at a time runs the process on a tab: a second one would answer the same step twice.
  if (member.orchestrates === true && [...runContexts.values()].some((context) => context.run.seatKey === seatKey && isRunning(context.run.runId))) return { ok: false, error: `${member.name} already runs the process in this tab; wait for that run to end, or stop it first` };

  const previousTimestamps = [...launchSafety.timestamps];
  const previousNotices = [...launchSafety.notices];
  const previousNextNoticeId = launchSafety.nextNoticeId;
  const previousLive = [...launchSafety.live];
  if (!relaunchUsed) {
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
  }
  const run: RunnerRun = {
    runId: randomUUID(), seatKey, slotId: slot, name: member.name, cli: member.cli, model: member.model,
    effort: member.effort, folder: location.tab.folder, canWrite: definition.canWrite === true, startedAt: Date.now(),
    // Only a Claude run can have an advisor; a CLI added in Settings runs through its own start command.
    ...(member.cli === "claude" && member.advisor ? { advisor: member.advisor } : {}),
    ...(acp ? { acp } : {}),
    ...(member.role.trim() === "Researcher" ? { webSearch: true } : {}),
  };
  launchSafety.live.push({ seatId: seatKey, runId: run.runId });
  const notice = {
    type: "leaderLaunch" as const,
    id: launchSafety.nextNoticeId++,
    seatId: seatKey,
    seatName: member.name,
    // The notice is a reminder of what was launched, not the brief itself (the run's log keeps that): a huge brief would otherwise ride in every state message.
    brief: prompt.length > NOTICE_BRIEF_MAX ? `${prompt.slice(0, NOTICE_BRIEF_MAX)}...` : prompt,
    source: source === "leader" ? leaderNameOf(tabId) : source === "seat" ? launchedByFor(tabId, "seat", launcher)?.name ?? "A seat" : source === "stall" ? "Stall relaunch" : "Local client",
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
  const origin = source === "stall" ? originSource ?? "client" as const : source;
  const context = { tabId, slot, run, prompt, source: origin, launcher, relaunchUsed };
  runContexts.set(run.runId, context);
  const startedBy = launchedByFor(tabId, origin, launcher);
  runRecords.set(run.runId, { tabId, seatKey, status: "working", outcome: null, logPath: null });
  trimRunRecords();
  if (member.orchestrates === true) {
    // The seat that runs the process reaches the crew tools through its own bridge entry, which lives exactly as long as this run.
    const key = `${tabId}.${run.runId}`;
    const bridge = openBridge(key, buildLeaderToolSpecs(runToolDeps(tabId, run.runId, slot)), () => noteRunActivity(tabId, run.runId));
    runBridgeRevokers.set(run.runId, bridge.revoke);
    run.crewTools = { url: `http://${HOST}:${boundPort}/api/leader-mcp/${encodeURIComponent(key)}`, token: bridge.token };
  }
  let result: ReturnType<typeof runSeat>;
  // The role's built-in instruction goes in front of every launch here, the one place they all pass (the user's Run, a launch_seat, a stall relaunch); the saved brief shows it.
  try { result = runSeat(run, withRoleInstruction(member.role, prompt), {
    onOutput: (startedRun, chunk) => {
      appendRunOutput(startedRun.runId, chunk);
      const wasStalled = tabs.get(tabId)?.stalledRuns.has(startedRun.runId) ?? false;
      const recovered = stallTrackers.noteOutput(startedRun.runId, Buffer.byteLength(chunk, "utf8"), Date.now(), wasStalled);
      if (recovered) {
        tabs.get(tabId)?.stalledRuns.delete(startedRun.runId);
        pendingRelaunch.delete(startedRun.runId);
      }
      broadcast({ type: "output", tabId, runId: startedRun.runId, seatKey: startedRun.seatKey, chunk });
    },
    onUsage: (_startedRun, delta) => { addRunUsage(run.runId, delta); broadcastUsageState(); },
    onRateLimit: (windows: RateLimitWindows) => broadcast({ type: "rateLimit", tabId, runId: run.runId, windows }),
    onUnconfirmedKill: (startedRun, pid) => {
      pendingRelaunch.delete(startedRun.runId);
      stallTrackers.markKilled(startedRun.runId);
      addUnconfirmed(startedRun, pid);
      tabs.get(tabId)?.stalledRuns.add(startedRun.runId);
      broadcast(stateMessage());
    },
    onReleasedClose: (startedRun) => {
      revokeRunBridge(startedRun.runId); denyRunApprovals(startedRun.runId);
      endRunWindow(startedRun.runId);
      runOutput.delete(startedRun.runId);
      runUsage.delete(startedRun.runId);
      userKilledRuns.delete(startedRun.runId);
      stallKillRuns.delete(startedRun.runId);
      stallTrackers.finishRun(startedRun.runId);
      clearConfirmedKill(startedRun.runId);
      broadcast(stateMessage());
    },
    onStatus: (startedRun, status, exitCode) => {
      if (status !== "working") { endLiveRun(startedRun.runId); endRunWindow(startedRun.runId); revokeRunBridge(startedRun.runId); denyRunApprovals(startedRun.runId); endRunRecord(startedRun.runId, status, exitCode); }
      else if (!runWindows.has(startedRun.runId)) runWindows.set(startedRun.runId, folderActivity.beginOwn(startedRun.folder));
      const runtime = tabs.get(tabId);
      if (!runtime) return;
      if (status === "working") {
        runtime.state = runEvent(runtime.state, { type: "start", run: { id: startedRun.runId, seatSlotId: slot, label: prompt.slice(0, 120), startedAt: startedRun.startedAt } });
        stallTrackers.startRun(startedRun.runId, startedRun.startedAt);
        if (relaunchUsed) stallTrackers.markRelaunched(startedRun.runId, startedRun.startedAt);
        broadcast({ type: "runStart", tabId, runId: startedRun.runId, seatKey, cli: startedRun.cli, model: startedRun.model, effort: startedRun.effort, folder: startedRun.folder, startedAt: startedRun.startedAt, canWrite: startedRun.canWrite, launchedBy: startedBy });
        broadcast(stateMessage());
        return;
      }
      runtime.stalledRuns.delete(startedRun.runId);
      if (status === "stopped") runtime.state = runEvent(runtime.state, { type: "stop", runId: startedRun.runId, endedAt: Date.now() });
      else if (status === "done") runtime.state = runEvent(runtime.state, { type: "finish", runId: startedRun.runId, endedAt: Date.now(), outcome: "done" });
      else runtime.state = runEvent(runtime.state, { type: "fail", runId: startedRun.runId, endedAt: Date.now(), outcome: exitCode === undefined ? "spawn error" : `exit ${exitCode}` });
      const pending = pendingRelaunch.get(startedRun.runId);
      const internalStallStop = status === "stopped" && stallKillRuns.has(startedRun.runId);
      broadcast({ type: status === "stopped" ? "runStop" : status === "done" ? "runFinish" : "runFail", tabId, runId: startedRun.runId, seatKey, outcome: status, exitCode, ...(status === "stopped" ? { internal: internalStallStop } : {}) });
      runContexts.delete(startedRun.runId);
      clearConfirmedKill(startedRun.runId);
      if (pending && status === "stopped") {
        pendingRelaunch.delete(startedRun.runId);
        // Kill dispatch is asynchronous. Recheck user intent at close,
        // since it can change after this relaunch queued.
        if (!stallTrackers.isKilled(startedRun.runId) && !userKilledRuns.has(startedRun.runId)) {
          const relaunched = launchWorker(pending.tabId, pending.slot, pending.prompt, "stall", true, pending.originSource, undefined, pending.launcher);
          if (!relaunched.ok) broadcast({ type: "error", message: `stall relaunch failed: ${relaunched.error}` });
        }
      } else if (pending) pendingRelaunch.delete(startedRun.runId);
      runOutput.delete(startedRun.runId);
      runUsage.delete(startedRun.runId);
      userKilledRuns.delete(startedRun.runId);
      stallKillRuns.delete(startedRun.runId);
      stallTrackers.finishRun(startedRun.runId);
      broadcast(stateMessage());
      void refreshTabDetails(tabId);
    },
  }); } catch (err) {
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
  notice.pending = false;
  try { persistLaunchSafety(); }
  catch (err) { broadcast({ type: "error", message: `launch started but its outcome could not be saved: ${describeError(err)}` }); }
  broadcast(notice);
  return { ok: true, runId: run.runId };
}
