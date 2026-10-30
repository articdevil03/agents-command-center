// Pack 12 (steer in chat), the server side through real servers, part 3: the OpenCode idle matrix and the fix-round cases.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { tabOf, sleep, fakeLog, reached, PAD, chatFile, withServer, unansweredNotices } from "./pack12-server-helpers.ts";

// Fix round 4: every order in which OpenCode's idles, a steer's answer and a steer's refusal can meet the usage lookup, through the real server and the real adapter.
// Each case ends with exactly `done` chatDone (one per turn), after the complete text in order, nothing after it, no chatError; a steer is in the chat once; the usage
// is the newest idle's own (one report per turn). Times are ms from the moment the first idle's lookup began (or from the first text, when there is no lookup delay).
// Usage tokens: the fake's run N reports 900 + (N - 1) * 1000 input + 100 cache, so 1000 / 2000 / 3000 for the first / second / third run.
type MatrixSteer = { text: string; at: number; posts: number; afterDupIdle?: boolean }; // afterDupIdle: posted when the fake logs its duplicate idle, not `at` ms in
type MatrixCase = {
  label: string; env: Record<string, string>; first: string; on: "lookup" | "text"; steers: MatrixSteer[]; dup: "before" | "after" | "only" | null;
  roles: string[]; answer: number; ordered: string[]; done: number; usage: number;
};
const LOOKUP = { FAKE_OPENCODE_PROVIDERS_DELAY_MS: "1500" }, FIRST = JSON.stringify([{ say: `first ${PAD}` }]);
const steps = (name: string, ms: number): string => JSON.stringify([{ say: `${name}-start ` }, { sleep: ms }, { say: `${name}-end!` }]); // ends in a character that is not a hex digit: a held-back tail that could start a secret would otherwise show up as its own row after a later steer
const FOUR = ["user", "assistant", "user", "assistant"];
const MATRIX: MatrixCase[] = [
  { label: "a: the duplicate idle arrives, then the steer is posted (lookup 1500 ms), the steered answer streams past the lookup", env: { ...LOOKUP, FAKE_OPENCODE_DUP_IDLE: "1" }, first: FIRST, on: "lookup",
    steers: [{ text: steps("a", 2500), at: 0, posts: 1, afterDupIdle: true }], dup: "before", roles: FOUR, answer: 3, ordered: ["a-start ", "a-end!"], done: 1, usage: 2000 },
  { label: "b: the steer is posted, then the duplicate idle (the fake sends it only after the steer arrived), the answer streams past the lookup", env: { ...LOOKUP, FAKE_OPENCODE_DUP_IDLE: "1", FAKE_OPENCODE_DUP_IDLE_AFTER_STEER: "1" }, first: FIRST, on: "lookup",
    steers: [{ text: steps("b", 2500), at: 0, posts: 1 }], dup: "after", roles: FOUR, answer: 3, ordered: ["b-start ", "b-end!"], done: 1, usage: 2000 },
  { label: "c (was fix 3b): the steer's own run ends DURING the lookup (200 ms): its idle is not lost, the usage is its run's", env: LOOKUP, first: FIRST, on: "lookup",
    steers: [{ text: steps("c", 200), at: 0, posts: 1 }], dup: null, roles: FOUR, answer: 3, ordered: ["c-start ", "c-end!"], done: 1, usage: 2000 },
  { label: "d (was fix 3 and 3c): the steer's own run ends AFTER the lookup (2500 ms): the turn stays open to its idle", env: LOOKUP, first: FIRST, on: "lookup",
    steers: [{ text: steps("d", 2500), at: 0, posts: 1 }], dup: null, roles: FOUR, answer: 3, ordered: ["d-start ", "d-end!"], done: 1, usage: 2000 },
  { label: "e: steer A answered and its idle in, then steer B posted and refused, all inside the lookup: the turn ends, B goes out as the next turn", env: LOOKUP, first: FIRST, on: "lookup",
    steers: [{ text: steps("e-a", 150), at: 0, posts: 1 }, { text: "REFUSE-ONCE e-b", at: 500, posts: 2 }], dup: null, roles: [...FOUR, "user", "assistant"], answer: 3, ordered: ["e-a-start ", "e-a-end!"], done: 2, usage: 3000 },
  { label: "e2: as e but B is refused only after the lookup returned (the idle waits for it, the refusal ends the turn)", env: LOOKUP, first: FIRST, on: "lookup",
    steers: [{ text: steps("e2-a", 150), at: 0, posts: 1 }, { text: "REFUSE-ONCE-SLOW e2-b", at: 500, posts: 2 }], dup: null, roles: [...FOUR, "user", "assistant"], answer: 3, ordered: ["e2-a-start ", "e2-a-end!"], done: 2, usage: 3000 },
  { label: "f: the steer is answered inside the first run: one idle for both", env: {}, first: JSON.stringify([{ say: `first ${PAD}` }, { sleep: 900 }, { say: "tail-end" }]), on: "text",
    steers: [{ text: JSON.stringify([{ say: "f-start " }, { say: "f-end " }]), at: 300, posts: 1 }], dup: null, roles: FOUR, answer: 3, ordered: ["f-start ", "f-end ", "tail-end"], done: 1, usage: 1000 },
  { label: "g: a refused steer alone (the first idle is held, the refusal ends the turn), the steer goes out as the next turn", env: {}, first: JSON.stringify([{ steerLate: "lateFail" }, { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]), on: "text",
    steers: [{ text: "STEER-G", at: 300, posts: 2 }], dup: null, roles: FOUR, answer: 3, ordered: ["opencode says hi to: STEER-G"], done: 2, usage: 2000 },
  { label: "h: no steer, a duplicate idle during the lookup: one usage, one chatDone", env: { ...LOOKUP, FAKE_OPENCODE_DUP_IDLE: "1" }, first: JSON.stringify([{ say: `first ${PAD}` }, { say: "h-end" }]), on: "lookup",
    steers: [], dup: "only", roles: ["user", "assistant"], answer: 1, ordered: ["first ", "h-end"], done: 1, usage: 1000 },
];
async function runMatrixCase(spec: MatrixCase): Promise<void> {
  await withServer(spec.env, async (server, c) => {
    const tab = tabOf("opencode", 1);
    await c.start(tab, spec.first);
    // The providers log line is written when the lookup request arrives (the first turn of a leader).
    if (spec.on === "lookup") await c.wait(() => fakeLog(server).some((entry) => entry.path === "/config/providers"), "the usage window lookup started");
    else await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    const began = Date.now();
    for (const steer of spec.steers) {
      if (steer.afterDupIdle) await c.wait(() => fakeLog(server).some((entry) => entry.dupIdle), "the duplicate idle went out before the steer");
      else await sleep(Math.max(0, steer.at - (Date.now() - began)));
      c.steer(tab, steer.text);
    }
    await c.finished(tab, spec.done, "the turn(s) end", 25_000);
    await sleep(900);
    assert.equal(c.done(tab), spec.done, "one chatDone per turn, none extra after the wait");
    assert.equal(c.failed(tab), 0, "no chatError");
    const rows = c.answers(tab);
    assert.deepEqual(rows.map((row) => row.role), spec.roles, JSON.stringify(rows));
    const text = rows[spec.answer]!.text;
    const at = spec.ordered.map((marker) => text.indexOf(marker));
    assert.ok(at.every((place, index) => place >= 0 && (index === 0 || place > at[index - 1]!)), `the whole text, in order: ${JSON.stringify(text)}`);
    assert.ok(text.endsWith(spec.ordered.at(-1)!), `nothing cut off, nothing after the end: ${JSON.stringify(text)}`);
    const log = fakeLog(server), dupAt = log.findIndex((entry) => entry.dupIdle);
    if (spec.dup === "after") {
      assert.ok(log.some((entry) => entry.dupIdleAfterSteer), "the gated duplicate was released after the steer");
      assert.equal(log.some((entry) => entry.dupIdleGaveUp), false, "the gated duplicate never gave up");
    }
    if (spec.on === "lookup") assert.equal(log.filter((entry) => entry.path === "/config/providers").length, 1, "overlapping idles share one providers read");
    if (spec.dup) assert.ok(dupAt >= 0, "the duplicate idle was sent");
    for (const steer of spec.steers) {
      assert.equal(rows.filter((row) => row.role === "user" && row.text === steer.text).length, 1, "the steer is in the chat once");
      assert.equal(log.filter((entry) => entry.path?.endsWith("/prompt_async") && String(entry.body?.parts?.[0]?.text).includes(steer.text)).length, steer.posts, "posted as many times as expected");
    }
    if (spec.dup === "before" || spec.dup === "after") {
      const postedAt = log.findIndex((entry) => entry.path?.endsWith("/prompt_async") && String(entry.body?.parts?.[0]?.text).includes(spec.steers[0]!.text));
      assert.ok(spec.dup === "before" ? dupAt < postedAt : postedAt < dupAt, `the order under test happened (dup at log line ${dupAt}, steer at ${postedAt})`);
    }
    const usage = c.tabState(tab).leaderUsage;
    assert.deepEqual([usage?.contextTokens, usage?.turns], [spec.usage, spec.done], "one usage report per turn, the newest idle's numbers");
  });
}
for (const spec of MATRIX) test(`fix 4r: OpenCode idle matrix, ${spec.label}`, { timeout: 60_000 }, () => runMatrixCase(spec));

test("fix 4: OpenCode, two steers where the second is refused after the first one's answer began: the turn still ends (once) and the refused one goes out as the next turn, once", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 2), a = "STEER-A-opencode", b = "STEER-B-opencode";
    await c.start(tab, JSON.stringify([{ steerLate: "failSecond" }, { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, a);
    await sleep(150);
    c.steer(tab, b);
    await c.finished(tab, 2, "the reply ends and the refused steer is answered as the next turn", 20_000);
    await sleep(300);
    assert.equal(c.done(tab), 2, "two turns, two chatDone, none stuck");
    assert.equal(c.failed(tab), 0);
    const rows = c.answers(tab);
    assert.ok(rows.some((row) => row.role === "assistant" && row.text.includes(`[steer: ${a}]`)), "the first steer was answered inside the reply");
    assert.equal(rows.filter((row) => row.text === b).length, 1, "the refused steer is in the chat once");
    assert.equal(rows.at(-1)!.text, `opencode says hi to: ${b}`, "and its answer comes last");
    assert.equal(chatFile(server, tab).filter((row) => row.text === b).length, 1);
    assert.equal(fakeLog(server).filter((entry) => entry.path?.endsWith("/prompt_async") && String(entry.body?.parts?.[0]?.text).includes(b)).length, 2, "posted as a steer (refused) and once more as a turn");
  });
});

test("fix 5: OpenCode, a secret only partly received is never shown when the reply is stopped (with a steer, and without one) or when the leader dies; the part is shown as [hidden]", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    // The fake logs the password when it sends the first half of it; `count` is how many such logs there should be by now.
    const half = async (count: number): Promise<string> => {
      await c.wait(() => fakeLog(server).filter((entry) => entry.leakHalfSecret).length >= count, "the fake sent the first half of the secret");
      return fakeLog(server).filter((entry) => entry.leakHalfSecret)[count - 1].leakHalfSecret;
    };
    const everythingOf = (tab: string) => JSON.stringify([c.messages.filter((m) => m.type !== "state" && m.tabId === tab), c.streamed(tab), chatFile(server, tab)]);
    // Stop after a steer.
    const steered = tabOf("opencode", 2);
    await c.start(steered, JSON.stringify([{ say: PAD }, { leakHalf: 8000 }]));
    const secret = await half(1);
    await sleep(300);
    const requestId = c.steer(steered, "STEER-THEN-STOP");
    await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), "the steer is taken");
    c.send({ type: "stopAll" });
    await c.wait(() => c.failed(steered) >= 1, "the stop ends the reply");
    await sleep(300);
    assert.equal(everythingOf(steered).includes(secret.slice(0, 8)), false, "stop after a steer: no part of the secret was shown, saved or broadcast");
    assert.ok(chatFile(server, steered).some((row) => row.role === "assistant" && row.text.includes("[hidden]")), "the held part was written as [hidden]");
    // Stop with no steer at all.
    const plain = tabOf("opencode", 3);
    await c.start(plain, JSON.stringify([{ say: PAD }, { leakHalf: 8000 }]));
    const secret2 = await half(2);
    await sleep(300);
    c.send({ type: "stopAll" });
    await c.wait(() => c.failed(plain) >= 1, "the stop ends the reply");
    await sleep(300);
    assert.equal(everythingOf(plain).includes(secret2.slice(0, 8)), false, "plain stop: no part of the secret was shown, saved or broadcast");
    assert.ok(chatFile(server, plain).some((row) => row.role === "assistant" && row.text.includes("[hidden]")), "plain stop: written as [hidden]");
    // The leader dies (its process ends) while the secret is half there.
    const dying = tabOf("opencode", 4);
    await c.start(dying, JSON.stringify([{ say: PAD }, { exitAfter: 1200 }, { leakHalf: 8000 }]));
    const secret3 = await half(3);
    await c.wait(() => c.failed(dying) >= 1, "the death ends the reply", 20_000);
    await sleep(300);
    assert.equal(everythingOf(dying).includes(secret3.slice(0, 8)), false, "death: no part of the secret was shown, saved or broadcast");
    assert.ok(chatFile(server, dying).some((row) => row.role === "assistant" && row.text.includes("[hidden]")), "death: written as [hidden]");
  });
});

test("fix 7: a second handed-back steer waiting behind the first one's resent turn: when that turn FAILS or is STOPPED the chat says so once; after a Clear it says nothing", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    const firstTurn = JSON.stringify([{ steerLate: "error" }, { say: "first " }, { sleep: 900 }, { say: "end " }]);
    const B = "STEER-B-WAITING";
    // Both steers are handed back by the CLI; the first turn succeeds; A goes out as the next turn, B waits behind it.
    const run = async (tab: string, a: string) => {
      await c.start(tab, firstTurn);
      await c.wait(() => c.streamed(tab).includes("first"), `${tab}: streaming`);
      c.steer(tab, a);
      c.steer(tab, B);
      await c.wait(() => c.done(tab) >= 1, `${tab}: the first turn ends`, 20_000);
      await c.wait(() => reached(server, "codex", a).some((item) => item.kind === "start"), `${tab}: A runs as the next turn`);
    };
    const failing = tabOf("codex", 1);
    await run(failing, JSON.stringify([{ sleep: 300 }, { error: "boom" }]));
    await c.wait(() => c.failed(failing) >= 1, "A's turn fails", 20_000);
    await sleep(500);
    assert.equal(unansweredNotices(c, failing).length, 1, "fail: one notice for the ended reply (not one per message)");
    assert.equal(reached(server, "codex", B).filter((item) => item.kind === "start").length, 0, "B was not sent on its own after the failure");

    const stopped = tabOf("codex", 2);
    await run(stopped, JSON.stringify([{ sleep: 5000 }, { say: "A-long-stop" }]));
    c.send({ type: "stopAll" });
    await c.wait(() => c.failed(stopped) >= 1, "the stop ends A's turn");
    await sleep(500);
    assert.equal(unansweredNotices(c, stopped).length, 1, "stop: one notice");
    assert.equal(reached(server, "codex", B).filter((item) => item.kind === "start").length, 0, "B was not sent on its own after the stop");

    const cleared = tabOf("codex", 3);
    await run(cleared, JSON.stringify([{ sleep: 5000 }, { say: "A-long-clear" }]));
    c.send({ type: "clear", tabId: cleared });
    await c.wait(() => c.failed(cleared) >= 1, "the clear ends A's turn");
    await sleep(500);
    assert.equal(unansweredNotices(c, cleared).length, 0, "clear: no notice");
    const lines = readFileSync(join(server.data, "chats", `${cleared}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.slice(lines.findLastIndex((row) => row.type === "clear") + 1), [], "nothing was written into the cleared chat");
  });
});

test("fix 8: Save clicked while a reply runs and a handed-back steer waits behind it: Save waits for the steer's turn too, then saves; nothing is sent twice", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("codex", 1), steerText = JSON.stringify([{ sleep: 600 }, { say: "A-done" }]);
    await c.start(tab, JSON.stringify([{ steerLate: "error" }, { say: "first " }, { sleep: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, steerText); // the CLI hands it back: it waits behind this reply
    // The fake CLI writes no handover, so the test plants one whose time is a minute ahead: the server only asks that the file is newer than the moment Save
    // started (which is taken after the steer's turn ends). A writer rewriting it every 2 ms could not do that under load: when the test process got no time
    // inside Save's few milliseconds the file was older and Save was refused (the folder is the test's own temp folder).
    const file = join(server.work, ".command-center", tab, "RESUME.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "handover");
    const ahead = new Date(Date.now() + 60_000); utimesSync(file, ahead, ahead);
    c.send({ type: "save", tabId: tab });
    try {
      await c.wait(() => c.messages.find((m) => m.type === "saved" && m.tabId === tab), "Save succeeds after the steer's turn", 30_000);
    } catch (error) {
      // Seen once under heavy load with nothing else to go on: say exactly what happened (what the client received, what reached the fake CLI).
      const types: string[] = [];
      for (const m of c.messages) { const t = `${m.type}${m.tabId && m.tabId !== tab ? `(${m.tabId})` : ""}`; if (types.at(-1)?.startsWith(`${t} x`) || types.at(-1) === t) types[types.length - 1] = `${t} x${(Number(types.at(-1)!.split(" x")[1]) || 1) + 1}`; else types.push(t); }
      const turns = fakeLog(server).filter((entry) => entry.cli === "codex" && entry.method === "turn/start").map((entry) => `${entry.at ?? ""} ${String(entry.params?.input?.[0]?.text).slice(0, 70)}`);
      assert.fail(`${error instanceof Error ? error.message : String(error)}
message types the client received, in order: ${types.join(", ")}
the fake CLI's turn/start log for this tab: ${JSON.stringify(turns)}
handover file mtime - now: ${statSync(file).mtimeMs - Date.now()} ms
server log tail: ${server.log().slice(-1500)}`);
    }
    assert.equal(c.messages.some((m) => m.type === "error" && m.action === "save"), false, "no Save failure was reported");
    const log = fakeLog(server).filter((entry) => entry.cli === "codex" && entry.method === "turn/start");
    const order = log.map((entry) => String(entry.params.input[0].text));
    assert.equal(order.filter((text) => text.includes("A-done")).length, 1, "the steer's turn started once");
    assert.equal(order.filter((text) => text.includes("Save a concise handover")).length, 1, "the handover prompt reached the CLI once");
    assert.ok(order.findIndex((text) => text.includes("A-done")) < order.findIndex((text) => text.includes("Save a concise handover")), "after the steer's turn");
    assert.equal(c.done(tab), 3, "the reply, the steer's turn and Save each ended once");
    assert.equal(c.answers(tab).filter((row) => row.text === steerText).length, 1, "the steer is in the chat once");
  });
});

test("fix 5b: at the end of a reply an end that only looks like the start of a secret is kept when it is short (3 characters of ordinary text) and hidden from 4 characters on", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 5);
    // Every OpenCode leader's secrets include the base64 of "opencode:<password>", which always starts with b3BlbmNvZGU6.
    await c.start(tab, JSON.stringify([{ say: `${PAD} ends b3B` }]));
    await c.finished(tab, 1, "the first reply ends");
    assert.ok(c.answers(tab).at(-1)!.text.endsWith(" ends b3B"), `3 characters are ordinary text: ${c.answers(tab).at(-1)!.text.slice(-20)}`);
    await c.start(tab, JSON.stringify([{ say: `${PAD} ends b3Bl` }]));
    await c.finished(tab, 2, "the second reply ends");
    const last = c.answers(tab).at(-1)!.text;
    assert.ok(last.endsWith(" ends [hidden]") && !last.includes("b3Bl"), `4 characters of a secret are hidden: ${last.slice(-20)}`);
  });
});
