import test from "node:test";
import assert from "node:assert/strict";
import { LEADER, WORKER, TAB, CODEX_LEADER, CLAUDE_LEADER, withServer, script } from "./any-cli-helpers.ts";

// ---- a fixed-crew assignment changes the CLI ----

const CODEX_WORKER = { cli: "codex", model: "gpt-6-sol", effort: "high" };

test("assignment cli: a CLI that was not checked yet is refused", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, unknown: ["codex"] }, async (h) => {
    assert.equal(h.state().settings.tools.codex.installed, null);
    const reply = await h.assign(WORKER.slotId, CODEX_WORKER);
    assert.equal(reply.type, "error"); assert.match(reply.message, /This CLI is unavailable\. Refresh installed tools first/);
    assert.equal(h.seat(WORKER.slotId).cli, WORKER.cli);
    assert.equal(h.savedSeat(WORKER.slotId).cli, WORKER.cli, "nothing was saved");
  });
});

test("assignment cli: refused unless installed, then needs a model valid for the NEW cli and an effort that exists there, then persists", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["codex"] }, async (h) => {
    await h.refresh();
    assert.equal(h.state().settings.tools.codex.installed, true, "the client receives installed per CLI");
    assert.equal(h.state().settings.tools.opencode.installed, false);
    const saved = h.savedSeat(WORKER.slotId);
    const refusals: Array<[object, RegExp]> = [
      [{ cli: "opencode", model: "opencode/claude-sonnet-5", effort: "max" }, /This CLI is unavailable/],
      [{ cli: "gemini", model: "gemini-2", effort: "high" }, /Invalid crew assignment/],
      [{ cli: "codex", model: WORKER.model, effort: "high" }, /Invalid crew model/],
      [{ cli: "codex", effort: "high" }, /Invalid crew assignment/],
      [{ cli: "codex", model: "gpt-6-sol", effort: "turbo" }, /Unknown crew effort/],
    ];
    for (const [assignment, message] of refusals) {
      const reply = await h.assign(WORKER.slotId, assignment);
      assert.equal(reply.type, "error", JSON.stringify(assignment)); assert.match(reply.message, message, JSON.stringify(assignment));
    }
    assert.deepEqual(h.savedSeat(WORKER.slotId), saved, "every refusal left the saved seat alone");
    assert.equal(h.seat(WORKER.slotId).cli, WORKER.cli);
    const reply = await h.assign(WORKER.slotId, CODEX_WORKER);
    assert.equal(reply.type, "actionResult");
    assert.deepEqual([h.seat(WORKER.slotId).cli, h.seat(WORKER.slotId).model, h.seat(WORKER.slotId).effort], ["codex", "gpt-6-sol", "high"]);
    assert.deepEqual(h.savedSeat(WORKER.slotId), CODEX_WORKER);
  });
});

test("assignment cli: the effort is the user's pick, and one that does not exist on the new CLI is refused instead of replaced", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["opencode"] }, async (h) => {
    await h.refresh();
    const before = h.savedSeat(WORKER.slotId);
    // OpenCode offers only "max" in this server; the Claude seat's own effort is not carried over, no default is substituted.
    const refused = await h.assign(WORKER.slotId, { cli: "opencode", model: "opencode/glm-5.2", effort: WORKER.effort });
    assert.equal(refused.type, "error"); assert.match(refused.message, /Unknown crew effort/);
    assert.deepEqual(h.savedSeat(WORKER.slotId), before, "the seat kept its saved assignment");
    assert.equal((await h.assign(WORKER.slotId, { cli: "opencode", model: "opencode/glm-5.2", effort: "max" })).type, "actionResult");
    assert.deepEqual(h.savedSeat(WORKER.slotId), { cli: "opencode", model: "opencode/glm-5.2", effort: "max" });
  });
});

const CODEX_SWITCH = { cli: "codex", model: "gpt-6-sol", effort: "high" };

test("leader assignment cli: refused while a reply or an approval is open, then the next message starts the new CLI", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["codex"], env: { CC_TEST_FAKE_LEADER: "1" } }, async (h) => {
    await h.refresh();
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(JSON.stringify([{ tool: "Write", input: { file_path: "C:/w/f.ts", content: "x" } }]));
    await h.wait(() => h.pending().length === 1, "approval waiting");
    const reply = await h.assign(LEADER.slotId, CODEX_SWITCH);
    assert.equal(reply.type, "error"); assert.match(reply.message, /Finish the leader's current reply before changing its CLI or instructions/);
    assert.equal(h.seat(LEADER.slotId).cli, "claude");
    assert.equal(h.savedSeat(LEADER.slotId).cli, "claude", "nothing was saved");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done"); await h.idle();
    assert.equal(h.tab().leaderStatus, "ready");
    const chatBefore = h.messages.filter((m) => m.type === "chatMessage").length;
    assert.equal((await h.assign(LEADER.slotId, CODEX_SWITCH)).type, "actionResult");
    assert.equal(h.seat(LEADER.slotId).cli, "codex");
    assert.equal(h.tab().leaderStatus, "ready", "the saved choice does not end the idle session: the next message does");
    assert.equal(h.messages.filter((m) => m.type === "chatMessage").length, chatBefore, "the chat log is kept");
    // The next message sees the changed fixed signature and starts the leader on Codex.
    const next = h.chat("hello after the switch");
    await h.wait(() => h.turnEnded(next).length === 1, "codex turn"); assert.equal(h.turnEnded(next)[0].type, "chatDone");
    assert.match(h.deltas(next), /codex says hi/);
    // The new leader reads the saved handover first, like after a mode-change restart (its text follows the fixed-crew wrapper).
    assert.match(h.cliEntries().find((e) => e.method === "turn/start").params.input[0].text, /Current message:\nBefore replying, first read the existing handover at .*RESUME\.md/);
  });
});

test("leader assignment cli: refused while only a turn is open, and a model or effort change is saved without ending that reply", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, installed: ["opencode", "codex"] }, async (h) => {
    await h.refresh();
    const start = h.chat(script({ sleep: 1500 }, { say: "slow" }));
    await h.wait(() => h.tab().derived.leaderTurnActive, "turn running");
    assert.equal(h.pending().length, 0, "no approval is open");
    const reply = await h.assign(LEADER.slotId, { cli: "opencode", model: "opencode/glm-5.2", effort: "max" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /Finish the leader's current reply before changing its CLI or instructions/);
    assert.equal(h.seat(LEADER.slotId).cli, "codex");
    assert.equal((await h.assign(LEADER.slotId, { ...CODEX_LEADER, effort: "low" })).type, "actionResult", "the same CLI with another effort is saved mid-reply");
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.turnEnded(start)[0].type, "chatDone", "the running reply was not ended by the change");
    assert.match(h.deltas(start), /slow/);
  });
});

test("leader assignment cli: refused while only an approval is open", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, installed: ["opencode"] }, async (h) => {
    await h.refresh();
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ commandNoWait: "rm -rf left-open" }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn done with the request still open");
    await h.wait(() => h.pending().length === 1, "approval waiting"); await h.idle();
    assert.equal(h.tab().derived.leaderTurnActive, false, "no turn is open");
    const reply = await h.assign(LEADER.slotId, { cli: "opencode", model: "opencode/glm-5.2", effort: "max" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /Finish the leader's current reply before changing its CLI or instructions/);
    assert.equal(h.seat(LEADER.slotId).cli, "codex");
  });
});

test("leader assignment effort on a Codex leader takes effect through the next fixed session", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, installed: ["codex"] }, async (h) => {
    await h.refresh();
    let start = h.chat("first"); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    assert.equal((await h.assign(LEADER.slotId, { ...CODEX_LEADER, effort: "low" })).type, "actionResult");
    start = h.chat("second"); await h.wait(() => h.turnEnded(start).length === 1, "second turn"); await h.idle();
    // The model and the effort in one assignment: both reach the next session.
    assert.equal((await h.assign(LEADER.slotId, { ...CODEX_LEADER, model: "gpt-6-astra", effort: "max" })).type, "actionResult");
    start = h.chat("third"); await h.wait(() => h.turnEnded(start).length === 1, "third turn");
    assert.deepEqual(h.cliEntries().filter((e) => e.method === "turn/start").map((t) => [t.params.model, t.params.effort]), [["gpt-6-sol", "high"], ["gpt-6-sol", "low"], ["gpt-6-astra", "max"]]);
    assert.equal(h.cliEntries().filter((e) => e.method === "thread/start").length, 3, "each changed fixed signature starts its own session");
  });
});

test("leader assignment model on a Codex leader takes effect through the next fixed session", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, installed: ["codex"] }, async (h) => {
    await h.refresh();
    let start = h.chat("first"); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    assert.equal((await h.assign(LEADER.slotId, { ...CODEX_LEADER, model: "gpt-6-astra" })).type, "actionResult");
    start = h.chat("second"); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    const turns = h.cliEntries().filter((e) => e.method === "turn/start");
    assert.deepEqual(turns.map((t) => t.params.model), ["gpt-6-sol", "gpt-6-astra"]);
    assert.equal(h.cliEntries().filter((e) => e.method === "thread/start").length, 2, "the changed model starts a new session");
  });
});
