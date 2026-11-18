import test from "node:test";
import assert from "node:assert/strict";
import { recordingEvents } from "./recording-events.ts";
import { pageHarness } from "./frontend-helpers.ts";
import { actionClient } from "./action-client.ts";
import { withPage, deliverState, delay, click, editorTestMs } from "./pack18-editor-harness.ts";

test("P8 VM event targets record, dispatch and remove document listeners", () => {
  const target = recordingEvents(), events: unknown[] = [];
  const handler = (event: unknown) => events.push(event);
  target.addEventListener("pointerdown", handler);
  target.addEventListener("pointerdown", handler);
  const event = { type: "pointerdown" };
  assert.equal(target.listeners.get("pointerdown")?.size, 1);
  target.dispatchEvent(event);
  assert.deepEqual(events, [event]);
  target.removeEventListener("pointerdown", handler);
  target.dispatchEvent(event);
  assert.deepEqual(events, [event], "removed handlers never run");
  const page = pageHarness();
  for (const type of ["pointerdown", "pointerup", "pointercancel", "keydown", "keyup"]) {
    assert.equal(page.api.document.listeners.get(type)?.size, 1, `${type} confirmation listener registered`);
  }
  assert.equal(page.window.listeners.get("blur")?.size, 1);
  assert.equal(typeof actionClient().onMessage, "function", "the action VM loads the same page listeners");
});

for (const width of [390, 1440]) test(`P8 repeated native close requests share one question at ${width}px`, { timeout: editorTestMs(90_000) }, async () => {
  await withPage(async ({ ev, page, discovered }) => {
    await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await deliverState(ev, discovered, "state.projects[0].tabs[0].activeWork=true");
    await ev(`window.__closeAnswers=[];window.cc.answerClose=a=>__closeAnswers.push(a);answerCloseRequest();answerCloseRequest();true`);
    await delay(450); await click(ev, '#confirmCancel'); await delay(50);
    assert.deepEqual(await ev('__closeAnswers'), ['hold', 'hold', 'keep']);
    assert.equal(await ev(`document.querySelector('#confirmModal').hidden`), true, 'no duplicate close warning remains queued');
    await ev(`confirmAction({title:'Other action',body:'Separate question'},()=>__closeAnswers.push('other'));answerCloseRequest();answerCloseRequest();true`);
    await delay(450); await click(ev, '#confirmOk'); await delay(450);
    assert.equal(await ev(`document.querySelector('#confirmTitle').textContent`), 'Close Command Center?', 'close request queued behind the unrelated question');
    await click(ev, '#confirmOk'); await delay(50);
    assert.deepEqual(await ev('__closeAnswers'), ['hold', 'hold', 'keep', 'hold', 'hold', 'other', 'close']);
    assert.equal(await ev(`document.querySelector('#confirmModal').hidden`), true);
  });
});
