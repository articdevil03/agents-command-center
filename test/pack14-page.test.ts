import test from "node:test";
import assert from "node:assert/strict";
import { withFixedBehaviour, type Page } from "./fixed-page-behaviour.ts";
import { delay, J, skipped } from "./pack18-editor-harness.ts";

// Pack 14, the page side, on the fixed crew: a real headless Chrome runs the real page script (public/app/*.js) against a fake socket. The Replying bubble shows what the leader is doing (and nothing once
// the reply ends), a line by the message box and a row under the crew show the background jobs of a Claude leader with their running time, the status bar stops saying
// "ready when you are" while a job runs, and a reply Claude started by itself reads as a normal saved leader message.
// Server, Chrome and teardown come from the shared fixed-crew adapter (fixed-page-behaviour.ts): two fixed tabs, fake CLI runner, temp data, free port, never 4317, Chrome window at X >= 1920.
// With CC_PACK14_SHOTS=<folder> the rough look is saved there as PNGs (the adapter's own switch is CC_PACK9_SHOTS, so a shot borrows it for the one call).
const withPage = (body: (page: Page) => Promise<void>) => withFixedBehaviour((page) => body({
  ...page,
  shot: async (name) => {
    const folder = process.env.CC_PACK14_SHOTS, previous = process.env.CC_PACK9_SHOTS;
    if (!folder) return;
    process.env.CC_PACK9_SHOTS = folder;
    try { await page.shot(name); } finally { if (previous === undefined) delete process.env.CC_PACK9_SHOTS; else process.env.CC_PACK9_SHOTS = previous; }
  },
}));

// ---- helpers ----
let revision = 100;
const deliver = (ev: Page["ev"], message: unknown): Promise<boolean> => ev(`__ccDeliver(${J(message)});true`);
const chatMsg = (ev: Page["ev"], tabId: string, role: string, text: string): Promise<boolean> => deliver(ev, { type: "chatMessage", tabId, role, text, at: Date.now(), revision: ++revision });
// The server's state for a tab: replying or not, what it is doing, the background jobs; `extra` is page code run on the tab first.
const setTab = (ev: Page["ev"], tabId: string, patch: { active?: boolean; activity?: string | null; jobs?: Array<{ id: string; description: string; startedAt: number }> }): Promise<boolean> => ev(`(()=>{const tab=window.__ccSeed.projects[0].tabs.find((t)=>t.id===${J(tabId)});const patch=${J(patch)};
  if(patch.active!==undefined)tab.derived={...(tab.derived||{}),leaderTurnActive:patch.active};
  if(patch.activity!==undefined)tab.leaderActivity=patch.activity;
  if(patch.jobs!==undefined)tab.leaderJobs=patch.jobs;
  __ccDeliver({...structuredClone(window.__ccSeed),type:"state"});return true})()`);
const stepText = (ev: Page["ev"]): Promise<{ text: string; hidden: boolean; inReplyingBubble: boolean; dots: boolean } | null> => ev(`(()=>{const e=document.querySelector("#view [data-activity]");if(!e)return null;const msg=e.closest(".msg");return{text:e.textContent,hidden:e.hidden,inReplyingBubble:/Replying/.test(msg?.querySelector(".meta")?.textContent??""),dots:Boolean(msg?.querySelector(".typing"))}})()`);
const MIN = 60_000;
// Two animation frames after a delivered state: the page has drawn it, so the protected labels and hidden states are read directly (a wait on a broken page would only time out).
const settled = (ev: Page["ev"]): Promise<boolean> => ev(`new Promise((ok)=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`);
const textOf = (ev: Page["ev"], selector: string): Promise<string | null> => ev(`document.querySelector(${J(selector)})?.textContent ?? null`);
// The process step bar is gone (Pack 26 slice 2e): the status is a plain element and the retired step mount is absent.
const statusWithoutStepBar = async (ev: Page["ev"], label: string) => assert.deepEqual(await ev(`({status:document.querySelector("#statusBtn")!==null,retiredStep:document.querySelector("#statusBtn .stepn")!==null})`), { status: true, retiredStep: false }, label);

test("the Replying bubble shows what the leader is doing, in the dots bubble and with the draft, follows each change, and is gone when the reply ends", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    assert.equal(await stepText(ev), null, "control: nothing replying, no step line");
    await statusWithoutStepBar(ev, "control: the status element is there and the retired step mount is not");
    await setTab(ev, tabA, { active: true });
    await waitFor(`document.querySelector("#view .typing")!==null`, "the dots bubble");
    assert.equal((await stepText(ev))?.hidden, true, "no step yet: the span is there but hidden");
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Searching the web" });
    await settled(ev);
    assert.equal(await textOf(ev, "#view [data-activity]"), "Searching the web", "the step shows");
    assert.deepEqual(await stepText(ev), { text: "Searching the web", hidden: false, inReplyingBubble: true, dots: true }, "inside the Replying bubble, next to the dots");
    await shot("01-replying-searching-the-web.png");
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Using skill: deep-research" });
    await settled(ev);
    assert.equal(await textOf(ev, "#view [data-activity]"), "Using skill: deep-research", "the next step replaces it");
    // The draft bubble keeps the step in its header.
    await deliver(ev, { type: "chatDelta", tabId: tabA, text: "Here is the first part. " });
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("first part")`, "the draft streams");
    assert.deepEqual(await stepText(ev), { text: "Using skill: deep-research", hidden: false, inReplyingBubble: true, dots: false }, "the draft's header carries the step");
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Running a command" });
    await settled(ev);
    assert.equal(await textOf(ev, "#view [data-stream] [data-activity]"), "Running a command", "it follows while the draft streams");
    await statusWithoutStepBar(ev, "the status element is still the only status and no 'Step N of M' mount came back");
    // Cleared by the server (null), then a new label, then the end of the reply.
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: null });
    await settled(ev);
    assert.equal(await ev(`document.querySelector("#view [data-activity]")?.hidden`), true, "a clear hides it");
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Reading a file" });
    await settled(ev);
    assert.equal(await textOf(ev, "#view [data-activity]"), "Reading a file", "shown again");
    await chatMsg(ev, tabA, "assistant", "Here is the first part. And the rest.");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: revision, savedRevision: 1 });
    // The page forgets the step at chatDone itself, before any state message says the reply is over.
    assert.equal(await ev(`(()=>{const e=document.querySelector("#view [data-activity]");return !e||e.hidden||e.textContent===""})()`), true, "chatDone clears the step line on its own");
    await setTab(ev, tabA, { active: false });
    await waitFor(`document.querySelector("#view [data-activity]")===null`, "gone when the reply ends");
    assert.ok(!(await ev(`document.querySelector("#view").textContent`)).includes("Reading a file"), "and the words are nowhere in the chat");
    // A label that arrives late, after chatDone, with no reply running, is not drawn.
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Thinking" });
    await delay(150);
    assert.equal(await stepText(ev), null, "no bubble, no step line");
  });
});

test("a step line is the server's words as plain text (nothing in it is markup), also when the page connects mid-reply (the state carries it), per tab, and a Stop or failure clears it", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    // Mid-reply connect: the state alone says what it is doing.
    await setTab(ev, tabA, { active: true, activity: "Editing files" });
    await settled(ev);
    assert.equal(await textOf(ev, "#view [data-activity]"), "Editing files", "the state carries the step");
    const markup = `<img src=x onerror="window.__pwned=1"><b>bold</b>`;
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: markup });
    await settled(ev);
    assert.equal(await ev(`document.querySelector("#view [data-activity]")?.textContent.startsWith("<img")`), true, "the words are shown as text");
    assert.equal(await ev(`document.querySelector("#view [data-activity] img, #view [data-activity] b")`), null, "no element was made from them");
    // A full render (the next state message) builds the bubble from the same words: still text.
    await setTab(ev, tabA, { active: true, activity: markup });
    await settled(ev);
    assert.equal(await ev(`document.querySelector("#view [data-activity]")?.textContent.startsWith("<img")`), true, "after a re-render");
    assert.equal(await ev(`document.querySelector("#view [data-activity] img, #view [data-activity] b")`), null, "the re-rendered bubble made no element from them");
    assert.equal(await ev(`window.__pwned===undefined`), true);
    // Another tab's step never shows here; a failed reply clears this one.
    await deliver(ev, { type: "leaderActivity", tabId: tabB, label: "Planning" });
    await delay(100);
    assert.ok(!(await ev(`document.querySelector("#view").textContent`)).includes("Planning"), "only the shown tab's step is drawn");
    await deliver(ev, { type: "leaderActivity", tabId: tabA, label: "Running a command" });
    await deliver(ev, { type: "chatError", tabId: tabA, message: "leader turn stopped" });
    assert.equal(await ev(`(()=>{const e=document.querySelector("#view [data-activity]");return !e||e.hidden||e.textContent===""})()`), true, "chatError clears the step line on its own");
    await setTab(ev, tabA, { active: false, activity: null });
    await waitFor(`document.querySelector("#view [data-activity]")===null`, "a stop clears it");
  });
});

test("background jobs: a line with a spinner by the message box, a row under the crew, the status bar says the leader is free; the running time counts up; all gone when the list is empty", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    const status = () => ev(`(()=>({pill:document.querySelector("#statusBtn .pt")?.textContent??"",sub:document.querySelector("#statusBtn .sub")?.textContent??""}))()`);
    // The leader's name is the assigned fixed leader's own seat name from the server's state, not whichever seat the page draws first.
    const lead = await ev(`(()=>{const tab=window.__ccSeed.projects[0].tabs.find((t)=>t.id===${J(tabA)});return {slot:tab.fixedCrew?.preferences?.leader?.assignment?"leader":null,name:tab.crew.find((s)=>s.slot==="leader"&&s.isLeader)?.name??null}})()`);
    assert.equal(lead.slot, "leader", "control: the tab has an assigned fixed leader");
    assert.ok(lead.name, "control: the leader seat has a name");
    const leaderName = lead.name as string;
    assert.equal(await ev(`document.querySelector("#jobsLine").hidden`), true, "control: no job, no line");
    assert.equal(await ev(`document.querySelector("#crewJobs").hidden`), true, "and no rows");
    assert.match((await status()).sub, /is ready when you are/, "control: the usual idle words");
    // One job, two minutes in.
    await setTab(ev, tabA, { jobs: [{ id: "b1", description: "Generate 5 concept images", startedAt: Date.now() - 2 * MIN }] });
    await settled(ev);
    assert.equal(await ev(`document.querySelector("#jobsLine").hidden`), false, "the line shows");
    assert.equal(await ev(`document.querySelector("#jobsLine").textContent`), "1 background job still running: Generate 5 concept images, 2 min");
    assert.equal(await ev(`document.querySelectorAll("#jobsLine .spin").length`), 1, "with a spinner");
    assert.equal(await ev(`getComputedStyle(document.querySelector("#jobsLine .spin")).animationName`), "spin", "that turns");
    const bar = await status();
    assert.equal(bar.pill, "Ready");
    assert.equal(bar.sub, `${leaderName} is free, 1 background job running`, "the status bar no longer says ready when you are");
    assert.deepEqual(await ev(`[...document.querySelectorAll("#crewJobs .jrow")].map((row)=>[row.querySelector(".jt").textContent,row.querySelector(".ja").textContent,row.querySelectorAll(".spin").length])`), [["Generate 5 concept images", "2 min", 1]], "one row under the crew: description, how long, spinner");
    assert.equal(await ev(`document.querySelector("#crewJobs").previousElementSibling.id`), "crew", "right under the crew list");
    // The same list again (every state message does this) keeps the same spinner: it is not rebuilt, so it does not jump back to its start.
    await ev(`window.__spinLine=document.querySelector("#jobsLine .spin");window.__spinRow=document.querySelector("#crewJobs .spin");true`);
    await setTab(ev, tabA, {});
    assert.equal(await ev(`window.__spinLine===document.querySelector("#jobsLine .spin")&&window.__spinRow===document.querySelector("#crewJobs .spin")`), true, "an unchanged list leaves the spinners alone");
    await shot("02-background-job-line-and-row.png");
    // The line stays while the leader replies, and is under the queue/approval area, not inside the chat.
    await setTab(ev, tabA, { active: true });
    await waitFor(`document.querySelector("#sendBtn").getAttribute("aria-label")==="Queue message"`, "replying");
    assert.equal(await ev(`document.querySelector("#jobsLine").hidden`), false, "also during a reply");
    await setTab(ev, tabA, { active: false });
    // Two jobs.
    await setTab(ev, tabA, { jobs: [{ id: "b1", description: "Generate 5 concept images", startedAt: Date.now() - 5 * MIN }, { id: "b2", description: "Render the intro video", startedAt: Date.now() - 1 * MIN }] });
    await settled(ev);
    assert.equal(await ev(`document.querySelectorAll("#crewJobs .jrow").length`), 2, "two rows");
    assert.equal(await ev(`document.querySelector("#jobsLine").textContent`), "2 background jobs still running, longest 5 min");
    assert.equal((await status()).sub, `${leaderName} is free, 2 background jobs running`);
    // The minutes count up on their own: a job a second short of a minute reads under 1 min, then 1 min.
    await setTab(ev, tabA, { jobs: [{ id: "b3", description: "Short job", startedAt: Date.now() - 59_000 }] });
    await settled(ev);
    assert.equal(await textOf(ev, "#jobsLine"), "1 background job still running: Short job, under 1 min", "under a minute");
    await delay(2500); // the page's own ticker runs every second: 59 s old is 61 s old by now, with nothing delivered
    assert.equal(await textOf(ev, "#jobsLine"), "1 background job still running: Short job, 1 min", "it ticks to 1 min by itself (line)");
    assert.equal(await textOf(ev, "#crewJobs .ja"), "1 min", "it ticks to 1 min by itself (row)");
    // A description is text, never markup.
    await setTab(ev, tabA, { jobs: [{ id: "b4", description: `<b>bold</b> & "q"`, startedAt: Date.now() }] });
    await settled(ev);
    assert.equal(await ev(`document.querySelector("#jobsLine").textContent.includes("<b>bold</b>")`), true, "shown as text");
    assert.equal(await ev(`document.querySelector("#jobsLine b, #crewJobs b")`), null);
    // The list ends: the line, the rows and the wording go back.
    await setTab(ev, tabA, { jobs: [] });
    await settled(ev);
    assert.deepEqual(await ev(`[document.querySelector("#jobsLine").hidden,document.querySelector("#crewJobs").hidden]`), [true, true], "gone");
    assert.match((await status()).sub, /is ready when you are/, "ready when you are again");
  });
});

test("a reply Claude started by itself reads as a normal saved leader message, after the first one, with no draft left behind", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, shot, tabA }) => {
    await chatMsg(ev, tabA, "user", "Generate 5 concept images in the background and tell me when they are done.");
    await setTab(ev, tabA, { active: true });
    await deliver(ev, { type: "chatDelta", tabId: tabA, text: "Started the image job." });
    await chatMsg(ev, tabA, "assistant", "Started the image job.");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision, savedRevision: 1 });
    await setTab(ev, tabA, { active: false, jobs: [{ id: "b1", description: "Generate 5 concept images", startedAt: Date.now() - 3 * MIN }] });
    // The job ends and Claude answers on its own: it streams like a reply, with its step line, then is saved.
    await setTab(ev, tabA, { active: true, activity: "Reading a file" });
    await deliver(ev, { type: "chatDelta", tabId: tabA, text: "The images are ready: all 5 are in the folder " });
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("The images are ready")`, "the follow-up streams");
    assert.equal((await stepText(ev))?.inReplyingBubble, true);
    await setTab(ev, tabA, { jobs: [] });
    await chatMsg(ev, tabA, "assistant", "The images are ready: all 5 are in the folder `concepts/`.");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision, savedRevision: 1 });
    await setTab(ev, tabA, { active: false, activity: null });
    await waitFor(`document.querySelector("#view [data-stream]")===null&&document.querySelector("#view [data-activity]")===null`, "the draft and the step line are gone");
    const rows = await ev(`[...document.querySelectorAll("#view .thread .msg")].map((e)=>(e.querySelector(".md")?.textContent??e.querySelector(".body")?.textContent??e.textContent).trim())`);
    assert.deepEqual(rows.slice(-2), ["Started the image job.", "The images are ready: all 5 are in the folder concepts/."], "two ordinary leader messages, in order");
    await shot("03-saved-follow-up-message.png");
  });
});
