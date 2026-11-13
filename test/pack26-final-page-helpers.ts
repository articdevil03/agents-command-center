import { J, type Page } from "./pack18-editor-harness.ts";

// The page's own status line text (the pill and its sub line), as the owner reads it.
export const statusLine = (ev: Page["ev"]): Promise<{ text: string; sub: string }> =>
  ev(`({text:document.querySelector("#statusBtn .pt")?.textContent??"",sub:document.querySelector("#statusBtn .sub")?.textContent??""})`);

// The persistent task announcer, observed from the page itself: every text it ever held, and whether it was ever detached.
export const watchAnnouncer = (ev: Page["ev"]): Promise<{ attached: boolean; text: string; role: string | null; live: string | null; atomic: string | null }> => ev(`(()=>{
  const el=document.getElementById("fctAnnouncer");
  window.__ann={el,texts:[el.textContent],detached:0};
  new MutationObserver((records)=>{for(const r of records){for(const n of r.removedNodes)if(n===el)window.__ann.detached++;if(r.target===el||el.contains(r.target))window.__ann.texts.push(el.textContent)}}).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  return {attached:el.isConnected,text:el.textContent,role:el.getAttribute("role"),live:el.getAttribute("aria-live"),atomic:el.getAttribute("aria-atomic")}})()`);
export const announced = (ev: Page["ev"]): Promise<{ same: boolean; connected: boolean; detached: number; text: string; texts: string[] }> =>
  ev(`({same:window.__ann.el===document.getElementById("fctAnnouncer"),connected:window.__ann.el.isConnected,detached:window.__ann.detached,text:window.__ann.el.textContent,texts:window.__ann.texts.filter((t,i,all)=>i===0||t!==all[i-1])})`);

// Geometry of the first Finished tasks row: the clamped task name, its date, the Open control, and any sideways overflow.
export const rowGeometry = (ev: Page["ev"]): Promise<any> => ev(`(()=>{
  const row=document.querySelector("#fixedView .fct-arow"),scope=row.querySelector(".fct-ascope"),date=row.querySelector(".fct-adate"),open=row.querySelector(".fct-aopen");
  const box=(e)=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
  const line=parseFloat(getComputedStyle(scope).lineHeight)||parseFloat(getComputedStyle(scope).fontSize)*1.3;
  return {row:box(row),scope:box(scope),date:box(date),open:box(open),lines:scope.getBoundingClientRect().height/line,scopeChars:scope.textContent.length,
    dateText:date.textContent,openText:open.textContent,viewport:innerWidth,panelOverflow:document.querySelector("#fixedView").scrollWidth>document.querySelector("#fixedView").clientWidth,
    viewOverflow:document.querySelector("#view").scrollWidth>document.querySelector("#view").clientWidth,
    wide:document.querySelector("#stage").classList.contains("wide"),
    offenders:[...document.querySelectorAll("#view *")].filter((e)=>e.getBoundingClientRect().right>innerWidth+1&&e.getClientRects().length).slice(0,6).map((e)=>e.tagName+"#"+e.id+"."+String(e.className).slice(0,40)+":"+Math.round(e.getBoundingClientRect().right))}})()`);
