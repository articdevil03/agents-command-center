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

// Pack 9, the page side of the folder warning: a real headless Chrome runs the real public/app.js against a fake socket. A `folderBusy` from the server
// shows "Another agent is working in this folder" with Continue anyway and Cancel; the held chat or Run keeps its draft, brief and attachments; Continue
// anyway re-sends under a fresh request id with confirmBusy. With CC_PACK9_SHOTS=<folder> the dialogs and the leader notice are saved there as PNGs.
// Fake CLI runner, temp data, free port, never 4317.

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
  attachCrashCatcher(server.pid, "pack9-page");
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
      const dir = process.env.CC_PACK9_SHOTS;
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

test("chat held by the server: the dialog names who was active, the draft stays, Continue anyway re-sends under a fresh request id with confirmBusy, Cancel sends nothing", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    const chats = (): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type==="chat")`);
    const type = (text: string) => ev(`(()=>{const ci=document.querySelector("#ci");ci.value=${J(text)};ci.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#sendBtn").click();return true})()`);
    const busy = (requestId: string, items: unknown[]) => ev(`__ccDeliver({type:"folderBusy",action:"chat",tabId:${J(tabA)},requestId:${J(requestId)},items:${J(items)}});true`);

    await type("hello there");
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the first send");
    const first = (await chats())[0];
    assert.equal(first.text, "hello there");
    assert.equal("confirmBusy" in first, false, "a normal send carries no confirmation");
    assert.equal(await ev(dialog), null, "control: no dialog before the server answers");
    await busy(first.requestId, [{ tool: "Codex", agoSeconds: 40 }]);
    await waitFor(`(${dialog})!==null`, "the dialog");
    const shown = await ev(dialog);
    assert.equal(shown.title, "Another agent is working in this folder");
    assert.ok(shown.body.startsWith("A Codex session outside Command Center was active here 40 seconds ago."), shown.body);
    assert.deepEqual([shown.ok, shown.cancel], ["Continue anyway", "Cancel"]);
    assert.equal(await ev(`document.querySelector("#ci").value`), "hello there", "the draft is kept");
    assert.equal((await chats()).length, 1, "nothing was sent behind the dialog");
    await shot("a-one-codex-session.png");

    await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===2`, "Continue anyway re-sends");
    const second = (await chats())[1];
    assert.deepEqual([second.text, second.confirmBusy, second.tabId], ["hello there", true, tabA]);
    assert.notEqual(second.requestId, first.requestId, "a fresh request id");
    assert.equal(await ev(`document.querySelector("#ci").value`), "hello there", "the draft stays until the server takes the message");
    await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"user",text:"hello there",requestId:${J(second.requestId)},at:Date.now(),revision:1});true`);
    await waitFor(`document.querySelector("#ci").value===""`, "the draft clears once the message is taken");

    // Two outsiders: a Claude Code session and the catch-all. Cancel keeps the draft and sends nothing; Send works again.
    await type("second draft");
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===3`, "the next send");
    const third = (await chats())[2];
    await busy(third.requestId, [{ tool: "Claude Code", agoSeconds: 12 }, { tool: null, agoSeconds: 75 }]);
    await waitFor(`(${dialog})!==null`, "the dialog for two");
    const two = await ev(dialog);
    assert.ok(two.body.includes("A Claude Code session outside Command Center was active here 12 seconds ago."), two.body);
    assert.ok(two.body.includes("Something outside Command Center changed files here 1 minute ago."), two.body);
    await shot("b-claude-code-and-file-changes.png");
    await ev(`document.querySelector("#confirmCancel").click();true`);
    await waitFor(`(${dialog})===null`, "the dialog closes");
    assert.equal((await chats()).length, 3, "Cancel sent nothing");
    assert.equal(await ev(`document.querySelector("#ci").value`), "second draft", "Cancel keeps the draft");
    await ev(`document.querySelector("#sendBtn").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===4`, "Send is unlocked after the hold");
    assert.equal("confirmBusy" in (await chats())[3], false);
  });
});

test("chat held by the server with an image and a file attached: both stay attached behind the dialog and after Cancel, and Continue anyway re-sends them", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    const chats = (): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type==="chat")`);
    const attached = `[...document.querySelectorAll("#atts .att")].map((e)=>e.textContent.trim())`;
    await ev(`(()=>{const png=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),(c)=>c.charCodeAt(0));
      const transfer=new DataTransfer();transfer.items.add(new File([png],"shot.png",{type:"image/png"}));transfer.items.add(new File(["notes"],"notes.txt",{type:"text/plain"}));
      const input=document.querySelector("#attachInput");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
    await waitFor(`${attached}.length===2&&!document.querySelector("#atts").hidden`, "both attachments are listed");
    await ev(`(()=>{const ci=document.querySelector("#ci");ci.value="with files";ci.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#sendBtn").click();return true})()`);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the send (after both uploads)");
    const first = (await chats())[0];
    assert.equal(first.images?.length, 1, "the image rides along");
    assert.equal(first.files?.length, 1, "and the file");
    const names = await ev(attached);
    const busy = (requestId: string) => ev(`__ccDeliver({type:"folderBusy",action:"chat",tabId:${J(tabA)},requestId:${J(requestId)},items:[{tool:"Codex",agoSeconds:9}]});true`);
    await busy(first.requestId);
    await waitFor(`(${dialog})!==null`, "the dialog");
    assert.deepEqual(await ev(attached), names, "both stay attached behind the dialog");
    await ev(`document.querySelector("#confirmCancel").click();true`);
    await waitFor(`(${dialog})===null`, "the dialog closes");
    assert.deepEqual(await ev(attached), names, "and after Cancel");
    assert.equal(await ev(`document.querySelector("#ci").value`), "with files");

    await ev(`document.querySelector("#sendBtn").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===2`, "sending again");
    const second = (await chats())[1];
    await busy(second.requestId);
    await waitFor(`(${dialog})!==null`, "the dialog again");
    await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===3`, "Continue anyway re-sends");
    const third = (await chats())[2];
    assert.deepEqual([third.confirmBusy, third.text, third.images, third.files], [true, "with files", first.images, first.files], "the same image and file go with the confirmed message");
    assert.deepEqual(await ev(attached), names, "still attached until the server takes the message");
    await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"user",text:"with files",requestId:${J(third.requestId)},at:Date.now(),revision:1});true`);
    await waitFor(`${attached}.length===0`, "released once the message is taken");
  });
});

test("Run held by the server: the dialog keeps the brief, Cancel leaves the Run dialog usable, Continue anyway starts it with confirmBusy", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    const runs = (): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type==="run")`);
    // A worker seat's Run button, the way a person reaches it.
    await ev(`document.querySelector('#crew [data-seat-id="coder"] [data-seat-open]').click();true`);
    await waitFor(`document.querySelector("#stagehead [data-run-seat]")!==null`, "the seat's Run button");
    await ev(`document.querySelector("#stagehead [data-run-seat]").click();true`);
    await waitFor(`!document.querySelector("#runModal").hidden`, "the Run dialog");
    await ev(`(()=>{const p=document.querySelector("#runPrompt");p.value="build the thing";p.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#runStart").click();return true})()`);
    await waitFor(`window.__sent.some((m)=>m.type==="run")`, "the Run is sent");
    const first = (await runs())[0];
    assert.deepEqual([first.prompt, first.tabId, "confirmBusy" in first], ["build the thing", tabA, false]);
    const busy = () => ev(`__ccDeliver({type:"folderBusy",action:"run",tabId:${J(tabA)},items:[{tool:"OpenCode",agoSeconds:5}]});true`);
    await busy();
    await waitFor(`(${dialog})!==null`, "the dialog");
    assert.ok((await ev(dialog)).body.startsWith("An OpenCode session outside Command Center was active here 5 seconds ago."), "the right article");
    await ev(`document.querySelector("#confirmCancel").click();true`);
    await waitFor(`(${dialog})===null`, "closed");
    assert.equal(await ev(`document.querySelector("#runStart").disabled`), false, "Start run is usable again");
    assert.equal(await ev(`document.querySelector("#runStart").textContent`), "Start run");
    assert.equal(await ev(`document.querySelector("#runPrompt").value`), "build the thing", "the brief is kept");
    assert.equal(await ev(`document.querySelector("#runModal").hidden`), false, "the Run dialog stays open");
    assert.equal((await runs()).length, 1, "Cancel sent nothing");

    await ev(`document.querySelector("#runStart").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="run").length===2`, "the second try");
    await busy();
    await waitFor(`(${dialog})!==null`, "the dialog again");
    await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="run").length===3`, "Continue anyway starts the run");
    const third = (await runs())[2];
    assert.deepEqual([third.prompt, third.slot, third.tabId, third.confirmBusy], ["build the thing", first.slot, tabA, true]);
    await ev(`__ccDeliver({type:"runAccepted",tabId:${J(tabA)},runId:"r1"});true`);
    await waitFor(`document.querySelector("#runModal").hidden`, "the Run dialog closes once the run is accepted");
  });
});

test("Continue anyway is bound to the tab that was warned: if the selected tab changed while the dialog was open, nothing is re-sent (chat or Run) and a toast says so", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    const sent = (type: string): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type===${J(type)})`);
    // The selection is server state: another window (or anything) selects the other tab.
    const selectOther = () => ev(`window.__ccSeed.selectedTabId=${J(tabB)};__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});true`);
    const toast = () => ev(`document.querySelector("#toast").textContent`);
    await ev(`(()=>{const ci=document.querySelector("#ci");ci.value="for tab A";ci.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#sendBtn").click();return true})()`);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the chat send");
    const first = (await sent("chat"))[0];
    await ev(`__ccDeliver({type:"folderBusy",action:"chat",tabId:${J(tabA)},requestId:${J(first.requestId)},items:[{tool:"Codex",agoSeconds:9}]});true`);
    await waitFor(`(${dialog})!==null`, "the chat dialog");
    await selectOther();
    await waitFor(`window.__sent.some((m)=>m.type==="selectTab")||document.querySelector("#tabs [aria-selected=true]")!==null`, "the page took the new selection");
    await delay(300);
    if (await ev(`(${dialog})!==null`)) await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`document.querySelector("#toast").textContent.includes("no longer selected")`, "the toast");
    assert.equal((await sent("chat")).length, 1, "nothing was re-sent for either tab");
    assert.equal((await sent("run")).length, 0);
    // Run: the same, from the Run dialog of the first tab.
    await ev(`window.__ccSeed.selectedTabId=${J(tabA)};__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});true`);
    await waitFor(`document.querySelector('#crew [data-seat-id="coder"] [data-seat-open]')!==null`, "back on the first tab");
    await ev(`document.querySelector('#crew [data-seat-id="coder"] [data-seat-open]').click();true`);
    await waitFor(`document.querySelector("#stagehead [data-run-seat]")!==null`, "the seat's Run button");
    await ev(`document.querySelector("#stagehead [data-run-seat]").click();true`);
    await waitFor(`!document.querySelector("#runModal").hidden`, "the Run dialog");
    await ev(`(()=>{const p=document.querySelector("#runPrompt");p.value="build for A";p.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#runStart").click();return true})()`);
    await waitFor(`window.__sent.some((m)=>m.type==="run")`, "the Run is sent");
    await ev(`__ccDeliver({type:"folderBusy",action:"run",tabId:${J(tabA)},items:[{tool:"OpenCode",agoSeconds:5}]});true`);
    await waitFor(`(${dialog})!==null`, "the Run warning");
    await ev(`document.querySelector("#toast").textContent=""`);
    await selectOther();
    await delay(300);
    if (await ev(`(${dialog})!==null`)) await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`document.querySelector("#toast").textContent.includes("no longer selected")`, "the toast for Run");
    assert.equal((await sent("run")).length, 1, "the Run was not started again, for either tab");
    assert.equal((await sent("chat")).length, 1);
  });
});

test("a hold for a tab that is not on screen only says so: no dialog over another tab's work", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, tabB }) => {
    await ev(`__ccDeliver({type:"folderBusy",action:"chat",tabId:${J(tabB)},requestId:"zzz",items:[{tool:"Codex",agoSeconds:3}]});true`);
    await delay(400);
    assert.equal(await ev(dialog), null);
    assert.ok(await ev(`document.querySelector("#toast").textContent.includes("another agent is working in this folder")`));
  });
});

test("the leader-started notice is a quiet line inside the chat (also after a reload) and stays in the Activity feed with its launch notice, with no pop-up", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    const headsUp = "a Codex session outside Command Center is active in this folder";
    const notice = { type: "leaderLaunch", id: 7, seatId: `${tabA}.coder`, seatName: "Sonny", brief: "build it", source: "Atlas", pending: true, headsUp };
    await ev(`(()=>{if(document.querySelector("#side").hidden)document.querySelector("#sideBtn").click();return true})()`);
    const line = `Heads up: ${headsUp}.`;
    // The server sends the chat line and the launch notice, no chatNotice (the page would turn that into a pop-up).
    await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"notice",text:${J(line)},revision:1,at:Date.now()});__ccDeliver(${J(notice)});true`);
    const feed = `[...document.querySelectorAll("#feed .x")].map((e)=>e.textContent)`;
    await waitFor(`${feed}.length>0`, "the Activity line");
    assert.deepEqual(await ev(feed), [`Atlas requested Sonny \u00b7 heads up: ${headsUp} \u00b7 outcome unconfirmed`]);
    // The chat holds it as a small quiet line: not the leader speaking, not a bubble of yours, and it adds nothing to the Activity feed or the unread dots.
    const notes = `[...document.querySelectorAll("#view .thread .msg.note p")].map((e)=>e.textContent)`;
    await waitFor(`${notes}.length===1`, "the chat line");
    assert.deepEqual(await ev(notes), [line]);
    assert.equal(await ev(`document.querySelectorAll("#view .thread .msg:not(.note)").length`), 0, "no leader or user message is drawn for it");
    assert.equal(await ev(`document.querySelector("#view .msg.note img,#view .msg.note .bubble")`), null, "no avatar and no bubble");
    assert.equal((await ev(feed)).length, 1, "it adds no 'replied' line to the Activity feed");
    // The screenshot shows the chat itself, with the Details panel closed.
    await ev(`(()=>{if(!document.querySelector("#side").hidden)document.querySelector("#sideBtn").click();return true})()`);
    await waitFor(`document.querySelector("#side").hidden`, "Details closed");
    await shot("c-leader-started-notice.png");
    // After a reload the same line comes back with the chat history.
    await ev(`__ccDeliver({type:"chatHistory",tabId:${J(tabA)},messages:[{tabId:${J(tabA)},role:"notice",text:${J(line)},revision:1,at:1}],revision:1,savedRevision:0});true`);
    await waitFor(`${notes}.length===1`, "the chat line after a reload");
    assert.deepEqual(await ev(notes), [line]);
    // No pop-up at any point: the grey line is the only place it shows. A state that carries the notice (a reload) says the same, not twice.
    assert.deepEqual(await ev(`(()=>{const t=document.querySelector("#toast");return [t.classList.contains("on"),t.hidden,t.textContent]})()`), [false, true, ""], "no pop-up for the heads-up");
    await ev(`__ccDeliver({...structuredClone(window.__ccSeed),type:"state",launchSafety:{notices:[${J(notice)}]}});true`);
    await delay(300);
    assert.equal((await ev(feed)).length, 1);
    assert.ok((await ev(feed))[0].includes(`heads up: ${headsUp}`), "kept after the toast");
  });
});

test("the dark pop-up sits just above the message box, also when the box grows; the undo notices stay where they were", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    const rects = () => ev(`(()=>{const r=(s)=>{const b=document.querySelector(s).getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right}};return {toast:r("#toast"),box:r("#cbox"),on:document.querySelector("#toast").classList.contains("on")}})()`);
    const pop = async (text: string) => {
      await ev(`__ccDeliver({type:"chatNotice",tabId:${J(tabA)},message:${J(text)}});true`); // the server's other chatNotice (an old leader that did not stop): any showToast caller would do
      await waitFor(`document.querySelector("#toast").classList.contains("on")&&document.querySelector("#toast").style.bottom!==""`, "the pop-up");
      await delay(300); // the slide-in finishes
      return rects();
    };
    const empty = await pop("tab created");
    console.log("empty composer", JSON.stringify(empty));
    assert.ok(empty.toast.bottom <= empty.box.top - 11 && empty.toast.bottom >= empty.box.top - 13, `the pop-up ends 12px above the message box: ${JSON.stringify(empty)}`);
    assert.ok(Math.abs((empty.toast.left + empty.toast.right) / 2 - (empty.box.left + empty.box.right) / 2) <= 1, "centred over the message box");
    await shot("e-popup-above-composer.png");
    // Grow the box (several lines): the same pop-up stays above its new top.
    await ev(`(()=>{const ci=document.querySelector("#ci");ci.value=${J("one\ntwo\nthree\nfour\nfive")};ci.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
    await delay(300);
    const grown = await pop("tab created again");
    console.log("grown composer", JSON.stringify(grown));
    assert.ok(grown.box.top < empty.box.top - 20, `control: the box really grew: ${empty.box.top} -> ${grown.box.top}`);
    assert.ok(grown.toast.bottom <= grown.box.top - 11 && grown.toast.bottom >= grown.box.top - 13, `still 12px above the grown box: ${JSON.stringify(grown)}`);
    // Growing while the pop-up is showing moves it too.
    await ev(`(()=>{const ci=document.querySelector("#ci");ci.value=${J("1\n2\n3\n4\n5\n6\n7\n8\n9\n10")};ci.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
    await waitFor(`(()=>{const t=document.querySelector("#toast").getBoundingClientRect(),b=document.querySelector("#cbox").getBoundingClientRect();return b.top<${grown.box.top - 20}&&Math.abs(b.top-t.bottom-12)<=1})()`, "the showing pop-up follows the growing box");
    // The undo notices keep their own corner (CSS only), and a dialog is not moved by any of this.
    assert.deepEqual(await ev(`(()=>{const s=getComputedStyle(document.querySelector("#undo"));return [s.position,s.left,s.bottom]})()`), ["fixed", "24px", "24px"], "undo notices stay bottom-left");
  });
});

test("another tab's writer is worded from the server's seat, role and tab name; a stand-alone leader reads the same", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    await ev(`document.querySelector("#ci").value="hello";document.querySelector("#ci").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#sendBtn").click();true`);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the send");
    const first = (await ev(`window.__sent.filter((m)=>m.type==="chat")`))[0];
    const items = [{ tool: null, agoSeconds: 0, writer: { seatName: "Sonny", roleLabel: "Coder", tabName: "Design" } }, { tool: null, agoSeconds: 0, writer: { seatName: "Atlas", roleLabel: "Leader", tabName: "Solo" } }];
    await ev(`__ccDeliver({type:"folderBusy",action:"chat",tabId:${J(tabA)},requestId:${J(first.requestId)},items:${J(items)}});true`);
    await waitFor(`(${dialog})!==null`, "the dialog");
    const shown = await ev(dialog);
    assert.equal(shown.title, "Another agent is working in this folder");
    assert.equal(shown.body, "Sonny (Coder) in your Design tab is writing code in this folder right now. Atlas (Leader) in your Solo tab is writing code in this folder right now. Working in the same files can overwrite each other's changes.");
    assert.deepEqual([shown.ok, shown.cancel], ["Continue anyway", "Cancel"]);
    await shot("d-other-tab-coder.png");
  });
});
