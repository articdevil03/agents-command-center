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

// Pack 10, the leader's formatting: a real headless Chrome runs the real public/app.js against a fake socket and checks what the page makes of model text
// (bold, lists, code, links, headings), that nothing from the model ever becomes live html, and that no place that shows model text leaks a raw `**`.
// With CC_PACK10_SHOTS=<folder> the screenshots are saved there. Fake CLI runner, temp data, free port, never 4317.

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
  const temp = mkdtempSync(join(tmpdir(), "cc-pack10-"));
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
  attachCrashCatcher(server.pid, "pack10-markdown");
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
      const dir = process.env.CC_PACK10_SHOTS;
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

const FENCE = "```";
const REPLY = [
  "## Where we are", "",
  "Pack 10 is **built** and *tested*, see `public/app.js` and __this__ too.", "",
  "- Renderer: one small function", "  - nested: handles `code`", "- Tests: [the docs](https://example.com/a_b_c?x=1&y=2)", "",
  "1. First step", "2. Second step", "",
  "> a quoted note", "",
  `${FENCE}js`, 'const x = "**not bold** <b>x</b>";', FENCE, "",
  "snake_case_name stays and so does C:/a/_b_/c",
].join("\n");

const history = (tab: string, messages: unknown[]) => `window.__ccHistory[${J(tab)}]=${J(messages)};window.__socket.history(${J(tab)});true`;
const summary = `(()=>{const m=[...document.querySelectorAll("#view .msg:not(.mine) .md")].at(-1);const q=(s)=>[...m.querySelectorAll(s)].map((e)=>e.textContent);
  const copy=m.cloneNode(true);copy.querySelectorAll("pre").forEach((p)=>p.remove());
  return {headings:q(".md-h"),strong:q("strong"),em:q("em"),inlineCode:q("p code, li code"),fenced:q("pre.md-code code"),lists:m.querySelectorAll("ul").length,nested:m.querySelectorAll("ul ul").length,
    numbered:q("ol > li"),quote:q("blockquote"),links:[...m.querySelectorAll("a")].map((a)=>[a.getAttribute("href"),a.target,a.rel,a.textContent]),stars:copy.textContent.includes("**"),text:copy.textContent}})()`;

test("a leader reply shows its formatting as real tags, every supported construct, and no raw ** outside a code block", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, shot }) => {
    await ev(history(tabA, [{ role: "user", text: "hi", at: 1_700_000_000_000, revision: 1 }, { role: "assistant", text: REPLY, at: 1_700_000_001_000, revision: 2 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===2`, "both messages render");
    const got = await ev(summary);
    assert.deepEqual({ ...got, text: undefined }, {
      headings: ["Where we are"], strong: ["built", "this"], em: ["tested"], inlineCode: ["public/app.js", "code"], fenced: ['const x = "**not bold** <b>x</b>";'], lists: 2, nested: 1,
      numbered: ["First step", "Second step"], quote: ["a quoted note"], links: [["https://example.com/a_b_c?x=1&y=2", "_blank", "noopener noreferrer", "the docs"]], stars: false, text: undefined,
    }, `matched: ${JSON.stringify(got)}`);
    assert.ok(got.text.includes("snake_case_name stays and so does C:/a/_b_/c"), `words with underscores and paths stay as typed: ${got.text}`);
    assert.equal(await ev(`document.querySelectorAll("#view .msg:not(.mine) .md em").length`), 1, "the only italic is the one asked for (snake_case, paths and URLs made none)");
    await shot("a-leader-reply-light.png");
    await ev(`document.body.classList.remove("light");true`);
    await shot("b-leader-reply-dark.png");
    await ev(`document.body.classList.add("light");true`);
  });
});

test("model text never becomes live html; a user message with ** stays exactly as typed", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    const hostile = [
      "<script>window.__pwn=1</script>", "<img src=x onerror=window.__pwn=2>", "[x](javascript:alert(1))", '<a href="https://evil.example">click</a>', "<!-- hidden -->",
      "[data](data:text/html,hi) [rel](//evil.example) [file](file:///c:/x)", FENCE, "**no** <b>x</b> [l](https://e.example)", FENCE, "",
    ].join("\n");
    await ev(history(tabA, [{ role: "user", text: "**x** and `y` and <b>z</b>", at: 1_700_000_000_000, revision: 1 }, { role: "assistant", text: hostile, at: 1_700_000_001_000, revision: 2 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===2`, "both render");
    const got = await ev(`(()=>{const m=document.querySelector("#view .msg:not(.mine) .md");return {script:m.querySelectorAll("script").length,img:m.querySelectorAll("img").length,a:m.querySelectorAll("a").length,
      tags:[...m.querySelectorAll("*")].map((e)=>e.tagName.toLowerCase()).filter((n,i,all)=>all.indexOf(n)===i).sort(),comment:m.innerHTML.includes("<!--"),pwn:window.__pwn??null,text:m.textContent,
      fencedInert:m.querySelector("pre.md-code code").children.length,fenced:m.querySelector("pre.md-code code").textContent}})()`);
    assert.deepEqual([got.script, got.img, got.a, got.comment, got.pwn, got.fencedInert], [0, 0, 0, false, null, 0], `matched: ${JSON.stringify(got)}`);
    assert.deepEqual(got.tags, ["br", "code", "p", "pre"], `only fixed tags exist; matched: ${JSON.stringify(got.tags)}`);
    for (const text of ["<script>window.__pwn=1</script>", "<img src=x onerror=window.__pwn=2>", "[x](javascript:alert(1))", '<a href="https://evil.example">click</a>', "<!-- hidden -->", "[data](data:text/html,hi)", "[rel](//evil.example)", "[file](file:///c:/x)"]) assert.ok(got.text.includes(text), `${text} stays inert text; matched: ${got.text}`);
    assert.equal(got.fenced, "**no** <b>x</b> [l](https://e.example)", "markdown inside a code block is shown as typed");
    const mine = await ev(`(()=>{const p=document.querySelector("#view .msg.mine .bubble p");return {text:p.textContent,kids:p.children.length}})()`);
    assert.deepEqual(mine, { text: "**x** and `y` and <b>z</b>", kids: 0 }, "your own message is plain text exactly as typed");
  });
});

test("a lone ** while streaming is shown as text and never swallows the rest of the reply", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await ev(history(tabA, [{ role: "user", text: "go", at: 1_700_000_000_000, revision: 1 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===1`, "history");
    const delta = (text: string) => ev(`__ccDeliver({type:"chatDelta",tabId:${J(tabA)},text:${J(text)}});true`);
    await delta("Half **bold");
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent==="Half **bold"`, "an unclosed marker is shown as text");
    assert.equal(await ev(`document.querySelectorAll("#view [data-stream] .md strong").length`), 0, "no bold from a lone **");
    await delta(`

- item one
- item **two**

${FENCE}
code **here**`);
    await waitFor(`document.querySelectorAll("#view [data-stream] .md li").length===2`, "the list after an unclosed marker still renders");
    assert.equal(await ev(`document.querySelector("#view [data-stream] .md").textContent.includes(${J(FENCE)})`), true, "an unclosed fence stays as text");
    assert.equal(await ev(`document.querySelectorAll("#view [data-stream] .md pre").length`), 0, "no code block from an unclosed fence");
  });
});

test("the streaming reply renders exactly like the final message", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await ev(history(tabA, [{ role: "user", text: "go", at: 1_700_000_000_000, revision: 1 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===1`, "history");
    const delta = (text: string) => ev(`__ccDeliver({type:"chatDelta",tabId:${J(tabA)},text:${J(text)}});true`);
    const full = "Half **bold more**\n\n- item one\n- item **two**\n\n" + REPLY;
    await delta(full.slice(0, 40)); await delta(full.slice(40));
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("snake_case_name")`, "the whole draft is painted");
    const streamed = await ev(`document.querySelector("#view [data-stream] .md").innerHTML`);
    await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"assistant",text:${J(full)},at:1_700_000_002_000,revision:2});__ccDeliver({type:"chatDone",tabId:${J(tabA)},revision:2,savedRevision:2});true`);
    await waitFor(`document.querySelector("#view [data-stream]")===null&&document.querySelectorAll("#view .msg").length===2`, "the final message replaces the draft");
    const final = await ev(`document.querySelector("#view .msg:not(.mine) .md").innerHTML`);
    assert.ok(streamed.includes("<strong>") && streamed.includes("<ul>") && streamed.includes("<pre"), `the draft has real tags: ${streamed.slice(0, 120)}`);
    assert.equal(final, streamed, "the final message has exactly the draft's html");
  });
});

const EDGE = [
  "Match **/*.js and **/*.ts, then *.js and test*.ts, or C:\\foo\\*bar*\\x.", "",
  "Run [run `npm test`](https://example.com/a?x=1) or [plain](https://example.com/`b`).", "",
  "3. third", "4. fourth", "", "## C#", "", "## Title ##",
].join("\n");

test("globs and paths keep their stars, a link label can hold code, a list keeps its first number, a heading keeps its #", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, shot }) => {
    await ev(history(tabA, [{ role: "user", text: "hi", at: 1_700_000_000_000, revision: 1 }, { role: "assistant", text: EDGE, at: 1_700_000_001_000, revision: 2 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===2`, "both messages render");
    const got = await ev(`(()=>{const m=[...document.querySelectorAll("#view .msg:not(.mine) .md")].at(-1);return {html:m.innerHTML,text:m.textContent,nul:m.innerHTML.includes("\\u0000"),
      links:[...m.querySelectorAll("a")].map((a)=>[a.getAttribute("href"),a.innerHTML]),ol:[...m.querySelectorAll("ol")].map((o)=>[o.getAttribute("start"),o.textContent]),heads:[...m.querySelectorAll(".md-h")].map((h)=>h.textContent)}})()`);
    assert.ok(got.text.includes("Match **/*.js and **/*.ts, then *.js and test*.ts, or C:\\foo\\*bar*\\x."), `glob and path stars stay as typed: ${got.text}`);
    assert.ok(!/<(?:strong|em)>/.test(got.html.split("<ol")[0].split("</p>")[0]), `no bold or italic made inside the glob line: ${got.html.slice(0, 300)}`);
    assert.equal(got.nul, false, "no placeholder character reaches the page");
    assert.deepEqual(got.links, [["https://example.com/a?x=1", "run <code>npm test</code>"], ["https://example.com/`b`", "plain"]], `link label parsed on its own, URL exactly as written; matched: ${JSON.stringify(got.links)}`);
    assert.deepEqual(got.ol, [["3", "thirdfourth"]], `the list starts at 3; matched: ${JSON.stringify(got.ol)}`);
    assert.deepEqual(got.heads, ["C#", "Title"], `closing hashes go only after a space; matched: ${JSON.stringify(got.heads)}`);
    await shot("d-fixes.png");
  });
});

// Nested emphasis whose closers touch: one run of 3 closes a 1 and a 2. Each input is checked as html (a leader reply) and as a plain label (the crew rail).
// Third column: the same text as a plain label. A triple opener closed in two steps, and a dotfile in bold, count here too.
const NESTED: [string, string, string][] = [
  ["**bold *italic***", "<strong>bold <em>italic</em></strong>", "bold italic"],
  ["*italic **bold***", "<em>italic <strong>bold</strong></em>", "italic bold"],
  ["__bold _italic___", "<strong>bold <em>italic</em></strong>", "bold italic"],
  ["***both***", "<strong><em>both</em></strong>", "both"],
  ["**bold with *italic* inside**", "<strong>bold with <em>italic</em> inside</strong>", "bold with italic inside"],
  ["***bold** italic*", "<em><strong>bold</strong> italic</em>", "bold italic"],
  ["***bold* more**", "<strong><em>bold</em> more</strong>", "bold more"],
  ["**bold***", "<strong>bold</strong>*", "bold*"],
  ["**.env** and **.gitignore**", "<strong>.env</strong> and <strong>.gitignore</strong>", ".env and .gitignore"],
  ["*.gitignore* is ignored", "<em>.gitignore</em> is ignored", ".gitignore is ignored"],
];

test("nested emphasis with adjacent closers renders balanced tags, in a reply and as plain words in a label", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    const messages = [{ role: "user", text: "hi", at: 1, revision: 1 }, ...NESTED.map(([text], index) => ({ role: "assistant", text, at: 2 + index, revision: 2 + index }))];
    await ev(history(tabA, messages));
    await waitFor(`document.querySelectorAll("#view .msg").length===${messages.length}`, "all replies render");
    const got = await ev(`[...document.querySelectorAll("#view .msg:not(.mine) .md")].map((m)=>m.innerHTML)`);
    assert.deepEqual(got, NESTED.map(([, html]) => `<p>${html}</p>`), `matched: ${JSON.stringify(got)}`);
    const plain = await ev(`(()=>{const s=window.__ccSeed,tab=s.projects[0].tabs.find((x)=>x.id===${J(tabA)}),worker=tab.crew.find((x)=>!x.isLeader);worker.status="working";tab.runs=[];
      const out=[];for(const text of ${J(NESTED.map(([text]) => text))}){worker.task=text;__ccDeliver({...structuredClone(s),type:"state"});out.push(document.querySelector('#statusBtn .pt')?.textContent??null)}return out})()`);
    assert.equal(plain.length, NESTED.length);
    for (const [index, label] of plain.entries()) assert.ok(typeof label === "string" && label.endsWith(` ${NESTED[index][2]}`), `${NESTED[index][0]} as a plain label keeps its words and shows no marker; matched: ${JSON.stringify(label)}`);
  });
});

// The renderer's emphasis pass, cut out of the page source and run here: random strings of markers, letters and spaces must never throw and always give balanced, properly nested strong/em tags.
function emphasisPass(): (text: string, plain: boolean) => string {
  const source = readFileSync(join(REPO, "public", "app.js"), "utf8");
  const start = source.indexOf("const mdSpace"), end = source.indexOf("// Code spans and links");
  assert.ok(start > 0 && end > start, `control: the emphasis pass was found (${start}..${end})`);
  return new Function(`${source.slice(start, end)};return mdEmphasis;`)() as (text: string, plain: boolean) => string;
}

test("emphasis opens before a dot but wildcards and dotted runs stay as typed (the renderer run directly)", () => {
  const emphasis = emphasisPass();
  const literal = ["*.js and test*.ts", "**/*.js", "src/**/*.ts", "C:\\foo\\*bar*\\x", "*.{js,ts}", "ver.*beta*", "**.js and test**.ts"];
  for (const text of literal) assert.equal(emphasis(text, false), text, `${text} stays as typed`);
  assert.equal(emphasis("I said *this*.", false), "I said <em>this</em>.", "a closer before a sentence dot still closes");
  assert.equal(emphasis("**.env** and **.gitignore**", true), ".env and .gitignore");
});

test("emphasis never throws and always makes balanced, properly nested tags (100000 random strings)", () => {
  const emphasis = emphasisPass();
  const pieces = ["*", "**", "***", "_", "__", "a", "b", " ", "a", " "];
  let seed = 12345, made = 0, tagged = 0;
  const random = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let round = 0; round < 100_000; round += 1) {
    let text = ""; for (let n = 1 + random(14); n > 0; n -= 1) text += pieces[random(pieces.length)];
    const html = emphasis(text, false), label = emphasis(text, true);
    const open: string[] = [];
    for (const [, slash, name] of html.matchAll(/<(\/?)(strong|em)>/g)) {
      if (!slash) open.push(name); else assert.equal(open.pop(), name, `tags nest properly for ${JSON.stringify(text)}: ${html}`);
    }
    assert.equal(open.length, 0, `every tag closes for ${JSON.stringify(text)}: ${html}`);
    assert.ok(!/<|>/.test(label) && label.replace(/[*_]/g, "") === html.replace(/<[^>]+>/g, "").replace(/[*_]/g, ""), `the plain label has no tags and the same words for ${JSON.stringify(text)}: ${label}`);
    made += 1; if (html !== text) tagged += 1;
  }
  assert.equal(made, 100_000);
  assert.ok(tagged > 10_000, `control: many random strings really got emphasis (${tagged})`);
});

// The finished message's html is kept: String.prototype.split("\n") on a reply holding the probe word is the renderer's first step, so it counts renders of that message.
test("a finished message is not rendered again by a later repaint (the per-message html cache hits)", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await ev(`window.__splits=0;const __split=String.prototype.split;String.prototype.split=function(sep,...rest){if(sep==="\\n"&&this.includes("CacheProbeWord"))window.__splits+=1;return __split.call(this,sep,...rest)};true`);
    await ev(history(tabA, [{ role: "user", text: "go", at: 1, revision: 1 }, { role: "assistant", text: "A **CacheProbeWord** reply", at: 2, revision: 2 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===2`, "history");
    const first = await ev("window.__splits");
    assert.ok(first >= 1, `control: the first paint of the reply counted (${first})`);
    const bold = `document.querySelector("#view .msg:not(.mine) .md strong")?.textContent==="CacheProbeWord"`;
    for (let round = 0; round < 3; round += 1) {
      await ev(`__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});__ccDeliver({type:"chatDelta",tabId:${J(tabA)},text:"streaming ${round} "});true`);
      await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("streaming ${round}")`, `repaint ${round}`);
    }
    assert.equal(await ev(bold), true, "the reply is still on the page");
    assert.equal(await ev("window.__splits"), first, "state updates and streaming repaints left the finished reply's html alone");
  });
});

// Unmatched markers by the tens of thousands: the old lazy regexes took ~0.4 s per 16k on this input and grew with its square.
test("emphasis parsing is linear: tens of thousands of unmatched markers paint in well under the bound", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await ev(history(tabA, [{ role: "user", text: "go", at: 1_700_000_000_000, revision: 1 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===1`, "history");
    const cases: [string, string][] = [
      ["open markers", "**a ".repeat(64_000)],
      ["closers with no opener of their size", "*a ".repeat(32_000) + "b** ".repeat(32_000)],
      ["half-written links", "[a](http://b".repeat(32_000)],
      ["underscores", "_a ".repeat(64_000)],
    ];
    const times: string[] = [];
    for (const [name, text] of cases) {
      const got = await ev(`(()=>{const tab=${J(tabA)};const t0=performance.now();window.__ccHistory[tab]=[{role:"user",text:"go",at:1,revision:1},{role:"assistant",text:${J(text)},at:2,revision:2}];window.__socket.history(tab);
        return {ms:performance.now()-t0,rendered:document.querySelectorAll("#view .msg").length}})()`);
      times.push(`${name}: ${Math.round(got.ms)} ms`);
      assert.equal(got.rendered, 2, `${name}: the reply painted inside the measured call`);
      assert.ok(got.ms < 1500, `${name}: ${text.length} characters took ${Math.round(got.ms)} ms (bound 1500); all: ${times.join(", ")}`);
    }
    t.diagnostic(times.join("; "));
  });
});

// A seed with a failed run, a pending request, a sent request and an unconfirmed launch: every one carries model text with **.
const MARK = (word: string) => `**${word}** and \`code\``;
async function seedModelText(ev: (e: string) => Promise<any>, tabA: string, tabB: string) {
  await ev(`(()=>{const s=window.__ccSeed,tab=s.projects[0].tabs.find((x)=>x.id===${J(tabA)}),worker=tab.crew.find((x)=>!x.isLeader);
    tab.runs=[{runId:"run-md",seatSlotId:worker.slot,seatName:worker.name,seatIsLeader:false,status:"failed",label:${J(MARK("RunLabel"))},outcome:"failed",cli:"claude",model:"m",startedAt:Date.now()-5000,endedAt:Date.now(),crewGenerationId:tab.processState.crewGenerationId,folderPath:"C:/x"}];
    tab.notes={content:${J("# **Pack 10** is done\n- fixed `x` thing\n- **bold** note\n## **Next** up\n```\n")},path:tab.folder+"/.command-center/"+tab.id+"/RESUME.md",truncated:false};
    s.requests=[{id:"rq-in",fromTabId:${J(tabB)},toTabId:${J(tabA)},title:${J(MARK("ReqTitle"))},body:${J("**ReqBody** first\n- point **one**\n- point two")},status:"pending",createdAt:Date.now()},
      {id:"rq-out",fromTabId:${J(tabA)},toTabId:${J(tabB)},title:${J(MARK("SentTitle"))},body:${J(MARK("SentBody"))},status:"accepted",createdAt:Date.now()}];
    s.launchSafety={...(s.launchSafety||{}),uncertain:[],blocked:[],released:[],notices:[{id:7,pending:true,seatKey:tab.id+"."+worker.slot,seatName:worker.name,source:"Atlas",brief:${J(MARK("NoticeBrief"))}}]};
    __ccDeliver({...structuredClone(s),type:"state"});return true})()`);
}

test("handover panel: no raw ** in the summary or the rows, bold and code rendered", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB, shot }) => {
    await seedModelText(ev, tabA, tabB);
    await ev(`document.querySelector("#side").hidden&&document.querySelector("#sideBtn").click();document.querySelector('[data-l="notes"]').click();true`);
    await waitFor(`document.querySelector("#lowerBody .resume p")?.textContent.includes("Pack 10")`, "the handover shows");
    const got = await ev(`(()=>{const b=document.querySelector("#lowerBody");return {summary:b.querySelector(".resume p").innerHTML,rows:[...b.querySelectorAll("[data-note-row]")].map((r)=>r.innerHTML)}})()`);
    assert.deepEqual(got, { summary: "<strong>Pack 10</strong> is done", rows: ["fixed <code>x</code> thing", "<strong>bold</strong> note", "<strong>Next</strong> up"] }, `matched: ${JSON.stringify(got)}`);
    await shot("c-handover-panel.png");
  });
});

test("handover panel: a fenced block shows as typed, an unclosed fence never hides what follows", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    await seedModelText(ev, tabA, tabB);
    const notes = ["Summary **line**", "- before **bold**", FENCE + "js", "**literal** and `tick`", "- not a bullet **x**", FENCE, "- after **bold**", FENCE, "- tail **bold**"].join("\n");
    await ev(`(()=>{const s=window.__ccSeed,tab=s.projects[0].tabs.find((x)=>x.id===${J(tabA)});tab.notes.content=${J(notes)};__ccDeliver({...structuredClone(s),type:"state"});return true})()`);
    await ev(`document.querySelector("#side").hidden&&document.querySelector("#sideBtn").click();document.querySelector('[data-l="notes"]').click();true`);
    await waitFor(`document.querySelector("#lowerBody .resume p")?.textContent.includes("Summary")`, "the handover shows");
    const got = await ev(`(()=>{const b=document.querySelector("#lowerBody");return {summary:b.querySelector(".resume p").innerHTML,rows:[...b.querySelectorAll("[data-note-row]")].map((r)=>r.innerHTML)}})()`);
    assert.deepEqual(got, { summary: "Summary <strong>line</strong>", rows: ["before <strong>bold</strong>", "<code>**literal** and `tick`</code>", "<code>- not a bullet **x**</code>", "after <strong>bold</strong>", "tail <strong>bold</strong>"] }, `matched: ${JSON.stringify(got)}`);
  });
});

// ---- The sweep, built from the real list ----
// Every place in public/app.js that calls the renderer or a plain-label helper is found in the source (by "function(first argument"), and each one is matched below to the
// scene that makes the page show it. A call site nobody covers, or a scene that claims one the source no longer has, is a gap; so a place added, removed or bypassed goes red.
const APP_JS = readFileSync(join(REPO, "public", "app.js"), "utf8");
const pageSource = (source: string) => source.slice(source.indexOf("const ICONS")); // above the icon table are the renderer's own definitions, not call sites
function callSites(source: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const m of pageSource(source).matchAll(/\b(mdHtml|mdInline|plainMd|mdPlain)\(\s*([\w."?]+)/g)) found.set(`${m[1]}(${m[2]}`, (found.get(`${m[1]}(${m[2]}`) ?? 0) + 1);
  return found;
}

// Every esc(...) whose argument (balanced parentheses, so ??, ||, ternaries and templates are all inside it) still holds a model-text field once the wrapped calls are taken out.
const MODEL_FIELD = /\b(?:run|item\.run|selected|last|current|failed|stalled|row|item\.row|message|request|seat|member)\.(?:label|brief|title|body|task)\b/;
function bareModelEscapes(source: string): { bare: string[]; scanned: number } {
  const page = pageSource(source), bare: string[] = []; let scanned = 0;
  for (const m of page.matchAll(/\besc\(/g)) {
    let depth = 1, end = m.index! + m[0].length;
    while (end < page.length && depth > 0) { if (page[end] === "(") depth += 1; else if (page[end] === ")") depth -= 1; end += 1; }
    const argument = page.slice(m.index! + m[0].length, end - 1).replace(/\b(?:plainMd|mdPlain|mdHtml|mdInline)\([^()]*\)/g, "");
    scanned += 1;
    if (MODEL_FIELD.test(argument)) bare.push(`esc(${argument.slice(0, 80)})`);
  }
  return { bare, scanned };
}

type Scene = { id: string; covers: Record<string, number>; setup: string; act?: string; ready: string; read: string; words: string[]; rich?: string };
const ALL = (selector: string) => `__ccAll(${J(selector)})`;
const OPEN_NOTES = `document.querySelector("#side").hidden&&document.querySelector("#sideBtn").click();document.querySelector('[data-l="notes"]').click()`;
const OPEN_SEAT = `document.querySelector('[data-seat-open="'+W+'"]').click()`;
const TASK_SEAT = (word: string) => `worker.status="working";worker.task=${J(MARK(word))};tab.runs=[]`;
const FAILED_RUN = (word: string) => `tab.runs=[run("rf","failed",${J(MARK(word))})]`;
const LIVE_RUN = (id: string, word: string, extra = "") => `run(${J(id)},"working",${J(MARK(word))}${extra})`;
// One scene per place the page shows model text: how to put the page in that state, how to open it, what to read there, and the words that must survive.
const SCENES: Scene[] = [
  { id: "OS notification at the end of a run", covers: { "mdPlain(message.label": 1 }, words: ["NotifyWord"],
    setup: `window.__notes=[];window.Notification=Object.assign(class{constructor(title,options){window.__notes.push(title+" | "+options?.body)}},{permission:"granted"})`,
    act: `__ccDeliver({type:"runFail",tabId:tab.id,seatKey:tab.id+"."+W,runId:"nr",label:${J(MARK("NotifyWord"))},outcome:"failed",exitCode:1})`,
    ready: `window.__notes.length>0`, read: `window.__notes.join(" || ")` },
  { id: "crew rail line, tooltip and labels", covers: { "mdPlain(seat.isLeader": 1 }, words: ["RailTask"],
    setup: TASK_SEAT("RailTask"), ready: `document.querySelector('#crew [data-seat-id="'+W+'"]')`, read: `__ccAll('#crew [data-seat-id="'+W+'"]')` },
  { id: "seat stage head line", covers: {}, words: ["StageTask"],
    setup: TASK_SEAT("StageTask"), act: OPEN_SEAT, ready: `document.querySelector("#stagehead .vstat .vt")`, read: ALL("#stagehead .vstat") },
  { id: "seat card line", covers: {}, words: ["CardTask"],
    setup: TASK_SEAT("CardTask"), act: `document.querySelector('[data-seat-pic="'+W+'"]').click()`, ready: `document.querySelector("#seatPop .now")`, read: ALL("#seatPop .now") },
  { id: "status line, a worker's task", covers: { "mdPlain(seat.task": 1 }, words: ["PhraseTask"],
    setup: TASK_SEAT("PhraseTask"), ready: `document.querySelector("#statusBtn .pt")`, read: ALL("#statusBtn") },
  { id: "status line, failed run", covers: { "mdPlain(failed.label": 1 }, words: ["StatusFailed"],
    setup: FAILED_RUN("StatusFailed"), ready: `document.querySelector("#statusBtn .pt")`, read: ALL("#statusBtn") },
  { id: "status line, stalled run", covers: { "mdPlain(stalled.label": 1 }, words: ["StatusStalled"],
    setup: `tab.runs=[${LIVE_RUN("rs", "StatusStalled", ",{stalled:true}")}];worker.status="stalled"`, ready: `document.querySelector("#statusBtn .pt")`, read: ALL("#statusBtn") },
  { id: "leader message", covers: { "mdHtml(messageText": 1 }, words: ["LeaderWord"], rich: "#view .msg:not(.mine) .md",
    setup: ``, act: `window.__ccHistory[tab.id]=[{role:"assistant",text:${J(MARK("LeaderWord"))},at:1,revision:1}];window.__socket.history(tab.id)`,
    ready: `document.querySelector("#view .msg:not(.mine) .md")`, read: ALL("#view .msg:not(.mine)") },
  { id: "run tabs of a seat with several live runs", covers: { "plainMd(run.label": 2 }, words: ["TabOne", "TabTwo"],
    setup: `worker.status="working";tab.runs=[${LIVE_RUN("t1", "TabOne")},${LIVE_RUN("t2", "TabTwo")}]`, act: OPEN_SEAT, ready: `document.querySelector("#stagehead .runtabs")`, read: ALL("#stagehead .runtabs") },
  { id: "live run: doing now and the terminal bar", covers: { "mdPlain(current.label": 1, "plainMd(selected.label": 3 }, words: ["DoingWord"],
    setup: `worker.status="working";tab.runs=[${LIVE_RUN("d1", "DoingWord")}]`, act: OPEN_SEAT, ready: `document.querySelector("#view .term .tb")`, read: `${ALL("#stagehead .facts")}+" | "+${ALL("#view .term .tb")}` },
  { id: "last result of a seat", covers: { "plainMd(last.label": 2 }, words: ["LastWord"],
    setup: `worker.status="idle";tab.runs=[run("l1","done",${J(MARK("LastWord"))})]`, act: OPEN_SEAT, ready: `document.querySelector("#view .last")`, read: ALL("#view .last") },
  { id: "runs from earlier crews (the leader's Past sessions)", covers: { "mdPlain(run.label": 1, "plainMd(run.label": 1 }, words: ["RetiredWord"],
    setup: `worker.status="idle";tab.runs=[];tab.derived.runViews.retiredHistory=[run("old1","done",${J(MARK("RetiredWord"))})]`, act: `document.querySelector('[data-seat-pic="leader"]').click();document.querySelector("#seatPop [data-seat-history]").click()`,
    ready: `[...document.querySelectorAll("#view h3")].some((h)=>h.textContent.includes("earlier crews"))`, read: ALL("#view") },
  { id: "seat card: live run rows", covers: { "plainMd(run.label": 3 }, words: ["RowWord"],
    setup: `worker.status="working";tab.runs=[${LIVE_RUN("c1", "RowWord")}]`, act: `document.querySelector('[data-seat-pic="'+W+'"]').click()`, ready: `document.querySelector("#seatPop .sr")`, read: ALL("#seatPop .sr") },
  { id: "handover summary and rows", covers: { "mdInline(bare": 1 }, words: ["Pack 10", "bold", "Next"], rich: "#lowerBody",
    setup: ``, act: OPEN_NOTES, ready: `document.querySelector("#lowerBody .resume p")`, read: ALL("#lowerBody") },
  { id: "handover with nothing saved", covers: { 'mdInline("Nothing': 1 }, words: ["Nothing saved yet"],
    setup: `tab.notes.content=""`, act: OPEN_NOTES, ready: `document.querySelector("#lowerBody .resume p")`, read: ALL("#lowerBody .resume") },
  { id: "request cards, incoming and sent", covers: { "plainMd(request.title": 1, "mdHtml(request.body": 1 }, words: ["ReqTitle", "ReqBody", "point one", "SentTitle", "SentBody"], rich: "#inboxList .ncard.req",
    setup: ``, ready: `document.querySelector("#inboxList .ncard.req")&&document.querySelector("#reqList .ncard")`, read: `${ALL("#inboxList .ncard.req")}+" | "+${ALL("#reqList")}` },
  { id: "failed run card (Needs you)", covers: { "plainMd(item.run.label": 1 }, words: ["CardFailed"],
    setup: FAILED_RUN("CardFailed"), ready: `document.querySelector("#inboxList .ncard.bad")`, read: ALL("#inboxList .ncard.bad") },
  { id: "stalled run card (Needs you)", covers: { "plainMd(item.run.label": 1 }, words: ["CardStalled"],
    setup: `tab.runs=[${LIVE_RUN("cs", "CardStalled", ",{stalled:true}")}]`, ready: `document.querySelector("#inboxList .ncard.bad")`, read: ALL("#inboxList .ncard.bad") },
  { id: "stop not confirmed card (Needs you)", covers: { "plainMd(run.label": 1 }, words: ["UncertainRun"],
    setup: `tab.runs=[${LIVE_RUN("u1", "UncertainRun")}];s.launchSafety.uncertain=[{runId:"u1",seatKey:tab.id+"."+W,pid:4242}]`, ready: `[...document.querySelectorAll("#inboxList .ncard.bad")].some((c)=>c.textContent.includes("Stop not confirmed"))`, read: ALL("#inboxList .ncard.bad") },
  { id: "unconfirmed launch card (Needs you)", covers: { "plainMd(item.row.brief": 1 }, words: ["NoticeBrief"],
    setup: ``, ready: `document.querySelector("#inboxList")?.textContent.includes("NoticeBrief")`, read: ALL("#inboxList") },
  { id: "launch records", covers: { "plainMd(row.brief": 1 }, words: ["RecordBrief"],
    setup: `s.launchSafety.notices=[{id:9,pending:false,seatKey:tab.id+"."+W,seatName:worker.name,source:"Atlas",brief:${J(MARK("RecordBrief"))}}]`, ready: `document.querySelector("#inboxRecords")?.textContent.includes("RecordBrief")`, read: ALL("#inboxRecords") },
  { id: "streaming reply, first paint and repaint", covers: { "mdHtml(draft": 2 }, words: ["StreamFirst", "StreamLater"], rich: "#view [data-stream] .md",
    setup: ``, act: `(async()=>{const d=(text)=>__ccDeliver({type:"chatDelta",tabId:tab.id,text});d(${J(MARK("StreamFirst") + " ")});await new Promise((r)=>setTimeout(r,150));d(${J(MARK("StreamLater"))});await new Promise((r)=>setTimeout(r,150))})()`,
    ready: `document.querySelector("#view [data-stream] .md")?.textContent.includes("StreamLater")`, read: ALL("#view [data-stream]") },
];

// Each scene starts from the same base state, with the page back on the chat and no card open.
async function walkScene(page: Page, scene: Scene) {
  const { ev, waitFor, tabA } = page;
  const pre = `const s=window.__ccSeed,tab=s.projects[0].tabs.find((x)=>x.id===${J(tabA)}),worker=tab.crew.find((x)=>!x.isLeader),W=worker.slot,now=Date.now(),
    run=(id,status,label,extra={})=>({runId:id,seatSlotId:W,seatName:worker.name,seatIsLeader:false,status,label,outcome:status==="working"?undefined:status,cli:"claude",model:"m",startedAt:now-5000,...(status==="working"?{}:{endedAt:now}),crewGenerationId:tab.processState.crewGenerationId,folderPath:"C:/x",...extra});`;
  await ev(`(()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));document.querySelector("[data-back-chat],[data-chat-live]")?.click();window.__ccSeed=structuredClone(window.__ccBase);${pre}${scene.setup};__ccDeliver({...structuredClone(s),type:"state"});return true})()`);
  if (scene.act) await ev(`(async()=>{${pre}${scene.act};return true})()`);
  try { await waitFor(`(()=>{${pre}return Boolean(${scene.ready})})()`, `${scene.id}: the place shows`); }
  catch (error) { throw new Error(`${(error as Error).message}; the page had: ${JSON.stringify(await ev(`({errors:window.__ccErrors,seats:[...document.querySelectorAll("#crew [data-seat-id]")].map((e)=>e.dataset.seatId),crew:document.querySelector("#crew")?.innerHTML.slice(0,200),view:document.querySelector("#view")?.innerHTML.slice(0,300)})`))}`); }
  const text: string = await ev(`(()=>{${pre}return ${scene.read}})()`);
  assert.ok(text && text.trim(), `${scene.id}: the page showed something`);
  for (const word of scene.words) assert.ok(text.includes(word), `${scene.id} keeps "${word}"; matched: ${text.slice(0, 300)}`);
  for (const bad of ["**", "`", "\u0000"]) assert.ok(!text.includes(bad), `${scene.id} shows a raw ${JSON.stringify(bad)}; matched: ${text.slice(0, 300)}`);
  if (scene.rich) assert.ok(await ev(`document.querySelectorAll(${J(`${scene.rich} strong`)}).length>0`), `${scene.id} is formatted (bold) where it can be`);
}

// The control: the same comparison on the real list with one claimed place taken away (or one call taken out of the source) must show a gap.
function inventoryGaps(found: Map<string, number>, scenes: Scene[]): string[] {
  const claimed = new Map<string, number>();
  for (const scene of scenes) for (const [key, count] of Object.entries(scene.covers)) claimed.set(key, (claimed.get(key) ?? 0) + count);
  return [...new Set([...found.keys(), ...claimed.keys()])].filter((key) => (found.get(key) ?? 0) !== (claimed.get(key) ?? 0)).map((key) => `${key}: source has ${found.get(key) ?? 0}, scenes cover ${claimed.get(key) ?? 0}`);
}

test("sweep: every call site of the renderer and the plain-label helpers is covered by a scene, and the control catches a missing one", () => {
  const found = callSites(APP_JS);
  assert.ok([...found.values()].reduce((sum, count) => sum + count, 0) >= 30, `the scan found the call sites: ${JSON.stringify([...found])}`);
  assert.deepEqual(inventoryGaps(found, SCENES), [], "every call site has exactly the scenes that cover it");
  for (const scene of SCENES.filter((item) => Object.keys(item.covers).length)) assert.ok(inventoryGaps(found, SCENES.filter((item) => item !== scene)).length > 0, `control: without "${scene.id}" the inventory shows a gap`);
  const first = [...found.keys()][0], removed = APP_JS.replace(first, "removedCall(");
  assert.ok(inventoryGaps(callSites(removed), SCENES).length > 0, `control: taking ${first} out of the source shows a gap`);
});

test("sweep: every scene, walked from the real page, shows no raw ** or backtick and keeps the words", async (t) => {
  if (skipped(t)) return;
  await withPage(async (page) => {
    await seedModelText(page.ev, page.tabA, page.tabB);
    await page.ev(`window.__ccBase=structuredClone(window.__ccSeed);window.__ccAll=(sel)=>[...document.querySelectorAll(sel)].map((el)=>[el,...el.querySelectorAll("*")].map((n)=>(n===el?n.textContent:"")+" "+n.getAttributeNames().filter((a)=>a!=="class"&&a!=="style").map((a)=>n.getAttribute(a)).join(" ")).join(" ")).join(" | ");true`);
    const walked: string[] = [];
    for (const scene of SCENES) { await walkScene(page, scene); walked.push(scene.id); }
    assert.deepEqual(walked, SCENES.map((scene) => scene.id), "every scene was walked");
  });
});

test("sweep (source): no model-text field (label, brief, title, body, task) reaches the page through a bare esc(), in any expression", () => {
  const { bare, scanned } = bareModelEscapes(APP_JS);
  assert.deepEqual(bare, [], "these still print model text with only esc()");
  // The control: the scan reads esc() calls (an empty scan from a renamed helper goes red), and it flags every shape a field can hide in.
  assert.ok(scanned >= 150, `the scan read ${scanned} esc() calls`);
  for (const shape of ["esc(row.brief ?? \"\")", "esc(item.run.label || \"a run\")", "esc(run ? run.label : \"\")", "esc(`${seat.name} · ${run.label}`)", "esc(selected.label)", "esc(seat.task)", "esc(request.title)"]) {
    assert.equal(bareModelEscapes(`const ICONS = 1;${shape}`).bare.length, 1, `control: the scan flags ${shape}`);
  }
  assert.equal(bareModelEscapes("const ICONS = 1;esc(`${run.seatName} · ${mdPlain(run.label)}`)").bare.length, 0, "control: a wrapped field is not flagged");
});
