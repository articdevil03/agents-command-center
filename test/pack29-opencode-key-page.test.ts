import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver } from "./pack18-editor-harness.ts";
import { AUDIT_JS } from "./overlap-audit-js.ts";
import { auditScrolled, catalogChange, sentCount, sentSince, showFirstRun, signInPolicy, stepOf } from "./pack29-onboarding-page.setup.ts";
import { toToolStep } from "./pack29-onboarding-page-acp.setup.ts";

const KEY = "synthetic-O3-key-sentinel-91";
const CAP = "a".repeat(48);
const TOOLS = { claude: [false, null], codex: [false, null], opencode: [true, false] } as const;
const SCOPE = '#frunTools [data-cli="opencode"]';
const INPUT = `${SCOPE} .cli-login input`;
const POLICY = signInPolicy(["claude", "codex", "opencode", "copilot", "grok"]);
const facts = (over = {}) => POLICY + catalogChange({ opencode: { installed: true, version: "1.9.0", supportedVersion: true, signedIn: false, credentialSource: "none", ...over } });
const action = (id: string, status = "running", phase: string | null = "waitingKey", reason: string | null = null) => ({ requestId: id, kind: "login", status, phase, reason });
const event = (id: string, revision = 1, over = {}) => ({ type: "cliLoginState", cli: "opencode", loginRequestId: id, loginId: CAP, revision, status: "running", phase: "waitingKey", reason: null, verificationUrl: "https://opencode.ai/auth", deviceCode: null, pasteRequired: false, ...over });
type Ev = (expression: string) => Promise<any>;
const value = (ev: Ev, selector = INPUT) => ev(`document.querySelector(${J(selector)}).value`);
const fill = (ev: Ev, text = KEY) => ev(`(()=>{const i=document.querySelector(${J(INPUT)});i.focus();i.value=${J(text)};i.dispatchEvent(new Event('input',{bubbles:true}));window.__keyInput=i;return true})()`);
const pressEnter = (ev: Ev) => ev(`(()=>{document.querySelector(${J(INPUT)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true})()`);
const shown = (ev: Ev) => ev(`document.querySelector(${J(SCOPE)}).innerText`);
async function begin(ev: Ev, seed: unknown) {
  await showFirstRun(ev, seed, TOOLS, facts());
  if (await stepOf(ev) !== "tools") await toToolStep(ev, "C:\\work\\O3");
  const mark = await sentCount(ev);
  await click(ev, '[data-frun-login="opencode"]');
  const [request] = await sentSince(ev, "cliLogin", mark);
  assert.ok(request, "real Sign in listener sent a request");
  assert.deepEqual(Object.keys(request).sort(), ["cli", "requestId", "type"]);
  await showFirstRun(ev, seed, TOOLS, facts({ action: action(request.requestId) }));
  await deliver(ev, event(request.requestId));
  return request;
}
// Do not record payloads here. The test socket alone records the allowed wire message.
const observeSend = (ev: Ev, mode = "normal") => ev(`(()=>{window.__originalSend=send;window.__boundary=[];send=(m)=>{if(m.type==='submitCliLoginKey'){
  window.__boundary.push([...document.querySelectorAll('[data-cli="opencode"] .cli-login input')].map(i=>i.value));
  if(${J(mode)}==='throw')throw new Error('synthetic send failure');if(${J(mode)}==='reject')return false;
}return window.__originalSend(m)};return true})()`);
const restoreSend = (ev: Ev) => ev(`(()=>{send=window.__originalSend;return true})()`);
const noLeaks = (ev: Ev) => ev(`(()=>{const n=${J(KEY)},hits=[];
  if(document.documentElement.outerHTML.includes(n))hits.push('markup');
  for(const el of document.querySelectorAll('*'))for(const a of el.attributes)if(a.value.includes(n))hits.push('attribute');
  for(const s of [localStorage,sessionStorage])for(let i=0;i<s.length;i++)if((s.key(i)+s.getItem(s.key(i))).includes(n))hits.push('storage');
  for(const [name,v] of Object.entries({serverState,view:cliLoginUi.viewOf('opencode'),draft:[...settingsDraftSnapshot(document.querySelector('#setBody'))],focus:settingsFocusSnapshot(document.querySelector('#setBody')),settingsSubmits:[...settingsSubmits],settingsEdits:[...settingsEdits],pending:[...pendingSettingsActions],drafts:[...draftsByTab]}))if(JSON.stringify(v).includes(n))hits.push(name);
  return hits})()`);

test("P29 O3 key wizard real listeners: exact messages, all boxes empty before send, Enter held, revision and duplicate guards, no secret persistence", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed }) => {
    const request = await begin(ev, seed);
    assert.deepEqual(await ev(`(()=>{const i=document.querySelector(${J(INPUT)});return [i.type,i.autocomplete,i.dataset.secret,i.labels[0].textContent,i.disabled]})()`), ["password", "off", "true", "OpenCode Go API key", false]);
    assert.match(await shown(ev), /Sign in with your OpenCode Go key/);
    const mark = await sentCount(ev);
    await click(ev, `${SCOPE} [data-login-act="open"]`);
    const [open] = await sentSince(ev, "openCliLogin", mark);
    assert.deepEqual({ ...open, requestId: "id" }, { type: "openCliLogin", requestId: "id", cli: "opencode", loginId: CAP });
    await fill(ev);
    assert.deepEqual(await noLeaks(ev), [], "typed key exists only in the masked value");
    await observeSend(ev);
    await pressEnter(ev);
    assert.equal(await value(ev), "");
    assert.equal(await stepOf(ev), "tools", "Enter never advances setup");
    assert.deepEqual(await ev("window.__boundary"), [[""]], "every mounted tool input was empty at send entry");
    const [submit] = await sentSince(ev, "submitCliLoginKey", mark);
    assert.deepEqual({ ...submit, requestId: "id" }, { type: "submitCliLoginKey", requestId: "id", cli: "opencode", loginId: CAP, apiKey: KEY });
    assert.equal((await sentSince(ev, "submitCliLoginCode", mark)).length, 0);
    assert.deepEqual(await noLeaks(ev), [], "key absent from controller view, shared state, snapshots, drafts, storage and attributes");
    await fill(ev);
    await ev(`(()=>{const b=document.querySelector(${J(`${SCOPE} [data-login-act="send"]`)});b.disabled=false;b.click();return true})()`);
    await deliver(ev, event(request.requestId, 1));
    await fill(ev); await pressEnter(ev);
    assert.equal((await sentSince(ev, "submitCliLoginKey", mark)).length, 1, "forced click and stale revision cannot resend");
    assert.equal(await value(ev), "");
    await restoreSend(ev);
    await deliver(ev, event(request.requestId, 2, { phase: "verifying" }));
    assert.match(await shown(ev), /Saving your key…/);
    await showFirstRun(ev, seed, TOOLS, facts({ signedIn: true, credentialSource: "stored", action: action(request.requestId, "done", null) }));
    await deliver(ev, { type: "actionResult", action: "cliLogin", requestId: request.requestId });
    assert.match(await shown(ev), /Ready/);
    assert.match(await shown(ev), /Key saved\. OpenCode will check it when you first chat\./);
  });
});

test("P29 O3 failed sends clear before boundary: false, throwing, socket throw and disconnected; no retries retain a key", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed }) => {
    const request = await begin(ev, seed);
    let rev = 1;
    for (const mode of ["reject", "throw", "socketThrow", "disconnected"]) {
      await deliver(ev, event(request.requestId, ++rev));
      await fill(ev);
      await observeSend(ev, mode);
      await ev(`(()=>{window.__socketSend=window.__socket.send;window.__ready=window.__socket.readyState;
        if(${J(mode)}==='socketThrow')window.__socket.send=()=>{throw new Error('synthetic socket failure')};
        if(${J(mode)}==='disconnected')window.__socket.readyState=3;return true})()`);
      await pressEnter(ev);
      assert.equal(await value(ev), "", `${mode}: input empty`);
      assert.deepEqual(await ev("window.__boundary.every(xs=>xs.every(v=>v===''))&&window.__boundary.length===1"), true, `${mode}: clear before calling send`);
      assert.deepEqual(await noLeaks(ev), [], `${mode}: no retained copy`);
      await ev(`(()=>{window.__socket.send=window.__socketSend;window.__socket.readyState=window.__ready;return true})()`);
      await restoreSend(ev);
    }
    for (const invalid of ["", "   ", "bad\u0001key", "bad\u0085key", "x".repeat(4097), "é".repeat(2049)]) {
      await deliver(ev, event(request.requestId, ++rev)); await fill(ev, invalid);
      const mark = await sentCount(ev); await pressEnter(ev);
      assert.equal(await value(ev), "");
      assert.deepEqual(await sentSince(ev, "submitCliLoginKey", mark), [], "invalid inputs never reach send");
      assert.equal(await ev(`document.querySelector(${J(SCOPE + " .cli-login-hint")}).textContent`), "Enter an OpenCode Go API key.");
      assert.equal(await ev(`document.querySelector(${J(INPUT)}).disabled`), false, "invalid key input stays editable");
    }
  });
});

test("P29 O3 terminal events, cancellation, hidden and detached panels clear keys; orphan reload never regains a capability", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed, reload, waitFor }) => {
    const request = await begin(ev, seed);
    await fill(ev);
    await ev(`(()=>{window.__socket.close();return true})()`);
    await waitFor(`window.__sent.some(m=>m.type==='getCliLoginState')`, "OpenCode private state requested after reconnect", 8000);
    const [again] = await sentSince(ev, "getCliLoginState", 0);
    assert.deepEqual({ ...again, requestId: "id" }, { type: "getCliLoginState", requestId: "id", cli: "opencode", loginId: CAP });
    assert.equal(await value(ev), "", "reconnect clears the input");
    await fill(ev);
    await ev(`(()=>{window.__keyPanel=document.querySelector(${J(`${SCOPE} .cli-login`)});window.__keyPanel.remove();return true})()`);
    assert.equal(await ev("window.__keyInput.value"), "", "detached retained input cleared");
    await showFirstRun(ev, seed, TOOLS, facts({ action: action(request.requestId) }));
    await fill(ev);
    await ev(`(()=>{document.querySelector('#first').hidden=true;return true})()`);
    assert.equal(await value(ev), "", "hidden surface cleared");
    await showFirstRun(ev, seed, TOOLS, facts({ action: action(request.requestId) }));
    await fill(ev);
    const mark = await sentCount(ev);
    await click(ev, `${SCOPE} [data-login-act="cancel"]`);
    assert.equal(await value(ev), "", "cancel clears immediately");
    const [cancel] = await sentSince(ev, "cancelCliLogin", mark);
    assert.deepEqual({ ...cancel, requestId: "id" }, { type: "cancelCliLogin", requestId: "id", cli: "opencode", loginRequestId: request.requestId });
    await fill(ev);
    await deliver(ev, event(request.requestId, 3, { status: "failed", phase: null, reason: "keyFailed", loginId: null }));
    assert.equal(await value(ev), "", "terminal private event clears even before shared state");
    await reload();
    await showFirstRun(ev, seed, TOOLS, facts({ action: action(request.requestId) }));
    assert.match(await shown(ev), /Sign-in is already running\. Cancel to start again\./);
    assert.deepEqual(await sentSince(ev, "getCliLoginState", 0), [], "reload lost the capability");
    assert.equal(await value(ev), "");
  });
});

test("P29 O3 OpenCode missing, installation phases, version 2, environment and cleanup states; headless rough layout", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed, page }) => {
    await showFirstRun(ev, seed, TOOLS, facts({ installed: false }));
    await toToolStep(ev, "C:\\work\\O3");
    assert.match(await shown(ev), /Not found/);
    assert.match(await shown(ev), /Downloads and checks OpenCode 1 from its official releases, then installs it for your Windows account\./);
    let mark = await sentCount(ev);
    await click(ev, '[data-frun-install="opencode"]');
    const [install] = await sentSince(ev, "installCli", mark);
    assert.deepEqual({ ...install, requestId: "id" }, { type: "installCli", requestId: "id", cli: "opencode", confirm: true });
    for (const message of ["Downloading OpenCode 1…", "Checking the download…", "Checking OpenCode 1…", "Trying another install method…"]) {
      await showFirstRun(ev, seed, TOOLS, facts({ installed: false, action: { requestId: install.requestId, kind: "install", status: "running", phase: "installing", message } }));
      assert.match(await shown(ev), /Installing/); assert.ok((await shown(ev)).includes(message));
    }
    await deliver(ev, { type: "actionResult", action: "installCli", requestId: install.requestId });
    // A version that could not be read is said as that, not as "OpenCode 1 is needed".
    await showFirstRun(ev, seed, TOOLS, facts({ signedIn: true, supportedVersion: null, version: null, action: null }));
    assert.match(await shown(ev), /The OpenCode version could not be read/); assert.doesNotMatch(await shown(ev), /OpenCode 1 is needed/);
    await showFirstRun(ev, seed, TOOLS, facts({ signedIn: true, supportedVersion: false, version: "2.0.0", action: null }));
    assert.match(await shown(ev), /OpenCode 1 is needed/); assert.doesNotMatch(await shown(ev), /Ready/);
    mark = await sentCount(ev);
    await click(ev, '[data-frun-install="opencode"]');
    const secondInstall = await sentSince(ev, "installCli", mark);
    assert.equal(secondInstall.length, 1, "version 2 can install version 1");
    await deliver(ev, { type: "actionResult", action: "installCli", requestId: secondInstall[0].requestId });
    await showFirstRun(ev, seed, TOOLS, facts({ credentialSource: "environment", action: null }));
    assert.match(await shown(ev), /A key is set outside Command Center\. Its connection is not checked\./);
    const request = await begin(ev, seed);
    await ev(`${AUDIT_JS};true`);
    for (const [width, height] of [[900, 600], [1296, 1030]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      for (const theme of ["light", "dark"]) {
        await ev(`(()=>{document.body.classList.toggle('light',${J(theme === "light")});return true})()`);
        await auditScrolled(ev, `OpenCode key ${width} ${theme}`, 3);
      }
    }
    assert.doesNotMatch(await shown(ev), /\bpaid\b|\bfree\b|pricing|subscription|\$\d|powershell|terminal/i);
    const shot = await page("Page.captureScreenshot", { format: "png" });
    assert.ok(Buffer.from(shot.result.data, "base64").length > 1000, "the page really rendered (nothing is written into the repo)");
    await showFirstRun(ev, seed, TOOLS, facts({ action: action(request.requestId, "failed", null, "cleanupUnconfirmed") }));
    assert.match(await shown(ev), /Could not confirm sign-in stopped\./);
    assert.match(await shown(ev), /Stop again/);
    const stopMark = await sentCount(ev);
    await click(ev, `${SCOPE} [data-login-act="stop"]`);
    assert.deepEqual((await sentSince(ev, "cancelCliLogin", stopMark)).map(m=>m.loginRequestId), [request.requestId]);
  });
});
