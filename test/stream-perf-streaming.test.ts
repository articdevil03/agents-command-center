import test from "node:test";
import assert from "node:assert/strict";
import { delay, J, withPage, historyOf } from "./stream-perf-helpers.ts";

test("streamed reply: a 200-message chat and 600 deltas make a bounded number of full chat renders, show the exact text and keep the bottom", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  await withPage(async ({ ev, waitFor, tabA }) => {
    await ev(`__ccDeliver({type:"chatHistory",tabId:${J(tabA)},messages:${J(historyOf(200))},revision:200,savedRevision:200});true`);
    await waitFor(`document.querySelectorAll("#view .msg").length===200`, "200 messages rendered");
    // Control: the chat really scrolls, and sits at the bottom to start with.
    assert.ok(await ev(`document.querySelector("#view").scrollHeight-document.querySelector("#view").clientHeight`) > 1000, "the 200-message chat scrolls");
    await ev(`(()=>{const v=document.querySelector("#view");v.scrollTop=v.scrollHeight;return true})()`);
    assert.ok(await ev("__gap()") <= 4, "starts at the bottom");

    const parts = Array.from({ length: 600 }, (_, index) => `w${index} `);
    const full = parts.join("");
    await ev(`window.__renders=0;true`);
    await ev(`__stream(${J(tabA)},${J(parts)},3)`);
    await waitFor(`__bubble()===${J(full)}`, "the last frame paints the whole streamed text");
    const duringStream = await ev("window.__renders");
    console.log(`Stream perf: ${parts.length} deltas, ${duringStream} full chat renders during the stream`);
    assert.ok(duringStream >= 1, "the first delta created the streaming bubble (the render counter is alive)");
    assert.ok(duringStream <= 3, `at most 3 full chat renders for 600 deltas, got ${duringStream}`);
    assert.equal(await ev("__bubble()"), full, "the streamed text is shown exactly");
    assert.ok(await ev("__gap()") <= 4, "stays stuck to the bottom while streaming");

    await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"assistant",text:${J(full)},at:1_700_000_999_000,revision:201});__ccDeliver({type:"chatDone",tabId:${J(tabA)},revision:201,savedRevision:201});true`);
    await waitFor(`document.querySelector("#view [data-stream]")===null&&document.querySelectorAll("#view .msg").length===201`, "the final message replaces the bubble");
    const afterDone = await ev("window.__renders");
    assert.ok(afterDone - duringStream <= 3, `finishing the reply costs at most 3 renders, got ${afterDone - duringStream}`);
    assert.equal(await ev(`document.querySelector("#view .msg:last-of-type .body .md").textContent`), full, "the final message shows the same text");
    assert.ok(await ev("__gap()") <= 4, "still at the bottom after the reply is saved");
  });
});

test("streamed text is escaped, background tabs and tab switches never leak, the final message replaces the bubble, the timer paints without frames", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    const history = (tabId: string, messages: unknown[]) => ev(`__ccDeliver({type:"chatHistory",tabId:${J(tabId)},messages:${J(messages)},revision:9,savedRevision:9});true`);
    const delta = (tabId: string, text: string) => ev(`__ccDeliver({type:"chatDelta",tabId:${J(tabId)},text:${J(text)}});true`);
    const base = [{ role: "user", text: "hello", at: 1_700_000_000_000, revision: 1 }];
    await history(tabA, base);
    await history(tabB, [{ role: "user", text: "tab B history", at: 1_700_000_000_000, revision: 1 }]);
    await waitFor(`document.querySelectorAll("#view .msg").length===1`, "tab A renders");

    await t.test("streamed text with HTML special characters is escaped, on the first delta and on later ones", async () => {
      const first = `<img src=x onerror="window.__pwn=1"> & "q" `, second = `<b>bold</b> 'single' &amp; `;
      await delta(tabA, first);
      await waitFor(`__bubble()!==null`, "bubble");
      assert.equal(await ev("__bubble()"), first, "the first delta is text, not markup");
      await delta(tabA, second);
      await waitFor(`__bubble()===${J(first + second)}`, "later delta painted");
      assert.equal(await ev(`document.querySelectorAll("#view [data-stream] .md img, #view [data-stream] .md b").length`), 0, "no element was created from streamed text");
      assert.equal(await ev("window.__pwn"), undefined, "no streamed handler ran");
      await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"assistant",text:${J(first + second)},at:1_700_000_001_000,revision:2});__ccDeliver({type:"chatDone",tabId:${J(tabA)},revision:2,savedRevision:2});true`);
      await waitFor(`document.querySelector("#view [data-stream]")===null&&document.querySelectorAll("#view .msg").length===2`, "final message");
      assert.equal(await ev(`document.querySelector("#view .msg:last-of-type .body .md").textContent`), first + second, "the saved message shows the same characters");
      assert.equal(await ev(`document.querySelectorAll("#view .msg:last-of-type .body .md img, #view .msg:last-of-type .body .md b").length`), 0, "the saved message is escaped too");
    });

    await t.test("chatDone replaces the streaming bubble with the final rendered message", async () => {
      await history(tabA, base);
      await delta(tabA, "partial words");
      await waitFor(`__bubble()==="partial words"`, "bubble");
      await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"assistant",text:"final words",at:1_700_000_002_000,revision:2});__ccDeliver({type:"chatDone",tabId:${J(tabA)},revision:2,savedRevision:2});true`);
      await waitFor(`document.querySelector("#view [data-stream]")===null`, "bubble gone");
      assert.equal(await ev(`[...document.querySelectorAll("#view .msg.mine .bubble p, #view .msg:not(.mine) .body > .md")].map((p)=>p.textContent).join("|")`), "hello|final words", "only the final message remains");
      assert.equal(await ev(`document.querySelector('#view [data-message-id="2"]')!==null`), true, "the final message is a real message row");
    });

    await t.test("a delta for a background tab does not touch the visible tab", async () => {
      await history(tabA, base);
      await delta(tabA, "visible draft");
      await waitFor(`__bubble()==="visible draft"`, "bubble");
      await delay(120);
      const before = await ev(`({renders:window.__renders,html:document.querySelector("#view").innerHTML})`);
      for (let index = 0; index < 20; index++) await delta(tabB, `background ${index} `);
      await delay(150);
      const after = await ev(`({renders:window.__renders,html:document.querySelector("#view").innerHTML})`);
      assert.equal(after.renders, before.renders, "no chat render for a background delta");
      assert.equal(after.html, before.html, "the visible chat is byte-for-byte unchanged");
      assert.equal(await ev("__bubble()"), "visible draft", "the visible draft is still its own");
    });

    await t.test("switching tabs mid-stream shows the right draft and the old frame does not paint into the new tab", async () => {
      await history(tabA, base);
      await history(tabB, [{ role: "user", text: "tab B history", at: 1_700_000_000_000, revision: 1 }]);
      await delta(tabA, "AAA ");
      await waitFor(`__bubble()==="AAA "`, "A bubble");
      // A's next frame is pending when the user switches; B starts its own stream in the same tick.
      await ev(`(()=>{
        __ccDeliver({type:"chatDelta",tabId:${J(tabA)},text:"more AAA "});
        document.querySelector('#tabs [data-tab-id=${J(tabB)}]').click();
        __ccDeliver({type:"chatDelta",tabId:${J(tabB)},text:"BBB "});
        return true})()`);
      await delay(150);
      assert.equal(await ev(`document.querySelector("#view").dataset.tabId`), tabB, "the view is B's");
      assert.equal(await ev("__bubble()"), "BBB ", "B shows only its own draft");
      await delta(tabB, "next");
      await waitFor(`__bubble()==="BBB next"`, "B keeps streaming");
      await ev(`document.querySelector('#tabs [data-tab-id=${J(tabA)}]').click();true`);
      await waitFor(`document.querySelector("#view").dataset.tabId===${J(tabA)}`, "back on A");
      await delay(120);
      assert.equal(await ev(`document.querySelector("#view").textContent.includes("BBB")`), false, "A shows nothing of B's draft");
    });

    await t.test("a frame held for tab A does not strand tab B's delta: the paint serves the chat shown now", async () => {
      await ev(`__ccDeliver({type:"chatDone",tabId:${J(tabA)}});__ccDeliver({type:"chatDone",tabId:${J(tabB)}});true`);
      await history(tabA, base);
      await history(tabB, [{ role: "user", text: "tab B history", at: 1_700_000_000_000, revision: 1 }]);
      await ev(`document.querySelector('#tabs [data-tab-id=${J(tabA)}]').click();true`);
      await waitFor(`document.querySelector("#view").dataset.tabId===${J(tabA)}`, "on A");
      await delay(300);
      await delta(tabA, "A0 ");
      await waitFor(`__bubble()==="A0 "`, "A has its streaming bubble");
      // Hold A's frame and its 50 ms fallback timer: nothing paints until this test lets the held callbacks run.
      await ev(`window.__held=[];window.__realRaf=window.requestAnimationFrame;window.__realTimeout=window.setTimeout;window.requestAnimationFrame=()=>999999;window.setTimeout=(cb,d,...a)=>d===50?(window.__held.push(cb),0):window.__realTimeout(cb,d,...a);true`);
      try {
        await delta(tabA, "A1 ");
        await ev(`document.querySelector('#tabs [data-tab-id=${J(tabB)}]').click();true`);
        await waitFor(`document.querySelector("#view").dataset.tabId===${J(tabB)}`, "on B");
        await delay(300);
        await delta(tabB, "B1 ");
        await waitFor(`__bubble()==="B1 "`, "B has its streaming bubble");
        await delta(tabB, "B2");
        assert.equal(await ev("__bubble()"), "B1 ", "B's second delta is waiting for the held frame");
        await ev(`window.__held.splice(0).forEach((cb)=>cb());true`);
        assert.equal(await ev("__bubble()"), "B1 B2", "the released paint (A's) showed B's new text");
      } finally { await ev(`window.requestAnimationFrame=window.__realRaf;window.setTimeout=window.__realTimeout;true`);
        await ev(`__ccDeliver({type:"chatDone",tabId:${J(tabA)}});__ccDeliver({type:"chatDone",tabId:${J(tabB)}});document.querySelector('#tabs [data-tab-id=${J(tabA)}]').click();true`);
        await waitFor(`document.querySelector("#view").dataset.tabId===${J(tabA)}`, "back on A");
        await delay(300);
      }
    });

    await t.test("the 50 ms timer paints a delta when no animation frame ever comes", async () => {
      await history(tabA, base);
      await delta(tabA, "first ");
      await waitFor(`__bubble()==="first "`, "bubble");
      await ev(`window.__realRaf=window.requestAnimationFrame;window.requestAnimationFrame=()=>999999;true`);
      try {
        await delta(tabA, "second");
        await delay(250);
        assert.equal(await ev("__bubble()"), "first second", "the timer fallback painted");
      } finally { await ev(`window.requestAnimationFrame=window.__realRaf;true`); }
    });
  });
});
