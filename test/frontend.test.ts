import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const publicDir = join(process.cwd(), "public");
const PRESETS = ["atlas", "sonny", "vera", "sol", "nova", "terra", "pip", "momo", "juno", "ziggy", "rumi", "kiki", "bo", "fig", "dune", "sage", "mel", "ollie", "taro", "ash"];

test("the twenty flat picture presets ship as safe, self-contained SVG files", () => {
  const shipped = readdirSync(join(publicDir, "avatars")).filter((name) => name.endsWith(".svg")).map((name) => name.slice(0, -4)).sort();
  assert.deepEqual(shipped, [...PRESETS].sort(), "public/avatars holds exactly the twenty presets");
  for (const name of PRESETS) {
    const path = join(publicDir, "avatars", `${name}.svg`);
    assert.ok(existsSync(path), `preset file exists: public/avatars/${name}.svg`);
    const svg = readFileSync(path, "utf8");
    assert.match(svg.trimStart(), /^(?:<\?xml[^>]*>\s*)?<svg\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${name}.svg is an SVG document`);
    assert.match(svg.trimEnd(), /<\/svg>$/, `${name}.svg ends its svg element`);
    assert.doesNotMatch(svg, /<script/i, `${name}.svg has no script`);
    assert.doesNotMatch(svg, /\son[a-z]+\s*=/i, `${name}.svg has no on* event attribute`);
    assert.doesNotMatch(svg, /\b(?:xlink:)?href\s*=\s*["'](?!#)/i, `${name}.svg links nothing outside itself`);
    assert.doesNotMatch(svg, /url\(\s*["']?(?!#)/i, `${name}.svg loads no outside url()`);
    assert.doesNotMatch(svg, /<(?:foreignObject|iframe|object|embed|image)\b/i, `${name}.svg embeds nothing`);
  }
  // The picker offers exactly the presets that ship, in the approved order; it can never offer a missing file.
  const app = readFileSync(join(publicDir, "app.js"), "utf8");
  const listed = /const AVATAR_PRESETS = \[([^\]]+)\];/.exec(app)?.[1].match(/"([a-z]+)"/g)?.map((item) => item.slice(1, -1));
  assert.deepEqual(listed, PRESETS, "app.js AVATAR_PRESETS matches the shipped files and order");
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  assert.match(index, /<script\b[^>]*\bsrc="\/logos\.js"/);
  assert.ok(readFileSync(join(publicDir, "logos.js"), "utf8").length > 0, "logos load from their public file");
  assert.match(index, /<link\b[^>]*\brel="icon"[^>]*\bhref="data:image\/svg\+xml,/, "the Orbit mark is the favicon");
});

test("real renderer contains no demo-only actions or seeded mock data", () => {
  const app = readFileSync(join(publicDir, "app.js"), "utf8");
  assert.doesNotMatch(app, /\b(?:demoAction|roundDemo|fakeFolder|demoMakerId|SAMPLE_LOGS|PROJECTS|REQUESTS)\b/);
  assert.match(app, /No runs yet/);
});

test("the front end never claims the leader is Claude-only (it runs on Claude, Codex or OpenCode)", () => {
  for (const file of ["app.js", "index.html"]) {
    const text = readFileSync(join(publicDir, file), "utf8");
    assert.doesNotMatch(text, /comes with the crew|leader stays on Claude|needs Claude Code for the leader/i, `public/${file}`);
  }
  // The Advisor rows (Usage panel, Settings, the seat card) are checked in the real app, per leader CLI: test/browser-harness.js "a Codex leader: Settings and the Usage panel show no Advisor".
});

test("renderAll's focus layers cover every popover and modal in index.html", () => {
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  const layers = [...index.matchAll(/<div\b[^>]*\brole="(?:alert)?dialog"[^>]*>/g)].map((m) => m[0]);
  assert.ok(layers.length >= 15, `found the dialog layers (${layers.length})`);
  const classes = (tag: string) => (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);
  for (const tag of layers) assert.ok(classes(tag).some((c) => c === "pop" || c === "modal"), `a dialog layer has the pop or modal class: ${tag.slice(0, 80)}`);
  const app = readFileSync(join(publicDir, "app.js"), "utf8");
  assert.match(app, /const LAYERS = "\.pop,\.modal", layerId/, "renderAll matches layers by the shared classes, so no popover or modal can be missed");
  for (const id of ["pop", "seatPop", "projPop", "ctxPop", "setupPop", "permPop", "soundPop", "inboxPop", "modal", "projModal", "renameModal", "avModal", "viewer", "setModal", "runModal", "confirmModal"]) {
    assert.ok(layers.some((tag) => tag.includes(`id="${id}"`)), `${id} is a dialog layer in index.html`);
  }
});

// ---- pack 1 block 3 ----

const appSource = readFileSync(join(publicDir, "app.js"), "utf8").replaceAll("\r\n", "\n");

test("the page takes the app key from the Electron bridge or #key=, sends it on the WebSocket and as X-App-Key on every POST", async () => {
  const start = appSource.indexOf("let appKeyValue = ");
  const end = appSource.indexOf("  function connect() {");
  assert.ok(start > 0 && end > start, "the key helpers exist");
  const make = (context: Record<string, unknown>) => {
    const fetched: { url: string; options: any }[] = [];
    const store = new Map<string, string>(); const replaced: unknown[][] = [];
    const scope = { fetch: async (url: string, options: any) => { fetched.push({ url, options }); return { ok: true }; }, sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
      history: { replaceState: (...args: unknown[]) => { replaced.push(args); } }, location: { hash: "", pathname: "/", search: "" }, ...context };
    const api = runInNewContext(`${appSource.slice(start, end)}\n;({ getAppKey, keyedFetch })`, scope);
    return { ...api, fetched, replaced, store };
  };
  const key = "ab".repeat(32);
  const electron = make({ window: { cc: { appKey: async () => key } } });
  assert.equal(await electron.getAppKey(), key);
  await electron.keyedFetch("/api/paste-image", { method: "POST", headers: { "Content-Type": "image/png", "X-Request-Id": "r1" }, body: "x" });
  await electron.keyedFetch("/api/paste-file", { method: "POST", headers: {}, body: "x" });
  assert.deepEqual(electron.fetched.map((f) => f.options.headers["X-App-Key"]), [key, key], "every POST carries the key");
  assert.equal(electron.fetched[0].options.headers["Content-Type"], "image/png", "the caller's own headers stay");
  assert.equal(electron.store.size, 0, "the Electron key is never stored");

  const browser = make({ window: {}, location: { hash: `#key=${key}`, pathname: "/", search: "?x=1" } });
  assert.equal(await browser.getAppKey(), key, "a plain browser tab reads #key=");
  assert.deepEqual(browser.replaced, [[null, "", "/?x=1"]], "and removes it from the address bar");
  assert.equal(browser.store.get("cc-app-key"), key);
  const reloaded = make({ window: {}, location: { hash: "", pathname: "/", search: "" } });
  reloaded.store.set("cc-app-key", key);
  assert.equal(await reloaded.getAppKey(), key, "a reload of the same tab keeps working");

  const none = make({ window: {} });
  assert.equal(await none.getAppKey(), "", "no key anywhere: empty, so the server refuses and the Disconnected banner shows");
  const broken = make({ window: { cc: { appKey: async () => { throw new Error("no"); } } } });
  assert.equal(await broken.getAppKey(), "");

  // A restarted server hands out a new key: a 403 on a POST, or a socket that closes before it ever opened, must drop the cached key.
  let current = key;
  const stale = make({ window: { cc: { appKey: async () => current } }, fetch: async () => ({ status: 403 }) });
  assert.equal(await stale.getAppKey(), key);
  current = "cd".repeat(32);
  await stale.keyedFetch("/api/paste-image", { method: "POST", headers: {}, body: "x" });
  assert.equal(await stale.getAppKey(), current, "after a 403 the next attempt re-reads the key");
  // A key a plain browser tab stored must also leave sessionStorage on a 403, or the next reload re-reads the dead key.
  const kept = make({ window: {}, location: { hash: `#key=${key}`, pathname: "/", search: "" }, fetch: async () => ({ status: 403 }) });
  assert.equal(await kept.getAppKey(), key);
  assert.equal(kept.store.get("cc-app-key"), key, "the browser tab stored the key");
  await kept.keyedFetch("/api/paste-image", { method: "POST", headers: {}, body: "x" });
  assert.equal(kept.store.has("cc-app-key"), false, "a 403 removes the stored key from sessionStorage");
  assert.match(appSource, /next\.addEventListener\("close", \(\) => \{\n      if \(socket !== next\) return;\n      if \(!everOpened\) forgetAppKey\(\);/, "a socket that closed before it opened forgets the key");
  assert.match(appSource, /next\.addEventListener\("open", \(\) => \{\n      everOpened = true;/, "an opened socket keeps it");
  assert.match(appSource, /reconnectTimer = setTimeout\(connect, reconnectDelay\)/, "the reconnect backoff stays");

  assert.match(appSource, /new WebSocket\(`ws:\/\/\$\{location\.host\}\/\?key=\$\{encodeURIComponent\(key\)\}`\)/, "the socket connects with ?key=");
  assert.match(appSource, /getAppKey\(\)\.then\(\(key\) => \{ if \(ticket === connectTicket\) openSocket\(key\); \}\)/, "the socket is opened with the resolved key");
  const rawFetches = [...appSource.matchAll(/(?<![\w.])fetch\(/g)];
  assert.equal(rawFetches.length, 1, "the only plain fetch( is the one inside keyedFetch");
  for (const route of ["/api/paste-image", "/api/paste-file", "/api/avatar"]) assert.ok(appSource.includes(`await keyedFetch("${route}",`), `${route} goes through keyedFetch`);
});

test("no page copy promises a Codex sandbox boundary", () => {
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  assert.doesNotMatch(appSource, /\(Codex sandbox\)|only Codex seats are sandboxed/);
  assert.doesNotMatch(index, /only Codex seats are held to it/);
  assert.match(appSource, /asked not to write; Codex can still write through commands/);
});

test("the permission copy is honest per leader CLI: only Claude promises to ask first or to change nothing", () => {
  const source = /const PERMISSIONS = (\[[\s\S]*?\n  \]);/.exec(appSource)?.[1];
  assert.ok(source, "the PERMISSIONS table is in app.js");
  const modes = runInNewContext(`(${source})`) as [string, string, (name: string, cli: string) => string][];
  const copy = (id: string, cli: string) => modes.find(([mode]) => mode === id)![2]("Atlas", cli);
  assert.equal(copy("ask", "claude"), "Atlas asks before changing any file or running a command");
  assert.equal(copy("accept", "claude"), "Edits go through, commands still ask");
  assert.equal(copy("plan", "claude"), "Reads and plans, changes nothing");
  for (const cli of ["codex", "opencode"]) {
    assert.doesNotMatch(copy("ask", cli), /asks before changing any file/, `${cli} Ask`);
    assert.doesNotMatch(copy("plan", cli), /changes nothing/i, `${cli} Plan`);
    assert.match(copy("plan", cli), /can still write a file/, `${cli} Plan says a command can still write`);
  }
  assert.match(copy("ask", "codex"), /Some commands and file writes can still go through without asking/);
  assert.match(copy("ask", "opencode"), /Reading files and folders does not ask/);
  assert.match(copy("accept", "codex"), /Codex asks when it needs more access/);
  assert.match(appSource, /description\(name, cli\)/, "the picker passes the leader's CLI");
});

test("the approval box shows the whole summary, scrollable; the font files ship with the app; nothing loads from Google", () => {
  const css = readFileSync(join(publicDir, "style.css"), "utf8");
  assert.match(/\.apv code\{[^}]*\}/.exec(css)![0], /white-space:pre-wrap[^}]*max-height:40vh;overflow:auto/);
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  assert.match(index, /<code id="approvalSummary" tabindex="0">/, "a keyboard user can scroll it");
  for (const [file, text] of [["index.html", index], ["style.css", css], ["app.js", appSource]]) assert.doesNotMatch(text, /fonts\.(?:googleapis|gstatic)\.com/, `public/${file} loads no Google fonts`);
  const faces = [...css.matchAll(/@font-face\{font-family:"([^"]+)";[^}]*font-weight:(\d+);[^}]*url\("(\/fonts\/[^"]+)"\)/g)];
  assert.deepEqual(faces.map(([, family, weight]) => `${family} ${weight}`), ["Geist 400", "Geist 500", "Geist 600", "Geist 700", "Geist Mono 400", "Geist Mono 500"]);
  for (const [, , , url] of faces) assert.ok(existsSync(join(publicDir, url.slice(1))), `${url} ships`);
  assert.ok(existsSync(join(publicDir, "fonts", "LICENSE-Geist-OFL.txt")), "the font licence ships with the fonts");
});

test("a dropped file never opens in place of the app, and MCP and plugin Add ask first like the Settings text says", () => {
  assert.match(appSource, /for \(const type of \["dragover", "drop"\]\) document\.addEventListener\(type, \(event\) => \{ if \(!event\.target\.closest\?\.\("\[data-drop-zone\]"\)\) event\.preventDefault\(\); \}\);/);
  const mcp = /querySelectorAll\("\[data-mcp-form\]"\)[\s\S]*?\n    \}\)\);/.exec(appSource)![0];
  assert.match(mcp, /confirmAction\(\{ title: `Add \$\{name\} to \$\{CLI_LABEL\[cli\]\}\?`[\s\S]*?\(\) => \{ if \(sendSettingsAction\(key, \{ type: "mcpAdd"/, "MCP Add sits inside the confirm callback");
  assert.doesNotMatch(mcp.replace(/confirmAction[\s\S]*$/, ""), /sendSettingsAction/, "nothing is sent before the confirm");
  const plugin = /querySelector\("\[data-plugin-form\]"\)[\s\S]*?\n    \}\);/.exec(appSource)![0];
  assert.match(plugin, /confirmAction\([\s\S]*?\(\) => \{ if \(sendSettingsAction\("plugin-add"/);
  assert.doesNotMatch(plugin.replace(/confirmAction[\s\S]*$/, ""), /sendSettingsAction/);
});

test("a late 'saved' clears the earlier Save failed card, notice and pending flag, which all read saveStates", () => {
  const app = readFileSync(join(publicDir, "app.js"), "utf8");
  const handler = /if \(message\.type === "saved"\) \{[^]*?\n    \}/.exec(app)?.[0] ?? "";
  assert.ok(handler, "the saved handler was found");
  assert.match(handler, /savePending\.delete\(message\.tabId\)/);
  assert.match(handler, /saveStates\.delete\(message\.tabId\)/);
  // The Save failed notice and the Needs you card both derive from saveStates, so deleting it removes every trace.
  assert.ok(/const save = saveStates\.get\(tab\.id\);\s*\n\s*if \(save\?\.status === "failed"\) return/.test(app), "the notice reads saveStates");
  assert.ok(/items\.push\(\{ type: "save", tab, save, bad: true \}\)/.test(app), "the Needs you card reads saveStates");
});

// ---- fix pack 2, block 3: the page's behaviour, driven through onMessage / the page's own functions (no browser) ----

// Runs app.js up to its start-up lines, with a stub DOM, a fake WebSocket, a captured Notification and captured timers.
function pageHarness(options: { raf?: (fn: () => void) => number } = {}) {
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, value: "", textContent: "", innerHTML: "", hidden: false, disabled: false, dataset: {}, options: [], style: { setProperty() {} },
      classList: { contains: () => false, toggle() {}, add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, removeAttribute() {},
      getAttribute: () => null, focus() {}, closest: () => null, matches: () => false, append() {}, replaceChildren() {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) });
    return nodes.get(id);
  };
  const closeAnswers: string[] = [];
  const sockets: any[] = [], notifications: { title: string; body: string }[] = [], timers: { fn: () => void; ms: number; cleared: boolean }[] = [], bodyClasses = new Set(["light", "boot"]);
  const mediaListeners: (() => void)[] = []; // the page's "change" listeners on the prefers-color-scheme query
  const media = { light: false, listeners: mediaListeners, change() { mediaListeners.forEach((listener) => listener()); } }; // light: what the PC's prefers-color-scheme: light answers
  class FakeWebSocket {
    static OPEN = 1; static CONNECTING = 0; readyState = 1; sent: any[] = []; listeners = new Map<string, ((event: any) => void)[]>(); url: string;
    constructor(url: string) { this.url = url; sockets.push(this); }
    addEventListener(name: string, fn: (event: any) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
    emit(name: string, event: any = {}) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.emit("close"); }
  }
  class FakeNotification { static permission = "granted"; constructor(title: string, options: { body?: string } = {}) { notifications.push({ title, body: options.body ?? "" }); } }
  const end = appSource.lastIndexOf("  bindEvents();");
  assert.ok(end > 0, "the start-up boundary is found");
  // bindEvents() is not run here, so the page's real PC-colour-scheme listener line is lifted out of the source and registered with the page's own functions.
  const mediaListenerLine = appSource.split(String.fromCharCode(10)).find((line) => line.includes('matchMedia("(prefers-color-scheme: light)").addEventListener'))?.trimEnd();
  assert.ok(mediaListenerLine, "the page's colour-scheme change listener is found in app.js");
  const api = runInNewContext(`${appSource.slice(0, end)}
    const confirmCalls = [];
    ${mediaListenerLine}
    // The page's own functions, taken before the stubs below replace the renderers: pack 3 tests call them with the state onMessage built.
    const real = { seatLine, liveRuns, avatarKeyFor, seatPic, sideWidth, saveSideWidth, contextLine, renderMeters, modelRows, modelLine, drawModelPicker };
    confirmAction = (options, callback, opener, onCancel) => { confirmCalls.push({ ...options, callback, onCancel }); };
    renderAll = renderStage = renderSide = renderSettings = renderUndo = renderInbox = renderCrew = renderHeader = renderToolApproval = renderMeters = renderTabs = renderStatusLine = renderChatIfShown = () => {};
    return {
      real, onMessage, connect, send, answerCloseRequest, renderChat, confirmCalls, killRun, stopAll, holdAction, runProcessAction, requestHistory, renderUsage, skillBlock, requestCard, approvalTitle, showApp, saveDismissed, pickerHints, bindHistoryView, mePic, renderMessage, clearConfirmMenu, setTheme, applyTheme,
      setMe: (av) => { me = { av }; }, setRefresh: (value) => { refreshState = value; }, setMakeMenu: (fn) => { makeMenu = fn; },
      snap: () => ({ historyRunRequested, historyDetails, historyRunTokens, historyFullRequested, outputByRun, activity, stopStates, killOrder, processPending, historyInFlight, historyFailed, transcriptRequests, pendingActions, stallActions, refreshState, stopAllTrack, clientPrefOverrides, railWide, sideOpen, seenNotices }),
    };
  })()`, {
    document: { getElementById: node, querySelectorAll: () => [], querySelector: () => null, activeElement: null, hasFocus: () => false, body: { classList: { remove: (name: string) => bodyClasses.delete(name), toggle: (name: string, on?: boolean) => { if (on === false || (on === undefined && bodyClasses.has(name))) bodyClasses.delete(name); else bodyClasses.add(name); }, add: (name: string) => bodyClasses.add(name) } } },
    window: { cc: { appKey: async () => "k".repeat(64), answerClose: (answer: string) => closeAnswers.push(answer) }, Notification: FakeNotification }, Notification: FakeNotification, WebSocket: FakeWebSocket,
    Map, Set, console, CSS: { escape: (s: string) => s }, Blob, TextEncoder, URL, atob, Uint8Array,
    location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, history: { replaceState() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200 }), crypto: { randomUUID: () => `${Math.random().toString(16).slice(2).padEnd(32, "0")}-0000-0000-0000-000000000000`.slice(0, 36) },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length; }, clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: options.raf ?? ((fn: () => void) => { fn(); return 1; }), cancelAnimationFrame() {}, performance: { now: () => 0 },
    matchMedia: (query: string) => ({ matches: /prefers-color-scheme: light/.test(query) ? media.light : false, addEventListener(name: string, listener: () => void) { if (name === "change" && /prefers-color-scheme/.test(query)) mediaListeners.push(listener); } }), innerWidth: 1600, innerHeight: 900,
  });
  const open = async () => { api.connect(); await new Promise((resolve) => setImmediate(resolve)); const socket = sockets.at(-1); socket.emit("open"); return socket; };
  const tab = (over: Record<string, unknown> = {}) => ({ id: "t1", name: "Dev", kind: "dev", process: "main", folder: "C:/p", pendingApprovals: [], runs: [], derived: { stepBar: [], busy: false }, processState: { approval: { state: "none" } },
    crew: [{ slot: "leader", name: "Atlas", cli: "claude", model: "claude-opus-5-5[1m]", effort: "high", isLeader: true, seatKey: "t1.leader" }, { slot: "coder", name: "Sonny", cli: "codex", model: "gpt-6-sol", effort: "low", seatKey: "t1.coder" }], ...over });
  const state = (tabOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({ type: "state", projects: [{ id: "p1", name: "P", folder: "C:/p", tabs: [tab(tabOver)] }], selectedTabId: "t1", clientPrefs: {}, requests: [], launchSafety: { notices: [] }, settings: {}, ...over });
  const run = (id: string, over: Record<string, unknown> = {}) => ({ runId: id, id, seatSlotId: "coder", seatKey: "t1.coder", seatName: "Sonny", label: `Run ${id}`, status: "working", cli: "codex", model: "gpt-6-sol", output: "", ...over });
  return { api, closeAnswers, sockets, notifications, timers, bodyClasses, media, open, tab, state, run, node };
}
// A held action's timer runs for max(0, dueAt - Date.now()), so it is 10 s less the milliseconds that passed since it was held (9999 is common): found by being the last live timer of about 10 s, never by an exact count.
function heldTimer(timers: { fn: () => void; ms: number; cleared: boolean }[]) {
  const held = timers.filter((timer) => !timer.cleared && timer.ms >= 9000 && timer.ms <= 10000).at(-1);
  assert.ok(held, `a live timer of about 10 s exists among ${JSON.stringify(timers.filter((timer) => !timer.cleared).map((timer) => timer.ms))}`);
  return held;
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)); // values built inside the page's context are not reference-equal to ours
const noTabs = { type: "state", projects: [{ id: "p1", name: "P", folder: "C:/p", tabs: [] }], selectedTabId: null, clientPrefs: {}, requests: [], launchSafety: { notices: [] }, settings: {} };

test("approvals already waiting when the page loads never ring; a new one rings once, named after the leader's current name", () => {
  const h = pageHarness();
  const approval = (id: string) => ({ approvalId: id, tool: "Bash", summary: `echo ${id}`, createdAt: 1 });
  h.api.onMessage(h.state({ pendingApprovals: [approval("a")], processState: { approval: { state: "pending" } } }));
  assert.deepEqual(h.notifications, [], "the first state after a load is not news: an approval and a look already waiting do not ring");
  h.api.onMessage(h.state({ pendingApprovals: [approval("a"), approval("b")], processState: { approval: { state: "pending" } } }));
  assert.deepEqual(h.notifications.map((item) => item.title), ["Atlas needs your answer"], "a new approval rings once");
  h.api.onMessage(h.state({ pendingApprovals: [approval("a"), approval("b")], processState: { approval: { state: "pending" } } }));
  assert.equal(h.notifications.length, 1, "the same state again rings nothing");
  const renamed: any = h.state({ pendingApprovals: [approval("a"), approval("b"), approval("c")], processState: { approval: { state: "pending" } } });
  renamed.projects[0].tabs[0].crew[0].name = "Rowan";
  h.api.onMessage(renamed);
  assert.deepEqual(h.notifications.map((item) => item.title), ["Atlas needs your answer", "Rowan needs your answer"], "a renamed leader is called by its new name");
  h.api.onMessage(h.state({ processState: { approval: { state: "none" } } }));
  h.api.onMessage(h.state({ processState: { approval: { state: "pending" } } }));
  assert.equal(h.notifications.at(-1)?.title, "Your look is needed", "a look that becomes pending after the page loaded still rings");
  const named: any = h.tab(); named.crew[0].name = "Rowan";
  assert.equal(h.api.approvalTitle("Edit", named), "Rowan wants to edit a file", "the approval title uses the leader's current name");
  assert.equal(h.api.approvalTitle("launch:Sonny", named), "Rowan wants to launch Sonny");
});

test("closing the app also warns about work that belongs to no tab (a Settings action, an upload), and alone it holds the close", () => {
  const h = pageHarness();
  const nbsp = " · ";
  h.api.onMessage(h.state({}, { globalWork: [] }));
  h.api.answerCloseRequest();
  assert.deepEqual(h.closeAnswers, ["close"], "nothing working: closes at once");
  h.api.onMessage(h.state({}, { globalWork: ["a Settings action is running"] }));
  h.api.answerCloseRequest();
  assert.deepEqual(h.closeAnswers, ["close", "hold"], "work with no tab holds the close");
  assert.equal(h.api.confirmCalls.at(-1).body, "Still working: a Settings action is running. Closing stops it.");
  h.api.onMessage(h.state({ activeWork: true }, { globalWork: ["an upload is running", "a Settings action is running"] }));
  h.api.answerCloseRequest();
  assert.equal(h.api.confirmCalls.at(-1).body, `1 tab is still working: P${nbsp}Dev. Also: an upload is running, a Settings action is running. Closing stops them.`);
  h.api.onMessage(h.state({ activeWork: true }, { globalWork: [] }));
  h.api.answerCloseRequest();
  assert.equal(h.api.confirmCalls.at(-1).body, `1 tab is still working: P${nbsp}Dev. Closing stops it.`, "a working tab alone reads as it always did");
});

test("a tab whose saved chat cannot be read says why its chat is empty, in the existing failed-status look", () => {
  const h = pageHarness();
  const withProblem: any = h.state({ chatProblem: "Unexpected token < in <b>JSON" });
  h.api.onMessage(withProblem);
  h.api.renderChat(withProblem.projects[0].tabs[0]);
  const html = h.node("view").innerHTML as string;
  assert.match(html, /<p class="action-status" data-status="failed" role="alert" data-chat-problem>This chat could not be read \(Unexpected token &lt; in &lt;b&gt;JSON\)\. Clear the chat to start a new one; the damaged file is kept as a copy\.<\/p>/, "one plain error line, reason escaped");
  assert.match(html, /is ready/, "the empty-chat welcome still shows under it");
  const fine: any = h.state({});
  h.api.onMessage(fine);
  h.api.renderChat(fine.projects[0].tabs[0]);
  assert.doesNotMatch(h.node("view").innerHTML as string, /data-chat-problem/, "a readable chat shows no such line");
});

test("a worker launch never rings or sends a notice; a finish or failure says which run and how it ended", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ runs: [h.run("r1", { label: "Fix the login" })] }));
  h.api.onMessage({ type: "runStart", tabId: "t1", seatKey: "t1.coder", runId: "r1", model: "gpt-6-sol" });
  assert.deepEqual(h.notifications, [], "starting a worker is not finishing, failing or needing you");
  h.api.onMessage({ type: "runFinish", tabId: "t1", seatKey: "t1.coder", runId: "r1", outcome: "done", exitCode: 0 });
  h.api.onMessage({ type: "runFail", tabId: "t1", seatKey: "t1.coder", runId: "r1", outcome: "failed", exitCode: 3 });
  assert.deepEqual(h.notifications, [{ title: "Sonny finished", body: "Fix the login finished." }, { title: "Sonny failed", body: "Fix the login failed (failed, exit 3)." }]);
  assert.ok(h.notifications.every((item) => item.body !== "The run ended."), "never the old always-the-same text");
});

test("a live run's log: the server's tail is its base, chunks append, a resync fills what was missed, the page keeps 200 KiB, a finished run's log is freed", () => {
  const h = pageHarness();
  const live = (output: string, status = "working") => h.state({ runs: [h.run("r1", { output, status })] });
  h.api.onMessage(live("line one\n"));
  assert.equal(h.api.snap().outputByRun.get("r1"), "line one\n", "a reload starts from the server's tail");
  h.api.onMessage({ type: "output", runId: "r1", chunk: "line two\n" });
  assert.equal(h.api.snap().outputByRun.get("r1"), "line one\nline two\n", "a chunk is appended to that tail, not started from nothing");
  h.api.onMessage(live("line one\nline two\nMISSED\n"));
  assert.equal(h.api.snap().outputByRun.get("r1"), "line one\nline two\nMISSED\n", "a state after a gap fills in what the page missed");
  h.api.onMessage({ type: "output", runId: "r1", chunk: "z".repeat(300 * 1024) + "END" });
  const kept = h.api.snap().outputByRun.get("r1");
  assert.equal(kept.length, 200 * 1024, "the page keeps what the server keeps");
  assert.ok(kept.endsWith("END"), "and it is the end of the log");
  h.api.onMessage(live("y".repeat(300 * 1024)));
  assert.equal(h.api.snap().outputByRun.get("r1").length, 200 * 1024, "a state's tail is capped too");
  h.api.onMessage(live("", "done"));
  assert.equal(h.api.snap().outputByRun.has("r1"), false, "a finished run's log is freed");
  h.api.onMessage({ type: "output", runId: "r1", chunk: "late" });
  h.api.onMessage(h.state({ runs: [] }));
  assert.equal(h.api.snap().outputByRun.has("r1"), false, "nothing keeps a log for a run that is not listed");
});

test("a launch notice is one Activity line however many pile up or arrive twice, and updates in place when its outcome is confirmed", () => {
  const h = pageHarness();
  const notice = (id: number, pending = false) => ({ type: "leaderLaunch", id, seatId: "t1.coder", seatKey: "t1.coder", seatName: "Sonny", brief: "x", source: "Atlas", pending });
  const withNotices = (list: any[]) => h.state({}, { launchSafety: { notices: list } });
  h.api.onMessage(notice(1, true));
  h.api.onMessage(withNotices([notice(1, true)]));
  assert.deepEqual(plain(h.api.snap().activity.map((item: any) => item.text)), ["Atlas requested Sonny \u00b7 outcome unconfirmed"], "the message and the state it also arrives in make one line");
  h.api.onMessage(withNotices([notice(1, false)]));
  assert.deepEqual(plain(h.api.snap().activity.map((item: any) => item.text)), ["Atlas requested Sonny"], "the outcome got confirmed: that line is updated, not a second one added");
  const many = Array.from({ length: 120 }, (_, index) => notice(100 + index));
  h.api.onMessage(withNotices(many));
  const first = plain(h.api.snap().activity.map((item: any) => item.id));
  assert.equal(first.length, 80, "the feed keeps 80");
  h.api.onMessage(withNotices(many)); h.api.onMessage(withNotices(many));
  assert.deepEqual(plain(h.api.snap().activity.map((item: any) => item.id)), first, "repeated states change nothing: notices that fell off are not added back");
  h.api.onMessage({ type: "runFinish", tabId: "t1", seatKey: "t1.coder", runId: "r9", outcome: "done", exitCode: 0 });
  h.api.onMessage(withNotices(many));
  assert.match(h.api.snap().activity[0].text, /finished$/, "a real event stays on top and is not pushed out by notices");
  h.api.onMessage(withNotices(many.slice(100)));
  assert.equal(h.api.snap().seenNotices.size, 20, "a notice the server dropped is forgotten");
});

test("a Stop, a held removal and a Stop all that were sent but never answered are not left stuck by a dropped connection", async () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ runs: [h.run("r1"), h.run("r2")] }));
  let socket = await h.open();
  h.api.killRun("r1"); h.api.killRun("r2");
  assert.deepEqual(plain([...h.api.snap().stopStates.entries()]), [["r1", "requested"], ["r2", "requested"]]);
  assert.deepEqual(plain(h.api.snap().killOrder), ["r1", "r2"]);
  h.api.onMessage({ type: "error", action: "killRun", message: "refused" });
  assert.deepEqual(plain([...h.api.snap().stopStates.entries()]), [["r2", "requested"]], "a refusal frees only the oldest unanswered Stop, not every one");
  h.api.onMessage({ type: "killAccepted", runId: "r2" });
  assert.equal(h.api.snap().stopStates.get("r2"), "accepted");
  assert.deepEqual(plain(h.api.snap().killOrder), [], "an answered Stop leaves the queue");
  h.api.killRun("r1");
  assert.equal(h.api.snap().stopStates.get("r1"), "requested");
  // a removal whose timer fired and was sent
  h.api.holdAction({ type: "removeTab", tabId: "t1" }, "Dev tab will be removed", { type: "removeTab", tabId: "t1", hideTabId: "t1" });
  const held = heldTimer(h.timers); held.fn();
  assert.equal(socket.sent.filter((message: any) => message.type === "removeTab").length, 1);
  assert.equal([...h.api.snap().pendingActions.values()][0].sent, true);
  socket.close();
  assert.equal(h.api.snap().stopStates.has("r1"), false, "a Stop that got no answer before the drop is forgotten, so its button works again");
  assert.equal(h.api.snap().stopStates.get("r2"), "accepted", "an accepted Stop stays: the run really is stopping");
  assert.deepEqual(plain(h.api.snap().killOrder), []);
  socket = await h.open();
  assert.equal(socket.sent.filter((message: any) => message.type === "removeTab").length, 0, "nothing is resent before the first state says whether it was applied");
  h.api.onMessage(h.state({ runs: [h.run("r1"), h.run("r2")] }));
  assert.equal(socket.sent.filter((message: any) => message.type === "removeTab").length, 1, "the tab is still there: the removal is sent again");
  h.api.onMessage(noTabs);
  assert.equal(h.api.snap().pendingActions.size, 0, "once the state shows the tab gone, the held action is finished");
  // the removal went through but its answer was lost: the first state shows the tab gone and nothing is sent twice
  const again = pageHarness();
  again.api.onMessage(again.state());
  let s2 = await again.open();
  again.api.holdAction({ type: "removeTab", tabId: "t1" }, "x", { type: "removeTab", tabId: "t1", hideTabId: "t1" });
  heldTimer(again.timers).fn();
  s2.close(); s2 = await again.open();
  again.api.onMessage(noTabs);
  assert.equal(s2.sent.filter((message: any) => message.type === "removeTab").length, 0, "a removal the server did apply is not sent a second time");
  assert.equal(again.api.snap().pendingActions.size, 0);
});

test("a step button stays Sending until the step moves, so a state already on its way cannot turn it back on and skip a step", async () => {
  const h = pageHarness();
  const steps = (current: number) => ({ derived: { stepBar: [{ stepId: "brief", state: current === 0 ? "current" : "done" }, { stepId: "build", state: current === 1 ? "current" : "todo" }, { stepId: "ship", state: "todo" }], busy: false } });
  h.api.onMessage(h.state(steps(0)));
  const socket = await h.open();
  const tab = h.state(steps(0)).projects[0].tabs[0];
  h.api.runProcessAction(tab, "advanceStep");
  h.api.onMessage(h.state(steps(0))); // a state that was already on its way
  h.api.runProcessAction(tab, "advanceStep");
  assert.equal(socket.sent.filter((message: any) => message.type === "advanceStep").length, 1, "the second click is ignored: the server has not acted yet");
  h.api.onMessage(h.state(steps(1)));
  assert.equal(h.api.snap().processPending.has("t1"), false, "the step moved: the button is free again");
  await new Promise((resolve) => setTimeout(resolve, 650)); // the next step's button ignores clicks for 600 ms after the step changes
  h.api.runProcessAction(h.state(steps(1)).projects[0].tabs[0], "advanceStep");
  assert.equal(h.api.snap().processPending.has("t1"), true);
  h.api.onMessage({ type: "error", action: "advanceStep", tabId: "t1", message: "no" });
  assert.equal(h.api.snap().processPending.has("t1"), false, "a refusal frees it too");
});

test("round 1 fix 17: a step button waits at most 5 s for a state; with no further state it is freed and redrawn", async () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ derived: { stepBar: [{ stepId: "brief", state: "current" }, { stepId: "build", state: "todo" }], busy: false } }));
  const socket = await h.open();
  const tab = h.state({ derived: { stepBar: [{ stepId: "brief", state: "current" }, { stepId: "build", state: "todo" }], busy: false } }).projects[0].tabs[0];
  h.api.runProcessAction(tab, "advanceStep");
  assert.equal(socket.sent.filter((message: any) => message.type === "advanceStep").length, 1);
  assert.equal(h.api.snap().processPending.has("t1"), true, "Sending while the server has not answered");
  const timer = h.timers.filter((entry) => entry.ms === 5_000 && !entry.cleared).at(-1);
  assert.ok(timer, "a 5 s timer was armed when the action was sent");
  timer.fn(); // five seconds pass with no state message at all
  assert.equal(h.api.snap().processPending.has("t1"), false, "the button is usable again");
  // a timer left over from an earlier click never frees a newer one
  h.api.runProcessAction(tab, "advanceStep");
  await new Promise((resolve) => setTimeout(resolve, 650));
  h.api.onMessage({ type: "error", action: "advanceStep", tabId: "t1", message: "no" }); // the answer came first
  h.api.runProcessAction(tab, "advanceStep");
  timer.fn();
  assert.equal(h.api.snap().processPending.has("t1"), true, "the old timer does not free the newer click");
});

test("round 1 fix 16: after pictures X, Y, X again, a message drawn earlier never shows the revoked picture URL", () => {
  const h = pageHarness();
  const png = (n: number) => `data:image/png;base64,${Buffer.from(`not really a picture ${n}`).toString("base64")}`;
  const message = (revision: number) => ({ role: "user", revision, text: "hi", at: 1 });
  const tabOf = (id: string) => ({ ...h.tab(), id });
  const src = (html: string) => /<img src="([^"]*)"[^>]*class="uav"/.exec(html)?.[1];
  h.api.setMe(png(1));
  const first = src(h.api.renderMessage(tabOf("t1"), message(1)));
  assert.match(first!, /^blob:/);
  h.api.setMe(png(2));
  h.api.renderMessage(tabOf("t2"), message(1)); // another tab is drawn while picture Y is set: this makes Y's URL and revokes X's
  h.api.setMe(png(1));
  const again = src(h.api.renderMessage(tabOf("t1"), message(1)));
  assert.equal(again, h.api.mePic(), "the first tab's message uses the URL that is current now");
  assert.notEqual(again, first, "not the one the later picture revoked");
});

test("round 1 fix 18: Clear on a tab whose chat cannot be read says it cannot be undone and makes no promise of Undo or a handover", () => {
  const h = pageHarness();
  const menus: any[][] = [];
  h.api.setMakeMenu((_pop: unknown, _anchor: unknown, items: any[]) => { menus.push(items); });
  h.api.onMessage(h.state({ chatProblem: "invalid chat transcript" }));
  h.api.clearConfirmMenu(null);
  const damaged = menus.at(-1)![0].hint as string;
  assert.equal(damaged, "Clear moves the damaged chat file aside as a copy and starts a fresh chat. This cannot be undone.");
  h.api.onMessage(h.state({}));
  h.api.clearConfirmMenu(null);
  assert.match(menus.at(-1)![0].hint, /You can undo for 10 seconds/, "an ordinary tab still gets the Undo hint");
});

test("choosing who fixes a round stays Sending until the server's choice shows, and a Stop all nobody answered is forgotten by a drop", async () => {
  const h = pageHarness();
  const maker = (slot: string) => ({ processState: { approval: { state: "none" }, selectedMakerSlotId: slot } });
  h.api.onMessage(h.state(maker("socialMedia")));
  const socket = await h.open();
  const tab = h.state(maker("socialMedia")).projects[0].tabs[0];
  h.api.runProcessAction(tab, "selectMarketingMaker", { slot: "image" });
  h.api.onMessage(h.state(maker("socialMedia"))); // a state already on its way: the choice has not been applied yet
  h.api.runProcessAction(tab, "selectMarketingMaker", { slot: "videoAndMotion" });
  assert.equal(socket.sent.filter((message: any) => message.type === "selectMarketingMaker").length, 1, "the second pick waits for the first to show");
  h.api.onMessage(h.state(maker("image")));
  assert.equal(h.api.snap().processPending.has("t1"), false, "the server's choice showed: free again");
  // Stop all: sent, never answered, then the connection drops
  h.api.onMessage(h.state({ runs: [h.run("r1")] }));
  h.api.stopAll();
  assert.ok(h.api.snap().stopAllTrack, "Stop all is being tracked");
  socket.close();
  assert.equal(h.api.snap().stopAllTrack, null, "a Stop all that was never accepted is forgotten when the connection drops");
});

test("a message over the server's 2 MiB limit (counted in bytes) is refused before it is sent, with a reason", async () => {
  const h = pageHarness();
  const socket = await h.open();
  const before = socket.sent.length;
  assert.equal(h.api.send({ type: "chat", text: "\u00e9".repeat(1_100_000) }), false, "2.2 MB of two-byte characters is over 2 MiB though it is under 2 million characters");
  assert.equal(h.api.send({ type: "chat", text: "x".repeat(2 * 1024 * 1024) }), false);
  assert.equal(socket.sent.length, before, "nothing reached the socket");
  assert.match(h.node("toast").textContent, /too large to send \(2 MiB at most\)/);
  assert.equal(h.api.send({ type: "chat", text: "\u00e9".repeat(1_000_000) }), true, "just under the limit still goes");
  assert.equal(socket.sent.length, before + 1);
});

test("the Usage panel names the leader's model for the leader's own CLI, not always as a Claude model", () => {
  const h = pageHarness();
  const shared = { claudeModels: [{ value: "shared-id", displayName: "Claude Shared Name" }] };
  const view = (cli: string) => {
    const lead = { slot: "leader", name: "Atlas", cli, model: "shared-id", effort: "low", isLeader: true, seatKey: "t1.leader" };
    h.api.onMessage(h.state({ crew: [lead] }, shared));
    h.api.renderUsage(h.state({ crew: [lead] }).projects[0].tabs[0]);
    return h.node("usage").innerHTML;
  };
  assert.match(view("claude"), /Claude Shared Name/);
  assert.doesNotMatch(view("codex"), /Claude Shared Name/);
  assert.match(view("codex"), /shared-id/);
});

test("MCP and plugin names are escaped inside data-focus-key, and a request card never shows a file chip or a hard-coded leader name", () => {
  const h = pageHarness();
  const html = h.api.skillBlock("claude", { mcpServers: [{ name: 'a"b' }], plugins: ['x"y'], skills: [], instructionFiles: [] });
  assert.match(html, /data-focus-key="mcp-remove-claude-a&quot;b"/);
  assert.match(html, /data-focus-key="plugin-remove-x&quot;y"/);
  h.api.onMessage(h.state());
  const card = h.api.requestCard({ id: "r", fromTabId: "t1", toTabId: "gone", title: "T", body: "B", status: "pending", files: ["a.md"], createdAt: Date.now() }, true);
  assert.doesNotMatch(card, /request-files|a\.md/);
  assert.doesNotMatch(card, /Atlas/);
  const renamed: any = h.state(); renamed.projects[0].tabs[0].crew[0].name = "Rowan"; h.api.onMessage(renamed);
  const handOver = h.api.requestCard({ id: "r2", fromTabId: "gone", toTabId: "t1", title: "T", body: "B", status: "pending", createdAt: Date.now() }, true);
  assert.match(handOver, /Hand to Dev's Rowan/, "the hand-over button names the destination leader's current name");
});

test("the page keeps the crew rail, Details and the theme in the server's prefs and never in localStorage, and shows the app only once the theme is known", () => {
  assert.doesNotMatch(appSource, /\blocalStorage\.|\blocalStorage\)|\.localStorage\b|getStored|setStored/, "the page reads and writes no localStorage");
  const h = pageHarness();
  assert.equal(h.api.snap().railWide, true); assert.equal(h.api.snap().sideOpen, false);
  assert.equal(h.bodyClasses.has("boot"), true, "until the first state the app is unpainted");
  h.api.onMessage(h.state({}, { clientPrefs: { crewRailOpen: false, detailsOpen: true } }));
  assert.equal(h.api.snap().railWide, false, "the server's crewRailOpen decides the rail"); assert.equal(h.api.snap().sideOpen, true, "the server's detailsOpen decides Details");
  assert.equal(h.bodyClasses.has("boot"), false, "the first state ends the unpainted start");
  assert.match(appSource, /setTimeout\(showApp, 3000\)/, "a 3 s fallback is armed at start-up for a server that never answers");
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  assert.match(index, /<body class="light boot">/);
});

test("the page's Content-Security-Policy allows only its own scripts, styles, images, fonts and connections, and index.html carries no inline script or handler", () => {
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(index)?.[1] ?? "";
  assert.ok(policy, "the page declares a policy");
  const directives = new Map(policy.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(" ")]));
  assert.equal(directives.get("default-src"), "'none'");
  assert.equal(directives.get("script-src"), "'self'", "no inline script, no eval");
  assert.equal(directives.get("font-src"), "'self'");
  assert.equal(directives.get("img-src"), "'self' data: blob:", "pictures: the page's own, data URLs for the favicon, blob for the uploaded picture");
  assert.match(directives.get("connect-src") ?? "", /^'self' ws:\/\/127\.0\.0\.1:\* ws:\/\/localhost:\*$/);
  assert.equal(directives.get("base-uri"), "'none'"); assert.equal(directives.get("form-action"), "'none'");
  assert.doesNotMatch(index, /<script(?![^>]*\bsrc=)[^>]*>/i, "no inline <script>");
  assert.doesNotMatch(index, /\son(?:click|load|error|submit|change|input)\s*=/i, "no inline event handler");
  assert.doesNotMatch(appSource, /\beval\(|new Function\(/);
  const css = readFileSync(join(publicDir, "style.css"), "utf8");
  assert.doesNotMatch(css, /--ring/, "the unused --ring token is gone");
  assert.match(/\.att\.err\{[^}]*\}/.exec(css)![0], /var\(--danger-text\)/);
  assert.doesNotMatch(/\.att\.err\{[^}]*\}/.exec(css)![0], /#f4c7c3/, "no fixed light pink");
});

test("final review 5: dismissed failure cards stay dismissed with 201 retained failures across five tabs (41+41+41+41+37), and the page and server caps both hold every retained run", async () => {
  const h = pageHarness();
  const socket = await h.open();
  const counts = [41, 41, 41, 41, 37];
  const tabs = counts.map((count, t) => h.tab({ id: `t${t + 1}`, runs: Array.from({ length: count }, (_, i) => h.run(`r${t}-${i}`, { status: "failed" })) }));
  const ids = tabs.flatMap((tab: any) => tab.runs.map((run: any) => run.runId));
  assert.equal(ids.length, 201);
  const message: any = h.state({}, { clientPrefs: { dismissedRuns: ids } });
  message.projects[0].tabs = tabs;
  h.api.onMessage(message);
  socket.sent.length = 0;
  h.api.saveDismissed();
  const sent = socket.sent.filter((item: any) => item.type === "updateClientPref" && item.key === "dismissedRuns");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].value, ids, "every retained dismissal is kept, the oldest included");
  assert.match(appSource, /const DISMISSED_RUNS_MAX = (\d+);/);
  assert.ok(Number(/const DISMISSED_RUNS_MAX = (\d+);/.exec(appSource)![1]) >= 50 * 40, "the page cap holds 50 runs for 40 tabs");
});

test("final review 6: clicking the same saved run again within 15 s is not cancelled by the first click's timeout", async () => {
  const h = pageHarness();
  await h.open();
  const key = "t1.coder", handlers: Array<() => void> = [];
  const button: any = { dataset: { historyTimestamp: "5" }, addEventListener: (_name: string, fn: () => void) => handlers.push(fn), removeAttribute() {}, setAttribute() {}, querySelector: () => null };
  const view: any = { querySelector: () => null, querySelectorAll: (selector: string) => selector === "[data-history-timestamp]" ? [button] : [] };
  h.api.bindHistoryView(view, h.tab(), h.tab().crew[1], key);
  assert.equal(handlers.length, 1);
  const before = h.timers.length;
  handlers[0](); handlers[0]();
  const waits = h.timers.slice(before).filter((timer) => timer.ms === 15_000);
  assert.equal(waits.length, 2, "each click arms its own timeout");
  waits[0].fn();
  assert.equal(h.api.snap().historyRunRequested.get(key), 5, "the older click's timeout leaves the newer request standing");
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 5, outcome: "done", output: "log", totalBytes: 3 });
  assert.equal(h.api.snap().historyDetails.has(key + ":5"), true, "and its reply still shows");
  waits[1].fn();
  assert.equal(h.api.snap().historyDetails.has(key + ":5"), true);
});

test("final review 7: a stale Check again error or an untagged settingsRefreshed does not settle a newer refresh; only its own requestId does", () => {
  const h = pageHarness();
  h.api.onMessage(h.state());
  h.api.setRefresh({ status: "running", at: 0, requestId: "new" });
  h.api.onMessage({ type: "error", action: "refreshSettings", requestId: "old", message: "stale" });
  assert.equal(h.api.snap().refreshState.status, "running", "an error for an older request leaves the newer refresh running");
  h.api.onMessage({ type: "settingsRefreshed" });
  assert.equal(h.api.snap().refreshState.status, "running", "an untagged settingsRefreshed does not end a refresh that carries a requestId");
  h.api.onMessage({ type: "actionResult", action: "refreshSettings", requestId: "new" });
  assert.equal(h.api.snap().refreshState.status, "done", "the matching reply ends it");
  h.api.setRefresh({ status: "running", at: 0, requestId: "next" });
  h.api.onMessage({ type: "error", action: "refreshSettings", requestId: "next", message: "failed" });
  assert.equal(h.api.snap().refreshState.status, "failed");
});

test("final review 8: the Claude model picker says a change made during an answer waits for the answer to end", () => {
  const h = pageHarness();
  const claude = h.api.pickerHints({ isLeader: true, cli: "claude" });
  assert.match(claude, /A model change applies right away, or after the current answer if one is running\./);
  assert.match(h.api.pickerHints({ isLeader: true, cli: "codex" }), /A model change applies from the next turn./);
});

function historyBinding(h: any, key: string) {
  const handlers: Record<string, () => void> = {};
  const button: any = { dataset: { historyTimestamp: "5" }, addEventListener: (_n: string, fn: () => void) => { handlers.run = fn; }, removeAttribute() {}, setAttribute() {}, querySelector: () => null };
  const full: any = { dataset: { fullTimestamp: "7" }, addEventListener: (_n: string, fn: (event: any) => void) => { handlers.full = () => fn({ currentTarget: full }); } };
  const view: any = { querySelector: (selector: string) => selector === "[data-full-log]" ? full : null, querySelectorAll: (selector: string) => selector === "[data-history-timestamp]" ? [button] : [] };
  h.api.bindHistoryView(view, h.tab(), h.tab().crew[1], key);
  return handlers;
}

test("scoped round 1: a saved-run click whose send fails leaves the earlier request and its timer as they were, and a timeout clears an unanswered request", async () => {
  const h = pageHarness();
  const socket = await h.open();
  const key = "t1.coder", handlers = historyBinding(h, key);
  const before = h.timers.length;
  handlers.run();
  const wait = h.timers.slice(before).filter((timer: any) => timer.ms === 15_000);
  assert.equal(wait.length, 1);
  assert.equal(h.api.snap().historyRunTokens.has(key), true, "the request records its token");
  socket.readyState = 3; handlers.run(); socket.readyState = 1;
  assert.equal(h.timers.slice(before).filter((timer: any) => timer.ms === 15_000).length, 1, "the failed click armed no timer");
  wait[0].fn();
  assert.equal(h.api.snap().historyRunRequested.has(key), false, "the first request's timer still clears the unanswered request");
});

test("scoped round 1: a fuller-log request has its own token (an older timer cannot clear a newer one) and a failed send changes nothing", async () => {
  const h = pageHarness();
  const socket = await h.open();
  const key = "t1.coder", handlers = historyBinding(h, key), detailKey = `${key}:7`;
  socket.readyState = 3; handlers.full(); socket.readyState = 1;
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), false, "a failed send leaves no pending fuller log");
  assert.equal(h.api.snap().historyRunRequested.has(key), false, "and no pending saved run");
  const before = h.timers.length;
  handlers.full();
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 7, outcome: "done", output: "log", totalBytes: 3, truncated: true });
  handlers.full();
  const waits = h.timers.slice(before).filter((timer: any) => timer.ms === 15_000);
  assert.equal(waits.length, 2);
  waits[0].fn();
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), true, "the older request's timer leaves the newer one pending");
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 7, outcome: "done", output: "log", totalBytes: 3, truncated: true, full: true });
  assert.equal(h.api.snap().historyDetails.get(detailKey).full, true, "the newer reply is shown as the fuller log");
});

function historyBinding7(h: any, key: string) {
  const handlers: Record<string, () => void> = {};
  const button: any = { dataset: { historyTimestamp: "7" }, addEventListener: (_n: string, fn: () => void) => { handlers.run = fn; }, removeAttribute() {}, setAttribute() {}, querySelector: () => null };
  const full: any = { dataset: { fullTimestamp: "7" }, addEventListener: (_n: string, fn: (event: any) => void) => { handlers.full = () => fn({ currentTarget: full }); } };
  const back: any = { addEventListener: (_n: string, fn: () => void) => { handlers.back = fn; } };
  const view: any = { querySelector: (selector: string) => selector === "[data-full-log]" ? full : selector === "[data-back-history]" ? back : null, querySelectorAll: (selector: string) => selector === "[data-history-timestamp]" ? [button] : [] };
  h.api.bindHistoryView(view, h.tab(), h.tab().crew[1], key);
  return handlers;
}

test("scoped round 2: a fuller-log reply that arrives after its timer fired is still shown as the fuller log (the label comes from the reply)", async () => {
  const h = pageHarness();
  await h.open();
  const key = "t1.coder", handlers = historyBinding7(h, key), detailKey = `${key}:7`;
  const before = h.timers.length;
  handlers.full();
  h.timers.slice(before).filter((timer: any) => timer.ms === 15_000)[0].fn();
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), false, "the timer cleared the pending marker");
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 7, outcome: "done", output: "log", totalBytes: 3, truncated: true, full: true });
  assert.equal(h.api.snap().historyDetails.get(detailKey).full, true, "the late fuller reply is labelled as the fuller log");
});

test("scoped round 2: Back clears the fuller-log marker, so reopening the run shows its short reply as short", async () => {
  const h = pageHarness();
  await h.open();
  const key = "t1.coder", handlers = historyBinding7(h, key), detailKey = `${key}:7`;
  handlers.run();
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 7, outcome: "done", output: "log", totalBytes: 3, truncated: true, full: false });
  handlers.full();
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), true);
  handlers.back();
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), false, "Back clears the run's fuller-log marker");
  handlers.run();
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 7, outcome: "done", output: "log", totalBytes: 3, truncated: true, full: false });
  assert.equal(h.api.snap().historyDetails.get(detailKey).full, false, "the reopened run's short reply is labelled short");
});

test("scoped round 2: a fuller-log request's own timer clears it when no reply comes", async () => {
  const h = pageHarness();
  await h.open();
  const key = "t1.coder", handlers = historyBinding7(h, key), detailKey = `${key}:7`;
  const before = h.timers.length;
  handlers.full();
  const waits = h.timers.slice(before).filter((timer: any) => timer.ms === 15_000);
  assert.equal(waits.length, 1);
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), true);
  waits[0].fn();
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), false, "its own timer cleared the unanswered request");
});

// ---- fix pack 3, block 2: page behaviour that had no test ----

test("Stop all: the toasts say what was asked, what the server accepted, and how the runs ended (all exited, some not confirmed, or none were working)", async () => {
  const live = (...ids: string[]) => ids.map((id) => ({ ...(pageHarness().run(id)) }));
  const toast = (h: ReturnType<typeof pageHarness>) => h.node("toast").textContent as string;
  const activityTexts = (h: ReturnType<typeof pageHarness>) => plain(h.api.snap().activity.map((item: any) => item.text));
  // Every run exits.
  const h = pageHarness();
  h.api.onMessage(h.state({ derived: { stepBar: [], busy: true }, runs: live("r1", "r2") }));
  const socket = await h.open();
  h.api.stopAll();
  assert.equal(socket.sent.filter((message: any) => message.type === "stopAll").length, 1);
  assert.equal(toast(h), "Asking the server to stop everything in every tab…");
  h.api.onMessage({ type: "stopAllAccepted" });
  assert.equal(toast(h), "Stop accepted; waiting for exits: 2 runs in 1 tab");
  h.api.onMessage(h.state({ runs: [{ ...h.run("r1"), status: "stopped" }, h.run("r2")] }));
  assert.equal(toast(h), "Stop accepted; waiting for exits: 2 runs in 1 tab", "one run still working: no final report yet");
  h.api.onMessage(h.state({ runs: [{ ...h.run("r1"), status: "stopped" }, { ...h.run("r2"), status: "stopped" }] }));
  assert.equal(toast(h), "Stop sent: all 2 runs exited. Leaders were told to stop");
  assert.deepEqual(activityTexts(h).slice(0, 2), ["Stop all: every run exited", "Stop all accepted: waiting for runs to exit"]);
  assert.equal(h.api.snap().stopAllTrack, null, "reported once");
  // One run never confirms its exit: the report says so and where to go.
  const u = pageHarness();
  u.api.onMessage(u.state({ derived: { stepBar: [], busy: true }, runs: live("r1", "r2") }));
  await u.open();
  u.api.stopAll(); u.api.onMessage({ type: "stopAllAccepted" });
  u.api.onMessage(u.state({ runs: [{ ...u.run("r1"), status: "stopped" }, u.run("r2")] }, { launchSafety: { notices: [], uncertain: [{ seatKey: "t1.coder", runId: "r2", pid: 99 }] } }));
  assert.equal(toast(u), "Stop all: 1 run exited, 1 not confirmed and may still be running. Needs you has Try again and Release");
  assert.equal(activityTexts(u)[0], "Stop all: 1 run exited, 1 not confirmed");
  // Nothing was working: accepted at once and said so.
  const n = pageHarness();
  n.api.onMessage(n.state({ derived: { stepBar: [], busy: true }, runs: [] }));
  await n.open();
  n.api.stopAll(); n.api.onMessage({ type: "stopAllAccepted" });
  assert.equal(toast(n), "Stop sent to 1 tab. No runs were working");
  assert.equal(n.api.snap().stopAllTrack, null);
});

test("Match my PC: the page follows the PC's light or dark setting, saves the choice as theme system, and takes it from the server on a fresh page", async () => {
  const h = pageHarness();
  const socket = await h.open();
  h.media.light = true;
  h.api.setTheme("system");
  assert.deepEqual(socket.sent.filter((message: any) => message.type === "updateClientPref" && message.key === "theme").map((message: any) => message.value), ["system"], "the choice is saved as 'system', not as light or dark");
  assert.equal(h.bodyClasses.has("light"), true, "a light PC gives the light look");
  assert.ok(h.media.listeners.length > 0, "the page registers a change listener on the PC's colour scheme");
  h.media.light = false; h.media.change(); // the PC switched to dark: nothing else reaches the page, so only the registered listener can move the theme
  assert.equal(h.bodyClasses.has("light"), false, "a dark PC gives the dark look");
  h.media.light = true; h.media.change();
  assert.equal(h.bodyClasses.has("light"), true, "and light again");
  // A fresh page that is handed 'system' by the server reads the PC; a fixed choice ignores it.
  for (const [pcLight, theme, expectLight] of [[true, "system", true], [false, "system", false], [true, "dark", false], [false, "light", true]] as const) {
    const fresh = pageHarness();
    fresh.media.light = pcLight;
    fresh.api.onMessage(fresh.state({}, { clientPrefs: { theme } }));
    assert.equal(fresh.bodyClasses.has("light"), expectLight, `PC ${pcLight ? "light" : "dark"}, server theme ${theme}: ${expectLight ? "light" : "dark"} look`);
  }
});

test("a message's time label is the clock time of its `at`, for the leader and for you, and no label without one", () => {
  const h = pageHarness();
  h.api.onMessage(h.state());
  const tab = h.tab();
  const at = new Date(2026, 0, 2, 9, 5).getTime();
  assert.match(h.api.renderMessage(tab, { role: "assistant", text: "hello", revision: 1, at }), /<span class="meta"><b>Atlas<\/b>09:05<\/span>/, "the leader's message carries its time after the name");
  assert.match(h.api.renderMessage(tab, { role: "user", text: "hello", revision: 2, at: at + 60_000 }), /<span class="meta">09:06 <b>You<\/b><\/span>/, "your message carries its time before your name");
  assert.match(h.api.renderMessage(tab, { role: "assistant", text: "no stamp", revision: 3 }), /<span class="meta"><b>Atlas<\/b><\/span>/, "a message with no `at` shows no time");
});

// ---- pack 3: page behaviour that no test pinned yet ----

test("pack 3: a stalled worker's desktop notice says what happens next", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ runs: [h.run("r1")] }));
  h.api.onMessage({ type: "runStalled", tabId: "t1", seatKey: "t1.coder", runId: "r1", action: "escalate" });
  assert.deepEqual(h.notifications, [{ title: "Sonny is stalled", body: "Check the run before it can continue." }]);
  h.api.onMessage({ type: "runStalled", tabId: "t1", seatKey: "t1.coder", runId: "r1", action: "relaunch" });
  assert.equal(h.notifications.at(-1)?.body, "No output for 5 minutes. It is being stopped and started once more.");
});

test("pack 3: the crew rail starts open when the server has no crewRailOpen pref, and follows it once there is one", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({}, { clientPrefs: {} }));
  assert.equal(h.api.snap().railWide, true);
  h.api.onMessage(h.state({}, { clientPrefs: { crewRailOpen: false } }));
  assert.equal(h.api.snap().railWide, false);
  h.api.onMessage(h.state({}, { clientPrefs: {} }));
  assert.equal(h.api.snap().railWide, true, "removing the pref goes back to open");
});

test("pack 3: a streamed reply follows the bottom only while the reader is at the bottom", () => {
  const frames: (() => void)[] = [];
  const h = pageHarness({ raf: (fn) => { frames.push(fn); return frames.length; } });
  h.api.onMessage(h.state());
  const paragraph = { innerHTML: "" }, view = h.node("view");
  Object.assign(view, { dataset: { tabId: "t1", mode: "chat" }, scrollHeight: 1000, clientHeight: 400, scrollTop: 100, querySelector: (selector: string) => selector === "[data-stream] .md" ? paragraph : null });
  const delta = (text: string) => { h.api.onMessage({ type: "chatDelta", tabId: "t1", text }); frames.splice(0).forEach((frame) => frame()); };
  delta("first ");
  assert.equal(paragraph.innerHTML, "<p>first </p>", "the delta is painted");
  assert.equal(view.scrollTop, 100, "a reader scrolled up (500 px from the bottom) is left where they are");
  view.scrollTop = 596; // exactly 4 px from the bottom: still counts as at the bottom
  delta("second");
  assert.equal(paragraph.innerHTML, "<p>first second</p>");
  assert.equal(view.scrollTop, 1000, "a reader at the bottom follows the stream");
  view.scrollTop = 595; // 5 px from the bottom: no longer at the bottom
  delta(" third");
  assert.equal(view.scrollTop, 595);
});

test("pack 3: the leader's context meter reads the leader's usage, not a worker's, and a window of 0 is not reported", () => {
  const h = pageHarness();
  const tab = (over: object) => ({ runs: [{ usage: { contextTokens: 50_000 } }], ...over });
  assert.equal(h.api.real.contextLine(tab({ leaderUsage: { contextTokens: 1000, contextWindow: 200_000 } })), "0.5% of 200k (estimate from the last turn)", "1000 of 200000 from the leader, not 50000 from the worker");
  assert.equal(h.api.real.contextLine(tab({ leaderUsage: { contextTokens: 1000, contextWindow: 0 } })), "not reported yet", "a window of exactly 0");
  assert.equal(h.api.real.contextLine(tab({ leaderUsage: { contextTokens: 1000, contextWindow: null } })), "not reported yet");
  assert.equal(h.api.real.contextLine(tab({ leaderUsage: { contextTokens: null, contextWindow: 200_000 } })), "not reported yet");
});

test("pack 3: the plan-limit meters skip a window that reports no usable percent", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ runs: [h.run("r1", { cli: "claude" })] }));
  h.api.onMessage({ type: "rateLimit", tabId: "t1", runId: "r1", windows: { five_hour: { utilization: 0.5 }, seven_day: { note: "none" }, empty: { limit: 0, used: 3 } } });
  h.api.real.renderMeters();
  const html = h.node("meters").innerHTML as string;
  assert.equal(html.match(/class="meter"/g)?.length, 1, "only the window with a percent gets a row");
  assert.match(html, /Five hour/);
  assert.match(html, /<b>50%<\/b>/);
  assert.doesNotMatch(html, /Seven day|Empty|<b>0%<\/b>/);
});

test("pack 3: the details panel width is kept between 280 and 560, when read and when a drag is saved", async () => {
  const h = pageHarness();
  const width = (value: number) => { h.api.onMessage(h.state({}, { clientPrefs: { rightPanelWidth: value } })); return h.api.real.sideWidth(); };
  assert.equal(width(100), 280, "below the minimum");
  assert.equal(width(900), 560, "above the maximum");
  assert.equal(width(400), 400, "control: inside the limits it is kept");
  h.api.onMessage(h.state());
  const socket = await h.open();
  h.api.real.saveSideWidth(100);
  h.api.real.saveSideWidth(900);
  h.api.real.saveSideWidth(480);
  const sent = socket.sent.filter((message: any) => message.type === "updateClientPref" && message.key === "rightPanelWidth").map((message: any) => message.value);
  assert.deepEqual(sent, [280, 560, 480]);
});

test("pack 3: a crew picture preset the page does not know falls back to the seat's own default", () => {
  const h = pageHarness();
  const seat = (pic?: string) => ({ slot: "coder", name: "Sonny", pic });
  assert.equal(h.api.real.avatarKeyFor(seat("/avatars/vera.svg")), "vera", "a known preset is kept");
  assert.equal(h.api.real.avatarKeyFor(seat("/avatars/zzzz.svg")), "sonny", "an unknown name gives the slot's default");
  assert.equal(h.api.real.seatPic(seat("/avatars/zzzz.svg")), "/avatars/sonny.svg");
});

test("pack 3: a stalled run is still a live run, so its Stop shows and the seat says Stop requested", async () => {
  const h = pageHarness();
  const stalledRun = h.run("r1", { stalled: true });
  h.api.onMessage(h.state({ runs: [stalledRun], crew: h.tab().crew.map((seat: any) => seat.slot === "coder" ? { ...seat, status: "stalled" } : seat) }));
  const tab = h.state({ runs: [stalledRun], crew: h.tab().crew.map((seat: any) => seat.slot === "coder" ? { ...seat, status: "stalled" } : seat) }).projects[0].tabs[0];
  const coder = tab.crew.find((seat: any) => seat.slot === "coder");
  assert.equal(h.api.real.liveRuns(tab, coder).length, 1, "the stalled run is listed as live");
  assert.equal(h.api.real.seatLine(tab, coder).text, "Stalled: no output");
  await h.open();
  h.api.killRun("r1");
  assert.equal(h.api.real.seatLine(tab, coder).text, "Stop requested…", "Stop on a stalled run is shown on the seat");
});

test("pack 3: the model list always offers the seat's own saved model, even when the server's list lacks it", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({}, { modelOptions: { claude: ["claude-opus-5-5[1m]"], codex: ["gpt-6-sol"] }, effortOptions: { claude: ["low", "high"], codex: ["low"] }, settings: {} }));
  const rows = h.api.real.modelRows({ cli: "codex", model: "gpt-6-old-model" }, "");
  assert.match(rows, /data-model="gpt-6-old-model"/, "the saved model is listed");
  assert.match(rows, /data-model="gpt-6-sol"/, "and so are the server's");
  assert.match(h.api.real.modelRows({ cli: "codex", model: "gpt-6-sol" }, ""), /data-model="gpt-6-sol"/, "control: a listed model is not doubled");
  assert.equal(h.api.real.modelRows({ cli: "codex", model: "gpt-6-sol" }, "").match(/data-model="gpt-6-sol"/g)?.length, 1);
});

test("pack 3: a Claude model with no effort level shows no effort in its line and no effort row in the picker", () => {
  const h = pageHarness();
  const claudeModels = [{ value: "claude-haiku-4-5", displayName: "Haiku", supportsEffort: false }, { value: "sonnet", displayName: "Sonnet", supportsEffort: true }];
  h.api.onMessage(h.state({}, { modelOptions: { claude: claudeModels.map((model) => model.value) }, claudeModels, effortOptions: { claude: ["low", "high"] } }));
  assert.doesNotMatch(h.api.real.modelLine("claude", "claude-haiku-4-5", "high"), /· high/, "no effort level on the line");
  assert.match(h.api.real.modelLine("claude", "sonnet", "high"), /· high$/, "control: a model with effort shows it");
  const seat = (model: string) => ({ slot: "coder", name: "Sonny", cli: "claude", model, effort: "high" });
  const tab = { id: "t1" };
  h.api.real.drawModelPicker(tab, seat("claude-haiku-4-5"), null, false);
  assert.match(h.node("pop").innerHTML, /has no effort setting/);
  assert.doesNotMatch(h.node("pop").innerHTML, /data-effort=/);
  h.api.real.drawModelPicker(tab, seat("sonnet"), null, false);
  assert.match(h.node("pop").innerHTML, /data-effort="high"/);
  assert.doesNotMatch(h.node("pop").innerHTML, /has no effort setting/);
});

// The stylesheet and markup are read as the browser would match them: a rule applies to a selector in its list, so a selector dropped from the list is a rule lost.
function cssRules(css: string): { selectors: string[]; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selectors: match[1].split(",").map((part) => part.trim()), body: match[2] }));
}
const stylesheet = readFileSync(join(publicDir, "style.css"), "utf8");

test("pack 3: the stalled dot has the waiting colour, a crew picture is cropped to fill its box, and the open rail turns its arrow", () => {
  const rules = cssRules(stylesheet);
  const bodyOf = (selector: string, needle: RegExp) => rules.filter((rule) => rule.selectors.includes(selector) && needle.test(rule.body));
  assert.equal(bodyOf(".dot.stalled", /background:var\(--waiting\)/).length, 1, "a stalled seat's dot takes the waiting background");
  assert.equal(bodyOf(".dot.waiting", /background:var\(--waiting\)/).length, 1, "control: the waiting dot does too");
  assert.equal(bodyOf(".av img", /object-fit:cover/).length, 1, "a crew picture is fitted with cover");
  assert.equal(bodyOf("#stage.wide .rtg svg", /transform:rotate\(180deg\)/).length, 1, "the open rail's arrow is turned");
});

test("pack 3: the crew rail toggle draws its arrow as the page's own svg, not a text character", () => {
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  const button = /<button class="rtg" id="railBtn"[^>]*>([\s\S]*?)<\/button>/.exec(index)?.[1] ?? "";
  assert.match(button, /<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5\.2 3\.2 9 7l-3\.8 3\.8"/);
  assert.doesNotMatch(button, /&raquo;|&laquo;|[»«]/);
});
