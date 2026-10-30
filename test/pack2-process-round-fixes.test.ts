import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leader, common, sleep, until, made, scratch, fakeTree, T0 } from "./pack2-process-helpers.ts";

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
  assert.deepEqual({ checked: failed.checked, killed: failed.killed }, { checked: 2, killed: 0 });
  assert.equal(existsSync(crashed), true, "kills failed: the file stays");
  works = true;
  const retried = await common.sweepOrphanedChildren({ list: async () => list, kill, registryDir: () => dir });
  assert.deepEqual({ checked: retried.checked, killed: retried.killed }, { checked: 2, killed: 2 });
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

test("pack 19b: when the start-up sweep's cap wins it says so (finished false), and `late` settles with the counts of the work that ended after the cap", async () => {
  const dir = scratch();
  const list = [100, 101, 102].map((pid) => ({ pid, ppid: 1, created: T0 }));
  for (const pid of [100, 101, 102]) {
    const file = join(dir, `.children-${4300 + pid}.json`); made.push(file);
    writeFileSync(file, JSON.stringify({ owner: { pid: 4300 + pid, created: T0 - 9000 }, roots: [{ pid, rootCreated: T0, known: [] }] }));
  }
  const capped = await common.sweepOrphanedChildren({ list: async () => list, kill: async () => { await sleep(600); return true; }, registryDir: () => dir, capMs: 200 });
  assert.equal(capped.finished, false, "the cap won, and the result says so");
  assert.deepEqual(await capped.late, { checked: 3, killed: 3, unchecked: false }, "late settles with the counts of the work that ended after the cap");
});

test("pack 19b: the start-up report says only the kills made after the cap, and an unreadable late list says unchecked", async () => {
  const dir = scratch();
  const list = [100, 101, 102].map((pid) => ({ pid, ppid: 1, created: T0 }));
  for (const pid of [100, 101, 102]) {
    const file = join(dir, `.children-${4300 + pid}.json`); made.push(file);
    writeFileSync(file, JSON.stringify({ owner: { pid: 4300 + pid, created: T0 - 9000 }, roots: [{ pid, rootCreated: T0, known: [] }] }));
  }
  // pid 100 is stopped before the cap, pids 101 and 102 after it
  const lines: string[] = [];
  const capped = await common.sweepOrphanedChildren({ list: async () => list, kill: async (pid: number) => { if (pid !== 100) await sleep(600); return true; }, registryDir: () => dir, capMs: 200 });
  common.reportStartupSweep(capped, 200, (line: string) => lines.push(line), String);
  assert.equal(capped.killed, 1, "one kill ended before the cap");
  await capped.late;
  assert.ok(await until(() => lines.length >= 3), `the late line was logged: ${lines.join(" | ")}`);
  assert.ok(lines[0].includes("did not finish within"), lines[0]);
  assert.deepEqual(lines.slice(1), ["[cleanup] stopped 1 processes left by an earlier server", "[cleanup] stopped 2 processes left by an earlier server"]);
  // a list that is still being read at the cap and then fails
  const dir2 = scratch();
  const file2 = join(dir2, ".children-4242.json"); made.push(file2);
  writeFileSync(file2, JSON.stringify({ owner: { pid: 4242, created: T0 }, roots: [] }));
  const lines2: string[] = [];
  const slow = await common.sweepOrphanedChildren({ list: async () => { await sleep(400); return null; }, kill: async () => { assert.fail("no unchecked kill"); }, registryDir: () => dir2, capMs: 100 });
  common.reportStartupSweep(slow, 100, (line: string) => lines2.push(line), String);
  await slow.late;
  assert.ok(await until(() => lines2.length >= 2), `the late lines were logged: ${lines2.join(" | ")}`);
  assert.ok(lines2.includes("[cleanup] could not check for processes left by an earlier server; their registry files are kept for the next start"), lines2.join(" | "));
  assert.equal(existsSync(file2), true);
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

test("an unreadable startup process list says unchecked and keeps the registry", async () => {
  const dir = scratch();
  const file = join(dir, ".children-4242.json"); made.push(file);
  writeFileSync(file, JSON.stringify({ owner: { pid: 4242, created: T0 }, roots: [] }));
  const swept = await common.sweepOrphanedChildren({ list: async () => null, kill: async () => { assert.fail("no unchecked kill"); }, registryDir: () => dir });
  const expected = ["[cleanup] could not check for processes left by an earlier server; their registry files are kept for the next start"];
  assert.deepEqual(common.describeStartupSweep(swept, common.SWEEP_CAP_MS), expected);
  assert.deepEqual(common.describeStartupSweep({ ...await swept.late, finished: true }, common.SWEEP_CAP_MS, swept.killed), expected);
  assert.equal(existsSync(file), true);
});
