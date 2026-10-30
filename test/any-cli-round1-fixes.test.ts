import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { LEADER, TAB, CODEX_LEADER, OPENCODE_LEADER, sleep, withServer, script, bridgePost, startedPids, errorsSince } from "./any-cli-helpers.ts";

test("Codex leader: the mode cannot change while a turn runs, and the chat is not stopped by the refusal", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const start = h.chat(script({ sleep: 1200 }, { say: "still going" }));
    await h.wait(() => h.tab().derived.leaderTurnActive, "turn running");
    const reply = await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /Finish or stop .*'s current turn first, then change the mode\./);
    await h.wait(() => h.turnEnded(start).length === 1, "turn done"); assert.equal(h.turnEnded(start)[0].type, "chatDone", "the refusal did not stop the chat");
    assert.equal(h.deltas(start), "still going");
    assert.equal(h.cliEntries().filter((e) => e.method === "turn/start")[0].params.approvalPolicy, "on-request", "the running turn kept its policy");
    await h.idle();
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const next = h.chat("again"); await h.wait(() => h.turnEnded(next).length === 1, "next turn");
    assert.equal(h.cliEntries().filter((e) => e.method === "turn/start").at(-1).params.approvalPolicy, "untrusted", "between turns it applies to the next turn");
  });
});

test("Codex leader: a failed turn reports once and retires the leader; the next message starts a fresh one without old deltas", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const before = h.messages.length;
    let start = h.chat(script({ say: "partial" }, { error: "boom" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "failed turn"); await sleep(500);
    assert.equal(errorsSince(h, before).length, 1, "one error, none from the later exit");
    const [oldPid] = startedPids(h);
    await h.wait(() => !h.pidAlive(oldPid), "the old child is gone");
    await h.wait(() => h.tab().leaderStatus === "dead", "leader dead");
    start = h.chat(script({ staleDelta: "OLD-TURN-TEXT" }, { say: "fresh" }));
    await h.wait(() => h.turnEnded(start).length === 1, "fresh turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone"); assert.equal(h.deltas(start), "fresh", "a delta from another turn is dropped");
    assert.equal(startedPids(h).length, 2);
  });
});

test("Codex leader: a turn/start the CLI refuses retires the leader", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, env: { FAKE_CODEX_TURN_START_FAILS: "1" } }, async (h) => {
    const start = h.chat("hello");
    await h.wait(() => h.turnEnded(start).length >= 1, "refused turn"); await sleep(300);
    assert.equal(h.turnEnded(start).length, 1); assert.match(h.turnEnded(start)[0].message, /turn start refused by fake/);
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the child is gone");
  });
});

test("Codex leader: a line that is not an object ends that leader only, the server stays up", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ raw: "null" }, { say: "never" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "odd line"); await sleep(300);
    assert.equal(h.turnEnded(start).length, 1); assert.match(h.turnEnded(start)[0].message, /could not be read/);
    assert.equal(h.child.exitCode, null, "the server is still running");
    start = h.chat("after"); await h.wait(() => h.turnEnded(start).length === 1, "fresh leader");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
  });
});

test("Codex leader: a multi-byte character split across two reads arrives whole", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const start = h.chat(script({ splitUnicode: "é😀 ok" }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.deltas(start), "é😀 ok");
  });
});

test("Codex leader: a killer that fails is reported once, a missing process is not", { timeout: 120_000 }, async () => {
  let noticeDelayMs = 0;
  for (const [code, reported] of [["1", true], ["128", false]] as const) {
    await withServer({ leader: CODEX_LEADER, env: { CC_TEST_KILLER_EXIT: code } }, async (h) => {
      const start = h.chat("hello"); await h.wait(() => h.turnEnded(start).length === 1, "turn done"); await h.idle();
      const before = h.messages.length;
      const stoppedAt = Date.now();
      h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
      const notices = () => h.messages.slice(before).filter((m) => m.type === "chatNotice" && m.tabId === TAB && /Could not confirm the old Codex leader stopped\. Check Task Manager\./.test(m.message));
      if (reported) {
        await h.wait(() => notices().length > 0, `killer exit ${code}: notice after Stop`, 20000);
        noticeDelayMs = Date.now() - stoppedAt;
        await sleep(Math.min(10_000, Math.max(1000, noticeDelayMs)));
      } else {
        // No completion signal exists for exit 128, so allow twice the measured notice delay.
        await sleep(Math.min(10_000, Math.max(3500, 2 * noticeDelayMs)));
      }
      assert.equal(notices().length, reported ? 1 : 0, `killer exit ${code}; notice after ${noticeDelayMs} ms`);
    });
  }
});

test("OpenCode leader: a failed turn reports once, retires the leader and a failed prompt does too", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const before = h.messages.length;
    let start = h.chat(script({ error: "boom" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "failed turn"); await sleep(600);
    assert.equal(errorsSince(h, before).length, 1, "one error, none from the later exit");
    const [oldPid] = startedPids(h);
    await h.wait(() => !h.pidAlive(oldPid), "the old server is gone");
    // The old session's idle can no longer complete the next turn early: the next turn runs on a fresh server.
    start = h.chat(script({ sleep: 300 }, { say: "fresh" }));
    await h.wait(() => h.turnEnded(start).length === 1, "fresh turn");
    assert.equal(h.deltas(start), "fresh"); assert.equal(startedPids(h).length, 2);
  });
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_PROMPT_FAILS: "1" } }, async (h) => {
    const start = h.chat("refused"); await h.wait(() => h.turnEnded(start).length >= 1, "failed prompt");
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the server is gone");
  });
});

test("OpenCode leader: a permission reply that fails fails the turn and retires the leader", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_REPLY_FAILS: "1" } }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ bash: "npm test" }));
    await h.wait(() => h.pending().length === 1, "bash approval");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length >= 1, "the turn failed instead of hanging");
    assert.match(h.turnEnded(start)[0].message, /could not answer an OpenCode permission request/);
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the server is gone");
  });
});

test("OpenCode leader: errors never carry the bridge token or the server password", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ error: "boom", leak: true }));
    await h.wait(() => h.turnEnded(start).length >= 1, "leaky error");
    const token = h.cliEntries().find((e) => e.path === "/mcp").body.config.headers.Authorization.slice("Bearer ".length);
    const text = JSON.stringify(h.messages);
    assert.match(h.turnEnded(start)[0].message, /boom/);
    assert.ok(!text.includes(token), "no bridge token"); assert.ok(!/[0-9a-f]{40,}/.test(h.turnEnded(start)[0].message), "no password or token");
  });
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_SESSION_FAILS: "1" } }, async (h) => {
    const start = h.chat("hello"); await h.wait(() => h.turnEnded(start).length >= 1, "setup failure");
    const message = h.turnEnded(start)[0].message;
    assert.match(message, /POST \/session returned 500/); assert.ok(!/session refused|password|[0-9a-f]{40,}/.test(message), `setup detail dropped: ${message}`);
  });
});

test("bridge: a client that drops mid-body does not take the server down", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat("start the leader"); await h.wait(() => h.turnEnded(start).length === 1, "turn"); await h.idle();
    const token = h.cliEntries().find((e) => e.path === "/mcp").body.config.headers.Authorization.slice("Bearer ".length);
    const socket = (await import("node:net")).connect(h.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(`POST /api/leader-mcp/${TAB} HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"jsonrpc":`);
    await sleep(100); socket.resetAndDestroy();
    await sleep(500);
    assert.equal(h.child.exitCode, null, "the server survived the dropped body");
    assert.ok(!h.messages.some((m) => m.type === "error" && /internal error/.test(m.message)), "no 'internal error' reached the browser: the route caught it");
    const ok = await bridgePost(h.port, `/api/leader-mcp/${TAB}`, { authorization: `Bearer ${token}` }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    assert.equal(ok.status, 200);
  });
});
