import test from "node:test";
import assert from "node:assert/strict";
import { delay, J, type Page, withPage, skipped, dialog } from "./pack9-page-helpers.ts";

test("Continue anyway is bound to the tab that was warned: if the selected tab changed while the dialog was open, nothing is re-sent (chat or Run) and a toast says so", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    const sent = (type: string): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type===${J(type)})`);
    // The selection is server state: another window (or anything) selects the other tab.
    const selectOther = () => ev(`window.__ccSeed.selectedTabId=${J(tabB)};__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});true`);
    const toast = () => ev(`document.querySelector("#toast").textContent`);
    await ev(`(()=>{const ci=document.querySelector("#ci");ci.value="for tab A";ci.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#sendBtn").click();return true})()`);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the chat send");
    const first = (await sent("chat"))[0];
    await ev(`__ccDeliver({type:"folderBusy",action:"chat",tabId:${J(tabA)},requestId:${J(first.requestId)},items:[{tool:"Codex",agoSeconds:9}]});true`);
    await waitFor(`(${dialog})!==null`, "the chat dialog");
    await selectOther();
    await waitFor(`window.__sent.some((m)=>m.type==="selectTab")||document.querySelector("#tabs [aria-selected=true]")!==null`, "the page took the new selection");
    await delay(300);
    if (await ev(`(${dialog})!==null`)) await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`document.querySelector("#toast").textContent.includes("no longer selected")`, "the toast");
    assert.equal((await sent("chat")).length, 1, "nothing was re-sent for either tab");
    assert.equal((await sent("run")).length, 0);
    // Run: the same, from the Run dialog of the first tab.
    await ev(`window.__ccSeed.selectedTabId=${J(tabA)};__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});true`);
    await waitFor(`document.querySelector('#crew [data-seat-id="coder"] [data-seat-open]')!==null`, "back on the first tab");
    await ev(`document.querySelector('#crew [data-seat-id="coder"] [data-seat-open]').click();true`);
    await waitFor(`document.querySelector("#stagehead [data-run-seat]")!==null`, "the seat's Run button");
    await ev(`document.querySelector("#stagehead [data-run-seat]").click();true`);
    await waitFor(`!document.querySelector("#runModal").hidden`, "the Run dialog");
    await ev(`(()=>{const p=document.querySelector("#runPrompt");p.value="build for A";p.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#runStart").click();return true})()`);
    await waitFor(`window.__sent.some((m)=>m.type==="run")`, "the Run is sent");
    await ev(`__ccDeliver({type:"folderBusy",action:"run",tabId:${J(tabA)},items:[{tool:"OpenCode",agoSeconds:5}]});true`);
    await waitFor(`(${dialog})!==null`, "the Run warning");
    await ev(`document.querySelector("#toast").textContent=""`);
    await selectOther();
    await delay(300);
    if (await ev(`(${dialog})!==null`)) await ev(`document.querySelector("#confirmOk").click();true`);
    await waitFor(`document.querySelector("#toast").textContent.includes("no longer selected")`, "the toast for Run");
    assert.equal((await sent("run")).length, 1, "the Run was not started again, for either tab");
    assert.equal((await sent("chat")).length, 1);
  });
});

test("a hold for a tab that is not on screen only says so: no dialog over another tab's work", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, tabB }) => {
    await ev(`__ccDeliver({type:"folderBusy",action:"chat",tabId:${J(tabB)},requestId:"zzz",items:[{tool:"Codex",agoSeconds:3}]});true`);
    await delay(400);
    assert.equal(await ev(dialog), null);
    assert.ok(await ev(`document.querySelector("#toast").textContent.includes("another agent is working in this folder")`));
  });
});

test("the leader-started notice is a quiet line inside the chat (also after a reload) and stays in the Activity feed with its launch notice, with no pop-up", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    const headsUp = "a Codex session outside Command Center is active in this folder";
    const notice = { type: "leaderLaunch", id: 7, seatId: `${tabA}.coder`, seatName: "Sonny", brief: "build it", source: "Atlas", pending: true, headsUp };
    await ev(`(()=>{if(document.querySelector("#side").hidden)document.querySelector("#sideBtn").click();return true})()`);
    const line = `Heads up: ${headsUp}.`;
    // The server sends the chat line and the launch notice, no chatNotice (the page would turn that into a pop-up).
    await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"notice",text:${J(line)},revision:1,at:Date.now()});__ccDeliver(${J(notice)});true`);
    const feed = `[...document.querySelectorAll("#feed .x")].map((e)=>e.textContent)`;
    await waitFor(`${feed}.length>0`, "the Activity line");
    assert.deepEqual(await ev(feed), [`Atlas requested Sonny \u00b7 heads up: ${headsUp} \u00b7 outcome unconfirmed`]);
    // The chat holds it as a small quiet line: not the leader speaking, not a bubble of yours, and it adds nothing to the Activity feed or the unread dots.
    const notes = `[...document.querySelectorAll("#view .thread .msg.note p")].map((e)=>e.textContent)`;
    await waitFor(`${notes}.length===1`, "the chat line");
    assert.deepEqual(await ev(notes), [line]);
    assert.equal(await ev(`document.querySelectorAll("#view .thread .msg:not(.note)").length`), 0, "no leader or user message is drawn for it");
    assert.equal(await ev(`document.querySelector("#view .msg.note img,#view .msg.note .bubble")`), null, "no avatar and no bubble");
    assert.equal((await ev(feed)).length, 1, "it adds no 'replied' line to the Activity feed");
    // The screenshot shows the chat itself, with the Details panel closed.
    await ev(`(()=>{if(!document.querySelector("#side").hidden)document.querySelector("#sideBtn").click();return true})()`);
    await waitFor(`document.querySelector("#side").hidden`, "Details closed");
    await shot("c-leader-started-notice.png");
    // After a reload the same line comes back with the chat history.
    await ev(`__ccDeliver({type:"chatHistory",tabId:${J(tabA)},messages:[{tabId:${J(tabA)},role:"notice",text:${J(line)},revision:1,at:1}],revision:1,savedRevision:0});true`);
    await waitFor(`${notes}.length===1`, "the chat line after a reload");
    assert.deepEqual(await ev(notes), [line]);
    // No pop-up at any point: the grey line is the only place it shows. A state that carries the notice (a reload) says the same, not twice.
    assert.deepEqual(await ev(`(()=>{const t=document.querySelector("#toast");return [t.classList.contains("on"),t.hidden,t.textContent]})()`), [false, true, ""], "no pop-up for the heads-up");
    await ev(`__ccDeliver({...structuredClone(window.__ccSeed),type:"state",launchSafety:{notices:[${J(notice)}]}});true`);
    await delay(300);
    assert.equal((await ev(feed)).length, 1);
    assert.ok((await ev(feed))[0].includes(`heads up: ${headsUp}`), "kept after the toast");
  });
});

test("the dark pop-up sits just above the message box, also when the box grows; the undo notices stay where they were", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    const rects = () => ev(`(()=>{const r=(s)=>{const b=document.querySelector(s).getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right}};return {toast:r("#toast"),box:r("#cbox"),on:document.querySelector("#toast").classList.contains("on")}})()`);
    const pop = async (text: string) => {
      await ev(`__ccDeliver({type:"chatNotice",tabId:${J(tabA)},message:${J(text)}});true`); // the server's other chatNotice (an old leader that did not stop): any showToast caller would do
      await waitFor(`document.querySelector("#toast").classList.contains("on")&&document.querySelector("#toast").style.bottom!==""`, "the pop-up");
      await delay(300); // the slide-in finishes
      return rects();
    };
    const empty = await pop("tab created");
    console.log("empty composer", JSON.stringify(empty));
    assert.ok(empty.toast.bottom <= empty.box.top - 11 && empty.toast.bottom >= empty.box.top - 13, `the pop-up ends 12px above the message box: ${JSON.stringify(empty)}`);
    assert.ok(Math.abs((empty.toast.left + empty.toast.right) / 2 - (empty.box.left + empty.box.right) / 2) <= 1, "centred over the message box");
    await shot("e-popup-above-composer.png");
    // Grow the box (several lines): the same pop-up stays above its new top.
    await ev(`(()=>{const ci=document.querySelector("#ci");ci.value=${J("one\ntwo\nthree\nfour\nfive")};ci.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
    await delay(300);
    const grown = await pop("tab created again");
    console.log("grown composer", JSON.stringify(grown));
    assert.ok(grown.box.top < empty.box.top - 20, `control: the box really grew: ${empty.box.top} -> ${grown.box.top}`);
    assert.ok(grown.toast.bottom <= grown.box.top - 11 && grown.toast.bottom >= grown.box.top - 13, `still 12px above the grown box: ${JSON.stringify(grown)}`);
    // Growing while the pop-up is showing moves it too.
    await ev(`(()=>{const ci=document.querySelector("#ci");ci.value=${J("1\n2\n3\n4\n5\n6\n7\n8\n9\n10")};ci.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
    await waitFor(`(()=>{const t=document.querySelector("#toast").getBoundingClientRect(),b=document.querySelector("#cbox").getBoundingClientRect();return b.top<${grown.box.top - 20}&&Math.abs(b.top-t.bottom-12)<=1})()`, "the showing pop-up follows the growing box");
    // The undo notices keep their own corner (CSS only), and a dialog is not moved by any of this.
    assert.deepEqual(await ev(`(()=>{const s=getComputedStyle(document.querySelector("#undo"));return [s.position,s.left,s.bottom]})()`), ["fixed", "24px", "24px"], "undo notices stay bottom-left");
  });
});

test("another tab's writer is worded from the server's seat, role and tab name; a stand-alone leader reads the same", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    await ev(`document.querySelector("#ci").value="hello";document.querySelector("#ci").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#sendBtn").click();true`);
    await waitFor(`window.__sent.some((m)=>m.type==="chat")`, "the send");
    const first = (await ev(`window.__sent.filter((m)=>m.type==="chat")`))[0];
    const items = [{ tool: null, agoSeconds: 0, writer: { seatName: "Sonny", roleLabel: "Coder", tabName: "Design" } }, { tool: null, agoSeconds: 0, writer: { seatName: "Atlas", roleLabel: "Leader", tabName: "Solo" } }];
    await ev(`__ccDeliver({type:"folderBusy",action:"chat",tabId:${J(tabA)},requestId:${J(first.requestId)},items:${J(items)}});true`);
    await waitFor(`(${dialog})!==null`, "the dialog");
    const shown = await ev(dialog);
    assert.equal(shown.title, "Another agent is working in this folder");
    assert.equal(shown.body, "Sonny (Coder) in your Design tab is writing code in this folder right now. Atlas (Leader) in your Solo tab is writing code in this folder right now. Working in the same files can overwrite each other's changes.");
    assert.deepEqual([shown.ok, shown.cancel], ["Continue anyway", "Cancel"]);
    await shot("d-other-tab-coder.png");
  });
});
