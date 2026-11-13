import { isSafeSeatId } from "../config.ts";
import { killRun, isRunning, runIdsForSeat } from "../runner.ts";
import { stopSeat as stopProcessSeat } from "../process.ts";
import { denyRunApprovals } from "./approvals.ts";
import { broadcast, stateMessage } from "./broadcast.ts";
import { revokeRunBridge } from "./launch.ts";
import { persistLaunchSafety } from "./launch-safety.ts";
import { stopLeaderSession } from "./leader-session.ts";
import { blockedSeatKeys, describeError, runContexts, tabs } from "./state.ts";
import { crewDefinition, tabLocation } from "./tabs.ts";
import { isFixedTab } from "../fixed-crew/runtime.ts";
import { FIXED_CREW } from "../fixed-crew/roster.ts";
import { fixedGitOperations } from "./fixed-task-actions.ts";

export function applyRunKill(runId: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof runId !== "string" || !isSafeSeatId(runId)) return { ok: false, error: "invalid run id" };
  const git = fixedGitOperations.get(runId);
  if (git) {
    blockedSeatKeys.add(git.seatKey);
    try { persistLaunchSafety(); } catch (err) { broadcast({ type: "error", message: `could not persist stop block: ${describeError(err)}` }); }
    denyRunApprovals(runId);
    fixedGitOperations.cancel(runId);
    return { ok: true };
  }
  const context = runContexts.get(runId);
  if (!context || !isRunning(runId)) return { ok: false, error: `run is not active: ${runId}` };
  blockedSeatKeys.add(context.run.seatKey);
  try { persistLaunchSafety(); } catch (err) { broadcast({ type: "error", message: `could not persist stop block: ${describeError(err)}` }); }
  // A stopped seat's next tool call gets 401 at once, and what it was waiting on is refused.
  revokeRunBridge(runId); denyRunApprovals(runId);
  return killRun(runId) ? { ok: true } : { ok: false, error: `could not stop run: ${runId}` };
}
export function stopRunsForSeat(tabId: unknown, slot: unknown): void {
  if (typeof tabId !== "string" || typeof slot !== "string") throw new Error("tabId and slot are required");
  const location = tabLocation(tabId);
  if (!location) throw new Error(`unknown tab: ${tabId}`);
  if (isFixedTab(location.tab) ? !FIXED_CREW.some((member) => member.slot === slot) : !crewDefinition(location.tab, slot)) throw new Error(`unknown slot: ${slot}`);
  const seatKey = `${tabId}.${slot}`;
  const runs = [...runIdsForSeat(seatKey), ...fixedGitOperations.ids(seatKey)];
  const runtime = tabs.get(tabId);
  // Live runs settle in the engine only on confirmed close or explicit release.
  if (runtime) runtime.state = stopProcessSeat(runtime.state, slot, Date.now(), new Set(runs));
  const isLeader = isFixedTab(location.tab) ? slot === "leader" : crewDefinition(location.tab, slot)?.isLeader;
  if (isLeader) stopLeaderSession(tabId);
  // A stopped worker seat stays blocked even when nothing was running on it.
  if (!isLeader) blockedSeatKeys.add(seatKey);
  for (const runId of runs) {
    fixedGitOperations.cancel(runId);
      revokeRunBridge(runId); denyRunApprovals(runId);
    killRun(runId);
  }
  if (!isLeader) {
    try { persistLaunchSafety(); } catch (err) { broadcast({ type: "error", message: `could not persist stop block: ${describeError(err)}` }); }
  }
  broadcast(stateMessage());
}
