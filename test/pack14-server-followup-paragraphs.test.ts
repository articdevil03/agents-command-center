// Pack 14 (the leader's steps, its background jobs, its own follow-up replies, and no more glued text), the server side through real servers, part 2: sections D Claude's own follow-up reply, E separate messages never glue together.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { sourceFiles, sourceText } from "./source-text.ts";
import { CLIS, type Cli, tabOf, sleep, SECRET, PAD, type Server, type Client, fakeLog, chatFile, withServer } from "./pack14-server-helpers.ts";

// ---- D: Claude's own follow-up reply ----

test("D: a background job finishing makes Claude answer by itself: that reply streams, counts as replying, is saved ONCE as a leader message, ends with ONE chatDone, and nothing is carried into the next reply", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 11), from = c.messages.length;
    await c.start(tab, JSON.stringify([{ say: "First answer." }, { followUp: [{ message: true }, { block: "thinking" }, { block: "text" }, { say: "Background job finished: all 5 images are ready." }], after: 400 }]));
    await c.finished(tab, 2, "the follow-up reply ends too");
    assert.equal(c.done(tab), 2, "one chatDone for the asked reply, one for the follow-up: no stray third");
    assert.deepEqual(c.answers(tab).map((row) => [row.role, row.role === "user" ? "(asked)" : row.text]), [["user", "(asked)"], ["assistant", "First answer."], ["assistant", "Background job finished: all 5 images are ready."]], "both replies are saved, once each, as leader messages");
    assert.equal(chatFile(server, tab).filter((row) => row.role === "assistant").length, 2, "and on disk");
    const firstDoneAt = c.messages.findIndex((m, i) => i >= from && m.type === "chatDone" && m.tabId === tab);
    const replyingAfter = c.messages.slice(firstDoneAt).find((m) => m.type === "state" && m.projects[0].tabs.find((t: any) => t.id === tab).derived.leaderTurnActive === true);
    assert.ok(replyingAfter, "after the first chatDone the state still said the tab was replying: that is the follow-up");
    assert.equal(replyingAfter.projects[0].tabs.find((t: any) => t.id === tab).derived.busy, true, "and busy");
    assert.ok(c.streamed(tab, from).includes("Background job finished"), "it streamed to the page");
    assert.deepEqual(c.labels(tab, from).filter((label) => label !== null).slice(-1), ["Thinking"], "the follow-up showed its step line");
    assert.equal(c.tabState(tab).derived.leaderTurnActive, false);
    // The next message is a clean reply: nothing of the follow-up is in it.
    await c.start(tab, JSON.stringify([{ say: "Second answer." }]));
    await c.finished(tab, 3, "the next reply ends");
    const rows = c.answers(tab).filter((row) => row.role === "assistant");
    assert.equal(rows.at(-1)!.text, "Second answer.", "nothing carried into the next reply");
    assert.equal(rows.length, 3);
  });
});

test("D: while Claude answers by itself the tab is busy everywhere: a chat message is refused as busy (the page queues it), a steer is refused, a folder change is refused, and Stop saves what was said", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 12);
    await c.start(tab, JSON.stringify([{ say: "First." }, { followUp: [{ say: "part A " }, { wait: 3000 }, { say: "part B" }], after: 200 }]));
    await c.wait(() => c.done(tab) === 1, "the asked reply ends");
    await c.wait(() => c.streamed(tab).includes("part A"), "the follow-up streams");
    assert.equal(c.tabState(tab).derived.leaderTurnActive, true);
    const from = c.messages.length;
    c.send({ type: "chat", tabId: tab, text: "DURING-FOLLOWUP", requestId: "p14during" });
    c.send({ type: "steer", tabId: tab, text: "STEER-DURING", requestId: "p14steer" });
    c.send({ type: "changeFolder", tabId: tab, folder: join(server.temp, "work2") });
    await c.wait(() => c.messages.slice(from).filter((m) => m.type === "error" || m.type === "steerRefused").length >= 3, "three refusals");
    const refused = c.messages.slice(from).filter((m) => m.type === "error" || m.type === "steerRefused");
    assert.ok(refused.some((m) => m.type === "error" && m.reason === "busy" && m.requestId === "p14during"), "the chat message is refused as busy, typed, so the page can queue it");
    assert.ok(refused.some((m) => m.type === "steerRefused" && m.reason === "unavailable" && /answering on its own/.test(m.message)), "a steer has nothing to join, and the page is told why");
    assert.ok(refused.some((m) => m.type === "error" && /busy/.test(m.message)), "the folder cannot change");
    assert.ok(!c.answers(tab).some((row) => row.text === "DURING-FOLLOWUP" || row.text === "STEER-DURING"), "and neither message was written to the chat");
    // Stop: what was said is kept, marked, the tab is free.
    c.send({ type: "stopAll" });
    await c.wait(() => c.failed(tab) >= 1, "Stop reports");
    await sleep(150);
    assert.equal(c.tabState(tab).derived.leaderTurnActive, false, "the tab is free");
    assert.ok(c.answers(tab).some((row) => row.role === "assistant" && row.text.startsWith("part A") && row.text.includes("(Stopped before it finished.)")), "the part said is kept, marked as cut short");
    await c.start(tab, JSON.stringify([{ say: "After the stop." }]));
    await c.finished(tab, 2, "a new message works");
    assert.equal(c.answers(tab).at(-1)!.text, "After the stop.");
  });
});

test("D: Claude dying during its own follow-up ends that reply with the error saved; a follow-up with no text still settles; a result with nothing open ends nothing", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    let tab = tabOf("claude", 13);
    await c.start(tab, JSON.stringify([{ say: "First." }, { followUp: [{ say: "half an answer" }, { wait: 5000 }], after: 200 }]));
    await c.wait(() => c.streamed(tab).includes("half an answer"), "the follow-up streams");
    server.child.send("end-query");
    await c.wait(() => c.failed(tab) >= 1, "the death reports");
    await sleep(150);
    assert.equal(c.tabState(tab).derived.leaderTurnActive, false, "the tab is free again");
    assert.ok(c.answers(tab).some((row) => row.role === "assistant" && row.text.startsWith("half an answer")), "what it said is saved with the error");
    // A follow-up that only runs a tool (no text): its step shows, it settles with one chatDone, and nothing is saved for it.
    tab = tabOf("claude", 14);
    const from = c.messages.length;
    await c.start(tab, JSON.stringify([{ say: "First." }, { followUp: [{ toolUse: { id: "f1", name: "Bash", input: { command: SECRET } } }, { toolResult: { id: "f1", output: SECRET } }], after: 200 }]));
    await c.finished(tab, 2, "the text-less follow-up settles");
    assert.deepEqual(c.answers(tab).filter((row) => row.role === "assistant").map((row) => row.text), ["First."], "no empty message is saved");
    assert.ok(c.labels(tab, from).includes("Running a command"), "its step line showed");
    // A result with no reply open at all (nothing was said, nothing ran) is not a stray chatDone.
    tab = tabOf("claude", 10);
    await c.start(tab, JSON.stringify([{ say: "First." }, { followUp: [], after: 200 }]));
    await c.finished(tab, 1, "the asked reply ends");
    await sleep(1200);
    assert.equal(c.done(tab), 1, "still one chatDone");
    assert.equal(c.tabState(tab).derived.leaderTurnActive, false);
  });
});

// ---- E: separate messages never glue together ----

// Two separate messages of one reply, per CLI: Claude two assistant messages (a tool between), Codex two agentMessage items, OpenCode two text parts.
const TWO: Record<Cli, (first: string, second: string) => string> = {
  claude: (first, second) => JSON.stringify([{ message: true }, { block: "text" }, { say: first }, { toolUse: { id: "g1", name: "Bash", input: { command: "x" } } }, { toolResult: { id: "g1" } }, { message: true }, { block: "text" }, { say: second }]),
  codex: (first, second) => JSON.stringify([{ say: first, item: "m1" }, { say: second, item: "m2" }]),
  opencode: (first, second) => JSON.stringify([{ say: first, part: "prt_ga" }, { say: second, part: "prt_gb" }]),
};
const saved = (c: Client, tab: string) => c.answers(tab).filter((row) => row.role === "assistant").map((row) => row.text);

test("E: two separate messages in one reply are separated by one blank line, in all three CLIs (saved text and streamed text agree)", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 7), from = c.messages.length;
      await c.start(tab, TWO[cli]("one in-game scene.", "Codex is drawing"));
      await c.finished(tab, 1, `${cli}: ends`);
      assert.deepEqual(saved(c, tab), ["one in-game scene.\n\nCodex is drawing"], `${cli}: one blank line between the messages`);
      assert.equal(c.streamed(tab, from), "one in-game scene.\n\nCodex is drawing", `${cli}: the page's draft reads the same`);
      assert.ok(!/one in-game scene\.Codex/.test(JSON.stringify(chatFile(server, tab))), `${cli}: control: never glued`);
    }
  });
});

test("E: a text that already ends with a newline gets no extra blank line; the first text of a reply and of the next reply get none; text in the same message is not split", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      let tab = tabOf(cli, 8);
      await c.start(tab, TWO[cli]("line one.\n", "line two"));
      await c.finished(tab, 1, `${cli}: ends`);
      assert.deepEqual(saved(c, tab), ["line one.\nline two"], `${cli}: it already ended with a newline`);
      // The next reply on the same tab starts with a message other than the last one of the first reply: still no leading blank line.
      await c.start(tab, cli === "claude" ? JSON.stringify([{ message: true }, { block: "text" }, { say: "Second reply." }]) : cli === "codex" ? JSON.stringify([{ say: "Second reply.", item: "m9" }]) : JSON.stringify([{ say: "Second reply.", part: "prt_gz" }]));
      await c.finished(tab, 2, `${cli}: the second reply ends`);
      assert.equal(saved(c, tab).at(-1), "Second reply.", `${cli}: a reply never starts with a blank line`);
      // One message said in pieces stays one run of text.
      tab = tabOf(cli, 9);
      await c.start(tab, JSON.stringify(cli === "claude" ? [{ message: true }, { block: "text" }, { say: "in " }, { say: "pieces" }] : cli === "codex" ? [{ say: "in pieces", item: "m5" }] : [{ say: "in pieces", part: "prt_gp" }]));
      await c.finished(tab, 1, `${cli}: pieces end`);
      assert.deepEqual(saved(c, tab), ["in pieces"], `${cli}: one message is not split`);
    }
  });
});

test("E: Claude marks a new message in two ways (a new assistant message, a new text block): each one alone starts a new paragraph", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 11);
    await c.start(tab, JSON.stringify([{ block: "text" }, { say: "block one." }, { block: "text" }, { say: "block two." }]));
    await c.finished(tab, 1, "text blocks end");
    assert.deepEqual(saved(c, tab), ["block one.\n\nblock two."], "a second text block, same message");
    await c.start(tab, JSON.stringify([{ message: true }, { say: "message one." }, { message: true }, { say: "message two." }]));
    await c.finished(tab, 2, "messages end");
    assert.equal(saved(c, tab).at(-1), "message one.\n\nmessage two.", "a second assistant message, no block start seen");
    // A sub-agent's own message start does not break the leader's text.
    await c.start(tab, JSON.stringify([{ message: true }, { say: "leader says " }, { message: true, parent: "zz" }, { toolUse: { id: "z1", name: "Bash", input: {}, parent: "zz" } }, { say: "more" }]));
    await c.finished(tab, 3, "sub-agent mix ends");
    assert.equal(saved(c, tab).at(-1), "leader says more", "a sub-agent's own message start is not a new message of the leader");
  });
});

test("E: after a steer splits the reply, the part after it never starts with a blank line (a saved message never does)", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 10);
      await c.start(tab, JSON.stringify([{ say: `part one ${PAD}`, ...(cli === "opencode" ? { part: "prt_sa" } : {}) }, cli === "claude" ? { wait: 900 } : { sleep: 900 }, { say: "part two", ...(cli === "opencode" ? { part: "prt_sb" } : cli === "codex" ? { item: "m2" } : {}) }]));
      await c.wait(() => c.streamed(tab).includes("part one"), `${cli}: streaming`);
      c.send({ type: "steer", tabId: tab, text: `STEER-${cli}`, requestId: `p14s-${cli}` });
      await c.finished(tab, 1, `${cli}: ends`);
      const assistant = c.answers(tab).filter((row) => row.role === "assistant");
      assert.ok(assistant.length >= 2, `${cli}: the reply was split by the steer`);
      for (const row of assistant) assert.ok(!/^\s*\n/.test(row.text), `${cli}: a saved message never starts with a blank line: ${JSON.stringify(row.text.slice(0, 20))}`);
    }
  });
});

// A secret cut in two, half at the end of one text part and the rest at the start of the NEXT part (the leader puts a paragraph break between them): redaction must still find it.
const SPLIT_FORMS = ["password", "token", "basic"] as const;
const splitSecret = async (server: Server, c: Client, index: number): Promise<string> => (await c.wait(() => fakeLog(server).filter((entry) => entry.splitSecret)[index], "the fake sent the first half of the secret")).splitSecret;
const everythingOf = (server: Server, c: Client, tab: string) => JSON.stringify([c.messages.filter((m) => m.type !== "state" && m.tabId === tab), c.streamed(tab), chatFile(server, tab)]);
const noPieceOf = (everything: string, secret: string, label: string) => { for (let at = 0; at + 8 <= secret.length; at++) assert.ok(!everything.includes(secret.slice(at, at + 8)), `${label}: no 8 character piece of the secret at ${at}`); };

test("E secret: a secret split across two text parts (the paragraph break between them) is hidden whole, in either half and in its Basic-auth form; the break itself still shows between ordinary parts", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const [index, form] of SPLIT_FORMS.entries()) {
      const tab = tabOf("opencode", index + 1);
      await c.start(tab, JSON.stringify([{ say: PAD }, { leakParts: { form } }]));
      await c.finished(tab, 1, `${form}: ends`);
      const secret = await splitSecret(server, c, index);
      noPieceOf(everythingOf(server, c, tab), secret, form);
      assert.deepEqual(saved(c, tab), [`${PAD}\n\nvisible-end \n\n[hidden] after`], `${form}: hidden, with the break between the parts and the secret's own [hidden] after it`);
      assert.equal(c.streamed(tab), `${PAD}\n\nvisible-end \n\n[hidden] after`, `${form}: the page's draft reads the same`);
    }
  });
});

test("E secret: the same split across two text parts with a steer between the halves, and with a Stop between them, never shows any piece of it", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const [index, form] of SPLIT_FORMS.entries()) {
      const tab = tabOf("opencode", index + 1);
      await c.start(tab, JSON.stringify([{ say: PAD }, { leakParts: { form, sleep: 1200 } }]));
      const secret = await splitSecret(server, c, index);
      await sleep(300);
      const requestId = `p14sec${index}`;
      c.send({ type: "steer", tabId: tab, text: `STEER-SECRET-${form}`, requestId });
      await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `${form}: the steer is taken`);
      await c.finished(tab, 1, `${form}: ends`);
      noPieceOf(everythingOf(server, c, tab), secret, `${form} with a steer`);
      assert.ok(c.answers(tab).map((row) => row.text).join("").includes("[hidden] after"), `${form}: hidden once complete`);
    }
    for (const [index, form] of SPLIT_FORMS.entries()) {
      const tab = tabOf("opencode", index + 4);
      await c.start(tab, JSON.stringify([{ say: PAD }, { leakParts: { form, sleep: 8000 } }]));
      const secret = await splitSecret(server, c, SPLIT_FORMS.length + index);
      await sleep(300);
      c.send({ type: "stopAll" });
      await c.wait(() => c.failed(tab) >= 1, `${form}: the stop ends the reply`);
      await sleep(300);
      noPieceOf(everythingOf(server, c, tab), secret, `${form} stopped`);
      assert.ok(chatFile(server, tab).some((row) => row.role === "assistant" && row.text.includes("[hidden]")), `${form}: the held first half was written as [hidden]`);
    }
  });
});

test("E sweep: every place a leader's text is joined is listed, and each adapter puts the paragraph break in before the text leaves it", () => {
  // The join points, from the real files (not a hand-picked set): every server/*.ts that hands text to onDelta, with how many calls, and what each does.
  const counts: Record<string, number> = {};
  for (const entry of sourceFiles().filter((file) => file.startsWith("server/") && file.endsWith(".ts"))) {
    const name = entry.slice("server/".length);
    const found = sourceText(entry).match(/\.onDelta\(/g)?.length ?? 0;
    if (found) counts[name] = found;
  }
  assert.deepEqual(counts, { "leader-acp.ts": 2, "leader-codex.ts": 1, "leader-opencode.ts": 2,"leader.ts": 1 }, "a new onDelta call site means a new join point: add it here and give it the paragraph break");
  const read = (name: string) => sourceText(`server/${name}`);
  assert.ok(read("leader.ts").includes("cb.onDelta(own ? paragraphs.text(event.delta.text, messageKey) : event.delta.text)"), "Claude: the leader's own text goes through the paragraph helper (a sub-agent's text is passed on as it always was)");
  assert.ok(read("leader-codex.ts").includes("cb.onDelta(paragraphs.text(params.delta, String(params.itemId ?? \"\")))"), "Codex: keyed by the agentMessage item");
  assert.ok(read("leader-opencode.ts").includes("emitDelta(p.delta, paragraphs.text(p.delta, String(p.partID)).length > p.delta.length)"), "OpenCode: keyed by the text part; the break is handed to the secret filter as a mark, never put into the text it searches (flushTail and flushSafeTail only release text that already went through it)");
  assert.ok(read("leader-acp.ts").includes("const shown = paragraphs.text(text, messageKey); emit(text, shown.slice(0, shown.length - text.length));"), "ACP: keyed by the message (a tool step or a thought starts the next one); the break is passed to emit as `gap`, so the secret filter decides it and drops it while a token may be in progress");
  // The server's own two joins: the reply text, and the strip at the start of a reply.
  const index = sourceText("server/index.ts");
  assert.equal((index.match(/leaderTurnText\.set\(tabId, \(leaderTurnText\.get\(tabId\) \?\? ""\) \+ text\)/g) ?? []).length, 1, "the server joins the reply text in one place");
  assert.ok(index.includes('const text = leaderTurnText.get(tabId) ? raw : raw.replace(/^\\n+/, "");'), "and strips blank lines only at the start of a reply (or of the part after a steer)");
});
