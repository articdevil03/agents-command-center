import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { plain, within, shellHarness, readyShell, readWindowBounds, writeWindowBounds, source } from "./electron-helpers.ts";

const READY_TIMEOUT_MS = Number(source.match(/const READY_TIMEOUT_MS = ([\d_]+);/)![1].replaceAll("_", ""));

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
  assert.equal([...h.timers.values()].some(({ ms }) => ms === READY_TIMEOUT_MS), false, "the readiness timer was cleared by the error");
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
