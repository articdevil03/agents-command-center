import { defaultWorkspaces, launchSafetyPath, readLaunchSafety, readWorkspaces, writeLaunchSafety, type LaunchSafety, type Workspaces } from "../config.ts";
import { existsSync } from "node:fs";
import { preserveBadFile } from "../safe-file.ts";
import { FIXED_CREW } from "../fixed-crew/roster.ts";
import type { RunnerRun } from "../runner.ts";
import { broadcast } from "./broadcast.ts";
import { blockedSeatKeys, describeError, launchSafety, setBlockedSeatKeys, setLaunchSafety, setSelectedTabId, setUnconfirmedRunIds, setWorkspaces, unconfirmedRunIds, workspaces } from "./state.ts";
import { assertWorkspaceRecoveryReady, blockWorkspaceRecovery, holdLaunchSafety, restoreWorkspaceRecovery, unavailableWorkspace, workspaceRecovery, type RecoveryState } from "../fixed-crew/recovery.ts";

let damaged = false, held = false;
let savedWorkspace: Workspaces | undefined;
let priorRecovery: RecoveryState | undefined;
const damagedNotice = "Workspace unavailable. The saved launch safety file (launch-safety.json) cannot be read. Earlier processes may still be running. Recover the saved workspace below to inspect your tasks. If the earlier process history can be read, your saved seat blocks stay and nothing else is held; if not, all launches stay held until you allow them.";
const heldNotice = "Your saved workspace is available to inspect. Launches remain held because earlier process history could not be read. No earlier process has been confirmed ended. Your original launch safety file, tasks and run records have been kept.";
const emptySafety = (): LaunchSafety => ({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] });

export function launchSafetyRecoveryStatus(): Record<string, unknown> {
  return { type: "launchSafetyRecovery", required: damaged, held, message: damaged ? damagedNotice : held ? heldNotice : "" };
}
export function initializeLaunchSafety(): void {
  try {
    const loaded = readLaunchSafety();
    const recoveryHold = (loaded as LaunchSafety & { recoveryHold?: unknown }).recoveryHold;
    if (recoveryHold !== undefined && recoveryHold !== true) throw new Error("Invalid saved recovery hold.");
    held = recoveryHold === true;
    holdLaunchSafety(held);
    setLaunchSafety(loaded);
  } catch {
    damaged = true;
    savedWorkspace = workspaces;
    priorRecovery = workspaceRecovery();
    const preserved = preserveBadFile(launchSafetyPath).ok;
    blockWorkspaceRecovery(damagedNotice + (preserved ? " A copy of the original was kept." : " The original is untouched; a copy could not be made."));
    setWorkspaces(unavailableWorkspace(defaultWorkspaces));
    setLaunchSafety(emptySafety());
  }
}
// This restores access to saved records. A readable saved copy keeps all its facts and seat blocks and adds no hold; an unreadable one adds a durable
// global hold that covers even seats absent from the damaged file or current workspace.
export function recoverLaunchSafety(): boolean {
  if (!damaged) return false;
  if (!savedWorkspace || !priorRecovery || priorRecovery.blocked) throw new Error("The saved workspace also needs recovery. All original files have been kept and launches remain held.");
  const preserved = existsSync(launchSafetyPath) ? preserveBadFile(launchSafetyPath) : { ok: false as const };
  if (!preserved.ok) throw new Error("The original launch safety file could not be safely preserved. Recovery was refused and launches remain held. Try again when the file is available.");
  const workspace = readWorkspacesForRecovery();
  let next: LaunchSafety & { recoveryHold?: true };
  // A now-readable file can retain all its saved facts. An invalid file stays
  // preserved verbatim, and the global hold represents the unknown facts.
  try { next = readLaunchSafety(preserved.path); }
  catch { next = { ...emptySafety(), recoveryHold: true }; }
  // Any hold value the saved copy carries counts as a hold, and is written back as the plain hold.
  if ((next as { recoveryHold?: unknown }).recoveryHold !== undefined) next.recoveryHold = true;
  next.blocked = [...new Set([...next.blocked, ...blockedSeatKeys, ...(next.recoveryHold ? workspace.projects.flatMap((project) => project.tabs.flatMap((tab) => FIXED_CREW.map((seat) => `${tab.id}.${seat.slot}`))) : []), ...next.live.map((row) => row.seatId), ...next.uncertain.map((row) => row.seatId)])];
  try { writeLaunchSafety(next); }
  catch { throw new Error("Launch safety could not be saved. The original and the launch blocks have been kept. Try again when the file is available."); }
  held = next.recoveryHold === true; damaged = false; holdLaunchSafety(held);
  setLaunchSafety(next);
  setBlockedSeatKeys(new Set(next.blocked));
  setUnconfirmedRunIds(new Set(next.uncertain.map((row) => row.runId ?? row.seatId)));
  restoreWorkspaceRecovery(priorRecovery);
  setWorkspaces(workspace);
  setSelectedTabId(workspace.projects[0]?.tabs[0]?.id ?? "");
  return true;
}
export function releaseLaunchSafetyHold(confirmation: unknown): void {
  if (confirmation !== "allow launches with unreadable process history") throw new Error("Confirm that earlier process history could not be read before allowing launches again.");
  if (!held || damaged) throw new Error("Recover the saved workspace before releasing the hold.");
  // This is the one write permitted while held. Keep every unresolved fact and
  // seat block; releasing the global hold never claims an earlier process ended.
  const next = { ...launchSafety } as LaunchSafety & { recoveryHold?: true };
  delete next.recoveryHold;
  try { writeLaunchSafety(next); }
  catch { throw new Error("The launch hold could not be released. Your saved process history has been kept."); }
  setLaunchSafety(next);
  held = false; holdLaunchSafety(false);
}
function readWorkspacesForRecovery(): Workspaces {
  // The initial blocked view is a placeholder. Revalidate the real saved data
  // without dropping an unrelated workspace recovery block.
  const blocked = workspaceRecovery();
  restoreWorkspaceRecovery(priorRecovery!);
  try { return readWorkspaces(); }
  catch { throw new Error("The saved workspace cannot be read. Its original files and launch blocks have been kept."); }
  finally { restoreWorkspaceRecovery(blocked); }
}

export function persistLaunchSafety(): void {
  assertWorkspaceRecoveryReady("launch-safety");
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
