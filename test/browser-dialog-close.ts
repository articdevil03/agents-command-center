import assert from "node:assert/strict";
import type { DialogPage } from "./browser-dialog-page.ts";

export async function dialogCloseProbes(page: DialogPage, specs: Array<{ id: string; label: string; opener: string; open: string }>, args: { width: number }) {
  const { evaluate, sendPage, waitForPage, delay } = page;
  for (const spec of specs) {
    const opened = await evaluate(spec.open);
    assert.equal(opened, true, `${spec.label} opened through ${spec.opener} at ${args.width}px`);
    await waitForPage(`document.querySelector("#${spec.id}")?.getAttribute("aria-hidden")==="false"`, `${spec.label} open`);
    await delay(300);
    const selector = `#${spec.id}`;
    const evidence = await evaluate(`(()=>{
      const dialog=document.querySelector(${JSON.stringify(selector)});
      if(!dialog)return {found:false};
      const close=dialog.querySelector(".dialog-close");
      const titleNode=${spec.id === "setModal" ? 'dialog.querySelector("#setNav h2")' : 'dialog.querySelector("h2")'};
      const visible=(node)=>!node.hidden&&node.tabIndex>=0&&getComputedStyle(node).display!=="none"&&getComputedStyle(node).visibility!=="hidden";
      const first=[...dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]')].find(visible);
      const describe=(node)=>node?{id:node.id||null,tag:node.tagName.toLowerCase(),className:String(node.className||""),label:node.getAttribute("aria-label"),text:node.textContent.trim().slice(0,36)}:null;
      const rect=(node)=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
      const box=rect(dialog),x=close?rect(close):null,t=titleNode?rect(titleNode):null;
      const topInset=x?x.top-box.top:null,rightInset=x?box.right-x.right:null,leftInset=x?x.left-box.left:null,bottomInset=x?box.bottom-x.bottom:null;
      const outlines=[...document.querySelectorAll("body *")].filter((node)=>node.getClientRects().length&&getComputedStyle(node).outlineStyle!=="none"&&parseFloat(getComputedStyle(node).outlineWidth)>0).map(describe);
      const aligned=x&&t?Math.abs(x.top-t.top)<=4:null;
      return {found:!dialog.hidden,containerFocused:document.activeElement===dialog,active:describe(document.activeElement),activeIsClose:document.activeElement===close,hasCloseX:Boolean(close),close:describe(close),box,x,topInset,rightInset,leftInset,bottomInset,ringInside:x?topInset>=4&&rightInset>=4&&leftInset>=4&&bottomInset>=4:null,evenInset:x?Math.abs(topInset-rightInset)<=2:null,title:describe(titleNode),titleAligned:aligned,first:describe(first),noOutline:outlines.length===0,outlines};
    })()`);
    assert.ok(evidence.found, `${spec.label} dialog was found at ${args.width}px: ${JSON.stringify(evidence)}`);
    assert.ok(evidence.containerFocused, `${spec.label} focused its dialog container at ${args.width}px: ${JSON.stringify(evidence)}`);
    // The simple look keeps one close X, on Settings; every other dialog closes from its own footer button or Escape.
    assert.equal(evidence.hasCloseX, spec.id === "setModal", `${spec.label} close X inventory at ${args.width}px: ${JSON.stringify(evidence)}`);
    assert.ok(evidence.noOutline, `${spec.label} opened without a visible outline at ${args.width}px: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.activeIsClose, false, `${spec.label} did not focus its X on open at ${args.width}px: ${JSON.stringify(evidence)}`);
    if (evidence.hasCloseX) {
      assert.ok(evidence.ringInside, `${spec.label} close X plus 4px fits inside its dialog at ${args.width}px: ${JSON.stringify(evidence)}`);
      if (spec.id === "setModal") {
        assert.ok(Math.abs(evidence.topInset - 8) <= 2, `${spec.label} close X top inset is 8px +-2 at ${args.width}px: ${JSON.stringify(evidence)}`);
      } else {
        assert.ok(evidence.evenInset, `${spec.label} top/right close X insets match within 2px at ${args.width}px: ${JSON.stringify(evidence)}`);
        assert.ok(evidence.titleAligned, `${spec.label} close X aligns with the title row at ${args.width}px: ${JSON.stringify(evidence)}`);
      }
    } else assert.ok(evidence.first, `${spec.label} has a first keyboard control at ${args.width}px: ${JSON.stringify(evidence)}`);
    console.log(`Dialog open ${args.width}px ${spec.label}: ${JSON.stringify(evidence)}`);

    const key = { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
    await sendPage("Input.dispatchKeyEvent", key);
    await sendPage("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
    const tabEvidence = await evaluate(`(()=>{const d=document.querySelector(${JSON.stringify(selector)}),x=d.querySelector(".dialog-close");const first=[...d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]')].find((node)=>!node.hidden&&!node.disabled&&node.tabIndex>=0&&getComputedStyle(node).display!=="none"&&getComputedStyle(node).visibility!=="hidden");const active=document.activeElement,s=getComputedStyle(active);return {active:{id:active.id||null,tag:active.tagName.toLowerCase(),className:String(active.className||""),label:active.getAttribute("aria-label"),text:active.textContent.trim().slice(0,36)},onCloseX:active===x,onFirstControl:active===first,focusVisible:active.matches(":focus-visible"),outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth}})()`);
    assert.ok(tabEvidence.onCloseX || tabEvidence.onFirstControl, `${spec.label} one Tab reached its X or first control at ${args.width}px: ${JSON.stringify(tabEvidence)}`);
    if (evidence.hasCloseX) assert.ok(tabEvidence.onCloseX && tabEvidence.focusVisible, `${spec.label} one Tab focuses its X with the keyboard ring at ${args.width}px: ${JSON.stringify(tabEvidence)}`);
    console.log(`Dialog Tab ${args.width}px ${spec.label}: ${JSON.stringify(tabEvidence)}`);

    const escape = { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await sendPage("Input.dispatchKeyEvent", escape);
    await sendPage("Input.dispatchKeyEvent", { ...escape, type: "keyUp" });
    const restored = await waitForPage(`(()=>{const d=document.querySelector(${JSON.stringify(selector)}),o=document.querySelector(${JSON.stringify(spec.opener)});return d.hidden&&document.activeElement===o})()`, `${spec.label} Escape close and opener focus`, 3000);
    assert.equal(restored, true, `${spec.label} Escape closes and restores focus to ${spec.opener} at ${args.width}px`);
    console.log(`Dialog Escape ${args.width}px ${spec.label}: closed; focus restored to ${spec.opener}`);
  }
}
