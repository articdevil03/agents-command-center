import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, setValue, type Page } from "./pack18-editor-harness.ts";

// Pack 26 Block 5 slice 2d2: what survives the deleted crew editor, on the real page. FCPICK load order proves the page scripts load in an order where the
// model picker and every fixed crew file exist before the page's own start-up script runs, and that Settings and the creation dialog boot from it.
// FCPICK saved advisors proves a fixed position's saved advisor is shown for its own position only, in Settings and in the Usage panel.
// Slice 2f2 adds FCPICK effort (a model without an effort setting shows none; one with it shows its tick and sends the choice) and FCPICK busy (a busy
// position cannot be changed through the chip, the menu, a kept listener or a confirmation, and the menu follows the lock, search and focus).

const FIXED_FILES = ["/logos.js", "/model-picker.js", "/fixed-crew/state.js", "/fixed-crew/view.js", "/fixed-crew/task-state.js", "/fixed-crew/task-archive-view.js", "/fixed-crew/task-view.js", "/fixed-crew/task-events.js", "/fixed-crew/events.js", "/fixed-crew/project-dialog.js"];
const APP_FILES = ["01-markdown-state", "02-selectors-format", "03-state-sync", "04-messages", "05-layers-approvals", "06-crew-rail", "06a-tab-status", "07-chat", "08-seat-view-details", "09-needs-you-stopping", "10-dialogs-seat-card", "11-settings-render", "12-events-queue-init"].map((name) => `/app/${name}.js`);
const START_UP = "/app/12-events-queue-init.js";

test("FCPICK load order: the model picker and every fixed crew file load before the page's start-up script, no old editor tag remains, and Settings and a creation dialog boot with 18 unique positions", { timeout: editorTestMs(60_000) }, async (t) => {
  // The source order is asserted BEFORE any browser boots, so a wrong order fails here with an assertion and not later as a missing name in a half-started page.
  const html = readFileSync(join(process.cwd(), "public", "index.html"), "utf8").replaceAll("\r\n", "\n");
  const at = (src: string) => {
    const tag = `<script defer src="${src}"></script>`;
    assert.equal(html.split(tag).length - 1, 1, `the script ${src} is loaded exactly once`);
    return html.indexOf(tag);
  };
  const positions = [...FIXED_FILES, ...APP_FILES].map((src) => [src, at(src)] as const);
  console.log(`FCPICK script positions: ${positions.map(([src, index]) => `${src}@${index}`).join(" ")}`);
  assert.equal(positions.length, FIXED_FILES.length + APP_FILES.length, "control: every expected script was FOUND");
  for (const src of FIXED_FILES) assert.ok(at(src) < at(START_UP), `${src} loads before the page's start-up script`);
  assert.deepEqual(positions.map(([src]) => src), [...positions].sort((a, b) => a[1] - b[1]).map(([src]) => src), "the scripts load in the order the page needs: logos, the model picker, the fixed crew files, then the page's own files in name order");
  assert.doesNotMatch(html, /setup-editor|setFoot|setLive|data-setup-editor|se-dock|se-live/, "no old editor script, style, mount or class remains in the page");
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor }) => {
    await click(ev, "#setBtn");
    await waitFor(`Boolean(document.querySelector("#setModal:not([hidden]) [data-fc-tab]"))`, "the fixed crew section in Settings");
    const settings: string[] = await ev(`[...document.querySelectorAll("#setModal [data-fc-row]")].map((r)=>r.dataset.fcRow)`);
    assert.equal(settings.length, 18, "Settings lists 18 positions");
    assert.equal(new Set(settings).size, 18, "each exactly once");
    await click(ev, "#setModal [data-close]");
    await click(ev, "#addProj");
    await waitFor(`!document.querySelector("#projModal").hidden&&document.querySelectorAll("#projModal [data-fc-new-row]").length>0`, "the New project dialog with its fixed positions");
    const creation: string[] = await ev(`[...document.querySelectorAll("#projModal [data-fc-new-row]")].map((r)=>r.dataset.fcNewRow)`);
    assert.equal(creation.length, 18, "the creation dialog lists 18 positions");
    assert.equal(new Set(creation).size, 18, "each exactly once");
    assert.deepEqual(creation, settings, "the creation dialog and Settings list the same positions in the same order");
  }, { fixture: "fixed" });
});

const ROW = (slot: string) => `#setModal [data-fc-row="${slot}"]`;
const sourceOf = (ev: Page["ev"], slot: string): Promise<string | null> => ev(`document.querySelector(${J(`${ROW(slot)} .fc-source`)})?.textContent??null`);

test("FCPICK saved advisors: each fixed position shows its own saved advisor in Settings and in Usage, and a position without one shows none", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed }) => {
    const claude = discovered.clis.find((cli: any) => cli.id === "claude"), codex = discovered.clis.find((cli: any) => cli.id === "codex");
    assert.ok(claude?.advisor === true && codex?.advisor === false, "control: the server says Claude can take an advisor and Codex cannot");
    const effort = (cap: any) => (cap.efforts.includes("medium") ? "medium" : cap.efforts[0]);
    const leader = { cli: "claude", model: claude.models[0], effort: effort(claude), advisor: "claude-fable-5-1" };
    const planner = { cli: "claude", model: claude.models[0], effort: effort(claude), advisor: "claude-fable-5-2" };
    const coder = { cli: "claude", model: claude.models[0], effort: effort(claude) };
    const reviewer = { cli: "codex", model: codex.models[0], effort: effort(codex) };
    const saved: Record<string, any> = { leader, planner, coder, reviewer1: reviewer };
    // The page's runtime seats follow the saved positions exactly as the server's own fixedMembers builds them: one seat per assigned position, named by its position.
    const seats = `state.projects[0].tabs[0].crew=Object.entries(${J(saved)}).map(([slot,assignment])=>{const def=state.fixedCrewDefinitions.find((d)=>d.slot===slot);return {slot,name:def.label,role:def.label,canWrite:false,isLeader:slot==="leader",seatKey:${J(`${fixed.id}.`)}+slot,...assignment}})`;
    const prefs = `for(const pref of Object.values(state.projects[0].tabs[0].fixedCrew.preferences)){pref.assignment=null;pref.source="auto"};` + Object.entries(saved).map(([slot, assignment]) => `state.projects[0].tabs[0].fixedCrew.preferences[${J(slot)}]={source:"user",assignment:${J(assignment)}}`).join(";");
    await deliverState(ev, discovered, `${prefs};${seats}`);
    const labels: Record<string, string> = Object.fromEntries(discovered.fixedCrewDefinitions.map((def: any) => [def.slot, def.label]));
    const from: number = await ev("window.__sent.length");
    await click(ev, "#setBtn");
    await waitFor(`Boolean(document.querySelector("#setModal:not([hidden]) [data-fc-tab]"))`, "the fixed crew section in Settings");
    const shown = Object.fromEntries(await Promise.all(["leader", "planner", "coder", "reviewer1", "helper"].map(async (slot) => [slot, await sourceOf(ev, slot)])));
    console.log(`FCPICK Settings sources: ${JSON.stringify(shown)}`);
    assert.match(String(shown.leader), /^Your choice · .+ · advisor Fable 5\.1$/, "the leader shows its own saved advisor by friendly name");
    assert.match(String(shown.planner), /^Your choice · .+ · advisor Fable 5\.2$/, "the planner shows a different saved advisor: each position keeps its own");
    assert.match(String(shown.coder), /^Your choice · [^·]+$/, "a Claude position with no saved advisor shows none (Off is the absence of one)");
    assert.match(String(shown.reviewer1), /^Your choice · [^·]+$/, "a Codex position shows no advisor");
    assert.equal(shown.helper, "No model assigned", "an unassigned position shows no advisor either");
    assert.doesNotMatch(Object.values(shown).join("|"), /claude-fable|\[1m\]/, "no raw advisor id is shown");
    assert.equal(await ev(`document.querySelectorAll("#setModal [data-settings-advisor],#setModal [data-seat-advisor],#setModal [data-advisor]").length`), 0, "no retired seat-editor or popup advisor controls appear in Settings");
    assert.deepEqual(await ev(`[...document.querySelectorAll('#setModal [data-fc-advisor]:not([hidden])')].map(el=>[el.dataset.fcAdvisor,el.value])`), [["leader", saved.leader.advisor], ["planner", saved.planner.advisor], ["coder", ""]], "Settings row controls show each capable position's own advisor or Off");
    await click(ev, '#setModal [data-fc-model="leader"]');
    assert.equal(await ev(`Boolean(document.querySelector('#pop #mq'))`), true, "model popup FOUND");
    assert.equal(await ev(`document.querySelectorAll('#pop [data-advisor],#pop [data-fc-advisor],#pop select[aria-label="Advisor"]').length`), 0, "the model popup has no advisor control");
    await ev(`setLayer(document.querySelector('#pop'),false);true`);
    await click(ev, "#setModal [data-close]");
    await click(ev, "#sideBtn");
    await waitFor(`!document.querySelector("#side").hidden`, "the Details panel");
    await click(ev, "#sp-usage");
    await waitFor(`!document.querySelector("#usagePanel").hidden`, "the Usage panel");
    const advisors: string[] = await ev(`[...document.querySelectorAll("#usage .useRow")].filter((r)=>r.querySelector(".advglyph")).map((r)=>r.querySelector("span[title]").title)`);
    console.log(`FCPICK Usage advisor rows: ${JSON.stringify(advisors)}`);
    assert.deepEqual(advisors, [`Advisor for ${labels.leader} · Fable 5.1`, `Advisor for ${labels.planner} · Fable 5.2`], "Usage lists an advisor row for each position that has one, attributed to that position, and for no other");
    const seatRows: string[] = await ev(`[...document.querySelectorAll("#usage .useRow")].filter((r)=>!r.querySelector(".advglyph")).map((r)=>r.querySelector("span[title]").title)`);
    assert.ok(["leader", "planner", "coder", "reviewer1"].every((slot) => seatRows.some((row) => row.startsWith(`${labels[slot]} · `))), `control: the Usage panel lists the four assigned positions (${JSON.stringify(seatRows)})`);
    const sent: any[] = await ev(`window.__sent.slice(${from})`);
    assert.deepEqual(sent.filter((message) => ["updateSeat", "setAdvisor", "setCrewAssignment"].includes(message.type)), [], "showing the advisors sends no seat or assignment write");
  }, { fixture: "fixed" });
});

// A redraw that only Settings itself performs (the server's settingsRefreshed answer): nothing else puts focus back, so restoreSettingsFocus in
// renderSettings is what keeps the field the user is typing in, its caret and the deep scroll. A state broadcast is no proof: renderAll restores focus by itself.
test("FCPICK settings redraw: a Settings-only redraw keeps the focused field after the crew, its caret and the exact deep scroll", { timeout: editorTestMs(60_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, discovered }) => {
    await deliverState(ev, discovered);
    await click(ev, "#setBtn");
    await waitFor(`Boolean(document.querySelector("#setModal:not([hidden]) [data-fc-tab]"))`, "the fixed crew section in Settings");
    const placed = await ev(`(async()=>{const input=document.querySelector("#defaultProjectFolder");if(!input)return null;input.scrollIntoView({block:"center"});await new Promise((ok)=>requestAnimationFrame(()=>requestAnimationFrame(ok)));input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length);return document.querySelector("#setBody").scrollTop})()`);
    assert.ok(placed !== null && placed > 500, `control: the Default folder field was FOUND, focused and Settings is scrolled deep (${placed})`);
    await page("Input.insertText", { text: "C:/redraw" });
    const probe = () => ev(`(()=>{const a=document.activeElement;return {id:a?.id??null,value:a?.value??null,caret:a&&"selectionStart" in a?[a.selectionStart,a.selectionEnd]:null,scroll:document.querySelector("#setBody").scrollTop}})()`);
    const before = await probe();
    assert.deepEqual([before.id, before.value, before.scroll], ["defaultProjectFolder", "C:/redraw", placed], "control: the text is typed into the focused field");
    for (let round = 1; round <= 3; round++) {
      await ev(`(()=>{const body=document.querySelector("#setBody");const first=body.querySelector("#defaultProjectFolder");__ccDeliver({type:"settingsRefreshed"});window.__redrew=body.querySelector("#defaultProjectFolder")!==first;return true})()`);
      assert.equal(await ev("window.__redrew"), true, `control: round ${round} rebuilt the field (a real redraw, not a no-op)`);
      assert.deepEqual(await probe(), before, `round ${round}: the same field keeps focus, its text, its caret and the exact scroll`);
    }
  }, { fixture: "fixed" });
});

// ---- slice 2f2: effort and busy, on the real Settings picker ----
const CREW_WRITES = ["setCrewAssignment", "clearCrewAssignment", "autoAssignCrew", "updateSeat", "setAdvisor", "addSeat", "removeSeat"];
const crewOf = "state.projects[0].tabs[0].fixedCrew";
const sentLength = (ev: Page["ev"]): Promise<number> => ev("window.__sent.length");
const writesSince = async (ev: Page["ev"], from: number): Promise<any[]> => (await ev(`window.__sent.slice(${from})`)).filter((message: any) => CREW_WRITES.includes(message.type));
const bare = (messages: any[]) => messages.map(({ requestId, ...rest }) => rest);
const prefsJs = (saved: Record<string, any>) => `for(const pref of Object.values(${crewOf}.preferences)){pref.assignment=null;pref.source="auto"};${Object.entries(saved).map(([slot, a]) => `${crewOf}.preferences[${J(slot)}]={source:"user",assignment:${J(a)}}`).join(";")}`;
const chip = (slot: string) => `${ROW(slot)} [data-fc-model]`;
const MENU = `(()=>{const p=document.querySelector("#pop");return {open:!p.hidden&&Boolean(p.querySelector("#mq")),efforts:[...p.querySelectorAll("[data-effort]")].map((b)=>[b.dataset.effort,b.getAttribute("aria-checked")]),groups:p.querySelectorAll(".effort").length,noEffortHint:p.innerText.includes("has no effort setting"),models:p.querySelectorAll("[data-model]").length,ticked:[...p.querySelectorAll("[data-model][aria-pressed=true]")].map((b)=>b.dataset.model)}})()`;
const openMenu = async (ev: Page["ev"], waitFor: Page["waitFor"], slot: string) => {
  await click(ev, chip(slot));
  await waitFor(`!document.querySelector("#pop").hidden&&Boolean(document.querySelector("#pop #mq"))`, `the model menu of ${slot}`);
};
const openSettings = async (ev: Page["ev"], waitFor: Page["waitFor"]) => {
  await click(ev, "#setBtn");
  await waitFor(`Boolean(document.querySelector("#setModal:not([hidden]) [data-fc-tab]"))`, "the fixed crew section in Settings");
};

test("FCPICK effort: a Claude model without an effort setting shows no effort on its chip and none in the picker, a model with one shows its tick and sends the chosen effort", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed }) => {
    const claude = discovered.clis.find((cli: any) => cli.id === "claude");
    assert.ok(claude && claude.efforts.length >= 2, `control: Claude lists at least two efforts (${JSON.stringify(claude?.efforts)})`);
    const [low, high] = [claude.efforts[0], claude.efforts.at(-1)], none = "claude-noeffort-test", some = "claude-effort-test";
    const models = `state.claudeModels=[{value:${J(none)},displayName:"No Effort Test",supportsEffort:false},{value:${J(some)},displayName:"Effort Test",supportsEffort:true},...(state.claudeModels||[]).filter((m)=>typeof m==="object"&&![${J(none)},${J(some)}].includes(m.value))]`;
    await deliverState(ev, discovered, `${prefsJs({ coder: { cli: "claude", model: none, effort: high }, planner: { cli: "claude", model: some, effort: low } })};${models}`);
    await openSettings(ev, waitFor);
    // Everything is FOUND before anything is judged.
    const chips: Record<string, string | null> = {};
    for (const slot of ["coder", "planner"]) chips[slot] = await ev(`document.querySelector(${J(`${ROW(slot)} .fc-model`)})?.textContent??null`);
    console.log(`FCPICK effort chips: ${JSON.stringify(chips)}`);
    assert.ok(chips.coder && chips.planner, "control: both chips were FOUND");
    assert.doesNotMatch(String(chips.coder), new RegExp(high, "i"), "the model without an effort setting shows no effort, though its saved assignment has one");
    assert.match(String(chips.planner), new RegExp(`· ${low}$`), "control: the model with an effort setting shows its effort");
    await openMenu(ev, waitFor, "coder");
    const plainMenu = await ev(MENU);
    console.log(`FCPICK effort plain menu: ${JSON.stringify(plainMenu)}`);
    assert.ok(plainMenu.open && plainMenu.models > 0 && plainMenu.ticked.includes(none), "control: the menu of the no-effort position is open, lists models and ticks its own");
    assert.deepEqual([plainMenu.efforts, plainMenu.groups, plainMenu.noEffortHint], [[], 0, true], "no effort control, and the no-effort explanation is shown");
    await click(ev, chip("coder"));
    await waitFor(`document.querySelector("#pop").hidden`, "the menu closed");
    await openMenu(ev, waitFor, "planner");
    const richMenu = await ev(MENU);
    console.log(`FCPICK effort supported menu: ${JSON.stringify(richMenu)}`);
    assert.ok(richMenu.open && richMenu.ticked.includes(some), "control: the menu of the effort position is open and ticks its own model");
    assert.deepEqual([richMenu.efforts, richMenu.noEffortHint], [claude.efforts.map((value: string) => [value, String(value === low)]), false], "every effort is offered, the saved one is ticked, and no no-effort explanation");
    const other = claude.efforts.find((value: string) => value !== low), from = await sentLength(ev);
    await click(ev, `#pop [data-effort="${other}"]`);
    assert.deepEqual(bare(await writesSince(ev, from)), [{ type: "setCrewAssignment", tabId: fixed.id, slot: "planner", assignment: { cli: "claude", model: some, effort: other } }], "a real effort choice sends one fixed assignment with that effort");
  }, { fixture: "fixed" });
});

const LOCKED_MENU = `(()=>{const p=document.querySelector("#pop"),all=[...p.querySelectorAll("[data-model],[data-effort],[data-clear-model]")],on=(sel)=>[...p.querySelectorAll(sel)];return {open:!p.hidden&&Boolean(p.querySelector("#mq")),hint:Boolean(p.querySelector("[data-picker-locked]")),models:on("[data-model]").length,efforts:on("[data-effort]").length,clears:on("[data-clear-model]").length,enabled:all.filter((b)=>!b.disabled||b.getAttribute("aria-disabled")!=="true").length}})()`;
const FORCE_ALL = `(()=>{const p=document.querySelector("#pop"),held=[p.querySelector("[data-model]"),p.querySelector("[data-effort]"),p.querySelector("[data-clear-model]")];if(held.some((b)=>!b))return held.map((b)=>Boolean(b));for(const b of held){b.disabled=false;b.click()}return true})()`;
// The chip's own click listener, reached past its disabled state.
const forceChip = (ev: Page["ev"], slot: string): Promise<boolean> => ev(`(()=>{const c=document.querySelector(${J(chip(slot))});if(!c)return false;c.disabled=false;c.click();return true})()`);

test("FCPICK busy positions: a busy leader or worker, working or unconfirmed, cannot be changed through the chip, the menu, search or focus, and everything recovers when it is idle again", { timeout: editorTestMs(150_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed }) => {
    const claude = discovered.clis.find((cli: any) => cli.id === "claude"), codex = discovered.clis.find((cli: any) => cli.id === "codex");
    const effort = (cap: any) => (cap.efforts.includes("medium") ? "medium" : cap.efforts[0]);
    const mine = { cli: "claude", model: claude.models[0], effort: effort(claude) }, toCodex = { cli: "codex", model: codex.models[0], effort: effort(codex) };
    assert.ok(claude.efforts.length >= 2 && claude.efforts.includes(mine.effort), "control: Claude has an effort row for the saved model");
    const base = prefsJs({ leader: mine, coder: mine });
    const state = (busy: string | null, extra = "") => deliverState(ev, discovered, `${base};${crewOf}.busy=${busy ? `{${J(busy)}:true}` : "{}"};${extra}`);
    const row = (slot: string) => ev(`(()=>{const r=document.querySelector(${J(ROW(slot))});return {chipOff:r.querySelector(".fc-model").disabled,busy:!r.querySelector(".fc-busy").hidden}})()`);
    await state(null);
    await openSettings(ev, waitFor);
    // Idle: the model, effort and clear controls each send their own fixed message, for the leader and for a worker.
    for (const slot of ["leader", "coder"]) {
      await openMenu(ev, waitFor, slot);
      let from = await sentLength(ev);
      await click(ev, `#pop [data-cli="codex"][data-model="${toCodex.model}"]`);
      assert.deepEqual(bare(await writesSince(ev, from)), [{ type: "setCrewAssignment", tabId: fixed.id, slot, assignment: toCodex }], `idle ${slot}: a model pick sends its assignment`);
      const other = claude.efforts.find((value: string) => value !== mine.effort);
      from = await sentLength(ev);
      await click(ev, `#pop [data-effort="${other}"]`);
      assert.deepEqual(bare(await writesSince(ev, from)), [{ type: "setCrewAssignment", tabId: fixed.id, slot, assignment: { ...mine, effort: other } }], `idle ${slot}: an effort choice sends it`);
      await openMenu(ev, waitFor, slot);
      from = await sentLength(ev);
      await click(ev, "#pop [data-clear-model]");
      assert.deepEqual(bare(await writesSince(ev, from)), [{ type: "clearCrewAssignment", tabId: fixed.id, slot }], `idle ${slot}: Clear sends it`);
    }
    // Unconfirmed work: an unconfirmed stop in launchSafety and no working run at all, projected busy by the server.
    const unconfirmed = (slot: string) => `state.launchSafety={...(state.launchSafety||{}),uncertain:[{runId:"unc-${slot}",seatKey:${J(`${fixed.id}.${slot}`)},seatId:${J(`${fixed.id}.${slot}`)},seatName:${J(slot)},tabId:${J(fixed.id)}}]};state.projects[0].tabs[0].runs=[]`;
    for (const [slot, kind] of [["leader", "working"], ["coder", "working"], ["leader", "unconfirmed"], ["coder", "unconfirmed"]] as const) {
      const label = `${kind} ${slot}`, idleSlot = slot === "leader" ? "coder" : "leader";
      await state(null);
      await state(slot, kind === "unconfirmed" ? unconfirmed(slot) : "");
      assert.deepEqual(await row(slot), { chipOff: true, busy: true }, `${label}: the chip is disabled and the busy explanation is shown`);
      assert.deepEqual(await row(idleSlot), { chipOff: false, busy: false }, `control: the other position (${idleSlot}) stays free`);
      assert.equal(await forceChip(ev, slot), true, `${label}: control: the chip was FOUND and clicked`);
      const menu = await ev(LOCKED_MENU);
      console.log(`FCPICK busy ${label} menu: ${JSON.stringify(menu)}`);
      assert.ok(menu.open && menu.models > 0 && menu.efforts > 0 && menu.clears === 1, `${label}: control: the menu is open with model, effort and clear controls FOUND`);
      assert.deepEqual([menu.hint, menu.enabled], [true, 0], `${label}: the menu says it is locked and every control is disabled`);
      // Controls forced enabled and their own listeners invoked: nothing is sent.
      let from = await sentLength(ev);
      assert.equal(await ev(FORCE_ALL), true, `${label}: control: the three controls were found and clicked`);
      assert.deepEqual(await writesSince(ev, from), [], `${label}: forced model, effort and clear clicks send zero assignment, clear or seat writes`);
      // Searching while locked draws new options that stay disabled.
      assert.equal(await forceChip(ev, slot), true, `${label}: control: the chip was FOUND again`);
      await setValue(ev, "#mq", "claude");
      const searched = await ev(`(()=>{const o=[...document.querySelectorAll("#pop [data-model]")];return {count:o.length,enabled:o.filter((b)=>!b.disabled).length,query:document.querySelector("#mq").value}})()`);
      assert.ok(searched.count > 0 && searched.query === "claude", `${label}: control: the search found options (${JSON.stringify(searched)})`);
      assert.equal(searched.enabled, 0, `${label}: options drawn by a search while locked are disabled`);
      // Idle again: the open menu unlocks, and a real pick sends.
      await state(null);
      const free = await ev(LOCKED_MENU);
      assert.deepEqual([free.open, free.hint, free.enabled === free.models + free.efforts + free.clears], [true, false, true], `${label}: after the busy state ends the open menu has no lock hint and every control is enabled`);
      await setValue(ev, "#mq", "");
      from = await sentLength(ev);
      await click(ev, `#pop [data-cli="codex"][data-model="${toCodex.model}"]`);
      assert.deepEqual(bare(await writesSince(ev, from)), [{ type: "setCrewAssignment", tabId: fixed.id, slot, assignment: toCodex }], `${label}: recovered: the real pick sends again`);
    }
    // Focus on a model option, then the position gets busy: focus moves to the search box, never to the page.
    for (const slot of ["leader", "coder"]) {
      await state(null);
      await openMenu(ev, waitFor, slot);
      const focused = await ev(`(()=>{const o=document.querySelector("#pop [data-model]:not(:disabled)");if(!o)return null;o.focus();return document.activeElement===o})()`);
      assert.equal(focused, true, `${slot}: control: a model option held focus while idle`);
      await state(slot);
      assert.deepEqual(await ev(`[document.activeElement?.id??null,[...document.querySelectorAll("#pop [data-model]")].every((b)=>b.disabled)]`), ["mq", true], `${slot}: focus moved from the option that locked to the search box`);
    }
  }, { fixture: "fixed" });
});

// The menu itself is the lock boundary: here the position's own second guard (the Settings adapter's busy check) is out of the way, so only the chooser can stop a call.
test("FCPICK busy chooser: a model, effort or clear listener kept from before, and an ACP confirmation answered after, do nothing once the adapter says locked; an incomplete adapter opens nothing", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered }) => {
    const claude = discovered.clis.find((cli: any) => cli.id === "claude"), codex = discovered.clis.find((cli: any) => cli.id === "codex");
    const acp = `state.clis.push({...state.clis.find((c)=>c.id==="codex"),id:"acp:kimi",label:"Kimi",installed:true,models:["default"],efforts:["default"]});state.acpClis=[{id:"kimi",name:"Kimi",program:"kimi",args:[],kind:"acp:kimi"}]`;
    await deliverState(ev, discovered, acp);
    await ev(`(()=>{const seat={slot:"coder",name:"Coder",cli:"claude",model:${J(claude.models[0])},effort:${J(claude.efforts[0])},isLeader:false,canWrite:true};
      window.__pc={locked:false,calls:[]};
      window.__seat=seat;window.__ad={tab:()=>currentTab(),seat:()=>seat,locked:()=>window.__pc.locked,pick:(fields)=>window.__pc.calls.push({pick:fields}),clear:()=>window.__pc.calls.push({clear:true}),hints:()=>[]};
      return true})()`);
    const open = () => ev(`(()=>{setLayer(document.querySelector("#pop"),false);openModelPicker(currentTab(),window.__seat,document.querySelector("#setBtn"),window.__ad);return !document.querySelector("#pop").hidden&&Boolean(document.querySelector("#pop #mq"))})()`);
    const calls = (): Promise<any[]> => ev("window.__pc.calls");
    const lock = (on: boolean) => ev(`(()=>{window.__pc.locked=${on};return true})()`);
    const codexModel = codex.models[0];
    const press = (selector: string) => ev(`(()=>{const el=document.querySelector(${J(selector)});if(!el)return false;el.click();return true})()`);
    // Control: idle, each action reaches the adapter once, through the one chooser.
    assert.equal(await open(), true, "control: the picker opened with the instrumented adapter");
    assert.equal(await press(`#pop [data-cli="codex"][data-model="${codexModel}"]`), true);
    assert.equal(await open(), true);
    assert.equal(await press(`#pop [data-effort="${claude.efforts.find((value: string) => value !== claude.efforts[0])}"]`), true);
    assert.equal(await open(), true);
    assert.equal(await press("#pop [data-clear-model]"), true);
    assert.deepEqual(await calls(), [{ pick: { model: codexModel, cli: "codex" } }, { pick: { effort: claude.efforts.find((value: string) => value !== claude.efforts[0]) } }, { clear: true }], "control: idle model, effort and clear each call the adapter once");
    // Retained listeners: kept elements from an idle menu, the lock changes without a redraw, then they are invoked.
    await ev("window.__pc.calls.length=0;true");
    assert.equal(await open(), true);
    const held = await ev(`(()=>{const p=document.querySelector("#pop");window.__held=[p.querySelector('[data-cli="codex"][data-model]'),p.querySelector("[data-effort]"),p.querySelector("[data-clear-model]")];return window.__held.map((el)=>Boolean(el&&!el.disabled))})()`);
    assert.deepEqual(held, [true, true, true], "control: model, effort and clear controls were FOUND and are enabled (the DOM is not what protects them)");
    await lock(true);
    assert.deepEqual(await ev(`(()=>{for(const el of window.__held)el.click();return window.__pc.calls.length})()`), 0, "kept model, effort and clear listeners call the adapter zero times once it is locked");
    // An ACP confirmation opened while idle and answered after the lock changed.
    await lock(false);
    assert.equal(await open(), true);
    assert.equal(await press('#pop [data-cli="acp:kimi"][data-model="default"]'), true, "control: the ACP option was FOUND");
    assert.equal(await ev(`!document.querySelector("#confirmModal").hidden`), true, "control: the Full access question is open");
    await lock(true);
    await click(ev, "#confirmOk");
    assert.deepEqual(await calls(), [], "a confirmation answered after the lock changed calls the adapter zero times");
    await lock(false);
    assert.equal(await open(), true);
    assert.equal(await press('#pop [data-cli="acp:kimi"][data-model="default"]'), true);
    await click(ev, "#confirmOk");
    assert.deepEqual(await calls(), [{ pick: { model: "default", cli: "acp:kimi" } }], "control: the same confirmation with no lock calls the adapter once");
    // An unusable adapter opens nothing, draws nothing and sends nothing.
    const refused = await ev(`(()=>{const pop=document.querySelector("#pop"),sent=window.__sent.length,tab=currentTab(),seat=window.__seat,anchor=document.querySelector("#setBtn"),errors=[];
      setLayer(pop,false);const shown=[];
      for(const adapter of [undefined,false,{tab:()=>tab,seat:()=>seat},{...window.__ad,pick:undefined}]){try{openModelPicker(tab,seat,anchor,adapter)}catch(e){errors.push(String(e))}shown.push(pop.hidden)}
      try{openModelPicker(tab,seat,anchor,false,window.__ad)}catch(e){errors.push(String(e))}shown.push(pop.hidden);
      return {errors,shown,sent:window.__sent.length-sent,calls:window.__pc.calls.length}})()`);
    assert.deepEqual(refused, { errors: [], shown: [true, true, true, true, true], sent: 0, calls: 1 }, "no adapter, a false one, a partial one, one without pick and the old five-argument shape each open nothing, throw nothing and send nothing");
  }, { fixture: "fixed" });
});
