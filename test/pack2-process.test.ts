// Fix pack 2, block 2 (launching agents): process trees, crash leftovers, folders with odd characters, the Claude leader's CLI and approvals.
// Real processes only where the behaviour IS the process (Windows): every one is started from a temp folder and killed again by pid.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fakeCliOnPath, scratchDir, setEnv } from "./temp-root.ts";

// The tracker reads the data root when it writes its registry, so for this file the root stays isolated; the environment is put back when the file ends.
const isolatedData = scratchDir();
const restoreDataEnv = setEnv({ CC_DATA_DIR: isolatedData, CC_TEST_FORCE_PACKAGED: "1" });
const runner = await import("../server/runner.ts");
const leader = await import("../server/leader.ts");
const common = await import("../server/leader-common.ts");
fakeCliOnPath();

const windowsOnly = { skip: process.platform !== "win32" ? "cmd.exe and Windows process behaviour" : false };
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(40);
  return check();
}
// A run is reported over only after its cleanup sweep, which the runner caps at SWEEP_WAIT_MS (server/runner.ts: LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000); a wait for a run's end must outlast that cap.
const SWEEP_CAP_MS = common.LIST_TIMEOUT_MS + common.KILL_TIMEOUT_MS + 1000;
const END_WAIT_MS = SWEEP_CAP_MS + 7000;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
function killTree(pid: number): void { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }

// Files this test creates are removed one by one at the end (never a recursive delete).
const made: string[] = [];
const madeDirs: string[] = [];
// A process the test only learned the pid of (a grandchild) is remembered with its creation time: teardown kills it only if that pid still has
// the same creation time, never by a bare number that may name somebody's editor after a reuse.
type Seen = { pid: number; created: number | null };
const tracked: Seen[] = [];
async function remember(pid: number): Promise<number> {
  const list = await common.listProcesses();
  tracked.push({ pid, created: list?.find((proc) => proc.pid === pid)?.created ?? null });
  return pid;
}
async function killSeen(entries: Seen[]): Promise<void> {
  const list = await common.listProcesses();
  for (const { pid, created } of entries) if (created !== null && list?.find((proc) => proc.pid === pid)?.created === created) killTree(pid);
}
function scratch(name = "cc-pack2-"): string { const dir = mkdtempSync(join(tmpdir(), name)); madeDirs.push(dir); return dir; }
function put(dir: string, name: string, text: string): string { const file = join(dir, name); writeFileSync(file, text); made.push(file); return file; }
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
function fakeTree(initial: Proc[]) {
  const state = { list: initial as Proc[] | null, killed: [] as number[] };
  const deps = {
    list: async () => state.list,
    kill: async (pid: number) => { state.killed.push(pid); return true; },
    pollMs: 15,
    now: () => 1_000_000,
  };
  return { state, deps };
}
const T0 = 1_000_000;

test("tracker: a grandchild seen by a poll is killed after its parent died, and a process that reused a pid is left alone", async () => {
  const { state, deps } = fakeTree([
    { pid: 100, ppid: 1, created: T0 }, { pid: 200, ppid: 100, created: T0 + 100 }, { pid: 300, ppid: 200, created: T0 + 200 },
  ]);
  const tracker = common.createTreeTracker(deps);
  const watch = tracker.watch(100, T0);
  await sleep(120); // at least one poll saw the whole chain
  state.list = [{ pid: 300, ppid: 200, created: T0 + 200 }, { pid: 555, ppid: 1, created: T0 + 400 }]; // root and middle are gone
  assert.equal(await watch.sweep(T0 + 500), 1);
  assert.deepEqual(state.killed, [300], "only the remembered grandchild");
  // the same pid, but a different creation time: another process now
  const second = fakeTree([{ pid: 100, ppid: 1, created: T0 }, { pid: 300, ppid: 100, created: T0 + 100 }]);
  const watched = common.createTreeTracker(second.deps).watch(100, T0);
  await sleep(120);
  second.state.list = [{ pid: 300, ppid: 77, created: T0 + 99_999 }];
  assert.equal(await watched.sweep(T0 + 500), 0);
  assert.deepEqual(second.state.killed, [], "a reused pid is never touched");
});

test("tracker: with the root already gone, its children are found by parent pid, but only those created during its life", async () => {
  const { state, deps } = fakeTree([]);
  const watch = common.createTreeTracker(deps).watch(100, T0);
  state.list = [
    { pid: 201, ppid: 100, created: T0 + 300 }, // started by the root before it ended
    { pid: 202, ppid: 201, created: T0 + 350 }, // and its own child
    { pid: 900, ppid: 100, created: T0 + 60_000 }, // a later process that now owns the reused pid 100
  ];
  assert.equal(await watch.sweep(T0 + 1000), 2);
  assert.deepEqual(state.killed.sort(), [201, 202]);
});

test("tracker: a child of an earlier owner of the root pid, older than the root, is never adopted", async () => {
  // root 100 was seen (created T0), then ended; 900 names pid 100 as parent but was created before it
  const seen = fakeTree([{ pid: 100, ppid: 1, created: T0 }]);
  const watchSeen = common.createTreeTracker(seen.deps).watch(100, T0);
  await sleep(80);
  seen.state.list = [{ pid: 900, ppid: 100, created: T0 - 1000 }];
  assert.equal(await watchSeen.sweep(T0 + 1000), 0);
  assert.deepEqual(seen.state.killed, [], "root creation time known: the older child is left alone");
  // root never seen by a poll: the spawn moment is the floor, with no grace before it
  const unseen = fakeTree([]);
  const watchUnseen = common.createTreeTracker(unseen.deps).watch(100, T0);
  unseen.state.list = [{ pid: 900, ppid: 100, created: T0 - 1000 }, { pid: 901, ppid: 100, created: T0 + 5 }];
  assert.equal(await watchUnseen.sweep(T0 + 1000), 1);
  assert.deepEqual(unseen.state.killed, [901], "root creation time unknown: only a child created at or after the spawn");
});

test("tracker: an unreadable process list kills nothing and says so", async () => {
  const { state, deps } = fakeTree([{ pid: 100, ppid: 1, created: T0 }, { pid: 200, ppid: 100, created: T0 + 10 }]);
  const watch = common.createTreeTracker(deps).watch(100, T0);
  await sleep(80);
  state.list = null;
  assert.equal(await watch.sweep(T0 + 100), null);
  assert.deepEqual(state.killed, []);
  state.list = [{ pid: 200, ppid: 100, created: T0 + 10 }];
  assert.equal(await watch.sweep(T0 + 100), 1, "the watch survives a failed attempt and can be swept again");
});

test("tracker: sweeping twice or releasing a watch kills nothing the second time", async () => {
  const { state, deps } = fakeTree([{ pid: 100, ppid: 1, created: T0 }, { pid: 200, ppid: 100, created: T0 + 10 }]);
  const tracker = common.createTreeTracker(deps);
  const watch = tracker.watch(100, T0);
  assert.equal(await watch.sweep(T0 + 100), 2, "the root itself, still alive, and its child");
  assert.equal(await watch.sweep(T0 + 100), 0);
  const other = tracker.watch(100, T0);
  other.release();
  assert.equal(await other.sweep(T0 + 100), 0);
  assert.equal(state.killed.length, 2);
});

test("tracker: workers are polled every 5 s, a leader alone only every 30 s, and the poll slows again when the last worker is gone", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let lists = 0;
  const settle = () => sleep(0); // a poll that is still waiting for its list is skipped; let it finish
  const tracker = common.createTreeTracker({ list: async () => { lists++; return []; }, kill: async () => true, now: () => T0 });
  const leaderWatch = tracker.watch(1, T0, true);
  await settle();
  const first = lists;
  assert.equal(first, 1, "a new watch lists the processes once at once, so its root is recorded before the first slow poll");
  t.mock.timers.tick(25_000); await settle();
  assert.equal(lists, first, "a leader alone is not looked at every 5 s");
  t.mock.timers.tick(5_000); await settle();
  assert.equal(lists, first + 1, "but it is looked at after 30 s");
  const worker = tracker.watch(2, T0);
  await settle();
  assert.equal(lists, first + 2, "the worker's own first look");
  t.mock.timers.tick(5_000); await settle();
  assert.equal(lists, first + 3, "a worker run brings the fast poll");
  await worker.sweep(T0);
  const afterSweep = lists;
  t.mock.timers.tick(25_000); await settle();
  assert.equal(lists, afterSweep, "with the worker gone the poll is slow again");
  t.mock.timers.tick(5_000); await settle();
  assert.equal(lists, afterSweep + 1);
  leaderWatch.release();
  t.mock.timers.tick(120_000);
  assert.equal(lists, afterSweep + 1, "no roots, no poll");
});

// ---- the registry a crashed server leaves behind ----
test("registry: a server that died hard leaves a file that the next start uses to kill the survivors it can still prove are the same processes", async () => {
  const dir = scratch();
  const { state, deps } = fakeTree([
    { pid: 100, ppid: 1, created: T0 }, { pid: 200, ppid: 100, created: T0 + 10 }, { pid: process.pid, ppid: 1, created: T0 - 50_000 },
  ]);
  const tracker = common.createTreeTracker({ ...deps, registryDir: () => dir });
  const registered = tracker.watch(100, T0);
  assert.ok(await until(() => readdirSync(dir).some((name) => name.startsWith(".children-"))), "the poll wrote the registry");
  const file = join(dir, readdirSync(dir).find((name) => name.startsWith(".children-"))!);
  made.push(file);
  const body = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(body.owner.pid, process.pid);
  assert.deepEqual(body.roots[0].known, [[200, T0 + 10]]);
  // Another server's file: owner 4242 is dead, child 200 is still the same process, child 201 now has a different creation time.
  const crashed = join(dir, ".children-4242.json"); made.push(crashed);
  writeFileSync(crashed, JSON.stringify({ owner: { pid: 4242, created: T0 - 9000 }, roots: [{ pid: 100, rootCreated: T0, known: [[200, T0 + 10], [201, T0 + 11]] }] }));
  const alivesFile = join(dir, ".children-7.json"); made.push(alivesFile);
  writeFileSync(alivesFile, JSON.stringify({ owner: { pid: 7, created: T0 - 1 }, roots: [{ pid: 100, rootCreated: T0, known: [[200, T0 + 10]] }] }));
  state.list = [{ pid: 100, ppid: 1, created: T0 }, { pid: 200, ppid: 100, created: T0 + 10 }, { pid: 201, ppid: 1, created: T0 + 9999 }, { pid: 7, ppid: 1, created: T0 - 1 }];
  state.killed.length = 0;
  const result = await common.sweepOrphanedChildren({ ...deps, registryDir: () => dir });
  assert.deepEqual(state.killed.sort(), [100, 200], "the root and the child that are provably the recorded processes");
  assert.deepEqual(result, { checked: 2, killed: 2 });
  assert.equal(existsSync(crashed), false, "a handled file is removed");
  assert.equal(existsSync(alivesFile), true, "a file whose owner is still running is left alone");
  unlinkSync(alivesFile);
  registered.release(); // stops the poll and removes this process's own file
  assert.equal(existsSync(file), false);
});

test("registry: the real start-up sweep looks in the data root's logs folder and removes an unreadable file", async () => {
  const logs = join(isolatedData, "logs");
  mkdirSync(logs, { recursive: true });
  const bad = join(logs, ".children-31337.json");
  writeFileSync(bad, "{ not json");
  made.push(bad);
  const result = await common.sweepOrphans();
  assert.deepEqual(result, { checked: 0, killed: 0 });
  assert.equal(existsSync(bad), false, "the start-up sweep read this data root's logs folder");
});

// ---- real process tree facts ----
test("the process list shows this process with a plausible start time, and its child as a descendant", windowsOnly, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await remember(child.pid!);
  try {
    const list = await common.listProcesses();
    assert.ok(list, "the list could be read");
    const me = list.find((proc) => proc.pid === process.pid)!;
    assert.ok(me, "this process is in the list");
    assert.ok(me.created < Date.now() && me.created > Date.now() - 6 * 3600_000, `start time ${me.created} is a recent real time`);
    assert.ok(common.descendantsOf(list, process.pid).includes(child.pid!), "the child is a descendant");
  } finally { if (child.exitCode === null && child.signalCode === null) killTree(child.pid!); }
});

// ---- a worker run, end to end through the real runner ----
function fakeCliDir(script: string, name = "codex"): { dir: string; bin: string } {
  const bin = scratch("cc-pack2-bin-");
  put(bin, `${name}.cmd`, script);
  return { dir: scratch("cc-pack2-work-"), bin };
}
function withPath<T>(bin: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
  return work().finally(() => { process.env.PATH = previous; });
}
function makeRun(folder: string, overrides: Record<string, unknown> = {}) {
  return { runId: "p2-run", seatKey: "p2-tab.coder", slotId: "coder", name: "Sonny", cli: "codex", model: "gpt-6-sol", effort: "high", folder, canWrite: true, startedAt: 100, ...overrides } as import("../server/runner.ts").RunnerRun;
}
function capture() {
  const statuses: Array<{ status: string; code?: number }> = [], outputs: string[] = [];
  return { statuses, outputs, cb: { onOutput: (_run: unknown, text: string) => outputs.push(text), onStatus: (_run: unknown, status: string, code?: number) => statuses.push({ status, code }) } as import("../server/runner.ts").RunnerCallbacks };
}
const HOLD_JS = `require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`;

test("a background process the CLI leaves behind is stopped when the run ends, and the log says so", windowsOnly, async () => {
  const { dir, bin } = fakeCliDir(`@echo off\r\nstart "" /b "${process.execPath}" "%~dp0hold.js" "%~dp0hold.pid"\r\nping -n 3 127.0.0.1 >nul\r\nexit /b 0\r\n`);
  put(bin, "hold.js", HOLD_JS);
  const pidFile = join(bin, "hold.pid"); made.push(pidFile);
  const c = capture();
  await withPath(bin, async () => {
    const started = runner.runSeat(makeRun(dir, { runId: "p2-leftover" }), "go", c.cb, spawn);
    assert.equal(started.ok, true);
    assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0), "the fake CLI started its background process");
    const held = Number(readFileSync(pidFile, "utf8"));
    await remember(held);
    assert.ok(alive(held));
    assert.ok(await until(() => c.statuses.some((entry) => entry.status !== "working"), 20_000), `the run ended: ${c.statuses.map((s) => s.status)}`);
    const outs = c.outputs.join("");
    assert.equal(c.statuses.at(-1)?.status, "done", `output: ${outs}`);
    // The runner prints this one line for three causes: the report cap (SWEEP_WAIT_MS in server/runner.ts), a process list that could not be read, or a sweep that threw. It never tells them apart, and "unchecked" is never a pass.
    if (/could not check for processes this run left running/.test(outs)) {
      const late = await until(() => !alive(held), 20_000); // a sweep that was only capped keeps going after the report
      assert.fail(`the cleanup of leftover processes was NOT checked (the report cap SWEEP_WAIT_MS, an unreadable process list, or a failed sweep); the leftover was ${late ? "stopped afterwards" : "STILL ALIVE 20 s later"}. output: ${c.outputs.join("")}`);
    }
    assert.equal(alive(held), false, `the leftover process was stopped before the run was reported over. output: ${outs}`);
    assert.match(outs, /\[cleanup\] stopped 1 process this run left running/);
  });
});

// The process list is slowed (or made unreadable) through the tree seam; the real runner, real tracker and a real leftover process run as usual.
async function runWithLeftover(runId: string, seam: Record<string, unknown>) {
  const { dir, bin } = fakeCliDir(`@echo off\r\nstart "" /b "${process.execPath}" "%~dp0hold.js" "%~dp0hold.pid"\r\nping -n 3 127.0.0.1 >nul\r\nexit /b 0\r\n`);
  put(bin, "hold.js", HOLD_JS);
  const pidFile = join(bin, "hold.pid"); made.push(pidFile);
  const seamFile = put(bin, "tree.json", JSON.stringify({ extra: [], failKill: [], ...seam }));
  made.push(`${seamFile}.kills`);
  const previous = { fake: process.env.CC_TEST_FAKE_CLI, tree: process.env.CC_TEST_TREE_FILE };
  process.env.CC_TEST_FAKE_CLI = "1"; process.env.CC_TEST_TREE_FILE = seamFile;
  const c = capture();
  try {
    return await withPath(bin, async () => {
      assert.equal(runner.runSeat(makeRun(dir, { runId }), "go", c.cb, spawn).ok, true);
      assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0), "the fake CLI started its background process");
      const held = Number(readFileSync(pidFile, "utf8"));
      await remember(held);
      assert.ok(await until(() => c.statuses.some((entry) => entry.status !== "working"), 30_000), `the run ended: ${c.statuses.map((s) => s.status)}`);
      const aliveAtReport = alive(held);
      if (aliveAtReport) killTree(held); // the failing-list case leaves it running: stopped here, not left for teardown
      return { outs: c.outputs.join(""), status: c.statuses.at(-1)?.status, aliveAtReport };
    });
  } finally {
    if (previous.fake === undefined) delete process.env.CC_TEST_FAKE_CLI; else process.env.CC_TEST_FAKE_CLI = previous.fake;
    if (previous.tree === undefined) delete process.env.CC_TEST_TREE_FILE; else process.env.CC_TEST_TREE_FILE = previous.tree;
  }
}

test("a slow process list (longer than the old 4 s cap) still ends with the leftover stopped and no 'could not check'", windowsOnly, async () => {
  const r = await runWithLeftover("p2-slowlist", { listDelayMs: 5000 });
  assert.equal(r.status, "done", `output: ${r.outs}`);
  assert.doesNotMatch(r.outs, /could not check/, r.outs);
  assert.match(r.outs, /\[cleanup\] stopped 1 process this run left running/);
  assert.equal(r.aliveAtReport, false, "the leftover was dead when the run was reported over");
});

test("a process list that cannot be read still says 'could not check' (the branch is kept)", windowsOnly, async () => {
  const r = await runWithLeftover("p2-faillist", { failList: true });
  assert.equal(r.status, "done", `output: ${r.outs}`);
  assert.match(r.outs, /\[cleanup\] could not check for processes this run left running/);
});

test("stopping a run kills the shell wrapper, the CLI and what it started", windowsOnly, async () => {
  const { dir, bin } = fakeCliDir(`@echo off\r\nstart "" /b "${process.execPath}" "%~dp0hold.js" "%~dp0hold2.pid"\r\nping -n 60 127.0.0.1 >nul\r\n`);
  put(bin, "hold.js", HOLD_JS);
  const pidFile = join(bin, "hold2.pid"); made.push(pidFile);
  const c = capture();
  await withPath(bin, async () => {
    assert.equal(runner.runSeat(makeRun(dir, { runId: "p2-stop" }), "go", c.cb, spawn).ok, true);
    assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0));
    const held = Number(readFileSync(pidFile, "utf8"));
    await remember(held);
    assert.equal(runner.killRun("p2-stop"), true);
    assert.ok(await until(() => c.statuses.some((entry) => entry.status === "stopped"), 20_000), `stopped: ${JSON.stringify(c.statuses)}`);
    assert.equal(alive(held), false, "the background process died with the run");
  });
});

test("killRun starts the real System32 taskkill even when the server's own folder holds a decoy", windowsOnly, async () => {
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const decoyDir = scratch("cc-pack2-decoy-");
  const decoy = join(decoyDir, "taskkill.exe");
  copyFileSync(join(system32, "whoami.exe"), decoy); made.push(decoy);
  const { dir, bin } = fakeCliDir(`@echo off\r\nping -n 60 127.0.0.1 >nul\r\n`);
  const c = capture();
  const before = process.cwd();
  await withPath(bin, async () => {
    assert.equal(runner.runSeat(makeRun(dir, { runId: "p2-decoy" }), "go", c.cb, spawn).ok, true);
    await sleep(500);
    process.chdir(decoyDir); // the folder a server started from
    try {
      assert.equal(runner.killRun("p2-decoy"), true);
      assert.ok(await until(() => c.statuses.some((entry) => entry.status === "stopped"), END_WAIT_MS), `the real taskkill ran: ${JSON.stringify(c.statuses)}`);
    } finally {
      process.chdir(before);
      if (!c.statuses.some((entry) => entry.status === "stopped")) runner.killRun("p2-decoy"); // a failed run must not leave its process behind
    }
  });
});

test("Stop all also sweeps what a released (unconfirmed) run left behind", windowsOnly, async () => {
  const { dir, bin } = fakeCliDir(`@echo off

ping -n 40 127.0.0.1 >nul

`);
  const sweeps: number[] = [];
  common.setProcessTreeForTests({ watch: () => ({ sweep: async (endedAt) => { sweeps.push(endedAt ?? -1); return 0; }, release() {} }), flushRegistry() {} });
  const killer = Object.assign(new EventEmitter(), { pid: 1 });
  const fakeKill = (() => killer) as any;
  let pid = 0;
  try {
    await withPath(bin, async () => {
      assert.equal(runner.runSeat(makeRun(dir, { runId: "p2-released" }), "go", capture().cb, spawn).ok, true);
      await sleep(400);
      runner.killRun("p2-released", fakeKill);
      killer.emit("error", new Error("taskkill could not start")); // the kill is unconfirmed, so the run can be released
      pid = runner.unconfirmedPid("p2-released")!;
      assert.ok(pid > 0);
      await remember(pid);
      assert.equal(runner.releaseUnconfirmedRun("p2-released"), true);
      assert.equal(sweeps.length, 0);
      runner.stopAllRunning(fakeKill);
      assert.equal(sweeps.length, 1, "Stop all asked for the released run's leftovers to be swept too");
    });
  } finally { if (pid) await killSeen(tracked.filter((entry) => entry.pid === pid)); common.setProcessTreeForTests(null); await sleep(300); }
});

test("a tab folder with ( ) & ^ and % in its name, and a drive root, reach OpenCode intact", windowsOnly, async () => {
  const { bin } = fakeCliDir("", "opencode");
  put(bin, "opencode.cmd", `@echo off\r\n"${process.execPath}" "%~dp0argv.js" %*\r\n`);
  put(bin, "argv.js", `require("node:fs").writeFileSync(require("node:path").join(__dirname, "argv-" + process.env.CC_TEST_TAG + ".json"), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));`);
  const parent = scratch("cc-pack2-odd-");
  const odd = join(parent, "p%PATH%x (v2) & ^caret");
  mkdirSync(odd);
  madeDirs.push(odd);
  const cases: Array<[string, string]> = [["odd", odd], ["root", "C:\\"]];
  for (const [tag, folder] of cases) {
    const out = join(bin, `argv-${tag}.json`); made.push(out);
    process.env.CC_TEST_TAG = tag;
    const c = capture();
    await withPath(bin, async () => {
      const result = runner.runSeat(makeRun(folder, { runId: `p2-odd-${tag}`, cli: "opencode", model: "provider/model-v1", effort: "max" }), "go", c.cb, spawn);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(await until(() => c.statuses.some((entry) => entry.status !== "working"), 20_000), `ran: ${c.outputs.join("")}`);
      assert.equal(c.statuses.at(-1)?.status, "done", c.outputs.join(""));
    });
    const seen = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(seen.argv[0], "run");
    assert.equal(seen.argv[seen.argv.indexOf("--dir") + 1], folder, `${tag}: --dir arrives exactly as the folder`);
    assert.equal(seen.cwd.toLowerCase().replace(/\\+$/, ""), folder.toLowerCase().replace(/\\+$/, ""));
    assert.match(seen.argv.at(-1), /^Read the file at .*\.brief\.txt and follow it exactly as your instructions\.$/);
  }
  delete process.env.CC_TEST_TAG;
});

// ---- the run's end is reported through the real call site, with a fake tracker ----
class FakeChild extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); pid = 4545;
}
test("runSeat: the status waits for the sweep, a cleanup line names what was stopped, and a sweep that cannot check says so but never blocks or changes the report", async () => {
  const dir = scratch("cc-pack2-fake-");
  const calls: Array<{ pid: number; startedAt?: number; slow?: boolean }> = [];
  const sweeps: Array<{ endedAt?: number; release: (value: number | null) => void }> = [];
  common.setProcessTreeForTests({
    watch: (pid, startedAt, slow) => { calls.push({ pid, startedAt, slow }); return { sweep: (endedAt) => new Promise<number | null>((resolve, reject) => { sweeps.push({ endedAt, release: (value) => (value === -1 ? reject(new Error("list failed")) : resolve(value)) }); }), release() {} }; },
    flushRegistry() {},
  });
  try {
    const bin = scratch("cc-pack2-bin-"); put(bin, "codex.cmd", "@echo off\r\n");
    await withPath(bin, async () => {
      const STOPPED = /\[cleanup\] stopped 3 processes/, UNCHECKED = /\[cleanup\] could not check for processes this run left running/;
      // 3 = three stopped; -1 = the check rejects; null = no process list; "cap" = the sweep never answers, so the runner's cap (SWEEP_WAIT_MS) wins
      for (const [id, outcome] of [["p2-fake-a", 3], ["p2-fake-b", -1], ["p2-fake-c", null], ["p2-fake-d", "cap"]] as const) {
        const c = capture();
        runner.runSeat(makeRun(dir, { runId: id }), "x", c.cb, spawn);
        assert.equal(calls.at(-1)?.startedAt !== undefined, true, "a real child is watched from its start");
        assert.notEqual(calls.at(-1)?.slow, true, "a worker run needs the fast poll");
        assert.ok(await until(() => sweeps.length > 0 && sweeps.at(-1)!.endedAt !== undefined, 15_000), "the end of the run asks for a sweep");
        const sweep = sweeps.at(-1)!;
        assert.ok(sweep.endedAt! > calls.at(-1)!.startedAt! - 1, "the sweep is told when the process ended");
        await sleep(100);
        assert.deepEqual(c.statuses.map((entry) => entry.status), ["working"], "not reported over while the sweep is still running");
        if (outcome !== "cap") sweep.release(outcome);
        assert.ok(await until(() => c.statuses.length === 2, END_WAIT_MS), "reported once the sweep answered (or the cap won)");
        const log = c.outputs.join("");
        assert.equal(STOPPED.test(log), outcome === 3, `${id}: the stopped line only when processes were stopped`);
        assert.equal(UNCHECKED.test(log), outcome !== 3, `${id}: a check that could not finish is said in the log`);
        assert.equal(c.statuses.at(-1)?.status, "done", `${id}: the run's own outcome is kept`);
        sweeps.length = 0;
      }
    });
  } finally { common.setProcessTreeForTests(null); }
});

test("runSeat: a leftover process that could not be stopped is said in the output and log, next to the ones that were stopped", async () => {
  const dir = scratch("cc-pack2-failkill-");
  const state = { list: null as Array<{ pid: number; ppid: number; created: number }> | null };
  const killed: number[] = [];
  let rootPid = 0;
  // The real tracker with a fake process list: the root and one leftover child are alive after the run; only the root can be stopped.
  const tracker = common.createTreeTracker({ list: async () => state.list, kill: async (pid) => { killed.push(pid); return pid === rootPid; }, pollMs: 15 });
  common.setProcessTreeForTests({
    watch: (pid, startedAt, slow) => { rootPid = pid; state.list = [{ pid, ppid: 1, created: startedAt! }, { pid: 987654, ppid: pid, created: startedAt! + 10 }, { pid: process.pid, ppid: 1, created: 1 }]; return tracker.watch(pid, startedAt, slow); },
    flushRegistry() {},
  });
  try {
    const bin = scratch("cc-pack2-bin-"); put(bin, "codex.cmd", "@echo off\r\n");
    await withPath(bin, async () => {
      const c = capture();
      runner.runSeat(makeRun(dir, { runId: "p2-failkill", seatKey: "p2-failkill-tab.coder" }), "x", c.cb, spawn);
      assert.ok(await until(() => c.statuses.length === 2, END_WAIT_MS), "the run is reported over");
      const log = c.outputs.join("");
      assert.ok(killed.includes(987654), "the leftover child was tried");
      assert.match(log, /\[cleanup\] stopped 1 process this run left running/);
      assert.match(log, /\[cleanup\] could not stop 1 process this run left running/, "a leftover that stays alive is never a silent Done");
      // History reads the saved file, not the live output: the same line must be on disk.
      const saved = readdirSync(runner.logsDir).filter((name) => name.startsWith("p2-failkill-tab.coder-"));
      for (const name of saved) made.push(join(runner.logsDir, name));
      const logFiles = saved.filter((name) => name.endsWith(".log"));
      assert.equal(logFiles.length, 1, `this run's saved log: ${saved}`);
      assert.match(readFileSync(join(runner.logsDir, logFiles[0]), "utf8"), /\[cleanup\] could not stop 1 process this run left running/, "the saved run log carries the cleanup warning");
    });
  } finally { common.setProcessTreeForTests(null); }
});

test("runSeat: a fake process (tests) is never watched, so its made-up pid cannot name a real process", async () => {
  let watched = 0;
  common.setProcessTreeForTests({ watch: () => { watched++; return { sweep: async () => 0, release() {} }; }, flushRegistry() {} });
  try {
    const proc = Object.assign(new EventEmitter(), { pid: 4343, stdout: new EventEmitter(), stderr: new EventEmitter() });
    const c = capture();
    runner.runSeat(makeRun("C:/work/project", { runId: "p2-nowatch" }), "x", c.cb, (() => proc) as any);
    proc.emit("close", 0);
    assert.equal(watched, 0);
    assert.deepEqual(c.statuses.map((entry) => entry.status), ["working", "done"], "and the report is immediate");
  } finally { common.setProcessTreeForTests(null); }
});

test("runSeat: a process that closes without an exit code is a failed run, not a failed spawn; a spawn error for a missing folder names the folder", () => {
  const proc = Object.assign(new EventEmitter(), { pid: 4344, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const c = capture();
  runner.runSeat(makeRun("C:/work/project", { runId: "p2-nullcode" }), "x", c.cb, (() => proc) as any);
  proc.emit("close", null);
  assert.deepEqual(c.statuses.at(-1), { status: "failed", code: -1 }, "killed from outside: an exit code, so the page does not say 'spawn error'");
  const missing = join(tmpdir(), "cc-pack2-never-created-folder");
  for (const [folder, expected] of [[missing, `the tab folder no longer exists: ${missing}`], [tmpdir(), "spawn cmd.exe ENOENT"]] as const) {
    const bad = Object.assign(new EventEmitter(), { pid: 4346, stdout: new EventEmitter(), stderr: new EventEmitter() });
    const d = capture();
    runner.runSeat(makeRun(folder, { runId: "p2-enoent" }), "x", d.cb, (() => bad) as any);
    bad.emit("error", Object.assign(new Error("spawn cmd.exe ENOENT"), { code: "ENOENT" }));
    assert.deepEqual(d.statuses.at(-1), { status: "failed", code: undefined });
    assert.ok(d.outputs.join("").includes(`[spawn error] ${expected}`), d.outputs.join(""));
  }
});

test("killRun and Stop all start taskkill without a shell, from System32", () => {
  const proc = Object.assign(new EventEmitter(), { pid: 4347, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const calls: unknown[][] = [];
  const killer = Object.assign(new EventEmitter(), { pid: 1 });
  runner.runSeat(makeRun("C:/work/project", { runId: "p2-kill-shape" }), "x", capture().cb, (() => proc) as any);
  runner.killRun("p2-kill-shape", ((...args: unknown[]) => { calls.push(args); return killer; }) as any);
  runner.stopAllRunning(((...args: unknown[]) => { calls.push(args); return killer; }) as any);
  proc.emit("close", 1);
  assert.ok(calls.length >= 1);
  const mine = (calls as Array<[string, string[], Record<string, unknown>]>).filter(([, args]) => args[1] === "4347");
  assert.ok(mine.length >= 2, "both paths killed this run");
  for (const [command, args, options] of mine) {
    assert.equal(command, "taskkill");
    assert.deepEqual(args, ["/pid", "4347", "/T", "/F"]);
    assert.equal(options.shell, undefined, "no shell: an args array with a shell is deprecated (DEP0190) and re-parsed");
    assert.equal(String(options.cwd).toLowerCase(), join(process.env.SystemRoot ?? "C:\\Windows", "System32").toLowerCase(), "looked up in System32, not the server's folder");
  }
});

// ---- leaders ----
test("trackLeaderChild: a watched child's leftovers are swept when it exits; an unwatched one is not tracked at all", async () => {
  const watched: number[] = [], swept: number[] = [], slow: Array<boolean | undefined> = [];
  common.setProcessTreeForTests({ watch: (pid, _startedAt, isSlow) => { watched.push(pid); slow.push(isSlow); return { sweep: async (endedAt) => { swept.push(endedAt ?? -1); return 0; }, release() {} }; }, flushRegistry() {} });
  try {
    const a = new EventEmitter() as ChildProcess; (a as any).pid = 8001;
    const b = new EventEmitter() as ChildProcess; (b as any).pid = 8002;
    common.trackLeaderChild(a, true);
    common.trackLeaderChild(b);
    a.emit("exit", 0); b.emit("exit", 0);
    await sleep(20);
    assert.deepEqual(watched, [8001]);
    assert.deepEqual(slow, [true], "a leader child is a long-lived process: it is polled slowly");
    assert.equal(swept.length, 1);
    assert.ok(swept[0] > 0, "the sweep gets the time the child ended");
  } finally { common.setProcessTreeForTests(null); }
});

test("a leader whose root exits while a tracked descendant cannot be stopped stays running and failed, is said once, and a recheck clears it", async () => {
  const now = Date.now();
  const root = 8101, grand = 8102;
  const state = { list: [{ pid: root, ppid: 1, created: now }, { pid: grand, ppid: root, created: now + 10 }, { pid: process.pid, ppid: 1, created: 1 }] };
  let killWorks = false;
  const killed: number[] = [];
  common.setProcessTreeForTests(common.createTreeTracker({ list: async () => state.list, kill: async (pid) => { killed.push(pid); return killWorks; }, pollMs: 15 }));
  try {
    const child = Object.assign(new EventEmitter(), { pid: root, exitCode: null as number | null, signalCode: null }) as unknown as ChildProcess;
    let said = 0;
    common.trackLeaderChild(child, true, () => said++);
    await sleep(60); // the tracker has seen the descendant
    const before = common.leaderProcessState(child, false);
    assert.deepEqual({ running: before.running, killFailed: before.killFailed }, { running: true, killFailed: false });
    state.list = state.list.filter((proc) => proc.pid !== root); // the root is gone, its descendant is not
    (child as any).exitCode = 0; child.emit("exit", 0);
    assert.equal(common.leaderProcessState(child, false).running, true, "the sweep has not finished: the leader is not gone yet");
    assert.ok(await until(() => said === 1), "the failed descendant kill is reported");
    const stuck = common.leaderProcessState(child, false);
    assert.equal(stuck.running, true, "a descendant that could not be stopped keeps the leader running");
    assert.equal(stuck.killFailed, true);
    assert.ok(killed.includes(grand), "the descendant was tried");
    await stuck.recheck!();
    assert.equal(said, 1, "a retry that fails again is not said again");
    assert.equal(common.leaderProcessState(child, false).running, true, "still failing, still blocking");
    killWorks = true;
    await common.leaderProcessState(child, false).recheck!();
    const cleared = common.leaderProcessState(child, false);
    assert.equal(cleared.running, false, "once the descendant is stopped the leader is gone");
    assert.equal(cleared.killFailed, false);
  } finally { common.setProcessTreeForTests(null); }
});

test("a retried exit sweep keeps the time the root really exited, so a later process on its reused pid never has its children killed", async () => {
  const now = Date.now();
  const root = 8111, grand = 8112, stranger = 8113;
  const state = { list: [{ pid: root, ppid: 1, created: now - 100 }, { pid: grand, ppid: root, created: now - 50 }, { pid: process.pid, ppid: 1, created: 1 }] };
  const killed: number[] = [];
  common.setProcessTreeForTests(common.createTreeTracker({ list: async () => state.list, kill: async (pid) => { killed.push(pid); return false; }, pollMs: 15 }));
  try {
    const child = Object.assign(new EventEmitter(), { pid: root, exitCode: null as number | null, signalCode: null }) as unknown as ChildProcess;
    common.trackLeaderChild(child, true);
    await sleep(60);
    state.list = state.list.filter((proc) => proc.pid !== root);
    (child as any).exitCode = 0; child.emit("exit", 0);
    assert.ok(await until(() => killed.includes(grand)), "the first sweep tried the leftover");
    await sleep(30);
    // the root's pid is reused by a process that has since exited too, leaving a child that began after the real exit
    state.list = [...state.list, { pid: stranger, ppid: root, created: Date.now() }];
    await sleep(30);
    await common.leaderProcessState(child, false).recheck!();
    assert.equal(killed.includes(stranger), false, "a child created after the root really exited is not ours");
    assert.ok(killed.filter((pid) => pid === grand).length >= 2, "the original leftover is retried");
  } finally { common.setProcessTreeForTests(null); }
});

test("killProcessTree: a taskkill that cannot start falls back to kill(), and a kill that fails is reported", windowsOnly, async () => {
  const previous = process.env.SystemRoot;
  process.env.SystemRoot = join(tmpdir(), "cc-pack2-no-such-windows");
  try {
    for (const [sent, expectedReports] of [[true, 0], [false, 1]] as const) {
      const child = Object.assign(new EventEmitter(), { pid: 6001, exitCode: null, signalCode: null, kill: () => sent }) as unknown as ChildProcess;
      let reports = 0;
      common.killProcessTree(child, () => { reports++; });
      await sleep(300);
      assert.equal(reports, expectedReports, `kill() returned ${sent}`);
    }
    const gone = Object.assign(new EventEmitter(), { pid: 6002, exitCode: null, signalCode: "SIGTERM", kill: () => false }) as unknown as ChildProcess;
    let reports = 0;
    common.killProcessTree(gone, () => { reports++; });
    await sleep(300);
    assert.equal(reports, 0, "a child that already ended is not a failure");
  } finally { if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous; }
});

test("a drive or share root as a project folder blocks only the root itself, not every program on that drive", () => {
  assert.equal(common.isInsideFolder("C:\\Users\\x\\bin", "C:\\"), false);
  assert.equal(common.isInsideFolder("C:\\", "C:\\"), true);
  const dir = scratch("cc-pack2-cli-");
  put(dir, "codex.cmd", "@echo off\r\n");
  assert.equal(common.resolveCliPath("codex", { PATH: dir }, "C:\\"), join(dir, "codex.cmd"), "a CLI elsewhere on the drive is found for a drive-root tab");
  assert.equal(common.resolveCliPath("codex", { PATH: dir }, dir), null, "an ordinary folder still blocks what lies inside it");
  assert.equal(common.isInsideFolder(join(dir, "sub"), dir), true);
});

test("describeSpawnError names a missing folder only when the folder is really missing", () => {
  const enoent = Object.assign(new Error("spawn cmd.exe ENOENT"), { code: "ENOENT" });
  assert.equal(common.describeSpawnError(enoent, join(tmpdir(), "cc-pack2-missing-x")), `the tab folder no longer exists: ${join(tmpdir(), "cc-pack2-missing-x")}`);
  assert.equal(common.describeSpawnError(enoent, tmpdir()), "spawn cmd.exe ENOENT");
  assert.equal(common.describeSpawnError(new Error("EPERM"), join(tmpdir(), "cc-pack2-missing-x")), "EPERM");
  assert.equal(common.describeSpawnError(enoent), "spawn cmd.exe ENOENT");
});

test("the Codex and OpenCode leaders watch their real child's process tree, and never a fake child from a test", async () => {
  const watched: number[] = [];
  common.setProcessTreeForTests({ watch: (pid) => { watched.push(pid); return { sweep: async () => 0, release() {} }; }, flushRegistry() {} });
  const { createCodexLeader } = await import("../server/leader-codex.ts");
  const { createOpencodeLeader } = await import("../server/leader-opencode.ts");
  const folder = scratch("cc-pack2-leaders-");
  const cb = { onDelta() {}, onDone() {}, onUsage() {}, onError() {}, onStop() {} };
  const never = 2_147_483_000; // a pid that cannot exist: a stop of the fake child must not name a real process
  const fakeChild = () => Object.assign(new EventEmitter(), { pid: never, exitCode: null, signalCode: null, stdin: Object.assign(new EventEmitter(), { writable: false }), stdout: new EventEmitter(), stderr: Object.assign(new EventEmitter(), { resume() {} }), kill: () => true }) as any;
  const made: Array<{ stop: () => void }> = [];
  try {
    made.push(createCodexLeader({ model: "gpt-6-sol", effort: "high" }, folder, cb, { tools: [], mode: "accept", ask: async () => true, startTimeoutMs: 300 }));
    made.push(createOpencodeLeader({ model: "fakeprov/fake-model", effort: "max" }, folder, cb, { bridge: { url: "http://127.0.0.1:1/mcp", token: "t" }, mode: "accept", ask: async () => true, startTimeoutMs: 300 }));
    assert.ok(await until(() => watched.length === 2, 5000), `both real children were watched: ${watched}`);
    watched.length = 0;
    made.push(createCodexLeader({ model: "gpt-6-sol", effort: "high" }, folder, cb, { tools: [], mode: "accept", ask: async () => true, startTimeoutMs: 300, spawnFn: () => fakeChild() }));
    made.push(createOpencodeLeader({ model: "fakeprov/fake-model", effort: "max" }, folder, cb, { bridge: { url: "http://127.0.0.1:1/mcp", token: "t" }, mode: "accept", ask: async () => true, startTimeoutMs: 300, spawnFn: () => fakeChild(), pickPort: async () => 1 }));
    await sleep(500);
    assert.deepEqual(watched, [], "a fake child has a made-up pid: it is not watched");
  } finally { for (const leaderHandle of made) leaderHandle.stop(); common.setProcessTreeForTests(null); await sleep(300); }
});

// ---- the Claude leader ----
test("resolveClaudeCli: npm's extensionless shim is never chosen; the real claude.exe beside it is", () => {
  const npm = scratch("cc-pack2-npm-");
  put(npm, "claude", "#!/bin/sh\n"); put(npm, "claude.cmd", "@echo off\r\n"); put(npm, "claude.ps1", "x");
  assert.equal(leader.resolveClaudeCli({ PATH: npm }, join(npm, "missing.exe")), null, "only shims: degraded, not a script the SDK cannot start");
  const pkg = join(npm, "node_modules", "@anthropic-ai", "claude-code", "bin");
  mkdirSync(pkg, { recursive: true }); madeDirs.push(join(npm, "node_modules"), join(npm, "node_modules", "@anthropic-ai"), join(npm, "node_modules", "@anthropic-ai", "claude-code"), pkg);
  const exe = put(pkg, "claude.exe", "x");
  assert.equal(leader.resolveClaudeCli({ PATH: npm }, join(npm, "missing.exe")), exe);
  assert.equal(leader.resolveClaudeCli({ PATH: "", CLAUDE_CLI_PATH: npm }, join(npm, "missing.exe")), exe, "an install folder named in the environment works the same way");
});

test("Claude leader: a question tool is declined without a card; approvals still ask; the SDK spawns through the tracked spawn", async () => {
  const asked: string[] = [];
  const options = leader.buildLeaderOptions({ model: "fake", effort: "medium" }, ".", null, undefined, "ask", async (tool) => { asked.push(tool); return true; });
  const question: any = await options.canUseTool!("AskUserQuestion", { questions: [{ question: "A or B?" }] }, { signal: new AbortController().signal, toolUseID: "q" } as any);
  assert.equal(question.behavior, "deny");
  assert.match(question.message, /Decide yourself/);
  assert.deepEqual(asked, [], "no approval card for a question");
  const edit: any = await options.canUseTool!("Write", { file_path: "x" }, { signal: new AbortController().signal, toolUseID: "w" } as any);
  assert.equal(edit.behavior, "allow");
  assert.deepEqual(asked, ["Write"]);
  assert.equal(options.spawnClaudeCodeProcess, common.spawnTrackedClaude);
});

test("Claude leader: in a Plan tab an approved ExitPlanMode does not turn later edits into silent ones", async () => {
  const run = async (mode: "plan" | "accept", live: string, holdsPlan?: () => boolean) => {
    const asked: string[] = [];
    const options = leader.buildLeaderOptions({ model: "fake", effort: "medium" }, ".", null, undefined, mode, async (tool) => { asked.push(tool); return true; }, () => false, () => {}, holdsPlan);
    const result: any = await options.hooks!.PreToolUse![0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "x" }, tool_use_id: "id", permission_mode: live, session_id: "s", transcript_path: "x", cwd: "." } as any, "id", { signal: new AbortController().signal });
    return { asked, result };
  };
  assert.deepEqual((await run("plan", "acceptEdits")).asked, ["Edit"], "a Plan tab whose live mode left plan asks before the edit");
  assert.deepEqual(await run("accept", "acceptEdits"), { asked: [], result: {} }, "an Accept tab is unaffected");
  assert.deepEqual((await run("accept", "acceptEdits", () => true)).asked, ["Edit"], "the leader reports a tab switched to Plan live");
});

test("Claude leader: a tab switched to Plan while running asks before edits once ExitPlanMode has put the live mode back", async () => {
  let optionsSeen: any;
  let release!: () => void;
  const held = new Promise<void>((ok) => { release = ok; });
  const handle: any = { async *[Symbol.asyncIterator]() { await held; }, setPermissionMode: async () => {}, setModel: async () => {}, return: async () => ({ done: true, value: undefined }) };
  const asked: string[] = [];
  const created = leader.createLeader({ model: "fake", effort: "medium" }, ".", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {} }, undefined, "accept", async (tool) => { asked.push(tool); return true; }, ((args: any) => { optionsSeen = args.options; return handle; }) as any);
  const edit = (live: string) => optionsSeen.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "x" }, tool_use_id: "id", permission_mode: live, session_id: "s", transcript_path: "x", cwd: "." }, "id", { signal: new AbortController().signal });
  await edit("acceptEdits");
  assert.deepEqual(asked, [], "an Accept tab edits without asking");
  assert.equal(await created.setPermissionMode("plan"), true);
  await edit("acceptEdits"); // the model called ExitPlanMode, the live mode is back to what it was before
  assert.deepEqual(asked, ["Edit"], "the tab is meant to be in Plan, so the edit asks");
  assert.equal(await created.setPermissionMode("accept"), true);
  await edit("acceptEdits");
  assert.deepEqual(asked, ["Edit"], "switching back to Accept stops the asking");
  created.stop();
  release();
});

test("Claude leader: a model or mode change that fails reports false and never ends the running answer", async () => {
  const errors: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((ok) => { release = ok; });
  const fakeQuery = (() => {
    const handle: any = {
      async *[Symbol.asyncIterator]() { await held; },
      setModel: async () => { throw new Error("cli said no"); },
      setPermissionMode: async () => { throw new Error("cli said no"); },
      return: async () => ({ done: true, value: undefined }),
    };
    return handle;
  }) as any;
  const created = leader.createLeader({ model: "fake", effort: "medium" }, ".", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (message: string) => errors.push(message) }, undefined, "accept", undefined, fakeQuery);
  assert.equal(await created.setModel("other"), false);
  assert.equal(await created.setPermissionMode("plan"), false);
  assert.deepEqual(errors, [], "the caller reports the failed change; an onError here would end a turn that is not this change's");
  created.stop();
  release();
});

test("the SDK is given a spawn that stops claude.exe's whole tree on abort, including a grandchild", windowsOnly, async () => {
  const grandchildJs = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log("grand=" + c.pid); setInterval(() => {}, 1000);`;
  const controller = new AbortController();
  const child = common.spawnTrackedClaude({ command: process.execPath, args: ["-e", grandchildJs], env: { ...process.env }, signal: controller.signal });
  await remember(child.pid!);
  let out = ""; child.stdout!.on("data", (d) => { out += d; });
  assert.ok(await until(() => /grand=\d+/.test(out)), `the leader process started a child: ${out}`);
  const grand = Number(/grand=(\d+)/.exec(out)![1]);
  await remember(grand);
  assert.ok(alive(grand));
  controller.abort();
  assert.ok(await until(() => !alive(child.pid!) && !alive(grand), 10_000), `abort ended the leader and its child (leader alive=${alive(child.pid!)}, grandchild alive=${alive(grand)})`);
});

test("the Claude leader reports a kill it could not confirm, and says its process is still running until it exits", windowsOnly, async () => {
  const notices: string[] = [];
  const previous = { fake: process.env.CC_TEST_FAKE_CLI, killer: process.env.CC_TEST_KILLER_EXIT };
  process.env.CC_TEST_FAKE_CLI = "1"; process.env.CC_TEST_KILLER_EXIT = "1"; // the kill goes through a fake killer that fails
  let spawned: ChildProcess | undefined;
  const fakeQuery = ((args: any) => {
    spawned = args.options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: { ...process.env }, signal: args.options.abortController.signal });
    return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; }, return: async () => ({ done: true }), setModel: async () => {}, setPermissionMode: async () => {} };
  }) as any;
  try {
    const created = leader.createLeader({ model: "fake", effort: "medium" }, ".", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {}, onNotice: (message: string) => notices.push(message) }, undefined, "accept", undefined, fakeQuery);
    await remember(spawned!.pid!);
    const flags = () => { const { running, killFailed } = created.process(); return { running, killFailed }; };
    assert.deepEqual(flags(), { running: true, killFailed: false });
    created.stop();
    assert.ok(await until(() => notices.length === 1), "the failed kill is reported");
    assert.match(notices[0], /Could not confirm the old Claude leader stopped/);
    assert.deepEqual(flags(), { running: true, killFailed: true });
    killTree(spawned!.pid!);
    assert.ok(await until(() => !created.process().running), "once the process exits it no longer blocks anything");
  } finally {
    if (previous.fake === undefined) delete process.env.CC_TEST_FAKE_CLI; else process.env.CC_TEST_FAKE_CLI = previous.fake;
    if (previous.killer === undefined) delete process.env.CC_TEST_KILLER_EXIT; else process.env.CC_TEST_KILLER_EXIT = previous.killer;
  }
});

test("when the leader's CLI exits on its own, what it started is stopped too", windowsOnly, async () => {
  // A cmd.exe stands in for claude.exe: it starts a background process and ends, the way a native program that is not a Node program does
  // (a Node parent would take its own children with it when it exits, which is not the case being tested).
  const bin = scratch("cc-pack2-lead-");
  assert.ok(!/\s/.test(bin), `the temp folder name has no spaces: ${bin}`);
  put(bin, "hold.js", HOLD_JS);
  const pidFile = join(bin, "lead.pid"); made.push(pidFile);
  const goFile = join(bin, "lead.go"); made.push(goFile);
  // The stand-in ends only when the test says so (or after about a minute): a fixed pause let a busy machine run it out before the test looked.
  const lead = put(bin, "lead.cmd", `@echo off

start "" /b "${process.execPath}" "%~dp0hold.js" "%~dp0lead.pid"

for /l %%i in (1,1,60) do if not exist "%~dp0lead.go" ping -n 2 127.0.0.1 >nul

exit /b 0

`);
  const child = common.spawnTrackedClaude({ command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", lead], env: { ...process.env }, signal: new AbortController().signal });
  await remember(child.pid!);
  assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0));
  const held = Number(readFileSync(pidFile, "utf8"));
  await remember(held);
  assert.ok(alive(held));
  writeFileSync(goFile, "go");
  assert.ok(await until(() => !alive(child.pid!), 8000), "the leader process ended by itself");
  assert.ok(await until(() => !alive(held), 15_000), "what it had started was stopped after it");
});

// ---- round 1 fixes ----
const startedPids = (state: { killed: number[] }) => [...state.killed].sort((a, b) => a - b);

test("round 1 fix 6: once the root's creation time is known, a new process that reused its pid is never adopted, nor its children", async () => {
  // path (a): the root was seen alive, then a different process took pid 100 inside the spawn window
  const live = fakeTree([{ pid: 100, ppid: 1, created: T0 }]);
  const watch = common.createTreeTracker(live.deps).watch(100, T0);
  await sleep(80); // the root's creation time is recorded
  live.state.list = [{ pid: 100, ppid: 1, created: T0 + 300 }, { pid: 200, ppid: 100, created: T0 + 350 }];
  assert.equal(await watch.sweep(T0 + 100), 0);
  assert.deepEqual(live.state.killed, [], "the process that reused pid 100 and its child are not ours");
  // path (b): the root was never seen; it ended at T0+9000 and a different process took the pid later, with a child of its own
  const gone = fakeTree([]);
  const second = common.createTreeTracker(gone.deps).watch(100, T0);
  gone.state.list = [{ pid: 200, ppid: 100, created: T0 + 10_050 }]; // its parent (a later process with the reused pid) is gone too
  assert.equal(await second.sweep(T0 + 9_000), 0);
  assert.deepEqual(gone.state.killed, [], "a child created after the root ended (no grace) is not adopted");
  // control: a child created while the root lived is still found
  const control = fakeTree([]);
  const third = common.createTreeTracker(control.deps).watch(100, T0);
  control.state.list = [{ pid: 201, ppid: 100, created: T0 + 8_000 }];
  assert.equal(await third.sweep(T0 + 9_000), 1);
  assert.deepEqual(control.state.killed, [201]);
});

test("round 1 fix 7: a drive or share root as the tab folder also refuses an executable directly in that root, whichever form the caller passes", () => {
  assert.equal(common.isInsideFolder("C:\\claude.exe", "C:\\"), true, "an executable directly in the drive root");
  assert.equal(common.isInsideFolder("C:\\", "C:\\"), true, "the root itself (a PATH directory)");
  assert.equal(common.isInsideFolder("C:\\Users\\x\\claude.exe", "C:\\"), false, "an executable deeper on the drive is fine");
  assert.equal(common.isInsideFolder("C:\\Windows", "C:\\"), false, "a folder on the drive is fine");
  // the real entry point of the Claude leader
  const seat = { model: "claude-opus-5-5", effort: "high" };
  assert.throws(() => leader.buildLeaderOptions(seat, "C:\\", "C:\\claude.exe"), /lies inside the tab folder/);
  assert.doesNotThrow(() => leader.buildLeaderOptions(seat, "C:\\", "C:\\Users\\x\\claude.exe"));
});

test("round 1 fix 8: a new watch lists the processes at once, so a leader that crashes in its first 30 s is already in the registry", async () => {
  const dir = scratch();
  const { state, deps } = fakeTree([{ pid: 100, ppid: 1, created: T0 }, { pid: process.pid, ppid: 1, created: T0 - 50_000 }]);
  const tracker = common.createTreeTracker({ list: deps.list, kill: deps.kill, now: deps.now, registryDir: () => dir }); // no fast poll: only the slow one (30 s)
  const watch = tracker.watch(100, T0, true);
  const file = join(dir, `.children-${process.pid}.json`); made.push(file);
  assert.ok(await until(() => existsSync(file), 2000), "the registry was written without waiting for a poll");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).roots[0].rootCreated, T0);
  state.list = [{ pid: 100, ppid: 1, created: T0 }];
  watch.release();
  assert.equal(existsSync(file), false);
});

test("round 1 fix 9: a kill that failed keeps the tracking, in memory and in the registry, so a later sweep or the next start retries it", async () => {
  const dir = scratch();
  const { state, deps } = fakeTree([{ pid: 100, ppid: 1, created: T0 }, { pid: 200, ppid: 100, created: T0 + 10 }, { pid: process.pid, ppid: 1, created: T0 - 50_000 }]);
  let works = false;
  const kill = async (pid: number) => { state.killed.push(pid); return works; };
  const tracker = common.createTreeTracker({ list: deps.list, kill, now: deps.now, registryDir: () => dir });
  const watch = tracker.watch(100, T0);
  await sleep(50);
  assert.equal(await watch.sweep(T0 + 100), 0, "both kills failed");
  const file = join(dir, `.children-${process.pid}.json`); made.push(file);
  assert.ok(existsSync(file), "the registry still names them");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).roots[0].known, [[200, T0 + 10]]);
  state.killed.length = 0; works = true;
  assert.equal(await watch.sweep(T0 + 100), 2, "a later sweep tries again and now succeeds");
  assert.deepEqual(startedPids(state), [100, 200]);
  assert.equal(existsSync(file), false, "and then the registry is clear");
  // the start-up sweep: a failed kill keeps the dead server's file for the next start
  const crashed = join(dir, ".children-4242.json"); made.push(crashed);
  writeFileSync(crashed, JSON.stringify({ owner: { pid: 4242, created: T0 - 9000 }, roots: [{ pid: 100, rootCreated: T0, known: [[200, T0 + 10]] }] }));
  works = false; state.killed.length = 0;
  const list = [{ pid: 100, ppid: 1, created: T0 }, { pid: 200, ppid: 100, created: T0 + 10 }];
  const failed = await common.sweepOrphanedChildren({ list: async () => list, kill, registryDir: () => dir });
  assert.deepEqual(failed, { checked: 2, killed: 0 });
  assert.equal(existsSync(crashed), true, "kills failed: the file stays");
  works = true;
  const retried = await common.sweepOrphanedChildren({ list: async () => list, kill, registryDir: () => dir });
  assert.deepEqual(retried, { checked: 2, killed: 2 });
  assert.equal(existsSync(crashed), false, "kills worked: the file goes");
});

test("round 2 fix 1: the start-up sweep handles every file at once and stops waiting at its cap, keeping what did not finish", async () => {
  const dir = scratch();
  const list = [100, 101, 102].map((pid) => ({ pid, ppid: 1, created: T0 }));
  const files = [100, 101, 102].map((pid) => {
    const file = join(dir, `.children-${4300 + pid}.json`); made.push(file);
    writeFileSync(file, JSON.stringify({ owner: { pid: 4300 + pid, created: T0 - 9000 }, roots: [{ pid, rootCreated: T0, known: [] }] }));
    return file;
  });
  const started: number[] = [];
  const sweep = common.sweepOrphanedChildren({ list: async () => list, kill: (pid: number) => { started.push(pid); return new Promise<boolean>(() => {}); }, registryDir: () => dir, capMs: 300 });
  const result = await Promise.race([sweep, sleep(3000).then(() => null)]);
  assert.ok(result, "the sweep came back at its cap although every kill hangs");
  assert.deepEqual(started.sort(), [100, 101, 102], "every file's kill was started, none queued behind a hung one");
  assert.equal(result!.checked, 3);
  assert.deepEqual(files.map((file) => existsSync(file)), [true, true, true], "nothing that did not finish is forgotten");
});

test("round 2 fix 3: a watch asked for while a list is running gets its own list right after, one extra however many ask", async () => {
  const dir = scratch();
  let lists = 0, release!: () => void;
  const gate = new Promise<void>((ok) => { release = ok; });
  const me = { pid: process.pid, ppid: 1, created: T0 - 50_000 };
  const list = async () => { lists++; if (lists === 1) { await gate; return [me, { pid: 100, ppid: 1, created: T0 }]; } return [me, { pid: 100, ppid: 1, created: T0 }, { pid: 200, ppid: 1, created: T0 + 5 }]; };
  const tracker = common.createTreeTracker({ list, kill: async () => true, now: () => T0, pollMs: 60_000, registryDir: () => dir }); // the timer cannot be what saves it
  const file = join(dir, `.children-${process.pid}.json`); made.push(file);
  const first = tracker.watch(100, T0);
  const second = tracker.watch(200, T0 + 5); // started after the first list's snapshot was taken
  const third = tracker.watch(200, T0 + 5);
  release();
  assert.ok(await until(() => existsSync(file) && JSON.parse(readFileSync(file, "utf8")).roots.some((root: any) => root.pid === 200 && root.rootCreated === T0 + 5)), "the second watch was recorded without waiting for the next poll");
  await sleep(100);
  assert.equal(lists, 2, "one extra list, not one per watch");
  first.release(); second.release(); third.release();
});

test("round 1 fix 11: the registry is replaced through a temp file, so a failed write leaves the old registry whole", async () => {
  const dir = scratch();
  const { state, deps } = fakeTree([{ pid: 100, ppid: 1, created: T0 }, { pid: 200, ppid: 100, created: T0 + 10 }, { pid: process.pid, ppid: 1, created: T0 - 50_000 }]);
  const tracker = common.createTreeTracker({ list: deps.list, kill: deps.kill, now: deps.now, pollMs: 15, registryDir: () => dir });
  const watch = tracker.watch(100, T0);
  const file = join(dir, `.children-${process.pid}.json`); made.push(file);
  assert.ok(await until(() => existsSync(file)), "the registry was written");
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temp file is left behind");
  const before = readFileSync(file, "utf8");
  // the temp name is taken by a folder, so the next write cannot even start: the live registry must not be touched
  const temp = `${file}.tmp`; mkdirSync(temp);
  try {
    state.list = [...state.list!, { pid: 300, ppid: 200, created: T0 + 20 }];
    await sleep(150); // several polls saw the new grandchild and tried to write it
    assert.equal(readFileSync(file, "utf8"), before, "the old registry is intact");
  } finally { rmdirSync(temp); }
  state.list = [...state.list!, { pid: 301, ppid: 200, created: T0 + 30 }];
  assert.ok(await until(() => readFileSync(file, "utf8").includes("301")), "with the temp name free again the write goes through");
  watch.release();
});

test("round 1 fix 12: Stop gives the leader the end of the answer it was holding back for secret redaction", { timeout: 60_000 }, async () => {
  const { createOpencodeLeader } = await import("../server/leader-opencode.ts");
  const { createServer: createHttpServer } = await import("node:http");
  const bridge = createHttpServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result: { tools: [] } })); }); });
  await new Promise<void>((ok) => bridge.listen(0, "127.0.0.1", ok));
  const folder = scratch("cc-pack2-stop-");
  const logFile = join(folder, "fake.log"); made.push(logFile);
  let deltas = "";
  let fake: ChildProcess | null = null;
  const cb = { onDelta: (text: string) => { deltas += text; }, onDone() {}, onUsage() {}, onError() {}, onStop() {} };
  const handle = createOpencodeLeader({ model: "fakeprov/fake-model", effort: "max" }, folder, cb, {
    bridge: { url: `http://127.0.0.1:${(bridge.address() as { port: number }).port}/mcp`, token: "bridge-token-0123456789abcdef0123456789abcdef" }, mode: "bypass", ask: async () => true,
    spawnFn: (command, options) => { fake = spawn(process.execPath, [join(process.cwd(), "test", "fake-opencode-server.mjs"), "--port", /--port (\d+)/.exec(command)![1]], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...options.env, FAKE_LEADER_LOG: logFile } }); return fake; },
  });
  try {
    // The permission request after the text is on the same event stream, so the leader's answer to it (the fake logs the reply) shows it has read the text before it.
    handle.send(JSON.stringify([{ say: "Visible partial answer" }, { bashNoWait: "echo hi" }, { hang: true }]));
    assert.ok(await until(() => existsSync(logFile) && readFileSync(logFile, "utf8").includes("prompt_async"), 20_000), "the prompt reached the fake OpenCode");
    assert.ok(await until(() => readFileSync(logFile, "utf8").includes("per_1"), 20_000), "the leader answered the request that followed the text, so it has the text");
    // the streamed text has arrived: all of it is shorter than the redaction hold-back
    assert.equal(deltas, "", "nothing is released while the answer is still being written");
    handle.stop();
    assert.equal(deltas, "Visible partial answer", "Stop released the held-back text");
  } finally { (fake as ChildProcess | null)?.kill(); bridge.close(); await sleep(300); }
});
