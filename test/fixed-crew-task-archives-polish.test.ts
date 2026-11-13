import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, delay } from "./pack18-editor-harness.ts";
import { archiveFixture, archiveItems } from "./pack18-editor-task-fixture.ts";
import { count, read, reads, shown, openList, listReply, detailReply, refusal, onlyReads } from "./fixed-crew-task-archives-helpers.ts";

test("FCARCH reply binding", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, secondFixed }) => {
    await deliverState(ev, discovered); const start = await count(ev);
    const first = await openList(ev, waitFor), foreign = [{ ...archiveItems(1)[0], scope: "FOREIGN REPLY" }];
    for (const reply of [listReply({ ...first, requestId: "wrong" }, foreign, null), listReply({ ...first, tabId: secondFixed.id }, foreign, null),
      { type: "fixedTaskArchive", requestId: first.requestId, tabId: first.tabId, taskId: "foreign" }]) {
      await deliver(ev, reply); assert.deepEqual((await shown(ev)).states, ["loading"]); assert.doesNotMatch((await shown(ev)).text, /FOREIGN/);
    }
    await click(ev, '#fixedView [data-fct-arch="current"]'); const newer = await openList(ev, waitFor);
    await deliver(ev, listReply(first, foreign, null)); assert.deepEqual((await shown(ev)).states, ["loading"]);
    await click(ev, `#tabs [role=tab][data-tab-id="${secondFixed.id}"]`);
    await waitFor(`document.querySelector('[data-fct-tab]')?.dataset.fctTab===${J(secondFixed.id)}`, "second panel FOUND");
    const second = await openList(ev, waitFor);
    const focus = (await shown(ev)).focus;
    await deliver(ev, listReply(newer, [{ ...archiveItems(1)[0], scope: "FIRST TAB TEXT" }], null));
    assert.deepEqual((await shown(ev)).states, ["loading"]); assert.equal((await shown(ev)).focus, focus);
    assert.doesNotMatch((await shown(ev)).text, /FIRST TAB TEXT/);
    await deliver(ev, listReply(second, [{ ...archiveItems(1)[0], scope: "SECOND TAB TEXT" }], null));
    assert.match((await shown(ev)).text, /SECOND TAB TEXT/);
    await click(ev, `#tabs [role=tab][data-tab-id="${fixed.id}"]`);
    assert.match((await shown(ev)).text, /FIRST TAB TEXT/); assert.doesNotMatch((await shown(ev)).text, /SECOND TAB TEXT/);
    await click(ev, '#fixedView [data-fct-arch="current"]'); const paged = await openList(ev, waitFor);
    await deliver(ev, listReply(paged, archiveItems(50), "finished-050"));
    await click(ev, '#fixedView [data-fct-arch="more"]'); const from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="more"]'); const oldPage = await read(ev, waitFor, from, "listFixedTaskArchives");
    await click(ev, '#fixedView [data-fct-arch="current"]'); const reopened = await openList(ev, waitFor);
    await deliver(ev, listReply(oldPage, foreign, null)); assert.deepEqual((await shown(ev)).states, ["loading"]);
    await deliver(ev, refusal({ ...reopened, type: "getFixedTaskArchive" }, "wrong operation")); assert.deepEqual((await shown(ev)).states, ["loading"]);
    await deliver(ev, listReply(reopened, [], null)); assert.deepEqual((await shown(ev)).states, ["empty"]);
    await onlyReads(ev, start, "reply binding");
  }, { fixture: "fixed2" });
});

test("FCARCH detail binding", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    await deliverState(ev, discovered); const start = await count(ev);
    const first = await openList(ev, waitFor); await deliver(ev, listReply(first, archiveItems(3), null));
    const open = async (id = "finished-001") => { const from = await count(ev); await click(ev, `#fixedView [data-fct-arch-id="${id}"]`); return read(ev, waitFor, from, "getFixedTaskArchive"); };
    const request = await open(), archive = archiveFixture(work, fixed.id, request.taskId);
    for (const field of ["outer", "task-id", "task-tab", "manifest-id", "manifest-tab", "version", "revision"]) {
      const reply = detailReply(request, structuredClone(archive));
      if (field === "outer") reply.taskId = "foreign";
      if (field === "task-id") reply.task.id = "foreign";
      if (field === "task-tab") reply.task.tabId = "foreign";
      if (field === "manifest-id") reply.manifest.taskId = "foreign";
      if (field === "manifest-tab") reply.manifest.tabId = "foreign";
      if (field === "version") reply.manifest.planVersion++;
      if (field === "revision") reply.manifest.recordRevision++;
      await deliver(ev, reply); assert.deepEqual((await shown(ev)).states, ["loading"], `ignore ${field} without settling`);
    }
    await deliver(ev, detailReply(request, archive)); assert.match((await shown(ev)).text, /Add the task panel above the chat/);
    await click(ev, '#fixedView [data-fct-arch="list"]'); const old = await open();
    await click(ev, '#fixedView [data-fct-arch="list"]'); const newer = await open("finished-002");
    await deliver(ev, detailReply(old, archive)); assert.deepEqual((await shown(ev)).states, ["loading"]);
    await deliver(ev, detailReply(newer, archiveFixture(work, fixed.id, newer.taskId))); assert.match((await shown(ev)).text, /Keep finished task history readable/);
    await click(ev, '#fixedView [data-fct-arch="list"]'); const failed = await open();
    await deliver(ev, refusal(failed, "Read refused")); const from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="retry"]'); const retried = await read(ev, waitFor, from, "getFixedTaskArchive");
    assert.notEqual(retried.requestId, failed.requestId);
    await deliver(ev, detailReply(failed, archive)); assert.deepEqual((await shown(ev)).states, ["loading"]);
    await click(ev, '#fixedView [data-fct-arch="list"]'); await click(ev, '#fixedView [data-fct-arch="current"]');
    const reopened = await openList(ev, waitFor); await deliver(ev, detailReply(retried, archive)); assert.deepEqual((await shown(ev)).states, ["loading"]);
    await deliver(ev, listReply(reopened, [], null)); assert.deepEqual((await shown(ev)).states, ["empty"]);
    await onlyReads(ev, start, "detail binding");
  }, { fixture: "fixed" });
});

test("FCARCH disconnect and retry", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered }) => {
    await deliverState(ev, discovered); const start = await count(ev);
    const first = await openList(ev, waitFor); await deliver(ev, listReply(first, archiveItems(50), "finished-050"));
    await click(ev, '#fixedView [data-fct-arch="more"]'); let from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="more"]'); const old = await read(ev, waitFor, from, "listFixedTaskArchives");
    assert.equal(await ev('(()=>{if(!window.__socket)return false;window.__socket.close();return true})()'), true);
    await waitFor(`document.querySelector('[data-fct-arch-state="offline"]')`, "disconnect event displayed");
    assert.match((await shown(ev)).text, /Not connected\.[\s\S]*Shown as last read\./);
    assert.match((await shown(ev)).text, /More finished tasks could not be loaded/);
    from = await count(ev);
    await waitFor(`window.__socket.readyState===1`, "fake socket reconnected", 10_000);
    await delay(150);
    const automatic = await ev(`window.__sent.slice(${from})`);
    assert.ok(automatic.every((m: any) => ["hello", "getFixedTask"].includes(m.type)), JSON.stringify(automatic));
    assert.deepEqual(await reads(ev, from), [], "reconnect resends no archive action");
    from = await count(ev); await click(ev, '#fixedView [data-fct-arch="retry"]');
    const retry = await read(ev, waitFor, from, "listFixedTaskArchives"); assert.notEqual(retry.requestId, old.requestId);
    await deliver(ev, listReply(old, archiveItems(1, 50), null)); assert.deepEqual((await shown(ev)).more, { label: "Loading more...", disabled: true });
    await deliver(ev, listReply(retry, archiveItems(1, 50), null)); assert.equal((await shown(ev)).rows.length, 51);
    const messages = await ev(`window.__sent.slice(${start})`); console.log("FCARCH reconnect messages " + JSON.stringify(messages));
    assert.ok(messages.every((m: any) => ["hello", "getFixedTask", "selectTab", "listFixedTaskArchives", "getFixedTaskArchive"].includes(m.type)));
  }, { fixture: "fixed" });
});

test("FCARCH unanswered read", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered }) => {
    await deliverState(ev, discovered); const start = await count(ev), began = Date.now();
    const old = await openList(ev, waitFor); await delay(1000);
    assert.deepEqual((await shown(ev)).states, ["loading"], "still loading before real 20-second deadline");
    await waitFor(`Boolean(document.querySelector('[data-fct-arch-state="list-error"]'))`, "bounded real read deadline", 29_000);
    const elapsed = Date.now() - began; console.log(`FCARCH real timeout elapsed=${elapsed}ms outcome=${(await shown(ev)).text}`);
    assert.ok(elapsed >= 19_900 && elapsed <= 30_000);
    assert.match((await shown(ev)).text, /Command Center did not answer in time\.[\s\S]*Try again/); assert.doesNotMatch((await shown(ev)).text, /No finished tasks yet/);
    const from = await count(ev); await click(ev, '#fixedView [data-fct-arch="retry"]');
    const retry = await read(ev, waitFor, from, "listFixedTaskArchives"); assert.notEqual(retry.requestId, old.requestId);
    await deliver(ev, listReply(old, [], null)); assert.deepEqual((await shown(ev)).states, ["loading"]);
    await deliver(ev, listReply(retry, archiveItems(1), null)); assert.equal((await shown(ev)).rows.length, 1);
    await onlyReads(ev, start, "timeout");
  }, { fixture: "fixed" });
});
