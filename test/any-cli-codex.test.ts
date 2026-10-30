import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { LEADER_START_TIMEOUT_MS } from "../server/leader-common.ts";
import * as path from "node:path";
import { SERVER_START_MS } from "./server-start.ts";
import { LIST_TIMEOUT_MS } from "../server/leader-common/types.ts";
import { codexPolicy, SEATS, LEADER, WORKER, TAB, CODEX_LEADER, sleep, NO_FAKE_CLI_ALIVE_MS, withServer, script } from "./any-cli-helpers.ts";

// ---- Codex leader ----

test("real server: live chat messages carry a unique increasing revision and no id, across two turns in one tab", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const first = h.chat(script({ say: "First answer." }));
    await h.wait(() => h.turnEnded(first).length === 1, "first turn done");
    const second = h.chat(script({ say: "Second answer." }));
    await h.wait(() => h.turnEnded(second).length === 1, "second turn done");
    const live = h.messages.filter((m) => m.type === "chatMessage");
    assert.deepEqual(live.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.ok(live.every((m) => !("id" in m)), "the server sends no message id, so the page must not key on one");
    assert.ok(live.every((m, i) => Number.isSafeInteger(m.revision) && (i === 0 || m.revision > live[i - 1].revision)), `revisions ${live.map((m) => m.revision)} increase`);
    assert.deepEqual(live.filter((m) => m.role === "assistant").map((m) => m.text), ["First answer.", "Second answer."]);
  });
});

test("Codex leader: deltas reach chatDelta, reasoning does not, the turn ends once, usage fills the meter", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const start = h.chat(script({ reasoning: "SECRET THOUGHT" }, { say: "Hello from Codex." }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.deltas(start), "Hello from Codex.", "only the answer text is forwarded");
    const assistant = h.messages.slice(start).find((m) => m.type === "chatMessage" && m.role === "assistant");
    assert.equal(assistant.text, "Hello from Codex.");
    const usage = h.tab().leaderUsage;
    assert.deepEqual([usage.modelId, usage.contextTokens, usage.contextWindow, usage.costUsd], ["gpt-6-sol", 1000, 258000, null]);
    const entries = h.cliEntries();
    const thread = entries.find((e) => e.method === "thread/start").params;
    assert.deepEqual(thread.dynamicTools.map((t: any) => t.name).sort(), ["get_crew_status", "launch_seat", "list_requests", "send_request"]);
    assert.equal(thread.dynamicTools.find((t: any) => t.name === "launch_seat").inputSchema.properties.slot.type, "string");
    assert.equal(thread.cwd, h.work);
    const turn = entries.find((e) => e.method === "turn/start").params;
    assert.deepEqual([turn.model, turn.effort, turn.approvalPolicy], ["gpt-6-sol", "high", "on-request"]);
    assert.equal(turn.sandboxPolicy.type, "workspaceWrite");
  });
});

test("Codex leader: permission modes map to approval policy and sandbox on the next turn", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const policies: any[] = [];
    for (const mode of ["ask", "plan", "bypass", "accept"]) {
      await h.action({ type: "setPermissionMode", tabId: TAB, mode, confirm: true });
      const start = h.chat(mode); await h.wait(() => h.turnEnded(start).length === 1, `${mode} turn`); await h.idle();
      const turn = h.cliEntries().filter((e) => e.method === "turn/start").at(-1).params;
      policies.push([turn.approvalPolicy, turn.sandboxPolicy.type]);
    }
    assert.deepEqual(policies, [["untrusted", "workspaceWrite"], ["on-request", "readOnly"], ["never", "dangerFullAccess"], ["on-request", "workspaceWrite"]]);
    assert.deepEqual(codexPolicy("ask", "C:/x").approvalPolicy, "untrusted");
  });
});

test("Codex leader: crew tools go through the same gate, and a tool failure is a failed result", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ tool: "get_crew_status" }));
    await h.wait(() => h.turnEnded(start).length === 1, "status turn"); await h.idle();
    const crew = JSON.parse(h.deltas(start).replace(/^\[tool ok: /, "").replace(/\]$/, ""));
    assert.equal(crew.tab, TAB); assert.equal(crew.crew.length, SEATS.length);
    // Plan mode: launch_seat on a seat that can write is refused by the existing gate.
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "plan", confirm: true });
    start = h.chat(script({ tool: "launch_seat", args: { slot: WORKER.slotId, brief: "write a file" } }));
    await h.wait(() => h.turnEnded(start).length === 1, "plan launch turn"); await h.idle();
    assert.match(h.deltas(start), /\[tool failed: launch failed: this tab is in Plan mode/);
    // Ask mode: the launch asks the browser first; denying it launches nothing.
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask", confirm: true });
    start = h.chat(script({ tool: "launch_seat", args: { slot: WORKER.slotId, brief: "write a file" } }));
    await h.wait(() => h.pending().length === 1, "launch asks");
    assert.match(h.pending()[0].tool, /^launch:/);
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.turnEnded(start).length === 1, "denied launch turn"); await h.idle();
    assert.match(h.deltas(start), /\[tool failed: launch failed: The user denied this\./);
    assert.equal(h.tab().runs.length, 0, "nothing was launched");
    // Invalid arguments fail the call instead of throwing.
    start = h.chat(script({ tool: "launch_seat", args: { slot: 5 } }));
    await h.wait(() => h.turnEnded(start).length === 1, "invalid args turn");
    assert.match(h.deltas(start), /\[tool failed: invalid arguments for launch_seat/);
  });
});

test("Codex leader: command and file approvals reach the browser; Allow and Deny reach the CLI", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    let start = h.chat(script({ command: "rm -rf build" }, { command: "echo ok" }, { fileChange: "two" }));
    await h.wait(() => h.pending().length === 1, "command approval");
    assert.equal(h.pending()[0].tool, "Bash"); assert.match(h.pending()[0].summary, /rm -rf build/);
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.pending().length === 1 && /echo ok/.test(h.pending()[0].summary), "second command approval");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.pending().length === 1 && h.pending()[0].tool === "Edit", "file approval");
    const fileSummary = h.pending()[0].summary;
    assert.ok(fileSummary.startsWith("C:/work/a.txt\nC:/work/b.txt\n\n"), "every changed path, one per line");
    assert.match(fileSummary, /SECOND-FILE-TEXT/, "the second file's change text is shown");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.deltas(start), "[command accept][command decline][file accept]");
    const decisions = h.cliEntries().filter((e) => e.response >= 1000).map((e) => e.result.decision);
    assert.deepEqual(decisions, ["accept", "decline", "accept"], "the CLI saw exactly what the browser answered");
  });
});

test("Codex leader: requests with no screen are refused and the turn goes on", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const start = h.chat(script({ unknownRequest: "item/tool/requestUserInput" }, { unknownRequest: "mcpServer/elicitation/request" }, { unknownRequest: "weird/new/request" }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    const text = h.deltas(start);
    assert.match(text, /requestUserInput -> \{"answers":\{\}\}/);
    assert.match(text, /elicitation\/request -> \{"action":"decline"/);
    assert.match(text, /weird\/new\/request -> \{"code":-32601/);
  });
});

test("Codex leader: every failure path ends the turn exactly once", { timeout: 90000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    for (const [label, steps, expected] of [
      ["error notification", [{ error: "boom from codex" }], /boom from codex/],
      ["turn failed status", [{ status: "failed" }], /leader turn failed/],
      ["turn interrupted status", [{ status: "interrupted" }], /leader turn interrupted/],
    ] as const) {
      const start = h.chat(script(...steps));
      await h.wait(() => h.turnEnded(start).length >= 1, label); await h.idle(); await sleep(100);
      const ended = h.turnEnded(start);
      assert.equal(ended.length, 1, `${label}: exactly one end`); assert.equal(ended[0].type, "chatError"); assert.match(ended[0].message, expected);
    }
    // A retrying error is not the end.
    let start = h.chat(script({ retryError: "transient" }, { say: "recovered" }));
    await h.wait(() => h.turnEnded(start).length === 1, "retry turn"); assert.equal(h.turnEnded(start)[0].type, "chatDone"); await h.idle();
    // The child dying mid-turn ends the turn once; the next message starts a fresh leader.
    start = h.chat(script({ exit: true }));
    await h.wait(() => h.turnEnded(start).length >= 1, "exit turn"); await sleep(300);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError");
    assert.equal(h.tab().derived.leaderTurnActive, false, "no turn stays Working after its leader is gone");
    await h.wait(() => h.tab().leaderStatus === "dead", "leader dead");
    start = h.chat("alive again"); await h.wait(() => h.turnEnded(start).length === 1, "fresh leader turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    // Every failed turn retires its leader (error, failed, interrupted, then the exit): five children in all.
    assert.equal(h.cliEntries().filter((e) => e.started).length, 5);
  });
});

test("Codex leader: a CLI that never answers fails the turn at the start deadline and the child is killed", { timeout: SERVER_START_MS + NO_FAKE_CLI_ALIVE_MS + LIST_TIMEOUT_MS + 30_000 }, async () => {
  await withServer({ leader: CODEX_LEADER, env: { FAKE_CODEX_NEVER_ANSWER: "1", CC_TEST_LEADER_START_TIMEOUT_MS: "600" } }, async (h) => {
    const start = h.chat("anyone there");
    await h.wait(() => h.turnEnded(start).length >= 1, "start deadline");
    const ended = h.turnEnded(start);
    assert.equal(ended.length, 1); assert.equal(ended[0].type, "chatError"); assert.match(ended[0].message, new RegExp(`did not start within ${LEADER_START_TIMEOUT_MS / 1000} seconds`));
    await h.wait(() => h.tab().leaderStatus === "dead", "leader dead");
    await h.noFakeCliAlive(); // by command line: the deadline can kill the fake before it logs "started"
    for (const entry of h.cliEntries().filter((e) => e.started)) await h.wait(() => !h.pidAlive(entry.pid), "child killed");
  });
});

test("Codex leader: Stop answers every open request, denies the approval and kills the child", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ command: "rm -rf /" }));
    await h.wait(() => h.pending().length === 1, "approval pending");
    const pid = h.cliEntries().find((e) => e.started).pid;
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.pending().length === 0, "approval removed");
    await h.wait(() => h.turnEnded(start).some((m) => m.type === "chatError"), "turn stopped");
    // The CLI got a decline for its request (not silence) and an interrupt for the turn, before the kill.
    await h.wait(() => h.cliEntries().some((e) => e.response >= 1000 && e.result?.decision === "decline"), "decline written");
    assert.ok(h.cliEntries().some((e) => e.method === "turn/interrupt"), "the turn was interrupted");
    await h.wait(() => !h.pidAlive(pid), "child killed");
    assert.equal(h.tab().derived.leaderTurnActive, false);
  });
});
