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

// Pack 12 (steer in chat), the page side: a real headless Chrome runs the real public/app.js against a fake socket. While the leader replies a message is
// queued above the box (nothing is sent), Steer pushes it into the reply (a `steer` message), the first waiting message goes out as a normal send when the
// reply ends normally, a Stop or failure keeps them behind a Send button, and a refusal (busy, folder busy, steerRefused) puts a message back where it was.
// With CC_PACK12_SHOTS=<folder> the queue is saved there as PNGs. Fake CLI runner, temp data, free port, never 4317.

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

type Page = {
  ev: (expression: string) => Promise<any>;
  waitFor: (expression: string, label: string, timeoutMs?: number) => Promise<void>;
  seed: any; tabA: string; tabB: string;
  shot: (name: string) => Promise<void>;
};

async function withPage(body: (page: Page) => Promise<void>) {
  assert.ok(existsSync(CHROME), `Headless Chrome is required at ${CHROME}; set CC_SKIP_BROWSER=1 only when intentionally running without it`);
  const temp = mkdtempSync(join(tmpdir(), "cc-pack12page-"));
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
  attachCrashCatcher(server.pid, "pack12-page");
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
      assert.fail(`timed out waiting for ${label}`);
    };
    const shot = async (name: string) => {
      const dir = process.env.CC_PACK12_SHOTS;
      if (!dir) return;
      await delay(600); // the dialog and the toast fade in
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), Buffer.from((await page("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
    };
    await page("Page.enable"); await page("Runtime.enable");
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

const skipped = (t: { skip: (message: string) => void }) => { if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return true; } return false; };
const dialog = `(()=>{const m=document.querySelector("#confirmModal");return m&&!m.hidden?{title:m.querySelector("#confirmTitle").textContent,body:m.querySelector("#confirmBody").textContent,ok:m.querySelector("#confirmOk").textContent,cancel:m.querySelector("#confirmCancel").textContent}:null})()`;

// ---- helpers ----
let revision = 100;
const sentOf = (ev: Page["ev"], type: string): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type===${J(type)})`);
// The server's state says the leader is replying (or not); `extra` is page code run on the tab first.
const setActive = (ev: Page["ev"], tabId: string, active: boolean, extra = ""): Promise<boolean> => ev(`(()=>{const tab=window.__ccSeed.projects[0].tabs.find((t)=>t.id===${J(tabId)});tab.derived={...(tab.derived||{}),leaderTurnActive:${active}};${extra}__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});return true})()`);
const typeAndEnter = (ev: Page["ev"], text: string): Promise<boolean> => ev(`(()=>{const ci=document.querySelector("#ci");ci.value=${J(text)};ci.dispatchEvent(new Event("input",{bubbles:true}));ci.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));return true})()`);
const typeAndClick = (ev: Page["ev"], text: string): Promise<boolean> => ev(`(()=>{const ci=document.querySelector("#ci");ci.value=${J(text)};ci.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#sendBtn").click();return true})()`);
const queueOf = (ev: Page["ev"]): Promise<{ text: string; go: string; off: boolean; why: string; files: string }[]> => ev(`[...document.querySelectorAll("#queue .qitem")].map((e)=>({text:e.querySelector(".qtext").firstChild.textContent,go:e.querySelector("[data-queue-go]").textContent,off:e.querySelector("[data-queue-go]").disabled,why:e.querySelector(".qwhy")?.textContent??"",files:e.querySelector(".qtext small")?.textContent??""}))`);
const deliver = (ev: Page["ev"], message: unknown): Promise<boolean> => ev(`__ccDeliver(${J(message)});true`);
const chatMsg = (ev: Page["ev"], tabId: string, role: string, text: string, extra: Record<string, unknown> = {}): Promise<boolean> => deliver(ev, { type: "chatMessage", tabId, role, text, at: Date.now(), revision: ++revision, ...extra });
const goButton = (ev: Page["ev"], index: number): Promise<boolean> => ev(`document.querySelectorAll("#queue [data-queue-go]")[${index}].click();true`);
const waitQueue = (waitFor: Page["waitFor"], count: number, label: string) => waitFor(`document.querySelectorAll("#queue .qitem").length===${count}`, label);
// Every upload's path as the server returned it, recorded by the page's own fetch (the independent measurement of "the exact uploaded path"). With hold=true an upload waits until releaseUploads.
const watchUploads = (ev: Page["ev"], hold = false): Promise<boolean> => ev(`(()=>{const real=window.fetch.bind(window);window.__uploads=[];window.__held=[];window.fetch=(url,opts)=>{const route=String(url);if(!route.includes("/api/paste-"))return real(url,opts);const go=()=>real(url,opts).then((response)=>{response.clone().json().then((j)=>window.__uploads.push({kind:route.includes("paste-image")?"image":"file",path:j.path})).catch(()=>{});return response});return ${hold}?new Promise((ok,bad)=>window.__held.push(()=>go().then(ok,bad))):go()};return true})()`);
const releaseUploads = (ev: Page["ev"]): Promise<boolean> => ev(`window.__held.splice(0).forEach((go)=>go());true`);
const uploaded = (ev: Page["ev"], kind: string): Promise<string[]> => ev(`window.__uploads.filter((u)=>u.kind===${J(kind)}).map((u)=>u.path)`);
const attach = (ev: Page["ev"], name: string, type: string): Promise<boolean> => ev(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(["data"],${J(name)},{type:${J(type)}}));const input=document.querySelector("#attachInput");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
const transcriptDom = (ev: Page["ev"]): Promise<string[]> => ev(`[...document.querySelectorAll("#view .thread .msg")].map((e)=>(e.querySelector(".md")?.textContent??e.querySelector(".body")?.textContent??e.textContent).trim())`);

test("while the leader replies the message box stays open: Enter and the button queue the message above the box, nothing is sent, the button says Queue", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    assert.equal(await ev(`document.querySelector("#sendBtn").getAttribute("aria-label")`), "Send message", "control: idle leader, plain Send");
    await setActive(ev, tabA, true);
    await waitFor(`document.querySelector("#sendBtn").getAttribute("aria-label")==="Queue message"`, "the button reads Queue while the leader replies");
    await typeAndEnter(ev, "first queued");
    await waitQueue(waitFor, 1, "the first message is queued");
    assert.equal(await ev(`document.querySelector("#ci").value`), "", "the box is empty for the next message");
    await typeAndClick(ev, "second queued");
    await waitQueue(waitFor, 2, "the second message is queued");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["first queued", "Steer"], ["second queued", "Steer"]]);
    assert.equal((await sentOf(ev, "chat")).length + (await sentOf(ev, "steer")).length, 0, "nothing reached the server");
    assert.equal(await ev(`document.querySelector("#ci").readOnly`), false, "the box is still open");
    await shot("01-queue-two-messages.png");
  });
});

test("Steer sends a steer (never a chat); the reply so far is written down, the steer follows it, the rest streams below; the queue drops the message once the server took it", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    await setActive(ev, tabA, true);
    await deliver(ev, { type: "chatDelta", tabId: tabA, text: "Here is the first part. " });
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("first part")`, "the draft streams");
    await typeAndEnter(ev, "also check the tests");
    await waitQueue(waitFor, 1, "queued");
    await typeAndEnter(ev, "and the docs");
    await waitQueue(waitFor, 2, "two queued");
    await goButton(ev, 0);
    await waitFor(`window.__sent.some((m)=>m.type==="steer")`, "the steer goes out");
    const steers = await sentOf(ev, "steer");
    assert.deepEqual(steers.map((m) => [m.text, m.tabId]), [["also check the tests", tabA]]);
    assert.equal((await sentOf(ev, "chat")).length, 0, "Steer is never a normal send");
    assert.equal((await queueOf(ev))[0]!.off, true, "the item waits for the server's answer");
    // The server's answer: the reply so far (marked split), the steer, then the rest.
    await chatMsg(ev, tabA, "assistant", "Here is the first part. ", { split: true });
    await chatMsg(ev, tabA, "user", "also check the tests", { requestId: steers[0].requestId });
    await waitQueue(waitFor, 1, "the steered message left the queue");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["and the docs"], "the other one still waits");
    await waitFor(`!document.querySelector("#view [data-stream]")`, "the draft is gone (it is the message above the steer now)");
    await deliver(ev, { type: "chatDelta", tabId: tabA, text: "Now the rest of the reply streams." });
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("rest of the reply")`, "the rest streams below the steer");
    const lines = await transcriptDom(ev);
    assert.ok(lines.at(-3)!.includes("Here is the first part."), JSON.stringify(lines));
    assert.ok(lines.at(-2)!.includes("also check the tests"));
    assert.ok(lines.at(-1)!.includes("rest of the reply"));
    await shot("02-chat-after-steer.png");
  });
});

test("the reply ends normally: the first waiting message goes out as a normal send, the next one waits for that reply; an x removes a message and nothing of it is ever sent", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await setActive(ev, tabA, true);
    for (const [index, text] of ["one", "two", "three"].entries()) { await typeAndEnter(ev, text); await waitQueue(waitFor, index + 1, `${text} queued`); }
    await ev(`document.querySelectorAll("#queue [data-queue-remove]")[1].click();true`); // "two" is removed
    await waitQueue(waitFor, 2, "x removes the second message");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["one", "three"]);
    // The state still says replying: nothing goes out. chatDone alone does not release it either.
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await delay(300);
    assert.equal((await sentOf(ev, "chat")).length, 0, "not before the state says the leader is idle");
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===1`, "the first waiting message goes out");
    const first = (await sentOf(ev, "chat"))[0];
    assert.deepEqual([first.text, "confirmBusy" in first], ["one", false]);
    assert.equal((await sentOf(ev, "steer")).length, 0, "an automatic send is a normal chat");
    await delay(300);
    assert.equal((await sentOf(ev, "chat")).length, 1, "the next one waits for that reply to end");
    // The server takes it, its reply runs, then ends: the next goes out.
    await chatMsg(ev, tabA, "user", "one", { requestId: first.requestId });
    await setActive(ev, tabA, true);
    await waitQueue(waitFor, 1, "the sent message left the queue");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 2, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===2`, "the third message goes out after the second reply");
    assert.equal((await sentOf(ev, "chat"))[1].text, "three");
    assert.equal((await sentOf(ev, "chat")).some((m) => m.text === "two"), false, "the removed message was never sent");
  });
});

test("a queued message keeps its own attachments: the box is free for the next message, the automatic send carries the exact uploaded file AND image paths, and a Steer carries its attachments too", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev);
    await setActive(ev, tabA, true);
    await attach(ev, "notes.txt", "text/plain");
    await attach(ev, "shot.png", "image/png");
    await waitFor(`document.querySelectorAll("#atts .att").length===2`, "the file and the image are attached");
    await waitFor(`window.__uploads.length===2`, "both uploads finished");
    await typeAndEnter(ev, "read the notes");
    await waitQueue(waitFor, 1, "queued with both");
    assert.equal(await ev(`document.querySelector("#atts").hidden`), true, "the composer's attachment list is empty again");
    assert.equal((await queueOf(ev))[0]!.files, "notes.txt, shot.png", "the queued item shows its file and its image");
    const [filePath] = await uploaded(ev, "file"), [imagePath] = await uploaded(ev, "image");
    assert.ok(filePath && imagePath && filePath !== imagePath, "control: the server returned two different paths");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the automatic send");
    const chat = (await sentOf(ev, "chat"))[0];
    assert.deepEqual([chat.text, chat.files, chat.images], ["read the notes", [filePath], [imagePath]], "the same file and the same image ride along, by their exact paths");
    // The server took it and its reply runs: a second message with its own file and image is queued, then steered.
    await chatMsg(ev, tabA, "user", "read the notes", { requestId: chat.requestId });
    await waitQueue(waitFor, 0, "the sent message left the queue");
    await setActive(ev, tabA, true);
    await attach(ev, "more.txt", "text/plain");
    await attach(ev, "more.png", "image/png");
    await waitFor(`window.__uploads.length===4`, "the second pair uploaded");
    await typeAndEnter(ev, "and this too");
    await waitQueue(waitFor, 1, "the second message is queued");
    const [, moreFile] = await uploaded(ev, "file"), [, moreImage] = await uploaded(ev, "image");
    await goButton(ev, 0);
    await waitFor(`window.__sent.some((m)=>m.type==="steer")`, "the steer");
    const steer = (await sentOf(ev, "steer"))[0];
    assert.deepEqual([steer.text, steer.files, steer.images], ["and this too", [moreFile], [moreImage]], "a Steer carries the exact paths of its attachments");
    assert.equal((await sentOf(ev, "chat")).length, 1, "and is no normal chat");
  });
});

test("a Stop or a failed reply: nothing goes out on its own, each message shows Send, and Send is a normal chat; Clear empties the queue", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "alpha"); await waitQueue(waitFor, 1, "alpha");
    await typeAndEnter(ev, "beta"); await waitQueue(waitFor, 2, "beta");
    await deliver(ev, { type: "chatError", tabId: tabA, message: "leader turn stopped" });
    await setActive(ev, tabA, false);
    await delay(400);
    assert.equal((await sentOf(ev, "chat")).length, 0, "nothing went out on its own");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["alpha", "Send"], ["beta", "Send"]]);
    await shot("03-queue-after-stop.png");
    // A later reply that ends normally (a message typed after the Stop) must not release the held ones either.
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 3, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await delay(400);
    assert.equal((await sentOf(ev, "chat")).length, 0, "held messages never go out on their own, not even after another reply ended");
    await goButton(ev, 1);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "Send sends a normal chat");
    assert.equal((await sentOf(ev, "chat"))[0].text, "beta");
    assert.equal((await sentOf(ev, "steer")).length, 0);
    await deliver(ev, { type: "chatCleared", tabId: tabA, revision: 0, savedRevision: 0, messages: [] });
    await waitQueue(waitFor, 0, "Clear empties the queue");
    assert.equal(await ev(`document.querySelector("#queue").hidden`), true);
  });
});

test("refusals put a message back: busy goes to the FRONT, steerRefused stays in place, Steer is disabled with a reason while an approval waits", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "A"); await waitQueue(waitFor, 1, "A");
    await typeAndEnter(ev, "B"); await waitQueue(waitFor, 2, "B");
    // An approval card is waiting: Steer is off and says why; a click does nothing.
    await setActive(ev, tabA, true, `tab.pendingApprovals=[{approvalId:"ap1",tool:"Bash",summary:"echo",createdAt:1}];`);
    await waitFor(`document.querySelector("#queue .qwhy")?.textContent==="Answer the approval first"`, "the reason shows");
    assert.equal((await queueOf(ev))[0]!.off, true);
    await ev(`document.querySelectorAll("#queue [data-queue-go]")[0].click();true`);
    await delay(200);
    assert.equal((await sentOf(ev, "steer")).length, 0, "nothing sent while an approval waits");
    await setActive(ev, tabA, true, `tab.pendingApprovals=[];`);
    await waitFor(`!document.querySelector("#queue .qwhy")`, "the reason clears");
    // The server refuses the steer (Save started meanwhile): A keeps its place.
    await goButton(ev, 0);
    await waitFor(`window.__sent.some((m)=>m.type==="steer")`, "A is steered");
    const steer = (await sentOf(ev, "steer"))[0];
    await deliver(ev, { type: "steerRefused", tabId: tabA, requestId: steer.requestId, reason: "save", message: "Save is running. Send it when Save is done." });
    await waitFor(`document.querySelectorAll("#queue [data-queue-go]")[0]?.disabled===false`, "A is free again");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["A", "B"], "same place");
    // The leader is not up yet (the server says "starting"): the same, A keeps its place.
    await goButton(ev, 0);
    await waitFor(`window.__sent.filter((m)=>m.type==="steer").length===2`, "A is steered again");
    const again = (await sentOf(ev, "steer"))[1];
    await deliver(ev, { type: "steerRefused", tabId: tabA, requestId: again.requestId, reason: "starting", message: "The leader has not started this reply yet." });
    await waitFor(`document.querySelectorAll("#queue [data-queue-go]")[0]?.disabled===false`, "A is free again after 'starting'");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["A", "B"], "same place after 'starting'");
    // Stop: B is sent as a normal chat and the server says busy (another window began a reply): B returns to the front.
    await deliver(ev, { type: "chatError", tabId: tabA, message: "leader turn stopped" });
    await setActive(ev, tabA, false);
    await waitFor(`document.querySelectorAll("#queue [data-queue-go]")[1]?.textContent==="Send"`, "Send buttons");
    await goButton(ev, 1);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "B is sent");
    const chat = (await sentOf(ev, "chat"))[0];
    await deliver(ev, { type: "error", action: "chat", reason: "busy", tabId: tabA, requestId: chat.requestId, message: "leader is still answering the previous message" });
    await waitFor(`document.querySelectorAll("#queue .qitem")[0]?.querySelector(".qtext").firstChild.textContent==="B"`, "B is back at the front");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["B", "A"]);
    assert.equal((await queueOf(ev))[0]!.off, false, "and can be sent again");
  });
});

test("a composer message that meets a reply begun elsewhere (busy) is queued instead of lost", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await typeAndEnter(ev, "typed before the state caught up");
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "sent as a normal chat (the state says idle)");
    const chat = (await sentOf(ev, "chat"))[0];
    await deliver(ev, { type: "error", action: "chat", reason: "busy", tabId: tabA, requestId: chat.requestId, message: "leader is still answering the previous message" });
    await waitQueue(waitFor, 1, "it joined the queue");
    assert.equal(await ev(`document.querySelector("#ci").value`), "", "and the box is empty, not holding a second copy");
    assert.equal((await queueOf(ev))[0]!.text, "typed before the state caught up");
  });
});

test("folder busy on a queued message: the dialog names the activity, the message stays queued (never sent on its own again), Send asks again, Continue anyway confirms", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    const chats = () => sentOf(ev, "chat");
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "careful");
    await waitQueue(waitFor, 1, "queued");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===1`, "the automatic send");
    const auto = (await chats())[0];
    assert.equal("confirmBusy" in auto, false, "the automatic send never confirms for the person");
    await deliver(ev, { type: "folderBusy", action: "chat", tabId: tabA, requestId: auto.requestId, items: [{ tool: "Codex", agoSeconds: 20 }] });
    await waitFor(`(${dialog})!==null`, "the dialog");
    assert.equal((await ev(dialog)).title, "Another agent is working in this folder");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["careful", "Send"]], "the message stays in the queue");
    await ev(`document.querySelector("#confirmCancel").click();true`);
    await waitFor(`(${dialog})===null`, "the dialog closes");
    // The reply ends again later: the held message is not sent on its own.
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 2, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await delay(400);
    assert.equal((await chats()).length, 1, "never goes out without the person's confirm");
    // Send asks the server again (without confirmBusy); the server holds it again; Continue anyway confirms.
    await goButton(ev, 0);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===2`, "Send sends again");
    const again = (await chats())[1];
    assert.equal("confirmBusy" in again, false);
    await deliver(ev, { type: "folderBusy", action: "chat", tabId: tabA, requestId: again.requestId, items: [{ tool: "Codex", agoSeconds: 21 }] });
    await waitFor(`(${dialog})!==null`, "the dialog again");
    await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===3`, "Continue anyway");
    const confirmed = (await chats())[2];
    assert.deepEqual([confirmed.text, confirmed.confirmBusy], ["careful", true]);
    // And a steer that is held is confirmed as a steer.
    await chatMsg(ev, tabA, "user", "careful", { requestId: confirmed.requestId });
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "push this in");
    await waitQueue(waitFor, 1, "queued again");
    await goButton(ev, 0);
    await waitFor(`window.__sent.some((m)=>m.type==="steer")`, "the steer");
    const steer = (await sentOf(ev, "steer"))[0];
    await deliver(ev, { type: "folderBusy", action: "chat", tabId: tabA, requestId: steer.requestId, items: [{ tool: "Claude Code", agoSeconds: 5 }] });
    await waitFor(`(${dialog})!==null`, "the dialog for the steer");
    await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="steer").length===2`, "Continue anyway steers");
    const second = (await sentOf(ev, "steer"))[1];
    assert.deepEqual([second.text, second.confirmBusy], ["push this in", true]);
    assert.equal((await chats()).length, 3, "no normal chat for a steer");
  });
});

test("the sweep: every chatSendLocked site in public/app.js is one this file knows (a send lock that ignores the queue would block typing during a reply)", () => {
  const source = readFileSync(join(REPO, "public", "app.js"), "utf8");
  const lines = source.split("\n").map((line) => line.trim()).filter((line) => line.includes("chatSendLocked("));
  assert.deepEqual(lines.map((line) => line.slice(0, 60)), [
    "function chatSendLocked(tabId) { return pendingChatByTab.has",
    "button.disabled = chatSendLocked(tab.id) || savePending.has(",
    "$(\"sendBtn\").disabled = !tab || !canChat || !$(\"ci\").value.t",
    "if (!tab || !inChat(tab) || savePending.has(tab.id) || chatS",
  ], "a new chatSendLocked site needs its own look");
  assert.match(source, /function chatSendLocked\(tabId\) \{ return pendingChatByTab\.has\(tabId\); \}/, "only a send on its way locks the box");
  assert.match(source, /if \(replyActive\(tab\.id\)\) \{ void queueComposer\(tab\.id\); return; \}/, "and sendChat queues while the leader replies");
  assert.equal((source.match(/type: steer \? "steer" : "chat"/g) ?? []).length, 1, "the queue sends a steer only while a reply runs");
});

// A message typed while the leader replies, with a file still uploading: queueComposer waits for the upload, and the reply may end meanwhile.
const typeWithSlowFile = async (ev: Page["ev"], waitFor: Page["waitFor"], text: string): Promise<void> => {
  await attach(ev, "notes.txt", "text/plain");
  await waitFor(`document.querySelectorAll("#atts .att").length===1`, "the file is attached (still uploading)");
  await typeAndEnter(ev, text);
  await delay(200);
};

test("fix 1a: a message whose file finishes uploading AFTER a Stop joins the queue held: not sent on its own, shows Send, and a later reply's end does not release it", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev, true);
    await setActive(ev, tabA, true);
    await typeWithSlowFile(ev, waitFor, "read the notes");
    assert.equal((await queueOf(ev)).length, 0, "control: it waits for the file, not in the queue yet");
    await deliver(ev, { type: "chatError", tabId: tabA, message: "leader turn stopped" });
    await setActive(ev, tabA, false);
    await releaseUploads(ev);
    await waitQueue(waitFor, 1, "it joined the queue");
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length + (await sentOf(ev, "steer")).length, 0, "not sent on its own after the Stop");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["read the notes", "Send"]]);
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 3, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length, 0, "held: not even another reply's normal end releases it");
    await goButton(ev, 0);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "Send sends it");
    const [filePath] = await uploaded(ev, "file");
    assert.deepEqual((await sentOf(ev, "chat"))[0].files, [filePath], "with its own file");
  });
});

test("fix 1b: a message whose file finishes uploading AFTER a Clear stays in the box, is not sent and not queued", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev, true);
    await setActive(ev, tabA, true);
    await typeWithSlowFile(ev, waitFor, "read the notes");
    await deliver(ev, { type: "chatCleared", tabId: tabA, revision: 0, savedRevision: 0, messages: [] });
    await setActive(ev, tabA, false);
    await releaseUploads(ev);
    await waitFor(`window.__uploads.length===1`, "the upload finished");
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length + (await sentOf(ev, "steer")).length, 0, "not sent on its own after the Clear");
    assert.equal((await queueOf(ev)).length, 0, "and not queued");
    assert.equal(await ev(`document.querySelector("#ci").value`), "read the notes", "the message is still in the box");
  });
});

test("fix 1c: a message whose file finishes uploading after a NORMAL end goes out in queue order, behind the earlier queued messages (also when the state still says replying)", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev, true);
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "first");
    await waitQueue(waitFor, 1, "first is queued");
    await typeWithSlowFile(ev, waitFor, "second with a file");
    // The reply ends normally: "first" goes out; the file of "second" is still uploading.
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===1`, "first goes out");
    await releaseUploads(ev);
    await waitQueue(waitFor, 2, "the upload finished: second joined the queue behind first");
    await delay(400);
    assert.deepEqual((await sentOf(ev, "chat")).map((m) => m.text), ["first"], "second did not jump ahead or go out on its own");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["first", "second with a file"]);
    // first's reply runs and ends normally: second goes out, with its file.
    const first = (await sentOf(ev, "chat"))[0];
    await chatMsg(ev, tabA, "user", "first", { requestId: first.requestId });
    await setActive(ev, tabA, true);
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 2, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===2`, "second goes out after first's reply");
    const [filePath] = await uploaded(ev, "file");
    assert.deepEqual([(await sentOf(ev, "chat"))[1].text, (await sentOf(ev, "chat"))[1].files], ["second with a file", [filePath]]);
  });
});

test("fix 1d: the reply ended normally but the state still says replying when the file finishes: it is armed, and goes out the moment the state says idle", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev, true);
    await setActive(ev, tabA, true);
    await typeWithSlowFile(ev, waitFor, "late file");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await releaseUploads(ev);
    await waitQueue(waitFor, 1, "it joined the queue");
    await delay(300);
    assert.equal((await sentOf(ev, "chat")).length, 0, "the state still says replying: nothing yet");
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "it goes out as soon as the state says idle");
    assert.equal((await sentOf(ev, "chat"))[0].text, "late file");
    assert.equal((await sentOf(ev, "steer")).length, 0);
  });
});

test("fix 1e: Enter pressed again while the queued message still waits for its upload (the reply has ended meanwhile) does nothing: one message goes out, with its file, once", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev, true);
    await setActive(ev, tabA, true);
    await typeWithSlowFile(ev, waitFor, "read the notes");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await ev(`document.querySelector("#ci").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));true`);
    await delay(400);
    assert.equal((await sentOf(ev, "chat")).length + (await sentOf(ev, "steer")).length, 0, "the second Enter sent nothing: the message is already on its way");
    await releaseUploads(ev);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the upload finished and the message goes out");
    await delay(500);
    const [filePath] = await uploaded(ev, "file");
    assert.deepEqual((await sentOf(ev, "chat")).map((m) => [m.text, m.files]), [["read the notes", [filePath]]], "once, with its file");
  });
});

// The leader's Stop is the button in its seat card (a real click on the crew picture, then on Stop).
const stopLeader = async (ev: Page["ev"], waitFor: Page["waitFor"]): Promise<void> => {
  const slot = await ev(`window.__ccSeed.projects[0].tabs.find((t)=>t.id===window.__ccSeed.selectedTabId).crew.find((s)=>s.isLeader).slot`);
  await ev(`document.querySelector('#crew [data-seat-pic="${slot}"]').click();true`);
  await waitFor(`document.querySelector("#seatPop [data-stop-seat]")!==null`, "the leader's card shows Stop");
  await ev(`document.querySelector("#seatPop [data-stop-seat]").click();true`);
  await waitFor(`window.__sent.some((m)=>m.type==="stopSeat")`, "the stop reaches the server");
};

test("fix 2a: the owner clicks the leader's Stop while the finished reply's chatDone is still on the way: the queue is held, and the arriving chatDone sends nothing", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "alpha"); await waitQueue(waitFor, 1, "alpha");
    await typeAndEnter(ev, "beta"); await waitQueue(waitFor, 2, "beta");
    await stopLeader(ev, waitFor); // the server has no turn to stop, so no chatError ever comes
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length, 0, "nothing went out after the Stop");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["alpha", "Send"], ["beta", "Send"]]);
  });
});

test("fix 2b: Stop all holds every tab's queue the same way, also a hidden tab whose reply ends late", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    const shown = (tabId: string) => waitFor(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId===${J(tabId)}`, `tab ${tabId} is shown`);
    const open = async (tabId: string) => { await ev(`document.querySelector('#tabs [role=tab][data-tab-id=${J(tabId)}]').click();true`); await shown(tabId); };
    await setActive(ev, tabA, true, `tab.derived.busy=true;`);
    await typeAndEnter(ev, "gamma"); await waitQueue(waitFor, 1, "gamma");
    await open(tabB);
    await setActive(ev, tabB, true);
    await typeAndEnter(ev, "delta"); await waitQueue(waitFor, 1, "delta is queued in tab B");
    await open(tabA); // Stop all is clicked while B is hidden
    await waitQueue(waitFor, 1, "tab A shows gamma");
    await waitFor(`!document.querySelector("#stopAll").disabled`, "Stop all is on");
    await ev(`document.querySelector("#stopAll").click();true`);
    await waitFor(`window.__sent.some((m)=>m.type==="stopAll")`, "stop all reaches the server");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await deliver(ev, { type: "chatDone", tabId: tabB, revision: 1, savedRevision: 0 }); // B's reply ends late, after the Stop
    await setActive(ev, tabB, false);
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length, 0, "nothing went out after Stop all, from either tab");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["gamma", "Send"]]);
    await open(tabB);
    await waitQueue(waitFor, 1, "tab B shows delta");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["delta", "Send"]], "the hidden tab's message waits behind Send too");
  });
});

test("fix 2c: a flush already waiting for the state (chatDone came first) is cancelled by Stop: a message typed after the Stop does not go out when the state says idle", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "alpha"); await waitQueue(waitFor, 1, "alpha");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 }); // arms the flush; the state still says replying
    await stopLeader(ev, waitFor);
    await typeAndEnter(ev, "typed after the stop"); await waitQueue(waitFor, 2, "typed after the stop");
    await setActive(ev, tabA, false);
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length, 0, "the waiting flush was cancelled by the Stop");
  });
});

test("fix 9: queues are per tab: a reply that ends in tab A sends A's message with A's tab id while tab B is shown, B's box and queue are untouched, and A's queue is right when shown again", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    const shown = (tabId: string) => waitFor(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId===${J(tabId)}`, `tab ${tabId} is shown`);
    const open = async (tabId: string) => { await ev(`document.querySelector('#tabs [role=tab][data-tab-id=${J(tabId)}]').click();true`); await shown(tabId); };
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "A one"); await waitQueue(waitFor, 1, "A one");
    await typeAndEnter(ev, "A two"); await waitQueue(waitFor, 2, "A two");
    await open(tabB);
    await waitQueue(waitFor, 0, "tab B shows no queue");
    await setActive(ev, tabB, true);
    await typeAndEnter(ev, "B one"); await waitQueue(waitFor, 1, "B one is queued in tab B");
    await ev(`(()=>{const ci=document.querySelector("#ci");ci.value="draft in B";ci.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
    // Tab A's reply ends normally while B is shown.
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "A's first message goes out");
    await delay(300);
    const chats = await sentOf(ev, "chat");
    assert.deepEqual(chats.map((m) => [m.text, m.tabId]), [["A one", tabA]], "A's message went out with A's tab id, and only that one");
    assert.equal((await sentOf(ev, "steer")).length, 0);
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["B one", "Steer"]], "B's queue is untouched");
    assert.equal(await ev(`document.querySelector("#ci").value`), "draft in B", "and so is B's box");
    // The server took A's message; back in A the queue holds only what is left.
    await chatMsg(ev, tabA, "user", "A one", { requestId: chats[0].requestId });
    await open(tabA);
    await waitQueue(waitFor, 1, "tab A shows what is left");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["A two"]);
  });
});
