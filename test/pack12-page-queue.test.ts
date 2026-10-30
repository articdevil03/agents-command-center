import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { appSource } from "./source-text.ts";
import { delay, J, type Page, withPage, skipped, dialog, sentOf, setActive, typeAndEnter, typeAndClick, queueOf, deliver, chatMsg, goButton, waitQueue, watchUploads, uploaded, attach, transcriptDom } from "./pack12-page-helpers.ts";

test("while the leader replies the message box stays open: Enter and the button queue the message above the box, nothing is sent, the button says Queue", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    assert.equal(await ev(`document.querySelector("#sendBtn").getAttribute("aria-label")`), "Send message", "control: idle leader, plain Send");
    await setActive(ev, tabA, true);
    await waitFor(`document.querySelector("#sendBtn").getAttribute("aria-label")==="Queue message"`, "the button reads Queue while the leader replies");
    await typeAndEnter(ev, "first queued");
    await waitQueue(waitFor, 1, "the first message is queued");
    assert.equal(await ev(`document.querySelector("#ci").value`), "", "the box is empty for the next message");
    await typeAndClick(ev, "second queued");
    await waitQueue(waitFor, 2, "the second message is queued");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["first queued", "Steer"], ["second queued", "Steer"]]);
    assert.equal((await sentOf(ev, "chat")).length + (await sentOf(ev, "steer")).length, 0, "nothing reached the server");
    assert.equal(await ev(`document.querySelector("#ci").readOnly`), false, "the box is still open");
    await shot("01-queue-two-messages.png");
  });
});

test("Steer sends a steer (never a chat); the reply so far is written down, the steer follows it, the rest streams below; the queue drops the message once the server took it", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    await setActive(ev, tabA, true);
    await deliver(ev, { type: "chatDelta", tabId: tabA, text: "Here is the first part. " });
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("first part")`, "the draft streams");
    await typeAndEnter(ev, "also check the tests");
    await waitQueue(waitFor, 1, "queued");
    await typeAndEnter(ev, "and the docs");
    await waitQueue(waitFor, 2, "two queued");
    await goButton(ev, 0);
    await waitFor(`window.__sent.some((m)=>m.type==="steer")`, "the steer goes out");
    const steers = await sentOf(ev, "steer");
    assert.deepEqual(steers.map((m) => [m.text, m.tabId]), [["also check the tests", tabA]]);
    assert.equal((await sentOf(ev, "chat")).length, 0, "Steer is never a normal send");
    assert.equal((await queueOf(ev))[0]!.off, true, "the item waits for the server's answer");
    // The server's answer: the reply so far (marked split), the steer, then the rest.
    await chatMsg(ev, tabA, "assistant", "Here is the first part. ", { split: true });
    await chatMsg(ev, tabA, "user", "also check the tests", { requestId: steers[0].requestId });
    await waitQueue(waitFor, 1, "the steered message left the queue");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["and the docs"], "the other one still waits");
    await waitFor(`!document.querySelector("#view [data-stream]")`, "the draft is gone (it is the message above the steer now)");
    await deliver(ev, { type: "chatDelta", tabId: tabA, text: "Now the rest of the reply streams." });
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("rest of the reply")`, "the rest streams below the steer");
    const lines = await transcriptDom(ev);
    assert.ok(lines.at(-3)!.includes("Here is the first part."), JSON.stringify(lines));
    assert.ok(lines.at(-2)!.includes("also check the tests"));
    assert.ok(lines.at(-1)!.includes("rest of the reply"));
    await shot("02-chat-after-steer.png");
  });
});

test("the reply ends normally: the first waiting message goes out as a normal send, the next one waits for that reply; an x removes a message and nothing of it is ever sent", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await setActive(ev, tabA, true);
    for (const [index, text] of ["one", "two", "three"].entries()) { await typeAndEnter(ev, text); await waitQueue(waitFor, index + 1, `${text} queued`); }
    await ev(`document.querySelectorAll("#queue [data-queue-remove]")[1].click();true`); // "two" is removed
    await waitQueue(waitFor, 2, "x removes the second message");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["one", "three"]);
    // The state still says replying: nothing goes out. chatDone alone does not release it either.
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await delay(300);
    assert.equal((await sentOf(ev, "chat")).length, 0, "not before the state says the leader is idle");
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===1`, "the first waiting message goes out");
    const first = (await sentOf(ev, "chat"))[0];
    assert.deepEqual([first.text, "confirmBusy" in first], ["one", false]);
    assert.equal((await sentOf(ev, "steer")).length, 0, "an automatic send is a normal chat");
    await delay(300);
    assert.equal((await sentOf(ev, "chat")).length, 1, "the next one waits for that reply to end");
    // The server takes it, its reply runs, then ends: the next goes out.
    await chatMsg(ev, tabA, "user", "one", { requestId: first.requestId });
    await setActive(ev, tabA, true);
    await waitQueue(waitFor, 1, "the sent message left the queue");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 2, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===2`, "the third message goes out after the second reply");
    assert.equal((await sentOf(ev, "chat"))[1].text, "three");
    assert.equal((await sentOf(ev, "chat")).some((m) => m.text === "two"), false, "the removed message was never sent");
  });
});

test("a queued message keeps its own attachments: the box is free for the next message, the automatic send carries the exact uploaded file AND image paths, and a Steer carries its attachments too", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await watchUploads(ev);
    await setActive(ev, tabA, true);
    await attach(ev, "notes.txt", "text/plain");
    await attach(ev, "shot.png", "image/png");
    await waitFor(`document.querySelectorAll("#atts .att").length===2`, "the file and the image are attached");
    await waitFor(`window.__uploads.length===2`, "both uploads finished");
    await typeAndEnter(ev, "read the notes");
    await waitQueue(waitFor, 1, "queued with both");
    assert.equal(await ev(`document.querySelector("#atts").hidden`), true, "the composer's attachment list is empty again");
    assert.equal((await queueOf(ev))[0]!.files, "notes.txt, shot.png", "the queued item shows its file and its image");
    const [filePath] = await uploaded(ev, "file"), [imagePath] = await uploaded(ev, "image");
    assert.ok(filePath && imagePath && filePath !== imagePath, "control: the server returned two different paths");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the automatic send");
    const chat = (await sentOf(ev, "chat"))[0];
    assert.deepEqual([chat.text, chat.files, chat.images], ["read the notes", [filePath], [imagePath]], "the same file and the same image ride along, by their exact paths");
    // The server took it and its reply runs: a second message with its own file and image is queued, then steered.
    await chatMsg(ev, tabA, "user", "read the notes", { requestId: chat.requestId });
    await waitQueue(waitFor, 0, "the sent message left the queue");
    await setActive(ev, tabA, true);
    await attach(ev, "more.txt", "text/plain");
    await attach(ev, "more.png", "image/png");
    await waitFor(`window.__uploads.length===4`, "the second pair uploaded");
    await typeAndEnter(ev, "and this too");
    await waitQueue(waitFor, 1, "the second message is queued");
    const [, moreFile] = await uploaded(ev, "file"), [, moreImage] = await uploaded(ev, "image");
    await goButton(ev, 0);
    await waitFor(`window.__sent.some((m)=>m.type==="steer")`, "the steer");
    const steer = (await sentOf(ev, "steer"))[0];
    assert.deepEqual([steer.text, steer.files, steer.images], ["and this too", [moreFile], [moreImage]], "a Steer carries the exact paths of its attachments");
    assert.equal((await sentOf(ev, "chat")).length, 1, "and is no normal chat");
  });
});

test("a Stop or a failed reply: nothing goes out on its own, each message shows Send, and Send is a normal chat; Clear empties the queue", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "alpha"); await waitQueue(waitFor, 1, "alpha");
    await typeAndEnter(ev, "beta"); await waitQueue(waitFor, 2, "beta");
    await deliver(ev, { type: "chatError", tabId: tabA, message: "leader turn stopped" });
    await setActive(ev, tabA, false);
    await delay(400);
    assert.equal((await sentOf(ev, "chat")).length, 0, "nothing went out on its own");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["alpha", "Send"], ["beta", "Send"]]);
    await shot("03-queue-after-stop.png");
    // A later reply that ends normally (a message typed after the Stop) must not release the held ones either.
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 3, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await delay(400);
    assert.equal((await sentOf(ev, "chat")).length, 0, "held messages never go out on their own, not even after another reply ended");
    await goButton(ev, 1);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "Send sends a normal chat");
    assert.equal((await sentOf(ev, "chat"))[0].text, "beta");
    assert.equal((await sentOf(ev, "steer")).length, 0);
    await deliver(ev, { type: "chatCleared", tabId: tabA, revision: 0, savedRevision: 0, messages: [] });
    await waitQueue(waitFor, 0, "Clear empties the queue");
    assert.equal(await ev(`document.querySelector("#queue").hidden`), true);
  });
});

test("refusals put a message back: busy goes to the FRONT, steerRefused stays in place, Steer is disabled with a reason while an approval waits", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "A"); await waitQueue(waitFor, 1, "A");
    await typeAndEnter(ev, "B"); await waitQueue(waitFor, 2, "B");
    // An approval card is waiting: Steer is off and says why; a click does nothing.
    await setActive(ev, tabA, true, `tab.pendingApprovals=[{approvalId:"ap1",tool:"Bash",summary:"echo",createdAt:1}];`);
    await waitFor(`document.querySelector("#queue .qwhy")?.textContent==="Answer the approval first"`, "the reason shows");
    assert.equal((await queueOf(ev))[0]!.off, true);
    await ev(`document.querySelectorAll("#queue [data-queue-go]")[0].click();true`);
    await delay(200);
    assert.equal((await sentOf(ev, "steer")).length, 0, "nothing sent while an approval waits");
    await setActive(ev, tabA, true, `tab.pendingApprovals=[];`);
    await waitFor(`!document.querySelector("#queue .qwhy")`, "the reason clears");
    // The server refuses the steer (Save started meanwhile): A keeps its place.
    await goButton(ev, 0);
    await waitFor(`window.__sent.some((m)=>m.type==="steer")`, "A is steered");
    const steer = (await sentOf(ev, "steer"))[0];
    await deliver(ev, { type: "steerRefused", tabId: tabA, requestId: steer.requestId, reason: "save", message: "Save is running. Send it when Save is done." });
    await waitFor(`document.querySelectorAll("#queue [data-queue-go]")[0]?.disabled===false`, "A is free again");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["A", "B"], "same place");
    // The leader is not up yet (the server says "starting"): the same, A keeps its place.
    await goButton(ev, 0);
    await waitFor(`window.__sent.filter((m)=>m.type==="steer").length===2`, "A is steered again");
    const again = (await sentOf(ev, "steer"))[1];
    await deliver(ev, { type: "steerRefused", tabId: tabA, requestId: again.requestId, reason: "starting", message: "The leader has not started this reply yet." });
    await waitFor(`document.querySelectorAll("#queue [data-queue-go]")[0]?.disabled===false`, "A is free again after 'starting'");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["A", "B"], "same place after 'starting'");
    // Stop: B is sent as a normal chat and the server says busy (another window began a reply): B returns to the front.
    await deliver(ev, { type: "chatError", tabId: tabA, message: "leader turn stopped" });
    await setActive(ev, tabA, false);
    await waitFor(`document.querySelectorAll("#queue [data-queue-go]")[1]?.textContent==="Send"`, "Send buttons");
    await goButton(ev, 1);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "B is sent");
    const chat = (await sentOf(ev, "chat"))[0];
    await deliver(ev, { type: "error", action: "chat", reason: "busy", tabId: tabA, requestId: chat.requestId, message: "leader is still answering the previous message" });
    await waitFor(`document.querySelectorAll("#queue .qitem")[0]?.querySelector(".qtext").firstChild.textContent==="B"`, "B is back at the front");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["B", "A"]);
    assert.equal((await queueOf(ev))[0]!.off, false, "and can be sent again");
  });
});

test("a composer message that meets a reply begun elsewhere (busy) is queued instead of lost", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await typeAndEnter(ev, "typed before the state caught up");
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "sent as a normal chat (the state says idle)");
    const chat = (await sentOf(ev, "chat"))[0];
    await deliver(ev, { type: "error", action: "chat", reason: "busy", tabId: tabA, requestId: chat.requestId, message: "leader is still answering the previous message" });
    await waitQueue(waitFor, 1, "it joined the queue");
    assert.equal(await ev(`document.querySelector("#ci").value`), "", "and the box is empty, not holding a second copy");
    assert.equal((await queueOf(ev))[0]!.text, "typed before the state caught up");
  });
});

test("folder busy on a queued message: the dialog names the activity, the message stays queued (never sent on its own again), Send asks again, Continue anyway confirms", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    const chats = () => sentOf(ev, "chat");
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "careful");
    await waitQueue(waitFor, 1, "queued");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===1`, "the automatic send");
    const auto = (await chats())[0];
    assert.equal("confirmBusy" in auto, false, "the automatic send never confirms for the person");
    await deliver(ev, { type: "folderBusy", action: "chat", tabId: tabA, requestId: auto.requestId, items: [{ tool: "Codex", agoSeconds: 20 }] });
    await waitFor(`(${dialog})!==null`, "the dialog");
    assert.equal((await ev(dialog)).title, "Another agent is working in this folder");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["careful", "Send"]], "the message stays in the queue");
    await ev(`document.querySelector("#confirmCancel").click();true`);
    await waitFor(`(${dialog})===null`, "the dialog closes");
    // The reply ends again later: the held message is not sent on its own.
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 2, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await delay(400);
    assert.equal((await chats()).length, 1, "never goes out without the person's confirm");
    // Send asks the server again (without confirmBusy); the server holds it again; Continue anyway confirms.
    await goButton(ev, 0);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===2`, "Send sends again");
    const again = (await chats())[1];
    assert.equal("confirmBusy" in again, false);
    await deliver(ev, { type: "folderBusy", action: "chat", tabId: tabA, requestId: again.requestId, items: [{ tool: "Codex", agoSeconds: 21 }] });
    await waitFor(`(${dialog})!==null`, "the dialog again");
    await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===3`, "Continue anyway");
    const confirmed = (await chats())[2];
    assert.deepEqual([confirmed.text, confirmed.confirmBusy], ["careful", true]);
    // And a steer that is held is confirmed as a steer.
    await chatMsg(ev, tabA, "user", "careful", { requestId: confirmed.requestId });
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "push this in");
    await waitQueue(waitFor, 1, "queued again");
    await goButton(ev, 0);
    await waitFor(`window.__sent.some((m)=>m.type==="steer")`, "the steer");
    const steer = (await sentOf(ev, "steer"))[0];
    await deliver(ev, { type: "folderBusy", action: "chat", tabId: tabA, requestId: steer.requestId, items: [{ tool: "Claude Code", agoSeconds: 5 }] });
    await waitFor(`(${dialog})!==null`, "the dialog for the steer");
    await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="steer").length===2`, "Continue anyway steers");
    const second = (await sentOf(ev, "steer"))[1];
    assert.deepEqual([second.text, second.confirmBusy], ["push this in", true]);
    assert.equal((await chats()).length, 3, "no normal chat for a steer");
  });
});

test("the sweep: every chatSendLocked site in public/app.js is one this file knows (a send lock that ignores the queue would block typing during a reply)", () => {
  const source = appSource();
  const lines = source.split("\n").map((line) => line.trim()).filter((line) => line.includes("chatSendLocked("));
  assert.deepEqual(lines.map((line) => line.slice(0, 60)), [
    "function chatSendLocked(tabId) { return pendingChatByTab.has",
    "button.disabled = chatSendLocked(tab.id) || savePending.has(",
    "$(\"sendBtn\").disabled = !tab || !canChat || !$(\"ci\").value.t",
    "if (!tab || !inChat(tab) || savePending.has(tab.id) || chatS",
  ], "a new chatSendLocked site needs its own look");
  assert.match(source, /function chatSendLocked\(tabId\) \{ return pendingChatByTab\.has\(tabId\); \}/, "only a send on its way locks the box");
  assert.match(source, /if \(replyActive\(tab\.id\)\) \{ void queueComposer\(tab\.id\); return; \}/, "and sendChat queues while the leader replies");
  assert.equal((source.match(/type: steer \? "steer" : "chat"/g) ?? []).length, 1, "the queue sends a steer only while a reply runs");
});
