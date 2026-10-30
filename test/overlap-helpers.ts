import { resolve } from "node:path";
import { newAppKey } from "./temp-root.ts";

// Overlap audit: every screen and state below is built from long data on purpose (60-char names, 200-char
// paths, a 300-char unbroken string) and checked in a real headless Chrome. Visible text ranges and visible
// interactive boxes must never intersect by more than 1px, and text must never be cut off without an ellipsis
// (plus a title tooltip) or run past its card or the window. Fake CLI runner, temp data, free port, never 4317.

export const HOST = "127.0.0.1";
// The server's CC_APP_KEY; the page gets it from window.cc.appKey() like the Electron preload gives it.
export const APP_KEY = newAppKey();
export const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
export const REPO = resolve(".");
export const WIDTHS = [1600, 1280, 1024];
export const HEIGHT = 900;

// Intentional stacks: an element pair that may overlap, named with the reason. Every other pair this audit found
// was fixed instead, so this list stays short. Each entry is { a: selector, b: selector, reason }, matched with closest().
export const INTENTIONAL_STACKS: Array<{ a: string; b: string; reason: string }> = [
  { a: "#side", b: "#stage", reason: "below 1280px the Details panel floats over the right of the chat column on an opaque card (the mockup's narrow layout); from 1280px up it sits beside it, and the browser layout test proves the two never touch there" },
];

export const delay = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
export const spaced = (prefix: string, length = 60) => `${prefix} ${"long words that keep going ".repeat(12)}`.slice(0, length);
export const unbroken = (prefix: string, length = 60) => `${prefix}${"W".repeat(length)}`.slice(0, length);
export const LONG_PATH = `C:\\Users\\example\\Documents\\${"very-long-folder-name-".repeat(9)}final`.slice(0, 200);
export const UNBROKEN_300 = `U${"n".repeat(298)}Z`;
export const LONG_URL = `https://example.com/${"path-segment/".repeat(14)}?query=${"x".repeat(60)}`;

export function buildSeed(base: any) {
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
    folderPath: LONG_PATH, startedAt: start + number, endedAt: null, output: "output", launchedBy: null,
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

export function chatMessages() {
  const now = Date.now();
  return [
    { id: "m1", role: "user", text: `${spaced("Please look at", 200)}\n${UNBROKEN_300}\n${LONG_URL}\n${LONG_PATH}`, at: now - 500000, revision: 1, files: [`${LONG_PATH}\\${unbroken("attached-", 120)}.md`], images: [`${LONG_PATH}\\${unbroken("shot-", 120)}.png`] },
    { id: "m2", role: "assistant", text: `${spaced("Sure", 400)}\n\n${UNBROKEN_300}\n\n${LONG_URL}\n${LONG_PATH}\n${"a-very-long-word-".repeat(30)}`, at: now - 400000, revision: 2, files: [`${LONG_PATH}\\${unbroken("out-", 100)}.txt`] },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `m-${index}`, role: index % 2 ? "assistant" : "user", text: spaced(`Filler message ${index}`, 260), at: now - 300000 + index, revision: 3 + index })),
  ];
}

// window.cc is the app window's whole bridge, window buttons included, so the top bar is audited as the app shows it.
export function bootstrap(seed: any, messages: any[]) {
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
