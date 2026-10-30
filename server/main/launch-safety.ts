import { writeLaunchSafety } from "../config.ts";
import type { RunnerRun } from "../runner.ts";
import { broadcast } from "./broadcast.ts";
import { blockedSeatKeys, describeError, launchSafety, unconfirmedRunIds } from "./state.ts";

export function persistLaunchSafety(): void {
  launchSafety.blocked = [...blockedSeatKeys];
  writeLaunchSafety(launchSafety);
}
export function endLiveRun(runId: string): void {
  if (!launchSafety.live.some((row) => row.runId === runId)) return;
  launchSafety.live = launchSafety.live.filter((row) => row.runId !== runId);
  try { persistLaunchSafety(); } catch (err) { broadcast({ type: "error", message: `could not save that a run ended: ${describeError(err)}` }); }
}
export function addUnconfirmed(run: RunnerRun, pid: number | undefined): void {
  if (!pid) return;
  unconfirmedRunIds.add(run.runId);
  if (!launchSafety.uncertain.some((row) => row.runId === run.runId || (row.runId === undefined && row.seatId === run.seatKey))) {
    launchSafety.uncertain.push({ seatId: run.seatKey, pid, runId: run.runId });
  }
  persistLaunchSafety();
}
export function clearConfirmedKill(runId: string): void {
  const uncertain = launchSafety.uncertain;
  const released = launchSafety.released;
  const nextUncertain = uncertain.filter((row) => row.runId !== runId);
  const nextReleased = released.filter((row) => row.runId !== runId);
  if (nextUncertain.length === uncertain.length && nextReleased.length === released.length) return;
  launchSafety.uncertain = nextUncertain;
  launchSafety.released = nextReleased;
  unconfirmedRunIds.delete(runId);
  try { persistLaunchSafety(); }
  catch (err) {
    launchSafety.uncertain = uncertain;
    launchSafety.released = released;
    unconfirmedRunIds.add(runId);
    broadcast({ type: "error", message: `could not persist confirmed process close: ${describeError(err)}` });
  }
}
