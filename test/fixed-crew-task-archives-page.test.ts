import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, press, delay, taskFixture, type Page } from "./pack18-editor-harness.ts";
import { archiveFixture, archiveItems } from "./pack18-editor-task-fixture.ts";

// S-F3 Finished tasks, ROUGH tier: the real page in a real headless Chrome with the real server's fixed tab states (harness fixtures
// "fixed" and "fixed2"). Archive replies are delivered by hand over the fake socket, so every request the page sends is recorded exactly
// at the socket. Fake-socket delivery is UI evidence only, never proof of what is on disk.

import { HOSTILE, READS, BROWSING, count, bare, summary, onlyReads, read, reads, shown, openList, listReply, detailReply, refusal, serveTask } from "./fixed-crew-task-archives-helpers.ts";

test("FCARCH entry: shown with no current task and with an active one, exact first read, loading, a real empty list, Back, and an unavailable tab sends nothing", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    const start = await count(ev);
    await deliverState(ev, discovered);
    let view = await shown(ev);
    assert.deepEqual([view.entry, view.open], [true, false], "the entry was FOUND with no current task");
    assert.match(view.text, /Finished tasks[\s\S]*No plan yet/, "the entry sits above the No plan yet line");
    assert.deepEqual(await reads(ev, start), [], "drawing the entry reads no archive");
    const first = await openList(ev, waitFor);
    assert.deepEqual(Object.keys(first).sort(), ["cursor", "limit", "requestId", "tabId", "type"], "exactly the contract's keys");
    assert.deepEqual(bare(first), { type: "listFixedTaskArchives", tabId: fixed.id, cursor: null, limit: 50 });
    assert.match(first.requestId, /^[0-9a-f]{32}$/);
    view = await shown(ev);
    assert.deepEqual([view.open, view.states, view.focus], [true, ["loading"], "arch-heading"]);
    assert.match(view.text, /Loading finished tasks\.\.\./);
    assert.doesNotMatch(view.text, /No finished tasks yet/, "loading is never shown as empty");
    await deliver(ev, listReply(first, [], null));
    view = await shown(ev);
    assert.deepEqual([view.states, view.rows, view.more], [["empty"], [], null]);
    assert.match(view.text, /No finished tasks yet\./);
    await click(ev, '#fixedView [data-fct-arch="current"]');
    view = await shown(ev);
    assert.deepEqual([view.open, view.entry, view.focus], [false, true, "arch-entry"], "Back to current task returns focus to the entry");
    // An active current task keeps its panel and the entry above it.
    await serveTask(ev, waitFor, discovered, taskFixture(work, fixed.id, "approved"));
    assert.equal(await ev(`document.querySelector("#fixedView [data-fct-card]")?.dataset.fctCard`), "plan-approved");
    assert.equal((await shown(ev)).entry, true, "the entry was FOUND beside an active task");
    const again = await openList(ev, waitFor);
    assert.notEqual(again.requestId, first.requestId);
    await deliver(ev, listReply(again, archiveItems(1), null));
    assert.deepEqual((await shown(ev)).rows, ["finished-001"]);
    await click(ev, '#fixedView [data-fct-arch="current"]');
    assert.equal(await ev(`document.querySelector("#fixedView [data-fct-card]")?.dataset.fctCard`), "plan-approved", "the live panel is back");
    // Saved data this version cannot use: no archive controls and no read.
    const from = await count(ev);
    await deliverState(ev, discovered, `const tab=state.projects[0].tabs.find((t)=>t.id===${J(fixed.id)});tab.fixedCrew={version:2,unavailable:true,notice:"This crew requires a newer version"};tab.crew=[]`);
    view = await shown(ev);
    assert.equal(view.entry, false, "no entry on an unavailable tab");
    assert.equal(await ev(`document.querySelector("#fixedView [data-fct-arch-unavailable]")?.textContent??null`), "Finished tasks aren't available on this tab.");
    assert.deepEqual(await reads(ev, from), [], "an unavailable tab is never asked about");
    await onlyReads(ev, start, "entry");
  }, { fixture: "fixed" });
});

test("FCARCH paging: a full first page shows three rows, Show more reveals the cached rows, then asks for the next page once and appends it, then ends", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered }) => {
    await deliverState(ev, discovered);
    const start = await count(ev);
    const first = await openList(ev, waitFor);
    await deliver(ev, listReply(first, archiveItems(50), "finished-050"));
    let view = await shown(ev);
    assert.deepEqual([view.rows, view.more], [["finished-001", "finished-002", "finished-003"], { label: "Show more", disabled: false }]);
    let from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="more"]');
    view = await shown(ev);
    assert.equal(view.rows.length, 50, "the cached rows are revealed first");
    assert.deepEqual(await reads(ev, from), [], "revealing cached rows asks the server nothing");
    assert.deepEqual(view.more, { label: "Show more", disabled: false }, "more exists on the server");
    from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="more"]');
    const next = await read(ev, waitFor, from, "listFixedTaskArchives");
    assert.deepEqual(bare(next), { type: "listFixedTaskArchives", tabId: first.tabId, cursor: "finished-050", limit: 50 }, "the cursor is passed back unchanged");
    assert.deepEqual((await shown(ev)).more, { label: "Loading more...", disabled: true });
    const forced = await ev(`(()=>{const b=document.querySelector('#fixedView [data-fct-arch="more"]');if(!b)return false;b.disabled=false;b.click();return true})()`);
    assert.equal(forced, true, "the waiting Show more was FOUND");
    await delay(150);
    assert.equal((await reads(ev, from)).length, 1, "one read at a time, even against a forced click");
    await deliver(ev, listReply(next, archiveItems(2, 50), null));
    view = await shown(ev);
    console.log(`FCARCH paged: ${view.rows.length} rows, last ${view.rows.at(-1)}, more ${JSON.stringify(view.more)}, focus ${view.focus}`);
    assert.deepEqual([view.rows.length, view.rows.slice(-2), view.more, view.focus], [52, ["finished-051", "finished-052"], null, "arch-row-finished-051"]);
    await onlyReads(ev, start, "paging");
  }, { fixture: "fixed" });
});

test("FCARCH errors: a failed first page is never an empty success, a failed later page keeps its rows, a failed task never shows the one opened before; Try again reads again", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    await deliverState(ev, discovered);
    const start = await count(ev);
    const first = await openList(ev, waitFor);
    await deliver(ev, refusal(first, "Archive receipt mismatch."));
    let view = await shown(ev);
    assert.deepEqual(view.states, ["list-error"]);
    assert.match(view.text, /Could not load finished tasks\.[\s\S]*Archive receipt mismatch\.[\s\S]*Try again/);
    assert.doesNotMatch(view.text, /No finished tasks yet/);
    assert.equal(await ev(`document.querySelector("#toast").hidden`), true, "the refusal is shown in place, not as a stray toast");
    let from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="retry"]');
    const retried = await read(ev, waitFor, from, "listFixedTaskArchives");
    await deliver(ev, listReply(retried, archiveItems(50), "finished-050"));
    await click(ev, '#fixedView [data-fct-arch="more"]');
    from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="more"]');
    const page2 = await read(ev, waitFor, from, "listFixedTaskArchives");
    await deliver(ev, refusal(page2, "Archive page limit must be 1..50."));
    view = await shown(ev);
    assert.deepEqual([view.rows.length, view.states], [50, ["more-error"]], "earlier rows stay");
    assert.match(view.text, /More finished tasks could not be loaded\.[\s\S]*Archive page limit must be 1\.\.50\./);
    from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="retry"]');
    assert.equal((await read(ev, waitFor, from, "listFixedTaskArchives")).cursor, "finished-050", "the retry asks for the same page");
    // A task that opened, then another that fails: the failure never shows the first task as the second.
    from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="row"][data-fct-arch-id="finished-001"]');
    const open1 = await read(ev, waitFor, from, "getFixedTaskArchive");
    assert.deepEqual(bare(open1), { type: "getFixedTaskArchive", tabId: fixed.id, taskId: "finished-001" });
    assert.match((await shown(ev)).text, /Opening task\.\.\./);
    await deliver(ev, detailReply(open1, archiveFixture(work, fixed.id, "finished-001", { scope: "First finished scope" })));
    assert.match((await shown(ev)).text, /First finished scope/);
    await click(ev, '#fixedView [data-fct-arch="list"]');
    from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="row"][data-fct-arch-id="finished-002"]');
    const open2 = await read(ev, waitFor, from, "getFixedTaskArchive");
    await deliver(ev, refusal(open2, "Archive hash mismatch."));
    view = await shown(ev);
    console.log(`FCARCH failed task: ${view.text}`);
    assert.deepEqual(view.states, ["task-error"]);
    assert.match(view.text, /finished-002[\s\S]*Could not open this task\.[\s\S]*Archive hash mismatch\./);
    assert.doesNotMatch(view.text, /First finished scope|finished-001/, "nothing of the task opened before");
    await onlyReads(ev, start, "errors");
  }, { fixture: "fixed" });
});

test("FCARCH held rollover: an empty list beside a held task shows the held notice and never says there are no finished tasks", { timeout: editorTestMs(60_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed }) => {
    const notice = "Task rollover incomplete: Archive bytes conflict";
    await deliverState(ev, discovered, `state.projects[0].tabs.find((t)=>t.id===${J(fixed.id)}).fixedTask={blocked:true,notice:${J(notice)}}`);
    assert.equal((await shown(ev)).entry, true, "the entry was FOUND beside a held task");
    const first = await openList(ev, waitFor);
    await deliver(ev, listReply(first, [], null));
    const view = await shown(ev);
    console.log(`FCARCH held: ${view.text}`);
    assert.equal(await ev(`document.querySelector("#fixedView [data-fct-arch-held] p")?.textContent??null`), notice);
    assert.match(view.text, /No finished tasks are listed\. A task is held, so this list may not be complete\./);
    assert.doesNotMatch(view.text, /No finished tasks yet/);
  }, { fixture: "fixed" });
});

test("FCARCH hostile text: scope, reason, finding, evidence and the server's error are literal text on both fixed tabs, each tab showing only its own archive", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, secondFixed, work }) => {
    await deliverState(ev, discovered);
    const start = await count(ev);
    const first = await openList(ev, waitFor);
    await deliver(ev, listReply(first, archiveItems(2), null));
    let from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="row"][data-fct-arch-id="finished-001"]');
    const open1 = await read(ev, waitFor, from, "getFixedTaskArchive");
    await deliver(ev, detailReply(open1, archiveFixture(work, fixed.id, "finished-001", { scope: HOSTILE, reason: HOSTILE, finding: HOSTILE, evidence: HOSTILE })));
    await ev(`document.querySelectorAll("#fixedView details").forEach((d)=>d.open=true)`);
    const literal = await ev(`(()=>{const q=(s)=>document.querySelector(s)?.textContent??null;return {scope:q('#fixedView [data-fct-row="Scope"] dd'),reason:q('#fixedView [data-fct-row="Reason"] dd'),
      finding:q('#fixedView [data-fct-arch-finding="finding1"] .fct-ftext'),evidence:[...document.querySelectorAll('#fixedView [data-fct-arch-ship="commit"] .fct-chip')].map((c)=>c.textContent),
      images:document.querySelectorAll("#fixedView img,#fixedView script").length,pwned:window.__pwned??null}})()`);
    console.log(`FCARCH literal: ${JSON.stringify(literal)}`);
    assert.deepEqual(literal, { scope: HOSTILE, reason: HOSTILE, finding: HOSTILE, evidence: [HOSTILE], images: 0, pwned: null });
    await click(ev, '#fixedView [data-fct-arch="list"]');
    from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="row"][data-fct-arch-id="finished-002"]');
    const open2 = await read(ev, waitFor, from, "getFixedTaskArchive");
    await deliver(ev, refusal(open2, HOSTILE));
    assert.equal(await ev(`document.querySelector('#fixedView [data-fct-arch-state="task-error"] .fct-faint')?.textContent??null`), HOSTILE, "the server's reason is literal text");
    assert.deepEqual(await ev(`[document.querySelectorAll("#fixedView img").length,window.__pwned??null]`), [0, null]);
    // The second fixed tab has its own archive and never shows the first tab's.
    await click(ev, `#tabs [role=tab][data-tab-id="${secondFixed.id}"]`);
    await waitFor(`document.querySelector("#fixedView [data-fct-tab]")?.dataset.fctTab===${J(secondFixed.id)}`, "the second tab's panel");
    assert.equal((await shown(ev)).open, false, "the second tab starts on its current task");
    const second = await openList(ev, waitFor);
    assert.equal(second.tabId, secondFixed.id);
    await deliver(ev, listReply(second, [{ ...archiveItems(1)[0], id: "second-only" }], null));
    from = await count(ev);
    await click(ev, '#fixedView [data-fct-arch="row"][data-fct-arch-id="second-only"]');
    const open3 = await read(ev, waitFor, from, "getFixedTaskArchive");
    await deliver(ev, detailReply(open3, archiveFixture(work, secondFixed.id, "second-only", { scope: "Second tab's own finished scope" })));
    const view = await shown(ev);
    assert.match(view.text, /Second tab's own finished scope/);
    assert.doesNotMatch(view.text, /onerror|finished-001/, "nothing of the first tab's archive");
    await onlyReads(ev, start, "hostile text");
  }, { fixture: "fixed2" });
});

test("FCARCH keyboard: Enter opens the list and a task, the task heading takes focus, Space opens a disclosure that an unrelated broadcast keeps, Back returns focus to the row and then the entry", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, discovered, fixed, work }) => {
    await deliverState(ev, discovered);
    const start = await count(ev);
    const focusOn = (selector: string) => ev(`(()=>{const el=document.querySelector(${J(selector)});el?.focus();return Boolean(el)&&document.activeElement===el})()`);
    assert.equal(await focusOn('#fixedView [data-fct-arch="open"]'), true, "the entry was FOUND and focused");
    let from = await count(ev);
    await press(page, "Enter");
    const first = await read(ev, waitFor, from, "listFixedTaskArchives");
    await deliver(ev, listReply(first, archiveItems(3), null));
    assert.equal((await shown(ev)).focus, "arch-heading", "opening the list puts the keyboard on its heading");
    assert.equal(await focusOn('#fixedView [data-fct-arch-id="finished-002"]'), true, "the row was FOUND and focused");
    from = await count(ev);
    await press(page, "Enter");
    const open = await read(ev, waitFor, from, "getFixedTaskArchive");
    assert.equal(open.taskId, "finished-002");
    await deliver(ev, detailReply(open, archiveFixture(work, fixed.id, "finished-002")));
    const task = await ev(`(()=>{const h=document.querySelector("#fixedView .fct-ah");return {heading:h?.textContent??null,focused:document.activeElement===h,
      top:[...document.querySelectorAll('#fixedView .fct-atop [data-fct-row]')].map((r)=>r.dataset.fctRow),summaries:[...document.querySelectorAll("#fixedView details>summary")].map((s)=>s.textContent)}})()`);
    console.log(`FCARCH task: ${JSON.stringify(task)}`);
    assert.deepEqual(task, { heading: "Finished task", focused: true, top: ["Scope", "Finished", "Reason"], summaries: ["Plan", "Checks · 1", "Reviews · 3", "Findings · 2", "What shipped", "Runs · 3"] });
    assert.equal(await focusOn('#fixedView details[data-fct-disc$="|shipped"]>summary'), true, "the What shipped disclosure was FOUND");
    await press(page, " ");
    await waitFor(`document.querySelector('#fixedView details[data-fct-disc$="|shipped"]').open`, "Space opened What shipped");
    const shipped = await ev(`[...document.querySelectorAll('#fixedView [data-fct-arch-ship]')].map((s)=>[s.dataset.fctArchShip,s.querySelector(".fct-badge").textContent])`);
    assert.deepEqual(shipped, [["commit", "Recorded as done"], ["push", "Failed"]], "a local commit and a failed push, and no publish that never ran");
    // An unrelated state broadcast keeps the open disclosure and the focus.
    await deliverState(ev, discovered);
    assert.deepEqual(await ev(`[document.querySelector('#fixedView details[data-fct-disc$="|shipped"]').open,document.activeElement?.dataset?.fctKey]`), [true, `disc-finished-002|shipped`]);
    assert.equal(await focusOn('#fixedView [data-fct-arch="list"]'), true, "Back to finished tasks was FOUND");
    await press(page, "Enter");
    assert.equal((await shown(ev)).focus, "arch-row-finished-002", "Back returns to the row it came from");
    assert.equal(await focusOn('#fixedView [data-fct-arch="current"]'), true, "Back to current task was FOUND");
    await press(page, "Enter");
    assert.deepEqual([(await shown(ev)).open, (await shown(ev)).focus], [false, "arch-entry"]);
    await onlyReads(ev, start, "keyboard");
  }, { fixture: "fixed" });
});
