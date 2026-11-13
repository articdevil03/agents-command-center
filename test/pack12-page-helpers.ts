import { withFixedBehaviour, type Page } from "./fixed-page-behaviour.ts";
export { delay, J } from "./pack18-editor-harness.ts";
import { J } from "./pack18-editor-harness.ts";

// Pack 12 (steer in chat), the page side: a real headless Chrome runs the real page script (public/app/*.js) against a fake socket. While the leader replies a message is
// queued above the box (nothing is sent), Steer pushes it into the reply (a `steer` message), the first waiting message goes out as a normal send when the
// reply ends normally, a Stop or failure keeps them behind a Send button, and a refusal (busy, folder busy, steerRefused) puts a message back where it was.
// With CC_PACK12_SHOTS=<folder> the queue is saved there as PNGs. The page, server and Chrome come from the shared fixed-crew adapter (fixed-page-behaviour.ts):
// two fixed tabs, fake CLI runner, temp data, free port, never 4317, Chrome window at X >= 1920.
export type { Page };

// The adapter saves shots under CC_PACK9_SHOTS; this file's own switch is CC_PACK12_SHOTS, so a shot borrows it for the one call.
export const withPage = (body: (page: Page) => Promise<void>) => withFixedBehaviour((page) => body({
  ...page,
  shot: async (name) => {
    const folder = process.env.CC_PACK12_SHOTS, previous = process.env.CC_PACK9_SHOTS;
    if (!folder) return;
    process.env.CC_PACK9_SHOTS = folder;
    try { await page.shot(name); } finally { if (previous === undefined) delete process.env.CC_PACK9_SHOTS; else process.env.CC_PACK9_SHOTS = previous; }
  },
}));

export const skipped = (t: { skip: (message: string) => void }) => { if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return true; } return false; };
export const dialog = `(()=>{const m=document.querySelector("#confirmModal");return m&&!m.hidden?{title:m.querySelector("#confirmTitle").textContent,body:m.querySelector("#confirmBody").textContent,ok:m.querySelector("#confirmOk").textContent,cancel:m.querySelector("#confirmCancel").textContent}:null})()`;

// ---- helpers ----
let revision = 100;
export const sentOf = (ev: Page["ev"], type: string): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type===${J(type)})`);
// The server's state says the leader is replying (or not); `extra` is page code run on the tab first.
export const setActive = (ev: Page["ev"], tabId: string, active: boolean, extra = ""): Promise<boolean> => ev(`(()=>{const tab=window.__ccSeed.projects[0].tabs.find((t)=>t.id===${J(tabId)});tab.derived={...(tab.derived||{}),leaderTurnActive:${active}};${extra}__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});return true})()`);
export const typeAndEnter = (ev: Page["ev"], text: string): Promise<boolean> => ev(`(()=>{const ci=document.querySelector("#ci");ci.value=${J(text)};ci.dispatchEvent(new Event("input",{bubbles:true}));ci.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));return true})()`);
export const typeAndClick = (ev: Page["ev"], text: string): Promise<boolean> => ev(`(()=>{const ci=document.querySelector("#ci");ci.value=${J(text)};ci.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#sendBtn").click();return true})()`);
export const queueOf = (ev: Page["ev"]): Promise<{ text: string; go: string; off: boolean; why: string; files: string }[]> => ev(`[...document.querySelectorAll("#queue .qitem")].map((e)=>({text:e.querySelector(".qtext").firstChild.textContent,go:e.querySelector("[data-queue-go]").textContent,off:e.querySelector("[data-queue-go]").disabled,why:e.querySelector(".qwhy")?.textContent??"",files:e.querySelector(".qtext small")?.textContent??""}))`);
export const deliver = (ev: Page["ev"], message: unknown): Promise<boolean> => ev(`__ccDeliver(${J(message)});true`);
export const chatMsg = (ev: Page["ev"], tabId: string, role: string, text: string, extra: Record<string, unknown> = {}): Promise<boolean> => deliver(ev, { type: "chatMessage", tabId, role, text, at: Date.now(), revision: ++revision, ...extra });
export const goButton = (ev: Page["ev"], index: number): Promise<boolean> => ev(`document.querySelectorAll("#queue [data-queue-go]")[${index}].click();true`);
export const waitQueue = (waitFor: Page["waitFor"], count: number, label: string) => waitFor(`document.querySelectorAll("#queue .qitem").length===${count}`, label);
// Every upload's path as the server returned it, recorded by the page's own fetch (the independent measurement of "the exact uploaded path"). With hold=true an upload waits until releaseUploads.
export const watchUploads = (ev: Page["ev"], hold = false): Promise<boolean> => ev(`(()=>{const real=window.fetch.bind(window);window.__uploads=[];window.__held=[];window.fetch=(url,opts)=>{const route=String(url);if(!route.includes("/api/paste-"))return real(url,opts);const go=()=>real(url,opts).then((response)=>{response.clone().json().then((j)=>window.__uploads.push({kind:route.includes("paste-image")?"image":"file",path:j.path})).catch(()=>{});return response});return ${hold}?new Promise((ok,bad)=>window.__held.push(()=>go().then(ok,bad))):go()};return true})()`);
export const releaseUploads = (ev: Page["ev"]): Promise<boolean> => ev(`window.__held.splice(0).forEach((go)=>go());true`);
export const uploaded = (ev: Page["ev"], kind: string): Promise<string[]> => ev(`window.__uploads.filter((u)=>u.kind===${J(kind)}).map((u)=>u.path)`);
export const attach = (ev: Page["ev"], name: string, type: string): Promise<boolean> => ev(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(["data"],${J(name)},{type:${J(type)}}));const input=document.querySelector("#attachInput");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
export const transcriptDom = (ev: Page["ev"]): Promise<string[]> => ev(`[...document.querySelectorAll("#view .thread .msg")].map((e)=>(e.querySelector(".md")?.textContent??e.querySelector(".body")?.textContent??e.textContent).trim())`);
