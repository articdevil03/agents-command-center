// Pack 21 item 2, on a fixed crew: a job notice STORED in the chat by an older version (a Planner's brief handed to the leader) is still part of the leader's rebuilt
// context and of Save's history, as a line from "<planner> (Planner)". No job is created here: the tab starts with the stored notice already on disk.
// A real fixed server and the fake Codex leader (its log holds every prompt it was sent).
// JC2 the leader is told the FULL stored brief once, before its stored reply and without the plain notice, on its first turn and again after Stop,
// JC3 Save's history has it, JC4 the chat store keeps and checks the job field across reload and Clear+Undo.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fixedServer } from "./fixed-crew-execution-helpers.ts";
import { sleep } from "./pack18-harness.ts";
import { ChatStore } from "../server/chat-store.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

const PLANNER = "Sage", LEADER = "Leader", ID = "fixed", MARK = "BRIEF-MARK-P21", REPLY = "JOB-REPLY-P21", PLAIN = "PLAIN-NOTICE-P21";
// Longer than the 4000 characters a job notice shows, so the full-versus-cut difference is tested.
const BRIEF = JSON.stringify([{ reasoning: `${MARK} ${"p".repeat(4500)}` }, { say: REPLY }]);
type Fixture = Awaited<ReturnType<typeof fixedServer>>;
let f: Fixture;
before(async () => {
  f = await fixedServer({
    extra: (paths) => {
      // What an older version left in the chat: a plain notice, one job notice with the whole brief, and the leader's reply to it.
      const store = new ChatStore(join(paths.data, "chats"));
      store.appendMessage(ID, "notice", PLAIN);
      store.appendJobNotice(ID, `${PLANNER} handed ${LEADER} a job:\n${BRIEF.slice(0, 4000)}...`, { from: `${PLANNER} (Planner)`, brief: BRIEF });
      store.appendMessage(ID, "assistant", REPLY);
    },
  });
});
after(async () => { await f?.close(); });

const leaderPrompts = (): string[] => {
  const file = join(f.server.temp, "fake-leader.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.method === "turn/start").map((entry) => String(entry.params.input[0].text));
};
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
// What the user types, with confirmBusy so a folder heads-up never holds the message back.
async function userSays(message: string): Promise<void> {
  const before = f.c.messages.filter((m) => m.type === "chatDone" && m.tabId === ID).length;
  f.c.send({ type: "chat", tabId: ID, text: message, requestId: `p21-${Math.random().toString(36).slice(2, 10)}`, confirmBusy: true });
  await f.c.wait(() => f.c.messages.filter((m) => m.type === "chatDone" && m.tabId === ID).length > before, `user message "${message}" answered`, 30_000);
}
// The lines of the fenced chat a rebuilt leader is handed: [{ from, text }].
function fencedChat(prompt: string): { from: string; text: string }[] {
  const fence = /BEGIN-([0-9a-f]{24})\n([\s\S]*?)\nEND-\1/.exec(prompt);
  assert.ok(fence, `the prompt carries a fenced chat: ${prompt.slice(0, 300)}`);
  return fence![2]!.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
}
function assertStoredBrief(prompt: string, label: string): void {
  const lines = fencedChat(prompt);
  console.log(`${label}: fence lines: ${lines.map((line) => `${line.from}(${line.text.length})`).join(", ")}`);
  const plannerAt = lines.findIndex((line) => line.from === `${PLANNER} (Planner)`);
  const replyAt = lines.findIndex((line) => line.from === LEADER && line.text.includes(REPLY));
  assert.ok(plannerAt >= 0, `${label}: the fence has a line from the Planner`);
  assert.equal(lines[plannerAt]!.text, BRIEF, `${label}: its text is the full brief, not the cut one`);
  assert.ok(replyAt > plannerAt, `${label}: the leader's reply (line ${replyAt}) comes after the brief (line ${plannerAt})`);
  assert.equal(occurrences(prompt, MARK), 1, `${label}: the brief is told once`);
  const fenceText = JSON.stringify(lines);
  assert.equal(fenceText.includes(PLAIN), false, `${label}: a plain notice stays out of the fence`);
  assert.equal(fenceText.includes(`${PLANNER} handed ${LEADER} a job`), false, `${label}: the notice's own display text stays out of the fence`);
}

test("JC2 a stored job brief is told in full once to the leader on its first turn and again after Stop, as the Planner's line before the leader's reply", { timeout: 180_000 }, async () => {
  assert.ok(BRIEF.length > 4000, `the brief is ${BRIEF.length} characters, over the 4000 a notice shows`);
  await userSays("hi p21");
  assert.equal(f.c.messages.find((m) => m.type === "chatMessage" && m.tabId === ID && m.text === "hi p21")?.revision, 4, "the three stored messages (revisions 1 to 3) were loaded");
  const first = leaderPrompts().find((prompt) => prompt.includes("Current message:\nhi p21"));
  assert.ok(first, "the leader was sent the user's first message");
  assertStoredBrief(first!, "JC2 first turn");
  f.c.send({ type: "stopSeat", tabId: ID, slot: "leader" });
  await sleep(500);
  await userSays("after p21");
  const rebuilt = leaderPrompts().find((prompt) => prompt.includes("Current message:\nafter p21"));
  assert.ok(rebuilt, "the rebuilt leader was sent the user's message");
  assertStoredBrief(rebuilt!, "JC2 after Stop");
});

test("JC3 Save's history log holds the stored Planner brief and the leader's reply, and no plain notice", { timeout: 120_000 }, async () => {
  // The handover file is made newer than Save's start so the Save counts.
  const handover = join(f.server.work, ".command-center", ID, "RESUME.md");
  mkdirSync(dirname(handover), { recursive: true });
  writeFileSync(handover, "handover");
  const future = new Date(Date.now() + 60_000);
  utimesSync(handover, future, future);
  f.c.send({ type: "save", tabId: ID });
  await f.c.wait(() => f.c.messages.find((m) => m.type === "saved" && m.tabId === ID), "Save done", 60_000);
  const logs = join(f.server.data, "logs");
  const logName = readdirSync(logs).find((name) => name.startsWith(`${ID}.leader-`) && name.endsWith(".log"));
  assert.ok(logName, `Save left a history log in ${logs}`);
  const history = readFileSync(join(logs, logName!), "utf8");
  const briefAt = history.indexOf(`${PLANNER} (Planner): ${BRIEF}`), replyInHistory = history.indexOf(`${LEADER}: ${REPLY}`);
  console.log(`JC3: history log ${logName} has the Planner line at ${briefAt}, the reply at ${replyInHistory}`);
  assert.ok(briefAt >= 0, "the history holds the Planner's full brief");
  assert.ok(replyInHistory > briefAt, "the leader's reply follows it");
  assert.equal(history.includes(PLAIN), false, "a plain notice stays out of the history");
});

test("JC4 the chat store keeps a job notice across a reload and a Clear+Undo, and refuses a bad job field", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-p21-chat-"));
  try {
    const job = { from: `${PLANNER} (Planner)`, brief: "B".repeat(5000) };
    const store = new ChatStore(dir);
    const notice = store.appendJobNotice("alpha-tab", "Sage handed Atlas a job:\nB...", job);
    assert.deepEqual([notice.role, notice.job], ["notice", job]);
    assert.deepEqual(new ChatStore(dir).snapshot("alpha-tab").messages[0]?.job, job, "the job survives a reload from disk");
    const before = store.snapshot("alpha-tab");
    store.clear("alpha-tab");
    store.restore("alpha-tab", before);
    assert.deepEqual(new ChatStore(dir).snapshot("alpha-tab").messages[0]?.job, job, "the job survives Clear and Undo");
    assert.equal(new ChatStore(dir).appendMessage("alpha-tab", "user", "plain").job, undefined, "an ordinary message carries no job");
    assert.throws(() => store.appendJobNotice("alpha-tab", "x", { from: 1, brief: "b" } as any), /invalid job notice/);
    assert.throws(() => store.restore("alpha-tab", { ...before, messages: [{ ...before.messages[0]!, job: { from: "a", brief: 2 } as any }] }), /invalid transcript restore/);
    writeFileSync(join(dir, "bad-tab.jsonl"), `${JSON.stringify({ type: "message", tabId: "bad-tab", revision: 1, role: "notice", text: "t", job: { from: "a", brief: 2 }, at: 1 })}\n`);
    assert.throws(() => new ChatStore(dir).snapshot("bad-tab"), /invalid chat message/);
  } finally { removeWithRetry(dir); }
});
