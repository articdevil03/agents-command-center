import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, ED, J, withPage, skipped, bareSeat, sentOf, click, openEditor, openSeat, addSeat, deliverTab, delay, type Page } from "./pack18-editor-harness.ts";

// Pack 18: the crew editor's layout in the real page (harness: test/pack18-editor-harness.ts). L1 nothing in Settings scrolls sideways, at
// three window sizes, with a 16-seat crew of long names, a card and its role list open and the Save bar showing; L2 Start blank is the first
// choice of Switch to, and a blank crew says the leader does everything; L3 a tab that started blank shows its main view and its editor.

const SIZES = [
  { name: "1440x900", width: 1440, height: 900, scale: 1 },
  { name: "900x900", width: 900, height: 900, scale: 1 },
  { name: "200% zoom", width: 720, height: 450, scale: 2 }, // 1440x900 device pixels at twice the size, the way a 200% zoom draws
];
const resize = (page: Page["page"], size: (typeof SIZES)[number]) => page("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: false });

// What scrolls sideways in Settings: the scroll container that holds the Settings sections (found from the editor upwards, never by a guessed
// name), the page itself, and any element in the Settings dialog that scrolls on its own (a text field scrolls its own text and is not counted).
function sideways(ev: Page["ev"]): Promise<any> {
  return ev(`(()=>{const editor=document.querySelector(${J(ED)});let box=null;
    for(let node=editor?.parentElement;node&&!box;node=node.parentElement)if(/(auto|scroll)/.test(getComputedStyle(node).overflowY))box=node;
    const size=(el)=>({scrollWidth:el.scrollWidth,clientWidth:el.clientWidth});
    const scrollers=[...document.querySelectorAll("#setModal *")].filter((el)=>!el.matches("input,textarea,select")&&/(auto|scroll)/.test(getComputedStyle(el).overflowX)&&el.scrollWidth>el.clientWidth+1)
      .map((el)=>(el.id?"#"+el.id:el.tagName.toLowerCase())+(el.classList.length?"."+[...el.classList].join("."):"")+" "+el.scrollWidth+">"+el.clientWidth);
    return {box:box?{id:box.id,sections:box.querySelectorAll(".settings-section").length,holdsEditor:box.contains(editor),...size(box)}:null,html:size(document.documentElement),body:size(document.body),dock:size(document.querySelector("#setFoot")),scrollers}})()`);
}
async function noSideways(ev: Page["ev"], label: string) {
  const seen = await sideways(ev);
  console.log(`L1 ${label}: settings body #${seen.box?.id} ${seen.box?.scrollWidth}/${seen.box?.clientWidth} (${seen.box?.sections} sections), html ${seen.html.scrollWidth}/${seen.html.clientWidth}, body ${seen.body.scrollWidth}/${seen.body.clientWidth}, save bar ${seen.dock.scrollWidth}/${seen.dock.clientWidth}, own sideways scrollers: ${seen.scrollers.join(", ") || "none"}`);
  assert.ok(seen.box?.id === "setBody" && seen.box.holdsEditor && seen.box.sections >= 8, `${label}: the scroll container that holds every Settings section was found (#setBody)`);
  for (const [name, el] of [["the Settings body", seen.box], ["the page", seen.html], ["the body", seen.body], ["the Save bar", seen.dock]] as const) assert.ok(el.scrollWidth <= el.clientWidth, `${label}: ${name} does not scroll sideways (${el.scrollWidth} > ${el.clientWidth})`);
  assert.deepEqual(seen.scrollers, [], `${label}: no element in Settings scrolls sideways`);
}

test("L1: nothing in Settings scrolls sideways at 1440x900, 900x900 and 200% zoom, also with a 16-seat crew of long names, a seat's card and its role list open, a long custom role and the Save bar showing", { timeout: editorTestMs(138_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, ours }) => {
    await openEditor(ev, waitFor);
    for (const size of SIZES) { await resize(page, size); await delay(150); await noSideways(ev, `Our process ${size.name}`); }
    // The longest names the server takes: 8 more seats (16 in all) with names near the 80-character limit and a long custom role.
    const extra = Array.from({ length: 16 - ours.crew.length }, (_, i) => ({ ...bareSeat(ours.crew.find((seat: any) => seat.slot === "coder")), slot: `wide${i}`, name: `Seat ${i} with a long name that fills a row edge to edge without any break at all`, role: "A custom role that is just as long as the name it sits under", seatKey: `${ours.id}.wide${i}`, status: "idle", runs: [] }));
    await deliverTab(ev, ours.id, `tab.crew=[...tab.crew,...${J(extra)}]`);
    await waitFor(`document.querySelectorAll(${J(`${ED} [data-se-row]`)}).length===16`, "the 16-seat crew is drawn");
    assert.equal(await ev(`document.querySelector(${J(`${ED} [data-se-add]`)}).disabled`), true, "control: a full crew cannot take another seat");
    await openSeat(ev, "wide0");
    await click(ev, `${ED} [data-se-role="wide0"]`);
    await click(ev, `${ED} [data-se-look-toggle]`); // the Save bar shows
    assert.equal(await ev(`Boolean(document.querySelector(${J(`${ED} [data-se-rolemenu="wide0"]`)})&&document.querySelector(${J(`${ED} [data-se-rolename="wide0"]`)})&&document.querySelector("#setFoot [data-se-save]"))`), true, "control: the card, its role list, the custom role and the Save bar are open");
    for (const size of [...SIZES].reverse()) { await resize(page, size); await delay(150); await noSideways(ev, `16 seats, a role list open, ${size.name}`); }
  });
});

test("L2: Start blank is the first choice of Switch to, with its own line; switching sends useSetup with blank; then the crew is the leader alone, who does everything, and the look switch says why it is off", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, ours, blank, seed }) => {
    const template = seed.templates.find((item: any) => item.id === "blank");
    assert.deepEqual([template?.name, template?.crew.length, template?.steps.length], ["Start blank", 1, 0], "control: the server offers Start blank, the leader and no steps");
    await openEditor(ev, waitFor);
    await click(ev, `${ED} [data-se-menu="switch"]`);
    const options: { kind: string; id: string; text: string }[] = await ev(`[...document.querySelectorAll(${J(`${ED} #se-switch [data-se-use], ${ED} #se-switch .se-mg`)})].map((el)=>({kind:el.dataset.seUse??"heading",id:el.dataset.id??"",text:el.innerText.replace(/\\s+/g," ").trim()}))`);
    console.log(`L2 Switch to, top down: ${options.map((item) => `${item.id || item.text}`).join(" | ")}`);
    assert.deepEqual(options[0], { kind: "template", id: "blank", text: `Start blank ${template.desc}` }, "Start blank is the first choice, with its own one line");
    assert.deepEqual(options.slice(1, 2).map((item) => item.text), ["Templates"], "and it sits above the other templates");
    assert.equal(options.filter((item) => item.id === "blank").length, 1, "it is listed once");
    await click(ev, `${ED} [data-se-use="template"][data-id="blank"]`);
    assert.match(await ev(`document.querySelector(${J(`${ED} #se-switch .se-ask`)}).textContent`), /^Start Development blank\? Every seat but the leader is removed\./, "the same confirm step as any switch, in its own words");
    await click(ev, `${ED} [data-se-confirm]`);
    assert.deepEqual(await sentOf(ev, "useSetup"), [{ type: "useSetup", tabId: ours.id, templateId: "blank" }]);
    // The server switched it: the tab now holds what a blank tab holds (the server's own blank tab, its kind left as it was).
    await deliverTab(ev, ours.id, `const generation=tab.processState.crewGenerationId;const b=window.__ccSeed.projects[0].tabs.find((x)=>x.id===${J(blank.id)});for(const key of ["crew","steps","lookPause","setupName","derived","processState"])tab[key]=structuredClone(b[key]);tab.crew=tab.crew.map((seat)=>({...seat,seatKey:${J(ours.id)}+"."+seat.slot}));tab.processState.crewGenerationId=generation+1`);
    await waitFor(`document.querySelectorAll(${J(`${ED} [data-se-row]`)}).length===1`, "the crew is the leader alone");
    assert.equal(await ev(`document.querySelector(${J(`${ED} [data-se-flow-none]`)}).textContent`), `${blank.crew[0].name} does everything. Add seats to share the work.`);
    assert.deepEqual(await ev(`(()=>{const sw=document.querySelector(${J(`${ED} [data-se-look-toggle]`)});return {off:sw.disabled,why:document.querySelector("#se-look-h").textContent}})()`), { off: true, why: "Add a Coder, Reviewer, Fixer, Planner or Final reviewer to give this tab steps." });
    assert.equal(await ev(`document.querySelector(${J(`${ED} [data-se-note]`)})?.textContent`), "Switched to Start blank");
    // A Coder gives the tab steps: the look switch comes on as something to pick.
    const slot = await addSeat(ev);
    await click(ev, `${ED} [data-se-role="${slot}"]`);
    await click(ev, `${ED} [data-se-rolemenu="${slot}"] [data-se-pick-role="Coder"]`);
    assert.equal(await ev(`document.querySelector(${J(`${ED} [data-se-look-toggle]`)}).disabled`), false);
  });
});

test("L3: a tab that started blank shows its main view (no step bar, no step count) and its editor (the leader alone, no step), with no page error", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, blank }) => {
    assert.deepEqual([blank.kind, blank.crew.length, blank.steps.length, blank.derived?.stepBar?.length], ["design", 1, 0, 0], "control: the server's blank tab kept its Design kind and has no step");
    await click(ev, `#tabs [role=tab][data-tab-id="${blank.id}"]`);
    await waitFor(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId===${J(blank.id)}`, "the blank tab is shown");
    const main = await ev(`({steps:document.querySelectorAll("#pipe .step").length,status:document.querySelector("#statusBtn").innerText.replace(/\\s+/g," ").trim(),actions:document.querySelector("#stepActs").innerHTML,seats:document.querySelectorAll("#crew .seat").length})`);
    console.log(`L3 main view: ${JSON.stringify(main)}`);
    assert.deepEqual({ steps: main.steps, actions: main.actions, seats: main.seats }, { steps: 0, actions: "", seats: 1 }, "no step in the bar, no step action, one seat");
    assert.doesNotMatch(main.status, /Step \d/, "the status line counts no step");
    await openEditor(ev, waitFor);
    assert.equal(await ev(`document.querySelectorAll(${J(`${ED} [data-se-row]`)}).length`), 1);
    assert.match(await ev(`document.querySelector(${J(`${ED} [data-se-who]`)}).innerText`), /does everything/);
  });
});
