import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { CLI_CATALOG } from "../server/settings/cli-catalog.ts";
import { validateInstallRequest } from "../server/settings/cli-install.ts";
import { request, cancel, serviceFixture } from "./pack29-cli-install.setup.ts";

test("shutdown preserves disconnected root and waits for every worker result", async () => {
  const text = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const start = text.indexOf("let shutdownWork:"), end = text.indexOf('process.on("SIGINT"', start);
  assert.ok(start > 0 && end > start, "shutdown implementation found");
  for (const connected of [false, true]) for (const confirmed of [false, true]) {
    const exits: number[] = [], terminated: boolean[] = [];
    let release!: (value: boolean) => void;
    const worker = new Promise<boolean>((done) => { release = done; });
    const noop = () => {};
    const shutdown = runInNewContext(`(() => { ${stripTypeScriptTypes(text.slice(start, end))}; return shutdown; })()`, {
      settingsService: { models: { close: noop, drain: async () => {} }, installer: { close: noop, drain: async () => true }, login: { close: noop, drain: async () => true } },
      closeWorkerAdmission: noop, fixedGitOperations: { close: noop, drain: async () => true },
      console: { log: noop, error: noop }, folderActivity: { endAllOwn: noop, closeWatchers: noop },
      leadersAndWaitingTurns: () => [], stopLeaderSession: noop, stopAllRunning: noop, drainWorkers: () => worker,
      process: { connected, exit: (code: number) => exits.push(code) },
      clients: [{ terminate: () => terminated.push(true) }], wss: { close: noop },
      server: { close: (done: () => void) => done(), closeAllConnections: noop },
      stallTimer: undefined, backpressureTimer: undefined, setTimeout, clearTimeout, clearInterval,
      describeError: String, spawnSync: () => assert.fail("must retain disconnected root for its parent"),
    });
    const pending = shutdown("test");
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(exits, [], `connected=${connected}: worker result is still pending`);
    assert.equal(terminated.length, connected ? 1 : 0, "disconnected root uses its own retained-root branch");
    release(confirmed); await pending;
    assert.deepEqual(exits, [confirmed ? 0 : 1], `connected=${connected}, worker confirmed=${confirmed}`);
  }
});

test("catalog id, exact fields and confirmation are enforced at service and validator", async () => {
  const fx = serviceFixture();
  try {
    for (const cli of ["unknown", "constructor", "__proto__", "toString", ...CLI_CATALOG.filter((row) => !row.recipe).map((row) => row.id), {}, []]) {
      await assert.rejects(fx.service.installCli({ ...request(), cli }), /catalog CLI|Invalid/);
    }
    for (const key of ["command", "url", "script", "package", "args", "cwd", "env", "pid", "timeout", "other"]) {
      const message = { ...request(), [key]: "hostile" };
      assert.throws(() => validateInstallRequest(message), /field/);
      await assert.rejects(fx.service.installCli(message), /field/);
      assert.throws(() => validateInstallRequest({ ...cancel(), [key]: "hostile" }, true), /field/);
    }
    for (const confirm of [false, undefined, "true", 1]) await assert.rejects(fx.service.installCli({ ...request(), confirm }), /confirmation/);
    assert.equal(fx.calls.length, 0, "invalid requests spawn nothing");
  } finally { fx.close(); }
});
test("fresh installed and unknown detection refuse before installer", async () => {
  for (const installed of [true, null]) {
    const fx = serviceFixture({ installed });
    try {
      await assert.rejects(fx.service.installCli(request()), installed ? /already installed/ : /unknown/);
      assert.equal(fx.calls.some((call) => call.installer), false, `installed=${installed}`);
    } finally { fx.close(); }
  }
});
test("synchronous install lock retains original canonical action, phases and PATH ordering", async () => {
  const fx = serviceFixture({ hold: true });
  try {
    const first = fx.service.installCli(request());
    assert.equal(fx.service.installer.busy, true, "lock before the first await");
    const second = fx.service.installCli(request("grok", "second"));
    const refused = second.then(() => false, (error) => /still active/.test(error.message));
    await new Promise((done) => setImmediate(done));
    assert.equal(fx.calls.filter((call) => call.installer).length, 1, "competing operation must not reach the installer");
    assert.equal(await refused, true);
    assert.equal(fx.service.state.catalogTools.grok.action, undefined);
    await new Promise((done) => setImmediate(done));
    assert.equal(fx.service.snapshot().catalogTools.qwen.action?.status, "running", "reconnect uses server state");
    assert.equal(fx.refreshes(), 1);
    fx.release(); await first;
    assert.equal(fx.calls.filter((call) => call.installer).length, 1);
    assert.equal(fx.refreshes(), 2, "post-install PATH refresh is required");
    assert.ok(fx.phases.includes("checking") && fx.phases.includes("installing") && fx.phases.includes("verifying"), fx.phases.join(","));
    assert.deepEqual(fx.service.state.catalogTools.qwen.action, { requestId: "install1", kind: "install", status: "done", phase: null, reason: null, message: "Installed" });
    assert.equal(fx.service.state.catalogTools.qwen.installed, true);
    assert.equal(fx.service.state.catalogTools.qwen.signedIn, null);
    assert.doesNotMatch(JSON.stringify(fx.service.snapshot()), /sensitive-output|secret-token|private-/);
    assert.equal(fx.service.installer.busy, false);
    const install = fx.calls.find((call) => call.installer);
    assert.ok(install.timeoutMs > 590_000 && install.timeoutMs <= 600_000, install.timeoutMs);
  } finally { fx.release(); fx.close(); }
});
test("exit zero without positive re-detection is failure", async () => {
  const fx = serviceFixture();
  try {
    const original = fx.service.installer;
    // Result does not dictate detection: the second fresh version probe does.
    const run = fx.run;
    let versions = 0;
    const { SettingsService } = await import("../server/settings/service.ts");
    const service = new SettingsService({ dataRoot: fx.data, env: fx.env, refreshPath: async () => {}, runCli: async (bin, args, options) => {
      if (bin === "qwen") { versions++; return { code: 127, stdout: "", stderr: "" }; }
      return run(bin, args, options);
    } });
    await assert.rejects(service.installCli(request()), /could not find/);
    assert.equal(versions, 2);
    assert.equal(service.state.catalogTools.qwen.action?.reason, "notFoundAfterInstall");
    assert.equal(original.busy, false);
  } finally { fx.close(); }
});
test("failures have static reasons, no raw output, no retry or implicit login", async () => {
  for (const [code, reason] of [[1, "installFailed"], [124, "timeout"]] as const) {
    const fx = serviceFixture({ result: { code } });
    try {
      await assert.rejects(fx.service.installCli(request()));
      assert.equal(fx.service.state.catalogTools.qwen.action?.reason, reason);
      assert.equal(fx.calls.filter((call) => call.installer).length, 1);
      assert.equal(fx.calls.some((call) => call.bin === "cmd"), false);
      assert.doesNotMatch(JSON.stringify(fx.service.snapshot()), /sensitive-output|secret-token/);
    } finally { fx.close(); }
  }
});
test("cancellation owns only the correlated operation and unconfirmed cleanup retains lock", async () => {
  let retry = false;
  const fx = serviceFixture({ result: { cleanupConfirmed: false, retryCleanup: async () => retry } });
  try {
    await assert.rejects(fx.service.installCli(request()), /confirm the installer/);
    assert.equal(fx.service.installer.busy, true);
    await assert.rejects(fx.service.cancelCliInstall(cancel("grok")), /matching/);
    await assert.rejects(fx.service.cancelCliInstall({ ...cancel(), installRequestId: "other" }), /matching/);
    await assert.rejects(fx.service.cancelCliInstall(cancel()), /confirm the installer/);
    await assert.rejects(fx.service.installCli(request("grok")), /still active/);
    assert.equal(await fx.service.installer.drain(), false, "unknown cleanup cannot satisfy shutdown drain");
    assert.equal(fx.service.installer.busy, true);
    retry = true; await fx.service.cancelCliInstall(cancel());
    assert.equal(fx.service.installer.busy, false);
    assert.equal(fx.service.state.catalogTools.qwen.action?.reason, "cancelled");
  } finally { fx.close(); }
});
test("shutdown closes admission and drains cancellation, orphan uncertainty blocks admission", async () => {
  const fx = serviceFixture({ hold: true });
  try {
    const pending = fx.service.installCli(request());
    const failure = assert.rejects(pending, /stopped/);
    await new Promise((done) => setImmediate(done));
    const drain = fx.service.installer.drain();
    await assert.rejects(fx.service.installCli(request("grok")), /blocked/);
    fx.release(); assert.equal(await drain, true); await failure;
    assert.equal(fx.service.state.catalogTools.qwen.action?.reason, "cancelled");
  } finally { fx.release(); fx.close(); }
  const blocked = serviceFixture({ admission: () => false });
  try { await assert.rejects(blocked.service.installCli(request()), /orphan cleanup/); assert.equal(blocked.calls.length, 0); }
  finally { blocked.close(); }
});

test("actual server shutdown waits for installer drain in connected and disconnected branches", async () => {
  const text = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const start = text.indexOf("let shutdownWork:"), end = text.indexOf('process.on("SIGINT"', start);
  assert.ok(start > 0 && end > start, "production shutdown functions must be found");
  for (const connected of [true, false]) {
    const fx = serviceFixture({ hold: true }), exitCodes: number[] = [];
    const nothing = () => {};
    try {
      const pending = fx.service.installCli(request());
      const failed = assert.rejects(pending, /stopped/);
      await new Promise((done) => setImmediate(done));
      const shutdown = runInNewContext(`(() => { ${stripTypeScriptTypes(text.slice(start, end))}; return shutdown; })()`, {
        settingsService: fx.service, closeWorkerAdmission: nothing, fixedGitOperations: { close: nothing, drain: async () => true },
        console: { log: nothing, error: nothing }, folderActivity: { endAllOwn: nothing, closeWatchers: nothing },
        leadersAndWaitingTurns: () => [], stopLeaderSession: nothing, stopAllRunning: nothing, drainWorkers: async () => true,
        process: { connected, exit: (code: number) => exitCodes.push(code) }, clients: [], wss: { close: nothing },
        server: { close: (done: () => void) => done(), closeAllConnections: nothing },
        stallTimer: undefined, backpressureTimer: undefined, setTimeout, clearTimeout, clearInterval,
        describeError: String, spawnSync: () => assert.fail("no taskkill expected"),
      });
      const drain = shutdown("test");
      await new Promise((done) => setImmediate(done));
      assert.deepEqual(exitCodes, [], "server must not exit while installer is draining");
      await assert.rejects(fx.service.installCli(request("grok")), /blocked/);
      fx.release(); await drain; await failed;
      assert.deepEqual(exitCodes, [0]);
      assert.equal(fx.service.installer.busy, false);
      assert.equal(fx.service.state.catalogTools.qwen.action?.reason, "cancelled");
    } finally { fx.release(); fx.close(); }
  }
});
