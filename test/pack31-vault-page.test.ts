import test from "node:test";
import assert from "node:assert/strict";
import { withPage, click, deliverState, editorTestMs } from "./pack18-editor-harness.ts";

test("Settings shows vault access wording and connection health in the real page", { timeout: editorTestMs(90000) }, async () => {
  await withPage(async ({ ev, discovered }) => {
    await deliverState(ev, discovered);
    await click(ev, "#setBtn");
    await click(ev, '[data-settings-section="vault"]');
    const wording = "Your leader can read and write this vault. Save also keeps a copy of the handover here. Disconnecting leaves your notes where they are.";
    assert.equal(await ev(`document.querySelector('#s-vault .vault-help').textContent`), wording);
    for (const [status, text] of [["connected", "Connected"], ["missing", "This folder is missing. Choose its new location."], ["broad", "That folder is too broad to use as a notes vault. Choose the folder that holds your notes."], ["readonly", "Command Center can read this folder but cannot save notes here."]]) {
      await deliverState(ev, discovered, `state.settings.vault={path:'C:/test/vault',status:${JSON.stringify(status)}};`);
      assert.equal(await ev(`document.querySelector('#vaultConnectionStatus').textContent`), text);
      assert.equal(await ev(`document.querySelector('#vaultConnectionStatus').classList.contains('connected')`), status === "connected");
    }
    await deliverState(ev, discovered, "state.settings.vault={path:null,status:'disconnected'};");
    assert.equal(await ev(`document.querySelector('#vaultConnectionStatus').textContent`), "Not connected");
  });
});

test("Save status keeps the local saved label and vault warning across page reload and clears with server state", { timeout: editorTestMs(90000) }, async () => {
  await withPage(async ({ ev, discovered, reload }) => {
    const warning = "Saved · vault copy needs attention";
    const flagged = structuredClone(discovered);
    const tab = flagged.projects[0].tabs[0];
    tab.chatRevision = 1; tab.savedRevision = 1; tab.vaultCopyNeedsAttention = true;
    await deliverState(ev, flagged);
    assert.equal(await ev(`document.querySelector('#saveSt').textContent`), warning);
    await ev(`window.__ccSeed=${JSON.stringify(flagged)}`);
    await reload();
    await deliverState(ev, flagged);
    assert.equal(await ev(`document.querySelector('#saveSt').textContent`), warning);
    tab.vaultCopyNeedsAttention = false;
    await deliverState(ev, flagged);
    assert.equal(await ev(`document.querySelector('#saveSt').textContent`), "Saved");
  });
});

test("Save status shows the vault warning only beside the plain Saved label", { timeout: editorTestMs(90000) }, async () => {
  await withPage(async ({ ev, discovered }) => {
    const flagged = structuredClone(discovered);
    const tab = flagged.projects[0].tabs[0];
    tab.vaultCopyNeedsAttention = true;
    for (const [revision, saved, expected] of [[0, 0, "Nothing to save yet"], [2, 1, /^Not saved/]] as const) {
      tab.chatRevision = revision; tab.savedRevision = saved;
      // Clear/restore invalidates history. Its subsequent read must answer these same facts.
      await ev(`window.__socket.history=(tabId)=>__ccDeliver({type:'chatHistory',tabId,messages:[],revision:${revision},savedRevision:${saved}})`);
      const type = revision === 0 ? "chatCleared" : "chatRestored";
      await ev(`__ccDeliver({ type: ${JSON.stringify(type)}, tabId: ${JSON.stringify(tab.id)}, revision: ${revision}, savedRevision: ${saved} })`);
      await deliverState(ev, flagged);
      const text = await ev(`document.querySelector('#saveSt').textContent`);
      if (typeof expected === "string") assert.equal(text, expected); else assert.match(text, expected);
      assert.equal(text.includes("vault copy"), false, text);
    }
  });
});
