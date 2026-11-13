import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// Pack 21: a typed thing is deleted when the server TAKES it, not when the request is sent. The real page scripts run in a VM with fake
// elements (no Chrome); every click goes through the real listener, and every target is printed as it is found.
// Slice 2c: the four "p21 editor:" cases (the old crew editor's refused Switch to) are retired with that editor.

const read = (file: string) => readFileSync(file, "utf8");

// ---- Needs you: a typed confirm phrase stays until the server takes it ----
function inbox(launchSafety: any) {
  const sent: any[] = [], elements = new Map<string, any>();
  const fake = () => ({ innerHTML: "", textContent: "", dataset: {}, value: "", options: [], hidden: true, disabled: false, title: "", querySelectorAll: () => [], querySelector: () => null, setAttribute() {}, focus() {} });
  const box: any = { phraseDrafts: new Map(), serverState: { launchSafety, requests: [] }, UNBLOCK_CONFIRM: "ALLOW IT", STOP_CONFIRM: "RELEASE IT", CSS: { escape: (s: string) => s },
    document: { activeElement: null }, esc: (s: any) => String(s ?? "").replace(/"/g, "&quot;"), $: (id: string) => { if (!elements.has(id)) elements.set(id, fake()); return elements.get(id); },
    send: (message: any) => { sent.push(structuredClone(message)); return true; }, showToast() {}, allTabs: () => [], findTab: () => null, tabIdOfKey: () => null, seatOfKey: () => ({}),
    uncertainRows: () => box.serverState.launchSafety.uncertain ?? [], hiddenProject: () => false, hiddenTab: () => false, currentTab: () => null, tabLabel: String,
    pendingRequestActions: new Map(), requestActionResults: new Map(), requestFormCleared: new Map(), actionStateFor: () => null, placePopover() {}, plainMd: String };
  const context = createContext(box);
  runInContext(read("public/app/09-needs-you-stopping.js"), context);
  // The page's own binding, on fake elements: an input per phrase, the buttons, and the lookups the handlers make.
  const inputs = new Map<string, any>(), buttons: any[] = [];
  const root: any = {
    querySelectorAll: (selector: string) => selector === "[data-phrase-key]" ? [...inputs.values()] : buttons.filter((button) => button.selector === selector),
    querySelector: (selector: string) => [...inputs.values()].find((input) => selector === `[${input.attr}="${input.ref}"]`) ?? null,
  };
  const field = (attr: string, ref: string) => { const input: any = { attr, ref, value: "", dataset: { phraseKey: `${attr}:${ref}` }, addEventListener(_t: string, fn: any) { input.type = fn; } }; inputs.set(`${attr}:${ref}`, input); return input; };
  const button = (selector: string, dataset: any) => { const b: any = { selector, dataset, addEventListener(_t: string, fn: any) { b.click = fn; } }; buttons.push(b); return b; };
  return { box, sent, root, field, button, bind: () => context.bindInbox(root), render: () => context.renderInbox(), list: () => elements.get("inboxList").innerHTML };
}
function typeAndSend(h: ReturnType<typeof inbox>, attr: string, ref: string, phrase: string, selector: string, dataset: any) {
  const input = h.field(attr, ref), submit = h.button(selector, dataset);
  h.bind();
  assert.ok(input.type && submit.click, `control: the page bound the ${attr} input and its ${selector} button`);
  input.value = phrase; input.type();
  assert.equal(h.box.phraseDrafts.get(`${attr}:${ref}`), phrase, "control: the phrase is in the drafts as it is typed");
  submit.click();
}

test("p21 Needs you: a refused Allow again keeps the typed phrase in its box; once the seat is no longer blocked it is dropped", () => {
  const h = inbox({ blocked: [{ seatKey: "alpha.coder" }] });
  h.render();
  assert.match(h.list(), /data-confirm-unblock="alpha\.coder"/, "control: the blocked card is drawn");
  typeAndSend(h, "data-confirm-unblock", "alpha.coder", "ALLOW IT", "[data-unblock]", { unblock: "alpha.coder" });
  const unblock = h.sent.filter((message) => message.type === "unblockSeat");
  console.log(`p21 phrases: matched ${unblock.length} unblockSeat message(s): ${JSON.stringify(unblock)}`);
  assert.equal(unblock.length, 1, "the unblock was sent");
  h.render(); // the server refused: the seat is still blocked
  assert.equal(h.box.phraseDrafts.get("data-confirm-unblock:alpha.coder"), "ALLOW IT", "the refused phrase is still in the drafts");
  assert.match(h.list(), /value="ALLOW IT"/, "and still in the box");
  h.box.serverState.launchSafety = { blocked: [] }; h.render(); // the server took it
  assert.equal(h.box.phraseDrafts.size, 0, "the seat is no longer blocked: its phrase is dropped");
});

test("p21 Needs you: a refused Release keeps the typed phrase; once the run is no longer unconfirmed it is dropped", () => {
  const h = inbox({ uncertain: [{ runId: "r1", seatKey: "alpha.reviewer", pid: 7 }] });
  h.render();
  assert.match(h.list(), /data-confirm-release="r1"/, "control: the unconfirmed card is drawn");
  typeAndSend(h, "data-confirm-release", "r1", "RELEASE IT", "[data-release]", { release: "r1", releaseSeat: "alpha.reviewer" });
  const release = h.sent.filter((message) => message.type === "releaseUnconfirmed");
  console.log(`p21 phrases: matched ${release.length} releaseUnconfirmed message(s): ${JSON.stringify(release)}`);
  assert.equal(release.length, 1, "the release was sent");
  h.render();
  assert.equal(h.box.phraseDrafts.get("data-confirm-release:r1"), "RELEASE IT", "the refused phrase is still in the drafts");
  assert.match(h.list(), /value="RELEASE IT"/, "and still in the box");
  h.box.serverState.launchSafety = { uncertain: [] }; h.render();
  assert.equal(h.box.phraseDrafts.size, 0, "the run is no longer unconfirmed: its phrase is dropped");
});

test("p21 Needs you: a phrase typed for a row that is gone is not kept for a seat that is blocked again later", () => {
  const h = inbox({ blocked: ["alpha.coder"] });
  h.render();
  h.field("data-confirm-unblock", "alpha.coder").value = "ALLOW IT";
  h.box.phraseDrafts.set("data-confirm-unblock:alpha.coder", "ALLOW IT");
  h.box.serverState.launchSafety = { blocked: [] }; h.render();
  h.box.serverState.launchSafety = { blocked: ["alpha.coder"] }; h.render();
  assert.equal(h.box.phraseDrafts.size, 0, "blocked again: the old phrase is not there");
  assert.match(h.list(), /data-confirm-unblock="alpha\.coder"[^>]*value=""/, "the new card starts with an empty box");
});
