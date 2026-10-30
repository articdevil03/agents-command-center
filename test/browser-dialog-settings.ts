import assert from "node:assert/strict";
import type { DialogPage } from "./browser-dialog-page.ts";

export async function settingsLifecycleProbes(page: DialogPage, args: { width: number }, proc: { pid?: number }) {
  const { evaluate, waitForPage } = page;
  const settings = await evaluate(`(()=>{
    const $=id=>document.getElementById(id), find=s=>{const e=document.querySelector(s);if(!e)throw Error("missing target "+s);return e};
    const deliver=s=>window.__ccDeliver({...s,type:"state"});
    const close=()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
    const T=(e,v)=>{e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};
    const open=()=>$("setBtn").click(); close(); open();
    const add=find('[data-settings-add="mcp-claude"]'); if(find('[data-mcp-form="claude"]').hidden)add.click();
    const form=()=>find('[data-mcp-form="claude"]');
    T(form().elements.name,"focused_server");T(form().elements.commandOrUrl,"npx -y server");form().elements.name.focus();form().requestSubmit();if(!$("confirmModal").hidden)$("confirmOk").click();
    const m=window.__sent.filter(m=>m.type==="mcpAdd").at(-1),s=structuredClone(window.__latestState);
    s.requestActions={...s.requestActions,[m.requestId]:{requestId:m.requestId,status:"done",message:"Done"}};deliver(s);
    const mcpCleared=form().elements.name.value==="" && form().elements.commandOrUrl.value==="";
    T($("defaultProjectFolder"),"typed-folder");$("defaultProjectFolder").focus();find('[data-setting-action="folder-save"]').click();
    const f=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1),s2=structuredClone(window.__latestState);
    s2.settings.folders={defaultProjectFolder:"normalized-folder"};s2.requestActions={...s2.requestActions,[f.requestId]:{requestId:f.requestId,status:"done",message:"Done"}};deliver(s2);
    const normalized=$("defaultProjectFolder").value;find('[data-setting-action="folder-save"]').click();const normalizedSent=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1).folder;
    close(); const s3=structuredClone(window.__latestState),again=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1);s3.requestActions={...s3.requestActions,[again.requestId]:{requestId:again.requestId,status:"done",message:"Done"}};s3.settings.folders={defaultProjectFolder:""};deliver(s3);open();$("defaultProjectFolder").focus();
    deliver(structuredClone(window.__latestState)); // an ordinary broadcast uses up the finished save, so the next one meets a field with no recent save
    const s4=structuredClone(window.__latestState);s4.settings.folders={defaultProjectFolder:"new-server-folder"};deliver(s4);
    const refreshed=$("defaultProjectFolder").value;find('[data-setting-action="folder-save"]').click();const refreshedSent=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1).folder;
    return {mcpCleared,normalized,normalizedSent,refreshed,refreshedSent};
  })()`);
  assert.equal(settings.mcpCleared, true, "focused MCP name clears after successful Add");
  assert.equal(settings.normalized, "normalized-folder", "focused saved folder shows normalized server value");
  assert.equal(settings.normalizedSent, "normalized-folder", "Save never resubmits stale focused folder");
  assert.equal(settings.refreshed, "new-server-folder", "untouched focused folder shows newer server value");
  assert.equal(settings.refreshedSent, "new-server-folder", "Save submits refreshed untouched folder");
  await evaluate(`(()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));const s=structuredClone(window.__latestState);s.settings.vault=null;window.__ccDeliver({...s,type:"state"});document.getElementById("setBtn").click();document.querySelector('[data-setting-action="vault-browse"]').click();return true})()`);
  await waitForPage('document.getElementById("vaultPath").value===window.__ccFolderChoice', "vault Browse draft");
  const vault = await evaluate(`(()=>{
    const close=()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));close();document.getElementById("setBtn").click();
    const afterClose=document.getElementById("vaultPath").value,oldControl=document.querySelector('[data-setting-action="vault-toggle"]');
    const s=structuredClone(window.__latestState);s.settings.vault={path:"new-connected-vault"};window.__ccDeliver({...s,type:"state"});
    const path=document.getElementById("vaultPath").value,label=document.querySelector('[data-setting-action="vault-toggle"]').textContent;
    oldControl.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    // No typing or Browse: this field must keep following the server.
    const newer=structuredClone(window.__latestState);newer.settings.vault={path:"newer-connected-vault"};window.__ccDeliver({...newer,type:"state"});
    return {afterClose,path,label,unchangedRefresh:document.getElementById("vaultPath").value,sent:window.__sent.filter(m=>m.type==="setNotesVault")};
  })()`);
  assert.equal(vault.afterClose, "", "closing Settings discards Browse vault draft");
  assert.equal(vault.path, "new-connected-vault", "untouched render does not conceal newly connected vault");
  assert.equal(vault.label, "Disconnect", "newly connected vault is shown as connected, not a stale Connect control");
  assert.equal(vault.unchangedRefresh, "newer-connected-vault", "untouched vault input is not an unsaved draft");
  assert.equal(vault.sent.at(-1)?.path, "new-connected-vault", "stale Connect activation uses the displayed newer vault");
  assert.equal(vault.sent.some((m: any) => m.path === null), false, "stale Connect control never sends setNotesVault path:null over newer vault");
  // The vault save above is done. A later Browse or typed choice must survive every broadcast until it is saved or Settings closes.
  await evaluate(`(()=>{const m=window.__sent.filter(m=>m.type==="setNotesVault").at(-1),s=structuredClone(window.__latestState);
    s.requestActions={...s.requestActions,[m.requestId]:{requestId:m.requestId,status:"done",message:"Done"}};window.__ccDeliver({...s,type:"state"});
    window.__ccFolderChoice="picker-second";document.querySelector('[data-setting-action="vault-browse"]').click();return true})()`);
  await waitForPage('document.getElementById("vaultPath").value==="picker-second"', "second vault Browse draft");
  const second = await evaluate(`(()=>{
    const toggle=()=>document.querySelector('[data-setting-action="vault-toggle"]').textContent;
    // Before any server update: the Browse result alone must already refresh the path and the button.
    const immediate={path:document.getElementById("vaultPathDisplay").textContent,label:toggle()};
    window.__ccDeliver({...structuredClone(window.__latestState),type:"state"});
    const browsed=document.getElementById("vaultPath").value,browsedLabel=toggle();
    const typed=document.getElementById("vaultPath");typed.value="typed-vault";typed.dispatchEvent(new Event("input",{bubbles:true}));
    window.__ccDeliver({...structuredClone(window.__latestState),type:"state"});
    return {immediate,browsed,browsedLabel,typed:document.getElementById("vaultPath").value,typedLabel:toggle()};
  })()`);
  assert.deepEqual(second.immediate, { path: "picker-second", label: "Connect" }, "a Browse result refreshes the vault path and button before any server update");
  assert.equal(second.browsed, "picker-second", "a Browse vault choice survives a broadcast after an earlier vault save finished");
  assert.equal(second.browsedLabel, "Connect", "the Browse choice keeps a Connect button, never flips to Disconnect");
  assert.equal(second.typed, "typed-vault", "a typed vault choice survives a broadcast");
  assert.equal(second.typedLabel, "Connect", "the typed choice keeps a Connect button");
  for (const cli of ["claude", "codex", "opencode", "plugin"]) {
    const result = await evaluate(`(()=>{
      const T=(e,v)=>{e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};const cli=${JSON.stringify(cli)},plugin=cli==="plugin",find=s=>{const e=document.querySelector(s);if(!e)throw Error("missing target "+s);return e};
      const selector=plugin?'[data-plugin-form]':'[data-mcp-form="'+cli+'"]', form=()=>find(selector);
      if(form().hidden)find('[data-settings-add="'+(plugin?'plugins-claude':'mcp-'+cli)+'"]').click();
      T(form().elements.name,"first_name");if(!plugin)T(form().elements.commandOrUrl,"npx -y first-server");form().requestSubmit();if(document.getElementById("confirmModal").hidden===false)document.getElementById("confirmOk").click();
      const type=plugin?"pluginInstall":"mcpAdd",m=window.__sent.filter(m=>m.type===type&&(plugin||m.cli===cli)).at(-1);
      T(form().elements.name,"newer_name");if(!plugin)T(form().elements.commandOrUrl,"https://newer.example/mcp");
      const s=structuredClone(window.__latestState);s.requestActions={...s.requestActions,[m.requestId]:{status:"done",requestId:m.requestId}};window.__ccDeliver({...s,type:"state"});
      const name=form().elements.name.value,command=plugin?null:form().elements.commandOrUrl.value;
      form().requestSubmit();if(document.getElementById("confirmModal").hidden===false)document.getElementById("confirmOk").click();const next=window.__sent.filter(m=>m.type===type&&(plugin||m.cli===cli)).at(-1);
      return {name,command,next};
    })()`);
    assert.equal(result.name,"newer_name", cli + " completed Add preserves newer name");
    assert.equal(result.next.name,"newer_name", cli + " next Add submits newer name");
    if(cli!=="plugin") {
      assert.equal(result.command,"https://newer.example/mcp",cli + " completed Add preserves newer command/url");
      assert.equal(result.next.commandOrUrl,"https://newer.example/mcp",cli + " next Add submits newer command/url");
    }
  }
  const pendingDrafts = await evaluate(`(()=>{
    const $=id=>document.getElementById(id),find=s=>{const e=document.querySelector(s);if(!e)throw Error("missing target "+s);return e};
    const deliver=s=>window.__ccDeliver({...s,type:"state"});
    const T=(e,v)=>{e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};
    T($("defaultProjectFolder"),"folder-one");find('[data-setting-action="folder-save"]').click();
    const f=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1);T($("defaultProjectFolder"),"folder-two");
    const s=structuredClone(window.__latestState);s.settings.folders={defaultProjectFolder:"folder-one"};s.requestActions={...s.requestActions,[f.requestId]:{status:"done",requestId:f.requestId}};deliver(s);
    const folder=$("defaultProjectFolder").value;find('[data-setting-action="folder-save"]').click();const resubmitted=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1).folder;
    const type=value=>{const e=$("vaultPath");e.value=value;e.dispatchEvent(new Event("input",{bubbles:true}))};
    type("save-one");find('[data-setting-action="vault-toggle"]').click();const v1=window.__sent.filter(m=>m.type==="setNotesVault").at(-1);type("newer-choice");
    const s1=structuredClone(window.__latestState);s1.settings.vault={path:"server-one"};s1.requestActions={...s1.requestActions,[v1.requestId]:{status:"done",requestId:v1.requestId}};deliver(s1);const newer=$("vaultPath").value;
    find('[data-setting-action="vault-toggle"]').click();const v2=window.__sent.filter(m=>m.type==="setNotesVault").at(-1);
    const s2=structuredClone(window.__latestState);s2.settings.vault={path:"server-two"};s2.requestActions={...s2.requestActions,[v2.requestId]:{status:"done",requestId:v2.requestId}};deliver(s2);const second=$("vaultPath").value;
    type("newer-choice");deliver(structuredClone(window.__latestState));const forgotten=$("vaultPath").value;
    return {folder,resubmitted,newer,second,forgotten};
  })()`);
  assert.equal(pendingDrafts.folder,"folder-two","a completed folder save must preserve a later edit");
  assert.equal(pendingDrafts.resubmitted,"folder-two","next Save submits the newer folder edit");
  const returnedDraft = await evaluate(`(()=>{
    const input=()=>document.querySelector("#defaultProjectFolder"),save=()=>document.querySelector('[data-setting-action="folder-save"]').click();
    const latest=()=>window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1),deliver=s=>window.__ccDeliver({...s,type:"state"});
    const T=(e,v)=>{e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};const prior=latest(),s=structuredClone(window.__latestState);s.settings.folders={defaultProjectFolder:"folder-two"};s.requestActions={...s.requestActions,[prior.requestId]:{status:"done",requestId:prior.requestId}};deliver(s);
    T(input(),"folder-three");save();const request=latest();T(input(),"folder-two");
    const done=structuredClone(window.__latestState);done.settings.folders={defaultProjectFolder:"folder-three"};done.requestActions={...done.requestActions,[request.requestId]:{status:"done",requestId:request.requestId}};deliver(done);
    const value=input().value;save();return {value,submitted:latest().folder};
  })()`);
  assert.equal(returnedDraft.value,"folder-two","a newer edit back to the prior server value survives completion");
  assert.equal(returnedDraft.submitted,"folder-two","next Save submits an edit back to the prior server value");
  const reopenedSave = await evaluate(`(()=>{
    const request=window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1);
    document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));document.querySelector("#setBtn").click();
    const s=structuredClone(window.__latestState);s.settings.folders={defaultProjectFolder:"reopened-saved"};s.requestActions={...s.requestActions,[request.requestId]:{status:"done",requestId:request.requestId}};window.__ccDeliver({...s,type:"state"});
    return document.querySelector("#defaultProjectFolder").value;
  })()`);
  assert.equal(reopenedSave,"reopened-saved","a save completed after Settings reopens does not treat an untouched field as a newer edit");
  // A draft means the user edited the field. A field never touched always shows the server value, whatever a pending save submitted.
  const untouched = await evaluate(`(()=>{
    const $=id=>document.getElementById(id),find=s=>{const e=document.querySelector(s);if(!e)throw Error("missing target "+s);return e};
    const T=(e,v)=>{e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};
    const close=()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})),open=()=>$("setBtn").click();
    const state=(folder,doneId)=>{const s=structuredClone(window.__latestState);s.settings.folders={defaultProjectFolder:folder};if(doneId)s.requestActions={...s.requestActions,[doneId]:{status:"done",requestId:doneId}};window.__ccDeliver({...s,type:"state"})};
    const value=()=>$("defaultProjectFolder").value,save=()=>{find('[data-setting-action="folder-save"]').click();return window.__sent.filter(m=>m.type==="setDefaultProjectFolder").at(-1)};
    const out={};
    close();open();state("srv");out.start=value();
    const f=save();state("srv2");out.mid=value();state("srv",f.requestId);out.done=value();
    state("srv3");out.later=value();const l=save();out.laterSent=l.folder;state("srv3",l.requestId);
    // a typed value the server normalizes: the saved draft is dropped, and the field follows the server again
    T($("defaultProjectFolder"),"typed");const g=save();state("norm",g.requestId);out.normalized=value();
    state("norm2");out.followsServer=value();
    // the finished save is forgotten: typing the same text again is a new edit
    T($("defaultProjectFolder"),"typed");state("norm2");out.typedAgain=value();
    // an edit made before Settings was closed is not carried into the next opening
    T($("defaultProjectFolder"),"stale");close();open();state("after-reopen");out.afterReopen=value();
    // a save from before Settings closed cannot clear a draft typed after it reopened
    T($("defaultProjectFolder"),"pre-close");const h=save();close();open();
    T($("defaultProjectFolder"),"pre-close");state("normalized-pre-close",h.requestId);out.preCloseSave=value();
    return out;
  })()`);
  assert.equal(untouched.start, "srv", "the folder field opens on the server value");
  assert.equal(untouched.mid, "srv2", "an untouched field follows a server change while its save is pending");
  assert.equal(untouched.done, "srv", "an untouched field shows the server value when the save completes");
  assert.equal(untouched.later, "srv3", "an untouched field keeps following the server after the save");
  assert.equal(untouched.laterSent, "srv3", "the next Save submits the server value, never a stale one");
  assert.equal(untouched.normalized, "norm", "a saved draft is replaced by the server's normalized value");
  assert.equal(untouched.followsServer, "norm2", "a saved field is no longer an edit and follows the server");
  assert.equal(untouched.typedAgain, "typed", "typing the same text after a finished save is a new edit that survives a broadcast");
  assert.equal(untouched.afterReopen, "after-reopen", "an unsaved edit does not survive closing Settings");
  assert.equal(untouched.preCloseSave, "pre-close", "a save from before Settings closed cannot clear a draft typed after it reopened");
  assert.equal(pendingDrafts.newer,"newer-choice","a completed vault save must preserve a later choice");
  assert.equal(pendingDrafts.second,"server-two","vault submit tracking must clear the second submitted draft");
  assert.equal(pendingDrafts.forgotten,"newer-choice","a completed vault save id must be forgotten before a later identical choice");
  // Round 11: editing back to the old saved value and a delayed picker must remain drafts.
  const vaultReturn = await evaluate(`(()=>{
    const $=id=>document.getElementById(id),close=()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    const state=(path,done)=>{const s=structuredClone(window.__latestState);s.settings.vault={path};if(done)s.requestActions={...s.requestActions,[done]:{requestId:done,status:"done"}};window.__ccDeliver({...s,type:"state"})};
    close();state("saved-A");$("setBtn").click();
    const type=v=>{const e=$("vaultPath");e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}))};
    const save=()=>{document.querySelector('[data-setting-action="vault-toggle"]').click();return window.__sent.filter(m=>m.type==="setNotesVault").at(-1)};
    type("submitted-B");const pending=save();type("saved-A");state("submitted-B",pending.requestId);
    const field=$("vaultPath").value,next=save();close();state("saved-A");$("setBtn").click();
    window.__originalPicker=window.cc.pickFolder;window.cc.pickFolder=()=>new Promise(resolve=>window.__resolveVaultPicker=resolve);
    document.querySelector('[data-setting-action="vault-browse"]').click();state("broadcast-B");window.__resolveVaultPicker("saved-A");
    return {field,submitted:next.path};
  })()`);
  await waitForPage('document.getElementById("vaultPath").value==="saved-A"', "delayed vault picker returned A");
  const vaultBrowseReturn = await evaluate(`(()=>{window.__ccDeliver({...structuredClone(window.__latestState),type:"state"});const field=document.getElementById("vaultPath").value;
    window.cc.pickFolder=window.__originalPicker;return field})()`);
  assert.deepEqual({typed:vaultReturn,browse:vaultBrowseReturn}, {typed:{field:"saved-A",submitted:"saved-A"},browse:"saved-A"},
    "vault return-to-A edits survive pending save completion and delayed Browse broadcasts");
  // A failed first vault save re-enables Connect before focus is put back, so the keyboard user keeps their place.
  await evaluate(`(()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));const s=structuredClone(window.__latestState),old=window.__sent.filter(m=>m.type==="setNotesVault").at(-1);s.settings.vault=null;s.requestActions={...s.requestActions,[old.requestId]:{requestId:old.requestId,status:"done"}};window.__ccDeliver({...s,type:"state"});
    document.getElementById("setBtn").click();window.__ccFolderChoice="failed-save-B";document.querySelector('[data-setting-action="vault-browse"]').click();return true})()`);
  await waitForPage('document.getElementById("vaultPath").value==="failed-save-B"', "failed-save vault Browse draft");
  const failedSave = await evaluate(`(()=>{
    const toggle=()=>document.querySelector('[data-setting-action="vault-toggle"]');
    toggle().focus();toggle().click();const m=window.__sent.filter(m=>m.type==="setNotesVault").at(-1);
    const s=structuredClone(window.__latestState);s.requestActions={...s.requestActions,[m.requestId]:{requestId:m.requestId,status:"failed",message:"Could not connect"}};window.__ccDeliver({...s,type:"state"});
    return {sent:m.path,disabled:toggle().disabled,label:toggle().textContent,focused:document.activeElement===toggle(),path:document.getElementById("vaultPath").value};
  })()`);
  assert.deepEqual(failedSave, { sent: "failed-save-B", disabled: false, label: "Connect", focused: true, path: "failed-save-B" },
    "a failed first vault save keeps the draft, re-enables Connect and leaves it focused");
  console.log("Settings lifecycle probes GREEN: focused Add clears, normalized Save, untouched refresh and submission, Browse-close-reopen, newer vault, second Browse and typed choice survive broadcasts");
  return { width: args.width, dialogs: [], chromePid: proc.pid };
}
