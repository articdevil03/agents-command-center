import test from "node:test";
import assert from "node:assert/strict";
import { LEADER, WORKER, TAB, CODEX_LEADER, CLAUDE_LEADER, sleep, withServer, script } from "./any-cli-helpers.ts";

// ---- updateSeat.cli ----

test("updateSeat cli: a CLI that was not checked yet is refused", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, unknown: ["codex"] }, async (h) => {
    assert.equal(h.state().settings.tools.codex.installed, null);
    const reply = await h.update({ slot: WORKER.slotId, cli: "codex", model: "gpt-6-sol" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /has not been checked yet/);
    assert.equal(h.seat(WORKER.slotId).cli, WORKER.cli);
  });
});

test("updateSeat cli: refused unless installed, then needs a model valid for the NEW cli, then persists like model", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["codex"] }, async (h) => {
    await h.refresh();
    assert.equal(h.state().settings.tools.codex.installed, true, "the client receives installed per CLI");
    assert.equal(h.state().settings.tools.opencode.installed, false);
    let reply = await h.update({ slot: WORKER.slotId, cli: "opencode", model: "opencode/claude-sonnet-5" });
    assert.match(reply.message, /not installed/);
    reply = await h.update({ slot: WORKER.slotId, cli: "gemini", model: "gemini-2" });
    assert.match(reply.message, /unknown CLI/);
    reply = await h.update({ slot: WORKER.slotId, cli: "codex", model: WORKER.model });
    assert.match(reply.message, /valid codex model is required/);
    reply = await h.update({ slot: WORKER.slotId, cli: "codex" });
    assert.match(reply.message, /valid codex model is required/);
    assert.equal(h.seat(WORKER.slotId).cli, WORKER.cli, "every refusal left the seat alone");
    await h.update({ slot: WORKER.slotId, effort: "high" }, () => h.seat(WORKER.slotId).effort === "high");
    reply = await h.update({ slot: WORKER.slotId, cli: "codex", model: "gpt-6-sol" }, () => h.seat(WORKER.slotId).cli === "codex");
    assert.equal(reply.type, "ok");
    assert.deepEqual([h.seat(WORKER.slotId).model, h.seat(WORKER.slotId).effort], ["gpt-6-sol", "high"], "effort kept: it exists on Codex");
    const saved = h.savedCrew().find((s) => s.slot === WORKER.slotId);
    assert.deepEqual([saved.cli, saved.model, saved.effort], ["codex", "gpt-6-sol", "high"]);
  });
});

test("updateSeat cli: an effort that does not exist on the new CLI falls back to that CLI's default", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["codex", "claude"] }, async (h) => {
    await h.refresh();
    await h.update({ slot: WORKER.slotId, effort: "xhigh" }, () => h.seat(WORKER.slotId).effort === "xhigh");
    await h.update({ slot: WORKER.slotId, cli: "codex", model: "gpt-6-sol" }, () => h.seat(WORKER.slotId).cli === "codex");
    assert.equal(h.seat(WORKER.slotId).effort, "medium", "xhigh is not a Codex effort: the CLI default is used");
    assert.equal(h.savedCrew().find((s) => s.slot === WORKER.slotId).effort, "medium");
  });
});

test("updateSeat cli on the leader: refused while a turn or an approval is open, then ends the session like Stop", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["codex"], env: { CC_TEST_FAKE_LEADER: "1" } }, async (h) => {
    await h.refresh();
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(JSON.stringify([{ tool: "Write", input: { file_path: "C:/w/f.ts", content: "x" } }]));
    await h.wait(() => h.pending().length === 1, "approval waiting");
    const reply = await h.update({ slot: LEADER.slotId, cli: "codex", model: "gpt-6-sol" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /Finish or stop .*'s current turn first/);
    assert.equal(h.seat(LEADER.slotId).cli, "claude");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done"); await h.idle();
    assert.equal(h.tab().leaderStatus, "ready");
    const chatBefore = h.messages.filter((m) => m.type === "chatMessage").length;
    await h.update({ slot: LEADER.slotId, cli: "codex", model: "gpt-6-sol" }, () => h.seat(LEADER.slotId).cli === "codex");
    assert.equal(h.tab().leaderStatus, "not-started", "the Claude session ended");
    assert.equal(h.messages.filter((m) => m.type === "chatMessage").length, chatBefore, "the chat log is kept");
    // The next message starts the leader on Codex.
    const next = h.chat("hello after the switch");
    await h.wait(() => h.turnEnded(next).length === 1, "codex turn"); assert.equal(h.turnEnded(next)[0].type, "chatDone");
    assert.match(h.deltas(next), /codex says hi/);
    // The new leader reads the saved handover first, like after a mode-change restart.
    assert.match(h.cliEntries().find((e) => e.method === "turn/start").params.input[0].text, /^Before replying, first read the existing handover at .*RESUME\.md/);
  });
});

test("updateSeat cli on the leader: refused while only a turn is open", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, installed: ["opencode"] }, async (h) => {
    await h.refresh();
    const start = h.chat(script({ sleep: 1500 }, { say: "slow" }));
    await h.wait(() => h.tab().derived.leaderTurnActive, "turn running");
    assert.equal(h.pending().length, 0, "no approval is open");
    const reply = await h.update({ slot: LEADER.slotId, cli: "opencode", model: "opencode/glm-5.2" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /Finish or stop .*'s current turn first/);
    assert.equal(h.seat(LEADER.slotId).cli, "codex");
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
  });
});

test("updateSeat cli on the leader: refused while only an approval is open", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, installed: ["opencode"] }, async (h) => {
    await h.refresh();
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ commandNoWait: "rm -rf left-open" }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn done with the request still open");
    await h.wait(() => h.pending().length === 1, "approval waiting"); await h.idle();
    assert.equal(h.tab().derived.leaderTurnActive, false, "no turn is open");
    const reply = await h.update({ slot: LEADER.slotId, cli: "opencode", model: "opencode/glm-5.2" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /Finish or stop .*'s current turn first/);
    assert.equal(h.seat(LEADER.slotId).cli, "codex");
  });
});

test("updateSeat effort on a live Codex leader applies from the next turn", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat("first"); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    await h.update({ slot: LEADER.slotId, effort: "low" }, () => h.seat(LEADER.slotId).effort === "low");
    start = h.chat("second"); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    // Model and effort in one message take the other branch (the model applies first): effort must still follow.
    await h.update({ slot: LEADER.slotId, model: "gpt-6-astra", effort: "max" }, () => h.seat(LEADER.slotId).effort === "max");
    start = h.chat("third"); await h.wait(() => h.turnEnded(start).length === 1, "third turn");
    assert.deepEqual(h.cliEntries().filter((e) => e.method === "turn/start").map((t) => [t.params.model, t.params.effort]), [["gpt-6-sol", "high"], ["gpt-6-sol", "low"], ["gpt-6-astra", "max"]]);
  });
});

test("updateSeat model on a live Codex leader applies from the next turn", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat("first"); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    await h.update({ slot: LEADER.slotId, model: "gpt-6-astra" }, () => h.seat(LEADER.slotId).model === "gpt-6-astra");
    start = h.chat("second"); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    const turns = h.cliEntries().filter((e) => e.method === "turn/start");
    assert.deepEqual(turns.map((t) => t.params.model), ["gpt-6-sol", "gpt-6-astra"]);
    assert.equal(h.cliEntries().filter((e) => e.method === "thread/start").length, 1, "the same thread, no restart");
  });
});
