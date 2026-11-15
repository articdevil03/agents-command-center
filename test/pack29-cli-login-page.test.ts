import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver } from "./pack18-editor-harness.ts";
import { AUDIT_JS } from "./overlap-audit-js.ts";
import { auditScrolled, catalogChange, footer, sentCount, sentSince, showFirstRun as rawShowFirstRun, signInPolicy, stepOf, UNSUPPORTED } from "./pack29-onboarding-page.setup.ts";
import { acpChange, leaderChoices, toToolStep } from "./pack29-onboarding-page-acp.setup.ts";

// Pack 29 W5 U1: signing in to an AI tool with no terminal, on the real page (real scripts and CSS, a state from a real server, then
// states, private sign-in events and answers delivered by hand through the page's stub socket). The server side (hidden process, address
// and code checks, paste delivery) is proven in test/pack29-cli-login*.test.ts; these prove what the page shows, EXACTLY what it sends
// (ids only, the frozen contract), and that a pasted code and the sign-in capability never stay anywhere on the page.
// Match O1's authoritative catalog facts when older tool fixtures set built-in status.
const showFirstRun: typeof rawShowFirstRun = (ev, seed, tools, extra = "") => rawShowFirstRun(ev, seed, tools,
  (tools.opencode ? catalogChange({ opencode: { installed: tools.opencode[0], signedIn: tools.opencode[1] } }) : "") + extra);
const FOLDER = "C:\\work\\My App";
const CLAUDE_SIGNIN = { claude: [true, false], codex: [true, true], opencode: [false, null] } as const;
const NONE_READY = { claude: [false, null], codex: [false, null], opencode: [false, null] } as const;
const URL1 = "https://claude.com/cai/oauth/authorize?code=true&client_id=test-client&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code_challenge_method=S256&state=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CODE1 = "TEST-AB12C";
const SECRET = "synthetic-pasted-code-7f3a9c41";
const LOGIN_ID = "capability-0123456789abcdef";
const UNTESTED = "Not tested yet. Connection checked when you first chat.";
// The contract's static words per reason, written out by hand from the brief (independent of public/first-run/login.js).
const FAILED: Record<string, string> = {
  existingCredentials: "A credential is already saved.",
  unsupported: "This tool has no verified sign-in flow in Command Center yet.", notInstalled: "Install the tool first.",
  installationUnknown: "Could not confirm the installation.", busy: "Another installation or sign-in is running.", launchFailed: "Could not start sign-in.",
  unsafeOutput: "The tool returned unsupported sign-in information.", outputLimit: "The tool returned unsupported sign-in information.",
  cancelled: "Sign-in stopped.", timeout: "Sign-in expired. Try again.", notSignedIn: "Sign-in did not finish. Try again.", loginFailed: "Sign-in did not finish. Try again.",
};
const NEVER_SAY = /\bpaid\b|\bfree\b|powershell|terminal/i;

type Ev = (expression: string) => Promise<any>;
// One tool's sign-in panel as a person sees it (only what is on screen counts).
const panel = (ev: Ev, cli: string, scope = "#first"): Promise<any> => ev(`(()=>{const p=document.querySelector(${J(`${scope} [data-cli="${cli}"] .cli-login`)});if(!p)return {found:false};
  const v=(s)=>{const e=p.querySelector(s);return e&&e.checkVisibility()?e:null};const i=p.querySelector('input');
  return {found:true,shown:!p.hidden&&p.checkVisibility(),state:p.dataset.state,status:p.querySelector('.cli-login-status').textContent,live:p.querySelector('.cli-login-status').getAttribute('aria-live'),
  bad:p.querySelector('.cli-login-status').classList.contains('bad'),bar:Boolean(v('.cli-login-bar')),buttons:[...p.querySelectorAll('button')].filter((b)=>b.checkVisibility()).map((b)=>b.textContent),
  addr:v('.cli-login-addr')?.textContent??null,code:v('.cli-login-code')?v('.cli-login-code .cli-login-l').textContent+' '+v('.cli-login-big').textContent:null,
  paste:Boolean(v('.cli-login-paste')),label:p.querySelector('.cli-login-paste label').textContent,input:{type:i.type,autocomplete:i.getAttribute('autocomplete'),disabled:i.disabled,value:i.value,labelled:i.labels[0]?.textContent}}})()`);
const rowOf = (ev: Ev, cli: string): Promise<{ chip: string; detail: string; buttons: string[]; disabled: boolean[]; note: string | null }> => ev(`(()=>{const r=document.querySelector('#frunTools [data-cli=${J(cli)}]');const bs=[...r.querySelector('.tool-row-action').querySelectorAll('button')];
  return {chip:r.querySelector('.frun-chip').textContent,detail:r.querySelector('.frun-detail').textContent,buttons:bs.map((b)=>b.textContent),disabled:bs.map((b)=>b.disabled),note:r.querySelector('.frun-signin-note')?.textContent??null}})()`);
const loginEvent = (requestId: string, over: Record<string, unknown> = {}) => ({ type: "cliLoginState", cli: "claude", loginRequestId: requestId, loginId: LOGIN_ID, revision: 1, status: "running",
  phase: "waitingBrowser", reason: null, verificationUrl: URL1, deviceCode: null, pasteRequired: false, expiresAt: Date.now() + 600_000, ...over });
const shared = (requestId: string, status: string, phase: string | null, reason: string | null = null, cli = "claude") => catalogChange({ [cli]: { action: { requestId, kind: "login", status, phase, reason, message: "" } } });
const keys = (message: Record<string, unknown>) => Object.keys(message).sort();
// Everywhere a secret could stay: the DOM (markup, attributes, field values), both storages, every message sent but the allowed ones, and
// Settings' draft and focus snapshots. Returns where it was found.
const leaks = (ev: Ev, needle: string, allowedSent: number[] = [], fields = true): Promise<string[]> => ev(`(()=>{const n=${J(needle)},w=[],ok=${J(allowedSent)};
  if(document.documentElement.outerHTML.includes(n))w.push('dom');
  for(const el of document.querySelectorAll('*'))for(const a of el.attributes)if(a.value.includes(n))w.push('attr:'+a.name);
  if(${fields})for(const el of document.querySelectorAll('input,textarea'))if(el.value.includes(n))w.push('value:'+(el.id||el.name||el.type));
  for(const s of [localStorage,sessionStorage])for(let i=0;i<s.length;i++){const k=s.key(i);if(k.includes(n)||String(s.getItem(k)).includes(n))w.push('storage:'+k)}
  window.__sent.forEach((m,i)=>{if(!ok.includes(i)&&JSON.stringify(m).includes(n))w.push('sent:'+i+':'+m.type)});
  const b=document.querySelector('#setBody');if(JSON.stringify([...settingsDraftSnapshot(b)]).includes(n))w.push('draft');if(JSON.stringify(settingsFocusSnapshot(b)).includes(n))w.push('focus');return w})()`);
const shownText = (ev: Ev): Promise<string> => ev(`(document.querySelector('#first').innerText||'')+' '+(document.querySelector('#setModal').hidden?'':document.querySelector('#setModal').innerText)`);
// Wizard, Claude Code installed but not signed in, on the AI tool step; Sign in clicked. Returns the cliLogin message.
async function startClaude(ev: Ev, seed: unknown, extra = ""): Promise<any> {
  await showFirstRun(ev, seed, CLAUDE_SIGNIN, extra);
  await toToolStep(ev, FOLDER);
  const mark = await sentCount(ev);
  await click(ev, '[data-frun-login="claude"]');
  const sent = await sentSince(ev, "cliLogin", mark);
  assert.equal(sent.length, 1, "one click, one cliLogin");
  return sent[0];
}
const typeCode = (ev: Ev, scope: string, code: string) => ev(`(()=>{const i=document.querySelector(${J(`${scope} [data-cli="claude"] .cli-login input`)});i.focus();i.value=${J(code)};i.dispatchEvent(new Event('input',{bubbles:true}));window.__input=i;return true})()`);

test("P29 O3 OpenCode offers managed key sign-in while other managed tools keep their sign-in controls", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    await showFirstRun(ev, seed, { claude: [true, false], codex: [true, true], opencode: [true, false] } as const, signInPolicy(["claude", "codex", "opencode", "copilot", "grok"]) + catalogChange({ opencode: { installed: true, signedIn: false, supportedVersion: true, credentialSource: "none" } }));
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await toToolStep(ev, FOLDER);
    const opencode = await rowOf(ev, "opencode");
    assert.deepEqual([opencode.chip, opencode.detail, opencode.buttons, opencode.note], ["Not signed in", "Found, but not signed in.", ["Sign in"], null], "OpenCode: managed Sign in");
    assert.deepEqual([(await rowOf(ev, "claude")).chip, (await rowOf(ev, "claude")).buttons], ["Sign in needed", ["Sign in"]], "a managed tool keeps its promise and its button");
  });
});

test("P29 U1 Sign in: exactly {type, requestId, cli}; forced clicks on unmanaged, missing, signed-in or busy tools send nothing; the step is held and Cancel names the sign-in", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    const facts = catalogChange({ kimi: { installed: true, signedIn: false, registered: true, leaderEligible: false }, copilot: { installed: true, signedIn: false, registered: false, leaderEligible: false } });
    await showFirstRun(ev, seed, CLAUDE_SIGNIN, facts);
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await toToolStep(ev, FOLDER);
    assert.deepEqual(await rowOf(ev, "claude"), { chip: "Sign in needed", detail: "Found, but not signed in.", buttons: ["Sign in"], disabled: [false], note: null }, "a managed tool: Sign in");
    assert.deepEqual([(await rowOf(ev, "kimi")).buttons, (await rowOf(ev, "kimi")).note], [[], UNSUPPORTED], "an unmanaged tool: its own words, no Sign in");
    // A stale or forged button still goes through the real click handler's guard: unmanaged, signed in and not installed send nothing.
    const forced = (cli: string) => ev(`(()=>{const b=document.createElement('button');b.dataset.frunLogin=${J(cli)};document.querySelector('#frunTools').appendChild(b);b.click();b.remove();return true})()`);
    let mark = await sentCount(ev);
    for (const cli of ["kimi", "codex", "opencode", "qwen"]) await forced(cli);
    assert.deepEqual(await sentSince(ev, "cliLogin", mark), [], "forced Sign in on kimi (unmanaged), codex (signed in), opencode (missing), qwen (unmanaged) sends nothing");
    mark = await sentCount(ev);
    await click(ev, '[data-frun-login="claude"]');
    const [sent] = await sentSince(ev, "cliLogin", mark);
    assert.deepEqual(keys(sent), ["cli", "requestId", "type"], `exactly three keys, nothing else (${J(sent)})`);
    assert.deepEqual([sent.type, sent.cli, typeof sent.requestId === "string" && sent.requestId.length >= 16], ["cliLogin", "claude", true], "type, the row's own tool, a fresh request id");
    assert.deepEqual(await rowOf(ev, "claude"), { chip: "Signing in", detail: "Signing in…", buttons: ["Signing in…"], disabled: [true], note: null }, "the row is signing in");
    const p = await panel(ev, "claude");
    assert.deepEqual([p.shown, p.status, p.buttons, p.bar, p.live], [true, "Starting sign-in…", ["Cancel"], true, "polite"], "the panel: starting, an indeterminate bar, Cancel, a live status");
    // One at a time: Copilot's Sign in is off, a forced click sends nothing, Install is off; the step cannot be left.
    assert.deepEqual((await rowOf(ev, "copilot")).disabled, [true], "another tool's Sign in is off while one runs");
    mark = await sentCount(ev); await forced("copilot"); await forced("claude");
    assert.deepEqual(await sentSince(ev, "cliLogin", mark), [], "nothing more while a sign-in runs");
    assert.equal(await ev(`document.querySelector('[data-frun-install="opencode"]').disabled`), true, "Install waits for the sign-in");
    const held = await footer(ev);
    assert.deepEqual([held.nextDisabled, held.why, await ev(`[document.querySelector('#frunBack').disabled,document.querySelector('#frunSkip').disabled]`)], [true, "Wait for sign-in to finish, or press Cancel.", [true, true]], "the step is held");
    // Cancel: names the sign-in's own public id, once.
    mark = await sentCount(ev);
    await click(ev, '#frunTools [data-cli="claude"] [data-login-act="cancel"]');
    await click(ev, '#frunTools [data-cli="claude"] [data-login-act="cancel"]');
    const cancels = await sentSince(ev, "cancelCliLogin", mark);
    assert.equal(cancels.length, 1, "a second press while stopping sends nothing");
    assert.deepEqual({ ...cancels[0], requestId: "id" }, { type: "cancelCliLogin", requestId: "id", cli: "claude", loginRequestId: sent.requestId }, "Cancel: ids only");
    assert.deepEqual([(await panel(ev, "claude")).status, (await panel(ev, "claude")).buttons], ["Stopping sign-in…", ["Stopping…"]], "stopping");
    await showFirstRun(ev, seed, CLAUDE_SIGNIN, facts + shared(sent.requestId, "failed", null, "cancelled"));
    assert.deepEqual([(await panel(ev, "claude")).status, (await panel(ev, "claude")).buttons, (await rowOf(ev, "claude")).buttons], [FAILED.cancelled, [], ["Sign in"]], "stopped: its words, Sign in again");
    assert.equal((await footer(ev)).why, "", "the step is free again");
  }, { fixture: "fixed" });
});

test("P29 U1 sign-in steps: browser address and device code as text, Open sends ids only, the paste box sends once then is empty and off, the code and the capability stay nowhere; verifying; done", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed }) => {
    await ev(`(()=>{window.__opened=0;window.open=()=>{window.__opened++;return null};return true})()`);
    const sent = await startClaude(ev, seed);
    const id = sent.requestId, running = shared(id, "running", "starting");
    await showFirstRun(ev, seed, CLAUDE_SIGNIN, running);
    // An event for another sign-in is ignored.
    await deliver(ev, loginEvent("someone-else", { deviceCode: CODE1 }));
    assert.equal((await panel(ev, "claude")).status, "Starting sign-in…", "another sign-in's event changes nothing");
    await deliver(ev, loginEvent(id, { deviceCode: CODE1 }));
    let p = await panel(ev, "claude");
    assert.deepEqual([p.status, p.addr, p.code, p.buttons], ["Finish signing in in your browser.", URL1, `Enter this code on the page: ${CODE1}`, ["Open sign-in page", "Copy address", "Copy code", "Cancel"]], "waiting for the browser");
    let mark = await sentCount(ev);
    await click(ev, '#frunTools [data-cli="claude"] [data-login-act="open"]');
    const [open] = await sentSince(ev, "openCliLogin", mark);
    assert.deepEqual({ ...open, requestId: "id" }, { type: "openCliLogin", requestId: "id", cli: "claude", loginId: LOGIN_ID }, "Open sign-in page: ids only, never the address");
    assert.deepEqual(await ev(`[window.__opened,document.querySelectorAll('#first a[href]').length]`), [0, 0], "the page never opens or links the address itself");
    // Server-supplied text is only ever text: markup in an address or code stays inert; an address that is not https is not shown.
    const XSS_CODE = `<img src=x onerror="window.__xss=1">`, XSS_URL = `https://claude.com/x?<img src=x onerror=window.__xss=2>`;
    await deliver(ev, loginEvent(id, { revision: 2, verificationUrl: XSS_URL, deviceCode: XSS_CODE }));
    p = await panel(ev, "claude");
    assert.deepEqual([p.addr, p.code, await ev(`[document.querySelectorAll('.cli-login img').length,window.__xss??null]`)], [XSS_URL, `Enter this code on the page: ${XSS_CODE}`, [0, null]], "rendered inert, as text nodes");
    await deliver(ev, loginEvent(id, { revision: 3, verificationUrl: "http://claude.com/login", deviceCode: null }));
    assert.deepEqual([(await panel(ev, "claude")).addr, (await panel(ev, "claude")).buttons], [null, ["Cancel"]], "an address that is not https is never shown or opened");
    // The browser could not open: the sign-in goes on, the address stays.
    await deliver(ev, loginEvent(id, { revision: 4, reason: "browserUnavailable" }));
    p = await panel(ev, "claude");
    assert.deepEqual([p.status, p.bad, p.addr], ["Could not open the browser. Copy the address below.", true, URL1], "browserUnavailable keeps the address");
    // The paste box: a password field without autocomplete, typed text survives a redraw of the rows, focus stays on it.
    await deliver(ev, loginEvent(id, { revision: 5, phase: "waitingCode", pasteRequired: true }));
    p = await panel(ev, "claude");
    assert.deepEqual([p.paste, p.input, p.label], [true, { type: "password", autocomplete: "off", disabled: false, value: "", labelled: "Paste the code from the website" }, "Paste the code from the website"], "the paste box");
    await typeCode(ev, "#frunTools", SECRET);
    assert.deepEqual(await leaks(ev, SECRET, [], false), [], "while typed: the code is only in its own box");
    await showFirstRun(ev, seed, CLAUDE_SIGNIN, running + catalogChange({ grok: { version: "2.0.0" } }));
    assert.deepEqual(await ev(`[document.activeElement===window.__input,window.__input.isConnected,window.__input.value===${J(SECRET)}]`), [true, true, true], "the same box keeps the typed code and focus through a broadcast");
    mark = await sentCount(ev);
    await click(ev, '#frunTools [data-cli="claude"] [data-login-act="send"]');
    p = await panel(ev, "claude");
    assert.deepEqual([p.input.value, p.input.disabled], ["", true], "sent: the box is empty and off at once");
    await ev(`(()=>{const i=window.__input;i.disabled=false;i.value='x2';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`);
    const submits = await sentSince(ev, "submitCliLoginCode", mark);
    assert.equal(submits.length, 1, "one code per waiting prompt (a forced second Enter sends nothing)");
    assert.deepEqual({ ...submits[0], requestId: "id" }, { type: "submitCliLoginCode", requestId: "id", cli: "claude", loginId: LOGIN_ID, code: SECRET }, "exactly the contract's keys");
    const index = await ev(`window.__sent.findIndex((m)=>m.type==='submitCliLoginCode')`);
    assert.deepEqual(await leaks(ev, SECRET, [index]), [], "the code is nowhere but its one message");
    const capabilityUses = await ev(`window.__sent.map((m,i)=>['openCliLogin','submitCliLoginCode','getCliLoginState'].includes(m.type)?i:-1).filter((i)=>i>=0)`);
    assert.deepEqual(await leaks(ev, LOGIN_ID, capabilityUses), [], "the capability is in no DOM, storage, snapshot or other message");
    // Checking, then done: the row says Ready from the state, the panel goes, the step is free.
    await deliver(ev, loginEvent(id, { revision: 6, phase: "verifying", pasteRequired: false }));
    p = await panel(ev, "claude");
    assert.deepEqual([p.status, p.paste, p.addr, p.buttons], ["Checking that you are signed in…", false, null, ["Cancel"]], "verifying");
    await showFirstRun(ev, seed, { ...CLAUDE_SIGNIN, claude: [true, true] }, shared(id, "done", null));
    assert.deepEqual([(await panel(ev, "claude")).shown, (await rowOf(ev, "claude")).chip, (await rowOf(ev, "claude")).buttons, (await footer(ev)).why], [false, "Ready", [], ""], "done");
  }, { fixture: "fixed" });
});

test("P29 U1 every static reason, Stop again, statusUnknown, a reloaded page (only Cancel, by the public id) and a reconnect (asks again with the capability)", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed, reload }) => {
    const texts: string[] = [];
    await showFirstRun(ev, seed, CLAUDE_SIGNIN);
    await toToolStep(ev, FOLDER);
    for (const [reason, text] of Object.entries(FAILED)) {
      await showFirstRun(ev, seed, CLAUDE_SIGNIN, shared(`r-${reason}`, "failed", null, reason));
      const p = await panel(ev, "claude");
      assert.deepEqual([p.shown, p.status, p.bad, p.buttons], [true, text, true, []], `${reason}: its static words`);
      texts.push(await shownText(ev));
    }
    await showFirstRun(ev, seed, CLAUDE_SIGNIN, shared("r-unknown", "done", null, "statusUnknown"));
    assert.deepEqual([(await panel(ev, "claude")).status, (await panel(ev, "claude")).bad], ["Sign-in command finished. Connection will be checked when you first chat.", false], "statusUnknown");
    await showFirstRun(ev, seed, CLAUDE_SIGNIN, shared("r-stuck", "failed", null, "cleanupUnconfirmed"));
    let p = await panel(ev, "claude");
    assert.deepEqual([p.status, p.buttons, (await rowOf(ev, "claude")).chip, (await footer(ev)).why], ["Could not confirm sign-in stopped.", ["Stop again"], "Not confirmed", "Stop the sign-in before you go on."], "cleanup not confirmed: Stop again, held");
    let mark = await sentCount(ev);
    await click(ev, '#frunTools [data-cli="claude"] [data-login-act="stop"]');
    assert.deepEqual((await sentSince(ev, "cancelCliLogin", mark)).map((m: any) => [m.cli, m.loginRequestId]), [["claude", "r-stuck"]], "Stop again names the stuck sign-in");
    texts.push(await shownText(ev));
    // A reload loses the capability: only the shared summary is left, so only Cancel, by the public id.
    await reload();
    await showFirstRun(ev, seed, CLAUDE_SIGNIN, shared("srv-login-1", "running", "waitingBrowser"));
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND after the reload");
    assert.equal(await stepOf(ev), "tools", "a reloaded page opens on the held AI tool step");
    p = await panel(ev, "claude");
    assert.deepEqual([p.status, p.buttons, p.addr, (await rowOf(ev, "claude")).buttons], ["Sign-in is already running. Cancel to start again.", ["Cancel"], null, ["Signing in…"]], "after a reload");
    texts.push(await shownText(ev));
    mark = await sentCount(ev);
    await click(ev, '#frunTools [data-cli="claude"] [data-login-act="cancel"]');
    assert.deepEqual((await sentSince(ev, "cancelCliLogin", mark)).map((m: any) => keys(m).join() + "|" + m.loginRequestId), ["cli,loginRequestId,requestId,type|srv-login-1"], "Cancel by the public id");
    assert.deepEqual(await sentSince(ev, "getCliLoginState", 0), [], "no capability, so nothing to ask for");
    // A new sign-in, then the connection drops: the new connection asks for its details again with the capability.
    await showFirstRun(ev, seed, CLAUDE_SIGNIN, shared("srv-login-1", "failed", null, "cancelled"));
    mark = await sentCount(ev);
    await click(ev, '[data-frun-login="claude"]');
    const [sent] = await sentSince(ev, "cliLogin", mark);
    await deliver(ev, loginEvent(sent.requestId));
    await showFirstRun(ev, seed, CLAUDE_SIGNIN, shared(sent.requestId, "running", "waitingBrowser"));
    assert.deepEqual(await sentSince(ev, "getCliLoginState", 0), [], "same connection: nothing to ask");
    await ev(`(()=>{window.__socket.close();return true})()`);
    await waitFor(`window.__sent.some((m)=>m.type==='getCliLoginState')`, "the page asked again after reconnecting", 8000);
    const [again] = await sentSince(ev, "getCliLoginState", 0);
    assert.deepEqual({ ...again, requestId: "id" }, { type: "getCliLoginState", requestId: "id", cli: "claude", loginId: LOGIN_ID }, "getCliLoginState: the contract's keys");
    for (const text of texts) assert.doesNotMatch(text, NEVER_SAY, `no paid, free, PowerShell or terminal wording: ${text.slice(0, 120)}`);
  }, { fixture: "fixed" });
});

test("P29 U1 every real catalog row: managed tools offer Sign in, unmanaged show their words and NO Sign in, provider rows unchanged; Settings lists every installable tool with the same controls and keeps a typed code out of its snapshots", { timeout: editorTestMs(240_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    const installable = (seed.cliCatalog ?? []).filter((e: any) => e.installable).map((e: any) => e.id);
    const providers = (seed.cliCatalog ?? []).filter((e: any) => !e.installable).map((e: any) => e.id);
    assert.ok(installable.length > 0 && providers.length > 0, `control: the real catalog has tools (${installable.length}) and models (${providers.length}); an empty list fails`);
    const extra = installable.filter((id: string) => !["claude", "codex", "opencode"].includes(id));
    const allSignedOut = catalogChange({ opencode: { installed: true, signedIn: false, version: "1.0.0", supportedVersion: true, credentialSource: "none" }, ...Object.fromEntries(extra.map((id: string) => [id, { installed: true, signedIn: false, version: "1.0.0", registered: true, leaderEligible: false }])) })
      + `if(state.settings.tools.gemini)state.settings.tools.gemini={...state.settings.tools.gemini,installed:true,signedIn:false};`;
    const out = { claude: [true, false], codex: [true, false], opencode: [true, false] } as const;
    const texts: string[] = [];
    for (const managed of [installable, []]) {
      await showFirstRun(ev, seed, out, allSignedOut + signInPolicy(managed));
      await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
      if ((await stepOf(ev)) !== "tools") await toToolStep(ev, FOLDER);
      let walked = 0;
      for (const id of installable) {
        const r = await rowOf(ev, id);
        if (managed.length) assert.deepEqual([r.buttons, r.note], [["Sign in"], null], `${id}: managed, so Sign in`);
        else assert.deepEqual([r.buttons.includes("Sign in"), r.note, await ev(`Boolean(document.querySelector('[data-frun-login=${J(id)}]'))`)], [false, UNSUPPORTED, false], `${id}: unmanaged, its words and no Sign in`);
        walked += 1;
      }
      for (const id of providers) assert.deepEqual(await ev(`[...document.querySelectorAll('#frunProviders [data-provider=${J(id)}] button')].length`), 0, `${id}: a model row, no button`);
      assert.equal(walked, installable.length, "every installable entry walked");
      texts.push(await shownText(ev));
    }
    // Settings: every installable tool, the built-ins first, each with the shared controls.
    await showFirstRun(ev, seed, out, allSignedOut + signInPolicy() + "state.firstRun={required:false};");
    await ev(`(()=>{openSettings(undefined,'tools');return true})()`);
    await waitFor(`!document.querySelector('#setModal').hidden&&Boolean(document.querySelector('#s-tools [data-tool-row]'))`, "Settings AI tools FOUND");
    const listed = await ev(`[...document.querySelectorAll('#s-tools [data-tool-row]')].map((r)=>r.dataset.cli)`);
    assert.deepEqual(listed, ["claude", "codex", "opencode", ...extra], "Settings lists every installable catalog tool");
    for (const id of installable) {
      const row = await ev(`(()=>{const r=document.querySelector('#s-tools [data-tool-row][data-cli=${J(id)}]');return {signIn:Boolean(r.querySelector('[data-setting-action="login-cli"]')),note:r.querySelector('[data-tool-signin-note]')?.textContent??null}})()`);
      assert.deepEqual(row, ["claude", "codex", "copilot", "grok"].includes(id) ? { signIn: true, note: null } : { signIn: false, note: UNSUPPORTED }, `Settings ${id}`);
    }
    let mark = await sentCount(ev);
    await click(ev, '#s-tools [data-setting-action="login-cli"][data-cli="claude"]');
    const [sent] = await sentSince(ev, "cliLogin", mark);
    assert.deepEqual(keys(sent), ["cli", "requestId", "type"], "Settings Sign in: exactly the three keys");
    await deliver(ev, loginEvent(sent.requestId, { phase: "waitingCode", pasteRequired: true }));
    const p = await panel(ev, "claude", "#s-tools");
    assert.deepEqual([p.shown, p.paste, p.addr], [true, true, URL1], "the same panel in Settings");
    await typeCode(ev, "#s-tools", SECRET);
    // Settings redraws everything on every broadcast: the box is the same element, keeps the code and focus, and no snapshot copies it.
    await showFirstRun(ev, seed, out, allSignedOut + signInPolicy() + "state.firstRun={required:false};" + shared(sent.requestId, "running", "waitingCode"));
    assert.deepEqual(await ev(`[document.activeElement===window.__input,window.__input.isConnected,window.__input.value===${J(SECRET)}]`), [true, true, true], "Settings keeps the box, its code and focus");
    assert.deepEqual(await leaks(ev, SECRET, [], false), [], "no Settings snapshot, attribute or message holds the typed code");
    mark = await sentCount(ev);
    await ev(`(()=>{window.__input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`);
    assert.equal((await sentSince(ev, "submitCliLoginCode", mark)).length, 1, "Enter sends it once");
    const index = await ev(`window.__sent.findIndex((m)=>m.type==='submitCliLoginCode')`);
    assert.deepEqual(await leaks(ev, SECRET, [index]), [], "after sending: nowhere");
    texts.push(await shownText(ev));
    for (const text of texts) assert.doesNotMatch(text, NEVER_SAY, `no paid, free, PowerShell or terminal wording: ${text.slice(0, 120)}`);
  }, { fixture: "fixed" });
});

test("P29 U1 an installed catalog ACP tool may lead: Not tested yet (never Ready), never chosen by itself, chosen with the Full access tick, cleared when the leader changes", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    const kimi = seed.cliCatalog.find((e: any) => e.id === "kimi");
    const saved = { id: kimi.leader.connectionId, name: "Command Center Kimi Code", program: "kimi", args: ["acp"], kind: `acp:${kimi.leader.connectionId}`, leaderEligible: true, tested: false, leaderLabel: "Not tested yet" };
    const kimiOnly = catalogChange({ kimi: { installed: true, version: "1.0.0", signedIn: null, registered: true, leaderEligible: true, tested: false, leaderLabel: "Not tested yet" } }) + acpChange([saved as any]);
    await showFirstRun(ev, seed, NONE_READY, kimiOnly);
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await toToolStep(ev, FOLDER);
    const r = await rowOf(ev, "kimi");
    assert.deepEqual([r.chip, r.detail], ["Not tested yet", UNTESTED], "the row never says Ready");
    assert.deepEqual(await leaderChoices(ev), [[saved.kind, false]], "a choice, never chosen by itself");
    assert.deepEqual([(await footer(ev)).nextDisabled, (await footer(ev)).why], [true, "Choose which tool leads."]);
    await click(ev, `#frunLeader input[value="${saved.kind}"]`);
    assert.deepEqual(await ev(`[[...document.querySelectorAll('#frunLeader .frun-opt .frun-tag')].map((t)=>t.textContent),document.querySelector('#frunLeader .frun-untested-note')?.textContent]`), [["Full access", "Not tested yet"], UNTESTED], "the choice says Full access and Not tested yet");
    assert.equal((await footer(ev)).why, "Tick the Full access box to use Command Center Kimi Code.");
    await click(ev, "#frunConsent");
    assert.equal((await footer(ev)).nextDisabled, false, "ticked: Next");
    // A change of leader clears the tick (Claude Code becomes Ready and is picked).
    await showFirstRun(ev, seed, { ...NONE_READY, claude: [true, true] }, kimiOnly);
    await click(ev, '#frunLeader input[value="claude"]');
    await click(ev, `#frunLeader input[value="${saved.kind}"]`);
    assert.deepEqual([await ev(`document.querySelector('#frunConsent').checked`), (await footer(ev)).nextDisabled], [false, true], "back on Kimi: the tick is cleared");
    await click(ev, "#frunConsent"); await click(ev, "#frunNext");
    const mark = await sentCount(ev);
    await click(ev, "#frunStart");
    const [start] = await sentSince(ev, "completeFirstRun", mark);
    assert.deepEqual([start?.cli, start?.acpConsent], [saved.kind, true], "Start sends the Kimi leader with the consent");
    await showFirstRun(ev, seed, NONE_READY, kimiOnly.replace('"tested":false', '"tested":true'));
    assert.equal((await rowOf(ev, "kimi")).chip, "Tested", "tested: says so");
  }, { fixture: "fixed" });
});

test("P29 U1 layout: the longest sign-in panel and a failed row, no overlap or clipping at 900x600 and 1296x1030, light and dark; the footer stays in view", { timeout: editorTestMs(240_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, page, seed }) => {
    const copilot = catalogChange({ copilot: { installed: true, signedIn: false, registered: false, leaderEligible: false } });
    const sent = await startClaude(ev, seed, copilot);
    const state = copilot + shared(sent.requestId, "running", "waitingCode") + shared("r-old", "failed", null, "timeout", "copilot");
    await showFirstRun(ev, seed, CLAUDE_SIGNIN, state);
    await deliver(ev, loginEvent(sent.requestId, { phase: "waitingCode", pasteRequired: true, deviceCode: "WXYZ-12345", reason: "browserUnavailable" }));
    const p = await panel(ev, "claude");
    assert.deepEqual([p.addr, p.paste, Boolean(p.code), (await panel(ev, "copilot")).status], [URL1, true, true, FAILED.timeout], "control: the longest panel and a failed one");
    await ev(`${AUDIT_JS};true`);
    for (const [width, height] of [[900, 600], [1296, 1030]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      for (const theme of ["light", "dark"]) {
        await ev(`(()=>{document.body.classList.toggle('light',${J(theme === "light")});return true})()`);
        await auditScrolled(ev, `sign-in ${width}x${height} ${theme}`, 4);
      }
    }
  }, { fixture: "fixed" });
});
