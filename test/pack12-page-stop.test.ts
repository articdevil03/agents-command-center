import test from "node:test";
import assert from "node:assert/strict";
import { delay, J, type Page, withPage, skipped, sentOf, setActive, typeAndEnter, queueOf, deliver, chatMsg, waitQueue } from "./pack12-page-helpers.ts";

// The leader's Stop is the button in the leader's read-only seat card (a real click on the seat picture, then on Stop). The leader is the tab's assigned fixed leader; the opener and the
// Stop button are looked up and asserted present before any click, and the message that reaches the server must name this tab and the leader's slot.
const stopLeader = async (ev: Page["ev"], waitFor: Page["waitFor"], tabId: string): Promise<void> => {
  await waitFor(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId===${J(tabId)}`, `tab ${tabId} is shown`);
  const leader = await ev(`(()=>{const tab=window.__ccSeed.projects[0].tabs.find((t)=>t.id===${J(tabId)});const seat=tab.crew.find((s)=>s.isLeader);return {slot:seat?.slot,assigned:Boolean(tab.fixedCrew?.preferences?.leader?.assignment)}})()`);
  assert.equal(leader.slot, "leader", "the tab's leader is the fixed leader seat");
  assert.equal(leader.assigned, true, "the fixed leader has an assigned model");
  assert.equal(await ev(`document.querySelector('#crew [data-seat-pic="${leader.slot}"]')!==null`), true, "control: the leader's seat picture (the card opener) is on the page");
  await ev(`document.querySelector('#crew [data-seat-pic="${leader.slot}"]').click();true`);
  await waitFor(`document.querySelector("#seatPop [data-stop-seat]")!==null`, "the leader's card shows Stop");
  await ev(`document.querySelector("#seatPop [data-stop-seat]").click();true`);
  await waitFor(`window.__sent.some((m)=>m.type==="stopSeat")`, "the stop reaches the server");
  assert.deepEqual((await sentOf(ev, "stopSeat")).map((m) => [m.tabId, m.slot]), [[tabId, leader.slot]], "exactly one stop, for this tab's leader");
};

test("fix 2a: the owner clicks the leader's Stop while the finished reply's chatDone is still on the way: the queue is held, and the arriving chatDone sends nothing", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "alpha"); await waitQueue(waitFor, 1, "alpha");
    await typeAndEnter(ev, "beta"); await waitQueue(waitFor, 2, "beta");
    await stopLeader(ev, waitFor, tabA); // the server has no turn to stop, so no chatError ever comes
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length, 0, "nothing went out after the Stop");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["alpha", "Send"], ["beta", "Send"]]);
  });
});

test("fix 2b: Stop all holds every tab's queue the same way, also a hidden tab whose reply ends late", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    const shown = (tabId: string) => waitFor(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId===${J(tabId)}`, `tab ${tabId} is shown`);
    const open = async (tabId: string) => { await ev(`document.querySelector('#tabs [role=tab][data-tab-id=${J(tabId)}]').click();true`); await shown(tabId); };
    await setActive(ev, tabA, true, `tab.derived.busy=true;`);
    await typeAndEnter(ev, "gamma"); await waitQueue(waitFor, 1, "gamma");
    await open(tabB);
    await setActive(ev, tabB, true, `tab.derived.busy=true;`);
    await typeAndEnter(ev, "delta"); await waitQueue(waitFor, 1, "delta is queued in tab B");
    await open(tabA); // Stop all is clicked while B is hidden
    await waitQueue(waitFor, 1, "tab A shows gamma");
    await waitFor(`!document.querySelector("#stopAll").disabled`, "Stop all is on");
    assert.equal(await ev(`document.querySelector("#stopAll")!==null`), true, "control: the Stop all button is on the page");
    await ev(`document.querySelector("#stopAll").click();true`);
    await waitFor(`window.__sent.some((m)=>m.type==="stopAll")`, "stop all reaches the server");
    assert.equal((await sentOf(ev, "stopAll")).length, 1, "one Stop all reached the server");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false, `tab.derived.busy=false;`);
    await deliver(ev, { type: "chatDone", tabId: tabB, revision: 1, savedRevision: 0 }); // B's reply ends late, after the Stop
    await setActive(ev, tabB, false, `tab.derived.busy=false;`);
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length, 0, "nothing went out after Stop all, from either tab");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["gamma", "Send"]]);
    await open(tabB);
    await waitQueue(waitFor, 1, "tab B shows delta");
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["delta", "Send"]], "the hidden tab's message waits behind Send too");
  });
});

test("fix 2c: a flush already waiting for the state (chatDone came first) is cancelled by Stop: a message typed after the Stop does not go out when the state says idle", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "alpha"); await waitQueue(waitFor, 1, "alpha");
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 }); // arms the flush; the state still says replying
    await stopLeader(ev, waitFor, tabA);
    await typeAndEnter(ev, "typed after the stop"); await waitQueue(waitFor, 2, "typed after the stop");
    await setActive(ev, tabA, false);
    await delay(500);
    assert.equal((await sentOf(ev, "chat")).length, 0, "the waiting flush was cancelled by the Stop");
  });
});

test("fix 9: queues are per tab: a reply that ends in tab A sends A's message with A's tab id while tab B is shown, B's box and queue are untouched, and A's queue is right when shown again", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    const shown = (tabId: string) => waitFor(`document.querySelector('#tabs [role=tab][aria-selected="true"]')?.dataset.tabId===${J(tabId)}`, `tab ${tabId} is shown`);
    const open = async (tabId: string) => { await ev(`document.querySelector('#tabs [role=tab][data-tab-id=${J(tabId)}]').click();true`); await shown(tabId); };
    await setActive(ev, tabA, true);
    await typeAndEnter(ev, "A one"); await waitQueue(waitFor, 1, "A one");
    await typeAndEnter(ev, "A two"); await waitQueue(waitFor, 2, "A two");
    await open(tabB);
    await waitQueue(waitFor, 0, "tab B shows no queue");
    await setActive(ev, tabB, true);
    await typeAndEnter(ev, "B one"); await waitQueue(waitFor, 1, "B one is queued in tab B");
    await ev(`(()=>{const ci=document.querySelector("#ci");ci.value="draft in B";ci.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
    // Tab A's reply ends normally while B is shown.
    await deliver(ev, { type: "chatDone", tabId: tabA, revision: 1, savedRevision: 0 });
    await setActive(ev, tabA, false);
    await waitFor(`window.__sent.some((m)=>m.type==="chat"||m.type==="steer")`, "A's first message goes out (any outbound attempt, so a wrong-tab send is read, not timed out)");
    await delay(300);
    const chats = await sentOf(ev, "chat");
    assert.deepEqual(chats.map((m) => [m.text, m.tabId]), [["A one", tabA]], "A's message went out with A's tab id, and only that one");
    assert.equal((await sentOf(ev, "steer")).length, 0);
    assert.deepEqual((await queueOf(ev)).map((item) => [item.text, item.go]), [["B one", "Steer"]], "B's queue is untouched");
    assert.equal(await ev(`document.querySelector("#ci").value`), "draft in B", "and so is B's box");
    // The server took A's message; back in A the queue holds only what is left.
    await chatMsg(ev, tabA, "user", "A one", { requestId: chats[0].requestId });
    await open(tabA);
    await waitQueue(waitFor, 1, "tab A shows what is left");
    assert.deepEqual((await queueOf(ev)).map((item) => item.text), ["A two"]);
  });
});
