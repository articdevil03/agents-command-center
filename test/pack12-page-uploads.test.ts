import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { delay, type Page, withPage, skipped, sentOf, setActive, typeAndEnter, queueOf, deliver, chatMsg, goButton, waitQueue, watchUploads, releaseUploads, uploaded, attach } from "./pack12-page-helpers.ts";

// A message typed while the leader replies, with a file still uploading: queueComposer waits for the upload, and the reply may end meanwhile.
const typeWithSlowFile = async (ev: Page["ev"], waitFor: Page["waitFor"], text: string): Promise<void> => {
  await attach(ev, "notes.txt", "text/plain");
  await waitFor(`document.querySelectorAll("#atts .att").length===1`, "the file is attached (still uploading)");
  await typeAndEnter(ev, text);
  await delay(200);
};

test("fix 1a: a message whose file finishes uploading AFTER a Stop joins the queue held: not sent on its own, shows Send, and a later reply's end does not release it", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev, true);
    await setActive(ev, tabA, true);
    await typeWithSlowFile(ev, waitFor, "read the notes");
    assert.equal((await queueOf(ev)).length, 0, "control: it waits for the file, not in the queue yet");
    await deliver(ev, { type: "chatError", tabId: tabA, message: "leader turn stopped" });
    await setActive(ev, tabA, false);
    await releaseUploads(ev);
    await waitQueue(waitFor, 1, "it joined the queue");
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length + (await sentOf(ev, "steer")).length, 0, "not sent on its own after the Stop");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["read the notes", "Send"]]);
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 3, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length, 0, "held: not even another reply's normal end releases it");
    await goButton(ev, 0);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "Send sends it");
    const [filePath] = await uploaded(ev, "file");
    assert.deepEqual((await sentOf(ev, "chat"))[0].files, [filePath], "with its own file");
  });
});

test("fix 1b: a message whose file finishes uploading AFTER a Clear stays in the box, is not sent and not queued", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev, true);
    await setActive(ev, tabA, true);
    await typeWithSlowFile(ev, waitFor, "read the notes");
    await deliver(ev, { type: "chatCleared", tabId: tabA, revision: 0, savedRevision: 0, messages: [] });
    await setActive(ev, tabA, false);
    await releaseUploads(ev);
    await waitFor(`window.__uploads.length===1`, "the upload finished");
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length + (await sentOf(ev, "steer")).length, 0, "not sent on its own after the Clear");
    assert.equal((await queueOf(ev)).length, 0, "and not queued");
    assert.equal(await ev(`document.querySelector("#ci").value`), "read the notes", "the message is still in the box");
  });
});

test("fix 1c: a message whose file finishes uploading after a NORMAL end goes out in queue order, behind the earlier queued messages (also when the state still says replying)", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev, true);
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "first");
    await waitQueue(waitFor, 1, "first is queued");
    await typeWithSlowFile(ev, waitFor, "second with a file");
    // The reply ends normally: "first" goes out; the file of "second" is still uploading.
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===1`, "first goes out");
    await releaseUploads(ev);
    await waitQueue(waitFor, 2, "the upload finished: second joined the queue behind first");
    await delay(400);
    assert.deepEqual((await sentOf(ev, "chat")).map((m) => m.text), ["first"], "second did not jump ahead or go out on its own");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["first", "second with a file"]);
    // first's reply runs and ends normally: second goes out, with its file.
    const first = (await sentOf(ev, "chat"))[0];
    await chatMsg(ev, tabA, "user", "first", { requestId: first.requestId });
    await setActive(ev, tabA, true);
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 2, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===2`, "second goes out after first's reply");
    const [filePath] = await uploaded(ev, "file");
    assert.deepEqual([(await sentOf(ev, "chat"))[1].text, (await sentOf(ev, "chat"))[1].files], ["second with a file", [filePath]]);
  });
});

test("fix 1d: the reply ended normally but the state still says replying when the file finishes: it is armed, and goes out the moment the state says idle", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev, true);
    await setActive(ev, tabA, true);
    await typeWithSlowFile(ev, waitFor, "late file");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await releaseUploads(ev);
    await waitQueue(waitFor, 1, "it joined the queue");
    await delay(300);
    assert.equal((await sentOf(ev, "chat")).length, 0, "the state still says replying: nothing yet");
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "it goes out as soon as the state says idle");
    assert.equal((await sentOf(ev, "chat"))[0].text, "late file");
    assert.equal((await sentOf(ev, "steer")).length, 0);
  });
});

test("fix 1e: Enter pressed again while the queued message still waits for its upload (the reply has ended meanwhile) does nothing: one message goes out, with its file, once", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev, true);
    await setActive(ev, tabA, true);
    await typeWithSlowFile(ev, waitFor, "read the notes");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await ev(`document.querySelector("#ci").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));true`);
    await delay(400);
    assert.equal((await sentOf(ev, "chat")).length + (await sentOf(ev, "steer")).length, 0, "the second Enter sent nothing: the message is already on its way");
    await releaseUploads(ev);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the upload finished and the message goes out");
    await delay(500);
    const [filePath] = await uploaded(ev, "file");
    assert.deepEqual((await sentOf(ev, "chat")).map((m) => [m.text, m.files]), [["read the notes", [filePath]]], "once, with its file");
  });
});
