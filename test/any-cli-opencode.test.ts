import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { LEADER_START_TIMEOUT_MS } from "../server/leader-common.ts";
import * as path from "node:path";
import { SERVER_START_MS } from "./server-start.ts";
import { LIST_TIMEOUT_MS } from "../server/leader-common/types.ts";
import { opencodeRules, opencodeApprovalRequest, LEADER, WORKER, TAB, OPENCODE_LEADER, sleep, NO_FAKE_CLI_ALIVE_MS, withServer, script, bridgePost } from "./any-cli-helpers.ts";

// ---- OpenCode leader ----

test("OpenCode leader: answer text only (no reasoning, no echo of the user), one turn end, usage counted once", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ reasoning: "SECRET THOUGHT" }, { say: "Hello from OpenCode." }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.deltas(start), "Hello from OpenCode.");
    const usage = h.tab().leaderUsage;
    assert.deepEqual([usage.modelId, usage.contextTokens, usage.contextWindow, usage.costUsd], ["fakeprov/fake-model", 1000, 200000, 0.25], "the duplicated completed message is counted once");
    const entries = h.cliEntries();
    assert.ok(entries.filter((e) => e.path).every((e) => e.authorized === true), "every request carried the password");
    assert.ok(entries.filter((e) => e.path && e.path !== "/global/health").every((e) => e.directory === h.work), "every call carries the tab folder");
    assert.ok(entries.some((e) => e.bridgeInit === 200 && e.bridgeTools.length === 4), "the bridge served initialize and the four tools");
    const session = entries.find((e) => e.method === "POST" && e.path === "/session").body;
    assert.deepEqual(session.permission, opencodeRules("accept"));
    const prompt = entries.find((e) => e.path?.endsWith("/prompt_async")).body;
    assert.deepEqual(prompt.model, { providerID: "fakeprov", modelID: "fake-model" });
    // Keys from the providers payload and the bridge token never reach the browser.
    const token = entries.find((e) => e.path === "/mcp").body.config.headers.Authorization.slice("Bearer ".length);
    const everything = JSON.stringify(h.messages);
    assert.ok(!everything.includes("SECRET-KEY-MUST-NOT-LEAK") && !everything.includes(token));
  });
});

test("OpenCode leader: crew tools come through the bridge; mode changes patch the session", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    let start = h.chat(script({ tool: "get_crew_status" }));
    await h.wait(() => h.turnEnded(start).length === 1, "tool turn"); await h.idle();
    assert.match(h.deltas(start), /^\[tool ok: \{"tab":"anycli-dev","crew":\[/);
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "plan", confirm: true });
    const patch = h.cliEntries().find((e) => e.method === "PATCH");
    assert.deepEqual(patch.body.permission, opencodeRules("plan"));
    // Plan mode through the bridge: the same gate refuses a writing seat.
    start = h.chat(script({ tool: "launch_seat", args: { slot: WORKER.slotId, brief: "write" } }));
    await h.wait(() => h.turnEnded(start).length === 1, "plan launch"); await h.idle();
    assert.match(h.deltas(start), /\[tool failed: launch failed: this tab is in Plan mode/);
    // Last match wins: looking is allowed, a .env read asks again after that, the crew tools come last.
    const looking = ["*:*:ask", "read:*:allow", "glob:*:allow", "grep:*:allow", "list:*:allow", "read:*.env:ask", "read:*.env.*:ask"];
    const flat = (mode: Parameters<typeof opencodeRules>[0]) => opencodeRules(mode).map((r) => `${r.permission}:${r.pattern}:${r.action}`);
    assert.deepEqual(flat("ask"), [...looking, "tab-crew_*:*:allow"]);
    assert.deepEqual(flat("accept"), [...looking, "edit:*:allow", "tab-crew_*:*:allow"]);
    assert.deepEqual(flat("plan"), [...looking, "edit:*:deny", "tab-crew_*:*:allow"]);
    assert.equal(opencodeRules("bypass")[0].action, "allow");
  });
});

test("OpenCode leader: approvals map to Bash and Edit and Allow/Deny reach the CLI", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ bash: "npm test" }, { edit: true }, { bash: "rm x" }));
    await h.wait(() => h.pending().length === 1, "bash approval");
    assert.equal(h.pending()[0].tool, "Bash"); assert.equal(h.pending()[0].summary, "npm test");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.pending().length === 1 && h.pending()[0].tool === "Edit", "edit approval");
    assert.match(h.pending()[0].summary, /a\.txt/);
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.pending().length === 1 && /rm x/.test(h.pending()[0].summary), "second bash");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.deltas(start), "[permission once][permission reject][permission reject]");
    assert.deepEqual(opencodeApprovalRequest("webfetch", ["https://x"], { a: 1 }), { tool: "webfetch", input: { patterns: ["https://x"], a: 1 } });
  });
});

test("OpenCode leader: an Edit permission with two paths and a diff shows both paths and the diff on the approval card", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ editFull: true }));
    await h.wait(() => h.pending().length === 1, "edit approval");
    assert.equal(h.pending()[0].tool, "Edit");
    assert.equal(h.pending()[0].summary, "C:/work/a.txt\nC:/work/b.txt\n\n-OLD-LINE\n+NEW-LINE", "both paths and the whole diff reach the card");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.deltas(start), "[permission reject]");
  });
});

test("OpenCode leader: every failure path ends the turn exactly once", { timeout: 90000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    let start = h.chat(script({ error: "boom from opencode" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "session.error"); await h.idle(); await sleep(100);
    assert.equal(h.turnEnded(start).length, 1); assert.match(h.turnEnded(start)[0].message, /boom from opencode/);
    start = h.chat(script({ exit: true }));
    await h.wait(() => h.turnEnded(start).length >= 1, "exit turn"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError");
    assert.equal(h.tab().derived.leaderTurnActive, false); await h.wait(() => h.tab().leaderStatus === "dead", "leader dead");
    start = h.chat("alive again"); await h.wait(() => h.turnEnded(start).length === 1, "fresh leader");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
  });
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_PROMPT_FAILS: "1" } }, async (h) => {
    const start = h.chat("will be refused");
    await h.wait(() => h.turnEnded(start).length >= 1, "failed prompt"); await sleep(100);
    assert.equal(h.turnEnded(start).length, 1); assert.match(h.turnEnded(start)[0].message, /prompt_async returned 500: prompt refused by fake/);
  });
});

test("OpenCode leader: Stop rejects what is waiting, kills the child, and the bridge token dies", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ bash: "rm -rf /" }));
    await h.wait(() => h.pending().length === 1, "approval pending");
    const entries = h.cliEntries();
    const token = entries.find((e) => e.path === "/mcp").body.config.headers.Authorization.slice("Bearer ".length);
    const bridge = `/api/leader-mcp/${TAB}`;
    const call = (headers: Record<string, string>, body = { jsonrpc: "2.0", id: 1, method: "tools/list" }) => bridgePost(h.port, bridge, headers, JSON.stringify(body));
    assert.equal((await call({ authorization: `Bearer ${token}` })).status, 200, "alive before Stop");
    const pid = entries.find((e) => e.started).pid;
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.pending().length === 0, "approval removed");
    await h.wait(() => h.cliEntries().some((e) => e.path?.includes("/permission/") && e.body?.reply === "reject"), "reject written");
    await h.wait(() => h.cliEntries().some((e) => e.path?.endsWith("/abort")), "abort written");
    await h.wait(() => !h.pidAlive(pid), "child killed");
    assert.equal((await call({ authorization: `Bearer ${token}` })).status, 401, "the token is dead after Stop");
    assert.ok(h.turnEnded(start).some((m) => m.type === "chatError"));
  });
});

test("OpenCode leader: a server that never comes up fails the turn at the start deadline", { timeout: SERVER_START_MS + NO_FAKE_CLI_ALIVE_MS + LIST_TIMEOUT_MS + 30_000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { CC_TEST_LEADER_START_TIMEOUT_MS: "800", FAKE_OPENCODE_NEVER_UP: "1" } }, async (h) => {
    const start = h.chat("hello");
    await h.wait(() => h.turnEnded(start).length >= 1, "start deadline");
    assert.equal(h.turnEnded(start).length, 1); assert.match(h.turnEnded(start)[0].message, new RegExp(`did not start within ${LEADER_START_TIMEOUT_MS / 1000} seconds`));
    await h.wait(() => h.tab().leaderStatus === "dead", "leader dead");
    await h.noFakeCliAlive(); // by command line: the deadline can kill the fake before it logs "started"
    for (const entry of h.cliEntries().filter((e) => e.started)) await h.wait(() => !h.pidAlive(entry.pid), "child killed");
  });
});
