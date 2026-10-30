import assert from "node:assert/strict";
import type { DialogPage } from "./browser-dialog-page.ts";

export async function seatPointerProbes(page: DialogPage) {
  const { evaluate, sendPage } = page;
  // Real pointer input (press, then release, like a person): the card closes on pointerdown, and the press must still become a click.
  const point = (selector: string) => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  const realClick = async (selector: string) => {
    const where = await point(selector);
    await sendPage("Input.dispatchMouseEvent", { type: "mouseMoved", ...where });
    await sendPage("Input.dispatchMouseEvent", { type: "mousePressed", ...where, button: "left", clickCount: 1 });
    await sendPage("Input.dispatchMouseEvent", { type: "mouseReleased", ...where, button: "left", clickCount: 1 });
  };
  const name = (slot: string) => `#crew [data-seat-id="${slot}"] [data-seat-open]`;
  const pic = (slot: string) => `#crew [data-seat-id="${slot}"] [data-seat-pic]`;
  await evaluate('(()=>{const b=document.querySelector("#view [data-back-chat], #view [data-chat-live]");if(b)b.click();return true})()');
  const workers: string[] = await evaluate('[...document.querySelectorAll("#crew .seat")].map((row)=>row.dataset.seatId).filter((slot)=>slot!=="leader")');
  assert.ok(workers.length >= 2 && workers.includes("coder"), `the rail has workers: ${workers}`);
  // The card opens below its picture and covers the rows under it: open the LAST worker's card, then press a worker row above it.
  const lower = workers.at(-1)!, upper = workers[0];
  await evaluate(`document.querySelector(${JSON.stringify(pic(lower))}).click();true`);
  assert.equal(await evaluate(`!document.getElementById("seatPop").hidden && document.getElementById("seatPop").dataset.slot===${JSON.stringify(lower)}`), true, "the lower worker's card is open");
  await realClick(name(upper));
  assert.deepEqual(await evaluate(`({viewing:document.querySelector(${JSON.stringify(name(upper))}).hasAttribute("aria-current"),head:Boolean(document.querySelector("#stagehead.wv")),cardHidden:document.getElementById("seatPop").hidden,expanded:[...document.querySelectorAll("#crew [aria-expanded]")].filter((b)=>b.getAttribute("aria-expanded")==="true").length})`), { viewing: true, head: true, cardHidden: true, expanded: 0 }, "a real click on a worker's name while a card is open opens its work view");
  // The same press on the leader's name (the top row) while a worker's view is showing and a card is open below it.
  await evaluate(`document.querySelector(${JSON.stringify(pic(lower))}).click();true`);
  assert.equal(await evaluate(`!document.getElementById("seatPop").hidden && document.getElementById("seatPop").dataset.slot===${JSON.stringify(lower)}`), true, "a card is open over a worker's view");
  await realClick(name("leader"));
  assert.deepEqual(await evaluate(`({workView:Boolean(document.querySelector("#stagehead.wv")),upperViewing:document.querySelector(${JSON.stringify(name(upper))}).hasAttribute("aria-current"),cardHidden:document.getElementById("seatPop").hidden})`), { workView: false, upperViewing: false, cardHidden: true }, "a real click on the leader's name while a worker's view shows returns to the chat");
  // Pictures with the real pointer: open from one, retarget to another seat's picture, Escape, press the same picture to close, and the viewed seat keeps its highlight.
  const card = (slot: string) => `({open:!document.getElementById("seatPop").hidden,slot:document.getElementById("seatPop").dataset.slot,expanded:[...document.querySelectorAll("#crew [data-seat-pic][aria-expanded='true']")].map((b)=>b.dataset.seatPic),focus:document.activeElement?.dataset?.seatPic??null,want:${JSON.stringify(slot)}})`;
  await realClick(pic(upper));
  const opened = await evaluate(card(upper));
  assert.deepEqual({ open: opened.open, slot: opened.slot, expanded: opened.expanded }, { open: true, slot: upper, expanded: [upper] }, "a real click on a picture opens that seat's card");
  await realClick(pic(lower));
  const retargeted = await evaluate(card(lower));
  assert.deepEqual({ open: retargeted.open, slot: retargeted.slot, expanded: retargeted.expanded }, { open: true, slot: lower, expanded: [lower] }, "a real click on another seat's picture switches the open card to that seat");
  const escape = async (type: string) => sendPage("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await escape("keyDown"); await escape("keyUp");
  assert.deepEqual(await evaluate(`({hidden:document.getElementById("seatPop").hidden,focus:document.activeElement?.dataset?.seatPic??null,expanded:document.querySelectorAll("#crew [aria-expanded='true']").length})`), { hidden: true, focus: lower, expanded: 0 }, "Escape closes the card and returns focus to the picture it was last opened from");
  await realClick(pic(lower));
  assert.equal(await evaluate('!document.getElementById("seatPop").hidden'), true, "the picture opens the card again");
  await realClick(pic(lower));
  assert.deepEqual(await evaluate(`({hidden:document.getElementById("seatPop").hidden,expanded:document.querySelectorAll("#crew [aria-expanded='true']").length})`), { hidden: true, expanded: 0 }, "pressing the same picture again closes the card");
  await realClick(name(upper));
  await realClick(pic(lower)); await realClick(pic(lower));
  assert.deepEqual(await evaluate(`({hidden:document.getElementById("seatPop").hidden,upperOn:document.querySelector('#crew [data-seat-id="${upper}"]').classList.contains("on"),lowerOn:document.querySelector('#crew [data-seat-id="${lower}"]').classList.contains("on")})`), { hidden: true, upperOn: true, lowerOn: false }, "after the card closes, the seat whose work is showing keeps its highlight");
  // Picture -> Model -> Escape with the real keyboard: opening the card redraws the crew, and focus still lands on the visible picture. Back -> Escape too.
  const visibleFocus = (slot: string) => evaluate(`(()=>{const a=document.activeElement,r=a?.getClientRects?.().length>0&&!a.closest("[hidden],[inert]");return {pic:a?.dataset?.seatPic??null,visible:Boolean(r),want:${JSON.stringify(slot)}}})()`);
  await realClick(pic(lower));
  await evaluate(`document.querySelector('#seatPop [data-seat-model]').click();true`);
  assert.equal(await evaluate('!document.getElementById("pop").hidden && document.getElementById("seatPop").hidden'), true, "Model opens the picker in place of the card");
  await escape("keyDown"); await escape("keyUp");
  assert.deepEqual(await visibleFocus(lower), { pic: lower, visible: true, want: lower }, "Picture, Model, Escape: focus returns to the seat's visible picture");
  await realClick(pic(lower));
  await evaluate(`document.querySelector('#seatPop [data-seat-model]').click();true`);
  await evaluate(`document.querySelector('#pop [data-pop-back]').click();true`);
  assert.equal(await evaluate('!document.getElementById("seatPop").hidden'), true, "Back returns to the card");
  await escape("keyDown"); await escape("keyUp");
  assert.deepEqual(await visibleFocus(lower), { pic: lower, visible: true, want: lower }, "Picture, Model, Back, Escape: focus is on the visible picture");
  // A state broadcast redraws the open card: keyboard focus on Watch stays on Watch.
  await realClick(pic(lower));
  await evaluate(`document.querySelector('#seatPop [data-seat-watch]').focus();true`);
  await evaluate(`(()=>{const s=structuredClone(window.__ccSeed);window.__ccDeliver({...s,type:"state"});return true})()`);
  assert.equal(await evaluate(`document.activeElement?.hasAttribute("data-seat-watch") && !document.getElementById("seatPop").hidden`), true, "focus on Watch survives a broadcast");
  await escape("keyDown"); await escape("keyUp");
  // The same control in the work view and in the open card: a broadcast keeps focus in the one that had it.
  await evaluate(`(()=>{const s=window.__ccSeed,t=s.projects.flatMap(p=>p.tabs).find(t=>t.id===s.selectedTabId);const seat=(t.seats??t.crew??[]).find(x=>x.slot==="coder");seat.status="working";s.launchSafety={blocked:[seat.seatKey??t.id+".coder"],uncertain:[],released:[],notices:[]};window.__ccDeliver({...structuredClone(s),type:"state"});document.querySelector(${JSON.stringify(name("coder"))}).click();return true})()`);
  await evaluate(`document.querySelector(${JSON.stringify(pic("coder"))}).click();true`);
  for (const attr of ["data-seat-unblock", "data-run-seat", "data-stop-seat"]) {
    const twins = await evaluate(`({view:document.querySelectorAll("#view ["+${JSON.stringify(attr)}+"]").length,card:document.querySelectorAll("#seatPop ["+${JSON.stringify(attr)}+"]").length})`);
    assert.deepEqual([twins.view > 0, twins.card > 0], [true, true], `${attr} exists in the work view and in the card: ${JSON.stringify(twins)}`);
    for (const place of ["#seatPop", "#view"]) {
      await evaluate(`document.querySelector(${JSON.stringify(`${place} [${attr}]`)}).focus();true`);
      await evaluate(`(()=>{const s=structuredClone(window.__ccSeed);window.__ccDeliver({...s,type:"state"});return true})()`);
      assert.equal(await evaluate(`document.activeElement?.hasAttribute(${JSON.stringify(attr)}) && Boolean(document.activeElement.closest(${JSON.stringify(place)}))`), true, `focus on ${attr} in ${place} stays there after a broadcast`);
    }
  }
  // renderAll's focus restore, driven directly: the focused control is REALLY replaced during the render (renderAll's first lookup, getElementById("first"), swaps it
  // for a clone), then optional decoys are planted just before the restore looks for a twin (the restore's own querySelectorAll call).
  const restore = (o: { target: string; attr: string; moveTo?: string; decoyIn?: string }) => evaluate(`(()=>{
    const o=${JSON.stringify(o)}, key="["+o.attr+"]", target=document.querySelector(o.target);
    target.focus();
    const gid=Document.prototype.getElementById, qsa=Document.prototype.querySelectorAll, planted=[]; let replaced=false, hits=0;
    Document.prototype.getElementById=function(...a){ if(a[0]!=="first") return gid.apply(this,a); Document.prototype.getElementById=gid; target.replaceWith(target.cloneNode(true)); replaced=!target.isConnected; if(o.moveTo) document.querySelector(o.moveTo).focus(); return gid.apply(this,a); };
    Document.prototype.querySelectorAll=function(sel,...r){ if(sel===key&&!planted.length&&o.decoyIn){ Document.prototype.querySelectorAll=qsa; hits++; const d=document.createElement("button"); d.setAttribute(o.attr,""); d.hidden=true; document.querySelector(o.decoyIn).prepend(d); planted.push(d); } return qsa.call(this,sel,...r); };
    try { window.__ccDeliver({...structuredClone(window.__ccSeed),type:"state"}); } finally { Document.prototype.getElementById=gid; Document.prototype.querySelectorAll=qsa; }
    const a=document.activeElement, where=a?.closest("#seatPop")?"seatPop":a?.closest("#view")?"view":a?.id||a?.tagName||"none";
    const out={replaced,where,hasAttr:Boolean(a?.hasAttribute?.(o.attr)),onDecoy:planted.includes(a),planted:planted.length,decoyWanted:Boolean(o.decoyIn)};
    planted.forEach((d)=>d.remove()); return out;
  })()`);
  const attr = "data-stop-seat";
  assert.deepEqual(await restore({ target: `#seatPop [${attr}]`, attr }), { replaced: true, where: "seatPop", hasAttr: true, onDecoy: false, planted: 0, decoyWanted: false }, "same layer: focus lost in the open card comes back to the card's control, not the work view's twin");
  assert.deepEqual(await restore({ target: `#view [${attr}]`, attr }), { replaced: true, where: "view", hasAttr: true, onDecoy: false, planted: 0, decoyWanted: false }, "outside layers: focus lost in the work view comes back to the work view's control, not the open card's twin");
  assert.deepEqual(await restore({ target: `#view [${attr}]`, attr, decoyIn: "body" }), { replaced: true, where: "view", hasAttr: true, onDecoy: false, planted: 1, decoyWanted: true }, "a hidden twin ahead of it in the page is skipped (work view)");
  assert.deepEqual(await restore({ target: `#seatPop [${attr}]`, attr, decoyIn: "#seatPop" }), { replaced: true, where: "seatPop", hasAttr: true, onDecoy: false, planted: 1, decoyWanted: true }, "a hidden twin ahead of it inside the same layer is skipped (card)");
  assert.deepEqual(await restore({ target: `#view [${attr}]`, attr, moveTo: "#railBtn" }), { replaced: true, where: "railBtn", hasAttr: false, onDecoy: false, planted: 0, decoyWanted: false }, "when rendering itself moved focus to another connected control, the restore leaves it there");
  await escape("keyDown"); await escape("keyUp");
  // The collapsed rail: a keyboard user gets the tooltip, and the picture says what the hidden name button said.
  await evaluate(`document.getElementById("railBtn").click();true`);
  assert.equal(await evaluate(`!document.getElementById("stage").classList.contains("wide")`), true, "the rail is collapsed");
  await sendPage("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
  await sendPage("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
  const collapsed = await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(pic(lower))});b.focus();const row=b.closest(".seat"),fx=row.querySelector(".fx");return {focusVisible:b.matches(":focus-visible"),tip:document.getElementById("tip").classList.contains("on"),tipText:document.getElementById("tip").textContent,tipWant:row.dataset.tip,label:b.getAttribute("aria-label"),role:fx.querySelector(".fr").textContent,status:fx.querySelector(".sl").textContent}})()`);
  assert.equal(collapsed.focusVisible, true, "the picture shows keyboard focus");
  assert.deepEqual([collapsed.tip, collapsed.tipText], [true, collapsed.tipWant], "keyboard focus on a picture in the collapsed rail shows its tooltip");
  assert.ok(collapsed.label.includes(collapsed.role) && collapsed.label.includes(collapsed.status), `the picture's label carries role and status: ${collapsed.label}`);
  return;
}
