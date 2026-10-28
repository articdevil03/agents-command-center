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

// Pack 14, the page side: a real headless Chrome runs the real public/app.js against a fake socket. The Replying bubble shows what the leader is doing (and nothing once
// the reply ends), a line by the message box and a row under the crew show the background jobs of a Claude leader with their running time, the status bar stops saying
// "ready when you are" while a job runs, and a reply Claude started by itself reads as a normal saved leader message.
// With CC_PACK14_SHOTS=<folder> the rough look is saved there as PNGs. Fake CLI runner, temp data, free port, never 4317.

const HOST = "127.0.0.1";
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

type Page = {
  ev: (expression: string) => Promise<any>;
  waitFor: (expression: string, label: string, timeoutMs?: number) => Promise<void>;
  seed: any; tabA: string; tabB: string;
  shot: (name: string) => Promise<void>;
};

async function withPage(body: (page: Page) => Promise<void>) {
  assert.ok(existsSync(CHROME), `Headless Chrome is required at ${CHROME}; set CC_SKIP_BROWSER=1 only when intentionally running without it`);
  const temp = mkdtempSync(join(tmpdir(), "cc-pack14page-"));
  const dataDir = join(temp, "data"); mkdirSync(join(dataDir, "config"), { recursive: true });
  const home = join(temp, "home"); mkdirSync(home, { recursive: true });
  const script = join(temp, "fake-cli-script.json");
  writeFileSync(script, JSON.stringify({ responses: {} }));
  const serverPort = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_CLI_RECORD: join(temp, "argv.jsonl"), CC_DATA_DIR: dataDir, CC_TEST_FORCE_PACKAGED: "1", CC_PORT: String(serverPort), CC_APP_KEY: APP_KEY, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1" };
  assert.notEqual(Number(env.CC_PORT), 4317);
  const repoScratch = join(REPO, "scratch"), repoScratchCount = () => (existsSync(repoScratch) ? readdirSync(repoScratch).length : 0);
  const repoScratchBefore = repoScratchCount(), repoWorkspacesPath = join(REPO, "config", "workspaces.json");
  const readRepoWorkspaces = () => (existsSync(repoWorkspacesPath) ? readFileSync(repoWorkspacesPath, "utf8") : null), repoWorkspacesBefore = readRepoWorkspaces();
  const server = spawn(process.execPath, [join(REPO, "server", "index.ts")], { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  attachCrashCatcher(server.pid, "pack14-page");
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
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
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
    // Headless: no window is ever shown, on either monitor.
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
    const shot = async (name: string) => {
      const dir = process.env.CC_PACK14_SHOTS;
      if (!dir) return;
      await delay(600);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), Buffer.from((await page("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
    };
    await page("Page.enable"); await page("Runtime.enable");
    // A 6-inch phone class window height is for the phone app; this is the desktop app, so the same window the other page tests use.
    await page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page("Page.navigate", { url: `http://${HOST}:${proxyPort}/__stream` });
    await waitFor(`document.querySelectorAll("#crew .seat").length>0&&document.querySelectorAll("#tabs [role=tab]").length>1&&document.querySelector("#view .thread")!==null`, "app render");
    await body({ ev, waitFor, seed, tabA, tabB, shot });
    assert.deepEqual(await ev("window.__ccErrors"), [], "no page errors");
    assert.ok(existsSync(join(dataDir, "scratch")) && existsSync(join(dataDir, "config", "workspaces.json")), "the server created its scratch and workspaces in the temp data root");
    assert.equal(repoScratchCount(), repoScratchBefore, "the repo's own scratch/ gained no files");
    assert.equal(readRepoWorkspaces(), repoWorkspacesBefore, "the repo's workspaces file is untouched");
  } finally {
    try { if (socket?.readyState === WebSocket.OPEN) await Promise.race([new Promise((ok) => { socket!.once("message", ok); socket!.send(JSON.stringify({ id: 1e9, method: "Browser.close" })); }), delay(5000)]); } catch { /* gone */ }
    socket?.close();
    try {
      if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
        const exited = once(chrome, "exit");
        await Promise.race([exited, delay(7000)]);
        if (chrome.exitCode === null && chrome.signalCode === null) { spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(chrome.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15_000 }); await Promise.race([exited, delay(20_000)]); }
      }
      proxy?.close();
      if (server.exitCode === null && server.signalCode === null) { const exited = once(server, "exit"); server.kill(); await Promise.race([exited, delay(7000)]); }
      assert.ok(server.exitCode !== null || server.signalCode !== null, `server PID ${server.pid} exited`);
      assert.ok(!chrome || chrome.exitCode !== null || chrome.signalCode !== null, `Chrome PID ${chrome?.pid} exited`);
    } finally { removeWithRetry(temp); }
  }
}

const skipped = (t: { skip: (message: string) => void }) => { if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return true; } return false; };

// ---- helpers ----
let revision = 100;
const deliver = (ev: Page["ev"], message: unknown): Promise<boolean> => ev(`__ccDeliver(${J(message)});true`);
const chatMsg = (ev: Page["ev"], tabId: string, role: string, text: string): Promise<boolean> => deliver(ev, { type: "chatMessage", tabId, role, text, at: Date.now(), revision: ++revision });
// The server's state for a tab: replying or not, what it is doing, the background jobs; `extra` is page code run on the tab first.
const setTab = (ev: Page["ev"], tabId: string, patch: { active?: boolean; activity?: string | null; jobs?: Array<{ id: string; description: string; startedAt: number }> }): Promise<boolean> => ev(`(()=>{const tab=window.__ccSeed.projects[0].tabs.find((t)=>t.id===${J(tabId)});const patch=${J(patch)};
  if(patch.active!==undefined)tab.derived={...(tab.derived||{}),leaderTurnActive:patch.active};
  if(patch.activity!==undefined)tab.leaderActivity=patch.activity;
  if(patch.jobs!==undefined)tab.leaderJobs=patch.jobs;
  __ccDeliver({...structuredClone(window.__ccSeed),type:"state"});return true})()`);
const stepText = (ev: Page["ev"]): Promise<{ text: string; hidden: boolean; inReplyingBubble: boolean; dots: boolean } | null> => ev(`(()=>{const e=document.querySelector("#view [data-activity]");if(!e)return null;const msg=e.closest(".msg");return{text:e.textContent,hidden:e.hidden,inReplyingBubble:/Replying/.test(msg?.querySelector(".meta")?.textContent??""),dots:Boolean(msg?.querySelector(".typing"))}})()`);
const MIN = 60_000;

test("the Replying bubble shows what the leader is doing, in the dots bubble and with the draft, follows each change, and is gone when the reply ends", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    assert.equal(await stepText(ev), null, "control: nothing replying, no step line");
    const stepBar = await ev(`document.querySelector("#statusBtn .stepn")?.textContent ?? ""`);
    await setTab(ev, tabA, { active: true });
    await waitFor(`document.querySelector("#view .typing")!==null`, "the dots bubble");
    assert.equal((await stepText(ev))?.hidden, true, "no step yet: the span is there but hidden");
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Searching the web" });
    await waitFor(`document.querySelector("#view [data-activity]")?.textContent==="Searching the web"`, "the step shows");
    assert.deepEqual(await stepText(ev), { text: "Searching the web", hidden: false, inReplyingBubble: true, dots: true }, "inside the Replying bubble, next to the dots");
    await shot("01-replying-searching-the-web.png");
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Using skill: deep-research" });
    await waitFor(`document.querySelector("#view [data-activity]")?.textContent==="Using skill: deep-research"`, "the next step replaces it");
    // The draft bubble keeps the step in its header.
    await deliver(ev, { type: "chatDelta", tabId: tabA, text: "Here is the first part. " });
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("first part")`, "the draft streams");
    assert.deepEqual(await stepText(ev), { text: "Using skill: deep-research", hidden: false, inReplyingBubble: true, dots: false }, "the draft's header carries the step");
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Running a command" });
    await waitFor(`document.querySelector("#view [data-stream] [data-activity]")?.textContent==="Running a command"`, "it follows while the draft streams");
    assert.equal(await ev(`document.querySelector("#statusBtn .stepn")?.textContent ?? ""`), stepBar, "the workflow 'Step N of M' bar is not touched");
    // Cleared by the server (null), then a new label, then the end of the reply.
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: null });
    await waitFor(`document.querySelector("#view [data-activity]")?.hidden===true`, "a clear hides it");
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Reading a file" });
    await waitFor(`document.querySelector("#view [data-activity]")?.textContent==="Reading a file"`, "shown again");
    await chatMsg(ev, tabA, "assistant", "Here is the first part. And the rest.");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: revision, savedRevision: 1 });
    // The page forgets the step at chatDone itself, before any state message says the reply is over.
    assert.equal(await ev(`(()=>{const e=document.querySelector("#view [data-activity]");return !e||e.hidden||e.textContent===""})()`), true, "chatDone clears the step line on its own");
    await setTab(ev, tabA, { active: false });
    await waitFor(`document.querySelector("#view [data-activity]")===null`, "gone when the reply ends");
    assert.ok(!(await ev(`document.querySelector("#view").textContent`)).includes("Reading a file"), "and the words are nowhere in the chat");
    // A label that arrives late, after chatDone, with no reply running, is not drawn.
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Thinking" });
    await delay(150);
    assert.equal(await stepText(ev), null, "no bubble, no step line");
  });
});

test("a step line is the server's words as plain text (nothing in it is markup), also when the page connects mid-reply (the state carries it), per tab, and a Stop or failure clears it", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    // Mid-reply connect: the state alone says what it is doing.
    await setTab(ev, tabA, { active: true, activity: "Editing files" });
    await waitFor(`document.querySelector("#view [data-activity]")?.textContent==="Editing files"`, "the state carries the step");
    const markup = `<img src=x onerror="window.__pwned=1"><b>bold</b>`;
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: markup });
    await waitFor(`document.querySelector("#view [data-activity]")?.textContent.startsWith("<img")`, "the words are shown as text");
    assert.equal(await ev(`document.querySelector("#view [data-activity] img, #view [data-activity] b")`), null, "no element was made from them");
    // A full render (the next state message) builds the bubble from the same words: still text.
    await setTab(ev, tabA, { active: true, activity: markup });
    await waitFor(`document.querySelector("#view [data-activity]")?.textContent.startsWith("<img")`, "after a re-render");
    assert.equal(await ev(`document.querySelector("#view [data-activity] img, #view [data-activity] b")`), null, "the re-rendered bubble made no element from them");
    assert.equal(await ev(`window.__pwned===undefined`), true);
    // Another tab's step never shows here; a failed reply clears this one.
    await deliver(ev, { type: "leaderActivity", tabId: tabB, label: "Planning" });
    await delay(100);
    assert.ok(!(await ev(`document.querySelector("#view").textContent`)).includes("Planning"), "only the shown tab's step is drawn");
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Running a command" });
    await deliver(ev, { type: "chatError", tabId: tabA, message: "leader turn stopped" });
    assert.equal(await ev(`(()=>{const e=document.querySelector("#view [data-activity]");return !e||e.hidden||e.textContent===""})()`), true, "chatError clears the step line on its own");
    await setTab(ev, tabA, { active: false, activity: null });
    await waitFor(`document.querySelector("#view [data-activity]")===null`, "a stop clears it");
  });
});

test("background jobs: a line with a spinner by the message box, a row under the crew, the status bar says the leader is free; the running time counts up; all gone when the list is empty", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    const status = () => ev(`(()=>({pill:document.querySelector("#statusBtn .pt")?.textContent??"",sub:document.querySelector("#statusBtn .sub")?.textContent??""}))()`);
    const lead = await ev(`document.querySelector("#crew .seat .fn")?.textContent ?? ""`);
    assert.equal(await ev(`document.querySelector("#jobsLine").hidden`), true, "control: no job, no line");
    assert.equal(await ev(`document.querySelector("#crewJobs").hidden`), true, "and no rows");
    assert.match((await status()).sub, /is ready when you are/, "control: the usual idle words");
    // One job, two minutes in.
    await setTab(ev, tabA, { jobs: [{ id: "b1", description: "Generate 5 concept images", startedAt: Date.now() - 2 * MIN }] });
    await waitFor(`document.querySelector("#jobsLine").hidden===false`, "the line shows");
    assert.equal(await ev(`document.querySelector("#jobsLine").textContent`), "1 background job still running: Generate 5 concept images, 2 min");
    assert.equal(await ev(`document.querySelectorAll("#jobsLine .spin").length`), 1, "with a spinner");
    assert.equal(await ev(`getComputedStyle(document.querySelector("#jobsLine .spin")).animationName`), "spin", "that turns");
    const bar = await status();
    assert.equal(bar.pill, "Ready");
    assert.equal(bar.sub, `${lead} is free, 1 background job running`, "the status bar no longer says ready when you are");
    assert.deepEqual(await ev(`[...document.querySelectorAll("#crewJobs .jrow")].map((row)=>[row.querySelector(".jt").textContent,row.querySelector(".ja").textContent,row.querySelectorAll(".spin").length])`), [["Generate 5 concept images", "2 min", 1]], "one row under the crew: description, how long, spinner");
    assert.equal(await ev(`document.querySelector("#crewJobs").previousElementSibling.id`), "crew", "right under the crew list");
    // The same list again (every state message does this) keeps the same spinner: it is not rebuilt, so it does not jump back to its start.
    await ev(`window.__spinLine=document.querySelector("#jobsLine .spin");window.__spinRow=document.querySelector("#crewJobs .spin");true`);
    await setTab(ev, tabA, {});
    assert.equal(await ev(`window.__spinLine===document.querySelector("#jobsLine .spin")&&window.__spinRow===document.querySelector("#crewJobs .spin")`), true, "an unchanged list leaves the spinners alone");
    await shot("02-background-job-line-and-row.png");
    // The line stays while the leader replies, and is under the queue/approval area, not inside the chat.
    await setTab(ev, tabA, { active: true });
    await waitFor(`document.querySelector("#sendBtn").getAttribute("aria-label")==="Queue message"`, "replying");
    assert.equal(await ev(`document.querySelector("#jobsLine").hidden`), false, "also during a reply");
    await setTab(ev, tabA, { active: false });
    // Two jobs.
    await setTab(ev, tabA, { jobs: [{ id: "b1", description: "Generate 5 concept images", startedAt: Date.now() - 5 * MIN }, { id: "b2", description: "Render the intro video", startedAt: Date.now() - 1 * MIN }] });
    await waitFor(`document.querySelectorAll("#crewJobs .jrow").length===2`, "two rows");
    assert.equal(await ev(`document.querySelector("#jobsLine").textContent`), "2 background jobs still running, longest 5 min");
    assert.equal((await status()).sub, `${lead} is free, 2 background jobs running`);
    // The minutes count up on their own: a job a second short of a minute reads under 1 min, then 1 min.
    await setTab(ev, tabA, { jobs: [{ id: "b3", description: "Short job", startedAt: Date.now() - 59_000 }] });
    await waitFor(`document.querySelector("#jobsLine").textContent==="1 background job still running: Short job, under 1 min"`, "under a minute");
    await waitFor(`document.querySelector("#jobsLine").textContent==="1 background job still running: Short job, 1 min"&&document.querySelector("#crewJobs .ja").textContent==="1 min"`, "it ticks to 1 min by itself", 6000);
    // A description is text, never markup.
    await setTab(ev, tabA, { jobs: [{ id: "b4", description: `<b>bold</b> & "q"`, startedAt: Date.now() }] });
    await waitFor(`document.querySelector("#jobsLine").textContent.includes("<b>bold</b>")`, "shown as text");
    assert.equal(await ev(`document.querySelector("#jobsLine b, #crewJobs b")`), null);
    // The list ends: the line, the rows and the wording go back.
    await setTab(ev, tabA, { jobs: [] });
    await waitFor(`document.querySelector("#jobsLine").hidden===true&&document.querySelector("#crewJobs").hidden===true`, "gone");
    assert.match((await status()).sub, /is ready when you are/, "ready when you are again");
  });
});

test("a reply Claude started by itself reads as a normal saved leader message, after the first one, with no draft left behind", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    await chatMsg(ev, tabA, "user", "Generate 5 concept images in the background and tell me when they are done.");
    await setTab(ev, tabA, { active: true });
    await deliver(ev, { type: "chatDelta", tabId: tabA, text: "Started the image job." });
    await chatMsg(ev, tabA, "assistant", "Started the image job.");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision, savedRevision: 1 });
    await setTab(ev, tabA, { active: false, jobs: [{ id: "b1", description: "Generate 5 concept images", startedAt: Date.now() - 3 * MIN }] });
    // The job ends and Claude answers on its own: it streams like a reply, with its step line, then is saved.
    await setTab(ev, tabA, { active: true, activity: "Reading a file" });
    await deliver(ev, { type: "chatDelta", tabId: tabA, text: "The images are ready: all 5 are in the folder " });
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("The images are ready")`, "the follow-up streams");
    assert.equal((await stepText(ev))?.inReplyingBubble, true);
    await setTab(ev, tabA, { jobs: [] });
    await chatMsg(ev, tabA, "assistant", "The images are ready: all 5 are in the folder `concepts/`.");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision, savedRevision: 1 });
    await setTab(ev, tabA, { active: false, activity: null });
    await waitFor(`document.querySelector("#view [data-stream]")===null&&document.querySelector("#view [data-activity]")===null`, "the draft and the step line are gone");
    const rows = await ev(`[...document.querySelectorAll("#view .thread .msg")].map((e)=>(e.querySelector(".md")?.textContent??e.querySelector(".body")?.textContent??e.textContent).trim())`);
    assert.deepEqual(rows.slice(-2), ["Started the image job.", "The images are ready: all 5 are in the folder concepts/."], "two ordinary leader messages, in order");
    await shot("03-saved-follow-up-message.png");
  });
});
