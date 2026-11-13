import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, setValue, deliverState, press, delay, type Page } from "./pack18-editor-harness.ts";

// Pack 26 Block 5 slice 2b: the old crew editor's draft bugs, proved on the fixed crew (harness fixture "fixed": the real page in a real headless
// Chrome, its state from the real server over a fake socket). W6 a creation draft takes its model before Create, W7 typing keeps the focus, the
// caret and the exact Settings scroll through state broadcasts, W8 the model menu hangs from its control and closes, W11 the model menu shows
// friendly names only. The old Save bar (W5), added-seat success (W9) and the derived Who does what line (W10) are retired with the old editor.

const count = (ev: Page["ev"]): Promise<number> => ev("window.__sent.length");
const sentFrom = (ev: Page["ev"], from: number, types: string[]): Promise<any[]> => ev(`window.__sent.slice(${from}).filter((m)=>${J(types)}.includes(m.type))`);
const popShown = (ev: Page["ev"]) => ev(`!document.querySelector("#pop").hidden`);
const bodyTop = (ev: Page["ev"]): Promise<number> => ev(`document.querySelector("#setBody").scrollTop`);
async function openSettings(ev: Page["ev"], waitFor: Page["waitFor"]): Promise<void> {
  await click(ev, "#setBtn");
  await waitFor(`Boolean(document.querySelector("#setModal:not([hidden]) [data-fc-tab]"))`, "the fixed crew section in Settings");
}

test("W6: a creation draft picks its model and effort before Create, shows them by friendly name, sends nothing early, and Create sends them in the one fixed payload", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, work }) => {
    await deliverState(ev, discovered);
    await ev(`window.cc.pickFolder=async()=>${J(work)}`);
    await click(ev, "#addProj");
    await waitFor(`!document.querySelector("#projModal").hidden`, "the New project dialog");
    await setValue(ev, "#pName", "W6 project");
    await click(ev, "#pBrowse");
    await waitFor(`document.querySelector("#pDir").textContent===${J(work)}`, "the project folder was chosen");
    await waitFor(`!document.querySelector("#createProj").disabled`, "Create project is enabled");
    // Auto assign stays off, so a preview message can never hide an early write.
    assert.equal(await ev(`document.querySelector("#pCrew [data-fc-new-auto]")?.getAttribute("aria-pressed")`), "false", "control: Auto assign is FOUND and off");
    const from = await count(ev);
    await click(ev, `#pCrew [data-fc-new-model="coder"]`);
    await waitFor(`!document.querySelector("#pop").hidden&&Boolean(document.querySelector("#pop #mq"))`, "the model menu opens for the position");
    const pick = await ev(`(()=>{const b=[...document.querySelectorAll("#pop [data-model]")].find((el)=>el.dataset.cli==="claude"&&el.getAttribute("aria-pressed")!=="true"&&!el.querySelector("small"));if(!b)return null;const out={model:b.dataset.model,shown:b.querySelector(".nm > span").textContent};b.click();return out})()`);
    assert.ok(pick, "control: the menu offers a Claude model with an effort setting");
    assert.equal(await ev(`document.querySelector('#pop [data-model="${pick.model}"][data-cli="claude"]').getAttribute("aria-pressed")`), "true", "the menu stays open and ticks the pick (drawn from the draft)");
    const effort = await ev(`(()=>{const b=[...document.querySelectorAll("#pop [data-effort]")].find((el)=>el.getAttribute("aria-checked")!=="true");if(!b)return null;b.click();return b.dataset.effort})()`);
    assert.ok(effort, "control: another effort is offered");
    assert.equal(await popShown(ev), false, "an effort closes the menu");
    const shown = await ev(`(()=>{const row=document.querySelector('#pCrew [data-fc-new-row="coder"]');return {source:row.querySelector(".fc-source").textContent,model:row.querySelector(".fc-model-text").textContent,all:document.querySelector("#projModal").innerText}})()`);
    console.log(`W6 picked ${JSON.stringify({ pick, effort })}; row "${shown.source}" / "${shown.model}"`);
    assert.ok(shown.model.includes(pick.shown) && shown.model.includes(effort), "the row shows the picked model's friendly name and its effort");
    assert.match(shown.source, /^Your choice · Claude/);
    assert.ok(!shown.all.includes(pick.model), `the raw id ${pick.model} is never shown`);
    assert.doesNotMatch(shown.all, /\[1m\]|claude-[a-z]/, "no raw Claude id anywhere in the dialog");
    assert.deepEqual(await sentFrom(ev, from, ["updateSeat", "setSetup", "setCrewAssignment", "clearCrewAssignment", "previewCrewAssignments", "addProject", "addTab"]), [], "nothing is sent before Create");
    await click(ev, "#createProj");
    const sent = await sentFrom(ev, from, ["addProject"]);
    assert.equal(sent.length, 1, "one addProject");
    assert.deepEqual(Object.keys(sent[0]).sort(), ["autoAssign", "crewChoices", "fixedCrewVersion", "folder", "id", "name", "projectOnly", "requestId", "tabFolder", "type"], "the payload is the fixed fields only");
    assert.deepEqual([sent[0].crewChoices, sent[0].autoAssign], [{ coder: { cli: "claude", model: pick.model, effort } }, false], "everything the position was given, in the one payload");
    assert.deepEqual(await sentFrom(ev, from, ["updateSeat", "setSetup", "setCrewAssignment"]), [], "no seat or assignment write for a position the server does not have yet");
    await ev(`__ccDeliver(${J({ type: "error", message: "refused for the test", action: "addProject", requestId: sent[0].requestId })});true`);
  }, { fixture: "fixed" });
});

test("W7: typing in a fixed position's instructions, and in a Settings field after the crew, keeps the value, caret, focus, open Instructions and the exact Settings scroll through state broadcasts (numbers printed)", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, discovered, fixed }) => {
    await deliverState(ev, discovered);
    await openSettings(ev, waitFor);
    const ROW = `#setModal [data-fc-row="coder"]`, AREA = `${ROW} .fc-extra`;
    await click(ev, `${ROW} [data-fc-toggle]`);
    await ev(`(()=>{const body=document.querySelector("#setBody"),box=document.querySelector(${J(AREA)});body.scrollTop+=box.getBoundingClientRect().top-body.getBoundingClientRect().top-body.clientHeight*0.3;return true})()`);
    await delay(150);
    const start = await bodyTop(ev);
    assert.ok(start > 100, `control: Settings is scrolled to the position's field (${start})`);
    const probe = () => ev(`(()=>{const a=document.activeElement,b=document.querySelector("#setBody");return {id:a?.id??null,value:a?.value??null,caret:a&&"selectionStart" in a?[a.selectionStart,a.selectionEnd]:null,scroll:b.scrollTop,open:!document.querySelector(${J(`${ROW} .fc-panel`)}).hidden}})()`);
    const focus = (selector: string) => ev(`(()=>{const a=document.querySelector(${J(selector)});if(!a)return false;a.focus({preventScroll:true});a.setSelectionRange(a.value.length,a.value.length);return document.activeElement===a})()`);
    assert.equal(await focus(AREA), true, "the instructions field was FOUND and focused");
    const field = `fc-extra-${fixed.id}-coder`, steps: string[] = [];
    let typed = "";
    for (const char of "Quinn Ross") {
      await page("Input.insertText", { text: char }); typed += char;
      await deliverState(ev, discovered); await delay(30);
      const now = await probe(); steps.push(`${JSON.stringify(typed)} scroll=${now.scroll} caret=${now.caret}`);
      assert.deepEqual(now, { id: field, value: typed, caret: [typed.length, typed.length], scroll: start, open: true }, `after typing ${char}: value, caret, focus, open Instructions and scroll`);
    }
    console.log(`W7 instructions, scrollTop before ${start}: ${steps.join(" | ")}`);
    // A Settings field after the fixed section: rebuilding the sections below it must not clamp the scroll or lose the draft.
    const placed = await ev(`(async()=>{const body=document.querySelector("#setBody"),input=document.querySelector("#defaultProjectFolder");if(!input)return null;input.scrollIntoView({block:"center"});await new Promise((ok)=>requestAnimationFrame(()=>requestAnimationFrame(ok)));
      const base=body.getBoundingClientRect().top-body.scrollTop,fixedBottom=document.querySelector("#s-crew").getBoundingClientRect().bottom-base,fieldTop=input.getBoundingClientRect().top-base;
      return {scroll:body.scrollTop,height:body.clientHeight,total:body.scrollHeight,fixedBottom:Math.round(fixedBottom),fieldTop:Math.round(fieldTop),initial:input.value}})()`);
    assert.ok(placed, "the Default folder field was FOUND");
    console.log(`W7 Settings field: ${JSON.stringify(placed)}`);
    assert.ok(placed.fieldTop > placed.fixedBottom && placed.scroll + placed.height > placed.fixedBottom + 50, "control: Settings is scrolled past the end of the fixed section, so dropping the later sections would clamp the scroll");
    assert.equal(await focus("#defaultProjectFolder"), true, "the Default folder field was focused");
    const base = await probe();
    assert.equal(base.id, "defaultProjectFolder");
    let text = placed.initial; const second: string[] = [];
    for (const char of "C:/w7") {
      await page("Input.insertText", { text: char }); text += char;
      await deliverState(ev, discovered); await delay(30);
      const now = await probe(); second.push(`${JSON.stringify(now.value)} scroll=${now.scroll}`);
      assert.deepEqual([now.id, now.value, now.caret, now.scroll], ["defaultProjectFolder", text, [text.length, text.length], base.scroll], `after typing ${char} in the Settings field: draft, caret, focus and exact scroll`);
    }
    console.log(`W7 Settings field, scrollTop before ${base.scroll}: ${second.join(" | ")}`);
  }, { fixture: "fixed" });
});

test("W8: a fixed model menu hangs from its control and closes on a Settings scroll, a section switch (even to the section already shown), an outside click and Escape", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, discovered }) => {
    await deliverState(ev, discovered);
    await openSettings(ev, waitFor);
    const CHIP = `#setModal [data-fc-row="leader"] [data-fc-model]`;
    const gap = () => ev(`(()=>{const pop=document.querySelector("#pop");if(pop.hidden)return null;const a=document.querySelector(${J(CHIP)}).getBoundingClientRect(),p=pop.getBoundingClientRect();return Math.round(Math.min(Math.abs(p.top-a.bottom),Math.abs(a.top-p.bottom)))})()`);
    // Measured once the menu's 150 ms open has run (it starts a little smaller and higher).
    const openMenu = async () => { await click(ev, CHIP); await waitFor(`!document.querySelector("#pop").hidden`, "the model menu opens"); await delay(250); };
    await click(ev, `#setNav [data-settings-section="crew"]`); await delay(100);
    await openMenu();
    const near = await gap();
    assert.ok(near !== null && near <= 12, `it opens next to its control (gap ${near})`);
    const scrolled = await ev(`(async()=>{const body=document.querySelector("#setBody"),from=body.scrollTop;body.scrollTop+=200;await new Promise((ok)=>setTimeout(ok,200));return {from,to:body.scrollTop}})()`);
    console.log(`W8 scroll ${JSON.stringify(scrolled)}: menu shown ${await popShown(ev)}`);
    assert.ok(scrolled.to - scrolled.from >= 150, "control: Settings really scrolled");
    assert.equal(await popShown(ev), false, "a real Settings scroll closes it");
    // The section already shown: the switch moves nothing, so only the switch itself can close it.
    await click(ev, `#setNav [data-settings-section="crew"]`); await delay(100);
    await openMenu();
    const still = await bodyTop(ev);
    await click(ev, `#setNav [data-settings-section="crew"]`); await delay(150);
    console.log(`W8 same-section switch: scrollTop ${still} -> ${await bodyTop(ev)}, menu shown ${await popShown(ev)}`);
    assert.equal(await bodyTop(ev), still, "control: switching to the shown section did not scroll");
    assert.equal(await popShown(ev), false, "switching to the section already shown closes it");
    await openMenu();
    await click(ev, `#setNav [data-settings-section="tools"]`); await delay(150);
    assert.equal(await popShown(ev), false, "switching to another section closes it");
    await click(ev, `#setNav [data-settings-section="crew"]`); await delay(150);
    await openMenu();
    assert.equal(await ev(`(()=>{const out=document.querySelector("#s-crew .fc-intro");if(!out)return false;out.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));out.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}));out.click();return true})()`), true, "control: the outside element was FOUND and clicked");
    await delay(100);
    assert.equal(await popShown(ev), false, "an outside click closes it");
    await openMenu();
    await press(page, "Escape");
    await delay(100);
    assert.deepEqual({ shown: await popShown(ev), settings: await ev(`!document.querySelector("#setModal").hidden`), focus: await ev(`document.activeElement?.dataset.focusKey`) }, { shown: false, settings: true, focus: "fc-model-leader" }, "Escape closes only the menu and focus goes back to its control");
  }, { fixture: "fixed" });
});

test("W11: the fixed model menu shows friendly names only: no raw id (claude-... or [1m]) in any visible text, every name is different and none is blank, also next to a model with no effort setting", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered }) => {
    const models = [{ value: "claude-opus-5", displayName: "Claude Opus 5" }, { value: "claude-opus-5[1m]", displayName: "Claude Opus 5 (1M context)" }, { value: "claude-fable-5-2", displayName: "Claude Fable 5.2" }, { value: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", supportsEffort: false }];
    await deliverState(ev, discovered, `const claude=state.clis.find((c)=>c.id==="claude");state.claudeModels=${J(models)};claude.models=${J(models.map((m) => m.value))};claude.installed=true`);
    await openSettings(ev, waitFor);
    await click(ev, `#setModal [data-fc-row="leader"] [data-fc-model]`);
    await waitFor(`!document.querySelector("#pop").hidden&&Boolean(document.querySelector("#pop #mq"))`, "the model menu opens");
    const menu = await ev(`(()=>{const rows=[...document.querySelectorAll("#pop [data-model]")].filter((el)=>el.dataset.cli==="claude");return {text:document.querySelector("#pop").innerText,names:rows.map((el)=>el.querySelector(".nm > span").innerText.trim()),ids:rows.map((el)=>el.dataset.model),
      noEffort:rows.filter((el)=>el.querySelector("small")?.textContent==="No effort setting").map((el)=>el.dataset.model)}})()`);
    console.log(`W11 claude rows ${JSON.stringify(menu.names)} for ids ${JSON.stringify(menu.ids)}`);
    for (const model of models) assert.ok(menu.ids.includes(model.value), `control: the menu offers ${model.value}`);
    assert.deepEqual(menu.noEffort, ["claude-haiku-5-5"], "control: the model with no effort setting says so in the menu");
    assert.doesNotMatch(menu.text, /claude-|\[1m\]/, "no raw id in the visible text of the menu");
    assert.equal(new Set(menu.names).size, menu.names.length, `every name is different: ${menu.names.join(" | ")}`);
    assert.ok(menu.names.every((name: string) => name.length > 1), "and none is blank");
  }, { fixture: "fixed" });
});
