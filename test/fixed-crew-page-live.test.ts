import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { editorTestMs, J, withPage, skipped, click, setValue, type Page } from "./pack18-editor-harness.ts";

// Pack 26 Block 2b, over the REAL WebSocket: the page is loaded from a real server on a temp data root (fresh install, fake CLIs that
// answer a version check for Claude and Codex, CC_SKIP_DISCOVERY=1, CC_SKIP_LEADER_CHECK=1), nothing is delivered by hand, and every
// claim of saving is checked in the server's own workspaces.json and again after a page reload.

const SAME_MODEL = "The same model will build and review. A second AI provider can make reviews stronger.";
const EXTRA = "Live extra </textarea> &amp; keep it literal";
const ROW = (slot: string) => `#setModal [data-fc-row="${slot}"]`;
const text = (ev: Page["ev"], selector: string): Promise<string> => ev(`document.querySelector(${J(selector)})?.textContent??null`);
async function openSettings(ev: Page["ev"], waitFor: Page["waitFor"]): Promise<void> {
  await click(ev, "#setBtn");
  await waitFor(`Boolean(document.querySelector("#setModal:not([hidden]) [data-fc-tab]"))`, "the fixed crew section in Settings");
}
async function pickModel(ev: Page["ev"], waitFor: Page["waitFor"], chip: string, cli: string): Promise<string> {
  await click(ev, chip);
  await waitFor(`Boolean(document.querySelector('#pop:not([hidden]) [data-cli="${cli}"][data-model]'))`, `${cli} models in the menu`);
  const model = await ev(`document.querySelector('#pop [data-cli="${cli}"][data-model]').dataset.model`);
  await click(ev, `#pop [data-cli="${cli}"][data-model="${model}"]`);
  await ev(`(()=>{if(!document.querySelector("#pop").hidden)document.querySelector("#pop").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));return true})()`);
  return model;
}
async function typeExtra(ev: Page["ev"], page: Page["page"], slot: string, value: string): Promise<void> {
  if (await ev(`document.querySelector(${J(`${ROW(slot)} .fc-panel`)}).hidden`)) await click(ev, `${ROW(slot)} [data-fc-toggle]`);
  assert.equal(await ev(`(()=>{const a=document.querySelector(${J(`${ROW(slot)} .fc-extra`)});a.focus();a.select();return document.activeElement===a})()`), true, `the ${slot} field was FOUND and focused`);
  await page("Input.insertText", { text: value });
}

test("FCUI live: a fresh install over the real socket starts unassigned, Check again fills it, picks, notices and extras persist on disk and after a reload, a refusal keeps the text, and New project creates a fixed crew", { timeout: editorTestMs(150_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, dataDir, reload, fixed }) => {
    const disk = () => JSON.parse(readFileSync(join(dataDir, "config", "workspaces.json"), "utf8"));
    const diskTab = (id: string) => disk().projects.flatMap((project: any) => project.tabs).find((tab: any) => tab.id === id);
    const source = (slot: string) => text(ev, `${ROW(slot)} .fc-source`);
    await openSettings(ev, waitFor);
    const fresh = await ev(`[...document.querySelectorAll("#setModal [data-fc-row]")].map((r)=>[r.dataset.fcRow,r.querySelector(".fc-source").textContent,r.querySelector(".fc-model").textContent])`);
    console.log(`FCUI live fresh rows: ${JSON.stringify(fresh)}`);
    assert.equal(fresh.length, 18);
    for (const [slot, from, chip] of fresh) assert.deepEqual([from, chip], ["No model assigned", "Choose a model"], slot);
    assert.deepEqual(Object.values(diskTab(fixed.id).fixedCrew.preferences).map((pref: any) => pref.assignment), Array(18).fill(null), "control: nothing assigned on disk before the first check");
    // Discovery through Settings' own Check again fills the empty automatic positions, and the server writes them.
    await click(ev, "#setModal [data-settings-refresh]");
    await waitFor(`document.querySelector(${J(`${ROW("coder")} .fc-source`)}).textContent.startsWith("Automatic")`, "Check again filled the coder automatically", 30_000);
    const autoCoder = diskTab(fixed.id).fixedCrew.preferences.coder;
    console.log(`FCUI live auto coder on disk: ${JSON.stringify(autoCoder)}`);
    assert.equal(autoCoder.source, "auto"); assert.ok(autoCoder.assignment, "the automatic pick is on disk");
    // A manual pick is the user's from then on.
    const other = autoCoder.assignment.cli === "claude" ? "codex" : "claude";
    const model = await pickModel(ev, waitFor, `${ROW("coder")} [data-fc-model]`, other);
    await waitFor(`document.querySelector(${J(`${ROW("coder")} .fc-source`)}).textContent.startsWith("Your choice")`, "the coder shows the user's pick");
    assert.deepEqual([diskTab(fixed.id).fixedCrew.preferences.coder.source, diskTab(fixed.id).fixedCrew.preferences.coder.assignment.model], ["user", model], "saved on disk as the user's choice");
    // The same model on the reviewer: the server's notice shows and saving still works.
    await pickModel(ev, waitFor, `${ROW("reviewer1")} [data-fc-model]`, other);
    const reviewerModel = diskTab(fixed.id).fixedCrew.preferences.reviewer1.assignment?.model;
    if (reviewerModel !== model) {
      await click(ev, `${ROW("reviewer1")} [data-fc-model]`);
      await click(ev, `#pop [data-cli="${other}"][data-model="${model}"]`);
    }
    await waitFor(`document.querySelector(${J(`${ROW("reviewer1")} .fc-notice`)}).textContent===${J(SAME_MODEL)}`, "the server's same-model notice", 15_000);
    await typeExtra(ev, page, "coder", EXTRA);
    await click(ev, `${ROW("coder")} [data-fc-save]`);
    await waitFor(`document.querySelector(${J(`${ROW("coder")} .fc-extra-status`)}).textContent==="Saved"`, "the extra instructions were saved");
    assert.equal(diskTab(fixed.id).fixedCrew.roleExtras.coder, EXTRA, "the literal text is on disk");
    // A real refusal: more than the server's 8 KiB keeps the text and writes nothing.
    const long = "x".repeat(9000);
    await typeExtra(ev, page, "planner", long);
    await click(ev, `${ROW("planner")} [data-fc-save]`);
    await waitFor(`document.querySelector(${J(`${ROW("planner")} .fc-extra-status`)}).textContent.startsWith("Not saved:")`, "the server refused the long text");
    console.log(`FCUI live refusal: ${await text(ev, `${ROW("planner")} .fc-extra-status`)}`);
    assert.equal(await ev(`document.querySelector(${J(`${ROW("planner")} .fc-extra`)}).value.length`), 9000, "the typed text stays");
    assert.equal(diskTab(fixed.id).fixedCrew.roleExtras.planner, undefined, "nothing was written");
    // A fresh page reads everything back from the server.
    await reload();
    await openSettings(ev, waitFor);
    await click(ev, `${ROW("coder")} [data-fc-toggle]`);
    const back = await ev(`({coder:document.querySelector(${J(`${ROW("coder")} .fc-source`)}).textContent,extra:document.querySelector(${J(`${ROW("coder")} .fc-extra`)}).value,notice:document.querySelector(${J(`${ROW("reviewer1")} .fc-notice`)}).textContent})`);
    console.log(`FCUI live after reload: ${JSON.stringify(back)}`);
    assert.deepEqual({ ...back, coder: back.coder.startsWith("Your choice") }, { coder: true, extra: EXTRA, notice: SAME_MODEL });
    await waitFor(`document.querySelector(${J(`${ROW("coder")} .fc-core-text`)}).textContent.startsWith("You are the Coder")`, "the server's built-in instructions");
    await click(ev, "#setModal [data-close]");
    // New project over the real contract: one manual pick plus Auto assign, created and written as a fixed crew.
    await click(ev, "#addProj");
    await setValue(ev, "#pName", "FCUI live project");
    await click(ev, "#pBrowse");
    await waitFor(`!document.querySelector("#createProj").disabled`, "Create project is enabled");
    const picked = await pickModel(ev, waitFor, `#pCrew [data-fc-new-model="coder"]`, "codex");
    await click(ev, "#pCrew [data-fc-new-auto]");
    await waitFor(`document.querySelector('#pCrew [data-fc-new-row="planner"] .fc-source').textContent.startsWith("Automatic")`, "the server's preview of Auto assign");
    assert.equal(diskTab(fixed.id).fixedCrew.roleExtras.coder, EXTRA, "control: the preview changed nothing on disk");
    const before = disk().projects.length;
    await click(ev, "#createProj");
    await waitFor(`document.querySelector("#projModal").hidden`, "the project was created and the dialog closed", 20_000);
    const project = disk().projects.find((item: any) => item.name === "FCUI live project");
    console.log(`FCUI live created: ${JSON.stringify(project?.tabs[0]?.fixedCrew?.preferences?.coder)} planner ${JSON.stringify(project?.tabs[0]?.fixedCrew?.preferences?.planner)}`);
    assert.equal(disk().projects.length, before + 1);
    assert.deepEqual([project.tabs.length, project.tabs[0].crew, project.tabs[0].fixedCrew.version], [1, [], 1]);
    assert.deepEqual(project.tabs[0].fixedCrew.preferences.coder, { source: "user", assignment: { cli: "codex", model: picked, effort: project.tabs[0].fixedCrew.preferences.coder.assignment.effort } });
    assert.equal(project.tabs[0].fixedCrew.preferences.planner.source, "auto"); assert.ok(project.tabs[0].fixedCrew.preferences.planner.assignment, "Auto assign filled the rest");
    assert.equal(await ev(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId`), project.tabs[0].id, "the new project's fixed tab is shown");
    assert.equal(await ev(`Boolean(document.querySelector("#fixedView #fcWorkSettings"))`), true);
  }, { fixture: "fixed", realSocket: true });
});
