import { app, shell, safeStorage } from "electron";
import { createCliCredentialStore, handleCliCredentialMessage } from "./cli-credentials.js";
import { validateLoginUrl } from "../server/settings/cli-login-policy.js";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { serverNodeRuntime } from "./node-runtime.js";
import { root, smokeReadyFile } from "./config.js";

// Must stay above the server's start-up sweep cap (SWEEP_CAP_MS, 41 s) plus start-up work: the server waits for that sweep before it listens.
export const READY_TIMEOUT_MS = 60_000;
// The server drains its Git work (73 s, then 41 s of helpers), its workers (about 52 s) and its HTTP close (7 s) in parallel, so a normal
// shutdown can take up to about 114 s: the parent only force-kills a server that is still alive after that, with a margin.
// A server that exits on its own still finishes at once (see stopServer).
export const KILL_GRACE_MS = 125_000;

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

export async function handleLoginOpen(message, reply, open = (url) => shell.openExternal(url)) {
  if (!message || message.type !== "openCliLogin") return;
  if (typeof message.id !== "string" || !/^[a-f0-9]{48}$/.test(message.id)) return;
  const url = validateLoginUrl(message.cli, message.url);
  let ok = false;
  if (url && Object.keys(message).length === 4) {
    try { await open(url); ok = true; } catch { /* only a boolean crosses back */ }
  }
  reply({ type: "cliLoginOpened", id: message.id, ok });
}

export let serverProcess = null;
// This run's secret: made fresh for every server start, handed to the server in its env and to the app page through the
// "cc:app-key" IPC, keeping it out of the page address. WebSocket uses a query key; POST uses a header.
// Bare source startup prints a fragment URL. Electron never logs or saves the key.
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
  const runtime = serverNodeRuntime(serverEntry, passDiscoverySkip);
  Object.assign(serverEnv, runtime.env);
  serverProcess = spawn(runtime.command, runtime.args, {
    cwd: root,
    env: { ...serverEnv, CC_PORT: String(port), CC_APP_KEY: appKey, ...dataDirEnv },
    windowsHide: true,
    // Give Node its own lifetime on Windows so parent death reaches its IPC
    // disconnect handler instead of terminating it with Electron's console.
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const ownedServer = serverProcess;
  let credentialStore;
  ownedServer.on("message", (message) => {
    if (message?.type === "cliCredentialRequest") {
      credentialStore ??= createCliCredentialStore({ safeStorage, dir: join(app.getPath("userData"), "credentials") });
      void handleCliCredentialMessage(message, (result) => {
        if (ownedServer.connected) ownedServer.send(result, () => {});
      }, credentialStore);
    }
    void handleLoginOpen(message, (result) => {
      if (ownedServer.connected) ownedServer.send(result, () => {});
    });
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
    let failing = false;
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
      if (settled || failing) return;
      if (serverStopping) { finish({ ok: false, reason: "Application is closing." }); return; }
      buffered += chunk.toString("utf8");
      const readyPort = parseServerPort(buffered);
      if (readyPort !== null) finish({ ok: true, origin: `http://127.0.0.1:${readyPort}`, port: readyPort });
    };
    const onStderr = (chunk) => { stderr += chunk.toString("utf8"); };
    const onExit = (code) => finish({ ok: false, reason: `server exited with code ${code} before it was ready.\n\n${buffered}\n${stderr}` });
    // A missing bundled runtime never starts, so it emits "error" and no "exit": without this the clear reason waits out the 60 s timer and is
    // then replaced by a vaguer one.
    const onError = (error) => finish({ ok: false, reason: `the server could not be started: ${error.message}\n\nCommand Center's bundled runtime could not start.\n\n${buffered}\n${stderr}` });
    const timer = setTimeout(
      async () => {
        if (settled || failing) return;
        failing = true;
        // Ignore late readiness and exit while the owned child's cleanup is in progress.
        ownedServer.off("exit", onExit);
        ownedServer.off("error", onError);
        const confirmed = await stopServer();
        finish({ ok: false, reason: `server did not report ready within ${READY_TIMEOUT_MS}ms. ${confirmed ? "The server stopped." : "Server cleanup could not be confirmed. Close Command Center and try again."}\n\n${buffered}\n${stderr}` });
      },
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
  if (!serverProcess) return Promise.resolve(true);
  const proc = serverProcess;
  serverStopPromise = new Promise((resolveStopped) => {
    if (proc.exitCode != null || proc.signalCode != null) { resolveStopped(true); return; }
    let backstop = 0, confirmation = 0, settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      clearTimeout(backstop); clearTimeout(confirmation);
      proc.off("exit", gone);
      resolveStopped(confirmed);
    };
    const gone = () => finish(true);
    proc.once("exit", gone);
    backstop = setTimeout(() => {
      const killed = () => {
        if (settled || confirmation) return;
        if (proc.exitCode != null || proc.signalCode != null) { finish(true); return; }
        // taskkill close can precede the owned child's exit delivery.
        confirmation = setTimeout(() => finish(proc.exitCode != null || proc.signalCode != null), 2_000);
      };
      try {
        const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
        killer.once("close", killed);
        killer.once("error", killed);
      } catch { killed(); }
    }, KILL_GRACE_MS);
    try { if (proc.connected) proc.send("shutdown", () => {}); } catch { /* The owned-child backstop still applies. */ }
  }).then((confirmed) => {
    if (!confirmed) serverStopPromise = null;
    return confirmed;
  });
  return serverStopPromise;
}
