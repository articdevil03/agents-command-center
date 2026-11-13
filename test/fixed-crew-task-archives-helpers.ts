import assert from "node:assert/strict";
import { J, click, deliver, deliverState, type Page } from "./pack18-editor-harness.ts";
export const HOSTILE = `</script></section><img src=x onerror="window.__pwned=1"> &lt;b&gt;bold&lt;/b&gt; & "quoted" 'single'`;
export const READS = ["listFixedTaskArchives", "getFixedTaskArchive"];
// What browsing may send: the two archive reads, plus the page's own task read and tab selection. Anything else (an approval, a launch,
// a chat message, a restore or delete) fails the test.
export const BROWSING = [...READS, "getFixedTask", "selectTab"];
export const count = (ev: Page["ev"]): Promise<number> => ev("window.__sent.length");
export const bare = ({ requestId, ...rest }: any) => rest;
export const summary = (task: any) => ({ taskId: task.id, planVersion: task.planVersion, detailRevision: task.recordRevision, stage: task.stage });
export async function onlyReads(ev: Page["ev"], from: number, what: string): Promise<void> {
  const other = (await ev(`window.__sent.slice(${from})`)).filter((message: any) => !BROWSING.includes(message.type));
  assert.deepEqual(other, [], `${what}: browsing finished tasks sent nothing but reads`);
}
// The newest archive read of `type` sent after `from`; FAILS when the page sent none.
export async function read(ev: Page["ev"], waitFor: Page["waitFor"], from: number, type: string): Promise<any> {
  await waitFor(`window.__sent.slice(${from}).some((m)=>m.type===${J(type)})`, `the page sent ${type}`);
  const message = await ev(`window.__sent.slice(${from}).filter((m)=>m.type===${J(type)}).at(-1)`);
  console.log(`FCARCH sent: ${JSON.stringify(message)}`);
  return message;
}
export const reads = async (ev: Page["ev"], from: number): Promise<any[]> => (await ev(`window.__sent.slice(${from})`)).filter((message: any) => READS.includes(message.type));
export const shown = (ev: Page["ev"]): Promise<any> => ev(`(()=>{const v=document.querySelector("#fixedView"),a=v.querySelector("section[data-fct-arch]"),more=v.querySelector('[data-fct-arch="more"]');
  return {entry:Boolean(v.querySelector('[data-fct-arch="open"]')),open:Boolean(a),rows:[...v.querySelectorAll('[data-fct-arch="row"]')].map((r)=>r.dataset.fctArchId),
  more:more?{label:more.textContent,disabled:more.disabled}:null,states:[...v.querySelectorAll("[data-fct-arch-state]")].map((e)=>e.dataset.fctArchState),
  focus:document.activeElement?.dataset?.fctKey??null,text:(a??v).innerText}})()`);
export async function openList(ev: Page["ev"], waitFor: Page["waitFor"]): Promise<any> {
  const from = await count(ev);
  await click(ev, '#fixedView [data-fct-arch="open"]');
  return read(ev, waitFor, from, "listFixedTaskArchives");
}
export const listReply = (request: any, items: any[], nextCursor: string | null) => ({ type: "fixedTaskArchives", requestId: request.requestId, tabId: request.tabId, items, nextCursor });
export const detailReply = (request: any, archive: any) => ({ type: "fixedTaskArchive", requestId: request.requestId, tabId: request.tabId, taskId: request.taskId, ...archive });
export const refusal = (request: any, message: string) => ({ type: "error", message, action: request.type, requestId: request.requestId, tabId: request.tabId });
export async function serveTask(ev: Page["ev"], waitFor: Page["waitFor"], state: any, task: any): Promise<void> {
  const from = await count(ev);
  await deliverState(ev, state, `state.projects[0].tabs.find((t)=>t.id===${J(task.tabId)}).fixedTask=${J(summary(task))}`);
  const request = await read(ev, waitFor, from, "getFixedTask");
  await deliver(ev, { type: "fixedTask", requestId: request.requestId, tabId: request.tabId, task });
}
