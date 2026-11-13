import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, delay, type Page } from "./pack18-editor-harness.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";

// Fixed-crew layout in the real page (harness: test/pack18-editor-harness.ts, fixture "fixed"). L1 nothing in Settings scrolls sideways or
// is cut off, at three window sizes, with all 18 positions on long model labels and an open Instructions panel; L3 a fresh, unassigned fixed
// tab shows its task guidance and the page's ordinary main view, no old editor and no step controls.
// Pack 26 Block 5 slice 2c: the arbitrary 16-seat crew, the custom role menu, the Save bar and the Start blank ordering (old L2) are retired.

const SLOTS = FIXED_CREW.map((seat: any) => seat.slot as string).sort(); // the page draws them grouped, so compared sorted
const LONG_MODEL = "vendor/a-model-name-that-fills-a-chip-edge-to-edge-without-any-break-at-all-0123456789";
const SIZES = [
  { name: "1440x900", width: 1440, height: 900, scale: 1 },
  { name: "900x900", width: 900, height: 900, scale: 1 },
  { name: "200% zoom", width: 720, height: 450, scale: 2 }, // 1440x900 device pixels at twice the size, the way a 200% zoom draws
];
const resize = (page: Page["page"], size: (typeof SIZES)[number]) => page("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: false });

// What scrolls sideways or is cut off in Settings: the scroll container that holds the fixed crew section (found from the section upwards,
// never by a guessed name), the page itself, any element in the Settings dialog that scrolls on its own (a text field scrolls its own text and
// is not counted), and every shown control of the 18 rows against the edges of that container.
function measure(ev: Page["ev"]): Promise<any> {
  return ev(`(()=>{const section=document.querySelector("#setModal [data-fc-tab]");let box=null;
    for(let node=section?.parentElement;node&&!box;node=node.parentElement)if(/(auto|scroll)/.test(getComputedStyle(node).overflowY))box=node;
    const size=(el)=>({scrollWidth:el.scrollWidth,clientWidth:el.clientWidth});
    const scrollers=[...document.querySelectorAll("#setModal *")].filter((el)=>!el.matches("input,textarea,select")&&/(auto|scroll)/.test(getComputedStyle(el).overflowX)&&el.scrollWidth>el.clientWidth+1)
      .map((el)=>(el.id?"#"+el.id:el.tagName.toLowerCase())+(el.classList.length?"."+[...el.classList].join("."):"")+" "+el.scrollWidth+">"+el.clientWidth);
    const rows=[...document.querySelectorAll("#setModal [data-fc-row]")], edge=box?.getBoundingClientRect();
    const controls=[...document.querySelectorAll("#setModal [data-fc-row] button,#setModal [data-fc-row] textarea")].filter((el)=>el.getClientRects().length);
    const clipped=edge?controls.filter((el)=>{const r=el.getBoundingClientRect();return r.left<edge.left-1||r.right>edge.right+1}).map((el)=>el.dataset.focusKey||el.className):[];
    return {box:box?{id:box.id,holdsSection:box.contains(section),...size(box)}:null,html:size(document.documentElement),body:size(document.body),
      slots:rows.map((r)=>r.dataset.fcRow),chips:[...document.querySelectorAll("#setModal .fc-model-text")].map((c)=>c.textContent),controls:controls.length,clipped,scrollers}})()`);
}
async function noSideways(ev: Page["ev"], label: string) {
  const seen = await measure(ev);
  console.log(`L1 ${label}: settings body #${seen.box?.id} ${seen.box?.scrollWidth}/${seen.box?.clientWidth}, html ${seen.html.scrollWidth}/${seen.html.clientWidth}, body ${seen.body.scrollWidth}/${seen.body.clientWidth}, rows ${seen.slots.length}, controls ${seen.controls}, clipped: ${seen.clipped.join(", ") || "none"}, own sideways scrollers: ${seen.scrollers.join(", ") || "none"}`);
  assert.ok(seen.box?.id === "setBody" && seen.box.holdsSection, `${label}: the scroll container that holds the fixed crew section was found (#setBody)`);
  assert.deepEqual([...seen.slots].sort(), SLOTS, `${label}: all 18 positions were found, each once`);
  assert.equal(seen.chips.length, 18, `${label}: all 18 model chips were found`);
  assert.ok(seen.chips.every((text: string) => /model name that fills/i.test(text)), `${label}: every chip draws the long model label (${seen.chips[0]})`);
  assert.ok(seen.controls >= 18 * 2, `${label}: the shown controls of the rows were found (${seen.controls})`);
  for (const [name, el] of [["the Settings body", seen.box], ["the page", seen.html], ["the body", seen.body]] as const) assert.ok(el.scrollWidth <= el.clientWidth, `${label}: ${name} does not scroll sideways (${el.scrollWidth} > ${el.clientWidth})`);
  assert.deepEqual(seen.clipped, [], `${label}: no shown control is cut off at the side`);
  assert.deepEqual(seen.scrollers, [], `${label}: no element in Settings scrolls sideways`);
}

test("L1: fixed Settings does not scroll sideways or cut off a control at 1440x900, 900x900 and 200% zoom, with all 18 positions on long model labels and an Instructions panel open", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, discovered }) => {
    const long = J({ cli: "opencode", model: LONG_MODEL, effort: "max" });
    await deliverState(ev, discovered, `for(const tab of state.projects[0].tabs)if(tab.fixedCrew)for(const pref of Object.values(tab.fixedCrew.preferences)){pref.assignment=${long};pref.source="user"}`);
    await click(ev, "#setBtn");
    await waitFor(`document.querySelectorAll("#setModal [data-fc-row]").length===18`, "the 18 fixed positions in Settings");
    await click(ev, `#setModal [data-fc-row="leader"] [data-fc-toggle]`);
    await waitFor(`!document.querySelector('#setModal [data-fc-row="leader"] .fc-panel').hidden`, "the leader's Instructions are open");
    const ask = await ev(`window.__sent.filter((m)=>m.type==="getCrewRolePrompt").at(-1)`);
    assert.ok(ask, "control: the page asked for the leader's built-in instructions");
    await deliver(ev, { type: "crewRolePrompt", requestId: ask.requestId, slot: "leader", defaultsVersion: discovered.crewDefaultsVersion, core: `You are the Leader. ${"unbrokenwordthatistoolongtofitaline".repeat(6)}`, guidance: "Keep the owner informed." });
    for (const size of SIZES) { await resize(page, size); await delay(150); await noSideways(ev, `fixed ${size.name}`); }
    for (const size of [...SIZES].reverse()) { await resize(page, size); await delay(150); await noSideways(ev, `fixed ${size.name} again`); }
  });
});

test("L3: a fresh, unassigned fixed tab shows its task guidance and the page's ordinary main view, no old editor or step controls, and every position once in Settings", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, fixed }) => {
    assert.deepEqual([fixed.setupName, Object.values(fixed.fixedCrew.preferences).every((pref: any) => pref.assignment === null)], ["Fixed crew", true], "control: the server's tab is a fresh fixed crew with no model assigned");
    const main = await ev(`(()=>{const shown=(s)=>Boolean(document.querySelector(s)?.getClientRects().length);return {fixed:shown("#fixedView #fcWorkSettings"),view:shown("#view"),sline:shown("#sline"),steps:shown("#stepsWrap"),old:document.querySelectorAll("[data-setup-editor],[data-process-action],[data-run-seat],[data-stop-seat]").length,text:document.querySelector("#fixedView").innerText}})()`);
    console.log(`L3 main view: ${JSON.stringify({ ...main, text: main.text.slice(0, 160) })}`);
    assert.deepEqual({ ...main, text: "" }, { fixed: true, view: true, sline: true, steps: false, old: 0, text: "" }, "the fixed task panel and the ordinary main view show, with no old editor and no visible step controls");
    assert.match(main.text, /Leader has no model\. Choose one in Settings before continuing\./, "the task guidance says what is needed");
    await click(ev, "#setBtn");
    await waitFor(`document.querySelectorAll("#setModal [data-fc-row]").length>0`, "the fixed crew rows in Settings");
    const settings = await ev(`({slots:[...document.querySelectorAll("#setModal [data-fc-row]")].map((r)=>r.dataset.fcRow),editors:document.querySelectorAll("#setModal [data-fc-tab]").length,old:document.querySelectorAll("#setModal [data-setup-editor],#setModal [data-se-row]").length})`);
    assert.deepEqual([...settings.slots].sort(), SLOTS, "all 18 positions exist once");
    assert.equal(new Set(settings.slots).size, 18);
    assert.deepEqual([settings.editors, settings.old], [1, 0], "one fixed editor and no old editor");
  });
});
