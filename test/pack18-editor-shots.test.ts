import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editorTestMs, ED, J, withPage, skipped, click, openEditor, openTab, addSeat, sentOf, setValue, deliverTab, delay } from "./pack18-editor-harness.ts";

// Not a check: the screenshots the design coder looks at. Run with CC_P18_SHOTS=<folder>. The page's scroll bars are drawn, so a sideways one
// would show; each shot is the whole window with the Settings body scrolled to the part named. One fresh page per size, so every size starts
// from the server's own Our process tab.
const SIZES = [
  { tag: "1440", width: 1440, height: 900, scale: 1 },
  { tag: "900", width: 900, height: 900, scale: 1 },
  { tag: "200pct", width: 720, height: 450, scale: 2 },
];

for (const size of SIZES) {
  test(`screenshots of the crew editor at ${size.tag} (top, who does what, a new seat with its model menu, the role list, after Save, the Save bar, a blank tab${size.tag === "1440" ? ", dark" : ""})`, { timeout: editorTestMs(198_000) }, async (t) => {
    const dir = process.env.CC_P18_SHOTS;
    if (!dir) { t.skip("set CC_P18_SHOTS=<folder> to save the editor's screenshots"); return; }
    if (skipped(t)) return;
    await withPage(async ({ ev, waitFor, page, ours, blank }) => {
      mkdirSync(dir, { recursive: true });
      await page("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: false });
      const capture = async () => Buffer.from((await page("Page.captureScreenshot", { format: "png" })).result.data, "base64");
      // No toast in a shot: the page's own toast is taken off before each capture.
      const save = async (what: string) => {
        await ev(`(()=>{const toast=document.querySelector("#toast");toast.classList.remove("on");toast.hidden=true;return true})()`);
        await delay(250);
        const name = `rework-${what}-${size.tag}.png`;
        writeFileSync(join(dir, name), await capture()); console.log(`shot ${join(dir, name)}`);
      };
      // Settings scrolls to its section on the next frame; a first capture lets that frame run, then the body is scrolled to the part shown.
      const scrollTo = async (selector: string, above = 12) => {
        await delay(300); await capture();
        const found = await ev(`(()=>{const body=document.querySelector("#setBody");const el=document.querySelector(${J(selector)});if(!el)return false;body.scrollTop+=el.getBoundingClientRect().top-body.getBoundingClientRect().top-${above};return true})()`);
        assert.equal(found, true, `${selector} is on the page`);
      };
      await openEditor(ev, waitFor);
      await scrollTo("#s-crew", 20);
      await save("top");
      await scrollTo(`${ED} [data-se-row="final"]`, 40);
      await save("who");
      const slot = await addSeat(ev);
      await scrollTo(`${ED} [data-se-card="${slot}"]`, 70);
      await click(ev, `${ED} [data-se-model="${slot}"]`);
      await waitFor(`!document.querySelector("#pop").hidden`, "the model menu opens");
      await save("new-seat");
      await ev(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));true`);
      await click(ev, `${ED} [data-se-role="${slot}"]`);
      await scrollTo(`${ED} [data-se-card="${slot}"]`, 70);
      await save("role-menu");
      await click(ev, `${ED} [data-se-rolemenu="${slot}"] [data-se-pick-role="Coder"]`);
      await setValue(ev, `${ED} [data-se-name="${slot}"]`, "Quinn");
      await click(ev, "#setFoot [data-se-save]");
      const [sent] = await sentOf(ev, "setSetup");
      await deliverTab(ev, ours.id, `tab.crew=${J(sent.crew)}.map((seat)=>({status:"idle",runs:[],...(tab.crew.find((x)=>x.slot===seat.slot)??{}),...seat,seatKey:${J(ours.id)}+"."+seat.slot}));tab.lookPause=${J(sent.lookPause)}`);
      await waitFor(`document.querySelector(${J(`${ED} [data-se-note]`)})!==null`, "the note shows");
      await scrollTo(`${ED} [data-se-row="${slot}"]`, 160);
      await save("saved");
      await click(ev, `${ED} [data-se-look-toggle]`);
      await delay(200);
      await ev(`document.querySelector("#setBody").scrollTop=1e6;true`);
      await save("bar");
      await click(ev, "#setFoot [data-se-discard]");
      if (size.tag === "1440") {
        await ev(`document.querySelector('[data-theme-toggle="dark"]').click();true`);
        await scrollTo("#s-crew", 20);
        await save("dark");
        await ev(`document.querySelector('[data-theme-toggle="light"]').click();true`);
      }
      await openTab(ev, waitFor, blank.id);
      await scrollTo("#s-crew", 20);
      await save("blank");
    }, { scrollbars: true });
  });
}
