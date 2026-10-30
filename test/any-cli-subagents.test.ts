import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { config, TAB, CODEX_LEADER, OPENCODE_LEADER, withServer, script } from "./any-cli-helpers.ts";

// ---- fix pack 2, block 2: OpenCode sub-agents, the port, secrets in streamed text, bounded memory, stale Codex file changes ----

test("OpenCode leader: a sub-agent's requests are answered by the tab's mode; a session that is not the leader's is ignored", { timeout: 90000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    // Accept mode: edits and plain reads pass without a card; a shell command and a .env read ask, wherever in the tree of sub-agents they come from.
    const start = h.chat(script({ childEdit: true }, { childRead: "C:/work/a.txt" }, { childBash: "npm test" }, { childRead: "C:/work/.env" }, { foreignBash: "evil" }, { grandBash: "npm run build" }, { childQuestion: true }, { say: "done" }));
    await h.wait(() => h.pending().length === 1, "the shell command asks");
    assert.equal(h.pending()[0].tool, "Bash"); assert.equal(h.pending()[0].summary, "npm test");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.pending().length === 1 && h.pending()[0].tool === "read", "the .env read asks");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.pending().length === 1 && /npm run build/.test(h.pending()[0].summary), "the grandchild's shell command asks");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.deltas(start), "[child edit once][child read C:/work/a.txt once][child bash once][child read C:/work/.env reject][foreign sent][grand bash once]done");
    const entries = h.cliEntries();
    assert.equal(entries.filter((e) => e.method === "POST" && /^\/question\/que_\d+\/reject$/.test(e.path ?? "")).length, 1, "the sub-agent's question was rejected");
    assert.equal(entries.filter((e) => /per_foreign/.test(e.path ?? "")).length, 0, "a session that is not under the leader's is never answered");
  });
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "plan", confirm: true });
    const start = h.chat(script({ childEdit: true }, { childRead: "C:/work/a.txt" }, { say: "x" }));
    await h.wait(() => h.turnEnded(start).length === 1, "plan turn");
    assert.equal(h.deltas(start), "[child edit reject][child read C:/work/a.txt once]x", "Plan: a sub-agent's edit is refused without a card, looking is free");
    assert.equal(h.pending().length, 0);
  });
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ childEdit: true }, { say: "y" }));
    await h.wait(() => h.pending().length === 1, "Ask: the sub-agent's edit asks");
    assert.equal(h.pending()[0].tool, "Edit");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "ask turn");
    assert.equal(h.deltas(start), "[child edit once]y");
  });
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "bypass", confirm: true });
    const start = h.chat(script({ childBash: "anything" }, { say: "z" }));
    await h.wait(() => h.turnEnded(start).length === 1, "bypass turn");
    assert.equal(h.deltas(start), "[child bash once]z", "Bypass: nothing asks");
  });
});

test("OpenCode leader: the server gets a baseline that makes sub-agents ask, and OpenCode picks its own port", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat("hello"); await h.wait(() => h.turnEnded(start).length === 1, "turn");
    const started = h.cliEntries().find((e) => e.started);
    const config = JSON.parse(started.config);
    assert.equal(config.permission["*"], "ask");
    assert.equal(config.permission["tab-crew_*"], "allow");
    assert.equal(config.permission.read["*.env"], "ask");
    assert.deepEqual(started.args.slice(started.args.indexOf("--port"), started.args.indexOf("--port") + 2), ["--port", "0"], "no port is probed and reused: OpenCode binds one itself and says which");
    assert.ok(h.cliEntries().filter((e) => e.path).every((e) => e.authorized === true), "and every call reached the server that was started");
  });
});

test("OpenCode leader: streamed text never carries the server password or the bridge token, even when a secret is split across deltas", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ say: "start " }, { leakDelta: true }, { say: " tail" }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn");
    const mcp = h.cliEntries().find((e) => e.path === "/mcp");
    const token = mcp.body.config.headers.Authorization.slice("Bearer ".length);
    const text = h.deltas(start);
    assert.equal(text, "start before [hidden] between [hidden] after tail", `the secrets are gone and nothing else was lost: ${text}`);
    assert.equal(JSON.stringify(h.messages).includes(token), false);
  });
});

test("OpenCode leader: a failed provider read is tried again on the next turn instead of leaving the window unknown", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_PROVIDERS_FAIL_ONCE: "1" } }, async (h) => {
    let start = h.chat("one"); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    assert.equal(h.tab().leaderUsage.contextWindow, null, "the failed read leaves this turn's window unknown");
    start = h.chat("two"); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.equal(h.tab().leaderUsage.contextWindow, 200000, "the next turn read it again");
    assert.equal(h.cliEntries().filter((e) => e.path === "/config/providers").length, 2);
  });
});

test("OpenCode leader: per-message memory is bounded (the oldest parts and message ids are forgotten, the newest kept)", { timeout: 90000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ flood: 4300 }, { say: "end" }));
    await h.wait(() => h.turnEnded(start).length === 1, "flood turn", 30000);
    // "end" is said in another text part than [NEWEST]: pack 14 puts a paragraph break between separate parts.
    assert.equal(h.deltas(start), "[NEWEST]\n\nend", "the oldest part id was forgotten, the newest is still known");
  });
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ floodMessages: 4100 }));
    await h.wait(() => h.turnEnded(start).length === 1, "message flood turn", 30000);
    const cost = h.tab().leaderUsage.costUsd;
    assert.ok(Math.abs(cost - (4100 * 0.001 + 0.001 + 0.25)) < 1e-6, `the evicted first message is counted again, the kept last one is not: ${cost}`);
  });
});

test("Codex leader: an approval never shows the file changes of an earlier turn", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    let start = h.chat(script({ fileChange: "two" }));
    await h.wait(() => h.pending().length === 1 && h.pending()[0].tool === "Edit", "file approval, first turn");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "first turn done"); await h.idle();
    start = h.chat(script({ raw: { method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "$turn", itemId: "f1", reason: "again" } } }));
    await h.wait(() => h.pending().length === 1, "second approval");
    assert.doesNotMatch(h.pending()[0].summary, /a\.txt|SECOND-FILE-TEXT/, "item f1 belonged to the first turn; its changes are gone");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.turnEnded(start).length === 1, "second turn done");
  });
});
