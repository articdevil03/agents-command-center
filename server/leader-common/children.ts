import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { windowsTaskkillPath } from "./cli-path.ts";
import { killProcessTree, tracker, watchProcessTree } from "./process-tree.ts";

// A tracked child's end is two steps: the root exits, then its exit sweep stops what it left behind. Until the sweep finished clean the leader is not gone.
type ChildLife = { sweeping: boolean; failed: boolean; reported: boolean; recheck: () => Promise<void> };
const childLives = new WeakMap<ChildProcess, ChildLife>();
export type LeaderProcessState = { running: boolean; killFailed: boolean; recheck?: () => Promise<void> };
export function leaderProcessState(child: ChildProcess | null, killFailed: boolean): LeaderProcessState {
  const life = child ? childLives.get(child) : undefined;
  const rootRunning = Boolean(child?.pid) && child!.exitCode === null && child!.signalCode === null;
  return { running: rootRunning || Boolean(life?.sweeping || life?.failed), killFailed: killFailed || Boolean(life?.failed), ...(life ? { recheck: life.recheck } : {}) };
}

// A server shutdown must never leave a leader CLI behind: whatever is still alive when this process exits is killed.
const liveChildren = new Set<ChildProcess>();
// watch: also remember its descendants (real children only), so what it left behind is killed when it ends.
// How many tracked children are alive (the shutdown hook ends them).
export function trackedLeaderChildren(): number { return liveChildren.size; }
// onSweepFailed: said once when the exit sweep could not stop (or could not look for) what the child left behind; leaderProcessState keeps the leader "running" and the next check retries the sweep.
export function trackLeaderChild(child: ChildProcess, watch = false, onSweepFailed?: () => void): void {
  liveChildren.add(child);
  const handle = watch && child.pid ? watchProcessTree(child.pid, Date.now(), true) : null;
  const life: ChildLife = { sweeping: false, failed: false, reported: false, recheck: async () => {} };
  childLives.set(child, life);
  let exitedAt = 0; // taken once, in the exit event: a retry must not move the boundary, or a reused root pid's later children look like ours
  const settle = async (): Promise<void> => {
    life.sweeping = true;
    let failed = false;
    try { if (handle) failed = (await handle.sweep(exitedAt)) === null || handle.failed > 0; } catch { failed = true; }
    life.failed = failed; life.sweeping = false;
    if (failed && !life.reported) { life.reported = true; onSweepFailed?.(); }
  };
  life.recheck = async () => { if (life.failed && !life.sweeping) await settle(); };
  child.once("exit", () => {
    liveChildren.delete(child);
    exitedAt = Date.now();
    life.sweeping = true; // set in the exit event itself: no moment where the root is gone and the sweep has not begun
    void settle();
  });
}
// The SDK starts claude.exe itself and, on abort, kills only that one process: start it here instead so its whole tree is tracked and killed.
export function spawnTrackedClaude(options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }, onUnconfirmedKill?: () => void): ChildProcess {
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  trackLeaderChild(child, true, onUnconfirmedKill);
  const stop = (): void => killProcessTree(child, onUnconfirmedKill);
  if (options.signal.aborted) stop(); else options.signal.addEventListener("abort", stop, { once: true });
  child.once("exit", () => options.signal.removeEventListener("abort", stop));
  return child;
}
process.on("exit", () => {
  for (const child of liveChildren) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === "win32") spawnSync(windowsTaskkillPath(), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill();
  }
  tracker?.flushRegistry();
});
