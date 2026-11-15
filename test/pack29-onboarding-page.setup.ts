// Helpers for test/pack29-onboarding-page.test.ts: the first-run screen driven through the real page with server states delivered by hand.
import assert from "node:assert/strict";
import { J, deliver, deliverState, type Page } from "./pack18-editor-harness.ts";

type Ev = Page["ev"];
export type Tools = Partial<Record<"claude" | "codex" | "opencode", [boolean | null, boolean | null]>>;

// A change (page code on `state`) that sets each named CLI's install and sign-in facts, keeping whatever else the server reported.
export const toolsChange = (tools: Tools): string => `state.settings.tools=state.settings.tools??{};${Object.entries(tools)
  .map(([cli, [installed, signedIn]]) => `state.settings.tools[${J(cli)}]={...(state.settings.tools[${J(cli)}]??{}),installed:${J(installed)},signedIn:${J(signedIn)}};`
    // The server fills settings.tools AND catalogTools together; the wizard reads OpenCode from catalogTools only (Pack 29 W6 O3).
    + (cli === "opencode" ? `state.settings.catalogTools=state.settings.catalogTools??{};state.settings.catalogTools.opencode={...(state.settings.catalogTools.opencode??{}),installed:${J(installed)},signedIn:${J(signedIn)},supportedVersion:${J(installed === true)},credentialSource:${J(signedIn === true ? "stored" : signedIn === false ? "none" : "unknown")}};` : "")).join("")}`;
// Every installable catalog tool other than the built-ins (Pack 29 B3), installed and saved but not allowed to lead: rows with no action
// and no Install by hand, so the wizard tests that are about the built-in rows keep their focus there. A test about the catalog rows
// delivers its own catalogTools after this (catalogChange).
export const CATALOG_QUIET = `for(const e of state.cliCatalog??[]){if(e.installable&&!['claude','codex','opencode'].includes(e.id))state.settings.catalogTools[e.id]={installed:true,version:'1.0.0',signedIn:true,registered:true,leaderEligible:false,connection:'unknown'};}`;
// Sets catalogTools facts by id (merged over what the state has), e.g. { grok: { installed: false } } or an install action.
export const catalogChange = (facts: Record<string, Record<string, unknown>>): string => Object.entries(facts)
  .map(([id, value]) => `state.settings.catalogTools[${J(id)}]={...(state.settings.catalogTools[${J(id)}]??{}),...${J(value)}};`).join("");
// The sign-in policy the server publishes per installable entry (Pack 29 W5: signIn.managed and signIn.unsupportedMessage), set here so
// the page tests do not depend on the server's current policy (that is proven in test/pack29-cli-login*.test.ts): managed hidden sign-in
// for Claude Code, Codex, Copilot and Grok, the static unsupported text for every other installable tool.
export const MANAGED = ["claude", "codex", "copilot", "grok"];
export const UNSUPPORTED = "This tool has no verified sign-in flow in Command Center yet.";
export const signInPolicy = (managed: string[] = MANAGED): string => `for(const e of state.cliCatalog??[]){if(!e.installable)continue;const m=${J(managed)}.includes(e.id);e.signIn={...(e.signIn??{}),managed:m,unsupportedMessage:m?null:${J(UNSUPPORTED)}};}`;
export const SIGNIN_POLICY = signInPolicy();
export const showFirstRun = (ev: Ev, seed: unknown, tools: Tools, extra = ""): Promise<boolean> => deliverState(ev, seed, `state.firstRun={required:true};${SIGNIN_POLICY}${toolsChange(tools)}${CATALOG_QUIET}${extra}`);

export const screen = (ev: Ev): Promise<Record<string, boolean>> => ev(`(()=>{const f=document.querySelector('#first');return {first:!f.hidden,frun:Boolean(f.querySelector('.frun')),
  stage:!document.querySelector('#stage').hidden,side:!document.querySelector('#side').hidden,bodyClass:document.body.classList.contains('first-run'),
  welcome:Boolean(f.querySelector('[data-first-project]')),strip:getComputedStyle(document.querySelector('#ptabs')).visibility!=='hidden'}})()`);
// The three built-in rows (the catalog's other rows: catalogRows in test/pack29-onboarding-catalog.test.ts).
export const rows = (ev: Ev): Promise<Array<{ cli: string; chip: string; state: string; actions: string[] }>> => ev(`[...document.querySelectorAll('#frunTools .frun-tool')].filter((r)=>['claude','codex','opencode'].includes(r.dataset.cli)).map((r)=>({cli:r.dataset.cli,
  chip:r.querySelector('.frun-chip').textContent,state:r.querySelector('.frun-chip').dataset.state,actions:[...r.querySelectorAll('button')].filter((b)=>!b.closest('[hidden]')).map((b)=>b.textContent)}))`);
export const startState = (ev: Ev): Promise<{ disabled: boolean; label: string; status: string; bad: boolean }> => ev(`(()=>{const b=document.querySelector('#frunStart'),s=document.querySelector('#frunStatus');
  return {disabled:b.disabled,label:b.textContent,status:s.textContent,bad:s.classList.contains('bad')}})()`);
// The wizard step on screen (exactly one section shown) and the footer: progress line, current mark, why Next is off, the visible buttons.
export const stepOf = (ev: Ev): Promise<string> => ev(`(()=>{const s=[...document.querySelectorAll('#first [data-step]')].filter((x)=>!x.hidden);return s.length===1?s[0].dataset.step:'shown:'+s.length})()`);
export const footer = (ev: Ev): Promise<{ count: string; current: string[]; why: string; buttons: string[]; nextDisabled: boolean | null }> => ev(`(()=>{const f=document.querySelector('#first .frun-foot');
  return {count:f.querySelector('#frunCount').textContent,current:[...f.querySelectorAll('[aria-current]')].map((m)=>m.dataset.mark+':'+m.getAttribute('aria-current')),why:f.querySelector('#frunWhy').textContent,
  buttons:[...f.querySelectorAll('button')].filter((b)=>!b.hidden).map((b)=>b.textContent),nextDisabled:f.querySelector('#frunNext').hidden?null:f.querySelector('#frunNext').disabled}})()`);
// Clicks the footer's Back until the named step shows; FAILS instead of looping when Back cannot get there.
export async function backTo(ev: Ev, id: string): Promise<void> {
  for (let i = 0; i < 4 && (await stepOf(ev)) !== id; i++) await ev(`(()=>{document.querySelector('#frunBack').click();return true})()`);
  assert.equal(await stepOf(ev), id, `Back reached the ${id} step`);
}
export const pickFolderAs =(ev: Ev, folder: string): Promise<boolean> => ev(`(()=>{window.cc.pickFolder=async()=>${J(folder)};return true})()`);
// Every message of a type the page sent after index `from`.
export const sentSince = (ev: Ev, type: string, from: number): Promise<any[]> => ev(`window.__sent.slice(${from}).filter((m)=>m.type===${J(type)})`);
export const sentCount = (ev: Ev): Promise<number> => ev("window.__sent.length");
// The server's answer to one request, as the real server words it (server/first-run/messages.ts, server/main/messages/index.ts).
export const answer = (ev: Ev, request: { type: string; requestId: string }, error?: string): Promise<boolean> =>
  deliver(ev, error ? { type: "error", message: error, action: request.type, requestId: request.requestId } : { type: "actionResult", action: request.type, requestId: request.requestId });
// Answers the screen's automatic tool check (sent once when it first shows with an unchecked tool), so Check again is free again.
export async function settleChecks(ev: Ev, from = 0): Promise<number> {
  const pending = await sentSince(ev, "refreshSettings", from);
  for (const request of pending) await answer(ev, request);
  return pending.length;
}
// One tool's "How to install" panel as a person sees it: the steps (each step's own words, without the command box), every command box,
// the notes, the Still-not-found line and the maker's address. FOUND is false when the row has no panel at all.
export type Guide = { found: boolean; expanded: string; shown: boolean; steps: string[]; boxIn: number[]; commands: string[]; shells: string[]; copyNames: string[]; notes: string[]; hint: string; page: string; copyAddress: string; text: string };
export const guide = (ev: Ev, cli: string): Promise<Guide> => ev(`(()=>{const b=document.querySelector('[data-frun-help=${J(cli)}]'),p=document.getElementById('frunHelp-'+${J(cli)});
  if(!p)return {found:false};const all=(s)=>[...p.querySelectorAll(s)];const lis=all('.frun-howto>li');
  return {found:true,expanded:b.getAttribute('aria-expanded'),shown:!p.hidden&&p.checkVisibility(),steps:lis.map((li)=>[...li.childNodes].filter((n)=>n.nodeType===3).map((n)=>n.textContent).join('')),
  boxIn:lis.map((li)=>li.querySelectorAll('.frun-cmd').length),commands:all('.frun-cmd pre code').map((c)=>c.textContent),shells:all('.frun-cmd-h>span').map((s)=>s.textContent),
  copyNames:all('[data-frun-copy-cmd]').map((c)=>c.getAttribute('aria-label')+' / '+c.textContent),notes:all('.frun-req').map((n)=>n.textContent),hint:p.querySelector('.frun-hint').textContent,
  page:p.querySelector('.frun-url code').textContent,copyAddress:p.querySelector('[data-frun-copy]').textContent,text:p.textContent}})()`);
// A clipboard the test can read and refuse, and a text-copy fallback it controls (the page tries the clipboard first, then execCommand).
export const stubClipboard = (ev: Ev): Promise<boolean> => ev(`(()=>{window.__copied=[];window.__refuse=false;window.__execOk=true;window.__execCalls=0;
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(v)=>{if(window.__refuse)throw new Error('refused');window.__copied.push(v);}}});
  document.execCommand=(name)=>{window.__execCalls++;return name==='copy'&&window.__execOk;};return true})()`);
// Opens exactly one install panel (or none), closing any other that is open.
export async function openOnly(ev: Ev, wanted: string | null): Promise<void> {
  for (const cli of ["claude", "codex", "opencode"]) {
    const open = await ev(`document.querySelector('[data-frun-help=${J(cli)}]')?.getAttribute('aria-expanded')==='true'`);
    if (open !== (cli === wanted)) await ev(`(()=>{document.querySelector('[data-frun-help=${J(cli)}]').click();return true})()`);
  }
}
// The overlap audit (AUDIT_JS loaded first) at the top, middle and bottom of the step body, plus: no sideways scroll, the screen itself
// never scrolls, the footer always in view.
export async function auditScrolled(ev: Ev, label: string, minControls: number): Promise<void> {
  const height = await ev(`(()=>{const s=document.querySelector('#first .frun-stage');return s.scrollHeight-s.clientHeight})()`);
  for (const at of [0, 0.5, 1]) {
    await ev(`(()=>{document.querySelector('#first .frun-stage').scrollTop=${Math.round(height * at)};return true})()`);
    const result = await ev(`window.__ov(${J(`${label} @${at}`)},"#first")`);
    assert.ok(result.found && result.texts >= 6 && result.controls >= minControls, `${label} @${at}: the audit read the screen (${result.texts} texts, ${result.controls} controls)`);
    assert.deepEqual(result.violations, [], `${label} @${at}: no overlap or clipped text`);
    const fit = await ev(`(()=>{const f=document.querySelector('#first'),s=f.querySelector('.frun-stage'),foot=f.querySelector('.frun-foot').getBoundingClientRect(),box=f.getBoundingClientRect();
      return {sideways:f.scrollWidth>f.clientWidth||s.scrollWidth>s.clientWidth,firstScrolls:f.scrollHeight>f.clientHeight,footerInView:foot.top>=box.top&&foot.bottom<=box.bottom+0.5&&foot.bottom<=innerHeight}})()`);
    assert.deepEqual(fit, { sideways: false, firstScrolls: false, footerInView: true }, `${label} @${at}: no sideways scroll, only the step body scrolls, the footer is in view`);
  }
  await ev(`(()=>{document.querySelector('#first .frun-stage').scrollTop=0;return true})()`);
}
export function expectRows(actual: Awaited<ReturnType<typeof rows>>, expected: Record<string, [string, string[]]>): void {
  assert.deepEqual(actual.map((row) => row.cli), ["claude", "codex", "opencode"], "three leader CLI rows, in order");
  for (const row of actual) assert.deepEqual([row.chip, row.actions], expected[row.cli], `${row.cli} row: chip and actions`);
}
