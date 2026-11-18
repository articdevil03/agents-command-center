import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliverState } from "./pack18-editor-harness.ts";
import { answer, catalogChange, sentCount, sentSince, showFirstRun, toolsChange } from "./pack29-onboarding-page.setup.ts";
import { toToolStep } from "./pack29-onboarding-page-acp.setup.ts";

const missing = { claude: [false, null], codex: [true, true], opencode: [false, null] } as const;
const action = (cli: string, status: string, reason: string | null) => ({ requestId: `owned-${cli}`, kind: "install", status, phase: null, reason });

test("R3 Settings lets every managed tool stop retained cleanup before retrying", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed }) => {
    const entries = seed.cliCatalog.filter((entry: any) => entry.installable);
    assert.equal(entries.length, 11, "the complete managed tool list was FOUND");
    for (const { id: cli } of entries) {
      const selector = `#s-tools [data-tool-row][data-cli="${cli}"]`;
      const install = `${selector} [data-setting-action="install-cli"]`;
      const stop = `${selector} [data-setting-action="cancel-cli-install"]`;
      const show = async (status: string, reason: string | null) => {
        const installed = cli === "opencode" && reason === "cleanupUnconfirmed" ? null : false;
        await deliverState(ev, seed, `state.firstRun={required:false};${toolsChange({ ...missing, [cli]: [false, null] })}${catalogChange({ [cli]: { installed, action: action(cli, status, reason) } })}`);
        await ev("openSettings(undefined,'tools');true");
      };
      await show("running", null);
      assert.deepEqual(await ev(`(()=>{const b=document.querySelector(${J(stop)});return b?[b.textContent,b.disabled,b.checkVisibility()]:null})()`), ["Cancel", false, true], `${cli}: running install has Cancel`);
      await show("failed", "cleanupUnconfirmed");
      assert.deepEqual(await ev(`(()=>{const b=document.querySelector(${J(stop)});return b?[b.textContent,b.disabled,b.checkVisibility()]:null})()`), ["Stop again", false, true], `${cli}: cleanup retains enabled Stop again`);
      const retry = await ev(`(()=>{const b=document.querySelector(${J(install)});return b?[b.textContent,b.disabled,b.checkVisibility()]:null})()`);
      assert.deepEqual(retry, cli === "copilot" ? null : ["Try again", true, true], `${cli}: retry is held until confirmed cleanup`);
      let mark = await sentCount(ev);
      if (cli !== "copilot") {
        await click(ev, install);
        assert.deepEqual(await sentSince(ev, "installCli", mark), [], `${cli}: disabled retry cannot send`);
      }
      await click(ev, stop);
      const sent = await sentSince(ev, "cancelCliInstall", mark);
      assert.deepEqual(sent.map((m) => [Object.keys(m).sort(), m.cli, m.installRequestId]), [[[
        "cli", "installRequestId", "requestId", "type",
      ], cli, `owned-${cli}`]], `${cli}: Stop again sends only the owned cancellation`);
      await answer(ev, sent[0]);
      await show("failed", "cancelled");
      assert.equal(await ev(`Boolean(document.querySelector(${J(stop)}))`), false, `${cli}: confirmed cleanup removes Stop again`);
      assert.deepEqual(await ev(`(()=>{const b=document.querySelector(${J(install)});return b?[b.textContent,b.disabled,b.checkVisibility()]:null})()`), ["Try again", false, true], `${cli}: confirmed cleanup restores retry`);
      mark = await sentCount(ev);
      await click(ev, install);
      assert.equal(await ev("document.querySelector('#confirmModal').hidden"), false, `${cli}: retry opens consent`);
      await click(ev, "#confirmOk");
      const again = await sentSince(ev, "installCli", mark);
      assert.deepEqual(again.map((m) => [m.cli, m.confirm]), [[cli, true]], `${cli}: retry sends after cleanup`);
      await answer(ev, again[0]);
    }
  }, { fixture: "fixed" });
});

test("R3 a failed OpenCode upgrade shows its failure and Try again in wizard and Settings", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed }) => {
    const failed = catalogChange({ opencode: { installed: true, version: "0.9.0", supportedVersion: false,
      action: action("opencode", "failed", "rateLimited") } });
    await showFirstRun(ev, seed, missing, failed);
    await toToolStep(ev, "C:\\work\\P6");
    assert.deepEqual(await ev(`(()=>{const r=document.querySelector('#frunTools [data-cli="opencode"]');const b=r.querySelector('[data-frun-install]');return [r.querySelector('.frun-detail').textContent,b.textContent,b.disabled,b.checkVisibility()]})()`), [
      "GitHub is limiting requests right now. Wait a few minutes, then choose Try again.", "Try again", false, true,
    ]);
    await deliverState(ev, seed, `state.firstRun={required:false};${toolsChange(missing)}${failed}`);
    await ev("openSettings(undefined,'tools');true");
    const selector = '#s-tools [data-cli="opencode"] [data-setting-action="install-cli"]';
    assert.deepEqual(await ev(`(()=>{const b=document.querySelector(${J(selector)});return [b.textContent,b.disabled,b.checkVisibility()]})()`), ["Try again", false, true]);
    const mark = await sentCount(ev);
    await click(ev, selector); await click(ev, "#confirmOk");
    const sent = await sentSince(ev, "installCli", mark);
    assert.deepEqual(sent.map((m) => [m.cli, m.confirm]), [["opencode", true]], "upgrade retry works through the real handler");
    await answer(ev, sent[0]);
  }, { fixture: "fixed" });
});

const others = ["opencode", "codex", "copilot"];
const probe = (selector: string) => `(()=>{const b=document.querySelector(${J(selector)});return b?[b.textContent,b.disabled,b.checkVisibility()]:null})()`;
const installOf = (cli: string) => `#s-tools [data-tool-row][data-cli="${cli}"] [data-setting-action="install-cli"]`;
const showClaude = async (ev: any, seed: any, status: string, reason: string | null) => {
  const facts = Object.fromEntries(others.map((cli) => [cli, { installed: false }]));
  await deliverState(ev, seed, `state.firstRun={required:false};${toolsChange({ ...missing, codex: [false, null] })}${catalogChange({ ...facts, claude: { installed: false, action: action("claude", status, reason) } })}`);
  await ev("openSettings(undefined,'tools');true");
};

test("R4 while one install runs or is stuck, every other Install is disabled and the owner keeps its stop control", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed }) => {
    const stop = '#s-tools [data-tool-row][data-cli="claude"] [data-setting-action="cancel-cli-install"]';
    for (const [status, reason, label] of [["running", null, "Cancel"], ["failed", "cleanupUnconfirmed", "Stop again"]] as const) {
      await showClaude(ev, seed, status, reason);
      for (const cli of others) assert.deepEqual(await ev(probe(installOf(cli))), ["Install", true, true], `${cli}: Install is disabled while Claude is ${status}/${reason}`);
      assert.deepEqual(await ev(probe(stop)), [label, false, true], `Claude keeps its own ${label}`);
    }
    await showClaude(ev, seed, "failed", "cancelled");
    for (const cli of others) assert.deepEqual(await ev(probe(installOf(cli))), ["Install", false, true], `${cli}: Install is enabled again after confirmed cleanup`);
    assert.deepEqual(await ev(probe(installOf("claude"))), ["Try again", false, true], "Claude retry is enabled again");
  }, { fixture: "fixed" });
});

test("R4 a stuck install of any tool says why in Settings, also after a reload", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  const note = '#s-tools [data-tool-row][data-cli="claude"] [data-tool-install-note]';
  const expected = "Could not confirm the installer stopped.";
  await withPage(async ({ ev, seed }) => {
    await showClaude(ev, seed, "failed", "cleanupUnconfirmed");
    assert.equal(await ev(`document.querySelector(${J(note)})?.textContent ?? null`), expected, "Claude's stuck install shows the reason");
    await showClaude(ev, seed, "failed", "cancelled");
    assert.equal(await ev(`document.querySelector(${J(note)})`), null, "the note goes away once cleanup is confirmed");
  }, { fixture: "fixed" });
  await withPage(async ({ ev, seed }) => { // a fresh page: the state is rebuilt from the server message alone
    await showClaude(ev, seed, "failed", "cleanupUnconfirmed");
    assert.equal(await ev(`document.querySelector(${J(note)})?.textContent ?? null`), expected, "the reason is shown again after a reload");
  }, { fixture: "fixed" });
});
