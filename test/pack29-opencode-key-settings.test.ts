import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver, press } from "./pack18-editor-harness.ts";
import { catalogChange, sentCount, sentSince, showFirstRun, signInPolicy } from "./pack29-onboarding-page.setup.ts";
import { toToolStep } from "./pack29-onboarding-page-acp.setup.ts";

const KEY = "synthetic-O3-settings-key-sentinel-42";
const CAP = "b".repeat(48);
const TOOLS = { claude: [false, null], codex: [false, null], opencode: [true, false] } as const;
const ROW = '#s-tools [data-tool-row][data-cli="opencode"]';
const PANEL = `${ROW} .cli-login`;
const INPUT = `${PANEL} input`;
const POLICY = signInPolicy(["claude", "codex", "opencode", "copilot", "grok"]);
const facts = (over = {}) => POLICY + catalogChange({ opencode: { installed: true, version: "1.9.0", supportedVersion: true, signedIn: false, credentialSource: "none", ...over } });
const shared = (id: string, status = "running", phase: string | null = "waitingKey", reason: string | null = null) => ({ requestId: id, kind: "login", status, phase, reason });
const event = (id: string, revision = 1, over = {}) => ({ type: "cliLoginState", cli: "opencode", loginRequestId: id, loginId: CAP, revision, status: "running", phase: "waitingKey", reason: null, verificationUrl: "https://opencode.ai/auth", deviceCode: null, pasteRequired: false, ...over });
type Ev = (expression: string) => Promise<any>;
const state = (ev: Ev, seed: unknown, over = {}) => showFirstRun(ev, seed, TOOLS, facts(over) + "state.firstRun={required:false};");
const fill = (ev: Ev, selector = INPUT) => ev(`(()=>{const i=document.querySelector(${J(selector)});i.focus();i.value=${J(KEY)};i.dispatchEvent(new Event('input',{bubbles:true}));window.__keyInput=i;return true})()`);
const text = (ev: Ev) => ev(`document.querySelector(${J(ROW)}).innerText`);
async function open(ev: Ev) { await ev(`(()=>{openSettings(undefined,'tools');return true})()`); }
async function begin(ev: Ev, seed: unknown) {
  await state(ev, seed); await open(ev);
  const mark = await sentCount(ev);
  await click(ev, `${ROW} [data-setting-action="login-cli"]`);
  const [request] = await sentSince(ev, "cliLogin", mark);
  assert.ok(request, "Settings real listener starts OpenCode flow");
  await state(ev, seed, { action: shared(request.requestId) });
  await deliver(ev, event(request.requestId));
  return request;
}

test("P29 O3 Settings exact key listener, cross-surface clear before send, focus and draft secrecy, keyboard order", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed, page }) => {
    await showFirstRun(ev, seed, TOOLS, facts());
    await toToolStep(ev, "C:\\work\\O3");
    await open(ev);
    const mark = await sentCount(ev);
    await click(ev, `${ROW} [data-setting-action="login-cli"]`);
    const [request] = await sentSince(ev, "cliLogin", mark);
    assert.deepEqual({ ...request, requestId: "id" }, { type: "cliLogin", requestId: "id", cli: "opencode" });
    await showFirstRun(ev, seed, TOOLS, facts({ action: shared(request.requestId) }));
    await deliver(ev, event(request.requestId));
    assert.equal(await ev(`document.querySelectorAll('[data-cli="opencode"] .cli-login input').length`), 2, "both actual surfaces mounted");
    await fill(ev);
    await showFirstRun(ev, seed, TOOLS, facts({ action: shared(request.requestId) }));
    assert.deepEqual(await ev(`[document.activeElement===window.__keyInput,window.__keyInput.value===${J(KEY)}]`), [true, true], "broadcast keeps the same input and focus");
    assert.deepEqual(await ev(`(()=>{const b=document.querySelector('#setBody');return [JSON.stringify([...settingsDraftSnapshot(b)]).includes(${J(KEY)}),JSON.stringify(settingsFocusSnapshot(b)).includes(${J(KEY)}),JSON.stringify([...settingsSubmits]).includes(${J(KEY)}),JSON.stringify(serverState).includes(${J(KEY)}),JSON.stringify(cliLoginUi.viewOf('opencode')).includes(${J(KEY)}),document.documentElement.outerHTML.includes(${J(KEY)})]})()`), [false, false, false, false, false, false]);
    await ev(`(()=>{document.querySelector(${J(`${PANEL} [data-login-act="open"]`)}).focus();return true})()`);
    const order = [];
    for (let i = 0; i < 3; i++) { await press(page, "Tab"); order.push(await ev(`document.activeElement.dataset.loginAct||document.activeElement.labels?.[0]?.textContent`)); }
    assert.deepEqual(order, ["OpenCode Go API key", "send", "cancel"], "Get my key, masked input, Save key, Cancel");
    await ev(`(()=>{window.__beforeSend=[];window.__savedSend=send;send=(m)=>{if(m.type==='submitCliLoginKey')window.__beforeSend.push([...document.querySelectorAll('[data-cli="opencode"] .cli-login input')].map(i=>i.value));return window.__savedSend(m)};return true})()`);
    // Set both surfaces in one task so the boundary checks the retained copy too.
    await ev(`(()=>{for(const i of document.querySelectorAll('[data-cli="opencode"] .cli-login input'))i.value=${J(KEY)};document.querySelector(${J(`${PANEL} [data-login-act="send"]`)}).click();return true})()`);
    assert.deepEqual(await ev("window.__beforeSend"), [["", ""]], "both inputs empty before the send function is invoked");
    const sent = await sentSince(ev, "submitCliLoginKey", mark);
    assert.equal(sent.length, 1);
    assert.deepEqual({ ...sent[0], requestId: "id" }, { type: "submitCliLoginKey", requestId: "id", cli: "opencode", loginId: CAP, apiKey: KEY });
    await ev(`(()=>{send=window.__savedSend;return true})()`);
    const leaked = await ev(`(()=>{const n=${J(KEY)},hits=[];if(document.documentElement.outerHTML.includes(n))hits.push('DOM');for(const i of document.querySelectorAll('input'))if(i.value.includes(n))hits.push('input');for(const s of [localStorage,sessionStorage])for(let k=0;k<s.length;k++)if((s.key(k)+s.getItem(s.key(k))).includes(n))hits.push('storage');return hits})()`);
    assert.deepEqual(leaked, []);
    await deliver(ev, event(request.requestId, 2, { phase: "verifying" }));
    assert.match(await text(ev), /Saving your key…/);
    await state(ev, seed, { signedIn: true, credentialSource: "stored", action: shared(request.requestId, "done", null) });
    await deliver(ev, { type: "actionResult", action: "cliLogin", requestId: request.requestId });
    assert.match(await text(ev), /Ready/);
    assert.match(await text(ev), /Key saved\. OpenCode will check it when you first chat\./);
    const shot = await page("Page.captureScreenshot", { format: "png" });
    assert.ok(Buffer.from(shot.result.data, "base64").length > 1000, "the page really rendered (nothing is written into the repo)");
  });
});

test("P29 O3 stored credentials require explicit replacement, ordinary and forged Sign in cannot replace; replacement sends confirm true", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed }) => {
    for (const signedIn of [true, false]) {
      await state(ev, seed, { signedIn, credentialSource: "stored" }); await open(ev);
      assert.equal(await ev(`Boolean(document.querySelector(${J(`${ROW} [data-setting-action="login-cli"]`)}))`), false);
      assert.match(await text(ev), /This replaces the OpenCode Go key saved on this PC\./);
      const mark = await sentCount(ev);
      await ev(`(()=>{const b=document.createElement('button');b.dataset.settingAction='login-cli';b.dataset.cli='opencode';document.querySelector(${J(ROW)}).append(b);cliLoginUi.start('opencode');b.remove();return true})()`);
      assert.deepEqual(await sentSince(ev, "cliLogin", mark), [], "ordinary start cannot replace even if signedIn=false");
    }
    let mark = await sentCount(ev);
    await click(ev, `${PANEL} [data-login-act="replace"]`);
    const sent = await sentSince(ev, "replaceCliLogin", mark);
    assert.equal(sent.length, 1);
    assert.deepEqual({ ...sent[0], requestId: "id" }, { type: "replaceCliLogin", requestId: "id", cli: "opencode", confirm: true });
    await ev(`(()=>{const b=document.querySelector(${J(`${PANEL} [data-login-act="replace"]`)});b.disabled=false;b.click();return true})()`);
    assert.equal((await sentSince(ev, "replaceCliLogin", mark)).length, 1, "forced double replacement blocked");
    await state(ev, seed, { signedIn: true, credentialSource: "stored", action: shared(sent[0].requestId) });
    await deliver(ev, event(sent[0].requestId));
    await fill(ev);
    await click(ev, `${PANEL} [data-login-act="open"]`);
    const [getKey] = await sentSince(ev, "openCliLogin", mark);
    assert.deepEqual({ ...getKey, requestId: "id" }, { type: "openCliLogin", requestId: "id", cli: "opencode", loginId: CAP });
    await click(ev, `${PANEL} [data-login-act="send"]`);
    assert.equal((await sentSince(ev, "submitCliLoginKey", mark)).length, 1);
  });
});

test("P29 O3 Settings surface closure, terminal static reasons and unknown text, version 2 install consent", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed, waitFor, page }) => {
    const request = await begin(ev, seed);
    await fill(ev);
    await ev(`(()=>{setLayer(document.querySelector('#setModal'),false);return true})()`);
    await waitFor(`window.__keyInput.value===''`, "closing Settings clears retained input");
    await open(ev);
    assert.equal(await ev(`document.querySelector(${J(INPUT)}).value`), "");
    await fill(ev);
    await state(ev, seed, { action: shared(request.requestId, "failed", null, "keyFailed") });
    assert.equal(await ev(`document.querySelector(${J(INPUT)}).value`), "", "terminal shared state clears retained input");
    const reasons = {
      unsupportedVersion: "OpenCode 1 is needed.", existingCredentials: "A credential is already saved.",
      environmentCredentials: "OpenCode is using credentials set outside Command Center. Remove that setting in Windows Settings before adding a key here.",
      credentialUnknown: "Could not check saved credentials.", invalidKey: "Enter an OpenCode Go API key.", keyFailed: "Could not save the key. Try again.",
      possiblySaved: "The key may have been saved. Check again.", cleanupUnconfirmed: "Could not confirm sign-in stopped.",
      cancelled: "Sign-in stopped.", timeout: "Sign-in expired. Try again.", unknownVendorText: "Sign-in did not finish. Try again.",
    };
    for (const [reason, expected] of Object.entries(reasons)) {
      await state(ev, seed, { action: shared(request.requestId, "failed", null, reason) });
      assert.equal(await ev(`document.querySelector(${J(`${PANEL} .cli-login-status`)}).textContent`), expected, `${reason}: static words`);
      assert.doesNotMatch(await text(ev), /\bpaid\b|\bfree\b|pricing|subscription|\$\d/i);
    }
    await state(ev, seed, { installed: true, signedIn: true, supportedVersion: false, version: "2.0.0", action: shared(request.requestId, "failed", null, "keyFailed") });
    assert.match(await text(ev), /OpenCode 1 is needed/);
    assert.doesNotMatch(await text(ev), /Ready/);
    assert.equal(await ev(`document.querySelector(${J(`${ROW} [data-setting-action="install-cli"]`)}).textContent`), "Install OpenCode 1");
    const mark = await sentCount(ev);
    await click(ev, `${ROW} [data-setting-action="install-cli"]`);
    assert.equal(await ev(`document.querySelector('#confirmBody').textContent`), "Downloads and checks OpenCode 1 from its official releases, then installs it for your Windows account. Signing in comes after.");
    await click(ev, "#confirmOk");
    const [install] = await sentSince(ev, "installCli", mark);
    assert.deepEqual({ ...install, requestId: "id" }, { type: "installCli", requestId: "id", cli: "opencode", confirm: true });
    assert.equal(await ev(`document.querySelector(${J(ROW)}).querySelector('.settings-install-by-hand')`), null);
    for (const [width, height] of [[900, 600], [1296, 1030]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      assert.equal(await ev(`(()=>{const b=document.querySelector('#setBody');return b.scrollWidth<=b.clientWidth})()`), true, "Settings fits minimum window");
    }
  });
});
