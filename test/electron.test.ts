import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runPackagedSmoke } from "../scripts/packaged-smoke.mjs";

const source = readFileSync("electron/main.js", "utf8").replaceAll("\r\n", "\n");
// Execute the real pure functions only. No Electron app, window, or process spawn.
function body(name) {
  const match = source.match(new RegExp(`(?:export )?function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, `${name} must exist`);
  return match[0].replace("export function", "function");
}
// vm.runInNewContext objects come from a different realm, so assert/strict's
// deepEqual (which is deepStrictEqual) rejects them as "not reference-equal"
// despite identical structure; round-tripping through JSON brings them home.
const plain = (value) => JSON.parse(JSON.stringify(value));
// A wait on a promise the code under test should settle, bounded so a change that stops it settling fails with this message instead of
// hanging until the runner's own timeout (the harness fakes only the timers inside main.js, so this one is real).
async function within(promise, label, ms = 3000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

const { parseServerPort, sanitizeWindowBounds, readWindowBounds, writeWindowBounds, classifyNavigation, isAllowedObsidianUrl, isSafeExternalUrl, buildServerCommandArgs } = runInNewContext(
  `${source.match(/(?:export )?const (?:DEFAULT_WINDOW_BOUNDS|MIN_WIDTH|MIN_HEIGHT) = .*;/g).join("\n").replaceAll("export ", "")}
  ${["parseServerPort", "sanitizeWindowBounds", "readWindowBounds", "writeWindowBounds", "classifyNavigation", "isAllowedObsidianUrl", "isSafeExternalUrl", "buildServerCommandArgs"].map(body).join("\n")}
  ;({ parseServerPort, sanitizeWindowBounds, readWindowBounds, writeWindowBounds, classifyNavigation, isAllowedObsidianUrl, isSafeExternalUrl, buildServerCommandArgs });`,
  { pathToFileURL, URL }
);

test("parseServerPort reads the real ready line, rejects garbage, and survives a chunk split", () => {
  assert.equal(parseServerPort("Command Center running at http://127.0.0.1:51234\n"), 51234);
  assert.equal(parseServerPort("Claude CLI not found; leader will run without --effort\n"), null);
  assert.equal(parseServerPort(""), null);
  assert.equal(parseServerPort("unrelated http://127.0.0.1:51234\n"), null);
  assert.equal(parseServerPort("Command Center running at http://127.0.0.1:5"), null);
  assert.equal(parseServerPort("Command Center running at http://127.0.0.1:51234"), null);
  assert.equal(parseServerPort("Command Center running at http://127.0.0.1:0\n"), null, "port 0 is never a real bound port");
  const chunk1 = "Claude CLI not found\nCommand Center runnin";
  const chunk2 = "g at http://127.0.0.1:60111\n";
  assert.equal(parseServerPort(chunk1), null, "must not match a line split mid-way");
  assert.equal(parseServerPort(chunk1 + chunk2), 60111, "must match once the full line has arrived");
});

test("sanitizeWindowBounds defaults on missing, malformed, too-small, too-large, and off-screen bounds", () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  assert.deepEqual(plain(sanitizeWindowBounds(null, displays)), { width: 1400, height: 900 });
  assert.deepEqual(plain(sanitizeWindowBounds({}, displays)), { width: 1400, height: 900 });
  assert.deepEqual(plain(sanitizeWindowBounds({ width: 100, height: 900 }, displays)), { width: 1400, height: 900 });
  assert.deepEqual(plain(sanitizeWindowBounds({ width: 1400, height: 100 }, displays)), { width: 1400, height: 900 });
  assert.deepEqual(plain(sanitizeWindowBounds({ width: 99999, height: 900 }, displays)), { width: 1400, height: 900 });
  assert.deepEqual(plain(sanitizeWindowBounds({ width: 1400, height: 900, x: 50000, y: 50000 }, displays)), { width: 1400, height: 900 });
  assert.deepEqual(plain(sanitizeWindowBounds({ width: 1400, height: 900, x: 100, y: 100 }, displays)), { width: 1400, height: 900, x: 100, y: 100 });
  assert.deepEqual(plain(sanitizeWindowBounds({ width: 1400, height: 900 }, displays)), { width: 1400, height: 900 });
  for (const bounds of [{ width: 899, height: 900 }, { width: 1400, height: 599 },
    { width: 1400, height: 900, x: 0, y: -899 },
    { width: 1400, height: 900, x: 1919, y: 0 },
    { width: 1400, height: 900, x: 1781, y: 0 },
    { width: 1400, height: 900, x: -1300, y: 0 },
    { width: 1400, height: 900, x: 0, y: 1060 }]) {
    assert.deepEqual(plain(sanitizeWindowBounds(bounds, displays)), { width: 1400, height: 900 });
  }
});

test("readWindowBounds falls back to defaults when the file is missing, corrupt, or throws", () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  const throwing = () => { throw new Error("ENOENT"); };
  assert.deepEqual(plain(readWindowBounds(throwing, "x", displays)), { width: 1400, height: 900 });
  assert.deepEqual(plain(readWindowBounds(() => "not json", "x", displays)), { width: 1400, height: 900 });
  assert.deepEqual(plain(readWindowBounds(() => JSON.stringify({ width: 1600, height: 1000 }), "x", displays)), { width: 1600, height: 1000 });
  let suppliedPath;
  readWindowBounds((path) => { suppliedPath = path; return "{}"; }, "saved-bounds.json", displays);
  assert.equal(suppliedPath, "saved-bounds.json");
});

test("writeWindowBounds persists width/height/x/y and swallows a write failure", () => {
  let written = null;
  writeWindowBounds((path, data) => { written = { path, data }; }, "x", { width: 1600, height: 1000, x: 5, y: 5 });
  assert.deepEqual(JSON.parse(written.data), { width: 1600, height: 1000, x: 5, y: 5 });
  assert.equal(written.path, "x");
  assert.doesNotThrow(() => writeWindowBounds(() => { throw new Error("disk full"); }, "x", { width: 1400, height: 900 }));
});

test("classifyNavigation keeps this run's own server in-window and sends everything else out", () => {
  const origin = "http://127.0.0.1:51234";
  assert.equal(classifyNavigation(origin, origin), "in-window");
  assert.equal(classifyNavigation(`${origin}/some/path`, origin), "in-window");
  assert.equal(classifyNavigation("https://example.com", origin), "external");
  assert.equal(classifyNavigation("http://127.0.0.1:9999", origin), "external", "a different instance's port is not this run's server");
  assert.equal(classifyNavigation(`${origin}.evil.com`, origin), "external", "must not match on a mere prefix of the origin");
  for (const value of [null, undefined, 42, {}]) assert.equal(classifyNavigation(value, origin), "external");
});

test("Obsidian IPC accepts only the obsidian scheme", () => {
  assert.equal(isAllowedObsidianUrl("obsidian://open?path=C%3A%5Cnotes"), true);
  for (const value of ["https://example.com", "file:///tmp/notes", "javascript:alert(1)", "not a URL", null]) assert.equal(isAllowedObsidianUrl(value), false, String(value));
});

// Execute the production wiring with event/IO dependencies, no DOM or Electron runner.
let keyCount = 0;
function shellHarness(savedBounds = {}, { lockAcquired = true, smokeReadyFile, smokeStopFile, smokeDataDir, inheritedDiscoverySkip = false } = {}) {
  const timers = new Map();
  const intervals = new Map();
  const files = new Map();
  const userDataPaths = [];
  let userDataPath = "test-data";
  const order = [];
  const app = Object.assign(new EventEmitter(), {
    getPath: () => userDataPath,
    setPath: (key, value) => { userDataPaths.push([key, value]); if (key === "userData") userDataPath = value; },
    whenReady: () => ({ then: (fn) => { ready = fn; return { catch: (fn) => { startupFailure = fn; } }; } }),
    quit: () => { quits++; },
    requestSingleInstanceLock: () => { order.push("lock"); return lockAcquired; },
    relaunch: (options) => { relaunches.push(options); },
  });
  const relaunches = [];
  let windowGone = false;
  let ready;
  let startupFailure;
  let quits = 0;
  let minimized = false;
  const sent = [];
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), connected: true, exitCode: null, pid: 1234,
    send: (message, callback) => { sent.push(message); callback(); },
    kill: () => assert.fail("Windows signals must not replace IPC shutdown"),
  });
  const killer = new EventEmitter();
  const spawns = [];
  const external = [];
  const loaded = [];
  const windowOptions = [];
  const ipcHandlers = new Map();
  const permissionHandlers = {};
  // keyCount is module-level so separate harnesses (separate server starts) get different keys
  const dialogCalls = [], parents = [], messageBoxes = [];
  let messageChoice = 0;
  let folderDialogResult = { canceled: false, filePaths: ["C:/Chosen"] };
  const env = { CC_TEST_FORCE_PACKAGED: "1", NODE_TEST_CONTEXT: "child-v8" };
  if (inheritedDiscoverySkip) env.CC_SKIP_DISCOVERY = "1";
  if (smokeReadyFile) Object.assign(env, {
    CC_SMOKE_READY_FILE: smokeReadyFile,
    CC_SMOKE_STOP_FILE: smokeStopFile,
    CC_DATA_DIR: smokeDataDir,
    CC_SKIP_DISCOVERY: "1",
  });
  const menus = [];
  const toPage = [];
  let maximized = false;
  // close() fires "close", then "closed" unless a "close" listener prevented it, like Electron's; destroy() skips "close".
  const win = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { setWindowOpenHandler: (fn) => { popup = fn; }, send: (channel, ...args) => toPage.push([channel, ...args]), getURL: () => loaded.at(-1) ?? "", reload: () => order.push("reload") }),
    loadURL: (url) => { loaded.push(url); }, isDestroyed: () => false,
    isMinimized: () => minimized, restore: () => order.push("restore"), focus: () => order.push("focus"),
    setMenuBarVisibility: (visible) => order.push(`menuBar:${visible}`),
    minimize: () => order.push("minimize"), isMaximized: () => maximized,
    maximize: () => { order.push("maximize"); maximized = true; win.emit("maximize"); },
    unmaximize: () => { order.push("unmaximize"); maximized = false; win.emit("unmaximize"); },
    getBounds: () => ({ width: 1500, height: 950, x: 30, y: 20 }),
    // a maximized window's own bounds are its screen edges; its restored size is the normal bounds
    getNormalBounds: () => ({ width: 1200, height: 800, x: 100, y: 60 }),
    close: () => { order.push("close"); let held = false; win.emit("close", { preventDefault() { held = true; } }); if (held) order.push("close-held"); else win.emit("closed"); },
    destroy: () => { order.push("destroy"); win.emit("closed"); },
  });
  let popup;
  win.on("closed", () => { windowGone = true; });
  function BrowserWindowMock(options) { order.push("window"); windowOptions.push(plain(options)); return win; }
  BrowserWindowMock.getAllWindows = () => (windowOptions.length && !windowGone ? [win] : []);
  BrowserWindowMock.fromWebContents = (sender) => (sender === win.webContents ? win : null);
  const api = runInNewContext(source.replace(/^import .*;$/gm, "")
    .replace(/const root = .*;/, 'const root = "test-root";').replaceAll("export ", "") +
    ";({ startServer, stopServer, MIN_WIDTH, MIN_HEIGHT, wireNavigationPolicy, getProcess: () => serverProcess })", {
    app, console: { error() {} }, BrowserWindow: BrowserWindowMock,
    Menu: { setApplicationMenu: (menu) => menus.push(menu), buildFromTemplate: (template) => template },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] }, shell: { openExternal: (url) => external.push(url) },
    ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
    session: { defaultSession: { setPermissionRequestHandler: (fn) => { permissionHandlers.request = fn; }, setPermissionCheckHandler: (fn) => { permissionHandlers.check = fn; } } },
    randomBytes: (size) => ({ toString: (encoding) => (assert.equal(size, 32) ?? assert.equal(encoding, "hex") ?? String(++keyCount).padStart(2, "0").repeat(32)) }),
    dialog: {
      showOpenDialog: async (parent, options) => { dialogCalls.push(options); parents.push(parent); return folderDialogResult; },
      showMessageBox: async (parent, options) => { messageBoxes.push({ parent, options }); return { response: messageChoice }; },
    },
    pathToFileURL, URL,
    join: (...parts) => parts.join("/"), readFileSync: () => JSON.stringify(savedBounds),
    writeFileSync: (file, data, options) => {
      if (options?.flag === "wx" && files.has(file)) throw Object.assign(new Error(`EEXIST: file already exists, open '${file}'`), { code: "EEXIST" });
      files.set(file, data);
    }, existsSync: (file) => files.has(file),
    process: { env },
    spawn: (...args) => { order.push(`spawn:${args[0]}`); spawns.push(args); return String(args[0]).endsWith("taskkill.exe") ? killer : proc; },
    createServer: () => Object.assign(new EventEmitter(), {
      listen: (_port, _host, cb) => cb(), address: () => ({ port: 51234 }), close: (cb) => cb(),
    }),
    setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => { const id = {}; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
  });
  return { ...api, app, proc, killer, spawns, sent, timers, intervals, files, userDataPaths, external, win, loaded, windowOptions, order, ipcHandlers, permissionHandlers, dialogCalls, parents, messageBoxes, relaunches, env, menus, toPage,
    ready: () => ready().catch(startupFailure), quits: () => quits, popup: (url) => popup({ url }),
    setMinimized: (value) => { minimized = value; }, setMaximized: (value) => { maximized = value; }, setMessageChoice: (value) => { messageChoice = value; }, setFolderDialogResult: (value) => { folderDialogResult = value; } };
}

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

test("folder picker IPC opens a directory-only dialog and returns its selected path", async () => {
  const h = shellHarness();
  const ready = h.ready();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  const handler = h.ipcHandlers.get("cc:pick-folder");
  assert.equal(typeof handler, "function", "the preload channel must be registered");
  const fromPage = { sender: h.win.webContents };
  assert.equal(await handler(fromPage), "C:/Chosen");
  assert.deepEqual(plain(h.dialogCalls), [{ properties: ["openDirectory"] }]);
  h.setFolderDialogResult({ canceled: true, filePaths: [] });
  assert.equal(await handler(fromPage), null, "cancel returns no path");
  const openObsidian = h.ipcHandlers.get("cc:open-obsidian");
  assert.equal(typeof openObsidian, "function", "the Obsidian channel must be registered");
  assert.deepEqual(plain(await openObsidian(fromPage, "obsidian://open?path=C%3A%5Cnotes")), { ok: true });
  assert.deepEqual(h.external, ["obsidian://open?path=C%3A%5Cnotes"]);
  assert.deepEqual(plain(await openObsidian(fromPage, "https://attacker.example")), { ok: false, message: "Only obsidian links are allowed" });
  assert.deepEqual(h.external, ["obsidian://open?path=C%3A%5Cnotes"], "refused schemes never reach shell.openExternal");
  const options = h.windowOptions[0].webPreferences;
  assert.equal(options.preload, "test-root/electron/preload.cjs");
  assert.equal(options.nodeIntegration, false);
  assert.equal(options.contextIsolation, true);
  assert.equal(options.sandbox, true);
});

test("preload exposes the folder picker, Obsidian-only opener and the window buttons through invoke, and hands the page only true/false", async () => {
  const calls = [];
  const listeners = new Map();
  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api }; } },
    ipcRenderer: {
      invoke: (...args) => { calls.push(args); return Promise.resolve(args[0] === "cc:pick-folder" ? "C:/Picked" : { ok: true }); },
      on: (channel, listener) => listeners.set(channel, listener),
    },
  };
  runInNewContext(readFileSync("electron/preload.cjs", "utf8"), { require: (name) => { assert.equal(name, "electron"); return electron; } });
  assert.equal(exposed.name, "cc");
  assert.deepEqual(Object.keys(exposed.api), ["appKey", "pickFolder", "openObsidian", "minimizeWindow", "toggleMaximizeWindow", "closeWindow", "isWindowMaximized", "onWindowMaximized", "onCloseRequested", "answerClose"]);
  assert.equal(await exposed.api.pickFolder(), "C:/Picked");
  assert.deepEqual(await exposed.api.openObsidian("obsidian://open?path=C%3A%5Cnotes"), { ok: true });
  assert.deepEqual(await exposed.api.appKey(), { ok: true }); await exposed.api.minimizeWindow(); await exposed.api.toggleMaximizeWindow(); await exposed.api.closeWindow(); await exposed.api.isWindowMaximized(); await exposed.api.answerClose("hold");
  assert.deepEqual(calls, [["cc:pick-folder"], ["cc:open-obsidian", "obsidian://open?path=C%3A%5Cnotes"], ["cc:app-key"], ["cc:window-minimize"], ["cc:window-toggle-maximize"], ["cc:window-close"], ["cc:window-is-maximized"], ["cc:close-answer", "hold"]]);
  const seen = [];
  exposed.api.onWindowMaximized((...args) => seen.push(args));
  const asked = [];
  exposed.api.onCloseRequested((...args) => asked.push(args));
  assert.deepEqual([...listeners.keys()], ["cc:window-maximized", "cc:close-requested"], "the page listens on the maximized-state and close-request channels");
  const ipcEvent = { sender: "the IPC event" };
  for (const value of [true, false, "yes", 1]) listeners.get("cc:window-maximized")(ipcEvent, value);
  assert.deepEqual(seen, [[true], [false], [false], [false]], "the page gets exactly one true/false per change, never the IPC event");
  listeners.get("cc:close-requested")(ipcEvent, "anything");
  assert.deepEqual(asked, [[]], "a close request reaches the page once, carrying nothing (never the IPC event)");
});

test("the window has no title strip, no native buttons and no menu row: every menu shortcut kept, and the page's own buttons drive the window", async () => {
  const h = shellHarness();
  const ready = h.ready();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  const options = h.windowOptions[0];
  assert.equal(options.titleBarStyle, "hidden");
  assert.equal("titleBarOverlay" in options, false, "no native minimize/maximize/close overlay: " + JSON.stringify(options.titleBarOverlay));
  assert.deepEqual(h.order.filter((entry) => entry.startsWith("menuBar:")), ["menuBar:false"], "the menu row is hidden, so Alt cannot reveal it");
  const roles = plain(h.menus.at(-1)).flatMap((item) => item.submenu).map((item) => item.role).filter(Boolean);
  assert.deepEqual(roles, ["reload", "forceReload", "toggleDevTools", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen", "quit"], "every shortcut stays in the hidden menu");
  const handler = (channel) => { const fn = h.ipcHandlers.get(channel); assert.equal(typeof fn, "function", `${channel} must be registered`); return fn; };
  const fromPage = { sender: h.win.webContents }, stranger = { sender: {} };
  const windowCalls = () => h.order.filter((entry) => ["minimize", "maximize", "unmaximize", "close", "destroy"].includes(entry));
  // A sender with no window of its own changes nothing.
  for (const channel of ["cc:window-minimize", "cc:window-toggle-maximize", "cc:window-close"]) handler(channel)(stranger);
  assert.equal(handler("cc:window-is-maximized")(stranger), undefined, "another sender is refused, not answered");
  assert.deepEqual(windowCalls(), [], "no window was touched by a sender without one");
  handler("cc:window-minimize")(fromPage);
  assert.deepEqual(windowCalls(), ["minimize"]);
  assert.equal(handler("cc:window-is-maximized")(fromPage), false);
  handler("cc:window-toggle-maximize")(fromPage);
  assert.equal(handler("cc:window-is-maximized")(fromPage), true);
  handler("cc:window-toggle-maximize")(fromPage);
  assert.equal(handler("cc:window-is-maximized")(fromPage), false);
  assert.deepEqual(windowCalls(), ["minimize", "maximize", "unmaximize"], "the maximize button maximizes, then restores");
  assert.deepEqual(h.toPage, [["cc:window-maximized", true], ["cc:window-maximized", false]], "each maximize and restore tells the page");
  // Close goes through the normal path: the page is asked first (nothing working here, so it answers "close"), then the "close"
  // handler saves the bounds, and "closed" stops the server.
  assert.equal(h.files.has("test-data/window-bounds.json"), false);
  handler("cc:window-close")(fromPage);
  assert.deepEqual(h.toPage.at(-1), ["cc:close-requested"], "the page is asked before the window closes");
  handler("cc:close-answer")(fromPage, "close");
  assert.deepEqual(windowCalls().slice(-2), ["close", "close"], "close(), never destroy(): asked once, then closed");
  assert.deepEqual(JSON.parse(h.files.get("test-data/window-bounds.json") ?? "null"), { width: 1500, height: 950, x: 30, y: 20 }, "the bounds were saved on the way out");
  assert.deepEqual(h.sent, ["shutdown"], "closing the window stops the server");
});

// Closing the app while a tab is still working asks first. The page answers "close" (nothing working, or Close anyway), "hold" (its
// warning is showing) or "keep" (Keep open); only "close", or no answer within 2 s, closes, and always through the normal close path.
async function readyShell() {
  const h = shellHarness();
  const ready = h.ready();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  assert.equal(h.loaded.at(-1), "http://127.0.0.1:51234", "the app page is showing");
  const answer = (value, sender = h.win.webContents) => h.ipcHandlers.get("cc:close-answer")({ sender }, value);
  const asks = () => h.toPage.filter(([channel]) => channel === "cc:close-requested").length;
  const askTimers = () => [...h.timers.values()].filter(({ ms }) => ms === 2000);
  const closed = () => h.sent.includes("shutdown") && h.files.has("test-data/window-bounds.json");
  return { h, answer, asks, askTimers, closed };
}

test("guard-close: closing the app page asks the page first, stays open on hold and Keep open, and closes only on its close answer", async () => {
  const { h, answer, asks, askTimers, closed } = await readyShell();
  h.win.close(); // Alt+F4, the taskbar and our Close all end in the window's close()
  assert.equal(asks(), 1, "the page was asked");
  assert.equal(closed(), false, "the window is held: no bounds saved, the server still running");
  assert.equal(askTimers().length, 1, "the 2 s no-answer timer is running");
  answer("close", {}); answer("close", { sender: {} });
  assert.equal(closed(), false, "an answer from no window, or another window, changes nothing");
  h.setMinimized(true);
  answer("hold");
  assert.equal(askTimers().length, 0, "the warning is showing: the no-answer timer is stopped");
  assert.deepEqual(h.order.slice(-2), ["restore", "focus"], "a minimized window comes back so the warning is seen");
  answer("keep");
  answer("close");
  assert.equal(closed(), false, "Keep open stays open, and a later stray close answer with no close waiting does nothing");
  h.win.close();
  assert.equal(asks(), 2, "the next close asks again");
  answer("hold");
  answer("close"); // Close anyway
  assert.equal(closed(), true, "Close anyway closes through the normal path: bounds saved, the server told to shut down");
  assert.deepEqual(h.order.filter((entry) => entry.startsWith("close")), ["close", "close-held", "close", "close-held", "close"], "close(), never destroy()");
  assert.deepEqual(JSON.parse(h.files.get("test-data/window-bounds.json")), { width: 1500, height: 950, x: 30, y: 20 });
});

test("guard-close: a page that never answers cannot trap the user: 2 s later the window closes through the normal path", async () => {
  const { h, asks, askTimers, closed } = await readyShell();
  h.win.close();
  h.win.close(); // a second close while waiting asks again and restarts the one timer, never a second dialog or a second timer
  assert.equal(asks(), 2);
  assert.equal(askTimers().length, 1, "one no-answer timer");
  assert.equal(closed(), false);
  askTimers()[0].fn();
  assert.equal(closed(), true, "no answer within 2 s: closed, bounds saved, server stopping");
  assert.equal(h.order.filter((entry) => entry === "destroy").length, 0, "close(), never destroy()");
});

test("guard-close: File > Quit asks the page too, and its close answer quits through the normal path", async () => {
  const { h, answer, asks, closed } = await readyShell();
  let prevented = 0;
  h.app.emit("before-quit", { preventDefault: () => prevented++ });
  assert.equal(prevented, 1, "the quit is held");
  assert.equal(asks(), 1, "the page was asked");
  assert.deepEqual(h.sent, [], "the server keeps running while the page decides");
  answer("close");
  assert.equal(closed(), true, "the close answer closes the window: bounds saved, the server told to shut down");
  // window-all-closed then quits again: this time nothing is asked.
  h.app.emit("before-quit", { preventDefault: () => prevented++ });
  assert.equal(asks(), 1, "the quit after the approved close asks nothing");
});

test("guard-close: the loading page, the error page and a Windows sign-out or shutdown close at once, without asking", async () => {
  const loading = shellHarness();
  const loadingReady = loading.ready();
  await Promise.resolve();
  assert.match(loading.loaded.at(-1), /^data:text\/html,/);
  loading.win.close();
  assert.equal(loading.toPage.length, 0, "the loading page is never asked");
  assert.ok(loading.sent.includes("shutdown"), "the loading page closes at once");
  loading.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(loadingReady, "loadingReady");

  const failed = await readyShell();
  failed.h.proc.emit("exit", 7);
  assert.match(decodeURIComponent(failed.h.loaded.at(-1)), /Server stopped \(code 7\)/);
  failed.h.win.close();
  assert.equal(failed.asks(), 0, "the error page is never asked");
  assert.equal(failed.closed(), true, "the error page closes at once");

  const signOut = await readyShell();
  signOut.h.win.emit("session-end", { preventDefault() { assert.fail("a sign-out is never held"); } });
  signOut.h.win.close();
  assert.equal(signOut.asks(), 0, "a Windows sign-out or shutdown is never asked about");
  assert.equal(signOut.closed(), true, "it closes at once");
});

// The loading and error pages have no title bar either: they carry the app's own minimize, maximize/restore and close buttons.
test("the loading and error pages show the window buttons, outside the drag area, and each sends its own call", async () => {
  const h = shellHarness();
  const ready = h.ready();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  h.proc.emit("exit", 7);
  const pages = { loading: decodeURIComponent(h.loaded[0].slice("data:text/html,".length)), error: decodeURIComponent(h.loaded.at(-1).slice("data:text/html,".length)) };
  assert.match(pages.error, /Server stopped \(code 7\)/);
  for (const [name, html] of Object.entries(pages)) {
    assert.match(html, /body\{[^}]*-webkit-app-region:drag/, `${name}: the page drags the window`);
    assert.match(html, /\.winbtns\{[^}]*position:fixed;top:11px;right:14px;[^}]*-webkit-app-region:no-drag/, `${name}: the buttons sit top-right and are not a drag area`);
    const buttons = [...html.matchAll(/<button id="(win\w+)" type="button" aria-label="(\w+)" title="(\w+)"[^>]*onclick="([^"]+)"/g)].map(([, id, label, title, onclick]) => ({ id, label, title, onclick }));
    assert.deepEqual(buttons.map(({ id, label, title }) => [id, label, title]), [["winMin", "Minimize", "Minimize"], ["winMax", "Maximize", "Maximize"], ["winClose", "Close", "Close"]], `${name}: three labelled buttons, in order`);
    const calls = [];
    const cc = { minimizeWindow: () => calls.push("minimize"), toggleMaximizeWindow: () => calls.push("toggleMaximize"), closeWindow: () => calls.push("close") };
    for (const button of buttons) runInNewContext(button.onclick, { cc });
    assert.deepEqual(calls, ["minimize", "toggleMaximize", "close"], `${name}: each button sends its own call`);
    // The maximize button follows the window: Restore while maximized, Maximize after a restore.
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(script, `${name}: the page has its maximize-state script`);
    const max = { dataset: {}, title: "", label: "", setAttribute(key, value) { if (key === "aria-label") this.label = value; } };
    let onChange;
    const bridge = { onWindowMaximized: (callback) => { onChange = callback; }, isWindowMaximized: () => Promise.resolve(true) };
    runInNewContext(script, { document: { getElementById: (id) => (id === "winMax" ? max : null) }, window: { cc: bridge }, cc: bridge });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([max.dataset.maximized, max.label, max.title], ["true", "Restore", "Restore"], `${name}: a maximized window shows Restore`);
    onChange(false);
    assert.deepEqual([max.dataset.maximized, max.label, max.title], ["false", "Maximize", "Maximize"], `${name}: a restored window shows Maximize`);
  }
});

// With no title strip, the loading page and the error page are the only things in the window until the app loads: both must still drag it.
test("the loading page and the server-error page drag the window", async () => {
  const h = shellHarness();
  const ready = h.ready();
  await Promise.resolve();
  const dragging = (url: string) => /-webkit-app-region:drag/.test(decodeURIComponent(url));
  assert.ok(h.loaded.length >= 1 && h.loaded[0].startsWith("data:text/html,"), "a loading page is shown first: " + JSON.stringify(h.loaded));
  assert.ok(dragging(h.loaded[0]), "the loading page drags the window: " + decodeURIComponent(h.loaded[0]));
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  h.proc.emit("exit", 7);
  const errorUrl = h.loaded.at(-1);
  assert.match(decodeURIComponent(errorUrl), /Server stopped \(code 7\)/);
  assert.ok(dragging(errorUrl), "the error page drags the window: " + decodeURIComponent(errorUrl));
});

// Run from source (npm run app) the taskbar button showed Electron's own icon: the window must carry build/icon.ico. The packaged app
// does not pack build/ (package.json build.files), so the option is only set when the file is there and never names a missing path.
test("the window uses build/icon.ico when it exists, and names no icon when the file is missing", async () => {
  for (const present of [true, false]) {
    const h = shellHarness();
    if (present) h.files.set("test-root/build/icon.ico", "");
    const ready = h.ready();
    await Promise.resolve();
    h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
    await within(ready, "ready");
    const options = h.windowOptions[0];
    assert.ok(options, "a window was created");
    if (present) assert.equal(options.icon, "test-root/build/icon.ico", "the window icon is the app's icon file");
    else assert.equal("icon" in options, false, "no icon option when the file is not there: " + JSON.stringify(options.icon));
  }
});

test("build/icon.ico is the file the source icon points at, and the build config keeps using it", () => {
  const source = readFileSync("electron/main.js", "utf8");
  const match = /const ICON_PATH = join\(root, "build", "icon\.ico"\);/.exec(source);
  assert.ok(match, "ICON_PATH must name build/icon.ico");
  assert.ok(existsSync("build/icon.ico"), "build/icon.ico exists");
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).build.win.icon, "build/icon.ico");
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

test("shutdown uses IPC and holds quit until the server is gone: a hung server is tree-killed after the grace", async () => {
  const h = shellHarness();
  const started = h.startServer();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "started");
  assert.deepEqual(plain(h.spawns[0][2].stdio), ["ignore", "pipe", "pipe", "ipc"]);
  assert.equal(h.spawns[0][2].detached, true, "parent death must allow Node to handle IPC disconnect");
  let prevented = 0;
  h.app.emit("before-quit", { preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  assert.equal(h.quits(), 0);
  assert.deepEqual(h.sent, ["shutdown"]);
  const pending = h.stopServer();
  assert.equal(pending, h.stopServer(), "one cleanup promise for repeated close/quit events");
  assert.equal(h.timers.size, 1, "the server has not exited: the backstop waits");
  const [{ fn, ms }] = [...h.timers.values()];
  assert.equal(ms, 3000);
  fn();
  await Promise.resolve();
  assert.equal(h.spawns[1][0], "C:\\Windows/System32/taskkill.exe", "taskkill by its System32 path, never a PATH lookup");
  assert.deepEqual(plain(h.spawns[1][1]), ["/pid", "1234", "/T", "/F"]);
  assert.equal(h.quits(), 0);
  h.killer.emit("close", 0);
  await within(pending, "pending");
  assert.equal(h.quits(), 1);
  h.app.emit("before-quit", { preventDefault: () => prevented++ });
  assert.equal(prevented, 1, "second quit must be allowed through");
});

// Closing then reopening within ~3 s used to open nothing: the old instance always waited the full grace, and the new launch lost the lock and quit.
test("a server that exits on its own finishes the shutdown at once: no 3 s wait, no taskkill of a dead pid", async () => {
  const h = shellHarness();
  const started = h.startServer();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "started");
  h.app.emit("before-quit", { preventDefault() {} });
  assert.deepEqual(h.sent, ["shutdown"]);
  assert.equal(h.timers.size, 1, "the backstop is armed while the server runs");
  h.proc.exitCode = 0;
  h.proc.emit("exit", 0);
  await within(h.stopServer(), "h.stopServer()");
  await Promise.resolve();
  assert.equal(h.timers.size, 0, "the backstop was cleared by the exit");
  assert.equal(h.spawns.filter(([command]) => String(command).endsWith("taskkill.exe")).length, 0, "no taskkill after the server is gone");
  assert.equal(h.quits(), 1, "the quit went through straight away");
  // a server that was already gone before the stop began needs no wait at all
  const gone = shellHarness();
  const goneStarted = gone.startServer();
  await Promise.resolve();
  gone.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(goneStarted, "goneStarted");
  gone.proc.exitCode = 1;
  await within(gone.stopServer(), "gone.stopServer()");
  assert.equal(gone.timers.size, 0);
  assert.equal(gone.spawns.filter(([command]) => String(command).endsWith("taskkill.exe")).length, 0);
});

test("a second launch while the first is shutting down starts the app again once the first is gone, and never when a window was open", async () => {
  const h = shellHarness();
  const ready = h.ready();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  h.win.close(); // nothing is working: the page answers close
  h.ipcHandlers.get("cc:close-answer")({ sender: h.win.webContents }, "close");
  assert.deepEqual(h.sent, ["shutdown"], "the first instance is shutting down and has no window");
  h.app.emit("second-instance"); // the launcher was double-clicked inside the shutdown
  assert.deepEqual(h.relaunches, [], "not yet: the first instance is still quitting");
  h.app.emit("before-quit", { preventDefault() {} });
  h.proc.exitCode = 0; h.proc.emit("exit", 0);
  await within(h.stopServer(), "h.stopServer()");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.relaunches.length, 1, "the app is started again after the first instance is gone");
  assert.equal(h.quits() >= 1, true);
  // with a window open, a second launch only focuses it and never relaunches
  const open = shellHarness();
  const openReady = open.ready();
  await Promise.resolve();
  open.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(openReady, "openReady");
  open.app.emit("second-instance");
  open.app.emit("before-quit", { preventDefault() {} });
  open.proc.exitCode = 0; open.proc.emit("exit", 0);
  await within(open.stopServer(), "open.stopServer()");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(open.relaunches, [], "a launch that found the window open is not repeated");
});

test("a missing Node reports its own clear reason at once, and one error page is shown, not two", async () => {
  const h = shellHarness();
  const ready = h.ready();
  await Promise.resolve();
  const loadsBefore = h.loaded.length;
  h.proc.emit("error", Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }));
  await within(ready, "ready");
  assert.equal([...h.timers.values()].some(({ ms }) => ms === 15_000), false, "the readiness timer was cleared by the error");
  assert.equal(h.loaded.length, loadsBefore + 1, "exactly one error page was loaded");
  const page = decodeURIComponent(h.loaded.at(-1));
  assert.match(page, /spawn node ENOENT/);
  assert.match(page, /Node\.js 24/);
  assert.doesNotMatch(page, /did not report ready/);
  // a server that exits before it is ready also gets exactly one page
  const dead = shellHarness();
  const deadReady = dead.ready();
  await Promise.resolve();
  const before = dead.loaded.length;
  dead.proc.stderr.emit("data", Buffer.from("boom"));
  dead.proc.emit("exit", 3);
  await within(deadReady, "deadReady");
  assert.equal(dead.loaded.length, before + 1, "one page for an exit before ready");
  assert.match(decodeURIComponent(dead.loaded.at(-1)), /exited with code 3 before it was ready[^]*boom/);
});

test("the window comes back maximized, and a maximized close saves the restored size plus the flag", async () => {
  const saved = shellHarness({ width: 1300, height: 800, x: 10, y: 10, maximized: true });
  const savedReady = saved.ready();
  assert.equal(saved.windowOptions[0].maximized, undefined, "the flag is not a BrowserWindow option");
  assert.equal(saved.windowOptions[0].width, 1300);
  assert.ok(saved.order.includes("maximize"), "a window saved maximized is maximized again");
  await Promise.resolve();
  saved.setMaximized(true);
  saved.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(savedReady, "savedReady");
  saved.win.close();
  saved.ipcHandlers.get("cc:close-answer")({ sender: saved.win.webContents }, "close");
  assert.deepEqual(JSON.parse(saved.files.get("test-data/window-bounds.json")), { width: 1200, height: 800, x: 100, y: 60, maximized: true }, "the restored size, never the screen-edge bounds");
  const normal = shellHarness({ width: 1300, height: 800, x: 10, y: 10 });
  normal.ready();
  assert.equal(normal.order.includes("maximize"), false, "a window not saved maximized is not maximized");
  assert.deepEqual(plain(readWindowBounds(() => JSON.stringify({ width: 1600, height: 1000, maximized: true }), "x", [{ x: 0, y: 0, width: 1920, height: 1080 }])), { width: 1600, height: 1000, maximized: true });
  assert.deepEqual(plain(readWindowBounds(() => JSON.stringify({ width: 1600, height: 1000, maximized: "yes" }), "x", [])), { width: 1600, height: 1000 });
  let written = ""; writeWindowBounds((_path, data) => { written = data; }, "x", { width: 1600, height: 1000, x: 5, y: 5, maximized: true });
  assert.deepEqual(JSON.parse(written), { width: 1600, height: 1000, x: 5, y: 5, maximized: true });
});

test("a crashed page reloads, keeps crashing into the error page, and a page that stops answering offers Wait or Reload", async () => {
  const { h } = await readyShell();
  const gone = (reason = "crashed") => h.win.webContents.emit("render-process-gone", {}, { reason });
  const reloads = () => h.order.filter((entry) => entry === "reload").length;
  gone("clean-exit");
  assert.equal(reloads(), 0, "a renderer that simply exited cleanly is not a crash");
  gone();
  assert.equal(reloads(), 1, "the first crash reloads the page");
  gone();
  assert.equal(reloads(), 2);
  gone("oom");
  assert.equal(reloads(), 2, "a third crash inside a minute stops reloading");
  assert.match(decodeURIComponent(h.loaded.at(-1)), /page stopped \(oom\)[^]*Close and reopen/);
  const loading = shellHarness();
  loading.ready();
  loading.win.webContents.emit("render-process-gone", {}, { reason: "killed" });
  assert.match(decodeURIComponent(loading.loaded.at(-1)), /page stopped \(killed\)/, "a crash before the app loaded shows the error page");
  const hang = await readyShell();
  hang.h.win.webContents.emit("unresponsive");
  hang.h.win.webContents.emit("unresponsive");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hang.h.messageBoxes.length, 1, "one question at a time");
  assert.equal(hang.h.messageBoxes[0].parent, hang.h.win, "attached to the window");
  assert.deepEqual(plain(hang.h.messageBoxes[0].options.buttons), ["Wait", "Reload the page"]);
  assert.equal(hang.h.order.includes("reload"), false, "Wait leaves the page alone");
  hang.h.setMessageChoice(1);
  hang.h.win.webContents.emit("unresponsive");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hang.h.messageBoxes.length, 2, "asked again after the first answer");
  assert.equal(hang.h.order.includes("reload"), true, "Reload reloads the page");
});

test("final review 9: a reload after a crash that fails to load shows the error page once; an aborted one, a subframe, or a failure with no crash shows nothing", async () => {
  const { h } = await readyShell();
  const failed = (code = -102, isMainFrame = true) => h.win.webContents.emit("did-fail-load", {}, code, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:1/", isMainFrame);
  const errorPages = () => h.loaded.filter((url) => /could not be reloaded/.test(decodeURIComponent(url))).length;
  failed();
  assert.equal(errorPages(), 0, "a failed load with no crash recovery running is not this handler's business");
  h.win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  failed(-3);
  failed(-102, false);
  assert.equal(errorPages(), 0, "an aborted load (a newer page took over) and a subframe failure show nothing");
  failed();
  assert.equal(errorPages(), 1, "the failed reload shows the error page");
  assert.match(decodeURIComponent(h.loaded.at(-1)), /could not be reloaded after it stopped \(ERR_CONNECTION_REFUSED\)/);
  failed();
  assert.equal(errorPages(), 1, "once");
  h.win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  h.win.webContents.emit("did-finish-load");
  failed();
  assert.equal(errorPages(), 1, "a reload that finished is not followed by an error page for a later failure");
});

test("round 1 fix 15: an app page that cannot load shows the error page with the reason, once; a load a newer page superseded shows nothing", async () => {
  const refuse = (code) => (h) => { h.win.loadURL = (url) => { h.loaded.push(url); return String(url).startsWith("http://") ? Promise.reject(Object.assign(new Error(`net::${code}`), { code })) : undefined; }; };
  const run = async (code) => {
    const h = shellHarness();
    refuse(code)(h);
    const ready = h.ready();
    await Promise.resolve();
    h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
    await within(ready, "ready");
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    return h;
  };
  const refused = await run("ERR_CONNECTION_REFUSED");
  const pages = refused.loaded.filter((url) => url.startsWith("data:"));
  assert.equal(refused.loaded.filter((url) => url === "http://127.0.0.1:51234").length, 1, "the app page was tried once");
  assert.equal(pages.length, 2, "the loading page, then exactly one error page");
  assert.match(decodeURIComponent(refused.loaded.at(-1)), /The app page could not be loaded: net::ERR_CONNECTION_REFUSED/);
  assert.match(decodeURIComponent(refused.loaded.at(-1)), /Command Center server unavailable/, "the same error page a server failure shows");
  const superseded = await run("ERR_ABORTED");
  assert.equal(superseded.loaded.filter((url) => url.startsWith("data:")).length, 1, "a superseded load is expected: only the loading page");
});

test("a failed page load or link open never becomes an unhandled rejection, and the folder picker is parented to the window", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const h = shellHarness();
    const ready = h.ready();
    await Promise.resolve();
    h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
    await within(ready, "ready");
    h.wireNavigationPolicy(h.win, "http://127.0.0.1:51234");
    h.win.loadURL = () => Promise.reject(Object.assign(new Error("net::ERR_FAILED"), { code: "ERR_FAILED" }));
    h.proc.emit("exit", 9);
    h.win.loadURL = () => Promise.reject(Object.assign(new Error("ERR_ABORTED (-3)"), { code: "ERR_ABORTED" }));
    h.proc.emit("exit", 9);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "no load rejection escaped");
    const picked = await h.ipcHandlers.get("cc:pick-folder")({ sender: h.win.webContents });
    assert.equal(picked, "C:/Chosen");
    assert.deepEqual(h.parents, [h.win], "the dialog has the window as its parent, so it cannot open behind the app");
  } finally {
    process.off("unhandledRejection", onUnhandled);
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

test("navigation and redirect enforcement prevent external loads on the MAIN frame, including popups", () => {
  const h = shellHarness();
  h.wireNavigationPolicy(h.win, "http://127.0.0.1:51234");
  for (const name of ["will-navigate", "will-redirect"]) {
    let blocked = false;
    h.win.webContents.emit(name, { isMainFrame: true, preventDefault: () => { blocked = true; } }, "https://example.com");
    assert.equal(blocked, true, name);
    assert.equal(h.external.at(-1), "https://example.com");
    for (const url of ["http://127.0.0.1:51234", "http://127.0.0.1:51234/path"]) {
      const externalBefore = [...h.external];
      h.win.webContents.emit(name, { isMainFrame: true, preventDefault: () => assert.fail("own server blocked") }, url);
      assert.deepEqual(h.external, externalBefore, "own server must not open externally");
    }
  }
  assert.equal(h.external.length, 2);
  assert.equal(h.popup("https://example.com").action, "deny");
});

// Guard 2 (sub-frames): a SUB-frame navigation/redirect (isMainFrame:
// false; this Electron version fires will-navigate/will-redirect for every
// frame, not just the main one, see electron/main.js's own comment) must
// never be externalized or blocked, even when the URL itself looks
// "external" by classifyNavigation's rules. The app page has no sub-frame
// today (the phone-preview iframe is gone), so this keeps a future one from
// popping the real browser. Drives the real onNavigate handler (not just checking which event
// names got wired -- that guard proved nothing about what happens to a
// sub-frame event, see the brief) with a sub-frame event carrying a
// classically-external URL, and asserts NEITHER shell.openExternal NOR
// preventDefault fired.
test("sub-frame navigation/redirect (the preview iframe) is left alone entirely, never externalized or blocked (guard 2)", () => {
  const h = shellHarness();
  h.wireNavigationPolicy(h.win, "http://127.0.0.1:51234");
  for (const name of ["will-navigate", "will-redirect"]) {
    let prevented = false;
    const externalBefore = [...h.external];
    h.win.webContents.emit(name, { isMainFrame: false, preventDefault: () => { prevented = true; } }, "https://attacker.example.com");
    assert.equal(prevented, false, `${name}: sub-frame navigation must not be preventDefault'd`);
    assert.deepEqual(h.external, externalBefore, `${name}: sub-frame navigation must not open the real browser`);
  }
  // The exact event set still matters alongside the behavioral proof above:
  // `did-frame-navigate` also carries isMainFrame and would look tempting to
  // add for "even more coverage", but it is NOT cancelable (it fires AFTER
  // navigation already happened) -- wiring onNavigate to it is silent dead
  // code, never actually preventing anything. Only a mutation adding exactly
  // that stayed green once the old exact-event-set check here was replaced
  // by the behavioral test above alone; kept as a second, cheap layer.
  assert.deepEqual(h.win.webContents.eventNames().sort(), ["will-navigate", "will-redirect"]);
});

test("server death after readiness displays an error in the window", async () => {
  const bounds = { width: 1600, height: 1000, x: 50, y: 40 };
  const h = shellHarness(bounds);
  const ready = h.ready();
  assert.equal(h.windowOptions.length, 1);
  const options = h.windowOptions[0];
  assert.equal(options.minWidth, h.MIN_WIDTH, "BrowserWindow must receive MIN_WIDTH");
  assert.equal(options.minHeight, h.MIN_HEIGHT, "BrowserWindow must receive MIN_HEIGHT");
  for (const key of Object.keys(bounds)) assert.equal(options[key], bounds[key], `restored ${key} must reach BrowserWindow`);
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  assert.equal(h.loaded.at(-1), "http://127.0.0.1:51234");
  h.proc.emit("exit", 7);
  assert.match(decodeURIComponent(h.loaded.at(-1)), /Server stopped \(code 7\)/);
  assert.match(decodeURIComponent(h.loaded.at(-1)), /Close and reopen/);
  h.proc.emit("error", new Error("server spawn failed"));
  assert.match(decodeURIComponent(h.loaded.at(-1)), /server spawn failed/);
  h.stopServer();
  const loadsBeforeShutdown = h.loaded.length;
  h.proc.emit("exit", 0);
  h.proc.emit("error", new Error("closing"));
  assert.equal(h.loaded.length, loadsBeforeShutdown, "normal shutdown must not show a crash page");
});

// The shutdown handler is cut out of the real server/index.ts and run here, so this stands in only for the one helper it calls.
const SYSTEM32_TASKKILL = "C:\\Windows\\System32\\taskkill.exe";
function registerServerShutdownHandlers(proc, calls) {
  const serverSource = stripTypeScriptTypes(readFileSync("server/index.ts", "utf8")).replaceAll("\r\n", "\n");
  const shutdownSource = serverSource.slice(serverSource.indexOf("function shutdown("));
  let closeCallback;
  const timeouts = [];
  const clientA = { terminate: () => calls.push("websocket:a") };
  const clientB = { terminate: () => calls.push("websocket:b") };
  runInNewContext(shutdownSource, {
    process: proc, console: { log() {} }, clearInterval: (timer) => calls.push(`${timer.name} timer`),
    spawnSync: (command, args, options) => { calls.push({ command, args, options }); },
    windowsTaskkillPath: () => SYSTEM32_TASKKILL,
    stallTimer: { name: "stall" }, backpressureTimer: { name: "backpressure" }, stopAllRunning: () => calls.push("workers"),
    leadersAndWaitingTurns: () => ["alpha", "beta"],
    folderActivity: { endAllOwn: () => calls.push("own windows ended"), closeWatchers: () => calls.push("folder watchers closed") },
    stopLeaderSession: (id) => calls.push(`leader:${id}`),
    wss: { close: () => calls.push("websocket server") },
    server: {
      close: (callback) => { calls.push("http server"); closeCallback = callback; },
      closeAllConnections: () => calls.push("http connections"),
    },
    clients: new Set([clientA, clientB]),
    setTimeout: (_callback, ms) => { timeouts.push(ms); return { unref() {} }; },
  });
  return { closeHttp: () => closeCallback?.(), timeouts };
}

test("server signal shutdown stops tab leaders and workers, closes every connection, then exits", () => {
  for (const event of ["SIGTERM", "SIGINT"]) {
    const calls = [];
    const proc = Object.assign(new EventEmitter(), { connected: true, send() {}, exit: (code) => calls.push(`exit:${code}`) });
    const shutdown = registerServerShutdownHandlers(proc, calls);
    proc.emit(event);
    assert.deepEqual(calls, ["stall timer", "backpressure timer", "own windows ended", "folder watchers closed", "leader:alpha", "leader:beta", "workers", "websocket:a", "websocket:b", "websocket server", "http server", "http connections"]);
    assert.deepEqual(shutdown.timeouts, [7000]);
    shutdown.closeHttp();
    assert.deepEqual(calls.at(-1), "exit:0", "the process exits after HTTP close finishes");
  }
});

test("Electron's real shutdown message drives the server IPC handler", async () => {
  const electron = shellHarness();
  const started = electron.startServer();
  await Promise.resolve();
  electron.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "started");
  const stopping = electron.stopServer();
  assert.deepEqual(electron.sent, ["shutdown"]);

  const calls = [];
  electron.proc.exit = (code) => calls.push(`exit:${code}`);
  const server = registerServerShutdownHandlers(electron.proc, calls);
  electron.proc.emit("message", electron.sent[0]);
  assert.deepEqual(calls, ["stall timer", "backpressure timer", "own windows ended", "folder watchers closed", "leader:alpha", "leader:beta", "workers", "websocket:a", "websocket:b", "websocket server", "http server", "http connections"]);
  assert.deepEqual(server.timeouts, [7000]);
  server.closeHttp();
  assert.equal(calls.at(-1), "exit:0");

  electron.proc.exitCode = 0;
  electron.proc.emit("exit", 0);
  await within(stopping, "stopping");
  assert.equal(electron.timers.size, 0, "the server exited by itself: the backstop was cleared, no taskkill needed");
});

test("server disconnect handler and startup parent-loss check stop the process tree", () => {
  for (const mode of ["disconnect", "startup"]) {
    const calls = [];
    const proc = Object.assign(new EventEmitter(), {
      connected: mode === "disconnect", pid: 4321, send() {}, exit: (code) => calls.push(`exit:${code}`),
    });
    registerServerShutdownHandlers(proc, calls);
    if (mode === "disconnect") { proc.connected = false; proc.emit("disconnect"); }
    assert.deepEqual(plain(calls), [
      "stall timer", "backpressure timer", "own windows ended", "folder watchers closed", "leader:alpha", "leader:beta", "workers",
      { command: SYSTEM32_TASKKILL, args: ["/pid", "4321", "/T", "/F"], options: { windowsHide: true } },
      "exit:0",
    ]);
  }
});

// ---- pack 1 block 3: what may reach the shell, who may call the main process, and the app key ----

test("only web and mail links reach the shell; file:, javascript: and custom schemes never do, and Obsidian is open-only", () => {
  for (const value of ["https://example.com/a", "http://127.0.0.1:3000", "mailto:someone@example.com"]) assert.equal(isSafeExternalUrl(value), true, value);
  for (const value of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-msdt:/id", "vscode://file/x", "obsidian://open?vault=a", "data:text/html,x", "C:\\Windows\\notepad.exe", "not a url", "", null, undefined, 7]) assert.equal(isSafeExternalUrl(value), false, String(value));
  assert.equal(isAllowedObsidianUrl("obsidian://open?vault=Brain&file=Note"), true);
  for (const value of ["obsidian://new?vault=Brain&name=x&content=y", "obsidian://daily?vault=Brain", "obsidian://hook-get-address", "obsidian://", "obsidian:open"]) assert.equal(isAllowedObsidianUrl(value), false, value);
});

test("the main window never leaves the app: file drops, javascript: and custom schemes are cancelled and never opened, web and mail links open outside", () => {
  const h = shellHarness();
  h.wireNavigationPolicy(h.win, "http://127.0.0.1:51234");
  const refused = ["file:///C:/Users/example/secret.txt", "javascript:alert(1)", "ms-msdt:/id", "vscode://file/x", "data:text/html,hi"];
  for (const name of ["will-navigate", "will-redirect"]) {
    for (const url of refused) {
      let blocked = false;
      h.win.webContents.emit(name, { isMainFrame: true, preventDefault: () => { blocked = true; } }, url);
      assert.equal(blocked, true, `${name} ${url} is cancelled`);
    }
  }
  assert.deepEqual(h.external, [], "none of those reached shell.openExternal");
  for (const url of refused) assert.equal(h.popup(url).action, "deny", `popup ${url}`);
  assert.deepEqual(h.external, [], "no popup reached shell.openExternal either");
  for (const url of ["https://example.com/x", "mailto:a@example.com"]) {
    let blocked = false;
    h.win.webContents.emit("will-navigate", { isMainFrame: true, preventDefault: () => { blocked = true; } }, url);
    assert.equal(blocked, true);
  }
  assert.equal(h.popup("https://example.com/y").action, "deny");
  assert.deepEqual(h.external, ["https://example.com/x", "mailto:a@example.com", "https://example.com/y"]);
});

test("every IPC handler answers the main window's page only: another sender gets nothing and nothing happens", async () => {
  const { h } = await readyShell();
  const channels = ["cc:app-key", "cc:pick-folder", "cc:open-obsidian", "cc:window-minimize", "cc:window-toggle-maximize", "cc:window-close", "cc:window-is-maximized", "cc:close-answer"];
  assert.deepEqual([...h.ipcHandlers.keys()].sort(), [...channels].sort(), "every registered handler is covered here");
  const orderBefore = [...h.order];
  for (const channel of channels) {
    for (const event of [{ sender: {} }, { sender: null }, {}, undefined]) {
      assert.equal(await h.ipcHandlers.get(channel)(event, "obsidian://open?vault=a"), undefined, `${channel} refuses ${JSON.stringify(event)}`);
    }
  }
  assert.deepEqual(h.dialogCalls, [], "no folder dialog opened");
  assert.deepEqual(h.external, [], "nothing reached the shell");
  assert.deepEqual(h.order, orderBefore, "no window was touched");
  assert.equal(h.sent.length, 0);
});

test("the app key is 32 random bytes in hex, new for every server start, passed to the server env, and given only to the app page", async () => {
  const h = shellHarness();
  const ready = h.ready();
  await Promise.resolve();
  const key = h.spawns[0][2].env.CC_APP_KEY;
  assert.match(key, /^[0-9a-f]{64}$/, "64 hex characters");
  assert.equal(h.env.CC_APP_KEY, undefined, "the app's own environment never holds it");
  const ask = (event) => h.ipcHandlers.get("cc:app-key")(event);
  const page = { sender: h.win.webContents, senderFrame: { url: "http://127.0.0.1:51234/" } };
  assert.equal(await ask({ sender: h.win.webContents, senderFrame: { url: h.loaded.at(-1) } }), null, "the loading page does not get it");
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(ready, "ready");
  assert.equal(await ask(page), key, "the app page gets the key the server was given");
  assert.equal(await ask({ ...page, senderFrame: { url: "http://127.0.0.1:51234.evil.example/" } }), null, "another origin does not");
  assert.equal(await ask({ ...page, senderFrame: { url: "https://example.com/" } }), null);
  assert.equal(await ask({ sender: h.win.webContents }), null, "a frame with no url does not");
  assert.equal(await ask({ ...page, sender: {} }), undefined, "another sender is refused");
  assert.equal(JSON.stringify(h.loaded).includes(key) || JSON.stringify(h.spawns.map(([, args]) => args)).includes(key), false, "never in a URL or an argument");
  const again = shellHarness();
  const started = again.startServer();
  await Promise.resolve();
  again.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "started");
  assert.match(again.spawns[0][2].env.CC_APP_KEY, /^[0-9a-f]{64}$/);
  const third = shellHarness();
  const thirdStarted = third.startServer();
  await Promise.resolve();
  third.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(thirdStarted, "thirdStarted");
  const keys = [key, again.spawns[0][2].env.CC_APP_KEY, third.spawns[0][2].env.CC_APP_KEY];
  assert.equal(new Set(keys).size, 3, "every start gets a fresh key");
});

test("the page can use only notifications and the clipboard copy; every other permission is denied, and nothing is granted to another page", async () => {
  const { h } = await readyShell();
  const request = (permission, requestingUrl) => { let granted; h.permissionHandlers.request({}, permission, (value) => { granted = value; }, { requestingUrl }); return granted; };
  const app = "http://127.0.0.1:51234/";
  assert.equal(request("notifications", app), true);
  assert.equal(request("clipboard-sanitized-write", app), true);
  for (const permission of ["media", "geolocation", "clipboard-read", "midi", "display-capture", "fullscreen", "openExternal", "hid", "usb", "serial", "idle-detection", "window-management"]) assert.equal(request(permission, app), false, `${permission} is denied`);
  assert.equal(request("notifications", "https://example.com/"), false, "another page gets nothing");
  assert.equal(request("notifications", undefined), false);
  assert.equal(h.permissionHandlers.check({}, "notifications", "http://127.0.0.1:51234"), true);
  assert.equal(h.permissionHandlers.check({}, "media", "http://127.0.0.1:51234"), false);
  assert.equal(h.permissionHandlers.check({}, "notifications", "https://example.com"), false);
});
