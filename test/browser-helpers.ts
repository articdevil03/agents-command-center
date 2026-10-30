import { SERVER_START_MS } from "./server-start.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stopChromeTree, chromeStopBoundMs } from "./chrome-stop.ts";
import { type Server } from "node:net";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { keyedWsUrl } from "./temp-root.ts";
import { HOST, APP_KEY, CHROME, REPO, CHROME_CAP_HEADROOM_MS } from "./browser-constants.ts";

// The workspace file is written in the old (kind, process) format on purpose: the server loads it through its migration to a tab with its own crew and steps.
// The seats are the old Main Crew, Duo and Design defaults as they were when this fixture was made (they no longer come from a table in the server).
export const OLD_SEATS = {
  "dev/main": [["leader", "Atlas", "claude", "claude-opus-5-5[1m]", "medium"], ["coder", "Sonny", "codex", "gpt-6-luna", "max"], ["reviewer1", "Vera", "claude", "claude-opus-5-5[1m]", "medium"], ["reviewer2", "Sol", "codex", "gpt-6-sol", "high"], ["fixer", "Nova", "claude", "claude-opus-5-5[1m]", "medium"], ["finalReviewer", "Terra", "codex", "gpt-6-sol", "high"]],
  "design/main": [["leader", "Atlas", "claude", "claude-opus-5-5[1m]", "high"], ["designer", "Terra", "claude", "claude-opus-5-5[1m]", "high"], ["imageAndAssets", "X", "codex", "gpt-6-astra", "medium"], ["designReviewer", "Sol", "codex", "gpt-6-sol", "high"]],
  "dev/duo": [["leader", "Atlas", "claude", "claude-opus-5-5[1m]", "medium"], ["coder", "Sonny", "codex", "gpt-6-luna", "max"]],
} as const;
export function defaults(kind: "dev" | "design", process: "main" | "duo") {
  return OLD_SEATS[`${kind}/${process}` as keyof typeof OLD_SEATS].map(([slot, name, cli, model, effort]) => ({ slot, name, cli, model, effort }));
}

export function workspaces(root: string) {
  const folder = (name: string) => {
    const path = join(root, "folders", name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return { projects: [
    { id: "alpha", name: "Alpha", folder: folder("alpha"), tabs: [
      { id: "alpha-dev", name: "Development", kind: "dev", process: "main", folder: folder("alpha-dev"), crew: defaults("dev", "main") },
      { id: "alpha-design", name: "Design", kind: "design", process: "main", folder: folder("alpha-design"), crew: defaults("design", "main") },
    ] },
    { id: "beta", name: "Beta", folder: folder("beta"), tabs: [
      { id: "beta-dev", name: "Development", kind: "dev", process: "duo", folder: folder("beta-dev"), crew: defaults("dev", "duo") },
    ] },
  ] };
}

export function waitServer(proc: ReturnType<typeof spawn>, timeoutMs = SERVER_START_MS): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    // Infrastructure timeout stays a plain Error, never a caught mutation.
    const timer = setTimeout(() => finish(new Error(`server did not become ready; output=${output}`)), timeoutMs);
    const finish = (result: number | Error) => {
      clearTimeout(timer); proc.stdout?.off("data", onData); proc.off("exit", onExit); proc.off("error", onError);
      if (result instanceof Error) reject(result); else resolveReady(result);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /Command Center running at http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) finish(Number(match[1]));
    };
    const onExit = (code: number | null) => finish(new Error(`server exited before ready (${code}); output=${output}`));
    const onError = (error: Error) => finish(error);
    proc.stdout?.on("data", onData); proc.once("exit", onExit); proc.once("error", onError);
  });
}

export async function stopServer(proc: ReturnType<typeof spawn>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, "exit");
  proc.kill();
  let timeout: NodeJS.Timeout | undefined;
  // Infrastructure timeout stays a plain Error, never a caught mutation.
  const result = await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`server ${proc.pid} did not exit`)), 7000); })]);
  if (timeout) clearTimeout(timeout);
  assert.ok(result, `server process ${proc.pid} exited after SIGTERM`);
}

export async function getServerState(port: number): Promise<any> {
  const origin = `http://${HOST}:${port}`;
  return new Promise((resolveState, reject) => {
    const ws = new WebSocket(keyedWsUrl(`ws://${HOST}:${port}`, APP_KEY), { origin });
    // Infrastructure timeout stays a plain Error, never a caught mutation.
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("server state request timed out")); }, 5000);
    ws.once("open", () => ws.send(JSON.stringify({ type: "hello" })));
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "state") return;
      clearTimeout(timer); ws.close(); resolveState(message);
    });
    ws.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

export function fakeParallelState(state: any) {
  const copy = structuredClone(state);
  const tab = copy.projects.flatMap((project: any) => project.tabs).find((item: any) => item.id === "alpha-dev");
  const lead = tab.crew.find((item: any) => item.isLeader || item.slot === "leader");
  if (lead) lead.name = '<img src=x onerror="window.__ccXss()">';
  const seat = tab.crew.find((item: any) => item.slot === "coder");
  const start = Date.now();
  const runs = ["audit-parallel-1", "audit-parallel-2"].map((runId, index) => ({
    id: runId,
    runId,
    seatSlotId: "coder",
    seatKey: "alpha-dev.coder",
    seatName: seat.name,
    seatIsLeader: false,
    label: `Parallel run ${index + 1}`,
    status: "working",
    outcome: null,
    cli: seat.cli,
    model: seat.model,
    effort: seat.effort,
    folderPath: tab.folder,
    startedAt: start + index,
    endedAt: null,
    output: `real runner output ${index + 1}`,
    launchedBy: null,
  }));
  tab.runs = [...tab.runs.filter((run: any) => run.status !== "working"), ...runs];
  seat.status = "working"; seat.task = "Working · parallel tasks"; seat.runs = runs.map((run: any) => run.runId);
  tab.processState.runs = [...tab.processState.runs.filter((run: any) => run.status !== "working"), ...runs.map((run: any) => ({
    id: run.runId, crewGenerationId: tab.processState.crewGenerationId, seatSlotId: "coder", seatName: seat.name,
    seatIsLeader: false, label: run.label, status: "working", outcome: null, cli: seat.cli, model: seat.model,
    effort: seat.effort, folderPath: tab.folder, startedAt: run.startedAt, endedAt: null,
  }))];
  tab.processState.seats.find((item: any) => item.slotId === "coder").status = "working";
  tab.derived.busy = true;
  tab.derived.workingSeats = [...tab.derived.workingSeats.filter((item: any) => item.slotId !== "coder"), { slotId: "coder", name: seat.name, isLeader: false }];
  tab.derived.runViews.liveBySeat.coder = tab.processState.runs.filter((run: any) => run.seatSlotId === "coder");
  copy.selectedTabId = "alpha-dev";
  return copy;
}

export function proxyServer(backendPort: number, options: { folder: string; mode: string; seed?: any; storageBlocked?: boolean; windowButtons?: boolean; oldMe?: { saved: string; expected: string } }, auditScript: string) {
  // The window-button bridge only the real Electron window has (electron/preload.cjs): this page records each call, starts maximized,
  // and window.__ccWinEmit(true|false) plays the main process telling the page the window was maximized or restored.
  // window.__ccWinAskClose() plays the main process asking the page about a close; window.__ccWin.answers records each answer.
  const windowScript = options.windowButtons ? `window.__ccWin={calls:[],maximized:true,listeners:[],closeListeners:[],answers:[]};Object.assign(window.cc,{minimizeWindow:()=>{window.__ccWin.calls.push("minimize");return Promise.resolve()},toggleMaximizeWindow:()=>{window.__ccWin.calls.push("toggleMaximize");return Promise.resolve()},closeWindow:()=>{window.__ccWin.calls.push("close");return Promise.resolve()},isWindowMaximized:()=>Promise.resolve(window.__ccWin.maximized),onWindowMaximized:(callback)=>{window.__ccWin.listeners.push(callback)},onCloseRequested:(callback)=>{window.__ccWin.closeListeners.push(callback)},answerClose:(answer)=>{window.__ccWin.answers.push(answer);return Promise.resolve()}});window.__ccWinEmit=(value)=>{window.__ccWin.maximized=value;for(const callback of window.__ccWin.listeners)callback(value)};window.__ccWinAskClose=()=>{for(const callback of window.__ccWin.closeListeners)callback()};` : "";
  const backendHost = `${HOST}:${backendPort}`;
  const backendOrigin = `http://${backendHost}`;
  // A picture saved before the simple look now reaches the page the only way a saved picture can: in the server's client prefs.
  const seedScript = options.seed ? `window.__ccSeed=${JSON.stringify(options.seed).replace(/</g, "\\u003c")};${options.oldMe ? `window.__ccSeed.clientPrefs={...window.__ccSeed.clientPrefs,avatar:${JSON.stringify(options.oldMe.saved)}};` : ""}` : "";
  const storageScript = options.storageBlocked
    ? `window.__ccStorageBlocked=true;Storage.prototype.getItem=function(){throw new DOMException("blocked","SecurityError")};Storage.prototype.setItem=function(){throw new DOMException("blocked","SecurityError")};`
    : `window.__ccStorageBlocked=false;${options.oldMe ? `window.__ccOldMe=${JSON.stringify(options.oldMe.saved)};window.__ccExpectMe=${JSON.stringify(options.oldMe.expected)};` : ""}`;
  const bootstrap = `
window.__ccErrors=[];window.__sent=[];window.__states=[];window.__received=[];window.__latestState=null;window.__ccHoldChatDone=false;window.__ccPendingChatDone=null;window.__ccDelaySelect=false;window.__ccDelayedSelect=null;window.__ccRejectHeldAction=null;window.__ccHoldNextRemoveState=false;window.__ccHeldRemoveState=null;window.__ccHistoryOverride=null;window.__ccChatHistory={};
window.__ccXss=()=>window.__ccErrors.push("escaped text ran as HTML");
window.__ccConfirms=[];window.__ccConfirmResult=true;window.confirm=(message)=>{window.__ccConfirms.push(String(message));return window.__ccConfirmResult};window.__ccOpenedObsidian=[];window.__ccFolderChoice=${JSON.stringify(options.folder)};window.cc={appKey:async()=>${JSON.stringify(APP_KEY)},pickFolder:async()=>window.__ccFolderChoice,openObsidian:async(url)=>{window.__ccOpenedObsidian.push(String(url));return {ok:true}}};${seedScript}${storageScript}${windowScript}
window.__ccAuditFinished=false;
const __ccSetTimeout=window.setTimeout.bind(window);
window.setTimeout=(fn,delay,...args)=>window.__ccAuditFinished?0:__ccSetTimeout(fn,delay,...args);
window.addEventListener("error",e=>window.__ccErrors.push(String(e.message||e.target?.src||e.target?.href||"browser error")));
window.addEventListener("unhandledrejection",e=>window.__ccErrors.push(String(e.reason?.message||e.reason||"unhandled rejection")));
const __ccConsoleError=console.error.bind(console);
console.error=(...a)=>{window.__ccErrors.push("console.error: "+a.map(String).join(" "));__ccConsoleError(...a)};
function __ccObserve(raw){try{const m=JSON.parse(raw);window.__received.push(m);if(m.type==="chatMessage"){const extra=Object.keys(m).filter(k=>!["type","tabId","revision","role","text","images","files","requestId","at"].includes(k));if(extra.length)window.__ccErrors.push("chatMessage fixture has fields the server never sends: "+extra.join(","))}if(m.type==="state"){window.__latestState=m;window.__states.push(m)}}catch{}}
if(new URLSearchParams(location.search).get("mode")==="fake"){
 class FakeWebSocket{
  static OPEN=1;static CONNECTING=0;
  constructor(){this.readyState=0;this.listeners=new Map();window.__socket=this;setTimeout(()=>{this.readyState=1;this.emit("open",{})},0)}
  addEventListener(name,fn){const items=this.listeners.get(name)||[];items.push(fn);this.listeners.set(name,items)}
  emit(name,event){for(const fn of this.listeners.get(name)||[])fn(event)}
  send(raw){
   const message=JSON.parse(raw);window.__sent.push(message);
   if(message.type==="hello"){this.sendMessage({...structuredClone(window.__ccSeed),type:"state"});this.sendHistory(window.__ccSeed.selectedTabId)}
   else if(message.type==="selectTab"){if(window.__ccRefuseSelect===message.tabId){window.__ccRefuseSelect=null;this.sendMessage({type:"error",action:"selectTab",tabId:message.tabId,message:"cannot open "+message.tabId});return}if(window.__ccDelaySelect){window.__ccDelaySelect=false;window.__ccSeed.selectedTabId=message.tabId;window.__ccDelayedSelect=message.tabId;return}if(window.__ccDelayedSelect){const delayed=window.__ccDelayedSelect;window.__ccDelayedSelect=null;window.__ccSeed.selectedTabId=delayed;this.sendMessage({...structuredClone(window.__ccSeed),type:"state"});this.sendHistory(delayed)}window.__ccSeed.selectedTabId=message.tabId;this.sendMessage({...structuredClone(window.__ccSeed),type:"state"});this.sendHistory(message.tabId)}
    else if(message.type==="removeTab"){if(window.__ccSwallowRemove){window.__ccSwallowRemove=false;return}if(window.__ccRejectHeldAction?.type==="removeTab"&&window.__ccRejectHeldAction.tabId===message.tabId){const refused=window.__ccRejectHeldAction;window.__ccRejectHeldAction=null;setTimeout(()=>this.sendMessage({type:"error",action:"removeTab",tabId:refused.tabId,message:"cannot remove busy tab "+refused.tabId}),0)}else{for(const project of window.__ccSeed.projects)project.tabs=project.tabs.filter(tab=>tab.id!==message.tabId);window.__ccSeed.selectedTabId=window.__ccSeed.projects.flatMap(project=>project.tabs)[0]?.id;const nextState={...structuredClone(window.__ccSeed),type:"state"};if(window.__ccHoldNextRemoveState){window.__ccHoldNextRemoveState=false;window.__ccHeldRemoveState=nextState;return}this.sendMessage(nextState);this.sendHistory(window.__ccSeed.selectedTabId)}}
    else if(message.type==="removeProject"){window.__ccSeed.projects=window.__ccSeed.projects.filter(project=>project.id!==message.projectId);window.__ccSeed.selectedTabId=window.__ccSeed.projects.flatMap(project=>project.tabs)[0]?.id;this.sendMessage({...structuredClone(window.__ccSeed),type:"state"});this.sendHistory(window.__ccSeed.selectedTabId)}
   else if(message.type==="chat"&&window.__ccSeed.projects.flatMap(p=>p.tabs).find(t=>t.id===message.tabId)?.pendingApprovals?.length){this.sendMessage({type:"error",action:"chat",tabId:message.tabId,requestId:message.requestId,message:"Answer the pending approval before sending a message."})}
   else if(message.type==="chat"&&window.__ccChatMode==="refuse"){this.sendMessage({type:"error",action:"chat",tabId:message.tabId,requestId:message.requestId,message:"images must be a list of uploaded image paths"})}
   else if(message.type==="chat"&&window.__ccChatMode==="hold"){}
   else if(message.type==="chat"&&window.__ccChatMode==="swallow"){}
   else if(message.type==="chat"){const chatNumber=(window.__ccChatSequence=(window.__ccChatSequence||0)+1);const userRevision=chatNumber*2;
    const userMessage={tabId:message.tabId,role:"user",text:message.text,images:message.images||[],files:message.files||[],requestId:message.requestId,revision:userRevision,at:Date.now()};window.__ccChatHistory[message.tabId]=[...(window.__ccChatHistory[message.tabId]||[]),userMessage];this.sendMessage({type:"chatMessage",...userMessage});const sendingTab=window.__ccSeed.projects.flatMap(project=>project.tabs).find(tab=>tab.id===message.tabId);if(sendingTab)sendingTab.derived.leaderTurnActive=true;this.sendMessage({...structuredClone(window.__ccSeed),type:"state"});
    setTimeout(()=>this.sendMessage({type:"chatDelta",tabId:message.tabId,text:"The lead is answering."}),20);
    const done=()=>{this.sendMessage({type:"chatMessage",tabId:message.tabId,role:"assistant",text:"The lead replied.",revision:userRevision+1,at:Date.now()});this.sendMessage({type:"chatDone",tabId:message.tabId,revision:userRevision+1,savedRevision:1});if(sendingTab)sendingTab.derived.leaderTurnActive=false;this.sendMessage({...structuredClone(window.__ccSeed),type:"state"})};if(window.__ccHoldChatDone)window.__ccPendingChatDone=done;else setTimeout(done,40)
   }
   else if(message.type==="answerApproval"){
    if(window.__ccApprovalReply==="hold")return;
    if(window.__ccApprovalReply==="refuse"){this.sendMessage({type:"error",action:"answerApproval",requestId:message.requestId,tabId:message.tabId,message:"Approval is no longer available"});return}
    const tab=window.__ccSeed.projects.flatMap(p=>p.tabs).find(t=>t.id===message.tabId);tab.pendingApprovals=tab.pendingApprovals.filter(a=>a.approvalId!==message.approvalId);
    this.sendMessage({type:"actionResult",action:"answerApproval",requestId:message.requestId,tabId:message.tabId});this.sendMessage({...structuredClone(window.__ccSeed),type:"state"})
   }
   else if(message.type==="save"){if(window.__ccSaveDeferred)return;if(window.__ccSaveError)this.sendMessage({type:"error",action:"save",tabId:message.tabId,message:"Save failed in the harness"});else this.sendMessage({type:"saved",tabId:message.tabId,revision:3,savedRevision:3})}
   else if(message.type==="clear"){window.__ccClearedTab=message.tabId;window.__ccClearSnapshot=[{tabId:message.tabId,role:"user",text:"Before Clear",at:Date.now(),revision:3}];this.sendMessage({type:"chatCleared",tabId:message.tabId,messages:[],revision:4,savedRevision:0})}
   else if(message.type==="undoClear"){if(window.__ccUndoReject){const reason=window.__ccUndoReject,tabId=message.tabId;Promise.resolve().then(()=>this.sendMessage({type:"chatUndoRejected",tabId,reason}))}else this.sendMessage({type:"chatRestored",tabId:message.tabId,messages:window.__ccClearSnapshot||[],revision:3,savedRevision:3})}
   else if(message.type==="updateClientPref"){window.__ccSeed.clientPrefs||={};window.__ccSeed.clientPrefs[message.key]=message.value;if(window.__ccHoldPrefEcho)return;this.sendMessage({...structuredClone(window.__ccSeed),type:"state"})}
   else if(message.type==="historyList"){if(!window.__ccDropHistory)this.sendMessage({type:"historyList",seatKey:message.seatKey,runs:window.__ccHistoryRuns?.[message.seatKey]??[]})}
   else if(message.type==="killRun"){if(window.__ccSwallowKill>0){window.__ccSwallowKill--;return}this.sendMessage({type:"killAccepted",runId:message.runId})}
   else if(message.type==="refreshSettings"){if(window.__ccRefreshReply==="error")this.sendMessage({type:"error",action:"refreshSettings",requestId:message.requestId,message:"Check failed in the harness"});else if(window.__ccRefreshReply==="ok")this.sendMessage({type:"actionResult",action:"refreshSettings",requestId:message.requestId})}
   else if(message.type==="resolveRequest"&&window.__ccStrictRequests){const request=(window.__ccSeed.requests||[]).find(item=>item.id===message.id);if(!request||message.tabId!==request.toTabId)this.sendMessage({type:"error",action:"resolveRequest",requestId:message.requestId,message:"request is not addressed to this tab"});else{request.status=message.status;this.sendMessage({type:"actionResult",action:"resolveRequest",requestId:message.requestId,id:request.id,status:request.status,toTabId:request.toTabId});this.sendMessage({...structuredClone(window.__ccSeed),type:"state"})}}
   else if(message.type==="run")this.sendMessage({type:"runAccepted",tabId:message.tabId,runId:"fake-run-"+(window.__ccRunSequence=(window.__ccRunSequence||0)+1)})
   else if(message.type==="stopAll")this.sendMessage({type:"stopAllAccepted"})
  }
    sendHistory(tabId){const base=tabId==="alpha-dev" ? [{tabId,role:"assistant",text:"Saved transcript from the server",at:Date.now(),revision:1}] : tabId ? [{tabId,role:"assistant",text:"Saved transcript for "+tabId,at:Date.now(),revision:1}] : [];const override=window.__ccHistoryOverride?.tabId===tabId?window.__ccHistoryOverride.messages:null;if(override)window.__ccHistoryOverride=null;const messages=override??[...base,...(window.__ccChatHistory[tabId]||[])];if(window.__ccHoldHistory){window.__ccHeldHistory={tabId,messages,revision:1,savedRevision:1};return}this.sendMessage({type:"chatHistory",tabId,messages,revision:1,savedRevision:1})}
  sendMessage(message){__ccObserve(JSON.stringify(message));this.emit("message",{data:JSON.stringify(message)})}
  close(){this.readyState=3;this.emit("close",{})}
 }
 window.WebSocket=FakeWebSocket;
}else{
 const NativeWebSocket=window.WebSocket;
 class TrackedWebSocket extends NativeWebSocket{
  constructor(...args){super(...args);window.__socket=this;super.addEventListener("message",event=>__ccObserve(event.data))}
  send(raw){try{window.__sent.push(JSON.parse(raw))}catch{}super.send(raw)}
 }
 Object.defineProperty(TrackedWebSocket,"OPEN",{value:NativeWebSocket.OPEN});window.WebSocket=TrackedWebSocket;
}
window.__ccDeliver=(message)=>{const raw=JSON.stringify(message),socket=window.__socket;if(typeof socket?.sendMessage==="function")socket.sendMessage(message);else socket?.dispatchEvent(new MessageEvent("message",{data:raw}))};
window.__ccMediaChange=[];const nativeMediaAdd=MediaQueryList.prototype.addEventListener;MediaQueryList.prototype.addEventListener=function(type,listener,...rest){if(type==="change"&&/prefers-color-scheme/.test(this.media))window.__ccMediaChange.push(listener);return nativeMediaAdd.call(this,type,listener,...rest)};
`;
  // The page's Content-Security-Policy stays, except that script-src also allows the inline bootstrap and audit scripts injected below; every other directive (images, fonts, connections) still applies to the real page.
  const appHtml = readFileSync(join(REPO, "public", "index.html"), "utf8").replace(/<link\b[^>]*https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, "").replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
  const html = appHtml.replace("</head>", `<script>${bootstrap}</script>\n</head>`)
    .replace("</body>", `<pre id="AUDIT">running</pre><script defer src="/__browser-harness.js"></script>\n</body>`);
  const proxy = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/__browser-barrier") { setTimeout(() => { response.writeHead(204); response.end(); }, 20); return; }
    if (url.pathname === "/__audit") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html); return; }
    if (url.pathname === "/__browser-harness.js") { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); response.end(auditScript); return; }
    const headers = { ...request.headers, host: backendHost, origin: backendOrigin, "accept-encoding": "identity" };
    const upstream = http.request({ host: HOST, port: backendPort, method: request.method, path: request.url, headers }, (result) => {
      response.writeHead(result.statusCode ?? 500, result.headers); result.pipe(response);
    });
    upstream.on("error", (error) => { response.writeHead(502); response.end(error.message); });
    request.pipe(upstream);
  });
  const wss = new WebSocketServer({ noServer: true });
  const refusedChats: string[] = [];
  proxy.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => {
      const serverSocket = new WebSocket(`ws://${backendHost}${request.url ?? "/"}`, { origin: backendOrigin, headers: { Host: backendHost } });
      const waiting: Array<{ data: string | Buffer; isBinary: boolean }> = [];
      client.on("message", (data, isBinary) => {
        // No real-server case sends a chat (it would start a real leader): one that does is held back here and fails the test when its proxy is shut.
        if (options.mode === "real" && !isBinary) { try { if (JSON.parse(data.toString()).type === "chat") { refusedChats.push(data.toString().slice(0, 200)); return; } } catch { /* not JSON: pass it on */ } }
        if (serverSocket.readyState === WebSocket.OPEN) serverSocket.send(data, { binary: isBinary});
        else waiting.push({ data: data as Buffer, isBinary });
      });
      serverSocket.on("open", () => { for (const message of waiting.splice(0)) serverSocket.send(message.data, { binary: message.isBinary }); });
      serverSocket.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      client.on("close", () => { if (serverSocket.readyState === WebSocket.OPEN) serverSocket.close(); });
      serverSocket.on("close", () => { if (client.readyState === WebSocket.OPEN) client.close(); });
      client.on("error", () => serverSocket.terminate()); serverSocket.on("error", () => client.terminate());
    });
  });
  return { proxy, wss, backendOrigin, options, refusedChats };
}
export function shutProxy(p: ReturnType<typeof proxyServer>) {
  p.wss.close(); p.proxy.close();
  assert.deepEqual(p.refusedChats, [], "a real-server audit tried to send a chat, which would start a real leader");
}

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, HOST, resolveListen); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

export function chromeAudit(args: { port: number; mode: string; folder: string; width: number; profile: string; caseName?: string; collect?: boolean; virtualMs: number; capMs?: number; capStartsAfter?: Promise<unknown>; chrome?: { exe: string; args: string[] } }): Promise<any> {
  const query = new URLSearchParams({ mode: args.mode, folder: args.folder });
  if (args.caseName) query.set("case", args.caseName);
  if (args.collect) query.set("collect", "1");
  const url = `http://${HOST}:${args.port}/__audit?${query}`;
  return new Promise((resolveAudit, rejectAudit) => {
    // args.chrome swaps in a stand-in program (a test of the cap and the tree kill); the audits always run the installed Chrome.
    const proc = spawn(args.chrome?.exe ?? CHROME, args.chrome?.args ?? [
    "--headless=new", "--dump-dom", `--virtual-time-budget=${args.virtualMs}`,
    `--window-size=${args.width + 16},1000`, `--user-data-dir=${args.profile}`,
    "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-gpu-sandbox",
      "--use-gl=swiftshader", "--disable-dev-shm-usage", "--disable-background-networking", "--no-proxy-server", "--hide-scrollbars", url,
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false; let capFiredAt = 0; const startedAt = Date.now();
    proc.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    // The real-time cap sits well above the virtual-time budget; a hung Chrome still ends here, and the wall time of every run is printed so its headroom is visible.
    const capMs = args.capMs ?? Number(process.env.CC_CHROME_TIMEOUT_MS ?? args.virtualMs + CHROME_CAP_HEADROOM_MS);
    // args.capStartsAfter (a test of the cap) holds the cap back until its workload has really started, so a busy PC's slow start-up is not
    // counted against the cap; that wait is bounded by the test, and a workload that never started kills Chrome and rejects with its reason.
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The cap stops the tree and rejects from here, not from "close" (which waits for every helper holding our pipes and so can come much later).
    const capFired = async () => {
      timedOut = true; capFiredAt = Date.now();
      const stop = await stopChromeTree(proc), bound = chromeStopBoundMs();
      console.log(`Chrome audit ${args.caseName ?? args.mode} at ${args.width}px hit its ${capMs} ms cap; stop took ${stop.ms} ms`);
      const message = stop.stopped ? `Chrome exceeded ${capMs}ms and exited after termination; stop: ${stop.facts.join("; ")}; stderr=${stderr.slice(-1500)}` : `Chrome exceeded ${capMs}ms and did NOT exit within ${bound} ms: ${stop.facts.join("; ")}; stderr=${stderr.slice(-1500)}`;
      rejectAudit(Object.assign(new Error(message), { capFiredAt, stopFacts: stop.facts }));
    };
    const arm = () => { if (proc.exitCode === null && proc.signalCode === null) timer = setTimeout(() => { void capFired(); }, capMs); };
    if (args.capStartsAfter) args.capStartsAfter.then(arm, (error) => {
      timedOut = true;
      stopChromeTree(proc).then((stop) => {
        const reason = error instanceof Error ? error : new Error(String(error));
        if (!stop.stopped) reason.message += `; Chrome did NOT exit within ${chromeStopBoundMs()} ms: ${stop.facts.join("; ")}`;
        rejectAudit(Object.assign(reason, { stopFacts: stop.facts }));
      });
    });
    else arm();
    proc.once("error", (error) => { clearTimeout(timer); rejectAudit(new Error(`Chrome launch failed: ${error.message}; stderr=${stderr.slice(-1500)}`)); });
    proc.once("close", (status, signal) => {
      clearTimeout(timer);
      if (timedOut) return;
      console.log(`Chrome audit ${args.caseName ?? args.mode} at ${args.width}px took ${Date.now() - startedAt} ms of its ${capMs} ms cap`);
      if (status !== 0) { rejectAudit(new Error(`Chrome exited with ${status} (${signal}); stderr=${stderr.slice(-1000)}; stdout=${stdout.slice(-1000)}`)); return; }
      const match = /<pre id="AUDIT"[^>]*>([\s\S]*?)<\/pre>/.exec(stdout);
      if (!match) { rejectAudit(new Error(`Chrome dump omitted #AUDIT; output tail=${stdout.slice(-2000)}`)); return; }
      try { resolveAudit(JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"))); }
      catch (error) { rejectAudit(new Error(`Could not parse Chrome #AUDIT JSON: ${String(error)}; matched=${match[1].slice(0, 2000)}`)); }
    });
  });
}
