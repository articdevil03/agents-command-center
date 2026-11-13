import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, press, delay, taskFixture, type Page } from "./pack18-editor-harness.ts";

// Pack 26 Block 3c: a fixed tab's task panel in a real headless Chrome running the real page. States are the real server's own
// (harness fixtures "fixed" and "fixed2"); task records are built by the server's createTask (harness taskFixture) and delivered over
// a fake socket, so every outgoing message is recorded exactly and every reply can be late, refused, for another tab or lost.
// A delivered state is NOT persistence proof: approvals on disk and after a reload are test/fixed-crew-task-page-live.test.ts.

const HOSTILE = `</script></section><img src=x onerror="window.__pwned=1"> &lt;b&gt;bold&lt;/b&gt; & "quoted" 'single'`;
const SAME_MODEL = "The same model will build and review. A second AI provider can make reviews stronger.";
const AUTHORITY = ["approveFixedPlan", "approveFixedRough", "requestFixedTaskAction", "approveLook", "advanceStep", "reviewClean", "reviewFindings", "finishFix"];
const count = (ev: Page["ev"]): Promise<number> => ev("window.__sent.length");
async function sentSince(ev: Page["ev"], from: number, types: string[]): Promise<any[]> {
  const sent = (await ev(`window.__sent.slice(${from})`)).filter((message: any) => types.includes(message.type));
  console.log(`FCTUI sent: ${JSON.stringify(sent)}`);
  return sent;
}
// Exactly one authority message since `from`; the count is asserted BEFORE anything reads the message, so a missing send fails by assertion.
async function sentOnce(ev: Page["ev"], from: number, what: string): Promise<any> {
  const sent = await sentSince(ev, from, AUTHORITY);
  assert.equal(sent.length, 1, `${what}: exactly one approval message was sent`);
  return sent[0];
}
const bare = ({ requestId, ...rest }: any) => rest;
const summary = (task: any) => ({ taskId: task.id, planVersion: task.planVersion, detailRevision: task.recordRevision, stage: task.stage });
const FIXED = `state.projects[0].tabs.find((t)=>t.fixedCrew)`;
// The task is set on the tab it belongs to (task.tabId), in its own block so two of them can be joined in one change.
const withTask = (task: any, extra = "") => `{const tab=state.projects[0].tabs.find((t)=>t.id===${J(task.tabId)});tab.fixedTask=${J(summary(task))};${extra}}`;
// Waits for the page's own getFixedTask after `from` and returns it.
async function asked(ev: Page["ev"], waitFor: Page["waitFor"], from: number): Promise<any> {
  await waitFor(`window.__sent.slice(${from}).some((m)=>m.type==="getFixedTask")`, "the page asked for the task");
  return (await ev(`window.__sent.slice(${from}).filter((m)=>m.type==="getFixedTask").at(-1)`));
}
// A state naming `task`, then the server's detail reply to the page's own request for it.
async function serve(ev: Page["ev"], waitFor: Page["waitFor"], state: any, task: any, extra = ""): Promise<void> {
  const from = await count(ev);
  await deliverState(ev, state, withTask(task, extra));
  const request = await asked(ev, waitFor, from);
  await deliver(ev, { type: "fixedTask", requestId: request.requestId, tabId: request.tabId, task });
}
const panel = (ev: Page["ev"]): Promise<any> => ev(`(()=>{const v=document.querySelector("#fixedView"),q=(s)=>v.querySelector(s);return {hidden:v.hidden,
  line:q("[data-fct-line]")?.textContent??null,reason:q("[data-fct-reason]")?.textContent??null,cards:[...v.querySelectorAll("[data-fct-card]")].map((c)=>c.dataset.fctCard),
  expanded:q("[data-fct-toggle]")?.getAttribute("aria-expanded")??null,focus:document.activeElement?.dataset?.fctKey??null,text:v.innerText}})()`);
const approveState = (ev: Page["ev"], kind: string): Promise<any> => ev(`(()=>{const b=document.querySelector('#fixedView [data-fct-approve=${kind}]');return b?{found:true,disabled:b.disabled,label:b.textContent,status:document.querySelector('#fixedView [data-fct-status=${kind}]')?.textContent??""}:{found:false}})()`);
// A click on a control the page drew disabled: the event first, then with the attribute removed. The listener must still refuse.
const forceClick = (ev: Page["ev"], selector: string): Promise<boolean> => ev(`(()=>{const b=document.querySelector(${J(selector)});if(!b)return false;b.dispatchEvent(new MouseEvent("click",{bubbles:true}));b.disabled=false;b.click();return true})()`);

test("FCTUI decision: collapsed and expanded details, late, cross-tab and other-plan replies, literal hostile text, keyboard, focus and scroll through broadcasts", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, discovered, fixed, work }) => {
    const v1 = taskFixture(work, fixed.id, "approved", { scope: HOSTILE });
    let from = await count(ev);
    await deliverState(ev, discovered, withTask(v1));
    const first = await asked(ev, waitFor, from);
    assert.deepEqual(bare(first), { type: "getFixedTask", tabId: fixed.id });
    // A newer record is announced before the reply: a new request. The older request's reply, a reply for another tab and a reply about another plan are all dropped.
    const v2 = { ...structuredClone(v1), recordRevision: v1.recordRevision + 1, reviewPolicy: { ...v1.reviewPolicy, reason: "Newer record's reason" } };
    from = await count(ev);
    await deliverState(ev, discovered, withTask(v2));
    const second = await asked(ev, waitFor, from);
    assert.notEqual(second.requestId, first.requestId);
    await deliver(ev, { type: "fixedTask", requestId: first.requestId, tabId: fixed.id, task: v1 });
    await deliver(ev, { type: "fixedTask", requestId: second.requestId, tabId: "another-tab", task: v2 });
    await deliver(ev, { type: "fixedTask", requestId: second.requestId, tabId: fixed.id, task: { ...v2, planVersion: 9 } });
    let shown = await panel(ev);
    console.log(`FCTUI after late replies: ${JSON.stringify({ ...shown, text: shown.text.slice(0, 120) })}`);
    assert.equal(shown.line, null, "nothing from an older request, another tab or another plan is shown");
    assert.match(shown.text, /Reading the task/);
    await deliver(ev, { type: "fixedTask", requestId: second.requestId, tabId: fixed.id, task: v2 });
    shown = await panel(ev);
    assert.deepEqual([shown.line, shown.reason, shown.expanded, shown.cards], ["Standard risk · One review · No final review", "Reason: Newer record's reason", "false", ["plan-approved"]]);
    // Keyboard: Enter opens the decision, the details are the server's text written literally, Space closes it, focus stays.
    assert.equal(await ev(`(()=>{const b=document.querySelector("#fixedView [data-fct-toggle]");b?.focus();return document.activeElement===b})()`), true, "the decision toggle was FOUND and focused");
    await press(page, "Enter");
    shown = await panel(ev);
    const rows = await ev(`[...document.querySelectorAll("#fixedView [data-fct-row]")].map((r)=>r.dataset.fctRow)`);
    const scope = await ev(`document.querySelector('#fixedView [data-fct-row="Scope"] dd')?.textContent??null`);
    const injected = await ev(`({pwned:window.__pwned??null,images:document.querySelectorAll("#fixedView img").length})`);
    console.log(`FCTUI expanded: ${JSON.stringify({ rows, scope, injected, focus: shown.focus })}`);
    assert.deepEqual([shown.expanded, shown.focus], ["true", "toggle"]);
    assert.deepEqual(rows, ["Scope", "Acceptance criteria", "Blocks", "Depends on", "Required checks", "Positions", "Why this risk", "Why these reviews"]);
    assert.equal(scope, HOSTILE, "the scope is the literal text");
    assert.deepEqual(injected, { pwned: null, images: 0 });
    assert.match(shown.text, /unit · not run on these files yet/);
    assert.equal(await ev(`document.querySelectorAll('#fixedView [data-fct-seat]').length`), 5, "every selected position is listed");
    // An identical broadcast keeps the open decision, the focus and the panel's scroll; a newer record is read again and keeps them too.
    const scrolled = await ev(`(()=>{const v=document.querySelector("#view");v.scrollTop=40;return v.scrollTop})()`);
    assert.ok(scrolled > 0, "control: the expanded panel scrolls");
    await deliverState(ev, discovered, withTask(v2));
    const same = await ev(`[document.querySelector("#view").scrollTop,document.activeElement?.dataset?.fctKey,document.querySelector("#fixedView [data-fct-toggle]").getAttribute("aria-expanded")]`);
    assert.deepEqual(same, [scrolled, "toggle", "true"]);
    const v3 = { ...structuredClone(v2), recordRevision: v2.recordRevision + 1 };
    await serve(ev, waitFor, discovered, v3);
    const after = await ev(`[document.querySelector("#view").scrollTop,document.activeElement?.dataset?.fctKey,document.querySelector("#fixedView [data-fct-toggle]").getAttribute("aria-expanded")]`);
    console.log(`FCTUI broadcasts: before ${JSON.stringify(same)} after ${JSON.stringify(after)}`);
    assert.deepEqual(after, [scrolled, "toggle", "true"]);
    await press(page, " ");
    assert.deepEqual([(await panel(ev)).expanded, (await panel(ev)).focus], ["false", "toggle"], "Space closed it and kept the focus");
  }, { fixture: "fixed" });
});

test("FCTUI plan approval: exact identity, no optimistic approval, disabled listener, refusal stays paused, stale record, cross-tab and late replies", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    const start = await count(ev);
    const planned = taskFixture(work, fixed.id, "planned");
    await serve(ev, waitFor, discovered, planned);
    let shown = await panel(ev);
    assert.deepEqual(shown.cards, ["plan"]);
    assert.match(shown.text, /Plan ready for your approval[\s\S]*Add the task panel above the chat[\s\S]*panel · Task panel[\s\S]*styles · Panel styles/);
    assert.deepEqual(await approveState(ev, "plan"), { found: true, disabled: false, label: "Approve this plan", status: "" });
    // A newer record is announced and not read yet: the control is disabled, and a forced click sends nothing.
    const newer = { ...structuredClone(planned), recordRevision: planned.recordRevision + 1 };
    let from = await count(ev);
    await deliverState(ev, discovered, withTask(newer));
    const request = await asked(ev, waitFor, from);
    assert.equal((await approveState(ev, "plan")).disabled, true, "disabled until the newer record is read");
    from = await count(ev);
    assert.equal(await forceClick(ev, "#fixedView [data-fct-approve=plan]"), true, "the approve control was FOUND");
    await delay(150);
    assert.deepEqual(await sentSince(ev, from, AUTHORITY), [], "zero authority messages from a stale record");
    await deliver(ev, { type: "fixedTask", requestId: request.requestId, tabId: fixed.id, task: newer });
    // One click: exactly one approval, naming the task, plan and record the server sent; the page shows it as waiting, never approved.
    from = await count(ev);
    await click(ev, "#fixedView [data-fct-approve=plan]");
    const sent = await sentOnce(ev, from, "Approve this plan");
    assert.deepEqual(bare(sent), { type: "approveFixedPlan", tabId: fixed.id, taskId: "task-one", planVersion: 1, recordRevision: newer.recordRevision });
    assert.match(sent.requestId, /^[0-9a-f]{32}$/);
    assert.deepEqual(await approveState(ev, "plan"), { found: true, disabled: true, label: "Approving…", status: "Sending…" });
    from = await count(ev);
    await forceClick(ev, "#fixedView [data-fct-approve=plan]");
    await delay(150);
    assert.deepEqual(await sentSince(ev, from, AUTHORITY), [], "a waiting approval is never sent twice");
    // A reply for another tab, or an error for another request, settles nothing.
    await deliver(ev, { type: "fixedTaskResult", requestId: sent.requestId, tabId: "another-tab", taskId: "task-one", recordRevision: 9, executionId: null, executionAvailable: true });
    await deliver(ev, { type: "error", message: "Unrelated refusal", action: "approveFixedPlan", tabId: fixed.id, requestId: "0".repeat(32) });
    assert.equal((await approveState(ev, "plan")).label, "Approving…");
    // A refusal leaves the plan waiting for the owner, with the server's reason.
    await deliver(ev, { type: "error", message: "Stale task revision", action: "approveFixedPlan", tabId: fixed.id, requestId: sent.requestId });
    assert.deepEqual(await approveState(ev, "plan"), { found: true, disabled: false, label: "Approve this plan", status: "Not approved: Stale task revision" });
    assert.deepEqual((await panel(ev)).cards, ["plan"]);
    // The server records it: still no approved card until the server's new record arrives.
    from = await count(ev);
    await click(ev, "#fixedView [data-fct-approve=plan]");
    const again = await sentOnce(ev, from, "Approve after a refusal");
    await deliver(ev, { type: "fixedTaskResult", requestId: again.requestId, tabId: fixed.id, taskId: "task-one", recordRevision: newer.recordRevision + 1, executionId: null, executionAvailable: true });
    shown = await panel(ev);
    assert.deepEqual(shown.cards, ["plan"], "no optimistic approval");
    assert.deepEqual(await approveState(ev, "plan"), { found: true, disabled: true, label: "Approve this plan", status: "The server recorded your answer. Reading the updated task…" });
    from = await count(ev);
    await forceClick(ev, "#fixedView [data-fct-approve=plan]");
    await deliver(ev, { type: "fixedTaskResult", requestId: sent.requestId, tabId: fixed.id, taskId: "task-one", recordRevision: 99, executionId: null, executionAvailable: true });
    await delay(150);
    assert.deepEqual(await sentSince(ev, from, AUTHORITY), [], "nothing sent while the new record is read; a late reply to the refused request changes nothing");
    const approved = { ...taskFixture(work, fixed.id, "approved"), recordRevision: newer.recordRevision + 1 };
    await serve(ev, waitFor, discovered, approved);
    assert.deepEqual((await panel(ev)).cards, ["plan-approved"]);
    assert.deepEqual((await sentSince(ev, start, AUTHORITY)).map((message) => message.type), ["approveFixedPlan", "approveFixedPlan"], "two owner answers in all, and no worker or step was started");
  }, { fixture: "fixed" });
});

test("FCTUI rough pause: evidence, every identity, refusal stays paused, Ask for changes through chat, disconnect leaves it unknown, reconnect reads again and never resends, stale and approved", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    const start = await count(ev);
    const rough = taskFixture(work, fixed.id, "inspected");
    await serve(ev, waitFor, discovered, rough);
    const shown = await panel(ev);
    console.log(`FCTUI rough card: ${shown.text}`);
    assert.deepEqual(shown.cards, ["rough"]);
    assert.match(shown.text, /Rough ready for your look\.[\s\S]*Checked[\s\S]*shots\/rough-narrow\.png[\s\S]*Leader inspection[\s\S]*notes\/leader-inspection\.md/);
    assert.deepEqual(await ev(`[...document.querySelectorAll('#fixedView [data-fct-card=rough] button')].map((b)=>b.textContent)`), ["Approve rough", "Ask for changes"]);
    let from = await count(ev);
    await click(ev, "#fixedView [data-fct-approve=rough]");
    const sent = await sentOnce(ev, from, "Approve rough");
    assert.deepEqual(bare(sent), { type: "approveFixedRough", tabId: fixed.id, taskId: "task-one", planVersion: 1, recordRevision: rough.recordRevision, roughRevision: rough.roughRevision });
    await deliver(ev, { type: "error", message: "The inspected rough revision changed", action: "approveFixedRough", tabId: fixed.id, requestId: sent.requestId });
    assert.deepEqual(await approveState(ev, "rough"), { found: true, disabled: false, label: "Approve rough", status: "Not approved: The inspected rough revision changed" });
    assert.deepEqual((await panel(ev)).cards, ["rough"], "a refusal leaves the rough paused");
    from = await count(ev);
    await click(ev, "#fixedView [data-fct-ask]");
    assert.deepEqual(await ev(`[document.activeElement?.id,document.querySelector("#ci").value]`), ["ci", "Please make these changes: "], "Ask for changes opens the leader's chat");
    assert.deepEqual(await sentSince(ev, from, AUTHORITY), []);
    // A dropped connection while an approval waits: unknown, controls off. The reconnect reads the task again and resends nothing.
    from = await count(ev);
    await click(ev, "#fixedView [data-fct-approve=rough]");
    const lost = await sentOnce(ev, from, "Approve rough before the drop");
    await ev("window.__socket.close()");
    await waitFor(`(document.querySelector('#fixedView [data-fct-status=rough]')?.textContent??"").startsWith("Not confirmed: the connection dropped")`, "the waiting approval became unknown");
    const off = await ev(`({banner:document.querySelector("#fixedView .fct-banner")?.textContent??null,disabled:document.querySelector('#fixedView [data-fct-approve=rough]').disabled})`);
    assert.deepEqual(off, { banner: "Not connected. Approvals are paused, and an answer that was on its way is not confirmed.", disabled: true });
    const reconnectFrom = await count(ev);
    await waitFor(`window.__socket.readyState===1&&document.querySelector("#conn").hidden`, "the page reconnected");
    await delay(1600); // a timer must never turn the unknown answer into a result
    assert.match((await approveState(ev, "rough")).status, /^Not confirmed: the connection dropped/);
    const reread = await asked(ev, waitFor, reconnectFrom);
    await deliver(ev, { type: "fixedTask", requestId: reread.requestId, tabId: fixed.id, task: rough });
    assert.deepEqual(await approveState(ev, "rough"), { found: true, disabled: false, label: "Approve rough", status: "Not confirmed: the server has no record of this answer, so nothing changed. Answer again if it still needs you." });
    // The next one did reach the server before the drop: its own record says so and the approved rough shows.
    from = await count(ev);
    await click(ev, "#fixedView [data-fct-approve=rough]");
    const landed = await sentOnce(ev, from, "Approve rough that reached the server");
    await ev("window.__socket.close()");
    await waitFor(`window.__socket.readyState===1&&document.querySelector("#conn").hidden`, "the page reconnected again");
    const approved = taskFixture(work, fixed.id, "roughApproved");
    approved.recordRevision = 6; approved.requests = [{ id: landed.requestId, digest: "b".repeat(64), result: { recordRevision: 6, executionId: null } }];
    await serve(ev, waitFor, discovered, approved);
    assert.deepEqual((await panel(ev)).cards, ["rough-approved"]);
    assert.deepEqual((await sentSince(ev, start, AUTHORITY)).map((message) => message.requestId), [sent.requestId, lost.requestId, landed.requestId], "every approval was sent once, never resent, never approveLook");
    // A rough whose files changed after the inspection cannot be approved.
    await serve(ev, waitFor, discovered, taskFixture(work, fixed.id, "staleRough"));
    assert.match((await panel(ev)).text, /Files changed since the leader inspected this rough\. A new check is needed\./);
    assert.equal((await approveState(ev, "rough")).disabled, true);
  }, { fixture: "fixed" });
});

test("FCTUI states: stale review, unresolved fixes, interrupted, blocked, needed seat, same-model notice, unavailable data, active run and history, task isolation between two fixed tabs", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, secondFixed, work }) => {
    const start = await count(ev);
    await serve(ev, waitFor, discovered, taskFixture(work, fixed.id, "staleReview"));
    let shown = await panel(ev);
    assert.deepEqual(shown.cards, ["stale"]);
    assert.match(shown.text, /Files changed since this review\. A new check is needed\./);
    // Each record below has a newer revision than the one before, as the server's would.
    const at = (task: any, recordRevision: number) => Object.assign(task, { recordRevision });
    await serve(ev, waitFor, discovered, at(taskFixture(work, fixed.id, "fixOpen", { finding: HOSTILE }), 8));
    shown = await panel(ev);
    assert.deepEqual([shown.cards, shown.line], [["fixes"], "Standard risk · 1 fix open · another review follows · No final review"], "never says one review is enough while a fix is open");
    await click(ev, "#fixedView [data-fct-open]");
    const findings = await ev(`[...document.querySelectorAll("#fixedView [data-fct-finding]")].map((f)=>[f.dataset.fctFinding,f.querySelector(".fct-badge").textContent,f.querySelector(".fct-ftext").textContent,f.querySelector(".fct-why")?.textContent??"",f.querySelector(".fct-chips")?.textContent??""])`);
    console.log(`FCTUI findings: ${JSON.stringify(findings)}`);
    assert.deepEqual(findings, [["finding1", "FIX", HOSTILE, "Still open. Wrong behaviour the owner would notice", "reviews/round1.md"], ["finding2", "PASS", "A comment names the old file", "Comment only", "reviews/round1.md"]]);
    assert.deepEqual(await ev(`({pwned:window.__pwned??null,images:document.querySelectorAll("#fixedView img").length})`), { pwned: null, images: 0 });
    await serve(ev, waitFor, discovered, at(taskFixture(work, fixed.id, "interrupted"), 9));
    shown = await panel(ev);
    assert.deepEqual(shown.cards, ["interrupted"]);
    assert.match(shown.text, /This run was interrupted\. Check what finished before continuing\.[\s\S]*Coder · Build · result unknown/);
    assert.equal(await ev(`document.querySelectorAll("#fixedView [data-fct-approve]").length`), 0);
    let from = await count(ev);
    await deliverState(ev, discovered, `${FIXED}.fixedTask={blocked:true,notice:"Task blocked: Task plan digest mismatch"}`);
    shown = await panel(ev);
    assert.deepEqual(shown.cards, ["blocked"]);
    assert.match(shown.text, /This task is blocked[\s\S]*Task blocked: Task plan digest mismatch/);
    assert.equal(await ev(`Boolean(document.querySelector("#fixedView #fcWorkSettings"))`), true, "Settings is one click away");
    assert.deepEqual(await sentSince(ev, from, ["getFixedTask"]), [], "a blocked task is not read");
    // A position the Planner selected has no model now: the server's own words and a button to that position in Settings.
    const planned = at(taskFixture(work, fixed.id, "planned"), 10);
    await serve(ev, waitFor, discovered, planned, `tab.fixedCrew.preferences.reviewer1={source:"user",assignment:null}`);
    assert.equal(await ev(`document.querySelector('#fixedView [data-fct-need="reviewer1"] span')?.textContent??null`), "Reviewer has no model. Choose one in Settings before continuing.");
    await click(ev, `#fixedView [data-fct-position="reviewer1"]`);
    await waitFor(`document.activeElement?.dataset?.fcModel==="reviewer1"`, "Settings opened on the Reviewer's model control");
    await click(ev, "#setModal [data-close]");
    // The same model reviewing is allowed: the server's notice shows and the approval stays possible.
    await deliverState(ev, discovered, withTask(planned, `tab.fixedCrew.notices.reviewer1={status:"same-model",blocking:false,message:${J(SAME_MODEL)}}`));
    assert.equal(await ev(`document.querySelector("#fixedView [data-fct-same-model]")?.textContent??null`), SAME_MODEL);
    assert.equal((await approveState(ev, "plan")).disabled, false, "the notice never blocks");
    // Saved data this version cannot use: its own notice, no chat and no legacy editor or step bar.
    await deliverState(ev, discovered, `const tab=${FIXED};tab.fixedCrew={version:2,unavailable:true,notice:"This crew requires a newer version of Command Center or valid saved data"};tab.crew=[]`);
    const unavailable = await ev(`(()=>{const shown=(s)=>Boolean(document.querySelector(s)?.getClientRects().length);return {cards:[...document.querySelectorAll("#fixedView [data-fct-card]")].map((c)=>c.dataset.fctCard),view:shown("#view .thread"),composer:shown("#composer"),steps:shown("#stepsWrap"),legacy:document.querySelectorAll("[data-setup-editor],[data-process-action]").length}})()`);
    assert.deepEqual(unavailable, { cards: ["unavailable"], view: false, composer: false, steps: false, legacy: 0 });
    // The selected seat's live run and history replace the panel; Back to the chat brings it back.
    const run = { runId: "run-live", seatSlotId: "coder", seatKey: `${fixed.id}.coder`, status: "working", label: "Build the panel", cli: "codex", model: "gpt-6.1-sol", effort: "medium", startedAt: Date.now(), folderPath: work, output: "compiling the panel", stalled: false };
    await deliverState(ev, discovered, `const tab=${FIXED};tab.runs=[{...${J(run)},crewGenerationId:tab.processState.crewGenerationId}];tab.crew.find((s)=>s.slot==="coder").status="working"`);
    await click(ev, `#crew [data-seat-open="coder"]`);
    await waitFor(`Boolean(document.querySelector("#view #stagehead"))&&document.querySelector("#fixedView").hidden`, "the coder's run view replaced the panel");
    assert.match(await ev(`document.querySelector('#view [data-output-run="run-live"]')?.textContent??""`), /compiling the panel/);
    from = await count(ev);
    await click(ev, `#view [data-run-view="history"]`);
    assert.deepEqual((await sentSince(ev, from, ["historyList"])).map((message) => message.seatKey), [`${fixed.id}.coder`]);
    await click(ev, "#view [data-back-chat]");
    await waitFor(`!document.querySelector("#fixedView").hidden`, "the panel is back over the chat");
    // Two fixed tabs keep their own tasks: each task is read for its own tab, and a late reply for the other tab changes nothing.
    const isolation = await count(ev);
    const firstTask: any = { ...taskFixture(work, fixed.id, "approved"), recordRevision: 20 };
    firstTask.reviewPolicy = { ...firstTask.reviewPolicy, reason: "First tab reason" };
    const secondTask: any = { ...taskFixture(work, secondFixed.id, "planned"), id: "task-second", recordRevision: 21 };
    const showTab = async (tabId: string) => {
      await click(ev, `#tabs [role=tab][data-tab-id="${tabId}"]`);
      await waitFor(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId===${J(tabId)}`, `the tab ${tabId} is shown`);
    };
    from = await count(ev);
    await deliverState(ev, discovered, withTask(firstTask, withTask(secondTask)));
    const firstAsk = await asked(ev, waitFor, from);
    assert.deepEqual(bare(firstAsk), { type: "getFixedTask", tabId: fixed.id }, "the selected first tab asks for its own task");
    from = await count(ev);
    await showTab(secondFixed.id);
    const secondAsk = await asked(ev, waitFor, from);
    assert.deepEqual(bare(secondAsk), { type: "getFixedTask", tabId: secondFixed.id }, "selecting the second tab asks for the second tab's task");
    await deliver(ev, { type: "fixedTask", requestId: secondAsk.requestId, tabId: secondFixed.id, task: secondTask });
    await waitFor(`document.querySelector("#fixedView [data-fct-card]")?.dataset.fctCard==="plan"`, "the second tab's plan card");
    const onSecond = await panel(ev);
    assert.deepEqual(onSecond.cards, ["plan"]);
    assert.match(onSecond.text, /Plan ready for your approval/);
    assert.doesNotMatch(onSecond.text, /First tab reason/, "only the second tab's task appears");
    await deliver(ev, { type: "fixedTask", requestId: firstAsk.requestId, tabId: fixed.id, task: firstTask });
    await delay(150);
    assert.deepEqual(await panel(ev), onSecond, "a late reply for the first tab cannot replace the selected second tab's panel");
    from = await count(ev);
    await showTab(fixed.id);
    await waitFor(`document.querySelector("#fixedView [data-fct-card]")?.dataset.fctCard==="plan-approved"||window.__sent.slice(${from}).some((m)=>m.type==="getFixedTask")`, "the first tab's task panel or its re-read");
    const reread = await ev(`window.__sent.slice(${from}).filter((m)=>m.type==="getFixedTask").at(-1)??null`);
    if (reread) { assert.equal(reread.tabId, fixed.id, "the re-read is for the first tab"); await deliver(ev, { type: "fixedTask", requestId: reread.requestId, tabId: fixed.id, task: firstTask }); }
    await waitFor(`document.querySelector("#fixedView [data-fct-card]")?.dataset.fctCard==="plan-approved"`, "the first tab's own approved task");
    const onFirst = await panel(ev);
    console.log(`FCTUI isolation: first ${JSON.stringify([onFirst.cards, onFirst.reason])} second ${JSON.stringify(onSecond.cards)}`);
    assert.deepEqual([onFirst.cards, onFirst.reason], [["plan-approved"], "Reason: First tab reason"], "back on the first tab: its own task");
    assert.deepEqual(await sentSince(ev, isolation, AUTHORITY), [], "showing two tabs' tasks sent no approval");
    assert.deepEqual([...new Set((await sentSince(ev, isolation, ["getFixedTask"])).map((message) => message.tabId))].sort(), [fixed.id, secondFixed.id].sort(), "tasks were read only for the two fixed tabs");
  }, { fixture: "fixed2" });
});

test("FCTUI details identity: a reply for another request, task or plan version is dropped while the newest request waits, and changes neither the panel nor the next read", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    const v1 = taskFixture(work, fixed.id, "approved");
    await serve(ev, waitFor, discovered, v1);
    const v2 = { ...structuredClone(v1), recordRevision: v1.recordRevision + 1 };
    let from = await count(ev);
    await deliverState(ev, discovered, withTask(v2));
    const newest = await asked(ev, waitFor, from);
    const before = await panel(ev);
    // Each foreign reply carries a different reason, so accepting it would change the panel or make the page read the task again.
    const foreign = (what: string, requestId: string, task: any) => ({ what, message: { type: "fixedTask", requestId, tabId: fixed.id, task: { ...task, reviewPolicy: { ...task.reviewPolicy, reason: `Foreign: ${what}` } } } });
    const replies = [
      foreign("older request", "0".repeat(32), v2),
      foreign("another task", newest.requestId, { ...v2, id: "task-other" }),
      foreign("another plan version", newest.requestId, { ...v2, planVersion: 9 }),
    ];
    for (const { what, message } of replies) {
      from = await count(ev);
      await deliver(ev, message);
      await delay(150);
      const after = await panel(ev);
      console.log(`FCTUI foreign reply (${what}): ${JSON.stringify({ reason: after.reason, line: after.line })}`);
      assert.deepEqual([after.line, after.reason, after.text], [before.line, before.reason, before.text], `${what}: the panel is unchanged`);
      assert.deepEqual(await sentSince(ev, from, ["getFixedTask"]), [], `${what}: the page did not drop its waiting request`);
    }
    await deliver(ev, { type: "fixedTask", requestId: newest.requestId, tabId: fixed.id, task: v2 });
    const shown = await panel(ev);
    assert.equal(shown.reason, `Reason: ${v2.reviewPolicy.reason}`, "control: the reply to the newest request is taken");
  }, { fixture: "fixed" });
});
