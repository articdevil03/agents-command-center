// Pack 12 (steer in chat), the server side through real servers, part 2: refusals, a busy folder, and the polish cases.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CLIS, type Cli, tabOf, SOLO_TAB, SPARE_TAB, sleep, slow, fakeLog, reached, PAD, HEAD, chatFile, withServer, unansweredNotices } from "./pack12-server-helpers.ts";

test("refusals: an approval card waiting and a Save running refuse the steer with a typed reply carrying the request id, and nothing reaches the CLI", { timeout: 90_000 }, async () => {
  await withServer({ CC_TEST_SAVE_WRITE_DELAY_MS: "1500" }, async (server, c) => {
    const tab = tabOf("codex", 6), text = "STEER-APPROVAL";
    await c.start(tab, JSON.stringify([{ say: "x " }, { command: "echo hi" }]));
    const card = await c.wait(() => c.tabState(tab).pendingApprovals?.[0], "the approval card");
    const requestId = c.steer(tab, text);
    const refused = await c.wait(() => c.messages.find((m) => m.type === "steerRefused" && m.requestId === requestId), "the refusal");
    assert.deepEqual([refused.reason, refused.tabId], ["approval", tab]);
    assert.equal(reached(server, "codex", text).length, 0, "nothing reached the CLI");
    assert.equal(c.answers(tab).some((row) => row.text === text), false, "and nothing was appended");
    c.send({ type: "answerApproval", tabId: tab, approvalId: card.approvalId, allow: false, requestId: "p12deny" });
    await c.finished(tab, 1, "the turn ends after the denial");

    // Save runs as a leader turn through the same machinery: a steer into it is refused too.
    const claude = tabOf("claude", 6);
    await c.start(claude, "hello before save");
    await c.finished(claude, 1, "the leader has read its handover");
    c.send({ type: "save", tabId: claude });
    await c.wait(() => reached(server, "claude", "Save a concise handover").length === 1, "the Save turn is running");
    const saveSteer = c.steer(claude, "STEER-SAVE");
    const saveRefused = await c.wait(() => c.messages.find((m) => m.type === "steerRefused" && m.requestId === saveSteer), "the refusal during Save");
    assert.equal(saveRefused.reason, "save");
    assert.equal(reached(server, "claude", "STEER-SAVE").length, 0);
    await c.wait(() => c.messages.find((m) => m.type === "saved" && m.tabId === claude), "the Save finishes", 20_000);
  });
});

test("a steer on a leader that cannot tell its steers from queued messages (no echo) is refused as unavailable; one sent before Codex named its turn waits for the id", { timeout: 60_000 }, async () => {
  await withServer({ FAKE_CLAUDE_NO_REPLAY: "1", FAKE_CODEX_TURN_START_DELAY_MS: "400" }, async (server, c) => {
    const claude = tabOf("claude", 1);
    await c.start(claude, slow("claude", "part one ", "part two"));
    await c.wait(() => c.streamed(claude).includes("part one"), "streaming");
    const requestId = c.steer(claude, "STEER-NOECHO");
    const refused = await c.wait(() => c.messages.find((m) => m.type === "steerRefused" && m.requestId === requestId), "refused");
    assert.equal(refused.reason, "unavailable");
    assert.equal(reached(server, "claude", "STEER-NOECHO").length, 0, "nothing was sent to a CLI that would answer it as a second turn");
    await c.finished(claude, 1, "the reply is untouched");
    assert.equal(c.answers(claude).length, 2);

    const codex = tabOf("codex", 3), text = "STEER-EARLY";
    await c.start(codex, JSON.stringify([{ sleep: 500 }, { say: "ok " }]));
    c.steer(codex, text); // the turn id is not known yet: the steer waits for it
    await c.finished(codex, 1, "codex: ends");
    const sent = fakeLog(server).find((entry) => entry.method === "turn/steer" && entry.params.input[0].text === text);
    assert.ok(sent, "turn/steer was sent");
    assert.equal(sent.params.expectedTurnId, "turn-1", "with the id from the turn/start reply");
    assert.match(c.answers(codex).at(-1)!.text, /\[steer: STEER-EARLY\]/);
    assert.equal(c.done(codex), 1);
  });
});

test("folder busy: a steer is held with the same request id (nothing steered), Continue anyway steers it; a normal send to an idle tab is held the same way", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("codex", 6), text = "STEER-BUSY";
    await c.start(tab, JSON.stringify([{ say: "a " }, { sleep: 3500 }, { say: "b" }]));
    await c.wait(() => c.streamed(tab).includes("a"), "the target is replying");
    // A Stand-alone tab's leader codes itself: its turn in the same folder is a writer.
    await c.start(SOLO_TAB, JSON.stringify([{ sleep: 3000 }, { say: "solo" }]));
    const held = c.steer(tab, text);
    const busy = await c.wait(() => c.messages.find((m) => m.type === "folderBusy" && m.requestId === held), "the steer is held");
    assert.deepEqual([busy.action, busy.tabId], ["chat", tab]);
    assert.equal(reached(server, "codex", text).length, 0, "nothing was steered");
    assert.equal(c.answers(tab).some((row) => row.text === text), false, "and nothing was appended");
    const confirmed = c.steer(tab, text, { confirmBusy: true });
    await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === confirmed), "Continue anyway steers it");
    await c.wait(() => reached(server, "codex", text).length, "the steer reached the CLI (the fake logs it a moment after the server wrote the chat row)");
    assert.deepEqual(reached(server, "codex", text).map((item) => item.kind), ["steer"]);
    // The automatic send of a queued message is a normal chat: held the same way while the writer is active.
    const auto = `auto${randomUUID().slice(0, 6)}`;
    c.send({ type: "chat", tabId: SPARE_TAB, text: "queued message", requestId: auto });
    await c.wait(() => c.messages.find((m) => m.type === "folderBusy" && m.requestId === auto), "the normal send is held");
    assert.equal(c.answers(SPARE_TAB).length, 0);
    await c.finished(tab, 1, "the target ends", 20_000);
    await c.finished(SOLO_TAB, 1, "the solo tab ends", 20_000);
  });
});


test("polish 1: a steer waiting behind a FAILED Claude turn is answered, not forgotten: it keeps the turn open, the turn ends once with the failure after the steer's answer, and the chat says so", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 5), text = JSON.stringify([{ say: "STEER-AFTER-FAIL-ANSWER" }]);
    await c.start(tab, JSON.stringify([{ noFold: true }, { say: "first " }, { wait: 900 }, { failTurn: true }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, text);
    await c.wait(() => c.failed(tab) >= 1, "the turn ends with the failure", 20_000);
    await sleep(600);
    assert.equal(c.failed(tab), 1, "one chatError, not one per CLI result");
    assert.equal(c.done(tab), 0);
    const rows = c.answers(tab);
    assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "user", "assistant"], JSON.stringify(rows));
    assert.ok(rows[3]!.text.includes("STEER-AFTER-FAIL-ANSWER") && rows[3]!.text.includes("leader turn failed"), `the steer's answer is kept and the failure follows it: ${rows[3]!.text}`);
    assert.equal(unansweredNotices(c, tab).length, 1, "and the chat says a steered message may be unanswered");
    assert.deepEqual(reached(server, "claude", "STEER-AFTER-FAIL-ANSWER").map((item) => item.kind), ["steer"]);
    await c.start(tab, "next-message");
    await c.finished(tab, 1, "the next turn works");
    assert.ok(!c.answers(tab).at(-1)!.text.includes("STEER-AFTER-FAIL"), "no text of the old turn leaked into the next");
  });
});

test("polish 5: a reply that FAILS or is STOPPED with a steered message in it says so in the chat, on every CLI; a Clear (which empties the chat) adds nothing", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    const failing: Record<Cli, string> = {
      claude: JSON.stringify([{ say: "first " }, { wait: 900 }, { failTurn: true }]),
      codex: JSON.stringify([{ say: "first " }, { sleep: 900 }, { error: "boom" }]),
      opencode: JSON.stringify([{ say: `first ${PAD}` }, { sleep: 900 }, { error: "boom" }]),
    };
    for (const cli of CLIS) {
      const tab = tabOf(cli, 1), text = `STEER-FAILING-${cli}`;
      await c.start(tab, failing[cli]);
      await c.wait(() => c.streamed(tab).includes("first"), `${cli}: streaming`);
      const requestId = c.steer(tab, text);
      await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `${cli}: the steer is taken`);
      await c.wait(() => c.failed(tab) >= 1, `${cli}: the reply fails`, 20_000);
      await sleep(300);
      assert.equal(unansweredNotices(c, tab).length, 1, `${cli}: failed reply, steer in the chat: the chat says it may be unanswered`);
    }
    for (const cli of CLIS) {
      const tab = tabOf(cli, 2), text = `STEER-STOPPED-${cli}`;
      await c.start(tab, slow(cli, HEAD, "part two"));
      await c.wait(() => c.streamed(tab).includes(cli === "opencode" ? "part one" : HEAD), `${cli}: streaming`);
      const requestId = c.steer(tab, text);
      await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `${cli}: the steer is taken`);
      c.send({ type: "stopAll" });
      await c.wait(() => c.failed(tab) >= 1, `${cli}: the stop ends the reply`);
      await sleep(300);
      assert.equal(unansweredNotices(c, tab).length, 1, `${cli}: stopped reply, steer in the chat: the chat says it may be unanswered`);
    }
    // Clear empties the chat: nothing to explain, and no notice is written into the fresh chat.
    const tab = tabOf("codex", 3);
    await c.start(tab, slow("codex", HEAD, "part two"));
    await c.wait(() => c.streamed(tab).includes(HEAD), "clear: streaming");
    const requestId = c.steer(tab, "STEER-CLEARED");
    await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), "clear: the steer is taken");
    c.send({ type: "clear", tabId: tab });
    await c.wait(() => c.failed(tab) >= 1, "clear: the reply ends");
    await sleep(300);
    assert.equal(unansweredNotices(c, tab).length, 0, "a Clear adds no notice");
    const lines = readFileSync(join(server.data, "chats", `${tab}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const clearedAt = lines.findLastIndex((row) => row.type === "clear");
    assert.ok(clearedAt >= 0, "the chat file records the clear");
    assert.deepEqual(lines.slice(clearedAt + 1), [], "nothing is written into the chat after the clear");
    assert.equal(lines.some((row) => /may not have been answered/.test(row.text ?? "")), false, "and the notice was never written");
  });
});

test("polish 2: OpenCode releases the reply so far at a steer through the redaction: the text before the steer is complete before the steered message, a secret only partly received is never shown in any form", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 1), text = "STEER-SECRET-SPLIT";
    await c.start(tab, JSON.stringify([{ say: PAD }, { leakHalf: 1200 }]));
    await c.wait(() => fakeLog(server).some((entry) => entry.leakHalfSecret), "the fake sent the first half of the secret");
    const secret: string = fakeLog(server).find((entry) => entry.leakHalfSecret).leakHalfSecret;
    await sleep(300);
    const requestId = c.steer(tab, text);
    await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), "the steer is taken");
    const rowsAtSteer = c.answers(tab);
    assert.ok(rowsAtSteer[1]!.text.endsWith("visible-end "), `the reply so far is complete before the steered message: ${JSON.stringify(rowsAtSteer[1]!.text.slice(-40))}`);
    await c.finished(tab, 1, "the turn ends");
    const everything = JSON.stringify([c.messages.filter((m) => m.type !== "state"), c.streamed(tab), chatFile(server, tab)]);
    assert.equal(everything.includes(secret.slice(0, 8)), false, "no part of the secret was ever shown, saved or broadcast");
    assert.ok(c.answers(tab).map((row) => row.text).join("").includes("[hidden] after"), "the secret was hidden once it was complete");
  });
});

test("polish 3: OpenCode runs a steer as a SECOND run although its message was seen before the first idle: the turn stays open, the second run's text is kept, one chatDone", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 3), text = "STEER-LATE-SEEN";
    await c.start(tab, JSON.stringify([{ steerLate: "lateSeen" }, { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, text);
    await c.finished(tab, 1, "the turn ends");
    await sleep(600);
    assert.equal(c.done(tab), 1, "one chatDone although OpenCode went idle twice");
    const rows = c.answers(tab);
    assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "user", "assistant"], JSON.stringify(rows));
    assert.ok(rows[3]!.text.endsWith(`opencode says hi to: ${text}`), `the second run's text was not dropped: ${rows[3]!.text}`);
    assert.equal(reached(server, "opencode", text).length, 1, "the prompt was posted once");
    await c.start(tab, "next-message");
    await c.finished(tab, 2, "the next turn works");
  });
});

test("polish 3b: OpenCode refuses the steer's prompt AFTER the first idle was held: the turn still ends, and the steer goes out as the next turn once", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 4), text = "STEER-REFUSED-AFTER-IDLE";
    await c.start(tab, JSON.stringify([{ steerLate: "lateFail" }, { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, text);
    await c.finished(tab, 2, "the reply ends and the handed-back steer is answered", 20_000);
    await sleep(300);
    assert.equal(c.done(tab), 2, "two turns, two chatDone, none stuck");
    const rows = c.answers(tab);
    assert.equal(rows.filter((row) => row.text === text).length, 1, "the steer is in the chat once");
    assert.equal(rows.at(-1)!.text, `opencode says hi to: ${text}`);
  });
});

test("polish 4: a steer that arrives while the tab's new leader is still waiting for a retired one is refused as 'starting' with its request id, reaches no CLI, appends nothing", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("codex", 1), text = "STEER-STARTING";
    await c.start(tab, slow("codex", HEAD, "part two", 3000));
    await c.wait(() => c.streamed(tab).includes(HEAD), "streaming");
    c.send({ type: "stopAll" });
    // The old Codex process is still being ended: the new message's turn is the tab's, but its leader does not exist yet.
    c.send({ type: "chat", tabId: tab, text: "AFTER-STOP", requestId: "p12after" });
    const requestId = c.steer(tab, text);
    const refused = await c.wait(() => c.messages.find((m) => m.type === "steerRefused" && m.requestId === requestId), "the refusal");
    assert.deepEqual([refused.reason, refused.tabId], ["starting", tab]);
    assert.equal(reached(server, "codex", text).length, 0, "nothing reached the CLI");
    await c.finished(tab, 1, "the message sent after the stop is answered");
    const rows = c.answers(tab);
    assert.equal(rows.some((row) => row.text === text), false, "the refused steer was not appended");
    assert.equal(rows.filter((row) => row.text === "AFTER-STOP").length, 1);
    assert.equal(chatFile(server, tab).filter((row) => row.text === text).length, 0);
  });
});
