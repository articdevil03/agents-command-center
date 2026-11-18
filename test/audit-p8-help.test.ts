import test from "node:test";
import assert from "node:assert/strict";
import { click, deliverState, editorTestMs, J, press, skipped, withPage } from "./pack18-editor-harness.ts";
import { toolsChange } from "./pack29-onboarding-page.setup.ts";

const button = (cli: string) => `[data-settings-help="${cli}"]`;
const panel = (cli: string) => `#settingsHelp-${cli}`;

for (const width of [390, 1440]) {
  test(`E-8 Settings help remembers each tool's open and closed state across broadcasts at ${width}px`, { timeout: editorTestMs(100_000) }, async (t) => {
    if (skipped(t)) return;
    await withPage(async ({ ev, page, seed }) => {
      await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
      const stateChange = `state.firstRun={required:false};${toolsChange({ claude: [false, null], codex: [false, null] })}`;
      await deliverState(ev, seed, stateChange);
      await ev("openSettings(undefined,'tools');true");
      const expectHelp = async (cli: string, open: boolean) => {
        const actual = await ev(`(()=>{const b=document.querySelector(${J(button(cli))}),p=document.querySelector(${J(panel(cli))});
          return b&&p?{expanded:b.getAttribute('aria-expanded'),controls:b.getAttribute('aria-controls'),hidden:p.hidden,visible:p.checkVisibility()}:null})()`);
        assert.deepEqual(actual, { expanded: String(open), controls: `settingsHelp-${cli}`, hidden: !open, visible: open }, `${cli}: help exists and its visibility agrees with aria-expanded`);
      };
      await expectHelp("claude", false);
      await expectHelp("codex", false);
      await click(ev, button("claude"), true);
      await expectHelp("claude", true);
      assert.match(await ev(`document.querySelector(${J(panel("claude"))}).innerText`), /Install.*Cancel.*Try again.*Check again/s);
      await ev(`window.__helpBeforeBroadcast=document.querySelector(${J(panel("claude"))});true`);
      await deliverState(ev, seed, stateChange);
      assert.equal(await ev(`window.__helpBeforeBroadcast!==document.querySelector(${J(panel("claude"))})`), true, "control: the broadcast rebuilt the help panel");
      await expectHelp("claude", true);
      await expectHelp("codex", false);
      assert.equal(await ev("document.activeElement.dataset.settingsHelp"), "claude", "broadcast restores help button keyboard focus");
      await press(page, "Enter");
      await expectHelp("claude", false);
      await deliverState(ev, seed, stateChange);
      await expectHelp("claude", false);
      await expectHelp("codex", false);
      await ev(`document.querySelector(${J(button("codex"))}).focus();true`);
      await press(page, " ");
      await deliverState(ev, seed, stateChange);
      await expectHelp("codex", true);
      await expectHelp("claude", false);
      await click(ev, button("claude"));
      await deliverState(ev, seed, stateChange);
      await expectHelp("claude", true);
      await expectHelp("codex", true);
      await click(ev, button("codex"));
      await deliverState(ev, seed, stateChange);
      await expectHelp("codex", false);
      await expectHelp("claude", true);
      assert.equal(await ev(`(()=>{const p=document.querySelector(${J(panel("claude"))});const r=p.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&p.scrollWidth<=p.clientWidth})()`), true, "open help fits the viewport without clipping its content");
    });
  });
}
