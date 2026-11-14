import test from "node:test";
import assert from "node:assert/strict";
import { CLIS, pageHarness, plain, p18Crew } from "./frontend-helpers.ts";

// Block 5 slice 2f2: only the fixed Settings and creation adapters choose a model. The ACP choice, Full access question, cancel, confirm and the fixed
// assignment are proved on the real page (test/fixed-crew-page.test.ts, "FCUI the shared model menu"); effort and busy locking in test/fixed-crew-picker.test.ts.
test("pack 18 P1: a coder seat's model list is offered every CLI the server lists, its own first (the ACP ones included)", () => {
  const h = pageHarness(); h.api.setLayers();
  const crew = p18Crew();
  h.api.onMessage(h.state({ crew }, { clis: CLIS }));
  const coder = h.state({ crew }).projects[0].tabs[0].crew.find((item: any) => item.slot === "coder");
  assert.deepEqual(plain(h.api.real.pickerClis(coder)), ["claude", "codex", "opencode", "acp:kimi", "acp:oracle", "acp:bare"], "a coder seat is offered every CLI the server lists, its own first");
  const rows = h.api.real.modelRows(coder, "");
  for (const cli of ["acp:kimi", "acp:oracle", "acp:bare"]) assert.match(rows, new RegExp(`data-cli="${cli}"`), `an ACP CLI (${cli}) has a row in a coder seat's model list`);
});

test("pack 18 P2: the seat card's Advisor fact follows the CLI's advisor capability and is read-only: a Claude planner and a capable ACP seat show it, a Codex reviewer does not", () => {
  const h = pageHarness(); h.api.setLayers();
  const crew = p18Crew();
  h.api.onMessage(h.state({ crew }, { clis: CLIS }));
  const tab = h.state({ crew }).projects[0].tabs[0];
  const inert = { addEventListener() {}, querySelector: () => null };
  const card = (slot: string) => { const pop = h.node("seatPop"); pop.querySelector = () => inert; h.api.real.renderSeatCard(tab, tab.crew.find((item: any) => item.slot === slot)); return String(pop.innerHTML); };
  const advisor = (html: string) => new RegExp(String.raw`<span>Advisor</span><span class="v"[^>]*><span>([^<]*)</span>`).exec(html)?.[1] ?? null;
  assert.equal(advisor(card("planner")), "✦ Fable 5.1", "a Claude planner shows that seat's own saved advisor");
  assert.equal(advisor(card("coder")), "✦ Off", "a Claude seat with no advisor says Off");
  assert.equal(advisor(card("reviewer1")), null, "a Codex reviewer has no Advisor fact");
  assert.equal(advisor(card("oracle")), "✦ Off", "an ACP CLI the server says can advise gets the fact, whatever its name");
  assert.equal(advisor(card("kimi")), null, "an ACP CLI that cannot advise does not");
  for (const slot of ["leader", "planner", "coder", "reviewer1", "oracle", "kimi"]) assert.doesNotMatch(card(slot), /data-seat-advisor|data-seat-model|data-advisor|<button[^>]*class="rowb"/, `${slot}: no model or advisor edit control and no chevron button on the card`);
  // The seat card stays read-only. Settings position rows edit advisors beside the model button (pack27-advisor-page.test.ts); Usage facts are covered by FCPICK saved advisors.
});

// Block 5 slice 2a: creation is fixed-crew only. The old Our process default and the kind and template controls are gone; the payload and
// the preserved choices are proved on the real page in test/fixed-crew-creation.test.ts and test/fixed-crew-page.test.ts. What stays here: a page with no
// fixed crew UI offers no old fallback, so Add a tab says it is unavailable, keeps Create disabled and sends nothing.
test("pack 18 P6b: with no fixed crew available, Add a tab sends no addTab and offers no kind or template", async () => {
  const h = pageHarness(); h.api.setLayers();
  h.api.onMessage(h.state({}, { clis: CLIS }));
  const socket = await h.open();
  h.api.real.openAddTab(null);
  assert.match(String(h.node("tCrew").textContent), /not available/, "the dialog says plainly that the crew positions are unavailable");
  assert.equal(h.node("tCrew").hidden, false, "and shows it");
  assert.equal(h.node("createTab").disabled, true, "Create tab stays disabled");
  assert.equal(String(h.node("tplBox").innerHTML) + String(h.node("kindBox").innerHTML), "", "no kind or template options are drawn");
  h.api.real.createTab();
  assert.deepEqual(socket.sent.filter((message: any) => message.type === "addTab"), [], "a forced Create sends nothing: no old-format tab, no template, no process id");
  assert.match(String(h.node("tStat").textContent), /Not created/, "and says nothing was created");
});

test("pack 18 P7: access text and the read-only warning are worded from readOnlyEnforced, so an ACP seat says it can write like a Codex one", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({}, { clis: CLIS }));
  const tab = h.state().projects[0].tabs[0];
  const access = (cli: string, canWrite: boolean) => h.api.real.accessText(tab, { slot: "x", name: "X", cli, canWrite });
  assert.match(access("acp:kimi", false), /^Read-only \(asked not to write; Kimi can still write through commands\)$/, "a read-only ACP seat says it can still write");
  assert.match(access("acp:kimi", true), /Kimi can still reach outside it/, "a writing ACP seat says it can reach outside its folder");
  assert.match(access("codex", false), /Codex can still write through commands/, "Codex says the same");
  assert.equal(access("claude", false), "Told not to write · Claude Code has no folder sandbox", "Claude's read-only is enforced, so it makes no such claim");
  assert.equal(access("opencode", true), "Can write, works in p · OpenCode has no folder sandbox");
  const warn = (cli: string) => h.api.real.readOnlyWarning({ slot: "x", name: "X", cli });
  assert.match(warn("acp:kimi"), /class="safety-warning">X runs on Kimi, which cannot be held read-only\. It can still write\./);
  assert.match(warn("codex"), /safety-warning/);
  assert.equal(warn("claude"), "", "an enforced read-only CLI gets no warning");
  assert.equal(warn("opencode"), "");
  h.api.onMessage(h.state({}, { clis: [{ ...CLIS[0], label: "Claude Work" }, ...CLIS.slice(1)] }));
  assert.equal(access("claude", true), "Can write, works in p · Claude Work has no folder sandbox", "a CLI's label is the server's, not a table inside the page");
});

test("pack 18 P8: the run line and the launch notice name who launched it (a seat such as the planner), and the user's own Run names nobody", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ crew: p18Crew() }, { clis: CLIS }));
  const lines = () => plain(h.api.snap().activity.map((item: any) => item.text));
  h.api.onMessage({ type: "runStart", tabId: "t1", seatKey: "t1.coder", runId: "r1", model: "claude-sonnet-5-5[1m]", launchedBy: { kind: "seat", slot: "planner", name: "Sage" } });
  h.api.onMessage({ type: "runStart", tabId: "t1", seatKey: "t1.coder", runId: "r2", model: "claude-sonnet-5-5[1m]", launchedBy: { kind: "leader", slot: "leader", name: "Atlas" } });
  h.api.onMessage({ type: "runStart", tabId: "t1", seatKey: "t1.coder", runId: "r3", model: "claude-sonnet-5-5[1m]", launchedBy: null });
  assert.deepEqual(lines().slice(0, 3).reverse(), ["Sonny started Sonnet 5.5 · launched by Sage", "Sonny started Sonnet 5.5 · launched by Atlas", "Sonny started Sonnet 5.5"]);
  h.api.onMessage({ type: "leaderLaunch", id: 7, seatId: "t1.coder", seatKey: "t1.coder", seatName: "Sonny", brief: "x", source: "Sage", pending: false });
  assert.equal(lines()[0], "Sage requested Sonny", "the notice names the planner that launched it");
});

test("pack 18 P9: the approval card and its title name the seat that asks (the planner), the leader for an approval with no asker, and the waiting mark follows the asker", () => {
  const h = pageHarness();
  const crew = p18Crew();
  const approval = (id: string, askedBy?: unknown) => ({ approvalId: id, tool: "fixed-action", summary: `launch ${id}`, createdAt: 1, ...(askedBy ? { askedBy } : {}) });
  h.api.onMessage(h.state({ crew, pendingApprovals: [] }, { clis: CLIS }));
  const planner = { kind: "seat", slot: "planner", name: "Sage" };
  h.api.onMessage(h.state({ crew, pendingApprovals: [approval("a", planner)] }, { clis: CLIS }));
  assert.deepEqual(h.notifications.map((item) => item.title), ["Sage needs your answer"], "the alert names the asker");
  h.api.real.renderToolApproval();
  assert.equal(h.node("approvalTitle").textContent, "Sage wants to start fixed work");
  const tab = h.state({ crew, pendingApprovals: [approval("a", planner)] }).projects[0].tabs[0];
  assert.match(h.api.real.attentionCard({ type: "toolApproval", tab, approval: tab.pendingApprovals[0] }), /Sage wants to start fixed work/, "so does the Needs you card");
  const seatLine = (slot: string) => plain(h.api.real.seatLine(tab, tab.crew.find((item: any) => item.slot === slot)));
  assert.equal(seatLine("planner").text, "Waiting on your answer", "the planner's rail row waits on you");
  assert.notEqual(seatLine("leader").text, "Waiting on your answer", "the leader does not");
  const plainTab = h.state({ crew, pendingApprovals: [approval("b")] }).projects[0].tabs[0];
  assert.equal(h.api.approvalTitle("fixed-action", plainTab, null), "Atlas wants to start fixed work", "no asker: the leader's current name, as before");
});

// Block 5 slice 2d2: the old crew editor is deleted. With no fixed crew UI on the page (this VM loads none), Settings says plainly that the crew and
// models are unavailable, offers no old editor or seat row, and keeps every other section. A fixed Settings list is proved on the real page (W1, FCUI Settings).
test("pack 18 P10: with no fixed crew UI, Settings says Crew and models unavailable, offers no old editor or seat row, and keeps its other sections", async () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ crew: p18Crew() }, { clis: CLIS }));
  await h.open();
  assert.equal(h.window.CC_FIXED_CREW, undefined, "control: this page has no fixed crew UI");
  const body = h.node("setBody");
  h.api.real.renderSettings(true);
  const html = String(body.innerHTML);
  assert.match(html, /<section class="settings-section" id="s-crew" data-section="crew"><h3>Crew and models · [^<]*<\/h3><p class="settings-help" data-crew-unavailable>Crew and models unavailable\.<\/p><\/section>/, "the crew section is its heading and the plain unavailable message");
  assert.equal(html.match(/id="s-crew"/g)?.length, 1, "one crew section");
  assert.doesNotMatch(html, /data-setup-editor|data-settings-orchestrates|data-settings-model|data-settings-advisor|data-settings-crew|data-se-/, "no old editor mount, seat rows or Change row");
  for (const id of ["tools", "acp", "github", "vault", "folders", "skills", "appearance", "behaviour"]) assert.match(html, new RegExp(`id="s-${id}" data-section="${id}"`), `the ${id} section is still drawn`);
});
