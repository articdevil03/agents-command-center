import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliverState } from "./pack18-editor-harness.ts";
import { answer, catalogChange, CATALOG_QUIET, sentCount, sentSince, toolsChange } from "./pack29-onboarding-page.setup.ts";

// Pack 29 final-review fix A: Settings offers Connect for an installed ACP catalog tool that is not saved as a connection yet, on the real
// page. Without it a tool installed from Settings never reaches the model picker. The message is the wizard's own (install.js connect).
const OFF = { claude: [true, true], codex: [true, true], opencode: [true, true] } as const;
const rowOf = (cli: string) => `#s-tools [data-tool-row][data-cli="${cli}"]`;
const connectButton = (ev: any, cli: string) => ev(`(()=>{const b=document.querySelector(${J(rowOf(cli) + ' [data-setting-action="connect-cli"]')});return b?{text:b.textContent,disabled:b.disabled,visible:b.checkVisibility(),primary:b.classList.contains('primary')}:null})()`);
const subtitle = (ev: any, cli: string) => ev(`document.querySelector(${J(rowOf(cli) + " [data-tool-subtitle]")}).textContent`);

const badge = (ev: any, cli: string) => ev(`Boolean(document.querySelector(${J(rowOf(cli) + ' [data-tool-status="connected"]')}))`);

test("P29 w8 fix 4: an installed, signed-in, unsaved ACP tool shows Connect and no Connected badge; a saved one shows the badge and no Connect", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    const show = (change: string) => deliverState(ev, seed, `state.firstRun={required:false};${toolsChange(OFF)}${CATALOG_QUIET}${change}`);
    await show(catalogChange({ kimi: { installed: true, version: "1.0.0", signedIn: true, registered: false, leaderEligible: false } }));
    await click(ev, "#setBtn");
    await waitFor(`Boolean(document.querySelector(${J(rowOf("kimi"))}))`, "Settings tool rows");
    assert.equal((await connectButton(ev, "kimi"))?.text, "Connect", "unsaved: Connect shows");
    assert.equal(await subtitle(ev, "kimi"), "Installed · Not connected yet · 1.0.0");
    assert.equal(await badge(ev, "kimi"), false, "unsaved: no Connected badge");

    await show(catalogChange({ kimi: { installed: true, version: "1.0.0", signedIn: true, registered: true } }));
    await waitFor(`Boolean(document.querySelector(${J(rowOf("kimi") + ' [data-tool-status="connected"]')}))`, "badge after save");
    assert.equal(await badge(ev, "kimi"), true, "saved: the badge shows");
    assert.equal(await connectButton(ev, "kimi"), null, "saved: no Connect");
  }, { fixture: "fixed" });
});

test("P29 final fix A: Settings shows Connect only for an installed, unregistered ACP catalog tool, and it sends exactly {type, requestId, cli, confirm:true} once", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    const show = (change: string) => deliverState(ev, seed, `state.firstRun={required:false};${toolsChange(OFF)}${CATALOG_QUIET}${change}`);
    await show(catalogChange({ kimi: { installed: true, version: "1.0.0", signedIn: null, registered: false, leaderEligible: false } }));
    await click(ev, "#setBtn");
    await waitFor(`Boolean(document.querySelector(${J(rowOf("kimi"))}))`, "Settings tool rows");
    const entry = seed.cliCatalog.find((item: any) => item.id === "kimi");
    assert.equal(entry.leader.kind, "acp", "kimi is an ACP catalog tool");
    assert.deepEqual(await connectButton(ev, "kimi"), { text: "Connect", disabled: false, visible: true, primary: true }, "installed + unregistered: a primary Connect");
    assert.equal(await subtitle(ev, "kimi"), "Installed · Not connected yet · 1.0.0");
    assert.doesNotMatch(await ev(`document.querySelector(${J(rowOf("kimi"))}).innerText`), /powershell|terminal|paste|type the command/i);

    // The four states with no Connect: registered, not installed, unknown, and a tool that is not an ACP catalog tool.
    const none = [
      ["registered", catalogChange({ kimi: { registered: true } }), "kimi"],
      ["not installed", catalogChange({ kimi: { installed: false, registered: false } }), "kimi"],
      ["unknown", catalogChange({ kimi: { installed: null, registered: false } }), "kimi"],
    ] as const;
    for (const [label, change, cli] of none) {
      await show(change);
      await waitFor(`!document.querySelector(${J(rowOf(cli) + ' [data-setting-action="connect-cli"]')})`, `${label}: no Connect`);
      assert.equal(await connectButton(ev, cli), null, label);
    }
    await show(toolsChange({ ...OFF, claude: [true, true] }) + catalogChange({ claude: { installed: true, registered: false } }));
    assert.equal((seed.cliCatalog.find((item: any) => item.id === "claude")).leader.kind, "builtin");
    assert.equal(await connectButton(ev, "claude"), null, "a built-in tool never gets Connect");

    // Back to the one state that offers it: the click sends one message, a second press while it runs sends nothing.
    await show(catalogChange({ kimi: { installed: true, version: "1.0.0", registered: false } }));
    await waitFor(`Boolean(document.querySelector(${J(rowOf("kimi") + ' [data-setting-action="connect-cli"]')}))`, "Connect again");
    const mark = await sentCount(ev);
    await click(ev, rowOf("kimi") + ' [data-setting-action="connect-cli"]');
    assert.equal((await connectButton(ev, "kimi"))?.disabled, true, "disabled while the connect runs");
    await ev(`(()=>{const b=document.querySelector(${J(rowOf("kimi") + ' [data-setting-action="connect-cli"]')});b.disabled=false;b.click();return true})()`);
    const sent = await sentSince(ev, "registerCatalogCli", mark);
    assert.equal(sent.length, 1, "exactly one registerCatalogCli, even from a forced second click");
    assert.deepEqual(Object.keys(sent[0]).sort(), ["cli", "confirm", "requestId", "type"]);
    assert.deepEqual([sent[0].cli, sent[0].confirm, await sentSince(ev, "installCli", mark)], ["kimi", true, []], "Connect names the tool and installs nothing");
    await answer(ev, sent[0]);
  }, { fixture: "fixed" });
});
