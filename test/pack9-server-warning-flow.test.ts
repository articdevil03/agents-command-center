// Pack 9, the warning flow through real servers, part 1: chat and Run are held with a `folderBusy` message when an outside session works in the folder; Continue anyway sends them; our own sessions never count.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { TAB_A, TAB_B, sleep, RUN_END_MS, runEndMs, testTimeoutMs, touch, type Server, boot, client, codexRecord, claudeRecord, opencodeRecord, fakeLeaderTurns, withServer } from "./pack9-server-helpers.ts";

test("chat: an outside Codex session holds the message (nothing saved, no turn, no leader), Continue anyway sends it, the next message is not asked again, a NEW outside session asks again", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    codexRecord(server, "ext-codex-1", Date.now() - 40_000);
    const held = await c.chat(TAB_A, "hello");
    assert.ok(held.held, `held, got ${JSON.stringify(held.answer)}`);
    assert.deepEqual([held.answer.action, held.answer.tabId, held.answer.requestId], ["chat", TAB_A, held.requestId]);
    assert.deepEqual(held.answer.items.map((i: any) => i.tool), ["Codex"]);
    assert.ok(held.answer.items[0].agoSeconds >= 38 && held.answer.items[0].agoSeconds <= 70, `about 40 seconds ago, got ${held.answer.items[0].agoSeconds}`);
    await sleep(400);
    assert.equal(c.messages.some((m) => m.type === "chatMessage" && m.requestId === held.requestId), false, "the user's message was not appended");
    assert.equal(existsSync(join(server.data, "chats", `${TAB_A}.jsonl`)), false, "no transcript was written");
    assert.equal(c.tab(TAB_A).leaderStatus, "not-started", "no leader was started");
    assert.equal(c.tab(TAB_A).derived.leaderTurnActive, false);
    assert.equal(fakeLeaderTurns(server), 0, "no turn reached the leader");

    const confirmed = await c.chatAndFinish(TAB_A, "hello", { confirmBusy: true });
    assert.ok(confirmed.taken, "Continue anyway sends it under a fresh request id");
    assert.notEqual(confirmed.requestId, held.requestId);
    assert.equal(fakeLeaderTurns(server), 1);
    const second = await c.chatAndFinish(TAB_A, "and another");
    assert.ok(second.taken, "within 10 minutes the same session is not asked about again");

    claudeRecord(server, "ext-claude-1", Date.now() - 10_000);
    const again = await c.chat(TAB_A, "third");
    assert.ok(again.held, "a new outside session asks again");
    assert.deepEqual(again.answer.items.map((i: any) => i.tool), ["Claude Code"], "only the new one: the Codex session stays quiet");
    assert.equal(c.messages.some((m) => m.type === "chatMessage" && m.requestId === again.requestId), false);
    const sent = await c.chatAndFinish(TAB_A, "third", { confirmBusy: true });
    assert.ok(sent.taken);
    // A confirm with nothing shown snoozes nothing: a stranger that appears now still asks.
    opencodeRecord(server, "ext-oc-1", Date.now() - 5_000);
    const stranger = await c.chat(TAB_A, "fourth", { confirmBusy: true });
    assert.ok(stranger.held, "confirmBusy only quiets what this tab was shown last");
    assert.deepEqual(stranger.answer.items.map((i: any) => i.tool), ["OpenCode"]);
  });
});

test("user Run: held with the same warning, nothing launched; Continue anyway launches; the next Run is not asked; a Run on a seat that cannot be launched is not held", { timeout: testTimeoutMs(RUN_END_MS) }, async () => {
  await withServer({}, async (server, c) => {
    opencodeRecord(server, "ext-oc-1", Date.now() - 20_000);
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "build it" });
    const held = await c.wait(() => c.messages.find((m) => m.type === "folderBusy" && m.action === "run"), "the Run is held");
    assert.deepEqual([held.tabId, held.items.map((i: any) => i.tool)], [TAB_A, ["OpenCode"]]);
    await sleep(500);
    assert.equal(c.messages.some((m) => m.type === "runAccepted" || m.type === "runStart"), false, "nothing was launched");
    assert.equal(existsSync(join(server.work, "run-wrote.txt")), false, "the fake CLI never ran");
    assert.equal(c.tab(TAB_A).runs.length, 0);

    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "build it", confirmBusy: true });
    await c.wait(() => c.messages.find((m) => m.type === "runAccepted" && m.tabId === TAB_A), "Continue anyway launches");
    await c.wait(() => c.runEnds() >= 1, "the run ended", RUN_END_MS);
    assert.ok(existsSync(join(server.work, "run-wrote.txt")), "the fake CLI ran in the tab's folder");
    const accepted = c.messages.filter((m) => m.type === "runAccepted").length;
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "build more" });
    await c.wait(() => c.messages.filter((m) => m.type === "runAccepted").length > accepted, "the next Run goes straight through");
    assert.equal(c.messages.filter((m) => m.type === "folderBusy").length, 1, "asked once");
    // A leader slot cannot be launched as a worker: that refusal is the normal one, not a warning.
    codexRecord(server, "ext-codex-x", Date.now() - 5_000);
    c.send({ type: "run", tabId: TAB_A, slot: "leader", prompt: "x" });
    await c.wait(() => c.messages.find((m) => m.type === "error" && m.action === "run" && /leader/.test(m.message)), "the normal refusal");
    assert.equal(c.messages.filter((m) => m.type === "folderBusy").length, 1);
  });
});

test("a leader-started crew run is never held: it launches, and says once per outside session per 10 minutes that one is active", { timeout: testTimeoutMs(RUN_END_MS) }, async () => {
  await withServer({}, async (server, c) => {
    await c.chatAndFinish(TAB_A, "start the leader"); // no outside session yet
    const results = () => c.messages.filter((m) => m.type === "testGatedLaunchResult" && m.tabId === TAB_A);
    // The heads-up is a quiet chat line only: the page turns a chatNotice into a pop-up, so none may be sent for it.
    const notices = () => c.messages.filter((m) => m.type === "chatMessage" && m.role === "notice" && m.tabId === TAB_A && /Heads up/.test(m.text)).map((m) => ({ message: m.text }));
    const popups = () => c.messages.filter((m) => m.type === "chatNotice" && /Heads up/.test(m.message));
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "coder", brief: "quiet launch" });
    await c.wait(() => results()[0], "a launch with nothing outside");
    assert.equal(results()[0].ok, true);
    assert.equal(notices().length, 0, "no outside session, no notice");

    codexRecord(server, "ext-codex-2", Date.now() - 5_000);
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "coder", brief: "with an outsider" });
    await c.wait(() => results()[1], "the launch with an outsider");
    assert.equal(results()[1].ok, true, "never blocked");
    assert.deepEqual(notices().map((m) => m.message), ["Heads up: a Codex session outside Command Center is active in this folder."]);
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "coder", brief: "again" });
    await c.wait(() => results()[2], "the second launch");
    assert.equal(results()[2].ok, true);
    assert.equal(notices().length, 1, "once per outside session");
    assert.equal(popups().length, 0, "no pop-up for it");
    assert.equal(c.messages.some((m) => m.type === "folderBusy"), false, "a leader launch never asks");
    await c.wait(() => c.runEnds() >= 3, "the three runs ended", RUN_END_MS);
    // The heads-up is kept with that launch's notice (so it survives a reload and a new connection), once, and is not chat.
    const kept = (await client(server));
    try {
      const withHeadsUp = kept.state().launchSafety.notices.filter((n: any) => n.headsUp);
      assert.deepEqual(withHeadsUp.map((n: any) => [n.brief, n.headsUp]), [["with an outsider", "a Codex session outside Command Center is active in this folder"]], "only the launch that announced it carries it");
      // The heads-up is also a quiet line inside the tab's chat: saved with it (once), shown to a new connection, and never told to the leader.
      const line = "Heads up: a Codex session outside Command Center is active in this folder.";
      const live = c.messages.filter((m) => m.type === "chatMessage" && m.tabId === TAB_A && m.role === "notice");
      assert.deepEqual(live.map((m) => m.text), [line], "sent to the open page as a chat line");
      const saved = readFileSync(join(server.data, "chats", `${TAB_A}.jsonl`), "utf8").trim().split("\n").map((row) => JSON.parse(row)).filter((row) => row.role === "notice");
      assert.deepEqual(saved.map((row) => row.text), [line], "saved with the chat, so it survives a restart");
      const history = kept.messages.find((m) => m.type === "chatHistory" && m.tabId === TAB_A);
      assert.deepEqual(history.messages.filter((m: any) => m.role === "notice").map((m: any) => m.text), [line], "a new connection reads it back");
      assert.equal(readFileSync(join(server.temp, "fake-leader.log"), "utf8").includes("outside Command Center"), false, "never sent to the leader");
    } finally { kept.close(); }
  });
});

test("Command Center's own leader session never warns, also after a restart within 2 minutes; a stranger still does", { timeout: 120_000 }, async () => {
  const server = await boot();
  let second: Server | undefined;
  try {
    const c = await client(server);
    const started = await c.chatAndFinish(TAB_A, "start the leader"); // the fake Codex leader's thread is thread-1
    assert.ok(existsSync(join(server.data, "config", "own-sessions.json")), "the own-session registry was saved");
    // A record last written while that leader turn was running: only the turn's window can say it is ours.
    codexRecord(server, "written-during-the-turn", started.answer.at + 100);
    // Written far past every window of ours (30 s ahead), so only its id can say it is ours.
    codexRecord(server, "thread-1", Date.now() + 30_000);
    const own = await c.chatAndFinish(TAB_A, "second");
    assert.ok(own.taken, "our own leader's session record and a record written during its turn do not warn");
    codexRecord(server, "stranger-1", Date.now() + 30_000);
    const stranger = await c.chat(TAB_A, "third");
    assert.ok(stranger.held && stranger.answer.items.length === 1, `only the stranger: ${JSON.stringify(stranger.answer)}`);
    c.close();
    await server.stop(true);

    // The app is closed and reopened: the leader is gone, but its session is remembered.
    second = await boot({ temp: server.temp });
    const c2 = await client(second);
    assert.equal(c2.tab(TAB_A).leaderStatus, "not-started", "no leader has started yet: only the saved registry can know thread-1");
    const after = await c2.chat(TAB_A, "first message after the restart");
    assert.ok(after.held, "the stranger still warns");
    assert.equal(after.answer.items.length, 1, "and neither thread-1 (its saved id) nor the record written during the turn (its saved window) does");
    c2.close();
  } finally {
    await second?.stop();
    if (!second) await server.stop();
    else if (existsSync(server.temp)) removeWithRetry(server.temp);
  }
});

test("a crew run's own session (window by time) never warns, also after the run ended; one written after its window does", { timeout: testTimeoutMs(RUN_END_MS) }, async () => {
  await withServer({}, async (server, c) => {
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "work" });
    const started = await c.wait(() => c.messages.find((m) => m.type === "runStart" && m.tabId === TAB_A), "the run started");
    await c.wait(() => c.runEnds() >= 1, "the run ended", RUN_END_MS);
    assert.ok(existsSync(join(server.work, "run-wrote.txt")), "its CLI wrote a file into the folder");
    // The run's CLI session, last written during the run.
    codexRecord(server, "crew-run-session", started.startedAt + 300);
    await sleep(300);
    const ours = await c.chatAndFinish(TAB_A, "after the run");
    assert.ok(ours.taken, `the run's own record and its own file change do not warn: ${JSON.stringify(ours.answer)}`);
    codexRecord(server, "late-stranger", Date.now() + 30_000); // after the window and its slack
    const late = await c.chat(TAB_A, "next");
    assert.ok(late.held && late.answer.items.length === 1, "control: a record outside the window warns");
  });
});

const longRuns = { FAKE_RUN_SLEEP: "20" };
test("an outside session that was already running when our crew run started still warns (chat and leader heads-up); one created inside the run's window is taken as ours", { timeout: testTimeoutMs(runEndMs(longRuns.FAKE_RUN_SLEEP)) }, async () => {
  await withServer({ env: longRuns, tabs: (work) => [{ id: TAB_A, folder: work }, { id: TAB_B, name: "Design", folder: work }] }, async (server, c) => {
    await c.chatAndFinish(TAB_A, "start the leader");
    await sleep(11_000); // past the leader turn's window and its slack, so only the crew run's window is in play
    const early = Date.now();
    const files = [codexRecord(server, "ext-codex-before", early), claudeRecord(server, "ext-claude-before", early)];
    opencodeRecord(server, "ext-oc-before", early, early);
    await sleep(1_600); // the run's window opens clearly after these were created
    c.send({ type: "run", tabId: TAB_B, slot: "coder", prompt: "work" });
    await c.wait(() => c.messages.find((m) => m.type === "folderBusy" && m.action === "run" && m.tabId === TAB_B), "the Run is held for the outsiders");
    c.send({ type: "run", tabId: TAB_B, slot: "coder", prompt: "work", confirmBusy: true }); // held for the outsiders, so the person continues
    await c.wait(() => c.messages.find((m) => m.type === "runStart" && m.tabId === TAB_B), "the run in the other tab started");
    // The outsiders keep working inside the run's window; one more starts inside it (a crew CLI gives no id, so that one is taken as ours).
    for (const file of files) touch(file, Date.now());
    opencodeRecord(server, "ext-oc-before", Date.now(), early);
    codexRecord(server, "started-inside", Date.now());
    const held = await c.chat(TAB_A, "hello");
    assert.ok(held.held, `held, got ${JSON.stringify(held.answer)}`);
    assert.deepEqual(held.answer.items.filter((i: any) => !i.writer).map((i: any) => i.tool).sort(), ["Claude Code", "Codex", "OpenCode"], "all three already-running outsiders warn; the session created inside the window does not (one Codex, not two)");
    assert.equal(held.answer.items.filter((i: any) => i.writer).length, 1, "and the other tab's coder, as before");
    // A leader-started run says the same in its heads-up line.
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "reviewer1", brief: "with outsiders" });
    await c.wait(() => c.messages.find((m) => m.type === "testGatedLaunchResult" && m.tabId === TAB_A), "the launch");
    const line = c.messages.find((m) => m.type === "chatMessage" && m.role === "notice" && m.tabId === TAB_A && /Heads up/.test(m.text))?.text ?? "";
    assert.match(line, /a Codex session outside Command Center is active/);
    assert.match(line, /a Claude Code session outside Command Center is active/);
    assert.match(line, /an OpenCode session outside Command Center is active/);
    assert.equal(line.match(/Codex session/g)?.length, 1, "the session created inside the window is not announced");
    await c.wait(() => c.runEnds() >= 2, "the runs ended", runEndMs(longRuns.FAKE_RUN_SLEEP));
  });
});

const shortRuns = { FAKE_RUN_SLEEP: "7" };
test("another Command Center tab working on the same folder is not an outsider (its run and its file change warn only as that tab's writer)", { timeout: testTimeoutMs(runEndMs(shortRuns.FAKE_RUN_SLEEP)) }, async () => {
  await withServer({ env: shortRuns }, async (server, c) => {
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "long work" });
    await c.wait(() => c.messages.find((m) => m.type === "runStart" && m.tabId === TAB_A), "the run in the first tab started");
    await c.wait(() => existsSync(join(server.work, "run-wrote.txt")), "its CLI wrote a file");
    await sleep(600); // the watch event for that file arrives (late events are common)
    assert.equal(c.runEnds(), 0, "the first tab's run is still working");
    const seen = await c.busyProbe(TAB_B);
    assert.deepEqual(seen.map((i) => i.writer?.tabName), [TAB_A], "the second tab sees the first tab's coder and nothing outside");
    assert.ok((await c.chat(TAB_B, "from the other tab")).held, "the message is held for it");
    const other = await c.chatAndFinish(TAB_B, "from the other tab", { confirmBusy: true });
    assert.ok(other.taken, "Continue anyway sends it");
    await c.wait(() => c.runEnds() >= 1, "the run ended", runEndMs(shortRuns.FAKE_RUN_SLEEP));
  });
});

test("catch-all: a file written into the folder while none of our agents works there warns ('something outside'); Continue anyway sends it and quiets it for 10 minutes", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    assert.deepEqual(await c.busyProbe(TAB_A), [], "control: quiet before the write");
    writeFileSync(join(server.work, "outside-edit.txt"), "someone else");
    const seen = await c.busyUntil(TAB_A);
    assert.deepEqual(seen.map((i) => i.tool), [null]);
    const held = await c.chat(TAB_A, "hello");
    assert.ok(held.held, "the message is held");
    assert.deepEqual(held.answer.items.map((i: any) => i.tool), [null], "it cannot name the tool");
    assert.equal(c.tab(TAB_A).leaderStatus, "not-started");
    const sent = await c.chatAndFinish(TAB_A, "hello", { confirmBusy: true });
    assert.ok(sent.taken);
    writeFileSync(join(server.work, "outside-edit-2.txt"), "again");
    await sleep(700);
    const next = await c.chatAndFinish(TAB_A, "and again");
    assert.ok(next.taken, "the same catch-all is quiet for 10 minutes");
  });
});

test("our own windows end with the work: 12 s after a leader turn and a crew run, a file an outsider writes warns (nothing stays 'ours' for ever)", { timeout: testTimeoutMs(RUN_END_MS) }, async () => {
  await withServer({}, async (server, c) => {
    await c.chatAndFinish(TAB_A, "a leader turn");
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "work" });
    await c.wait(() => c.runEnds() >= 1, "the run ended", RUN_END_MS);
    await sleep(12_000); // a window still covers a late flush for 10 s after its work ended
    writeFileSync(join(server.work, "outsider.txt"), "someone else");
    assert.deepEqual((await c.busyUntil(TAB_A)).map((i) => i.tool), [null]);
  });
});
