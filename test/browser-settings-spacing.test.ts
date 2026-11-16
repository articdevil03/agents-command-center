import test from "node:test";
import assert from "node:assert/strict";
import { withPage, click, deliverState, editorTestMs } from "./pack18-editor-harness.ts";

test("Settings spacing: every real section, help element and row has breathing room", { timeout: editorTestMs(90_000) }, async () => {
  await withPage(async ({ ev, discovered }) => {
    await deliverState(ev, discovered, `for(const cli of ["claude","codex","opencode"])state.settings.skills[cli].inventoryError="Inventory unavailable in this fixture";`);
    await click(ev, "#setBtn");
    await ev(`new Promise(resolve=>setTimeout(resolve,300))`);
    const sections = await ev(`Array.from(document.querySelectorAll('#setNav [data-settings-section]'),e=>({id:e.dataset.settingsSection,label:e.textContent}))`);
    assert.deepEqual(sections.map((s: any) => s.id), ["crew", "tools", "acp", "github", "vault", "folders", "skills", "appearance", "behaviour"], "FOUND every real Settings section");
    const helpSections = new Set(["crew", "tools", "acp", "vault", "folders", "skills", "appearance"]);
    const rowSections = new Set(["tools", "acp", "github", "vault", "folders", "behaviour"]);
    let helps = 0, rows = 0;
    const measurements = [];
    for (const section of sections) {
      await click(ev, `[data-settings-section="${section.id}"]`);
      const result = await ev(`(()=>{
        const root=document.querySelector('#s-${section.id}');if(!root)throw Error('missing section ${section.id}');
        const visible=e=>e.getClientRects().length>0;
        const help=Array.from(root.querySelectorAll('.settings-help,.help,.sintro')).filter(visible).map((e,i)=>{
          const r=e.getBoundingClientRect(),s=getComputedStyle(e);let p=e.previousElementSibling;
          while(p&&!visible(p))p=p.previousElementSibling;
          const above=p?p.getBoundingClientRect():e.parentElement.getBoundingClientRect();
          return {id:e.className+'['+i+']',gap:r.top-above.bottom,marginLeft:parseFloat(s.marginLeft),marginRight:parseFloat(s.marginRight),lineHeight:parseFloat(s.lineHeight)/parseFloat(s.fontSize),inBlock:!!e.closest('.sblock'),inline:e.getAttribute('style')};
        });
        const rows=Array.from(root.querySelectorAll('.crow')).filter(visible).map((e,i)=>{
          const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),rects=[];let n;
          while(n=walker.nextNode())if(n.textContent.trim()&&visible(n.parentElement)&&(!n.parentElement.closest('details:not([open])')||n.parentElement.closest('summary'))){
            const range=document.createRange();range.selectNodeContents(n);rects.push(...Array.from(range.getClientRects()).filter(r=>r.height&&r.width));
          }
          const bottom=e.getBoundingClientRect().bottom;
          return {id:e.className+'['+i+']',gap:rects.length?bottom-Math.max(...rects.map(r=>r.bottom)):null,padding:parseFloat(getComputedStyle(e).paddingBottom)};
        });return {help,rows};
      })()`);
      measurements.push({ section: section.label, ...result });
      if (helpSections.has(section.id)) assert.ok(result.help.length > 0, `FOUND help in ${section.id}: ${JSON.stringify(result)}`);
      if (rowSections.has(section.id)) assert.ok(result.rows.length > 0, `FOUND rows in ${section.id}: ${JSON.stringify(result)}`);
      helps += result.help.length; rows += result.rows.length;
    }
    assert.ok(helps > 0 && rows > 0, `FOUND ${helps} help elements and ${rows} rows`);
    for (const section of measurements) {
      for (const help of section.help) {
        const label = `${section.section} ${help.id}: ${JSON.stringify(help)}`;
        assert.ok(help.gap >= 11.99, label);
        assert.ok(help.lineHeight >= 1.44 && help.lineHeight <= 1.46, label);
        assert.equal(help.marginLeft, help.inBlock ? 8 : 14, label); assert.equal(help.marginRight, help.inBlock ? 8 : 14, label);
        if (help.id.startsWith("settings-help fc-intro")) assert.ok(help.gap <= 16, label);
      }
      for (const row of section.rows) {
        assert.notEqual(row.gap, null, `FOUND text in ${section.section} ${row.id}`);
        assert.ok(row.gap >= 10 && row.padding >= 14, `${section.section} ${JSON.stringify(row)}`);
      }
    }
  });
});
