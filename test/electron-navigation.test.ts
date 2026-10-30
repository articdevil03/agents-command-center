import test from "node:test";
import { sourceText } from "./source-text.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { plain, within, shellHarness, parseServerPort, sanitizeWindowBounds, readWindowBounds, writeWindowBounds, classifyNavigation, isAllowedObsidianUrl } from "./electron-helpers.ts";

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
// frame, not just the main one, see wireNavigationPolicy's comment in electron/navigation.js) must
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
  const serverSource = stripTypeScriptTypes(sourceText("server/index.ts")).replaceAll("\r\n", "\n");
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
