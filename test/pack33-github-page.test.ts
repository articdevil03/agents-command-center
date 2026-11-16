import test from "node:test";
import assert from "node:assert/strict";
import { withPage, click, deliver, deliverState, editorTestMs, J } from "./pack18-editor-harness.ts";

test("Settings GitHub row shows Connect, browser code, failure, Stop again and Connected with no console wording", { timeout: editorTestMs(120000) }, async () => {
  await withPage(async ({ ev, seed }) => {
    const state = (action: any = null, connected = false) => deliverState(ev, seed, `state.firstRun={required:false};state.settings.github={connected:${connected},account:null,action:${J(action)}};`);
    await state(); await ev(`(()=>{openSettings(undefined,'github');return true})()`);
    const row = () => ev(`document.querySelector('#s-github').innerText`);
    assert.match(await row(), /Connect/);
    await click(ev, '[data-setting-action="github-login"]');
    const request = await ev(`window.__sent.findLast(m=>m.type==='cliLogin'&&m.cli==='github')`);
    assert.ok(request); assert.deepEqual(Object.keys(request).sort(), ["cli", "requestId", "type"]);
    await deliver(ev, { type: "error", action: "cliLogin", requestId: request.requestId, message: "Another installation or sign-in is running." });
    assert.match(await row(), /Another installation or sign-in is running\./);
    const action = { requestId: request.requestId, status: "running", kind: "login", phase: "waitingBrowser", reason: null };
    await state(action);
    await deliver(ev, { type: "cliLoginState", cli: "github", loginRequestId: request.requestId, loginId: "a".repeat(48), revision: 1, status: "running", phase: "waitingBrowser", reason: null,
      verificationUrl: "https://github.com/login/device", deviceCode: "AB12-CD34", pasteRequired: false });
    let text = await row();
    assert.match(text, /Waiting for you to finish in your browser/); assert.match(text, /AB12-CD34/); assert.match(text, /Open GitHub/);
    await click(ev, '#s-github [data-login-act="open"]');
    const open = await ev(`window.__sent.findLast(m=>m.type==='openCliLogin')`);
    assert.deepEqual(Object.keys(open).sort(), ["cli", "loginId", "requestId", "type"]);
    await click(ev, '#s-github [data-login-act="cancel"]');
    assert.equal(await ev(`window.__sent.findLast(m=>m.type==='cancelCliLogin').loginRequestId`), request.requestId);
    await deliver(ev, { type: "actionResult", action: "cancelCliLogin", requestId: await ev(`window.__sent.findLast(m=>m.type==='cancelCliLogin').requestId`) });
    await state({ ...action, status: "failed", phase: null, reason: "cleanupUnconfirmed" });
    text = await row(); assert.match(text, /Could not confirm sign-in stopped/); assert.match(text, /Stop again/); assert.doesNotMatch(text, /AB12-CD34/);
    await click(ev, '#s-github [data-login-act="stop"]');
    assert.equal(await ev(`window.__sent.filter(m=>m.type==='cancelCliLogin').length`), 2);
    await state({ ...action, status: "failed", phase: null, reason: "loginFailed" });
    text = await row(); assert.match(text, /Could not connect\. Try again\./); assert.doesNotMatch(text, /AB12-CD34|login\/device/);
    await state({ ...action, status: "done", phase: null }, true);
    text = await row(); assert.match(text, /Connected/); assert.doesNotMatch(text, /AB12-CD34|login\/device/);
    assert.doesNotMatch(text, /powershell|terminal|\bpaid\b|\bfree\b|\u2014/i);
    assert.equal(await ev(`localStorage.length===0||![...Object.values(localStorage)].some(v=>v.includes('AB12-CD34'))`), true);
  });
});
