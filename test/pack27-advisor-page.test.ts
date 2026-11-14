import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { editorTestMs, J, withPage, skipped, click, setValue, deliver, deliverState } from "./pack18-editor-harness.ts";

const CHIP = '#setModal [data-fc-model="leader"]';
const SELECT = '#setModal [data-fc-advisor="leader"]';

test("P27 picker saves advisor and Off", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, fixed, dataDir, reload, page }) => {
    const preference = () => JSON.parse(readFileSync(join(dataDir, "config", "workspaces.json"), "utf8"))
      .projects.flatMap((project: any) => project.tabs).find((tab: any) => tab.id === fixed.id).fixedCrew.preferences.leader;
    const writes = () => ev(`window.__sent.filter((m)=>m.type==='setCrewAssignment')`);
    // Observe real responses on the app's own socket before the next send. Never inject a response or state.
    const recorder = `(()=>{window.__p27Replies=[];const send=WebSocket.prototype.send;const watched=new WeakSet();
      WebSocket.prototype.send=function(raw){if(!watched.has(this)){watched.add(this);this.addEventListener('message',(e)=>window.__p27Replies.push(JSON.parse(e.data)))}return send.call(this,raw)};return true})()`;
    await page("Page.addScriptToEvaluateOnNewDocument", { source: recorder });
    await ev(recorder);
    await click(ev, "#setBtn");
    assert.equal(await ev(`document.querySelector(${J(SELECT)})?.hidden`), true, "No-model position hides Advisor");
    await click(ev, "#setModal [data-settings-refresh]");
    await waitFor(`document.querySelector(${J(CHIP)}).textContent!=='Choose a model'`, "fake CLI discovery assigned the Leader");
    const original = preference().assignment;
    assert.equal(original.cli, "claude", "the automatic Leader uses the capable fixture CLI");
    const close = async () => { if (await ev("!document.getElementById('pop').hidden")) await page("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 }); };
    const open = async () => {
      const before = await writes();
      await click(ev, CHIP);
      await waitFor(`Boolean(document.querySelector('#pop #mq'))`, "model popup FOUND");
      assert.equal(await ev(`Boolean(document.querySelector('#pop [data-advisor],#pop .fc-advisor'))`), false, "popup has no advisor control");
      assert.deepEqual(await writes(), before, "opening the picker sends no assignment");
    };
    const save = async (act: () => Promise<unknown>, assignment: any) => {
      const before = (await writes()).length;
      await act();
      const sent = (await writes()).slice(before);
      assert.equal(sent.length, 1, `one immediate assignment request: ${JSON.stringify(sent)}`);
      assert.equal(typeof sent[0].requestId, "string"); assert.ok(sent[0].requestId.length > 0);
      assert.deepEqual(sent[0], { type: "setCrewAssignment", requestId: sent[0].requestId, tabId: fixed.id, slot: "leader", assignment });
      const replies = `window.__p27Replies.filter((m)=>m.requestId===${J(sent[0].requestId)}&&(m.type==='actionResult'||m.type==='error'))`;
      await waitFor(`${replies}.length>0`, "correlated server result");
      assert.deepEqual(await ev(replies), [{ type: "actionResult", action: "setCrewAssignment", requestId: sent[0].requestId, tabId: fixed.id, slot: "leader" }]);
      assert.deepEqual(preference(), { source: "user", assignment }, "the real temporary workspaces.json contains the exact choice");
      await waitFor(`document.querySelector(${J(CHIP)})?.disabled===false && document.querySelector(${J(SELECT)})?.dataset.cli===${J(assignment.cli)} && (document.querySelector(${J(SELECT)}).hidden || document.querySelector(${J(SELECT)}).value===${J(assignment.advisor ?? "")})`, "saved assignment broadcast reached the row");
    };
    await waitFor(`document.querySelector(${J(SELECT)})?.hidden===false`, "capable assigned row Advisor FOUND");
    await open(); await close();
    const options: string[] = await ev(`[...document.querySelector(${J(SELECT)}).options].map((o)=>o.value)`);
    assert.equal(options[0], "", "Off is the empty UI intent");
    const advisor = options.find((value) => /fable/i.test(value)) ?? options.find(Boolean);
    assert.ok(advisor, `an advisor option was FOUND: ${JSON.stringify(options)}`);
    const on = { ...original, advisor };
    await save(() => setValue(ev, SELECT, advisor), on);
    await waitFor(`document.querySelector(${J(SELECT)})?.value===${J(advisor)}`, "the saved advisor is selected");
    assert.equal(await ev("document.activeElement.dataset.focusKey"), "fc-advisor-leader", "the select retains focus after saving");
    await reload();
    await click(ev, "#setBtn");
    await open();
    assert.equal(await ev(`document.querySelector(${J(SELECT)}).value`), advisor, "the advisor survives a real page reload");
    assert.deepEqual(preference(), { source: "user", assignment: on });
    // Same-CLI model and effort choices retain the saved advisor.
    const model: string = await ev(`[...document.querySelectorAll('#pop [data-cli="claude"][data-model]')].find((b)=>b.dataset.model!==${J(original.model)})?.dataset.model`);
    assert.ok(model, "another Claude model was FOUND");
    const changed = { ...on, model };
    await save(() => click(ev, `#pop [data-cli="claude"][data-model=${J(model)}]`), changed);
    const effort: string = await ev(`[...document.querySelectorAll('#pop [data-effort]')].find((b)=>b.dataset.effort!==${J(original.effort)})?.dataset.effort`);
    assert.ok(effort, "another effort was FOUND");
    const withEffort = { ...changed, effort };
    await save(() => click(ev, `#pop [data-effort=${J(effort)}]`), withEffort);
    const off = { ...withEffort }; delete off.advisor;
    await save(() => setValue(ev, SELECT, ""), off);
    assert.equal(Object.hasOwn(preference().assignment, "advisor"), false, "Off has no own advisor key on disk");
    await close();
    const autoFrom = await ev("window.__sent.length");
    await click(ev, "#setModal [data-fc-auto]");
    const autoSent = await ev(`window.__sent.slice(${autoFrom}).filter(m=>m.type==='autoAssignCrew')`);
    assert.equal(autoSent.length, 1, "Auto assign sends immediately");
    assert.equal(autoSent[0].tabId, fixed.id);
    await waitFor(`window.__p27Replies.some((m)=>m.type==='actionResult'&&m.action==='autoAssignCrew')`, "Auto assign completed");
    assert.deepEqual(preference(), { source: "user", assignment: off }, "Auto assign preserves user Off");
    await save(() => setValue(ev, SELECT, advisor), withEffort);
    await open();
    // A different CLI must remove the advisor, even while an advisor is currently selected.
    const codexModel: string = await ev(`document.querySelector('#pop [data-cli="codex"][data-model]')?.dataset.model`);
    assert.ok(codexModel, "a Codex model was FOUND");
    const codex = { cli: "codex", model: codexModel, effort: "medium" };
    await save(() => click(ev, `#pop [data-cli="codex"][data-model=${J(codexModel)}]`), codex);
    assert.equal(await ev(`document.querySelector(${J(SELECT)})?.hidden`), true, "incapable CLI hides Advisor");
    const back = { cli: "claude", model: original.model, effort: "medium" };
    await save(() => click(ev, `#pop [data-cli="claude"][data-model=${J(original.model)}]`), back);
    await close();
    await waitFor(`document.querySelector(${J(SELECT)})?.value===''`, "switching back leaves advisor Off");
    await reload();
    await click(ev, "#setBtn");
    await open();
    assert.equal(await ev(`document.querySelector(${J(SELECT)}).value`), "", "Off survives a real page reload");
    assert.deepEqual(preference(), { source: "user", assignment: back });
    assert.deepEqual(await writes(), [], "reload and opening send no assignment");
    await click(ev, '#pop [data-clear-model]');
    const cleared = await ev(`window.__sent.filter(m=>m.type==='clearCrewAssignment')`);
    assert.equal(cleared.length, 1, "clear sends immediately");
    assert.equal(cleared[0].slot, "leader");
    await waitFor(`document.querySelector(${J(CHIP)}).textContent==='Choose a model'`, "Leader has no model");
    assert.equal(await ev(`document.querySelector(${J(SELECT)}).hidden`), true, "cleared position hides Advisor");
    assert.equal(await ev(`document.querySelector(${J(SELECT)}).disabled`), true, "hidden Advisor leaves the tab order");
  }, { fixture: "fixed", realSocket: true });
});

test("P27 advisor control follows capabilities", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, discovered }) => {
    const main = discovered.clis.find((cli: any) => cli.id === "claude");
    const saved = "claude-saved-advisor-not-discovered";
    const seed = structuredClone(discovered);
    seed.clis.push({ ...main, id: "acp:capable", label: "Capable", advisor: true },
      { ...main, id: "acp:incapable", label: "Incapable", advisor: false });
    seed.acpClis = [{ id: "capable", name: "Capable", program: "fake", args: [] }, { id: "incapable", name: "Incapable", program: "fake", args: [] }];
    await deliverState(ev, seed);
    await click(ev, "#setBtn");
    const before = await ev("window.__sent.length");
    for (const cli of ["claude", "codex", "opencode", "acp:incapable", null, "acp:capable"]) {
      const assignment = cli ? { cli, model: main.models[0], effort: "medium", advisor: saved } : null;
      await deliverState(ev, seed, `state.projects[0].tabs[0].fixedCrew.preferences.leader={source:'user',assignment:${J(assignment)}}`);
      const control = await ev(`(()=>{const el=document.querySelector(${J(SELECT)});return el?{hidden:el.hidden,value:el.value,options:[...el.options].map(o=>[o.value,o.textContent]),label:el.getAttribute('aria-label'),title:el.title}:null})()`);
      assert.ok(control, `${cli}: row control FOUND, including when hidden`);
      const capable = cli === "claude" || cli === "acp:capable";
      assert.equal(control.hidden, !capable, `${cli}: visibility follows capability`);
      if (capable) {
        const expected = await ev(`['',${J(saved)},...new Set(modelOptions('claude'))].map(value=>[value,value?'Advisor: '+formatModel('claude',value):'Advisor: Off'])`);
        assert.deepEqual(control.options, expected, "exact friendly options include only this position's saved advisor and Claude catalogue");
        assert.equal(control.value, saved); assert.equal(control.label, "Leader: Advisor");
        assert.equal(control.title, "Applies from your next message.");
        const worker = await ev(`(()=>{const el=document.querySelector('#setModal [data-fc-advisor="planner"]');return {label:el.getAttribute('aria-label'),title:el.title}})()`);
        assert.notEqual(worker.label, control.label, "different positions have different advisor labels");
        assert.match(worker.label, /Planner.*Advisor/);
        assert.equal(worker.title, "Applies to the next run. If this position is in an approved task, ask the Planner to update the plan.");
        await click(ev, CHIP);
        assert.equal(await ev(`Boolean(document.querySelector('#pop #mq'))`), true, "model popup FOUND");
        assert.equal(await ev(`document.querySelectorAll('#pop [data-fc-advisor],#pop [data-advisor],#pop select[aria-label="Advisor"]').length`), 0);
        await ev(`setLayer(document.querySelector('#pop'),false);true`);
      }
    }
    assert.deepEqual(await ev(`window.__sent.slice(${before}).filter(m=>m.type==='setCrewAssignment')`), [], "looking and opening send zero writes");
    await click(ev, "#setModal [data-close]");
    for (const open of ["openProjectDialog(null)", "openAddTab(null)"]) {
      await ev(`${open};true`);
      assert.equal(await ev(`['pCrew','tCrew'].some(id=>{const el=document.getElementById(id);return el&&!el.closest('[hidden]')&&el.querySelector('[data-fc-new-model]')})`), true, "creation position controls FOUND");
      assert.equal(await ev(`document.querySelectorAll('#pCrew [data-fc-advisor],#tCrew [data-fc-advisor],#pCrew [data-advisor],#tCrew [data-advisor]').length`), 0, "creation dialogs have no advisor control");
      await ev(`for(const id of ['projModal','modal']){const el=document.getElementById(id);if(el)setLayer(el,false)};true`);
    }
  }, { fixture: "fixed" });
});

test("P27 advisor select holds the chosen value while saving", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, discovered, fixed }) => {
    await deliverState(ev, discovered);
    await click(ev, "#setBtn");
    const original = discovered.projects[0].tabs[0].fixedCrew.preferences.leader.assignment;
    assert.equal(original.cli, "claude", "capable Leader assignment FOUND");
    const options: string[] = await ev(`[...document.querySelector(${J(SELECT)}).options].map(o=>o.value)`);
    const chosen = options.find(value => value && value !== original.advisor);
    assert.ok(chosen, `different advisor option FOUND: ${JSON.stringify(options)}`);
    const value = () => ev(`document.querySelector(${J(SELECT)}).value`);
    const request = () => ev(`window.__sent.filter(m=>m.type==='setCrewAssignment').at(-1)`);
    await setValue(ev, SELECT, chosen);
    const refused = await request();
    assert.ok(refused?.requestId, "pending advisor request FOUND");
    assert.equal(await value(), chosen, "pending save keeps the chosen advisor before any broadcast");
    await deliverState(ev, discovered);
    assert.equal(await value(), chosen, "unrelated saved-state refresh keeps the pending choice");
    await deliver(ev, { type: "error", action: "setCrewAssignment", requestId: refused.requestId, tabId: fixed.id, slot: "leader", message: "fixture refusal" });
    assert.equal(await value(), original.advisor ?? "", "refusal restores the old saved value");
    await setValue(ev, SELECT, chosen);
    const saved = await request();
    assert.ok(saved?.requestId && saved.requestId !== refused.requestId, "new advisor request FOUND");
    assert.equal(await value(), chosen, "retry keeps the chosen advisor while pending");
    await deliverState(ev, discovered, `state.projects[0].tabs[0].fixedCrew.preferences.leader.assignment.advisor=${J(chosen)};state.requestActions={[${J(saved.requestId)}]:{requestId:${J(saved.requestId)},status:'done',message:'Done'}}`);
    assert.equal(await value(), chosen, "successful state shows the newly saved advisor");
    assert.equal(await ev(`document.querySelector(${J(SELECT)}).disabled`), false, "success settles the pending save");
    await setValue(ev, SELECT, "");
    const off = await request();
    assert.ok(off?.requestId && off.requestId !== saved.requestId, "Off request FOUND");
    assert.equal(await value(), "", "Off also stays selected while pending");
    await deliver(ev, { type: "error", action: "setCrewAssignment", requestId: off.requestId, tabId: fixed.id, slot: "leader", message: "fixture refusal" });
    assert.equal(await value(), chosen, "refused Off restores the saved advisor");
  }, { fixture: "fixed" });
});

test("P27 advisor control guards retained listeners", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, discovered }) => {
    await deliverState(ev, discovered);
    await click(ev, "#setBtn");
    assert.equal(await ev(`Boolean(document.querySelector(${J(SELECT)}))`), true, "advisor control FOUND");
    const held = `window.__heldAdvisor`;
    await ev(`${held}=document.querySelector(${J(SELECT)});${held}.focus();true`);
    await deliverState(ev, discovered);
    assert.equal(await ev(`document.activeElement===${held}&&${held}===document.querySelector(${J(SELECT)})`), true, "broadcast preserves the focused control");
    const reset = () => deliverState(ev, discovered);
    const writes = () => ev(`window.__sent.filter(m=>m.type==='setCrewAssignment')`);
    const forceChange = () => ev(`(()=>{const el=${held};el.disabled=false;el.hidden=false;el.value=[...el.options].find(o=>o.value)?.value??'';el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    // Read current state without redrawing: a retained control cannot trust its old DOM flags.
    for (const [name, change] of [
      ["busy", "currentTab().fixedCrew.busy.leader=true"],
      ["lost capability", "cliCap('claude').advisor=false"],
      ["switched CLI", "currentTab().fixedCrew.preferences.leader.assignment.cli='codex'"],
      ["stale CLI", `${held}.dataset.cli='codex'`],
    ]) {
      await reset();
      const before = await writes();
      await ev(`${change};true`);
      await forceChange();
      assert.deepEqual(await writes(), before, `${name}: retained change sends nothing immediately`);
    }
    await reset();
    await deliverState(ev, discovered, "state.projects[0].tabs[0].fixedCrew.busy.leader=true");
    assert.equal(await ev(`${held}.disabled`), true, "busy disables select");
    await reset();
    // Model saving and instruction saving have independent pending keys.
    for (const kind of ["model", "extra"]) {
      await reset();
      if (kind === "model") await setValue(ev, SELECT, "");
      else {
        await click(ev, '#setModal [data-fc-toggle="leader"]');
        await setValue(ev, '#setModal [data-fc-extra="leader"]', 'extra');
        await click(ev, '#setModal [data-fc-save="leader"]');
      }
      const pending = await ev(`window.__sent.filter(m=>m.type===${J(kind === "model" ? "setCrewAssignment" : "setCrewRoleExtra")}).at(-1)`);
      assert.ok(pending?.requestId, `${kind} saving request FOUND immediately`);
      assert.equal(await ev(`${held}.disabled`), true, `${kind} saving disables select`);
      const before = await writes();
      await forceChange();
      assert.deepEqual(await writes(), before, `${kind} saving: forced retained event sends nothing immediately`);
      await deliver(ev, { type: "error", action: pending.type, requestId: pending.requestId, tabId: pending.tabId, slot: "leader", message: "fixture refusal" });
    }
    await reset();
    await deliverState(ev, discovered, "state.projects[0].tabs[0].fixedCrew.unavailable=true");
    const unavailableHidden = await ev(`${held}.closest('.fc-group')?.hidden`);
    const before = await writes();
    await forceChange();
    assert.deepEqual(await writes(), before, "unavailable retained event sends nothing");
    await reset();
    const from = (await writes()).length;
    await setValue(ev, SELECT, "");
    assert.equal((await writes()).length, from + 1, "idle control sends once, proving the retained event probes were live");
    assert.equal(unavailableHidden, true, "unavailable hides the group that holds the select");
  }, { fixture: "fixed" });
});
