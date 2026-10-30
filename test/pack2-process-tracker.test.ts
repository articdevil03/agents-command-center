import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedData, leader, common, windowsOnly, sleep, until, alive, killTree, made, remember, scratch, fakeTree, T0 } from "./pack2-process-helpers.ts";

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
  assert.deepEqual({ checked: result.checked, killed: result.killed, finished: result.finished }, { checked: 2, killed: 2, finished: true });
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
  assert.deepEqual({ checked: result.checked, killed: result.killed, finished: result.finished }, { checked: 0, killed: 0, finished: true });
  assert.equal(existsSync(bad), false, "the start-up sweep read this data root's logs folder");
});

// ---- real process tree facts ----
test("the process list shows this process with a plausible start time, and its child as a descendant", windowsOnly, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  try {
    await remember(child.pid!); // inside the try: a failed remember must not leave the child behind
    const list = await common.listProcesses();
    assert.ok(list, "the list could be read");
    const me = list.find((proc) => proc.pid === process.pid)!;
    assert.ok(me, "this process is in the list");
    assert.ok(me.created < Date.now() && me.created > Date.now() - 6 * 3600_000, `start time ${me.created} is a recent real time`);
    assert.ok(common.descendantsOf(list, process.pid).includes(child.pid!), "the child is a descendant");
  } finally { if (child.exitCode === null && child.signalCode === null) killTree(child.pid!); }
});
