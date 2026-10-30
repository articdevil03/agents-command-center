import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// Pack 21: a typed thing is deleted when the server TAKES it, not when the request is sent. The real page scripts run in a VM with a fake
// socket and fake elements (no Chrome); every click goes through the real listener, and every target is printed as it is found.

const read = (file: string) => readFileSync(file, "utf8");

// ---- the crew editor: a refused Switch to keeps the unsaved crew ----
function editor() {
  const listeners: any[] = [], sent: any[] = [], clicks: any[] = [];
  class Socket { addEventListener(type: string, fn: any) { if (type === "message") listeners.push(fn); } }
  const window: any = { WebSocket: Socket };
  const context = createContext({ window, document: { addEventListener() {}, getElementById() { return null; }, body: {} }, setTimeout() {}, requestAnimationFrame(fn: any) { fn(); }, CSS: { escape: (s: string) => s }, crypto: { randomUUID: () => "req" } });
  for (const file of ["public/setup-editor.js", "public/setup-editor-draw.js", "public/setup-editor-events.js"]) runInContext(read(file), context);
  const se = window.CC_SETUP_EDITOR;
  assert.ok(se?.wire && se.foot, "control: the real editor, its Save bar and its events loaded");
  se.draw = () => "";
  // render() wires the root itself, with the real SE.wire: the click listener it adds is the one a person's click reaches.
  const root = { isConnected: true, classList: { add() {} }, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, closest: () => null, addEventListener: (type: string, fn: any) => { if (type === "click") clicks.push(fn); } };
  const tab: any = { id: "t1", lookPause: false, setupName: "Mine", processState: { crewGenerationId: "before" }, crew: [
    { slot: "leader", name: "Lead", role: "Leader", cli: "claude", model: "m", effort: "high", canWrite: true, isLeader: true },
    { slot: "coder", name: "Coder", role: "Coder", cli: "claude", model: "m", effort: "high", canWrite: true, isLeader: false },
  ] };
  const state: any = { savedSetups: [{ id: "other", name: "Other" }], templates: [], clis: [] };
  const ctx = { tab, state, send: (message: any) => { sent.push(structuredClone(message)); return true; } };
  const draw = () => se.render(root, ctx);
  draw(); new window.WebSocket();
  assert.equal(clicks.length, 1, "control: the real click listener was captured");
  const press = (...hits: string[]) => { for (const attr of hits) clicks[0]({ target: { closest: (selector: string) => selector === `[${attr}]` ? { dataset: { seUse: "saved", id: "other", seRow: "coder" } } : null } }); };
  const draft = () => { se.setSeat("coder", { canWrite: false }); return se.ed(tab.id); };
  const answer = (message: any) => listeners.forEach((fn) => fn({ data: JSON.stringify(message) }));
  return { se, tab, sent, draw, press, draft, answer };
}
// The person has an unsaved crew, picks a saved setup and confirms: the real click path.
function switching() {
  const h = editor(), s = h.draft();
  assert.ok(s.draft && h.se.unsaved(h.tab, s), "control: an unsaved crew exists before the switch");
  h.press("data-se-row");
  h.se.pickRole("coder", null);
  h.se.typeInto("coder", "name", "Typed coder");
  h.se.typeInto("coder", "role", "Typed specialist");
  const kept = keptState(s);
  assert.equal(kept.crew.find((seat: any) => seat.slot === "coder").name, "Typed coder");
  assert.equal(kept.crew.find((seat: any) => seat.slot === "coder").role, "Typed specialist");
  assert.equal(kept.open, "coder", "control: the seat card is open");
  assert.deepEqual(kept.custom, ["coder"], "control: custom-role typing is active");
  h.press("data-se-use", "data-se-confirm");
  const use = h.sent.filter((message) => message.type === "useSetup");
  console.log(`p21 editor: matched ${use.length} useSetup message(s): ${JSON.stringify(use)}`);
  assert.equal(use.length, 1, "the confirmed switch was sent once");
  assert.equal(use[0].setupId, "other");
  return { ...h, s, use, kept };
}

function keptState(s: any) {
  return { crew: structuredClone(s.draft?.crew ?? null), open: s.open, custom: [...s.custom] };
}
function assertKept(h: ReturnType<typeof switching>, label: string) {
  const actual = keptState(h.s);
  console.log(`p21 editor ${label}: compared before=${JSON.stringify(h.kept)} after=${JSON.stringify(actual)}`);
  assert.deepEqual(actual.crew, h.kept.crew, label + ": draft crew contents are unchanged");
  assert.equal(actual.open, h.kept.open, label + ": open card is unchanged");
  assert.deepEqual(actual.custom, h.kept.custom, label + ": custom-role typing is unchanged");
}

test("p21 editor: the server refuses the switch, the unsaved crew and its open card stay and the refusal shows", () => {
  const h = switching();
  assert.ok(h.s.draft, "waiting for the answer: the crew is still kept");
  h.answer({ type: "error", action: "useSetup", tabId: h.tab.id, message: "Tab is busy" });
  assert.equal(h.s.waiting, null, "the refusal ended the wait");
  assert.equal(h.s.error, "Tab is busy");
  assertKept(h, "refused switch");
  h.draw();
  assertKept(h, "draw after refusal");
  assert.match(h.se.foot(h.tab, h.s, false), /Tab is busy/, "the Save bar shows the refusal");
});

test("p21 editor: control, the server confirms the switch (new generation): the crew is cleared and the note says Switched to", () => {
  const h = switching();
  h.draw();
  assert.ok(h.s.draft, "no answer yet: kept");
  h.tab.processState.crewGenerationId = "after"; h.draw();
  assert.equal(h.s.draft, null, "the switch took: the old unsaved crew is gone");
  const cleared = keptState(h.s);
  console.log(`p21 editor confirmed switch: compared before=${JSON.stringify(h.kept)} after=${JSON.stringify(cleared)}`);
  assert.equal(cleared.crew, null, "confirmed switch clears the crew");
  assert.equal(cleared.open, null, "confirmed switch closes the card");
  assert.deepEqual(cleared.custom, [], "confirmed switch clears custom-role typing");
  assert.equal(h.s.note.text, "Switched to Other");
});

test("p21 editor: no answer within the wait keeps the unsaved crew and says the server did not answer", () => {
  const h = switching();
  h.s.waiting.at -= 16_000; h.draw();
  assert.equal(h.s.waiting, null);
  assertKept(h, "15 s no-answer timeout");
  assert.match(h.s.error, /has not answered/);
});

test("p21 editor: while a switch waits, Save sends nothing, the Save bar is greyed and Discard does nothing", () => {
  const h = switching();
  const before = h.sent.length;
  h.se.save();
  assert.equal(h.sent.length, before, "Save while a switch waits sent no second request");
  h.press("data-se-save");
  assert.equal(h.sent.length, before, "also through the Save button");
  const bar = h.se.foot(h.tab, h.s, false);
  console.log(`p21 editor: Save bar while waiting: ${bar.match(/<button[^>]*data-se-save[^>]*>/)?.[0]}`);
  assert.match(bar, /data-se-save[^>]*aria-disabled="true"/);
  h.press("data-se-discard");
  assert.ok(h.s.draft, "Discard does nothing while the switch waits");
  h.answer({ type: "error", action: "useSetup", tabId: h.tab.id, message: "no" });
  assert.doesNotMatch(h.se.foot(h.tab, h.s, false), /data-se-save[^>]*aria-disabled/, "control: after the refusal the Save bar is live again");
  h.se.save();
  assert.equal(h.sent.at(-1).type, "setSetup", "and Save works again");
});

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
