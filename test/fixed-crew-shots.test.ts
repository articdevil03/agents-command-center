import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editorTestMs, J, withPage, skipped, click, setValue, deliver, deliverState, type Page } from "./pack18-editor-harness.ts";
import { getCrewRolePrompt } from "../server/fixed-crew/role-prompts.ts";

// Pack 26 Block 2b rough screenshots: the real page in headless Chrome (window at x=1920, the second monitor) with the real server's
// states (harness fixture "fixed2"), written only to the folder CC_FC_SHOTS names. Every shot first asserts nothing scrolls sideways
// and no shown control is cut off at the side. Light, dark, 900 px wide and 200% zoom (720 x 450 CSS px at scale 2).

const OUT = process.env.CC_FC_SHOTS ?? "";
const SAME_MODEL = "The same model will build and review. A second AI provider can make reviews stronger.";
const ROW = (slot: string) => `#setModal [data-fc-row="${slot}"]`;
const fresh = `for(const tab of state.projects[0].tabs)if(tab.fixedCrew)for(const pref of Object.values(tab.fixedCrew.preferences)){pref.assignment=null;pref.source="auto"}`;
const crew = `state.projects[0].tabs.find((tab)=>tab.fixedCrew).fixedCrew`;

async function view(page: Page["page"], width: number, height: number, scale = 1) {
  await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
}
// No sideways scroll anywhere that is shown, and every shown button sits inside the window and inside its scrolling box.
async function layout(ev: Page["ev"]) {
  return ev(`(()=>{const w=innerWidth,boxes=[document.documentElement,...document.querySelectorAll("#setBody,.modal:not([hidden]),.pop:not([hidden]),.fc-clist,#fixedView")].filter((e)=>e.getClientRects().length);
    const wide=boxes.filter((e)=>e.scrollWidth>e.clientWidth+1).map((e)=>e.id||e.className);
    const cut=[...document.querySelectorAll("button")].filter((b)=>b.getClientRects().length&&!b.closest("[hidden],[inert]")).filter((b)=>{const r=b.getBoundingClientRect(),box=b.closest("#setBody,.modal,.pop,.fc-clist")?.getBoundingClientRect();return r.left<-1||r.right>w+1||(box&&(r.left<box.left-1||r.right>box.right+1))}).map((b)=>b.dataset.focusKey||b.id||b.textContent.trim().slice(0,30));
    return {wide,cut}})()`);
}
async function shot(ev: Page["ev"], waitFor: Page["waitFor"], page: Page["page"], name: string) {
  // A shot is taken only once every transition has finished and no toast is showing, so nothing is caught half drawn.
  await waitFor(`document.getAnimations().every((a)=>a.effect?.getComputedTiming().iterations===Infinity||a.playState!=="running")&&document.querySelector("#toast").hidden`, `${name}: transitions and toasts finished`, 8000);
  const found = await layout(ev);
  console.log(`FCUI shot ${name}: ${JSON.stringify(found)}`);
  assert.deepEqual(found, { wide: [], cut: [] }, `${name}: nothing scrolls sideways or is cut off`);
  const captured = await page("Page.captureScreenshot", { format: "png" });
  assert.ok(captured.result?.data, `${name} was captured`);
  writeFileSync(join(OUT, name), Buffer.from(captured.result.data, "base64"));
}
async function openSettings(ev: Page["ev"], waitFor: Page["waitFor"]) {
  if (await ev(`document.querySelector("#setModal").hidden`)) await click(ev, "#setBtn");
  await waitFor(`Boolean(document.querySelector("#setModal:not([hidden]) [data-fc-tab]"))`, "the fixed crew section");
}
const scrollTo = (ev: Page["ev"], selector: string) => ev(`(()=>{const b=document.querySelector("#setBody"),e=document.querySelector(${J(selector)});b.scrollTop=e?e.offsetTop-12:0;b.dispatchEvent(new Event("scroll"));return Boolean(e)})()`);

test("FCUI rough screenshots of Settings, the model menu, notices, extra instructions, creation, dark, narrow, 200% and the second fixed tab's Settings", { timeout: editorTestMs(150_000) }, async (t) => {
  if (skipped(t)) return;
  if (!OUT) { t.skip("CC_FC_SHOTS names the screenshot folder; nothing is written without it"); return; }
  mkdirSync(OUT, { recursive: true });
  await withPage(async ({ ev, waitFor, page, discovered, secondFixed, work, reload }) => {
    await ev(`window.cc.pickFolder=async()=>${J(work)}`);
    await deliverState(ev, discovered, fresh);
    await openSettings(ev, waitFor);
    await shot(ev, waitFor, page, "01-settings-unassigned-light-1440.png");
    assert.ok(await scrollTo(ev, `#setModal [data-fc-group="Making"]`), "the Making group was FOUND");
    await shot(ev, waitFor, page, "02-settings-making-checking-light-1440.png");
    await scrollTo(ev, "#s-crew");
    await click(ev, "#setModal [data-fc-bulk]");
    await shot(ev, waitFor, page, "14-one-model-picker.png");
    await click(ev, "#setModal [data-fc-bulk]");
    await deliverState(ev, discovered, `${crew}.preferences.coder={source:"user",assignment:null}`);
    await click(ev, "#setModal [data-fc-bulk]");
    await click(ev, '#pop [data-cli="codex"][data-model]');
    await shot(ev, waitFor, page, "15-one-model-confirmation.png");
    await click(ev, "#confirmOk");
    const bulk = await ev(`window.__sent.filter((m)=>m.type==="setCrewModelForAll").at(-1)`);
    assert.ok(bulk, "bulk message FOUND for screenshot reply");
    await deliver(ev, { type: "actionResult", action: "setCrewModelForAll", requestId: bulk.requestId, tabId: bulk.tabId,
      changed: [{ slot: "coder", label: "Coder" }], skipped: [{ slot: "leader", label: "Leader" }, { slot: "reviewer1", label: "Reviewer · odd rounds" }], notice: "Crew choices updated." });
    await shot(ev, waitFor, page, "16-one-model-partial-result.png");
    await click(ev, "#setModal [data-fc-bulk]");
    await click(ev, '#pop [data-cli="codex"][data-model]');
    await click(ev, "#confirmOk");
    const busyBulk = await ev(`window.__sent.filter((m)=>m.type==="setCrewModelForAll").at(-1)`);
    await deliver(ev, { type: "actionResult", action: "setCrewModelForAll", requestId: busyBulk.requestId, tabId: busyBulk.tabId,
      changed: [], skipped: discovered.fixedCrewDefinitions.map((def: any) => ({ slot: def.slot, label: def.label })), notice: "All positions are busy. No choices changed." });
    await shot(ev, waitFor, page, "17-one-model-all-busy.png");
    await reload();
    await ev(`window.cc.pickFolder=async()=>${J(work)}`);
    await deliverState(ev, discovered, fresh);
    await openSettings(ev, waitFor);
    await click(ev, `${ROW("leader")} [data-fc-model]`);
    await waitFor(`!document.querySelector("#pop").hidden`, "the model menu");
    await shot(ev, waitFor, page, "03-model-picker-unassigned-light-1440.png");
    await click(ev, `${ROW("leader")} [data-fc-model]`);
    // One AI only: Auto assign puts the same model on every position, and each reviewer says so without blocking.
    const sol = J({ cli: "codex", model: "gpt-6.1-sol", effort: "medium" });
    await deliverState(ev, discovered, `const c=${crew};for(const pref of Object.values(c.preferences)){pref.assignment=${sol};pref.source="auto"}for(const slot of Object.keys(c.notices))c.notices[slot]={status:"same-model",blocking:false,message:${J(SAME_MODEL)}}`);
    assert.ok(await scrollTo(ev, `#setModal [data-fc-group="Checking"]`), "the Checking group was FOUND");
    await shot(ev, waitFor, page, "04-auto-single-ai-notice-light-1440.png");
    await deliverState(ev, discovered, `const c=${crew};c.preferences.helper={source:"auto",assignment:{cli:"opencode",model:"deepseek/deepseek-flash",effort:"max"}};c.preferences.researcher={source:"auto",assignment:{cli:"acp:kimi",model:"default",effort:"default"}};state.clis.push({...state.clis.find((x)=>x.id==="codex"),id:"acp:kimi",label:"Kimi",installed:true,models:["default"],efforts:["default"]});state.acpClis=[{id:"kimi",name:"Kimi",program:"kimi",args:[],kind:"acp:kimi"}]`);
    await scrollTo(ev, "#s-crew");
    await shot(ev, waitFor, page, "05-auto-opencode-acp-hints-light-1440.png");
    await deliverState(ev, discovered);
    await click(ev, `${ROW("coder")} [data-fc-toggle]`);
    const asked = await ev(`window.__sent.filter((m)=>m.type==="getCrewRolePrompt").at(-1)`);
    assert.ok(asked, "the built-in instructions were asked for");
    await deliver(ev, { type: "crewRolePrompt", requestId: asked.requestId, ...getCrewRolePrompt("coder") });
    await ev(`(()=>{const a=document.querySelector(${J(`${ROW("coder")} .fc-extra`)});a.focus();return true})()`);
    await page("Input.insertText", { text: "Keep each change small and name every file you touch." });
    await scrollTo(ev, `${ROW("coder")}`);
    await shot(ev, waitFor, page, "06-extra-instructions-unsaved-light-1440.png");
    await click(ev, `${ROW("coder")} [data-fc-save]`);
    const saving = await ev(`window.__sent.filter((m)=>m.type==="setCrewRoleExtra").at(-1)`);
    await deliver(ev, { type: "error", message: "Extra instructions are too long", action: "setCrewRoleExtra", requestId: saving.requestId });
    await shot(ev, waitFor, page, "07-extra-instructions-refused-light-1440.png");
    await click(ev, "#setModal [data-close]");
    await deliverState(ev, discovered, fresh);
    await click(ev, "#addProj");
    await setValue(ev, "#pName", "Example project");
    await click(ev, "#pBrowse");
    await waitFor(`!document.querySelector("#createProj").disabled`, "Create project is enabled");
    await shot(ev, waitFor, page, "08-new-project-unassigned-light-1440.png");
    await click(ev, "#pCrew [data-fc-new-auto]");
    const preview = await ev(`window.__sent.filter((m)=>m.type==="previewCrewAssignments").at(-1)`);
    await deliver(ev, { type: "crewAssignmentsPreview", requestId: preview.requestId, draftId: preview.draftId, fixedCrew: { version: 1, roleExtras: {}, preferences: discovered.projects[0].tabs.find((tab: any) => tab.fixedCrew).fixedCrew.preferences } });
    await waitFor(`document.querySelector('#pCrew [data-fc-new-row="planner"] .fc-source').textContent.startsWith("Automatic")`, "the preview is shown");
    await shot(ev, waitFor, page, "09-new-project-auto-assigned-light-1440.png");
    await click(ev, "#projModal [data-close]");
    await deliverState(ev, discovered);
    await click(ev, `[data-theme-toggle="dark"]`);
    await openSettings(ev, waitFor);
    await scrollTo(ev, "#s-crew");
    await shot(ev, waitFor, page, "10-settings-assigned-dark-1440.png");
    await click(ev, `[data-theme-toggle="light"]`);
    await view(page, 900, 900);
    await openSettings(ev, waitFor);
    await shot(ev, waitFor, page, "11-settings-narrow-900.png");
    await view(page, 720, 450, 2);
    await openSettings(ev, waitFor);
    await shot(ev, waitFor, page, "12-settings-200pct.png");
    await view(page, 1440, 900);
    await click(ev, "#setModal [data-close]");
    await click(ev, `#tabs [role=tab][data-tab-id="${secondFixed.id}"]`);
    await click(ev, "#setBtn");
    await waitFor(`document.querySelector("#setModal:not([hidden]) [data-fc-tab]")?.dataset.fcTab===${J(secondFixed.id)}`, "the second fixed tab's own Settings");
    await shot(ev, waitFor, page, "13-second-fixed-tab-settings-light-1440.png");
    await click(ev, "#setModal [data-close]");
    await click(ev, "#addtab");
    await shot(ev, waitFor, page, "18-fresh-add-tab.png");
    await click(ev, "#modal [data-close]");
    await deliverState(ev, discovered, `state.projects[0].tabs.forEach((tab)=>{tab.fixedCrew={version:1,unavailable:true,notice:"Workspace unavailable. Your old files have been kept. Recovery could not safely finish. Check the data folder and restart Command Center."};tab.crew=[]})`);
    await click(ev, "#setBtn");
    await shot(ev, waitFor, page, "19-backup-failure-blocking-notice.png");
  }, { fixture: "fixed2", scrollbars: true });
});
