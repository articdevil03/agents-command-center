import test from "node:test";
import assert from "node:assert/strict";
import { CLIS, wireNode, pageHarness, heldTimer, plain, p18Crew, P18_CLAUDE_MODELS } from "./frontend-helpers.ts";

test("pack 18 P1: the model picker offers the ACP CLIs on a coder seat too, and picking one asks for Full access and then sends confirm", async () => {
  const h = pageHarness(); h.api.setLayers();
  const crew = p18Crew();
  h.api.onMessage(h.state({ crew }, { clis: CLIS }));
  const socket = await h.open();
  const tab = h.state({ crew }).projects[0].tabs[0], coder = tab.crew.find((item: any) => item.slot === "coder");
  assert.deepEqual(plain(h.api.real.pickerClis(coder)), ["claude", "codex", "opencode", "acp:kimi", "acp:oracle", "acp:bare"], "a coder seat is offered every CLI the server lists, its own first");
  const pop = h.node("pop"), wired = wireNode(pop);
  h.api.real.drawModelPicker(tab, coder, null, false);
  const kimi = wired.find("cli", "acp:kimi");
  assert.ok(kimi, "an ACP CLI has a button in a coder seat's picker");
  kimi.click();
  const asked = h.api.confirmCalls.at(-1);
  assert.equal(asked.title, "Use Kimi as Sonny's CLI?", "picking it asks first");
  assert.match(asked.body, /cannot hold it read-only/, "the crew-seat wording says it cannot be held read-only");
  assert.equal(socket.sent.filter((message: any) => message.type === "updateSeat").length, 0, "nothing is sent before the answer");
  asked.callback();
  assert.deepEqual(socket.sent.filter((message: any) => message.type === "updateSeat"), [{ type: "updateSeat", tabId: "t1", slot: "coder", model: "default", cli: "acp:kimi", confirm: true }], "the answer sends the CLI with confirm: true");
});

test("pack 18 P2: the Advisor row follows the CLI's advisor capability: a Claude planner and a capable ACP seat have it, a Codex reviewer does not", () => {
  const h = pageHarness(); h.api.setLayers();
  const crew = p18Crew();
  h.api.onMessage(h.state({ crew }, { clis: CLIS }));
  const tab = h.state({ crew }).projects[0].tabs[0];
  const inert = { addEventListener() {}, querySelector: () => null };
  const card = (slot: string) => { const pop = h.node("seatPop"); pop.querySelector = () => inert; h.api.real.renderSeatCard(tab, tab.crew.find((item: any) => item.slot === slot)); return String(pop.innerHTML); };
  const planner = card("planner");
  assert.match(planner, /data-seat-advisor/, "a Claude planner has the Advisor row");
  assert.match(planner, /✦ Fable 5\.1/, "and it shows that seat's own advisor");
  assert.match(card("coder"), /✦ Off/, "a Claude seat with no advisor says Off");
  assert.doesNotMatch(card("reviewer1"), /data-seat-advisor/, "a Codex reviewer has no Advisor row");
  assert.match(card("oracle"), /data-seat-advisor/, "an ACP CLI the server says can advise gets the row, whatever its name");
  assert.doesNotMatch(card("kimi"), /data-seat-advisor/, "an ACP CLI that cannot advise does not");
  // Settings has no seat rows of its own any more: its crew is the crew editor's one list (test/pack18-editor.test.ts W3 checks its Advisor rows).
  const settings = h.api.real.settingsCrewSection();
  assert.match(settings, /<div data-setup-editor><\/div><\/section>$/, "the Settings crew section is the editor's mount");
  assert.doesNotMatch(settings, /data-settings-advisor|data-settings-model|class="crow"/, "and no old seat row");
  h.api.onMessage(h.state({ crew }, { clis: CLIS }));
  const usage = (() => { h.api.renderUsage(tab); return String(h.node("usage").innerHTML); })();
  assert.match(usage, /Advisor for Sage/, "the Usage panel lists the planner's advisor");
  assert.match(usage, /Advisor for Atlas/, "and the leader's: every seat that has one");
  assert.doesNotMatch(usage, /Advisor for Vera/);
});

test("pack 18 P3: choosing an advisor sends updateSeat with the seat's slot and the advisor, and null for Off", async () => {
  const h = pageHarness(); h.api.setLayers();
  const crew = p18Crew();
  h.api.onMessage(h.state({ crew }, { clis: CLIS, claudeModels: P18_CLAUDE_MODELS }));
  const socket = await h.open();
  const tab = h.state({ crew }).projects[0].tabs[0], planner = tab.crew.find((item: any) => item.slot === "planner");
  const wired = wireNode(h.node("pop"));
  h.api.real.openAdvisor(tab, planner, null);
  wired.find("advisor", "claude-fable-5-1").click();
  wired.find("advisor", "").click();
  assert.deepEqual(socket.sent.filter((message: any) => message.type === "updateSeat" || message.type === "setAdvisor"), [
    { type: "updateSeat", tabId: "t1", slot: "planner", advisor: "claude-fable-5-1" },
    { type: "updateSeat", tabId: "t1", slot: "planner", advisor: null },
  ]);
});

test("pack 18 P4: a rounds step with its own id (qa) still shows the round buttons, and a plain step called review does not", () => {
  const h = pageHarness();
  const crew = p18Crew();
  const bar = (stepId: string, type: string) => [{ stepId: "brief", type: "work", state: "done", label: "Brief", owners: ["planner"] }, { stepId, type, state: "current", label: "QA", owners: ["reviewer1"] }, { stepId: "ship", type: "finish", state: "todo", label: "Ship", owners: ["planner"] }];
  const tabWith = (stepId: string, type: string, phase: string) => { const message: any = h.state({ crew, derived: { stepBar: bar(stepId, type), busy: false }, processState: { approval: { state: "approved" }, phase, round: 1 } }, { clis: CLIS }); h.api.onMessage(message); return message.projects[0].tabs[0]; };
  const review = h.api.real.stepActions(tabWith("qa", "rounds", "review"));
  assert.match(review, /data-process-action="reviewClean"/, "round buttons for a rounds step called qa");
  assert.match(review, /data-process-action="reviewFindings"/);
  assert.match(h.api.real.stepActions(tabWith("qa", "rounds", "fix")), /data-process-action="finishFix"/, "and the fix step's button");
  const decoy = h.api.real.stepActions(tabWith("review", "work", "review"));
  assert.doesNotMatch(decoy, /reviewClean|reviewFindings/, "a work step that happens to be called review gets no round buttons");
  assert.match(decoy, /data-process-action="advanceStep"/, "it gets the ordinary Continue button");
});

test("pack 18 P5: a pair with two fixers shows the fixer picker (the right pair for the round), the choice follows the server, and a pick sends selectFixer", async () => {
  const h = pageHarness();
  const crew = [...p18Crew(), { slot: "fixer2", name: "Nova", cli: "codex", model: "gpt-6.1-sol", effort: "low", canWrite: true, role: "Fixer 2", seatKey: "t1.fixer2" }, { slot: "fixer3", name: "Ziggy", cli: "codex", model: "gpt-6.1-sol", effort: "low", canWrite: true, role: "Fixer 3", seatKey: "t1.fixer3" }];
  const steps = [{ id: "qa", label: "QA", type: "rounds", pairs: [{ reviewer: "reviewer1", fixers: ["fixer1"] }, { reviewer: "reviewer1", fixers: ["fixer2", "fixer3"] }] }];
  const tabAt = (round: number, selectedFixer?: string) => { const message: any = h.state({ crew, steps, derived: { stepBar: [{ stepId: "qa", type: "rounds", state: "current", label: "QA", owners: ["fixer1"] }], busy: false }, processState: { approval: { state: "approved" }, phase: "fix", round, ...(selectedFixer ? { selectedFixer } : {}) } }, { clis: CLIS }); h.api.onMessage(message); return message.projects[0].tabs[0]; };
  assert.doesNotMatch(h.api.real.stepActions(tabAt(1)), /data-fixer=/, "round 1 uses the pair with one fixer: no picker");
  const two = h.api.real.stepActions(tabAt(2));
  assert.match(two, /data-fixer="fixer2"/, "round 2 uses the pair with two fixers");
  assert.match(two, /data-fixer="fixer3"/);
  assert.doesNotMatch(two, /data-fixer="fixer1"/, "a fixer of another pair is not offered");
  assert.match(two, /data-fixer="fixer2" aria-checked="true"/, "no choice yet: the pair's first fixer is checked");
  assert.match(h.api.real.stepActions(tabAt(2, "fixer3")), /data-fixer="fixer3" aria-checked="true"/, "the server's choice is the checked one");
  assert.match(h.api.real.stepActions(tabAt(2, "fixer1")), /data-fixer="fixer2" aria-checked="true"/, "a choice that is not in this pair's list falls back to the first");
  const socket = await h.open();
  const acts = wireNode(h.node("stepActs"));
  h.api.real.renderPipe(tabAt(2));
  acts.find("fixer", "fixer3").click();
  assert.deepEqual(socket.sent.filter((message: any) => message.type === "selectFixer"), [{ type: "selectFixer", tabId: "t1", slot: "fixer3" }]);
});

test("pack 18 P6: the switch menu lists the server's templates and saved setups, each with its own face count, and a pick sends useSetup", async () => {
  const dummySeat = (slot: string) => ({ slot, name: slot, cli: "claude", model: "m", effort: "low", canWrite: false, isLeader: slot === "leader", role: slot });
  const templates = [
    { id: "our-process", name: "Our process", kind: "dev", desc: "Planner runs the pack", crew: ["leader", "planner", "coder", "reviewer1", "fixer1", "reviewer2", "fixer2", "final"].map(dummySeat), steps: [] },
    { id: "duo", name: "The Duo", kind: "dev", desc: "Leader and coder", crew: ["leader", "coder"].map(dummySeat), steps: [] },
    { id: "solo", name: "Stand-alone", kind: "dev", desc: "Just the leader", crew: ["leader"].map(dummySeat), steps: [] },
  ];
  const savedSetups = [{ id: "s1", name: "My crew", kind: "dev", crew: ["leader", "coder", "reviewer1"].map(dummySeat), steps: [{ id: "a" }, { id: "b" }] }];
  const open = async (custom = false, tabPatch: any = {}, seatPatch: any = {}) => {
    const h = pageHarness(); h.api.setLayers();
    const crew = templates[0].crew.map((seat) => ({ ...seat }));
    if (custom) crew[2].role = "Custom coder";
    Object.assign(crew[1], seatPatch);
    h.api.onMessage(h.state({ crew, setupName: "Our process", ...tabPatch }, { clis: CLIS, templates, savedSetups }));
    const socket = await h.open();
    const wired = wireNode(h.node("setupPop"));
    h.api.real.processMenu(h.state({ crew, setupName: "Our process", ...tabPatch }).projects[0].tabs[0], h.node("setupsBtn"));
    return { h, socket, wired, html: String(h.node("setupPop").innerHTML) };
  };
  const { html, h, socket, wired } = await open();
  const block = (attr: string, id: string) => html.split(/(?=<button)/).find((part) => part.includes(`${attr}="${id}"`)) ?? "";
  for (const item of templates) {
    const part = block("data-use-template", item.id);
    assert.ok(part.includes(`<span>${item.name}</span>`), `${item.name} is listed`);
    assert.ok(part.includes(`${item.crew.length} seat${item.crew.length === 1 ? "" : "s"}`), `${item.name} says ${item.crew.length} seats`);
    assert.equal((part.match(/<img /g) ?? []).length, item.crew.length, `${item.name} shows one face per seat of ITS crew`);
  }
  assert.ok(block("data-use-template", "our-process").includes("in use"), "the setup the tab has is marked in use");
  assert.ok(block("data-use-saved", "s1").includes("<span>My crew</span>") && (block("data-use-saved", "s1").match(/<img /g) ?? []).length === 3, "a saved setup is listed with its own faces");
  wired.find("useTemplate", "duo").click();
  heldTimer(h.timers).fn();
  assert.deepEqual(socket.sent.filter((message: any) => message.type === "useSetup"), [{ type: "useSetup", tabId: "t1", templateId: "duo" }], "a template pick sends useSetup with templateId only");
  const second = await open();
  second.wired.find("useSaved", "s1").click();
  heldTimer(second.h.timers).fn();
  assert.deepEqual(second.socket.sent.filter((message: any) => message.type === "useSetup"), [{ type: "useSetup", tabId: "t1", setupId: "s1" }], "a saved setup pick sends setupId only");
  const customized = await open(true);
  customized.wired.find("useTemplate", "our-process").click();
  heldTimer(customized.h.timers).fn();
  assert.deepEqual(customized.socket.sent.filter((message: any) => message.type === "useSetup"), [{ type: "useSetup", tabId: "t1", templateId: "our-process" }], "the same name restores the template after role edits");
  // Same name and seats, but a different look switch or a seat's Can write: still a change, so it is sent.
  for (const [what, tabPatch, seatPatch] of [["look switch", { lookPause: true }, {}], ["Can write", {}, { canWrite: true }]] as const) {
    const edited = await open(false, tabPatch, seatPatch);
    edited.wired.find("useTemplate", "our-process").click();
    heldTimer(edited.h.timers).fn();
    assert.deepEqual(edited.socket.sent.filter((message: any) => message.type === "useSetup"), [{ type: "useSetup", tabId: "t1", templateId: "our-process" }], `a crew differing only in its ${what} is switched back`);
  }
  const same = await open();
  same.wired.find("useTemplate", "our-process").click();
  assert.equal(same.h.timers.filter((timer) => !timer.cleared && timer.ms >= 9000 && timer.ms <= 10000).length, 0, "picking the setup the tab already has holds nothing");
});

test("pack 18 P6b: a new Development tab starts with Our process, and addTab carries the template", async () => {
  const dummySeat = (slot: string) => ({ slot, name: slot, cli: "claude", model: "m", effort: "low", canWrite: false, isLeader: slot === "leader", role: slot });
  const templates = [
    { id: "duo", name: "The Duo", kind: "dev", desc: "Leader and coder", crew: ["leader", "coder"].map(dummySeat), steps: [] },
    { id: "our-process", name: "Our process", kind: "dev", desc: "Planner runs the pack", crew: ["leader", "planner"].map(dummySeat), steps: [] },
    { id: "marketing", name: "Marketing", kind: "mkt", desc: "Posts", crew: ["leader"].map(dummySeat), steps: [] },
  ];
  const h = pageHarness(); h.api.setLayers();
  h.api.onMessage(h.state({}, { clis: CLIS, templates }));
  const socket = await h.open();
  h.api.real.openAddTab(null);
  assert.match(String(h.node("tplBox").innerHTML), /aria-checked="true" data-template="our-process"/, "Our process is the checked template, though it is not first in the list");
  h.api.real.createTab();
  const added = socket.sent.filter((message: any) => message.type === "addTab");
  assert.equal(added.length, 1);
  assert.equal(added[0].template, "our-process", "the new tab asks for Our process");
  assert.equal(added[0].kind, "dev");
  assert.ok(!("process" in added[0]), "and sends no old process id");
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
  const approval = (id: string, askedBy?: unknown) => ({ approvalId: id, tool: "launch:Sonny", summary: `launch ${id}`, createdAt: 1, ...(askedBy ? { askedBy } : {}) });
  h.api.onMessage(h.state({ crew, pendingApprovals: [] }, { clis: CLIS }));
  const planner = { kind: "seat", slot: "planner", name: "Sage" };
  h.api.onMessage(h.state({ crew, pendingApprovals: [approval("a", planner)] }, { clis: CLIS }));
  assert.deepEqual(h.notifications.map((item) => item.title), ["Sage needs your answer"], "the alert names the asker");
  h.api.real.renderToolApproval();
  assert.equal(h.node("approvalTitle").textContent, "Sage wants to launch Sonny");
  const tab = h.state({ crew, pendingApprovals: [approval("a", planner)] }).projects[0].tabs[0];
  assert.match(h.api.real.attentionCard({ type: "toolApproval", tab, approval: tab.pendingApprovals[0] }), /Sage wants to launch Sonny/, "so does the Needs you card");
  const seatLine = (slot: string) => plain(h.api.real.seatLine(tab, tab.crew.find((item: any) => item.slot === slot)));
  assert.equal(seatLine("planner").text, "Waiting on your answer", "the planner's rail row waits on you");
  assert.notEqual(seatLine("leader").text, "Waiting on your answer", "the leader does not");
  const plainTab = h.state({ crew, pendingApprovals: [approval("b")] }).projects[0].tabs[0];
  assert.equal(h.api.approvalTitle("launch:Sonny", plainTab, null), "Atlas wants to launch Sonny", "no asker: the leader's current name, as before");
});

test("pack 18 P10: Settings draws the crew editor once per draw, with its context (the tab, the state, the socket, the Save bar strip, the model and advisor menus, the one model name, the lock); its old seat rows and Runs the process switches are gone", async () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ crew: p18Crew() }, { clis: CLIS }));
  await h.open();
  const calls: any[] = [];
  h.window.CC_SETUP_EDITOR = { render: (el: unknown, context: any) => calls.push({ el, context }) };
  const body = h.node("setBody"), mount = { mount: true };
  body.querySelector = (selector: string) => selector === "[data-setup-editor]" ? mount : null;
  h.api.real.renderSettings(true);
  const html = String(body.innerHTML);
  assert.match(html, /<section class="settings-section" id="s-crew" data-section="crew"><h3>Crew and models · [^<]*<\/h3><div data-setup-editor><\/div><\/section>/, "the crew section is its heading and the editor's mount");
  assert.doesNotMatch(html, /data-settings-orchestrates|data-settings-model|data-settings-advisor|data-settings-crew/, "no old seat rows, no old Change row");
  assert.equal(calls.length, 1, "the crew editor is drawn by exactly one call per Settings draw");
  assert.equal(calls[0].el, mount, "into the crew section's mount");
  assert.deepEqual(plain(Object.keys(calls[0].context).sort()), ["dock", "modelLine", "openAdvisor", "openModel", "seatLocked", "send", "state", "tab"]);
  assert.equal(calls[0].context.tab.id, "t1");
  assert.equal(calls[0].context.state.clis.length, CLIS.length);
  assert.equal(calls[0].context.dock, h.node("setFoot"), "its Save bar goes in the strip under the Settings body");
  assert.equal(calls[0].context.modelLine("claude", "claude-opus-5-5[1m]", "high"), "Opus 5.5 · high", "one model name for the whole page, never the raw id");
  assert.equal(typeof calls[0].context.send, "function");
});

test("pack 18: the approved card claims a look only for a setup with a look step", () => {
  const h = pageHarness();
  for (const hasLook of [false, true]) {
    const message = h.state({ steps: hasLook ? [{ id: "look", type: "look", owners: ["user"] }] : [], processState: { approval: { state: "approved" } }, derived: { approvedCardLine: "Round 1 is ready." } });
    h.api.onMessage(message);
    const html = h.api.real.lookCard(message.projects[0].tabs[0]);
    assert.ok(html.includes(hasLook ? "Look approved" : "Review rounds"));
    assert.equal(html.includes("Look approved"), hasLook);
    assert.ok(html.includes("Round 1 is ready."));
  }
});

test("pack 18: the waiting line says Approved only for a setup with a look step", () => {
  const h = pageHarness();
  const crew = p18Crew();
  const bar = [{ stepId: "qa", type: "rounds", state: "current", label: "QA", owners: ["reviewer1"] }];
  for (const hasLook of [false, true]) {
    const message: any = h.state({ crew, steps: hasLook ? [{ id: "look", type: "look", owners: ["user"] }] : [], derived: { stepBar: bar, busy: false, approvedCardLine: "Waiting for Sage to finish." }, processState: { approval: { state: "approved" }, phase: "review", round: 2 } }, { clis: CLIS });
    h.api.onMessage(message);
    const html = h.api.real.stepActions(message.projects[0].tabs[0]);
    assert.ok(html.includes("Review round 2 starts when"), html);
    assert.equal(html.includes("Approved. "), hasLook, html);
  }
});

test("FF3 app: same-name useSetup survives unchanged state and reconnect, then settles on a new generation", async () => {
  const h = pageHarness(); h.api.setLayers();
  const seat = (slot: string) => ({ slot, name: slot, cli: "claude", model: "m", effort: "low", canWrite: false, isLeader: slot === "leader", role: slot });
  const crew = ["leader", "coder", "reviewer1"].map(seat); crew[1].role = "Custom coder";
  const template = { id: "same", name: "Same", kind: "dev", desc: "Same crew", crew: ["leader", "coder", "reviewer1"].map(seat), steps: [] };
  const state = (generation: string) => h.state({ crew, setupName: "Same", processState: { crewGenerationId: generation } }, { clis: CLIS, templates: [template], savedSetups: [] });
  h.api.onMessage(state("before")); let socket = await h.open();
  // the real menu pick: the same name with a customised crew is still a switch, and the pick records the generation
  const wired = wireNode(h.node("setupPop"));
  h.api.real.processMenu(state("before").projects[0].tabs[0], h.node("setupsBtn"));
  wired.find("useTemplate", "same").click();
  heldTimer(h.timers).fn();
  assert.equal(socket.sent.filter((m: any) => m.type === "useSetup").length, 1);
  h.api.onMessage(state("before"));
  assert.equal(h.api.snap().pendingActions.size, 1, "FF3 app: same name with unchanged generation stays pending");
  socket.close(); socket = await h.open(); h.api.onMessage(state("before"));
  assert.equal(socket.sent.filter((m: any) => m.type === "useSetup").length, 1, "unchanged generation after reconnect resends the switch");
  h.api.onMessage(state("after")); assert.equal(h.api.snap().pendingActions.size, 0);
});
