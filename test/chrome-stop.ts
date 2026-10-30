import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { KILL_TIMEOUT_MS } from "../server/leader-common/types.ts";

export const CHROME_CLOSE_GRACE_MS = 7_000; // Browser.close to exit, before any kill
export const CHROME_EXIT_MS = 30_000; // a busy PC may take this long to finish ending a killed process
// The helper's own worst case (grace, two taskkills, the final exit wait): a test's limit on a stop is derived from this, never hand-typed.
export const chromeStopBoundMs = (graceMs = 0) => graceMs + 2 * KILL_TIMEOUT_MS + CHROME_EXIT_MS;

// Runs taskkill on a process tree; resolves with "exit <code>", "error <message>" or "timed out after <n> s" (the killer is then stopped). Async: a sync call would block the event loop.
function taskkillTree(pid: number, limitMs: number): Promise<string> {
  const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  return new Promise<string>((ok) => {
    let done = false;
    const finish = (result: string) => { if (done) return; done = true; clearTimeout(timer); ok(result); };
    const timer = setTimeout(() => { finish(`timed out after ${limitMs / 1000} s`); killer.kill(); }, limitMs);
    killer.once("exit", (code, signal) => finish(`exit ${code ?? signal}`));
    killer.once("error", (error) => finish(`error ${error.message}`));
  });
}

export type StopOptions = { graceMs?: number; kill?: (pid: number, limitMs: number) => Promise<string>; killMs?: number; exitMs?: number };

// The one Chrome stop every test uses: wait the grace, then kill the whole tree (twice if the first try fails, while the root is alive so /T can still walk it), proc.kill() only as the last resort.
export async function stopChromeTree(proc: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill" | "once" | "off">, options: StopOptions = {}) {
  const { graceMs = 0, kill = taskkillTree, killMs = KILL_TIMEOUT_MS, exitMs = CHROME_EXIT_MS } = options;
  const started = Date.now(), facts: string[] = [];
  const gone = () => proc.exitCode !== null || proc.signalCode !== null;
  const waitExit = (limitMs: number) => new Promise<boolean>((ok) => {
    if (gone()) return ok(true);
    const onExit = () => { clearTimeout(timer); ok(true); };
    const timer = setTimeout(() => { proc.off("exit", onExit); ok(false); }, limitMs);
    proc.once("exit", onExit);
  });
  const result = () => ({ stopped: gone(), ms: Date.now() - started, facts });
  if (gone()) { facts.push("Chrome had already exited"); return result(); }
  if (graceMs > 0) {
    const byExit = await waitExit(graceMs);
    facts.push(byExit ? `exit ${Date.now() - started} ms into the ${graceMs} ms grace` : `no exit within the ${graceMs} ms grace`);
  }
  if (gone()) return result();
  if (!proc.pid) facts.push("no pid: taskkill skipped");
  let treeKilled = false;
  for (let attempt = 1; !gone() && !treeKilled && proc.pid && attempt <= 2; attempt++) {
    const at = Date.now(), outcome = await kill(proc.pid, killMs);
    facts.push(`taskkill /T /F${attempt > 1 ? " retry" : ""} ${outcome} after ${Date.now() - at} ms`);
    treeKilled = /^exit (0|128)$/.test(outcome);
  }
  // ponytail: the tree kill failed twice, so only the root can still be stopped; its helpers may be orphaned.
  if (!gone() && !treeKilled) facts.push(`proc.kill() returned ${proc.kill()}`);
  const at = Date.now(), byExit = await waitExit(exitMs);
  facts.push(byExit ? `exit ${Date.now() - at} ms after the kill` : `no exit within ${exitMs} ms of the kill`);
  return result();
}
