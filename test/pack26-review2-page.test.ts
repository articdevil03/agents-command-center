import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, delay, taskFixture, press } from "./pack18-editor-harness.ts";
import { historicalCss } from "./pack26-review3-css-fixtures.ts";
import { archiveFixture, archiveItems } from "./pack18-editor-task-fixture.ts";
import { count, read, shown, openList, listReply, detailReply, serveTask } from "./fixed-crew-task-archives-helpers.ts";

test("P26R6P archive accessible row name", { timeout: editorTestMs(60_000) }, async t => {
  if (skipped(t)) return;
  await withPage(async ({ ev, page, waitFor, discovered }) => {
    await deliverState(ev, discovered); const first = await openList(ev, waitFor);
    await deliver(ev, listReply(first, archiveItems(1), null));
    const values = await ev(`(()=>{const row=document.querySelector('[data-fct-arch="row"]');return [row.querySelector('.fct-ascope').textContent,row.querySelector('.fct-adate').textContent,row.dataset.fctArchId]})()`);
    const tree = await page("Accessibility.getFullAXTree");
    assert.ok(Array.isArray(tree.result?.nodes), "browser returned its accessibility tree");
    const row = tree.result.nodes.find((node: any) => node.role?.value === "button" && node.name?.value.includes(values[2]));
    assert.ok(row, "archive row FOUND in browser accessibility tree");
    for (const text of [...values, "Open"]) assert.ok(row.name.value.includes(text), `accessible name includes ${text}: ${row.name.value}`);
    console.log(`ARCHIVE ACCESSIBLE NAME ${row.name.value}`);
    const from = await count(ev); await click(ev, '[data-fct-arch="row"]');
    assert.equal((await read(ev, waitFor, from, "getFixedTaskArchive")).taskId, values[2]);
  }, { fixture: "fixed" });
});
test("P26R6P late page preserves composer focus", { timeout: editorTestMs(90_000) }, async t => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, secondFixed }) => {
    for (const focus of ["composer", "heading", "other-tab"]) {
      await deliverState(ev, discovered); const first = await openList(ev, waitFor);
      await deliver(ev, listReply(first, archiveItems(50), "finished-050"));
      await click(ev, '[data-fct-arch="more"]'); const from = await count(ev);
      await ev(`document.querySelector('[data-fct-arch="more"]').focus()`);
      await click(ev, '[data-fct-arch="more"]'); const pending = await read(ev, waitFor, from, "listFixedTaskArchives");
      assert.equal((await shown(ev)).focus, "arch-heading", "waiting interaction owns heading");
      if (focus === "other-tab") await click(ev, `#tabs [data-tab-id="${secondFixed.id}"]`);
      if (focus !== "heading") await ev(`(()=>{const c=document.querySelector('#ci');c.value='keep draft';c.focus();c.setSelectionRange(2,6);return true})()`);
      await deliver(ev, listReply(pending, archiveItems(1, 50), null));
      if (focus === "heading") assert.equal((await shown(ev)).focus, "arch-row-finished-051");
      else assert.deepEqual(await ev(`[document.activeElement.id,document.querySelector('#ci').value,document.querySelector('#ci').selectionStart,document.querySelector('#ci').selectionEnd]`), ["ci", "keep draft", 2, 6]);
      if (focus === "other-tab") { assert.equal(await ev(`document.querySelector('[data-fct-tab]').dataset.fctTab`), secondFixed.id); await click(ev, `#tabs [data-tab-id="${fixed.id}"]`); }
      await click(ev, '[data-fct-arch="current"]');
    }
  }, { fixture: "fixed2" });
});
test("P26R6P invalid detail deadline reason", { timeout: editorTestMs(90_000) }, async t => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    await deliverState(ev, discovered); const first = await openList(ev, waitFor);
    await deliver(ev, listReply(first, archiveItems(1), null));
    const open = async () => { const from = await count(ev); await click(ev, '[data-fct-arch="row"]'); return read(ev, waitFor, from, "getFixedTaskArchive"); };
    let request = await open(); const archive = archiveFixture(work, fixed.id, request.taskId);
    const invalid = detailReply(request, structuredClone(archive)); invalid.manifest.recordRevision++;
    await deliver(ev, invalid); assert.deepEqual((await shown(ev)).states, ["loading"]);
    await deliver(ev, detailReply(request, archive)); assert.match((await shown(ev)).text, /Finished task/);
    await click(ev, '[data-fct-arch="list"]'); request = await open();
    const began = Date.now(), bad = detailReply(request, structuredClone(archive)); bad.task.id = "foreign";
    await deliver(ev, bad); await delay(1000); assert.deepEqual((await shown(ev)).states, ["loading"]);
    await waitFor(`Boolean(document.querySelector('[data-fct-arch-state="task-error"]'))`, "real invalid detail deadline", editorTestMs(45_000));
    assert.ok(Date.now() - began >= 19_900);
    assert.match((await shown(ev)).text, /The reply could not be read\./);
    console.log(`INVALID DETAIL elapsed=${Date.now()-began} reason=${(await shown(ev)).text}`);
    const from = await count(ev); await click(ev, '[data-fct-arch="retry"]');
    const retry = await read(ev, waitFor, from, "getFixedTaskArchive"); assert.notEqual(retry.requestId, request.requestId);
    await deliver(ev, detailReply(retry, archive)); assert.deepEqual((await shown(ev)).states, []);
  }, { fixture: "fixed" });
});
test("P26R6P held archive detail notice", { timeout: editorTestMs(60_000) }, async t => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    const notice = "Task rollover incomplete: Archive bytes conflict";
    await deliverState(ev, discovered, `state.projects[0].tabs[0].fixedTask={blocked:true,notice:${J(notice)}}`);
    const first = await openList(ev, waitFor); await deliver(ev, listReply(first, archiveItems(1), null));
    const from = await count(ev); await click(ev, '[data-fct-arch="row"]');
    const request = await read(ev, waitFor, from, "getFixedTaskArchive");
    await deliver(ev, detailReply(request, archiveFixture(work, fixed.id, request.taskId)));
    assert.equal(await ev(`document.querySelector('[data-fct-arch-held] p')?.textContent`), notice);
    assert.match((await shown(ev)).text, /A task is held/);
  }, { fixture: "fixed" });
});

test("P26R6P rough controls reachable", { timeout: editorTestMs(90_000) }, async t => {
  if (skipped(t)) return;
  await withPage(async ({ ev, page, waitFor, discovered, fixed, work }) => {
    await serveTask(ev, waitFor, discovered, taskFixture(work, fixed.id, "inspected"));
    const originalPageState = await ev(`({links:[...document.querySelectorAll('link[rel="stylesheet"]')].map(link=>link.getAttribute('media')),hidden:document.querySelector('[data-fct-arch="open"]').hidden})`);
    console.log(`WORKING TREE STYLE INPUT ${JSON.stringify(originalPageState)}`);
    try {
      await page("Emulation.setDeviceMetricsOverride", { width: 720, height: 450, deviceScaleFactor: 2, mobile: false });
    const paths = ["styles/01-base-bar-rail.css", "styles/02-chat-panels.css", "styles/03-popovers-settings.css", "fixed-crew/crew.css"];
    for (const [name, commit] of [["current Finished tasks", null], ["Run21", "run21"], ["restored approval styling", "restored"]] as const) {
      const css = commit ? historicalCss(commit, paths) : [];
      try {
        await ev(`(()=>{document.querySelectorAll('link[rel="stylesheet"]').forEach(link=>{if(${Boolean(commit)}&&${J(paths)}.includes(new URL(link.href).pathname.slice(1)))link.media="not all"});const style=document.createElement('style');style.id='review2-history';style.textContent=${J(css.join("\n"))};document.head.append(style);document.querySelector('[data-fct-arch="open"]').hidden=${Boolean(commit)};return true})()`);
        if (!commit) await waitFor(`getComputedStyle(document.querySelector('#view')).overflowY==='auto'&&[...document.querySelectorAll('link[rel="stylesheet"]')].every(link=>link.sheet&&!link.disabled)`, "working-tree linked styles loaded");
        for (const selector of ['[data-fct-approve="rough"]', '[data-fct-ask]', '#ci']) {
          const rect = await ev(`(()=>{const el=document.querySelector(${J(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect(),v=document.querySelector('#view');el.focus({preventScroll:true});return {target:r.toJSON(),view:v.getBoundingClientRect().toJSON(),client:v.clientHeight,scroll:v.scrollHeight,top:v.scrollTop,hit:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),focus:document.activeElement===el}})()`);
          console.log(`B8 comparison ${name} ${selector}: ${JSON.stringify(rect)}`);
          assert.equal(rect.hit, true); assert.equal(rect.focus, true);
          assert.ok(rect.target.top >= -1 && rect.target.bottom <= 451);
          if (selector !== '#ci') assert.ok(rect.target.top >= rect.view.top - 1 && rect.target.bottom <= rect.view.bottom + 1);
        }
        const point = await ev(`(()=>{const b=document.querySelector('[data-fct-ask]');b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await page("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
        await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
        assert.equal(await ev("document.activeElement.id"), "ci", "actual pointer activates Ask for changes");
      } finally { await ev(`document.querySelector('#review2-history')?.remove();document.querySelectorAll('link[rel="stylesheet"]').forEach((link,index)=>{const media=${J(originalPageState.links)}[index];if(media===null)link.removeAttribute("media");else link.setAttribute("media",media)});document.querySelector('[data-fct-arch="open"]').hidden=${J(originalPageState.hidden)};true`); }
    }
    await waitFor(`getComputedStyle(document.querySelector('#view')).overflowY==='auto'`, "working-tree styles restored before mobile checks");
    await page("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    if (await ev(`document.querySelector('#railBtn').getAttribute('aria-expanded')==='true'`)) await click(ev, '#railBtn');
    for (const selector of ['[data-fct-approve="rough"]', '[data-fct-ask]', '#ci']) {
      assert.equal(await ev(`(()=>{const el=document.querySelector(${J(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return r.left>=0&&r.right<=390&&r.top>=-1&&r.bottom<=845&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`), true, `${selector} reachable at 390px`);
    }
    await ev(`document.querySelector('[data-fct-approve="rough"]').focus()`); await press(page, "Enter");
    assert.equal(await ev(`window.__sent.filter(m=>m.type==='approveFixedRough').length`), 1, "actual keyboard activation reaches approval route once");
    } finally {
      await ev(`document.querySelector('#review2-history')?.remove();document.querySelectorAll('link[rel="stylesheet"]').forEach((link,index)=>{const media=${J(originalPageState.links)}[index];if(media===null)link.removeAttribute("media");else link.setAttribute("media",media)});document.querySelector('[data-fct-arch="open"]').hidden=${J(originalPageState.hidden)};true`);
      await page("Emulation.clearDeviceMetricsOverride");
    }
  }, { fixture: "fixed" });
});
