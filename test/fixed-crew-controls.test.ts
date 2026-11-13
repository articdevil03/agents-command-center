import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, withPage, skipped, deliverState, deliver, delay, sentOf, J, type Page } from "./pack18-editor-harness.ts";

// Pack 26 Block 5 slice 2e: the old process bar, look card and step, review and fixer buttons are gone from the page. What stays is proved here on the
// real page (fixtures "fixed", fake socket, every message recorded): ordinary status, background jobs, the leader's activity label, real tool
// approvals, Stop (requested, accepted, refused and unconfirmed are different words) and Save. Every read happens right after a delivered state.
const RETIRED_SENDERS = ["approveLook", "advanceStep", "reviewFindings", "finishFix", "reviewClean", "selectFixer"];
const RETIRED_MOUNTS = ["#stepsWrap", "#pipe", "#stepActs", "#rounds", "#stepnote", "#statusBtn .stepn", "[data-process-action]", "[data-fixer]", "#lookCard", "[data-wait-tab]", ".ncard.look"];
const RAIL = `#crew .seat[data-seat-id="leader"]`;
// A state built from the server's own discovered one, with `patch` run on the first (fixed) tab, then given a moment to draw.
async function show(ev: Page["ev"], base: unknown, patch: string, wait = 80): Promise<void> {
  await deliverState(ev, base, `const tab=state.projects[0].tabs[0];${patch}`);
  await delay(wait);
}
const text = (ev: Page["ev"], selector: string): Promise<string | null> => ev(`document.querySelector(${J(selector)})?.textContent ?? null`);
const status = (ev: Page["ev"]): Promise<{ found: boolean; pill: string | null; sub: string | null }> =>
  ev(`(()=>{const s=document.querySelector("#statusBtn");return {found:Boolean(s),pill:s?.querySelector(".pill .pt")?.textContent??null,sub:s?.querySelector(".sub")?.textContent??null}})()`);
const sentTypes = (ev: Page["ev"]): Promise<string[]> => ev(`window.__sent.map((m)=>m.type)`);

test("FCPROC status: a noninteractive status display, ordinary words, the leader's activity and background jobs, and no old process control anywhere", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, discovered }) => {
    await show(ev, discovered, "");
    const display = await ev(`(()=>{const s=document.querySelector("#statusBtn"),pill=s?.querySelector(".pill");return {found:Boolean(s),tag:s?.tagName??null,role:s?.getAttribute("role")??null,toggles:["type","aria-expanded","aria-controls","aria-pressed"].filter((a)=>s?.hasAttribute(a)),pillFound:Boolean(pill),pill:pill?.querySelector(".pt")?.textContent??null,tone:pill?.dataset.tone??null,retired:${J(RETIRED_MOUNTS)}.filter((sel)=>document.querySelector(sel)),saveBtn:Boolean(document.querySelector("#sline #saveBtn")),chatMore:Boolean(document.querySelector("#sline #chatMore"))}})()`);
    assert.equal(display.found, true, "the status display was found");
    assert.equal(display.pillFound, true, "its .pill was found");
    assert.equal(display.tag, "DIV", "the status is a plain element, not a button");
    assert.equal(display.role, "status");
    assert.deepEqual(display.toggles, [], "no step-toggle attributes (type, aria-expanded, aria-controls) are left");
    assert.deepEqual(display.retired, [], "none of the retired mounts or controls is on the page");
    assert.equal(display.saveBtn && display.chatMore, true, "Save and the chat menu are still in the status line");
    assert.equal(display.pill, "Ready");
    assert.equal(display.tone, "idle");
    const before = (await sentTypes(ev)).length;
    await ev(`document.querySelector("#statusBtn").click();true`);
    await delay(60);
    assert.equal(await ev(`document.querySelector("#stepsWrap")`), null, "clicking the status opens nothing");
    assert.equal((await sentTypes(ev)).length, before, "and sends nothing");

    // The leader replying: its own words, with the activity label on the Replying line, whatever the old steps were.
    await show(ev, discovered, `tab.derived={...(tab.derived||{}),leaderTurnActive:true};tab.leaderActivity="Reading the plan"`);
    const replying = await status(ev);
    assert.match(String(replying.pill), / is replying$/, "the status says the leader is replying");
    const activity = await ev(`(()=>{const e=document.querySelector("#view [data-activity]");return e?{text:e.textContent,hidden:e.hidden}:null})()`);
    assert.ok(activity, "the Replying line has an activity label");
    assert.deepEqual(activity, { text: "Reading the plan", hidden: false }, "the label is the leader's current activity");
    await show(ev, discovered, `tab.derived={...(tab.derived||{}),leaderTurnActive:false};tab.leaderActivity=null`);
    assert.equal((await status(ev)).pill, "Ready", "the reply ended: ordinary Ready again");

    // A background job: the row under the crew, the line by the message box and the status all name the work.
    await show(ev, discovered, `tab.leaderJobs=[{id:"b1",description:"Generate the hero image",startedAt:Date.now()-120000}]`);
    const jobs = await ev(`(()=>{const box=document.querySelector("#crewJobs"),line=document.querySelector("#jobsLine");return {box:Boolean(box),hidden:box?.hidden,rows:[...(box?.querySelectorAll(".jrow")??[])].map((r)=>[r.querySelector(".jt")?.textContent,r.querySelector(".ja")?.textContent]),line:line?.textContent??null,lineHidden:line?.hidden}})()`);
    assert.equal(jobs.box, true, "the crew jobs box was found");
    assert.equal(jobs.hidden, false, "it is shown");
    assert.deepEqual(jobs.rows, [["Generate the hero image", "2 min"]], "crewJobs holds exactly the delivered job");
    assert.equal(jobs.lineHidden, false);
    assert.equal(jobs.line, "1 background job still running: Generate the hero image, 2 min", "the composer job line still appears");
    const busy = await status(ev);
    assert.equal(busy.pill, "Ready");
    assert.match(String(busy.sub), /is free, 1 background job running$/, "the status names the background work");
    assert.deepEqual((await sentTypes(ev)).filter((type) => RETIRED_SENDERS.includes(type)), [], "no old process action was sent");
  });
});

test("FCPROC safety: real tool approvals, Stop and Save send their own messages once and keep their states apart", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, discovered, fixed }) => {
    const approval = (id: string, summary: string) => `{approvalId:${J(id)},tool:"Bash",summary:${J(summary)},createdAt:1}`;
    const answers = () => sentOf(ev, "answerApproval");
    const panel = () => ev(`(()=>{const p=document.querySelector("#approvalPanel"),row=document.querySelector(${J(RAIL)});return {found:Boolean(p),hidden:p?.hidden,id:p?.dataset.approvalId??null,summary:document.querySelector("#approvalSummary")?.textContent??null,allow:Boolean(document.querySelector("#approvalAllow")),deny:Boolean(document.querySelector("#approvalDeny")),railFound:Boolean(row),rail:row?.querySelector(".sl")?.textContent??null,railNeeds:row?.classList.contains("need")??false,error:document.querySelector("#approvalError")?.textContent??null,allowDisabled:document.querySelector("#approvalAllow")?.disabled}})()`);
    // Allow: the panel, its summary, the current approval id and the waiting rail row; then exactly one answer with the right ids.
    await show(ev, discovered, `tab.pendingApprovals=[${approval("ap1", "echo allowed")}]`, 600);
    const first = await panel();
    assert.equal(first.found && first.allow && first.deny, true, "the approval panel and its Allow and Deny controls were found");
    assert.deepEqual([first.hidden, first.id, first.summary], [false, "ap1", "echo allowed"], "the panel shows the current approval");
    assert.equal(first.railFound, true, "the leader's rail row was found");
    assert.equal(first.rail, "Waiting on your answer", "the rail row waits on the answer");
    assert.equal(first.railNeeds, true, "and is marked as needing you");
    assert.match(String((await status(ev)).pill), /^Waiting on you: /, "the status says it waits on you");
    await ev(`document.querySelector("#approvalAllow").click();document.querySelector("#approvalAllow").click();true`);
    const allowed = await answers();
    assert.equal(allowed.length, 1, "Allow, clicked twice, sent one answer");
    assert.deepEqual({ ...allowed[0], requestId: typeof allowed[0].requestId }, { type: "answerApproval", requestId: "string", tabId: fixed.id, approvalId: "ap1", allow: true });
    // A reply for another request changes nothing; the refusal for this one shows its words and frees the buttons.
    await deliver(ev, { type: "error", action: "answerApproval", requestId: "someone-elses", message: "not mine" });
    assert.equal((await panel()).error, "Sending your answer...", "another request's refusal is ignored");
    await deliver(ev, { type: "error", action: "answerApproval", requestId: allowed[0].requestId, message: "The server refused" });
    const refused = await panel();
    assert.deepEqual([refused.error, refused.allowDisabled], ["The server refused", false], "this request's refusal shows and the control is usable again");

    // Deny: a separate approval in a separate state.
    await show(ev, discovered, `tab.pendingApprovals=[${approval("ap2", "echo denied")}]`, 600);
    const second = await panel();
    assert.deepEqual([second.hidden, second.id, second.summary], [false, "ap2", "echo denied"]);
    await ev(`document.querySelector("#approvalDeny").click();document.querySelector("#approvalDeny").click();true`);
    const all = await answers();
    assert.equal(all.length, 2, "Deny, clicked twice, added one more answer");
    assert.deepEqual({ ...all[1], requestId: typeof all[1].requestId }, { type: "answerApproval", requestId: "string", tabId: fixed.id, approvalId: "ap2", allow: false });

    // Stop: the real Stop all control and the leader's own Stop in its card; requested, accepted and refused are different words, never a process exit.
    await show(ev, discovered, `tab.pendingApprovals=[];tab.derived={...(tab.derived||{}),busy:true};tab.runs=[{runId:"r1",seatSlotId:"leader",seatName:"Leader",seatIsLeader:true,status:"working",label:"Working"}]`);
    const stopAll = await ev(`(()=>{const b=document.querySelector("#stopAll");return b?{disabled:b.disabled}:null})()`);
    assert.deepEqual(stopAll, { disabled: false }, "the Stop all control was found and is enabled for a live run");
    await ev(`document.querySelector("#stopAll").click();true`);
    await delay(80);
    assert.deepEqual(await sentOf(ev, "stopAll"), [{ type: "stopAll" }], "Stop all sends its own message, once");
    assert.equal((await status(ev)).pill, "Stop requested for Leader", "requested: the run is still there and nothing has changed yet");
    await deliver(ev, { type: "stopAllAccepted" });
    await delay(80);
    const accepted = await status(ev);
    assert.equal(accepted.pill, "Stopping Leader…", "accepted: waiting for the process to close");
    assert.match(String(accepted.sub), /Accepted\. Waiting for the process to close/);
    await show(ev, discovered, `tab.runs=[{runId:"r1",seatSlotId:"leader",seatName:"Leader",seatIsLeader:true,status:"working",label:"Working"}];state.launchSafety={...(state.launchSafety||{}),uncertain:[{runId:"r1",seatKey:tab.id+".leader",seatId:tab.id+".leader"}]}`);
    assert.match(String((await status(ev)).pill), /may still be running: the stop was not confirmed$/, "unconfirmed is its own state, not an exit");
    // The leader's card carries its own Stop and per-run Stop, each with its own message.
    await show(ev, discovered, `tab.leaderStatus="ready";tab.runs=[{runId:"r2",seatSlotId:"leader",seatName:"Leader",seatIsLeader:true,status:"working",label:"Working"}]`);
    await ev(`document.querySelector(${J(RAIL + " [data-seat-pic]")})?.click();true`);
    await delay(120);
    const card = await ev(`(()=>{const run=document.querySelector("#seatPop [data-stop-run]"),seat=document.querySelector("#seatPop [data-stop-seat]");return {run:run?.dataset.stopRun??null,seat:Boolean(seat)}})()`);
    assert.deepEqual(card, { run: "r2", seat: true }, "the card's per-run and per-seat Stop controls were found");
    await ev(`document.querySelector("#seatPop [data-stop-run]").click();true`);
    await delay(80);
    assert.deepEqual(await sentOf(ev, "killRun"), [{ type: "killRun", runId: "r2" }], "the run's Stop sends killRun for that run");
    assert.equal((await status(ev)).pill, "Stop requested for Leader");
    await deliver(ev, { type: "error", action: "killRun", runId: "r2", message: "The server refused" });
    await delay(80);
    assert.doesNotMatch(String((await status(ev)).pill), /^Stop/, "a refused Stop is released: it no longer says Stop requested");
    await ev(`document.querySelector("#seatPop [data-stop-seat]").click();true`);
    await delay(80);
    assert.deepEqual(await sentOf(ev, "stopSeat"), [{ type: "stopSeat", tabId: fixed.id, slot: "leader" }], "the seat's Stop sends stopSeat for that seat");

    // Save: the real button, a refusal, a retry and a late success.
    await show(ev, discovered, `tab.runs=[];tab.derived={...(tab.derived||{}),busy:false}`);
    await ev(`document.querySelector("#saveBtn").click();true`);
    await delay(80);
    assert.deepEqual(await sentOf(ev, "save"), [{ type: "save", tabId: fixed.id }], "Save sends its own message");
    assert.equal(await text(ev, "#saveSt"), "Saving…");
    await deliver(ev, { type: "error", action: "save", tabId: fixed.id, message: "Disk is full" });
    await delay(80);
    assert.deepEqual([(await status(ev)).pill, (await status(ev)).sub, await text(ev, "#saveSt")], ["Save failed", "Disk is full", "Save failed"], "a refused Save says so and keeps its words");
    assert.match(String(await ev(`document.querySelector("#saveBtn").textContent`)), /Retry save/);
    await ev(`document.querySelector("#saveBtn").click();true`);
    await delay(80);
    assert.equal((await sentOf(ev, "save")).length, 2, "Retry sends a second save");
    await deliver(ev, { type: "saved", tabId: fixed.id, revision: 3, savedRevision: 3 });
    await delay(80);
    assert.notEqual((await status(ev)).pill, "Save failed", "a late success clears the failure");
    assert.notEqual(await text(ev, "#saveSt"), "Save failed");
    assert.deepEqual((await sentTypes(ev)).filter((type) => RETIRED_SENDERS.includes(type)), [], "no retired approval or step sender was used");
  });
});
