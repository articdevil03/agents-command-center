import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, taskFixture, type Page } from "./pack18-editor-harness.ts";
import { archiveFixture, archiveItems } from "./pack18-editor-task-fixture.ts";
import { serveTask } from "./fixed-crew-task-archives-helpers.ts";

// S-F3 Finished tasks rough screenshots: the real page in headless Chrome (window at x=1920, the second monitor) with the real server's
// states (harness fixture "fixed2") and archive replies delivered over the fake socket, written only to the folder CC_FCT_SHOTS names.
// Phone 390 x 844 (the rail closed with its own control) and desktop 1440 x 900, light and dark; then phone at 200% browser text size.
// The large-text shots are BROWSER TEXT-SIZE EMULATION (Page.setFontSizes doubles the default font size the page's rem units follow),
// not a physical phone check. Before every shot: the expected state and controls are FOUND, nothing in the archive scrolls sideways or
// is cut off at the side, and the shot's required control is brought into the visible part of the shared scroll area.

const POLISH = process.env.CC_FCT_SHOTS_ONLY === "list-polish";
const REVIEW2 = process.env.CC_FCT_SHOTS_ONLY === "review2";
const OUT = process.env.CC_FCT_SHOTS ?? "";
const read = async (ev: Page["ev"], waitFor: Page["waitFor"], from: number, type: string): Promise<any> => {
  await waitFor(`window.__sent.slice(${from}).some((m)=>m.type===${J(type)})`, `the page sent ${type}`);
  return ev(`window.__sent.slice(${from}).filter((m)=>m.type===${J(type)}).at(-1)`);
};
async function layout(ev: Page["ev"], required: string | null) {
  return ev(`(()=>{const view=document.querySelector("#view"),p=view.getBoundingClientRect();
    const wide=[...document.querySelectorAll("#fixedView,#fixedView section[data-fct-arch],#fixedView details,#fixedView .fct-alist")].filter((e)=>e.getClientRects().length&&e.scrollWidth>e.clientWidth+1).map((e)=>e.className||e.id);
    const cut=[...document.querySelectorAll("#fixedView button,#fixedView summary")].filter((b)=>b.getClientRects().length).filter((b)=>{const r=b.getBoundingClientRect();return r.left<p.left-1||r.right>p.right+1}).map((b)=>b.dataset.fctKey||b.textContent.trim().slice(0,30));
    const need=${J(required)};let control=null;
    if(need){const b=document.querySelector(need);if(b){b.scrollIntoView({block:"nearest"});const r=b.getBoundingClientRect();control=r.top>=p.top-1&&r.bottom<=p.bottom+1&&r.left>=p.left-1&&r.right<=p.right+1?"visible":"clipped"}else control="missing"}
    const shell=[document.documentElement,view,...document.querySelectorAll("#top,.shead,.sline")].filter((e)=>e.scrollWidth>e.clientWidth+1).map((e)=>e.id||e.className||e.tagName);
    return {wide,cut,control,shell}})()`);
}
async function shot(ev: Page["ev"], waitFor: Page["waitFor"], page: Page["page"], name: string, required: string | null = null) {
  await waitFor(`document.fonts.status==="loaded"&&document.getAnimations().every((a)=>a.effect?.getComputedTiming().iterations===Infinity||a.playState!=="running")&&document.querySelector("#toast").hidden`, `${name}: fonts, transitions and toasts settled`, 8000);
  const { shell, ...found } = await layout(ev, required);
  console.log(`FCARCH shot ${name}: ${JSON.stringify(found)} shell-overflow ${JSON.stringify(shell)}`);
  assert.deepEqual(found, { wide: [], cut: [], control: required ? "visible" : null }, `${name}: nothing in the archive scrolls sideways or is cut off`);
  const captured = await page("Page.captureScreenshot", { format: "png" });
  assert.ok(captured.result?.data, `${name} was captured`);
  writeFileSync(join(OUT, name), Buffer.from(captured.result.data, "base64"));
}
const state = (ev: Page["ev"]): Promise<any> => ev(`(()=>{const v=document.querySelector("#fixedView");return {entry:Boolean(v.querySelector('[data-fct-arch="open"]')),open:Boolean(v.querySelector("section[data-fct-arch]")),
  rows:v.querySelectorAll('[data-fct-arch="row"]').length,more:v.querySelector('[data-fct-arch="more"]')?.textContent??null,states:[...v.querySelectorAll("[data-fct-arch-state]")].map((e)=>e.dataset.fctArchState),
  heading:v.querySelector(".fct-ah")?.textContent??null,top:[...v.querySelectorAll(".fct-atop [data-fct-row]")].map((r)=>r.dataset.fctRow),text:v.innerText}})()`);
const top = (ev: Page["ev"]) => ev(`(()=>{document.querySelector("#view").scrollTop=0;return true})()`);

async function openList(ev: Page["ev"], waitFor: Page["waitFor"], items: any[], nextCursor: string | null) {
  const from = await ev("window.__sent.length");
  await click(ev, '#fixedView [data-fct-arch="open"]');
  const request = await read(ev, waitFor, from, "listFixedTaskArchives");
  await deliver(ev, { type: "fixedTaskArchives", requestId: request.requestId, tabId: request.tabId, items, nextCursor });
}
async function openTask(ev: Page["ev"], waitFor: Page["waitFor"], archive: any, id: string) {
  const from = await ev("window.__sent.length");
  await click(ev, `#fixedView [data-fct-arch="row"][data-fct-arch-id="${id}"]`);
  const request = await read(ev, waitFor, from, "getFixedTaskArchive");
  await deliver(ev, { type: "fixedTaskArchive", requestId: request.requestId, tabId: request.tabId, taskId: request.taskId, ...archive });
}

test("FCARCH rough screenshots of Finished tasks: empty, entry, list with Show more, an opened task and an honest read error, phone and desktop, light and dark, and phone at 200% text", { timeout: editorTestMs(240_000) }, async (t) => {
  if (skipped(t)) return;
  if (!OUT) { t.skip("CC_FCT_SHOTS names the screenshot folder; nothing is written without it"); return; }
  mkdirSync(OUT, { recursive: true });
  await withPage(async ({ ev, waitFor, page, discovered, fixed, work }) => {
    const archive = archiveFixture(work, fixed.id, "finished-001");
    const viewport = async (width: number, height: number) => {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      // The phone uses the rail's own control to close the crew rail; the desktop keeps it open.
      if ((await ev(`document.querySelector("#stage").classList.contains("wide")`)) !== (width > 600)) await click(ev, "#railBtn");
    };
    await deliverState(ev, discovered);
    if (REVIEW2) {
      await viewport(720, 450);
      await serveTask(ev, waitFor, discovered, taskFixture(work, fixed.id, "inspected"));
      await shot(ev, waitFor, page, "review2-rough-composer-720.png", '[data-fct-approve="rough"]');
      await viewport(390, 844);
      await shot(ev, waitFor, page, "review2-rough-composer-390.png", '[data-fct-approve="rough"]');
      await openList(ev, waitFor, archiveItems(3), null);
      await shot(ev, waitFor, page, "review2-archive-row-390.png", '[data-fct-arch="row"]');
      try {
        await page("Page.setFontSizes", { fontSizes: { standard: 32, fixed: 26 } });
        await shot(ev, waitFor, page, "review2-archive-row-large-390.png", '[data-fct-arch="row"]');
      } finally { await page("Page.setFontSizes", { fontSizes: { standard: 16, fixed: 13 } }); }
      const notice = "Task rollover incomplete: Archive bytes conflict";
      await deliverState(ev, discovered, `state.projects[0].tabs[0].fixedTask={blocked:true,notice:${J(notice)}}`);
      await openTask(ev, waitFor, archive, "finished-001");
      assert.equal(await ev(`document.querySelector('[data-fct-arch-held] p')?.textContent`), notice);
      await shot(ev, waitFor, page, "review2-held-detail-390.png", '[data-fct-arch="list"]');
      try {
        await page("Page.setFontSizes", { fontSizes: { standard: 32, fixed: 26 } });
        await shot(ev, waitFor, page, "review2-held-detail-large-390.png", '[data-fct-arch="list"]');
      } finally { await page("Page.setFontSizes", { fontSizes: { standard: 16, fixed: 13 } }); }
      return;
    }
    if (POLISH) {
      const textSizes = () => ev(`['.fct-ascope','.fct-adate','.fct-aid','.fct-aopen'].map(s=>{const e=document.querySelector('.fct-arow '+s);return e?parseFloat(getComputedStyle(e).fontSize):null})`);
      const captureList = async (theme: string, width: number, large = false) => {
        await viewport(width, width === 390 ? 844 : 900);
        await click(ev, `[data-theme-toggle="${theme}"]`);
        await openList(ev, waitFor, archiveItems(50), "finished-050");
        const listed = await state(ev);
        assert.deepEqual([listed.rows, listed.more], [3, "Show more"]);
        assert.deepEqual(await ev(`[...document.querySelectorAll('.fct-ascope')].map(e=>e.textContent)`), archiveItems(3).map(i=>i.scope));
        assert.deepEqual(await ev(`[...document.querySelectorAll('.fct-adate')].map(e=>e.textContent)`), archiveItems(3).map(i=>new Date(i.completedAt).toLocaleString([], {dateStyle:"medium",timeStyle:"short"})));
        assert.deepEqual(await ev(`[...document.querySelectorAll('.fct-aopen')].map(e=>e.textContent)`), ["Open", "Open", "Open"]);
        const normal = await textSizes(); assert.ok(normal.every((n: number) => n > 0));
        try {
          if (large) {
            await page("Page.setFontSizes", { fontSizes: { standard: 32, fixed: 26 } });
            const enlarged = await textSizes(); console.log(`FCARCH polish text sizes ${JSON.stringify({normal,enlarged})}`);
            assert.deepEqual(enlarged, normal.map((n: number) => n * 2));
          }
          await top(ev);
          await shot(ev, waitFor, page, large ? "06-list-large-light-390.png" : `03-list-${theme}-${width}.png`, '#fixedView [data-fct-arch="more"]');
        } finally { await page("Page.setFontSizes", { fontSizes: { standard: 16, fixed: 13 } }); }
        await click(ev, '#fixedView [data-fct-arch="current"]');
      };
      await captureList("light", 390); await captureList("dark", 390); await captureList("light", 1440); await captureList("light", 390, true);
      return;
    }
    for (const theme of ["light", "dark"]) {
      await click(ev, `[data-theme-toggle="${theme}"]`);
      for (const [width, height] of [[390, 844], [1440, 900]]) {
        await viewport(width, height);
        await openList(ev, waitFor, [], null);
        assert.deepEqual((await state(ev)).states, ["empty"]);
        await top(ev);
        await shot(ev, waitFor, page, `01-empty-none-${theme}-${width}.png`, '#fixedView [data-fct-arch="current"]');
        await click(ev, '#fixedView [data-fct-arch="current"]');
        const current = await state(ev);
        assert.deepEqual([current.entry, current.open], [true, false]);
        assert.match(current.text, /Finished tasks[\s\S]*No plan yet/);
        await top(ev);
        await shot(ev, waitFor, page, `02-empty-finished-${theme}-${width}.png`, '#fixedView [data-fct-arch="open"]');
        await openList(ev, waitFor, archiveItems(50), "finished-050");
        const listed = await state(ev);
        assert.deepEqual([listed.rows, listed.more], [3, "Show more"], "a full first page shows three rows and Show more");
        await top(ev);
        await shot(ev, waitFor, page, `03-list-${theme}-${width}.png`, '#fixedView [data-fct-arch="more"]');
        await openTask(ev, waitFor, archive, "finished-001");
        await ev(`(()=>{const d=document.querySelector('#fixedView details[data-fct-disc$="|shipped"]');if(d)d.open=true;return Boolean(d)})()`);
        const opened = await state(ev);
        assert.deepEqual([opened.heading, opened.top], ["Finished task", ["Scope", "Finished", "Reason"]]);
        await top(ev);
        await shot(ev, waitFor, page, `04-task-${theme}-${width}.png`, '#fixedView [data-fct-arch="list"]');
        await click(ev, '#fixedView [data-fct-arch="list"]');
        await click(ev, '#fixedView [data-fct-arch="current"]');
        const from = await ev("window.__sent.length");
        await click(ev, '#fixedView [data-fct-arch="open"]');
        const failed = await read(ev, waitFor, from, "listFixedTaskArchives");
        await deliver(ev, { type: "error", message: "Archive receipt mismatch.", action: "listFixedTaskArchives", requestId: failed.requestId, tabId: failed.tabId });
        const error = await state(ev);
        assert.deepEqual(error.states, ["list-error"]);
        assert.doesNotMatch(error.text, /No finished tasks yet/, "an error is never an empty success");
        await top(ev);
        await shot(ev, waitFor, page, `05-error-${theme}-${width}.png`, '#fixedView [data-fct-arch="retry"]');
        await click(ev, '#fixedView [data-fct-arch="current"]');
      }
    }
    // Browser text-size emulation at 200%: the default font size doubles, and the archive's rem text must follow it.
    await viewport(390, 844);
    for (const theme of ["light", "dark"]) {
      await click(ev, `[data-theme-toggle="${theme}"]`);
      await openList(ev, waitFor, archiveItems(50), "finished-050");
      const normal = await ev(`parseFloat(getComputedStyle(document.querySelector("#fixedView .fct-aid")).fontSize)`);
      try {
      await page("Page.setFontSizes", { fontSizes: { standard: 32, fixed: 26 } });
      await waitFor(`parseFloat(getComputedStyle(document.querySelector("#fixedView .fct-aid")).fontSize)>=${normal * 2 - 0.1}`, "the archive text grew");
      const large = await ev(`parseFloat(getComputedStyle(document.querySelector("#fixedView .fct-aid")).fontSize)`);
      console.log(`FCARCH text size (${theme}): ${normal}px -> ${large}px`);
      assert.equal(large / normal, 2, "the archive's task ID text is at 200%");
      await top(ev);
      await shot(ev, waitFor, page, `06-list-large-${theme}-390.png`, '#fixedView [data-fct-arch="more"]');
      await openTask(ev, waitFor, archive, "finished-001");
      assert.equal((await state(ev)).heading, "Finished task");
      await top(ev);
      await shot(ev, waitFor, page, `07-task-large-${theme}-390.png`, '#fixedView [data-fct-arch="list"]');
      } finally { await page("Page.setFontSizes", { fontSizes: { standard: 16, fixed: 13 } }); }
      await click(ev, '#fixedView [data-fct-arch="list"]');
      await click(ev, '#fixedView [data-fct-arch="current"]');
    }
    await click(ev, `[data-theme-toggle="light"]`);
  }, { fixture: "fixed2", scrollbars: true });
});
