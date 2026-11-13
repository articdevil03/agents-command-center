export { taskFixture, TASK_SEATS, type TaskStage } from "./pack18-editor-task-fixture.ts";
import { waitForFirstRender } from "./page-first-render.ts";
import { SERVER_START_MS } from "./server-start.ts";
// Fixed-crew page test harness: the real page in a real headless Chrome, its state taken from a real server that started on a temp data
// root seeded with fixed crew tabs. The page talks to a fake socket (every message it sends is recorded and the server's answers are
// delivered by hand) or, with realSocket, straight to the server. Fake CLI runner, temp data root, free port, never 4317.
// Fixture "fixed" is a fresh install's one fixed crew tab; "fixed2" seeds a second, separate fixed tab next to it.
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
import { freshFixedCrew } from "../server/fixed-crew/preferences.ts";

const HOST = "127.0.0.1";
const APP_KEY = newAppKey();
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPO = resolve(".");
export const delay = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
export const J = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
// A test's own budget plus the harness's Chrome stop, derived from the helper.
export const editorTestMs = (withoutChromeStopMs: number) => withoutChromeStopMs + chromeStopBoundMs(CHROME_CLOSE_GRACE_MS);

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
  // the server's own state before and after its first CLI check (which fills the automatic positions); fixed is the first fixed tab,
  // secondFixed the second one (fixture "fixed2" only)
  seed: any; fixed: any; secondFixed?: any; discovered?: any; dataDir: string; work: string; reload: () => Promise<void>;
};
// tasks (Pack 26 Block 3c): saved task files, by tab id, written into the temp data root before the server starts and reads them.
export type PageOptions = { scrollbars?: boolean; fixture?: "fixed" | "fixed2"; realSocket?: boolean; tasks?: (work: string) => Record<string, unknown> };
const SECOND_FIXED_ID = "second-fixed";
const FIXED_READY = `typeof window.CC_FIXED_CREW?.init==="function"&&Boolean(document.querySelector("#fixedView:not([hidden]) #fcWorkSettings"))`;
// The fixed fixtures' server state: as it starts (nothing checked yet, so no model anywhere), then after Settings' own refreshSettings.
function fixedStates(port: number, discover: boolean, tabCount: number): Promise<{ fresh: any; discovered: any }> {
  return new Promise((ok, bad) => {
    const ws = new WebSocket(keyedWsUrl(`ws://${HOST}:${port}`, APP_KEY), { origin: `http://${HOST}:${port}` });
    const timer = setTimeout(() => { ws.terminate(); bad(new Error("fixed crew state request timed out")); }, 15_000);
    let fresh: any = null, answered = false;
    const done = (value: any) => { clearTimeout(timer); ws.close(); ok(value); };
    ws.once("open", () => ws.send(JSON.stringify({ type: "hello" })));
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "error") { clearTimeout(timer); ws.close(); bad(new Error(message.message)); return; }
      if (message.type === "actionResult" && message.requestId === "fcui-discover") answered = true;
      if (message.type !== "state") return;
      const tabs = message.projects[0].tabs;
      if (tabs.length !== tabCount) { clearTimeout(timer); ws.close(); bad(new Error(`expected ${tabCount} fixed tab(s), the server gave ${tabs.length}`)); return; }
      if (!fresh) { fresh = message; if (!discover) { done({ fresh, discovered: null }); return; } ws.send(JSON.stringify({ type: "refreshSettings", requestId: "fcui-discover" })); return; }
      if (answered && tabs.every((tab: any) => tab.fixedCrew?.preferences?.coder?.assignment)) done({ fresh, discovered: message });
    });
    ws.once("error", (error) => { clearTimeout(timer); bad(error); });
  });
}
// A real-socket page gets the app key and a folder picker the way the Electron bridge would hand them over, and records what it sends.
function realBootstrap(folder: string) {
  return `window.__ccErrors=[];window.__sent=[];
window.cc={appKey:async()=>${JSON.stringify(APP_KEY)},pickFolder:async()=>${J(folder)},openObsidian:async()=>({ok:true})};
window.addEventListener("error",(e)=>window.__ccErrors.push(String(e.message||"browser error")));
window.addEventListener("unhandledrejection",(e)=>window.__ccErrors.push(String(e.reason?.message||e.reason||"unhandled rejection")));
const __ccSend=WebSocket.prototype.send;WebSocket.prototype.send=function(raw){try{window.__sent.push(JSON.parse(raw))}catch{}return __ccSend.call(this,raw)};`;
}

// scrollbars: draw the page's scroll bars (the screenshots show there is no sideways one); the checks run without them, as the other page tests do.
export async function withPage(body: (page: Page) => Promise<void>, options: PageOptions = {}) {
  const fixture = options.fixture ?? "fixed";
  assert.ok(existsSync(CHROME), `Headless Chrome is required at ${CHROME}; set CC_SKIP_BROWSER=1 only when intentionally running without it`);
  const temp = mkdtempSync(join(tmpdir(), "cc-p18editor-"));
  const dataDir = join(temp, "data"); mkdirSync(join(dataDir, "config"), { recursive: true });
  const folder = join(temp, "work"); mkdirSync(folder);
  // Each fixed tab gets its own freshFixedCrew(); the server projects its runtime identity (seat keys, process state) itself.
  const fixedTab = (id: string, name: string) => ({ id, name, folder, kind: "dev", setupName: "Fixed crew", crew: [], steps: [], lookPause: false, fixedCrew: freshFixedCrew() });
  const tabs = fixture === "fixed2" ? [fixedTab("example-development", "Development"), fixedTab(SECOND_FIXED_ID, "Second")] : [fixedTab("example-development", "Development")];
  writeFileSync(join(dataDir, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "example", name: "Example project", folder, tabs }] }));
  if (options.tasks) { mkdirSync(join(dataDir, "tasks")); for (const [tabId, task] of Object.entries(options.tasks(folder))) writeFileSync(join(dataDir, "tasks", `${tabId}.json`), JSON.stringify(task, null, 2)); }
  const home = join(temp, "home"); mkdirSync(home, { recursive: true });
  const script = join(temp, "fake-cli-script.json");
  // The fixed fixtures answer a version check for Claude and Codex, so Settings' Check again finds them installed (OpenCode stays missing).
  const versions = Object.fromEntries(["claude", "codex"].map((cli) => [JSON.stringify([cli, "--version"]), { code: 0, stdout: `${cli} 1.0.0`, stderr: "" }]));
  writeFileSync(script, JSON.stringify({ responses: versions }));
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
    const states = await fixedStates(serverPort, !options.realSocket, tabs.length);
    const seed = states.fresh;
    const seeded = seed.projects[0].tabs;
    for (const state of [states.fresh, states.discovered]) if (state) assert.deepEqual(state.projects[0].tabs.map((tab: any) => tab.id), tabs.map((tab) => tab.id), "control: the server kept every seeded fixed tab, in order");
    const fixed = seeded.find((tab: any) => tab.id === "example-development"), secondFixed = fixture === "fixed2" ? seeded.find((tab: any) => tab.id === SECOND_FIXED_ID) : undefined;
    assert.ok(fixed?.fixedCrew && (fixture === "fixed" || secondFixed?.fixedCrew), `control: the server gave ${fixture === "fixed2" ? "two valid fixed crew tabs" : "a fixed crew tab"} (got ${seeded.map((tab: any) => tab.setupName).join(", ")})`);
    if (secondFixed) { const owners = [fixed, secondFixed].map((tab: any) => [tab.id, tab.processState?.tabId]); assert.ok(owners.every(([id, owner]) => id === owner) && owners[0][0] !== owners[1][0], `control: each fixed tab has its own runtime identity (${JSON.stringify(owners)})`); }
    seed.selectedTabId = fixed.id;
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
    if (options.realSocket) await page("Page.addScriptToEvaluateOnNewDocument", { source: realBootstrap(folder) });
    await page("Page.navigate", { url: options.realSocket ? `http://${HOST}:${serverPort}/` : `http://${HOST}:${proxyPort}/__stream` });
    const ready = FIXED_READY;
    await waitForFirstRender(waitFor, ready, "app render with the fixed crew loaded");
    const firstRender = waitForFirstRender.bind(null, waitFor, ready);
    const reload = async () => { await page("Page.reload", { ignoreCache: true }); await firstRender("app render after a reload"); };
    await body({ ev, waitFor, page, seed, fixed, secondFixed, discovered: states.discovered, dataDir, work: folder, reload });
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
export const sentOf = (ev: Page["ev"], type: string): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type===${J(type)})`);
// Clicks the first element the selector finds; FAILS when it finds none, so a renamed control can never pass silently.
export async function click(ev: Page["ev"], selector: string, focusFirst = false): Promise<void> {
  const found = await ev(`(()=>{const el=document.querySelector(${J(selector)});if(!el)return false;${focusFirst ? "el.focus();" : ""}el.click();return true})()`);
  assert.equal(found, true, `the control ${selector} was found`);
}
export const bodyTop = (ev: Page["ev"]): Promise<number> => ev(`document.querySelector("#setBody").scrollTop`);
// The server's state for one tab, changed by `change` (page code on `tab`), delivered like a broadcast.
export const deliverTab = (ev: Page["ev"], tabId: string, change: string): Promise<boolean> => ev(`(()=>{const tab=window.__ccSeed.projects[0].tabs.find((t)=>t.id===${J(tabId)});${change};__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});return true})()`);
export async function setValue(ev: Page["ev"], selector: string, value: string): Promise<void> {
  const found = await ev(`(()=>{const el=document.querySelector(${J(selector)});if(!el)return false;el.focus();el.value=${J(value)};el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  assert.equal(found, true, `the field ${selector} was found`);
}

// ---- Pack 26 (fixed crew) helpers ----
// One message delivered to the page as the server would send it (a fake-socket page only).
export const deliver = (ev: Page["ev"], message: unknown): Promise<boolean> => ev(`(()=>{__ccDeliver(${J(message)});return true})()`);
// A state built from the server's own one, changed by `change` (page code on `state`), delivered and kept as the seed for reconnects.
export const deliverState = (ev: Page["ev"], state: unknown, change = ""): Promise<boolean> => ev(`(()=>{const state=${J(state)};state.selectedTabId=window.__ccSeed.selectedTabId;${change};window.__ccSeed=state;__ccDeliver({...structuredClone(state),type:"state"});return true})()`);
const KEYS: Record<string, [string, number, string?]> = { Tab: ["Tab", 9], Enter: ["Enter", 13, "\r"], " ": ["Space", 32, " "], Escape: ["Escape", 27] };
// A real key press through DevTools (keyDown with its text, then keyUp), Shift held when asked.
export async function press(page: Page["page"], key: keyof typeof KEYS, shift = false): Promise<void> {
  const [code, vk, text] = KEYS[key], base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
  await page("Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text } : {}) });
  await page("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}
