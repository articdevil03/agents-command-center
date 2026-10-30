import { SERVER_START_MS } from "./server-start.ts";
// Pack 18 crew editor test harness: the real page in a real headless Chrome, its state taken from a real server. The server starts on a
// temp data root and adds, through its own addTab, a Marketing tab and a "Start blank" tab next to its first (Our process) tab. The page
// talks to a fake socket, as in the other page tests, so every message the editor sends is recorded and the server's answers are delivered
// by hand. Fake CLI runner, temp data root, free port, never 4317. Used by test/pack18-editor*.test.ts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stopChromeTree, chromeStopBoundMs, CHROME_CLOSE_GRACE_MS } from "./chrome-stop.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { newAppKey, keyedWsUrl } from "./temp-root.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";

const HOST = "127.0.0.1";
const APP_KEY = newAppKey();
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPO = resolve(".");
export const delay = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
export const J = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
export const ED = "[data-setup-editor]";
// A test's own budget plus the harness's Chrome stop, derived from the helper.
export const editorTestMs = (withoutChromeStopMs: number) => withoutChromeStopMs + chromeStopBoundMs(CHROME_CLOSE_GRACE_MS);

// The real server's state once its own addTab has added a Marketing tab and a Design tab that starts blank next to the first tab.
const EXTRA_TABS = [
  { setupName: "Marketing", message: { name: "Launch posts", kind: "mkt", template: "marketing" } },
  { setupName: "Start blank", message: { name: "Scratch", kind: "design", template: "blank" } },
];
function serverState(port: number): Promise<any> {
  return new Promise((ok, bad) => {
    const ws = new WebSocket(keyedWsUrl(`ws://${HOST}:${port}`, APP_KEY), { origin: `http://${HOST}:${port}` });
    const timer = setTimeout(() => { ws.terminate(); bad(new Error("server state request timed out")); }, 10_000);
    const asked = new Set<string>();
    ws.once("open", () => ws.send(JSON.stringify({ type: "hello" })));
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "error" && message.action === "addTab") { clearTimeout(timer); ws.close(); bad(new Error(message.message)); return; }
      if (message.type !== "state") return;
      const project = message.projects[0];
      const missing = EXTRA_TABS.find((extra) => !project.tabs.some((tab: any) => tab.setupName === extra.setupName));
      if (!missing) { clearTimeout(timer); ws.close(); ok(message); return; }
      if (!asked.has(missing.setupName)) { asked.add(missing.setupName); ws.send(JSON.stringify({ type: "addTab", projectId: project.id, ...missing.message })); }
    });
    ws.once("error", (error) => { clearTimeout(timer); bad(error); });
  });
}

function bootstrap(seed: any) {
  return `
window.__ccErrors=[];window.__sent=[];
window.cc={appKey:async()=>${JSON.stringify(APP_KEY)},pickFolder:async()=>null,openObsidian:async()=>({ok:true})};
window.__ccSeed=${J(seed)};window.__ccHistory={};
window.addEventListener("error",(e)=>window.__ccErrors.push(String(e.message||"browser error")));
window.addEventListener("unhandledrejection",(e)=>window.__ccErrors.push(String(e.reason?.message||e.reason||"unhandled rejection")));
const __ccConsoleError=console.error.bind(console);console.error=(...a)=>{window.__ccErrors.push("console.error: "+a.map(String).join(" "));__ccConsoleError(...a)};
class FakeWebSocket{
  static OPEN=1;static CONNECTING=0;
  constructor(){this.readyState=0;this.listeners=new Map();window.__socket=this;setTimeout(()=>{this.readyState=1;this.emit("open",{})},0)}
  addEventListener(name,fn){const items=this.listeners.get(name)||[];items.push(fn);this.listeners.set(name,items)}
  emit(name,event){for(const fn of this.listeners.get(name)||[])fn(event)}
  deliver(message){this.emit("message",{data:JSON.stringify(message)})}
  history(tabId){this.deliver({type:"chatHistory",tabId,messages:window.__ccHistory[tabId]||[],revision:1,savedRevision:1})}
  send(raw){const message=JSON.parse(raw);window.__sent.push(message);
    if(message.type==="hello"){this.deliver({...structuredClone(window.__ccSeed),type:"state"});this.history(window.__ccSeed.selectedTabId)}
    else if(message.type==="selectTab"){window.__ccSeed.selectedTabId=message.tabId;this.deliver({...structuredClone(window.__ccSeed),type:"state"});this.history(message.tabId)}}
  close(){this.readyState=3;this.emit("close",{})}
}
window.WebSocket=FakeWebSocket;
window.__ccDeliver=(message)=>window.__socket.deliver(message);
`;
}

export type Page = {
  ev: (expression: string) => Promise<any>;
  waitFor: (expression: string, label: string, timeoutMs?: number) => Promise<void>;
  page: (method: string, params?: Record<string, unknown>) => Promise<any>;
  seed: any; ours: any; mkt: any; blank: any;
};

// scrollbars: draw the page's scroll bars (the screenshots show there is no sideways one); the checks run without them, as the other page tests do.
export async function withPage(body: (page: Page) => Promise<void>, options: { scrollbars?: boolean } = {}) {
  assert.ok(existsSync(CHROME), `Headless Chrome is required at ${CHROME}; set CC_SKIP_BROWSER=1 only when intentionally running without it`);
  const temp = mkdtempSync(join(tmpdir(), "cc-p18editor-"));
  const dataDir = join(temp, "data"); mkdirSync(join(dataDir, "config"), { recursive: true });
  const home = join(temp, "home"); mkdirSync(home, { recursive: true });
  const script = join(temp, "fake-cli-script.json");
  writeFileSync(script, JSON.stringify({ responses: {} }));
  let serverPort = 0; // read from the server's ready line below
  const env = { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_CLI_RECORD: join(temp, "argv.jsonl"), CC_DATA_DIR: dataDir, CC_TEST_FORCE_PACKAGED: "1", CC_PORT: "0", CC_APP_KEY: APP_KEY, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1" };
  assert.equal(env.CC_PORT, "0"); // the OS picks the port at the server's own listen, so no other test can take it first
  const repoWorkspacesPath = join(REPO, "config", "workspaces.json");
  const readRepoWorkspaces = () => (existsSync(repoWorkspacesPath) ? readFileSync(repoWorkspacesPath, "utf8") : null), repoWorkspacesBefore = readRepoWorkspaces();
  const server = spawn(process.execPath, [join(REPO, "server", "index.ts")], { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  attachCrashCatcher(server.pid, "pack18-editor");
  let proxy: http.Server | null = null;
  let chrome: ReturnType<typeof spawn> | null = null;
  let socket: WebSocket | null = null;
  try {
    await new Promise<void>((ok, bad) => {
      let output = ""; const timer = setTimeout(() => bad(new Error(`server did not become ready; output=${output}`)), SERVER_START_MS);
      server.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); const line = /running at http:\/\/127\.0\.0\.1:(\d+)/.exec(output); if (line) { clearTimeout(timer); serverPort = Number(line[1]); ok(); } });
      server.once("exit", (code) => bad(new Error(`server exited early (${code}); output=${output}`)));
    });
    assert.notEqual(serverPort, 4317, "the test server must never use the real app's port");
    const seed = await serverState(serverPort);
    const tabs = seed.projects[0].tabs;
    const ours = tabs.find((tab: any) => tab.setupName === "Our process"), mkt = tabs.find((tab: any) => tab.setupName === "Marketing"), blank = tabs.find((tab: any) => tab.setupName === "Start blank");
    assert.ok(ours && mkt && blank, `control: the server gave an Our process tab, a Marketing tab and a blank tab (got ${tabs.map((tab: any) => tab.setupName).join(", ")})`);
    seed.selectedTabId = ours.id;
    const html = readFileSync(join(REPO, "public", "index.html"), "utf8").replace(/<link\b[^>]*https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, "")
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") // the page's policy stays, except for the inline bootstrap injected here
      .replace("</head>", `<script>${bootstrap(seed)}</script>\n</head>`);
    proxy = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname === "/__stream") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html); return; }
      const headers = { ...request.headers, host: `${HOST}:${serverPort}`, origin: `http://${HOST}:${serverPort}`, "accept-encoding": "identity" };
      const upstream = http.request({ host: HOST, port: serverPort, method: request.method, path: request.url, headers }, (result) => { response.writeHead(result.statusCode ?? 500, result.headers); result.pipe(response); });
      upstream.on("error", (error) => { response.writeHead(502); response.end(error.message); });
      request.pipe(upstream);
    });
    await new Promise<void>((ok, bad) => { proxy!.once("error", bad); proxy!.listen(0, HOST, ok); });
    const proxyPort = (proxy.address() as { port: number }).port;

    const profile = join(temp, "chrome"); mkdirSync(profile, { recursive: true });
    chrome = spawn(CHROME, [
      "--headless=new", "--remote-debugging-port=0", "--window-size=1296,1030", "--window-position=1920,0", `--user-data-dir=${profile}`,
      "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-gpu-sandbox", "--use-gl=swiftshader",
      "--disable-dev-shm-usage", "--disable-background-networking", "--no-proxy-server", ...(options.scrollbars ? [] : ["--hide-scrollbars"]), "about:blank",
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    chrome.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const portFile = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 15_000;
    while (!existsSync(portFile) && Date.now() < deadline && chrome.exitCode === null) await delay(50);
    assert.ok(existsSync(portFile), `Chrome PID ${chrome.pid} opened DevTools; stderr=${stderr.slice(-800)}`);
    let devtoolsPort = 0;
    while (!devtoolsPort && Date.now() < deadline) {
      try { devtoolsPort = Number(/^(\d+)\r?\n/.exec(readFileSync(portFile, "utf8"))?.[1] ?? 0); } catch { /* locked: retried */ }
      if (!devtoolsPort) await delay(50);
    }
    assert.ok(devtoolsPort > 0, `Chrome wrote a DevTools port to ${portFile} before the deadline`);
    const version = await fetch(`http://${HOST}:${devtoolsPort}/json/version`).then((response) => response.json()) as { webSocketDebuggerUrl?: string };
    socket = new WebSocket(version.webSocketDebuggerUrl!);
    let sequence = 0;
    const pending = new Map<number, { ok: (message: any) => void; bad: (error: Error) => void }>();
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id || !pending.has(message.id)) return;
      const waiting = pending.get(message.id)!; pending.delete(message.id);
      if (message.error) waiting.bad(new Error(message.error.message ?? JSON.stringify(message.error))); else waiting.ok(message);
    });
    await new Promise<void>((ok, bad) => { socket!.once("open", ok); socket!.once("error", bad); });
    const open = socket;
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((ok, bad) => {
      if (open.readyState !== WebSocket.OPEN) { bad(new Error(`DevTools socket is not open for ${method}`)); return; }
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); bad(new Error(`DevTools command timed out: ${method}`)); }, 30_000);
      pending.set(id, { ok(message) { clearTimeout(timer); ok(message); }, bad(error) { clearTimeout(timer); bad(error); } });
      open.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const created = await send("Target.createTarget", { url: "about:blank" });
    const attached = await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
    const sessionId = attached.result.sessionId as string;
    const page = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
    const ev = async (expression: string) => {
      const response = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.result?.exceptionDetails) throw new Error(`Browser expression failed: ${response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text}`);
      return response.result?.result?.value;
    };
    const waitFor = async (expression: string, label: string, timeoutMs = 15_000) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) { try { if (await ev(expression)) return; } catch { /* page still loading */ } await delay(40); }
      assert.fail(`timed out waiting for ${label}`);
    };
    await page("Page.enable"); await page("Runtime.enable");
    await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page("Page.navigate", { url: `http://${HOST}:${proxyPort}/__stream` });
    await waitFor(`document.querySelectorAll("#crew .seat").length>0&&typeof window.CC_SETUP_EDITOR?.render==="function"`, "app render with the editor loaded");
    await body({ ev, waitFor, page, seed, ours, mkt, blank });
    assert.deepEqual(await ev("window.__ccErrors"), [], "no page errors");
    assert.equal(readRepoWorkspaces(), repoWorkspacesBefore, "the repo's workspaces file is untouched");
  } finally {
    try { if (socket?.readyState === WebSocket.OPEN) await Promise.race([new Promise((ok) => { socket!.once("message", ok); socket!.send(JSON.stringify({ id: 1e9, method: "Browser.close" })); }), delay(5000)]); } catch { /* gone */ }
    socket?.close();
    let chromeStop: Awaited<ReturnType<typeof stopChromeTree>> | null = null;
    try {
      chromeStop = chrome ? await stopChromeTree(chrome, { graceMs: CHROME_CLOSE_GRACE_MS }) : null;
      proxy?.close();
      if (server.exitCode === null && server.signalCode === null) { const exited = once(server, "exit"); server.kill(); await Promise.race([exited, delay(7000)]); }
      assert.ok(server.exitCode !== null || server.signalCode !== null, `server PID ${server.pid} exited`);
      assert.ok(!chrome || chrome.exitCode !== null || chrome.signalCode !== null, `Chrome PID ${chrome?.pid} exited: ${chromeStop?.facts.join("; ") ?? "the stop never ran"}`);
    } finally { removeWithRetry(temp); }
  }
}

export const skipped = (t: { skip: (message: string) => void }) => { if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return true; } return false; };

// ---- helpers ----
// The setup exactly as the server's validateSetup takes it, written here on its own (not the editor's code) to compare what was sent.
const SEAT_FIELDS = ["slot", "name", "role", "cli", "model", "effort", "canWrite", "isLeader", "advisor", "orchestrates", "pic"];
export const bareSeat = (seat: any) => Object.fromEntries(SEAT_FIELDS.filter((key) => seat[key] !== undefined && !(key === "orchestrates" && seat[key] !== true)).map((key) => [key, seat[key]]));
export const sentOf = (ev: Page["ev"], type: string): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type===${J(type)})`);
// Clicks the first element the selector finds; FAILS when it finds none, so a renamed control can never pass silently.
export async function click(ev: Page["ev"], selector: string, focusFirst = false): Promise<void> {
  const found = await ev(`(()=>{const el=document.querySelector(${J(selector)});if(!el)return false;${focusFirst ? "el.focus();" : ""}el.click();return true})()`);
  assert.equal(found, true, `the control ${selector} was found`);
}
// Opens Settings on the selected tab and waits for the crew editor's seat rows.
export async function openEditor(ev: Page["ev"], waitFor: Page["waitFor"]): Promise<void> {
  await click(ev, "#setBtn");
  await waitFor(`document.querySelectorAll(${J(`${ED} [data-se-row]`)}).length>0`, "the crew editor is drawn in Settings");
}
// Selects a tab through the page's own tab strip (Settings closed first) and opens the editor on it.
export async function openTab(ev: Page["ev"], waitFor: Page["waitFor"], tabId: string): Promise<void> {
  await ev(`(()=>{const close=document.querySelector("#setModal:not([hidden]) [data-close]");close?.click();return true})()`);
  await click(ev, `#tabs [role=tab][data-tab-id="${tabId}"]`);
  await waitFor(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId===${J(tabId)}`, `the tab ${tabId} is shown`);
  await openEditor(ev, waitFor);
}
// The slots of the crew list, top to bottom.
export const rowSlots = (ev: Page["ev"]): Promise<string[]> => ev(`[...document.querySelectorAll(${J(`${ED} [data-se-row]`)})].map((el)=>el.dataset.seRow)`);
// Opens a seat's card (its row is a toggle, so an open card is left open).
export async function openSeat(ev: Page["ev"], slot: string): Promise<void> {
  if (await ev(`Boolean(document.querySelector(${J(`${ED} [data-se-card="${slot}"]`)}))`)) return;
  await click(ev, `${ED} [data-se-row="${slot}"]`);
  assert.equal(await ev(`Boolean(document.querySelector(${J(`${ED} [data-se-card="${slot}"]`)}))`), true, `the card of ${slot} opened`);
}
// Picks a role from a seat's role list (null = Custom...), the way a click does.
export async function pickRole(ev: Page["ev"], slot: string, role: string | null): Promise<void> {
  await openSeat(ev, slot);
  await click(ev, `${ED} [data-se-role="${slot}"]`);
  await click(ev, role === null ? `${ED} [data-se-rolemenu="${slot}"] [data-se-custom-role]` : `${ED} [data-se-rolemenu="${slot}"] [data-se-pick-role="${role}"]`);
}
// Adds a seat with "Add a seat" and returns its slot (the card opens on it).
export async function addSeat(ev: Page["ev"]): Promise<string> {
  const before = await rowSlots(ev);
  await click(ev, `${ED} [data-se-add]`);
  const slot = (await rowSlots(ev)).find((item) => !before.includes(item));
  assert.ok(slot, "a new row was added");
  return slot!;
}
export const bodyTop = (ev: Page["ev"]): Promise<number> => ev(`document.querySelector("#setBody").scrollTop`);
// The server's state for one tab, changed by `change` (page code on `tab`), delivered like a broadcast.
export const deliverTab = (ev: Page["ev"], tabId: string, change: string): Promise<boolean> => ev(`(()=>{const tab=window.__ccSeed.projects[0].tabs.find((t)=>t.id===${J(tabId)});${change};__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});return true})()`);
export async function setValue(ev: Page["ev"], selector: string, value: string): Promise<void> {
  const found = await ev(`(()=>{const el=document.querySelector(${J(selector)});if(!el)return false;el.focus();el.value=${J(value)};el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  assert.equal(found, true, `the field ${selector} was found`);
}
