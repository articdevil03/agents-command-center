// The leader's ordinary reply on a fixed crew: a reply that streams in parts, a steer in the middle of it, and the owner's Stop. A real fixed server and the fake Codex leader.
// The retired leader-job tests (a Planner handing the leader a job, the queue behind a reply, the step guard) have no counterpart: the fixed crew has no job route.
// LO-steer the whole reply survives a steer, LO-stop Stop after a steer keeps the part split off before it, LO-stop-plain Stop ends a running reply and the leader can answer again.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { fixedServer } from "./fixed-crew-execution-helpers.ts";

type Fixture = Awaited<ReturnType<typeof fixedServer>>;
let f: Fixture;
before(async () => { f = await fixedServer(); });
after(async () => { await f?.close(); });

const ID = "fixed";
const say = (text: string) => JSON.stringify([{ say: text }]);
const deltas = () => f.c.messages.filter((m) => m.type === "chatDelta" && m.tabId === ID).map((m) => m.text).join("");
const active = () => f.c.tab(ID).derived?.leaderTurnActive;
const chatDones = () => f.c.messages.filter((m) => m.type === "chatDone" && m.tabId === ID).length;
const assistantText = () => f.c.messages.filter((m) => m.type === "chatMessage" && m.tabId === ID && m.role === "assistant").map((m) => m.text).join("\n");
const userChat = (steps: unknown[], tag: string) => f.c.send({ type: "chat", tabId: ID, text: JSON.stringify(steps), requestId: `${ID}-${tag}`, confirmBusy: true });
const steer = async (text: string, tag: string) => {
  f.c.send({ type: "steer", tabId: ID, text, requestId: `${ID}-${tag}` });
  await f.c.wait(() => f.c.messages.some((m) => m.type === "chatMessage" && m.requestId === `${ID}-${tag}`), `${tag}: steer accepted`);
};

test("LO-steer the leader's whole reply survives a steer, in order, with the steer answered", { timeout: 90_000 }, async () => {
  const before = chatDones();
  userChat([{ say: "PART-ONE" }, { sleep: 4000 }, { say: "PART-TWO" }], "steer");
  await f.c.wait(() => active() && deltas().includes("PART-ONE"), "first part streamed while the reply is running");
  await steer(say("STEER-ACK"), "steer-ack");
  await f.c.wait(() => chatDones() > before && !active(), "the reply ended", 60_000);
  const reply = `${deltas()}\n${assistantText()}`;
  assert.ok(reply.includes("PART-ONE") && reply.includes("PART-TWO"), `both parts reached the chat: ${reply}`);
  assert.ok(reply.indexOf("PART-ONE") < reply.indexOf("PART-TWO"), "in order");
  assert.ok(reply.includes("STEER-ACK"), `the steer was answered: ${reply}`);
});

test("LO-stop the owner's Stop after a steer still keeps the part streamed before it, and ends the reply long before its sleep", { timeout: 90_000 }, async () => {
  const began = Date.now();
  userChat([{ say: "STOP-PART-ONE" }, { sleep: 30_000 }], "stop");
  await f.c.wait(() => active() && deltas().includes("STOP-PART-ONE"), "first part streamed");
  await steer(JSON.stringify([{ sleep: 30_000 }, { say: "never-a" }]), "stop-steer");
  f.c.send({ type: "stopSeat", tabId: ID, slot: "leader" });
  await f.c.wait(() => !active(), "the owner's Stop ended the reply", 20_000);
  assert.ok(Date.now() - began < 25_000, `ended at ${Date.now() - began} ms, well before the 30 s sleep`);
  assert.ok(deltas().includes("STOP-PART-ONE"), "the part streamed before the Stop survives");
  assert.equal(`${deltas()}\n${assistantText()}`.includes("never-a"), false, "the steered reply never ran");
  console.log(`LO-stop: Stop ended the reply after ${Date.now() - began} ms`);
});

test("LO-stop-plain Stop ends a running reply, and the leader answers the next message", { timeout: 90_000 }, async () => {
  userChat([{ sleep: 15_000 }, { say: "never-b" }], "plain");
  await f.c.wait(() => active(), "the reply is running");
  const began = Date.now();
  f.c.send({ type: "stopSeat", tabId: ID, slot: "leader" });
  await f.c.wait(() => !active(), "Stop ended the reply", 20_000);
  assert.ok(Date.now() - began < 14_000, `ended at ${Date.now() - began} ms, well before its 15 s`);
  assert.equal(`${deltas()}\n${assistantText()}`.includes("never-b"), false, "the stopped reply never finished");
  const before = chatDones();
  userChat([{ say: "AFTER-STOP" }], "after");
  await f.c.wait(() => chatDones() > before && deltas().includes("AFTER-STOP"), "the leader answered after the Stop", 30_000);
});
