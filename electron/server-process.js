import { app } from "electron";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { root, smokeReadyFile } from "./config.js";

// Must stay above the server's start-up sweep cap (SWEEP_CAP_MS, 41 s) plus start-up work: the server waits for that sweep before it listens.
export const READY_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 3_000;

// Reads the accumulated stdout text from the spawned server, not a single
// chunk: a line can arrive split across two `data` events, and the caller
// re-runs this against the whole buffer on every chunk rather than trying to
// reassemble lines itself.
export function parseServerPort(text) {
  const match = /(?:^|\n)Command Center running at http:\/\/[^:\s]+:(\d+)\r?\n/.exec(text);
  if (!match) return null;
  const port = Number(match[1]);
  return port > 0 ? port : null;
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolvePort(port));
    });
  });
}

export let serverProcess = null;
// This run's secret: made fresh for every server start, handed to the server in its env and to the app page through the
// "cc:app-key" IPC (the page then sends it on its WebSocket and every POST). Never in a URL, a log or a file.
export let appKey = null;
export let serverStopping = false;
let serverStopPromise = null;

// ponytail: a probe-then-release free-port check has a tiny theoretical race
// (another process grabs the port between our close() and the child's
// listen()). Accepted for a local single-user desktop tool; the alternative
// (threading an OS-assigned port back through server/security.ts's
// module-load-time allow-list) is a materially bigger, riskier diff for a
// race that has never been observed on loopback.
export async function startServer(onFailure = () => {}) {
  const port = await getFreePort();
  if (serverStopping) return { ok: false, reason: "Application is closing." };
  const serverEntry = join(root, "server", "index.ts");
  // Only set when packaged: a portable build re-extracts to a fresh temp
  // "root" on every launch, so config and logs must live in a stable
  // per-user directory instead (see server/data-root.ts). Running from
  // source (npm run app) never sets this, so the server falls back to the
  // repo root exactly as before.
  const dataDirEnv = app.isPackaged ? { CC_DATA_DIR: app.getPath("userData") } : {};
  const passDiscoverySkip = Boolean(smokeReadyFile) && process.env.CC_SKIP_DISCOVERY === "1";
  appKey = randomBytes(32).toString("hex");
  const { CC_TEST_FORCE_PACKAGED: _ccTestForcePackaged, ...serverEnv } = process.env;
  for (const key of Object.keys(serverEnv)) {
    if (key.startsWith("CC_SMOKE_") || key.startsWith("CC_TEST_FAKE_CLI")) delete serverEnv[key];
  }
  if (!passDiscoverySkip) delete serverEnv.CC_SKIP_DISCOVERY;
  serverProcess = spawn("node", buildServerCommandArgs(serverEntry, passDiscoverySkip), {
    cwd: root,
    env: { ...serverEnv, CC_PORT: String(port), CC_APP_KEY: appKey, ...dataDirEnv },
    windowsHide: true,
    // Give Node its own lifetime on Windows so parent death reaches its IPC
    // disconnect handler instead of terminating it with Electron's console.
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  // Before the server reports ready, a failure comes back through the returned reason (one error page, with its output); only a
  // server that was running and then stopped is reported through onFailure.
  let serverReady = false;
  serverProcess.on("error", (error) => {
    if (!serverStopping && serverReady) onFailure(error.message);
  });
  serverProcess.on("exit", (code) => {
    if (!serverStopping && serverReady) onFailure(`Server stopped (code ${code}). Close and reopen Command Center.`);
  });

  return new Promise((resolveReady) => {
    let settled = false;
    let buffered = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      serverProcess.stdout.off("data", onData);
      serverProcess.stderr.off("data", onStderr);
      serverProcess.off("exit", onExit);
      serverProcess.off("error", onError);
      serverReady = result.ok === true;
      resolveReady(result);
    };
    const onData = (chunk) => {
      buffered += chunk.toString("utf8");
      const readyPort = parseServerPort(buffered);
      if (readyPort !== null) finish({ ok: true, origin: `http://127.0.0.1:${readyPort}`, port: readyPort });
    };
    const onStderr = (chunk) => { stderr += chunk.toString("utf8"); };
    const onExit = (code) => finish({ ok: false, reason: `server exited with code ${code} before it was ready.\n\n${buffered}\n${stderr}` });
    // A missing Node never starts, so it emits "error" and no "exit": without this the clear reason waits out the 15 s timer and is
    // then replaced by a vaguer one.
    const onError = (error) => finish({ ok: false, reason: `the server could not be started: ${error.message}\n\nCommand Center needs Node.js 24 or newer installed and on the PATH.\n\n${buffered}\n${stderr}` });
    const timer = setTimeout(
      () => finish({ ok: false, reason: `server did not report ready within ${READY_TIMEOUT_MS}ms.\n\n${buffered}\n${stderr}` }),
      READY_TIMEOUT_MS
    );
    serverProcess.stdout.on("data", onData);
    serverProcess.stderr.on("data", onStderr);
    serverProcess.on("exit", onExit);
    serverProcess.on("error", onError);
  });
}

export function stopServer() {
  if (serverStopPromise) return serverStopPromise;
  serverStopping = true;
  if (!serverProcess) return Promise.resolve();
  const proc = serverProcess;
  serverStopPromise = new Promise((resolveStopped) => {
    // The server stops its own workers on "shutdown", so a server that is gone is done at once: taskkill on a dead pid finds nothing (or
    // hits a new process that reused it), and always waiting the grace would hold the quit, and a relaunch, for 3 s every time.
    if (proc.exitCode != null || proc.signalCode != null) { resolveStopped(); return; }
    let backstop = 0;
    const gone = () => { clearTimeout(backstop); resolveStopped(); };
    proc.once("exit", gone);
    backstop = setTimeout(() => {
      proc.off("exit", gone);
      const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
      killer.once("close", resolveStopped);
      killer.once("error", resolveStopped);
    }, KILL_GRACE_MS);
    if (proc.connected) proc.send("shutdown", () => {});
  });
  return serverStopPromise;
}

export function buildServerCommandArgs(serverEntry, passDiscoverySkip) {
  if (!passDiscoverySkip) return [serverEntry];
  // Direct `node <entry>` cannot clear this startup-only flag after the entry
  // imports but before the server launches agents. The bootstrap keeps it in
  // the server during discovery and removes it before agent children spawn.
  const entryUrl = pathToFileURL(serverEntry).href;
  const bootstrap = "im" + "port(" + JSON.stringify(entryUrl) + ").then(() => { delete process.env.CC_SKIP_DISCOVERY; });";
  return ["--input-type=module", "--eval", bootstrap];
}
