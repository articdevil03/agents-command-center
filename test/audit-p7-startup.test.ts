import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { shellHarness, within } from "./electron-helpers.ts";

const read = (file: string) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// Execute the actual startup entry and runtime prelude. Only IO/service boundaries
// are replaced; mkdir holds the first initialization await and listen is a fake socket.
function serverHarness({ connected = true, holdListen = false } = {}) {
  const runtime = read("server/runtime-env.ts") + read("server/shutdown-latch.ts"), entry = read("server/index.ts");
  const calls: string[] = [], logs: string[] = [];
  const proc = Object.assign(new EventEmitter(), {
    env: { CC_SKIP_DISCOVERY: "1" }, connected, send() {},
    exit: (code: number) => calls.push(`exit:${code}`),
  });
  let resume!: () => void;
  const initialized = new Promise<void>((resolve) => { resume = resolve; });
  const service = () => ({ close: () => calls.push("close"), drain: async () => true });
  const settings = { installer: service(), login: service(), cliKeys: service(), models: service(), setOnChange() {} };
  let onListen = () => {};
  const http = Object.assign(new EventEmitter(), {
    listen: (_port: number, _host: string, cb: () => void) => { calls.push("listen"); onListen = cb; if (!holdListen) cb(); },
    address: () => ({ port: 12345 }), close: (cb: () => void) => { calls.push("http-close"); cb(); }, closeAllConnections() {},
  });
  const context: any = {
    process: proc, console: { log: (s: string) => logs.push(s), error: (s: string) => logs.push(s) },
    setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
  };
  for (const match of entry.matchAll(/^import\s+\{([^}]+)\}\s+from[^;]+;/gm)) {
    for (const name of match[1].split(",").map((s) => s.trim()).filter(Boolean)) context[name] = () => {};
  }
  Object.assign(context, {
    join: (...parts: string[]) => parts.join("/"), dirname: () => "fixture", fileURLToPath: () => "fixture/server/index.ts",
    mkdir: () => initialized, randomBytes: () => ({ toString: () => "a".repeat(64) }),
    ChatStore: class {}, RequestsStore: class { list() { return []; } },
    createFolderActivity: () => ({ endAllOwn() {}, closeWatchers() {} }),
    resolveDataRoot: () => "fixture", dataRoot: "fixture", scratchDir: "fixture/scratch",
    cleanScratch: async () => {}, readWorkspaces: () => ({ projects: [] }), workspaces: { projects: [] },
    readAcpClis: () => [], readClientPrefs: () => ({}), resolveClaudeCli: () => null,
    sweepOrphans: async () => ({ finished: true, checked: 0, killed: 0 }),
    SettingsService: class { constructor() { context.settingsService = settings; } },
    setRequestsStore: (store: unknown) => { context.requestsStore = store; },
    pendingHandoverReads: new Set(), blockedSeatKeys: new Set(),
    launchSafety: { blocked: [], uncertain: [], live: [] }, workspaceRecovery: () => ({ blocked: false }),
    launchSafetyRecoveryStatus: () => ({ held: false }),
    createServer: () => http, WebSocketServer: class extends EventEmitter { close() {} },
    clients: new Set(), laggingClients: new Set(), folderActivity: { endAllOwn() {}, closeWatchers() {} },
    fixedGitOperations: service(), leadersAndWaitingTurns: () => [],
    drainWorkers: async () => true, closeWorkerAdmission: () => calls.push("admission-closed"),
    describeError: String,
  });
  const plainRuntime = stripTypeScriptTypes(runtime).replaceAll("export ", "");
  const plainEntry = stripTypeScriptTypes(entry).replace(/^import[\s\S]*?;\n/gm, "").replaceAll("import.meta.url", '"fixture"');
  const started = runInNewContext(`${plainRuntime}\n(async () => { ${plainEntry} })()`, context);
  return { proc, calls, logs, resume, started, onListen: () => onListen() };
}

for (const signal of ["shutdown", "disconnect", "SIGTERM", "SIGINT"]) test(`P7 early ${signal} latches without uninitialized drains and never becomes ready`, async () => {
  const h = serverHarness();
  if (signal === "shutdown") h.proc.emit("message", signal); else h.proc.emit(signal);
  h.proc.emit("message", "shutdown");
  assert.deepEqual(h.calls, [], "no service can be closed before initialization");
  h.resume(); await within(h.started, "initialization"); await tick();
  assert.equal(h.calls.filter((c) => c === "admission-closed").length, 1, "one drain despite repeated requests");
  assert.equal(h.calls.includes("listen"), false, "shutdown startup must not bind or advertise readiness");
  assert.equal(h.logs.some((s) => s.includes("Command Center running")), false);
  assert.ok(h.calls.includes("exit:0"));
  h.proc.emit("message", "shutdown"); await tick();
  assert.equal(h.calls.filter((c) => c === "admission-closed").length, 1);
});

test("P7 ordinary startup still listens and later shutdown drains once", async () => {
  const h = serverHarness(); h.resume(); await within(h.started, "initialization");
  assert.equal(h.calls.filter((c) => c === "listen").length, 1);
  assert.equal(h.logs.filter((s) => s.includes("Command Center running")).length, 1);
  h.proc.emit("message", "shutdown"); h.proc.emit("SIGINT"); await tick();
  assert.equal(h.calls.filter((c) => c === "admission-closed").length, 1);
});

test("P7 disconnected parent before runtime registration is latched", async () => {
  const h = serverHarness({ connected: false }); assert.deepEqual(h.calls, []);
  h.resume(); await within(h.started, "initialization"); await tick();
  assert.equal(h.calls.includes("listen"), false);
  assert.equal(h.calls.filter((c) => c === "admission-closed").length, 1);
});

test("P7 listen callback arriving after shutdown never announces readiness", async () => {
  const h = serverHarness({ holdListen: true }); h.resume(); await within(h.started, "initialization");
  h.proc.emit("message", "shutdown"); h.onListen(); await tick();
  assert.equal(h.logs.some((s) => s.includes("Command Center running")), false);
});

for (const outcome of ["graceful", "forced", "unknown", "kill-error"]) test(`P7 missing readiness waits for owned child cleanup: ${outcome}`, async () => {
  const h = shellHarness(); let result: any;
  const startup = h.startServer().then((r: any) => { result = r; }); await tick();
  const timeout = [...h.timers.values()].find((t: any) => t.ms === 60_000)!;
  assert.ok(timeout, "the real readiness timeout is armed"); timeout.fn(); await tick();
  assert.deepEqual(h.sent, ["shutdown"]); assert.equal(result, undefined, "timeout cannot settle before cleanup");
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await tick(); assert.equal(result, undefined, "late readiness cannot revive startup");
  if (outcome !== "graceful") {
    const grace = [...h.timers.values()].find((t: any) => t.ms === 125_000)!;
    assert.ok(grace); grace.fn(); await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(h.spawns[1][1])), ["/pid", "1234", "/T", "/F"]);
    assert.equal(result, undefined, "wait for the owned kill result");
  }
  if (outcome === "graceful" || outcome === "forced") { h.proc.exitCode = 0; h.proc.emit("exit", 0); }
  if (outcome !== "graceful") h.killer.emit(outcome === "kill-error" ? "error" : "close", outcome === "kill-error" ? new Error("denied") : 0);
  if (outcome === "unknown" || outcome === "kill-error") {
    const confirmation = [...h.timers.values()].find((t: any) => t.ms === 2_000);
    assert.ok(confirmation, "unconfirmed kill has a bounded exit wait");
    assert.equal(result, undefined); confirmation.fn();
  }
  await within(startup, "failed startup");
  assert.equal(result.ok, false);
  assert.match(result.reason, outcome === "unknown" || outcome === "kill-error" ? /cleanup could not be confirmed/ : /server stopped/);
  assert.equal(h.proc.stdout.listenerCount("data"), 0);
});

test("P7 startup failure gives plain guidance first and escaped redacted Details", async () => {
  const h = shellHarness(); const ready = h.ready(); await tick();
  const key = "b".repeat(64), token = "sk-testsecretvalue123456789", U = ["C:", "Users"].join("\\");
  h.proc.stderr.emit("data", Buffer.from(JSON.stringify({ path: U + "\\EscapedName\\app.ts" }) + `\nError at ${U}\\PrivateName\\app.ts and /home/PrivateName/app.ts\n${U}\\Private Person\\app.ts\nCC_APP_KEY=${key}\napiKey=${token}\n{"api_key":"shortCredential"}\npassword="two word password"\nAuthorization: Bearer sampleCredential\n<script>alert(1)</script> & diagnostics`));
  h.proc.emit("exit", 3); await within(ready, "error page");
  const page = decodeURIComponent(h.loaded.at(-1));
  assert.match(page, /<h2>Command Center could not start\.<\/h2><p>Close Command Center and open it again\./);
  const primary = page.slice(page.indexOf("<h2>"), page.indexOf("<details"));
  assert.doesNotMatch(primary, /Error at|exited with code|app.ts|script/);
  assert.match(page, /<details[^>]*><summary>Details<\/summary><pre[^>]*>[^]*&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; diagnostics[^]*<\/pre><\/details>/);
  assert.doesNotMatch(page, /EscapedName|PrivateName|Private Person|shortCredential|two word password|sampleCredential|sk-testsecret|b{64}|<script>alert/);
});

// The loop above also sends an IPC shutdown, so these send ONLY the signal: each registration must work alone.
for (const signal of ["SIGINT", "SIGTERM"]) test(`P7 ${signal} alone before initialization is latched and drained once`, async () => {
  const h = serverHarness();
  h.proc.emit(signal); h.proc.emit(signal);
  assert.deepEqual(h.calls, [], "nothing is closed before initialization");
  h.resume(); await within(h.started, "initialization"); await tick();
  assert.equal(h.calls.includes("listen"), false, `${signal} before initialization never becomes ready`);
  assert.equal(h.calls.filter((c) => c === "admission-closed").length, 1);
});

test("P7 repeated signals after the handler is bound dispatch one shutdown", async () => {
  const h = serverHarness(); h.resume(); await within(h.started, "initialization");
  for (const signal of ["SIGINT", "SIGTERM", "SIGINT"]) h.proc.emit(signal);
  await tick();
  assert.equal(h.calls.filter((c) => c === "admission-closed").length, 1);
  assert.equal(h.calls.filter((c) => c === "http-close").length, 1);
});
