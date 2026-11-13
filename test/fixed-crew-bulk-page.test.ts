import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, setValue, press, taskFixture, type Page } from "./pack18-editor-harness.ts";

const BULK = "#setModal [data-fc-bulk]";
const STATUS = `document.querySelector(".fc-bulk-status").textContent`;
const writes = (ev: Page["ev"]) => ev(`window.__sent.filter((m)=>["setCrewModelForAll","setCrewAssignment"].includes(m.type))`);
const crew = "state.projects[0].tabs[0].fixedCrew";
const manual = `${crew}.preferences.coder={source:"user",assignment:null}`;
async function pointer(p: Page, selector: string) {
  const point = await p.ev(`(()=>{const b=document.querySelector(${J(selector)});if(!b)return null;b.scrollIntoView({block:"nearest"});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(point, `FOUND real pointer target ${selector}`);
  await p.page("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await p.page("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}
async function setup(p: Page, extra = "") {
  await deliverState(p.ev, p.discovered, extra);
  await click(p.ev, "#setBtn");
  assert.equal(await p.ev(`document.querySelectorAll(${J(BULK)}).length`), 1, "one bulk button FOUND");
}
async function choose(p: Page, keyboard = false) {
  await click(p.ev, BULK);
  const selector = '#pop [data-cli="codex"][data-model]';
  assert.ok(await p.ev(`document.querySelector(${J(selector)})`), "codex choice FOUND");
  if (keyboard) { await p.ev(`document.querySelector(${J(selector)}).focus()`); await press(p.page, "Enter"); }
  else await click(p.ev, selector);
}
const answer = (p: Page, sent: any, extra = {}) => deliver(p.ev, { type: "actionResult", action: "setCrewModelForAll", requestId: sent.requestId, tabId: sent.tabId,
  changed: [{ slot: "coder", label: "Coder" }], skipped: [{ slot: "leader", label: "Leader" }], notice: "Crew choices updated.", ...extra });

test("FCBUI one bulk message by real pointer and keyboard, no optimistic success, pending duplicates refused, named busy result and literal drafts survive", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async (p) => {
    const { ev, discovered, fixed, page } = p;
    await setup(p);
    await pointer(p, BULK);
    assert.equal(await ev(`document.querySelectorAll('#pop [data-clear-model],#pop [data-effort]').length`), 0, "bulk picker offers models only");
    const selector = '#pop [data-cli="codex"][data-model]';
    const model = await ev(`document.querySelector(${J(selector)}).dataset.model`);
    await ev(`document.querySelector(${J(selector)}).focus()`); await press(page, "Enter");
    const sent = await writes(ev);
    console.log(`FCBUI send ${JSON.stringify(sent)}`);
    assert.equal(sent.length, 1, "exactly one bulk message, never per-position messages");
    assert.deepEqual(sent[0], { type: "setCrewModelForAll", requestId: sent[0].requestId, tabId: fixed.id, cli: "codex", model,
      expectedAssignmentsDigest: discovered.projects[0].tabs[0].fixedCrew.assignmentsDigest, confirmReplace: false });
    assert.match(sent[0].requestId, /^[a-f0-9]{32}$/);
    assert.equal(await ev(STATUS), "Saving…", "no success before server confirmation");
    assert.equal(await ev(`document.querySelector(${J(BULK)}).disabled`), true, "bulk button disabled while pending");
    await ev(`document.querySelector(${J(BULK)}).disabled=false`); await choose(p, true);
    assert.equal((await writes(ev)).length, 1, "forced pending control sends no duplicate");
    await answer(p, sent[0]);
    assert.equal(await ev(STATUS), "Crew choices updated. Updated 1 position. Kept 1 working position: Leader.");
    await click(ev, '[data-fc-toggle="coder"]');
    await setValue(ev, '[data-fc-extra="coder"]', 'draft </textarea> & keep');
    const before = await ev(`(()=>{const a=document.querySelector('[data-fc-extra="coder"]');a.setSelectionRange(4,4);const b=document.querySelector('#setBody');b.scrollTop=240;return [a.value,a.selectionStart,a.selectionEnd,b.scrollTop,a.id]})()`);
    await deliverState(ev, discovered, `${crew}.busy.leader=true`);
    const after = await ev(`(()=>{const a=document.activeElement;return [a.value,a.selectionStart,a.selectionEnd,document.querySelector('#setBody').scrollTop,a.id]})()`);
    assert.deepEqual(after, before, "draft, focus, caret and scroll survive the result and broadcasts");
    await answer(p, sent[0], { notice: "late duplicate" });
    assert.doesNotMatch(await ev(STATUS), /late duplicate/);
  }, { fixture: "fixed2" });
});

test("FCBUI confirmation Cancel, stale digest, disconnected and disabled confirmation send nothing; confirm sends once", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async (p) => {
    const { ev, discovered } = p;
    await setup(p, manual);
    await choose(p);
    assert.equal(await ev(`document.querySelector('#confirmModal').hidden`), false, "overwrite question FOUND");
    assert.equal(await ev(`document.querySelector('#confirmBody').textContent`), "Replace the models you chose for this tab? Working positions will be kept. Extra instructions will stay.");
    assert.deepEqual(await writes(ev), [], "no write before confirmation");
    await pointer(p, "#confirmCancel");
    assert.deepEqual(await writes(ev), [], "Cancel sends nothing");
    await choose(p);
    await ev(`document.querySelector(${J(BULK)}).disabled=true`);
    await click(ev, "#confirmOk");
    assert.deepEqual(await writes(ev), [], "disabled opener refuses even a retained confirmation");
    await deliverState(ev, discovered, manual);
    await choose(p);
    await deliverState(ev, discovered, `${manual};${crew}.assignmentsDigest="changed-digest"`);
    await click(ev, "#confirmOk");
    assert.deepEqual(await writes(ev), [], "stale confirmation sends nothing");
    await deliverState(ev, discovered, manual);
    await choose(p);
    await ev(`window.__socket.close()`);
    await click(ev, "#confirmOk");
    assert.deepEqual(await writes(ev), [], "disconnected confirmation sends nothing");
    await p.waitFor(`window.__socket.readyState===1&&document.querySelector('#conn').hidden`, "reconnected");
    await deliverState(ev, discovered, manual);
    await choose(p, true); await pointer(p, "#confirmOk");
    const sent = await writes(ev);
    assert.equal(sent.length, 1, "confirm sends one message");
    assert.equal(sent[0].confirmReplace, true);
  }, { fixture: "fixed" });
});

test("FCBUI result identity, busy notices, tab isolation and dropped reply reconciliation remain honest", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async (p) => {
    const { ev, discovered, fixed, secondFixed } = p;
    await setup(p); await choose(p);
    const [first] = await writes(ev);
    assert.ok(first, "bulk request FOUND before identity checks");
    await answer(p, first, { tabId: secondFixed.id, notice: "foreign tab" });
    await answer(p, first, { requestId: "other-request", notice: "foreign request" });
    assert.equal(await ev(STATUS), "Saving…", "foreign tab or request cannot settle current result");
    await answer(p, first, { changed: [], skipped: [{ slot: "leader", label: "Leader" }], notice: "All positions are busy. No choices changed." });
    assert.match(await ev(STATUS), /^All positions are busy\. No choices changed\./);
    await choose(p); const second = (await writes(ev)).at(-1);
    assert.notEqual(second.requestId, first.requestId, "new request identity FOUND");
    await answer(p, first, { notice: "old response" });
    assert.equal(await ev(STATUS), "Saving…", "late previous reply cannot replace pending result");
    await ev("window.__socket.close()");
    await p.waitFor(`(${STATUS}).startsWith('Not confirmed')`, "lost reply becomes unknown");
    await p.waitFor(`window.__socket.readyState===1&&document.querySelector('#conn').hidden`, "reconnect without resending");
    assert.match(await ev(STATUS), /^Not confirmed/, "unknown until reconciled");
    assert.equal(await ev(`document.querySelector(${J(BULK)}).disabled`), true, "unknown bulk request stays locked until reconciled");
    assert.equal((await writes(ev)).length, 2, "no replay on reconnect");
    await deliverState(ev, discovered, `state.requestActions={${J(second.requestId)}:{status:"done",message:"Done"}}`);
    assert.match(await ev(STATUS), /^The server confirmed this request completed/, "server request ledger reconciles completion without invented counts");
    assert.equal(await ev(`document.querySelector(${J(BULK)}).disabled`), false, "reconciled request unlocks the button");
    await click(ev, '#setModal [data-close]');
    await click(ev, `#tabs [data-tab-id="${secondFixed.id}"]`); await click(ev, '#setBtn');
    assert.equal(await ev(STATUS), "", "second tab has its own result");
    await answer(p, second, { notice: "old tab reply" });
    assert.equal(await ev(STATUS), "", "another tab's late reply cannot change current result");
    assert.notEqual(fixed.id, secondFixed.id);
  }, { fixture: "fixed2" });
});

test("FCBUI waiting status reads current task detail and refuses stale cached approval; rough evidence is unique and actions plus composer reachable at 200 percent", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async (p) => {
    const { ev, discovered, fixed, work, page } = p;
    const serve = async (task: any, reply = true) => {
      const from = await ev("window.__sent.length");
      await deliverState(ev, discovered, `state.projects[0].tabs[0].fixedTask=${J({ taskId: task.id, planVersion: task.planVersion, detailRevision: task.recordRevision, stage: task.stage })}`);
      const requests = await ev(`window.__sent.slice(${from}).filter((m)=>m.type==='getFixedTask')`);
      assert.equal(requests.length, 1, "current detail request FOUND once");
      if (reply) await deliver(ev, { type: "fixedTask", requestId: requests[0].requestId, tabId: fixed.id, task });
    };
    const rough = taskFixture(work, fixed.id, "inspected");
    await serve(rough);
    assert.match(await ev(`document.querySelector('#statusBtn').textContent`), /Waiting on you: look at the rough/);
    await ev("document.querySelector('[data-fct-toggle]').focus()");
    await deliverState(ev, discovered, `state.projects[0].tabs[0].fixedTask=${J({ taskId: rough.id, planVersion: rough.planVersion, detailRevision: rough.recordRevision, stage: rough.stage })}`);
    assert.equal(await ev("document.activeElement?.dataset.fctKey"), "toggle", "task control keeps focus through chat redraws");
    const paths = await ev(`[...document.querySelectorAll('[data-fct-card="rough"] .fct-chip')].map((c)=>c.textContent)`);
    assert.ok(paths.length > 0, "evidence paths FOUND"); assert.equal(new Set(paths).size, paths.length, "each evidence path appears once across categories");
    const approved = { ...taskFixture(work, fixed.id, "roughApproved"), recordRevision: rough.recordRevision + 1 };
    await serve(approved);
    assert.doesNotMatch(await ev(`document.querySelector('#statusBtn').textContent`), /look at the rough/);
    await serve({ ...rough, recordRevision: approved.recordRevision + 1 }, false);
    assert.match(await ev(`document.querySelector('#statusBtn').textContent`), /Reading the current task/, "stale cached approval cannot decide waiting status");
    const request = await ev(`window.__sent.filter((m)=>m.type==='getFixedTask').at(-1)`);
    await deliver(ev, { type: "fixedTask", requestId: request.requestId, tabId: fixed.id, task: { ...rough, recordRevision: approved.recordRevision + 1 } });
    await page("Emulation.setDeviceMetricsOverride", { width: 720, height: 450, deviceScaleFactor: 2, mobile: false });
    for (const selector of ['[data-fct-approve="rough"]', '[data-fct-ask]', '#ci']) {
      await ev(`document.querySelector(${J(selector)}).scrollIntoView({block:'nearest'})`);
      // scrollTop is integer-valued here; layout uses fractional CSS pixels. Require a hit and keyboard focus as well as geometry.
      const visible = await ev(`(()=>{const b=document.querySelector(${J(selector)}),r=b.getBoundingClientRect(),v=document.querySelector('#view').getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);b.focus({preventScroll:true});return document.activeElement===b&&b.contains(hit)&&r.width>0&&r.top>=-1&&r.bottom<=innerHeight+1&&(b.id==='ci'||r.top>=v.top-1&&r.bottom<=v.bottom+1)})()`);
      assert.equal(visible, true, `${selector} reachable with one shared scroll at 200 percent`);
    }
    assert.equal(await ev(`getComputedStyle(document.querySelector('#fixedView')).overflowY`), "visible", "no nested task scroll");
    await deliverState(ev, discovered, `state.projects[0].tabs[0].fixedTask={blocked:true,notice:"Task record could not be read"}`);
    assert.match(await ev(`document.querySelector('#statusBtn').textContent`), /Task blocked/, "blocked task status needs no cached task identity");
  }, { fixture: "fixed" });
});

test("FCBUI live bulk action is one message and server-confirmed choices persist after reload", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async (p) => {
    await click(p.ev, '#setBtn');
    await click(p.ev, '[data-settings-refresh]');
    await p.waitFor(`document.querySelector('[data-fc-model="coder"]').textContent!=='Choose a model'`, "fake CLIs discovered");
    await choose(p, true);
    await p.waitFor(`(${STATUS}).startsWith('Crew choices updated.')`, "server result");
    const sent = await writes(p.ev);
    assert.equal(sent.length, 1, "one real bulk message");
    const saved = JSON.parse(readFileSync(join(p.dataDir, 'config/workspaces.json'), 'utf8')).projects[0].tabs[0].fixedCrew;
    assert.equal(Object.values(saved.preferences).length, 18);
    assert.ok(Object.values(saved.preferences).every((pref: any) => pref.source === 'user' && pref.assignment.cli === sent[0].cli && pref.assignment.model === sent[0].model));
    await p.reload(); await click(p.ev, '#setBtn');
    assert.equal(await p.ev(`[...document.querySelectorAll('.fc-source')].filter((e)=>e.textContent.startsWith('Your choice')).length`), 18);
    assert.deepEqual(await writes(p.ev), [], "no replay after reload");
  }, { fixture: "fixed", realSocket: true });
});
