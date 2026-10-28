// Manual Windows smoke proof, separate from node:test. Uses the real Electron
// binary, server and run path (the "run" message), with a harmless stand-in for the paid CLI.
// It opens a real Electron window (closing that window is what it proves), so it is never part of npm test.
// Everything it touches lives in one disposable folder under the repo: a copy of electron/, server/ and public/, its own data root
// (CC_DATA_DIR) and a fresh first-run workspace. It never reads or copies the owner's config/, chats or settings.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(root, ".cc-test-electron-proof-"));
const tracked = new Map(); // pid -> { name, created, commandLine } as first seen, so cleanup never kills a pid that something else reused
const system32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
const forceBackstop = process.argv.includes("--backstop");
const forceParent = process.argv.includes("--force-parent");
let desktop;
let browserServer;
let debuggerSocket;
let agentSocket;
let desktopOutput = "";
let serverError = null;

async function until(read, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (serverError) throw new Error(`Server refused: ${serverError}`);
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const port = server.address().port;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}

// Created is the process's creation time in ms: a pid handed to another program later has a different one.
function processes() {
  const result = spawnSync(join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; Created = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(); CommandLine = $_.CommandLine } } | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }); // every process's command line is in the list
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// Tracked only while the process is in `list` (a process list taken just now): its creation time and command line are recorded with its name.
function track(pid, name, list) {
  const item = pid && !tracked.has(pid) ? list.find((entry) => entry.ProcessId === pid) : null;
  if (item) tracked.set(pid, { name: name.toLowerCase(), created: item.Created, commandLine: item.CommandLine ?? null });
}
// The same process, not another one that was given its pid: same name, same creation time and same command line.
const isTracked = (item) => {
  const record = tracked.get(item.ProcessId);
  return Boolean(record) && record.name === item.Name.toLowerCase() && record.created === item.Created && record.commandLine === (item.CommandLine ?? null);
};
// Children of a tracked process that were created after it (a child is never older than its parent), found in `list`.
function adoptDescendants(list) {
  for (let changed = true; changed;) {
    changed = false;
    for (const item of list) {
      if (tracked.has(item.ProcessId)) continue;
      const parent = list.find((entry) => entry.ProcessId === item.ParentProcessId);
      if (parent && isTracked(parent) && item.Created >= parent.Created) { track(item.ProcessId, item.Name, list); changed = true; }
    }
  }
}

// The pid the worker reported about itself is only a claim: it is this run's worker only if that live process has this run's exact worker.cjs
// path in its command line, the parent it reported, and a parent chain that reaches the process this run started (a stale or reused pid fails).
function isThisRunsWorker(list, worker, workerPath, rootPid) {
  const item = list.find((entry) => entry.ProcessId === worker.pid);
  if (!item || item.ParentProcessId !== worker.ppid || !String(item.CommandLine ?? "").toLowerCase().includes(workerPath.toLowerCase())) return false;
  for (let pid = item.ParentProcessId, hops = 0; hops < 8; hops++) {
    if (pid === rootPid) return true;
    pid = list.find((entry) => entry.ProcessId === pid)?.ParentProcessId;
    if (pid === undefined) return false;
  }
  return false;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return socket;
}

let nextId = 0;
async function cdp(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { debuggerSocket.removeEventListener("message", onMessage); reject(new Error(method)); }, 5000);
    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      debuggerSocket.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolveResult(message.result);
    }
    debuggerSocket.addEventListener("message", onMessage);
    debuggerSocket.send(JSON.stringify({ id, method, params }));
  });
}

try {
  for (const name of ["electron", "server", "public", "package.json"]) {
    cpSync(join(root, name), join(dir, name), { recursive: true });
  }
  if (forceBackstop) {
    const path = join(dir, "server/index.ts");
    const source = readFileSync(path, "utf8");
    const target = 'if (message === "shutdown") shutdown("IPC shutdown");';
    assert.ok(source.includes(target));
    writeFileSync(path, source.replace(target, "// Deliberately ignore graceful shutdown in this disposable copy."));
  }
  mkdirSync(join(dir, "profile"));
  // config/ is deliberately not copied: the owner's workspaces.json would win over the first-run seed and point the run at his real
  // project folders. The server starts on the data root below and makes its own one-project example workspace (tab "example-development").
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  // No real agent is invoked. The "run" message still builds the real acceptEdits command and spawns cmd.exe; this local CLI just
  // reports its PID and stays alive. It lives in bin/, outside every project folder (the runner never uses a CLI found inside one),
  // and does nothing without the brief variable, so the server's own CLI discovery gets an instant failure, not a lingering process.
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/claude.cmd"), `@echo off\r\nif not defined CC_BRIEF_PATH exit /b 1\r\n"${process.execPath}" "${join(dir, "worker.cjs")}"\r\n`);
  writeFileSync(join(dir, "worker.cjs"), 'console.log("CC_PROOF_WORKER " + JSON.stringify({pid:process.pid,ppid:process.ppid})); setInterval(() => {}, 1000);');
  // Keep Electron's profile/crash/cache writes inside the disposable workspace.
  writeFileSync(join(dir, "electron/proof-main.js"), `import { app, BrowserWindow } from "electron";
    app.setPath("userData", ${JSON.stringify(join(dir, "profile"))});
    app.setPath("crashDumps", ${JSON.stringify(join(dir, "profile"))});
    await import("./main.js");
    setInterval(() => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) console.log("CC_PROOF_WINDOW " + JSON.stringify({visible:win.isVisible(),url:win.webContents.getURL()}));
    }, 200).unref();`);
  const debugPort = await freePort();
  // CC_DATA_DIR is honoured by the server (Electron passes it on unchanged when not packaged); CC_TEST_FORCE_PACKAGED is stripped by
  // electron/main.js and only matters if this script is ever run inside node --test, which NODE_TEST_CONTEXT would otherwise reveal.
  const env = { ...process.env, CC_SKIP_LEADER_CHECK: "1", CC_DATA_DIR: dataDir, CC_TEST_FORCE_PACKAGED: "1", HOME: dir, USERPROFILE: dir, TEMP: dir, TMP: dir };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  env[pathKey] = `${join(dir, "bin")};${env[pathKey]}`;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_TEST_CONTEXT;
  delete env.CC_APP_KEY;
  desktop = spawn(join(root, "node_modules/electron/dist/electron.exe"), [
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(dir, "profile")}`,
    join(dir, "electron/proof-main.js"),
  ], { cwd: dir, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
  track(desktop.pid, "electron.exe", processes());
  desktop.stdout.on("data", (chunk) => { desktopOutput += chunk; });
  desktop.stderr.on("data", (chunk) => { desktopOutput += chunk; });
  const page = await until(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return pages.find((item) => /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(item.url));
    } catch { return null; }
  }, "Electron window on ready server port");
  debuggerSocket = await connect(page.webSocketDebuggerUrl);
  await cdp("Page.bringToFront");
  const rendered = await until(async () => {
    const value = await cdp("Runtime.evaluate", { expression: "({url:location.href,title:document.title,visible:document.visibilityState,ready:document.readyState,body:document.body.innerText.slice(0,200)})", returnByValue: true });
    return value.result.value.ready === "complete" && value;
  }, "window rendering complete");
  console.log("WINDOW", JSON.stringify(rendered.result.value));
  const nativeWindow = await until(() => {
    const matches = [...desktopOutput.matchAll(/CC_PROOF_WINDOW (\{[^\n]+\})/g)];
    const value = matches.length && JSON.parse(matches.at(-1)[1]);
    return value?.url.startsWith("http:") && value;
  }, "native window visibility");
  console.log("NATIVE_WINDOW", JSON.stringify(nativeWindow));
  assert.equal(nativeWindow.visible, true);
  assert.equal(rendered.result.value.title, "Command Center");
  const screenshot = await cdp("Page.captureScreenshot");
  const screenshotPath = join(dir, "electron-process-proof.png");
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log("SCREENSHOT (temporary, removed on cleanup)", screenshotPath);
  const origin = new URL(page.url).origin;
  assert.equal((await fetch(origin)).status, 200);
  // The page holds this run's app key (Electron made it); read it the way the page does, never from a file or the environment.
  const keyResult = await cdp("Runtime.evaluate", { expression: "window.cc.appKey()", awaitPromise: true, returnByValue: true });
  const appKey = keyResult.result.value;
  assert.match(String(appKey), /^[0-9a-f]{64}$/, "the page must hold a 64-hex app key");
  const wsUrl = origin.replace("http:", "ws:");
  await assert.rejects(connect(`${wsUrl}/?key=${"0".repeat(64)}`), undefined, "a wrong app key must not connect");
  agentSocket = await connect(`${wsUrl}/?key=${appKey}`);
  let output = "";
  let accepted = null;
  agentSocket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    console.log("WORKER_MESSAGE", JSON.stringify(message).slice(0, 300));
    if (message.type === "output") output += message.chunk;
    if (message.type === "runAccepted") accepted = message;
    if (message.type === "error") serverError = message.message;
  });
  // First-run example workspace: tab "example-development", Fixer slot (Claude, writable, so the real acceptEdits command is built).
  agentSocket.send(JSON.stringify({ type: "run", tabId: "example-development", slot: "fixer", prompt: "Harmless process-lifecycle proof only." }));
  const worker = await until(() => {
    const match = output.match(/CC_PROOF_WORKER (\{[^\n]+\})/);
    return match && JSON.parse(match[1]);
  }, "real run worker PID");
  assert.ok(accepted?.runId, "the server must answer runAccepted with a runId");
  const before = processes();
  assert.ok(isThisRunsWorker(before, worker, join(dir, "worker.cjs"), desktop.pid), `the reported worker pid ${worker.pid} is not a process running this run's worker.cjs under this run's Electron`);
  track(worker.pid, "node.exe", before);
  track(worker.ppid, "cmd.exe", before);
  const command = before.find((item) => item.ProcessId === worker.ppid);
  assert.equal(command.Name.toLowerCase(), "cmd.exe");
  const server = before.find((item) => item.ProcessId === command.ParentProcessId);
  assert.equal(server.Name.toLowerCase(), "node.exe");
  assert.equal(server.ParentProcessId, desktop.pid);
  track(server.ProcessId, "node.exe", before);
  adoptDescendants(before);
  console.log("BEFORE", JSON.stringify(before.filter(isTracked)));
  if (forceParent) {
    const killed = spawnSync(join(system32, "taskkill.exe"), ["/pid", String(desktop.pid), "/F"], { encoding: "utf8", windowsHide: true });
    assert.equal(killed.status, 0, killed.stderr);
    console.log("FORCE_PARENT_ONLY", killed.stdout.trim());
  } else {
    // This closes the actual native window and exercises closed/window-all-closed/before-quit. A close asks the page first, and with a
    // worker running the page holds and shows its warning, so the page's own "Close anyway" answer is given once it has had time to hold.
    await cdp("Runtime.evaluate", { expression: "setTimeout(() => window.close(), 100); setTimeout(() => window.cc.answerClose('close'), 800)" });
    if (forceBackstop) {
      await delay(1500);
      assert.equal(alive(worker.pid), true, "worker must still be running when IPC is ignored");
    } else {
      await until(() => !alive(worker.pid), "graceful worker cleanup", 4500);
    }
    console.log(forceBackstop ? "BACKSTOP_PENDING_CHECK" : "GRACEFUL_PROCESS_CHECK", JSON.stringify({ workerAlive: alive(worker.pid), serverAlive: alive(server.ProcessId), electronAlive: alive(desktop.pid) }));
    assert.equal(alive(server.ProcessId), true, "IPC keeps the tree root alive for the backstop");
    assert.equal(alive(desktop.pid), true, "quit waits for the backstop");
  }
  await until(() => !alive(desktop.pid) && !alive(worker.pid) && !alive(server.ProcessId), "Electron, server AND worker exit");
  const survivors = processes().filter(isTracked);
  console.log("AFTER Get-CimInstance Win32_Process (tracked tree)", JSON.stringify(survivors));
  console.log("WORKER_PROCESS_CHECK", JSON.stringify({ pid: worker.pid, alive: alive(worker.pid) }));
  if (forceParent) console.log("FORCE_PARENT_PROCESS_CHECK", JSON.stringify({ electronPid: desktop.pid, electronAlive: alive(desktop.pid), serverPid: server.ProcessId, serverAlive: alive(server.ProcessId), workerPid: worker.pid, workerAlive: alive(worker.pid) }));
  assert.deepEqual(survivors, []);

  const port = await freePort();
  browserServer = spawn(process.execPath, [join(dir, "server/index.ts")], {
    cwd: dir, env: { ...env, CC_PORT: String(port) }, windowsHide: true,
  });
  track(browserServer.pid, "node.exe", processes());
  browserServer.stdout.resume();
  browserServer.stderr.resume();
  const browser = await until(async () => {
    try { const response = await fetch(`http://127.0.0.1:${port}`); return response.ok && await response.text(); }
    catch { return null; }
  }, "browser fallback");
  assert.match(browser, /Command Center/);
  console.log("BROWSER_FALLBACK", JSON.stringify({ status: 200, port, ipc: browserServer.connected }));
  browserServer.kill();
  await until(() => !alive(browserServer.pid), "browser server exit");
  const left = processes().filter(isTracked);
  console.log("FINAL_PROCESS_CHECK", JSON.stringify(left));
  assert.deepEqual(left, []);
  console.log("ELECTRON_PROCESS_PROOF_OK");
} catch (error) {
  // Why a window or server never came up is usually in what Electron printed.
  if (desktopOutput) console.error("ELECTRON_OUTPUT (tail)", desktopOutput.slice(-2000));
  throw error;
} finally {
  // Cleanup must never hide the real error above: each step is guarded on its own.
  try {
    // Only processes this run tracked, and only while the live process is the same one (name, creation time, command line); each is ended on its
    // own, never with /T, because a tree below a pid that was handed to another program would end that program's children too.
    const live = processes();
    adoptDescendants(live);
    const mine = live.filter(isTracked);
    console.log("CLEANUP_PROCESS_CHECK", JSON.stringify(mine));
    for (const item of mine) spawnSync(join(system32, "taskkill.exe"), ["/pid", String(item.ProcessId), "/F"], { windowsHide: true, stdio: "ignore" });
  } catch (error) { console.error("cleanup: could not list or end processes:", error.message); }
  try { debuggerSocket?.close(); agentSocket?.close(); } catch { /* already closed */ }
  await delay(1000);
  // Only the mkdtemp child created above is removed, never a computed project path.
  assert.equal(resolve(dir, ".."), resolve(root));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
