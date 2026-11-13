import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { pageHarness, plain } from "./frontend-helpers.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";

test("P26 Run acknowledgement matches tab and slot, frees the latch and allows another request", async () => {
  const h = pageHarness(); const socket = await h.open();
  h.api.onMessage(h.state({ fixedCrew: { version: 1 } }));
  h.api.setRunTarget({ tabId: "t1", slot: "coder", name: "Coder" });
  h.node("runPrompt").value = "Build this";
  h.api.startRun();
  assert.deepEqual(plain(h.api.runState().pendingRun), { tabId: "t1", slot: "coder" });
  for (const reply of [{ tabId: "other", slot: "coder" }, { tabId: "t1", slot: "planner" }]) {
    h.api.onMessage({ type: "fixedRunRequested", ...reply });
    assert.ok(h.api.runState().pendingRun, "foreign acknowledgements preserve the pending Run");
  }
  h.api.onMessage({ type: "fixedRunRequested", tabId: "t1", slot: "coder" });
  assert.equal(h.api.runState().pendingRun, null, "matching acknowledgement releases pendingRun");
  assert.match(h.node("toast").textContent, /requested/);
  assert.doesNotMatch(h.node("toast").textContent, /started/);
  h.api.startRun();
  assert.equal(socket.sent.filter((m: any) => m.type === "run").length, 2, "later Run reaches the socket");
});

test("P26 missing Leader never falls back to a worker; default work preserves chat and guidance", () => {
  const h = pageHarness();
  const worker = h.tab().crew[1];
  for (const crew of [[], [worker]]) {
    const tab = h.tab({ fixedCrew: { version: 1 }, crew });
    h.api.onMessage(h.state(tab));
    assert.equal(h.api.leader(tab), null, "a fixed tab has no implicit Leader");
    assert.equal(h.api.selectedSeat(tab), null, "default view remains the Leader work view");
    const view = h.node("view");
    let html = "";
    view.children = []; view.contains = () => true; view.prepend = () => {};
    view.append = (content: any) => { html += content.html; };
    h.api.document.createElement = () => {
      const template: any = { content: {} };
      Object.defineProperty(template, "innerHTML", { set(value) { template.content.html = value; } });
      return template;
    };
    h.api.onMessage({ type: "chatHistory", tabId: "t1", messages: [{ role: "assistant", text: "Retained answer", at: 1 }], revision: 1, savedRevision: 0 });
    h.api.real.renderStage();
    assert.match(html, /Leader has no model/);
    assert.match(html, /Retained answer/);
    assert.doesNotMatch(html, /is ready|Waiting for server state|Tell .*what you want/);
  }
  const restored = h.tab({ fixedCrew: { version: 1 } });
  h.api.onMessage(h.state(restored));
  assert.equal(h.api.selectedSeat(restored).slot, "leader", "server reassignment restores Leader without reload");
});

test("P26 approval styles and roster avatars restore existing assets only", () => {
  const css = readFileSync("public/styles/02-chat-panels.css", "utf8");
  for (const selector of [".ask{", ".ask .h{", ".ask p{", ".ask .acts{", ".ask.ok{", ".ask.stop{"]) assert.ok(css.includes(selector), selector);
  const source = readFileSync("public/app/01-markdown-state.js", "utf8");
  const entries = [...source.match(/const SLOT_PRESET = \{([^}]+)\}/)![1].matchAll(/(\w+): "(\w+)"/g)];
  assert.deepEqual(entries.map((m) => m[1]).sort(), FIXED_CREW.map((s) => s.slot).sort());
  for (const [, slot, avatar] of entries) assert.ok(existsSync(`public/avatars/${avatar}.svg`), `${slot}: ${avatar}`);
  assert.ok(source.includes('const ME_DEFAULT = "ash.svg"'));
});
