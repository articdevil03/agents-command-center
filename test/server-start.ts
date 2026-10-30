import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SWEEP_CAP_MS } from "../server/leader-common/types.ts"; // the constants' own file: it has no side effects, unlike leader-common.ts

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

const STOP_MS = 15_000;

// taskkill exits 128 when the process is already gone. Under load it can also time out or fail: that is logged, not ignored.
function killTree(pid: number, timeout: number): string | null {
  const done = spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
    ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout });
  return done.error ? done.error.message : done.status === 0 || done.status === 128 ? null : `exit ${done.status}`;
}

// Ends the child and its grandchildren; true when the child is gone, false when it survived both kills or taskkill failed twice.
async function stopTree(child: ChildProcess, stopMs: number): Promise<boolean> {
  if (hasExited(child)) return true;
  if (child.pid && process.platform === "win32") {
    const failed = killTree(child.pid, stopMs);
    if (failed) {
      console.log(`taskkill ${child.pid} failed (${failed}); retrying with a longer limit`);
      if (!hasExited(child) && killTree(child.pid, 2 * stopMs)) { child.kill(); return false; } // the grandchildren may still be alive
    }
  }
  if (!hasExited(child)) child.kill();
  const deadline = Date.now() + stopMs;
  while (!hasExited(child) && Date.now() < deadline) await sleep(10);
  return hasExited(child);
}

// The server's own ready line. A bind error ("listen EADDRINUSE: ... 127.0.0.1:<port>") also holds 127.0.0.1 but is not this line.
const RUNNING_LINE = /Command Center running at http:\/\/127\.0\.0\.1:(\d+)/;

export const SERVER_START_MS = Math.max(60_000, SWEEP_CAP_MS + 10_000);

// Resolves with the port the server printed (0 when a caller's own `ready` matched a log without the line).
// The server listens only after its start-up sweep, which is capped at SWEEP_CAP_MS, so the default wait outlasts that cap.
export async function waitForServerStart(
  child: ChildProcess,
  readLog: () => string,
  ms = SERVER_START_MS,
  ready = (log: string) => RUNNING_LINE.test(log),
  stopMs = STOP_MS,
): Promise<number> {
  let spawnError: Error | undefined;
  const onError = (error: Error) => { spawnError = error; };
  child.on("error", onError);
  try {
    const deadline = Date.now() + ms;
    while (!hasExited(child) && !spawnError) {
      const log = readLog();
      if (ready(log)) return Number(RUNNING_LINE.exec(log)?.[1] ?? 0);
      if (Date.now() >= deadline) break;
      await sleep(10);
    }
    if (!await stopTree(child, stopMs)) {
      assert.fail(`server did not start, and cleanup failed: server ${child.pid} is still running: ${readLog()}`);
    }
    assert.fail(`server did not start: ${readLog()}${spawnError ? `\n${spawnError.message}` : ""}`);
  } finally { child.removeListener("error", onError); }
}
