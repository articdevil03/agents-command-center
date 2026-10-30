import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { J, type Page, withPage, skipped, dialog } from "./pack9-page-helpers.ts";

test("chat held by the server: the dialog names who was active, the draft stays, Continue anyway re-sends under a fresh request id with confirmBusy, Cancel sends nothing", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    const chats = (): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type==="chat")`);
    const type = (text: string) => ev(`(()=>{const ci=document.querySelector("#ci");ci.value=${J(text)};ci.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#sendBtn").click();return true})()`);
    const busy = (requestId: string, items: unknown[]) => ev(`__ccDeliver({type:"folderBusy",action:"chat",tabId:${J(tabA)},requestId:${J(requestId)},items:${J(items)}});true`);

    await type("hello there");
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the first send");
    const first = (await chats())[0];
    assert.equal(first.text, "hello there");
    assert.equal("confirmBusy" in first, false, "a normal send carries no confirmation");
    assert.equal(await ev(dialog), null, "control: no dialog before the server answers");
    await busy(first.requestId, [{ tool: "Codex", agoSeconds: 40 }]);
    await waitFor(`(${dialog})!==null`, "the dialog");
    const shown = await ev(dialog);
    assert.equal(shown.title, "Another agent is working in this folder");
    assert.ok(shown.body.startsWith("A Codex session outside Command Center was active here 40 seconds ago."), shown.body);
    assert.deepEqual([shown.ok, shown.cancel], ["Continue anyway", "Cancel"]);
    assert.equal(await ev(`document.querySelector("#ci").value`), "hello there", "the draft is kept");
    assert.equal((await chats()).length, 1, "nothing was sent behind the dialog");
    await shot("a-one-codex-session.png");

    await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===2`, "Continue anyway re-sends");
    const second = (await chats())[1];
    assert.deepEqual([second.text, second.confirmBusy, second.tabId], ["hello there", true, tabA]);
    assert.notEqual(second.requestId, first.requestId, "a fresh request id");
    assert.equal(await ev(`document.querySelector("#ci").value`), "hello there", "the draft stays until the server takes the message");
    await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"user",text:"hello there",requestId:${J(second.requestId)},at:Date.now(),revision:1});true`);
    await waitFor(`document.querySelector("#ci").value===""`, "the draft clears once the message is taken");

    // Two outsiders: a Claude Code session and the catch-all. Cancel keeps the draft and sends nothing; Send works again.
    await type("second draft");
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===3`, "the next send");
    const third = (await chats())[2];
    await busy(third.requestId, [{ tool: "Claude Code", agoSeconds: 12 }, { tool: null, agoSeconds: 75 }]);
    await waitFor(`(${dialog})!==null`, "the dialog for two");
    const two = await ev(dialog);
    assert.ok(two.body.includes("A Claude Code session outside Command Center was active here 12 seconds ago."), two.body);
    assert.ok(two.body.includes("Something outside Command Center changed files here 1 minute ago."), two.body);
    await shot("b-claude-code-and-file-changes.png");
    await ev(`document.querySelector("#confirmCancel").click();true`);
    await waitFor(`(${dialog})===null`, "the dialog closes");
    assert.equal((await chats()).length, 3, "Cancel sent nothing");
    assert.equal(await ev(`document.querySelector("#ci").value`), "second draft", "Cancel keeps the draft");
    await ev(`document.querySelector("#sendBtn").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===4`, "Send is unlocked after the hold");
    assert.equal("confirmBusy" in (await chats())[3], false);
  });
});

test("chat held by the server with an image and a file attached: both stay attached behind the dialog and after Cancel, and Continue anyway re-sends them", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    const chats = (): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type==="chat")`);
    const attached = `[...document.querySelectorAll("#atts .att")].map((e)=>e.textContent.trim())`;
    await ev(`(()=>{const png=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),(c)=>c.charCodeAt(0));
      const transfer=new DataTransfer();transfer.items.add(new File([png],"shot.png",{type:"image/png"}));transfer.items.add(new File(["notes"],"notes.txt",{type:"text/plain"}));
      const input=document.querySelector("#attachInput");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
    await waitFor(`${attached}.length===2&&!document.querySelector("#atts").hidden`, "both attachments are listed");
    await ev(`(()=>{const ci=document.querySelector("#ci");ci.value="with files";ci.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#sendBtn").click();return true})()`);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the send (after both uploads)");
    const first = (await chats())[0];
    assert.equal(first.images?.length, 1, "the image rides along");
    assert.equal(first.files?.length, 1, "and the file");
    const names = await ev(attached);
    const busy = (requestId: string) => ev(`__ccDeliver({type:"folderBusy",action:"chat",tabId:${J(tabA)},requestId:${J(requestId)},items:[{tool:"Codex",agoSeconds:9}]});true`);
    await busy(first.requestId);
    await waitFor(`(${dialog})!==null`, "the dialog");
    assert.deepEqual(await ev(attached), names, "both stay attached behind the dialog");
    await ev(`document.querySelector("#confirmCancel").click();true`);
    await waitFor(`(${dialog})===null`, "the dialog closes");
    assert.deepEqual(await ev(attached), names, "and after Cancel");
    assert.equal(await ev(`document.querySelector("#ci").value`), "with files");

    await ev(`document.querySelector("#sendBtn").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===2`, "sending again");
    const second = (await chats())[1];
    await busy(second.requestId);
    await waitFor(`(${dialog})!==null`, "the dialog again");
    await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="chat").length===3`, "Continue anyway re-sends");
    const third = (await chats())[2];
    assert.deepEqual([third.confirmBusy, third.text, third.images, third.files], [true, "with files", first.images, first.files], "the same image and file go with the confirmed message");
    assert.deepEqual(await ev(attached), names, "still attached until the server takes the message");
    await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"user",text:"with files",requestId:${J(third.requestId)},at:Date.now(),revision:1});true`);
    await waitFor(`${attached}.length===0`, "released once the message is taken");
  });
});

test("Run held by the server: the dialog keeps the brief, Cancel leaves the Run dialog usable, Continue anyway starts it with confirmBusy", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    const runs = (): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type==="run")`);
    // A worker seat's Run button, the way a person reaches it.
    await ev(`document.querySelector('#crew [data-seat-id="coder"] [data-seat-open]').click();true`);
    await waitFor(`document.querySelector("#stagehead [data-run-seat]")!==null`, "the seat's Run button");
    await ev(`document.querySelector("#stagehead [data-run-seat]").click();true`);
    await waitFor(`!document.querySelector("#runModal").hidden`, "the Run dialog");
    await ev(`(()=>{const p=document.querySelector("#runPrompt");p.value="build the thing";p.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#runStart").click();return true})()`);
    await waitFor(`window.__sent.some((m)=>m.type==="run")`, "the Run is sent");
    const first = (await runs())[0];
    assert.deepEqual([first.prompt, first.tabId, "confirmBusy" in first], ["build the thing", tabA, false]);
    const busy = () => ev(`__ccDeliver({type:"folderBusy",action:"run",tabId:${J(tabA)},items:[{tool:"OpenCode",agoSeconds:5}]});true`);
    await busy();
    await waitFor(`(${dialog})!==null`, "the dialog");
    assert.ok((await ev(dialog)).body.startsWith("An OpenCode session outside Command Center was active here 5 seconds ago."), "the right article");
    await ev(`document.querySelector("#confirmCancel").click();true`);
    await waitFor(`(${dialog})===null`, "closed");
    assert.equal(await ev(`document.querySelector("#runStart").disabled`), false, "Start run is usable again");
    assert.equal(await ev(`document.querySelector("#runStart").textContent`), "Start run");
    assert.equal(await ev(`document.querySelector("#runPrompt").value`), "build the thing", "the brief is kept");
    assert.equal(await ev(`document.querySelector("#runModal").hidden`), false, "the Run dialog stays open");
    assert.equal((await runs()).length, 1, "Cancel sent nothing");

    await ev(`document.querySelector("#runStart").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="run").length===2`, "the second try");
    await busy();
    await waitFor(`(${dialog})!==null`, "the dialog again");
    await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`window.__sent.filter((m)=>m.type==="run").length===3`, "Continue anyway starts the run");
    const third = (await runs())[2];
    assert.deepEqual([third.prompt, third.slot, third.tabId, third.confirmBusy], ["build the thing", first.slot, tabA, true]);
    await ev(`__ccDeliver({type:"runAccepted",tabId:${J(tabA)},runId:"r1"});true`);
    await waitFor(`document.querySelector("#runModal").hidden`, "the Run dialog closes once the run is accepted");
  });
});
