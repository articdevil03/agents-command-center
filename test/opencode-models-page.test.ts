import test from "node:test";
import assert from "node:assert/strict";
import { withPage, click, setValue, editorTestMs, skipped } from "./pack18-editor-harness.ts";

const catalogue = [
  { value: "opencode/empty", providerID: "opencode", modelID: "empty", displayName: "Same name", variants: [] },
  { value: "opencode-go/thinking", providerID: "opencode-go", modelID: "thinking", displayName: "Same name", variants: ["none", "thinking"] },
  { value: "opencode-go/max", providerID: "opencode-go", modelID: "max", displayName: "Max model", variants: ["max"] },
];

test("seat card distinguishes OpenCode default from literal none", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev }) => {
    for (const effort of ["", "none"]) {
      await ev(`(()=>{const s=window.__ccSeed;s.firstRun={required:false};s.opencodeModelInfo=${JSON.stringify(catalogue)};const tab=s.projects[0].tabs[0];tab.fixedCrew.preferences.coder={source:'user',assignment:{cli:'opencode',model:'opencode-go/thinking',effort:${JSON.stringify(effort)}}};__ccDeliver({...structuredClone(s),type:'state'});const current=currentTab(),seat={slot:'coder',name:'Coder',role:'Coder',isLeader:false,status:'idle',...tab.fixedCrew.preferences.coder.assignment};renderSeatCard(current,seat);return true})()`);
      assert.equal(await ev(`document.querySelector('#seatPop .eff').textContent.trim()`), `· ${effort || "OpenCode default"}`);
    }
  });
});

test("picker groups providers, uses exact efforts/default, keeps saved choices, custom IDs, refresh search and focus", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev }) => {
    await ev(`(()=>{const s=window.__ccSeed;s.firstRun={required:false};s.opencodeModelInfo=${JSON.stringify(catalogue)};s.opencodeModels=s.opencodeModelInfo.map(m=>m.value);s.discoveryInfo.opencodeModels={fallback:false};s.clis.find(c=>c.id==='opencode').installed=true;const tab=s.projects[0].tabs[0];tab.fixedCrew.preferences.coder={source:'user',assignment:{cli:'opencode',model:'opencode-go/thinking',effort:'none'}};__ccDeliver({...structuredClone(s),type:'state'});openSettings(undefined,'crew');return true})()`);
    await click(ev, '[data-fc-model="coder"]');
    assert.match(await ev(`document.querySelector('#mrows').innerText`), /OpenCode \/ opencode-go/);
    assert.match(await ev(`document.querySelector('#mrows').innerText`), /OpenCode \/ opencode/);
    await setValue(ev, '#mq', 'Same name');
    assert.equal(await ev(`document.querySelectorAll('#mrows [data-model]').length`), 2, "search uses reported names and keeps distinct ids");
    assert.deepEqual(await ev(`[...document.querySelectorAll('#pop [data-effort]')].map(b=>[b.dataset.effort,b.textContent])`), [["", "OpenCode default"], ["none", "none"], ["thinking", "thinking"]]);
    await click(ev, '#pop [data-effort=""]');
    assert.equal(await ev(`window.__sent.filter(m=>m.type==='setCrewAssignment').at(-1).assignment.effort`), "");
    await ev(`(()=>{const s=window.__ccSeed;const tab=s.projects[0].tabs[0];tab.fixedCrew.preferences.coder.assignment={cli:'opencode',model:'gone/model',effort:'future'};__ccDeliver({...structuredClone(s),type:'state'});return true})()`);
    await click(ev, '[data-fc-model="coder"]');
    assert.match(await ev(`document.querySelector('#pop').innerText`), /Saved choice, not currently reported/);
    assert.ok(await ev(`document.querySelector('#pop [data-effort="future"]')!==null`));
    await setValue(ev, '#mq', 'opencode-go');
    await click(ev, '#pop [data-refresh-models]');
    assert.equal(await ev(`window.__sent.at(-1).type`), "refreshOpenCodeModels");
    await ev(`(()=>{document.querySelector('#mq').focus();__ccDeliver({...structuredClone(window.__ccSeed),type:'state'});return true})()`);
    assert.deepEqual(await ev(`[document.querySelector('#mq').value,document.activeElement.id]`), ["opencode-go", "mq"]);
    await ev(`(()=>{window.__ccSeed.discoveryInfo.opencodeModels={fallback:false,stale:true,error:'Could not refresh models. Try again.'};__ccDeliver({...structuredClone(window.__ccSeed),type:'state'});return true})()`);
    assert.match(await ev(`document.querySelector('#pop').innerText`), /Could not refresh models/);
    await setValue(ev, '#mq', 'custom/model:tag');
    assert.ok(await ev(`document.querySelector('#pop [data-model="custom/model:tag"]')!==null`));
    await click(ev, '#pop [data-model="custom/model:tag"]');
    assert.deepEqual(await ev(`(()=>{const a=window.__sent.filter(m=>m.type==='setCrewAssignment').at(-1).assignment;return [a.model,a.effort]})()`), ["custom/model:tag", ""]);
    await ev(`(()=>{window.__ccSeed.projects[0].tabs[0].fixedCrew.preferences.coder.assignment={cli:'opencode',model:'opencode/empty',effort:''};__ccDeliver({...structuredClone(window.__ccSeed),type:'state'});return true})()`);
    assert.equal(await ev(`document.querySelectorAll('#pop [data-effort]').length`), 0);
    assert.match(await ev(`document.querySelector('#pop').innerText`), /no effort setting/);
  });
});

test("creation drafts and bulk picker share provider groups and model-aware efforts", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev }) => {
    await ev(`(()=>{const s=window.__ccSeed;s.firstRun={required:false};s.opencodeModelInfo=${JSON.stringify(catalogue)};s.opencodeModels=s.opencodeModelInfo.map(m=>m.value);s.clis.find(c=>c.id==='opencode').installed=true;__ccDeliver({...structuredClone(s),type:'state'});openProjectDialog();return true})()`);
    await click(ev, '#pCrew [data-fc-new-model="coder"]');
    assert.match(await ev(`document.querySelector('#mrows').innerText`), /OpenCode \/ opencode-go/);
    await click(ev, '#pop [data-model="opencode-go/thinking"]');
    assert.deepEqual(await ev(`[...document.querySelectorAll('#pop [data-effort]')].map(b=>b.dataset.effort)`), ["", "none", "thinking"]);
    await click(ev, '#pop [data-effort="thinking"]');
    assert.deepEqual(await ev(`(()=>{const a=fixedCrewUi.creationFields('project').crewChoices.coder;return [a.model,a.effort]})()`), ["opencode-go/thinking", "thinking"]);
    await ev(`(()=>{closePopovers();setLayer(document.querySelector('#projModal'),false);openSettings(undefined,'crew');return true})()`);
    await click(ev, '[data-fc-bulk]');
    assert.match(await ev(`document.querySelector('#mrows').innerText`), /OpenCode \/ opencode/);
    assert.equal(await ev(`document.querySelectorAll('#pop [data-effort]').length`), 0);
    await setValue(ev, '#mq', 'opencode-go/max');
    await click(ev, '#pop [data-model="opencode-go/max"]');
    const bulk = await ev(`window.__sent.filter(m=>m.type==='setCrewModelForAll').at(-1)`);
    assert.ok(bulk); assert.equal(bulk.cli, "opencode"); assert.equal(bulk.model, "opencode-go/max");
  });
});

test("the model menu scrolls only its model list, and effort pills stay on one compact line", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  const many = Array.from({ length: 40 }, (_, at) => ({ value: `opencode-go/model-${at}`, providerID: "opencode-go", modelID: `model-${at}`, displayName: `Model ${at}`,
    variants: at === 0 ? ["none", "low", "medium", "high", "xhigh", "max"] : [] }));
  await withPage(async ({ ev }) => {
    await ev(`(()=>{const s=window.__ccSeed;s.firstRun={required:false};s.opencodeModelInfo=${JSON.stringify(many)};s.opencodeModels=s.opencodeModelInfo.map(m=>m.value);s.clis.find(c=>c.id==='opencode').installed=true;s.projects[0].tabs[0].fixedCrew.preferences.coder.assignment={cli:'opencode',model:'opencode-go/model-0',effort:'high'};__ccDeliver({...structuredClone(s),type:'state'});openSettings(undefined,'crew');return true})()`);
    await click(ev, '[data-fc-model="coder"]');
    // A short window: placePopover shortens the menu to the roomier side (public/app/05-layers-approvals.js).
    await ev(`document.querySelector('#pop').style.maxHeight='420px'`);
    const box = await ev(`(()=>{const pop=document.querySelector('#pop'),list=document.querySelector('#mrows');const pills=[...pop.querySelectorAll('[data-effort]')];
      return {fixedChildren:[...pop.children].filter(el=>el!==list).every(el=>getComputedStyle(el).flexShrink==="0"),menuScrolls:pop.scrollHeight>pop.clientHeight+1,listScrolls:list.scrollHeight>list.clientHeight+1,pills:pills.length,tallest:Math.max(...pills.map(b=>b.offsetHeight)),widest:Math.max(...pills.map(b=>b.offsetWidth))}})()`);
    assert.equal(box.fixedChildren, true, "search, actions and effort controls cannot shrink into the scrolling list");
    assert.equal(box.menuScrolls, false, "the menu around the list must not scroll");
    assert.equal(box.listScrolls, true, "control: the list itself scrolls with 40 models");
    assert.equal(box.pills, 7, "control: default plus six variants");
    assert.ok(box.tallest <= 30, `effort pills stay one line, tallest ${box.tallest}`);
  });
});
