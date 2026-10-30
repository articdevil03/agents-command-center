import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join, resolve } from "node:path";
import { config, createCodexLeader, createOpencodeLeader, TAB, CODEX_LEADER, OPENCODE_LEADER, sleep, withServer, script, startedPids } from "./any-cli-helpers.ts";
import type { Harness } from "./any-cli-helpers.ts";

// ---- final-review fixes ----

test("OpenCode leader: an unreadable successful reply never puts a piece of the password or the bridge token in chat", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_SESSION_MALFORMED: "1" } }, async (h) => {
    const start = h.chat("hello"); await h.wait(() => h.turnEnded(start).length >= 1, "setup failure");
    const message = h.turnEnded(start)[0].message;
    assert.match(message, /POST \/session returned unreadable data/);
    const { password, token } = h.cliEntries().find((e) => e.leaked).leaked;
    const everything = JSON.stringify(h.messages.filter((m) => m.type !== "state"));
    for (const secret of [password, token]) for (let at = 0; at + 8 <= secret.length; at++) assert.ok(!everything.includes(secret.slice(at, at + 8)), `no 8 character piece of a secret at ${at}: ${message}`);
  });
});

test("OpenCode leader: a duplicate session.idle while the window is read neither ends the turn early nor completes the next turn with the old numbers", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_DUP_IDLE: "1", FAKE_OPENCODE_PROVIDERS_DELAY_MS: "700" } }, async (h) => {
    const start = h.chat("first"); await h.wait(() => h.turnEnded(start).length >= 1, "first turn"); await h.idle();
    // The duplicate idle came 50 ms after the first, while the window was still being read: it did not finish the turn with no window.
    assert.equal(h.tab().leaderUsage.contextWindow, 200000, "the turn ended on the idle that read the window");
    // Both idles for turn 1 are in; the second turn starts right away.
    const second = h.chat(script({ sleep: 1200 }, { say: "second" }));
    await h.wait(() => h.turnEnded(second).length >= 1, "second turn", 15000); await sleep(400);
    assert.equal(h.turnEnded(start).length, 2, "one completion per turn, two in all");
    assert.equal(h.turnEnded(second).length, 1, "one completion for the second turn"); assert.equal(h.turnEnded(second)[0].type, "chatDone");
    assert.equal(h.deltas(second), "second", "the second turn ended on its own idle, after its own text");
    assert.equal(h.tab().leaderUsage.contextTokens, 2000, "the second turn's own usage, not the first turn's");
  });
});

test("OpenCode leader: a turn that started while the first one's window lookup was held gets no usage or completion from the first", { timeout: 60000 }, async () => {
  // The leader driven directly: the server never starts a second turn while one is open, so the guard is only reachable here.
  const temp = mkdtempSync(join(tmpdir(), "cc-gen-"));
  const logFile = join(temp, "fake.log");
  const bridge = createHttpServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result: { tools: [] } })); }); });
  bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
  const events = { deltas: "", done: 0, usage: [] as any[], errors: [] as string[] };
  const leader = createOpencodeLeader({ model: "fakeprov/fake-model", effort: "max" }, temp, {
    onDelta: (text) => { events.deltas += text; }, onDone: () => { events.done++; }, onUsage: (u) => { events.usage.push(u); }, onError: (m) => { events.errors.push(m); },
  }, {
    bridge: { url: `http://127.0.0.1:${(bridge.address() as any).port}/mcp`, token: "bridge-token-0123456789abcdef0123456789abcdef" }, mode: "bypass", ask: async () => true, // a real token is 64 hex characters; streamed text is redacted against it
    spawnFn: (command, options) => spawn(process.execPath, [resolve("test/fake-opencode-server.mjs"), "--port", /--port (\d+)/.exec(command)![1]], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...options.env, FAKE_LEADER_LOG: logFile, FAKE_OPENCODE_PROVIDERS_DELAY_MS: "1500" } }),
  });
  const providerHits = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split(String.fromCharCode(10)).filter((line) => line.includes('"/config/providers"')).length : 0);
  const until = async (fn: () => unknown, label: string, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(20); } assert.fail(label); };
  try {
    leader.send("first");
    await until(() => providerHits() === 1, "turn 1 is waiting on its window lookup");
    // Turn 2 starts while turn 1's lookup is still held, and stays open past the moment that lookup is released.
    leader.send(script({ sleep: 3500 }, { say: "two" }));
    await sleep(2200);
    assert.deepEqual([events.done, events.usage.length], [0, 0], "turn 1's late lookup gave turn 2 no usage and no completion");
    await until(() => events.done === 1, "turn 2 ends on its own idle", 10000);
    assert.equal(events.usage.length, 1, "one usage, turn 2's own");
    assert.equal(events.usage[0].contextTokens, 2000, "the usage is turn 2's tokens, not turn 1's");
    assert.match(events.deltas, /two$/, "turn 2's text came before its completion");
    assert.deepEqual(events.errors, []);
  } finally {
    leader.stop();
    bridge.close();
    await sleep(600);
    rmSync(logFile, { force: true });
    // The stopped server may still hold the folder for a moment: retry the empty-folder removal, and say so (never silently) if it stays.
    let removeError: unknown;
    for (const end = Date.now() + 2000; Date.now() < end;) { try { rmdirSync(temp); removeError = undefined; break; } catch (error) { removeError = error; await sleep(50); } }
    if (removeError) console.warn(`could not remove the temp folder ${temp}: ${String(removeError)}`);
  }
});

test("OpenCode leader: a question is rejected, and a reject that fails retires the leader with one plain error", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ question: true }, { say: "after" })); await h.wait(() => h.turnEnded(start).length === 1, "turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.cliEntries().filter((e) => e.method === "POST" && e.path === "/question/que_1/reject").length, 1, "the reject reached OpenCode");
  });
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_QUESTION_REJECT_FAILS: "1" } }, async (h) => {
    const start = h.chat(script({ question: true }, { hang: true }));
    await h.wait(() => h.turnEnded(start).length >= 1, "the turn failed instead of waiting for ever"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError");
    assert.match(h.turnEnded(start)[0].message, /could not answer an OpenCode question \(OpenCode POST \/question\/\S+\/reject returned 500\)/);
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the server is gone");
    const next = h.chat("fresh"); await h.wait(() => h.turnEnded(next).length === 1, "next message");
    assert.equal(startedPids(h).length, 2, "the next message started a fresh leader");
  });
});

test("OpenCode leader: in Ask mode reading is not sent to the approval path, a .env read and a shell command are", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ read: "C:/work/.command-center/RESUME.md" }, { read: "C:/work/.env" }, { bash: "npm test" }));
    await h.wait(() => h.pending().length === 1, "the first approval");
    assert.equal(h.pending()[0].tool, "read", "the first thing to ask is the .env read; the plain read passed without asking");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.pending().length === 1 && h.pending()[0].tool === "Bash", "the shell command still asks");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.deltas(start), "[read C:/work/.command-center/RESUME.md auto][read C:/work/.env reject][permission once]");
  });
});

test("Codex leader: a crew-tool call that names the previous turn is refused during the next turn, which completes normally", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ staleCallNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ say: "fresh" })); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.deltas(start), "[stale call refused]fresh", "the stale call did not run and the turn went on");
    assert.ok(h.cliEntries().some((e) => e.response >= 1000 && e.result?.success === false && /leader stopped/.test(e.result?.contentItems?.[0]?.text)), "the CLI got its refusal");
    assert.equal(startedPids(h).length, 1, "the same leader served both turns");
  });
});

test("Codex leader: a request with no thread id, another thread, or an old v1 name is refused and never asks", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const base = { turnId: "$turn", itemId: "i9", command: "echo hi", cwd: "C:/work", reason: "x" };
    const raws = [
      { method: "item/tool/call", params: { turnId: "$turn", callId: "c9", tool: "get_crew_status", arguments: {} } },
      { method: "item/commandExecution/requestApproval", params: base },
      { method: "item/fileChange/requestApproval", params: { turnId: "$turn", itemId: "f9" } },
      { method: "item/commandExecution/requestApproval", params: { ...base, threadId: "thread-other" } },
      { method: "execCommandApproval", params: { conversationId: "thread-other", callId: "x", command: ["echo", "hi"], cwd: "C:/work", reason: "x" } },
      { method: "execCommandApproval", params: { conversationId: "thread-1", callId: "x", command: ["echo", "hi"], cwd: "C:/work", reason: "x" } },
      { method: "applyPatchApproval", params: { conversationId: "thread-other", callId: "y", fileChanges: {}, reason: "x" } },
      { method: "applyPatchApproval", params: { conversationId: "thread-1", callId: "y", fileChanges: {}, reason: "x" } },
    ];
    const start = h.chat(script(...raws.map((raw) => ({ raw })), { say: "end" }));
    await h.wait(() => h.turnEnded(start).length === 1 || h.pending().length > 0, "the turn ends without asking");
    assert.equal(h.pending().length, 0, "nothing reached the approval path");
    assert.equal(h.turnEnded(start)[0]?.type, "chatDone");
    const text = h.deltas(start);
    const denied = '{"decision":{"denied":{"rejection":"The user denied this."}}}';
    assert.match(text, /\[item\/tool\/call -> \{"contentItems":\[\{"type":"inputText","text":"leader stopped"\}\],"success":false\}\]/, "a tool call with no thread id is refused");
    assert.equal(text.match(/\[item\/commandExecution\/requestApproval -> \{"decision":"decline"\}\]/g)?.length, 2, "a command approval with no thread id, and with another thread, is declined");
    assert.match(text, /\[item\/fileChange\/requestApproval -> \{"decision":"decline"\}\]/, "a file approval with no thread id is declined");
    assert.equal(text.split(`execCommandApproval -> ${denied}`).length - 1, 2, "both execCommandApproval requests are denied");
    assert.equal(text.split(`applyPatchApproval -> ${denied}`).length - 1, 2, "both applyPatchApproval requests are denied");
  });
});

const APPROVALS = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"];

const declines = (h: Harness) => h.cliEntries().filter((e) => e.response >= 1000 && e.result?.decision === "decline").length;

test("Codex leader: a command or file approval with no turn id, an old turn id, another thread, or a finished turn is declined and never asks", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const raws = APPROVALS.flatMap((method) => [
      { method, params: { threadId: "thread-1", itemId: "m1", command: "echo hi", cwd: "C:/work", reason: "x" } },
      { method, params: { threadId: "thread-1", turnId: "turn-old", itemId: "s1", command: "echo hi", cwd: "C:/work", reason: "x" } },
      { method, params: { threadId: "thread-other", turnId: "$turn", itemId: "f1", command: "echo hi", cwd: "C:/work", reason: "x" } },
    ]);
    const late = APPROVALS.map((method) => ({ lateRaw: { method, params: { threadId: "thread-1", turnId: "$turn", itemId: "l1", command: "echo hi", cwd: "C:/work", reason: "x" } } }));
    const start = h.chat(script(...late, ...raws.map((raw) => ({ raw })), { say: "end" }));
    await h.wait(() => h.turnEnded(start).length === 1 || h.pending().length > 0, "the turn ends without asking");
    await h.idle();
    await h.wait(() => declines(h) === raws.length + late.length, `every one of the ${raws.length + late.length} requests was declined (saw ${declines(h)})`);
    assert.equal(h.pending().length, 0, "nothing reached the approval path");
    assert.equal(h.turnEnded(start)[0]?.type, "chatDone");
    for (const method of APPROVALS) assert.equal(h.deltas(start).split(`[${method} -> {"decision":"decline"}]`).length - 1, 3, `${method}: missing turn id, old turn id and another thread are each declined in the turn`);
  });
});

test("Codex leader: a command or file approval that lands before the turn/start reply is declined when it names another turn and handled when it names this one", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    for (const method of APPROVALS) {
      let start = h.chat(script({ earlyApprovalNext: { who: "other", method } }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
      start = h.chat(script({ say: "next" })); await h.wait(() => h.turnEnded(start).length === 1, `${method}: turn after an early request for another turn`);
      assert.equal(h.deltas(start), "[early call refused]next", `${method}: an early request naming another turn is declined on the reply`);
      assert.equal(h.pending().length, 0, `${method}: nothing was asked`);
    }
  });
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    let start = h.chat(script({ earlyApprovalNext: { who: "own", method: APPROVALS[0] } }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ say: "own" }));
    await h.wait(() => h.pending().length === 1, "the early request naming this turn reached the approval path");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.equal(h.deltas(start), "[early call ran]own", "control: an early request naming the coming turn is handled once the reply names it");
  });
});

test("Codex leader: a crew-tool call that lands before the turn/start reply waits for it, runs when it names the turn and is refused when it names another", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ earlyOwnNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ say: "own" })); await h.wait(() => h.turnEnded(start).length === 1, "second turn"); await h.idle();
    assert.equal(h.deltas(start), "[early call ran]own", "a call naming the coming turn ran once the reply named it");
    start = h.chat(script({ earlyOtherNext: true }, { say: "three" })); await h.wait(() => h.turnEnded(start).length === 1, "third turn"); await h.idle();
    start = h.chat(script({ say: "other" })); await h.wait(() => h.turnEnded(start).length === 1, "fourth turn");
    assert.equal(h.deltas(start), "[early call refused]other", "a call naming another turn was refused on the reply");
  });
});

test("leader CLI children (Codex and OpenCode) are spawned without the app key in their environment", async () => {
  const previous = process.env.CC_APP_KEY;
  process.env.CC_APP_KEY = "test-app-key-must-not-leak";
  const seen: Record<string, any> = {};
  const events = { onDelta() {}, onDone() {}, onUsage() {}, onError() {} };
  try {
    try {
      createCodexLeader({ model: "gpt-6-sol", effort: "low" }, ".", events as any, { tools: [], mode: "bypass", ask: async () => true, spawnFn: ((_command: string, options: any) => { seen.codex = options.env; throw new Error("stop after capturing the environment"); }) as any });
    } catch { /* the capture throws on purpose */ }
    const opencode = createOpencodeLeader({ model: "fakeprov/fake-model", effort: "max" }, ".", events as any, {
      bridge: { url: "http://127.0.0.1:1/mcp", token: "t" }, mode: "bypass", ask: async () => true,
      spawnFn: ((_command: string, options: any) => { seen.opencode = options.env; throw new Error("stop after capturing the environment"); }) as any,
    });
    opencode.send("hi");
    const end = Date.now() + 5000;
    while (!seen.opencode && Date.now() < end) await sleep(20);
    opencode.stop?.();
    assert.ok(seen.codex && seen.opencode, `both spawn calls were captured: ${Object.keys(seen)}`);
    for (const [name, env] of Object.entries(seen)) assert.equal(Object.hasOwn(env, "CC_APP_KEY"), false, `${name} child must not see CC_APP_KEY`);
    assert.ok(Object.keys(seen.codex).length > 3, "the captured environment is a real one (control: other variables are kept)");
  } finally { if (previous === undefined) delete process.env.CC_APP_KEY; else process.env.CC_APP_KEY = previous; }
});
