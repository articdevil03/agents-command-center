import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

// electron/main.js and the modules it imports, joined in ESM evaluation order (an imported module before its importer, main.js last), so
// the harness below runs them as ONE program. Their imports are stripped there, so every import sits on one line and every export is a declaration.
function joinedSource(file = "main.js", seen = new Set<string>()): string {
  if (seen.has(file)) return "";
  seen.add(file);
  const text = readFileSync(`electron/${file}`, "utf8").replaceAll("\r\n", "\n");
  return [...text.matchAll(/^import .* from "\.\/([\w-]+\.js)";$/gm)].map((m) => joinedSource(m[1], seen)).join("") + text + "\n";
}
export const source = joinedSource();
// Execute the real pure functions only. No Electron app, window, or process spawn.
export function body(name) {
  const match = source.match(new RegExp(`(?:export )?function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, `${name} must exist`);
  return match[0].replace("export function", "function");
}
// vm.runInNewContext objects come from a different realm, so assert/strict's
// deepEqual (which is deepStrictEqual) rejects them as "not reference-equal"
// despite identical structure; round-tripping through JSON brings them home.
export const plain = (value) => JSON.parse(JSON.stringify(value));
// A wait on a promise the code under test should settle, bounded so a change that stops it settling fails with this message instead of
// hanging until the runner's own timeout (the harness fakes only the timers inside main.js, so this one is real).
export async function within(promise, label, ms = 3000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: `${label} did not settle within ${ms}ms` })), ms); })]);
  } finally { clearTimeout(timer); }
}

export const { parseServerPort, sanitizeWindowBounds, readWindowBounds, writeWindowBounds, classifyNavigation, isAllowedObsidianUrl, isSafeExternalUrl, buildServerCommandArgs } = runInNewContext(
  `${source.match(/(?:export )?const (?:DEFAULT_WINDOW_BOUNDS|MIN_WIDTH|MIN_HEIGHT) = .*;/g).join("\n").replaceAll("export ", "")}
  ${["parseServerPort", "sanitizeWindowBounds", "readWindowBounds", "writeWindowBounds", "classifyNavigation", "isAllowedObsidianUrl", "isSafeExternalUrl", "buildServerCommandArgs"].map(body).join("\n")}
  ;({ parseServerPort, sanitizeWindowBounds, readWindowBounds, writeWindowBounds, classifyNavigation, isAllowedObsidianUrl, isSafeExternalUrl, buildServerCommandArgs });`,
  { pathToFileURL, URL }
);

// Execute the production wiring with event/IO dependencies, no DOM or Electron runner.
export let keyCount = 0;
export function shellHarness(savedBounds = {}, { lockAcquired = true, smokeReadyFile, smokeStopFile, smokeDataDir, inheritedDiscoverySkip = false } = {}) {
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

// Closing the app while a tab is still working asks first. The page answers "close" (nothing working, or Close anyway), "hold" (its
// warning is showing) or "keep" (Keep open); only "close", or no answer within 2 s, closes, and always through the normal close path.
export async function readyShell() {
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
