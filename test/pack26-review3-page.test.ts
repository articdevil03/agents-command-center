import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, delay, taskFixture, press } from "./pack18-editor-harness.ts";
import { historicalCss } from "./pack26-review3-css-fixtures.ts";
import { archiveFixture, archiveItems } from "./pack18-editor-task-fixture.ts";
import { count, read, shown, openList, listReply, detailReply, serveTask, refusal } from "./fixed-crew-task-archives-helpers.ts";

test("P26R8P Show more retry preserves keyboard continuation", { timeout: editorTestMs(90_000) }, async t => {
  if (skipped(t)) return;
  await withPage(async ({ ev, page, waitFor, discovered, fixed, secondFixed }) => {
    for (const focus of ["composer", "heading", "other-tab"]) {
      await deliverState(ev, discovered); const first = await openList(ev, waitFor);
      await deliver(ev, listReply(first, archiveItems(50), "finished-050"));
      await click(ev, '[data-fct-arch="more"]'); const from = await count(ev);
      await ev(`document.querySelector('[data-fct-arch="more"]').focus()`);
      await click(ev, '[data-fct-arch="more"]'); const failed = await read(ev, waitFor, from, "listFixedTaskArchives");
      await deliver(ev, refusal(failed, "Explicit page failure"));
      const retryFrom = await count(ev);
      await ev(`document.querySelector('[data-fct-arch="retry"]').focus()`); await press(page, "Enter");
      const pending = await read(ev, waitFor, retryFrom, "listFixedTaskArchives");
      assert.equal(await count(ev), retryFrom + 1, "exactly one explicit retry read");
      assert.notEqual(pending.requestId, failed.requestId);
      assert.equal((await shown(ev)).focus, "arch-heading", "waiting interaction owns heading");
      if (focus === "other-tab") await click(ev, `#tabs [data-tab-id="${secondFixed.id}"]`);
      if (focus !== "heading") await ev(`(()=>{const c=document.querySelector('#ci');c.value='keep draft';c.focus();c.setSelectionRange(2,6);return true})()`);
      await deliver(ev, listReply(pending, archiveItems(1, 50), null));
      if (focus === "heading") assert.equal((await shown(ev)).focus, "arch-row-finished-051");
      else assert.deepEqual(await ev(`[document.activeElement.id,document.querySelector('#ci').value,document.querySelector('#ci').selectionStart,document.querySelector('#ci').selectionEnd]`), ["ci", "keep draft", 2, 6]);
      if (focus === "other-tab") { assert.equal(await ev(`document.querySelector('[data-fct-tab]').dataset.fctTab`), secondFixed.id); await click(ev, `#tabs [data-tab-id="${fixed.id}"]`); }
      await click(ev, '[data-fct-arch="current"]');
    }
  }, { fixture: "fixed2" });
});
test("P26R8P incomplete detail deadline reason", { timeout: editorTestMs(90_000) }, async t => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    await deliverState(ev, discovered); const first = await openList(ev, waitFor);
    await deliver(ev, listReply(first, archiveItems(1), null));
    const open = async () => { const from = await count(ev); await click(ev, '[data-fct-arch="row"]'); return read(ev, waitFor, from, "getFixedTaskArchive"); };
    let request = await open(); const archive = archiveFixture(work, fixed.id, request.taskId);
    const invalid = detailReply(request, structuredClone(archive)); invalid.manifest.recordRevision++;
    await deliver(ev, invalid); assert.deepEqual((await shown(ev)).states, ["loading"]);
    await deliver(ev, detailReply(request, archive)); assert.match((await shown(ev)).text, /Finished task/);
    await click(ev, '[data-fct-arch="list"]'); request = await open();
    const began = Date.now(), bad = detailReply(request, structuredClone(archive)); bad.manifest.recordRevision++;
    await deliver(ev, bad); await delay(1000); assert.deepEqual((await shown(ev)).states, ["loading"]);
    await waitFor(`Boolean(document.querySelector('[data-fct-arch-state="task-error"]'))`, "real incomplete detail deadline", 29_000);
    assert.ok(Date.now() - began >= 19_900 && Date.now() - began <= 30_000);
    assert.match((await shown(ev)).text, /The reply could not be read\./);
    console.log(`INVALID DETAIL elapsed=${Date.now()-began} reason=${(await shown(ev)).text}`);
    const from = await count(ev); await click(ev, '[data-fct-arch="retry"]');
    const retry = await read(ev, waitFor, from, "getFixedTaskArchive"); assert.notEqual(retry.requestId, request.requestId);
    await deliver(ev, detailReply(retry, archive)); assert.deepEqual((await shown(ev)).states, []);
  }, { fixture: "fixed" });
});
