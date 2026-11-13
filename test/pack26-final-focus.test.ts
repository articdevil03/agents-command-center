// Pack 26 final cleanup: a restored browser guard for the live seat card (public/app/10-dialogs-seat-card.js, focusTarget.disabled).
import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliverState } from "./pack18-editor-harness.ts";

const RUN = "p26f-focus-run";

test("P26F disabled seat-card control keeps focus in the card", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, discovered, fixed }) => {
    // A live Coder run on the selected fixed tab, as the server lists it.
    const live = `const tab=state.projects[0].tabs.find((t)=>t.id===${J(fixed.id)});const seat=tab.crew.find((s)=>s.slot==="coder");
      const base={id:${J(RUN)},crewGenerationId:tab.processState.crewGenerationId,seatSlotId:"coder",seatName:seat.name,seatIsLeader:false,label:"Focus run",status:"working",outcome:null,cli:seat.cli,model:seat.model,effort:seat.effort,folderPath:tab.folder,startedAt:Date.now()-5000,endedAt:null};
      tab.runs.push({...base,runId:${J(RUN)},seatKey:seat.seatKey,output:"",launchedBy:null});tab.processState.runs.push(base);
      Object.assign(seat,{status:"working",task:"Working · Focus run",runs:[${J(RUN)}]});tab.processState.seats.find((s)=>s.slotId==="coder").status="working";
      tab.derived.busy=true;tab.derived.runViews={liveBySeat:{coder:[base]},history:[],retiredHistory:[]}`;
    await deliverState(ev, discovered, live);
    await click(ev, '#crew [data-seat-pic="coder"]');
    const stop = `#seatPop [data-stop-run=${J(RUN)}]`;
    await waitFor(`Boolean(document.querySelector(${J(stop)}))&&!document.getElementById("seatPop").hidden`, "the live card shows the run's Stop control");
    await ev(`document.querySelector(${J(stop)}).focus();true`);
    assert.equal(await ev(`document.activeElement===document.querySelector(${J(stop)})&&!document.activeElement.disabled`), true, "control: the enabled Stop control holds focus before the update");
    // The server now says this seat is stopped: the card redraws and the focused control comes back disabled.
    await deliverState(ev, discovered, `${live};tab.processState.seats.find((s)=>s.slotId==="coder").status="stopped"`);
    const after = await ev(`(()=>{const stop=document.querySelector(${J(stop)}),a=document.activeElement;return {locked:Boolean(stop&&stop.disabled),inCard:Boolean(a?.closest("#seatPop")),body:a===document.body,enabled:Boolean(a&&!a.disabled),tag:a?.tagName,attr:a?[...a.attributes].map((x)=>x.name).filter((n)=>n.startsWith("data-")).join(",")+"|"+a.className:null}})()`);
    assert.equal(after.locked, true, "control: the update really disabled the focused Stop control");
    assert.deepEqual([after.body, after.inCard, after.enabled], [false, true, true], `focus moved to an enabled control inside the card, not the page body: ${JSON.stringify(after)}`);
    console.log(`PAGE focus after the control locked: ${JSON.stringify(after)}`);
  }, { fixture: "fixed" });
});
