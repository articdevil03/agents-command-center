import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, setValue, deliver, deliverState, type Page } from "./pack18-editor-harness.ts";

// Pack 26 Block 5 slice 2a: New project and Add a tab create only through the fixed crew. The real page in a real headless Chrome, its
// state from the real server over a fake socket (harness fixture "fixed"), so every creation message is captured exactly.

const CREATION = ["previewCrewAssignments", "addProject", "addTab"];
const DIALOGS = {
  project: { opener: "#addProj", modal: "#projModal", only: "#pOnly", create: "#createProj", box: "#pCrew", type: "addProject",
    keys: ["autoAssign", "crewChoices", "fixedCrewVersion", "folder", "id", "name", "projectOnly", "requestId", "tabFolder", "type"] },
  tab: { opener: "#addtab", modal: "#modal", only: "#tOnly", create: "#createTab", box: "#tCrew", type: "addTab",
    keys: ["autoAssign", "crewChoices", "fixedCrewVersion", "folder", "name", "projectId", "projectOnly", "requestId", "type"] },
} as const;
type Which = keyof typeof DIALOGS;
const sentFrom = (ev: Page["ev"], from: number, types: string[] = CREATION): Promise<any[]> => ev(`window.__sent.slice(${from}).filter((m)=>${J(types)}.includes(m.type))`);
const count = (ev: Page["ev"]): Promise<number> => ev("window.__sent.length");
const checkedOf = async (ev: Page["ev"], selector: string): Promise<boolean> => {
  const value = await ev(`(()=>{const el=document.querySelector(${J(selector)});return el?el.checked:null})()`);
  assert.notEqual(value, null, `the checkbox ${selector} was FOUND`);
  return value;
};

// Opens a dialog the way a click does, with a name and folder filled in when it asks for them.
async function openDialog({ ev, waitFor, work }: Pick<Page, "ev" | "waitFor" | "work">, which: Which): Promise<void> {
  const d = DIALOGS[which];
  await click(ev, d.opener);
  await waitFor(`!document.querySelector(${J(d.modal)}).hidden`, `the ${which} dialog is open`);
  if (which === "project") {
    await setValue(ev, "#pName", "FCCREATE project");
    await click(ev, "#pBrowse");
    await waitFor(`document.querySelector("#pDir").textContent===${J(work)}`, "the project folder was chosen");
  } else await waitFor(`document.querySelector("#tDir").textContent!=="No folder chosen"`, "the tab dialog starts in the project folder");
}
const textOf = async (ev: Page["ev"], selector: string): Promise<string> => {
  const value = await ev(`document.querySelector(${J(selector)})?.textContent??null`);
  assert.notEqual(value, null, `the element ${selector} was FOUND`);
  return value;
};
const closeDialog = (ev: Page["ev"], which: Which) => click(ev, `${DIALOGS[which].modal} [data-close]`);
// A refusal frees the page's waiting create, so the next one can be sent.
const refuse = (ev: Page["ev"], which: Which, requestId: string) => deliver(ev, { type: "error", message: "refused for the test", action: DIALOGS[which].type, requestId });

test("FCCREATE project-only: both dialogs start checked, send projectOnly true or false as left, reset on reopen, and send only fixed fields", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async (page) => {
    const { ev, discovered, work } = page;
    await deliverState(ev, discovered);
    await ev(`window.cc.pickFolder=async()=>${J(work)}`);
    for (const which of ["project", "tab"] as const) {
      const d = DIALOGS[which];
      await openDialog(page, which);
      assert.equal(await checkedOf(ev, d.only), true, `${which}: a fresh open starts checked`);
      assert.equal(await textOf(ev, `label[for=${d.only.slice(1)}] span`), "Work on this project only", `${which}: the checkbox label`);
      if (which === "project") assert.match(await textOf(ev, "label[for=pOnly] small"), /AGENTS\.md/, "the New project help mentions AGENTS.md");
      let from = await count(ev);
      await click(ev, d.create);
      const [ticked] = await sentFrom(ev, from);
      assert.ok(ticked, `${which}: a checked Create sent a message`);
      assert.equal(ticked.type, d.type);
      assert.equal(ticked.projectOnly, true, `${which}: checked sends projectOnly true`);
      if (which === "project") assert.equal(ticked.name, "FCCREATE project", "the chosen project name is sent");
      assert.deepEqual(Object.keys(ticked).sort(), [...d.keys], `${which}: the payload is the fixed fields only`);
      assert.deepEqual([ticked.fixedCrewVersion, Object.hasOwn(ticked, "kind"), Object.hasOwn(ticked, "template")], [1, false, false]);
      await refuse(ev, which, ticked.requestId);
      await closeDialog(ev, which);
      await openDialog(page, which);
      assert.equal(await checkedOf(ev, d.only), true, `${which}: reopening resets to checked`);
      await click(ev, d.only);
      assert.equal(await checkedOf(ev, d.only), false, `${which}: the click unchecked it`);
      from = await count(ev);
      await click(ev, d.create);
      const [unticked] = await sentFrom(ev, from);
      assert.ok(unticked, `${which}: an unchecked Create sent a message`);
      assert.equal(unticked.projectOnly, false, `${which}: unchecked sends projectOnly false`);
      assert.deepEqual(Object.keys(unticked).sort(), [...d.keys], `${which}: the payload is still the fixed fields only`);
      await refuse(ev, which, unticked.requestId);
      await closeDialog(ev, which);
      await openDialog(page, which);
      assert.equal(await checkedOf(ev, d.only), true, `${which}: reopening after an unchecked create resets to checked`);
      await closeDialog(ev, which);
    }
  }, { fixture: "fixed" });
});

// Server states the dialogs must refuse. Each stays drawable, so a broken guard shows as a failed assertion and not as a crash.
const BROKEN: [string, string][] = [
  ["missing", "delete state.fixedCrewDefinitions"],
  ["empty", "state.fixedCrewDefinitions=[]"],
  ["not a list", `state.fixedCrewDefinitions="leader"`],
  ["incomplete (no label)", "delete state.fixedCrewDefinitions[0].label"],
  ["incomplete (no group)", "delete state.fixedCrewDefinitions[1].group"],
  ["duplicate slot", "state.fixedCrewDefinitions[1].slot=state.fixedCrewDefinitions[0].slot"],
];

async function unavailableCase(which: Which): Promise<void> {
  await withPage(async (page) => {
    const { ev, waitFor, discovered, work } = page;
    const d = DIALOGS[which];
    await deliverState(ev, discovered);
    await ev(`window.cc.pickFolder=async()=>${J(work)}`);
    const found = (selector: string) => `document.querySelector(${J(selector)})`;
    for (const [label, change] of BROKEN) {
      await deliverState(ev, discovered, change);
      await openDialog(page, which);
      const shape = await ev(`(()=>{const msg=${found(`${d.box} [data-fc-new-unavailable]`)},create=${found(d.create)},auto=${found(`${d.box} [data-fc-new-auto]`)};
        return {msg:msg?.textContent??null,msgShown:Boolean(msg?.getClientRects().length),create:create?create.disabled:null,auto:auto?auto.disabled:null,rows:document.querySelectorAll("${d.box} [data-fc-new-row]").length,
          legacy:document.querySelectorAll("#kindBox,#tplBox,#pKind,#pTpl,${d.modal} [data-kind],${d.modal} [data-template]").length}})()`);
      console.log(`FCCREATE ${which} ${label}: ${JSON.stringify(shape)}`);
      assert.match(String(shape.msg), /not available/, `${label}: the plain unavailable message exists`);
      assert.equal(shape.msgShown, true, `${label}: the message is visible`);
      assert.deepEqual([shape.create, shape.auto], [true, true], `${label}: Create and Auto assign are disabled`);
      assert.deepEqual([shape.rows, shape.legacy], [0, 0], `${label}: no position rows and no old kind or template controls`);
      // Forced on, the real listeners still send nothing.
      const from = await count(ev);
      const forced = await ev(`(()=>{const create=${found(d.create)},auto=${found(`${d.box} [data-fc-new-auto]`)};if(!create||!auto)return false;create.disabled=false;auto.disabled=false;create.click();auto.click();return true})()`);
      assert.equal(forced, true, `${label}: both controls were FOUND and forced`);
      assert.deepEqual(await sentFrom(ev, from), [], `${label}: no creation or preview message is sent`);
      assert.deepEqual(await ev("window.__ccErrors"), [], `${label}: no page error`);
      await closeDialog(ev, which);
    }
    // Valid data back, dialog reopened: normal fixed creation works again.
    await deliverState(ev, discovered);
    await openDialog(page, which);
    await waitFor(`document.querySelectorAll(${J(`${d.box} [data-fc-new-row]`)}).length===18`, "all 18 positions are drawn again");
    assert.equal(await ev(`Boolean(${found(`${d.box} [data-fc-new-unavailable]`)})`), false, "the unavailable message is gone");
    await waitFor(`!${found(d.create)}.disabled`, "Create is enabled again");
    const from = await count(ev);
    await click(ev, d.create);
    const [created] = await sentFrom(ev, from);
    assert.ok(created, "a normal create is sent after the data came back");
    assert.deepEqual([created.type, created.fixedCrewVersion, Object.hasOwn(created, "kind"), Object.hasOwn(created, "template")], [d.type, 1, false, false]);
    await refuse(ev, which, created.requestId);
  }, { fixture: "fixed" });
}

test("FCCREATE unavailable project: without usable server positions New project says so, disables Create and Auto assign, and sends nothing even when forced", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await unavailableCase("project");
});

test("FCCREATE unavailable tab: without usable server positions Add a tab says so, disables Create and Auto assign, and sends nothing even when forced", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await unavailableCase("tab");
});
