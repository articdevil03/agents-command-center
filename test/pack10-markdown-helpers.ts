import { delay, J, skipped } from "./pack18-editor-harness.ts";
import { withFixedBehaviour, type Page } from "./fixed-page-behaviour.ts";

// Pack 10, the leader's formatting: the real page script (public/app/*.js) in a real headless Chrome, now on the shared fixed-crew behaviour page
// (test/fixed-page-behaviour.ts, fixture "fixed2", the server's own discovered state). It checks what the page makes of model text
// (bold, lists, code, links, headings), that nothing from the model ever becomes live html, and that no place that shows model text leaks a raw `**`.
// With CC_PACK10_SHOTS=<folder> the screenshots are saved there (the adapter's own switch, CC_PACK9_SHOTS, is set to it for the run).

export { delay, J, skipped, type Page };
export async function withPage(body: (page: Page) => Promise<void>) {
  const wanted = process.env.CC_PACK10_SHOTS, before = process.env.CC_PACK9_SHOTS;
  if (wanted) process.env.CC_PACK9_SHOTS = wanted;
  try { await withFixedBehaviour(body); }
  finally { if (before === undefined) delete process.env.CC_PACK9_SHOTS; else process.env.CC_PACK9_SHOTS = before; }
}

export const FENCE = "```";
export const REPLY = [
  "## Where we are", "",
  "Pack 10 is **built** and *tested*, see `public/app.js` and __this__ too.", "",
  "- Renderer: one small function", "  - nested: handles `code`", "- Tests: [the docs](https://example.com/a_b_c?x=1&y=2)", "",
  "1. First step", "2. Second step", "",
  "> a quoted note", "",
  `${FENCE}js`, 'const x = "**not bold** <b>x</b>";', FENCE, "",
  "snake_case_name stays and so does C:/a/_b_/c",
].join("\n");

export const history = (tab: string, messages: unknown[]) => `window.__ccHistory[${J(tab)}]=${J(messages)};window.__socket.history(${J(tab)});true`;
export const summary = `(()=>{const m=[...document.querySelectorAll("#view .msg:not(.mine) .md")].at(-1);const q=(s)=>[...m.querySelectorAll(s)].map((e)=>e.textContent);
  const copy=m.cloneNode(true);copy.querySelectorAll("pre").forEach((p)=>p.remove());
  return {headings:q(".md-h"),strong:q("strong"),em:q("em"),inlineCode:q("p code, li code"),fenced:q("pre.md-code code"),lists:m.querySelectorAll("ul").length,nested:m.querySelectorAll("ul ul").length,
    numbered:q("ol > li"),quote:q("blockquote"),links:[...m.querySelectorAll("a")].map((a)=>[a.getAttribute("href"),a.target,a.rel,a.textContent]),stars:copy.textContent.includes("**"),text:copy.textContent}})()`;
