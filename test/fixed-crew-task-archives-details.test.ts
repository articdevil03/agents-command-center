import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState } from "./pack18-editor-harness.ts";
import { archiveFixture, archiveItems } from "./pack18-editor-task-fixture.ts";
import { count, read, shown, openList, listReply, detailReply, onlyReads } from "./fixed-crew-task-archives-helpers.ts";

test("FCARCH row text", { timeout: editorTestMs(60_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered }) => {
    await deliverState(ev, discovered); const start = await count(ev);
    const scope = '</b><img src=x onerror="window.__pwned=true">scope', completedAt = '</small><img src=x onerror="window.__pwned=true">';
    const request = await openList(ev, waitFor);
    await deliver(ev, listReply(request, [{ ...archiveItems(1)[0], scope, completedAt }], null));
    assert.deepEqual(await ev(`(()=>{const row=document.querySelector('.fct-arow');return {found:!!row,scope:row?.querySelector('.fct-ascope')?.textContent,date:row?.querySelector('.fct-adate')?.textContent,id:row?.dataset.fctArchId,open:row?.querySelector('.fct-aopen')?.textContent,injected:document.querySelectorAll('#fixedView img,#fixedView script').length,pwned:window.__pwned??null}})()`),
      { found: true, scope, date: completedAt, id: "finished-001", open: "Open", injected: 0, pwned: null });
    const from = await count(ev); await click(ev, '#fixedView [data-fct-arch-id="finished-001"]');
    assert.equal((await read(ev, waitFor, from, "getFixedTaskArchive")).taskId, "finished-001");
    await onlyReads(ev, start, "literal rows");
  }, { fixture: "fixed" });
});

test("FCARCH row contract", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered }) => {
    await deliverState(ev, discovered); const start = await count(ev);
    for (const [field, value] of [["scope", undefined], ["scope", 3], ["scope", ""], ["scope", "x".repeat(8193)],
      ["completedAt", undefined], ["completedAt", 3], ["completedAt", ""], ["completedAt", "x".repeat(65)]]) {
      const request = await openList(ev, waitFor), item: any = { ...archiveItems(1)[0] };
      if (value === undefined) delete item[String(field)]; else item[String(field)] = value;
      await deliver(ev, listReply(request, [item], null));
      const view = await shown(ev); assert.deepEqual(view.states, ["list-error"], `reject ${field} ${typeof value}`);
      assert.match(view.text, /The reply could not be read\./); assert.equal(view.rows.length, 0); assert.doesNotMatch(view.text, /No finished tasks yet/);
      await click(ev, '#fixedView [data-fct-arch="current"]');
    }
    await onlyReads(ev, start, "row contract");
  }, { fixture: "fixed" });
});

test("FCARCH recorded detail", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    await deliverState(ev, discovered); const start = await count(ev), first = await openList(ev, waitFor);
    await deliver(ev, listReply(first, archiveItems(2), null));
    const from = await count(ev); await click(ev, '#fixedView [data-fct-arch-id="finished-001"]');
    const request = await read(ev, waitFor, from, "getFixedTaskArchive"), archive = archiveFixture(work, fixed.id, request.taskId);
    await deliver(ev, detailReply(request, archive));
    for (const part of ["plan", "checks", "reviews", "findings", "shipped", "runs"]) await click(ev, `#fixedView details[data-fct-disc$="|${part}"]>summary`);
    const values = await ev(`(()=>{const ds=[...document.querySelectorAll('#fixedView details')];return {open:ds.every(d=>d.open),count:ds.length,text:ds.map(d=>d.innerText).join('\\n')}})()`);
    assert.equal(values.count, 6); assert.equal(values.open, true);
    for (const value of [...archive.task.plan.criteria, ...archive.task.plan.paths, ...archive.task.plan.checks, ...archive.task.plan.risk.verification,
      archive.task.plan.risk.reason, archive.task.plan.reviewReason, ...archive.task.plan.blocks.flatMap((b: any) => [b.id, b.scope, ...b.paths]),
      ...archive.task.checks.flatMap((c: any) => [c.name, ...c.evidence]), ...archive.task.reviews.flatMap((r: any) => [...r.evidence, ...r.resolved]),
      ...archive.task.findings.map((f: any) => f.text), ...Object.values(archive.task.triage).flatMap((d: any) => [d.outcome, d.reason]),
      "Final review", "Marked resolved by review review2", "Local commit", "Recorded as done", "Push", "Failed", "Publish (planned, not a result)",
      ...archive.executions.flatMap((r: any) => [r.assignment.model, r.assignment.effort, r.selectionReason, r.logPath]), "Planning", "Build", "Done"])
      assert.ok(values.text.includes(value), `recorded value FOUND: ${value}`);
    assert.equal(await ev(`document.querySelectorAll('[data-fct-arch-ship="publish"]').length`), 0, "planned publish is never a result");
    await deliverState(ev, discovered, `state.projects[0].tabs.find(t=>t.id===${J(fixed.id)}).fixedCrew.preferences.coder.assignment.model="today-model"`);
    assert.doesNotMatch((await shown(ev)).text, /today-model/);
    assert.match((await shown(ev)).text, /gpt-6.1-sol/);
    await click(ev, '#fixedView [data-fct-arch="list"]');
    const next = await count(ev); await click(ev, '#fixedView [data-fct-arch-id="finished-002"]');
    const second = await read(ev, waitFor, next, "getFixedTaskArchive"), published = archiveFixture(work, fixed.id, second.taskId);
    published.task.executions.push({ ...published.task.executions.find((r: any) => r.kind === "commit"), id: "publish1", kind: "publish", evidence: ["release/published.txt"] });
    await deliver(ev, detailReply(second, published)); await click(ev, '#fixedView details[data-fct-disc$="|shipped"]>summary');
    assert.match(await ev(`document.querySelector('[data-fct-arch-ship="publish"]')?.innerText??''`), /Publish[\s\S]*Recorded as done[\s\S]*release\/published.txt/);
    await onlyReads(ev, start, "recorded detail");
  }, { fixture: "fixed" });
});

test("FCARCH broadcast preservation", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    await deliverState(ev, discovered); const first = await openList(ev, waitFor); await deliver(ev, listReply(first, archiveItems(50), "finished-050"));
    await click(ev, '#fixedView [data-fct-arch="more"]');
    const saved = await ev(`(()=>{const v=document.querySelector('#view');v.scrollTop=240;return v.scrollTop})()`); assert.ok(saved > 0);
    const from = await count(ev); await click(ev, '#fixedView [data-fct-arch-id="finished-020"]');
    const request = await read(ev, waitFor, from, "getFixedTaskArchive"), archive = archiveFixture(work, fixed.id, request.taskId);
    archive.task.plan.criteria = Array.from({ length: 40 }, (_, n) => `Criterion ${n}: ${"readable history ".repeat(6)}`);
    await deliver(ev, detailReply(request, archive));
    await click(ev, '#fixedView details[data-fct-disc$="|plan"]>summary');
    const before = await ev(`(()=>{const s=document.querySelector('details[data-fct-disc$="|plan"]>summary');if(!s)return null;s.focus({preventScroll:true});window.__archiveNode=document.querySelector('.fct-arch');const v=document.querySelector('#view');v.scrollTop=300;return {top:v.scrollTop,key:document.activeElement.dataset.fctKey}})()`);
    assert.ok(before && before.top > 0, "summary and nonzero shared scroll FOUND"); const countBefore = await count(ev);
    await deliverState(ev, discovered);
    assert.deepEqual(await ev(`({same:window.__archiveNode===document.querySelector('.fct-arch'),open:document.querySelector('details[data-fct-disc$="|plan"]').open,top:document.querySelector('#view').scrollTop,key:document.activeElement.dataset.fctKey})`), { same: true, open: true, ...before });
    assert.equal(await count(ev), countBefore, "broadcast never refetches");
    await click(ev, '#fixedView [data-fct-arch="list"]');
    assert.equal((await shown(ev)).focus, "arch-row-finished-020"); assert.equal(await ev(`document.querySelector('#view').scrollTop`), saved);
  }, { fixture: "fixed" });
});

test("FCARCH text enlargement", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, discovered }) => {
    await page("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await deliverState(ev, discovered); if (await ev(`document.querySelector('#stage').classList.contains('wide')`)) await click(ev, "#railBtn");
    await waitFor(`!document.querySelector("#stage").classList.contains("wide")&&document.getAnimations().every(a=>a.effect?.getComputedTiming().iterations===Infinity||a.playState!=="running")`, "rail closed and transitions settled");
    const first = await openList(ev, waitFor); await deliver(ev, listReply(first, archiveItems(50), "finished-050"));
    const sizes = () => ev(`['.fct-ascope','.fct-adate','.fct-aid','.fct-aopen'].map(s=>{const e=document.querySelector('.fct-arow '+s);return e?parseFloat(getComputedStyle(e).fontSize):null})`);
    await page("Page.setFontSizes", { fontSizes: { standard: 16, fixed: 13 } }); const normal = await sizes(); assert.ok(normal.every((v: any) => v > 0));
    try {
      await page("Page.setFontSizes", { fontSizes: { standard: 32, fixed: 26 } });
      const large = await sizes(); console.log(`FCARCH text enlargement ${JSON.stringify({ normal, large })}`); assert.deepEqual(large, normal.map((n: number) => n * 2));
      const layout = await ev(`(()=>{const a=document.querySelector('.fct-arch'),v=document.querySelector('#view'),more=a.querySelector('[data-fct-arch="more"]');more.scrollIntoView({block:'nearest'});const r=more.getBoundingClientRect(),p=v.getBoundingClientRect();return {open:[...a.querySelectorAll('.fct-aopen')].map(e=>e.textContent),wide:a.scrollWidth>a.clientWidth+1,nested:[...a.querySelectorAll('*')].filter(e=>/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+1).length,reachable:r.top>=p.top-1&&r.bottom<=p.bottom+1,wrapped:a.querySelector(".fct-ascope").getBoundingClientRect().height>parseFloat(getComputedStyle(a.querySelector(".fct-ascope")).fontSize)*1.5,wrap:getComputedStyle(a.querySelector('.fct-ascope')).whiteSpace}})()`);
      console.log("FCARCH enlarged layout " + JSON.stringify(await ev(`(()=>{const a=document.querySelector(".fct-arch"),r=a.getBoundingClientRect();return {width:a.clientWidth,scroll:a.scrollWidth,overflow:[...a.querySelectorAll("*")].filter(e=>e.getBoundingClientRect().right>r.right+1).map(e=>[e.tagName,e.className,e.clientWidth,e.scrollWidth])}})()`)));
      assert.deepEqual(layout, { open: ["Open", "Open", "Open"], wide: false, nested: 0, reachable: true, wrapped: true, wrap: "normal" });
    } finally { await page("Page.setFontSizes", { fontSizes: { standard: 16, fixed: 13 } }); }
  }, { fixture: "fixed", scrollbars: true });
});
