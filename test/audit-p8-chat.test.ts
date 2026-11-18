import test from "node:test";
import assert from "node:assert/strict";
import { withPage, deliverState, J, delay } from "./pack18-editor-harness.ts";

const user = { role: "user", text: "Earlier question", revision: 1, at: 1700000000000 };
const answer = (text: string, revision = 2) => ({ role: "assistant", text, revision, at: 1700000001000 });

test('P8 cached fallback is selected on the server after hiding the selected tab', async () => {
  await withPage(async ({ ev, discovered, fixed, secondFixed }) => {
    await deliverState(ev, discovered);
    await ev(`__ccDeliver({type:'chatHistory',tabId:${J(secondFixed.id)},messages:[]});__sent.length=0;pendingActions.set('hide',{hideTabId:${J(fixed.id)}});renderAll();true`);
    assert.equal(await ev(`__sent.some(m=>m.type==='selectTab'&&m.tabId===${J(secondFixed.id)})`), true, 'a cached visible fallback must also become the server selection');
  }, { fixture: 'fixed2' });
});

for (const width of [390, 1440]) {
  test(`P8 drafts survive refresh and switching and settle once at ${width}px`, async () => {
    await withPage(async ({ ev, page, discovered, fixed, secondFixed }) => {
      await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await deliverState(ev, discovered);
      const tabId = fixed.id, other = secondFixed.id;
      const deliver = (message: object) => ev(`__ccDeliver(${J({ tabId, ...message })});true`);
      const bubble = () => ev(`document.querySelector('#view [data-stream] .md')?.textContent??null`);
      await deliver({ type: "chatHistory", messages: [user] });
      await deliver({ type: "chatDelta", text: "Draft before refresh" });
      await deliver({ type: "chatHistory", messages: [user] });
      assert.equal(await bubble(), "Draft before refresh", "history must preserve the active draft");
      await ev(`selectTabFromUser(${J(other)});selectTabFromUser(${J(tabId)});true`);
      assert.equal(await bubble(), "Draft before refresh", "switching back must preserve the whole draft");
      await deliver({ type: "chatDelta", text: " and its tail" });
      await delay(80);
      await deliver({ type: "chatMessage", ...answer("Draft before refresh and its tail") });
      assert.equal(await bubble(), null, "the final message itself settles its draft");
      await deliver({ type: "chatDone" });
      assert.equal(await ev(`document.querySelectorAll('#view [data-message-id="2"]').length`), 1);
      assert.equal(await bubble(), null, "Done leaves no ghost draft");

      await deliver({ type: "chatDelta", text: "Interrupted words" });
      await deliver({ type: "chatMessage", ...answer("Interrupted words\nCould not finish", 3) });
      await deliver({ type: "chatError", message: "Could not finish" });
      assert.equal(await bubble(), null, "error after a saved partial reply leaves no duplicate");
      assert.equal(await ev(`document.querySelector('[data-message-id="3"] .md').textContent`), "Interrupted wordsCould not finish");
      await deliver({ type: "chatDelta", text: "Unsaved interrupted words" });
      await deliver({ type: "chatError", message: "Could not save the answer" });
      assert.equal(await bubble(), null, "an unsaved errored reply stops streaming");
      assert.equal(await ev(`document.querySelector('[data-interrupted-reply] .md')?.textContent??null`), "Unsaved interrupted words", "error without a saved final message must not lose text");
      await deliver({ type: "chatHistory", messages: [user] });
      assert.equal(await ev(`document.querySelectorAll('[data-interrupted-reply]').length`), 1, "an older snapshot cannot erase unsaved text");
      await deliver({ type: "chatHistory", messages: [user, answer("Unsaved interrupted words", 4)] });
      assert.equal(await ev(`document.querySelectorAll('[data-interrupted-reply]').length`), 0, "a confirmed saved copy replaces the local fallback");

      await deliver({ type: "chatDelta", text: "Split words" });
      await deliver({ type: "chatMessage", ...answer("Split words", 5), split: true });
      await deliver({ type: "chatDelta", text: "Next segment" });
      await deliver({ type: "chatHistory", messages: [user, answer("Split words", 5)] });
      assert.equal(await bubble(), "Next segment", "history keeps only the current segment after a split");
      await deliver({ type: "chatCleared", messages: [], noUndo: true });
      assert.equal(await bubble(), null, "Clear removes the draft");
      await deliver({ type: "chatRestored", messages: [user, answer("Split words", 5)] });
      assert.equal(await bubble(), null, "restore cannot revive a cleared draft");
      assert.equal(await ev(`document.querySelectorAll('[data-message-id="5"]').length`), 1);
      await deliver({ type: "chatDelta", text: "Stale before restore" });
      await deliver({ type: "chatRestored", messages: [user, answer("Restored once", 5)] });
      assert.equal(await bubble(), null, "restore itself settles any old draft");
    }, { fixture: "fixed2" });
  });

  test(`P8 selection and unchanged nodes survive broadcasts at ${width}px`, async () => {
    await withPage(async ({ ev, page, discovered, fixed, work }) => {
      await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await deliverState(ev, discovered);
      const id = fixed.id;
      await ev(`__ccDeliver({type:'chatHistory',tabId:${J(id)},messages:${J([user, answer("Selected chat words")])}});true`);
      const select = (selector: string) => ev(`(()=>{window.__selectedNode=document.querySelector(${J(selector)});const n=__selectedNode.firstChild;const r=document.createRange();r.setStart(n,0);r.setEnd(n,8);getSelection().removeAllRanges();getSelection().addRange(r);window.__selectedText=getSelection().toString();return __selectedText})()`);
      const stable = (selector: string) => ev(`document.querySelector(${J(selector)})===window.__selectedNode&&getSelection().toString()===window.__selectedText&&getSelection().anchorNode===__selectedNode.firstChild`);
      assert.equal(await select('[data-message-id="2"] .md p'), "Selected");
      await ev(`__ccDeliver({...structuredClone(__ccSeed),type:'state'});true`);
      assert.equal(await stable('[data-message-id="2"] .md p'), true, "unrelated state preserves chat node and real Selection range");
      await ev(`__ccDeliver({type:'chatDelta',tabId:${J(id)},text:'New live words'});true`);
      assert.equal(await stable('[data-message-id="2"] .md p'), true, "streaming keeps selected earlier messages");
      await ev(`__ccDeliver({type:'chatDone',tabId:${J(id)}});true`);
      await ev(`__ccDeliver({type:'chatHistory',tabId:${J(id)},messages:${J([user, answer("Inserted earlier reply", 1.5), answer("Selected chat words")])}});true`);
      assert.equal(await stable('[data-message-id="2"] .md p'), true, "inserting earlier history preserves an unchanged selected message");
      const run = { runId: "p8-log", seatSlotId: "coder", seatKey: `${id}.coder`, crewGenerationId: discovered.projects[0].tabs[0].processState.crewGenerationId, status: "working", output: "Selected log words\n", startedAt: Date.now(), label: "Check output", cli: "codex", model: "gpt-6.1-sol", folderPath: work };
      await ev(`(()=>{const t=__ccSeed.projects[0].tabs[0];t.runs=[${J(run)}];__ccDeliver({...structuredClone(__ccSeed),type:'state'});openSeatView(${J(id)},'coder');return true})()`);
      assert.equal(await select('[data-output-run="p8-log"]'), "Selected");
      await ev(`__ccSeed.projects[0].tabs[0].runs[0].usage={inputTokens:2345,outputTokens:99};__ccSeed.projects[0].tabs[0].runs[0].startedAt-=10000;__ccDeliver({...structuredClone(__ccSeed),type:'state'});true`);
      assert.equal(await stable('[data-output-run="p8-log"]'), true, "header timer and usage changes preserve selected log node and range");
      await ev(`__ccDeliver({type:'output',runId:'p8-log',chunk:'Real new output'});true`);
      assert.equal(await ev(`document.querySelector('[data-output-run="p8-log"]').textContent`), "Selected log words\nReal new output");
      assert.equal(await stable('[data-output-run="p8-log"]'), true, "appending output preserves the range");
      await ev(`__ccSeed.projects[0].tabs[0].runs[0].output='Changed snapshot';__ccDeliver({...structuredClone(__ccSeed),type:'state'});true`);
      assert.equal(await ev(`document.querySelector('[data-output-run="p8-log"]').textContent`), "Changed snapshot", "real snapshot changes still appear");
      const stamp = 1700000000000;
      const detail = { type: "historyRun", seatKey: `${id}.leader`, timestamp: stamp, output: "Selected saved log", outcome: { status: "done", exitCode: 0 } };
      await ev(`showLeaderHistory(currentTab());__ccDeliver({type:'historyList',seatKey:${J(`${id}.leader`)},runs:[{timestamp:${stamp},outcome:{status:'done',exitCode:0}}]});document.querySelector('[data-history-timestamp]').click();__ccDeliver(${J(detail)});true`);
      assert.equal(await select('.runs .term pre'), "Selected");
      await ev(`__ccDeliver({...structuredClone(__ccSeed),type:'state'});true`);
      assert.equal(await stable('.runs .term pre'), true, "saved logs retain the real selection across broadcasts too");
      await ev(`__ccDeliver(${J({ ...detail, output: "Changed saved log" })});true`);
      assert.equal(await ev(`document.querySelector('.runs .term pre').textContent`), "Changed saved log");
    });
  });
}

test("P8 two connected pages load full history independently and reset completeness on Clear, removal and reconnect", async () => {
  await withPage(async ({ ev, discovered, fixed, secondFixed }) => {
    await deliverState(ev, discovered);
    const id = secondFixed.id;
    await withPage(async (peer) => {
      const full = [user, answer("Complete shared history"), answer("Background tail", 3)];
      // Both isolated real pages connect to this same fake server state and history.
      const shared = structuredClone(discovered); shared.selectedTabId = fixed.id;
      for (const client of [{ ev }, peer]) {
        await client.ev(`window.__sharedState=${J(shared)};window.__full=${J(full)};window.__historyRequests=0;__socket.send=raw=>{const m=JSON.parse(raw);if(m.type==='selectTab'){__historyRequests++;__ccDeliver({type:'chatHistory',tabId:m.tabId,messages:structuredClone(__full)})}};__ccDeliver({...structuredClone(__sharedState),type:'state'});__ccDeliver({type:'chatMessage',tabId:${J(id)},...${J(answer("Background tail",3))}});__sharedState.selectedTabId=${J(id)};__ccDeliver({...structuredClone(__sharedState),type:'state'});true`);
      }
      for (const client of [{ ev }, peer]) {
        assert.ok(await client.ev(`__historyRequests`) > 0, "each page requests complete history despite having received a background message");
        assert.equal(await client.ev(`document.querySelector('#view').textContent.includes('Complete shared history')`), true);
        const count = await client.ev(`__historyRequests`);
        await client.ev(`__ccDeliver({...structuredClone(__sharedState),type:'state'});true`);
        assert.equal(await client.ev(`__historyRequests`), count, "a confirmed complete history is not requested again on every broadcast");
      }
    }, { fixture: "fixed2" });
    const before = await ev(`__historyRequests`);
    await ev(`__ccDeliver({type:'chatCleared',tabId:${J(id)},messages:[],noUndo:true});renderAll();true`);
    await delay(80);
    assert.ok(await ev(`__historyRequests`) > before, "Clear invalidates completeness");
    const afterClear = await ev(`__historyRequests`);
    await ev(`(()=>{const removed=structuredClone(__sharedState);removed.projects[0].tabs=removed.projects[0].tabs.filter(t=>t.id!==${J(id)});removed.selectedTabId=${J(fixed.id)};__ccDeliver({...removed,type:'state'});__ccDeliver({...structuredClone(__sharedState),type:'state'});return true})()`);
    await delay(80);
    assert.ok(await ev(`__historyRequests`) > afterClear, "removal invalidates completeness even when the same tab id returns");
    await ev(`__socket.close();true`);
    await delay(1200);
    await ev(`__ccDeliver({...structuredClone(__sharedState),type:'state'});true`);
    await delay(80);
    assert.equal(await ev(`document.querySelector('#view').textContent.includes('Complete shared history')`), false, "reconnect loads fresh empty server history instead of trusting the old cache");
  }, { fixture: "fixed2" });
});


test('P8 hello, removal, Clear and restore invalidate complete cached transcripts', async () => {
  await withPage(async ({ ev, discovered, fixed }) => {
    await deliverState(ev, discovered);
    await ev('__socket.send=raw=>__sent.push(JSON.parse(raw));true');
    const cache = () => ev('transcriptRequests.clear();__ccDeliver({type:"chatHistory",tabId:'+J(fixed.id)+',messages:[]});__sent.length=0;true');
    const requested = () => ev('__sent.some(m=>m.type==="selectTab"&&m.tabId==='+J(fixed.id)+')');
    await cache();
    await ev('send({type:"hello"});renderAll();true');
    assert.equal(await requested(), true, 'hello must invalidate a previous connection cache before rendering');
    for (const type of ['chatCleared', 'chatRestored']) {
      await cache();
      await ev('__ccDeliver({type:'+J(type)+',tabId:'+J(fixed.id)+',messages:[],noUndo:true});renderAll();true');
      assert.equal(await requested(), true, type+' must fetch a fresh snapshot');
    }
    await cache();
    await ev('(()=>{const removed=structuredClone(__ccSeed);removed.projects[0].tabs=[];__ccDeliver({...removed,type:"state"});__ccDeliver({...structuredClone(__ccSeed),type:"state"});return true})()');
    assert.equal(await requested(), true, 'a removed and returned tab must fetch a fresh snapshot');
  });
});
