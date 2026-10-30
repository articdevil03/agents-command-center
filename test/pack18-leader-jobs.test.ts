// Pack 18 follow-up: the Planner hands a step the leader owns to the leader. launch_seat on the leader's slot, called by the seat that runs the process, is a "leader job":
// one turn of the leader's chat, whose reply wait_for_runs gives back. A real server, the fake planner CLI calling the real bridge, the fake Codex leader.
// LJ1 every crew shape from the real role list, LJ2 the step guard and the queue behind a running reply, LJ3 the leader's Stop, LJ4 a queued job whose planner ended.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { boot, client, sleep, RUN_END_MS, type Client, type Server } from "./pack18-harness.ts";
import { seat, fakeClis, orchKit } from "./pack18-orch-harness.ts";
import { ROLES, deriveSteps } from "../server/setup.ts";

const PLANNER = "Sage", LEADER = "Atlas";
const members = (roles: string[]) => [
  seat("leader", LEADER, "Leader", "codex", "gpt-6-sol", "high", false),
  seat("planner", PLANNER, "Planner", "codex", "gpt-6-sol", "high", false, { orchestrates: true }),
  ...roles.map((role, i) => seat(`s${i}`, `Seat${i}`, role, "claude", "claude-sonnet-5-5[1m]", "medium", ROLES.find((item) => item.name === role)!.canWrite)),
];
const tabWith = (work: string, id: string, roles: string[]) => {
  mkdirSync(join(work, id), { recursive: true });
  const crew = members(roles);
  return { id, name: id, kind: "dev", folder: join(work, id), setupName: "Jobs", crew, lookPause: false, steps: deriveSteps(crew as any, false) };
};
// The steps the leader owns: a work step it is an owner of, and the review step when any round's reviewer or fixer is the leader.
const leaderOwned = (roles: string[]): string[] => deriveSteps(members(roles) as any, false)
  .filter((step: any) => step.type === "work" ? step.owners.includes("leader") : step.type === "rounds" && step.pairs.some((pair: any) => pair.reviewer === "leader" || pair.fixers.includes("leader")))
  .flatMap((step: any) => step.type === "rounds" ? [
    ...(step.pairs.some((pair: any) => pair.reviewer === "leader") ? [`${step.id}:reviewer`] : []),
    ...(step.pairs.some((pair: any) => pair.fixers.includes("leader")) ? [`${step.id}:fixer`] : []),
  ] : [step.id]);

// LJ1's tabs: every subset of the roles except Planner, deduped by the set of steps the leader owns (a set with none is the control).
const OTHER_ROLES = ROLES.map((role) => role.name).filter((name) => name !== "Planner");
const SETS = new Map<string, { roles: string[]; owned: string[] }>();
for (let mask = 0; mask < 1 << OTHER_ROLES.length; mask++) {
  const roles = OTHER_ROLES.filter((_, bit) => mask & (1 << bit));
  const owned = leaderOwned(roles);
  if (!SETS.has(owned.join(","))) SETS.set(owned.join(","), { roles, owned });
}
const WITH_JOBS = [...SETS.values()].filter((set) => set.owned.length), CONTROL = [...SETS.values()].find((set) => !set.owned.length)!;
const lj1Id = (index: number) => `lj1-${index}`;

let srv: Server, c: Client;
before(async () => {
  srv = await boot({
    fakeLeader: true, extra: fakeClis,
    tabs: (work) => [...WITH_JOBS.map((set, i) => tabWith(work, lj1Id(i), set.roles)), tabWith(work, "lj1-control", CONTROL.roles),
      tabWith(work, "lj2", ["Coder"]), tabWith(work, "lj3", ["Coder"]), tabWith(work, "lj4", ["Coder"]),
      tabWith(work, "lj-steer", ["Coder"]), tabWith(work, "lj-guard", ["Reviewer"]), tabWith(work, "lj-guard-final", ["Coder"]),
      tabWith(work, "ljs-leader", ["Coder"]), tabWith(work, "ljs-planner", ["Coder"]),
      tabWith(work, "ljs-self", ["Coder"]), { ...tabWith(work, "ljs-self-alone", ["Coder"]), crew: members(["Coder"]).filter((seat) => seat.slot !== "planner"), steps: [] },
      tabWith(work, "lj-stop", ["Coder"]), tabWith(work, "lj-free", ["Coder"])],
  });
  c = await client(srv);
});
after(async () => { c?.close(); await srv?.stop(); });

const { planPath, results, runPlanner, planDone, endedRuns } = orchKit(() => ({ srv, c }));
const leaderLog = () => existsSync(join(srv.temp, "fake-leader.log")) ? readFileSync(join(srv.temp, "fake-leader.log"), "utf8") : "";
const say = (text: string) => JSON.stringify([{ say: text }]);
const notices = (id: string) => c.messages.filter((m) => m.type === "chatMessage" && m.tabId === id && m.role === "notice" && m.text.startsWith(`${PLANNER} handed ${LEADER} a job:`));
const readJsonFile = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const text = (result: any) => JSON.parse(result.text);
const hand = (brief: string, save: string) => ({ call: "launch_seat", args: { slot: "leader", brief }, save });
const waitFor = (save: string, maxWaitSeconds = 60) => ({ call: "wait_for_runs", args: { runIds: [`{{RUN:${save}}}`], maxWaitSeconds } });
const userChat = (id: string, steps: unknown[]) => c.send({ type: "chat", tabId: id, text: JSON.stringify(steps), requestId: `${id}-user` });
const chatDones = (id: string) => c.messages.filter((m) => m.type === "chatDone" && m.tabId === id);

test("LJ1 the sweep: for every crew shape from the real roles, each step the leader owns is handed to it and its reply comes back", { timeout: 300_000 }, async () => {
  console.log(`LJ1: ${1 << OTHER_ROLES.length} subsets of [${OTHER_ROLES.join(", ")}] -> ${SETS.size} distinct leader-owned sets: ${[...SETS.keys()].map((key) => `{${key}}`).join(" ")}; ${WITH_JOBS.length} tabs with jobs + 1 control`);
  assert.ok(WITH_JOBS.length >= 2, "the sweep found more than one shape");
  assert.deepEqual(CONTROL.owned, [], "the control owns no step");
  let expectedHandOffs = 0, madeHandOffs = 0;
  for (const [index, set] of WITH_JOBS.entries()) {
    const id = lj1Id(index), withToken = index === 0;
    expectedHandOffs += set.owned.length;
    const plan: unknown[] = [{ call: "get_crew_status" }];
    set.owned.forEach((stepId, i) => plan.push(hand(say(`LEADER-DID-${stepId}${withToken ? " {{TOKEN}}" : ""}`), `j${i}`), waitFor(`j${i}`)));
    runPlanner(id, plan);
    await planDone(id, 1 + 2 * set.owned.length);
    const out = results(id), view = text(out[0]);
    const row = (slot: string) => view.crew.find((item: any) => item.slot === slot);
    assert.deepEqual([row("leader").runnable, row("planner").runnable], [true, false], `${id}: the leader takes jobs, the planner never itself`);
    for (const other of view.crew.filter((item: any) => item.slot.startsWith("s"))) assert.equal(other.runnable, true, `${id}: ${other.role} stays runnable`);
    set.owned.forEach((stepId, i) => {
      const [launched, waited] = [out[1 + 2 * i], out[2 + 2 * i]];
      assert.match(launched.text, new RegExp(`launched "${id}\\.leader" as run leader-job-`), `${id}/${stepId}: ${launched.text}`);
      const run = text(waited).runs[0];
      assert.deepEqual([run.status, run.outcome, run.logPath], ["done", "done", null], `${id}/${stepId}: ${waited.text}`);
      assert.ok(run.tail.includes(`LEADER-DID-${stepId}`), `${id}/${stepId}: tail=${run.tail}`);
      madeHandOffs++;
    });
    await c.wait(() => notices(id).length >= set.owned.length, `${id}: all job notices arrived`);
    await c.wait(() => c.messages.some((m) => m.type === "chatMessage" && m.tabId === id && m.role === "assistant" && m.text.includes(`LEADER-DID-${set.owned[0]}`)), `${id}: assistant reply arrived`);
    assert.equal(notices(id).length, set.owned.length, `${id}: one notice per job`);
    assert.ok(c.messages.some((m) => m.type === "chatMessage" && m.tabId === id && m.role === "assistant" && m.text.includes(`LEADER-DID-${set.owned[0]}`)), `${id}: the leader's reply is in the chat`);
    if (withToken) {
      const { token } = readJsonFile(planPath(srv.temp, id, "session"));
      assert.ok(token.length > 8);
      const tail = text(out[2]).runs[0].tail;
      assert.ok(tail.includes("[hidden]"), `the token became [hidden]: ${tail}`);
      for (const [where, seen] of [["the tail", tail], ["the chat notice", notices(id)[0].text], ["the chat", JSON.stringify(c.messages.filter((m) => m.tabId === id && m.type === "chatMessage"))], ["the leader's turn", leaderLog()]]) assert.equal(String(seen).includes(token), false, `the planner's token reached ${where}`);
    }
    await endedRuns(id, 1);
  }
  assert.equal(madeHandOffs, expectedHandOffs, "every leader-owned step across all tabs was handed over");
  assert.ok(expectedHandOffs >= 4, `the walk made ${expectedHandOffs} hand-offs (an empty walk would go red)`);
  // The control: nothing for the leader to own, so nothing is handed over.
  runPlanner("lj1-control", [{ call: "get_crew_status" }]);
  await planDone("lj1-control", 1);
  assert.equal(notices("lj1-control").length, 0);
  console.log(`LJ1: ${madeHandOffs}/${expectedHandOffs} hand-offs done and answered; control tab ran none`);
});

test("LJ2 a job queues behind the user's reply, the step tools wait while the leader owns the step, and a second job is refused", { timeout: 120_000 }, async () => {
  const id = "lj2";
  userChat(id, [{ sleep: 5000 }, { say: "USER-REPLY" }]);
  await c.wait(() => c.tab(id).derived?.leaderTurnActive, `${id}: the user's reply is running`);
  runPlanner(id, [
    { call: "advance_step", args: { fromStepId: "plan" } }, { call: "advance_step", args: { fromStepId: "build" } }, { call: "advance_step", args: { fromStepId: "gate" } }, // 0-2: now Review
    { call: "get_crew_status" },                                    // 3
    hand(JSON.stringify([{ sleep: 2500 }, { say: "REVIEW-DONE" }]), "r"), // 4
    { call: "report_round", args: { round: 1, outcome: "clean" } }, // 5: refused, the leader works
    hand(say("SECOND"), "second"),                                  // 6: refused, one at a time
    { call: "get_crew_status" },                                    // 7
    waitFor("r"),                                                   // 8
    { call: "report_round", args: { round: 1, outcome: "clean" } }, // 9
    hand(say("FINAL-DONE"), "f"), waitFor("f"),                     // 10, 11
    { call: "advance_step", args: { fromStepId: "final" } },        // 12
  ]);
  await planDone(id, 13);
  const out = results(id);
  const current = (r: any) => text(r).stepBar.find((s: any) => s.state === "current").stepId;
  assert.equal(current(out[2]), "review");
  const runId = /as run (\S+)/.exec(out[4].text)![1];
  assert.equal(out[5].isError, true);
  assert.match(text(out[5]).reason, new RegExp(`${LEADER} is still working on the job you handed it \\(run ${runId}\\); wait_for_runs`), out[5].text);
  assert.equal(out[6].isError, true);
  assert.ok(out[6].text.includes(runId), `the refusal names run ${runId}: ${out[6].text}`);
  assert.equal(text(out[7]).crew.find((item: any) => item.slot === "leader").status, "working");
  const waited = text(out[8]).runs[0];
  assert.deepEqual([waited.status, waited.outcome], ["done", "done"]);
  assert.ok(waited.tail.includes("REVIEW-DONE"), waited.tail);
  assert.equal(text(out[9]).changed, true, out[9].text);
  assert.equal(current(out[9]), "final");
  assert.equal(text(out[11]).runs[0].status, "done");
  assert.equal(text(out[12]).changed, true, out[12].text);
  assert.equal(current(out[12]), "ship");
  // The job never ran beside the user's reply: the reply's chatDone comes before the job's notice.
  await c.wait(() => chatDones(id).length && notices(id).length, `${id}: reply end and job notice arrived`);
  await c.wait(() => c.messages.some((m) => m.type === "chatMessage" && m.tabId === id && m.role === "assistant" && m.text.includes("USER-REPLY")), `${id}: user reply arrived`);
  const firstDone = c.messages.indexOf(chatDones(id)[0]), firstNotice = c.messages.indexOf(notices(id)[0]);
  assert.ok(firstDone >= 0 && firstNotice > firstDone, `the user's reply ended (message ${firstDone}) before the job started (notice ${firstNotice})`);
  assert.ok(c.messages.some((m) => m.type === "chatMessage" && m.tabId === id && m.role === "assistant" && m.text.includes("USER-REPLY")));
  await endedRuns(id, 1);
  console.log(`LJ2: reply ended at message ${firstDone}, job notice at ${firstNotice}; step tool refused with "${text(out[5]).reason}"`);
});

test("LJ-steer the job returns the whole reply across a steer", { timeout: 90_000 }, async () => {
  const id = "lj-steer";
  runPlanner(id, [hand(JSON.stringify([{ say: "PART-ONE" }, { sleep: 4000 }, { say: "PART-TWO" }]), "j"), waitFor("j")]);
  await c.wait(() => c.tab(id).derived?.leaderTurnActive && c.messages.filter((m) => m.type === "chatDelta" && m.tabId === id).map((m) => m.text).join("").includes("PART-ONE"), `${id}: first part streamed`);
  c.send({ type: "steer", tabId: id, text: say("STEER-ACK"), requestId: `${id}-steer` });
  await c.wait(() => c.messages.some((m) => m.type === "chatMessage" && m.requestId === `${id}-steer`), `${id}: steer accepted`);
  await planDone(id, 2);
  const run = text(results(id)[1]).runs[0];
  assert.deepEqual([run.status, run.outcome], ["done", "done"]);
  assert.ok(run.tail.includes("PART-ONE") && run.tail.includes("PART-TWO") && run.tail.indexOf("PART-ONE") < run.tail.indexOf("PART-TWO"), `whole ordered reply: ${run.tail}`);
  assert.ok(run.tail.includes("STEER-ACK"), run.tail);
  await endedRuns(id, 1);
});

for (const phase of ["Build", "Fix", "Final review"]) test(`LJ-guard ${phase} refuses until wait_for_runs`, { timeout: 120_000 }, async () => {
  // Nobody reviews their own work: the leader owns Build and Fix only when no Coder builds, and then it never owns the Final review.
  // So one tab walks Build, then round 1's findings and fix; the Final review is the leader's on a tab where a Coder builds.
  const id = phase === "Final review" ? "lj-guard-final" : "lj-guard";
  if (phase === "Fix") unlinkSync(planPath(srv.temp, id, "result"));
  const advance = (fromStepId: string) => ({ call: "advance_step", args: { fromStepId } });
  const report = (round: number, outcome: string) => ({ call: "report_round", args: { round, outcome } });
  const setup = phase === "Build" ? [advance("plan")] : phase === "Fix" ? [advance("gate"), report(1, "findings")] : [advance("plan"), advance("build"), advance("gate"), report(1, "clean")];
  const op = phase === "Build" ? advance("build") : phase === "Fix" ? { call: "finish_fix", args: { round: 1 } } : advance("final");
  runPlanner(id, [...setup, hand(JSON.stringify([{ sleep: 2000 }, { say: `${phase}-DONE` }]), "j"), op, waitFor("j"), op]);
  await planDone(id, setup.length + 4);
  const out = results(id), at = setup.length;
  for (const result of out.slice(0, at)) assert.equal(text(result).changed, true, result.text);
  const runId = /as run (\S+)/.exec(out[at].text)![1];
  assert.equal(out[at + 1].isError, true, out[at + 1].text);
  assert.equal(text(out[at + 1]).changed, false, out[at + 1].text);
  assert.ok(text(out[at + 1]).reason.includes(`${LEADER} is still working on the job you handed it (run ${runId}); wait_for_runs`), out[at + 1].text);
  const run = text(out[at + 2]).runs[0];
  assert.deepEqual([run.status, run.outcome], ["done", "done"]);
  assert.ok(run.tail.includes(`${phase}-DONE`), run.tail);
  assert.equal(out[at + 3].isError, false, out[at + 3].text);
  assert.equal(text(out[at + 3]).changed, true, out[at + 3].text);
  await endedRuns(id, phase === "Fix" ? 2 : 1);
});

test("LJ3 the leader's Stop ends the job as failed, never leaves it working", { timeout: 90_000 }, async () => {
  const id = "lj3", began = Date.now();
  runPlanner(id, [hand(JSON.stringify([{ sleep: 15_000 }, { say: "never" }]), "j"), waitFor("j")]);
  await c.wait(() => c.tab(id).derived?.leaderTurnActive, `${id}: the leader is replying to the job`);
  c.send({ type: "stopSeat", tabId: id, slot: "leader" });
  await planDone(id, 2);
  const run = text(results(id)[1]).runs[0];
  assert.equal(run.status, "failed", results(id)[1].text);
  assert.ok(Date.now() - began < 14_000, `the job ended at ${Date.now() - began} ms, well before its 15 s`);
  await endedRuns(id, 1);
  console.log(`LJ3: stopped job reads "${run.status}" / "${run.outcome}" after ${Date.now() - began} ms`);
});

test("LJ4 a job queued behind a reply is cancelled when the planner's run ends, and never reaches the leader", { timeout: 180_000 }, async () => {
  const id = "lj4";
  userChat(id, [{ sleep: 40_000 }, { say: "LONG" }]);
  await c.wait(() => c.tab(id).derived?.leaderTurnActive, `${id}: the user's reply is running`);
  runPlanner(id, [hand(say("LJ4-NEVER"), "j")]);
  await planDone(id, 1);
  const runId = /as run (\S+)/.exec(results(id)[0].text)![1];
  await endedRuns(id, 1, RUN_END_MS);
  unlinkSync(planPath(srv.temp, id, "result"));
  runPlanner(id, [{ call: "wait_for_runs", args: { runIds: [runId], maxWaitSeconds: 20 } }]);
  await planDone(id, 1);
  const run = text(results(id)[0]).runs[0];
  assert.equal(run.status, "stopped", results(id)[0].text);
  assert.match(run.outcome, /run ended before the leader was free/);
  assert.equal(notices(id).length, 0, "no notice: the job never started");
  assert.equal(leaderLog().includes("LJ4-NEVER"), false, "the leader never received the job");
  c.send({ type: "stopSeat", tabId: id, slot: "leader" });
  await endedRuns(id, 2);
  console.log(`LJ4: queued job reads "${run.status}": ${run.outcome}`);
});

test("LJ-stop the leader's Stop after a steer still returns the part split off before it", { timeout: 90_000 }, async () => {
  const id = "lj-stop";
  runPlanner(id, [hand(JSON.stringify([{ say: "PART-ONE" }, { sleep: 30_000 }]), "j"), waitFor("j")]);
  await c.wait(() => c.tab(id).derived?.leaderTurnActive && c.messages.filter((m) => m.type === "chatDelta" && m.tabId === id).map((m) => m.text).join("").includes("PART-ONE"), `${id}: first part streamed`);
  c.send({ type: "steer", tabId: id, text: JSON.stringify([{ sleep: 30_000 }, { say: "never" }]), requestId: `${id}-steer` });
  await c.wait(() => c.messages.some((m) => m.type === "chatMessage" && m.requestId === `${id}-steer`), `${id}: steer accepted`);
  c.send({ type: "stopSeat", tabId: id, slot: "leader" });
  await planDone(id, 2);
  const run = text(results(id)[1]).runs[0];
  assert.equal(run.status, "failed", results(id)[1].text);
  assert.ok(run.tail.includes("PART-ONE"), `the part split off by the steer survives the stop: ${run.tail}`);
  await endedRuns(id, 1);
});

test("LJ-free the guard lets steps move while the leader works on a step it does not own", { timeout: 90_000 }, async () => {
  const id = "lj-free";
  runPlanner(id, [
    { call: "advance_step", args: { fromStepId: "plan" } },                      // 0: now Build, the Coder's step
    hand(JSON.stringify([{ sleep: 6000 }, { say: "FINAL-DONE" }]), "j"),         // 1
    { call: "get_crew_status" },                                                 // 2
    { call: "advance_step", args: { fromStepId: "build" } },                     // 3: must not be refused
    waitFor("j"),                                                                // 4
  ]);
  await planDone(id, 5);
  const out = results(id);
  assert.equal(text(out[2]).crew.find((item: any) => item.slot === "leader").status, "working", "the job was still working when the step moved");
  assert.equal(out[3].isError, false, out[3].text);
  assert.equal(text(out[3]).changed, true, out[3].text);
  assert.equal(text(out[4]).runs[0].status, "done", out[4].text);
  await endedRuns(id, 1);
});


test("LJS-leader Stop cancels a waiting job before the leader takes it", { timeout: 120_000 }, async () => {
  const id = "ljs-leader";
  userChat(id, [{ sleep: 40_000 }, { say: "LONG" }]);
  await c.wait(() => c.tab(id).derived?.leaderTurnActive, `${id}: user reply running`);
  runPlanner(id, [hand(say("LJS-NEVER"), "j"), waitFor("j")]);
  await planDone(id, 1);
  c.send({ type: "stopSeat", tabId: id, slot: "leader" });
  await planDone(id, 2);
  const run = text(results(id)[1]).runs[0];
  await sleep(2500);
  assert.equal(run.status, "stopped", results(id)[1].text);
  assert.equal(run.outcome, "the leader was stopped before it took the job");
  assert.equal(leaderLog().includes("LJS-NEVER"), false);
  assert.equal(notices(id).length, 0, "no job notice for a cancelled job");
  await endedRuns(id, 1);
});

test("LJS-planner Stop cancels a waiting job with the Planner-stopped outcome", { timeout: 180_000 }, async () => {
  const id = "ljs-planner";
  userChat(id, [{ sleep: 40_000 }, { say: "LONG" }]);
  await c.wait(() => c.tab(id).derived?.leaderTurnActive, `${id}: user reply running`);
  runPlanner(id, [hand(say("LJS-PLANNER-NEVER"), "j"), { sleep: 60_000 }]);
  await planDone(id, 1);
  const runId = /as run (\S+)/.exec(results(id)[0].text)![1];
  c.send({ type: "stopSeat", tabId: id, slot: "planner" });
  await endedRuns(id, 1);
  unlinkSync(planPath(srv.temp, id, "result"));
  c.send({ type: "unblockSeat", seatKey: `${id}.planner`, confirm: "allow this seat to launch again" });
  runPlanner(id, [{ call: "wait_for_runs", args: { runIds: [runId], maxWaitSeconds: 20 } }]);
  await planDone(id, 1);
  const run = text(results(id)[0]).runs[0];
  c.send({ type: "stopSeat", tabId: id, slot: "leader" });
  await sleep(2500);
  assert.equal(run.status, "stopped", results(id)[0].text);
  assert.equal(run.outcome, "Sage (Planner) was stopped before the leader took the job");
  assert.equal(leaderLog().includes("LJS-PLANNER-NEVER"), false);
  assert.equal(notices(id).length, 0);
  await endedRuns(id, 2);
});

for (const id of ["ljs-self", "ljs-self-alone"]) test(`LJS-self ${id}: leader cannot launch its own slot`, { timeout: 90_000 }, async () => {
  const reply = (await c.chat(id, JSON.stringify([{ tool: "launch_seat", args: { slot: "leader", brief: say("SELF-NEVER") } }]))).trim();
  assert.match(reply, /^\[tool failed: launch failed:/);
  assert.equal(reply.includes("leader-job-"), false, reply);
  assert.equal(notices(id).length, 0);
});
