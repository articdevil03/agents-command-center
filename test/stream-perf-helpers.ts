import assert from "node:assert/strict";
import { withFixedBehaviour, type Page } from "./fixed-page-behaviour.ts";
import { delay, J } from "./pack18-editor-harness.ts";

// Streaming and message-cache audit: the shared fixed-crew page (real server, real Chrome, the server's own fixed tabs, every message the server would send is
// delivered by the test). Proves a long streamed reply makes a bounded number of full chat renders, shows exactly the streamed text, keeps the reader at the
// bottom (or where they scrolled to), and that the per-message html cache can never show a stale bubble. Boot, ownership and teardown live in pack18-editor-harness.ts.

export { delay, J };

// Counts full chat replacements, including detached template fragments. Text paints and message nodes do not count.
const PROBE_JS = String.raw`
(() => {
  window.__renders = 0;
  const d = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  Object.defineProperty(Element.prototype, "innerHTML", { configurable: true, get() { return d.get.call(this); }, set(v) { if (this.id === "view") window.__renders++; d.set.call(this, v); } });
  const append = Element.prototype.append;
  Element.prototype.append = function(...nodes) {
    if (this.id === "view" && nodes.some(n => n.querySelector?.(".thread") || n.matches?.(".thread"))) window.__renders++;
    return append.apply(this, nodes);
  };
  window.__restoreRenderProbe = () => { Object.defineProperty(Element.prototype, "innerHTML", d); Element.prototype.append = append; };
  window.__stream = async (tabId, parts, gap) => { for (const text of parts) { window.__ccDeliver({ type: "chatDelta", tabId, text }); await new Promise((ok) => setTimeout(ok, gap)); } return true; };
  window.__bubble = () => document.querySelector("#view [data-stream] .md")?.textContent ?? null;
  window.__gap = () => { const v = document.querySelector("#view"); return v.scrollHeight - v.scrollTop - v.clientHeight; };
})()
`;

export type { Page };

// The probe goes in after the fixed state is delivered and before any assertion; the render counter is this file's own, independent of the page.
export async function withPage(body: (page: Page) => Promise<void>) {
  await withFixedBehaviour(async (page) => {
    await page.ev(PROBE_JS);
    try {
    // Control: a socket message the page cannot read is reported only through console.error, and the page-error hook must catch that.
    await page.ev(`window.__socket.emit("message",{data:"{not json"});true`);
    const control = await page.ev("window.__ccErrors");
    assert.ok(control.length === 1 && /^console\.error: Invalid Command Center message/.test(control[0]), `the console.error hook caught the unreadable message: ${JSON.stringify(control)}`);
    await page.ev("window.__ccErrors.length=0;true");
      await body(page);
    } finally { await page.ev("window.__restoreRenderProbe();true"); }
  });
}

const long = (index: number) => `Reply ${index}: ${"some realistic words that make a message a normal length. ".repeat(5)}`;

export const historyOf = (count: number) => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: index % 2 ? long(index) : `Question ${index}: please do the next step.`, at: 1_700_000_000_000 + index * 1000, revision: index + 1 }));
