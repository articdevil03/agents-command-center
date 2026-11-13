import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fixedServer } from "./fixed-crew-execution-helpers.ts";
import { shellHarness, within } from "./electron-helpers.ts";
import { holdServer, liveWorker, flag, until, exitWatch, diskJournal, hold, fakeClock, runnerFixture, settled, tick } from "./pack26-final-shutdown-helpers.ts";
import { GIT_DRAIN_MS } from "../server/fixed-crew/git-operations.ts";
import { LIST_TIMEOUT_MS, KILL_TIMEOUT_MS } from "../server/leader-common/types.ts";
import { WORKER_DRAIN_MS } from "../server/runner/lifecycle.ts";

const stamp = (label: string, at = Date.now()) => console.log(`SHUTDOWN TIMELINE ${new Date(at).toISOString()} ${label}`);

test("P26F runner retains finalization after root close", async () => {
  const sweep = hold();
  const fx = await runnerFixture({ sweep: () => sweep.promise, failed: 0 });
  assert.equal(fx.started().ok, true);
  fx.proc.emit("close", 0);
  assert.equal(fx.harness.isRunning("isolated-run"), false, "the runner's own map already forgot the run");
  const timers = fakeClock();
  const drain = fx.harness.drainWorkers(fx.harness.WORKER_DRAIN_MS, timers.clock);
  assert.equal((await settled(drain)).done, false, "the drain still waits: the sweep callback is held");
  assert.deepEqual(fx.events, ["status:working"], "neither final callback has run yet");
  sweep.resolve(0);
  assert.equal(await drain, true);
  assert.deepEqual(fx.events, ["status:working", "tree:confirmed", "status:done"]);
});

test("P26F runner publishes completion after callbacks", async () => {
  const fx = await runnerFixture({ sweep: async () => 0, failed: 0 });
  assert.equal(fx.started().ok, true);
  fx.proc.emit("close", 0);
  const timers = fakeClock();
  const drain = fx.harness.drainWorkers(fx.harness.WORKER_DRAIN_MS, timers.clock);
  await tick(); await tick();
  timers.fire(); // a drain that is still pending here would give up: that is an assertion failure below, not a real timeout
  assert.equal(await drain, true, "completion is published once both callbacks finished");
  assert.deepEqual(fx.events, ["status:working", "tree:confirmed", "status:done"]);
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].ms, WORKER_DRAIN_MS, "a finite budget");
  assert.equal(timers.timers[0].cleared, true, "the budget timer is cleared");
});

test("P26F shutdown rejects delayed worker admission", async () => {
  const fx = await runnerFixture(null);
  assert.equal(fx.harness.workerAdmissionClosed(), false);
  fx.harness.closeWorkerAdmission();
  const result = fx.started();
  assert.equal(result.ok, false);
  assert.equal(result.error, "Worker admission is closed for shutdown.");
  assert.equal(fx.spawns.length, 0, "no process was started");
  assert.deepEqual(fx.events, [], "no callback ran");
  assert.equal(fx.harness.isRunning("isolated-run"), false);
  assert.deepEqual(readdirSync(fx.harness.logsDir), [], "no brief or log was written");
});

test("P26F unconfirmed worker endings never satisfy the drain", async () => {
  const confirm = async (fx: Awaited<ReturnType<typeof runnerFixture>>, clockFires = false) => {
    const timers = fakeClock();
    const drain = fx.harness.drainWorkers(fx.harness.WORKER_DRAIN_MS, timers.clock);
    await tick(); await tick();
    if (clockFires) timers.fire();
    return drain;
  };
  // Root closed, but the whole tree was never confirmed (no process list).
  const noTree = await runnerFixture(null); assert.equal(noTree.started().ok, true); noTree.proc.emit("close", 0);
  assert.deepEqual(noTree.events, ["status:working", "tree:unknown", "status:done"]);
  assert.equal(await confirm(noTree), false, "an unknown tree end is never a confirmed drain");
  // The sweep itself fails.
  const failing = await runnerFixture({ sweep: () => Promise.reject(new Error("no process list")), failed: 0 });
  assert.equal(failing.started().ok, true); failing.proc.emit("close", 0);
  assert.equal(await confirm(failing), false, "a rejected sweep is unknown");
  assert.deepEqual(failing.events, ["status:working", "tree:unknown", "status:done"]);
  // A leftover that could not be stopped.
  const stuck = await runnerFixture({ sweep: async () => 1, failed: 1 });
  assert.equal(stuck.started().ok, true); stuck.proc.emit("close", 0);
  assert.equal(await confirm(stuck), false, "a leftover that could not be stopped is not an end");
  // The final callback cannot publish.
  const broken = await runnerFixture(null, { onTreeEnd: () => { throw new Error("journal write failed"); } });
  assert.equal(broken.started().ok, true);
  assert.throws(() => broken.proc.emit("close", 0), /journal write failed/);
  assert.equal(await confirm(broken), false, "a failed publication keeps the drain red");
  // The root never closes: the finite budget gives up.
  const silent = await runnerFixture({ sweep: async () => 0, failed: 0 }); assert.equal(silent.started().ok, true);
  assert.equal(await confirm(silent, true), false, "a worker with no close is unknown when the budget ends");
  assert.equal(silent.harness.isRunning("isolated-run"), true);
  // An owner-released run never confirms the drain either, even after its close.
  const released = await runnerFixture({ sweep: async () => 0, failed: 0 }); assert.equal(released.started().ok, true);
  released.harness.killRun("isolated-run", (() => { const killer = Object.assign(new (released.proc.constructor)(), {}); queueMicrotask(() => killer.emit("error", new Error("no taskkill"))); return killer; }) as any);
  await tick();
  assert.equal(released.harness.releaseUnconfirmedRun("isolated-run"), true);
  released.proc.emit("close", 0);
  assert.equal(await confirm(released), false, "a released run's end was never published as confirmed");
});

// ---- the real server ----
test("P26F shutdown waits for worker publication", { timeout: 240_000 }, async () => {
  const f = await holdServer(), held = flag(f, "hold-sweep");
  const exit = exitWatch(f);
  try {
    const runId = await liveWorker(f);
    held.set();
    const startedAt = Date.now();
    f.server.child.send("shutdown"); f.server.child.send("shutdown");
    stamp("shutdown requested twice", startedAt);
    await until(() => f.children().some((row: any) => row.worker && row.event === "close"), "the actual worker close");
    stamp("root close observed");
    await new Promise((resolve) => setTimeout(resolve, 3000)); // Git (no operations) and HTTP are long finished by now
    assert.equal(exit.code, undefined, "the server must not exit while the worker's publication is held");
    const waiting = diskJournal(f).executions.find((entry: any) => entry.id === runId);
    assert.equal(waiting.processEnded, false, "nothing was published while the sweep callback is held");
    stamp("held: journal still unconfirmed");
    held.clear();
    stamp("sweep callback released");
    await until(() => exit.code !== undefined, "server exit after the release");
    stamp(`server exit code ${exit.code}`, exit.at);
    assert.equal(exit.code, 0, f.server.log());
    const cold = diskJournal(f), ended = cold.executions.find((entry: any) => entry.id === runId);
    assert.equal(ended.processEnded, true, "the real tree-end publication landed before exit");
    assert.notEqual(ended.status, "running");
    assert.equal(cold.activeExecutionId, null, "no heavy slot is left held for the next tab");
    assert.equal(f.server.log().match(/Received IPC shutdown; stopping agents/g)?.length, 1, "repeat requests drain once");
  } finally { held.clear(); await f.close(); }
});

test("P26F unknown worker drain refuses successful exit", { timeout: 240_000 }, async () => {
  const f = await holdServer(), unknown = flag(f, "unknown-tree");
  const exit = exitWatch(f);
  try {
    await f.planning(); await f.approve();
    unknown.set(); // from here on every process list is unreadable: the build's tree end stays unknown
    f.worker({ delay: 50, write: "after!" });
    const run = await f.action("build"); assert.equal(run.ok, true, run.text);
    await f.ended(run.value.runId);
    assert.equal(diskJournal(f).executions.find((entry: any) => entry.id === run.value.runId).processEnded, false, "the tree end stayed unknown");
    f.server.child.send("shutdown");
    await until(() => exit.code !== undefined, "server exit");
    assert.equal(exit.code, 1, "Git and HTTP are clean, but a worker whose end is unknown is never a successful exit");
    assert.match(f.server.log(), /Worker shutdown INCOMPLETE/);
    assert.equal(diskJournal(f).executions.find((entry: any) => entry.id === run.value.runId).processEnded, false, "no tree end was manufactured");
  } finally { unknown.clear(); await f.close(); }
});

test("P26F connected shutdown preserves failed drain exit", { timeout: 240_000 }, async () => {
  const f = await holdServer(), unknown = flag(f, "unknown-tree");
  const exit = exitWatch(f);
  try {
    const runId = await liveWorker(f);
    unknown.set();
    f.server.child.send("shutdown");
    await until(() => exit.code !== undefined, "server exit");
    assert.equal(exit.code, 1, "a live worker whose sweep cannot be confirmed fails the connected shutdown");
    const entry = diskJournal(f).executions.find((row: any) => row.id === runId);
    assert.equal(entry.processEnded, false, "the unknown end stays held; nothing was confirmed for it");
    assert.equal(entry.status, "interrupted");
  } finally { unknown.clear(); await f.close(); }
});

test("P26F parent loss waits for the worker and exits 1 when its end is unknown", { timeout: 240_000 }, async () => {
  const f = await holdServer(), held = flag(f, "hold-sweep"), unknown = flag(f, "unknown-tree");
  const exit = exitWatch(f);
  try {
    await liveWorker(f);
    held.set(); unknown.set();
    f.server.child.disconnect();
    await until(() => f.children().some((row: any) => row.worker && row.event === "close"), "the actual worker close");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(exit.code, undefined, "the disconnected server also waits for the held worker");
    held.clear();
    await until(() => exit.code !== undefined, "server exit");
    assert.equal(exit.code, 1, "an unknown worker end is exit 1, never the success path that kills the tree");
  } finally { held.clear(); unknown.clear(); await f.close(); }
});

test("P26F Electron allows the server drain budget", async () => {
  const h = shellHarness();
  const started = h.startServer();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "started");
  h.app.emit("before-quit", { preventDefault() {} });
  const pending = h.stopServer();
  const [{ fn, ms }] = [...h.timers.values()];
  // Git (its budget, then the helper drain), workers and HTTP run in parallel: the longest of them is the normal worst case.
  const helperDrain = LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000;
  const worst = Math.max(GIT_DRAIN_MS + helperDrain, WORKER_DRAIN_MS, 7000);
  assert.ok(ms >= worst + 10_000, `the parent backstop (${ms} ms) must outlast the worst normal shutdown (${worst} ms) with a margin`);
  fn(); await Promise.resolve();
  assert.match(String(h.spawns[1][0]), /taskkill\.exe$/, "a genuinely hung server still reaches the finite backstop");
  h.killer.emit("close", 0);
  await within(pending, "pending");
});

test("P26F fresh startup does not create avatars", { timeout: 120_000 }, async () => {
  const fresh = await fixedServer();
  try {
    assert.equal(existsSync(join(fresh.server.data, "avatars")), false, "a fresh data root never gets an avatars folder");
    assert.equal(existsSync(join(fresh.server.data, "scratch")), true, "the folders the server does write are still created");
  } finally { await fresh.close(); }
  const name = "avatar-01234567-89ab-cdef-0123-456789abcdef.png";
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  const old = await fixedServer({ extra: ({ data }) => { mkdirSync(join(data, "avatars")); writeFileSync(join(data, "avatars", name), bytes); } });
  try {
    const served = await fetch(`http://127.0.0.1:${old.server.port}/api/avatar/${name}`);
    assert.equal(served.status, 200, "a historical image is still served by the guarded route");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
    const outside = await fetch(`http://127.0.0.1:${old.server.port}/api/avatar/..%5Cconfig%5Cworkspaces.json`);
    assert.equal(outside.status, 403, "the route's own validation is unchanged");
  } finally { await old.close(); }
});
