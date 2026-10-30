import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { validateSetup } from "../server/setup.ts";
import { editorTestMs, ED, J, withPage, skipped, sentOf, click, openEditor, openSeat, openTab, pickRole, addSeat, bodyTop, deliverTab, setValue, delay, type Page } from "./pack18-editor-harness.ts";

// Pack 18 rework, the crew editor's bugs found live (harness: test/pack18-editor-harness.ts). W5 the Save bar is pinned and covers
// nothing, W6 a new seat takes a model before Save, W7 editing keeps the scroll, W8 the model menu closes instead of staying behind,
// W9 Save closes the card and says who joined, W10 who does what is the server's steps.

const SIZES = [{ name: "1440x900", width: 1440, height: 900, scale: 1 }, { name: "200% zoom", width: 720, height: 450, scale: 2 }];
const resize = (page: Page["page"], size: (typeof SIZES)[number]) => page("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: false });
const popShown = (ev: Page["ev"]) => ev(`!document.querySelector("#pop").hidden`);

test("W5: the Save bar is pinned to the bottom edge of the Settings window, the full width of the Settings content, solid, and never over the crew: the scroll area ends where the bar starts (numbers printed)", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page }) => {
    await openEditor(ev, waitFor);
    assert.equal(await ev(`document.querySelector("#setFoot").getBoundingClientRect().height`), 0, "nothing to save: no bar");
    await click(ev, `${ED} [data-se-look-toggle]`);
    for (const size of SIZES) {
      await resize(page, size); await delay(150);
      const box = (scrollTo: string) => ev(`(async()=>{const body=document.querySelector("#setBody");body.scrollTop=${scrollTo};await new Promise((ok)=>requestAnimationFrame(()=>requestAnimationFrame(ok)));
        const r=(el)=>{const b=el.getBoundingClientRect();return {top:Math.round(b.top),bottom:Math.round(b.bottom),left:Math.round(b.left),right:Math.round(b.right)}};
        const bar=document.querySelector("#setFoot"),b=bar.getBoundingClientRect(),sections=[...body.querySelectorAll(".settings-section")],hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
        return {bar:r(bar),body:r(body),modal:r(document.querySelector("#setModal")),last:r(sections.at(-1)),bg:getComputedStyle(bar).backgroundColor,
          atEnd:Math.abs(body.scrollTop+body.clientHeight-body.scrollHeight)<=1,onTop:bar.contains(hit),save:bar.querySelectorAll("[data-se-save]").length}})()`);
      const middle = await box("200"), end = await box("body.scrollHeight");
      console.log(`W5 ${size.name}: bar ${JSON.stringify(middle.bar)} body ${JSON.stringify(middle.body)} window ${JSON.stringify(middle.modal)} bg ${middle.bg}; at the end: last section bottom ${end.last.bottom} vs bar top ${end.bar.top}`);
      assert.equal(middle.save, 1, "control: the bar is there with its Save");
      assert.ok(Math.abs(middle.bar.bottom - middle.modal.bottom) <= 1, `${size.name}: the bar sits on the window's bottom edge`);
      assert.ok(Math.abs(middle.body.bottom - middle.bar.top) <= 1, `${size.name}: the Settings scroll area ends where the bar starts (it reserves the bar's height)`);
      assert.ok(Math.abs(middle.bar.left - middle.body.left) <= 1 && Math.abs(middle.bar.right - middle.body.right) <= 1, `${size.name}: the bar is the full width of the Settings content`);
      assert.match(middle.bg, /^rgb\(/, `${size.name}: a solid background (${middle.bg})`);
      assert.ok(middle.onTop, "nothing is drawn over the bar");
      assert.ok(end.atEnd && end.last.bottom <= end.bar.top, `${size.name}: scrolled to the end, the last section ends above the bar (${end.last.bottom} <= ${end.bar.top})`);
    }
  });
});

test("W6: a new seat picks its model, effort and advisor, Can write and Runs the process before Save, all sent in the one setSetup; no updateSeat for it; friendly model names, never a raw id", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor }) => {
    await openEditor(ev, waitFor);
    await pickRole(ev, "planner", "Reviewer"); // the crew's Planner steps aside, so the new seat can be the Planner
    const slot = await addSeat(ev);
    const before = await ev(`({text:document.querySelector(${J(ED)}).innerText})`);
    await click(ev, `${ED} [data-se-model="${slot}"]`);
    await waitFor(`!document.querySelector("#pop").hidden&&document.querySelector("#mq")`, "the model menu opens for the new seat");
    const pick = await ev(`(()=>{const b=[...document.querySelectorAll("#pop [data-model]")].find((el)=>el.getAttribute("aria-pressed")!=="true"&&el.dataset.cli==="claude");if(!b)return null;const out={model:b.dataset.model,cli:b.dataset.cli,shown:b.querySelector(".nm > span").textContent};b.click();return out})()`);
    assert.ok(pick, "control: the menu offers another Claude model");
    assert.equal(await ev(`document.querySelector('#pop [data-model="${pick.model}"][data-cli="claude"]').getAttribute("aria-pressed")`), "true", "the menu stays open and ticks the pick (drawn from the draft)");
    const effort = await ev(`(()=>{const b=[...document.querySelectorAll("#pop [data-effort]")].find((el)=>el.getAttribute("aria-checked")!=="true");if(!b)return null;b.click();return b.dataset.effort})()`);
    assert.ok(effort, "control: another effort is offered");
    assert.equal(await popShown(ev), false, "an effort closes the menu");
    await click(ev, `${ED} [data-se-advisor="${slot}"]`);
    const advisor = await ev(`(()=>{const b=[...document.querySelectorAll("#pop [data-advisor]")].find((el)=>el.dataset.advisor);if(!b)return null;b.click();return b.dataset.advisor})()`);
    assert.ok(advisor, "control: an advisor is offered");
    await pickRole(ev, slot, "Planner"); // a Planner is read-only by default ...
    await click(ev, `${ED} [data-se-canwrite="${slot}"]`); // ... and Can write can still be flipped by hand
    const shown = await ev(`({row:document.querySelector(${J(`${ED} [data-se-row="${slot}"] small`)}).innerText,model:document.querySelector(${J(`${ED} [data-se-model="${slot}"]`)}).innerText,advisor:document.querySelector(${J(`${ED} [data-se-advisor="${slot}"]`)}).innerText,all:document.querySelector(${J(ED)}).innerText})`);
    console.log(`W6 picked ${JSON.stringify({ pick, effort, advisor })}; row "${shown.row}", model button "${shown.model.replace(/\s+/g, " ")}", advisor "${shown.advisor}"`);
    assert.ok(shown.row.includes(pick.shown) && shown.row.includes(effort), "the row shows the picked model's friendly name and its effort");
    assert.ok(shown.model.includes(pick.shown), "and so does the model button");
    for (const raw of [pick.model, advisor]) assert.ok(!shown.all.includes(raw) && !before.text.includes(raw), `the raw id ${raw} is never shown`);
    assert.doesNotMatch(shown.all, /\[1m\]|claude-[a-z]/, "no raw Claude id anywhere in the editor");
    await click(ev, "#setFoot [data-se-save]");
    const sent = await sentOf(ev, "setSetup");
    assert.equal(sent.length, 1, "one setSetup");
    const seat = sent[0].crew.find((item: any) => item.slot === slot);
    assert.deepEqual(seat, { slot, name: "New seat", role: "Planner", cli: "claude", model: pick.model, effort, canWrite: true, isLeader: false, advisor, orchestrates: true }, "everything the new seat was given, in the one setSetup");
    assert.equal((await sentOf(ev, "updateSeat")).length, 0, "no updateSeat for a seat the server does not know");
  });
});

test("W7: typing in a new seat, switching Can write and picking a role keep the Settings scroll exactly, also when a state message arrives between them (numbers printed)", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, ours }) => {
    await openEditor(ev, waitFor);
    const slot = await addSeat(ev);
    await ev(`(()=>{const body=document.querySelector("#setBody"),card=document.querySelector(${J(`${ED} [data-se-card="${slot}"]`)});body.scrollTop+=card.getBoundingClientRect().top-body.getBoundingClientRect().top-body.clientHeight*0.3;return true})()`);
    await delay(150);
    const start = await bodyTop(ev);
    assert.ok(start > 100, `control: Settings is scrolled to the new seat's card (${start})`);
    const tops: [string, number][] = [];
    const broadcast = () => deliverTab(ev, ours.id, "");
    await ev(`document.querySelector(${J(`${ED} [data-se-name="${slot}"]`)}).focus();true`);
    for (const char of "Quinn Ross") { await page("Input.insertText", { text: char }); await broadcast(); await delay(30); tops.push([`typed ${char}`, await bodyTop(ev)]); }
    assert.equal(await ev(`document.querySelector(${J(`${ED} [data-se-name="${slot}"]`)}).value`), "Quinn Ross", "control: the ten characters were typed");
    await click(ev, `${ED} [data-se-canwrite="${slot}"]`); await broadcast(); await delay(30); tops.push(["Can write", await bodyTop(ev)]);
    await pickRole(ev, slot, "Reviewer"); await broadcast(); await delay(30); tops.push(["role", await bodyTop(ev)]);
    console.log(`W7 scrollTop start ${start}: ${tops.map(([what, top]) => `${what}=${top}`).join(" ")}`);
    for (const [what, top] of tops) assert.equal(top, start, `after ${what} the scroll is where it was`);
  });
});

test("W8: the model menu hangs from its seat and closes on a Settings scroll, a section switch (even to the section already shown), an outside click and Escape; the advisor menu closes on a scroll too", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor }) => {
    await openEditor(ev, waitFor);
    await openSeat(ev, "coder");
    const gap = () => ev(`(()=>{const pop=document.querySelector("#pop");if(pop.hidden)return null;const a=document.querySelector(${J(`${ED} [data-se-model="coder"]`)}).getBoundingClientRect(),p=pop.getBoundingClientRect();return Math.round(Math.min(Math.abs(p.top-a.bottom),Math.abs(a.top-p.bottom)))})()`);
    // Measured once the menu's 150 ms open has run (it starts a little smaller and higher).
    const openMenu = async (which = "model") => { await click(ev, `${ED} [data-se-${which}="coder"]`); await waitFor(`!document.querySelector("#pop").hidden`, `the ${which} menu opens`); await delay(250); };
    await click(ev, `#setNav [data-settings-section="crew"]`); await delay(100);
    await openMenu();
    assert.ok((await gap()) <= 8, `it opens next to its seat (gap ${await gap()})`);
    const scrolled = await ev(`(async()=>{const body=document.querySelector("#setBody"),from=body.scrollTop;body.scrollTop+=200;await new Promise((ok)=>setTimeout(ok,200));return {from,to:body.scrollTop}})()`);
    const afterScroll = { shown: await popShown(ev), gap: await gap() };
    console.log(`W8 scroll ${JSON.stringify(scrolled)}: ${JSON.stringify(afterScroll)}`);
    assert.ok(scrolled.to - scrolled.from >= 150, "control: Settings really scrolled");
    assert.ok(!afterScroll.shown || afterScroll.gap! <= 8, "after a scroll it is closed or still next to its seat");
    // The section already shown: the switch moves nothing, so only the switch itself can close it.
    await click(ev, `#setNav [data-settings-section="crew"]`); await delay(100);
    await openMenu();
    const still = await bodyTop(ev);
    await click(ev, `#setNav [data-settings-section="crew"]`); await delay(150);
    console.log(`W8 same-section switch: scrollTop ${still} -> ${await bodyTop(ev)}, menu shown ${await popShown(ev)}`);
    assert.equal(await bodyTop(ev), still, "control: switching to the shown section did not scroll");
    assert.equal(await popShown(ev), false, "switching section closes it");
    await openMenu();
    await click(ev, `#setNav [data-settings-section="tools"]`); await delay(150);
    assert.equal(await popShown(ev), false, "switching to another section closes it");
    await click(ev, `#setNav [data-settings-section="crew"]`); await delay(150);
    await openMenu();
    await ev(`(()=>{const out=document.querySelector("#s-crew h3");out.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));out.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}));out.click();return true})()`);
    await delay(100);
    assert.equal(await popShown(ev), false, "an outside click closes it");
    await openMenu();
    await ev(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));true`);
    await delay(100);
    assert.deepEqual({ shown: await popShown(ev), settings: await ev(`!document.querySelector("#setModal").hidden`), focus: await ev(`document.activeElement?.dataset.focusKey`) }, { shown: false, settings: true, focus: "se-model-coder" }, "Escape closes only the menu and focus goes back to its button");
    await openMenu("advisor");
    await ev(`document.querySelector("#setBody").scrollTop+=200;true`); await delay(200);
    assert.equal(await popShown(ev), false, "the advisor menu closes on a scroll too");
  });
});

test("W9: after a successful Save the new seat's card closes and '<name> added to the crew' shows, is announced once (polite) and fades away", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, ours }) => {
    await openEditor(ev, waitFor);
    const slot = await addSeat(ev);
    await setValue(ev, `${ED} [data-se-name="${slot}"]`, "Quinn");
    await click(ev, "#setFoot [data-se-save]");
    const [sent] = await sentOf(ev, "setSetup");
    assert.ok(await ev(`Boolean(document.querySelector(${J(`${ED} [data-se-card="${slot}"]`)}))`), "control: the card is open while it saves");
    await deliverTab(ev, ours.id, `tab.crew=${J(sent.crew)}.map((seat)=>({status:"idle",runs:[],...(tab.crew.find((x)=>x.slot===seat.slot)??{}),...seat,seatKey:${J(ours.id)}+"."+seat.slot}));tab.lookPause=${J(sent.lookPause)}`);
    await waitFor(`document.querySelector(${J(`${ED} [data-se-note]`)})?.textContent==="Quinn added to the crew"`, "the note shows");
    await waitFor(`document.querySelector("#setLive").textContent==="Quinn added to the crew"`, "the live region is filled on the next frame");
    const after = await ev(`({cards:document.querySelectorAll(${J(`${ED} [data-se-card]`)}).length,bar:document.querySelector("#setFoot").innerHTML,live:document.querySelector("#setLive").textContent,role:document.querySelector("#setLive").getAttribute("role"),politeness:document.querySelector("#setLive").getAttribute("aria-live"),focus:document.activeElement?.dataset.focusKey,expanded:document.querySelector(${J(`${ED} [data-se-row="${slot}"]`)}).getAttribute("aria-expanded")})`);
    console.log(`W9 after the save: ${JSON.stringify(after)}`);
    assert.deepEqual(after, { cards: 0, bar: "", live: "Quinn added to the crew", role: "status", politeness: "polite", focus: `se-row-${slot}`, expanded: "false" }, "the card closed, the bar went, the note was announced and focus is on the new seat's row");
    await waitFor(`document.querySelector(${J(`${ED} [data-se-note]`)})===null`, "the note goes after a few seconds", 8_000);
  });
});

test("W10: who does what is the server's steps for the tab in plain words, greyed with 'Updates when you save.' while the crew is unsaved; a tab with no steps says the leader does everything", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, ours, blank }) => {
    assert.deepEqual(ours.steps.map((step: any) => step.id), ["plan", "build", "gate", "look", "review", "final", "ship"], "control: the server derived Our process's steps");
    await openEditor(ev, waitFor);
    const flow = () => ev(`[...document.querySelectorAll(${J(`${ED} [data-se-flow] li`)})].map((li)=>li.innerText.trim())`);
    assert.deepEqual(await flow(), ["Plan: Sage", "Build: Sonny", "Gate: Sage", "Your look", "Review: Vera, then Sol (fixes: Juno / Nova)", "Final review: Terra", "Ship: Sage"]);
    // Whatever the server says the steps are is what shows (here a second builder and one review pair).
    await deliverTab(ev, ours.id, `const b=tab.steps.find((s)=>s.id==="build");b.owners=["coder","final"];tab.steps.find((s)=>s.id==="review").pairs=[{reviewer:"reviewer2",fixers:["coder"]}]`);
    await waitFor(`document.querySelector(${J(`${ED} [data-se-flow]`)})?.innerText.includes("Sonny + Terra")`, "the line follows the server's steps");
    assert.deepEqual((await flow()).filter((text: string) => /^(Build|Review)/.test(text)), ["Build: Sonny + Terra", "Review: Sol (fixes: Sonny)"]);
    assert.equal(await ev(`document.querySelector(${J(`${ED} [data-se-stale]`)})`), null, "control: saved, nothing greyed");
    await pickRole(ev, "coder", "Reviewer");
    assert.deepEqual(await ev(`({note:document.querySelector(${J(`${ED} [data-se-stale]`)})?.textContent,grey:document.querySelector(${J(`${ED} [data-se-who]`)}).classList.contains("stale")})`), { note: "Updates when you save.", grey: true });
    assert.ok((await flow()).includes("Build: Sonny + Terra"), "unsaved roles do not change the shown steps: they are the server's");
    await click(ev, "#setFoot [data-se-discard]");
    await openTab(ev, waitFor, blank.id);
    assert.equal(await ev(`document.querySelector(${J(`${ED} [data-se-flow-none]`)})?.textContent`), `${blank.crew[0].name} does everything. Add seats to share the work.`);
    assert.equal(await ev(`document.querySelectorAll(${J(`${ED} [data-se-flow] li`)}).length`), 0);
  });
});

test("W11: the model menu of a new seat shows friendly names only: no raw id (claude-... or [1m]) in any visible text, and every name in the menu is different", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor }) => {
    await openEditor(ev, waitFor);
    const slot = await addSeat(ev);
    await click(ev, `${ED} [data-se-model="${slot}"]`);
    await waitFor(`!document.querySelector("#pop").hidden&&document.querySelector("#mq")`, "the model menu opens for the new seat");
    const menu = await ev(`(()=>{const rows=[...document.querySelectorAll("#pop [data-model]")].filter((el)=>el.dataset.cli==="claude");return {text:document.querySelector("#pop").innerText,names:rows.map((el)=>el.querySelector(".nm > span").innerText.trim()),ids:rows.map((el)=>el.dataset.model)}})()`);
    console.log(`W11 claude rows ${JSON.stringify(menu.names)} for ids ${JSON.stringify(menu.ids)}`);
    assert.ok(menu.ids.includes("claude-opus-5") && menu.ids.includes("claude-opus-5[1m]"), "control: the menu offers both Opus ids that used to read alike");
    assert.doesNotMatch(menu.text, /claude-|\[1m\]/, "no raw id in the visible text of the menu");
    assert.equal(new Set(menu.names).size, menu.names.length, `every name is different: ${menu.names.join(" | ")}`);
    assert.ok(menu.names.every((name: string) => name.length > 1), "and none is blank");
  });
});

// Final-review guards run the real editor even when Chrome is unavailable.
function finalEditor() {
  const listeners: any[] = [], sent: any[] = [];
  class Socket { addEventListener(type: string, fn: any) { if (type === "message") listeners.push(fn); } }
  const window: any = { WebSocket: Socket };
  runInNewContext(readFileSync("public/setup-editor.js", "utf8"), { window, document: { addEventListener() {}, getElementById() { return null; }, body: {} }, setTimeout() {}, requestAnimationFrame(fn: any) { fn(); }, CSS: { escape: (s: string) => s }, crypto: { randomUUID: () => "save-request" } });
  const se = window.CC_SETUP_EDITOR;
  assert.ok(se, "control: the real editor loaded");
  se.draw = se.foot = () => ""; se.wire = () => {};
  const root = { isConnected: true, classList: { add() {} }, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, closest: () => null };
  const tab: any = { id: "final", lookPause: false, setupName: "Same", processState: { crewGenerationId: "before" }, crew: [
    { slot: "leader", name: "Lead", role: "Leader", cli: "codex", model: "gpt-6.1-sol", effort: "high", canWrite: true, isLeader: true },
    { slot: "planner", name: "Plan", role: "Planner", cli: "acp:kimi", model: "default", effort: "default", canWrite: true, orchestrates: true, isLeader: false },
  ] };
  const state: any = { savedSetups: [{ id: "same", name: "Same" }], clis: [{ id: "acp:kimi", crewTools: true }] };
  const ctx = { tab, state, send: (message: any) => { sent.push(structuredClone(message)); return true; } };
  const draw = () => se.render(root, ctx);
  draw(); const socket = new window.WebSocket(); void socket;
  return { se, tab, state, sent, draw, answer: (message: any) => listeners.forEach((fn) => fn({ data: JSON.stringify(message) })) };
}
test("FF2: a saved ACP orchestrator switched read-only saves orchestrates false and validates", () => {
  const h = finalEditor();
  h.se.setSeat("planner", { canWrite: false }); h.se.save();
  assert.equal(h.sent.length, 1, "control: Save sent one command");
  assert.equal(h.sent[0].crew.find((s: any) => s.slot === "planner").orchestrates, false, "FF2: saved ACP planner stops orchestrating");
  assert.doesNotThrow(() => validateSetup(h.sent[0]));
});
test("FF3 editor: same-name switch waits for a new generation recorded at send time", () => {
  const h = finalEditor(), s = h.se.ed(h.tab.id);
  h.se.sendAs({ type: "useSetup", tabId: h.tab.id }, { name: "Same", note: "Switched to Same" });
  h.draw();
  assert.ok(s.waiting, "FF3 editor: same name and unchanged generation do not settle");
  h.tab.processState.crewGenerationId = "after"; h.draw();
  assert.equal(s.waiting, null); assert.equal(s.note.text, "Switched to Same");
});
test("FF3 save: an existing name and stale state never acknowledge an overwrite", () => {
  const h = finalEditor(), s = h.se.ed(h.tab.id);
  h.se.sendAs({ type: "saveSetup", tabId: h.tab.id, name: "Same" }, { name: "Same", note: "Saved as Same" });
  h.draw(); assert.ok(s.waiting, "FF3 save: an existing name is not proof of saving");
  assert.equal(h.sent[0].requestId, "save-request", "FF3 save: Save sends the request id it waits for");
  h.answer({ type: "setupSaved", tabId: h.tab.id, requestId: "wrong" }); assert.ok(s.waiting);
  h.answer({ type: "setupSaved", tabId: h.tab.id, requestId: h.sent[0].requestId });
  assert.equal(s.waiting, null); assert.equal(s.note.text, "Saved as Same");
});
