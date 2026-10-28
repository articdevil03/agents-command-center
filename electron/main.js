import { app, BrowserWindow, Menu, shell, screen, ipcMain, dialog, session } from "electron";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const READY_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 3_000;
const SMOKE_STOP_TIMEOUT_MS = 30_000;
const BG_COLOR = "#0a0a0c";
const ICON_PATH = join(root, "build", "icon.ico");
const smokeReadyFile = process.env.CC_SMOKE_READY_FILE;
const smokeStopFile = process.env.CC_SMOKE_STOP_FILE;

if (smokeReadyFile) {
  if (!smokeStopFile) throw new Error("CC_SMOKE_STOP_FILE is required with CC_SMOKE_READY_FILE");
  if (process.env.CC_DATA_DIR) app.setPath("userData", process.env.CC_DATA_DIR);
}

// ---- pure, unit-tested logic (see test/electron.test.ts) -------------------

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

export const DEFAULT_WINDOW_BOUNDS = { width: 1400, height: 900 };
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

// `displays` is injected (Electron's screen.getAllDisplays().map(d => d.workArea))
// so this stays a plain function callers can unit-test with fake geometry.
export function sanitizeWindowBounds(bounds, displays) {
  if (!bounds || typeof bounds !== "object") return { ...DEFAULT_WINDOW_BOUNDS };
  const { width, height, x, y } = bounds;
  if (typeof width !== "number" || typeof height !== "number") return { ...DEFAULT_WINDOW_BOUNDS };
  if (width < MIN_WIDTH || height < MIN_HEIGHT || width > 10000 || height > 10000) return { ...DEFAULT_WINDOW_BOUNDS };
  if (typeof x !== "number" || typeof y !== "number") return { width, height };
  // Leave a draggable strip, excluding the system menu and caption buttons.
  const onScreen = displays.some((d) => Math.min(x + width - 160, d.x + d.width) - Math.max(x + 40, d.x) >= 100 && y >= d.y && y + 32 <= d.y + d.height);
  return onScreen ? { width, height, x, y } : { ...DEFAULT_WINDOW_BOUNDS };
}

// A window that was maximized when it closed comes back maximized: `maximized` is only present (true) when it was.
export function readWindowBounds(readFileFn, path, displays) {
  try {
    const saved = JSON.parse(readFileFn(path, "utf8"));
    return { ...sanitizeWindowBounds(saved, displays), ...(saved?.maximized === true ? { maximized: true } : {}) };
  } catch {
    return { ...DEFAULT_WINDOW_BOUNDS };
  }
}

export function writeWindowBounds(writeFileFn, path, bounds) {
  try {
    writeFileFn(path, JSON.stringify({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, ...(bounds.maximized === true ? { maximized: true } : {}) }));
  } catch {
    // best-effort: losing the saved window position is not worth crashing over
  }
}

// `serverOrigin` is this run's own server (a fresh ephemeral port each
// launch), so only an exact match stays in-window; every other URL, local or
// remote, is treated as external.
export function classifyNavigation(url, serverOrigin) {
  return typeof url === "string" && (url === serverOrigin || url.startsWith(`${serverOrigin}/`)) ? "in-window" : "external";
}

// Only the "open" action: obsidian:// also has new, daily-note and other actions that write into a vault.
export function isAllowedObsidianUrl(value) {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "obsidian:" && url.hostname === "open"; }
  catch { return false; }
}

// What may be handed to the operating system's shell. file:, javascript:, custom app schemes and anything unparseable never are.
export function isSafeExternalUrl(value) {
  if (typeof value !== "string") return false;
  try { return ["http:", "https:", "mailto:"].includes(new URL(value).protocol); }
  catch { return false; }
}

// ---- server lifecycle -------------------------------------------------

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

let serverProcess = null;
// This run's secret: made fresh for every server start, handed to the server in its env and to the app page through the
// "cc:app-key" IPC (the page then sends it on its WebSocket and every POST). Never in a URL, a log or a file.
let appKey = null;
let serverStopping = false;
let serverStopPromise = null;

// ponytail: a probe-then-release free-port check has a tiny theoretical race
// (another process grabs the port between our close() and the child's
// listen()). Accepted for a local single-user desktop tool; the alternative
// (threading an OS-assigned port back through server/security.ts's
// module-load-time allow-list) is a materially bigger, riskier diff for a
// race that has never been observed on loopback.
async function startServer(onFailure = () => {}) {
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

function stopServer() {
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

// ---- window ---------------------------------------------------------------

const boundsPath = join(app.getPath("userData"), "window-bounds.json");
let mainWindow = null; // the only window whose page may call the IPC handlers below

// The window has no native title bar or buttons: the loading and error pages are dragged by their body and end in the same minimize,
// maximize/restore and close buttons as the app's top bar (its dark look), wired to the same cc:window-* handlers below.
export function shellPage(content) {
  return `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
html{height:100%}body{margin:0;box-sizing:border-box;min-height:100%;padding:2rem;background:${BG_COLOR};color:#f0f0f0;font-family:system-ui,sans-serif;-webkit-app-region:drag}
.winbtns{position:fixed;top:11px;right:14px;display:flex;gap:6px;-webkit-app-region:no-drag}
.winbtns button{width:36px;height:36px;padding:0;border:0;border-radius:10px;display:grid;place-items:center;background:#19191c;box-shadow:0 1px 2px 0 #00000066,0 0 0 1px #ffffff12;color:#b4b4ba;cursor:pointer}
.winbtns button:hover{background:#222226;color:#ededef}#winClose:hover{background:#e5484d;box-shadow:none;color:#fff}
.winbtns button:focus-visible{outline:2px solid #6aa8ff;outline-offset:2px}
#winMax[data-maximized="true"] .wmax,#winMax:not([data-maximized="true"]) .wrestore{display:none}
</style><body>${content}<div class="winbtns">
<button id="winMin" type="button" aria-label="Minimize" title="Minimize" onclick="cc.minimizeWindow()"><svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M4.5 9h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
<button id="winMax" type="button" aria-label="Maximize" title="Maximize" data-maximized="false" onclick="cc.toggleMaximizeWindow()"><svg class="wmax" width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="4.5" y="4.5" width="9" height="9" rx="2" stroke="currentColor" stroke-width="1.5"/></svg><svg class="wrestore" width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="3.75" y="6.25" width="8" height="8" rx="1.8" stroke="currentColor" stroke-width="1.5"/><path d="M6.25 3.75h6.2a1.8 1.8 0 0 1 1.8 1.8v6.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
<button id="winClose" type="button" aria-label="Close" title="Close" onclick="cc.closeWindow()"><svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="m5 5 8 8M13 5l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
</div><script>
const max = document.getElementById("winMax");
const show = (maximized) => { const label = maximized === true ? "Restore" : "Maximize"; max.dataset.maximized = String(maximized === true); max.setAttribute("aria-label", label); max.title = label; };
if (window.cc) { cc.onWindowMaximized(show); cc.isWindowMaximized().then(show); }
</script></body>`)}`;
}

function errorPage(reason) {
  const escaped = reason.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return shellPage(`<h2>Command Center server unavailable</h2><pre style="white-space:pre-wrap">${escaped}</pre>`);
}

// loadURL rejects when a newer load supersedes it (ERR_ABORTED), which is expected; any other failed load is logged, never an unhandled rejection.
// onFail (the app page only): a page that cannot load must not leave the loading page up for ever.
function loadPage(win, url, onFail) {
  Promise.resolve(win.loadURL(url)).catch((error) => {
    if (error?.code === "ERR_ABORTED") return;
    console.error("page load failed:", error?.message ?? error);
    if (onFail) onFail(error);
  });
}

function createWindow() {
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const { maximized: wasMaximized, ...bounds } = readWindowBounds(readFileSync, boundsPath, displays);
  const win = mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: BG_COLOR,
    // From source (npm run app) Electron's own icon would show on the taskbar: use the app's. The packaged app does not pack build/ (the exe already carries it), so it is only set when the file is there.
    ...(existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
    // No title strip and no native buttons: the page's own top bar (#top) drags the window and ends in
    // its own minimize, maximize/restore and close buttons (cc:window-* below). The edges still resize.
    titleBarStyle: "hidden",
    webPreferences: { preload: join(root, "electron", "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  // The menu stays set for its keyboard shortcuts, but no strip ever shows (not even on Alt).
  win.setMenuBarVisibility(false);
  if (wasMaximized) win.maximize();
  // The page's maximize button shows "restore" while the window is maximized.
  win.on("maximize", () => win.webContents.send("cc:window-maximized", true));
  win.on("unmaximize", () => win.webContents.send("cc:window-maximized", false));

  const saveBounds = () => {
    try {
      mkdirSync(dirname(boundsPath), { recursive: true });
    } catch {
      // best-effort
    }
    // A maximized window's own bounds are its screen edges (a negative origin the next launch would reject): keep the restored size and remember the flag.
    const maximized = win.isMaximized();
    writeWindowBounds(writeFileSync, boundsPath, { ...(maximized ? win.getNormalBounds() : win.getBounds()), maximized });
  };
  win.on("close", (event) => {
    if (closeNeedsAsking(win)) { event.preventDefault(); askBeforeClose(win); return; }
    saveBounds();
  });
  // A Windows sign-out or shutdown is never held up by the warning.
  win.on("session-end", () => { sessionEnding = true; });

  // The window has no native buttons, so a crashed page would leave it blank with nothing to click: reload it, and if it keeps
  // crashing show the error page (which has the window buttons). A page that stops answering offers Wait or Reload.
  let crashTimes = [], hangAsked = false, reloadingAfterCrash = false;
  win.webContents.on("render-process-gone", (_event, details) => {
    if (win.isDestroyed() || details?.reason === "clean-exit") return;
    const now = Date.now();
    crashTimes = [...crashTimes.filter((at) => now - at < 60_000), now];
    if (appOrigin === null || crashTimes.length > 2) loadPage(win, errorPage(`The window's page stopped (${details?.reason ?? "unknown reason"}). Close and reopen Command Center.`));
    else { reloadingAfterCrash = true; win.webContents.reload(); }
  });
  // A reload gives no promise to catch: a failed main-frame load after a crash shows the error page, once. ERR_ABORTED (-3) is a newer page
  // taking over (the server-exit or load-failure page), which already shows its own.
  win.webContents.on("did-finish-load", () => { reloadingAfterCrash = false; });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!reloadingAfterCrash || isMainFrame === false || errorCode === -3 || win.isDestroyed()) return;
    reloadingAfterCrash = false;
    loadPage(win, errorPage(`The window's page could not be reloaded after it stopped (${errorDescription ?? errorCode}). Close and reopen Command Center.`));
  });
  win.webContents.on("unresponsive", () => {
    if (hangAsked || win.isDestroyed()) return;
    hangAsked = true;
    Promise.resolve(dialog.showMessageBox(win, { type: "warning", message: "Command Center is not responding", detail: "Its page has stopped answering. Wait for it, or reload the page. Your work in the tabs is not lost.", buttons: ["Wait", "Reload the page"], defaultId: 0, cancelId: 0, noLink: true }))
      .then((choice) => { if (choice?.response === 1 && !win.isDestroyed()) win.webContents.reload(); })
      .catch(() => {})
      .finally(() => { hangAsked = false; });
  });

  return win;
}

// ---- closing while a tab is working -----------------------------------------
// Every way of closing (the page's Close, Alt+F4, the taskbar, File > Quit) asks the app page first. It answers "close" (nothing is
// working, or Close anyway), "hold" (its warning is showing) or "keep" (Keep open). A page that does not answer within CLOSE_ASK_MS
// (frozen, crashed, still loading) never traps the user: the window closes as it always did. The loading and error pages close at once.
export const CLOSE_ASK_MS = 2_000;
let appOrigin = null; // this run's server page, once the window was sent there
let closeApproved = false;
let sessionEnding = false;
let closeAsk = null; // { timer } from the ask until the page answers "close" or "keep"

function closeNeedsAsking(win) {
  return !closeApproved && !sessionEnding && appOrigin !== null && !win.isDestroyed() && classifyNavigation(win.webContents.getURL(), appOrigin) === "in-window";
}
function askBeforeClose(win) {
  if (closeAsk) clearTimeout(closeAsk.timer);
  closeAsk = { timer: setTimeout(() => closeNow(win), CLOSE_ASK_MS) };
  win.webContents.send("cc:close-requested");
}
// close(), never destroy(): the window's "close" handler saves its bounds, then "closed" and window-all-closed stop the server.
function closeNow(win) {
  if (closeAsk) clearTimeout(closeAsk.timer);
  closeAsk = null;
  closeApproved = true;
  if (!win.isDestroyed()) win.close();
}

// will-navigate and will-redirect also fire for sub-frames; the event's `isMainFrame` flag (see node_modules/electron/electron.d.ts,
// WebContentsWillNavigateEventParams) lets onNavigate police only the MAIN frame and leave a sub-frame alone. The app page has no
// sub-frames today. setWindowOpenHandler cannot tell which frame asked, so every window.open / target=_blank goes through
// handleExternal and is denied: only a web or mail link is passed on to the shell.
function wireNavigationPolicy(win, serverOrigin) {
  // The main window never leaves the app's own page: anything else (a dropped file, a link, a redirect) is cancelled, and only a
  // web or mail link is passed on to the shell.
  const handleExternal = (url) => {
    if (classifyNavigation(url, serverOrigin) === "external") {
      if (isSafeExternalUrl(url)) Promise.resolve(shell.openExternal(url)).catch(() => {});
      return true;
    }
    return false;
  };
  const onNavigate = (event, url) => {
    if (!event.isMainFrame) return;
    if (handleExternal(url)) event.preventDefault();
  };
  win.webContents.on("will-navigate", onNavigate);
  win.webContents.on("will-redirect", onNavigate);
  win.webContents.setWindowOpenHandler(({ url }) => {
    handleExternal(url);
    return { action: "deny" };
  });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { label: "File", submenu: [{ role: "quit" }] },
    ])
  );
}

// Notifications (the desktop notice) and the clipboard copy button are the only things the app page uses; everything else is denied,
// for any other page too.
const ALLOWED_PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write"]);
function lockPermissions() {
  const allowed = (permission, url) => appOrigin !== null && ALLOWED_PERMISSIONS.has(permission) && classifyNavigation(url, appOrigin) === "in-window";
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, details?.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowed(permission, requestingOrigin));
}

function registerFolderPicker() {
  // Every handler answers the main window's page only; a call from any other sender gets nothing and does nothing.
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => (
    mainWindow !== null && !mainWindow.isDestroyed() && event?.sender === mainWindow.webContents ? fn(event, ...args) : undefined
  ));
  // The key goes only to the page showing this run's own server, never to the loading page, the error page or anything else.
  handle("cc:app-key", (event) => (appKey !== null && appOrigin !== null && classifyNavigation(event.senderFrame?.url, appOrigin) === "in-window" ? appKey : null));
  handle("cc:pick-folder", async () => {
    // Parented to the window, so the picker is modal and cannot open behind the app.
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths?.[0] ?? null;
  });
  handle("cc:open-obsidian", async (_event, url) => {
    if (!isAllowedObsidianUrl(url)) return { ok: false, message: "Only obsidian links are allowed" };
    await shell.openExternal(url);
    return { ok: true };
  });
  // The page's own window buttons. Each acts only on the window that sent it.
  const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);
  handle("cc:window-minimize", (event) => { senderWindow(event)?.minimize(); });
  handle("cc:window-toggle-maximize", (event) => {
    const win = senderWindow(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  // close(), never destroy(): the window's "close" handler saves its bounds, then "closed" and window-all-closed stop the server.
  handle("cc:window-close", (event) => { senderWindow(event)?.close(); });
  handle("cc:window-is-maximized", (event) => senderWindow(event)?.isMaximized() === true);
  // The page's answer to a close it was asked about; nothing happens without a close waiting on it.
  handle("cc:close-answer", (event, answer) => {
    const win = senderWindow(event);
    if (!win || !closeAsk) return;
    if (answer === "close") closeNow(win);
    else if (answer === "keep") { clearTimeout(closeAsk.timer); closeAsk = null; }
    else if (answer === "hold") {
      clearTimeout(closeAsk.timer);
      // The warning must be seen: a close from the taskbar can come while the window is minimized.
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function waitForSmokeStop() {
  let stopped = false;
  let poll;
  const timeout = setTimeout(() => finish(), SMOKE_STOP_TIMEOUT_MS);
  const finish = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    clearTimeout(timeout);
    app.quit();
  };
  poll = setInterval(() => {
    if (existsSync(smokeStopFile)) finish();
  }, 25);
}

// ---- single instance --------------------------------------------------

// A second launch must never spawn its own server: it would fight the first
// instance over the shared data root (the workspaces, settings and requests
// files and the chat transcripts). Requested before
// anything else runs, so a refused instance creates no window and starts no
// server, even briefly, and just quits.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  // A launch that arrives while this instance is still shutting down loses the lock and quits, so this instance starts the app again once it is gone.
  let relaunchAfterQuit = false;
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { if (serverStopping) relaunchAfterQuit = true; return; }
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    registerFolderPicker();
    lockPermissions();
    if (!smokeReadyFile) buildMenu();
    const win = smokeReadyFile ? null : createWindow();
    if (win) {
      loadPage(win, shellPage(""));
      win.on("closed", stopServer);
    }

    const result = await startServer((reason) => {
      if (smokeReadyFile) app.quit();
      else if (!win.isDestroyed()) loadPage(win, errorPage(reason));
    });
    if (!smokeReadyFile) {
      if (win.isDestroyed()) return;
    }
    if (result.ok) {
      if (smokeReadyFile) {
        writeFileSync(smokeReadyFile, `${JSON.stringify({ port: result.port, serverPid: serverProcess.pid })}\n`, { flag: "wx" });
        waitForSmokeStop();
      } else {
        wireNavigationPolicy(win, result.origin);
        appOrigin = result.origin;
        // A newer page (the server-failure page) supersedes this load with ERR_ABORTED, so one failure shows one error page.
        loadPage(win, result.origin, (error) => { if (!win.isDestroyed()) loadPage(win, errorPage(`The app page could not be loaded: ${error?.message ?? error}`)); });
      }
    } else {
      if (win) loadPage(win, errorPage(result.reason));
      else app.quit();
    }
  }).catch(async (error) => {
    console.error("Application startup failed:", error);
    await stopServer();
    app.quit();
  });

  app.on("window-all-closed", () => {
    stopServer();
    app.quit();
  });
  let quitReady = false;
  app.on("before-quit", (event) => {
    if (quitReady) return;
    event.preventDefault();
    // File > Quit asks the page like a close does; its "close" closes the window, and window-all-closed comes back here to quit.
    const win = BrowserWindow.getAllWindows()[0];
    if (win && closeNeedsAsking(win)) { askBeforeClose(win); return; }
    stopServer().then(() => {
      quitReady = true;
      // A portable build runs from a temp folder that goes away with it: PORTABLE_EXECUTABLE_FILE (set by electron-builder) is the exe to start again.
      if (relaunchAfterQuit) app.relaunch(process.env.PORTABLE_EXECUTABLE_FILE ? { execPath: process.env.PORTABLE_EXECUTABLE_FILE } : undefined);
      app.quit();
    });
  });
}
