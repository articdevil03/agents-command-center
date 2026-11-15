import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, press } from "./pack18-editor-harness.ts";
import { AUDIT_JS } from "./overlap-audit-js.ts";
import { auditScrolled, catalogChange, guide, openOnly, sentCount, showFirstRun, stubClipboard } from "./pack29-onboarding-page.setup.ts";
import { toToolStep } from "./pack29-onboarding-page-acp.setup.ts";

const NONE_FOUND = { claude: [false, null], codex: [false, null], opencode: [false, null] } as const;
const STEPS = ["Visit the official setup guide at the address below.", "Follow the maker's setup guide, then return here and press Check again."];
const FORBIDDEN = /powershell|terminal|press the windows key|paste (?:the )?(?:install )?command|\bpaid\b|\bfree\b|\u2014/i;

test("every catalogue fallback offers its official guide, address copy and Check again, with in-app Install primary", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed, page }) => {
    const entries = seed.cliCatalog.filter((entry: any) => entry.installable);
    assert.equal(entries.length, 11, "all actual installable tools FOUND");
    const missing = catalogChange(Object.fromEntries(entries.map((entry: any) => [entry.id, { installed: false, registered: false }])));
    await showFirstRun(ev, seed, NONE_FOUND, missing);
    await toToolStep(ev, "C:\\work\\My App"); await stubClipboard(ev);
    for (const entry of entries) {
      const id = entry.id;
      assert.equal((await guide(ev, id)).shown, false, id + " starts collapsed");
      await click(ev, `[data-frun-help="${id}"]`);
      const shown = await guide(ev, id);
      assert.deepEqual([shown.expanded, shown.shown, shown.commands, shown.shells, shown.copyNames], ["true", true, [], [], []], id + " guide has no command controls");
      assert.doesNotMatch(shown.text, FORBIDDEN, id);
      assert.match(shown.text, /Check again/);
      const address = id === "opencode" ? "https://opencode.ai/v1/docs/" : id === "codex" ? "https://developers.openai.com/codex/cli" : entry.sources[0];
      assert.equal(shown.page, address, id + " official guide");
      if (id !== "opencode") assert.deepEqual(shown.steps, STEPS);
      else assert.match(shown.steps.join(" "), /Press Install.*Press Sign in/);
      const mark = await sentCount(ev);
      await ev("window.__copied=[]"); await click(ev, `[data-frun-copy="${id}"]`);
      await waitFor("window.__copied.length===1", id + " address copied");
      assert.deepEqual(await ev("window.__copied"), [address]);
      assert.equal(await sentCount(ev), mark, "copying runs nothing");
      assert.equal(await ev(`Boolean(document.querySelector('[data-frun-install="${id}"]'))`), true, id + " in-app Install remains primary");
      await click(ev, `[data-frun-help="${id}"]`);
    }
    await openOnly(ev, "codex");
    await ev("window.__refuse=true;document.querySelector('#toast').textContent=''");
    await click(ev, '[data-frun-copy="codex"]');
    await waitFor("window.__execCalls===1&&document.querySelector('#toast').textContent==='Address copied'", "clipboard fallback copies address");
    await ev("window.__execOk=false;document.querySelector('#toast').textContent=''");
    await click(ev, '[data-frun-copy="codex"]');
    await waitFor("window.__execCalls===2&&document.querySelector('#toast').textContent==='Could not copy. Select the address and copy it by hand'", "failed address copy is explained");
    assert.equal(await ev("document.querySelectorAll('body > textarea').length"), 0);
    await ev(`${AUDIT_JS};true`);
    await page("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["light", "dark"]) {
      await ev(`document.body.classList.toggle('light',${J(theme === "light")})`);
      await auditScrolled(ev, `official guide ${theme}`, 2);
    }
    await openOnly(ev, "opencode");
    await ev("document.querySelector('#frunH-tools').focus()");
    const order: string[] = [], expected = ["frunCheck", "frunGuideCopy", "frunSearch",
      ...entries.flatMap((entry: any) => [`frun-install-${entry.id}`, `frun-help-${entry.id}`, ...(entry.id === "opencode" ? ["frun-copy-opencode"] : [])]),
      "frun-to-opencode", "frunOtherToggle", "frunSkip"];
    for (let i = 0; i < expected.length; i++) { await press(page, "Tab"); order.push(await ev("(()=>{const a=document.activeElement;return a.id||a.dataset.focusKey||a.tagName})()")); }
    assert.deepEqual(order, expected);
    await showFirstRun(ev, seed, { claude: [true, false], codex: [true, true], opencode: [false, null] });
    assert.equal((await guide(ev, "claude")).found, false); assert.equal((await guide(ev, "codex")).found, false);
    assert.equal(await ev("document.querySelectorAll('[data-frun-copy-cmd]').length"), 0);
  }, { fixture: "fixed" });
});
