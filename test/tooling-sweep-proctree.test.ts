import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { killTracked, listProcesses, planKill, recordTree, watchTree } from "../scripts/sweep/proctree.mjs";

// Every refusal test runs against planKill with FAKE lists: no process is touched and no kill function exists there.
// The real tests start their own bounded-life fixture processes (about 30 s at most) and stop only those, through killTracked.
const proc = (pid: number, ppid: number, created: number) => ({ pid, ppid, created });
const SELF = 3;
// Chain 1 <- 2 <- 3 (self) <- 4; the whole chain shares one CreationDate so only the chain rule can refuse a parent. 5 is older than the sweep, 6 and 7 are unrelated.
const LIST = [proc(1, 0, 300), proc(2, 1, 300), proc(SELF, 2, 300), proc(4, SELF, 400), proc(5, 0, 50), proc(6, 0, 500), proc(7, 0, 600)];
const plan = (tracked: Record<number, number>, extra: object = {}) => planKill({ list: LIST, tracked: new Map(Object.entries(tracked).map(([pid, created]) => [Number(pid), created])), selfPid: SELF, ...extra });
const GOOD = { 4: 400 };

test("planKill names a live tracked descendant (control for every refusal below)", () => {
  assert.deepEqual(plan(GOOD), [{ pid: 4, created: 400 }]);
});

for (const [label, bad] of [
  ["the sweep process itself", { [SELF]: 300 }],
  ["its parent", { 2: 300 }],
  ["its grandparent, the root of the chain", { 1: 300 }],
  ["a process created before the sweep process", { 5: 50 }],
] as const) {
  test(`planKill refuses ${label} and names no target, even beside a valid one`, () => {
    assert.throws(() => plan({ ...GOOD, ...bad }), /refusing/);
  });
}

test("planKill refuses a pid that is not in the tracked set, even beside a valid one", () => {
  assert.throws(() => plan(GOOD, { pids: [4, 7] }), /not in the tracked set/);
});

test("planKill refuses everything when the sweep's own process is missing from the list", () => {
  assert.throws(() => plan(GOOD, { selfPid: 999 }), /own process 999 is not in the list/);
});

test("pid reuse: a tracked pid alive with another CreationDate is not a target", () => {
  assert.deepEqual(plan({ 4: 401 }), []);
});

test("recordTree skips a child created before its parent and never adopts a child of a dead tracked parent", () => {
  const tracked = new Map([[8, 800]]);
  recordTree([proc(8, 0, 800), proc(9, 8, 700), proc(10, 8, 900)], 8, tracked);
  assert.deepEqual([...tracked], [[8, 800], [10, 900]], "9 is older than its parent 8: a reused pid, not a child");
  const orphaned = new Map([[8, 800]]);
  recordTree([proc(11, 8, 950)], undefined, orphaned);
  assert.deepEqual([...orphaned], [[8, 800]], "8 is dead: its child 11 is not adopted");
});

test("recordTree records the root on first sight and walks down the whole tree", () => {
  const tracked = new Map();
  recordTree([proc(20, 0, 100), proc(21, 20, 110), proc(22, 21, 120), proc(23, 0, 130)], 20, tracked);
  assert.deepEqual([...tracked.keys()].sort(), [20, 21, 22]);
});

test("recordTree does not expand through a reused parent", () => {
  const tracked = new Map([[8, 800]]);
  recordTree([proc(8, 0, 900), proc(9, 8, 950)], undefined, tracked);
  assert.deepEqual([...tracked], [[8, 800]], "the live pid 8 belongs to another process");
});

test("planKill returns targets parents first, whatever order they were tracked in", () => {
  const list = [proc(SELF, 0, 10), proc(30, SELF, 800), proc(31, 30, 810), proc(32, 31, 820)];
  const tracked = new Map([[32, 820], [31, 810], [30, 800]]);
  assert.deepEqual(planKill({ list, tracked, selfPid: SELF }).map(({ pid }) => pid), [30, 31, 32]);
});

test("killTracked on a refusal throws and the kill function is called 0 times", async () => {
  const calls: number[] = [];
  const list = [proc(process.pid, 0, 10), proc(40, process.pid, 20)];
  const tracked = new Map([[40, 20], [process.pid, 10]]);
  await assert.rejects(killTracked(tracked, { list: async () => list, kill: (pid: number) => { calls.push(pid); } }), /refusing/);
  assert.deepEqual(calls, []);
});

// ---- the real thing, on processes this file starts itself ----

const scratch = mkdtempSync(join(tmpdir(), "cc-proctree-test-"));
const made: string[] = [];
const scratchFile = (name: string) => { const path = join(scratch, name); made.push(path); return path; };
after(() => { for (const path of made) { try { unlinkSync(path); } catch { /* never written */ } } rmdirSync(scratch); });

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; } };
const state = (pids: Record<string, number>) => Object.entries(pids).map(([name, pid]) => `${name}=${pid}:${isAlive(pid) ? "alive" : "gone"}`).join(" ");
async function waitFor(path: string): Promise<string> {
  for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  return readFileSync(path, "utf8");
}
const SLEEP_30S = "setTimeout(() => {}, 30000)";
// The root starts a grandchild (bounded life), writes its pid and sleeps; the optional release file lets the root exit and leave the grandchild an orphan.
const ROOT = "const fs = require('fs'); const [pidFile, releaseFile] = process.argv.slice(1); const g = require('child_process').spawn(process.execPath, ['-e', '" + SLEEP_30S + "'], { stdio: 'ignore', detached: !!releaseFile }); g.unref(); fs.writeFileSync(pidFile, String(g.pid)); setInterval(() => { if (releaseFile && fs.existsSync(releaseFile)) process.exit(0); }, 100); setTimeout(() => process.exit(0), 30000);";

test("killTracked stops the root and its grandchild, and a bystander and the test's own parents stay alive", { skip: process.platform !== "win32" }, async () => {
  const pidFile = scratchFile("g1.pid");
  const root = spawn(process.execPath, ["-e", ROOT, pidFile], { stdio: "ignore", windowsHide: true });
  const bystander = spawn(process.execPath, ["-e", SLEEP_30S], { stdio: "ignore", windowsHide: true });
  try {
    const grandchildPid = Number(await waitFor(pidFile));
    const pids = { root: root.pid!, grandchild: grandchildPid, bystander: bystander.pid!, self: process.pid, parent: process.ppid };
    console.log(`KILL PROBE before: ${state(pids)}`);
    const tracked = new Map();
    const { killed } = await killTracked(tracked, { root: root.pid });
    console.log(`KILL PROBE after: ${state(pids)} killed=${JSON.stringify(killed)}`);
    assert.equal(isAlive(pids.root), false);
    assert.equal(isAlive(pids.grandchild), false);
    assert.equal(isAlive(pids.bystander), true, "a process outside the tree is untouched");
    assert.equal(isAlive(pids.self) && isAlive(pids.parent), true);
  } finally { bystander.kill(); }
});

test("killTracked with no root stops an orphan the poller had recorded while its parent was alive", { skip: process.platform !== "win32" }, async () => {
  const release = scratchFile("release2");
  const pidFile = scratchFile("g2.pid");
  const root = spawn(process.execPath, ["-e", ROOT, pidFile, release], { stdio: "ignore", windowsHide: true });
  const closed = new Promise((resolve) => root.once("close", resolve));
  const grandchildPid = Number(await waitFor(pidFile));
  const tracked = new Map();
  recordTree(await listProcesses(), root.pid, tracked);
  console.log(`ORPHAN TREE before: root=${root.pid}:${isAlive(root.pid!) ? "alive" : "gone"} grandchild=${grandchildPid}:${isAlive(grandchildPid) ? "alive" : "gone"} tracked=${JSON.stringify([...tracked.keys()])}`);
  writeFileSync(release, "go");
  await closed;
  const { killed } = await killTracked(tracked);
  console.log(`ORPHAN TREE after: root=${root.pid}:${isAlive(root.pid!) ? "alive" : "gone"} grandchild=${grandchildPid}:${isAlive(grandchildPid) ? "alive" : "gone"} killed=${JSON.stringify(killed)}`);
  assert.deepEqual(killed, [grandchildPid], "only the orphan was alive to stop");
  assert.equal(isAlive(grandchildPid), false);
});

test("one real process list: its cost on this PC", { skip: process.platform !== "win32" }, async () => {
  const started = Date.now();
  const list = await listProcesses();
  console.log(`LIST COST: ${Date.now() - started} ms, ${list.length} processes`);
  assert.ok(list.some(({ pid }) => pid === process.pid), "the list holds this very process");
});

test("R1 watchTree registration drops a stale root entry, then the new root and its child are recorded", () => {
  const tracked = new Map([[20, 100]]);
  const unwatch = watchTree(20, tracked);
  unwatch();
  assert.equal(tracked.has(20), false, "the stale entry for the just-spawned pid is gone");
  recordTree([proc(20, 0, 200), proc(21, 20, 210)], 20, tracked);
  assert.deepEqual([...tracked], [[20, 200], [21, 210]]);
});

test("R1 recordTree never replaces a known root: a live run is not hijacked by a reused pid", () => {
  const tracked = new Map([[20, 100]]);
  recordTree([proc(20, 0, 200), proc(21, 20, 210)], 20, tracked);
  assert.deepEqual([...tracked], [[20, 100]], "pid 20 now belongs to another process: kept at its first identity, child not adopted");
});

test("R1 killTracked calls only tracked targets in parent-first order with fake processes", async () => {
  const calls: number[] = [];
  const list = [proc(process.pid, 0, 10), proc(40, process.pid, 20), proc(41, 40, 30), proc(42, 0, 40)];
  const tracked = new Map([[41, 30], [40, 20]]);
  const result = await killTracked(tracked, {
    list: async () => list.filter(({ pid }) => !calls.includes(pid)),
    kill: (pid: number) => { calls.push(pid); },
  });
  assert.deepEqual(calls, [40, 41], "only the tracked root and child, never self or the bystander");
  assert.deepEqual(result.killed, [40, 41]);
});
