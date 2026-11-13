import test from "node:test";
import assert from "node:assert/strict";
import { withPage, deliverState, deliver, click, setValue, taskFixture, editorTestMs } from "./pack18-editor-harness.ts";

test("P26 browser missing Leader preserves work panel and chat through clearing and reassignment", { timeout: editorTestMs(90_000) }, async () => {
  await withPage(async ({ ev, seed, discovered, fixed }) => {
    assert.match(await ev('document.querySelector("#view").innerText'), /Leader has no model/);
    assert.equal(await ev('Boolean(document.querySelector("#fixedView:not([hidden]) [data-fct-position=leader]"))'), true);
    assert.doesNotMatch(await ev('document.querySelector("#view").innerText'), /Waiting for server state|is ready|Tell .*what you want/);
    await deliverState(ev, discovered);
    await deliver(ev, { type: "chatHistory", tabId: fixed.id, messages: [{ role: "assistant", text: "Keep this conversation", at: Date.now() }], revision: 1, savedRevision: 0 });
    await deliverState(ev, discovered, `const t=state.projects[0].tabs[0]; t.fixedCrew.preferences.leader={assignment:null,source:"user"};t.crew=t.crew.filter(s=>!s.isLeader&&s.slot!=="leader");`);
    assert.match(await ev('document.querySelector("#view").innerText'), /Keep this conversation/);
    assert.match(await ev('document.querySelector("#view").innerText'), /Leader has no model/);
    assert.equal(await ev('document.querySelector("#fixedView").hidden'), false);
    assert.equal(await ev('document.querySelector("#cbox").hidden'), true);
    assert.equal(await ev('Boolean(document.querySelector("#view [data-run-seat]"))'), false, "worker-only crew keeps the default work view");
    await deliverState(ev, discovered);
    assert.equal(await ev('document.querySelector("#cbox").hidden'), false);
    assert.match(await ev('document.querySelector("#view").innerText'), /Keep this conversation/);
    await deliverState(ev, seed);
    assert.equal(await ev('Boolean(document.querySelector("#fixedView [data-fct-position=leader]"))'), true);
  });
});

test("P26 browser Run acknowledgement closes only matching dialog and allows later Run", { timeout: editorTestMs(90_000) }, async () => {
  await withPage(async ({ ev, discovered }) => {
    await deliverState(ev, discovered);
    await click(ev, '[data-seat-open="coder"]');
    await click(ev, '[data-run-seat]');
    await setValue(ev, "#runPrompt", "First request"); await click(ev, "#runStart");
    const request = await ev('window.__sent.filter(m=>m.type==="run").at(-1)');
    assert.ok(request);
    await deliver(ev, { type: "fixedRunRequested", tabId: request.tabId, slot: "planner" });
    assert.equal(await ev('document.querySelector("#runModal").hidden'), false);
    await deliver(ev, { type: "fixedRunRequested", tabId: request.tabId, slot: request.slot });
    assert.equal(await ev('document.querySelector("#runModal").hidden'), true);
    assert.match(await ev('document.querySelector("#toast").textContent'), /requested/);
    await click(ev, '[data-run-seat]'); await setValue(ev, "#runPrompt", "Second request"); await click(ev, "#runStart");
    assert.equal(await ev('window.__sent.filter(m=>m.type==="run").length'), 2);
  });
});

test("P26 browser approval cards retain restored background padding and action row", { timeout: editorTestMs(90_000) }, async () => {
  await withPage(async ({ ev, discovered, fixed, work }) => {
    const task = taskFixture(work, fixed.id, "planned");
    await deliverState(ev, discovered, `state.projects[0].tabs[0].fixedTask=${JSON.stringify({ taskId: task.id, planVersion: task.planVersion, detailRevision: task.recordRevision, stage: task.stage })};`);
    const request = await ev('window.__sent.filter(m=>m.type==="getFixedTask").at(-1)'); assert.ok(request);
    await deliver(ev, { type: "fixedTask", tabId: fixed.id, requestId: request.requestId, task });
    const styles = await ev(`(()=>{const card=document.querySelector(".ask.fct-card"),s=getComputedStyle(card),a=getComputedStyle(card.querySelector(".acts"));return {padding:s.padding,background:s.backgroundColor,radius:s.borderRadius,display:a.display,maxWidth:s.maxWidth}})()`);
    assert.equal(styles.padding, "16px 18px"); assert.equal(styles.radius, "16px");
    assert.notEqual(styles.background, "rgba(0, 0, 0, 0)"); assert.equal(styles.display, "flex"); assert.equal(styles.maxWidth, "none");
  });
});
