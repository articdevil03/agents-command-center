import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, delay, taskFixture } from "./pack18-editor-harness.ts";
import { archiveFixture } from "./pack18-editor-task-fixture.ts";
import { count, read, shown, openList, listReply, detailReply, serveTask } from "./fixed-crew-task-archives-helpers.ts";
import { statusLine, watchAnnouncer, announced, rowGeometry } from "./pack26-final-page-helpers.ts";

const UNAVAILABLE = `{version:2,unavailable:true,notice:"Workspace unavailable. Your old files have been kept."}`;

test("P26F unassigned Leader is not Ready", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed, discovered }) => {
    // The server's own first state: no model anywhere, so no Leader.
    await deliverState(ev, seed);
    assert.equal(await ev(`Boolean(window.__ccSeed.projects[0].tabs.find((t)=>t.fixedCrew)?.fixedCrew.preferences.leader.assignment)`), false, "the fixture really has no Leader assignment");
    const unassigned = await statusLine(ev);
    assert.equal(unassigned.text, "Leader has no model");
    assert.match(unassigned.sub, /Settings/);
    assert.doesNotMatch(`${unassigned.text} ${unassigned.sub}`, /Ready|is ready when you are/);
    // Assigning a Leader returns the normal state.
    await deliverState(ev, discovered);
    assert.equal((await statusLine(ev)).text, "Ready");
    console.log(`PAGE status with no Leader: ${JSON.stringify(unassigned)}; with a Leader: Ready`);
  }, { fixture: "fixed" });
});

test("P26F unavailable task heading preserves the cause", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, discovered, fixed }) => {
    await deliverState(ev, discovered, `const tab=state.projects[0].tabs.find((t)=>t.id===${J(fixed.id)});tab.fixedCrew=${UNAVAILABLE};tab.crew=[]`);
    const card = await ev(`(()=>{const c=document.querySelector('#fixedView [data-fct-card="unavailable"]');return c?{heading:c.querySelector("h3")?.textContent??"",body:c.querySelector("p")?.textContent??"",text:c.textContent}:null})()`);
    assert.ok(card, "the unavailable card was FOUND");
    assert.equal(card.heading, "This crew is unavailable.");
    assert.equal(card.body, "Workspace unavailable. Your old files have been kept.", "the server's own notice, which names the cause, is shown unchanged");
    assert.doesNotMatch(card.text, /newer Command Center/, "a recovery block is never described as a version problem");
  }, { fixture: "fixed" });
});

test("P26F unavailable Settings fallback is neutral", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed }) => {
    const setUnavailable = (notice: string) => deliverState(ev, discovered, `const tab=state.projects[0].tabs.find((t)=>t.id===${J(fixed.id)});tab.fixedCrew={version:2,unavailable:true${notice}};tab.crew=[]`);
    await setUnavailable("");
    await click(ev, "#fixedView #fcWorkSettings");
    await waitFor(`Boolean(document.querySelector(".fc-recovery"))&&!document.querySelector(".fc-recovery").hidden`, "the Settings recovery line FOUND and visible");
    assert.equal(await ev(`document.querySelector(".fc-recovery").textContent`), "This crew is unavailable");
    assert.doesNotMatch(await ev(`document.querySelector(".fc-recovery").textContent`), /newer/i);
    await setUnavailable(`,notice:"Workspace unavailable. Your old files have been kept."`);
    assert.equal(await ev(`document.querySelector(".fc-recovery").textContent`), "Workspace unavailable. Your old files have been kept.", "a server notice still wins");
  }, { fixture: "fixed" });
});

test("P26F task announcements remain mounted", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, secondFixed, work }) => {
    const planned = taskFixture(work, fixed.id, "planned");
    await serveTask(ev, waitFor, discovered, planned);
    const mounted = await watchAnnouncer(ev);
    assert.deepEqual(mounted, { attached: true, text: "", role: "status", live: "polite", atomic: "true" }, "the region is attached, empty, polite and atomic before any text changes");
    // The caret in the chat box is the keyboard state this panel's redraws must never disturb.
    await ev(`(()=>{const box=document.querySelector("#ci");box.focus();box.value="hello leader";box.setSelectionRange(3,8);return true})()`);
    const caret = () => ev(`({active:document.activeElement?.id,start:document.querySelector("#ci").selectionStart,end:document.querySelector("#ci").selectionEnd})`);
    const before = await caret(); assert.deepEqual(before, { active: "ci", start: 3, end: 8 });
    const noRole = () => ev(`document.querySelectorAll('#fixedView [data-fct-status]').length>0&&[...document.querySelectorAll('#fixedView [data-fct-status]')].every((e)=>!e.hasAttribute("role"))`);
    const approve = async () => {
      const from = await count(ev);
      await click(ev, "#fixedView [data-fct-approve=plan]");
      return read(ev, waitFor, from, "approveFixedPlan");
    };
    const refuse = (request: any) => deliver(ev, { type: "error", message: "Stale task revision", action: "approveFixedPlan", tabId: fixed.id, requestId: request.requestId });
    const paragraph = () => ev(`document.querySelector("#fixedView [data-fct-status=plan]")?.textContent??null`);
    // Sending, refusal, a redraw with nothing new, then a retry that is refused the same way.
    let request = await approve();
    assert.equal((await announced(ev)).text, "Sending…");
    assert.equal(await paragraph(), "Sending…", "the visible paragraph stays readable");
    await refuse(request);
    assert.equal((await announced(ev)).text, "Not approved: Stale task revision");
    assert.equal(await paragraph(), "Not approved: Stale task revision");
    const settled = (await announced(ev)).texts.length;
    await deliverState(ev, discovered, `state.projects[0].tabs.find((t)=>t.id===${J(fixed.id)}).fixedTask=${J({ taskId: planned.id, planVersion: planned.planVersion, detailRevision: planned.recordRevision, stage: planned.stage })}`);
    await delay(100);
    assert.equal((await announced(ev)).texts.length, settled, "a redraw that shows the same outcome announces nothing");
    request = await approve();
    await refuse(request);
    assert.deepEqual((await announced(ev)).texts, ["", "Sending…", "Not approved: Stale task revision", "Sending…", "Not approved: Stale task revision"], "each distinct outcome is announced once, in order");
    assert.equal(await noRole(), true, "the rebuilt paragraphs carry no live role of their own: one announcer, no duplicates");
    assert.deepEqual(await caret(), before, "focus and caret in the chat box never moved");
    // A tab switch never replays the other tab's result, and coming back does not replay this one.
    await click(ev, `#tabs [role=tab][data-tab-id="${secondFixed.id}"]`);
    await waitFor(`document.querySelector('[data-fct-tab]')?.dataset.fctTab===${J(secondFixed.id)}`, "second panel FOUND");
    assert.equal((await announced(ev)).text, "", "nothing from the first tab is announced on the second");
    await click(ev, `#tabs [role=tab][data-tab-id="${fixed.id}"]`);
    await waitFor(`document.querySelector('[data-fct-tab]')?.dataset.fctTab===${J(fixed.id)}`, "first panel FOUND");
    assert.equal((await announced(ev)).text, "", "the earlier refusal is still readable but is not announced again");
    assert.equal(await paragraph(), "Not approved: Stale task revision");
    // Finished tasks loading uses the same region.
    const list = await openList(ev, waitFor);
    assert.equal((await announced(ev)).text, "Loading finished tasks...");
    assert.deepEqual((await shown(ev)).states, ["loading"]);
    assert.equal(await ev(`document.querySelector("#fixedView [data-fct-arch-state=loading]").hasAttribute("role")`), false, "the rebuilt loading line is not a live region itself");
    await deliver(ev, listReply(list, [], null));
    assert.equal((await announced(ev)).text, "", "the loading text goes away with the loading line");
    const end = await announced(ev);
    assert.equal(end.same && end.connected && end.detached === 0, true, "the announcer was never replaced or detached");
    console.log(`ANNOUNCER lifecycle: ${JSON.stringify(end.texts)}; detached ${end.detached}`);
  }, { fixture: "fixed2" });
});

test("P26F archive names stay within two lines", { timeout: editorTestMs(150_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, discovered, fixed, work }) => {
    await deliverState(ev, discovered);
    const longName = "x".repeat(8192);
    const item = { id: "finished-001", kind: "task", scope: longName, completedAt: "2026-11-02T10:00:00.000Z" };
    for (const [width, height] of [[390, 844], [1280, 900]] as const) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await deliverState(ev, discovered);
      const settled = `document.getAnimations().every(a=>a.effect?.getComputedTiming().iterations===Infinity||a.playState!=="running")`;
      // A narrow window starts with the rail closed, as in the existing 390 px checks.
      if (width < 800 && await ev(`document.querySelector('#stage').classList.contains('wide')`)) await click(ev, "#railBtn");
      await waitFor(width < 800 ? `!document.querySelector("#stage").classList.contains("wide")&&${settled}` : settled, "rail and transitions settled");
      const list = await openList(ev, waitFor);
      await deliver(ev, listReply(list, [item], null));
      await waitFor(`Boolean(document.querySelector("#fixedView .fct-arow"))`, "the row FOUND");
      const geometry = await rowGeometry(ev);
      console.log(`ROW GEOMETRY ${width}px: ${JSON.stringify({ lines: geometry.lines, row: geometry.row, scope: geometry.scope, open: geometry.open, panelOverflow: geometry.panelOverflow, viewOverflow: geometry.viewOverflow })}`);
      assert.equal(geometry.scopeChars, 8192, "the full text is still in the DOM, so assistive technology reads all of it");
      assert.ok(geometry.lines <= 2.05, `${width}px: the name is at most two lines (${geometry.lines})`);
      assert.ok(geometry.row.height < 220, `${width}px: the row stays bounded (${geometry.row.height}px)`);
      assert.equal(geometry.panelOverflow || geometry.viewOverflow || geometry.offenders.length > 0, false, `${width}px: no sideways overflow in the task panel ${JSON.stringify({ wide: geometry.wide, offenders: geometry.offenders })}`);
      for (const part of [geometry.date, geometry.open]) assert.ok(part.width > 0 && part.height > 0 && part.left >= geometry.row.left - 1 && part.right <= geometry.row.right + 1 && part.right <= geometry.viewport + 1, `${width}px: date and Open are visible inside the row`);
      assert.match(geometry.dateText, /2026/); assert.equal(geometry.openText, "Open");
      // Open works from the row, and the opened task shows the whole name unclamped.
      const from = await count(ev);
      await click(ev, "#fixedView .fct-arow");
      const request = await read(ev, waitFor, from, "getFixedTaskArchive");
      await deliver(ev, detailReply(request, archiveFixture(work, fixed.id, request.taskId, { scope: longName })));
      await waitFor(`document.querySelector('#fixedView [data-fct-row="Scope"] dd')?.textContent.length===8192`, "the opened task shows the full name");
      assert.equal(await ev(`(()=>{const dd=document.querySelector('#fixedView [data-fct-row="Scope"] dd');return dd.scrollHeight<=dd.clientHeight+1})()`), true, `${width}px: the detail does not clamp the name`);
      await click(ev, '#fixedView [data-fct-arch="list"]'); await click(ev, '#fixedView [data-fct-arch="current"]');
    }
  }, { fixture: "fixed" });
});
