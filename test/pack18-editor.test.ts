import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, setValue, deliver, deliverState, delay, press, type Page } from "./pack18-editor-harness.ts";

// Pack 26 Block 5 slice 2b: the old crew editor's surviving behaviour, proved on the fixed crew (harness fixture "fixed": the real page in a real
// headless Chrome, its state from the real server over a fake socket, so every message the page sends is captured). W1 one fixed section with the
// server's 18 positions and nothing of the old editor, W4 a creation refusal keeps the draft, E5 a busy position is locked and sends nothing.
// What the old cases checked and the fixed crew no longer has (custom roles, Can write, Runs the process, seat rename, Switch to / Save as, the
// Save bar) is retired with the product features; test/fixed-crew-page.test.ts and test/fixed-crew-creation.test.ts cover the fixed outcomes.

const GROUP_ORDER = ["Planning", "Making", "Checking"];
const WRITES = ["setCrewAssignment", "clearCrewAssignment", "setCrewRoleExtra", "resetCrewRoleExtra"];
const count = (ev: Page["ev"]): Promise<number> => ev("window.__sent.length");
const sentFrom = (ev: Page["ev"], from: number, types: string[]): Promise<any[]> => ev(`window.__sent.slice(${from}).filter((m)=>${J(types)}.includes(m.type))`);
const reply = (ev: Page["ev"], action: string, requestId: string) => deliver(ev, { type: "actionResult", action, requestId });
async function openSettings(ev: Page["ev"], waitFor: Page["waitFor"]): Promise<void> {
  await click(ev, "#setBtn");
  await waitFor(`Boolean(document.querySelector("#setModal:not([hidden]) [data-fc-tab]"))`, "the fixed crew section in Settings");
}

test("W1: Settings mounts one fixed crew section with exactly the server's 18 positions, each once, in their groups, and nothing of the old editor: no role, step or seat controls, no Save bar", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    const defs: { slot: string; label: string; group: string }[] = seed.fixedCrewDefinitions;
    assert.equal(defs.length, 18, "control: the server sends its 18 positions");
    const expected = Object.fromEntries(GROUP_ORDER.map((group) => [group, defs.filter((def) => def.group === group).map((def) => def.slot)]));
    await openSettings(ev, waitFor);
    const scan = await ev(`(()=>{const set=document.querySelector("#setModal"),crew=document.querySelector("#s-crew"),q=(sel)=>set.querySelectorAll(sel).length;
      return {sections:q("[data-fc-tab]"),crewIds:document.querySelectorAll("#s-crew").length,
        groups:Object.fromEntries([...set.querySelectorAll("[data-fc-group]")].map((g)=>[g.dataset.fcGroup,[...g.querySelectorAll("[data-fc-row]")].map((r)=>r.dataset.fcRow)])),
        all:[...set.querySelectorAll("[data-fc-row]")].map((r)=>r.dataset.fcRow),labels:[...set.querySelectorAll("[data-fc-row] .fc-label")].map((l)=>l.textContent),
        old:{editor:q("[data-setup-editor]"),rows:q("[data-se-row],[data-se-card]"),roles:q("[data-se-role],[data-se-rolemenu],[data-se-custom-role]"),
          steps:q("[data-se-step],[data-se-lane],.se-li,[data-se-type],[data-se-gap],[data-se-add-step]"),add:q("[data-se-add]"),switches:q("[data-se-canwrite],[data-se-runs],[data-se-look-toggle]"),
          owners:q("[data-se-owner],[data-se-owner-add],[data-se-pick],[data-se-pick-new],[data-se-pair],[data-se-pair-add],[data-se-fixer-add]"),grips:q("[data-se-grip],[draggable=true]"),
          oldRows:q("[data-settings-model],[data-settings-advisor],[data-settings-orchestrates],[data-settings-crew]"),menus:q("[data-se-menu]"),saveBar:q("[data-se-save],[data-se-discard]")},
        mounts:{foot:document.getElementById("setFoot"),live:document.getElementById("setLive"),dock:document.querySelectorAll("[data-setup-editor-foot],.se-dock,.se-live").length},
        stepWords:(crew?.innerText.match(/\\bsteps?\\b/gi)??[]).length}})()`);
    console.log(`W1 scan: ${JSON.stringify(scan)}`);
    assert.deepEqual([scan.sections, scan.crewIds], [1, 1], "exactly one mounted fixed Settings section");
    assert.deepEqual(Object.keys(scan.groups), GROUP_ORDER, "the three groups, in order");
    assert.deepEqual(scan.groups, expected, "the server's slots, grouped as the server says, in the server's order");
    assert.deepEqual(scan.all, GROUP_ORDER.flatMap((group) => expected[group]), "the complete ordered slot list");
    assert.equal(new Set(scan.all).size, 18, "every slot is shown exactly once");
    assert.equal(new Set(scan.labels).size, 18, "no two positions read alike");
    assert.deepEqual(scan.old, Object.fromEntries(Object.keys(scan.old).map((key) => [key, 0])), "no variable-role control, step editor, old seat row, old editor list or old Save bar control anywhere in Settings");
    assert.equal(await ev(`Boolean(document.querySelector("#setModal #setBody"))`), true, "control: the Settings body was FOUND, so an absent strip is a real absence");
    assert.deepEqual(scan.mounts, { foot: null, live: null, dock: 0 }, "the old Save-bar strip #setFoot and the old live line #setLive are absent from the page, not merely empty");
    assert.equal(scan.stepWords, 0, "nothing in the crew section talks about steps");
  }, { fixture: "fixed" });
});

test("W1b: with no or unusable server positions Settings says Crew and models unavailable, draws no old editor or invented position, keeps its other sections working, and the fixed list returns with valid positions", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered }) => {
    await deliverState(ev, discovered);
    await openSettings(ev, waitFor);
    const scan = () => ev(`(()=>{const set=document.querySelector("#setModal");return {fixed:set.querySelectorAll("[data-fc-tab]").length,rows:set.querySelectorAll("[data-fc-row]").length,crewIds:document.querySelectorAll("#s-crew").length,message:set.querySelector("#s-crew [data-crew-unavailable]")?.textContent??null,
      old:set.querySelectorAll("[data-setup-editor],[data-se-row],[data-settings-model],[data-settings-advisor]").length+document.querySelectorAll("#setFoot,#setLive").length,sections:[...set.querySelectorAll(".settings-section")].map((s)=>s.dataset.section)}})()`);
    const SECTIONS = ["crew", "tools", "acp", "github", "vault", "folders", "skills", "appearance", "behaviour"];
    const ready = await scan();
    assert.deepEqual(ready, { fixed: 1, rows: 18, crewIds: 1, message: null, old: 0, sections: SECTIONS }, "control: with the server's 18 positions one fixed section is mounted and no unavailable message");
    const broken: [string, string][] = [
      ["no positions", "state.fixedCrewDefinitions=[]"],
      ["a position twice", "state.fixedCrewDefinitions=[...state.fixedCrewDefinitions,{...state.fixedCrewDefinitions[0]}]"],
      ["an unknown group", 'state.fixedCrewDefinitions[0].group="Nowhere"'],
    ];
    for (const [label, change] of broken) {
      await deliverState(ev, discovered, change);
      const now = await scan();
      console.log(`W1b ${label}: ${JSON.stringify(now)}`);
      assert.deepEqual({ ...now, message: "" }, { fixed: 0, rows: 0, crewIds: 1, message: "", old: 0, sections: SECTIONS }, `${label}: no fixed list and no old editor, one crew section, every other section kept`);
      assert.match(String(now.message), /^Crew and models unavailable\./, `${label}: the plain message`);
      await click(ev, '#setModal [data-theme="dark"]');
      assert.equal(await ev(`document.querySelector('#setModal [data-theme="dark"]').getAttribute("aria-checked")`), "true", `${label}: another Settings section still works`);
      await deliverState(ev, discovered);
      const back = await scan();
      assert.deepEqual(back, ready, `${label}: valid positions return the one fixed list`);
      assert.deepEqual(await ev(`[...document.querySelectorAll("#setModal [data-fc-row]")].map((r)=>r.dataset.fcRow)`), GROUP_ORDER.flatMap((group) => discovered.fixedCrewDefinitions.filter((def: any) => def.group === group).map((def: any) => def.slot)), `${label}: all 18 positions, each once, grouped as the server says`);
    }
  }, { fixture: "fixed" });
});

test("W4: a creation the server refuses shows its reason, keeps the dialog and the user's model and effort picks, and can be sent again; nothing reports success", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, work }) => {
    await deliverState(ev, discovered);
    await ev(`window.cc.pickFolder=async()=>${J(work)}`);
    await click(ev, "#addProj");
    await waitFor(`!document.querySelector("#projModal").hidden`, "the New project dialog");
    await setValue(ev, "#pName", "W4 project");
    await click(ev, "#pBrowse");
    await waitFor(`document.querySelector("#pDir").textContent===${J(work)}`, "the project folder was chosen");
    await waitFor(`!document.querySelector("#createProj").disabled`, "Create project is enabled");
    await click(ev, `#pCrew [data-fc-new-model="coder"]`);
    await waitFor(`!document.querySelector("#pop").hidden&&Boolean(document.querySelector("#pop #mq"))`, "the model menu");
    const model = await ev(`(()=>{const b=document.querySelector('#pop [data-cli="codex"][data-model]');if(!b)return null;b.click();return b.dataset.model})()`);
    assert.ok(model, "control: the menu offers a Codex model");
    const effort = await ev(`(()=>{const b=[...document.querySelectorAll("#pop [data-effort]")].find((el)=>el.getAttribute("aria-checked")!=="true");if(!b)return null;b.click();return b.dataset.effort})()`);
    assert.ok(effort, "control: another effort is offered");
    const chosen = { cli: "codex", model, effort };
    let from = await count(ev);
    await click(ev, "#createProj");
    const [first] = await sentFrom(ev, from, ["addProject"]);
    assert.ok(first, "Create sent addProject");
    assert.deepEqual(first.crewChoices, { coder: chosen }, "the one fixed payload carries the chosen model and effort");
    await deliver(ev, { type: "error", message: "project folder does not exist", action: "addProject", requestId: first.requestId });
    await waitFor(`document.querySelector("#npStat")?.textContent==="Not created: project folder does not exist"`, "the server's refusal is shown");
    const after = await ev(`(()=>{const toast=document.querySelector("#toast"),row=document.querySelector('#pCrew [data-fc-new-row="coder"]');
      return {open:!document.querySelector("#projModal").hidden,name:document.querySelector("#pName").value,source:row?.querySelector(".fc-source").textContent??null,chip:row?.querySelector(".fc-model-text").textContent??null,
        create:document.querySelector("#createProj").disabled,toast:toast&&!toast.hidden&&toast.textContent.trim()!==""?toast.textContent:null}})()`);
    console.log(`W4 after the refusal: ${JSON.stringify(after)}`);
    assert.equal(after.open, true, "the dialog stays open");
    assert.equal(after.name, "W4 project", "the name stays");
    assert.match(String(after.source), /^Your choice · Codex$/, "the user's pick stays");
    assert.ok(String(after.chip).includes(effort), `the chosen effort ${effort} is still shown`);
    assert.equal(after.create, false, "Create can be pressed again");
    assert.doesNotMatch(String(after.toast ?? ""), /^(Created|Added|Saved|Project created)/i, "no success toast");
    from = await count(ev);
    await click(ev, "#createProj");
    const [retry] = await sentFrom(ev, from, ["addProject"]);
    assert.ok(retry, "the retry sent addProject again");
    assert.deepEqual([retry.crewChoices, retry.name, retry.requestId !== first.requestId], [{ coder: chosen }, "W4 project", true], "the retry carries the same picks under a new request");
    await deliver(ev, { type: "error", message: "refused again", action: "addProject", requestId: retry.requestId });
  }, { fixture: "fixed" });
});

test("E5: while a position is busy its model and instruction controls are locked and say why, send nothing even when forced on, and unlock when it finishes", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, discovered }) => {
    await deliverState(ev, discovered);
    await openSettings(ev, waitFor);
    const ROW = `#setModal [data-fc-row="coder"]`;
    const found = async (selector: string) => { assert.equal(await ev(`Boolean(document.querySelector(${J(selector)}))`), true, `the control ${selector} was FOUND`); return selector; };
    const chip = await found(`${ROW} [data-fc-model]`), save = await found(`${ROW} [data-fc-save]`), reset = await found(`${ROW} [data-fc-reset]`), area = await found(`${ROW} .fc-extra`);
    const look = () => ev(`(()=>{const q=(s)=>document.querySelector(s);return {chipOff:q(${J(chip)}).disabled,saveOff:q(${J(save)}).disabled,resetOff:q(${J(reset)}).disabled,busyShown:!q(${J(`${ROW} .fc-busy`)}).hidden,busyText:q(${J(`${ROW} .fc-busy`)}).textContent}})()`);
    const typeInto = async (text: string) => {
      assert.equal(await ev(`(()=>{const a=document.querySelector(${J(area)});if(!a||!a.getClientRects().length)return false;a.focus();a.setSelectionRange(a.value.length,a.value.length);return document.activeElement===a})()`), true, "the shown extra instructions field was FOUND and focused");
      await page("Input.insertText", { text });
    };
    const crew = "state.projects[0].tabs[0].fixedCrew";
    const busy = (on: boolean) => `${crew}.busy={...(${crew}.busy??{}),coder:${on}}`;
    await click(ev, `${ROW} [data-fc-toggle]`);
    // Idle: the model menu, the effort row, Save and Reset all send.
    const idle = await look();
    assert.deepEqual([idle.chipOff, idle.saveOff, idle.resetOff, idle.busyShown], [false, true, true, false], "control: idle, the model control is on and nothing is waiting to save");
    await click(ev, chip);
    await waitFor(`!document.querySelector("#pop").hidden&&Boolean(document.querySelector("#pop #mq"))`, "the idle model menu");
    let from = await count(ev);
    assert.equal(await ev(`(()=>{const b=document.querySelector('#pop [data-model]:not([aria-pressed="true"])');if(!b)return false;b.click();return true})()`), true, "control: another model was FOUND and picked");
    assert.equal(await ev(`(()=>{const b=[...document.querySelectorAll("#pop [data-effort]")].find((el)=>el.getAttribute("aria-checked")!=="true");if(!b)return false;b.click();return true})()`), true, "control: another effort was FOUND and picked");
    const idlePicks = await sentFrom(ev, from, WRITES);
    assert.deepEqual(idlePicks.map((m) => [m.type, m.slot]), [["setCrewAssignment", "coder"], ["setCrewAssignment", "coder"]], "idle, a model pick and an effort pick are sent");
    for (const message of idlePicks) await reply(ev, "setCrewAssignment", message.requestId);
    await typeInto("idle note");
    assert.equal((await look()).saveOff, false, "idle, typing turns Save on");
    from = await count(ev);
    await click(ev, save);
    const [idleSave] = await sentFrom(ev, from, WRITES);
    assert.deepEqual([idleSave?.type, idleSave?.text], ["setCrewRoleExtra", "idle note"], "idle, Save sends the typed text");
    await deliverState(ev, discovered, `${crew}.roleExtras.coder="idle note"`);
    await reply(ev, "setCrewRoleExtra", idleSave.requestId);
    from = await count(ev);
    await click(ev, reset);
    const [idleReset] = await sentFrom(ev, from, WRITES);
    assert.equal(idleReset?.type, "resetCrewRoleExtra", "idle, Reset sends");
    await deliverState(ev, discovered);
    await reply(ev, "resetCrewRoleExtra", idleReset.requestId);
    // Busy: a state broadcast makes the position busy.
    await typeInto("draft while busy");
    assert.deepEqual([(await look()).saveOff, (await look()).resetOff], [false, false], "control: with unsaved text, Save and Reset would be on");
    await deliverState(ev, discovered, busy(true));
    await waitFor(`!document.querySelector(${J(`${ROW} .fc-busy`)}).hidden`, "the busy note shows");
    const locked = await look();
    console.log(`E5 busy: ${JSON.stringify(locked)}`);
    assert.deepEqual([locked.chipOff, locked.saveOff, locked.resetOff, locked.busyShown], [true, true, true, true], "the position's controls are locked");
    assert.match(locked.busyText, /^Working now\./, "and the position says why");
    from = await count(ev);
    const forced = await ev(`(async()=>{const q=(s)=>document.querySelector(s),pop=q("#pop"),out={};
      const c=q(${J(chip)});c.disabled=false;c.click();out.menuOpen=!pop.hidden;out.lockedNote=Boolean(pop.querySelector("[data-picker-locked]"));
      const model=[...pop.querySelectorAll("[data-model]")].find((b)=>b.getAttribute("aria-pressed")!=="true");out.model=Boolean(model);if(model){model.disabled=false;model.click()}
      const effort=[...pop.querySelectorAll("[data-effort]")].find((b)=>b.getAttribute("aria-checked")!=="true");out.effort=Boolean(effort);if(effort){effort.disabled=false;effort.click()}
      for(const sel of [${J(save)},${J(reset)}]){const b=q(sel);b.dispatchEvent(new MouseEvent("click",{bubbles:true}));b.disabled=false;b.click();}
      return out})()`);
    console.log(`E5 forced: ${JSON.stringify(forced)}`);
    assert.deepEqual(forced, { menuOpen: true, lockedNote: true, model: true, effort: true }, "control: the forced model menu opened locked and its model and effort buttons were FOUND and invoked");
    await delay(150);
    assert.deepEqual(await sentFrom(ev, from, WRITES), [], "zero assignment or instruction writes while busy");
    assert.equal(await ev(`document.querySelector("#pop").hidden`), true, "the forced effort pick closed the menu");
    // Not busy any more: the controls unlock and Save sends the draft.
    await deliverState(ev, discovered, busy(false));
    await waitFor(`document.querySelector(${J(`${ROW} .fc-busy`)}).hidden`, "the busy note goes");
    assert.deepEqual(await look(), { chipOff: false, saveOff: false, resetOff: false, busyShown: false, busyText: locked.busyText }, "the controls unlock");
    from = await count(ev);
    await click(ev, save);
    const [after] = await sentFrom(ev, from, WRITES);
    assert.deepEqual([after?.type, after?.text], ["setCrewRoleExtra", "draft while busy"], "unlocked, Save sends the draft kept through the busy time");
  }, { fixture: "fixed" });
});

// Block 5 slice 2d1: the app has no crew switcher. The rail's crew control and the tab menu's Crew item only open Settings on the fixed crew.
test("B5SWITCH routes: rail and tab Crew actions open fixed Settings without a setup switch", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, fixed, secondFixed }) => {
    const second = secondFixed.id as string;
    const open = `Boolean(document.querySelector("#setModal:not([hidden]) [data-fc-tab]"))`;
    const where = () => ev(`({mounted:document.querySelectorAll("#setModal [data-fc-tab]").length,tab:document.querySelector("#setModal [data-fc-tab]")?.dataset.fcTab??null,selected:document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId??null,focus:document.activeElement?.id||document.activeElement?.dataset?.moreFor||null,settingsHidden:document.querySelector("#setModal").hidden})`);
    const closeByEscape = async (label: string) => { await press(page, "Escape"); await waitFor(`document.querySelector("#setModal").hidden`, `Escape closed Settings (${label})`); };
    const crewItem = async (tabId: string) => {
      assert.equal(await ev(`Boolean(document.querySelector('#tabs .tmore[data-more-for="${tabId}"]'))`), true, `control: the options button of ${tabId} was FOUND`);
      await click(ev, `#tabs .tmore[data-more-for="${tabId}"]`);
      await waitFor(`!document.querySelector("#ctxPop").hidden`, `the tab menu of ${tabId}`);
      const index = await ev(`(()=>{const b=[...document.querySelectorAll("#ctxPop [data-menu-index]")].find((x)=>x.querySelector(".nm span")?.textContent==="Crew");return b?b.dataset.menuIndex:null})()`);
      assert.notEqual(index, null, "control: the Crew item was FOUND in the tab menu");
      return { sub: await ev(`document.querySelector('#ctxPop [data-menu-index="${index}"]').textContent`), pick: () => click(ev, `#ctxPop [data-menu-index="${index}"]`) };
    };
    const mark = await ev("window.__sent.length");
    // 1. The rail's crew control opens the current tab's fixed Settings; Escape gives focus back to it.
    assert.equal(await ev(`Boolean(document.querySelector("#setupsBtn"))`), true, "control: the rail's crew control was FOUND");
    await click(ev, "#setupsBtn", true);
    await waitFor(open, "the rail control opened Settings");
    const rail = await where();
    assert.deepEqual([rail.mounted, rail.tab, rail.selected], [1, fixed.id, fixed.id], "the rail control opened the current tab's one fixed section");
    await closeByEscape("rail");
    assert.equal((await where()).focus, "setupsBtn", "Escape returned focus to the rail control");
    // 2. The current tab's menu: Crew opens that tab's Settings.
    const own = await crewItem(fixed.id);
    assert.match(own.sub, /Choose its models in Settings/);
    await own.pick();
    await waitFor(open, "the current tab's Crew item opened Settings");
    const ownScan = await where();
    assert.deepEqual([ownScan.mounted, ownScan.tab, ownScan.selected], [1, fixed.id, fixed.id], "the current tab's Crew item opened its own one fixed section");
    await closeByEscape("current tab menu");
    assert.equal((await where()).focus, fixed.id, "Escape returned focus to the current tab's options button");
    // 3. A background tab: Crew selects it first and does not open Settings; the same item then opens its Settings.
    const background = await crewItem(second);
    assert.match(background.sub, /Open the tab to choose its models/);
    await background.pick();
    await waitFor(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId===${J(second)}`, "the background tab was selected");
    const picked = await where();
    assert.deepEqual([picked.selected, picked.settingsHidden], [second, true], "Crew on a background tab only selected it");
    const next = await crewItem(second);
    assert.match(next.sub, /Choose its models in Settings/);
    await next.pick();
    await waitFor(open, "the selected tab's Crew item opened Settings");
    await waitFor(`document.querySelector("#setModal [data-fc-tab]")?.dataset.fcTab===${J(second)}`, "the second tab's fixed section");
    const last = await where();
    assert.deepEqual([last.mounted, last.tab, last.selected], [1, second, second], "exactly one fixed section, for the selected tab");
    // 4. Nothing of the old switch: no popover, no template or saved-setup button, no useSetup sent.
    const gone = await ev(`({pop:document.getElementById("setupPop"),use:document.querySelectorAll("[data-use-template],[data-use-saved]").length})`);
    assert.deepEqual(gone, { pop: null, use: 0 }, "no setupPop and no template or saved-setup button anywhere");
    const sent: any[] = await ev(`window.__sent.slice(${mark})`);
    console.log(`B5SWITCH sent: ${JSON.stringify(sent.map((m) => m.type))}`);
    assert.deepEqual(sent.filter((m) => m.type === "useSetup"), [], "no useSetup was sent");
    assert.ok(sent.some((m) => m.type === "selectTab" && m.tabId === second), "control: the background pick sent selectTab for the second tab");
  }, { fixture: "fixed2" });
});
