import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { newAppKey, keyedWsUrl } from "./temp-root.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";

// Streaming and message-cache audit: a real headless Chrome runs the real public/app.js against a fake socket, so every
// message the server would send is delivered by this test. Proves a long streamed reply makes a bounded number of full chat
// renders, shows exactly the streamed text, keeps the reader at the bottom, and that the per-message html cache can never
// show a stale bubble. Fake CLI runner, temp data, free port, never 4317.

const HOST = "127.0.0.1";
// The server's CC_APP_KEY; the page gets it from window.cc.appKey() like the Electron preload gives it.
const APP_KEY = newAppKey();
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPO = resolve(".");
const delay = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const J = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

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

function backendState(port: number): Promise<any> {
  return new Promise((ok, bad) => {
    const ws = new WebSocket(keyedWsUrl(`ws://${HOST}:${port}`, APP_KEY), { origin: `http://${HOST}:${port}` });
    const timer = setTimeout(() => { ws.terminate(); bad(new Error("server state request timed out")); }, 8000);
    ws.once("open", () => ws.send(JSON.stringify({ type: "hello" })));
    ws.on("message", (data) => { const message = JSON.parse(data.toString()); if (message.type === "state") { clearTimeout(timer); ws.close(); ok(message); } });
    ws.once("error", (error) => { clearTimeout(timer); bad(error); });
  });
}

// Two tabs of one project: the real state's first tab and a clone of it.
function buildSeed(base: any) {
  const state = structuredClone(base);
  const project = state.projects[0];
  const first = project.tabs[0];
  if (project.tabs.length < 2) {
    const clone = structuredClone(first);
    clone.id = `${first.id}-second`; clone.name = "Second tab"; clone.processState.tabId = clone.id;
    for (const seat of clone.crew) seat.seatKey = `${clone.id}.${seat.slot}`;
    project.tabs.push(clone);
  }
  state.selectedTabId = first.id;
  return state;
}

// The fake socket answers like the server: hello -> state + the selected tab's history; selectTab -> state + that tab's history.
function bootstrap(seed: any) {
  return `
window.__ccErrors=[];window.__sent=[];
window.cc={appKey:async()=>${JSON.stringify(APP_KEY)},pickFolder:async()=>null,openObsidian:async()=>({ok:true})};
window.__ccSeed=${J(seed)};window.__ccHistory={};
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

// Counts every full replacement of the chat column (#view.innerHTML = ...), and drives a streamed reply.
const PROBE_JS = String.raw`
(() => {
  window.__renders = 0;
  const d = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  Object.defineProperty(Element.prototype, "innerHTML", { configurable: true, get() { return d.get.call(this); }, set(v) { if (this.id === "view") window.__renders++; d.set.call(this, v); } });
  window.__stream = async (tabId, parts, gap) => { for (const text of parts) { window.__ccDeliver({ type: "chatDelta", tabId, text }); await new Promise((ok) => setTimeout(ok, gap)); } return true; };
  window.__bubble = () => document.querySelector("#view [data-stream] .md")?.textContent ?? null;
  window.__gap = () => { const v = document.querySelector("#view"); return v.scrollHeight - v.scrollTop - v.clientHeight; };
})()
`;

type Page = {
  ev: (expression: string) => Promise<any>;
  waitFor: (expression: string, label: string, timeoutMs?: number) => Promise<void>;
  seed: any; tabA: string; tabB: string;
};

async function withPage(body: (page: Page) => Promise<void>) {
  assert.ok(existsSync(CHROME), `Headless Chrome is required at ${CHROME}; set CC_SKIP_BROWSER=1 only when intentionally running without it`);
  const temp = mkdtempSync(join(tmpdir(), "cc-streamperf-"));
  const dataDir = join(temp, "data"); mkdirSync(join(dataDir, "config"), { recursive: true });
  const home = join(temp, "home"); mkdirSync(home, { recursive: true });
  const script = join(temp, "fake-cli-script.json");
  writeFileSync(script, JSON.stringify({ responses: {} }));
  const serverPort = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_CLI_RECORD: join(temp, "argv.jsonl"), CC_DATA_DIR: dataDir, CC_TEST_FORCE_PACKAGED: "1", CC_PORT: String(serverPort), CC_APP_KEY: APP_KEY, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1" };
  assert.notEqual(Number(env.CC_PORT), 4317);
  // The EFFECT, not the env: this server must run on the temp data root (under node --test a CC_DATA_DIR alone is ignored),
  // so it seeds its own folders there and the repo's own scratch/ and workspaces file are left exactly as they were.
  const repoScratch = join(REPO, "scratch"), repoScratchCount = () => (existsSync(repoScratch) ? readdirSync(repoScratch).length : 0);
  const repoScratchBefore = repoScratchCount(), repoWorkspacesPath = join(REPO, "config", "workspaces.json");
  // The file is untracked, so a fresh clone has none: absent must stay absent, present must stay byte-identical.
  const readRepoWorkspaces = () => (existsSync(repoWorkspacesPath) ? readFileSync(repoWorkspacesPath, "utf8") : null), repoWorkspacesBefore = readRepoWorkspaces();
  const server = spawn(process.execPath, [join(REPO, "server", "index.ts")], { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  attachCrashCatcher(server.pid, "stream-perf");
  let proxy: http.Server | null = null;
  let chrome: ReturnType<typeof spawn> | null = null;
  let socket: WebSocket | null = null;
  try {
    await new Promise<void>((ok, bad) => {
      let output = ""; const timer = setTimeout(() => bad(new Error(`server did not become ready; output=${output}`)), 15_000);
      server.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); if (/running at http:\/\/127\.0\.0\.1:\d+/.test(output)) { clearTimeout(timer); ok(); } });
      server.once("exit", (code) => bad(new Error(`server exited early (${code}); output=${output}`)));
    });
    const seed = buildSeed(await backendState(serverPort));
    const tabA = seed.projects[0].tabs[0].id, tabB = seed.projects[0].tabs[1].id;
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
      "--headless=new", "--remote-debugging-port=0", "--window-size=1296,1030", `--user-data-dir=${profile}`,
      "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-gpu-sandbox", "--use-gl=swiftshader",
      "--disable-dev-shm-usage", "--disable-background-networking", "--no-proxy-server", "--hide-scrollbars", "about:blank",
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    chrome.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const portFile = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 15_000;
    while (!existsSync(portFile) && Date.now() < deadline && chrome.exitCode === null) await delay(50);
    assert.ok(existsSync(portFile), `Chrome PID ${chrome.pid} opened DevTools; stderr=${stderr.slice(-800)}`);
    // Chrome may still hold the file (EBUSY) or have written only part of it: read again until the whole first line is there, within the same deadline.
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
      throw new Error(`timed out waiting for ${label}`);
    };
    await page("Page.enable"); await page("Runtime.enable");
    await page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page("Page.navigate", { url: `http://${HOST}:${proxyPort}/__stream` });
    await waitFor(`document.querySelectorAll("#crew .seat").length>0&&document.querySelectorAll("#tabs [role=tab]").length>1&&document.querySelector("#view .thread")!==null`, "app render");
    await ev(PROBE_JS);
    // Control: a socket message the page cannot read is reported only through console.error, and the page-error hook must catch that.
    await ev(`window.__socket.emit("message",{data:"{not json"});true`);
    const control = await ev("window.__ccErrors");
    assert.ok(control.length === 1 && /^console\.error: Invalid Command Center message/.test(control[0]), `the console.error hook caught the unreadable message: ${JSON.stringify(control)}`);
    await ev("window.__ccErrors.length=0;true");
    await body({ ev, waitFor, seed, tabA, tabB });
    assert.deepEqual(await ev("window.__ccErrors"), [], "no page errors");
    assert.ok(existsSync(join(dataDir, "scratch")) && existsSync(join(dataDir, "config", "workspaces.json")), "the server created its scratch and workspaces in the temp data root");
    assert.equal(repoScratchCount(), repoScratchBefore, "the repo's own scratch/ gained no files");
    assert.equal(readRepoWorkspaces(), repoWorkspacesBefore, "the repo's workspaces file is untouched");
  } finally {
    try { if (socket?.readyState === WebSocket.OPEN) await Promise.race([new Promise((ok) => { socket!.once("message", ok); socket!.send(JSON.stringify({ id: 1e9, method: "Browser.close" })); }), delay(5000)]); } catch { /* gone */ }
    socket?.close();
    // The temp folder is removed whatever the checks below say; the checks still fail the test when a process is left running.
    try {
      if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
        const exited = once(chrome, "exit");
        await Promise.race([exited, delay(7000)]);
        // chrome.kill() ends only the main chrome.exe on Windows; its renderer and GPU children keep running and hold the profile folder. Kill this child's own tree (by pid, never by name).
        if (chrome.exitCode === null && chrome.signalCode === null) { spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(chrome.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15_000 }); await Promise.race([exited, delay(20_000)]); }
      }
      proxy?.close();
      if (server.exitCode === null && server.signalCode === null) { const exited = once(server, "exit"); server.kill(); await Promise.race([exited, delay(7000)]); }
      assert.ok(server.exitCode !== null || server.signalCode !== null, `server PID ${server.pid} exited`);
      assert.ok(!chrome || chrome.exitCode !== null || chrome.signalCode !== null, `Chrome PID ${chrome?.pid} exited`);
    } finally { removeWithRetry(temp); }
  }
}

const long = (index: number) => `Reply ${index}: ${"some realistic words that make a message a normal length. ".repeat(5)}`;
const historyOf = (count: number) => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: index % 2 ? long(index) : `Question ${index}: please do the next step.`, at: 1_700_000_000_000 + index * 1000, revision: index + 1 }));

test("streamed reply: a 200-message chat and 600 deltas make a bounded number of full chat renders, show the exact text and keep the bottom", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  await withPage(async ({ ev, waitFor, tabA }) => {
    await ev(`__ccDeliver({type:"chatHistory",tabId:${J(tabA)},messages:${J(historyOf(200))},revision:200,savedRevision:200});true`);
    await waitFor(`document.querySelectorAll("#view .msg").length===200`, "200 messages rendered");
    // Control: the chat really scrolls, and sits at the bottom to start with.
    assert.ok(await ev(`document.querySelector("#view").scrollHeight-document.querySelector("#view").clientHeight`) > 1000, "the 200-message chat scrolls");
    await ev(`(()=>{const v=document.querySelector("#view");v.scrollTop=v.scrollHeight;return true})()`);
    assert.ok(await ev("__gap()") <= 4, "starts at the bottom");

    const parts = Array.from({ length: 600 }, (_, index) => `w${index} `);
    const full = parts.join("");
    await ev(`window.__renders=0;true`);
    await ev(`__stream(${J(tabA)},${J(parts)},3)`);
    await waitFor(`__bubble()===${J(full)}`, "the last frame paints the whole streamed text");
    const duringStream = await ev("window.__renders");
    console.log(`Stream perf: ${parts.length} deltas, ${duringStream} full chat renders during the stream`);
    assert.ok(duringStream >= 1, "the first delta created the streaming bubble (the render counter is alive)");
    assert.ok(duringStream <= 3, `at most 3 full chat renders for 600 deltas, got ${duringStream}`);
    assert.equal(await ev("__bubble()"), full, "the streamed text is shown exactly");
    assert.ok(await ev("__gap()") <= 4, "stays stuck to the bottom while streaming");

    await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"assistant",text:${J(full)},at:1_700_000_999_000,revision:201});__ccDeliver({type:"chatDone",tabId:${J(tabA)},revision:201,savedRevision:201});true`);
    await waitFor(`document.querySelector("#view [data-stream]")===null&&document.querySelectorAll("#view .msg").length===201`, "the final message replaces the bubble");
    const afterDone = await ev("window.__renders");
    assert.ok(afterDone - duringStream <= 3, `finishing the reply costs at most 3 renders, got ${afterDone - duringStream}`);
    assert.equal(await ev(`document.querySelector("#view .msg:last-of-type .body .md").textContent`), full, "the final message shows the same text");
    assert.ok(await ev("__gap()") <= 4, "still at the bottom after the reply is saved");
  });
});

test("streamed text is escaped, background tabs and tab switches never leak, the final message replaces the bubble, the timer paints without frames", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    const history = (tabId: string, messages: unknown[]) => ev(`__ccDeliver({type:"chatHistory",tabId:${J(tabId)},messages:${J(messages)},revision:9,savedRevision:9});true`);
    const delta = (tabId: string, text: string) => ev(`__ccDeliver({type:"chatDelta",tabId:${J(tabId)},text:${J(text)}});true`);
    const base = [{ role: "user", text: "hello", at: 1_700_000_000_000, revision: 1 }];
    await history(tabA, base);
    await history(tabB, [{ role: "user", text: "tab B history", at: 1_700_000_000_000, revision: 1 }]);
    await waitFor(`document.querySelectorAll("#view .msg").length===1`, "tab A renders");

    await t.test("streamed text with HTML special characters is escaped, on the first delta and on later ones", async () => {
      const first = `<img src=x onerror="window.__pwn=1"> & "q" `, second = `<b>bold</b> 'single' &amp; `;
      await delta(tabA, first);
      await waitFor(`__bubble()!==null`, "bubble");
      assert.equal(await ev("__bubble()"), first, "the first delta is text, not markup");
      await delta(tabA, second);
      await waitFor(`__bubble()===${J(first + second)}`, "later delta painted");
      assert.equal(await ev(`document.querySelectorAll("#view [data-stream] .md img, #view [data-stream] .md b").length`), 0, "no element was created from streamed text");
      assert.equal(await ev("window.__pwn"), undefined, "no streamed handler ran");
      await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"assistant",text:${J(first + second)},at:1_700_000_001_000,revision:2});__ccDeliver({type:"chatDone",tabId:${J(tabA)},revision:2,savedRevision:2});true`);
      await waitFor(`document.querySelector("#view [data-stream]")===null&&document.querySelectorAll("#view .msg").length===2`, "final message");
      assert.equal(await ev(`document.querySelector("#view .msg:last-of-type .body .md").textContent`), first + second, "the saved message shows the same characters");
      assert.equal(await ev(`document.querySelectorAll("#view .msg:last-of-type .body .md img, #view .msg:last-of-type .body .md b").length`), 0, "the saved message is escaped too");
    });

    await t.test("chatDone replaces the streaming bubble with the final rendered message", async () => {
      await history(tabA, base);
      await delta(tabA, "partial words");
      await waitFor(`__bubble()==="partial words"`, "bubble");
      await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"assistant",text:"final words",at:1_700_000_002_000,revision:2});__ccDeliver({type:"chatDone",tabId:${J(tabA)},revision:2,savedRevision:2});true`);
      await waitFor(`document.querySelector("#view [data-stream]")===null`, "bubble gone");
      assert.equal(await ev(`[...document.querySelectorAll("#view .msg.mine .bubble p, #view .msg:not(.mine) .body > .md")].map((p)=>p.textContent).join("|")`), "hello|final words", "only the final message remains");
      assert.equal(await ev(`document.querySelector('#view [data-message-id="2"]')!==null`), true, "the final message is a real message row");
    });

    await t.test("a delta for a background tab does not touch the visible tab", async () => {
      await history(tabA, base);
      await delta(tabA, "visible draft");
      await waitFor(`__bubble()==="visible draft"`, "bubble");
      await delay(120);
      const before = await ev(`({renders:window.__renders,html:document.querySelector("#view").innerHTML})`);
      for (let index = 0; index < 20; index++) await delta(tabB, `background ${index} `);
      await delay(150);
      const after = await ev(`({renders:window.__renders,html:document.querySelector("#view").innerHTML})`);
      assert.equal(after.renders, before.renders, "no chat render for a background delta");
      assert.equal(after.html, before.html, "the visible chat is byte-for-byte unchanged");
      assert.equal(await ev("__bubble()"), "visible draft", "the visible draft is still its own");
    });

    await t.test("switching tabs mid-stream shows the right draft and the old frame does not paint into the new tab", async () => {
      await history(tabA, base);
      await history(tabB, [{ role: "user", text: "tab B history", at: 1_700_000_000_000, revision: 1 }]);
      await delta(tabA, "AAA ");
      await waitFor(`__bubble()==="AAA "`, "A bubble");
      // A's next frame is pending when the user switches; B starts its own stream in the same tick.
      await ev(`(()=>{
        __ccDeliver({type:"chatDelta",tabId:${J(tabA)},text:"more AAA "});
        document.querySelector('#tabs [data-tab-id=${J(tabB)}]').click();
        __ccDeliver({type:"chatDelta",tabId:${J(tabB)},text:"BBB "});
        return true})()`);
      await delay(150);
      assert.equal(await ev(`document.querySelector("#view").dataset.tabId`), tabB, "the view is B's");
      assert.equal(await ev("__bubble()"), "BBB ", "B shows only its own draft");
      await delta(tabB, "next");
      await waitFor(`__bubble()==="BBB next"`, "B keeps streaming");
      await ev(`document.querySelector('#tabs [data-tab-id=${J(tabA)}]').click();true`);
      await waitFor(`document.querySelector("#view").dataset.tabId===${J(tabA)}`, "back on A");
      await delay(120);
      assert.equal(await ev(`document.querySelector("#view").textContent.includes("BBB")`), false, "A shows nothing of B's draft");
    });

    await t.test("a frame held for tab A does not strand tab B's delta: the paint serves the chat shown now", async () => {
      await ev(`__ccDeliver({type:"chatDone",tabId:${J(tabA)}});__ccDeliver({type:"chatDone",tabId:${J(tabB)}});true`);
      await history(tabA, base);
      await history(tabB, [{ role: "user", text: "tab B history", at: 1_700_000_000_000, revision: 1 }]);
      await ev(`document.querySelector('#tabs [data-tab-id=${J(tabA)}]').click();true`);
      await waitFor(`document.querySelector("#view").dataset.tabId===${J(tabA)}`, "on A");
      await delay(300);
      await delta(tabA, "A0 ");
      await waitFor(`__bubble()==="A0 "`, "A has its streaming bubble");
      // Hold A's frame and its 50 ms fallback timer: nothing paints until this test lets the held callbacks run.
      await ev(`window.__held=[];window.__realRaf=window.requestAnimationFrame;window.__realTimeout=window.setTimeout;window.requestAnimationFrame=()=>999999;window.setTimeout=(cb,d,...a)=>d===50?(window.__held.push(cb),0):window.__realTimeout(cb,d,...a);true`);
      try {
        await delta(tabA, "A1 ");
        await ev(`document.querySelector('#tabs [data-tab-id=${J(tabB)}]').click();true`);
        await waitFor(`document.querySelector("#view").dataset.tabId===${J(tabB)}`, "on B");
        await delay(300);
        await delta(tabB, "B1 ");
        await waitFor(`__bubble()==="B1 "`, "B has its streaming bubble");
        await delta(tabB, "B2");
        assert.equal(await ev("__bubble()"), "B1 ", "B's second delta is waiting for the held frame");
        await ev(`window.__held.splice(0).forEach((cb)=>cb());true`);
        assert.equal(await ev("__bubble()"), "B1 B2", "the released paint (A's) showed B's new text");
      } finally { await ev(`window.requestAnimationFrame=window.__realRaf;window.setTimeout=window.__realTimeout;true`);
        await ev(`__ccDeliver({type:"chatDone",tabId:${J(tabA)}});__ccDeliver({type:"chatDone",tabId:${J(tabB)}});document.querySelector('#tabs [data-tab-id=${J(tabA)}]').click();true`);
        await waitFor(`document.querySelector("#view").dataset.tabId===${J(tabA)}`, "back on A");
        await delay(300);
      }
    });

    await t.test("the 50 ms timer paints a delta when no animation frame ever comes", async () => {
      await history(tabA, base);
      await delta(tabA, "first ");
      await waitFor(`__bubble()==="first "`, "bubble");
      await ev(`window.__realRaf=window.requestAnimationFrame;window.requestAnimationFrame=()=>999999;true`);
      try {
        await delta(tabA, "second");
        await delay(250);
        assert.equal(await ev("__bubble()"), "first second", "the timer fallback painted");
      } finally { await ev(`window.requestAnimationFrame=window.__realRaf;true`); }
    });
  });
});

// The cache is keyed by tab + revision and checked against everything the bubble shows. Each case renders one message, changes
// exactly one thing about the same revision, and the new picture must show. Removing that field from the signature turns it red.
// Only fields the server really sends: a chat message is { tabId, revision, role, text, images?, files?, requestId?, at } (server/chat-store.ts). The time label is the clock time of `at`.
test("message cache: a same-revision message re-renders when its text, time, role, pictures, files, seat name or seat picture change", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  await withPage(async ({ ev, waitFor, seed, tabA }) => {
    const leaderSlot = seed.projects[0].tabs[0].crew.find((seat: any) => seat.isLeader)?.slot ?? seed.projects[0].tabs[0].crew[0].slot;
    const message = (extra: Record<string, unknown> = {}) => ({ role: "assistant", text: "cache text one", at: 1_700_000_000_000, revision: 7, ...extra });
    const show = async (messages: unknown[]) => { await ev(`__ccDeliver({type:"chatHistory",tabId:${J(tabA)},messages:${J(messages)},revision:9,savedRevision:9});true`); await delay(30); };
    const html = () => ev(`document.querySelector("#view").innerHTML`);
    const seatChange = async (change: (seat: any) => void) => {
      await ev(`(()=>{const seat=window.__ccSeed.projects[0].tabs[0].crew.find((s)=>s.slot===${J(leaderSlot)});(${change.toString()})(seat);__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});return true})()`);
      await delay(30);
    };
    const cases: Array<[string, Record<string, unknown>, (page: string) => boolean]> = [
      ["text", { text: "cache text TWO" }, (page) => page.includes("cache text TWO") && !page.includes("cache text one")],
      ["time", { at: new Date(2026, 0, 2, 22, 2).getTime() }, (page) => page.includes("22:02")],
      ["role", { role: "user" }, (page) => page.includes('class="msg mine"')],
      ["images", { images: ["C:\\shots\\one.png"] }, (page) => page.includes("data-open-shot")],
      ["files", { files: ["C:\\docs\\notes.md"] }, (page) => page.includes("file-chip")],
    ];
    for (const [field, change, shows] of cases) {
      await t.test(`a changed ${field} on the same revision is shown`, async () => {
        await show([message()]);
        assert.ok((await html()).includes("cache text one"), "the first render shows the original");
        await show([message(change)]);
        assert.ok(shows(await html()), `the changed ${field} shows; got ${(await html()).slice(0, 400)}`);
      });
    }
    await t.test("Clear then new messages: a reused revision shows the new text, not the cleared one", async () => {
      await show([message()]);
      assert.ok((await html()).includes("cache text one"));
      await ev(`__ccDeliver({type:"chatCleared",tabId:${J(tabA)},messages:[],revision:8,savedRevision:8});true`);
      await delay(30);
      assert.ok(!(await html()).includes("cache text one"), "Clear removes the old text");
      await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},...${J(message({ text: "fresh after clear" }))}});true`);
      await delay(30);
      const page = await html();
      assert.ok(page.includes("fresh after clear") && !page.includes("cache text one"), "the new message with the reused revision shows its own text");
    });
    await t.test("Restore: the restored message shows its own text, not the one cached under the same revision", async () => {
      await show([message()]);
      assert.ok((await html()).includes("cache text one"));
      await ev(`__ccDeliver({type:"chatCleared",tabId:${J(tabA)},messages:[],revision:8,savedRevision:8});true`);
      await ev(`__ccDeliver({type:"chatRestored",tabId:${J(tabA)},messages:${J([message({ text: "restored other text" })])},revision:9,savedRevision:9});true`);
      await delay(30);
      const page = await html();
      assert.ok(page.includes("restored other text") && !page.includes("cache text one"), "the restored message shows its own text");
    });
    await t.test("a seat rename changes the speaker name on a cached message", async () => {
      await show([message({ text: "seat rename text" })]);
      await seatChange((seat) => { seat.name = "Renamed Lead"; });
      assert.ok((await html()).includes("<b>Renamed Lead</b>"), "the new name shows");
      await seatChange((seat) => { seat.name = "Renamed Again"; });
      const page = await html();
      assert.ok(page.includes("<b>Renamed Again</b>") && !page.includes("Renamed Lead"), "and the next name replaces it");
    });
    await t.test("a seat picture change changes the picture on a cached message", async () => {
      await show([message({ text: "seat picture text" })]);
      await seatChange((seat) => { seat.pic = "/avatars/nova.svg"; });
      assert.ok((await html()).includes('src="/avatars/nova.svg"'), "the new picture shows");
      await seatChange((seat) => { seat.pic = "/avatars/pip.svg"; });
      const page = await html();
      assert.ok(page.includes('src="/avatars/pip.svg"') && !page.includes("nova.svg"), "and the next picture replaces it");
    });
    await waitFor(`document.querySelector("#view .thread")!==null`, "chat still rendered");
  });
});

// Live chatMessages arrive by tab revision: out-of-order ones are inserted in order, a repeated revision is dropped.
// Turning the ordered insert into a plain push breaks the order check; removing the repeat check breaks the count.
test("live chat messages: revisions 1, 3, 2 then 3 again show exactly three messages in the order 1, 2, 3", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  await withPage(async ({ ev, tabA }) => {
    await ev(`__ccDeliver({type:"chatCleared",tabId:${J(tabA)},messages:[],revision:0,savedRevision:0});true`);
    for (const revision of [1, 3, 2, 3]) {
      await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"assistant",text:${J(`ORDERED-${revision}-END`)},at:${1_700_000_000_000 + revision},revision:${revision}});true`);
    }
    await delay(60);
    const shown = JSON.parse(await ev(`JSON.stringify([...document.querySelector("#view").innerHTML.matchAll(/ORDERED-([0-9]+)-END/g)].map((m)=>m[1]))`));
    assert.deepEqual(shown, ["1", "2", "3"], `three messages in revision order; got ${JSON.stringify(shown)}`);
  });
});
