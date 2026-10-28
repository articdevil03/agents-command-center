import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { getProcessDefinition, type ProcessKind, type ProcessId } from "../server/process.ts";
import { newAppKey, keyedWsUrl, keyHeaders } from "./temp-root.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";

const HOST = "127.0.0.1";
// One app key for every server this file spawns; each spawn passes it as CC_APP_KEY and the page gets it from window.cc.appKey().
const APP_KEY = newAppKey();
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPO = resolve(".");
// Real milliseconds a Chrome audit may take beyond its virtual-time budget (the cap is virtual + this). The old 60 s left Pack C (60 s virtual) a cap of 120 s,
// which a parallel `npm test` once passed. Measured 2026-10-13 on an ordinary PC: the slowest audit, Pack C, takes 25-28 s of real time, the whole file 2.5-3 minutes.
// A Chrome that hangs still ends at its cap (a test below proves it, and that nothing of it is left running), so more headroom only delays that verdict.
const CHROME_CAP_HEADROOM_MS = 120_000;

// Mutation sweeps run one part of this suite at a time: CC_BROWSER_PHASES=b2,titlebar (real, layout, titlebar, pack2, b2, packc, pack3, looks, approvals) and CC_BROWSER_WIDTHS=1600. Unset, everything runs.
const phase = (name: string) => !process.env.CC_BROWSER_PHASES || process.env.CC_BROWSER_PHASES.split(",").includes(name);
// Anything that narrows the run is said loudly, and under `npm test` it fails: a leftover variable must never turn most of the browser coverage into a quiet pass.
const NARROWED = [process.env.CC_BROWSER_PHASES && `CC_BROWSER_PHASES=${process.env.CC_BROWSER_PHASES}`, process.env.CC_BROWSER_WIDTHS && `CC_BROWSER_WIDTHS=${process.env.CC_BROWSER_WIDTHS}`, process.env.CC_BROWSER_DEBUG_ONLY === "1" && "CC_BROWSER_DEBUG_ONLY=1"].filter(Boolean) as string[];
if (NARROWED.length) console.log(`!!!!! NOT A FULL BROWSER RUN: ${NARROWED.join(" ")} skips part of this suite !!!!!`);
function narrowedRunError(env: NodeJS.ProcessEnv, narrowed: string[]): string | null {
  return narrowed.length && env.npm_lifecycle_event === "test" ? `npm test must run the whole browser suite, but ${narrowed.join(" ")} is set (it skips phases). Unset it.` : null;
}

// The harness writes audit.finished only when its last step ran; a report cut short by the virtual-time budget has checks but no failure and no marker.
function assertAuditFinished(audit: any, label: string) {
  assert.equal(audit?.finished, true, `${label}: the audit did not finish (the virtual-time budget or a crash ended it early); it ran ${audit?.checks?.length ?? 0} checks and the last was ${JSON.stringify(audit?.checks?.at(-1)?.name)}`);
}

async function freePort(): Promise<number> {
  while (true) {
    const probe = createServer();
    await new Promise<void>((resolveListen, reject) => {
      probe.once("error", reject);
      probe.listen(0, HOST, resolveListen);
    });
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
    if (port && port !== 4317) return port;
  }
}

// Every check the Pack C audit (case "c2") must have run, in the real-app test and in the approval test.
const C2_APPROVAL_CHECKS: string[] = [
  "tool approval panel, answers, focus, Waiting status and reconnect",
  "an answer in flight when the socket drops fails with Disconnected and unlocks Allow and Deny",
  "approval panel and Waiting status clear after answer",
  "a second click 30 ms after Allow cannot answer the next approval, and works after it settles",
  "a press that began on another approval is ignored and the next fresh press answers",
  "a held Enter key repeat is blocked on the approval buttons and a first press is not",
  "a new approval sends one desktop notification naming the tab and the change",
  "Settings keeps every unsaved field across a state broadcast",
  "Settings drops a draft once its save is done and keeps the others",
  "Settings opens with no leftover unsaved text after it was closed",
  "a sent request empties the form once and a second click sends no duplicate",
  "a seat-picture upload that finishes after its dialog was closed still applies and leaves the open Settings dialog alone",
  "a crew picker closed on one tab cannot redraw or send for it after another tab's picker opens",
  "an Outcome unknown launch stays locked when the brief is edited and sends no second run",
  "a Save that went unknown is not confirmed when the saved revision had not moved",
  "a Save that went unknown is confirmed when the saved revision moved past its start",
  "a New project create lost with the connection frees Create and says it is not known",
  "an Add tab create lost with the connection frees Create and says it is not known",
  "Check again is usable again after the connection dropped before its answer",
  "a force-enabled Start after an Outcome unknown launch sends no second run",
  "a project create that landed with its reply lost frees Create tab in the open Add tab dialog",
  "a tab create that landed with its reply lost frees Create project in the open New project dialog",
  // After "Check again is usable again..." in the harness (runR1Fixes): crew picks and the step button. The harness ends them last, so a cut-short audit lacks exactly these.
  "two crew picks for one tab leave exactly one notice; picking the current crew cancels the waiting change and sends nothing",
  "two quick crew picks send exactly one setProcess, the last pick",
  "three rapid clicks on the step button advance exactly one step, and a click after the pause works",
  "a step change arriving after an unrelated state still blocks the immediate click, and a click after the pause works",
  "a review round change (Found findings, Finish fixes) pauses the next step click for 600 ms, and a click after the pause works",
  "a tab that left the state loses its sent mark: a later change starts no pause",
  "a connection drop between a step click and its state keeps the pause: the immediate click is ignored, a click after the pause works",
];
const packCWidthChecks = (width: number): string[] => [
  `Pack C target selector list finds every required control at ${width}px`,
  `Settings section target list finds all eight sections at ${width}px`,
  `Settings scroll tracking marks the section and the final section at ${width}px`,
  `request badge reads the selected tab at ${width}px`,
  `Changes and Notes pills render server empty state and no-vault action at ${width}px`,
  `Pack C Changes target list finds every mockup row and status at ${width}px`,
  `Pack C Changes rows match Branch, Last commit, Remote and Not committed at ${width}px`,
  `Pack C Notes target list finds the heading, rows and no-vault state at ${width}px`,
  `Pack C composer target list finds Attach and the permission pill at ${width}px`,
  `Pack C composer puts Attach before the permission pill at ${width}px`,
  `Pack C AI tool target list finds every right-column install detail at ${width}px`,
  `Pack C Gemini Install stays right-aligned with its real npm argv at ${width}px`,
  `Pack C Needs you request target list finds incoming and sent card parts at ${width}px`,
  `Pack C Needs you separates pending, answered and sent requests with the handoff button at ${width}px`,
  `Pack C permission picker target list finds all approved modes at ${width}px`,
  `Pack C permission picker matches approved labels and descriptions at ${width}px`,
  `Gemini stays install-only, unknown sign-in stays unknown, and unconfirmed Install sends nothing at ${width}px`,
  `Gemini Install at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `CLI login at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `GitHub connect at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `Notes vault save at ${width}px sends its exact request, shows that id's done status, restores focus, and re-enables`,
  `Default project folder save at ${width}px sends its exact request, shows that id's done status, restores focus, and re-enables`,
  `Folders keep each tab's Browse and the new-project default at ${width}px`,
  `MCP add at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `MCP remove at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `Plugin install at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `Plugin remove at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `Skills and MCP controls respect Gemini/OpenCode limits and validate names and endpoints at ${width}px`,
  `Obsidian opens only the encoded server vault path at ${width}px`,
  `Obsidian and folder pickers hide without the Electron bridge at ${width}px`,
  `Requests send fresh cross-project protocol ids and show refusal at ${width}px`,
  `Requests waiting, accept, decline, destination-removed and per-id refusal render at ${width}px`,
  `Needs you returns focus to its opener at ${width}px`,
  `Per-tab permission picker shows all modes, saved state, confirmation and status at ${width}px`,
  `Seat picture uploads with an id, applies its server route and restores focus at ${width}px`,
  `Approval screenshots use only the selected tab transcript at ${width}px`,
  `chat waits for an in-flight non-image file read before sending at ${width}px`,
  `non-image attachment uploads, waits, sends files and renders a transcript chip at ${width}px`,
];
const packCFileUndoChecks = (): string[] => ["tab", "project", "process"].flatMap((kind) => ["read-before-undo", "read-after-undo"].flatMap((order) => [
  `file attachment packc-undo-${kind}-${order}.md completes in ${order} around ${kind} Undo`,
  `completed file attachment packc-undo-${kind}-${order}.md releases and does not duplicate`,
]));

// Fix pack 3: page behaviour that had no test (runPackThree in browser-harness.js), one named check each.
const PACK3_CHECKS: string[] = [
  "the fake clock's ids are never the positive integers real timers use, clearing a real timer leaves a fake one alone, and a fake id never reaches the real clearTimeout after restore",
  "Needs you offers Release all N for a seat with several unconfirmed stops, refuses a wrong phrase, and sends one releaseUnconfirmedSeat with the typed phrase",
  "a failed Save shows a Retry save card in Needs you; its button closes Needs you and sends save for that tab, and the card is gone once the save lands",
  "a stalled run's card has a Stop this run button that sends killRun for that run only",
  "the Advisor picker sends setAdvisor with the chosen model, and null for Off",
  "the seat card's pencil renames the seat: Enter sends updateSeat with the new name, Escape sends nothing",
  "a working crew seat's Model row, open picker and Settings button lock with Locked while working, the leader never locks, and they unlock when the run ends",
  "an open picker, seat card and Settings unlock when the run ends, searching a locked picker keeps its models locked, focus stays inside the surface when its control locks, and an unconfirmed stop locks the seat until released",
  "Escape on a Settings model picker whose chip locked meanwhile puts focus in the Settings dialog on an enabled control, never the page body",
  "Settings New tabs Browse sends changeProjectFolder for the shown project with the picked folder",
  "the marketing maker radios choose who fixes the round: a pick sends selectMarketingMaker once, the checked one follows the server, and picking the checked one sends nothing",
  "the Details width grip drags the panel (clamped 280 to 560), saves the width once on release, and the arrow keys move it by 16",
  "Match my PC follows the PC's light or dark setting, saves theme system, and keeps following it",
  "a capped saved run offers Load the fuller log, asks for the full log once, and labels the fuller reply",
  "the Copy button copies the install command and says so, and falls back to a hidden text copy when the clipboard refuses",
  "Enter sends the message, but not while an input method is composing or with Shift held",
  "the empty chat's suggestion chips send their own text, and cannot be pressed while a Save is waiting for its answer",
  "Retry now on the Disconnected banner opens a new connection at once",
  "the screenshot viewer's Prev, Next and Fit buttons step through the pictures, disable at the ends and toggle the size",
  "live output appends to the open run's log, follows the end, stays put when the reader scrolled up, and Jump to latest returns to the end",
  "the seat card's Watch on a run opens that run in the work view",
  "Allow again in the Run dialog asks for the typed phrase, then sends unblockSeat; cancelling sends nothing",
  "the first-project screen's New project opens the project dialog and each Set up opens Settings on AI tools",
  "Rename tab in the tab menu sends renameTab with the new name",
  "Acknowledge all sends ackLaunchNotices for the finished launch records only",
];

function defaults(kind: ProcessKind, process: ProcessId) {
  return getProcessDefinition(kind, process).seats.map((seat) => ({
    slot: seat.slotId,
    name: seat.defaultName,
    cli: seat.cli,
    model: seat.model,
    effort: seat.effort,
  }));
}

function workspaces(root: string) {
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

function waitServer(proc: ReturnType<typeof spawn>, timeoutMs = 15_000): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let output = "";
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

async function stopServer(proc: ReturnType<typeof spawn>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, "exit");
  proc.kill();
  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`server ${proc.pid} did not exit`)), 7000); })]);
  if (timeout) clearTimeout(timeout);
  assert.ok(result, `server process ${proc.pid} exited after SIGTERM`);
}

async function getServerState(port: number): Promise<any> {
  const origin = `http://${HOST}:${port}`;
  return new Promise((resolveState, reject) => {
    const ws = new WebSocket(keyedWsUrl(`ws://${HOST}:${port}`, APP_KEY), { origin });
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

function fakeParallelState(state: any) {
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
    launchedByLeader: false,
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

function proxyServer(backendPort: number, options: { folder: string; mode: string; seed?: any; storageBlocked?: boolean; windowButtons?: boolean; oldMe?: { saved: string; expected: string } }, auditScript: string) {
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
function shutProxy(p: ReturnType<typeof proxyServer>) {
  p.wss.close(); p.proxy.close();
  assert.deepEqual(p.refusedChats, [], "a real-server audit tried to send a chat, which would start a real leader");
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, HOST, resolveListen); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

// Chrome starts helper processes of its own, and proc.kill() ends only the one this test spawned: kill the tree under that pid (never anything else).
function killTree(proc: ReturnType<typeof spawn>) {
  if (proc.pid && proc.exitCode === null && proc.signalCode === null) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15_000 });
  proc.kill();
}

function chromeAudit(args: { port: number; mode: string; folder: string; width: number; profile: string; caseName?: string; collect?: boolean; virtualMs: number; capMs?: number; capStartsAfter?: Promise<unknown>; chrome?: { exe: string; args: string[] } }): Promise<any> {
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
    let stdout = ""; let stderr = ""; let timedOut = false; const startedAt = Date.now();
    proc.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    // The real-time cap sits well above the virtual-time budget; a hung Chrome still ends here, and the wall time of every run is printed so its headroom is visible.
    const capMs = args.capMs ?? Number(process.env.CC_CHROME_TIMEOUT_MS ?? args.virtualMs + CHROME_CAP_HEADROOM_MS);
    // args.capStartsAfter (a test of the cap) holds the cap back until its workload has really started, so a busy PC's slow start-up is not
    // counted against the cap; that wait is bounded by the test, and a workload that never started kills Chrome and rejects with its reason.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { if (proc.exitCode === null && proc.signalCode === null) timer = setTimeout(() => { timedOut = true; killTree(proc); }, capMs); };
    if (args.capStartsAfter) args.capStartsAfter.then(arm, (error) => { killTree(proc); rejectAudit(error); });
    else arm();
    proc.once("error", (error) => { clearTimeout(timer); rejectAudit(new Error(`Chrome launch failed: ${error.message}; stderr=${stderr.slice(-1500)}`)); });
    proc.once("close", (status, signal) => {
      clearTimeout(timer);
      console.log(`Chrome audit ${args.caseName ?? args.mode} at ${args.width}px took ${Date.now() - startedAt} ms of its ${capMs} ms cap`);
      if (timedOut) { rejectAudit(new Error(`Chrome exceeded ${capMs}ms and exited after termination; stderr=${stderr.slice(-1500)}`)); return; }
      if (status !== 0) { rejectAudit(new Error(`Chrome exited with ${status} (${signal}); stderr=${stderr.slice(-1000)}; stdout=${stdout.slice(-1000)}`)); return; }
      const match = /<pre id="AUDIT"[^>]*>([\s\S]*?)<\/pre>/.exec(stdout);
      if (!match) { rejectAudit(new Error(`Chrome dump omitted #AUDIT; output tail=${stdout.slice(-2000)}`)); return; }
      try { resolveAudit(JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"))); }
      catch (error) { rejectAudit(new Error(`Could not parse Chrome #AUDIT JSON: ${String(error)}; matched=${match[1].slice(0, 2000)}`)); }
    });
  });
}

async function chromeDialogAudit(args: { port: number; folder: string; width: number; profile: string; approvals?: boolean; seatPointer?: boolean }) {
  const query = new URLSearchParams({ mode: "fake", folder: args.folder, case: "dialog-close" });
  const url = `http://${HOST}:${args.port}/__audit?${query}`;
  mkdirSync(args.profile, { recursive: true });
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--window-size=${args.width + 16},1000`,
    `--user-data-dir=${args.profile}`, "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--disable-gpu-sandbox", "--use-gl=swiftshader", "--disable-dev-shm-usage",
    "--disable-background-networking", "--no-proxy-server", "--hide-scrollbars", "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  let socket: WebSocket | null = null;
  let sequence = 0;
  const pending = new Map<number, { resolve: (message: any) => void; reject: (error: Error) => void }>();
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error(`Chrome DevTools socket is not open for ${method}`)); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome DevTools command timed out: ${method}`)); }, 10_000);
    pending.set(id, {
      resolve(message) { clearTimeout(timer); resolve(message); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  try {
    const activePortFile = join(args.profile, "DevToolsActivePort");
    const portDeadline = Date.now() + 15_000;
    while (!existsSync(activePortFile) && Date.now() < portDeadline && proc.exitCode === null && proc.signalCode === null) await delay(50);
    assert.ok(existsSync(activePortFile), `Chrome PID ${proc.pid} opened DevTools; stderr=${stderr.slice(-1200)}`);
    // Chrome may still hold the file (EBUSY) or have written only part of it: read again until the whole first line is there, within the same deadline.
    let devtoolsPort = 0;
    while (!devtoolsPort && Date.now() < portDeadline) {
      try { devtoolsPort = Number(/^(\d+)\r?\n/.exec(readFileSync(activePortFile, "utf8"))?.[1] ?? 0); } catch { /* locked: retried */ }
      if (!devtoolsPort) await delay(50);
    }
    assert.ok(devtoolsPort > 0, `Chrome wrote a DevTools port to ${activePortFile} before the deadline`);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, `Chrome DevTools port was recorded: ${devtoolsPort}`);
    const version = await fetch(`http://${HOST}:${devtoolsPort}/json/version`).then((response) => response.json()) as { webSocketDebuggerUrl?: string };
    assert.ok(version.webSocketDebuggerUrl, `Chrome exposed its DevTools websocket: ${JSON.stringify(version)}`);
    socket = new WebSocket(version.webSocketDebuggerUrl);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id || !pending.has(message.id)) return;
      const waiting = pending.get(message.id)!; pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiting.resolve(message);
    });
    socket.on("close", () => { for (const [id, waiting] of pending) { pending.delete(id); waiting.reject(new Error("Chrome DevTools socket closed")); } });
    socket.on("error", (error) => { for (const [id, waiting] of pending) { pending.delete(id); waiting.reject(error); } });
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });

    const created = await send("Target.createTarget", { url: "about:blank" });
    const targetId = created.result?.targetId;
    assert.ok(targetId, `Chrome created a page target: ${JSON.stringify(created)}`);
    const attached = await send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.result?.sessionId;
    assert.ok(sessionId, `Chrome attached the page target: ${JSON.stringify(attached)}`);
    const sendPage = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
    const evaluate = async (expression: string) => {
      const response = await sendPage("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.result?.exceptionDetails) throw new Error(`Browser expression failed: ${response.result.exceptionDetails.text ?? JSON.stringify(response.result.exceptionDetails)}`);
      return response.result?.result?.value;
    };
    const waitForPage = async (expression: string, label: string, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && proc.exitCode === null && proc.signalCode === null) {
        try { const value = await evaluate(expression); if (value) return value; } catch {}
        await delay(50);
      }
      throw new Error(`Chrome dialog audit timed out waiting for ${label}; stderr=${stderr.slice(-1200)}`);
    };
    await sendPage("Page.enable");
    await sendPage("Runtime.enable");
    await sendPage("Emulation.setDeviceMetricsOverride", { width: args.width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sendPage("Page.navigate", { url });
    await waitForPage("window.__ccDialogAuditReady === true", "fake app state");
    const actualWidth = await evaluate("innerWidth");
    assert.equal(actualWidth, args.width, `Chrome viewport is ${args.width}px`);

    if (args.seatPointer) {
      // Real pointer input (press, then release, like a person): the card closes on pointerdown, and the press must still become a click.
      const point = (selector: string) => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
      const realClick = async (selector: string) => {
        const where = await point(selector);
        await sendPage("Input.dispatchMouseEvent", { type: "mouseMoved", ...where });
        await sendPage("Input.dispatchMouseEvent", { type: "mousePressed", ...where, button: "left", clickCount: 1 });
        await sendPage("Input.dispatchMouseEvent", { type: "mouseReleased", ...where, button: "left", clickCount: 1 });
      };
      const name = (slot: string) => `#crew [data-seat-id="${slot}"] [data-seat-open]`;
      const pic = (slot: string) => `#crew [data-seat-id="${slot}"] [data-seat-pic]`;
      await evaluate('(()=>{const b=document.querySelector("#view [data-back-chat], #view [data-chat-live]");if(b)b.click();return true})()');
      const workers: string[] = await evaluate('[...document.querySelectorAll("#crew .seat")].map((row)=>row.dataset.seatId).filter((slot)=>slot!=="leader")');
      assert.ok(workers.length >= 2 && workers.includes("coder"), `the rail has workers: ${workers}`);
      // The card opens below its picture and covers the rows under it: open the LAST worker's card, then press a worker row above it.
      const lower = workers.at(-1)!, upper = workers[0];
      await evaluate(`document.querySelector(${JSON.stringify(pic(lower))}).click();true`);
      assert.equal(await evaluate(`!document.getElementById("seatPop").hidden && document.getElementById("seatPop").dataset.slot===${JSON.stringify(lower)}`), true, "the lower worker's card is open");
      await realClick(name(upper));
      assert.deepEqual(await evaluate(`({viewing:document.querySelector(${JSON.stringify(name(upper))}).hasAttribute("aria-current"),head:Boolean(document.querySelector("#stagehead.wv")),cardHidden:document.getElementById("seatPop").hidden,expanded:[...document.querySelectorAll("#crew [aria-expanded]")].filter((b)=>b.getAttribute("aria-expanded")==="true").length})`), { viewing: true, head: true, cardHidden: true, expanded: 0 }, "a real click on a worker's name while a card is open opens its work view");
      // The same press on the leader's name (the top row) while a worker's view is showing and a card is open below it.
      await evaluate(`document.querySelector(${JSON.stringify(pic(lower))}).click();true`);
      assert.equal(await evaluate(`!document.getElementById("seatPop").hidden && document.getElementById("seatPop").dataset.slot===${JSON.stringify(lower)}`), true, "a card is open over a worker's view");
      await realClick(name("leader"));
      assert.deepEqual(await evaluate(`({workView:Boolean(document.querySelector("#stagehead.wv")),upperViewing:document.querySelector(${JSON.stringify(name(upper))}).hasAttribute("aria-current"),cardHidden:document.getElementById("seatPop").hidden})`), { workView: false, upperViewing: false, cardHidden: true }, "a real click on the leader's name while a worker's view shows returns to the chat");
      // Pictures with the real pointer: open from one, retarget to another seat's picture, Escape, press the same picture to close, and the viewed seat keeps its highlight.
      const card = (slot: string) => `({open:!document.getElementById("seatPop").hidden,slot:document.getElementById("seatPop").dataset.slot,expanded:[...document.querySelectorAll("#crew [data-seat-pic][aria-expanded='true']")].map((b)=>b.dataset.seatPic),focus:document.activeElement?.dataset?.seatPic??null,want:${JSON.stringify(slot)}})`;
      await realClick(pic(upper));
      const opened = await evaluate(card(upper));
      assert.deepEqual({ open: opened.open, slot: opened.slot, expanded: opened.expanded }, { open: true, slot: upper, expanded: [upper] }, "a real click on a picture opens that seat's card");
      await realClick(pic(lower));
      const retargeted = await evaluate(card(lower));
      assert.deepEqual({ open: retargeted.open, slot: retargeted.slot, expanded: retargeted.expanded }, { open: true, slot: lower, expanded: [lower] }, "a real click on another seat's picture switches the open card to that seat");
      const escape = async (type: string) => sendPage("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await escape("keyDown"); await escape("keyUp");
      assert.deepEqual(await evaluate(`({hidden:document.getElementById("seatPop").hidden,focus:document.activeElement?.dataset?.seatPic??null,expanded:document.querySelectorAll("#crew [aria-expanded='true']").length})`), { hidden: true, focus: lower, expanded: 0 }, "Escape closes the card and returns focus to the picture it was last opened from");
      await realClick(pic(lower));
      assert.equal(await evaluate('!document.getElementById("seatPop").hidden'), true, "the picture opens the card again");
      await realClick(pic(lower));
      assert.deepEqual(await evaluate(`({hidden:document.getElementById("seatPop").hidden,expanded:document.querySelectorAll("#crew [aria-expanded='true']").length})`), { hidden: true, expanded: 0 }, "pressing the same picture again closes the card");
      await realClick(name(upper));
      await realClick(pic(lower)); await realClick(pic(lower));
      assert.deepEqual(await evaluate(`({hidden:document.getElementById("seatPop").hidden,upperOn:document.querySelector('#crew [data-seat-id="${upper}"]').classList.contains("on"),lowerOn:document.querySelector('#crew [data-seat-id="${lower}"]').classList.contains("on")})`), { hidden: true, upperOn: true, lowerOn: false }, "after the card closes, the seat whose work is showing keeps its highlight");
      // Picture -> Model -> Escape with the real keyboard: opening the card redraws the crew, and focus still lands on the visible picture. Back -> Escape too.
      const visibleFocus = (slot: string) => evaluate(`(()=>{const a=document.activeElement,r=a?.getClientRects?.().length>0&&!a.closest("[hidden],[inert]");return {pic:a?.dataset?.seatPic??null,visible:Boolean(r),want:${JSON.stringify(slot)}}})()`);
      await realClick(pic(lower));
      await evaluate(`document.querySelector('#seatPop [data-seat-model]').click();true`);
      assert.equal(await evaluate('!document.getElementById("pop").hidden && document.getElementById("seatPop").hidden'), true, "Model opens the picker in place of the card");
      await escape("keyDown"); await escape("keyUp");
      assert.deepEqual(await visibleFocus(lower), { pic: lower, visible: true, want: lower }, "Picture, Model, Escape: focus returns to the seat's visible picture");
      await realClick(pic(lower));
      await evaluate(`document.querySelector('#seatPop [data-seat-model]').click();true`);
      await evaluate(`document.querySelector('#pop [data-pop-back]').click();true`);
      assert.equal(await evaluate('!document.getElementById("seatPop").hidden'), true, "Back returns to the card");
      await escape("keyDown"); await escape("keyUp");
      assert.deepEqual(await visibleFocus(lower), { pic: lower, visible: true, want: lower }, "Picture, Model, Back, Escape: focus is on the visible picture");
      // A state broadcast redraws the open card: keyboard focus on Watch stays on Watch.
      await realClick(pic(lower));
      await evaluate(`document.querySelector('#seatPop [data-seat-watch]').focus();true`);
      await evaluate(`(()=>{const s=structuredClone(window.__ccSeed);window.__ccDeliver({...s,type:"state"});return true})()`);
      assert.equal(await evaluate(`document.activeElement?.hasAttribute("data-seat-watch") && !document.getElementById("seatPop").hidden`), true, "focus on Watch survives a broadcast");
      await escape("keyDown"); await escape("keyUp");
      // The same control in the work view and in the open card: a broadcast keeps focus in the one that had it.
      await evaluate(`(()=>{const s=window.__ccSeed,t=s.projects.flatMap(p=>p.tabs).find(t=>t.id===s.selectedTabId);const seat=(t.seats??t.crew??[]).find(x=>x.slot==="coder");seat.status="working";s.launchSafety={blocked:[seat.seatKey??t.id+".coder"],uncertain:[],released:[],notices:[]};window.__ccDeliver({...structuredClone(s),type:"state"});document.querySelector(${JSON.stringify(name("coder"))}).click();return true})()`);
      await evaluate(`document.querySelector(${JSON.stringify(pic("coder"))}).click();true`);
      for (const attr of ["data-seat-unblock", "data-run-seat", "data-stop-seat"]) {
        const twins = await evaluate(`({view:document.querySelectorAll("#view ["+${JSON.stringify(attr)}+"]").length,card:document.querySelectorAll("#seatPop ["+${JSON.stringify(attr)}+"]").length})`);
        assert.deepEqual([twins.view > 0, twins.card > 0], [true, true], `${attr} exists in the work view and in the card: ${JSON.stringify(twins)}`);
        for (const place of ["#seatPop", "#view"]) {
          await evaluate(`document.querySelector(${JSON.stringify(`${place} [${attr}]`)}).focus();true`);
          await evaluate(`(()=>{const s=structuredClone(window.__ccSeed);window.__ccDeliver({...s,type:"state"});return true})()`);
          assert.equal(await evaluate(`document.activeElement?.hasAttribute(${JSON.stringify(attr)}) && Boolean(document.activeElement.closest(${JSON.stringify(place)}))`), true, `focus on ${attr} in ${place} stays there after a broadcast`);
        }
      }
      // renderAll's focus restore, driven directly: the focused control is REALLY replaced during the render (renderAll's first lookup, getElementById("first"), swaps it
      // for a clone), then optional decoys are planted just before the restore looks for a twin (the restore's own querySelectorAll call).
      const restore = (o: { target: string; attr: string; moveTo?: string; decoyIn?: string }) => evaluate(`(()=>{
        const o=${JSON.stringify(o)}, key="["+o.attr+"]", target=document.querySelector(o.target);
        target.focus();
        const gid=Document.prototype.getElementById, qsa=Document.prototype.querySelectorAll, planted=[]; let replaced=false, hits=0;
        Document.prototype.getElementById=function(...a){ if(a[0]!=="first") return gid.apply(this,a); Document.prototype.getElementById=gid; target.replaceWith(target.cloneNode(true)); replaced=!target.isConnected; if(o.moveTo) document.querySelector(o.moveTo).focus(); return gid.apply(this,a); };
        Document.prototype.querySelectorAll=function(sel,...r){ if(sel===key&&!planted.length&&o.decoyIn){ Document.prototype.querySelectorAll=qsa; hits++; const d=document.createElement("button"); d.setAttribute(o.attr,""); d.hidden=true; document.querySelector(o.decoyIn).prepend(d); planted.push(d); } return qsa.call(this,sel,...r); };
        try { window.__ccDeliver({...structuredClone(window.__ccSeed),type:"state"}); } finally { Document.prototype.getElementById=gid; Document.prototype.querySelectorAll=qsa; }
        const a=document.activeElement, where=a?.closest("#seatPop")?"seatPop":a?.closest("#view")?"view":a?.id||a?.tagName||"none";
        const out={replaced,where,hasAttr:Boolean(a?.hasAttribute?.(o.attr)),onDecoy:planted.includes(a),planted:planted.length,decoyWanted:Boolean(o.decoyIn)};
        planted.forEach((d)=>d.remove()); return out;
      })()`);
      const attr = "data-stop-seat";
      assert.deepEqual(await restore({ target: `#seatPop [${attr}]`, attr }), { replaced: true, where: "seatPop", hasAttr: true, onDecoy: false, planted: 0, decoyWanted: false }, "same layer: focus lost in the open card comes back to the card's control, not the work view's twin");
      assert.deepEqual(await restore({ target: `#view [${attr}]`, attr }), { replaced: true, where: "view", hasAttr: true, onDecoy: false, planted: 0, decoyWanted: false }, "outside layers: focus lost in the work view comes back to the work view's control, not the open card's twin");
      assert.deepEqual(await restore({ target: `#view [${attr}]`, attr, decoyIn: "body" }), { replaced: true, where: "view", hasAttr: true, onDecoy: false, planted: 1, decoyWanted: true }, "a hidden twin ahead of it in the page is skipped (work view)");
      assert.deepEqual(await restore({ target: `#seatPop [${attr}]`, attr, decoyIn: "#seatPop" }), { replaced: true, where: "seatPop", hasAttr: true, onDecoy: false, planted: 1, decoyWanted: true }, "a hidden twin ahead of it inside the same layer is skipped (card)");
      assert.deepEqual(await restore({ target: `#view [${attr}]`, attr, moveTo: "#railBtn" }), { replaced: true, where: "railBtn", hasAttr: false, onDecoy: false, planted: 0, decoyWanted: false }, "when rendering itself moved focus to another connected control, the restore leaves it there");
      await escape("keyDown"); await escape("keyUp");
      // The collapsed rail: a keyboard user gets the tooltip, and the picture says what the hidden name button said.
      await evaluate(`document.getElementById("railBtn").click();true`);
      assert.equal(await evaluate(`!document.getElementById("stage").classList.contains("wide")`), true, "the rail is collapsed");
      await sendPage("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await sendPage("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      const collapsed = await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(pic(lower))});b.focus();const row=b.closest(".seat"),fx=row.querySelector(".fx");return {focusVisible:b.matches(":focus-visible"),tip:document.getElementById("tip").classList.contains("on"),tipText:document.getElementById("tip").textContent,tipWant:row.dataset.tip,label:b.getAttribute("aria-label"),role:fx.querySelector(".fr").textContent,status:fx.querySelector(".sl").textContent}})()`);
      assert.equal(collapsed.focusVisible, true, "the picture shows keyboard focus");
      assert.deepEqual([collapsed.tip, collapsed.tipText], [true, collapsed.tipWant], "keyboard focus on a picture in the collapsed rail shows its tooltip");
      assert.ok(collapsed.label.includes(collapsed.role) && collapsed.label.includes(collapsed.status), `the picture's label carries role and status: ${collapsed.label}`);
      return;
    }
    if (args.approvals) {
      const setup = async (ids: string[]) => evaluate(`(()=>{
        window.__ccApprovalReply="ok";
        const s=window.__ccSeed,t=s.projects.flatMap(p=>p.tabs).find(t=>t.id===s.selectedTabId);
        t.pendingApprovals=${JSON.stringify(ids)}.map((approvalId,i)=>({approvalId,tool:"Write",summary:approvalId,createdAt:i}));
        window.__ccDeliver({...structuredClone(s),type:"state"});return true;
      })()`);
      const sent = () => evaluate('window.__sent.filter(m=>m.type==="answerApproval").map(m=>m.approvalId)');
      const settled = () => waitForPage('!document.querySelector("#approvalAllow").disabled', "approval settled", 2000);
      // Reset between probes by really releasing every key and pointer the probes press; window blur has its own dedicated test below.
      const releaseHolds = async () => { await evaluate('(()=>{for(const id of [0,1,2,71,81,91])document.dispatchEvent(new PointerEvent("pointerup",{pointerId:id,bubbles:true}));for(const k of [{key:" ",code:"Space"},{key:" "},{key:"Enter",code:"Enter"}])document.dispatchEvent(new KeyboardEvent("keyup",{...k,bubbles:true}));return true})()'); await delay(30); };
      const mouse = async (type: string, clickCount = 1) => {
        const point = await evaluate('(()=>{const r=document.querySelector("#approvalAllow").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
        await sendPage("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount });
      };
      const key = (type: string, name = " ", repeat = false) => sendPage("Input.dispatchKeyEvent", { type, key: name, code: name === " " ? "Space" : "Enter", windowsVirtualKeyCode: name === " " ? 32 : 13, nativeVirtualKeyCode: name === " " ? 32 : 13, autoRepeat: repeat });
      await setup([]);
      await setup(["first"]);
      assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled && document.querySelector("#approvalDeny").disabled'), true, "first appearance disables both approval buttons");
      // The settle window is APPROVAL_SETTLE_MS = 400 on performance.now(). A real-time delay near that edge flakes on a slow PC, so the page's clock is held still and moved by hand:
      // 250 ms in, the same approval is broadcast again (a restart would end at 650 ms), and at 400 ms the buttons must be live. The real clock goes back before the next probe.
      await evaluate('(()=>{const real=performance.now.bind(performance);window.__ccRealPerf=real;window.__ccPerf=real();performance.now=()=>window.__ccPerf;return true})()');
      try {
        await setup([]); await setup(["first-held"]);
        assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled'), true, "a new approval starts disabled on the held clock");
        await evaluate("window.__ccPerf+=250;true"); await setup(["first-held"]);
        assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled'), true, "250 ms in, the buttons are still settling");
        await evaluate("window.__ccPerf+=149;true"); await setup(["first-held"]);
        assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled'), true, "399 ms in, the last millisecond is still settling");
        await evaluate("window.__ccPerf+=1;true"); await setup(["first-held"]);
        assert.equal(await evaluate('!document.querySelector("#approvalAllow").disabled'), true, "same-id broadcast does not restart settle: live 400 ms after the first appearance");
      } finally { await evaluate("performance.now=window.__ccRealPerf;true"); }
      await setup([]); await delay(1700); await setup(["idle"]);
      assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled'), true, "appearance after idle starts settle"); await settled();

      // Native double-click, plus a press held on A until well after B settles.
      for (const interval of [30, 450, 1000]) {
        await setup([]); await setup([`native-A-${interval}`, `native-B-${interval}`]); await settled();
        const before = (await sent()).length;
        await mouse("mousePressed"); await mouse("mouseReleased");
        await delay(interval); await mouse("mousePressed", 2); await mouse("mouseReleased", 2);
        assert.deepEqual((await sent()).slice(before), [`native-A-${interval}`], `native double-click ${interval}ms answers only A`);
        await setup([]); await setup([`press-A-${interval}`]); await settled();
        const pressBefore = (await sent()).length;
        await mouse("mousePressed"); await setup([`press-B-${interval}`]); await delay(Math.max(450, interval)); await mouse("mouseReleased");
        assert.deepEqual((await sent()).slice(pressBefore), [], `native press started on A cannot answer B after ${interval}ms`);
      }
      await setup([]); await setup(["early-A"]);
      const earlyBefore = (await sent()).length;
      await mouse("mousePressed"); await settled(); await mouse("mouseReleased");
      assert.deepEqual((await sent()).slice(earlyBefore), [], "native pointer-down before settle cannot activate after settle");
      // Chrome suppresses activation of a press on a disabled button. Force the delayed click separately
      // so deleting the listener's settle check still goes RED, independent of that browser behavior.
      await delay(50); await setup([]); await setup(["early-listener"]);
      await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));true');
      await settled();
      await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:1}));true');
      assert.deepEqual((await sent()).slice(earlyBefore), [], "pointer listener rejects delayed activation from before settle");
      for (const name of [" ", "Enter"]) {
        await setup([]); await setup(["held-A"]); await settled();
        await evaluate('document.querySelector("#approvalAllow").focus();true');
        const before = (await sent()).length;
        await key("keyDown", name); await delay(1700); await setup(["held-B"]); await settled();
        await key("keyUp", name);
        assert.equal((await sent()).slice(before).includes("held-B"), false, `native held ${name === " " ? "Space" : "Enter"} cannot answer replacement B`);
        await evaluate('document.querySelector("#approvalAllow").focus();true');
        await key("keyDown", name); await key("keyUp", name);
        assert.equal((await sent()).at(-1), "held-B", "fresh keyboard press answers settled B");
        // Keep forced activation and repeat controls separate from the native hold/replace/release probe.
        const suffix = name === " " ? "space" : "enter";
        await setup([]); await setup(["control-A-" + suffix]); await settled();
        await evaluate('document.querySelector("#approvalAllow").focus();true');
        const controlBefore = (await sent()).length;
        await key("keyDown", name); await setup(["control-B-" + suffix]); await settled();
        await key("keyDown", name, true);
        assert.equal((await sent()).slice(controlBefore).includes("control-B-" + suffix), false, "native repeat cannot answer a replacement");
        await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
        assert.equal((await sent()).slice(controlBefore).includes("control-B-" + suffix), false, "delayed keyboard activation remains bound to key-down ID");
        await key("keyUp", name);
      }
      // A repeat key-down that reaches the panel (synthetic, so focus loss on a disabled button cannot hide it) must not re-bind the press to B.
      await setup([]); await setup(["repeat-A"]); await settled();
      const repeatBefore = (await sent()).length;
      await evaluate('document.querySelector("#approvalAllow").focus();true');
      await key("keyDown", " "); await setup(["repeat-B"]); await settled();
      await evaluate('document.querySelector("#approvalPanel").dispatchEvent(new KeyboardEvent("keydown",{key:" ",repeat:true,bubbles:true}));true');
      await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
      assert.equal((await sent()).slice(repeatBefore).includes("repeat-B"), false, "a repeat key-down reaching the panel never re-binds the press to B");
      await key("keyUp", " ");
      // Rejected activations cannot consume a press that is still held, including presses outside the panel.
      for (const kind of ["keyboard", "pointer", "outside-key", "outside-pointer"]) {
        await releaseHolds();
        await setup([]); await setup([kind + "-held-A"]); await settled();
        const before = (await sent()).length;
        const outside = kind.startsWith("outside");
        const pointer = kind.includes("pointer");
        if (!outside) { if (pointer) await mouse("mousePressed"); else { await evaluate('document.querySelector("#approvalAllow").focus();true'); await key("keyDown", " "); } }
        else await evaluate('(()=>{const b=document.querySelector(' + JSON.stringify(outside ? "#setBtn" : "#approvalAllow") + ');if(!b)throw Error("missing held-input target");b.dispatchEvent(new ' + (pointer ? 'PointerEvent("pointerdown",{pointerId:71,bubbles:true})' : 'KeyboardEvent("keydown",{key:" ",bubbles:true})') + ');return true})()');
        await setup([kind + "-held-B"]); await settled();
        await evaluate('document.querySelector("#approvalAllow").click();document.querySelector("#approvalAllow").click();true');
        assert.deepEqual((await sent()).slice(before), [], kind + " repeated press-less clicks answer nothing while held");
        if (!outside) { if (pointer) await mouse("mouseReleased"); else await key("keyUp", " "); }
        else await evaluate('document.dispatchEvent(new ' + (pointer ? 'PointerEvent("pointerup",{pointerId:71,bubbles:true})' : 'KeyboardEvent("keyup",{key:" ",bubbles:true})') + ');true'); await delay(30);
        await evaluate('document.querySelector("#approvalAllow").click();true');
        assert.deepEqual((await sent()).slice(before), [kind + "-held-B"], kind + " release allows a genuine press-less click");
      }
      for (const pointer of [false, true]) {
        await releaseHolds();
        await setup([]);await setup(["release-record-A"]);await settled();
        const before=(await sent()).length;
        await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new '+(pointer?'PointerEvent("pointerdown",{bubbles:true})':'KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true})')+');true');
        await setup(["release-record-B"]);await settled();
        if (!pointer) { await evaluate('document.dispatchEvent(new KeyboardEvent("keyup",{key:" ",code:"OtherSpace",bubbles:true}));true'); await delay(30); }
        await evaluate('document.querySelector("#approvalAllow").click();document.dispatchEvent(new '+(pointer?'PointerEvent("pointerup",{bubbles:true})':'KeyboardEvent("keyup",{key:" ",code:"Space",bubbles:true})')+');document.querySelector("#approvalAllow").click();true');
        assert.deepEqual((await sent()).slice(before),[],(pointer?"pointer":"key")+" release activation remains bound after a rejected click");
        await delay(30);await evaluate('document.querySelector("#approvalAllow").click();true');
        assert.deepEqual((await sent()).slice(before),["release-record-B"],"released record is cleared before a genuine later activation");
      }
      // Screen reader or voice control: a click with no key or pointer press before it answers the shown, settled approval.
      await setup([]); await setup(["reader-A"]); await settled();
      const readerBefore = (await sent()).length;
      await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
      assert.deepEqual((await sent()).slice(readerBefore), ["reader-A"], "press-less click answers the settled shown approval");
      // ...but never while a pointer press that began on another approval is still down.
      await setup([]); await setup(["reader-pA"]); await settled();
      const readerPointerBefore = (await sent()).length;
      await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));true');
      await setup(["reader-pB"]); await settled();
      await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
      assert.deepEqual((await sent()).slice(readerPointerBefore), [], "press-less click is rejected while a pointer press for another approval is down");
      // A cancelled pointer (a finger that turned into a scroll) sends pointercancel and no pointerup; it must release the hold so a later screen-reader click answers.
      for (const onButton of [false, true]) {
        await releaseHolds();
        await setup([]); await setup(["cancel-" + onButton + "-A"]); await settled();
        const cancelBefore = (await sent()).length;
        await evaluate('document.querySelector(' + JSON.stringify(onButton ? "#approvalAllow" : "#setBtn") + ').dispatchEvent(new PointerEvent("pointerdown",{pointerId:81,bubbles:true}));true');
        await setup(["cancel-" + onButton + "-B"]); await settled();
        await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
        assert.deepEqual((await sent()).slice(cancelBefore), [], "a press-less click is rejected while the pointer is still held");
        await evaluate('document.dispatchEvent(new PointerEvent("pointercancel",{pointerId:81,bubbles:true}));true');
        await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
        assert.deepEqual((await sent()).slice(cancelBefore), ["cancel-" + onButton + "-B"], "pointercancel releases the held pointer and its press record so a press-less click answers the shown approval");
      }
      // Losing window focus drops every held key, held pointer and press record (the release may never reach the page).
      for (const pointer of [false, true]) {
        await releaseHolds();
        await setup([]); await setup(["blur-" + pointer + "-A"]); await settled();
        const blurBefore = (await sent()).length;
        await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new ' + (pointer ? 'PointerEvent("pointerdown",{pointerId:91,bubbles:true})' : 'KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true})') + ');true');
        await setup(["blur-" + pointer + "-B"]); await settled();
        await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
        assert.deepEqual((await sent()).slice(blurBefore), [], "a press-less click is rejected while the input is still held");
        await evaluate('window.dispatchEvent(new Event("blur"));true');
        await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
        assert.deepEqual((await sent()).slice(blurBefore), ["blur-" + pointer + "-B"], "window blur clears the " + (pointer ? "pointer" : "key") + " hold and press record so a press-less click answers");
      }
      // A deliberate multi-click on a settled approval answers nothing and says why; a single click then answers and clears the message.
      await setup([]); await setup(["multi-A"]); await settled();
      const multiBefore = (await sent()).length;
      await evaluate('(()=>{const b=document.querySelector("#approvalAllow");b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));b.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:2}));return true})()');
      assert.deepEqual((await sent()).slice(multiBefore), [], "multi-click on a settled approval answers nothing");
      assert.equal(await evaluate('document.querySelector("#approvalError").textContent'), "Click once to answer.", "multi-click shows why nothing happened");
      await evaluate('(()=>{const b=document.querySelector("#approvalAllow");b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));b.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:1}));return true})()');
      assert.deepEqual((await sent()).slice(multiBefore), ["multi-A"], "a single click then answers");
      // A system clock jump back during the settle must not keep the buttons disabled.
      await setup([]); await setup(["clock-A"]);
      await evaluate('window.__realNow=Date.now;Date.now=()=>window.__realNow()-3600000;true');
      try { await delay(900); assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled'), false, "a backwards clock jump does not keep the approval buttons disabled"); } finally { await evaluate('Date.now=window.__realNow;true'); }
      // Deferred release cleanup cannot erase a new press made in the same event-loop turn.
      for (const kind of ["pointer", "keyboard"]) {
        await setup([]); await setup([kind + "-cleanup"]); await settled();
        const before = (await sent()).length;
        await evaluate('(()=>{const b=document.querySelector("#approvalAllow");' + (kind === "pointer"
          ? 'b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));b.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}));b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));'
          : 'b.dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true}));b.dispatchEvent(new KeyboardEvent("keyup",{key:" ",bubbles:true}));b.dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true}));') + 'return true})()');
        await delay(50);
        await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:' + (kind === "pointer" ? 1 : 0) + '}));true');
        assert.deepEqual((await sent()).slice(before), [kind + "-cleanup"], kind + " release cleanup preserves a newer press");
      }
      // A key press made during the settle stays bound to "no approval": an earlier release's deferred cleanup must not erase it,
      // or the press-less fallback would let a later click answer the approval the press never saw.
      await setup([]); await setup(["settle-key"]);
      const settleKeyBefore = (await sent()).length;
      await evaluate('(()=>{const p=document.querySelector("#approvalPanel"),k=(t)=>p.dispatchEvent(new KeyboardEvent(t,{key:" ",bubbles:true}));k("keydown");k("keyup");k("keydown");return true})()');
      await settled(); await delay(50);
      await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
      assert.deepEqual((await sent()).slice(settleKeyBefore), [], "a key press made during the settle cannot answer after it, even after a release cleanup");
      await evaluate('document.querySelector("#approvalPanel").dispatchEvent(new KeyboardEvent("keyup",{key:" ",bubbles:true}));true'); await delay(20);
      // Two pointers: releasing the old A pointer must neither answer B nor erase B's fresh press.
      await setup([]); await setup(["pointer-A"]); await settled();
      const pointerBefore = (await sent()).length;
      await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerId:1}));true');
      await setup(["pointer-B"]); await settled();
      await evaluate('(()=>{const b=document.querySelector("#approvalAllow");b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerId:2}));b.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,pointerId:1}));b.dispatchEvent(new PointerEvent("click",{bubbles:true,pointerId:1,detail:1}));return true})()');
      await delay(50);
      assert.deepEqual((await sent()).slice(pointerBefore), [], "old pointer cannot consume another pointer's B press");
      await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new PointerEvent("click",{bubbles:true,pointerId:2,detail:1}));true');
      assert.deepEqual((await sent()).slice(pointerBefore), ["pointer-B"], "old pointer-up cannot erase B's fresh pointer press");
      console.log("Pointer identity controls GREEN: synthetic multi-pointer delivery");
      await setup([]);
      console.log("Native approval probes GREEN: first/idle/same-id settle, 30/450/1000ms double-click and stale pointer, pre-settle press, held Space/Enter, fresh keyboard activation");

      const settings = await evaluate(`(()=>{
        const $=id=>document.getElementById(id), find=s=>{const e=document.querySelector(s);if(!e)throw Error("missing target "+s);return e};
        const deliver=s=>window.__ccDeliver({...s,type:"state"});
        const close=()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
        const T=(e,v)=>{e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};
        const open=()=>$("setBtn").click(); close(); open();
        const add=find('[data-settings-add="mcp-claude"]'); if(find('[data-mcp-form="claude"]').hidden)add.click();
        const form=()=>find('[data-mcp-form="claude"]');
        T(form().elements.name,"focused_server");T(form().elements.commandOrUrl,"npx -y server");form().elements.name.focus();form().requestSubmit();if(!$("confirmModal").hidden)$("confirmOk").click();
        const m=window.__sent.filter(m=>m.type==="mcpAdd").at(-1),s=structuredClone(window.__latestState);
        s.requestActions={...s.requestActions,[m.requestId]:{requestId:m.requestId,status:"done",message:"Done"}};deliver(s);
        const mcpCleared=form().elements.name.value==="" && form().elements.commandOrUrl.value==="";
        T($("defaultProjectFolder"),"typed-folder");$("defaultProjectFolder").focus();find('[data-setting-action="folder-save"]').click();
        const f=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1),s2=structuredClone(window.__latestState);
        s2.settings.folders={defaultProjectFolder:"normalized-folder"};s2.requestActions={...s2.requestActions,[f.requestId]:{requestId:f.requestId,status:"done",message:"Done"}};deliver(s2);
        const normalized=$("defaultProjectFolder").value;find('[data-setting-action="folder-save"]').click();const normalizedSent=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1).folder;
        close(); const s3=structuredClone(window.__latestState),again=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1);s3.requestActions={...s3.requestActions,[again.requestId]:{requestId:again.requestId,status:"done",message:"Done"}};s3.settings.folders={defaultProjectFolder:""};deliver(s3);open();$("defaultProjectFolder").focus();
        deliver(structuredClone(window.__latestState)); // an ordinary broadcast uses up the finished save, so the next one meets a field with no recent save
        const s4=structuredClone(window.__latestState);s4.settings.folders={defaultProjectFolder:"new-server-folder"};deliver(s4);
        const refreshed=$("defaultProjectFolder").value;find('[data-setting-action="folder-save"]').click();const refreshedSent=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1).folder;
        return {mcpCleared,normalized,normalizedSent,refreshed,refreshedSent};
      })()`);
      assert.equal(settings.mcpCleared, true, "focused MCP name clears after successful Add");
      assert.equal(settings.normalized, "normalized-folder", "focused saved folder shows normalized server value");
      assert.equal(settings.normalizedSent, "normalized-folder", "Save never resubmits stale focused folder");
      assert.equal(settings.refreshed, "new-server-folder", "untouched focused folder shows newer server value");
      assert.equal(settings.refreshedSent, "new-server-folder", "Save submits refreshed untouched folder");
      await evaluate(`(()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));const s=structuredClone(window.__latestState);s.settings.vault=null;window.__ccDeliver({...s,type:"state"});document.getElementById("setBtn").click();document.querySelector('[data-setting-action="vault-browse"]').click();return true})()`);
      await waitForPage('document.getElementById("vaultPath").value===window.__ccFolderChoice', "vault Browse draft");
      const vault = await evaluate(`(()=>{
        const close=()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));close();document.getElementById("setBtn").click();
        const afterClose=document.getElementById("vaultPath").value,oldControl=document.querySelector('[data-setting-action="vault-toggle"]');
        const s=structuredClone(window.__latestState);s.settings.vault={path:"new-connected-vault"};window.__ccDeliver({...s,type:"state"});
        const path=document.getElementById("vaultPath").value,label=document.querySelector('[data-setting-action="vault-toggle"]').textContent;
        oldControl.dispatchEvent(new MouseEvent("click",{bubbles:true}));
        // No typing or Browse: this field must keep following the server.
        const newer=structuredClone(window.__latestState);newer.settings.vault={path:"newer-connected-vault"};window.__ccDeliver({...newer,type:"state"});
        return {afterClose,path,label,unchangedRefresh:document.getElementById("vaultPath").value,sent:window.__sent.filter(m=>m.type==="setNotesVault")};
      })()`);
      assert.equal(vault.afterClose, "", "closing Settings discards Browse vault draft");
      assert.equal(vault.path, "new-connected-vault", "untouched render does not conceal newly connected vault");
      assert.equal(vault.label, "Disconnect", "newly connected vault is shown as connected, not a stale Connect control");
      assert.equal(vault.unchangedRefresh, "newer-connected-vault", "untouched vault input is not an unsaved draft");
      assert.equal(vault.sent.at(-1)?.path, "new-connected-vault", "stale Connect activation uses the displayed newer vault");
      assert.equal(vault.sent.some((m: any) => m.path === null), false, "stale Connect control never sends setNotesVault path:null over newer vault");
      // The vault save above is done. A later Browse or typed choice must survive every broadcast until it is saved or Settings closes.
      await evaluate(`(()=>{const m=window.__sent.filter(m=>m.type==="setNotesVault").at(-1),s=structuredClone(window.__latestState);
        s.requestActions={...s.requestActions,[m.requestId]:{requestId:m.requestId,status:"done",message:"Done"}};window.__ccDeliver({...s,type:"state"});
        window.__ccFolderChoice="picker-second";document.querySelector('[data-setting-action="vault-browse"]').click();return true})()`);
      await waitForPage('document.getElementById("vaultPath").value==="picker-second"', "second vault Browse draft");
      const second = await evaluate(`(()=>{
        const toggle=()=>document.querySelector('[data-setting-action="vault-toggle"]').textContent;
        // Before any server update: the Browse result alone must already refresh the path and the button.
        const immediate={path:document.getElementById("vaultPathDisplay").textContent,label:toggle()};
        window.__ccDeliver({...structuredClone(window.__latestState),type:"state"});
        const browsed=document.getElementById("vaultPath").value,browsedLabel=toggle();
        const typed=document.getElementById("vaultPath");typed.value="typed-vault";typed.dispatchEvent(new Event("input",{bubbles:true}));
        window.__ccDeliver({...structuredClone(window.__latestState),type:"state"});
        return {immediate,browsed,browsedLabel,typed:document.getElementById("vaultPath").value,typedLabel:toggle()};
      })()`);
      assert.deepEqual(second.immediate, { path: "picker-second", label: "Connect" }, "a Browse result refreshes the vault path and button before any server update");
      assert.equal(second.browsed, "picker-second", "a Browse vault choice survives a broadcast after an earlier vault save finished");
      assert.equal(second.browsedLabel, "Connect", "the Browse choice keeps a Connect button, never flips to Disconnect");
      assert.equal(second.typed, "typed-vault", "a typed vault choice survives a broadcast");
      assert.equal(second.typedLabel, "Connect", "the typed choice keeps a Connect button");
      for (const cli of ["claude", "codex", "opencode", "plugin"]) {
        const result = await evaluate(`(()=>{
          const T=(e,v)=>{e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};const cli=${JSON.stringify(cli)},plugin=cli==="plugin",find=s=>{const e=document.querySelector(s);if(!e)throw Error("missing target "+s);return e};
          const selector=plugin?'[data-plugin-form]':'[data-mcp-form="'+cli+'"]', form=()=>find(selector);
          if(form().hidden)find('[data-settings-add="'+(plugin?'plugins-claude':'mcp-'+cli)+'"]').click();
          T(form().elements.name,"first_name");if(!plugin)T(form().elements.commandOrUrl,"npx -y first-server");form().requestSubmit();if(document.getElementById("confirmModal").hidden===false)document.getElementById("confirmOk").click();
          const type=plugin?"pluginInstall":"mcpAdd",m=window.__sent.filter(m=>m.type===type&&(plugin||m.cli===cli)).at(-1);
          T(form().elements.name,"newer_name");if(!plugin)T(form().elements.commandOrUrl,"https://newer.example/mcp");
          const s=structuredClone(window.__latestState);s.requestActions={...s.requestActions,[m.requestId]:{status:"done",requestId:m.requestId}};window.__ccDeliver({...s,type:"state"});
          const name=form().elements.name.value,command=plugin?null:form().elements.commandOrUrl.value;
          form().requestSubmit();if(document.getElementById("confirmModal").hidden===false)document.getElementById("confirmOk").click();const next=window.__sent.filter(m=>m.type===type&&(plugin||m.cli===cli)).at(-1);
          return {name,command,next};
        })()`);
        assert.equal(result.name,"newer_name", cli + " completed Add preserves newer name");
        assert.equal(result.next.name,"newer_name", cli + " next Add submits newer name");
        if(cli!=="plugin") {
          assert.equal(result.command,"https://newer.example/mcp",cli + " completed Add preserves newer command/url");
          assert.equal(result.next.commandOrUrl,"https://newer.example/mcp",cli + " next Add submits newer command/url");
        }
      }
      const pendingDrafts = await evaluate(`(()=>{
        const $=id=>document.getElementById(id),find=s=>{const e=document.querySelector(s);if(!e)throw Error("missing target "+s);return e};
        const deliver=s=>window.__ccDeliver({...s,type:"state"});
        const T=(e,v)=>{e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};
        T($("defaultProjectFolder"),"folder-one");find('[data-setting-action="folder-save"]').click();
        const f=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1);T($("defaultProjectFolder"),"folder-two");
        const s=structuredClone(window.__latestState);s.settings.folders={defaultProjectFolder:"folder-one"};s.requestActions={...s.requestActions,[f.requestId]:{status:"done",requestId:f.requestId}};deliver(s);
        const folder=$("defaultProjectFolder").value;find('[data-setting-action="folder-save"]').click();const resubmitted=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1).folder;
        const type=value=>{const e=$("vaultPath");e.value=value;e.dispatchEvent(new Event("input",{bubbles:true}))};
        type("save-one");find('[data-setting-action="vault-toggle"]').click();const v1=window.__sent.filter(m=>m.type==="setNotesVault").at(-1);type("newer-choice");
        const s1=structuredClone(window.__latestState);s1.settings.vault={path:"server-one"};s1.requestActions={...s1.requestActions,[v1.requestId]:{status:"done",requestId:v1.requestId}};deliver(s1);const newer=$("vaultPath").value;
        find('[data-setting-action="vault-toggle"]').click();const v2=window.__sent.filter(m=>m.type==="setNotesVault").at(-1);
        const s2=structuredClone(window.__latestState);s2.settings.vault={path:"server-two"};s2.requestActions={...s2.requestActions,[v2.requestId]:{status:"done",requestId:v2.requestId}};deliver(s2);const second=$("vaultPath").value;
        type("newer-choice");deliver(structuredClone(window.__latestState));const forgotten=$("vaultPath").value;
        return {folder,resubmitted,newer,second,forgotten};
      })()`);
      assert.equal(pendingDrafts.folder,"folder-two","a completed folder save must preserve a later edit");
      assert.equal(pendingDrafts.resubmitted,"folder-two","next Save submits the newer folder edit");
      const returnedDraft = await evaluate(`(()=>{
        const input=()=>document.querySelector("#defaultProjectFolder"),save=()=>document.querySelector('[data-setting-action="folder-save"]').click();
        const latest=()=>window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1),deliver=s=>window.__ccDeliver({...s,type:"state"});
        const T=(e,v)=>{e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};const prior=latest(),s=structuredClone(window.__latestState);s.settings.folders={defaultProjectFolder:"folder-two"};s.requestActions={...s.requestActions,[prior.requestId]:{status:"done",requestId:prior.requestId}};deliver(s);
        T(input(),"folder-three");save();const request=latest();T(input(),"folder-two");
        const done=structuredClone(window.__latestState);done.settings.folders={defaultProjectFolder:"folder-three"};done.requestActions={...done.requestActions,[request.requestId]:{status:"done",requestId:request.requestId}};deliver(done);
        const value=input().value;save();return {value,submitted:latest().folder};
      })()`);
      assert.equal(returnedDraft.value,"folder-two","a newer edit back to the prior server value survives completion");
      assert.equal(returnedDraft.submitted,"folder-two","next Save submits an edit back to the prior server value");
      const reopenedSave = await evaluate(`(()=>{
        const request=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1);
        document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));document.querySelector("#setBtn").click();
        const s=structuredClone(window.__latestState);s.settings.folders={defaultProjectFolder:"reopened-saved"};s.requestActions={...s.requestActions,[request.requestId]:{status:"done",requestId:request.requestId}};window.__ccDeliver({...s,type:"state"});
        return document.querySelector("#defaultProjectFolder").value;
      })()`);
      assert.equal(reopenedSave,"reopened-saved","a save completed after Settings reopens does not treat an untouched field as a newer edit");
      // A draft means the user edited the field. A field never touched always shows the server value, whatever a pending save submitted.
      const untouched = await evaluate(`(()=>{
        const $=id=>document.getElementById(id),find=s=>{const e=document.querySelector(s);if(!e)throw Error("missing target "+s);return e};
        const T=(e,v)=>{e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};
        const close=()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})),open=()=>$("setBtn").click();
        const state=(folder,doneId)=>{const s=structuredClone(window.__latestState);s.settings.folders={defaultProjectFolder:folder};if(doneId)s.requestActions={...s.requestActions,[doneId]:{status:"done",requestId:doneId}};window.__ccDeliver({...s,type:"state"})};
        const value=()=>$("defaultProjectFolder").value,save=()=>{find('[data-setting-action="folder-save"]').click();return window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1)};
        const out={};
        close();open();state("srv");out.start=value();
        const f=save();state("srv2");out.mid=value();state("srv",f.requestId);out.done=value();
        state("srv3");out.later=value();const l=save();out.laterSent=l.folder;state("srv3",l.requestId);
        // a typed value the server normalizes: the saved draft is dropped, and the field follows the server again
        T($("defaultProjectFolder"),"typed");const g=save();state("norm",g.requestId);out.normalized=value();
        state("norm2");out.followsServer=value();
        // the finished save is forgotten: typing the same text again is a new edit
        T($("defaultProjectFolder"),"typed");state("norm2");out.typedAgain=value();
        // an edit made before Settings was closed is not carried into the next opening
        T($("defaultProjectFolder"),"stale");close();open();state("after-reopen");out.afterReopen=value();
        // a save from before Settings closed cannot clear a draft typed after it reopened
        T($("defaultProjectFolder"),"pre-close");const h=save();close();open();
        T($("defaultProjectFolder"),"pre-close");state("normalized-pre-close",h.requestId);out.preCloseSave=value();
        return out;
      })()`);
      assert.equal(untouched.start, "srv", "the folder field opens on the server value");
      assert.equal(untouched.mid, "srv2", "an untouched field follows a server change while its save is pending");
      assert.equal(untouched.done, "srv", "an untouched field shows the server value when the save completes");
      assert.equal(untouched.later, "srv3", "an untouched field keeps following the server after the save");
      assert.equal(untouched.laterSent, "srv3", "the next Save submits the server value, never a stale one");
      assert.equal(untouched.normalized, "norm", "a saved draft is replaced by the server's normalized value");
      assert.equal(untouched.followsServer, "norm2", "a saved field is no longer an edit and follows the server");
      assert.equal(untouched.typedAgain, "typed", "typing the same text after a finished save is a new edit that survives a broadcast");
      assert.equal(untouched.afterReopen, "after-reopen", "an unsaved edit does not survive closing Settings");
      assert.equal(untouched.preCloseSave, "pre-close", "a save from before Settings closed cannot clear a draft typed after it reopened");
      assert.equal(pendingDrafts.newer,"newer-choice","a completed vault save must preserve a later choice");
      assert.equal(pendingDrafts.second,"server-two","vault submit tracking must clear the second submitted draft");
      assert.equal(pendingDrafts.forgotten,"newer-choice","a completed vault save id must be forgotten before a later identical choice");
      // Round 11: editing back to the old saved value and a delayed picker must remain drafts.
      const vaultReturn = await evaluate(`(()=>{
        const $=id=>document.getElementById(id),close=()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
        const state=(path,done)=>{const s=structuredClone(window.__latestState);s.settings.vault={path};if(done)s.requestActions={...s.requestActions,[done]:{requestId:done,status:"done"}};window.__ccDeliver({...s,type:"state"})};
        close();state("saved-A");$("setBtn").click();
        const type=v=>{const e=$("vaultPath");e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};
        const save=()=>{document.querySelector('[data-setting-action="vault-toggle"]').click();return window.__sent.filter(m=>m.type==="setNotesVault").at(-1)};
        type("submitted-B");const pending=save();type("saved-A");state("submitted-B",pending.requestId);
        const field=$("vaultPath").value,next=save();close();state("saved-A");$("setBtn").click();
        window.__originalPicker=window.cc.pickFolder;window.cc.pickFolder=()=>new Promise(resolve=>window.__resolveVaultPicker=resolve);
        document.querySelector('[data-setting-action="vault-browse"]').click();state("broadcast-B");window.__resolveVaultPicker("saved-A");
        return {field,submitted:next.path};
      })()`);
      await waitForPage('document.getElementById("vaultPath").value==="saved-A"', "delayed vault picker returned A");
      const vaultBrowseReturn = await evaluate(`(()=>{window.__ccDeliver({...structuredClone(window.__latestState),type:"state"});const field=document.getElementById("vaultPath").value;
        window.cc.pickFolder=window.__originalPicker;return field})()`);
      assert.deepEqual({typed:vaultReturn,browse:vaultBrowseReturn}, {typed:{field:"saved-A",submitted:"saved-A"},browse:"saved-A"},
        "vault return-to-A edits survive pending save completion and delayed Browse broadcasts");
      // A failed first vault save re-enables Connect before focus is put back, so the keyboard user keeps their place.
      await evaluate(`(()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));const s=structuredClone(window.__latestState),old=window.__sent.filter(m=>m.type==="setNotesVault").at(-1);s.settings.vault=null;s.requestActions={...s.requestActions,[old.requestId]:{requestId:old.requestId,status:"done"}};window.__ccDeliver({...s,type:"state"});
        document.getElementById("setBtn").click();window.__ccFolderChoice="failed-save-B";document.querySelector('[data-setting-action="vault-browse"]').click();return true})()`);
      await waitForPage('document.getElementById("vaultPath").value==="failed-save-B"', "failed-save vault Browse draft");
      const failedSave = await evaluate(`(()=>{
        const toggle=()=>document.querySelector('[data-setting-action="vault-toggle"]');
        toggle().focus();toggle().click();const m=window.__sent.filter(m=>m.type==="setNotesVault").at(-1);
        const s=structuredClone(window.__latestState);s.requestActions={...s.requestActions,[m.requestId]:{requestId:m.requestId,status:"failed",message:"Could not connect"}};window.__ccDeliver({...s,type:"state"});
        return {sent:m.path,disabled:toggle().disabled,label:toggle().textContent,focused:document.activeElement===toggle(),path:document.getElementById("vaultPath").value};
      })()`);
      assert.deepEqual(failedSave, { sent: "failed-save-B", disabled: false, label: "Connect", focused: true, path: "failed-save-B" },
        "a failed first vault save keeps the draft, re-enables Connect and leaves it focused");
      console.log("Settings lifecycle probes GREEN: focused Add clears, normalized Save, untouched refresh and submission, Browse-close-reopen, newer vault, second Browse and typed choice survive broadcasts");
      return { width: args.width, dialogs: [], chromePid: proc.pid };
    }

    const specs = [
      { id: "inboxPop", label: "Needs you", opener: "#inboxBtn", open: `(()=>{const e=document.querySelector("#inboxBtn");if(!e)return false;e.click();return true})()` },
      { id: "setModal", label: "Settings", opener: "#setBtn", open: `(()=>{const e=document.querySelector("#setBtn");if(!e)return false;e.click();return true})()` },
      { id: "avModal", label: "Avatar", opener: "#meBtn", open: `(()=>{const e=document.querySelector("#meBtn");if(!e)return false;e.click();return true})()` },
      { id: "viewer", label: "Screenshots", opener: "#view [data-open-screenshots]", open: `(()=>{const e=document.querySelector("#view [data-open-screenshots]");if(!e)return false;e.click();return true})()` },
      { id: "modal", label: "Add tab", opener: "#addtab", open: `(()=>{const e=document.querySelector("#addtab");if(!e)return false;e.click();return true})()` },
      { id: "projModal", label: "New project", opener: "#addProj", open: `(()=>{const e=document.querySelector("#addProj");if(!e)return false;e.click();return true})()` },
      { id: "runModal", label: "Run a seat", opener: "#stagehead [data-run-seat]", open: `(()=>{const s=document.querySelector('#crew [data-seat-id="coder"] [data-seat-open]');if(!s)return false;s.click();const e=document.querySelector("#stagehead [data-run-seat]");if(!e)return false;e.click();return true})()` },
    ];
    const expectedIds = specs.map((item) => item.id);
    const foundIds = await evaluate(`(${JSON.stringify(expectedIds)}).filter((id)=>document.querySelector("#"+id)).map((id)=>"#"+id)`);
    assert.deepEqual(foundIds, expectedIds.map((id) => `#${id}`), `every dialog target was found at ${args.width}px: ${JSON.stringify(foundIds)}`);
    console.log(`Dialog targets ${args.width}px: matched ${JSON.stringify(foundIds)}, missing []`);

    const uploadResponse = await fetch(`http://${HOST}:${args.port}/api/paste-image`, {
      method: "POST",
      headers: keyHeaders(APP_KEY, { "Content-Type": "image/png", "X-Request-Id": `dialog-close-${args.width}` }),
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmWQAAAAASUVORK5CYII=", "base64"),
    });
    const uploaded = await uploadResponse.json() as { path?: string; error?: string };
    assert.equal(uploadResponse.status, 200, `temporary screenshot upload succeeded: ${JSON.stringify(uploaded)}`);
    assert.ok(uploaded.path, `temporary screenshot path was returned: ${JSON.stringify(uploaded)}`);
    const screenshotTabId = "alpha-dev";
    await evaluate(`(()=>{const state=structuredClone(window.__latestState);state.selectedTabId=${JSON.stringify(screenshotTabId)};const tab=state.projects.flatMap((project)=>project.tabs).find((item)=>item.id===${JSON.stringify(screenshotTabId)});if(!tab)return false;tab.processState.approval={state:"pending"};tab.processState.currentStepIndex=0;tab.derived.stepBar=[{stepId:"look",state:"current",owners:["user"],label:"Your look"}];window.__ccSeed=structuredClone(state);window.__ccDeliver({...state,type:"state"});window.__ccDeliver({type:"chatHistory",tabId:${JSON.stringify(screenshotTabId)},messages:[{id:"dialog-close-shot",role:"user",text:"Screenshot",images:[${JSON.stringify(uploaded.path)}],at:Date.now()}],revision:1,savedRevision:1});return true})()`);
    await waitForPage(`Boolean(document.querySelector('#view [data-open-screenshots="${screenshotTabId}"]'))`, "screenshot viewer opener");
    const screenshotOpener = `#view [data-open-screenshots="${screenshotTabId}"]`;
    const viewerSpec = specs.find((item) => item.id === "viewer")!;
    viewerSpec.opener = screenshotOpener;
    viewerSpec.open = `(()=>{const e=document.querySelector(${JSON.stringify(screenshotOpener)});if(!e)return false;e.click();return true})()`;

    for (const spec of specs) {
      const opened = await evaluate(spec.open);
      assert.equal(opened, true, `${spec.label} opened through ${spec.opener} at ${args.width}px`);
      await waitForPage(`document.querySelector("#${spec.id}")?.getAttribute("aria-hidden")==="false"`, `${spec.label} open`);
      await delay(300);
      const selector = `#${spec.id}`;
      const evidence = await evaluate(`(()=>{
        const dialog=document.querySelector(${JSON.stringify(selector)});
        if(!dialog)return {found:false};
        const close=dialog.querySelector(".dialog-close");
        const titleNode=${spec.id === "setModal" ? 'dialog.querySelector("#setNav h2")' : 'dialog.querySelector("h2")'};
        const visible=(node)=>!node.hidden&&node.tabIndex>=0&&getComputedStyle(node).display!=="none"&&getComputedStyle(node).visibility!=="hidden";
        const first=[...dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]')].find(visible);
        const describe=(node)=>node?{id:node.id||null,tag:node.tagName.toLowerCase(),className:String(node.className||""),label:node.getAttribute("aria-label"),text:node.textContent.trim().slice(0,36)}:null;
        const rect=(node)=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
        const box=rect(dialog),x=close?rect(close):null,t=titleNode?rect(titleNode):null;
        const topInset=x?x.top-box.top:null,rightInset=x?box.right-x.right:null,leftInset=x?x.left-box.left:null,bottomInset=x?box.bottom-x.bottom:null;
        const outlines=[...document.querySelectorAll("body *")].filter((node)=>node.getClientRects().length&&getComputedStyle(node).outlineStyle!=="none"&&parseFloat(getComputedStyle(node).outlineWidth)>0).map(describe);
        const aligned=x&&t?Math.abs(x.top-t.top)<=4:null;
        return {found:!dialog.hidden,containerFocused:document.activeElement===dialog,active:describe(document.activeElement),activeIsClose:document.activeElement===close,hasCloseX:Boolean(close),close:describe(close),box,x,topInset,rightInset,leftInset,bottomInset,ringInside:x?topInset>=4&&rightInset>=4&&leftInset>=4&&bottomInset>=4:null,evenInset:x?Math.abs(topInset-rightInset)<=2:null,title:describe(titleNode),titleAligned:aligned,first:describe(first),noOutline:outlines.length===0,outlines};
      })()`);
      assert.ok(evidence.found, `${spec.label} dialog was found at ${args.width}px: ${JSON.stringify(evidence)}`);
      assert.ok(evidence.containerFocused, `${spec.label} focused its dialog container at ${args.width}px: ${JSON.stringify(evidence)}`);
      // The simple look keeps one close X, on Settings; every other dialog closes from its own footer button or Escape.
      assert.equal(evidence.hasCloseX, spec.id === "setModal", `${spec.label} close X inventory at ${args.width}px: ${JSON.stringify(evidence)}`);
      assert.ok(evidence.noOutline, `${spec.label} opened without a visible outline at ${args.width}px: ${JSON.stringify(evidence)}`);
      assert.equal(evidence.activeIsClose, false, `${spec.label} did not focus its X on open at ${args.width}px: ${JSON.stringify(evidence)}`);
      if (evidence.hasCloseX) {
        assert.ok(evidence.ringInside, `${spec.label} close X plus 4px fits inside its dialog at ${args.width}px: ${JSON.stringify(evidence)}`);
        if (spec.id === "setModal") {
          assert.ok(Math.abs(evidence.topInset - 8) <= 2, `${spec.label} close X top inset is 8px +-2 at ${args.width}px: ${JSON.stringify(evidence)}`);
        } else {
          assert.ok(evidence.evenInset, `${spec.label} top/right close X insets match within 2px at ${args.width}px: ${JSON.stringify(evidence)}`);
          assert.ok(evidence.titleAligned, `${spec.label} close X aligns with the title row at ${args.width}px: ${JSON.stringify(evidence)}`);
        }
      } else assert.ok(evidence.first, `${spec.label} has a first keyboard control at ${args.width}px: ${JSON.stringify(evidence)}`);
      console.log(`Dialog open ${args.width}px ${spec.label}: ${JSON.stringify(evidence)}`);

      const key = { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
      await sendPage("Input.dispatchKeyEvent", key);
      await sendPage("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
      const tabEvidence = await evaluate(`(()=>{const d=document.querySelector(${JSON.stringify(selector)}),x=d.querySelector(".dialog-close");const first=[...d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]')].find((node)=>!node.hidden&&!node.disabled&&node.tabIndex>=0&&getComputedStyle(node).display!=="none"&&getComputedStyle(node).visibility!=="hidden");const active=document.activeElement,s=getComputedStyle(active);return {active:{id:active.id||null,tag:active.tagName.toLowerCase(),className:String(active.className||""),label:active.getAttribute("aria-label"),text:active.textContent.trim().slice(0,36)},onCloseX:active===x,onFirstControl:active===first,focusVisible:active.matches(":focus-visible"),outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth}})()`);
      assert.ok(tabEvidence.onCloseX || tabEvidence.onFirstControl, `${spec.label} one Tab reached its X or first control at ${args.width}px: ${JSON.stringify(tabEvidence)}`);
      if (evidence.hasCloseX) assert.ok(tabEvidence.onCloseX && tabEvidence.focusVisible, `${spec.label} one Tab focuses its X with the keyboard ring at ${args.width}px: ${JSON.stringify(tabEvidence)}`);
      console.log(`Dialog Tab ${args.width}px ${spec.label}: ${JSON.stringify(tabEvidence)}`);

      const escape = { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      await sendPage("Input.dispatchKeyEvent", escape);
      await sendPage("Input.dispatchKeyEvent", { ...escape, type: "keyUp" });
      const restored = await waitForPage(`(()=>{const d=document.querySelector(${JSON.stringify(selector)}),o=document.querySelector(${JSON.stringify(spec.opener)});return d.hidden&&document.activeElement===o})()`, `${spec.label} Escape close and opener focus`, 3000);
      assert.equal(restored, true, `${spec.label} Escape closes and restores focus to ${spec.opener} at ${args.width}px`);
      console.log(`Dialog Escape ${args.width}px ${spec.label}: closed; focus restored to ${spec.opener}`);
    }
    await evaluate("window.__ccDialogAuditContinue?.(); true");
    return { width: args.width, dialogs: expectedIds.map((id) => `#${id}`), chromePid: proc.pid };
  } finally {
    if (socket?.readyState === WebSocket.OPEN) { try { await send("Browser.close"); } catch {} }
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => proc.once("close", () => resolveExit()));
      const stopped = await Promise.race([exited.then(() => true), delay(7000).then(() => false)]);
      if (!stopped && proc.exitCode === null && proc.signalCode === null) {
        const killed = new Promise<void>((resolveExit) => proc.once("close", () => resolveExit()));
        killTree(proc);
        await Promise.race([killed, delay(5000)]);
      }
    }
    socket?.close();
    assert.ok(proc.exitCode !== null || proc.signalCode !== null, `Chrome PID ${proc.pid} exited after the dialog audit`);
    console.log(`Dialog browser Chrome PID ${proc.pid} stopped (exit=${proc.exitCode}, signal=${proc.signalCode})`);
  }
}

test("browser harness exercises the real app, server actions, safety shell and responsive layout", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  assert.ok(existsSync(CHROME), `Headless Chrome is required at ${CHROME}; set CC_SKIP_BROWSER=1 only when intentionally running without it`);

  const temp = mkdtempSync(join(tmpdir(), "cc-packb-browser-"));
  const dataDir = join(temp, "data"); const configDir = join(dataDir, "config"); mkdirSync(configDir, { recursive: true });
  const testHome = join(temp, "test-home"); mkdirSync(testHome, { recursive: true });
  const workspaceData = workspaces(temp);
  mkdirSync(join(testHome, ".gemini"), { recursive: true });
  writeFileSync(join(testHome, ".gemini", "GEMINI.md"), "temporary global Gemini instructions\n", "utf8");
  const alphaDevFolder = workspaceData.projects[0].tabs[0].folder;
  writeFileSync(join(alphaDevFolder, "GEMINI.md"), "temporary project Gemini instructions\n", "utf8");
  writeFileSync(join(configDir, "workspaces.json"), JSON.stringify(workspaceData, null, 2));
  const fakeResponses = Object.fromEntries([
    [["claude", "--version"], { code: 0, stdout: "Claude Code 2.1.0\n", stderr: "" }],
    [["claude", "auth", "status"], { code: 0, stdout: "Not logged in\n", stderr: "" }],
    [["claude", "mcp", "list"], { code: 0, stdout: "claude_mcp: npx -y local-server\n", stderr: "" }],
    [["claude", "mcp", "add", "-s", "user", "valid_mcp", "--", "npx", "-y", "server"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["claude", "mcp", "remove", "-s", "user", "claude_mcp"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["claude", "plugin", "list"], { code: 0, stdout: "sample-plugin\n", stderr: "" }],
    [["claude", "plugin", "install", "sample-plugin"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["claude", "plugin", "uninstall", "sample-plugin"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["cmd", "/c", "start", "", "claude", "auth", "login"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["cmd", "/c", "start", "", "gh", "auth", "login", "--web"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["codex", "--version"], { code: 0, stdout: "codex-cli 0.155.1\n", stderr: "" }],
    [["codex", "login", "status"], { code: 0, stdout: "Not logged in\n", stderr: "" }],
    [["codex", "mcp", "list"], { code: 0, stdout: "No MCP servers configured.\n", stderr: "" }],
    [["opencode", "--version"], { code: 0, stdout: "OpenCode 1.2.3\n", stderr: "" }],
    [["opencode", "auth", "list"], { code: 0, stdout: "No providers configured\n", stderr: "" }],
    [["opencode", "mcp", "list"], { code: 0, stdout: "No MCP servers configured.\n", stderr: "" }],
    [["gemini", "--version"], { code: 127, stdout: "", stderr: "not installed" }],
    [["npm", "install", "-g", "@google/gemini-cli"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["gh", "auth", "status"], { code: 0, stdout: "not logged in\n", stderr: "" }],
  ].map(([argv, result]) => [JSON.stringify(argv), result]));
  const fakeScript = join(temp, "fake-cli-script.json");
  const fakeRecord = join(temp, "fake-cli-argv.jsonl");
  writeFileSync(fakeScript, JSON.stringify({ responses: fakeResponses }));
  const serverPort = await freePort();
  const childEnv = { ...process.env, HOME: testHome, USERPROFILE: testHome, CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: fakeScript, CC_TEST_FAKE_CLI_RECORD: fakeRecord, CC_DATA_DIR: dataDir, CC_PORT: String(serverPort), CC_APP_KEY: APP_KEY, CC_TEST_FORCE_PACKAGED: "1", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1" };
  assert.equal(childEnv.CC_TEST_FAKE_CLI, "1", "browser server must start with the fake CLI runner enabled");
  assert.equal(childEnv.CC_TEST_FAKE_CLI_SCRIPT, fakeScript, "browser fake responses must come from this test's temp directory");
  assert.equal(childEnv.CC_TEST_FAKE_CLI_RECORD, fakeRecord, "browser CLI calls must be recorded in this test's temp directory");
  assert.equal(childEnv.CC_DATA_DIR, dataDir, "browser server data must stay in this test's temp directory");
  assert.equal(childEnv.CC_PORT, String(serverPort));
  assert.notEqual(Number(childEnv.CC_PORT), 4317);
  assert.equal(childEnv.CC_SKIP_LEADER_CHECK, "1");
  assert.equal(childEnv.CC_SKIP_DISCOVERY, "1");
  assert.equal(childEnv.HOME, testHome);
  assert.equal(childEnv.USERPROFILE, testHome);
  const child = spawn(process.execPath, [join(REPO, "server", "index.ts")], {
    cwd: REPO, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  attachCrashCatcher(child.pid, "browser");
  let proxy: ReturnType<typeof proxyServer> | null = null;
  try {
    const actualPort = await waitServer(child);
    assert.equal(actualPort, serverPort, "CC_PORT must use the selected free port, not 4317");
    assert.notEqual(actualPort, 4317);
    const folder = join(temp, "folders", "picker-choice");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "GEMINI.md"), "temporary project Gemini instructions\n", "utf8");
    const settingsFolder = join(temp, "folders", "settings-picker-choice");
    mkdirSync(settingsFolder, { recursive: true });
    writeFileSync(join(settingsFolder, "GEMINI.md"), "temporary Settings picker Gemini instructions\n", "utf8");
    const script = readFileSync(join(REPO, "test", "browser-harness.js"), "utf8");
    const seed = fakeParallelState(await getServerState(actualPort));
    if (process.env.CC_BROWSER_DEBUG_ONLY !== "1" && phase("real")) {
    proxy = proxyServer(actualPort, { folder, mode: "real" }, script);
    const proxyPort = await listen(proxy.proxy);
    const real = await chromeAudit({ port: proxyPort, mode: "real", folder, width: 1600, profile: join(temp, "chrome-real"), virtualMs: 35_000 });
    console.log(`Browser real-server audit: ${JSON.stringify(real)}`);
    assert.equal(real.failure, undefined, `real browser audit failed: ${real.failure ?? JSON.stringify(real)}`);
    assertAuditFinished(real, "real");
    assert.deepEqual(real.errors, [], `real browser console/runtime errors: ${JSON.stringify(real.errors)}`);
    const realNames = real.checks.map((item: any) => item.name);
    for (const name of [
      "server state renders every shell target, project, tab, crew and step",
      "Pack C shell controls render",
      "tab switch reaches the server",
      "add-tab dialog creates the selected kind and process on the server",
      "new-project dialog creates the selected kind and process on the server",
      "held remove offers Undo before sending",
      "Undo cancels a held remove",
      "held remove sends after the Undo window",
      "seat model change reaches the server",
      "seat effort change reaches the server",
      "folder picker updates the server tab folder",
      "project folder picker updates the default without changing existing tab folders",
      "new tab dialog defaults to the project folder",
      "process change waits for Undo and then reaches the server",
      "modal traps Tab focus at its final control",
      "Escape closes the add-tab dialog and restores focus",
    ]) assert.ok(realNames.includes(name), `missing real browser check ${name}; matched ${JSON.stringify(realNames)}`);

    shutProxy(proxy);
    }
    const widths = process.env.CC_BROWSER_WIDTHS ? process.env.CC_BROWSER_WIDTHS.split(",").map(Number) : [1600, 1280, 1100, 1024];
    const layoutResults = [];
    // Saved personal pictures from before the simple look: an old preset and an old portrait fall back to Ash; an upload stays.
    const uploadedMe = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pHUAAAAASUVORK5CYII=";
    const oldMe: Record<number, { saved: string; expected: string }> = { 1600: { saved: "astra.jpg", expected: "/avatars/ash.svg" }, 1280: { saved: "me-3.jpg", expected: "/avatars/ash.svg" }, 1100: { saved: uploadedMe, expected: uploadedMe } };
    for (const width of phase("layout") ? widths : []) {
      proxy = proxyServer(actualPort, { folder, mode: "fake", seed, storageBlocked: width === 1024, oldMe: oldMe[width] }, script);
      const fakePort = await listen(proxy.proxy);
      const result = await chromeAudit({ port: fakePort, mode: "fake", folder, width, profile: join(temp, `chrome-${width}`), virtualMs: 35_000 });
      layoutResults.push(result);
      console.log(`Browser ${width}px audit: ${JSON.stringify(result)}`);
      assert.equal(result.failure, undefined, `${width}px browser audit failed: ${result.failure ?? JSON.stringify(result)}`);
      assertAuditFinished(result, "result");
      assert.deepEqual(result.errors, [], `${width}px browser console/runtime errors: ${JSON.stringify(result.errors)}`);
      const names = result.checks.map((item: any) => item.name);
      for (const name of [
        `B1 model labels and effort fit at ${width}px`,
        "plan meters stay hidden without data and show the measured rateLimit",
        "tab arrow keys change server selection and retain focus",
        "server supplied seat text is rendered as text",
        "chatHistory renders its server transcript",
        "chat sends the current tab and message through the protocol",
        "chatMessage updates the visible transcript",
        "chatDelta renders the live transcript",
        "chatDone clears streaming text and leaves the final message",
        "a second chat turn shows both its message and the leader's reply without reopening the tab",
        "a finished server-shaped message is rendered once and then served from the cache",
        "chat transcript keeps the reader position and sticks within four pixels",
        "Usage shows only measured leader and running-seat snapshots",
        "two parallel runs show the count badge and independent run tabs",
        "Writes only inside shows the server's folderPath",
        "per-run stop sends only the selected run id",
        "Stop all sends the server action",
        "run sends the selected tab, seat and prompt",
        "Stop seat sends the selected tab and seat",
        "seat History requests its server log list",
        "historyRun requests and renders the selected server run",
        "History refreshes on reopen, run completion, and reconnect",
        "long server names truncate inside project, tab, crew and stage controls",
        "every visible button has an accessible name",
        "every audited stage target was found",
        "stage header, steps, transcript and composer fit and remain clickable",
        `layout at ${width}px has no horizontal scroll or panel overlap`,
        "both panels collapse to the mockup strips and expand accessibly",
        "the rail's open or closed choice is sent to the server as the crewRailOpen pref",
        "the crew rail and Details open or closed come from the server's client prefs, not localStorage",
        "theme and personal avatar choices stay usable",
        "launch safety shows the Codex warning when a Claude seat is involved",
        "wrong launch-safety phrases stay local and the exact typed phrases are sent",
        "activity feed renders real launch, stall and completion events",
        "plain browser hides Electron-only folder pickers",
        "the top bar drags the window, and its controls, tabs and popovers are not drag areas",
        "without the app window's bridge the top bar shows no window buttons",
      ]) assert.ok(names.includes(name), `missing ${width}px browser check ${name}; matched ${JSON.stringify(names)}`);
      if (width === 1100) assert.ok(names.includes("Details open or closed is saved only by the user and survives resizing"), `missing tablet persistence check; matched ${JSON.stringify(names)}`);
      if (oldMe[width]) assert.ok(names.includes("a personal picture saved before the simple look falls back to Ash, and an uploaded one is kept"), `missing saved-picture migration check at ${width}px; matched ${JSON.stringify(names)}`);
      assert.ok(names.includes("a picture that fails to load falls back once and never loops"), `missing picture fallback check at ${width}px; matched ${JSON.stringify(names)}`);
      shutProxy(proxy);
      proxy = null;
    }
    assert.equal(layoutResults.length, phase("layout") ? widths.length : 0);
    if (phase("titlebar")) {
    // The window's own minimize, maximize/restore and close buttons: a fresh fake page with the Electron bridge, at the app's minimum width (electron/main.js MIN_WIDTH).
    proxy = proxyServer(actualPort, { folder, mode: "fake", seed, windowButtons: true }, script);
    const titleBarPort = await listen(proxy.proxy);
    const titleBar = await chromeAudit({ port: titleBarPort, mode: "fake", folder, width: 900, profile: join(temp, "chrome-titlebar"), caseName: "titlebar", virtualMs: 35_000 });
    console.log(`Browser window-buttons audit: ${JSON.stringify(titleBar)}`);
    assert.equal(titleBar.failure, undefined, `window-buttons audit failed: ${titleBar.failure ?? JSON.stringify(titleBar)}`);
    assertAuditFinished(titleBar, "titleBar");
    assert.deepEqual(titleBar.errors, [], `window-buttons browser errors: ${JSON.stringify(titleBar.errors)}`);
    for (const name of [
      "with the app bridge the window buttons show after the avatar, as labelled buttons the size and shape of Settings, and none of them drags the window",
      "each window button sends its own call once per click: minimize, maximize or restore, close",
      "the maximize button opens as Restore on a maximized window and swaps icon, label and tooltip on every maximize and restore",
      "at the app's minimum width nothing in the top bar overlaps or leaves the window",
      "at the app's minimum width the sound popover opens whole, inside the window, right under the speaker",
      "a close request with nothing working is answered close at once, with no warning",
      "a close request while tabs are working holds the close and names them as Project · Tab in the app's own warning",
      "a second close request while the warning shows redraws the same warning, never a second one",
      "Keep open, Escape and a click outside cancel the warning and tell the window to stay open",
      "Close anyway tells the window to close, and nothing after it says stay",
      "the warning names one working tab as it, and more than three as the first three and +N more",
      "the server's answer that a tab was created closes the Add tab dialog, not the close question open over it",
    ]) assert.ok(titleBar.checks.some((item: any) => item.name === name && item.passed), `missing window-buttons proof ${name}; matched ${JSON.stringify(titleBar.checks)}`);
    shutProxy(proxy); proxy = null;
    }
    if (phase("pack2")) {
    // Fix pack 2, block 3: the page's behaviour fixes, one named check each (see runPackTwo in browser-harness.js).
    proxy = proxyServer(actualPort, { folder, mode: "fake", seed }, script);
    const pack2Port = await listen(proxy.proxy);
    const pack2 = await chromeAudit({ port: pack2Port, mode: "fake", folder, width: 1600, profile: join(temp, "chrome-pack2"), caseName: "pack2", collect: process.env.CC_BROWSER_COLLECT === "1", virtualMs: 120_000 });
    console.log(`Browser fix pack 2 audit: ${JSON.stringify(pack2)}`);
    assert.equal(pack2.failures?.length ?? 0, 0, `fix pack 2 behaviour guard failed: ${(pack2.failures ?? []).map((item: any) => item.name).join(" | ")}`);
    assert.equal(pack2.failure, undefined, `fix pack 2 browser audit failed: ${pack2.failure ?? JSON.stringify(pack2)}`);
    assertAuditFinished(pack2, "pack2");
    assert.deepEqual(pack2.errors, [], `fix pack 2 browser console/runtime errors: ${JSON.stringify(pack2.errors)}`);
    const pack2Names = pack2.checks.map((item: any) => item.name);
    for (const name of [
      "while body.boot is set the app is hidden, so a dark launch never flashes the light look",
      "Accept and Decline on a request for another tab name that tab, and the server takes both",
      "a renamed leader is named in the approval title, the Waiting status, the Needs you card and the hand-over button",
      "a run's log starts from the server's tail, a chunk only appends, a resync fills what was missed, and the page keeps 200 KiB",
      "a stalled run the server relaunches says so, and one it leaves for you says it was not relaunched",
      "a launch notice is one Activity line however it arrives, updated in place, and repeated states never push real events out",
      "a removal sent just before the connection dropped is sent again after the reconnect and completes",
      "a Stop that never got its answer before the drop is forgotten, so its button works again",
      "a refused Stop frees only the run it was for",
      "Check again sends a request id, ends on the server's success or failure answer, and never hangs when there is none",
      "a chat over 2 MiB is not sent, says so, and keeps the connection and the draft",
      "request details are measured in bytes: 24 KiB goes, one byte more is refused here with a reason",
      "a saved-runs list or saved run the server never answers stops spinning, and the list can be asked for again",
      "a successful Save asks for the leader's saved sessions again",
      "a refused tab selection does not stop the page asking for that tab's transcript later",
      "no tab in the project strip or the tab strip contains another button",
      "a failed attachment's ring is not the fixed light pink in the dark theme",
    ]) assert.ok(pack2.checks.some((item: any) => item.name === name && item.passed), `missing fix pack 2 check ${name}; matched ${JSON.stringify(pack2Names)}`);
    shutProxy(proxy); proxy = null;
    }
    if (phase("pack3")) {
    // Fix pack 3, block 2: page behaviour that had no test at all (see runPackThree in browser-harness.js).
    proxy = proxyServer(actualPort, { folder, mode: "fake", seed }, script);
    const pack3Port = await listen(proxy.proxy);
    const pack3 = await chromeAudit({ port: pack3Port, mode: "fake", folder, width: 1600, profile: join(temp, "chrome-pack3"), caseName: "pack3", collect: process.env.CC_BROWSER_COLLECT === "1", virtualMs: 120_000 });
    console.log(`Browser fix pack 3 audit: ${JSON.stringify(pack3)}`);
    assert.equal(pack3.failures?.length ?? 0, 0, `fix pack 3 behaviour guard failed: ${(pack3.failures ?? []).map((item: any) => item.name).join(" | ")}`);
    assert.equal(pack3.failure, undefined, `fix pack 3 browser audit failed: ${pack3.failure ?? JSON.stringify(pack3)}`);
    assertAuditFinished(pack3, "pack3");
    assert.deepEqual(pack3.errors, [], `fix pack 3 browser console/runtime errors: ${JSON.stringify(pack3.errors)}`);
    const pack3Names = pack3.checks.map((item: any) => item.name);
    for (const name of PACK3_CHECKS) assert.ok(pack3.checks.some((item: any) => item.name === name && item.passed), `missing fix pack 3 check ${name}; matched ${JSON.stringify(pack3Names)}`);
    shutProxy(proxy); proxy = null;
    }
    if (phase("b2")) {
    proxy = proxyServer(actualPort, { folder, mode: "fake", seed, storageBlocked: true }, script);
    const b2Port = await listen(proxy.proxy);
    const b2 = await chromeAudit({ port: b2Port, mode: "fake", folder, width: 1600, profile: join(temp, "chrome-b2"), caseName: "b2", collect: process.env.CC_BROWSER_COLLECT === "1", virtualMs: 35_000 });
    console.log(`Browser Pack B2 acceptance audit: ${JSON.stringify(b2)}`);
    assert.equal(b2.failures?.length ?? 0, 0, `B2 call-site mutation detected: ${(b2.failures ?? []).map((item: any) => item.name).join(" | ")}`);
    assert.equal(b2.failure, undefined, `Pack B2 browser audit failed: ${b2.failure ?? JSON.stringify(b2)}`);
    assertAuditFinished(b2, "b2");
    assert.deepEqual(b2.errors, [], `Pack B2 browser console/runtime errors: ${JSON.stringify(b2.errors)}`);
    const b2Names = b2.checks.map((item: any) => item.name);
    for (const name of [
      "Pack B2 target selector list finds every required control",
      "B1 labels, effort, role, CLI, and Nova portrait match the mockup",
      "the leader crown badge shows only when the leader's picture has no crown of its own",
      "Codex and OpenCode model labels use the mockup names and unknown ids stay raw",
      "XSS-shaped chat, tab, project, and folder strings stay visible literal text",
      "project rename keeps typed text through incoming state, Enter sends it, and Escape discards it",
      "Attach precedes the permission pill and keeps its file input",
      "launch safety panel stays hidden when there is no safety action",
      "launch safety shows the Codex warning only when a non-Codex seat is involved",
      "tab arrows select the next tab and restore focus after re-render",
      "worker Live, History, run, and history-return controls retain focus after re-render",
      "approval card exposes the real approve action and prefilled changes",
      "Settings includes every mockup section and retains Behaviour defaults",
      "Behaviour switches send the selected values through the server protocol",
      "Settings closes and restores focus to its opener",
      "leader History requests saved files for the leader seat and returns to chat",
      "session row hides unmeasured or invalid context and shows a clamped one-decimal meter and saved time",
      "Save sends the tab, shows progress, handles success, and reports the matching error",
      "Clear always confirms, clears the transcript, restores once within 10 seconds, and reports rejected Undo",
      "notification policy covers worker finish, failure, stall (never launch), focus, approval, routine noise, and both kinds of stop (the server's own internal stop and the user's)",
      "disabling notifications blocks every desktop notice while the sound button keeps the chime on the same events",
      "clicking the speaker opens the sound popover under it; Escape, a click outside and a second click close it",
      "the sound popover's switch turns the completion chime off and on, in sync with Settings both ways",
      "the sound popover and the Settings switch agree before the server answers, from either one",
      "the volume slider shows its percent while dragged, keeps it through a state redraw, and sends the pref once when let go",
      "Test plays one bell at the slider's level, before it is let go and while the sound is off, and saves nothing",
      "every bell follows the saved volume: 30% is 0.3 of the full master level, 0% plays nothing, and the speaker shows muted at 0%",
      "an unread reply in a project that is not shown dots its tab until that project is opened",
      "the page shows the theme and picture a state carries, and an unknown preset falls back to Ash",
      "Dismiss saves the run on the server, and the page hides exactly the runs the server lists",
      "Your avatar has twenty presets, saves the choice to the server, and returns focus after a state re-render",
        "a picture over 512 KB is refused in plain words, sends nothing and keeps the old picture",
        "Your avatar upload stores the image data URL on the server and shows it through one short blob URL",
        "your uploaded picture is referenced once in each message, never copied into its HTML",
        "seat avatar presets and upload control render, send the selected picture and return focus after a state re-render",
        "active leader turn queues click and Enter without sending, and the next draft and image move into the queue",
        "background completion preserves foreground upload status and names background errors",
      "image-only composer stays disabled and retains its image",
      "completed leader turn clears progress and keeps the empty composer disabled",
      "chat waits for an in-flight image read before sending",
      "client send guard covers click and Enter",
      "pending send keeps text and attachments read-only until its request is answered",
      "chatMessage from another or legacy window cannot settle an identical draft",
      "chat error with another request id cannot settle this send",
      "chatMessage with my request id accepts and consumes only that composer snapshot",
      "chat consumes only the attachments in its send snapshot",
      "disconnected sends keep draft and attachments",
      "chat sends the uploaded image path for the selected tab",
      "chat image thumbnails include the sent filename as a file chip",
      "XSS-shaped attachment filenames stay visible literal text",
      "XSS-shaped run output stays visible literal text",
      "released attachments stop before POST when their file read finishes",
      "chat waits for image upload, sends its server path, renders the right-side thumbnail, and releases the preview",
      "assistant messages use the lead portrait, and every message's time label is the clock time of its `at`",
      "completed attachment resources release after a tab removal is confirmed",
      "completed attachment resources release after a project removal is confirmed",
      "a send waiting for an image is abandoned on tab switch and both drafts survive",
      "a send waiting for an image is abandoned on project switch and both drafts survive",
      "a send waiting for an image is abandoned on switch away and back and both drafts survive",
      "History matches out-of-order historyRun replies by seat and timestamp and ignores stale ones",
      "a failed Settings send rolls back with an error and reconnect shows the server's value",
      "Run dialog keeps the brief and shows an error when the send fails, then closes after a successful send",
      "selected-tab Undo restores selection when fallback state is delayed",
      "one rejected held removal restores only itself; the next removal cleans up on confirmation",
      "multiple held actions each keep a visible Undo when pagehide sends fail",
      "pagehide flushes every held action after reconnect",
      "error toast visibility and hidden state stay in sync",
      "Undo after Remove tab keeps a tab the user chose during the hold",
      "Undo after Remove tab returns to the removed tab when the user did not move",
      "Undo after Remove tab keeps the fallback tab the user clicked",
      "Undo after Remove tab keeps the fallback tab picked with the arrow keys",
      "Undo after Remove tab keeps the fallback tab picked with Enter",
      "Undo after Remove tab keeps the fallback tab picked with Space",
      "Undo after Remove tab keeps the fallback tab picked with the waiting card",
      "Undo after Remove tab keeps the fallback tab picked with the project picker",
      "unrelated errors never restore a held action",
      "an error naming the held request restores only that action",
      "chat error with my request id unlocks without changing the composer",
      "a refused chat unlocks Send once the server answers",
      "a disconnect mid-reply unlocks Send after reconnect with an idle server",
      "socket close releases pending lock but leaves composer text and attachments",
      "reconnect history without my request id keeps composer untouched",
      "reconnect history with my request id clears the accepted composer",
      "older accepted request cannot change a newer pending composer",
      "the send mode follows the leader turn: queues while active, plain Send with a worker still running and no chatDone",
      "a leader turn the server reports makes Send queue with no local send (second window or reconnect mid-turn)",
      "a state before server acceptance keeps the pending send locked with its composer intact",
      "a refusal during another window's turn leaves Send in queue mode",
      "a refused send leaves its original text and images in the composer",
      "a sent chat abandoned by a tab switch is still settled by its later echo without a duplicate send",
      "a sent chat abandoned by a tab switch is still settled by history on return without a duplicate send",
      "text edited after a disconnect survives reconnect history that accepts the older send",
      "a file picked while a send is pending is never attached to that composer",
      "the composer caps attachments at the server's eight-image limit",
    ]) assert.ok(b2Names.includes(name), `missing Pack B2 browser check ${name}; matched ${JSON.stringify(b2Names)}`);
    for (const kind of ["tab", "project", "process"]) {
      for (const order of ["read-before-undo", "read-after-undo"]) {
        const filename = `race-${kind}-${order}.png`;
        assert.ok(b2Names.includes(`attachment ${filename} survives the ${kind} Undo in ${order}`), `missing attachment Undo check ${filename}; matched ${JSON.stringify(b2Names)}`);
      }
      assert.ok(b2Names.includes(`attachment preview stays live while ${kind} Undo is pending`), `missing live Undo retention check for ${kind}; matched ${JSON.stringify(b2Names)}`);
    }
    assert.equal(b2Names.filter((name: string) => name.startsWith("removed completed attachment ")).length, 6, `each removal target was checked: ${JSON.stringify(b2Names.filter((name: string) => name.startsWith("removed completed attachment ")))}`);
    shutProxy(proxy); proxy = null;
    }

    if (phase("packc")) {
    const packCWidths = [1600, 1280, 1024];
    for (const width of packCWidths) {
      proxy = proxyServer(actualPort, { folder, mode: "fake", seed, storageBlocked: width === 1024 }, script);
      const c2Port = await listen(proxy.proxy);
      const c2 = await chromeAudit({ port: c2Port, mode: "fake", folder, width, profile: join(temp, `chrome-packc-${width}`), caseName: "c2", virtualMs: 60_000 });
      console.log(`Browser Pack C ${width}px audit: ${JSON.stringify(c2)}`);
      assert.equal(c2.failures?.length ?? 0, 0, `Pack C ${width}px call-site mutation detected: ${(c2.failures ?? []).map((item: any) => item.name).join(" | ")}`);
      assert.equal(c2.failure, undefined, `Pack C ${width}px browser audit failed: ${c2.failure ?? JSON.stringify(c2)}`);
      assertAuditFinished(c2, "c2");
      assert.deepEqual(c2.errors, [], `Pack C ${width}px browser console/runtime errors: ${JSON.stringify(c2.errors)}`);
      const c2Names = c2.checks.map((item: any) => item.name);
      for (const name of C2_APPROVAL_CHECKS) assert.ok(c2Names.includes(name), `missing Pack C approval check ${name}; matched ${JSON.stringify(c2Names)}`);
      for (const name of packCWidthChecks(width)) assert.ok(c2Names.includes(name), `missing Pack C ${width}px browser check ${name}; matched ${JSON.stringify(c2Names)}`);
      for (const name of packCFileUndoChecks()) assert.ok(c2Names.includes(name), `missing Pack C file check ${name}; matched ${JSON.stringify(c2Names)}`);
      if (width === 1600 || width === 1024) {
        const dialogAudit = await chromeDialogAudit({ port: c2Port, folder, width, profile: join(temp, `chrome-dialog-close-${width}`) });
        assert.deepEqual(dialogAudit.dialogs, ["#inboxPop", "#setModal", "#avModal", "#viewer", "#modal", "#projModal", "#runModal"]);
        console.log(`Dialog browser audit ${width}px passed: ${JSON.stringify(dialogAudit)}`);
      }
      shutProxy(proxy); proxy = null;
    }

    for (const width of packCWidths) {
      assert.equal(childEnv.CC_TEST_FAKE_CLI, "1", `real Settings browser audit at ${width}px must use the scripted fake CLI runner`);
      assert.equal(childEnv.CC_TEST_FAKE_CLI_SCRIPT, fakeScript, `real Settings browser audit at ${width}px must use its temporary response script`);
      assert.equal(childEnv.CC_DATA_DIR, dataDir, `real Settings browser audit at ${width}px must use temporary server data`);
      assert.equal(Number(childEnv.CC_PORT), actualPort, `real Settings browser audit at ${width}px must use the isolated server port`);
      assert.notEqual(Number(childEnv.CC_PORT), 4317);
      proxy = proxyServer(actualPort, { folder: settingsFolder, mode: "real" }, script);
      const settingsPort = await listen(proxy.proxy);
      const settingsAudit = await chromeAudit({ port: settingsPort, mode: "real", folder: settingsFolder, width, profile: join(temp, `chrome-packc-real-settings-${width}`), caseName: "c2-settings", virtualMs: 60_000 });
      console.log(`Browser Pack C real-server Settings ${width}px audit: ${JSON.stringify(settingsAudit)}`);
      assert.equal(settingsAudit.failures?.length ?? 0, 0, `Pack C real Settings ${width}px check failed: ${(settingsAudit.failures ?? []).map((item: any) => item.name).join(" | ")}`);
      assert.equal(settingsAudit.failure, undefined, `Pack C real Settings ${width}px browser audit failed: ${settingsAudit.failure ?? JSON.stringify(settingsAudit)}`);
      assertAuditFinished(settingsAudit, "settingsAudit");
      assert.deepEqual(settingsAudit.errors, [], `Pack C real Settings ${width}px browser errors: ${JSON.stringify(settingsAudit.errors)}`);
      const settingsNames = settingsAudit.checks.map((item: any) => item.name);
      for (const name of [
        `real fake-runner Settings and permission targets exist at ${width}px`,
        `real Settings nav finds all eight sections at ${width}px`,
        `real Gemini remains install-only with server instruction inventory at ${width}px`,
        `Gemini install shows real server status for its fresh id at ${width}px`,
        `Claude sign-in shows real server status for its fresh id at ${width}px`,
        `GitHub connect shows real server status for its fresh id at ${width}px`,
        `Notes vault refusal shows real server status for its fresh id at ${width}px`,
        `Notes vault save shows real server status for its fresh id at ${width}px`,
        `real Notes vault Open in Obsidian uses the encoded server path at ${width}px`,
        `Default folder refusal shows real server status for its fresh id at ${width}px`,
        `Default folder save shows real server status for its fresh id at ${width}px`,
        `real folder pickers update the default and selected tab at ${width}px`,
        `MCP add shows real server status for its fresh id at ${width}px`,
        `MCP remove shows real server status for its fresh id at ${width}px`,
        `Plugin install shows real server status for its fresh id at ${width}px`,
        `Plugin remove shows real server status for its fresh id at ${width}px`,
        `real MCP and plugin actions use server refusals and require confirmation at ${width}px`,
        `real per-tab permission flow uses server state and confirmation at ${width}px`,
        `Clear Notes vault shows real server status for its fresh id at ${width}px`,
        `real Notes vault clears back to its honest no-vault state at ${width}px`,
      ]) assert.ok(settingsNames.includes(name), `missing real fake-runner Settings check ${name}; matched ${JSON.stringify(settingsNames)}`);
      shutProxy(proxy); proxy = null;
    }

    proxy = proxyServer(actualPort, { folder, mode: "real" }, script);
    const requestPort = await listen(proxy.proxy);
    const requestAudit = await chromeAudit({ port: requestPort, mode: "real", folder, width: 1600, profile: join(temp, "chrome-packc-requests"), caseName: "c2-requests", virtualMs: 35_000 });
    console.log(`Browser Pack C real-server requests audit: ${JSON.stringify(requestAudit)}`);
    assert.equal(requestAudit.failure, undefined, `Pack C real request audit failed: ${requestAudit.failure ?? JSON.stringify(requestAudit)}`);
    assertAuditFinished(requestAudit, "requestAudit");
    assert.deepEqual(requestAudit.errors, [], `Pack C real request browser errors: ${JSON.stringify(requestAudit.errors)}`);
    assert.ok(requestAudit.checks.some((item: any) => item.name === "the real browser server probes Gemini and GitHub through its scripted fake runner"), `missing real fake-runner settings proof; matched ${JSON.stringify(requestAudit.checks.map((item: any) => item.name))}`);
    assert.ok(requestAudit.checks.some((item: any) => item.name === "requests run end to end on the fake-runner server: send, badge, accept/decline, and destination removed"), `missing real-server request proof; matched ${JSON.stringify(requestAudit.checks.map((item: any) => item.name))}`);
    shutProxy(proxy); proxy = null;
    }

    if (phase("looks")) {
    // The actual restart bug: the app window opens on a new random port each launch, so its localStorage is a new, empty one. The same real
    // server is opened from two different proxy ports (two origins, two Chrome profiles); the second page must wear what the first chose.
    proxy = proxyServer(actualPort, { folder, mode: "real" }, script);
    const writePort = await listen(proxy.proxy);
    const looksWrite = await chromeAudit({ port: writePort, mode: "real", folder, width: 1600, profile: join(temp, "chrome-looks-write"), caseName: "looks-write", virtualMs: 35_000 });
    console.log(`Browser looks-write audit: ${JSON.stringify(looksWrite)}`);
    assert.equal(looksWrite.failure, undefined, `looks-write audit failed: ${looksWrite.failure ?? JSON.stringify(looksWrite)}`);
    assertAuditFinished(looksWrite, "looksWrite");
    assert.deepEqual(looksWrite.errors, [], `looks-write browser errors: ${JSON.stringify(looksWrite.errors)}`);
    for (const name of ["a theme and picture chosen in one page load are kept by the real server", "a sound volume set in one page load is kept by the real server"]) assert.ok(looksWrite.checks.some((item: any) => item.name === name), `missing looks-write proof ${name}; matched ${JSON.stringify(looksWrite.checks)}`);
    shutProxy(proxy); proxy = null;
    const kept = (await getServerState(actualPort)).clientPrefs;
    assert.equal(kept.theme, "dark", "the server itself holds the chosen theme"); assert.equal(kept.avatar, "momo.svg", "the server itself holds the chosen picture");
    assert.equal(kept.bellVolume, 35, "the server itself holds the chosen sound volume");
    // A picture over the cap that reaches the server anyway is refused in plain words and changes nothing.
    const refusal = await new Promise<any>((resolveRefusal, rejectRefusal) => {
      const ws = new WebSocket(keyedWsUrl(`ws://${HOST}:${actualPort}`, APP_KEY), { origin: `http://${HOST}:${actualPort}` });
      const timer = setTimeout(() => { ws.terminate(); rejectRefusal(new Error("no answer to the oversized picture")); }, 5000);
      ws.once("open", () => ws.send(JSON.stringify({ type: "updateClientPref", key: "avatar", value: "data:image/png;base64," + "A".repeat(512 * 1024) })));
      ws.on("message", (data) => { const message = JSON.parse(data.toString()); if (message.type !== "error") return; clearTimeout(timer); ws.close(); resolveRefusal(message); });
      ws.once("error", (error) => { clearTimeout(timer); rejectRefusal(error); });
    });
    assert.match(refusal.message, /too large to keep \(limit 512 KB\)/, `the refusal says why: ${JSON.stringify(refusal)}`);
    assert.equal((await getServerState(actualPort)).clientPrefs.avatar, "momo.svg", "the refused picture changed nothing");
    proxy = proxyServer(actualPort, { folder, mode: "real" }, script);
    const readPort = await listen(proxy.proxy);
    assert.notEqual(readPort, writePort, "the second page load must be a different origin");
    const looksRead = await chromeAudit({ port: readPort, mode: "real", folder, width: 1600, profile: join(temp, "chrome-looks-read"), caseName: "looks-read", virtualMs: 35_000 });
    console.log(`Browser looks-read audit: ${JSON.stringify(looksRead)}`);
    assert.equal(looksRead.failure, undefined, `looks-read audit failed: ${looksRead.failure ?? JSON.stringify(looksRead)}`);
    assertAuditFinished(looksRead, "looksRead");
    assert.deepEqual(looksRead.errors, [], `looks-read browser errors: ${JSON.stringify(looksRead.errors)}`);
    for (const name of ["a fresh page load on a different port opens in the theme and picture chosen before", "a fresh page load on a different port opens the sound popover at the volume set before"]) assert.ok(looksRead.checks.some((item: any) => item.name === name), `missing looks-read proof ${name}; matched ${JSON.stringify(looksRead.checks)}`);
    assert.equal(looksWrite.matched.port, String(writePort)); assert.equal(looksRead.matched.port, String(readPort));
    assert.notEqual(looksWrite.matched.port, looksRead.matched.port, "the two page loads ran on different ports");
    shutProxy(proxy); proxy = null;
    }

    if (phase("packc")) {
    const recordedCalls = readFileSync(fakeRecord, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(recordedCalls.every((argv) => Array.isArray(argv) && argv.every((arg: unknown) => typeof arg === "string")), `fake runner recorded argv arrays only: ${JSON.stringify(recordedCalls)}`);
    assert.ok(recordedCalls.some((argv) => JSON.stringify(argv) === JSON.stringify(["gemini", "--version"])), `Gemini version probe was recorded by the fake runner: ${JSON.stringify(recordedCalls)}`);
    assert.ok(recordedCalls.some((argv) => JSON.stringify(argv) === JSON.stringify(["gh", "auth", "status"])), `GitHub auth status was recorded by the fake runner: ${JSON.stringify(recordedCalls)}`);
    }
  } finally {
    if (proxy) { proxy.wss.close(); proxy.proxy.close(); }
    try { await stopServer(child); } // a stop that rejects or times out still surfaces, after the temp folder is gone
    finally { rmSync(temp, { recursive: true, force: true, maxRetries:30, retryDelay:100 }); }
  }
});

// The mutation runner selects this test. It exercises the same Pack C harness at all three widths,
// plus native Chrome input, without repeating unrelated Pack A/B browser audits per mutation.
test("approval browser guards and Settings lifecycle", async (t) => {
  if (!phase("approvals")) { t.skip("CC_BROWSER_PHASES leaves this part out"); return; }
  const temp = mkdtempSync(join(tmpdir(), "cc-approval-browser-"));
  const home = join(temp, "home"), data = join(temp, "data"), folder = join(temp, "picker");
  mkdirSync(home); mkdirSync(join(data, "config"), { recursive: true }); mkdirSync(folder);
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify(workspaces(temp)));
  const fake = join(temp, "cli.json"); writeFileSync(fake, JSON.stringify({ responses: {} }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(REPO, "server/index.ts")], { cwd: REPO, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: String(port), CC_APP_KEY: APP_KEY, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1", CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: fake } });
  attachCrashCatcher(child.pid, "browser");
  let proxy: ReturnType<typeof proxyServer> | null = null;
  try {
    assert.equal(await waitServer(child), port);
    const seed = fakeParallelState(await getServerState(port));
    const script = readFileSync(join(REPO, "test/browser-harness.js"), "utf8");
    for (const width of [1600, 1280, 1024]) {
      proxy = proxyServer(port, { folder, mode: "fake", seed, storageBlocked: width === 1024 }, script);
      const auditPort = await listen(proxy.proxy);
      const audit = await chromeAudit({ port: auditPort, folder, mode: "fake", width, profile: join(temp, "c2-" + width), caseName: "c2", virtualMs: 60000 });
      assert.equal(audit.failure, undefined, "approval browser audit completed: " + audit.failure);
      assertAuditFinished(audit, "audit");
      assert.deepEqual(audit.errors, [], "approval browser runtime errors");
      assert.ok(audit.checks.length > 0, "approval harness found checks");
      const auditNames = audit.checks.map((item: any) => item.name);
      for (const name of C2_APPROVAL_CHECKS) assert.ok(auditNames.includes(name), `missing approval-test check ${name} at ${width}px; matched ${JSON.stringify(auditNames)}`);
      assert.deepEqual(audit.failures ?? [], [], "approval browser call-site failures: " + JSON.stringify(audit.failures));
      console.log("Approval harness " + width + "px: " + audit.checks.length + " checks GREEN");
      if (width === 1600) await chromeDialogAudit({ port: auditPort, folder, width, profile: join(temp, "native"), approvals: true });
      if (width === 1600) await chromeDialogAudit({ port: auditPort, folder, width, profile: join(temp, "native-seat"), seatPointer: true });
      shutProxy(proxy); proxy = null;
    }
  } finally {
    if (proxy) { proxy.wss.close(); proxy.proxy.close(); }
    try { await stopServer(child); } // a stop that rejects or times out still surfaces, after the temp folder is gone
    finally { rmSync(temp, { recursive: true, force: true, maxRetries:30, retryDelay:100 }); }
  }
});

test("the audit guards go RED on a cut-short report, a narrowed run under npm test, and a Chrome that outlives its cap", async () => {
  // A report with checks and no failure, but without the harness's finished marker, is what the virtual-time budget leaves behind.
  assert.throws(() => assertAuditFinished({ checks: [{ name: "the last check that ran" }] }, "control"), /control: the audit did not finish.*the last check that ran/);
  assert.throws(() => assertAuditFinished({ checks: [], failure: undefined }, "control"), /did not finish/);
  assertAuditFinished({ checks: [], finished: true }, "control");
  // CC_BROWSER_PHASES, CC_BROWSER_WIDTHS and CC_BROWSER_DEBUG_ONLY skip browser phases: that is refused under npm test and only announced elsewhere.
  assert.match(narrowedRunError({ npm_lifecycle_event: "test" }, ["CC_BROWSER_PHASES=b2"]) ?? "", /npm test must run the whole browser suite.*CC_BROWSER_PHASES=b2/);
  assert.equal(narrowedRunError({ npm_lifecycle_event: "test" }, []), null, "nothing narrowed: allowed under npm test");
  assert.equal(narrowedRunError({}, ["CC_BROWSER_PHASES=b2"]), null, "a mutation sweep or a debug run is not npm test: announced, not refused");
  assert.equal(narrowedRunError(process.env, NARROWED) === null, !(NARROWED.length && process.env.npm_lifecycle_event === "test"), "this very run is not narrowed under npm test");
  if (process.env.CC_SKIP_BROWSER === "1") return;
  assert.ok(existsSync(CHROME), `Headless Chrome is required at ${CHROME}`);
  // A page whose request never answers keeps Chrome waiting past a 3 s cap: the audit must reject at the cap, and nothing of that Chrome may be left running.
  // This leg proves the cap fires with the installed Chrome; whether the whole process TREE is stopped is proven by the next test, which cannot be fooled by a Chrome whose helpers happen to exit with it.
  const temp = mkdtempSync(join(tmpdir(), "cc-chromecap-"));
  const profile = join(temp, "profile");
  const hung = new Set<import("node:net").Socket>();
  let hangRequestedAt = 0, hangRequested = () => {};
  const hangStarted = new Promise<void>((ok) => { hangRequested = ok; });
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/__audit")) { response.writeHead(200, { "Content-Type": "text/html" }); response.end('<!doctype html><pre id="AUDIT">running</pre><img src="/hang">'); } // /hang never answers
    else if (request.url === "/hang" && !hangRequestedAt) { hangRequestedAt = Date.now(); hangRequested(); }
  });
  server.on("connection", (socket) => { hung.add(socket); socket.on("close", () => hung.delete(socket)); });
  try {
    const port = await listen(server);
    // The cap is armed once Chrome has asked for /hang (waited for up to 60 s, separately from the cap): the page is then really hung.
    const requested = Promise.race([hangStarted, new Promise((_, no) => setTimeout(() => no(new Error("Chrome never requested /hang within 60 s")), 60_000).unref())]);
    await assert.rejects(chromeAudit({ port, mode: "fake", folder: temp, width: 800, profile, virtualMs: 60_000, capMs: 3000, capStartsAfter: requested }), /Chrome exceeded 3000ms and exited after termination/);
    const sinceHang = Date.now() - hangRequestedAt;
    assert.ok(hangRequestedAt > 0, "Chrome requested /hang before the cap fired");
    assert.ok(sinceHang >= 2990, `the cap counted from the hung request, not from Chrome's start: ${sinceHang} ms`);
    assert.ok(sinceHang < 30_000, `the audit rejected at its cap, not at the virtual budget: ${sinceHang} ms`);
    const left = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profile.replaceAll("'", "''")}*' } | Measure-Object).Count`], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.equal(left.stdout.trim(), "0", `no Chrome process that this test started is left after the cap: ${left.stdout} ${left.stderr}`);
  } finally {
    for (const socket of hung) socket.destroy();
    server.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test("the cap stops the whole tree of a Chrome, not just its first process: a helper that outlives a plain kill is gone", async () => {
  // A stand-in Chrome that starts one helper and never ends. Killing only its own pid (what proc.kill() does) leaves the helper running.
  const temp = mkdtempSync(join(tmpdir(), "cc-chrometree-"));
  const marker = `cc-tree-marker-${process.pid}-${Date.now()}`, pidFile = join(temp, "helper.pid");
  const helperProcesses = () => spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }) -join ','`], { encoding: "utf8", windowsHide: true, timeout: 30_000 }).stdout.trim();
  // The cap is armed once the stand-in has written its helper's pid (waited for up to 60 s, separately from the cap).
  let helperSeenAt = 0;
  const helperStarted = (async () => {
    for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((ok) => setTimeout(ok, 20))) {
      if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()) { helperSeenAt = Date.now(); return; }
    }
    throw new Error("the stand-in Chrome never wrote its helper's pid within 60 s");
  })();
  try {
    await assert.rejects(
      chromeAudit({ port: 1, mode: "fake", folder: temp, width: 800, profile: join(temp, "profile"), virtualMs: 1, capMs: 2500, capStartsAfter: helperStarted, chrome: { exe: process.execPath, args: [join(REPO, "test", "fake-chrome-tree.mjs"), marker, pidFile, "1500"] } }),
      /Chrome exceeded 2500ms and exited after termination/);
    assert.ok(helperSeenAt > 0 && existsSync(pidFile), "the stand-in started its helper before the cap");
    assert.ok(Date.now() - helperSeenAt >= 2490, `the cap counted from the helper's start (written 1.5 s after the stand-in's spawn), not from the spawn: ${Date.now() - helperSeenAt} ms`);
    const helperPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(helperPid) && helperPid > 0, `the helper's pid was recorded: ${helperPid}`);
    const end = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < end) { try { process.kill(helperPid, 0); await new Promise((ok) => setTimeout(ok, 100)); } catch { alive = false; } }
    assert.equal(alive, false, `the helper (pid ${helperPid}) was still running after the cap: only the first process was stopped`);
    assert.equal(helperProcesses(), "", "no process carrying the marker is left");
  } finally {
    // Whatever carries this test's own marker (and nothing else) is stopped, so a failure here leaves nothing behind.
    const left = helperProcesses();
    if (left) spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${left} -Force`], { windowsHide: true, timeout: 30_000 });
    rmSync(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test("the browser suite is not narrowed under npm test", () => {
  const error = narrowedRunError(process.env, NARROWED);
  assert.equal(error, null, error ?? "");
});
