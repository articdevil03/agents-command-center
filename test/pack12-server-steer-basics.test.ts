// Pack 12 (steer in chat), the server side through real servers, part 1: a steer into a running reply on each CLI, the end-of-turn races, and the sweep of the steer call sites.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { sourceText } from "./source-text.ts";
import { CLIS, tabOf, sleep, ECHO, slow, fakeLog, reached, PAD, HEAD, promptCount, chatFile, upload, withServer } from "./pack12-server-helpers.ts";

test("steer in the middle of a reply, on each CLI: the CLI gets a steer (not a turn), the chat reads [user][reply so far][steer][rest], one chatDone", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 1), text = `STEER-MID-${cli}`;
      await c.start(tab, slow(cli, HEAD, "part two"));
      await c.wait(() => c.streamed(tab).includes(cli === "opencode" ? "part one" : HEAD), `${cli}: the first part streamed`);
      const requestId = c.steer(tab, text);
      await c.finished(tab, 1, `${cli}: the reply ends`);
      assert.equal(c.done(tab), 1, `${cli}: one chatDone for the reply and its steer: ${JSON.stringify(c.messages.filter((m) => m.tabId === tab && m.type !== "state").map((m) => [m.type, m.role, m.text ?? m.message]))}`);
      assert.equal(c.failed(tab), 0);
      const rows = c.answers(tab);
      assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "user", "assistant"], `${cli}: ${JSON.stringify(rows)}`);
      // OpenCode's filter holds back the end of what it said until later: that part is written after the steer.
      if (cli === "opencode") assert.ok(rows[1]!.text.length > 0 && HEAD.startsWith(rows[1]!.text), `${cli}: the reply so far was written down at the steer: ${rows[1]!.text}`);
      else assert.equal(rows[1]!.text, HEAD, `${cli}: the reply so far was written down at the steer`);
      assert.equal(rows[1]!.split, true, "and marked, so the page drops its draft");
      assert.deepEqual([rows[2]!.text, rows[2]!.requestId], [text, requestId]);
      assert.match(rows[3]!.text, ECHO[cli](text), `${cli}: the rest of the reply answers the steer`);
      assert.ok(rows[3]!.text.includes("part two"), `${cli}: and carries the rest`);
      // The OpenCode fake says "part two" in another text part than the steer's answer: pack 14 puts a paragraph break between separate parts, so line breaks are not compared here.
      assert.equal((rows[1]!.text + rows[3]!.text.replace(ECHO[cli](text), "")).replaceAll("\n", ""), HEAD + "part two", `${cli}: nothing lost, nothing doubled`);
      assert.equal(chatFile(server, tab).filter((row) => row.role === "user" && row.text === text).length, 1, `${cli}: the steer is in the chat file once`);
      const seen = reached(server, cli, text);
      assert.deepEqual(seen.map((item) => item.kind), ["steer"], `${cli}: the steer text reached the CLI once, as a steer: ${JSON.stringify(seen)}`);
      if (cli === "opencode") assert.equal(promptCount(server) >= 2, true);
    }
  });
});

test("a steer with an image and a file: they travel with it, the file as the usual suffix, and the chat row keeps both", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 3), text = `STEER-FILES-${cli}`;
      const image = upload(server, `paste-${randomUUID()}.png`), file = upload(server, `file-${randomUUID()}.txt`);
      await c.start(tab, slow(cli, HEAD, "part two"));
      await c.wait(() => c.streamed(tab).includes(cli === "opencode" ? "part one" : HEAD), `${cli}: streaming`);
      c.steer(tab, text, { images: [image], files: [file] });
      await c.finished(tab, 1, `${cli}: ends`);
      const row = c.answers(tab).find((item) => item.role === "user" && item.text === text)!;
      assert.deepEqual(row.files, [file], `${cli}: the row keeps the file`);
      const seen = reached(server, cli, text);
      assert.equal(seen.length, 1, `${cli}: once`);
      assert.equal(seen[0]!.kind, "steer");
      if (cli === "codex") assert.deepEqual(seen[0]!.images, [image], "the image is a localImage item of the steer");
      if (cli === "claude") assert.equal(fakeLog(server).find((entry) => entry.cli === "claude" && String(entry.userText).includes(text))!.imageBlocks, 1, "the image reaches the CLI as an image block of the steer");
      const sent = fakeLog(server).find((entry) => (entry.method === "turn/steer" && entry.params.input[0].text.includes(text)) || (entry.userText ?? "").includes(text) || (entry.path?.endsWith("/prompt_async") && entry.body?.parts?.[0]?.text?.includes(text)));
      const sentText = String(sent.userText ?? sent.params?.input?.[0]?.text ?? sent.body?.parts?.[0]?.text);
      assert.ok(sentText.includes(`Attached files. Read these local paths if they are useful:\n- ${file}`), `${cli}: ${sentText}`);
      assert.ok(!sentText.includes("Before replying, first read the existing handover"), "never the handover wrapper");
      if (cli === "opencode") assert.equal(fakeLog(server).filter((entry) => entry.path?.endsWith("/prompt_async") && entry.body?.parts?.[0]?.text?.includes(text)).every((entry) => entry.body.parts.some((part: any) => part.type === "file")), true, "the image is a file part");
    }
  });
});

test("race a: the reply ended before the steer arrived, so it is a normal message (a new turn, appended once)", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 2), text = JSON.stringify([{ say: `answer STEER-AFTER-${cli}` }]);
      await c.start(tab, JSON.stringify([{ say: `first-${cli}` }]));
      await c.finished(tab, 1, `${cli}: the first reply ends`);
      const requestId = c.steer(tab, text);
      await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `${cli}: taken`);
      await c.finished(tab, 2, `${cli}: the second reply ends`);
      assert.equal(c.messages.some((m) => m.type === "steerRefused" && m.requestId === requestId), false);
      assert.deepEqual(c.answers(tab).map((row) => row.role), ["user", "assistant", "user", "assistant"], cli);
      assert.equal(chatFile(server, tab).filter((row) => row.text === text).length, 1, `${cli}: once in the chat`);
      const seen = reached(server, cli, text);
      assert.deepEqual(seen.map((item) => item.kind), ["start"], `${cli}: it reached the CLI as a normal turn, never as a steer: ${JSON.stringify(seen)}`);
    }
  });
});

test("race b, Claude: a steer the CLI queues behind the running turn keeps the turn open: one chatDone after the last answer, nothing dropped, nothing leaking", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 4), text = JSON.stringify([{ say: "STEER-ANSWER-claude" }]);
    await c.start(tab, JSON.stringify([{ noFold: true }, { say: "first " }, { wait: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, text);
    await c.finished(tab, 1, "the turn and the queued steer are answered");
    await sleep(600);
    assert.equal(c.done(tab), 1, "one chatDone, not one per CLI result");
    const rows = c.answers(tab);
    assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "user", "assistant"], JSON.stringify(rows));
    assert.ok(rows[3]!.text.includes("end ") && rows[3]!.text.includes("STEER-ANSWER-claude"), `both the rest of the reply and the steer's answer are kept: ${rows[3]!.text}`);
    assert.deepEqual(reached(server, "claude", "STEER-ANSWER-claude").map((item) => item.kind), ["steer"], "the CLI had it while the first turn was open");
    await c.start(tab, "next-message");
    await c.finished(tab, 2, "the next turn works");
    assert.ok(!c.answers(tab).at(-1)!.text.includes("STEER-ANSWER"), "no text of the old turn leaked into the next");
  });
});

test("race b, Codex: turn/steer answered 'no active turn' after the turn ended (or while it still runs): the message goes out as the next turn, once, never appended twice", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const [mode, n] of [["complete", 4], ["error", 5]] as const) {
      const tab = tabOf("codex", n), text = `STEER-LATE-${mode}`;
      await c.start(tab, JSON.stringify([{ steerLate: mode }, { say: "first " }, { sleep: 900 }, { say: "end " }]));
      await c.wait(() => c.streamed(tab).includes("first"), `${mode}: streaming`);
      c.steer(tab, text);
      await c.finished(tab, 2, `${mode}: the reply and the resent steer both end`);
      await sleep(300);
      assert.equal(c.done(tab), 2, `${mode}: two turns, two chatDone`);
      const rows = c.answers(tab);
      const expectedRoles = mode === "complete" ? ["user", "assistant", "user", "assistant"] : ["user", "assistant", "user", "assistant", "assistant"];
      assert.deepEqual(rows.map((row) => row.role), expectedRoles, `${mode}: ${JSON.stringify(rows)}`);
      assert.equal(rows.filter((row) => row.text === text).length, 1, `${mode}: the steer is in the chat once`);
      assert.equal(rows.at(-1)!.text, `codex says hi to: ${text}`, `${mode}: and its answer comes last`);
      if (mode === "error") assert.equal(rows[3]!.text, "end ", "the running turn's own rest stays before the steer's answer");
      assert.equal(chatFile(server, tab).filter((row) => row.text === text).length, 1);
      assert.deepEqual(reached(server, "codex", text).map((item) => item.kind), ["steer", "start"], `${mode}: tried as a steer once, then sent as a turn once`);
    }
  });
});

test("race b, OpenCode: a steer that starts a second run (its own idle) stays in the same turn; a refused prompt is resent as the next turn", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    // Twice: the first run's end carries token counts (the idle waits for the context window) and, on the other tab, none (the idle ends the turn at once).
    for (const [n, noTokens] of [[4, false], [6, true]] as const) {
      const late = tabOf("opencode", n), lateText = `STEER-LATE-opencode-${n}`;
      await c.start(late, JSON.stringify([{ steerLate: "late" }, ...(noTokens ? [{ noTokens: true }] : []), { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]));
      await c.wait(() => c.streamed(late).includes("first"), "late: streaming");
      c.steer(late, lateText);
      await c.finished(late, 1, "late: the turn ends");
      await sleep(600);
      assert.equal(c.done(late), 1, "one chatDone although OpenCode went idle twice");
      const rows = c.answers(late);
      assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "user", "assistant"], JSON.stringify(rows));
      assert.ok(rows[3]!.text.endsWith(`opencode says hi to: ${lateText}`), `the second run's text was not dropped: ${rows[3]!.text}`);
      assert.equal(reached(server, "opencode", lateText).length, 1, "the prompt was posted once");
    }

    const fail = tabOf("opencode", 5), failText = "STEER-FAIL-opencode";
    await c.start(fail, JSON.stringify([{ steerLate: "fail" }, { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(fail).includes("first"), "fail: streaming");
    c.steer(fail, failText);
    await c.finished(fail, 2, "fail: the reply and the resent steer end");
    await sleep(300);
    assert.equal(c.done(fail), 2);
    const failRows = c.answers(fail);
    assert.equal(failRows.filter((row) => row.text === failText).length, 1, "the steer is in the chat once");
    assert.equal(failRows.at(-1)!.text, `opencode says hi to: ${failText}`);
    assert.equal(chatFile(server, fail).filter((row) => row.text === failText).length, 1);
  });
});

test("race c: a chat that meets a running reply comes back typed (reason busy, its request id), appends nothing, and the reply is untouched", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 7);
      await c.start(tab, slow(cli, HEAD, "part two"));
      await c.wait(() => c.streamed(tab).includes(cli === "opencode" ? "part one" : HEAD), `${cli}: streaming`);
      c.send({ type: "chat", tabId: tab, text: `COLLIDES-${cli}`, requestId: `busy${cli}` });
      const refusal = await c.wait(() => c.messages.find((m) => m.type === "error" && m.requestId === `busy${cli}`), `${cli}: the typed refusal`);
      assert.deepEqual([refusal.action, refusal.reason, refusal.tabId], ["chat", "busy", tab]);
      assert.match(refusal.message, /leader is still answering/);
      await c.finished(tab, 1, `${cli}: the reply ends`);
      assert.deepEqual(c.answers(tab).map((row) => row.role), ["user", "assistant"], `${cli}: nothing was appended for the refused chat`);
      assert.equal(reached(server, cli, `COLLIDES-${cli}`).length, 0);
    }
  });
});

test("the sweep: every leader implementation has steer, sendLeaderTurn has exactly the call sites this file knows, and steerLeaderTurn never starts a turn itself", () => {
  const read = (path: string) => sourceText(path);
  for (const [file, pattern] of [["server/leader.ts", /return \{ send, steer, stop,/], ["server/leader-codex.ts", /return \{ send, steer, stop,/], ["server/leader-opencode.ts", /return \{ send, steer, stop,/]] as const) {
    assert.match(read(file), pattern, `${file} returns a steer`);
  }
  assert.match(read("server/leader-common.ts"), /steer: \(text: string, images: string\[\]\) => boolean;/);
  const index = sourceText("server/index.ts");
  // The definition, then the places that start a turn: a normal chat, Save, the planner's leader job, and the resend of a steer the CLI handed back.
  const calls = index.split("\n").map((line, at) => ({ line: line.trim().replace(/^export /, ""), at })).filter(({ line }) => /\bsendLeaderTurn\(/.test(line) && !line.startsWith("//"));
  assert.deepEqual(calls.map(({ line }) => line.slice(0, 68)).sort(), [
    "const turn = sendLeaderTurn(tabId, text, [], [], noticeRevision, onR",
    "function sendLeaderTurn(tabId: string, text: string, images: string[",
    "const turn = sendLeaderTurn(tabId, `Save a concise handover of this ",
    "void sendLeaderTurn(tabId, steer.text, steer.images).catch((err) => ",
    "void sendLeaderTurn(message.tabId, message.text, images, files, user",
  ].sort(), "a new sendLeaderTurn call site needs its own handling of a running reply");
  const steerStart = index.indexOf("function steerLeaderTurn(");
  const body = index.slice(steerStart, index.indexOf("\n}\n", steerStart) + 2);
  assert.ok(body.length > 200 && !body.includes("sendLeaderTurn("), "steerLeaderTurn never starts a turn (the no-turn case is acceptChat)");
  assert.ok(body.includes("live.steer("), "and it steers through the leader handle");
  assert.equal(index.split("\n").filter((line) => line.includes("onSteerMissed:")).length, 1, "the tab hands a missed steer back in one place");
  // Every way a steered reply can end without an answer says so: a failed finish and a Stop both write the notice (a Clear empties the chat and does not).
  const finish = index.slice(index.indexOf("function finishLeaderTurn("), index.indexOf("function noteUnansweredSteer("));
  const stop = index.slice(index.indexOf("function stopLeaderSession("), index.indexOf("// Runs when an answer ends"));
  assert.ok(finish.includes("(steeredTurns.delete(tabId) || waitingBehind) && failed) noteUnansweredSteer(tabId)"), "a failed reply notes an unanswered steer, also one waiting behind it in lateSteers");
  assert.ok(stop.includes("(steeredTurns.has(tabId) || waitingBehind) && !clearUsage) noteUnansweredSteer(tabId)"), "a stopped reply notes an unanswered steer, also one waiting behind it in lateSteers");
  assert.ok(index.includes("steeredTurns.add(tabId)"), "and a taken steer marks its reply");
  // No steer path ends silently in an adapter: the Claude and OpenCode leaders no longer carry a 'forgotten' simplification.
  for (const file of ["server/leader.ts", "server/leader-opencode.ts"]) assert.equal(/ponytail:[^\n]*steer/i.test(read(file)), false, `${file} has no ponytail note about a steer left unhandled`);
});
