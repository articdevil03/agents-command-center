import test from "node:test";
import assert from "node:assert/strict";
import { delay, J, withPage } from "./stream-perf-helpers.ts";

// The cache is keyed by tab + revision and checked against everything the bubble shows. Each case renders one message, changes
// exactly one thing about the same revision, and the new picture must show. Removing that field from the signature turns it red.
// Only fields the server really sends: a chat message is { tabId, revision, role, text, images?, files?, requestId?, at } (server/chat-store.ts). The time label is the clock time of `at`.
test("message cache: a same-revision message re-renders when its text, time, role, pictures, files, seat name or seat picture change", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  await withPage(async ({ ev, waitFor, seed, tabA }) => {
    const leaderSlot = seed.projects[0].tabs[0].crew.find((seat: any) => seat.isLeader)?.slot ?? seed.projects[0].tabs[0].crew[0].slot;
    const message = (extra: Record<string, unknown> = {}) => ({ role: "assistant", text: "cache text one", at: 1_700_000_000_000, revision: 7, ...extra });
    const show = async (messages: unknown[]) => { await ev(`__ccDeliver({type:"chatHistory",tabId:${J(tabA)},messages:${J(messages)},revision:9,savedRevision:9});true`); await delay(30); };
    const html = () => ev(`document.querySelector("#view").innerHTML`);
    const seatChange = async (change: (seat: any) => void) => {
      await ev(`(()=>{const seat=window.__ccSeed.projects[0].tabs[0].crew.find((s)=>s.slot===${J(leaderSlot)});(${change.toString()})(seat);__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});return true})()`);
      await delay(30);
    };
    const cases: Array<[string, Record<string, unknown>, (page: string) => boolean]> = [
      ["text", { text: "cache text TWO" }, (page) => page.includes("cache text TWO") && !page.includes("cache text one")],
      ["time", { at: new Date(2026, 0, 2, 22, 2).getTime() }, (page) => page.includes("22:02")],
      ["role", { role: "user" }, (page) => page.includes('class="msg mine"')],
      ["images", { images: ["C:\\shots\\one.png"] }, (page) => page.includes("data-open-shot")],
      ["files", { files: ["C:\\docs\\notes.md"] }, (page) => page.includes("file-chip")],
    ];
    for (const [field, change, shows] of cases) {
      await t.test(`a changed ${field} on the same revision is shown`, async () => {
        await show([message()]);
        assert.ok((await html()).includes("cache text one"), "the first render shows the original");
        await show([message(change)]);
        assert.ok(shows(await html()), `the changed ${field} shows; got ${(await html()).slice(0, 400)}`);
      });
    }
    await t.test("Clear then new messages: a reused revision shows the new text, not the cleared one", async () => {
      await show([message()]);
      assert.ok((await html()).includes("cache text one"));
      await ev(`__ccDeliver({type:"chatCleared",tabId:${J(tabA)},messages:[],revision:8,savedRevision:8});true`);
      await delay(30);
      assert.ok(!(await html()).includes("cache text one"), "Clear removes the old text");
      await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},...${J(message({ text: "fresh after clear" }))}});true`);
      await delay(30);
      const page = await html();
      assert.ok(page.includes("fresh after clear") && !page.includes("cache text one"), "the new message with the reused revision shows its own text");
    });
    await t.test("Restore: the restored message shows its own text, not the one cached under the same revision", async () => {
      await show([message()]);
      assert.ok((await html()).includes("cache text one"));
      await ev(`__ccDeliver({type:"chatCleared",tabId:${J(tabA)},messages:[],revision:8,savedRevision:8});true`);
      await ev(`__ccDeliver({type:"chatRestored",tabId:${J(tabA)},messages:${J([message({ text: "restored other text" })])},revision:9,savedRevision:9});true`);
      await delay(30);
      const page = await html();
      assert.ok(page.includes("restored other text") && !page.includes("cache text one"), "the restored message shows its own text");
    });
    await t.test("a seat rename changes the speaker name on a cached message", async () => {
      await show([message({ text: "seat rename text" })]);
      await seatChange((seat) => { seat.name = "Renamed Lead"; });
      assert.ok((await html()).includes("<b>Renamed Lead</b>"), "the new name shows");
      await seatChange((seat) => { seat.name = "Renamed Again"; });
      const page = await html();
      assert.ok(page.includes("<b>Renamed Again</b>") && !page.includes("Renamed Lead"), "and the next name replaces it");
    });
    await t.test("a seat picture change changes the picture on a cached message", async () => {
      await show([message({ text: "seat picture text" })]);
      await seatChange((seat) => { seat.pic = "/avatars/nova.svg"; });
      assert.ok((await html()).includes('src="/avatars/nova.svg"'), "the new picture shows");
      await seatChange((seat) => { seat.pic = "/avatars/pip.svg"; });
      const page = await html();
      assert.ok(page.includes('src="/avatars/pip.svg"') && !page.includes("nova.svg"), "and the next picture replaces it");
    });
    await waitFor(`document.querySelector("#view .thread")!==null`, "chat still rendered");
  });
});

// Live chatMessages arrive by tab revision: out-of-order ones are inserted in order, a repeated revision is dropped.
// Turning the ordered insert into a plain push breaks the order check; removing the repeat check breaks the count.
test("live chat messages: revisions 1, 3, 2 then 3 again show exactly three messages in the order 1, 2, 3", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  await withPage(async ({ ev, tabA }) => {
    await ev(`__ccDeliver({type:"chatCleared",tabId:${J(tabA)},messages:[],revision:0,savedRevision:0});true`);
    for (const revision of [1, 3, 2, 3]) {
      await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"assistant",text:${J(`ORDERED-${revision}-END`)},at:${1_700_000_000_000 + revision},revision:${revision}});true`);
    }
    await delay(60);
    const shown = JSON.parse(await ev(`JSON.stringify([...document.querySelector("#view").innerHTML.matchAll(/ORDERED-([0-9]+)-END/g)].map((m)=>m[1]))`));
    assert.deepEqual(shown, ["1", "2", "3"], `three messages in revision order; got ${JSON.stringify(shown)}`);
  });
});
