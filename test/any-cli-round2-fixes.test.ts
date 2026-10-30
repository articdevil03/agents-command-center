import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { LEADER, TAB, CODEX_LEADER, OPENCODE_LEADER, CLAUDE_LEADER, sleep, withServer, script, startedPids, errorsSince } from "./any-cli-helpers.ts";
import type { Harness } from "./any-cli-helpers.ts";
import { LIST_TIMEOUT_MS, KILL_TIMEOUT_MS } from "../server/leader-common/types.ts"; // the constants' own file: leader-common.ts reads the data root at import

// ---- round 2 fixes ----

const modeReply = (h: Harness, from: number, requestId: string) => h.wait(() => h.messages.slice(from).find((m) => m.requestId === requestId && (m.type === "error" || m.type === "permissionModeChanged" || m.type === "actionResult")), `reply to ${requestId}`, 15000);

const permissionCalls = (h: Harness, reply: string) => h.cliEntries().filter((e) => e.path?.includes("/permission/") && e.body?.reply === reply);

test("mode change race: a queued change that reaches a busy Codex leader is refused by the queued callback's own check, the chat is not stopped, and nothing from the old leader fails the new turn", { timeout: 90000 }, async () => {
  // The old leader is Claude (its replacement does not wait for a process), so the new Codex leader is running a turn when race_2's turn in the queue comes.
  await withServer({ leader: CLAUDE_LEADER, installed: ["codex"], env: { CC_TEST_FAKE_LEADER: "1", FAKE_CLAUDE_MODE_DELAY_MS: "2500" } }, async (h) => {
    await h.refresh();
    const warm = h.chat(JSON.stringify([{ tool: "Read", input: { file_path: "x" } }])); await h.wait(() => h.turnEnded(warm).length === 1, "claude turn"); await h.idle();
    const mark = h.messages.length;
    h.send({ type: "setPermissionMode", tabId: TAB, mode: "plan", confirm: true, requestId: "race_1" });
    await h.wait(() => h.ipc.some((m) => m.type === "modeChangeStarted"), "the first change is in flight");
    // No busy leader at request time, so race_2 passes the first check and queues behind race_1: only the queued callback's check can refuse it.
    h.send({ type: "setPermissionMode", tabId: TAB, mode: "ask", confirm: true, requestId: "race_2" });
    await h.update({ slot: LEADER.slotId, cli: "codex", model: "gpt-6-sol" }, () => h.seat(LEADER.slotId).cli === "codex");
    const start = h.chat(script({ sleep: 3500 }, { say: "still going" }));
    await h.wait(() => startedPids(h).length === 1 && h.tab().derived.leaderTurnActive, "the Codex leader is running the turn");
    const second = await modeReply(h, mark, "race_2");
    assert.equal(second.type, "error"); assert.match(second.message, /Finish or stop .*'s current turn first, then change the mode./, "the busy refusal, not a failed apply");
    assert.equal((await modeReply(h, mark, "race_1")).type, "error", "the change that was in flight when the leader was replaced fails");
    await h.wait(() => h.turnEnded(start).length === 1, "codex turn done", 15000);
    assert.equal(h.turnEnded(start)[0].type, "chatDone", "the busy refusal did not stop the chat and the old leader did not fail it");
    assert.equal(h.deltas(start), "still going");
    assert.equal(errorsSince(h, mark).length, 0, "no chat error frame at all");
  });
});

test("OpenCode leader: a server that dies during a mode change reports one chat error, not two", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_PATCH_EXITS: "1" } }, async (h) => {
    const warm = h.chat("start the leader"); await h.wait(() => h.turnEnded(warm).length === 1, "opencode turn"); await h.idle();
    const mark = h.messages.length;
    const reply = await h.action({ type: "setPermissionMode", tabId: TAB, mode: "plan", confirm: true });
    assert.equal(reply.type, "error");
    await sleep(700);
    const errors = errorsSince(h, mark);
    assert.equal(errors.length, 1, `one chat error: ${JSON.stringify(errors.map((e) => e.message))}`);
    assert.match(errors[0].message, /session ended/);
  });
});

test("OpenCode leader: when it dies with a permission still open, the CLI gets a reject for it", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ bashNoWait: "rm -rf left-open" }, { error: "boom" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "the turn failed with a permission open");
    await h.wait(() => permissionCalls(h, "reject").length === 1, "a reject was posted for the open permission");
    await h.wait(() => h.pending().length === 0, "the approval card is gone");
  });
});

test("OpenCode leader: Stop while a reply is still being acknowledged still rejects that permission", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_REPLY_DELAY_MS: "4000" } }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    h.chat(script({ bash: "npm test" }));
    await h.wait(() => h.pending().length === 1, "approval pending");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => permissionCalls(h, "once").length === 1, "the allow reached the CLI, its acknowledgement is still pending");
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => permissionCalls(h, "reject").length === 1, "Stop rejected the permission that was not acknowledged yet");
  });
});

test("OpenCode leader: the effort sent with each prompt follows the saved seat", { timeout: 60000 }, async () => {
  // OpenCode offers one effort today: the test runner widens the list to two so a leader that froze its effort at start is caught.
  await withServer({ leader: OPENCODE_LEADER, env: { CC_TEST_OPENCODE_EFFORTS: "max,high" } }, async (h) => {
    let start = h.chat("first"); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    await h.update({ slot: LEADER.slotId, effort: "high" }, () => h.seat(LEADER.slotId).effort === "high");
    start = h.chat("second"); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.deepEqual(h.cliEntries().filter((e) => e.path?.endsWith("/prompt_async")).map((e) => e.body.variant), ["max", "high"]);
  });
});

test("OpenCode leader: an error that echoes the base64 credential never reaches the chat", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ error: "boom", leakB64: true }));
    await h.wait(() => h.turnEnded(start).length >= 1, "leaky error");
    const message = h.turnEnded(start)[0].message;
    assert.match(message, /boom credential \[hidden\]/);
    assert.ok(!/[A-Za-z0-9+/=]{40,}/.test(JSON.stringify(h.messages.filter((m) => m.type !== "state"))), "no credential-sized string anywhere in the chat frames");
  });
});

test("OpenCode leader: a prompt error is redacted before it is shortened", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_PROMPT_FAILS: "1", FAKE_OPENCODE_PROMPT_LEAK: "1" } }, async (h) => {
    const start = h.chat("will be refused"); await h.wait(() => h.turnEnded(start).length >= 1, "failed prompt");
    const message = h.turnEnded(start)[0].message;
    assert.match(message, /x{100,}\[hidden\]/, "the password became [hidden] before the cut");
    assert.ok(!/[0-9a-f]{12,}/.test(message.replace(/x+/g, "")), `no part of the password survives: ${message}`);
  });
});

test("Codex leader: a delta from an older turn that lands before the new turn is announced is dropped, and a late turn/started cannot replace the id", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ staleNext: "OLD-BEFORE-START" }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ say: "fresh" })); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone"); assert.equal(h.deltas(start), "fresh", "the old turn's delta never reached this turn");
    await h.idle();
    start = h.chat(script({ staleStarted: true }, { say: "after" })); await h.wait(() => h.turnEnded(start).length === 1, "third turn");
    assert.equal(h.deltas(start), "after", "a turn/started naming an older turn did not take over the turn id");
  });
});

test("Codex leader: an older turn's started, text and completion that land before the new turn's reply are ignored", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ staleTurnNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ sleep: 300 }, { say: "own text" })); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone"); assert.equal(h.deltas(start), "own text", "only the real turn's text, finished by its own completion");
  });
});

test("Codex leader: text and a completion that name no turn, landing before the reply, neither reach chat nor end the turn", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ unidentNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ sleep: 300 }, { say: "own text" })); await h.wait(() => h.turnEnded(start).length >= 1, "second turn"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.deltas(start), "own text", "the unidentified text never reached chat and the unidentified completion did not end the turn early");
  });
});

test("Codex leader: a final error that names no turn, before and after the reply, does not end the turn or the leader", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ unidentErrorNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ sleep: 300 }, { say: "own text" })); await h.wait(() => h.turnEnded(start).length >= 1, "second turn"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatDone", "no chat error from the unidentified error");
    assert.equal(h.deltas(start), "own text");
    assert.equal(startedPids(h).length, 1, "the same leader served both turns");
    start = h.chat(script({ say: "third" })); await h.wait(() => h.turnEnded(start).length === 1, "third turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone"); assert.equal(startedPids(h).length, 1, "the next message reused the leader");
  });
});

test("Codex leader: a turn/start that is never answered retires the leader with one plain error, and the next message starts fresh", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, env: { FAKE_CODEX_TURN_START_NEVER_ANSWERED: "1", CC_TEST_LEADER_TURN_TIMEOUT_MS: "600" } }, async (h) => {
    const start = h.chat("hello"); await h.wait(() => h.turnEnded(start).length >= 1, "the unanswered turn ended"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError"); assert.match(h.turnEnded(start)[0].message, /Codex did not answer the turn request/);
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the leader's child is gone");
    await h.wait(() => !h.tab().derived.leaderTurnActive, "the tab is no longer busy");
    h.chat("again"); await h.wait(() => startedPids(h).length === 2, "the next message started a fresh leader");
  });
});

test("Codex leader: a turn/start reply with no turn id ends that leader with one plain error, and the next message starts fresh", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ noIdNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat("no id please"); await h.wait(() => h.turnEnded(start).length >= 1, "the unidentified turn ended"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError"); assert.match(h.turnEnded(start)[0].message, /did not identify the turn/);
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the leader's child is gone");
    start = h.chat("fresh again"); await h.wait(() => h.turnEnded(start).length === 1, "next turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone"); assert.match(h.deltas(start), /fresh again/);
  });
});

test("Codex leader: a request it cannot handle is refused and ends that leader once", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const start = h.chat(script({ badFileChange: true }, { say: "never" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "the turn ended"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError"); assert.match(h.turnEnded(start)[0].message, /could not be handled/);
    assert.ok(h.cliEntries().some((e) => e.response >= 1000 && e.result?.decision === "decline"), "the CLI got its refusal");
    assert.equal(h.child.exitCode, null, "the server is still running");
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the leader's child is gone");
  });
});

test("Codex leader: when it fails with an approval open, the CLI still gets its refusal", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ commandNoWait: "rm -rf left-open" }, { error: "boom" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "the turn failed with a request open");
    await h.wait(() => h.cliEntries().some((e) => e.response >= 1000 && e.result?.decision === "decline"), "the refusal was written before the kill");
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the child is gone");
  });
});

test("a leader whose kill could not be confirmed blocks the tab's next leader until its process is seen to exit", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, env: { CC_TEST_KILLER_EXIT: "1" } }, async (h) => {
    const warm = h.chat("hello"); await h.wait(() => h.turnEnded(warm).length === 1, "first turn"); await h.idle();
    const [oldPid] = startedPids(h);
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.messages.some((m) => m.type === "chatNotice" && /Could not confirm the old Codex leader stopped/.test(m.message)), "the failed kill is reported");
    assert.ok(h.pidAlive(oldPid), "the fake killer left the old leader running");
    const blocked = h.chat("while the old one lives"); await h.wait(() => h.turnEnded(blocked).length === 1, "refused");
    assert.equal(h.turnEnded(blocked)[0].type, "chatError");
    assert.match(h.turnEnded(blocked)[0].message, /could not be confirmed stopped and may still be running/);
    assert.equal(startedPids(h).length, 1, "no second leader process was started beside it");
    process.kill(oldPid); await h.wait(() => !h.pidAlive(oldPid), "the old leader exits");
    // The server learns of the exit a moment after the pid is gone: ask again until it has (a still-blocked answer is the same refusal as above).
    let next = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      next = h.chat("after it exited"); await h.wait(() => h.turnEnded(next).length === 1, "answered");
      if (h.turnEnded(next)[0].type === "chatDone") break;
      await sleep(250);
    }
    assert.equal(h.turnEnded(next)[0].type, "chatDone", h.turnEnded(next)[0].message); assert.equal(startedPids(h).length, 2);
  });
});

test("a message sent right after Stop, before the old kill's result is known, never starts a second leader beside one whose kill then fails", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, env: { CC_TEST_KILLER_EXIT: "1" } }, async (h) => {
    const warm = h.chat("hello"); await h.wait(() => h.turnEnded(warm).length === 1, "first turn"); await h.idle();
    const [oldPid] = startedPids(h);
    const mark = h.messages.length;
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.tab().leaderStatus === "not-started", "the old leader is stopped");
    // The kill runs after a short grace and its (failing) result comes later: this message arrives before either.
    const start = h.chat(script({ sleep: 1800 }, { say: "still going" }));
    const notice = await h.wait(() => h.messages.slice(mark).find((m) => m.type === "chatNotice"), "the failed kill is reported", 15000);
    assert.match(notice.message, /Could not confirm the old Codex leader stopped/); assert.equal(notice.tabId, TAB);
    await h.wait(() => h.turnEnded(start).length === 1, "the message was refused", 15000);
    assert.equal(h.turnEnded(start)[0].type, "chatError");
    assert.match(h.turnEnded(start)[0].message, /could not be confirmed stopped and may still be running/);
    assert.ok(h.pidAlive(oldPid), "the fake killer left the old leader running");
    assert.equal(startedPids(h).length, 1, "no second leader process was started beside it");
    assert.ok(!errorsSince(h, mark).some((m) => m.message === notice.message), "the notice is not a chat error");
  });
});

// A normal Stop can run two overlapping taskkills on one tree and one of them exits with another code though the tree is gone (CC_TEST_KILLER_EXIT=1 plays that exit code).
// The old leader really exits a moment after the failed kill: that is a confirmed stop, with no notice and no refusal of the next message.
for (const c of [{ name: "Codex", leader: CODEX_LEADER, notice: /Could not confirm the old Codex leader stopped/ }, { name: "OpenCode", leader: OPENCODE_LEADER, notice: /Could not confirm the old OpenCode leader stopped/ }]) {
  test(`${c.name} leader: a Stop whose killer exits with another code but whose process then exits raises no could-not-confirm alarm`, { timeout: 60000 }, async () => {
    await withServer({ leader: c.leader, env: { CC_TEST_KILLER_EXIT: "1" } }, async (h) => {
      const warm = h.chat("hello"); await h.wait(() => h.turnEnded(warm).length === 1, "first turn"); await h.idle();
      const [oldPid] = startedPids(h);
      const mark = h.messages.length;
      h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
      await sleep(900); // the kill starts after the 200 ms grace and its fake killer has failed by now; the old leader is still alive
      assert.ok(h.pidAlive(oldPid), "the fake killer left the old leader running for the moment");
      process.kill(oldPid); await h.wait(() => !h.pidAlive(oldPid), "the old leader exits");
      await sleep(3000); // past the confirm wait: a false alarm would have come by now
      assert.ok(!h.messages.slice(mark).some((m) => m.type === "chatNotice" && c.notice.test(m.message)), "no could-not-confirm notice");
      const next = h.chat("after it exited"); await h.wait(() => h.turnEnded(next).length === 1, "answered", 20000);
      assert.equal(h.turnEnded(next)[0].type, "chatDone", h.turnEnded(next)[0].message); assert.equal(startedPids(h).length, 2, "a new leader started normally");
    });
  });
}

test("Stop and an immediate message: the new leader starts once the old one has exited, with no error", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const warm = h.chat("hello"); await h.wait(() => h.turnEnded(warm).length === 1, "first turn"); await h.idle();
    const [oldPid] = startedPids(h);
    const mark = h.messages.length;
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    const next = h.chat(script({ say: "fresh" }));
    await h.wait(() => h.turnEnded(next).length === 1, "the new turn", 20000);
    assert.equal(h.turnEnded(next)[0].type, "chatDone", h.turnEnded(next)[0].message); assert.equal(h.deltas(next), "fresh");
    assert.equal(startedPids(h).length, 2); assert.ok(!h.pidAlive(oldPid), "the old leader was gone before the new answer");
    assert.equal(errorsSince(h, mark).length, 0, "no chat error frame at all");
  });
});

test("Stop all ends a turn that is waiting for the old leader to exit, and no leader starts after it", { timeout: 60000 }, async () => {
  // CC_TEST_KILLER_EXIT=0: the kill reports success but stops nothing, so the old leader stays alive and the next turn has to wait for it.
  await withServer({ leader: CODEX_LEADER, env: { CC_TEST_KILLER_EXIT: "0" } }, async (h) => {
    const warm = h.chat("hello"); await h.wait(() => h.turnEnded(warm).length === 1, "first turn"); await h.idle();
    const [oldPid] = startedPids(h);
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.tab().leaderStatus === "not-started", "the old leader is stopped");
    const waiting = h.chat(script({ say: "must never run" }));
    await h.wait(() => h.tab().derived.leaderTurnActive, "the message is waiting for the old leader");
    assert.ok(h.pidAlive(oldPid), "the old leader is still alive");
    h.send({ type: "stopAll" });
    await h.wait(() => h.turnEnded(waiting).length === 1, "the waiting turn ended", 15000);
    assert.equal(h.turnEnded(waiting)[0].type, "chatError");
    assert.equal(h.turnEnded(waiting)[0].message, "leader turn stopped");
    await h.idle();
    assert.equal(h.tab().derived.busy, false, "the tab is not busy after Stop all");
    process.kill(oldPid); await h.wait(() => !h.pidAlive(oldPid), "the old leader exits");
    await sleep(1500); // well past the 25 ms recheck of the wait: a leader would have started by now
    assert.equal(startedPids(h).length, 1, "no new leader process was ever started");
    assert.equal(h.deltas(waiting), "");
  });
});

// The old leader's root exits but a descendant of it cannot be stopped. The process list and the kill of that one made-up descendant are the only
// fakes (Boot.tree); the leader, its exit sweep, the tab's retired-leader check and the chat all run for real.
const GRAND = 2_147_400_001;

// A sweep can legitimately take as long as the app lets one list and one kill take; a wait that covers a sweep outlasts that.
const SWEEP_WAIT = LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 5_000;

const sweepCases = [
  { name: "Codex", leader: CODEX_LEADER, env: {}, notice: /Could not confirm the old Codex leader stopped/, text: () => script({ say: "fresh" }), pids: (h: Harness) => startedPids(h) },
  { name: "OpenCode", leader: OPENCODE_LEADER, env: {}, notice: /Could not confirm the old OpenCode leader stopped/, text: () => script({ say: "fresh" }), pids: (h: Harness) => startedPids(h) },
  { name: "Claude", leader: CLAUDE_LEADER, env: { CC_TEST_FAKE_LEADER: "1", FAKE_CLAUDE_SPAWN: "1" }, notice: /Could not confirm the old Claude leader stopped/, text: () => JSON.stringify([{ tool: "Read", input: { file_path: "x" } }]), pids: (h: Harness) => h.ipc.filter((m) => m.type === "claudeSpawned").map((m) => m.pid as number) },
];

for (const c of sweepCases) {
  test(`${c.name} leader: a descendant of the stopped leader that cannot be killed is said once, refuses the next message with no new leader, and once it can be killed the next message starts one`, { timeout: 15000 + 4 * SWEEP_WAIT + 60000 }, async () => {
    await withServer({ leader: c.leader, tree: true, env: c.env }, async (h) => {
      const warm = h.chat(c.text()); await h.wait(() => h.turnEnded(warm).length === 1, "first turn", 15000); await h.idle();
      const [oldPid] = c.pids(h);
      assert.ok(oldPid, "the old leader's process started");
      const leftover = { pid: GRAND, ppid: oldPid, created: Date.now() }; // the same process on every setTree: a new created would be a different one
      h.setTree([leftover], [GRAND]);
      const notices = () => h.messages.filter((m) => m.type === "chatNotice" && c.notice.test(m.message)).length;
      h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
      await h.wait(() => notices() === 1, "the failed descendant kill is reported", SWEEP_WAIT);
      await h.wait(() => !h.pidAlive(oldPid), "the old leader's own process is gone");
      // The notice can come from Stop's own kill before the exit sweep has looked: go on only once the sweep has tried (and failed) to kill the descendant.
      await h.wait(() => h.treeKills().some((kill) => kill.pid === GRAND && !kill.ok), "the exit sweep's failed kill of the descendant", SWEEP_WAIT);
      const blocked = h.chat(c.text()); await h.wait(() => h.turnEnded(blocked).length === 1, "refused", SWEEP_WAIT);
      assert.equal(h.turnEnded(blocked)[0].type, "chatError");
      assert.match(h.turnEnded(blocked)[0].message, /could not be confirmed stopped and may still be running/);
      assert.equal(c.pids(h).length, 1, "no new leader process was started");
      assert.equal(notices(), 1, "said once, not again by the retry");
      h.setTree([leftover], []); // the descendant can be killed now: the retry has to kill this very process, or the next message is refused again
      const next = h.chat(c.text()); await h.wait(() => h.turnEnded(next).length === 1, "the next message", SWEEP_WAIT);
      assert.equal(h.turnEnded(next)[0].type, "chatDone", h.turnEnded(next)[0].message);
      assert.equal(c.pids(h).length, 2, "a new leader started normally");
    });
  });
}

// Every kill of the stopped leader fails (CC_TEST_KILLER_EXIT=1) and its descendant cannot be stopped either, so the kill and the exit sweep both report: one notice, not one per report.
for (const c of sweepCases) {
  test(`${c.name} leader: a kill that cannot be confirmed and a sweep that fails afterwards are said once`, { timeout: 15000 + 3 * SWEEP_WAIT + 60000 }, async () => {
    await withServer({ leader: c.leader, tree: true, env: { ...c.env, CC_TEST_KILLER_EXIT: "1" } }, async (h) => {
      const warm = h.chat(c.text()); await h.wait(() => h.turnEnded(warm).length === 1, "first turn", 15000); await h.idle();
      const [oldPid] = c.pids(h);
      assert.ok(oldPid, "the old leader's process started");
      h.setTree([{ pid: GRAND, ppid: oldPid, created: Date.now() }], [GRAND]);
      const notices = () => h.messages.filter((m) => m.type === "chatNotice" && c.notice.test(m.message)).length;
      h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
      await h.wait(() => notices() >= 1, "the failed kill is reported", SWEEP_WAIT);
      assert.ok(h.pidAlive(oldPid), "the fake killer left the old leader running");
      const exitedAfter = Date.now();
      process.kill(oldPid); await h.wait(() => !h.pidAlive(oldPid), "the old leader exits");
      // The exit sweep has tried (and failed) to kill the descendant: only now can a second notice be on its way.
      await h.wait(() => h.treeKills().some((kill) => kill.pid === GRAND && !kill.ok && kill.at >= exitedAfter), "the exit sweep's failed kill of the descendant", SWEEP_WAIT);
      const blocked = h.chat(c.text()); await h.wait(() => h.turnEnded(blocked).length === 1, "refused", SWEEP_WAIT);
      assert.match(h.turnEnded(blocked)[0].message, /could not be confirmed stopped and may still be running/);
      await sleep(2500); // the sweep's report follows its kill within a moment (about 1.6 s after the exit when the dedupe is missing, measured)
      assert.equal(notices(), 1, "the kill and the sweep said it once between them");
    });
  });
}
