// Helpers for test/pack29-onboarding-page-acp.test.ts: the setup wizard's "other AI tools" parts, driven through the real page with
// server states delivered by hand (the server side is proven in test/pack29-first-run-acp.test.ts and test/pack17-acp-server.test.ts).
import assert from "node:assert/strict";
import { J, click, deliverState, type Page } from "./pack18-editor-harness.ts";
import { CATALOG_QUIET, SIGNIN_POLICY, pickFolderAs, showFirstRun, stepOf, toolsChange, type Tools } from "./pack29-onboarding-page.setup.ts";

type Ev = Page["ev"];
// A saved ACP tool as the server broadcasts it (server/main/broadcast.ts: the saved entry plus its kind).
export const acpTool = (name: string, program = "gemini", args = ["--acp"]) => {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { id, name, program, args, kind: `acp:${id}` };
};
export type AcpTool = ReturnType<typeof acpTool>;
export const acpChange = (list: AcpTool[]): string => `state.acpClis=${J(list)};`;
// The wizard shown with these built-in tool facts and these saved tools.
export const showWith = (ev: Ev, seed: unknown, tools: Tools, list: AcpTool[]): Promise<boolean> => showFirstRun(ev, seed, tools, acpChange(list));
// A broadcast that keeps the wizard and changes nothing the person typed (the tool facts and saved tools stay the same).
export const broadcastAgain = (ev: Ev, seed: unknown, tools: Tools, list: AcpTool[]): Promise<boolean> => deliverState(ev, seed, `state.firstRun={required:true};${SIGNIN_POLICY}${toolsChange(tools)}${CATALOG_QUIET}${acpChange(list)}`);

// From Welcome to the AI tool step with a folder chosen; FAILS when a step does not open.
export async function toToolStep(ev: Ev, folder: string): Promise<void> {
  if ((await stepOf(ev)) === "welcome") await click(ev, "#frunNext");
  assert.equal(await stepOf(ev), "folder");
  await pickFolderAs(ev, folder); await click(ev, "#frunBrowse");
  for (let i = 0; i < 20 && !(await ev(`document.querySelector('#frunPath').textContent===${J(folder)}`)); i++) await new Promise((r) => setTimeout(r, 25));
  await click(ev, "#frunNext");
  assert.equal(await stepOf(ev), "tools", `the AI tool step opened (why Next is off: ${J(await ev(`document.querySelector('#frunWhy').textContent`))}, page errors: ${J(await ev("window.__ccErrors"))})`);
}
// The added tools' rows: name, chip, the line under the name, and every word on the row.
export const acpRows = (ev: Ev): Promise<Array<{ kind: string; name: string; chip: string; line: string; text: string }>> => ev(`[...document.querySelectorAll('#frunAcpRows .frun-acp')].map((r)=>({kind:r.dataset.acp,
  name:r.querySelector('b').textContent,chip:r.querySelector('.frun-chip').textContent,line:r.querySelector('small').textContent,text:r.textContent}))`);
// The leader choices on the tool step: [value, checked].
export const leaderChoices = (ev: Ev): Promise<Array<[string, boolean]>> => ev(`[...document.querySelectorAll('#frunLeader input[name=frunLeader]')].map((r)=>[r.value,r.checked])`);
// The Add form and the Full access tick, as a person sees them.
export const form = (ev: Ev): Promise<{ open: boolean; expanded: string; name: string; command: string; button: string; busy: string; message: string; bad: boolean; consentShown: boolean; consent: boolean }> => ev(`(()=>{const q=(id)=>document.getElementById(id);
  return {open:!q('frunOther').hidden,expanded:q('frunOtherToggle').getAttribute('aria-expanded'),name:q('frunAcpName').value,command:q('frunAcpCmd').value,button:q('frunAcpAdd').textContent,busy:q('frunAcpAdd').getAttribute('aria-disabled'),
  message:q('frunAcpMsg').textContent,bad:q('frunAcpMsg').classList.contains('bad'),consentShown:!q('frunConsentBox').hidden&&q('frunConsentBox').checkVisibility(),consent:q('frunConsent').checked}})()`);
// Types into a field the way a person does (focus, value, input event).
export const typeInto = (ev: Ev, id: string, value: string): Promise<boolean> => ev(`(()=>{const el=document.getElementById(${J(id)});el.focus();el.value=${J(value)};el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
export const activeId = (ev: Ev): Promise<string> => ev(`(()=>{const a=document.activeElement;return a.id||a.dataset.focusKey||a.tagName})()`);
// Opens the "Use a different AI tool" form when it is closed.
export async function openForm(ev: Ev): Promise<void> {
  if ((await form(ev)).open) return;
  await click(ev, "#frunOtherToggle");
  assert.equal((await form(ev)).open, true, "the Add form opened");
}
