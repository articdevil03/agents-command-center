// Fix pack 2, block 2 (launching agents): process trees, crash leftovers, folders with odd characters, the Claude leader's CLI and approvals.
// Real processes only where the behaviour IS the process (Windows): every one is started from a temp folder and killed again by pid.
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCliOnPath, scratchDir, setEnv } from "./temp-root.ts";

// The tracker reads the data root when it writes its registry, so for this file the root stays isolated; the environment is put back when the file ends.
export const isolatedData = scratchDir();

const restoreDataEnv = setEnv({ CC_DATA_DIR: isolatedData, CC_TEST_FORCE_PACKAGED: "1" });

export const runner = await import("../server/runner.ts");

export const leader = await import("../server/leader.ts");

export const common = await import("../server/leader-common.ts");

fakeCliOnPath();

export const windowsOnly = { skip: process.platform !== "win32" ? "cmd.exe and Windows process behaviour" : false };

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(40);
  return check();
}

// A run is reported over only after its cleanup sweep, which the runner caps at SWEEP_WAIT_MS (server/runner.ts: LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000); a wait for a run's end must outlast that cap.
const SWEEP_CAP_MS = common.LIST_TIMEOUT_MS + common.KILL_TIMEOUT_MS + 1000;

export const END_WAIT_MS = SWEEP_CAP_MS + 7000;

export const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function killTree(pid: number): void { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }

// Files this test creates are removed one by one at the end (never a recursive delete).
export const made: string[] = [];

export const madeDirs: string[] = [];

// A process the test only learned the pid of (a grandchild) is remembered with its creation time: teardown kills it only if that pid still has
// the same creation time, never by a bare number that may name somebody's editor after a reuse.
type Seen = { pid: number; created: number };

export const tracked: Seen[] = [];

const LIST_RETRY_MS = 60_000;

// Reads the process list again until `done` accepts it; null when the bound passed first. A busy PC can fail one read, so one failure is not an answer.
async function readListUntil<T>(done: (list: NonNullable<Awaited<ReturnType<typeof common.listProcesses>>>) => T | undefined): Promise<T | null> {
  const end = Date.now() + LIST_RETRY_MS;
  do {
    const list = await common.listProcesses();
    const value = list ? done(list) : undefined;
    if (value !== undefined) return value;
    await sleep(500);
  } while (Date.now() < end);
  return null;
}

// A leftover nobody can identify must fail the test, not be skipped: its creation time is read or this throws.
export async function remember(pid: number): Promise<number> {
  const created = await readListUntil((list) => list.find((proc) => proc.pid === pid)?.created);
  if (created === null) throw new Error(`could not read the creation time of process ${pid} in ${LIST_RETRY_MS} ms: a leftover that cannot be identified cannot be cleaned up`);
  tracked.push({ pid, created });
  return pid;
}

export async function killSeen(entries: Seen[]): Promise<void> {
  if (!entries.length) return;
  const list = await readListUntil((now) => now);
  if (list === null) throw new Error(`could not read the process list in ${LIST_RETRY_MS} ms, so these were not checked or stopped: ${entries.map((entry) => entry.pid).join(", ")}`);
  for (const { pid, created } of entries) if (list.find((proc) => proc.pid === pid)?.created === created) killTree(pid);
}

export function scratch(name = "cc-pack2-"): string { const dir = mkdtempSync(join(tmpdir(), name)); madeDirs.push(dir); return dir; }

export function put(dir: string, name: string, text: string): string { const file = join(dir, name); writeFileSync(file, text); made.push(file); return file; }

// A test that failed halfway leaves files nobody registered, so a scratch folder (made by mkdtempSync here, so ours alone) is removed with what is
// in it, unless it holds a link (never followed or deleted through).
function removeScratch(dir: string): void {
  try { if (readdirSync(dir, { recursive: true, withFileTypes: true }).some((entry) => entry.isSymbolicLink())) return; } catch { return; }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test.after(async () => {
  // The data-root variables go back last: a tracker write still pending while the files are cleaned up must not resolve to the repo's own folders.
  try {
    await killSeen(tracked);
    for (const file of made) try { unlinkSync(file); } catch { /* already gone */ }
    for (const dir of madeDirs.reverse()) try { removeScratch(dir); } catch { /* a handle still held: left for the OS temp cleaner */ }
  } finally { restoreDataEnv(); }
});

// ---- the tracker, with a fake process list ----
type Proc = { pid: number; ppid: number; created: number };

export function fakeTree(initial: Proc[]) {
  const state = { list: initial as Proc[] | null, killed: [] as number[] };
  const deps = {
    list: async () => state.list,
    kill: async (pid: number) => { state.killed.push(pid); return true; },
    pollMs: 15,
    now: () => 1_000_000,
  };
  return { state, deps };
}

export const T0 = 1_000_000;

// Exits by itself after 120 s: a backstop so no fake can hold a test file (through a pipe it inherited) for ever.
export const HOLD_JS = `require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 120000);`;
