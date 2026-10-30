import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, ED, J, withPage, skipped, bareSeat, sentOf, click, openEditor, openSeat, pickRole, addSeat, rowSlots, deliverTab, setValue, delay } from "./pack18-editor-harness.ts";

// Pack 18 rework: the crew editor (public/setup-editor*.js) in a real headless Chrome running the real page, its state from the real server
// (harness: test/pack18-editor-harness.ts). W1 no step editor and one crew list, W2 the role list programs a seat, W3 only a Planner runs the
// process, W4 a new seat starts empty, E5 locked while the tab is busy, E7 a rename then Save in one click.

const baseFor = (tab: any) => tab.crew.find((seat: any) => !seat.isLeader && !String(seat.cli).startsWith("acp:"));
const sentSetups = async (ev: any) => (await sentOf(ev, "setSetup")).map((message) => { const { type, tabId, crew, lookPause, ...rest } = message; return { type, tabId, crew, lookPause, rest }; });

test("W1: Settings has no step editor and exactly one crew list: no step rows, add-step, owner chips, pair lines or drag grips; one row per seat; the old Settings seat rows are gone; the setup line and its Switch to / Save as sit in the crew header", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, ours }) => {
    await openEditor(ev, waitFor);
    await openSeat(ev, "planner");
    const scan = await ev(`(()=>{const set=document.querySelector("#setModal"),crew=document.querySelector("#s-crew"),q=(sel)=>set.querySelectorAll(sel).length;
      const names=${J(ours.crew.map((seat: any) => seat.name))};
      return {stepRows:q("[data-se-step],[data-se-lane],.se-li"),addStep:q("[data-se-type],[data-se-gap],[data-se-add-step]"),owners:q("[data-se-owner],[data-se-owner-add],[data-se-pick],[data-se-pick-new]"),
        pairs:q("[data-se-pair],[data-se-pair-add],[data-se-fixer-add]"),grips:q("[data-se-grip],[draggable=true]"),oldRows:q("[data-settings-model],[data-settings-advisor],[data-settings-orchestrates],[data-settings-crew]"),
        crows:crew.querySelectorAll(".crow").length,lists:crew.querySelectorAll(".se-list").length,rows:[...crew.querySelectorAll("[data-se-row]")].map((el)=>el.dataset.seRow),
        nameCounts:Object.fromEntries(names.map((name)=>[name,[...crew.querySelectorAll("b")].filter((b)=>!b.closest("[data-se-runs-note]")&&b.textContent.trim()===name).length])),
        stepWords:(crew.innerText.match(/\\bsteps?\\b/gi)??[]).length,header:[crew.querySelector(".se-title h4")?.textContent,crew.querySelector(".se-title small")?.textContent],
        menus:[...crew.querySelectorAll(".se-head [data-se-menu]")].map((el)=>el.textContent.trim())}})()`);
    console.log(`W1 scan: ${JSON.stringify(scan)}`);
    assert.deepEqual({ stepRows: scan.stepRows, addStep: scan.addStep, owners: scan.owners, pairs: scan.pairs, grips: scan.grips, oldRows: scan.oldRows, crows: scan.crows }, { stepRows: 0, addStep: 0, owners: 0, pairs: 0, grips: 0, oldRows: 0, crows: 0 }, "no step-editing control and no old seat row anywhere in Settings");
    assert.equal(scan.lists, 1, "one crew list");
    assert.deepEqual(scan.rows, ours.crew.map((seat: any) => seat.slot), "one row per seat, in the crew's order");
    assert.ok(ours.crew.length >= 8, "control: Our process has its eight seats");
    for (const seat of ours.crew) assert.equal(scan.nameCounts[seat.name], 1, `${seat.name} is shown once in the crew section, not in two lists`);
    assert.equal(scan.stepWords, 0, "nothing in the crew section talks about steps");
    assert.deepEqual(scan.header, [ours.setupName, `${ours.crew.length} seats`], "the setup line moved into the crew header");
    assert.deepEqual(scan.menus, ["Switch to…", "Save as setup…"]);
  });
});

test("W2: the role list is the server's roles then Custom; picking Reviewer on a new seat turns Can write off and Coder turns it on; a saved seat's role is a draft too; Save sends role, canWrite and lookPause in one setSetup", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, ours, seed }) => {
    const roles: { name: string; canWrite: boolean }[] = seed.roles ?? [];
    assert.ok(roles.length >= 8 && roles.some((role) => role.name === "Coder" && role.canWrite) && roles.some((role) => role.name === "Reviewer" && !role.canWrite), `control: the server sends its roles (${roles.map((role) => role.name).join(", ")})`);
    await openEditor(ev, waitFor);
    const slot = await addSeat(ev);
    await click(ev, `${ED} [data-se-role="${slot}"]`);
    const listed = await ev(`[...document.querySelectorAll(${J(`${ED} [data-se-rolemenu="${slot}"] [role=option]`)})].map((el)=>({name:el.querySelector(".se-rn b").textContent,access:el.querySelector(".se-ra").textContent}))`);
    console.log(`W2 role list: ${listed.map((item: any) => `${item.name} (${item.access})`).join(", ")}`);
    assert.deepEqual(listed.map((item: any) => item.name), [...roles.map((role) => role.name), "Custom…"], "the server's roles in its order, then Custom");
    assert.deepEqual(listed.slice(0, -1).map((item: any) => item.access), roles.map((role) => role.canWrite ? "Can write" : "Read-only"), "each says its own Can write default");
    const canWrite = (who: string) => ev(`document.querySelector(${J(`${ED} [data-se-canwrite="${who}"]`)}).getAttribute("aria-checked")`);
    await click(ev, `${ED} [data-se-rolemenu="${slot}"] [data-se-pick-role="Coder"]`);
    assert.equal(await canWrite(slot), "true", "Coder: Can write on");
    await pickRole(ev, slot, "Reviewer");
    assert.equal(await canWrite(slot), "false", "Reviewer: Can write off");
    await pickRole(ev, slot, "Coder");
    assert.equal(await canWrite(slot), "true", "Coder again: on");
    await setValue(ev, `${ED} [data-se-name="${slot}"]`, "Quinn");
    // A saved seat: the Coder becomes a Reviewer, so it stops writing, and its row says it changed.
    await pickRole(ev, "coder", "Reviewer");
    assert.equal(await canWrite("coder"), "false");
    assert.match(await ev(`document.querySelector(${J(`${ED} [data-se-row="coder"]`)}).innerText`), /Changed/);
    assert.equal(await ev(`document.querySelector(${J(`${ED} [data-se-look-toggle]`)}).getAttribute("aria-checked")`), String(ours.lookPause === true), "control: the look switch shows the tab's lookPause");
    await click(ev, `${ED} [data-se-look-toggle]`);
    assert.equal((await sentOf(ev, "updateSeat")).length, 0, "nothing applied before Save");
    await click(ev, "#setFoot [data-se-save]");
    const base = baseFor(ours);
    const crew = [...ours.crew.map((seat: any) => seat.slot === "coder" ? bareSeat({ ...seat, role: "Reviewer", canWrite: false }) : bareSeat(seat)), { slot, name: "Quinn", role: "Coder", cli: base.cli, model: base.model, effort: base.effort, canWrite: true, isLeader: false }];
    assert.deepEqual(await sentSetups(ev), [{ type: "setSetup", tabId: ours.id, crew, lookPause: ours.lookPause !== true, rest: {} }], "one setSetup: the whole crew with the roles and Can write, the look switch, and no steps");
  });
});

test("W3: Runs the process shows only on the Planner seat (on, with its plain line); the leader has no role list; a second Planner is offered off with the reason; picking Planner on a seat turns it on", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, ours, seed }) => {
    await openEditor(ev, waitFor);
    const runsNote = () => ev(`document.querySelector(${J(`${ED} [data-se-runs-note]`)}).innerText.trim()`);
    assert.equal(await runsNote(), "Sage runs the process. You talk with Atlas.");
    const found: Record<string, boolean> = {}, advisors: Record<string, boolean> = {};
    for (const seat of ours.crew) {
      await openSeat(ev, seat.slot);
      found[seat.slot] = await ev(`Boolean(document.querySelector(${J(`${ED} [data-se-card="${seat.slot}"] [data-se-runs]`)}))`);
      advisors[seat.slot] = await ev(`Boolean(document.querySelector(${J(`${ED} [data-se-card="${seat.slot}"] [data-se-advisor]`)}))`);
    }
    // The Advisor row follows the CLI's own advisor capability (state.clis), seat by seat.
    const canAdvise = Object.fromEntries(ours.crew.map((seat: any) => [seat.slot, seed.clis.find((cap: any) => cap.id === seat.cli)?.advisor === true]));
    console.log(`W3 Advisor row per seat: ${JSON.stringify(advisors)}`);
    assert.deepEqual(advisors, canAdvise, "an Advisor row exactly where the seat's CLI can take one");
    assert.ok(Object.values(canAdvise).includes(true) && Object.values(canAdvise).includes(false), "control: the crew has seats with and without an advisor");
    console.log(`W3 Runs the process switch per seat: ${JSON.stringify(found)}`);
    assert.equal(Object.keys(found).length, ours.crew.length, "control: every seat's card was opened");
    assert.deepEqual(Object.entries(found).filter(([, has]) => has).map(([slot]) => slot), ["planner"], "only the Planner has the switch");
    await openSeat(ev, "planner");
    assert.deepEqual(await ev(`(()=>{const el=document.querySelector(${J(`${ED} [data-se-runs="planner"]`)});return {on:el.getAttribute("aria-checked"),line:el.closest(".se-r").querySelector(".se-hint").textContent}})()`),
      { on: "true", line: "Sage runs the process: plans, starts the other seats and moves the work on. You talk with Atlas." });
    await openSeat(ev, "leader");
    assert.deepEqual(await ev(`({role:Boolean(document.querySelector(${J(`${ED} [data-se-card="leader"] [data-se-role]`)})),shown:document.querySelector(${J(`${ED} [data-se-card="leader"] .se-static`)})?.textContent})`), { role: false, shown: "Leader" }, "the leader has no role list");
    const slot = await addSeat(ev);
    await click(ev, `${ED} [data-se-role="${slot}"]`);
    assert.deepEqual(await ev(`(()=>{const el=document.querySelector(${J(`${ED} [data-se-rolemenu="${slot}"] [data-se-pick-role="Planner"]`)});return {off:el.disabled,why:el.querySelector("small").textContent}})()`), { off: true, why: "A crew has one Planner: Sage." });
    await click(ev, `${ED} [data-se-role="${slot}"]`);
    await pickRole(ev, "planner", "Reviewer");
    assert.equal(await runsNote(), "Atlas runs the process.", "no Planner: the leader runs it, said once in the header");
    await pickRole(ev, slot, "Planner");
    assert.equal(await ev(`document.querySelector(${J(`${ED} [data-se-runs="${slot}"]`)}).getAttribute("aria-checked")`), "true", "picking Planner turns Runs the process on");
    assert.equal(await runsNote(), "New seat runs the process. You talk with Atlas.");
    await click(ev, "#setFoot [data-se-save]");
    const [sent] = await sentOf(ev, "setSetup");
    assert.deepEqual([sent.crew.find((seat: any) => seat.slot === "planner"), sent.crew.find((seat: any) => seat.slot === slot)?.orchestrates, sent.crew.find((seat: any) => seat.slot === slot)?.role],
      [{ ...bareSeat({ ...ours.crew.find((seat: any) => seat.slot === "planner"), role: "Reviewer", canWrite: false, orchestrates: undefined }), orchestrates: false }, true, "Planner"], "the old planner stops running it, the new Planner runs it");
  });
});

test("W4: a new seat's Name and Role start empty with grey placeholders; Save sends New seat (numbered when taken) and a Helper; a saved seat's cleared name keeps its own; a refusal shows next to Save and the draft stays", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, ours }) => {
    await openEditor(ev, waitFor);
    const first = await addSeat(ev);
    assert.equal(await ev(`document.activeElement?.dataset.focusKey`), `se-name-${first}`, "the new seat's Name takes focus");
    const second = await addSeat(ev);
    const fields = await ev(`[${J(first)},${J(second)}].map((slot)=>{const name=document.querySelector(${J(ED)}+" [data-se-name='"+slot+"']"),role=document.querySelector(${J(ED)}+" [data-se-role='"+slot+"']"),row=document.querySelector(${J(ED)}+" [data-se-row='"+slot+"'] .se-who b");
      return slot===${J(second)}?{value:name.value,placeholder:name.getAttribute("placeholder"),role:role.innerText.trim(),roleGrey:Boolean(role.querySelector(".se-ph")),row:row.textContent,rowGrey:row.classList.contains("se-ph")}:{row:row.textContent}})`);
    console.log(`W4 new seats: ${JSON.stringify(fields)}`);
    assert.deepEqual(fields, [{ row: "New seat" }, { value: "", placeholder: "New seat 2", role: "Choose a role", roleGrey: true, row: "New seat 2", rowGrey: true }], "empty fields with grey placeholders; the second takes the next free name");
    await openSeat(ev, "coder");
    await setValue(ev, `${ED} [data-se-name="coder"]`, "");
    await click(ev, "#setFoot [data-se-save]");
    const [sent] = await sentOf(ev, "setSetup");
    const base = baseFor(ours);
    assert.deepEqual(sent.crew.slice(-2), [first, second].map((slot, index) => ({ slot, name: index ? "New seat 2" : "New seat", role: "Helper", cli: base.cli, model: base.model, effort: base.effort, canWrite: false, isLeader: false })));
    assert.equal(sent.crew.find((seat: any) => seat.slot === "coder").name, ours.crew.find((seat: any) => seat.slot === "coder").name, "a saved seat left without a name keeps its own");
    // The server refuses: the reason shows next to Save, announced once, and the draft stays for another try.
    await ev(`__ccDeliver({type:"error",action:"setSetup",tabId:${J(ours.id)},message:"a crew has at most one Planner"});true`);
    await waitFor(`document.querySelector("#setFoot [data-se-error]")?.textContent==="a crew has at most one Planner"`, "the server's refusal shows next to Save");
    assert.deepEqual(await ev(`({role:document.querySelector("#setFoot [data-se-error]").getAttribute("role"),save:document.querySelector("#setFoot [data-se-save]").hasAttribute("aria-disabled"),rows:document.querySelectorAll(${J(`${ED} [data-se-row]`)}).length})`), { role: "alert", save: false, rows: ours.crew.length + 2 });
  });
});

test("E5: while the tab is busy the editor and its Save bar are locked (every control that waits for Save disabled, nothing sent) and say so; a seat's card still opens, and a saved seat's model and advisor still change; they unlock when the work ends", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, ours }) => {
    await openEditor(ev, waitFor);
    await openSeat(ev, "planner");
    await click(ev, `${ED} [data-se-look-toggle]`); // something to save, so the Save bar shows
    const controls = `[...document.querySelectorAll(${J(`${ED} button, ${ED} input, #setFoot button`)})].filter((el)=>!el.matches("[data-se-row],[data-se-live]"))`;
    assert.equal(await ev(`${controls}.filter((el)=>el.disabled).length<3`), true, "control: idle, the controls are on");
    await deliverTab(ev, ours.id, `tab.derived={...tab.derived,busy:true}`);
    await waitFor(`document.querySelector(${J(`${ED} [data-se-locked]`)})!==null`, "the lock note shows");
    const locked = await ev(`({total:${controls}.length,off:${controls}.filter((el)=>el.disabled).length,bar:document.querySelectorAll("#setFoot [data-se-save]").length})`);
    console.log(`E5 busy: ${locked.off} of ${locked.total} controls disabled, Save bar buttons ${locked.bar}`);
    assert.ok(locked.total >= 10 && locked.bar === 1, "control: the scan found the editor's controls and the Save bar (11 here)");
    assert.equal(locked.off, locked.total, "every control is disabled");
    await ev(`(()=>{for(const sel of ["#setFoot [data-se-save]","${ED} [data-se-add]","${ED} [data-se-runs]","${ED} [data-se-canwrite]","${ED} [data-se-role]","${ED} [data-se-look-toggle]"])document.querySelector(sel)?.dispatchEvent(new MouseEvent("click",{bubbles:true}));return true})()`);
    await delay(200);
    assert.equal((await sentOf(ev, "setSetup")).length + (await sentOf(ev, "updateSeat")).length, 0, "nothing was sent while locked");
    assert.deepEqual(await rowSlots(ev), ours.crew.map((seat: any) => seat.slot), "and no seat was added");
    // Looking is still possible: another seat's card opens, with every control in it off.
    await click(ev, `${ED} [data-se-row="coder"]`);
    assert.deepEqual(await ev(`(()=>{const card=document.querySelector(${J(`${ED} [data-se-card="coder"]`)});const all=card?[...card.querySelectorAll("button,input")]:[];return {open:Boolean(card),controls:all.length,on:all.filter((el)=>!el.disabled).map((el)=>Object.keys(el.dataset).find((k)=>k.startsWith("se")&&k!=="seLive"))}})()`), { open: true, controls: 6, on: ["seModel", "seAdvisor"] }, "the Coder's card opens to look at; only its model and advisor (which the server takes while the tab works) can change");
    await deliverTab(ev, ours.id, `tab.derived={...tab.derived,busy:false}`);
    await waitFor(`document.querySelector(${J(`${ED} [data-se-locked]`)})===null`, "the lock lifts");
    assert.equal(await ev(`${controls}.filter((el)=>el.disabled).length<3`), true, "the controls are on again");
  });
});

test("E7: a seat renamed and then Save pressed sends the new name in that one click (the editor does not redraw between the press and the release); the row follows the new name", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor }) => {
    await openEditor(ev, waitFor);
    await openSeat(ev, "planner");
    // The browser's order for typing then clicking Save: input events, the press on Save, the change as the field loses focus, then the release and the click.
    const kept = await ev(`(async()=>{const input=document.querySelector(${J(`${ED} [data-se-name="planner"]`)});if(!input)return "missing";input.focus();input.value="Sagey";input.dispatchEvent(new Event("input",{bubbles:true}));
      const save=document.querySelector("#setFoot [data-se-save]");if(!save)return "no save";save.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));
      await new Promise((ok)=>setTimeout(ok,80));const still=save.isConnected;save.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}));save.click();return still})()`);
    assert.equal(kept, true, "the Save button pressed is still the one released");
    const sent = await sentOf(ev, "setSetup");
    assert.equal(sent.length, 1, "one click, one setSetup");
    assert.equal(sent[0].crew.find((seat: any) => seat.slot === "planner").name, "Sagey");
    await waitFor(`document.querySelector(${J(`${ED} [data-se-row="planner"] .se-who b`)})?.textContent==="Sagey"`, "the row follows the new name");
  });
});

test("W3b: a Planner that cannot run the process says why and its switch is off: a CLI with no crew tools, a read-only ACP seat; giving the ACP seat Can write lifts it", { timeout: editorTestMs(78_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, ours }) => {
    const acp = (id: string, label: string, crewTools: boolean) => ({ id, label, advisor: false, readOnlyEnforced: false, crewTools, customModel: null, installed: true, models: ["default"], efforts: ["default"] });
    await deliverTab(ev, ours.id, `window.__ccSeed.clis=[...window.__ccSeed.clis.filter((c)=>!c.id.startsWith("acp:")),${J(acp("acp:bare", "Bare", false))},${J(acp("acp:kimi", "Kimi", true))}];const p=tab.crew.find((s)=>s.slot==="planner");Object.assign(p,{cli:"acp:bare",model:"default",effort:"default",canWrite:true});delete p.orchestrates;delete p.advisor`);
    await openEditor(ev, waitFor);
    await openSeat(ev, "planner");
    const runs = () => ev(`(()=>{const el=document.querySelector(${J(`${ED} [data-se-runs="planner"]`)});return {off:el.disabled,why:el.closest(".se-r").querySelector(".se-hint").textContent}})()`);
    assert.deepEqual(await runs(), { off: true, why: "Bare cannot reach the crew tools." });
    await deliverTab(ev, ours.id, `Object.assign(tab.crew.find((s)=>s.slot==="planner"),{cli:"acp:kimi",canWrite:false})`);
    await waitFor(`document.querySelector(${J(`${ED} [data-se-runs="planner"]`)})?.closest(".se-r").textContent.includes("Kimi")`, "the Kimi Planner is drawn");
    assert.deepEqual(await runs(), { off: true, why: "A read-only Kimi seat refuses every permission request, so it cannot use the crew tools." });
    await click(ev, `${ED} [data-se-canwrite="planner"]`);
    assert.deepEqual(await runs(), { off: false, why: "Off: Atlas runs the process." }, "able to write, it can run the process");
  });
});
