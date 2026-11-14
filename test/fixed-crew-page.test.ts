import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, setValue, deliver, deliverState, press, delay, type Page } from "./pack18-editor-harness.ts";

// Pack 26 Block 2b: the fixed crew in a real headless Chrome running the real page. Its states are the real server's own (harness:
// test/pack18-editor-harness.ts, fixtures "fixed" and "fixed2"), delivered over a fake socket so every outgoing message is recorded
// exactly and every reply can be late, refused or out of order. Saving for real is test/fixed-crew-page-live.test.ts.

const GROUPS = {
  Planning: ["leader", "planner", "researcher", "helper", "secondOpinion"],
  Making: ["coder", "designCoder", "imageMaker", "socialMaker", "videoMaker"],
  Checking: ["reviewer1", "fixer1", "reviewer2", "fixer2", "final", "designFinal", "minimalFixer", "minimalReviewer"],
};
const SAME_MODEL = "The same model will build and review. A second AI provider can make reviews stronger.";
const HOSTILE = `</textarea><img src=x onerror="window.__pwned=1"> &lt;b&gt;bold&lt;/b&gt; & "quoted" 'single'`;
const CREW = ["setCrewAssignment", "clearCrewAssignment", "autoAssignCrew", "setCrewRoleExtra", "resetCrewRoleExtra", "getCrewRolePrompt", "previewCrewAssignments", "addProject", "addTab"];
const ROW = (slot: string) => `#setModal [data-fc-row="${slot}"]`;
const count = (ev: Page["ev"]): Promise<number> => ev("window.__sent.length");
async function sentSince(ev: Page["ev"], from: number, types = CREW): Promise<any[]> {
  const sent = (await ev(`window.__sent.slice(${from})`)).filter((message: any) => types.includes(message.type));
  console.log(`FCUI sent: ${JSON.stringify(sent)}`);
  return sent;
}
const bare = (messages: any[]) => messages.map(({ requestId, ...rest }) => rest);
const unassigned = `for(const tab of state.projects[0].tabs)if(tab.fixedCrew)for(const pref of Object.values(tab.fixedCrew.preferences)){pref.assignment=null;pref.source="auto"}`;
const crewOf = (index = 0) => `state.projects[0].tabs[${index}].fixedCrew`;
async function openSettings(ev: Page["ev"], waitFor: Page["waitFor"]): Promise<void> {
  await click(ev, "#setBtn");
  await waitFor(`Boolean(document.querySelector("#setModal:not([hidden]) [data-fc-tab]"))`, "the fixed crew section in Settings");
}
const row = (ev: Page["ev"], slot: string): Promise<any> => ev(`(()=>{const r=document.querySelector(${J(ROW(slot))});if(!r)return null;const q=(s)=>r.querySelector(s);
  return {label:q(".fc-label").textContent,source:q(".fc-source").textContent,chip:q(".fc-model").textContent,chipOff:q(".fc-model").disabled,notice:q(".fc-notice").hidden?null:q(".fc-notice").textContent,
    check:!q(".fc-check").hidden,busy:!q(".fc-busy").hidden,extra:q(".fc-extra").value,status:q(".fc-extra-status").textContent,save:!q("[data-fc-save]").disabled,reset:!q("[data-fc-reset]").disabled,open:!q(".fc-panel").hidden}})()`);
async function typeInto(ev: Page["ev"], page: Page["page"], slot: string, text: string, caretToEnd = true): Promise<void> {
  const found = await ev(`(()=>{const a=document.querySelector(${J(`${ROW(slot)} .fc-extra`)});if(!a||!a.getClientRects().length)return false;a.focus();${caretToEnd ? "a.setSelectionRange(a.value.length,a.value.length);" : ""}return document.activeElement===a})()`);
  assert.equal(found, true, `the shown extra instructions field of ${slot} was FOUND and focused`);
  await page("Input.insertText", { text });
}
async function expand(ev: Page["ev"], slot: string): Promise<void> {
  if (!(await row(ev, slot)).open) await click(ev, `${ROW(slot)} [data-fc-toggle]`);
  assert.equal((await row(ev, slot)).open, true, `${slot}'s Instructions opened`);
}
const reply = (ev: Page["ev"], action: string, requestId: string, extra: any = {}) => deliver(ev, { type: "actionResult", action, requestId, ...extra });

test("FCUI Settings lists exactly the 18 fixed positions in Planning, Making and Checking, unassigned, with one editor per tab, separate choices and drafts on a second fixed tab, and the fixed tab's task panel", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, discovered, fixed, secondFixed }) => {
    const work = await ev(`(()=>{const shown=(s)=>Boolean(document.querySelector(s)?.getClientRects().length);return {work:shown("#fixedView #fcWorkSettings"),rail:shown("#fcRailSettings"),view:shown("#view"),sline:shown("#sline"),steps:shown("#stepsWrap"),runs:document.querySelectorAll("[data-run-seat],[data-stop-seat]").length,text:document.querySelector("#fixedView").innerText}})()`);
    console.log(`FCUI work view: ${JSON.stringify(work)}`);
    // Block 3c: the setup-only view is gone. With no leader assigned yet, the panel says what is needed in the server's words.
    assert.deepEqual({ ...work, text: "" }, { work: true, rail: true, view: true, sline: true, steps: false, runs: 0, text: "" }, "a fixed tab shows its task panel and the page's own views, never the legacy step bar");
    assert.doesNotMatch(work.text, /arrives in the next update|setting it up/);
    assert.match(work.text, /Leader has no model\. Choose one in Settings before continuing\./);
    await click(ev, "#setupsBtn");
    await waitFor(`Boolean(document.querySelector("#setModal:not([hidden]) [data-fc-tab]"))`, "the rail's crew control opened Settings");
    const groups = await ev(`Object.fromEntries([...document.querySelectorAll("#setModal [data-fc-group]")].map((g)=>[g.dataset.fcGroup,[...g.querySelectorAll("[data-fc-row]")].map((r)=>r.dataset.fcRow)]))`);
    console.log(`FCUI matched slots: ${JSON.stringify(groups)}`);
    assert.deepEqual(groups, GROUPS, "exactly the 18 positions, each in its own group, in order");
    assert.equal(new Set(Object.values(groups).flat()).size, 18, "every position appears once across the groups");
    const rows = Object.fromEntries(await Promise.all(Object.values(GROUPS).flat().map(async (slot) => [slot, await row(ev, slot)])));
    for (const [slot, info] of Object.entries(rows)) assert.deepEqual([info.source, info.chip], ["No model assigned", "Choose a model"], slot);
    assert.equal(new Set(Object.values(rows).map((info) => info.label)).size, 18, "no two positions read alike");
    assert.deepEqual(["reviewer1", "fixer1", "reviewer2", "fixer2"].map((slot) => rows[slot].label), ["Reviewer · odd rounds", "Fixer · odd rounds", "Reviewer · even rounds", "Fixer · even rounds"]);
    const editors = `({fixed:document.querySelectorAll("#setModal [data-fc-tab]").length,old:document.querySelectorAll("#setModal [data-setup-editor]").length,mounts:["setFoot","setLive"].filter((id)=>document.getElementById(id)).length+document.querySelectorAll("[data-setup-editor],[data-setup-editor-foot]").length,head:document.querySelector("#s-crew h3")?.textContent})`;
    assert.deepEqual({ ...(await ev(editors)), head: "" }, { fixed: 1, old: 0, mounts: 0, head: "" }, "a fixed tab mounts only the new editor; #setFoot, #setLive and every old editor mount are absent");
    // The second fixed tab is a real tab of its own: one mounted fixed section with its own heading and preferences, no old editor, no Save bar.
    const showTab = async (tabId: string) => {
      await click(ev, "#setModal [data-close]");
      await click(ev, `#tabs [role=tab][data-tab-id="${tabId}"]`);
      await waitFor(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId===${J(tabId)}`, `the tab ${tabId} is shown`);
      await openSettings(ev, waitFor);
      await waitFor(`document.querySelector("#setModal [data-fc-tab]")?.dataset.fcTab===${J(tabId)}`, `the fixed section of ${tabId}`);
    };
    await showTab(secondFixed.id);
    const second = await ev(`({...${editors},title:document.querySelector("#setModal .fc-title")?.textContent??null,tab:document.querySelector("#setModal [data-fc-tab]").dataset.fcTab,slots:[...document.querySelectorAll("#setModal [data-fc-row]")].map((r)=>r.dataset.fcRow)})`);
    console.log(`FCUI second fixed tab: ${JSON.stringify(second)}`);
    assert.deepEqual({ ...second, head: "", title: "", slots: [] }, { fixed: 1, old: 0, mounts: 0, head: "", title: "", tab: secondFixed.id, slots: [] }, "the second fixed tab mounts exactly one fixed section and no old editor or Save bar");
    assert.match(second.title, /^Crew and models · .+/, "the second tab's own heading");
    assert.deepEqual(second.slots, Object.values(GROUPS).flat(), "its own 18 positions, each once");
    assert.equal(await ev(`Boolean(document.querySelector("#view").getClientRects().length)&&document.querySelector("#stage").classList.contains("fixed-crew")`), true, "and the fixed tab's own main view");
    // Choices and drafts belong to their tab: two different models, two different drafts, kept across a switch away and back.
    const [codex, claude] = ["codex", "claude"].map((id) => discovered.clis.find((cli: any) => cli.id === id));
    const picks = [{ cli: "codex", model: codex.models[0], effort: codex.efforts[0] }, { cli: "claude", model: claude.models[0], effort: claude.efforts[0] }];
    const separate = `${unassigned};${crewOf(0)}.preferences.coder={source:"user",assignment:${J(picks[0])}};${crewOf(1)}.preferences.coder={source:"user",assignment:${J(picks[1])}}`;
    await deliverState(ev, discovered, separate);
    await expand(ev, "coder"); await typeInto(ev, page, "coder", "second tab draft");
    const secondChip = (await row(ev, "coder")).chip;
    await showTab(fixed.id);
    const firstRow = await row(ev, "coder");
    assert.notEqual(firstRow.chip, secondChip, "the first tab keeps its own model choice");
    assert.equal(firstRow.extra, "", "the first tab has no draft of the second tab's text");
    await expand(ev, "coder"); await typeInto(ev, page, "coder", "first tab draft");
    await showTab(secondFixed.id);
    assert.deepEqual([(await row(ev, "coder")).chip, (await row(ev, "coder")).extra], [secondChip, "second tab draft"], "back on the second tab: its model and draft are kept");
    await showTab(fixed.id);
    assert.deepEqual([(await row(ev, "coder")).chip, (await row(ev, "coder")).extra], [firstRow.chip, "first tab draft"], "back on the first tab: its model and draft are kept");
  }, { fixture: "fixed2" });
});

test("FCUI the shared model menu: unassigned, manual set, effort, clear, Auto assign, server sources, ACP default and the notices", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed }) => {
    await deliverState(ev, discovered, unassigned);
    await openSettings(ev, waitFor);
    await click(ev, `${ROW("coder")} [data-fc-model]`);
    await waitFor(`!document.querySelector("#pop").hidden&&Boolean(document.querySelector("#pop #mq"))`, "the model menu");
    const menu = await ev(`(()=>{const p=document.querySelector("#pop");return {pressed:p.querySelectorAll("[data-model][aria-pressed=true]").length,none:p.querySelector("[data-clear-model]")?.getAttribute("aria-pressed"),effort:p.querySelectorAll("[data-effort]").length,clis:[...new Set([...p.querySelectorAll("[data-model]")].map((b)=>b.dataset.cli))],hint:p.innerText.includes("No model assigned yet"),focus:document.activeElement?.id}})()`);
    console.log(`FCUI unassigned menu: ${JSON.stringify(menu)}`);
    assert.deepEqual(menu, { pressed: 0, none: "true", effort: 0, clis: ["claude", "codex"], hint: true, focus: "mq" }, "no fake CLI, no tick and no effort before a model is chosen");
    const codex = discovered.clis.find((cli: any) => cli.id === "codex"), model = await ev(`document.querySelector('#pop [data-cli="codex"][data-model]').dataset.model`);
    const effort = codex.efforts.includes("medium") ? "medium" : codex.efforts[0], chosen = { cli: "codex", model, effort };
    let from = await count(ev);
    await click(ev, `#pop [data-cli="codex"][data-model="${model}"]`);
    const set = await sentSince(ev, from);
    assert.deepEqual(bare(set), [{ type: "setCrewAssignment", tabId: fixed.id, slot: "coder", assignment: chosen }]);
    assert.match(set[0].requestId, /^[0-9a-f]{32}$/);
    await deliverState(ev, discovered, `${unassigned};${crewOf()}.preferences.coder={source:"user",assignment:${J(chosen)}}`);
    await reply(ev, "setCrewAssignment", set[0].requestId, { tabId: fixed.id, slot: "coder" });
    const efforts = await ev(`[...document.querySelectorAll("#pop [data-effort]")].map((b)=>[b.dataset.effort,b.getAttribute("aria-checked")])`);
    assert.deepEqual(efforts, codex.efforts.map((value: string) => [value, String(value === effort)]), "the effort row appears once a model that has one is chosen");
    const other = codex.efforts.find((value: string) => value !== effort);
    from = await count(ev);
    await click(ev, `#pop [data-effort="${other}"]`);
    assert.deepEqual(bare(await sentSince(ev, from)), [{ type: "setCrewAssignment", tabId: fixed.id, slot: "coder", assignment: { ...chosen, effort: other } }]);
    assert.match((await row(ev, "coder")).source, /^Your choice · Codex$/);
    await click(ev, `${ROW("coder")} [data-fc-model]`);
    from = await count(ev);
    await click(ev, "#pop [data-clear-model]");
    await click(ev, "#setModal [data-fc-auto]");
    assert.deepEqual(bare(await sentSince(ev, from)), [{ type: "clearCrewAssignment", tabId: fixed.id, slot: "coder" }, { type: "autoAssignCrew", tabId: fixed.id }]);
    // The browser shows the server's sources: a manual clear stays cleared while Auto assign fills the rest.
    await deliverState(ev, discovered, `${crewOf()}.preferences.coder={source:"user",assignment:null}`);
    const auto = await row(ev, "planner"), cleared = await row(ev, "coder");
    assert.equal(cleared.source, "No model assigned · you cleared it");
    assert.match(auto.source, /^Automatic · /);
    // ACP: picked only after the Full access question, always with its own default model and effort. Nothing is sent before the answer, and Cancel sends nothing.
    await deliverState(ev, discovered, `state.clis.push({...state.clis.find((c)=>c.id==="codex"),id:"acp:kimi",label:"Kimi",installed:true,models:["default"],efforts:["default"]});state.acpClis=[{id:"kimi",name:"Kimi",program:"kimi",args:[],kind:"acp:kimi"}]`);
    const WRITES = [...CREW, "updateSeat", "setAdvisor"], acpChoice = `#pop [data-cli="acp:kimi"][data-model="default"]`;
    await click(ev, `${ROW("helper")} [data-fc-model]`);
    assert.equal(await ev(`document.querySelectorAll(${J(acpChoice)}).length`), 1, "control: the ACP choice was FOUND exactly once in the helper's menu");
    from = await count(ev);
    await click(ev, acpChoice);
    await waitFor(`!document.querySelector("#confirmModal").hidden`, "the Full access question");
    const asked = await ev(`({title:document.querySelector("#confirmTitle").textContent,body:document.querySelector("#confirmBody").textContent,ok:document.querySelector("#confirmOk").textContent})`);
    assert.match(asked.title, /^Use Kimi as .+'s CLI\?$/, "the question names the CLI");
    assert.match(asked.body, /may edit files and run commands without asking/, "the warning says it runs with Full access");
    assert.equal(asked.ok, "Use with Full access");
    assert.deepEqual(await sentSince(ev, from, WRITES), [], "nothing is sent before the question is answered");
    await click(ev, "#confirmCancel");
    assert.deepEqual(await sentSince(ev, from, WRITES), [], "Cancel sends no assignment");
    await click(ev, `${ROW("helper")} [data-fc-model]`);
    assert.equal(await ev(`document.querySelectorAll(${J(acpChoice)}).length`), 1, "the reopened menu offers the ACP choice again");
    await click(ev, acpChoice);
    await waitFor(`!document.querySelector("#confirmModal").hidden`, "the Full access question again");
    await click(ev, "#confirmOk");
    assert.deepEqual(bare(await sentSince(ev, from, WRITES)), [{ type: "setCrewAssignment", tabId: fixed.id, slot: "helper", assignment: { cli: "acp:kimi", model: "default", effort: "default" } }], "confirming sends exactly one fixed assignment for the helper, and no updateSeat or setAdvisor");
    // The server's independence notice and the check hint never block anything.
    const vendor = { cli: "opencode", model: "vendor/model", effort: "max" };
    await deliverState(ev, discovered, `const c=${crewOf()};c.notices.reviewer1={status:"same-model",blocking:false,message:${J(SAME_MODEL)}};c.preferences.helper={source:"auto",assignment:${J(vendor)}};c.preferences.researcher={source:"auto",assignment:{cli:"acp:kimi",model:"default",effort:"default"}};c.preferences.planner={source:"user",assignment:${J(vendor)}};state.clis.push({...state.clis.find((x)=>x.id==="codex"),id:"acp:kimi",label:"Kimi",installed:true,models:["default"],efforts:["default"]})`);
    const notes = Object.fromEntries(await Promise.all(["reviewer1", "helper", "researcher", "planner", "coder"].map(async (slot) => [slot, await row(ev, slot)])));
    console.log(`FCUI notices: ${JSON.stringify(Object.fromEntries(Object.entries(notes).map(([slot, info]: any) => [slot, [info.notice, info.check]])))}`);
    assert.equal(notes.reviewer1.notice, SAME_MODEL);
    assert.deepEqual(["helper", "researcher", "planner", "coder"].map((slot) => notes[slot].check), [true, true, false, false], "only automatic OpenCode and ACP picks ask to be checked");
    from = await count(ev);
    await click(ev, `${ROW("reviewer1")} [data-fc-model]`);
    await click(ev, `#pop [data-cli="claude"][data-model]`);
    assert.equal((await sentSince(ev, from)).filter((message) => message.slot === "reviewer1").length, 1, "the same-model notice does not block a change");
  }, { fixture: "fixed" });
});

test("FCUI extra instructions: built-in text, literal hostile text, broadcasts while typing, newer text, refusal, disconnect, out-of-order replies, busy seats, per-tab drafts and the keyboard", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, page, discovered, fixed, secondFixed }) => {
    await deliverState(ev, discovered);
    await openSettings(ev, waitFor);
    let from = await count(ev);
    await expand(ev, "coder");
    const ask = await sentSince(ev, from);
    assert.deepEqual(bare(ask), [{ type: "getCrewRolePrompt", slot: "coder" }]);
    await deliver(ev, { type: "crewRolePrompt", requestId: ask[0].requestId, slot: "coder", defaultsVersion: discovered.crewDefaultsVersion, core: "You are the Coder. Core rules.", guidance: "Implement the brief." });
    assert.deepEqual(await ev(`(()=>{const c=document.querySelector(${J(`${ROW("coder")} .fc-core`)});return [c.innerText.includes("You are the Coder. Core rules."),c.innerText.includes("Implement the brief."),c.querySelectorAll("textarea,input,[contenteditable]").length]})()`), [true, true, 0], "the built-in text is shown read-only");
    await typeInto(ev, page, "coder", HOSTILE);
    from = await count(ev);
    await click(ev, `${ROW("coder")} [data-fc-save]`);
    const saved = await sentSince(ev, from);
    assert.deepEqual(bare(saved), [{ type: "setCrewRoleExtra", tabId: fixed.id, slot: "coder", text: HOSTILE }], "the typed text is sent exactly");
    await deliverState(ev, discovered, `${crewOf()}.roleExtras.coder=${J(HOSTILE)}`);
    await reply(ev, "setCrewRoleExtra", saved[0].requestId);
    assert.deepEqual([(await row(ev, "coder")).extra, (await row(ev, "coder")).status], [HOSTILE, "Saved"]);
    // A saved value the field did not show yet arrives from the server: it is written literally, never parsed.
    await expand(ev, "helper");
    await deliverState(ev, discovered, `${crewOf()}.roleExtras.coder=${J(HOSTILE)};${crewOf()}.roleExtras.helper=${J(HOSTILE)}`);
    const literal = await ev(`({value:document.querySelector(${J(`${ROW("helper")} .fc-extra`)}).value,pwned:window.__pwned??null,images:document.querySelectorAll("#setModal .fc-panel img").length})`);
    console.log(`FCUI literal: ${JSON.stringify(literal)}`);
    assert.deepEqual(literal, { value: HOSTILE, pwned: null, images: 0 });
    from = await count(ev);
    await click(ev, `${ROW("helper")} [data-fc-reset]`);
    assert.deepEqual(bare(await sentSince(ev, from)), [{ type: "resetCrewRoleExtra", tabId: fixed.id, slot: "helper" }]);
    const base = `${crewOf()}.roleExtras.coder=${J(HOSTILE)};${crewOf()}.roleExtras.helper=${J(HOSTILE)}`;
    // A broadcast while typing keeps the text, the focus, a caret in the middle and the Settings scroll.
    await typeInto(ev, page, "coder", "\nline two");
    const before = await ev(`(()=>{const a=document.activeElement;a.setSelectionRange(5,5);const b=document.querySelector("#setBody");b.scrollTop=Math.min(260,b.scrollHeight-b.clientHeight);a.focus({preventScroll:true});return {id:a.id,value:a.value,caret:[a.selectionStart,a.selectionEnd],scroll:b.scrollTop}})()`);
    await deliverState(ev, discovered, `${base};${crewOf()}.preferences.planner.source="user"`);
    const after = await ev(`(()=>{const a=document.activeElement;return {id:a.id,value:a.value,caret:[a.selectionStart,a.selectionEnd],scroll:document.querySelector("#setBody").scrollTop}})()`);
    console.log(`FCUI focus/caret/scroll before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    assert.ok(before.scroll > 0 && before.caret[0] === 5 && before.value === `${HOSTILE}\nline two`, "control: typed, a caret in the middle and Settings scrolled");
    assert.deepEqual(after, before);
    // Newer typing while Save waits survives the reply; a refusal keeps the text; replies settle only their own position.
    await expand(ev, "researcher");
    await typeInto(ev, page, "researcher", "first");
    from = await count(ev);
    await click(ev, `${ROW("researcher")} [data-fc-save]`);
    const first = (await sentSince(ev, from))[0];
    await typeInto(ev, page, "researcher", " second");
    await deliverState(ev, discovered, `${base};${crewOf()}.roleExtras.researcher="first"`);
    await reply(ev, "setCrewRoleExtra", first.requestId);
    assert.deepEqual([(await row(ev, "researcher")).extra, (await row(ev, "researcher")).status, (await row(ev, "researcher")).save], ["first second", "Not saved yet", true]);
    await expand(ev, "planner"); await typeInto(ev, page, "planner", "refused text");
    from = await count(ev); await click(ev, `${ROW("planner")} [data-fc-save]`);
    const refused = (await sentSince(ev, from))[0];
    await deliver(ev, { type: "error", message: "Extra instructions are too long", action: "setCrewRoleExtra", requestId: refused.requestId });
    assert.deepEqual([(await row(ev, "planner")).extra, (await row(ev, "planner")).status, (await row(ev, "planner")).save], ["refused text", "Not saved: Extra instructions are too long", true]);
    await expand(ev, "designCoder"); await typeInto(ev, page, "designCoder", "A");
    await expand(ev, "imageMaker"); await typeInto(ev, page, "imageMaker", "B");
    from = await count(ev);
    await click(ev, `${ROW("designCoder")} [data-fc-save]`); await click(ev, `${ROW("imageMaker")} [data-fc-save]`);
    const [a, b] = await sentSince(ev, from);
    const both = `${base};${crewOf()}.roleExtras.researcher="first";${crewOf()}.roleExtras.designCoder="A";${crewOf()}.roleExtras.imageMaker="B"`;
    await deliverState(ev, discovered, both);
    await reply(ev, "setCrewRoleExtra", b.requestId);
    assert.deepEqual([(await row(ev, "designCoder")).status, (await row(ev, "imageMaker")).status], ["Saving…", "Saved"], "the later reply settles only its own position");
    await reply(ev, "setCrewRoleExtra", a.requestId);
    assert.deepEqual([(await row(ev, "designCoder")).status, (await row(ev, "imageMaker")).status], ["Saved", "Saved"]);
    await expand(ev, "videoMaker"); await typeInto(ev, page, "videoMaker", "lost reply");
    from = await count(ev); await click(ev, `${ROW("videoMaker")} [data-fc-save]`);
    const lost = (await sentSince(ev, from))[0];
    await ev("window.__socket.close()");
    await waitFor(`document.querySelector(${J(`${ROW("videoMaker")} .fc-extra-status`)}).textContent.startsWith("Not confirmed")`, "a dropped connection makes the save unknown");
    await waitFor(`window.__socket.readyState===1&&document.querySelector("#conn").hidden`, "the page reconnected");
    assert.deepEqual([(await row(ev, "videoMaker")).extra, (await row(ev, "videoMaker")).status.startsWith("Not confirmed")], ["lost reply", true]);
    await deliverState(ev, discovered, `${both};${crewOf()}.roleExtras.videoMaker="lost reply";state.requestActions={[${J(lost.requestId)}]:{requestId:${J(lost.requestId)},status:"done",message:"Done"}}`);
    assert.equal((await row(ev, "videoMaker")).status, "Saved", "the server's finished-request list settles it after the reconnect");
    // A working seat: nothing can be sent for it, even from a control that missed its disabled state.
    await expand(ev, "fixer1"); await typeInto(ev, page, "fixer1", "while busy");
    await deliverState(ev, discovered, `${both};${crewOf()}.busy.fixer1=true`);
    assert.deepEqual([(await row(ev, "fixer1")).busy, (await row(ev, "fixer1")).chipOff, (await row(ev, "fixer1")).save], [true, true, false]);
    from = await count(ev);
    await ev(`(()=>{const b=document.querySelector(${J(`${ROW("fixer1")} [data-fc-save]`)});b.dispatchEvent(new MouseEvent("click",{bubbles:true}));b.disabled=false;b.click();return true})()`);
    await delay(150);
    assert.deepEqual(await sentSince(ev, from), [], "zero messages for a busy seat");
    // Drafts belong to their tab and position.
    await expand(ev, "final"); await typeInto(ev, page, "final", "tab one draft");
    await click(ev, "#setModal [data-close]");
    await click(ev, `#tabs [role=tab][data-tab-id="${secondFixed.id}"]`);
    await openSettings(ev, waitFor);
    assert.equal(await ev(`document.querySelector("#setModal [data-fc-tab]").dataset.fcTab`), secondFixed.id);
    await expand(ev, "final");
    assert.equal((await row(ev, "final")).extra, "", "the other tab has its own empty draft");
    await typeInto(ev, page, "final", "tab two draft");
    await click(ev, "#setModal [data-close]");
    await click(ev, `#tabs [role=tab][data-tab-id="${fixed.id}"]`);
    await openSettings(ev, waitFor);
    assert.deepEqual([(await row(ev, "final")).extra, (await row(ev, "final")).open, (await row(ev, "researcher")).extra], ["tab one draft", true, "first second"]);
    // Keyboard: Tab and Shift+Tab move, Enter opens the menu, Escape closes the innermost layer and gives focus back, Space opens Instructions.
    const focusKey = `document.activeElement?.dataset.focusKey??document.activeElement?.id`;
    await ev(`document.querySelector("#setModal [data-fc-auto]").focus()`);
    await press(page, "Tab"); assert.equal(await ev(focusKey), "fc-advisor-leader");
    await press(page, "Tab"); assert.equal(await ev(focusKey), "fc-model-leader");
    await press(page, "Tab", true); assert.equal(await ev(focusKey), "fc-advisor-leader");
    await press(page, "Tab", true); assert.equal(await ev(focusKey), "fc-auto");
    await press(page, "Tab"); await press(page, "Tab"); await press(page, "Enter");
    await waitFor(`!document.querySelector("#pop").hidden&&document.activeElement?.id==="mq"`, "Enter opened the leader's model menu");
    await page("Input.insertText", { text: "son" });
    await deliverState(ev, discovered, both);
    assert.deepEqual(await ev(`[document.activeElement?.id,document.querySelector("#mq").value]`), ["mq", "son"], "a broadcast keeps focus and search in the open menu");
    await press(page, "Escape");
    assert.deepEqual(await ev(`[document.querySelector("#pop").hidden,document.querySelector("#setModal").hidden,${focusKey}]`), [true, false, "fc-model-leader"], "Escape closed only the menu and returned to its opener");
    await press(page, "Tab"); await press(page, " ");
    assert.equal((await row(ev, "leader")).open, true, "Space opened the leader's Instructions");
    await press(page, "Escape");
    assert.equal(await ev(`document.querySelector("#setModal").hidden`), true, "the next Escape closed Settings");
  }, { fixture: "fixed2" });
});

test("FCUI New project and Add a tab: per-position picks, one-click Auto assign, matched previews, create, refusal and cancel", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed, work }) => {
    await deliverState(ev, discovered, unassigned);
    await ev(`window.cc.pickFolder=async()=>${J(work)}`);
    await click(ev, "#addProj");
    await waitFor(`!document.querySelector("#projModal").hidden`, "the New project dialog");
    const shape = `(()=>{const m=document.querySelector("#projModal"),shown=(s)=>Boolean(m.querySelector(s)?.getClientRects().length);return {legacy:document.querySelectorAll("#pKind,#pTpl,#kindBox,#tplBox,#projModal [data-kind],#projModal [data-template],#modal [data-kind],#modal [data-template]").length,crew:shown("#pCrew"),name:shown("#pName"),folder:shown("#pBrowse"),only:shown("#pOnly"),rows:[...m.querySelectorAll("[data-fc-new-row]")].map((r)=>r.dataset.fcNewRow),sources:[...new Set([...m.querySelectorAll(".fc-source")].map((s)=>s.textContent))]}})()`;
    const opened = await ev(shape);
    console.log(`FCUI New project: ${JSON.stringify(opened)}`);
    assert.deepEqual(opened, { legacy: 0, crew: true, name: true, folder: true, only: true, rows: Object.values(GROUPS).flat(), sources: ["No model assigned"] });
    await setValue(ev, "#pName", "FCUI project");
    await click(ev, "#pBrowse");
    await waitFor(`!document.querySelector("#createProj").disabled`, "Create project is enabled with no model chosen");
    const model = (cli: string) => ev(`document.querySelector('#pop [data-cli="${cli}"][data-model]').dataset.model`);
    const effortOf = (cli: string) => { const efforts = discovered.clis.find((cap: any) => cap.id === cli).efforts; return efforts.includes("medium") ? "medium" : efforts[0]; };
    await click(ev, `#pCrew [data-fc-new-model="coder"]`);
    const coder = { cli: "codex", model: await model("codex"), effort: effortOf("codex") };
    await click(ev, `#pop [data-cli="codex"][data-model="${coder.model}"]`);
    await click(ev, "#projModal [data-fc-new-model=reviewer1]");
    const reviewer = { cli: "claude", model: await model("claude"), effort: effortOf("claude") };
    await click(ev, `#pop [data-cli="claude"][data-model="${reviewer.model}"]`);
    let from = await count(ev);
    await click(ev, "#pCrew [data-fc-new-auto]");
    await click(ev, `#pCrew [data-fc-new-model="coder"]`); await click(ev, "#pop [data-clear-model]");
    const previews = await sentSince(ev, from);
    assert.deepEqual(previews.map(({ type, choices, autoAssign }) => ({ type, choices, autoAssign })), [
      { type: "previewCrewAssignments", choices: { coder, reviewer1: reviewer }, autoAssign: true },
      { type: "previewCrewAssignments", choices: { coder: null, reviewer1: reviewer }, autoAssign: true },
    ], "Auto assign and each later pick ask for a preview with the user's own choices only");
    assert.equal(previews[0].draftId, previews[1].draftId);
    const auto = discovered.projects[0].tabs[0].fixedCrew.preferences, planner = auto.planner.assignment;
    const preview = (requestId: string, draftId: string, plannerAssignment: any) => ({ type: "crewAssignmentsPreview", requestId, draftId, fixedCrew: { version: 1, roleExtras: {}, preferences: { ...auto, planner: { source: "auto", assignment: plannerAssignment }, coder: { source: "user", assignment: null }, reviewer1: { source: "user", assignment: reviewer } } } });
    await deliver(ev, preview(previews[1].requestId, previews[1].draftId, planner));
    await deliver(ev, preview(previews[0].requestId, previews[0].draftId, null));
    await deliver(ev, preview(previews[1].requestId, "another-draft", null));
    const shown = await ev(`Object.fromEntries([...document.querySelectorAll("#pCrew [data-fc-new-row]")].map((r)=>[r.dataset.fcNewRow,r.querySelector(".fc-source").textContent]))`);
    console.log(`FCUI preview rows: ${JSON.stringify(shown)}`);
    assert.match(shown.planner, /^Automatic · /, "only the latest preview of this dialog is shown");
    assert.deepEqual([shown.coder, shown.reviewer1.startsWith("Your choice")], ["No model assigned · you cleared it", true]);
    from = await count(ev);
    await click(ev, "#createProj");
    const [create] = await sentSince(ev, from);
    assert.deepEqual(Object.keys(create).sort(), ["autoAssign", "crewChoices", "fixedCrewVersion", "folder", "id", "name", "projectOnly", "requestId", "tabFolder", "type"], "no kind, template or source is sent");
    assert.deepEqual(["kind", "template"].map((key) => Object.hasOwn(create, key)), [false, false], "no own kind or template property");
    assert.deepEqual([create.type, create.name, create.fixedCrewVersion, create.autoAssign, create.crewChoices], ["addProject", "FCUI project", 1, true, { coder: null, reviewer1: reviewer }]);
    await deliver(ev, { type: "error", message: "project folder folder does not exist", action: "addProject", requestId: create.requestId });
    assert.deepEqual(await ev(`[document.querySelector("#projModal").hidden,document.querySelector("#npStat").textContent,document.querySelector("#pName").value,document.querySelector('#pCrew [data-fc-new-row="reviewer1"] .fc-source').textContent.startsWith("Your choice")]`), [false, "Not created: project folder folder does not exist", "FCUI project", true], "a refusal keeps the whole form");
    from = await count(ev);
    await click(ev, "#projModal [data-close]");
    await click(ev, "#addProj");
    assert.deepEqual((await ev(shape)).sources, ["No model assigned"], "Cancel kept nothing: the next dialog starts fresh");
    await click(ev, "#projModal [data-close]");
    assert.deepEqual(await sentSince(ev, from, ["addProject", "addTab"]), [], "Cancel sent nothing");
    await click(ev, "#addtab");
    await waitFor(`!document.querySelector("#modal").hidden&&!document.querySelector("#createTab").disabled`, "the Add a tab dialog");
    assert.deepEqual(await ev(`[document.querySelectorAll("#kindBox,#tplBox,#modal [data-kind],#modal [data-template]").length,Boolean(document.querySelector("#tCrew")?.getClientRects().length)]`), [0, true], "the Add a tab dialog has no kind or template nodes, only the fixed crew");
    from = await count(ev);
    await click(ev, "#createTab");
    const [tab] = await sentSince(ev, from);
    assert.deepEqual({ ...tab, requestId: typeof tab.requestId }, { type: "addTab", projectId: discovered.projects[0].id, name: "Development", requestId: "string", fixedCrewVersion: 1, crewChoices: {}, autoAssign: false, folder: fixed.folder, projectOnly: true });
    assert.deepEqual(["kind", "template"].map((key) => Object.hasOwn(tab, key)), [false, false], "no own kind or template property");
  }, { fixture: "fixed" });
});
