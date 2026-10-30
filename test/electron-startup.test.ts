import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { runPackagedSmoke } from "../scripts/packaged-smoke.mjs";
import { source, plain, within, shellHarness, buildServerCommandArgs } from "./electron-helpers.ts";

test("single instance lock is requested before any window or server is created (guard 1)", async () => {
  const h = shellHarness();
  assert.deepEqual(h.order, ["lock"], "the lock must be requested at load time, before whenReady even resolves");
  const ready = h.ready();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  const lockIndex = h.order.indexOf("lock");
  const windowIndex = h.order.indexOf("window");
  const spawnIndex = h.order.indexOf("spawn:node");
  assert.ok(lockIndex !== -1 && windowIndex !== -1 && spawnIndex !== -1, "all three must have happened");
  assert.ok(lockIndex < windowIndex, "lock must be requested before the window is created");
  assert.ok(lockIndex < spawnIndex, "lock must be requested before the server is spawned");
});

test("a refused instance quits immediately and never creates a window or spawns a server (guard 2)", () => {
  const h = shellHarness({}, { lockAcquired: false });
  assert.equal(h.quits(), 1);
  assert.equal(h.windowOptions.length, 0);
  assert.equal(h.spawns.length, 0);
  assert.equal(h.app.listenerCount("second-instance"), 0, "a refused instance must not even wire second-instance");
});

test("portable smoke mode skips the window, publishes the real server port, and waits for the smoke stop file", async () => {
  const h = shellHarness({}, { smokeReadyFile: "ready.json", smokeStopFile: "stop", smokeDataDir: "smoke-data" });
  const ready = h.ready();
  await Promise.resolve();
  assert.equal(h.windowOptions.length, 0, "smoke mode must not create a BrowserWindow");
  assert.deepEqual(h.userDataPaths, [["userData", "smoke-data"]], "smoke mode must isolate Electron's userData too");
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  assert.equal(h.files.get("ready.json"), `${JSON.stringify({ port: 51234, serverPid: 1234 })}\n`);
  const serverEnv = h.spawns.find(([command]) => command === "node")?.[2].env;
  assert.ok(serverEnv, "smoke mode must spawn a server");
  assert.equal(Object.keys(serverEnv).some((key) => key.startsWith("CC_SMOKE_")), false,
    "CC_SMOKE_* controls must not reach the server");
  assert.equal(serverEnv.CC_SKIP_DISCOVERY, "1", "the server must see the discovery skip at startup");
  const serverArgs = h.spawns.find(([command]) => command === "node")?.[1];
  assert.ok(serverArgs.includes("--eval"), "smoke server must use the bootstrap that clears the discovery flag after module startup");
  assert.match(serverArgs[serverArgs.indexOf("--eval") + 1], /delete process\.env\.CC_SKIP_DISCOVERY/);
  assert.equal(h.quits(), 0, "the app must keep the server alive so the smoke can GET /");
  const selfQuit = [...h.timers.values()].find(({ ms }) => ms === 30_000);
  assert.ok(selfQuit, "smoke mode must schedule a 30s self-quit");
  const [poll] = h.intervals.values();
  assert.ok(poll, "smoke mode must wait for its stop file");
  h.files.set("stop", "stop\n");
  poll.fn();
  assert.equal(h.quits(), 1);
  assert.equal(h.intervals.size, 0, "the poll must be cleared when shutdown begins");
});

test("smoke discovery skip reaches server startup, then is cleared before an agent child inherits env", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "cc-discovery-bootstrap-"));
  try {
    const serverEntry = path.join(fixture, "server.mjs");
    writeFileSync(serverEntry, `import { spawnSync } from "node:child_process";
const discoveryWasSkipped = process.env.CC_SKIP_DISCOVERY === "1";
setImmediate(() => {
  const agent = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.CC_SKIP_DISCOVERY ?? 'unset')"], { encoding: "utf8", env: process.env });
  process.stdout.write(JSON.stringify({ discoveryWasSkipped, agentEnv: agent.stdout }));
});
`);
    const args = plain(buildServerCommandArgs(serverEntry, true));
    const run = spawnSync(process.execPath, args, {
      cwd: fixture, encoding: "utf8", timeout: 10000,
      env: { ...process.env, CC_SKIP_DISCOVERY: "1" },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), { discoveryWasSkipped: true, agentEnv: "unset" });
    assert.deepEqual(plain(buildServerCommandArgs(serverEntry, false)), [serverEntry], "ordinary startup keeps its direct entry command");
  } finally {
    rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("normal launch strips an inherited discovery skip and uses the direct server entry", async () => {
  const h = shellHarness({}, { inheritedDiscoverySkip: true });
  const started = h.startServer();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "started");
  const [, args, options] = h.spawns.find(([command]) => command === "node");
  assert.deepEqual(plain(args), ["test-root/server/index.ts"], "normal launch must use the direct server entry");
  assert.equal(Object.hasOwn(options.env, "CC_SKIP_DISCOVERY"), false);
});

test("portable smoke quits if its server fails after readiness", async () => {
  const h = shellHarness({}, { smokeReadyFile: "ready.json", smokeStopFile: "stop", smokeDataDir: "smoke-data" });
  const ready = h.ready();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  h.proc.emit("exit", 1);
  assert.equal(h.quits(), 1, "server failure in smoke mode must quit the app");
});

test("portable smoke self-quits after 30s without a stop file", async () => {
  const h = shellHarness({}, { smokeReadyFile: "ready.json", smokeStopFile: "stop", smokeDataDir: "smoke-data" });
  const ready = h.ready();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  const selfQuit = [...h.timers.values()].find(({ ms }) => ms === 30_000);
  assert.ok(selfQuit, "missing smoke self-quit timer");
  selfQuit.fn();
  assert.equal(h.quits(), 1, "expired smoke timer must quit the app");
});

test("portable smoke never overwrites a ready file that is already there: it stops its server and quits", async () => {
  const h = shellHarness({}, { smokeReadyFile: "ready.json", smokeStopFile: "stop", smokeDataDir: "smoke-data" });
  h.files.set("ready.json", "left by another run\n");
  const ready = h.ready();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(h.files.get("ready.json"), "left by another run\n", "the existing ready file is untouched");
  assert.deepEqual(h.sent, ["shutdown"], "the failed publish stops the server it just started");
  assert.equal(h.intervals.size, 0, "no stop-file poll was started for a smoke that never published");
  h.proc.exitCode = 0;
  h.proc.emit("exit", 0);
  await within(ready, "ready");
  assert.equal(h.quits(), 1, "and the app quits");
});

test("the error page escapes what the server printed: markup in its output is shown as text, never run in the window that has the cc bridge", async () => {
  const hostile = `<img src=x onerror="cc.pickFolder()"> & <script>alert(1)</script> &amp; ok`;
  const h = shellHarness();
  const ready = h.ready();
  await Promise.resolve();
  h.proc.stderr.emit("data", Buffer.from(hostile));
  h.proc.emit("exit", 3);
  await within(ready, "ready");
  const page = decodeURIComponent(h.loaded.at(-1));
  assert.match(page, /exited with code 3 before it was ready/);
  assert.equal(page.includes("<img"), false, "no raw tag from the server's output");
  assert.equal(page.includes("<script>alert(1)"), false);
  assert.ok(page.includes("&lt;img src=x onerror=\"cc.pickFolder()\">"), "the tag is shown as text");
  assert.ok(page.includes("&amp;amp; ok"), "an ampersand in the output is itself escaped, so it cannot form an entity");
  // The same page is used for a server that stopped after it was running.
  const running = shellHarness();
  const runningReady = running.ready();
  await Promise.resolve();
  running.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(runningReady, "ready");
  running.proc.emit("error", new Error("<b>boom</b> & more"));
  const crashPage = decodeURIComponent(running.loaded.at(-1));
  assert.ok(crashPage.includes("&lt;b>boom&lt;/b> &amp; more"));
  assert.equal(crashPage.includes("<b>boom"), false);
});

test("packaged smoke launches the supplied portable exe and probes its ready port", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "cc-smoke-exe-guard-"));
  let smokeTemp;
  try {
    const sourceApp = path.join(fixture, "win-unpacked", "resources", "app");
    mkdirSync(path.join(sourceApp, "server"), { recursive: true });
    writeFileSync(path.join(sourceApp, "server", "index.ts"), "// smoke fixture\n");
    const exe = path.join(fixture, "Command Center.exe");
    writeFileSync(exe, "portable exe fixture");

    const launched = [];
    const fetched = [];
    let serverPidChecks = 0;
    const spawnProcess = (command, args, options) => {
      launched.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
        stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
        pid: 45678, exitCode: null, signalCode: null,
      });
      const stopPoll = setInterval(() => {
        if (!existsSync(options.env.CC_SMOKE_STOP_FILE)) return;
        clearInterval(stopPoll);
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      }, 5);
      setImmediate(() => writeFileSync(options.env.CC_SMOKE_READY_FILE, `${JSON.stringify({ port: 43123, serverPid: 45679 })}\n`));
      return child;
    };

    await within(runPackagedSmoke({
      root: realpathSync(process.cwd()),
      source: sourceApp,
      exe,
      spawnProcess,
      fetchPage: async (url) => { fetched.push(url); return { status: 200 }; },
      isRunning: (pid) => {
        assert.equal(pid, 45679);
        serverPidChecks++;
        return serverPidChecks === 1;
      },
      createTempDir: (prefix) => { smokeTemp = mkdtempSync(path.join(tmpdir(), prefix)); return smokeTemp; },
      logger: { log() {} },
      runIsolated: false,
    }), "packaged smoke", 20_000);

    assert.equal(launched.length, 1);
    assert.equal(launched[0].command, realpathSync(exe), "the smoke must launch Command Center.exe itself");
    assert.deepEqual(launched[0].args, []);
    assert.equal(launched[0].options.env.CC_SMOKE_READY_FILE.endsWith("ready.json"), true);
    assert.deepEqual(fetched, ["http://127.0.0.1:43123/"]);
    assert.ok(serverPidChecks >= 2, "smoke must wait for the packaged server PID to exit");
    assert.equal(existsSync(smokeTemp), false, "the smoke temp workspace must be removed after shutdown");
  } finally {
    if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("second-instance focuses the existing window, restoring it first if minimized (guard 3)", async () => {
  const h = shellHarness();
  const ready = h.ready();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  h.app.emit("second-instance");
  assert.deepEqual(h.order.filter((entry) => entry === "restore" || entry === "focus"), ["focus"], "not minimized: no restore needed");
  h.setMinimized(true);
  h.app.emit("second-instance");
  assert.deepEqual(h.order.slice(-2), ["restore", "focus"], "a minimized window must be restored before it is focused");
});

test("startup split-port guard buffers digits until the newline arrives", async () => {
  const h = shellHarness();
  let result;
  const started = h.startServer().then((value) => { result = value; });
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:5"));
  await Promise.resolve();
  assert.equal(result, undefined);
  h.proc.stderr.emit("data", Buffer.from("1234\n"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(result, undefined, "stderr cannot complete stdout readiness");
  h.proc.stdout.emit("data", Buffer.from("123"));
  await Promise.resolve();
  assert.equal(result, undefined);
  h.proc.stdout.emit("data", Buffer.from("4\n"));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(result, "the accumulated complete line must resolve startup");
  await within(started, "started");
  assert.equal(result.origin, "http://127.0.0.1:51234");
  for (const failure of ["exit", "timeout"]) {
    const failed = shellHarness();
    const pending = failed.startServer();
    await Promise.resolve();
    failed.proc.stderr.emit("data", Buffer.from("diagnostic failure"));
    if (failure === "exit") failed.proc.emit("exit", 1);
    else [...failed.timers.values()][0].fn();
    assert.match((await within(pending, "pending")).reason, /diagnostic failure/);
    assert.equal(failed.proc.stderr.listenerCount("data"), 0);
  }
});

// A portable build re-extracts to a fresh temp "root" on every launch, so the
// server must be pointed at a stable per-user directory for config/logs (see
// server/data-root.ts) -- but only when actually packaged, never for a source
// run, which must keep using the repo's own config/logs exactly as before.
test("startServer omits CC_DATA_DIR for a source run (not packaged)", async () => {
  const h = shellHarness();
  h.app.isPackaged = false;
  const started = h.startServer();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "started");
  assert.equal(Object.hasOwn(h.spawns[0][2].env, "CC_TEST_FORCE_PACKAGED"), false);
  assert.equal(h.spawns[0][2].env.CC_DATA_DIR, undefined);
});

test("startServer passes CC_DATA_DIR (Electron's userData) to the spawned server when packaged", async () => {
  const h = shellHarness();
  h.app.isPackaged = true;
  const started = h.startServer();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "started");
  assert.equal(Object.hasOwn(h.spawns[0][2].env, "CC_TEST_FORCE_PACKAGED"), false);
  assert.equal(h.spawns[0][2].env.CC_DATA_DIR, "test-data");
});

test("startServer never hands the fake CLI switch to the shipped server, even when the machine has one set", async () => {
  const h = shellHarness();
  h.env.CC_TEST_FAKE_CLI = "1";
  h.env.CC_TEST_FAKE_CLI_SCRIPT = "C:/stray/script.json";
  h.env.CC_TEST_FAKE_CLI_RECORD = "C:/stray/record.log";
  h.env.CC_KEPT_VARIABLE = "kept";
  const started = h.startServer();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "started");
  const serverEnv = h.spawns[0][2].env;
  for (const key of ["CC_TEST_FAKE_CLI", "CC_TEST_FAKE_CLI_SCRIPT", "CC_TEST_FAKE_CLI_RECORD"]) assert.equal(Object.hasOwn(serverEnv, key), false, `${key} must be stripped`);
  assert.equal(serverEnv.CC_KEPT_VARIABLE, "kept", "unrelated variables still pass through");
});

test("closing during port selection cannot spawn a server after cleanup", async () => {
  const h = shellHarness();
  const started = h.startServer();
  await within(h.stopServer(), "h.stopServer()");
  assert.equal(h.spawns.length, 0);
  assert.equal((await within(started, "started")).ok, false);
  const failing = shellHarness();
  const ready = failing.ready();
  await Promise.resolve();
  failing.win.loadURL = () => { throw new Error("startup failed after spawn"); };
  failing.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.deepEqual(failing.sent, ["shutdown"], "startup rejection must stop its child");
  [...failing.timers.values()][0].fn();
  failing.killer.emit("close", 0);
  await within(ready, "ready");
  assert.equal(failing.quits(), 1);
});
