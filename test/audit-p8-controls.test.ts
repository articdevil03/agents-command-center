import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { editorTestMs, J, withPage, click, deliverState, setValue, press, delay, type Page } from "./pack18-editor-harness.ts";
import { showFirstRun, pickFolderAs, catalogChange } from "./pack29-onboarding-page.setup.ts";
import { keyProfile } from "../server/settings/cli-key-profiles.ts";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";

async function pointer(p: Page, selector: string, middle?: () => Promise<void>) {
  const point = await p.ev(`(()=>{const b=document.querySelector(${J(selector)});if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(point, `FOUND ${selector}`);
  await p.page("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await middle?.();
  await p.page("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}

for (const width of [390, 1440]) test(`P8 confirmations queue their own callbacks and gestures at ${width}px`, { timeout: editorTestMs(90_000) }, async () => {
  await withPage(async (p) => {
    const { ev, page } = p;
    await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await ev(`window.__answers=[];confirmAction({title:'A',body:'First'},()=>__answers.push('A'),null,()=>__answers.push('cancel A'));true`);
    await delay(450);
    await pointer(p, "#confirmOk", async () => {
      await ev(`confirmAction({title:'B',body:'Second'},()=>__answers.push('B'),null,()=>__answers.push('cancel B'));true`);
      assert.equal(await ev(`document.querySelector('#confirmTitle').textContent`), "A", "A stays under the press");
    });
    assert.deepEqual(await ev(`__answers`), ["A"]);
    await p.waitFor(`document.querySelector('#confirmTitle').textContent==='B'`, "queued B shown");
    await pointer(p, "#confirmOk", () => delay(450));
    assert.deepEqual(await ev(`__answers`), ["A"], "a press begun during settling stays rejected after settling ends");
    await delay(450); await pointer(p, "#confirmCancel");
    assert.deepEqual(await ev(`__answers`), ["A", "cancel B"]);
    await ev(`confirmAction({title:'C',body:'Third'},()=>__answers.push('C'),null,()=>__answers.push('cancel C'));true`);
    await p.waitFor(`document.querySelector('#confirmTitle').textContent==='C'`, 'C shown');
    await ev(`document.querySelector('#confirmOk').focus();true`);
    await delay(450);
    await page("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await ev(`confirmAction({title:'D',body:'Fourth'},()=>__answers.push('D'),null,()=>__answers.push('cancel D'));true`);
    assert.equal(await ev(`document.querySelector('#confirmTitle').textContent`), "C");
    await page("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    assert.deepEqual(await ev(`__answers`), ["A", "cancel B", "C"]);
    await delay(450); await press(page, "Escape");
    assert.deepEqual(await ev(`__answers`), ["A", "cancel B", "C", "cancel D"]);
    await ev(`confirmAction({title:'Enter A',body:'First',phrase:'YES'},()=>__answers.push('enter A'));true`);
    await p.waitFor(`document.querySelector('#confirmTitle').textContent==='Enter A'`, 'Enter A shown');
    await setValue(ev, '#confirmPhrase', 'YES'); await delay(450);
    await page("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await ev(`confirmAction({title:'Enter B',body:'Second',phrase:'YES'},()=>__answers.push('enter B'),null,()=>__answers.push('cancel enter B'));true`);
    await p.waitFor(`document.querySelector('#confirmTitle').textContent==='Enter B'`, 'Enter B shown');
    await setValue(ev, '#confirmPhrase', 'YES'); await delay(450);
    await page("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, autoRepeat: true });
    await page("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.deepEqual(await ev(`__answers.slice(-1)`), ['enter A'], 'held Enter never answers B');
    await press(page, 'Escape');
    await ev(`confirmAction({title:'Close?',body:'Close',ok:'Close',cancel:'Keep open'},()=>__answers.push('close'),null,()=>__answers.push('keep'));confirmAction({title:'Next',body:'Next'},()=>__answers.push('next'),null,()=>__answers.push('cancel next'));true`);
    await delay(450); await pointer(p, "#confirmCancel"); await delay(450); await pointer(p, "#confirmOk");
    assert.deepEqual(await ev(`__answers`), ["A", "cancel B", "C", "cancel D", "enter A", "cancel enter B", "keep", "next"]);
  });
});

test("P8 absent lost bulk requests unlock unconfirmed; running requests remain held", { timeout: editorTestMs(90_000) }, async () => {
  await withPage(async ({ ev, discovered }) => {
    await deliverState(ev, discovered); await click(ev, "#setBtn");
    await click(ev, "[data-fc-bulk]"); await click(ev, '#pop [data-cli="codex"][data-model]');
    const request = await ev(`__sent.find(m=>m.type==='setCrewModelForAll')`); assert.ok(request);
    await ev(`__socket.close();true`);
    await delay(400);
    await ev(`__ccSeed.requestActions={${J(request.requestId)}:{status:'running'}};true`);
    await delay(1000);
    assert.equal(await ev(`document.querySelector('[data-fc-bulk]').disabled`), true);
    await deliverState(ev, discovered, "state.requestActions={}");
    assert.equal(await ev(`document.querySelector('[data-fc-bulk]').disabled`), false);
    assert.match(await ev(`document.querySelector('.fc-bulk-status').textContent`), /^Not confirmed/);
    assert.equal(await ev(`__sent.filter(m=>m.type==='setCrewModelForAll').length`), 1);
  });
});

for (const width of [390, 1440]) test(`P8 Retry stays above dialogs and preserves typing at ${width}px`, { timeout: editorTestMs(90_000) }, async () => {
  await withPage(async (p) => {
    const { ev, page } = p;
    await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await ev(`openModal('runModal');document.querySelector('#runPrompt').value='Keep my brief';document.querySelector('#runPrompt').focus();__socket.readyState=3;connState='off';retryAt=Date.now()+60000;renderConn();true`);
    const point = await ev(`(()=>{const b=document.querySelector('[data-reconnect]'),r=b.getBoundingClientRect();return {hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),visible:r.width>0&&r.right<=innerWidth}})()`);
    assert.deepEqual(point, { hit: true, visible: true });
    await pointer(p, "[data-reconnect]");
    assert.equal(await ev(`document.querySelector('#runModal').hidden`), false);
    assert.equal(await ev(`document.activeElement.id`), "runPrompt", "Retry preserves dialog field focus");
    await page("Input.insertText", { text: "!" });
    assert.equal(await ev(`document.querySelector('#runPrompt').value`), "Keep my brief!");
    await press(page, "Tab");
    assert.equal(await ev(`document.querySelector('#runModal').contains(document.activeElement)`), true);
    await press(page, "Escape"); assert.equal(await ev(`document.querySelector('#runModal').hidden`), true);
  });
});

for (const width of [390, 1440]) test(`P8 key region placeholder is visible, required and restored without secrets at ${width}px`, { timeout: editorTestMs(90_000) }, async () => {
  await withPage(async (p) => {
    await p.page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await deliverState(p.ev, p.seed, catalogChange({ qwen: { installed: true, keySaved: false, keyProfile: keyProfile("qwen") } }));
    await p.ev(`openSettings(undefined,'tools');true`);
    const root = '[data-cli-key-slot="qwen"]';
    for (let reset = 0; reset < 2; reset++) {
      await click(p.ev, root + ' [data-key-act="add"]');
      assert.deepEqual(await p.ev(`(()=>{const s=document.querySelector('${root} select');return [s.selectedOptions[0]?.textContent,s.value,s.checkValidity()]})()`), ["Choose...", "", false]);
      await setValue(p.ev, root + ' input[type="password"]', 'test-secret');
      await pointer(p, root + ' [data-key-act="save"]');
      assert.equal(await p.ev(`__sent.filter(m=>m.type==='submitCliKey').length`), 0, "placeholder prevents submit");
      await click(p.ev, root + ' [data-key-act="cancel"]');
      assert.equal(await p.ev(`document.querySelector('${root} input[type="password"]').value`), "");
    }
  });
});

for (const width of [390, 1440]) test(`P8 first-run page accepts Greek, CJK and Arabic names and refuses invalid names at ${width}px`, { timeout: editorTestMs(90_000) }, async () => {
  await withPage(async ({ ev, seed, page }) => {
    await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await showFirstRun(ev, seed, { claude: [true, true], codex: [true, true], opencode: [true, true] });
    await click(ev, '#frunNext'); await pickFolderAs(ev, 'C:\\work\\Names'); await click(ev, '#frunBrowse');
    for (const name of ['Ελλάδα', '项目', 'مشروع', 'می\u200Cخواهم', 'क्\u200Dष']) {
      await setValue(ev, '#frunName', name);
      assert.equal(await ev(`document.querySelector('#frunNext').disabled`), false, name);
    }
    for (const name of ['', 'x'.repeat(101), 'bad\u0001name', 'abc\u202Edef', 'proj\u2028x', 'a\u200Bb', 'a\u0085b', '\uFEFFabc']) {
      await setValue(ev, '#frunName', name);
      assert.equal(await ev(`document.querySelector('#frunNext').disabled`), true, JSON.stringify(name));
    }
  });
});

test("P8 first-run server round trips non-Latin names with safe unique fallback ids", async () => {
  // A fresh process loads the server fixture before the browser harness can cache config-files.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { setup, api, dataDir } from './test/pack29-first-run.setup.ts';
  import { join } from 'node:path';
  test('isolated first-run names', async () => {
  assert.equal(api.config.workspacesPath, join(dataDir, 'config', 'workspaces.json'), 'server fixture must write only to its temporary data root');
  for (const name of ['Ελλάδα', '项目', 'مشروع', 'می\\u200Cخواهم', 'क्\\u200Dष']) {
    const ctx = setup();
    const reply = await ctx.dispatch({ name, projectOnly: true });
    assert.equal(reply?.type, 'actionResult', JSON.stringify(reply));
    const project = api.config.readWorkspaces().projects.find((p) => p.name === name);
    assert.ok(project); assert.equal(project.id, 'project'); assert.match(project.id, /^[a-z0-9-]+$/);
  }
  for (const name of ['', 'x'.repeat(101), 'bad\\u0001name', 'abc\\u202Edef', 'proj\\u2028x', 'a\\u200Bb', 'a\\u0085b', '\\uFEFFabc']) {
    const ctx = setup(), before = ctx.bytes();
    assert.equal((await ctx.dispatch({ name }))?.type, 'error'); assert.deepEqual(ctx.bytes(), before);
  }
  });`], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const source = readFileSync('server/first-run/complete.ts', 'utf8');
  const start = source.indexOf('  const name = message.name.trim();'), end = source.indexOf('  const folder =', start);
  assert.ok(start > 0 && end > start, 'FOUND actual server id generation');
  const id = runInNewContext(`(()=>{${source.slice(start, end)}return id})()`, { message: { name: '项目' }, workspaces: { projects: [{ id: 'project' }, { id: 'project-2' }] }, isTabSlug: (value: string) => /^[a-z0-9-]+$/.test(value) });
  assert.equal(id, 'project-3', 'actual server collision loop keeps ids unique');
});

test("P8 all attachment failure paths tell the user to remove and attach again", async () => {
  await withPage(async ({ ev, fixed, discovered }) => {
    await deliverState(ev, discovered);
    await ev(`openSeatView(${J(fixed.id)},'leader');window.__toasts=[];showToast=text=>__toasts.push(text);true`);
    for (const path of ['send', 'queue', 'queued']) {
      await ev(`(()=>{const id=${J(fixed.id)},a={id:'failed',name:'bad.txt',status:'error',path:null,released:false};queueByTab.delete(id);pendingChatByTab.delete(id);attachmentsByTab.set(id,[a]);document.querySelector('#ci').value='message';if(${J(path)}==='queued'){queueByTab.set(id,[{id:'q',state:'waiting',text:'message',items:[a]}]);goQueued(id,'q')}else if(${J(path)}==='queue'){queueComposer(id)}else{sendChat()}return true})()`);
      await delay(20);
    }
    assert.deepEqual(await ev(`__toasts`), Array(3).fill('Remove the attachment that could not be loaded and attach it again'));
  });
});

for (const width of [390, 1440]) test(`P8 Needs you hides raw keys in labels and preserves action targets at ${width}px`, { timeout: editorTestMs(90_000) }, async () => {
  await withPage(async ({ ev, discovered, page }) => {
    await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await deliverState(ev, discovered, `state.launchSafety={blocked:['removed-tab.coder','legacy-123'],uncertain:[{seatKey:'removed-tab.reviewer',runId:'run-123',pid:4321}],released:[{seatId:'legacy-123',pid:4322}],notices:[{id:1,seatId:'legacy-123',pending:true},{id:2,seatKey:'removed-tab.coder',pending:false}]}`);
    await click(ev, '#inboxBtn');
    const text = await ev(`(()=>{const root=document.querySelector('#inboxPop');return root.textContent+' '+[...root.querySelectorAll('[title],[aria-label]')].map(e=>e.title+' '+e.getAttribute('aria-label')).join(' ')})()`);
    assert.doesNotMatch(text, /removed-tab|legacy-123|run-123|Old seat ID/);
    assert.match(text, /Coder/); assert.match(text, /Earlier position/); assert.match(text, /4321/);
    await setValue(ev, '[data-confirm-unblock="removed-tab.coder"]', 'ALLOW');
    await ev(`document.querySelector('[data-confirm-unblock="removed-tab.coder"]').value=UNBLOCK_CONFIRM;document.querySelector('[data-unblock="removed-tab.coder"]').click();true`);
    assert.equal(await ev(`__sent.filter(m=>m.type==='unblockSeat').at(-1).seatKey`), 'removed-tab.coder');
    await ev(`document.querySelector('[data-confirm-release="run-123"]').value=STOP_CONFIRM;document.querySelector('[data-release="run-123"]').click();true`);
    assert.equal(await ev(`__sent.filter(m=>m.type==='releaseUnconfirmed').at(-1).runId`), 'run-123');
  });
});

for (const width of [390, 1440]) test(`P8 removed positions use plain names in status and Activity at ${width}px`, async () => {
  await withPage(async ({ ev, page, discovered, fixed }) => {
    await page('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    const key = `${fixed.id}.coder`;
    await deliverState(ev, discovered, `state.projects[0].tabs[0].crew=state.projects[0].tabs[0].crew.filter(s=>s.slot!=='coder');state.launchSafety={uncertain:[{seatKey:${J(key)},runId:'removed-run',pid:4321}]}`);
    const status = await ev(`(()=>{renderStatusLine(currentTab());const b=document.querySelector('#statusBtn');return [b.textContent,b.title,b.getAttribute('aria-label')]})()`);
    for (const label of status) {
      assert.match(label, /Coder may still be running/);
      assert.ok(!label.includes(key), 'status and accessibility text cannot expose the routing key');
    }
    for (const type of ['runStart', 'runFinish', 'runFail', 'runStop', 'runStalled']) {
      await ev(`__ccDeliver({type:${J(type)},seatKey:'example-development.coder'});true`);
    }
    await ev(`__ccDeliver({type:'leaderLaunch',id:999,seatId:'example-development.coder'});renderSide();true`);
    const entries = await ev(`activity.slice(0,6).map(a=>a.text)`);
    assert.equal(entries.length, 6);
    assert.match(entries.join(' '), /Coder started a run/);
    assert.doesNotMatch(entries.join(' '), /example-development|\.coder/);
    assert.equal(await ev(`seatNameOfKey('unknown-route.unknown-slot')`), 'Earlier position');
  });
});

test('P8 repeated keys cannot accept a settled confirmation and cancel retires state before callback', async () => {
  await withPage(async ({ ev, page }) => {
    await ev(`window.__accepted=0;confirmAction({title:'Repeat',body:'Repeat',phrase:'YES'},()=>__accepted++);true`);
    await setValue(ev, '#confirmPhrase', 'YES'); await delay(450);
    await ev(`confirmationKey=activeConfirmation;true`);
    await page('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, autoRepeat: true });
    assert.equal(await ev('__accepted'), 0, 'repeat is rejected even when the press belongs to this dialog');
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await ev(`confirmCancelled=()=>{window.__retired=[activeConfirmation===null,confirmCallback===null,confirmCancelled===null,Boolean(confirmationTimer)];confirmAction({title:'From cancel',body:'Next'},()=>{});};true`);
    await click(ev, '#confirmCancel');
    assert.deepEqual(await ev('__retired'), [true, true, true, true], 'cancel sees retired state and the scheduled queue before running user code');
  });
});
