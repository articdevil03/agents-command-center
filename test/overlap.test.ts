import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { newAppKey, keyedWsUrl } from "./temp-root.ts";
import { getProcessDefinition } from "../server/process.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";

// Overlap audit: every screen and state below is built from long data on purpose (60-char names, 200-char
// paths, a 300-char unbroken string) and checked in a real headless Chrome. Visible text ranges and visible
// interactive boxes must never intersect by more than 1px, and text must never be cut off without an ellipsis
// (plus a title tooltip) or run past its card or the window. Fake CLI runner, temp data, free port, never 4317.

const HOST = "127.0.0.1";
// The server's CC_APP_KEY; the page gets it from window.cc.appKey() like the Electron preload gives it.
const APP_KEY = newAppKey();
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPO = resolve(".");
const WIDTHS = [1600, 1280, 1024];
const HEIGHT = 900;

// Intentional stacks: an element pair that may overlap, named with the reason. Every other pair this audit found
// was fixed instead, so this list stays short. Each entry is { a: selector, b: selector, reason }, matched with closest().
const INTENTIONAL_STACKS: Array<{ a: string; b: string; reason: string }> = [
  { a: "#side", b: "#stage", reason: "below 1280px the Details panel floats over the right of the chat column on an opaque card (the mockup's narrow layout); from 1280px up it sits beside it, and the browser layout test proves the two never touch there" },
];

async function freePort(): Promise<number> {
  while (true) {
    const probe = createServer();
    await new Promise<void>((ok, bad) => { probe.once("error", bad); probe.listen(0, HOST, ok); });
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((ok, bad) => probe.close((error) => error ? bad(error) : ok()));
    if (port && port !== 4317) return port;
  }
}

const delay = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const spaced = (prefix: string, length = 60) => `${prefix} ${"long words that keep going ".repeat(12)}`.slice(0, length);
const unbroken = (prefix: string, length = 60) => `${prefix}${"W".repeat(length)}`.slice(0, length);
const LONG_PATH = `C:\\Users\\example\\Documents\\${"very-long-folder-name-".repeat(9)}final`.slice(0, 200);
const UNBROKEN_300 = `U${"n".repeat(298)}Z`;
const LONG_URL = `https://example.com/${"path-segment/".repeat(14)}?query=${"x".repeat(60)}`;

function buildSeed(base: any) {
  const state = structuredClone(base);
  const project = state.projects[0];
  project.name = spaced("Project", 60);
  project.folder = LONG_PATH;
  const template = project.tabs[0];
  template.name = spaced("Development tab", 60);
  const tabs = [template];
  for (let index = 1; index < 12; index++) {
    const clone = structuredClone(template);
    clone.id = `${template.id}-extra-${index}`;
    clone.name = index % 3 === 0 ? unbroken(`Tab${index}`, 60) : index % 3 === 1 ? spaced(`Tab ${index}`, 60) : `Tab ${index}`;
    clone.processState.tabId = clone.id;
    for (const seat of clone.crew) seat.seatKey = `${clone.id}.${seat.slot}`;
    tabs.push(clone);
  }
  project.tabs = tabs;
  const other = state.projects[1];
  other.name = unbroken("OtherProject", 60);
  for (const tab of tabs) {
    tab.folder = LONG_PATH;
    tab.crew.forEach((seat: any, index: number) => { if (index % 2 === 1) seat.name = index % 4 === 1 ? spaced(seat.name, 60) : unbroken(seat.name, 60); });
  }
  // A busy crew on the selected tab.
  const tab = template;
  const start = Date.now();
  const worker = tab.crew.find((seat: any) => seat.slot === "coder");
  const lead = tab.crew.find((seat: any) => seat.isLeader);
  const runs = [1, 2].map((number) => ({
    id: `ov-run-${number}`, runId: `ov-run-${number}`, seatSlotId: "coder", seatKey: `${tab.id}.coder`, seatName: worker.name, seatIsLeader: false,
    label: spaced(`Parallel run ${number}`, 90), status: "working", outcome: null, cli: worker.cli, model: worker.model, effort: worker.effort,
    folderPath: LONG_PATH, startedAt: start + number, endedAt: null, output: "output", launchedByLeader: false,
  }));
  tab.runs = runs;
  worker.status = "working"; worker.task = `Working · ${spaced("a very long task line that describes what this seat is doing right now", 140)}`; worker.runs = runs.map((run) => run.runId);
  lead.status = "working"; lead.task = `Working · ${UNBROKEN_300.slice(0, 120)}`;
  tab.processState.runs = runs.map((run) => ({ id: run.runId, crewGenerationId: tab.processState.crewGenerationId, seatSlotId: "coder", seatName: run.seatName, seatIsLeader: false, label: run.label, status: "working", outcome: null, cli: run.cli, model: run.model, effort: run.effort, folderPath: LONG_PATH, startedAt: run.startedAt, endedAt: null }));
  tab.processState.seats.find((item: any) => item.slotId === "coder").status = "working";
  tab.derived.busy = true; tab.derived.leaderTurnActive = false;
  tab.derived.workingSeats = [{ slotId: "coder", name: worker.name, isLeader: false }];
  tab.derived.runViews.liveBySeat.coder = tab.processState.runs.filter((run: any) => run.seatSlotId === "coder");
  tab.derived.leaderStatusLine = `Working · ${spaced("Waiting on the coder to finish the long parallel task", 100)}`;
  tab.derived.approvedCardLine = spaced("The look was approved and the crew continues with the build", 120);
  tab.changes = { repo: true, branch: unbroken("feature/", 60), ahead: 3, behind: 0, lastCommit: { hash: "abc1234", subject: spaced("Commit subject", 100) },
    uncommittedFiles: Array.from({ length: 14 }, (_, index) => ({ status: ["M", "??", "D", "MM"][index % 4], path: index === 3 ? `src/${UNBROKEN_300.slice(0, 250)}.ts` : `${LONG_PATH.replaceAll("\\", "/")}/file-${index}.ts` })) };
  tab.notes = { path: `${LONG_PATH}\\RESUME.md`, truncated: true, content: [
    spaced("Where we left off", 300), `- ${UNBROKEN_300}`, `- ${LONG_URL}`, `- ${LONG_PATH}`, ...Array.from({ length: 8 }, (_, index) => `- ${spaced(`Note ${index}`, 180)}`),
  ].join("\n") };
  const now = Date.now();
  const other1 = tabs[1].id; const other2 = tabs[2].id;
  const files = [`${unbroken("attachment-", 120)}.md`, `${spaced("report", 90)}.txt`];
  state.requests = [
    { id: "ov-r1", fromTabId: other1, toTabId: tab.id, title: spaced("Please export the seat portraits at two times the size", 120), body: `${spaced("Body", 200)}\n${UNBROKEN_300}\n${LONG_URL}\n${LONG_PATH}`, status: "pending", createdAt: now - 60_000, files },
    { id: "ov-r2", fromTabId: other2, toTabId: tab.id, title: unbroken("IncomingUnbroken", 120), body: UNBROKEN_300, status: "accepted", createdAt: now - 120_000, files: [] },
    { id: "ov-r3", fromTabId: other2, toTabId: tab.id, title: spaced("Declined request", 120), body: spaced("Declined body", 400), status: "declined", createdAt: now - 180_000 },
    { id: "ov-r4", fromTabId: tab.id, toTabId: other1, title: spaced("Sent request with a very long title that must wrap", 120), body: `${spaced("Body", 300)} ${UNBROKEN_300}`, status: "pending", createdAt: now - 30_000, files },
    { id: "ov-r5", fromTabId: tab.id, toTabId: other2, title: unbroken("SentUnbroken", 120), body: LONG_URL, status: "accepted", createdAt: now - 90_000 },
    { id: "ov-r6", fromTabId: tab.id, toTabId: other2, title: "Removed destination", body: spaced("Body", 100), status: "destinationRemoved", createdAt: now - 95_000 },
  ];
  state.pendingRequestCounts = { ...(state.pendingRequestCounts ?? {}), [tab.id]: 1 };
  tab.pendingRequestCount = 1;
  const inventory = (cli: string) => ({
    instructionFiles: [{ path: `${LONG_PATH}\\AGENTS.md`, scope: "project" }, { path: `${LONG_PATH}\\${unbroken("CLAUDE-", 100)}.md`, scope: "global" }],
    skills: Array.from({ length: 10 }, (_, index) => index % 2 ? unbroken(`skill-${cli}-`, 90) : spaced(`skill ${cli}`, 90)),
    mcpServers: [{ name: unbroken(`mcp_${cli}_`, 60) }, { name: spaced("mcp server", 60) }],
    plugins: cli === "claude" ? [unbroken("plugin@", 90), spaced("plugin", 90)] : [],
    ...(cli === "opencode" ? { inventoryError: spaced("Could not read the inventory because", 240) } : {}),
  });
  state.settings = {
    ...state.settings,
    tools: {
      claude: { installed: true, version: unbroken("2.1.0-", 60), signedIn: true }, codex: { installed: true, version: "0.155.1", signedIn: false },
      opencode: { installed: false, version: null, signedIn: null }, gemini: { installed: false, version: null, signedIn: null },
    },
    github: { connected: true, account: unbroken("octocat", 60) },
    vault: { path: LONG_PATH }, folders: { defaultProjectFolder: LONG_PATH },
    skills: { claude: inventory("claude"), codex: inventory("codex"), opencode: inventory("opencode"), gemini: { ...inventory("gemini"), plugins: [] } },
  };
  state.launchSafety = {
    blocked: [unbroken("blocked.seat", 90)], uncertain: [{ seatId: spaced("seat", 80), runId: "ov-unc", pid: 4242 }],
    notices: [{ id: 1, source: unbroken("Source", 60), seatName: spaced("Seat", 60), brief: `${spaced("brief", 200)} ${UNBROKEN_300}`, pending: true }], released: [],
  };
  state.launchNotices = [];
  state.selectedTabId = tab.id;
  return state;
}

function chatMessages() {
  const now = Date.now();
  return [
    { id: "m1", role: "user", text: `${spaced("Please look at", 200)}\n${UNBROKEN_300}\n${LONG_URL}\n${LONG_PATH}`, at: now - 500000, revision: 1, files: [`${LONG_PATH}\\${unbroken("attached-", 120)}.md`], images: [`${LONG_PATH}\\${unbroken("shot-", 120)}.png`] },
    { id: "m2", role: "assistant", text: `${spaced("Sure", 400)}\n\n${UNBROKEN_300}\n\n${LONG_URL}\n${LONG_PATH}\n${"a-very-long-word-".repeat(30)}`, at: now - 400000, revision: 2, files: [`${LONG_PATH}\\${unbroken("out-", 100)}.txt`] },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `m-${index}`, role: index % 2 ? "assistant" : "user", text: spaced(`Filler message ${index}`, 260), at: now - 300000 + index, revision: 3 + index })),
  ];
}

// window.cc is the app window's whole bridge, window buttons included, so the top bar is audited as the app shows it.
function bootstrap(seed: any, messages: any[]) {
  return `
window.__ccErrors=[];window.__sent=[];window.__ccFolder=${JSON.stringify(LONG_PATH)};
window.cc={appKey:async()=>${JSON.stringify(APP_KEY)},pickFolder:async()=>window.__ccFolder,openObsidian:async()=>({ok:true}),minimizeWindow:async()=>{},toggleMaximizeWindow:async()=>{},closeWindow:async()=>{},isWindowMaximized:async()=>false,onWindowMaximized:()=>{},onCloseRequested:()=>{},answerClose:async()=>{}};
window.__ccSeed=${JSON.stringify(seed).replace(/</g, "\\u003c")};window.__ccMessages=${JSON.stringify(messages).replace(/</g, "\\u003c")};
window.addEventListener("error",(e)=>window.__ccErrors.push(String(e.message||"browser error")));
window.addEventListener("unhandledrejection",(e)=>window.__ccErrors.push(String(e.reason?.message||e.reason||"unhandled rejection")));
// The page wraps every socket message in try/catch and reports a throw only with console.error: without this hook a render that throws never reaches the check.
const __ccConsoleError=console.error.bind(console);console.error=(...a)=>{window.__ccErrors.push("console.error: "+a.map(String).join(" "));__ccConsoleError(...a)};
class FakeWebSocket{
  static OPEN=1;static CONNECTING=0;
  constructor(){this.readyState=0;this.listeners=new Map();window.__socket=this;setTimeout(()=>{this.readyState=1;this.emit("open",{})},0)}
  addEventListener(name,fn){const items=this.listeners.get(name)||[];items.push(fn);this.listeners.set(name,items)}
  emit(name,event){for(const fn of this.listeners.get(name)||[])fn(event)}
  deliver(message){this.emit("message",{data:JSON.stringify(message)})}
  history(tabId){this.deliver({type:"chatHistory",tabId,messages:tabId===window.__ccSeed.selectedTabId?window.__ccMessages:[],revision:1,savedRevision:1})}
  send(raw){const message=JSON.parse(raw);window.__sent.push(message);
    if(message.type==="hello"){this.deliver({...structuredClone(window.__ccSeed),type:"state"});this.history(window.__ccSeed.selectedTabId)}
    else if(message.type==="selectTab"){window.__ccSeed.selectedTabId=message.tabId;this.deliver({...structuredClone(window.__ccSeed),type:"state"});this.history(message.tabId)}}
  close(){this.readyState=3;this.emit("close",{})}
}
window.WebSocket=FakeWebSocket;
window.__ccDeliver=(message)=>window.__socket.deliver(message);
`;
}

// The in-page audit. window.__ov(label, rootSelector) -> { texts, controls, violations }.
const AUDIT_JS = String.raw`
(() => {
  const cs = (node) => getComputedStyle(node);
  const visible = (node) => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const hasTransform = (style) => style.transform !== "none" || style.willChange.includes("transform");
  const clipsOf = (element, includeSelf) => {
    const out = []; let current = element;
    const own = includeSelf ? cs(element) : null;
    if (own && (own.overflowX !== "visible" || own.overflowY !== "visible")) out.push({ node: element, x: own.overflowX !== "visible", y: own.overflowY !== "visible", scrollX: /auto|scroll/.test(own.overflowX), scrollY: /auto|scroll/.test(own.overflowY), style: own });
    while (current && current !== document.body && current.parentElement) {
      const position = cs(current).position;
      if (position === "fixed") break;
      let parent = current.parentElement;
      if (position === "absolute") while (parent && parent !== document.body && cs(parent).position === "static" && !hasTransform(cs(parent))) parent = parent.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      const style = cs(parent);
      const x = style.overflowX !== "visible", y = style.overflowY !== "visible";
      if (x || y) out.push({ node: parent, x, y, scrollX: /auto|scroll/.test(style.overflowX), scrollY: /auto|scroll/.test(style.overflowY), style });
      current = parent;
    }
    return out;
  };
  const clipBox = (node) => { const box = node.getBoundingClientRect(); return { left: box.left + node.clientLeft, top: box.top + node.clientTop, right: box.left + node.clientLeft + node.clientWidth, bottom: box.top + node.clientTop + node.clientHeight }; };
  const intersect = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const empty = (r) => r.right - r.left <= 0.5 || r.bottom - r.top <= 0.5;
  const plain = (r) => ({ left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10, right: Math.round(r.right * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 });
  const describe = (element, extra = "") => {
    const classes = String(element.className?.baseVal ?? element.className ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    const label = (element.textContent || element.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 34);
    return element.tagName.toLowerCase() + (element.id ? "#" + element.id : "") + (classes ? "." + classes : "") + ' "' + (extra || label) + '"';
  };
  const visibleRect = (raw, element, includeSelf) => {
    let rect = { left: raw.left, top: raw.top, right: raw.right, bottom: raw.bottom };
    rect = intersect(rect, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    for (const clip of clipsOf(element, includeSelf)) {
      const box = clipBox(clip.node);
      rect = intersect(rect, { left: clip.x ? box.left : -1e9, top: clip.y ? box.top : -1e9, right: clip.x ? box.right : 1e9, bottom: clip.y ? box.bottom : 1e9 });
    }
    return rect;
  };
  const color = (value) => { const m = /rgba?\(([^)]+)\)/.exec(value); if (!m) return 0; const parts = m[1].split(/[ ,\/]+/).filter(Boolean); return parts.length > 3 ? Number(parts[3]) : 1; };
  window.__ov = (label, rootSelector) => {
    const root = rootSelector ? document.querySelector(rootSelector) : document.body;
    const result = { label, found: Boolean(root), root: rootSelector ?? "body", texts: 0, controls: 0, violations: [] };
    if (!root) return result;
    const items = []; const violations = result.violations;
    const add = (type, a, b, detail) => violations.push({ type, a, b, detail });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue.trim() || parent.closest("script,style,noscript,option,textarea,svg,select")) continue;
      if (!visible(parent)) continue;
      range.selectNodeContents(node);
      for (const raw of range.getClientRects()) {
        if (raw.width < 1 || raw.height < 1) continue;
        const vis = visibleRect(raw, parent, true);
        if (empty(vis)) continue;
        result.texts++;
        const trim = raw.height * 0.2;
        items.push({ kind: "text", el: parent, node, raw, vis, box: { left: vis.left, right: vis.right, top: vis.top + trim, bottom: vis.bottom - trim }, name: describe(parent, node.nodeValue.trim().slice(0, 34)) });
      }
    }
    const selector = 'button,a[href],input:not([type=hidden]),select,textarea,[role=tab],[role=radio],[role=button],summary';
    for (const element of [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]) {
      if (!visible(element)) continue;
      const raw = element.getBoundingClientRect();
      if (raw.width < 1 || raw.height < 1) continue;
      const vis = visibleRect(raw, element);
      if (empty(vis)) continue;
      result.controls++;
      items.push({ kind: "ctl", el: element, raw, vis, box: vis, name: describe(element) });
    }
    const allowed = (a, b) => window.__ovAllowed.some((rule) => (a.el.closest(rule.a) && b.el.closest(rule.b)) || (a.el.closest(rule.b) && b.el.closest(rule.a)));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.node && a.node === b.node) continue;
      if ((a.kind === "ctl" || b.kind === "ctl") && (a.el.contains(b.el) || b.el.contains(a.el))) continue;
      // A tab's own options button is laid over the right padding the tab reserves for it (it is the tab's next sibling, never inside a role=tab); the tab's text is still checked against it.
      if (a.kind === "ctl" && b.kind === "ctl" && [[a.el, b.el], [b.el, a.el]].some(([tab, more]) => tab.getAttribute("role") === "tab" && tab.nextElementSibling === more && more.classList.contains("dots"))) continue;
      const x = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const y = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (x > 1 && y > 1 && !allowed(a, b)) add("overlap", a.name, b.name, "by " + x.toFixed(1) + "x" + y.toFixed(1) + " px at " + JSON.stringify(plain(a.box)));
    }
    const seen = new Set();
    for (const item of items) {
      if (item.kind !== "text") continue;
      let stopX = false, stopY = false;
      for (const clip of clipsOf(item.el, true)) {
        const box = clipBox(clip.node); const height = item.raw.bottom - item.raw.top;
        if (clip.x && !stopX) {
          if (clip.scrollX) stopX = true;
          else {
            const cut = Math.max(item.raw.right - box.right, box.left - item.raw.left);
            if (cut > 1) {
              const key = "x" + item.name + cut.toFixed(0);
              if (clip.style.textOverflow === "ellipsis") { if (!item.el.closest("[title]") && !seen.has("t" + key)) { seen.add("t" + key); add("ellipsis-no-title", item.name, describe(clip.node), "text cut with an ellipsis but no title tooltip"); } }
              else if (!seen.has(key)) { seen.add(key); add("clipped-x", item.name, describe(clip.node), "cut off by " + cut.toFixed(1) + " px with no ellipsis"); }
              stopX = true;
            }
          }
        }
        if (clip.y && !stopY) {
          if (clip.scrollY) stopY = true;
          else {
            const cut = Math.max(item.raw.bottom - box.bottom, box.top - item.raw.top);
            if (cut > height * 0.3 && !/^[1-9]/.test(clip.style.webkitLineClamp || "none")) {
              const key = "y" + item.name + cut.toFixed(0);
              if (!seen.has(key)) { seen.add(key); add("clipped-y", item.name, describe(clip.node), "cut off by " + cut.toFixed(1) + " px vertically"); }
              stopY = true;
            }
          }
        }
      }
      if (!stopX && (item.raw.right > innerWidth + 1 || item.raw.left < -1)) add("past-window", item.name, "window", "text reaches " + item.raw.right.toFixed(0) + " of " + innerWidth);
      if (!stopX) {
        let ancestor = item.el;
        while (ancestor && ancestor !== root.parentElement && ancestor !== document.body) {
          const style = cs(ancestor);
          if (style.overflowX !== "visible") break;
          const border = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
          if ((border > 0 || color(style.backgroundColor) > 0.05) && style.display !== "inline" && style.position !== "fixed") {
            const box = ancestor.getBoundingClientRect();
            const over = Math.max(item.raw.right - box.right, box.left - item.raw.left);
            if (over > 1) { const key = "s" + item.name + describe(ancestor); if (!seen.has(key)) { seen.add(key); add("spills-out", item.name, describe(ancestor), "runs " + over.toFixed(1) + " px outside its box"); } break; }
          }
          ancestor = ancestor.parentElement;
        }
      }
    }
    return result;
  };
  window.__ovAllowed = [];
})()
`;

type Finding = { width: number; state: string; type: string; a: string; b: string; detail: string };

async function chromeAudit(port: number, profile: string, width: number, extraFiles: string[], inventory: string[]) {
  mkdirSync(profile, { recursive: true });
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--window-size=${width + 16},${HEIGHT + 130}`, `--user-data-dir=${profile}`,
    "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-gpu-sandbox", "--use-gl=swiftshader",
    "--disable-dev-shm-usage", "--disable-background-networking", "--no-proxy-server", "--hide-scrollbars", "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  let socket: WebSocket | null = null; let sequence = 0;
  const pending = new Map<number, { resolve: (message: any) => void; reject: (error: Error) => void }>();
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((ok, bad) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) { bad(new Error(`DevTools socket is not open for ${method}`)); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); bad(new Error(`DevTools command timed out: ${method}`)); }, 20_000);
    pending.set(id, { resolve(message) { clearTimeout(timer); ok(message); }, reject(error) { clearTimeout(timer); bad(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const findings: Finding[] = []; const checked: string[] = [];
  let bodyError: unknown;
  try {
    const portFile = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 15_000;
    while (!existsSync(portFile) && Date.now() < deadline && proc.exitCode === null) await delay(50);
    assert.ok(existsSync(portFile), `Chrome PID ${proc.pid} opened DevTools; stderr=${stderr.slice(-800)}`);
    // Chrome may still hold the file (EBUSY) or have written only part of it: read again until the whole first line is there, within the same deadline.
    let devtoolsPort = 0;
    while (!devtoolsPort && Date.now() < deadline) {
      try { devtoolsPort = Number(/^(\d+)\r?\n/.exec(readFileSync(portFile, "utf8"))?.[1] ?? 0); } catch { /* locked: retried */ }
      if (!devtoolsPort) await delay(50);
    }
    assert.ok(devtoolsPort > 0, `Chrome wrote a DevTools port to ${portFile} before the deadline`);
    const version = await fetch(`http://${HOST}:${devtoolsPort}/json/version`).then((response) => response.json()) as { webSocketDebuggerUrl?: string };
    socket = new WebSocket(version.webSocketDebuggerUrl!);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id || !pending.has(message.id)) return;
      const waiting = pending.get(message.id)!; pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error))); else waiting.resolve(message);
    });
    await new Promise<void>((ok, bad) => { socket!.once("open", ok); socket!.once("error", bad); });
    const created = await send("Target.createTarget", { url: "about:blank" });
    const attached = await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
    const sessionId = attached.result.sessionId as string;
    const page = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
    const evaluate = async (expression: string) => {
      const response = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.result?.exceptionDetails) throw new Error(`Browser expression failed: ${response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text}`);
      return response.result?.result?.value;
    };
    const waitFor = async (expression: string, label: string, timeoutMs = 15_000) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) { try { if (await evaluate(expression)) return; } catch { /* page still loading */ } await delay(40); }
      throw new Error(`timed out waiting for ${label} at ${width}px`);
    };
    await page("Page.enable"); await page("Runtime.enable"); await page("DOM.enable");
    await page("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await page("Page.navigate", { url: `http://${HOST}:${port}/__audit` });
    await waitFor(`document.querySelectorAll("#crew .seat").length>0&&document.querySelectorAll("#tabs [role=tab]").length>0&&document.querySelector("#view .thread")!==null`, "app render");
    assert.equal(await evaluate("innerWidth"), width, `viewport is ${width}px`);
    await evaluate(AUDIT_JS);
    // Control: a socket message the page cannot read is reported only through console.error, and the page-error hook must catch that.
    await evaluate(`window.__socket.emit("message",{data:"{not json"});true`);
    const control = await evaluate("window.__ccErrors");
    assert.ok(control.length === 1 && /^console\.error: Invalid Command Center message/.test(control[0]), `the console.error hook caught the unreadable message at ${width}px: ${JSON.stringify(control)}`);
    await evaluate("window.__ccErrors.length=0;true");
    await evaluate(`window.__ovAllowed=${JSON.stringify(INTENTIONAL_STACKS)};true`);
    const settle = () => delay(120);
    const click = (selector: string) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true})()`);
    const escape = async () => { await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));true`); await delay(320); };
    const audit = async (state: string, root: string | null, expect: { texts?: number; controls?: number } = {}) => {
      await settle();
      const result = await evaluate(`window.__ov(${JSON.stringify(state)}, ${JSON.stringify(root)})`);
      assert.ok(result.found, `${state}: root ${root} was FOUND at ${width}px`);
      assert.ok(result.texts >= (expect.texts ?? 1), `${state}: ${result.texts} visible text rects at ${width}px, expected at least ${expect.texts ?? 1}`);
      assert.ok(result.controls >= (expect.controls ?? 1), `${state}: ${result.controls} visible controls at ${width}px, expected at least ${expect.controls ?? 1}`);
      checked.push(`${state} [${result.root}] texts=${result.texts} controls=${result.controls}`);
      for (const item of result.violations) findings.push({ width, state, type: item.type, a: item.a, b: item.b, detail: item.detail });
      return result;
    };
    const openAndWait = async (opener: string, layer: string) => {
      assert.equal(await click(opener), true, `${opener} exists at ${width}px`);
      await waitFor(`document.querySelector(${JSON.stringify(layer)})?.getAttribute("aria-hidden")==="false"`, `${layer} open`);
      await delay(320);
    };
    // Measure the scroll viewport as well as the first visible content: padding alone
    // disappears on scroll and cannot protect the close button from later cards.
    const checkedCloseModals = new Set<string>();
    // fixedTopInset: the user's later instruction for Settings ("move up the close button a bit"): top inset 8px replaces the title-level and equal-inset rules.
    const closePlacement = async (modal: string, body: string, title: string, fixedTopInset?: number) => {
      checkedCloseModals.add(modal);
      for (const position of ["top", "middle", "bottom"]) {
        const measurement = await evaluate(`(()=>{
          const modal=document.querySelector(${JSON.stringify(modal)}),body=document.querySelector(${JSON.stringify(body)}),title=document.querySelector(${JSON.stringify(title)}),close=modal?.querySelector(".dialog-close");
          if(!modal||!body||!title||!close)throw new Error("close placement target missing: ${modal}, ${body}, ${title}");
          const max=body.scrollHeight-body.clientHeight;body.scrollTop=${position === "top" ? "0" : position === "middle" ? "max/2" : "max"};
          const m=modal.getBoundingClientRect(),b=body.getBoundingClientRect(),x=close.getBoundingClientRect(),h=title.getBoundingClientRect();
          const visible=[...body.children].map(e=>e.getBoundingClientRect()).filter(r=>r.bottom>b.top&&r.top<b.bottom);
          if(!visible.length)throw new Error("close placement found no visible content: ${body}");
          return {centreDelta:(x.top+x.bottom-h.top-h.bottom)/2,topInset:x.top-m.top,rightInset:m.right-x.right,viewportGap:b.top-x.bottom,contentGap:Math.min(...visible.map(r=>Math.max(r.top,b.top)))-x.bottom,scrollTop:body.scrollTop,maxScroll:max};
        })()`);
        console.log(`Close placement ${width}px ${modal} ${position}: ${JSON.stringify(measurement)}`);
        assert.ok(measurement.maxScroll > 0, `${modal}: long content makes top, middle and bottom distinct at ${width}px`);
        const expectedScroll = position === "top" ? 0 : position === "middle" ? measurement.maxScroll / 2 : measurement.maxScroll;
        assert.ok(Math.abs(measurement.scrollTop - expectedScroll) <= 1, `${modal}: reached ${position} at ${width}px`);
        const add = (type: string, detail: string) => findings.push({ width, state: `${modal} close ${position}`, type, a: ".dialog-close", b: title, detail });
        if (fixedTopInset !== undefined) {
          if (Math.abs(measurement.topInset - fixedTopInset) > 2) add("close-top-inset", `top inset ${measurement.topInset}px, expected ${fixedTopInset}px +-2`);
        } else {
          if (Math.abs(measurement.centreDelta) > 2) add("close-title-centre", `centre delta ${measurement.centreDelta}px exceeds 2px`);
          if (Math.abs(measurement.rightInset - measurement.topInset) > 2) add("close-equal-insets", `right ${measurement.rightInset}px, top ${measurement.topInset}px`);
        }
        if (measurement.viewportGap < 16 || measurement.contentGap < 16) add("close-content-gap", `viewport ${measurement.viewportGap}px, visible content ${measurement.contentGap}px; require >=16px`);
      }
    };

    // 1. Main view: busy crew, long chat (unbroken words, URLs, paths, files), 12 tabs with long names.
    await audit("main: busy crew, long chat, 12 tabs, status line", null, { texts: 40, controls: 20 });
    await audit("main: tab strip with many long tabs", "#top", { texts: 4, controls: 6 });
    await audit("main: crew rail with long names and tasks", "#rail", { texts: 8, controls: 4 });
    await audit("main: status line and save", "#sline", { texts: 2, controls: 2 });
    await audit("main: chat with long unbroken words, URLs, paths and files", "#view", { texts: 10, controls: 0 });
    await evaluate(`document.querySelector("#view").scrollTop=0;true`); await audit("main: chat scrolled to the top", "#view", { texts: 5, controls: 0 });
    // The step list opens under the status line.
    assert.equal(await click("#statusBtn"), true, "status line exists"); await delay(400);
    await audit("main: steps open under the status line", "#stage > .col", { texts: 10, controls: 6 });
    await click("#statusBtn"); await delay(400);
    // The crew rail collapsed to faces, then back.
    await click("#railBtn"); await delay(400);
    await audit("main: crew rail collapsed to faces", "#rail", { texts: 1, controls: 4 });
    await click("#railBtn"); await delay(400);

    // 2. Details panel: Activity, Changes, Notes, Usage. It starts closed; the user opens it (floating below 1280px).
    assert.equal(await click("#sideBtn"), true, "Details button exists"); await delay(400);
    for (const lower of ["activity", "changes", "notes", "usage"]) {
      assert.equal(await click(`.pills [data-l="${lower}"]`), true, `Details pill ${lower} exists`);
      await evaluate(`document.querySelector("#sideBody").scrollTop=0;true`);
      await audit(`Details: ${lower}`, "#side", { texts: 3, controls: 2 });
      await evaluate(`(()=>{const b=document.querySelector("#sideBody");b.scrollTop=b.scrollHeight;return true})()`);
      await audit(`Details: ${lower} scrolled to the bottom`, "#side", { texts: 2, controls: 2 });
    }
    await audit("main: Details open beside or over the chat", null, { texts: 30, controls: 20 });
    await click("#sideBtn"); await delay(400);

    // 3. Attachments with long file names (real upload to the temp-data server through the proxy).
    const doc = await page("DOM.getDocument", { depth: 0 });
    const input = await page("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#attachInput" });
    await page("DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: extraFiles });
    await waitFor(`document.querySelectorAll("#atts .att").length===${extraFiles.length}`, "attachments render");
    await evaluate(`document.querySelector("#ci").value=${JSON.stringify(spaced("A long draft message ", 300))};document.querySelector("#ci").dispatchEvent(new Event("input",{bubbles:true}));true`);
    await audit("composer: attachments with long file names and a long draft", "#composer", { texts: 3, controls: 3 });

    // 4. Permission picker and popovers.
    await openAndWait("#permBtn", "#permPop");
    await audit("permission picker open", "#permPop", { texts: 4, controls: 4 }); await escape();
    await click("#pmore"); await waitFor(`document.querySelector("#projPop")?.getAttribute("aria-hidden")==="false"`, "project popover"); await delay(200);
    await audit("project popover with long project names", "#projPop", { texts: 2, controls: 2 }); await escape();
    assert.equal(await click(`#tabs .tabw.sel .tmore`), true, "tab menu button exists");
    await waitFor(`document.querySelector("#ctxPop")?.getAttribute("aria-hidden")==="false"`, "tab menu"); await delay(200);
    await audit("tab options menu", "#ctxPop", { texts: 1, controls: 1 }); await escape();
    assert.equal(await click(`#ptabs .ptabw.sel [data-project-menu]`), true, "project menu button exists");
    await waitFor(`document.querySelector("#ctxPop")?.getAttribute("aria-hidden")==="false"`, "project menu"); await delay(200);
    await audit("project options menu with a 200-char folder", "#ctxPop", { texts: 2, controls: 2 }); await escape();
    await openAndWait("#chatMore", "#ctxPop");
    await audit("chat options menu", "#ctxPop", { texts: 3, controls: 2 }); await escape();

    await evaluate(`(()=>{const t=document.querySelector("#tabs");t.scrollLeft=t.scrollWidth;return true})()`);
    await audit("main: tab strip scrolled to its last tabs", "#stage .shead", { texts: 3, controls: 4 });
    await evaluate(`document.querySelector("#tabs").scrollLeft=0;true`);
    // The leader's seat card opens from its face; its Model and Advisor rows open the pickers.
    const openLeaderCard = async () => { await openAndWait('#crew [data-seat-id="leader"] [data-seat-pic]', "#seatPop"); };
    await openLeaderCard();
    await audit("leader seat card with long name and status", "#seatPop", { texts: 6, controls: 4 });
    assert.equal(await click("#seatPop [data-seat-model]"), true, "leader model row exists");
    await waitFor(`document.querySelector("#pop")?.getAttribute("aria-hidden")==="false"`, "model picker open"); await delay(200);
    await audit("model and effort popover", "#pop", { texts: 2, controls: 1 }); await escape();
    await openLeaderCard();
    assert.equal(await click("#seatPop [data-seat-advisor]"), true, "leader advisor row exists");
    await waitFor(`document.querySelector("#pop")?.getAttribute("aria-hidden")==="false"`, "advisor picker open"); await delay(200);
    await audit("advisor popover", "#pop", { texts: 2, controls: 1 }); await escape();
    await openAndWait("#setupsBtn", "#setupPop");
    await audit("crew choices popover", "#setupPop", { texts: 2, controls: 1 }); await escape();
    // A worker's own view: live runs with long labels, then its seat card.
    assert.equal(await click('#crew [data-seat-id="coder"] [data-seat-open]'), true, "coder face exists"); await delay(250);
    await audit("worker view: two live runs with long labels and a 200-char folder", "#view", { texts: 8, controls: 6 });
    await openAndWait("#view [data-seat-more]", "#seatPop");
    await audit("worker seat card with long runs", "#seatPop", { texts: 6, controls: 4 }); await escape();
    assert.equal(await click('#view [data-run-view="history"]'), true, "worker History exists"); await delay(250);
    await evaluate(`(()=>{const tab=window.__ccSeed.projects[0].tabs[0];window.__ccDeliver({type:"historyList",seatKey:tab.id+".coder",runs:Array.from({length:6},(_,i)=>({timestamp:Date.now()-i*60000,sizeBytes:123456789,outcome:{status:i%2?"failed":"done",exitCode:i}}))});return true})()`); await delay(150);
    await audit("worker History list", "#view", { texts: 8, controls: 6 });
    await click("#view [data-back-chat]"); await delay(250);

    // 5. Needs you: launch safety records, approvals and long requests, and the send form.
    await openAndWait("#inboxBtn", "#inboxPop");
    await evaluate(`document.querySelector("#inboxPop").scrollTop=0;true`);
    // A request body now keeps its line breaks (the leader's formatting), so the long cards are taller and fewer controls fit above the fold.
    await audit("Needs you: launch safety and long request cards", "#inboxPop", { texts: 20, controls: 2 });
    // Taller cards mean fewer buttons above the fold, so the minimum above stays low; what must hold is that EVERY request card's buttons can be reached: scrolled to, inside the panel, and not covered.
    const reach = await evaluate(`(()=>{const pop=document.querySelector("#inboxPop"),out=[];for(const b of pop.querySelectorAll(".ncard.req [data-request-action]")){b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect(),p=pop.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);out.push({action:b.dataset.requestAction,inside:r.width>0&&r.height>0&&r.top>=p.top-0.5&&r.bottom<=p.bottom+0.5,hit:Boolean(hit&&(hit===b||b.contains(hit)))})}pop.scrollTop=0;return out})()`);
    assert.ok(reach.length >= 2, `${reach.length} request card buttons were found in Needs you at ${width}px, expected at least 2 (an empty scan checks nothing)`);
    assert.deepEqual(reach.filter((item: { inside: boolean; hit: boolean }) => !item.inside || !item.hit), [], `every request card button is reachable at ${width}px; matched: ${JSON.stringify(reach)}`);
    await evaluate(`(()=>{const b=document.querySelector("#inboxPop");b.scrollTop=(b.scrollHeight-b.clientHeight)/2;return true})()`);
    await audit("Needs you: scrolled to the middle", "#inboxPop", { texts: 10, controls: 3 });
    await evaluate(`(()=>{const b=document.querySelector("#inboxPop");b.scrollTop=b.scrollHeight;return true})()`);
    await audit("Needs you: scrolled to the bottom (sent requests, no controls)", "#inboxPop", { texts: 10, controls: 0 });
    await click("#reqNew"); await delay(150);
    await evaluate(`(()=>{document.querySelector("#reqTitle").value=${JSON.stringify(unbroken("T", 120))};document.querySelector("#reqBody").value=${JSON.stringify(UNBROKEN_300)};const b=document.querySelector("#inboxPop");b.scrollTop=document.querySelector("#reqForm").offsetTop-20;return true})()`);
    await audit("Needs you: long draft in the request form", "#inboxPop", { texts: 6, controls: 4 });
    await escape();

    // 6. Settings: every section top and bottom, plus body top, middle and bottom, and the add forms.
    await openAndWait("#setBtn", "#setModal");
    await closePlacement("#setModal", "#setBody", "#setNav h2", 8);
    await evaluate(`document.querySelector("#setBody").scrollTop=0;true`);
    await audit("settings: opened", "#setModal", { texts: 20, controls: 6 });
    const scrollBody = (expression: string) => evaluate(`(()=>{const b=document.querySelector("#setBody");${expression};return true})()`);
    await scrollBody("b.scrollTop=0"); await audit("settings: body top", "#setModal", { texts: 10, controls: 4 });
    await scrollBody("b.scrollTop=(b.scrollHeight-b.clientHeight)/2"); await audit("settings: body middle", "#setModal", { texts: 10, controls: 3 });
    await scrollBody("b.scrollTop=b.scrollHeight"); await audit("settings: body bottom", "#setModal", { texts: 5, controls: 2 });
    for (const id of ["crew", "tools", "github", "vault", "folders", "skills", "appearance", "behaviour"]) {
      await scrollBody(`b.scrollTop=0;const s=b.querySelector("#s-${id}");if(!s)throw new Error("missing #s-${id}");b.scrollTop+=s.getBoundingClientRect().top-b.getBoundingClientRect().top`);
      await audit(`settings: ${id} section scrolled to its top`, "#setModal", { texts: 3, controls: 1 });
      await scrollBody(`const s=b.querySelector("#s-${id}");b.scrollTop+=s.getBoundingClientRect().bottom-b.getBoundingClientRect().bottom`);
      await audit(`settings: ${id} section scrolled to its bottom`, "#setModal", { texts: 3, controls: 1 });
    }
    await evaluate(`document.querySelectorAll('#setBody [data-settings-add]').forEach((button)=>button.click());true`);
    await scrollBody("b.scrollTop=0"); await audit("settings: add forms open, top", "#setModal", { texts: 10, controls: 4 });
    await scrollBody("b.scrollTop=(b.scrollHeight-b.clientHeight)/2"); await audit("settings: add forms open, middle", "#setModal", { texts: 10, controls: 4 });
    await scrollBody("b.scrollTop=b.scrollHeight"); await audit("settings: add forms open, bottom", "#setModal", { texts: 5, controls: 2 });
    await escape();

    // 7. Dialogs: avatar, add tab, new project, run a seat, screenshots.
    await openAndWait("#meBtn", "#avModal"); await audit("avatar dialog", "#avModal", { texts: 2, controls: 2 }); await escape();
    await openAndWait("#addtab", "#modal");
    await click("#browse"); await delay(250);
    await evaluate(`document.querySelector("#tName").value=${JSON.stringify(unbroken("New", 64))};true`);
    await audit("add-tab modal with a long project name, name and 200-char folder", "#modal", { texts: 5, controls: 4 }); await escape();
    await openAndWait("#addProj", "#projModal");
    await click("#pBrowse"); await delay(250);
    await evaluate(`document.querySelector("#pName").value=${JSON.stringify(unbroken("New", 64))};document.querySelector("#pName").dispatchEvent(new Event("input",{bubbles:true}));true`);
    await audit("new-project modal with a long name and 200-char folder", "#projModal", { texts: 5, controls: 4 }); await escape();
    await evaluate(`(()=>{const s=document.querySelector('#crew [data-seat-id="coder"] [data-seat-open]');if(s)s.click();return true})()`); await delay(150);
    assert.equal(await click("#stagehead [data-run-seat]"), true, "run seat button exists");
    await waitFor(`document.querySelector("#runModal")?.getAttribute("aria-hidden")==="false"`, "run modal"); await delay(320);
    await audit("run a seat modal with a long seat name", "#runModal", { texts: 2, controls: 2 }); await escape();
    // Rename and confirm dialogs carry server text too.
    assert.equal(await click(`#tabs .tabw.sel .tmore`), true, "tab menu for rename"); await delay(200);
    await evaluate(`[...document.querySelectorAll("#ctxPop button.opt")].find((b)=>b.textContent.includes("Rename"))?.click();true`);
    await waitFor(`document.querySelector("#renameModal")?.getAttribute("aria-hidden")==="false"`, "rename modal"); await delay(320);
    await audit("rename dialog with a 60-char tab name", "#renameModal", { texts: 1, controls: 2 }); await escape();

    await evaluate(`(()=>{const b=document.querySelector("#view [data-back-chat]");if(b)b.click();return true})()`); await delay(150);
    for (const count of [1, 3]) {
      await evaluate(`(()=>{const tab=window.__ccSeed.projects[0].tabs[0];tab.pendingApprovals=Array.from({length:${count}},(_,i)=>({approvalId:"overlap-"+i,tool:"Bash",summary:i===0?${JSON.stringify("echo " + (LONG_PATH + UNBROKEN_300).repeat(20))}:"echo next",createdAt:i}));window.__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});const v=document.querySelector("#view");v.scrollTop=v.scrollHeight;return true})()`);
      await waitFor(`!document.querySelector("#approvalPanel").hidden`, "approval panel");
      await audit(`tool approval panel with long command and ${count} pending`, "#composer", { texts: 3, controls: 3 });
      assert.equal(await evaluate(`(()=>{const p=document.querySelector("#approvalPanel").getBoundingClientRect(),c=document.querySelector(".cbox").getBoundingClientRect(),v=document.querySelector("#view"),last=v.querySelector(".msg:last-of-type");v.scrollTop=v.scrollHeight;return !!last && last.getBoundingClientRect().bottom<=p.top && v.getBoundingClientRect().bottom<=p.top && Math.abs(p.width-c.width)<1 && p.bottom<=c.top})()`),true, `last message stays above approval panel at ${width}px (${count} pending): ${JSON.stringify(await evaluate('(()=>{const v=document.querySelector("#view"),p=document.querySelector("#approvalPanel"),c=document.querySelector(".cbox"),last=v.querySelector(".msg:last-of-type");return {v:v.getBoundingClientRect().toJSON(),p:p.getBoundingClientRect().toJSON(),c:c.getBoundingClientRect().toJSON(),last:last?.getBoundingClientRect().toJSON()}})()'))}`);
    }
    await evaluate(`(()=>{window.__ccSeed.projects[0].tabs[0].pendingApprovals=[];window.__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});return true})()`);

    // 8. Screenshots viewer with long file names: the approval card offers it.
    const shot = await evaluate(`(()=>{const tab=window.__ccSeed.projects[0].tabs[0];tab.processState.approval={state:"pending"};tab.processState.currentStepIndex=0;tab.derived.stepBar=[{stepId:"look",state:"current",owners:["user"],label:"Your look"}];window.__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});window.__ccDeliver({type:"chatHistory",tabId:tab.id,messages:[{id:"ov-shot",role:"user",text:"Screenshots",images:${JSON.stringify(Array.from({length:12},(_,index)=>`${LONG_PATH}\\screenshot-${index}-${unbroken("long-",140)}.png`))},at:Date.now(),revision:1}],revision:1,savedRevision:1});return true})()`);
    assert.ok(shot);
    await waitFor(`document.querySelector("#view [data-open-screenshots]")!==null`, "screenshots opener");
    await evaluate(`(()=>{const v=document.querySelector("#view");v.scrollTop=v.scrollHeight;return true})()`);
    await audit("approval card with long text", "#view", { texts: 3, controls: 2 });
    await audit("look waiting in the steps and status line", "#stage > .col", { texts: 6, controls: 4 });
    await openAndWait("#view [data-open-screenshots]", "#viewer");
    await audit("screenshots viewer with long file names", "#viewer", { texts: 2, controls: 1 });
    await evaluate(`document.querySelector("#viewerFiles [data-shot-open]").click();true`); await delay(200);
    await audit("one screenshot at full size with its long name", "#viewer", { texts: 2, controls: 3 }); await escape();
    const allCloseModals = await evaluate(`Array.from(document.querySelectorAll(".modal .dialog-close,.drawer .dialog-close"),x=>"#"+x.closest(".modal,.drawer").id).sort()`);
    assert.deepEqual([...checkedCloseModals].sort(), allCloseModals, `every modal/drawer with an X was measured at ${width}px`);

    inventory.push(...checked);
    return { findings, errors: await evaluate("window.__ccErrors") };
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    const gone = () => proc.exitCode !== null || proc.signalCode !== null;
    const facts: string[] = [];
    const started = Date.now();
    if (socket?.readyState === WebSocket.OPEN) {
      try { await send("Browser.close"); facts.push("Browser.close answered"); } catch (error) { facts.push(`Browser.close error: ${(error as Error).message}`); }
    } else facts.push("Browser.close not sent (socket not open)");
    if (!gone()) {
      const exited = new Promise<void>((ok) => proc.once("close", () => ok()));
      const byClose = await Promise.race([exited.then(() => true), delay(7000).then(() => false)]);
      facts.push(byClose ? `7 s wait ended by close after ${Date.now() - started} ms` : "7 s wait ended by timeout");
      if (!byClose) {
        const killedAt = Date.now();
        facts.push(`proc.kill() returned ${proc.kill()}`);
        const afterKill = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
        facts.push(afterKill ? `exit ${Date.now() - killedAt} ms after kill` : "no exit within 5 s of kill");
        if (!gone() && proc.pid) {
          const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          const code = await Promise.race([
            new Promise<string>((ok) => { killer.once("exit", (c, s) => ok(`exit ${c ?? s}`)); killer.once("error", (e) => ok(`error ${e.message}`)); }),
            delay(10_000).then(() => { killer.kill(); return "timed out after 10 s"; }),
          ]);
          facts.push(`taskkill /T /F ${code}`);
          await Promise.race([exited, delay(2000)]);
        }
      }
    } else facts.push("Chrome had already exited");
    socket?.close();
    facts.push(`exitCode=${proc.exitCode} signalCode=${proc.signalCode}`);
    if (!gone()) {
      const message = `Chrome PID ${proc.pid} did not exit after the overlap audit: ${facts.join("; ")}; stderr=${stderr.slice(-800)}`;
      if (bodyError instanceof Error) bodyError.message += `\n${message}`;
      else assert.fail(message);
    }
  }
}

function backendState(port: number): Promise<any> {
  return new Promise((ok, bad) => {
    const ws = new WebSocket(keyedWsUrl(`ws://${HOST}:${port}`, APP_KEY), { origin: `http://${HOST}:${port}` });
    const timer = setTimeout(() => { ws.terminate(); bad(new Error("server state request timed out")); }, 8000);
    ws.once("open", () => ws.send(JSON.stringify({ type: "hello" })));
    ws.on("message", (data) => { const message = JSON.parse(data.toString()); if (message.type === "state") { clearTimeout(timer); ws.close(); ok(message); } });
    ws.once("error", (error) => { clearTimeout(timer); bad(error); });
  });
}

test("overlap audit: no visible text or control overlaps or is clipped, at 1600, 1280 and 1024, on every screen with long data", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  assert.ok(existsSync(CHROME), `Headless Chrome is required at ${CHROME}; set CC_SKIP_BROWSER=1 only when intentionally running without it`);
  const temp = mkdtempSync(join(tmpdir(), "cc-overlap-"));
  const dataDir = join(temp, "data"); mkdirSync(join(dataDir, "config"), { recursive: true });
  // Two projects of its own (the audit needs a second one); the server runs on this temp data root, never the repo's.
  const crew = getProcessDefinition("dev", "main").seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort }));
  const project = (id: string) => ({ id, name: id, folder: temp, tabs: [{ id: `${id}-dev`, name: "Development", kind: "dev", process: "main", folder: temp, crew }] });
  writeFileSync(join(dataDir, "config", "workspaces.json"), JSON.stringify({ projects: [project("alpha"), project("beta")] }));
  const home = join(temp, "home"); mkdirSync(home, { recursive: true });
  const script = join(temp, "fake-cli-script.json");
  writeFileSync(script, JSON.stringify({ responses: {} }));
  const attachDir = join(temp, "attach"); mkdirSync(attachDir);
  const extraFiles = [`${unbroken("attachment-", 120)}.md`, `${spaced("report", 90)}.txt`].map((name) => { const path = join(attachDir, name); writeFileSync(path, "long name attachment\n"); return path; });
  const serverPort = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_CLI_RECORD: join(temp, "argv.jsonl"), CC_DATA_DIR: dataDir, CC_TEST_FORCE_PACKAGED: "1", CC_PORT: String(serverPort), CC_APP_KEY: APP_KEY, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1" };
  assert.equal(env.CC_TEST_FAKE_CLI, "1"); assert.notEqual(Number(env.CC_PORT), 4317);
  // The EFFECT, not the env: this server must run on the temp data root (under node --test a CC_DATA_DIR alone is ignored),
  // so the uploads end up there and the repo's own scratch/ and workspaces file are left exactly as they were.
  const repoScratch = join(REPO, "scratch"), repoScratchCount = () => (existsSync(repoScratch) ? readdirSync(repoScratch).length : 0);
  const repoScratchBefore = repoScratchCount(), repoWorkspacesPath = join(REPO, "config", "workspaces.json");
  // The file is untracked, so a fresh clone has none: absent must stay absent, present must stay byte-identical.
  const readRepoWorkspaces = () => (existsSync(repoWorkspacesPath) ? readFileSync(repoWorkspacesPath, "utf8") : null), repoWorkspacesBefore = readRepoWorkspaces();
  const server = spawn(process.execPath, [join(REPO, "server", "index.ts")], { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  attachCrashCatcher(server.pid, "overlap");
  let proxy: http.Server | null = null;
  try {
    await new Promise<void>((ok, bad) => {
      let output = ""; const timer = setTimeout(() => bad(new Error(`server did not become ready; output=${output}`)), 15_000);
      server.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); if (/running at http:\/\/127\.0\.0\.1:\d+/.test(output)) { clearTimeout(timer); ok(); } });
      server.once("exit", (code) => bad(new Error(`server exited early (${code}); output=${output}`)));
    });
    const seed = buildSeed(await backendState(serverPort));
    const html = readFileSync(join(REPO, "public", "index.html"), "utf8").replace(/<link\b[^>]*https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, "")
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") // the page's policy stays, except for the inline bootstrap injected here
      .replace("</head>", `<script>${bootstrap(seed, chatMessages())}</script>\n</head>`);
    proxy = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname === "/__audit") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html); return; }
      const headers = { ...request.headers, host: `${HOST}:${serverPort}`, origin: `http://${HOST}:${serverPort}`, "accept-encoding": "identity" };
      const upstream = http.request({ host: HOST, port: serverPort, method: request.method, path: request.url, headers }, (result) => { response.writeHead(result.statusCode ?? 500, result.headers); result.pipe(response); });
      upstream.on("error", (error) => { response.writeHead(502); response.end(error.message); });
      request.pipe(upstream);
    });
    await new Promise<void>((ok, bad) => { proxy!.once("error", bad); proxy!.listen(0, HOST, ok); });
    const proxyPort = (proxy.address() as { port: number }).port;
    const all: Finding[] = []; const inventory: string[] = [];
    for (const width of WIDTHS) {
      const perWidth: string[] = [];
      const { findings, errors } = await chromeAudit(proxyPort, join(temp, `chrome-${width}`), width, extraFiles, perWidth);
      assert.deepEqual(errors, [], `page errors at ${width}px: ${JSON.stringify(errors)}`);
      console.log(`Overlap audit ${width}px checked ${perWidth.length} screens/states:\n  ${perWidth.join("\n  ")}`);
      inventory.push(...perWidth); all.push(...findings);
    }
    assert.ok(inventory.length >= WIDTHS.length * 40, `audit checked ${inventory.length} screens/states`);
    const unique = new Map<string, Finding & { widths: number[] }>();
    for (const item of all) {
      const key = `${item.state}|${item.type}|${item.a}|${item.b}`;
      const entry = unique.get(key) ?? { ...item, widths: [] };
      if (!entry.widths.includes(item.width)) entry.widths.push(item.width);
      unique.set(key, entry);
    }
    const report = [...unique.values()].map((item) => `[${item.widths.join("/")}px] ${item.state}: ${item.type}: ${item.a} <-> ${item.b} (${item.detail})`);
    console.log(`Overlap audit findings: ${report.length}${report.length ? `\n  ${report.join("\n  ")}` : ""}`);
    assert.equal(report.length, 0, `overlaps or clipped text found:\n${report.join("\n")}`);
    assert.ok(readdirSync(join(dataDir, "scratch")).length >= extraFiles.length, `the ${extraFiles.length} uploads landed in the temp data root: ${JSON.stringify(readdirSync(join(dataDir, "scratch")))}`);
    assert.ok(existsSync(join(dataDir, "config", "workspaces.json")), "the server seeded its workspaces into the temp data root");
    assert.equal(repoScratchCount(), repoScratchBefore, "the repo's own scratch/ gained no files");
    assert.equal(readRepoWorkspaces(), repoWorkspacesBefore, "the repo's workspaces file is untouched");
  } finally {
    // The temp folder is removed whatever the check says.
    try {
      proxy?.close();
      if (server.exitCode === null && server.signalCode === null) { const exited = once(server, "exit"); server.kill(); await Promise.race([exited, delay(7000)]); }
      assert.ok(server.exitCode !== null || server.signalCode !== null, `server PID ${server.pid} exited after the overlap audit`);
    } finally { await removeWithRetry(temp); }
  }
});
