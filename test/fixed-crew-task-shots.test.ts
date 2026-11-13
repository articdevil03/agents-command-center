import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, taskFixture, type Page } from "./pack18-editor-harness.ts";

// Pack 26 Block 3c rough screenshots: the real page in headless Chrome (window at x=1920, the second monitor) with the real server's
// states (harness fixture "fixed2") and task records built by the server's createTask, written only to the folder CC_FCT_SHOTS names.
// Every shot first asserts nothing scrolls sideways, no shown control is cut off at the side, and the shot's required control (when it
// has one) is FOUND inside the visible part of the task panel. Light, dark, 900 px wide and 200% zoom (720 x 450 CSS px at scale 2).

const OUT = process.env.CC_FCT_SHOTS ?? "";
const SAME_MODEL = "The same model will build and review. A second AI provider can make reviews stronger.";
const FIXED = `state.projects[0].tabs.find((t)=>t.fixedCrew)`;
const summary = (task: any) => ({ taskId: task.id, planVersion: task.planVersion, detailRevision: task.recordRevision, stage: task.stage });

async function view(page: Page["page"], width: number, height: number, scale = 1) {
  await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
}
async function layout(ev: Page["ev"], required: string | null) {
  return ev(`(()=>{const w=innerWidth,boxes=[document.documentElement,...document.querySelectorAll("#fixedView,#view,#setBody,.modal:not([hidden]),.pop:not([hidden])")].filter((e)=>e.getClientRects().length);
    const wide=boxes.filter((e)=>e.scrollWidth>e.clientWidth+1).map((e)=>e.id||e.className);
    const cut=[...document.querySelectorAll("button")].filter((b)=>b.getClientRects().length&&!b.closest("[hidden],[inert]")).filter((b)=>{const r=b.getBoundingClientRect();return r.left<-1||r.right>w+1}).map((b)=>b.dataset.fctKey||b.id||b.textContent.trim().slice(0,30));
    const need=${J(required)};let control=null;
    if(need){const b=document.querySelector(need),v=document.querySelector("#view");if(b){b.scrollIntoView({block:"nearest"});const r=b.getBoundingClientRect(),p=v.getBoundingClientRect();control=r.top>=p.top-1&&r.bottom<=p.bottom+1&&r.left>=p.left-1&&r.right<=p.right+1?"visible":"clipped"}else control="missing"}
    return {wide,cut,control}})()`);
}
async function shot(ev: Page["ev"], waitFor: Page["waitFor"], page: Page["page"], name: string, required: string | null = null) {
  await waitFor(`document.getAnimations().every((a)=>a.effect?.getComputedTiming().iterations===Infinity||a.playState!=="running")&&document.querySelector("#toast").hidden`, `${name}: transitions and toasts finished`, 8000);
  const found = await layout(ev, required);
  console.log(`FCTUI shot ${name}: ${JSON.stringify(found)}`);
  assert.deepEqual(found, { wide: [], cut: [], control: required ? "visible" : null }, `${name}: nothing scrolls sideways or is cut off`);
  const captured = await page("Page.captureScreenshot", { format: "png" });
  assert.ok(captured.result?.data, `${name} was captured`);
  writeFileSync(join(OUT, name), Buffer.from(captured.result.data, "base64"));
}
// A state naming the task, then the server's detail reply to the page's own request for it.
async function serve(ev: Page["ev"], waitFor: Page["waitFor"], state: any, task: any, extra = "") {
  const from = await ev("window.__sent.length");
  await deliverState(ev, state, `const tab=${FIXED};tab.fixedTask=${J(summary(task))};${extra}`);
  await waitFor(`window.__sent.slice(${from}).some((m)=>m.type==="getFixedTask")`, "the page asked for the task");
  const request = await ev(`window.__sent.slice(${from}).filter((m)=>m.type==="getFixedTask").at(-1)`);
  await deliver(ev, { type: "fixedTask", requestId: request.requestId, tabId: request.tabId, task });
  await waitFor(`!document.querySelector("#fixedView").hidden&&Boolean(document.querySelector("#fixedView [data-fct-decision]"))`, "the task panel is drawn");
}
async function expand(ev: Page["ev"]) {
  if (await ev(`document.querySelector("#fixedView [data-fct-toggle]").getAttribute("aria-expanded")`) !== "true") await click(ev, "#fixedView [data-fct-toggle]");
  await ev(`(()=>{document.querySelector("#view").scrollTop=0;return true})()`);
}

test("FCTUI rough screenshots of the task panel: decision, plan and rough approval, approved, stale, open fixes, needed seat, interrupted, dark, narrow, 200% and the second fixed tab's panel", { timeout: editorTestMs(150_000) }, async (t) => {
  if (skipped(t)) return;
  if (!OUT) { t.skip("CC_FCT_SHOTS names the screenshot folder; nothing is written without it"); return; }
  mkdirSync(OUT, { recursive: true });
  await withPage(async ({ ev, waitFor, page, discovered, fixed, secondFixed, work }) => {
    let revision = 10;
    const next = (stage: Parameters<typeof taskFixture>[2], text = {}) => Object.assign(taskFixture(work, fixed.id, stage, text), { recordRevision: ++revision });
    await serve(ev, waitFor, discovered, next("approved"), `tab.fixedCrew.notices.reviewer1={status:"same-model",blocking:false,message:${J(SAME_MODEL)}}`);
    await shot(ev, waitFor, page, "01-decision-collapsed-light-1440.png", "#fixedView [data-fct-toggle]");
    await expand(ev);
    await shot(ev, waitFor, page, "02-decision-expanded-light-1440.png", "#fixedView [data-fct-toggle]");
    await ev(`document.querySelector('#view .empty-chat').scrollIntoView({block:'end'})`);
    const visible = await ev(`['#view .empty-chat h2','#ci'].map((s)=>{const r=document.querySelector(s).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})`);
    assert.deepEqual(visible, [true, true], "expanded decision's greeting and composer visible together after scrolling");
    await shot(ev, waitFor, page, "14-expanded-greeting-composer.png");
    await ev(`document.querySelector('#view').scrollTop=0`);
    await click(ev, "#fixedView [data-fct-toggle]");
    await serve(ev, waitFor, discovered, next("planned"));
    await shot(ev, waitFor, page, "03-plan-awaiting-approval-light-1440.png", "#fixedView [data-fct-approve=plan]");
    const rough = next("inspected");
    await serve(ev, waitFor, discovered, rough);
    await shot(ev, waitFor, page, "04-rough-awaiting-approval-light-1440.png", "#fixedView [data-fct-approve=rough]");
    assert.match(await ev(`document.querySelector('#statusBtn').textContent`), /Waiting on you: look at the rough/);
    const finalShot = await page("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(process.cwd(), "docs/screenshot.png"), Buffer.from(finalShot.result.data, "base64"));
    await serve(ev, waitFor, discovered, next("roughApproved"));
    await shot(ev, waitFor, page, "05-rough-approved-light-1440.png");
    await serve(ev, waitFor, discovered, next("staleReview"));
    await shot(ev, waitFor, page, "06-review-stale-light-1440.png");
    await serve(ev, waitFor, discovered, next("fixOpen"));
    await click(ev, "#fixedView [data-fct-open]");
    await ev(`(()=>{document.querySelector("#fixedView").scrollTop=0;return true})()`);
    await shot(ev, waitFor, page, "07-unresolved-fix-blocked-light-1440.png", "#fixedView [data-fct-open]");
    await click(ev, "#fixedView [data-fct-toggle]");
    await serve(ev, waitFor, discovered, next("approved"), `tab.fixedCrew.preferences.reviewer1={source:"user",assignment:null}`);
    await shot(ev, waitFor, page, "08-needed-seat-unassigned-light-1440.png", `#fixedView [data-fct-position="reviewer1"]`);
    await click(ev, `[data-theme-toggle="dark"]`);
    await serve(ev, waitFor, discovered, next("interrupted"));
    await shot(ev, waitFor, page, "09-interrupted-dark-1440.png");
    await serve(ev, waitFor, discovered, next("approved"), `tab.fixedCrew.notices.reviewer1={status:"same-model",blocking:false,message:${J(SAME_MODEL)}}`);
    await expand(ev);
    await shot(ev, waitFor, page, "10-decision-expanded-dark-1440.png", "#fixedView [data-fct-toggle]");
    await click(ev, `[data-theme-toggle="light"]`);
    await view(page, 900, 900);
    await shot(ev, waitFor, page, "11-decision-narrow-900.png", "#fixedView [data-fct-toggle]");
    await click(ev, "#fixedView [data-fct-toggle]");
    await view(page, 720, 450, 2);
    await serve(ev, waitFor, discovered, Object.assign(structuredClone(rough), { recordRevision: ++revision }));
    await shot(ev, waitFor, page, "12-rough-approval-200pct.png", "#fixedView [data-fct-approve=rough]");
    await shot(ev, waitFor, page, "15-rough-ask-changes-200pct.png", "#fixedView [data-fct-ask]");
    await view(page, 1440, 900);
    await click(ev, `#tabs [role=tab][data-tab-id="${secondFixed.id}"]`);
    await waitFor(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId===${J(secondFixed.id)}&&!document.querySelector("#fixedView").hidden`, "the second fixed tab and its own panel");
    await shot(ev, waitFor, page, "13-second-fixed-tab-panel-light-1440.png");
  }, { fixture: "fixed2", scrollbars: true });
});
