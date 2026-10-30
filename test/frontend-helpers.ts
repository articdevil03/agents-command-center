import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { appSource as readAppSource } from "./source-text.ts";

export const publicDir = join(process.cwd(), "public");

// ---- pack 1 block 3 ----

export const appSource = readAppSource().replaceAll("\r\n", "\n");
// The model and advisor menus moved to their own file; the page loads it before app.js, and so does pageHarness.
export const pickerSource = readFileSync(join(publicDir, "model-picker.js"), "utf8").replaceAll("\r\n", "\n");

// ---- pack 18: the server's CLI list (state.clis, one CliCap per CLI) and a way to drive the page's own DOM code against a stub ----
export const CLIS = [
  { id: "claude", label: "Claude Code", advisor: true, readOnlyEnforced: true, crewTools: true, customModel: null, installed: true, models: ["claude-opus-5-5[1m]", "claude-sonnet-5-5[1m]"], efforts: ["low", "medium", "high"] },
  { id: "codex", label: "Codex", advisor: false, readOnlyEnforced: false, crewTools: true, customModel: "^gpt-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$", installed: true, models: ["gpt-6.1-sol"], efforts: ["low", "medium", "high"] },
  { id: "opencode", label: "OpenCode", advisor: false, readOnlyEnforced: true, crewTools: true, customModel: "^[A-Za-z0-9._-]+\\/[A-Za-z0-9._/-]+$", installed: true, models: ["deepseek/deepseek-flash"], efforts: ["low", "high"] },
  { id: "acp:kimi", label: "Kimi", advisor: false, readOnlyEnforced: false, crewTools: true, customModel: null, installed: true, models: ["default"], efforts: ["default"] },
  { id: "acp:oracle", label: "Oracle", advisor: true, readOnlyEnforced: false, crewTools: true, customModel: null, installed: true, models: ["default"], efforts: ["default"] },
  { id: "acp:bare", label: "Bare", advisor: false, readOnlyEnforced: false, crewTools: false, customModel: null, installed: true, models: ["default"], efforts: ["default"] },
];
// The page asks a stub element for its buttons with querySelectorAll("[data-x]"): this answers from the html the page just wrote, one fake button per tag, each keeping the click handlers the page adds.
export function wireNode(node: any) {
  const made: any[] = [];
  node.querySelectorAll = (selector: string) => {
    const found: any[] = [];
    for (const attr of selector.split(",").map((part) => /^\[(data-[a-z-]+)\]$/.exec(part.trim())?.[1]).filter(Boolean)) {
      for (const match of String(node.innerHTML).matchAll(new RegExp(`<button\\b[^>]*\\b${attr}="[^"]*"[^>]*>`, "g"))) {
        const attrs: Record<string, string> = Object.fromEntries([...match[0].matchAll(/([a-z-]+)="([^"]*)"/g)].map((pair) => [pair[1], pair[2]]));
        const dataset: Record<string, string> = Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase()), value]));
        const handlers: (() => void)[] = [];
        found.push({ dataset, handlers, disabled: /\sdisabled(?=[\s>=])/.test(match[0]), getAttribute: (name: string) => attrs[name] ?? null, setAttribute() {}, addEventListener: (_name: string, fn: () => void) => handlers.push(fn), click() { handlers.forEach((fn) => fn()); } });
      }
    }
    made.push(...found);
    return found;
  };
  return { find: (key: string, value: string) => made.filter((item) => item.dataset[key] === value).at(-1), all: () => made };
}

// ---- fix pack 2, block 3: the page's behaviour, driven through onMessage / the page's own functions (no browser) ----

// Runs app.js up to its start-up lines, with a stub DOM, a fake WebSocket, a captured Notification and captured timers.
export function pageHarness(options: { raf?: (fn: () => void) => number } = {}) {
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, value: "", textContent: "", innerHTML: "", hidden: false, disabled: false, dataset: {}, options: [], style: { setProperty() {} },
      classList: { contains: () => false, toggle() {}, add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, removeAttribute() {},
      getAttribute: () => null, focus() {}, closest: () => null, matches: () => false, append() {}, replaceChildren() {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) });
    return nodes.get(id);
  };
  const closeAnswers: string[] = [];
  const pageWindow: any = { cc: { appKey: async () => "k".repeat(64), answerClose: (answer: string) => closeAnswers.push(answer) } };
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
  pageWindow.Notification = FakeNotification;
  const end = appSource.lastIndexOf("  bindEvents();");
  assert.ok(end > 0, "the start-up boundary is found");
  // bindEvents() is not run here, so the page's real PC-colour-scheme listener line is lifted out of the source and registered with the page's own functions.
  const mediaListenerLine = appSource.split(String.fromCharCode(10)).find((line) => line.includes('matchMedia("(prefers-color-scheme: light)").addEventListener'))?.trimEnd();
  assert.ok(mediaListenerLine, "the page's colour-scheme change listener is found in app.js");
  const api = runInNewContext(`${pickerSource}
${appSource.slice(0, end)}
    const confirmCalls = [];
    ${mediaListenerLine}
    // The page's own functions, taken before the stubs below replace the renderers: pack 3 tests call them with the state onMessage built.
    const real = { seatLine, liveRuns, avatarKeyFor, seatPic, sideWidth, saveSideWidth, contextLine, renderMeters, modelRows, modelLine, drawModelPicker, renderToolApproval, renderSettings, renderPipe, renderSeatCard, openAdvisor, processMenu, settingsCrewSection, stepActions, lookCard, accessText, readOnlyWarning, attentionCard, pickerClis, openAddTab, createTab };
    confirmAction = (options, callback, opener, onCancel) => { confirmCalls.push({ ...options, callback, onCancel }); };
    renderAll = renderStage = renderSide = renderSettings = renderUndo = renderInbox = renderCrew = renderHeader = renderToolApproval = renderMeters = renderTabs = renderStatusLine = renderChatIfShown = () => {};
    return {
      real, onMessage, connect, send, answerCloseRequest, renderChat, confirmCalls, killRun, stopAll, holdAction, runProcessAction, requestHistory, renderUsage, skillBlock, requestCard, approvalTitle, showApp, saveDismissed, pickerHints, bindHistoryView, mePic, renderMessage, clearConfirmMenu, setTheme, applyTheme,
      setMe: (av) => { me = { av }; }, setRefresh: (value) => { refreshState = value; }, setMakeMenu: (fn) => { makeMenu = fn; }, setLayers: () => { openPopover = () => {}; openModal = () => {}; },
      snap: () => ({ historyRunRequested, historyDetails, historyRunTokens, historyFullRequested, outputByRun, activity, stopStates, killOrder, processPending, historyInFlight, historyFailed, transcriptRequests, pendingActions, stallActions, refreshState, stopAllTrack, clientPrefOverrides, railWide, sideOpen, seenNotices }),
    };
  })()`, {
    document: { getElementById: node, querySelectorAll: () => [], querySelector: () => null, activeElement: null, hasFocus: () => false, body: { classList: { remove: (name: string) => bodyClasses.delete(name), toggle: (name: string, on?: boolean) => { if (on === false || (on === undefined && bodyClasses.has(name))) bodyClasses.delete(name); else bodyClasses.add(name); }, add: (name: string) => bodyClasses.add(name) } } },
    window: pageWindow, Notification: FakeNotification, WebSocket: FakeWebSocket,
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
  return { api, closeAnswers, sockets, notifications, timers, bodyClasses, media, open, tab, state, run, node, window: pageWindow };
}
// A held action's timer runs for max(0, dueAt - Date.now()), so it is 10 s less the milliseconds that passed since it was held (9999 is common): found by being the last live timer of about 10 s, never by an exact count.
export function heldTimer(timers: { fn: () => void; ms: number; cleared: boolean }[]) {
  const held = timers.filter((timer) => !timer.cleared && timer.ms >= 9000 && timer.ms <= 10000).at(-1);
  assert.ok(held, `a live timer of about 10 s exists among ${JSON.stringify(timers.filter((timer) => !timer.cleared).map((timer) => timer.ms))}`);
  return held;
}
export const plain = (value: unknown) => JSON.parse(JSON.stringify(value)); // values built inside the page's context are not reference-equal to ours
export const noTabs = { type: "state", projects: [{ id: "p1", name: "P", folder: "C:/p", tabs: [] }], selectedTabId: null, clientPrefs: {}, requests: [], launchSafety: { notices: [] }, settings: {} };


// ---- pack 18, block 3a: the page works from the server's setups (state.clis, tab.steps, templates), driven through onMessage and the page's own render functions ----

// A crew of every kind of seat the setups can hold: a leader and a planner on Claude, a coder, a Codex reviewer and fixer, an ACP read-only seat and an ACP writing seat.
export function p18Crew(): any[] {
  const seat = (slot: string, name: string, cli: string, over: Record<string, unknown> = {}) => ({ slot, name, cli, model: cli === "claude" ? "claude-opus-5-5[1m]" : cli === "codex" ? "gpt-6.1-sol" : "default", effort: "medium", canWrite: false, isLeader: false, role: slot, seatKey: `t1.${slot}`, ...over });
  return [
    seat("leader", "Atlas", "claude", { isLeader: true, role: "Leader", advisor: "claude-fable-5-1" }),
    seat("planner", "Sage", "claude", { role: "Planner", advisor: "claude-fable-5-1", orchestrates: true }),
    seat("coder", "Sonny", "claude", { role: "Coder", model: "claude-sonnet-5-5[1m]", canWrite: true }),
    seat("reviewer1", "Vera", "codex", { role: "Reviewer 1" }),
    seat("fixer1", "Juno", "codex", { role: "Fixer 1", canWrite: true }),
    seat("kimi", "Kim", "acp:kimi", { role: "Researcher" }),
    seat("oracle", "Ora", "acp:oracle", { role: "Writer", canWrite: true }),
  ];
}
export const P18_CLAUDE_MODELS = [{ value: "claude-opus-5-5[1m]", displayName: "Opus 5.5" }, { value: "claude-fable-5-1", displayName: "Fable 5.1", supportsEffort: false }];
