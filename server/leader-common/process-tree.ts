import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataRoot } from "../data-root.ts";
import { writeFileSynced, replaceFile } from "../safe-file.ts";
import { leaderChildEnv, windowsPowerShellPath, windowsTaskkillPath } from "./cli-path.ts";
import { sweepOrphanedChildren, type RegistryFile, type SweepResult } from "./orphans.ts";
import { LIST_TIMEOUT_MS, KILL_TIMEOUT_MS, KILL_CONFIRM_MS } from "./types.ts";

// Same tree kill the runner uses: the shell wrapper's pid is not the real CLI.
// A killer that fails (other than "process not found", 128) is reported once through onUnconfirmed, never silent.
export function killProcessTree(child: ChildProcess, onUnconfirmed?: () => void): void {
  if (!child.pid || child.exitCode !== null) return;
  // kill() returns false when the signal could not be sent; a child that already ended is not a failure.
  const plainKill = (): void => {
    let sent = false;
    try { sent = child.kill(); } catch { /* reported below */ }
    if (!sent && child.exitCode === null && child.signalCode === null) onUnconfirmed?.();
  };
  if (process.platform !== "win32") { plainKill(); return; }
  const forced = process.env.CC_TEST_FAKE_CLI === "1" ? process.env.CC_TEST_KILLER_EXIT : undefined;
  const killer = forced !== undefined
    ? spawn(process.execPath, ["-e", `process.exit(${Number(forced) || 0})`], { windowsHide: true, stdio: "ignore" })
    : spawn(windowsTaskkillPath(), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  killer.on("error", plainKill);
  killer.on("exit", (code) => {
    if (code === 0 || code === 128) return;
    // Two overlapping taskkills on one tree can make one of them exit with another code though the tree is gone: the root still alive after a short wait is the only proof it was not stopped.
    const ended = (): boolean => child.exitCode !== null || child.signalCode !== null;
    if (ended()) return;
    const finish = (alive: boolean): void => { clearTimeout(timer); child.off("exit", onExit); if (alive) onUnconfirmed?.(); };
    const onExit = (): void => finish(false);
    const timer = setTimeout(() => finish(!ended()), KILL_CONFIRM_MS);
    timer.unref();
    child.once("exit", onExit);
  });
}

export function deadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

// ---- Process trees. Without a Windows job object, a CLI's descendants are found by parent pid. ----
// While a CLI lives, a shared poll remembers every descendant (pid + creation time). When the CLI is stopped or ends, the ones still
// alive with the SAME creation time (so a reused pid is never touched) are killed. The same list is kept in a registry file, so a
// server that died hard (the native crash skips every exit hook) has its leftovers killed by the next start.
// ponytail: a process started and orphaned between two polls (POLL_MS) is missed; a Windows job object would close that gap.
export type ProcInfo = { pid: number; ppid: number; created: number };
export type ProcessLister = () => Promise<ProcInfo[] | null>;
// sweep(endedAt): endedAt is when the watched process ended (ms); children it started before then are still found by parent pid after it is gone.
// failed: how many leftovers the latest sweep tried to stop and could not (sweep's number counts only the ones it did stop).
export type TreeWatch = { sweep: (endedAt?: number) => Promise<number | null>; release: () => void; readonly failed: number };
export type TreeDeps = { list: ProcessLister; kill: (pid: number) => Promise<boolean>; registryDir?: () => string | null; pollMs?: number; now?: () => number; sweepAtFirstWatch?: boolean };
// slow: a long-lived process (a leader) that is looked at every SLOW_POLL_MS instead of POLL_MS while no worker run needs the fast poll.
export type TreeTracker = { watch: (pid: number, startedAt?: number, slow?: boolean) => TreeWatch; flushRegistry: () => void };

const POLL_MS = 5_000;
const SLOW_POLL_MS = 30_000;
export { LIST_TIMEOUT_MS, KILL_TIMEOUT_MS };
// A process is ours when it was created within this window around the moment we spawned it.
const BEFORE_SPAWN_MS = 5_000;
const AFTER_SPAWN_MS = 2_000;
const LIST_SCRIPT = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Where-Object { $_.CreationDate } | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }';

export function parseProcessList(text: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+),(\d+),(\d+)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), created: Number(match[3]) });
  }
  return rows;
}
// The descendants of rootPid by parent pid (the root itself excluded), a child only when created no earlier than its parent.
export function descendantsOf(list: ProcInfo[], rootPid: number): number[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const proc of list) byParent.set(proc.ppid, [...(byParent.get(proc.ppid) ?? []), proc]);
  const byPid = new Map(list.map((proc) => [proc.pid, proc]));
  const found: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const parentPid = queue.shift()!;
    const parent = byPid.get(parentPid);
    for (const child of byParent.get(parentPid) ?? []) {
      if (seen.has(child.pid) || (parent && child.created < parent.created)) continue;
      seen.add(child.pid); found.push(child.pid); queue.push(child.pid);
    }
  }
  return found;
}
// The process list through PowerShell (about 0.3 s): no compile step to time out on a cold start. null = it could not be read.
export function listProcesses(spawnFn: typeof spawn = spawn, timeoutMs = LIST_TIMEOUT_MS): Promise<ProcInfo[] | null> {
  return new Promise((done) => {
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: ProcInfo[] | null) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); done(value); };
    let child: ChildProcess;
    try { child = spawnFn(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", LIST_SCRIPT], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: leaderChildEnv() }); }
    catch { settle(null); return; }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { output += chunk; });
    timer = setTimeout(() => { try { child.kill(); } catch { /* the timeout answers null */ } settle(null); }, timeoutMs);
    child.once("error", () => settle(null));
    child.once("close", (code) => settle(code === 0 ? parseProcessList(output) : null));
  });
}
function killPid(pid: number): Promise<boolean> {
  return new Promise((done) => {
    let killer: ChildProcess;
    try { killer = spawn(windowsTaskkillPath(), ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { done(false); return; }
    const timer = setTimeout(() => { try { killer.kill(); } catch { /* answered below */ } done(false); }, KILL_TIMEOUT_MS);
    timer.unref();
    killer.once("error", () => { clearTimeout(timer); done(false); });
    killer.once("exit", (code) => { clearTimeout(timer); done(code === 0 || code === 128); });
  });
}

// Test seam (the fake-CLI runner only): CC_TEST_TREE_FILE names a JSON file { extra: ProcInfo[], failKill: number[] } read at every use. The listed
// made-up processes join the real process list, and their kill is only pretended (it fails for the pids in failKill). Real processes are untouched.
// listDelayMs slows every list by that long (a busy PC), failList: true makes it unreadable (null).
// Every pretended kill is also appended to <CC_TEST_TREE_FILE>.kills as one JSON line { pid, ok, at }, so a test can wait for a sweep's attempt.
const treeSeamFile = (): string | undefined => (process.env.CC_TEST_FAKE_CLI === "1" ? process.env.CC_TEST_TREE_FILE : undefined);
// A read that fails (the file is being replaced) keeps the last good value, so a race cannot make the made-up processes vanish for one read.
type TreeSeam = { extra: ProcInfo[]; failKill: number[]; listDelayMs?: number; failList?: boolean };
let lastSeam: TreeSeam = { extra: [], failKill: [] };
function treeSeam(): TreeSeam {
  try { lastSeam = { extra: [], failKill: [], ...JSON.parse(readFileSync(treeSeamFile()!, "utf8")) }; } catch { /* keep the last good one */ }
  return lastSeam;
}
// A leader child is watched when it is the real CLI (its pid is real); a test's fake CLI child only with the seam above, whose process is real too.
export const watchesLeaderChild = (spawnFn: unknown): boolean => spawnFn === undefined || treeSeamFile() !== undefined;
async function listWithSeam(): Promise<ProcInfo[] | null> {
  const list = await listProcesses();
  if (!treeSeamFile()) return list;
  const seam = treeSeam();
  if (seam.listDelayMs) await new Promise((done) => setTimeout(done, seam.listDelayMs));
  return list && !seam.failList ? [...list, ...seam.extra] : null;
}
function killWithSeam(pid: number): Promise<boolean> {
  if (treeSeamFile()) {
    const seam = treeSeam();
    if (seam.extra.some((proc) => proc.pid === pid)) {
      const ok = !seam.failKill.includes(pid);
      try { appendFileSync(`${treeSeamFile()}.kills`, JSON.stringify({ pid, ok, at: Date.now() }) + "\n"); } catch { /* the record is only for the tests */ }
      return Promise.resolve(ok);
    }
  }
  return killPid(pid);
}

type WatchedRoot = { pid: number; startedAt: number; slow: boolean; endedAt: number | null; rootCreated: number | null; known: Map<number, number> };

export function createTreeTracker(deps: TreeDeps): TreeTracker {
  const roots = new Set<WatchedRoot>();
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;
  let timerMs = 0;
  let polling = false;
  let ownerCreated: number | null = null;
  let swept = !deps.sweepAtFirstWatch;

  function writeRegistry(): void {
    const dir = deps.registryDir?.();
    if (!dir) return;
    const file = join(dir, `.children-${process.pid}.json`);
    try {
      const keep = [...roots].filter((root) => root.known.size > 0 || root.rootCreated !== null);
      if (!keep.length) { try { unlinkSync(file); } catch { /* none written */ } return; }
      const body: RegistryFile = { owner: { pid: process.pid, created: ownerCreated }, roots: keep.map((root) => ({ pid: root.pid, rootCreated: root.rootCreated, known: [...root.known] })) };
      // Only the logs folder itself is created, never its parents: a data root that is gone (a test removed it) is not brought back by the exit hook.
      try { mkdirSync(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
      const temp = `${file}.tmp`;
      try { unlinkSync(temp); } catch { /* none left over */ }
      writeFileSynced(temp, JSON.stringify(body));
      replaceFile(temp, file);
    } catch { /* the registry is a safety net; the live kill paths do not depend on it */ }
  }
  // Adds what the list shows under this root to its known set; true when something new was found.
  function discover(root: WatchedRoot, list: ProcInfo[]): boolean {
    const byPid = new Map(list.map((proc) => [proc.pid, proc]));
    const at = byPid.get(root.pid);
    // Once the root's creation time is known only that exact process is the root; a later one with the same pid is somebody else.
    const ours = at !== undefined && (root.rootCreated !== null
      ? at.created === root.rootCreated
      : at.created >= root.startedAt - BEFORE_SPAWN_MS && at.created <= root.startedAt + AFTER_SPAWN_MS && (root.endedAt === null || at.created <= root.endedAt));
    const byParent = new Map<number, ProcInfo[]>();
    for (const proc of list) byParent.set(proc.ppid, [...(byParent.get(proc.ppid) ?? []), proc]);
    const queue: ProcInfo[] = [];
    let changed = false;
    if (ours) { queue.push(at); if (root.rootCreated !== at.created) { root.rootCreated = at.created; changed = true; } }
    // The root is gone: what it started still names its pid as parent. Its pid cannot be reused before it ended, so anything created
    // between its start and its end is its child; anything created later (or after another process took the pid) is not.
    // A child older than the root belongs to an earlier owner of the pid: the root's own creation time when known, else the spawn moment.
    else if (root.endedAt !== null) {
      const notBefore = root.rootCreated ?? root.startedAt;
      for (const child of byParent.get(root.pid) ?? []) {
        if (child.created < notBefore || child.created >= root.endedAt || (at !== undefined && child.created >= at.created)) continue;
        queue.push(child);
        if (root.known.get(child.pid) !== child.created) { root.known.set(child.pid, child.created); changed = true; }
      }
    }
    for (const [pid, created] of root.known) { const proc = byPid.get(pid); if (proc && proc.created === created) queue.push(proc); }
    const seen = new Set<number>(queue.map((proc) => proc.pid));
    while (queue.length) {
      const parent = queue.shift()!;
      for (const child of byParent.get(parent.pid) ?? []) {
        if (seen.has(child.pid) || child.created < parent.created) continue;
        seen.add(child.pid); queue.push(child);
        if (root.known.get(child.pid) !== child.created) { root.known.set(child.pid, child.created); changed = true; }
      }
    }
    return changed;
  }
  function noteOwner(list: ProcInfo[]): void {
    if (ownerCreated === null) ownerCreated = list.find((proc) => proc.pid === process.pid)?.created ?? null;
  }
  let pollAgain = false;
  async function tick(): Promise<void> {
    if (polling) { pollAgain = true; return; } // a list already running may predate this ask: one more right after it
    polling = true;
    try {
      const list = await deps.list();
      if (!list) return;
      noteOwner(list);
      let changed = false;
      for (const root of roots) if (discover(root, list)) changed = true;
      if (changed) writeRegistry();
    } finally { polling = false; if (pollAgain) { pollAgain = false; void tick().catch(() => {}); } }
  }
  // One poll for every watched root: fast while any worker run is among them, slow when only leaders are.
  function reschedule(): void {
    if (!roots.size) { if (timer) clearInterval(timer); timer = null; return; }
    const ms = deps.pollMs ?? ([...roots].some((root) => !root.slow) ? POLL_MS : SLOW_POLL_MS);
    if (timer && timerMs === ms) return;
    if (timer) clearInterval(timer);
    timerMs = ms;
    timer = setInterval(() => { void tick().catch(() => {}); }, ms);
    timer.unref();
  }

  return {
    watch(pid, startedAt = now(), slow = false) {
      const root: WatchedRoot = { pid, startedAt, slow, endedAt: null, rootCreated: null, known: new Map() };
      let failed = 0;
      roots.add(root);
      reschedule();
      void tick().catch(() => {}); // record the root and its creation time at once, not after the first slow poll
      if (!swept) { swept = true; void sweepOrphanedChildren(deps).catch(() => {}); }
      return {
        get failed() { return failed; },
        // Kills what this root left alive; null = the process list could not be read, so nothing was touched.
        async sweep(endedAt) {
          failed = 0;
          if (!roots.has(root)) return 0;
          if (endedAt !== undefined) root.endedAt = endedAt;
          const list = await deps.list();
          if (!list) return null;
          noteOwner(list);
          discover(root, list);
          const alive = new Map(list.map((proc) => [proc.pid, proc.created]));
          const targets = [...root.known].filter(([knownPid, created]) => alive.get(knownPid) === created).map(([knownPid]) => knownPid);
          if (root.rootCreated !== null && alive.get(root.pid) === root.rootCreated) targets.push(root.pid);
          const results = await Promise.all(targets.map((target) => deps.kill(target)));
          // A target whose kill failed stays tracked (here and in the registry), so a later sweep or the next start retries it.
          failed = results.filter((ok) => !ok).length;
          targets.forEach((target, i) => { if (results[i]) root.known.delete(target); });
          if (results.every(Boolean)) roots.delete(root);
          reschedule();
          writeRegistry();
          return results.filter(Boolean).length;
        },
        release() { roots.delete(root); reschedule(); writeRegistry(); },
      };
    },
    // At process exit: a root with remembered leftovers keeps its registry file, so the next start can finish the job with verified pids.
    flushRegistry: writeRegistry,
  };
}

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const defaultRegistryDir = (): string => join(resolveDataRoot(process.env, repoRoot), "logs");
export let tracker: TreeTracker | null = null;
export function processTree(): TreeTracker {
  return tracker ??= createTreeTracker({ list: listWithSeam, kill: killWithSeam, registryDir: defaultRegistryDir, sweepAtFirstWatch: true });
}
export function setProcessTreeForTests(next: TreeTracker | null): void { tracker = next; }
export function watchProcessTree(pid: number, startedAt = Date.now(), slow = false): TreeWatch { return processTree().watch(pid, startedAt, slow); }
// For the server start: finish what a crashed server left behind (safe to call more than once).
export function sweepOrphans(): Promise<SweepResult> {
  return sweepOrphanedChildren({ list: () => listProcesses(), kill: killPid, registryDir: defaultRegistryDir });
}
