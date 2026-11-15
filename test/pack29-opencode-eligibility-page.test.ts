import test from "node:test";
import assert from "node:assert/strict";
import { withPage, click, setValue, editorTestMs, skipped } from "./pack18-editor-harness.ts";

for (const installed of [false, null]) test(`saved OpenCode with installed=${installed} stays visible without selectable models, custom IDs or effort controls`, { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev }) => {
    await ev(`(()=>{const s=window.__ccSeed;s.firstRun={required:false};s.clis.find(c=>c.id==='opencode').installed=${JSON.stringify(installed)};s.opencodeModels=['provider/model'];s.opencodeModelInfo=[{value:'provider/model',variants:['thinking']}];s.projects[0].tabs[0].fixedCrew.preferences.coder={source:'user',assignment:{cli:'opencode',model:'provider/model',effort:'thinking'}};__ccDeliver({...structuredClone(s),type:'state'});openSettings(undefined,'crew');return true})()`);
    assert.match(await ev(`document.querySelector('[data-fc-model="coder"]').innerText`), /Model.*thinking/);
    await click(ev, '[data-fc-model="coder"]');
    assert.match(await ev(`document.querySelector('#pop').innerText`), /OpenCode 1 is needed.*saved choice is kept/s);
    for (const query of ["", "custom/model"]) {
      await setValue(ev, "#mq", query);
      assert.deepEqual(await ev(`[document.querySelectorAll('#pop [data-model][data-cli="opencode"]').length,document.querySelectorAll('#pop [data-effort]').length]`), [0, 0]);
    }
    assert.deepEqual(await ev(`window.__sent.filter(m=>m.type==='setCrewAssignment')`), []);
  });
});

