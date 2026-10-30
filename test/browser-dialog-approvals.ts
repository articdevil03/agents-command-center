import assert from "node:assert/strict";
import type { DialogPage } from "./browser-dialog-page.ts";

export async function approvalProbes(page: DialogPage) {
  const { evaluate, sendPage, waitForPage, delay } = page;
  const setup = async (ids: string[]) => evaluate(`(()=>{
    window.__ccApprovalReply="ok";
    const s=window.__ccSeed,t=s.projects.flatMap(p=>p.tabs).find(t=>t.id===s.selectedTabId);
    t.pendingApprovals=${JSON.stringify(ids)}.map((approvalId,i)=>({approvalId,tool:"Write",summary:approvalId,createdAt:i}));
    window.__ccDeliver({...structuredClone(s),type:"state"});return true;
  })()`);
  const sent = () => evaluate('window.__sent.filter(m=>m.type==="answerApproval").map(m=>m.approvalId)');
  const settled = () => waitForPage('!document.querySelector("#approvalAllow").disabled', "approval settled", 2000);
  // Reset between probes by really releasing every key and pointer the probes press; window blur has its own dedicated test below.
  const releaseHolds = async () => { await evaluate('(()=>{for(const id of [0,1,2,71,81,91])document.dispatchEvent(new PointerEvent("pointerup",{pointerId:id,bubbles:true}));for(const k of [{key:" ",code:"Space"},{key:" "},{key:"Enter",code:"Enter"}])document.dispatchEvent(new KeyboardEvent("keyup",{...k,bubbles:true}));return true})()'); await delay(30); };
  const mouse = async (type: string, clickCount = 1) => {
    const point = await evaluate('(()=>{const r=document.querySelector("#approvalAllow").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
    await sendPage("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount });
  };
  const key = (type: string, name = " ", repeat = false) => sendPage("Input.dispatchKeyEvent", { type, key: name, code: name === " " ? "Space" : "Enter", windowsVirtualKeyCode: name === " " ? 32 : 13, nativeVirtualKeyCode: name === " " ? 32 : 13, autoRepeat: repeat });
  await setup([]);
  await setup(["first"]);
  assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled && document.querySelector("#approvalDeny").disabled'), true, "first appearance disables both approval buttons");
  // The settle window is APPROVAL_SETTLE_MS = 400 on performance.now(). A real-time delay near that edge flakes on a slow PC, so the page's clock is held still and moved by hand:
  // 250 ms in, the same approval is broadcast again (a restart would end at 650 ms), and at 400 ms the buttons must be live. The real clock goes back before the next probe.
  await evaluate('(()=>{const real=performance.now.bind(performance);window.__ccRealPerf=real;window.__ccPerf=real();performance.now=()=>window.__ccPerf;return true})()');
  try {
    await setup([]); await setup(["first-held"]);
    assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled'), true, "a new approval starts disabled on the held clock");
    await evaluate("window.__ccPerf+=250;true"); await setup(["first-held"]);
    assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled'), true, "250 ms in, the buttons are still settling");
    await evaluate("window.__ccPerf+=149;true"); await setup(["first-held"]);
    assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled'), true, "399 ms in, the last millisecond is still settling");
    await evaluate("window.__ccPerf+=1;true"); await setup(["first-held"]);
    assert.equal(await evaluate('!document.querySelector("#approvalAllow").disabled'), true, "same-id broadcast does not restart settle: live 400 ms after the first appearance");
  } finally { await evaluate("performance.now=window.__ccRealPerf;true"); }
  await setup([]); await delay(1700); await setup(["idle"]);
  assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled'), true, "appearance after idle starts settle"); await settled();

  // Native double-click, plus a press held on A until well after B settles.
  for (const interval of [30, 450, 1000]) {
    await setup([]); await setup([`native-A-${interval}`, `native-B-${interval}`]); await settled();
    const before = (await sent()).length;
    await mouse("mousePressed"); await mouse("mouseReleased");
    await delay(interval); await mouse("mousePressed", 2); await mouse("mouseReleased", 2);
    assert.deepEqual((await sent()).slice(before), [`native-A-${interval}`], `native double-click ${interval}ms answers only A`);
    await setup([]); await setup([`press-A-${interval}`]); await settled();
    const pressBefore = (await sent()).length;
    await mouse("mousePressed"); await setup([`press-B-${interval}`]); await delay(Math.max(450, interval)); await mouse("mouseReleased");
    assert.deepEqual((await sent()).slice(pressBefore), [], `native press started on A cannot answer B after ${interval}ms`);
  }
  await setup([]); await setup(["early-A"]);
  const earlyBefore = (await sent()).length;
  await mouse("mousePressed"); await settled(); await mouse("mouseReleased");
  assert.deepEqual((await sent()).slice(earlyBefore), [], "native pointer-down before settle cannot activate after settle");
  // Chrome suppresses activation of a press on a disabled button. Force the delayed click separately
  // so deleting the listener's settle check still goes RED, independent of that browser behavior.
  await delay(50); await setup([]); await setup(["early-listener"]);
  await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));true');
  await settled();
  await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:1}));true');
  assert.deepEqual((await sent()).slice(earlyBefore), [], "pointer listener rejects delayed activation from before settle");
  for (const name of [" ", "Enter"]) {
    await setup([]); await setup(["held-A"]); await settled();
    await evaluate('document.querySelector("#approvalAllow").focus();true');
    const before = (await sent()).length;
    await key("keyDown", name); await delay(1700); await setup(["held-B"]); await settled();
    await key("keyUp", name);
    assert.equal((await sent()).slice(before).includes("held-B"), false, `native held ${name === " " ? "Space" : "Enter"} cannot answer replacement B`);
    await evaluate('document.querySelector("#approvalAllow").focus();true');
    await key("keyDown", name); await key("keyUp", name);
    assert.equal((await sent()).at(-1), "held-B", "fresh keyboard press answers settled B");
    // Keep forced activation and repeat controls separate from the native hold/replace/release probe.
    const suffix = name === " " ? "space" : "enter";
    await setup([]); await setup(["control-A-" + suffix]); await settled();
    await evaluate('document.querySelector("#approvalAllow").focus();true');
    const controlBefore = (await sent()).length;
    await key("keyDown", name); await setup(["control-B-" + suffix]); await settled();
    await key("keyDown", name, true);
    assert.equal((await sent()).slice(controlBefore).includes("control-B-" + suffix), false, "native repeat cannot answer a replacement");
    await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
    assert.equal((await sent()).slice(controlBefore).includes("control-B-" + suffix), false, "delayed keyboard activation remains bound to key-down ID");
    await key("keyUp", name);
  }
  // A repeat key-down that reaches the panel (synthetic, so focus loss on a disabled button cannot hide it) must not re-bind the press to B.
  await setup([]); await setup(["repeat-A"]); await settled();
  const repeatBefore = (await sent()).length;
  await evaluate('document.querySelector("#approvalAllow").focus();true');
  await key("keyDown", " "); await setup(["repeat-B"]); await settled();
  await evaluate('document.querySelector("#approvalPanel").dispatchEvent(new KeyboardEvent("keydown",{key:" ",repeat:true,bubbles:true}));true');
  await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
  assert.equal((await sent()).slice(repeatBefore).includes("repeat-B"), false, "a repeat key-down reaching the panel never re-binds the press to B");
  await key("keyUp", " ");
  // Rejected activations cannot consume a press that is still held, including presses outside the panel.
  for (const kind of ["keyboard", "pointer", "outside-key", "outside-pointer"]) {
    await releaseHolds();
    await setup([]); await setup([kind + "-held-A"]); await settled();
    const before = (await sent()).length;
    const outside = kind.startsWith("outside");
    const pointer = kind.includes("pointer");
    if (!outside) { if (pointer) await mouse("mousePressed"); else { await evaluate('document.querySelector("#approvalAllow").focus();true'); await key("keyDown", " "); } }
    else await evaluate('(()=>{const b=document.querySelector(' + JSON.stringify(outside ? "#setBtn" : "#approvalAllow") + ');if(!b)throw Error("missing held-input target");b.dispatchEvent(new ' + (pointer ? 'PointerEvent("pointerdown",{pointerId:71,bubbles:true})' : 'KeyboardEvent("keydown",{key:" ",bubbles:true})') + ');return true})()');
    await setup([kind + "-held-B"]); await settled();
    await evaluate('document.querySelector("#approvalAllow").click();document.querySelector("#approvalAllow").click();true');
    assert.deepEqual((await sent()).slice(before), [], kind + " repeated press-less clicks answer nothing while held");
    if (!outside) { if (pointer) await mouse("mouseReleased"); else await key("keyUp", " "); }
    else await evaluate('document.dispatchEvent(new ' + (pointer ? 'PointerEvent("pointerup",{pointerId:71,bubbles:true})' : 'KeyboardEvent("keyup",{key:" ",bubbles:true})') + ');true'); await delay(30);
    await evaluate('document.querySelector("#approvalAllow").click();true');
    assert.deepEqual((await sent()).slice(before), [kind + "-held-B"], kind + " release allows a genuine press-less click");
  }
  for (const pointer of [false, true]) {
    await releaseHolds();
    await setup([]);await setup(["release-record-A"]);await settled();
    const before=(await sent()).length;
    await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new '+(pointer?'PointerEvent("pointerdown",{bubbles:true})':'KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true})')+');true');
    await setup(["release-record-B"]);await settled();
    if (!pointer) { await evaluate('document.dispatchEvent(new KeyboardEvent("keyup",{key:" ",code:"OtherSpace",bubbles:true}));true'); await delay(30); }
    await evaluate('document.querySelector("#approvalAllow").click();document.dispatchEvent(new '+(pointer?'PointerEvent("pointerup",{bubbles:true})':'KeyboardEvent("keyup",{key:" ",code:"Space",bubbles:true})')+');document.querySelector("#approvalAllow").click();true');
    assert.deepEqual((await sent()).slice(before),[],(pointer?"pointer":"key")+" release activation remains bound after a rejected click");
    await delay(30);await evaluate('document.querySelector("#approvalAllow").click();true');
    assert.deepEqual((await sent()).slice(before),["release-record-B"],"released record is cleared before a genuine later activation");
  }
  // Screen reader or voice control: a click with no key or pointer press before it answers the shown, settled approval.
  await setup([]); await setup(["reader-A"]); await settled();
  const readerBefore = (await sent()).length;
  await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
  assert.deepEqual((await sent()).slice(readerBefore), ["reader-A"], "press-less click answers the settled shown approval");
  // ...but never while a pointer press that began on another approval is still down.
  await setup([]); await setup(["reader-pA"]); await settled();
  const readerPointerBefore = (await sent()).length;
  await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));true');
  await setup(["reader-pB"]); await settled();
  await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
  assert.deepEqual((await sent()).slice(readerPointerBefore), [], "press-less click is rejected while a pointer press for another approval is down");
  // A cancelled pointer (a finger that turned into a scroll) sends pointercancel and no pointerup; it must release the hold so a later screen-reader click answers.
  for (const onButton of [false, true]) {
    await releaseHolds();
    await setup([]); await setup(["cancel-" + onButton + "-A"]); await settled();
    const cancelBefore = (await sent()).length;
    await evaluate('document.querySelector(' + JSON.stringify(onButton ? "#approvalAllow" : "#setBtn") + ').dispatchEvent(new PointerEvent("pointerdown",{pointerId:81,bubbles:true}));true');
    await setup(["cancel-" + onButton + "-B"]); await settled();
    await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
    assert.deepEqual((await sent()).slice(cancelBefore), [], "a press-less click is rejected while the pointer is still held");
    await evaluate('document.dispatchEvent(new PointerEvent("pointercancel",{pointerId:81,bubbles:true}));true');
    await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
    assert.deepEqual((await sent()).slice(cancelBefore), ["cancel-" + onButton + "-B"], "pointercancel releases the held pointer and its press record so a press-less click answers the shown approval");
  }
  // Losing window focus drops every held key, held pointer and press record (the release may never reach the page).
  for (const pointer of [false, true]) {
    await releaseHolds();
    await setup([]); await setup(["blur-" + pointer + "-A"]); await settled();
    const blurBefore = (await sent()).length;
    await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new ' + (pointer ? 'PointerEvent("pointerdown",{pointerId:91,bubbles:true})' : 'KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true})') + ');true');
    await setup(["blur-" + pointer + "-B"]); await settled();
    await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
    assert.deepEqual((await sent()).slice(blurBefore), [], "a press-less click is rejected while the input is still held");
    await evaluate('window.dispatchEvent(new Event("blur"));true');
    await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
    assert.deepEqual((await sent()).slice(blurBefore), ["blur-" + pointer + "-B"], "window blur clears the " + (pointer ? "pointer" : "key") + " hold and press record so a press-less click answers");
  }
  // A deliberate multi-click on a settled approval answers nothing and says why; a single click then answers and clears the message.
  await setup([]); await setup(["multi-A"]); await settled();
  const multiBefore = (await sent()).length;
  await evaluate('(()=>{const b=document.querySelector("#approvalAllow");b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));b.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:2}));return true})()');
  assert.deepEqual((await sent()).slice(multiBefore), [], "multi-click on a settled approval answers nothing");
  assert.equal(await evaluate('document.querySelector("#approvalError").textContent'), "Click once to answer.", "multi-click shows why nothing happened");
  await evaluate('(()=>{const b=document.querySelector("#approvalAllow");b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));b.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:1}));return true})()');
  assert.deepEqual((await sent()).slice(multiBefore), ["multi-A"], "a single click then answers");
  // A system clock jump back during the settle must not keep the buttons disabled.
  await setup([]); await setup(["clock-A"]);
  await evaluate('window.__realNow=Date.now;Date.now=()=>window.__realNow()-3600000;true');
  try { await delay(900); assert.equal(await evaluate('document.querySelector("#approvalAllow").disabled'), false, "a backwards clock jump does not keep the approval buttons disabled"); } finally { await evaluate('Date.now=window.__realNow;true'); }
  // Deferred release cleanup cannot erase a new press made in the same event-loop turn.
  for (const kind of ["pointer", "keyboard"]) {
    await setup([]); await setup([kind + "-cleanup"]); await settled();
    const before = (await sent()).length;
    await evaluate('(()=>{const b=document.querySelector("#approvalAllow");' + (kind === "pointer"
      ? 'b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));b.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}));b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));'
      : 'b.dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true}));b.dispatchEvent(new KeyboardEvent("keyup",{key:" ",bubbles:true}));b.dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true}));') + 'return true})()');
    await delay(50);
    await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:' + (kind === "pointer" ? 1 : 0) + '}));true');
    assert.deepEqual((await sent()).slice(before), [kind + "-cleanup"], kind + " release cleanup preserves a newer press");
  }
  // A key press made during the settle stays bound to "no approval": an earlier release's deferred cleanup must not erase it,
  // or the press-less fallback would let a later click answer the approval the press never saw.
  await setup([]); await setup(["settle-key"]);
  const settleKeyBefore = (await sent()).length;
  await evaluate('(()=>{const p=document.querySelector("#approvalPanel"),k=(t)=>p.dispatchEvent(new KeyboardEvent(t,{key:" ",bubbles:true}));k("keydown");k("keyup");k("keydown");return true})()');
  await settled(); await delay(50);
  await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0}));true');
  assert.deepEqual((await sent()).slice(settleKeyBefore), [], "a key press made during the settle cannot answer after it, even after a release cleanup");
  await evaluate('document.querySelector("#approvalPanel").dispatchEvent(new KeyboardEvent("keyup",{key:" ",bubbles:true}));true'); await delay(20);
  // Two pointers: releasing the old A pointer must neither answer B nor erase B's fresh press.
  await setup([]); await setup(["pointer-A"]); await settled();
  const pointerBefore = (await sent()).length;
  await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerId:1}));true');
  await setup(["pointer-B"]); await settled();
  await evaluate('(()=>{const b=document.querySelector("#approvalAllow");b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerId:2}));b.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,pointerId:1}));b.dispatchEvent(new PointerEvent("click",{bubbles:true,pointerId:1,detail:1}));return true})()');
  await delay(50);
  assert.deepEqual((await sent()).slice(pointerBefore), [], "old pointer cannot consume another pointer's B press");
  await evaluate('document.querySelector("#approvalAllow").dispatchEvent(new PointerEvent("click",{bubbles:true,pointerId:2,detail:1}));true');
  assert.deepEqual((await sent()).slice(pointerBefore), ["pointer-B"], "old pointer-up cannot erase B's fresh pointer press");
  console.log("Pointer identity controls GREEN: synthetic multi-pointer delivery");
  await setup([]);
  console.log("Native approval probes GREEN: first/idle/same-id settle, 30/450/1000ms double-click and stale pointer, pre-settle press, held Space/Enter, fresh keyboard activation");
}
