// Pack 21 item 2: the brief a Planner hands the leader is part of the leader's rebuilt context (after Stop) and of Save's history, as a line from "<planner> (Planner)".
// A real server, the fake planner CLI calling the real bridge, the fake Codex leader (its log holds every prompt it was sent).
// JC1 the job turn on a fresh leader tells the brief once, JC2 the rebuilt leader is told the FULL brief before its reply and no plain notice, JC3 Save's history has it,
// JC4 the chat store keeps and checks the job field.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { boot, client, sleep, type Client, type Server } from "./pack18-harness.ts";
import { seat, fakeClis, orchKit } from "./pack18-orch-harness.ts";
import { deriveSteps } from "../server/setup.ts";
import { ChatStore } from "../server/chat-store.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

const PLANNER = "Sage", LEADER = "Atlas", ID = "p21-a", MARK = "BRIEF-MARK-P21", REPLY = "JOB-REPLY-P21", PLAIN = "PLAIN-NOTICE-P21";
// Longer than the 4000 characters a job notice shows, so the full-versus-cut difference is tested.
const BRIEF = JSON.stringify([{ reasoning: `${MARK} ${"p".repeat(4500)}` }, { say: REPLY }]);
const crew = [
  seat("leader", LEADER, "Leader", "codex", "gpt-6-sol", "high", false),
  seat("planner", PLANNER, "Planner", "codex", "gpt-6-sol", "high", false, { orchestrates: true }),
  seat("s0", "Seat0", "Coder", "claude", "claude-sonnet-5-5[1m]", "medium", true),
];

let srv: Server, c: Client;
before(async () => {
  srv = await boot({
    fakeLeader: true,
    extra: (paths) => {
      fakeClis(paths);
      // A plain notice already in the chat (a heads-up): the control that notices stay out of the leader's context.
      writeFileSync(join(paths.data, "chats", `${ID}.jsonl`), `${JSON.stringify({ type: "message", tabId: ID, revision: 1, role: "notice", text: PLAIN, at: 1 })}\n`);
    },
    tabs: (work) => {
      mkdirSync(join(work, ID), { recursive: true });
      return [{ id: ID, name: ID, kind: "dev", folder: join(work, ID), setupName: "Jobs", crew, lookPause: false, steps: deriveSteps(crew as any, false) }];
    },
  });
  c = await client(srv);
});
after(async () => { c?.close(); await srv?.stop(); });

const { results, runPlanner, planDone, endedRuns } = orchKit(() => ({ srv, c }));
const text = (result: any) => JSON.parse(result.text);
const leaderPrompts = (): string[] => {
  const file = join(srv.temp, "fake-leader.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.method === "turn/start").map((entry) => String(entry.params.input[0].text));
};
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
// What the user types, with confirmBusy so a folder heads-up never holds the message back.
async function userSays(message: string): Promise<void> {
  const before = c.messages.filter((m) => m.type === "chatDone" && m.tabId === ID).length;
  c.send({ type: "chat", tabId: ID, text: message, requestId: `p21-${Math.random().toString(36).slice(2, 10)}`, confirmBusy: true });
  await c.wait(() => c.messages.filter((m) => m.type === "chatDone" && m.tabId === ID).length > before, `user message "${message}" answered`, 30_000);
}
// The lines of the fenced chat a rebuilt leader is handed: [{ from, text }].
function fencedChat(prompt: string): { from: string; text: string }[] {
  const fence = /BEGIN-([0-9a-f]{24})\n([\s\S]*?)\nEND-\1/.exec(prompt);
  assert.ok(fence, `the prompt carries a fenced chat: ${prompt.slice(0, 300)}`);
  return fence![2]!.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
}

test("JC1-3 a leader job's brief is told once on its own turn, in full to a rebuilt leader, and kept in Save's history", { timeout: 180_000 }, async () => {
  assert.ok(BRIEF.length > 4000, `the brief is ${BRIEF.length} characters, over the 4000 a notice shows`);
  await userSays("hi p21");
  assert.equal(c.messages.find((m) => m.type === "chatMessage" && m.tabId === ID && m.text === "hi p21")?.revision, 2, "the pre-written notice (revision 1) was loaded");
  c.send({ type: "stopSeat", tabId: ID, slot: "leader" });
  await sleep(500);

  // JC1: the fresh leader's job turn holds the brief once (the current message), not again in the fence.
  runPlanner(ID, [{ call: "launch_seat", args: { slot: "leader", brief: BRIEF }, save: "j" }, { call: "wait_for_runs", args: { runIds: ["{{RUN:j}}"], maxWaitSeconds: 60 } }]);
  await planDone(ID, 2);
  assert.equal(text(results(ID)[1]).runs[0].status, "done", results(ID)[1].text);
  const jobTurn = leaderPrompts().find((prompt) => prompt.includes("hands you a job"));
  assert.ok(jobTurn, "the leader was sent the job");
  const fenceOfJob = fencedChat(jobTurn!);
  console.log(`JC1: job turn holds the brief ${occurrences(jobTurn!, MARK)}x; its fence has ${fenceOfJob.length} lines: ${fenceOfJob.map((line) => line.from).join(", ")}`);
  assert.equal(occurrences(jobTurn!, MARK), 1, "the brief is told once on the job turn");
  assert.ok(fenceOfJob.some((line) => line.text === "hi p21"), "the fence holds the earlier chat (found)");

  // JC2: Stop, then the user writes: the rebuilt leader is told the whole brief, as the Planner's line, before its own reply.
  await endedRuns(ID, 1);
  c.send({ type: "stopSeat", tabId: ID, slot: "leader" });
  await sleep(500);
  await userSays("after p21");
  const rebuilt = leaderPrompts().find((prompt) => prompt.includes("Current message:\nafter p21"));
  assert.ok(rebuilt, "the rebuilt leader was sent the user's message");
  const lines = fencedChat(rebuilt!);
  console.log(`JC2: rebuilt fence lines: ${lines.map((line) => `${line.from}(${line.text.length})`).join(", ")}`);
  const plannerAt = lines.findIndex((line) => line.from === `${PLANNER} (Planner)`);
  const replyAt = lines.findIndex((line) => line.from === LEADER && line.text.includes(REPLY));
  assert.ok(plannerAt >= 0, "the fence has a line from the Planner");
  assert.equal(lines[plannerAt]!.text, BRIEF, "its text is the full brief, not the cut one");
  assert.ok(replyAt > plannerAt, `the leader's reply (line ${replyAt}) comes after the brief (line ${plannerAt})`);
  const fenceText = JSON.stringify(lines);
  assert.equal(fenceText.includes(PLAIN), false, "a plain notice stays out of the fence");
  assert.equal(fenceText.includes(`${PLANNER} handed ${LEADER} a job`), false, "the notice's own display text stays out of the fence");

  // JC3: Save's history log (the handover file is made newer than Save's start so the Save counts).
  const handover = join(srv.work, ID, ".command-center", ID, "RESUME.md");
  mkdirSync(dirname(handover), { recursive: true });
  writeFileSync(handover, "handover");
  const future = new Date(Date.now() + 60_000);
  utimesSync(handover, future, future);
  c.send({ type: "save", tabId: ID });
  await c.wait(() => c.messages.find((m) => m.type === "saved" && m.tabId === ID), "Save done", 60_000);
  const logs = join(srv.data, "logs");
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
