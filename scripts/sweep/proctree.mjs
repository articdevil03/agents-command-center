import { spawn } from "node:child_process";
import { join } from "node:path";

// The only way the sweep stops a process: by pid AND CreationDate, and only inside the tree of a process the sweep spawned itself.
// Never by command-line text, name, path or port (a text match once closed every program on the owner's PC). The sweep never imports app code:
// the design is copied from server/leader-common/process-tree.ts, not the module.
const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const LIST_SCRIPT = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Where-Object { $_.CreationDate } | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }';
const LIST_TIMEOUT_MS = 20_000;
const POLL_MS = 2000;
const GONE_WAIT_MS = 5000;
const GONE_STEP_MS = 250;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseProcessList(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+),(\d+),(\d+)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), created: Number(match[3]) });
  }
  return rows;
}

// One PowerShell read of every process (about 0.3 s). A failure or a timeout throws: it must never read as "nothing is running".
export function listProcesses() {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const settle = (finish, value) => { if (settled) return; settled = true; clearTimeout(timer); finish(value); };
    const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", LIST_SCRIPT], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { child.kill(); settle(reject, new Error(`listProcesses: no answer in ${LIST_TIMEOUT_MS} ms`)); }, LIST_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.once("error", (err) => settle(reject, err));
    child.once("close", (code) => (code === 0 ? settle(resolve, parseProcessList(output)) : settle(reject, new Error(`listProcesses: powershell exited ${code}`))));
  });
}

// The parents above a process, nearest first; a parent only counts when created no later than its child (a reused pid cannot be a parent).
function ancestorPids(byPid, proc) {
  const found = [];
  for (let current = proc; ;) {
    const parent = byPid.get(current.ppid);
    if (!parent || parent.created > current.created || parent.pid === proc.pid || found.includes(parent.pid)) return found;
    found.push(parent.pid);
    current = parent;
  }
}

// PURE: nothing is touched. Refuses the whole list (throws) before naming any target if one candidate is us, our parent chain, untracked or older than us.
export function planKill({ list, tracked, pids = [...tracked.keys()], selfPid = process.pid }) {
  const byPid = new Map(list.map((proc) => [proc.pid, proc]));
  const self = byPid.get(selfPid);
  if (!self) throw new Error(`planKill: refusing everything, the sweep's own process ${selfPid} is not in the list`);
  const protectedPids = new Set([selfPid, ...ancestorPids(byPid, self)]);
  for (const pid of pids) {
    if (!tracked.has(pid)) throw new Error(`planKill: refusing pid ${pid}, it is not in the tracked set`);
    if (protectedPids.has(pid)) throw new Error(`planKill: refusing pid ${pid}, it is the sweep itself or one of its parents`);
    if (tracked.get(pid) < self.created) throw new Error(`planKill: refusing pid ${pid}, it was created before the sweep process`);
  }
  // A tracked pid alive with another CreationDate is a reused pid, somebody else's process: not a target.
  return pids.filter((pid) => byPid.get(pid)?.created === tracked.get(pid))
    .map((pid) => ({ pid, created: tracked.get(pid), depth: ancestorPids(byPid, byPid.get(pid)).length }))
    .sort((a, b) => a.depth - b.depth)
    .map(({ pid, created }) => ({ pid, created }));
}

// Adds the root (first sight) and every live descendant of a live tracked process. A child of a dead parent is never adopted.
// ponytail: a process whose parent died before any poll saw it is never adopted; a Windows job object per run would close that gap.
export function recordTree(list, rootPid, tracked) {
  const byPid = new Map(list.map((proc) => [proc.pid, proc]));
  const children = new Map();
  for (const proc of list) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc]);
  const root = byPid.get(rootPid);
  if (root && !tracked.has(rootPid)) tracked.set(rootPid, root.created);
  const queue = [...tracked].map(([pid]) => byPid.get(pid)).filter((proc) => proc && proc.created === tracked.get(proc.pid));
  while (queue.length) {
    const parent = queue.shift();
    for (const child of children.get(parent.pid) ?? []) {
      if (child.created < parent.created || tracked.get(child.pid) === child.created) continue;
      tracked.set(child.pid, child.created);
      queue.push(child);
    }
  }
}

// ---- one shared poller for the whole process: one list at a time, only while a run is registered ----

const watched = new Set();
let pollTimer = null;
let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const list = await listProcesses();
    for (const entry of watched) recordTree(list, entry.rootPid, entry.tracked);
  } catch { /* a missed poll is retried at the next tick; killTracked lists again and throws if it cannot */ } finally { polling = false; }
}

// rootPid is the child just spawned, so an entry left for that pid by an earlier run in the same lane is stale: dropped once here, never replaced by a poll.
export function watchTree(rootPid, tracked) {
  tracked.delete(rootPid);
  const entry = { rootPid, tracked };
  watched.add(entry);
  if (!pollTimer) { pollTimer = setInterval(poll, POLL_MS); pollTimer.unref(); }
  return () => {
    watched.delete(entry);
    if (!watched.size && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };
}

const stillAlive = (list, targets) => targets.filter(({ pid, created }) => list.some((proc) => proc.pid === pid && proc.created === created));

// list / kill are seams for tests. A test that passes a FAKE list must also pass a fake kill that kills nothing.
export async function killTracked(tracked, { root, list = listProcesses, kill = (pid) => process.kill(pid) } = {}) {
  const before = await list();
  recordTree(before, root, tracked);
  const targets = planKill({ list: before, tracked });
  for (const { pid } of targets) { try { kill(pid); } catch { /* already gone, or the check below says otherwise */ } }
  for (let waited = 0; targets.length; waited += GONE_STEP_MS) {
    const left = stillAlive(await list(), targets);
    if (!left.length) break;
    if (waited >= GONE_WAIT_MS) throw new Error(`killTracked: still alive after ${GONE_WAIT_MS} ms: ${left.map(({ pid }) => pid).join(", ")}`);
    await wait(GONE_STEP_MS);
  }
  return { killed: targets.map(({ pid }) => pid) };
}
