import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { source, body, plain, within, shellHarness, readyShell, isAllowedObsidianUrl, isSafeExternalUrl } from "./electron-helpers.ts";

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
