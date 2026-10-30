// Pack 18, Block 1b: the seat that runs the process (a planner), through a real server. A fake planner CLI (pack18-orch-harness.ts) reads CC_CREW_URL / CC_CREW_TOKEN
// from its environment and calls the real bridge over HTTP, exactly as a real agent would; the coders are fake CLIs that only write a file and wait.
// O1 / O2 per-run bridge, O3 the gate by origin, O4 approvals by origin (answer, Stop, Stop all, kill), O5 Plan mode, O6 no self-launch and a talk-only leader,
// O7 one planner run at a time, O8 the per-tab launch budget, O9 wait_for_runs. The step tools (O10, S13) and O12 are in pack18-orchestrator-steps.test.ts.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { importWithTempDataRoot } from "./temp-root.ts";
import { boot, client, type Client, type Server } from "./pack18-harness.ts";
import { tabIn, fakeClis, orchKit, bridgeCall } from "./pack18-orch-harness.ts";
import { createLeaderBridge } from "../server/leader-bridge.ts";
import { buildLeaderToolSpecs } from "../server/leader-tools.ts";

const { modules: { config } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));

let srv: Server, c: Client;
const TABS = ["o-gate", "o-ask", "o-plan", "o-self", "o-one", "o-budget", "o-budget2", "o-wait", "o-bridge", "o-stopseat", "o-kill", "o-stopall", "o-endrun"];
before(async () => {
  srv = await boot({
    fakeLeader: true, env: { FAKE_SLEEP_CLAUDE: "4", FAKE_SLEEP_OPENCODE: "9" },
    extra: (paths) => {
      fakeClis(paths);
      // A launch-safety file from before the budget was counted per tab: plain numbers, eight of them, all recent. They name no tab and must count against none.
      writeFileSync(join(paths.data, "config", "launch-safety.json"), JSON.stringify({ blocked: [], timestamps: Array.from({ length: 8 }, (_, i) => Date.now() - i * 1000), notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] }));
    },
    tabs: (work) => TABS.map((id) => tabIn(work, id)),
  });
  c = await client(srv);
});
after(async () => { c?.close(); await srv?.stop(); });

const { readJson, results, setPlan, session, runPlanner, plannerRun, mode, planDone, endedRuns } = orchKit(() => ({ srv, c }));

test("O1 one bridge serves a leader's key and a run's key side by side, each with its own token", { timeout: 30_000 }, async () => {
  // The real bridge on a real HTTP server: the leader's entry is the tab id, a run's is "<tab>.<run>"; opening the second must not close the first.
  const bridge = createLeaderBridge();
  const specs = buildLeaderToolSpecs({ tabName: "t", crew: () => [], statusOf: () => "idle", launch: () => ({ ok: true, runId: "r" }) });
  const leaderEntry = bridge.open("tab-x", specs), runEntry = bridge.open("tab-x.run-1", specs);
  const http = createServer((req, res) => { void bridge.handle(req, res, decodeURIComponent(req.url!.split("/").pop()!)); });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  try {
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}/api/leader-mcp/`;
    const ask = async (key: string, token: string) => (await bridgeCall(base + encodeURIComponent(key), token, "tools/list")).status;
    assert.deepEqual([await ask("tab-x", leaderEntry.token), await ask("tab-x.run-1", runEntry.token)], [200, 200], "both entries answer");
    assert.deepEqual([await ask("tab-x", runEntry.token), await ask("tab-x.run-1", leaderEntry.token)], [401, 401], "a token opens only its own key");
    runEntry.revoke();
    assert.deepEqual([await ask("tab-x", leaderEntry.token), await ask("tab-x.run-1", runEntry.token)], [200, 401], "revoking the run leaves the leader's entry alone");
    console.log("O1: leader and run entries side by side, 4 cross-checks");
  } finally { http.close(); }
});

test("O1/O2 a planner run gets its own entry on the real server (tool list with the step tools), and a POST after the run ended gets 401", { timeout: 90_000 }, async () => {
  const id = "o-bridge";
  runPlanner(id, [{ sleep: 5000 }]);
  const { url, token } = await session(id);
  assert.match(url, new RegExp(`/api/leader-mcp/${id}\\.[0-9a-f-]{36}$`), "the key is <tab>.<run>");
  const list = await bridgeCall(url, token, "tools/list");
  assert.equal(list.status, 200);
  const names = list.body.result.tools.map((tool: any) => tool.name).sort();
  assert.deepEqual(names, ["advance_step", "finish_fix", "get_crew_status", "launch_seat", "list_requests", "report_round", "send_request", "wait_for_runs"]);
  assert.equal((await bridgeCall(url.replace(`/${id}.`, "/o-gate."), token, "tools/list")).status, 401, "another key does not take this token");
  assert.equal((await bridgeCall(url, "0".repeat(token.length), "tools/list")).status, 401, "a wrong token");
  await endedRuns(id, 1);
  assert.equal((await bridgeCall(url, token, "tools/list")).status, 401, "after the run ended the entry is gone");
  console.log(`O1/O2: ${names.length} tools: ${names.join(",")}; 401 after the run ended`);
});

test("O3 a planner with no leader alive, in Full access, launches a coder; the run, the notice and the crew status name the planner", { timeout: 90_000 }, async () => {
  const id = "o-gate";
  await mode(id, "bypass");
  assert.equal(c.tab(id).leaderStatus, "not-started", "no leader exists on this tab");
  runPlanner(id, [{ call: "get_crew_status" }, { call: "launch_seat", args: { slot: "coderA", brief: "TEST ONLY: build" }, save: "a" }, { call: "wait_for_runs", args: { runIds: ["{{RUN:a}}"], maxWaitSeconds: 30 } }]);
  await planDone(id, 2);
  // The run view on the page says who started it, while the run is going.
  // The page's state follows the planner's answer by a moment, so the run is waited for rather than read once.
  const live = await c.wait(() => c.tab(id).runs.find((run: any) => run.seatSlotId === "coderA" && run.status === "working"), "the coder run is working");
  assert.deepEqual(live.launchedBy, { kind: "seat", slot: "planner", name: "Sage" });
  await planDone(id, 3);
  const [status, launched, waited] = results(id);
  const view = JSON.parse(status.text);
  const row = (slot: string) => view.crew.find((item: any) => item.slot === slot);
  assert.deepEqual([row("planner").runnable, row("leader").runnable, row("coderA").runnable, row("planner").orchestrates], [false, true, true, true], "never yourself; the leader takes jobs from the seat that runs the process");
  assert.deepEqual([view.process.stepId, view.process.phase, view.process.round, view.process.look, view.process.orchestrator], ["plan", "review", 1, "not reached", "planner"]);
  assert.equal(launched.isError, false, launched.text);
  assert.match(launched.text, /^launched "o-gate\.coderA" as run [0-9a-f-]{36}$/);
  const start = await c.wait(() => c.messages.find((m) => m.type === "runStart" && m.tabId === id && m.seatKey === "o-gate.coderA"), "the coder start arrives");
  assert.deepEqual(start.launchedBy, { kind: "seat", slot: "planner", name: "Sage" }, "the run says who started it");
  const notice = await c.wait(() => c.state().launchSafety.notices.find((n: any) => n.seatId === "o-gate.coderA"), "the coder notice arrives");
  assert.equal(notice.source, "Sage", "the notice names the launching seat");
  assert.equal(JSON.parse(waited.text).allEnded, true);
  await endedRuns(id, 2);
  // The user's own Run is attributed to nobody.
  c.send({ type: "run", confirmBusy: true, tabId: id, slot: "reviewer", prompt: "TEST ONLY: review" });
  const own = await c.wait(() => c.messages.find((m) => m.type === "runStart" && m.tabId === id && m.seatKey === "o-gate.reviewer"), "own run started");
  assert.equal(own.launchedBy, null);
  console.log(`O3: launchedBy=${JSON.stringify(start.launchedBy)} notice.source=${notice.source}`);
});

test("O4/O11 in Ask mode the planner's approval names the planner, blocks Save but not the chat with the leader, and answerApproval settles it with no leader asking", { timeout: 120_000 }, async () => {
  const id = "o-ask";
  await mode(id, "ask");
  await c.chat(id, "hello"); // the leader exists and answers
  runPlanner(id, [{ call: "launch_seat", args: { slot: "coderA", brief: "TEST ONLY: build after you say yes" }, save: "a" }, { call: "wait_for_runs", args: { runIds: ["{{RUN:a}}"], maxWaitSeconds: 30 } }]);
  const item = await c.wait(() => c.tab(id).pendingApprovals?.[0], "the planner's approval card");
  assert.deepEqual(item.askedBy, { kind: "seat", slot: "planner", name: "Sage" });
  assert.equal(item.tool, "launch:Ann");
  assert.equal(c.tab(id).pendingApprovals.length, 1);
  // Save waits for the user: refused, and the message names the one who asks.
  assert.match((await c.attempt({ type: "save", tabId: id })).error ?? "", /^Sage is waiting for your answer on a change$/);
  // Chat with the leader is not held by the planner's approval.
  const answer = await c.chat(id, "still there?");
  assert.match(answer, /still there\?/, "the leader answered while the planner's approval was pending");
  assert.deepEqual(await c.request({ type: "answerApproval", tabId: id, approvalId: item.approvalId, allow: true }), { ok: true });
  await planDone(id, 2);
  assert.match(results(id)[0].text, /^launched "o-ask\.coderA" as run /);
  await c.wait(() => c.tab(id).pendingApprovals.length === 0, "the answered approval leaves the page");
  assert.equal(c.tab(id).pendingApprovals.length, 0);
  await endedRuns(id, 2);
  console.log(`O4/O11: askedBy=${JSON.stringify(item.askedBy)}; Save refused; leader chat answered`);
});

// A planner waiting for an answer on a launch, in a tab on Ask mode: its approval card and its bridge session.
async function waitingPlanner(id: string) {
  await mode(id, "ask");
  runPlanner(id, [{ call: "launch_seat", args: { slot: "coderA", brief: "TEST ONLY: never answered" } }]);
  const item = await c.wait(() => c.tab(id).pendingApprovals?.[0], `${id}: the planner's approval card`);
  const run = await plannerRun(id);
  return { item, run, ...(await session(id)) };
}
// Send a command and collect every message up to the marker the command itself produces (not a timer, not any broadcast).
async function afterCommand(send: () => void, isMarker: (m: any) => boolean) {
  const from = c.messages.length;
  send();
  const marker = await c.wait(() => c.messages.slice(from).find(isMarker), "the command's own marker", 5000);
  return c.messages.slice(from, c.messages.indexOf(marker) + 1);
}
const stopped = (id: string, state: any) => state.projects.flatMap((p: any) => p.tabs).find((t: any) => t.id === id);
const approvalCounts = (id: string, messages: any[]) => messages.filter((m) => m.type === "state").map((m) => stopped(id, m).pendingApprovals.length);

test("O4 Stop on the planner denies its pending approval at once and its next tool call gets 401", { timeout: 90_000 }, async () => {
  const id = "o-stopseat";
  const { url, token } = await waitingPlanner(id);
  // The first state that holds the seat in the blocked list is the command's own; the approval must already be gone in it.
  const seen = await afterCommand(() => c.send({ type: "stopSeat", tabId: id, slot: "planner" }), (m) => m.type === "state" && m.launchSafety.blocked.includes(`${id}.planner`));
  assert.equal(approvalCounts(id, seen).at(-1), 0, "the approval is gone in the first state that shows the seat stopped");
  assert.equal(seen.some((m) => ["runStop", "runFail", "runFinish"].includes(m.type)), false, "before the process itself ended");
  assert.equal((await bridgeCall(url, token, "tools/list")).status, 401, "the planner's entry is revoked by the Stop itself");
  console.log("O4 stopSeat: approval cleared and entry revoked by the command itself");
});

test("O4 killRun on the planner run denies its pending approval and revokes its entry", { timeout: 90_000 }, async () => {
  const id = "o-kill";
  const { run, url, token } = await waitingPlanner(id);
  // The denial broadcasts before the handler answers killAccepted, so a state with no approvals must come first.
  const seen = await afterCommand(() => c.send({ type: "killRun", runId: run.id }), (m) => m.type === "killAccepted" && m.runId === run.id);
  assert.ok(approvalCounts(id, seen).includes(0), "a state without the approval arrived before killAccepted");
  assert.equal(seen.some((m) => ["runStop", "runFail", "runFinish"].includes(m.type)), false, "before the process itself ended");
  assert.equal((await bridgeCall(url, token, "tools/list")).status, 401);
});

test("O4 Stop all denies a planner's pending approval and revokes its entry", { timeout: 90_000 }, async () => {
  const id = "o-stopall";
  const { url, token } = await waitingPlanner(id);
  const seen = await afterCommand(() => c.send({ type: "stopAll" }), (m) => m.type === "stopAllAccepted");
  assert.ok(approvalCounts(id, seen).includes(0), "a state without the approval arrived before stopAllAccepted");
  assert.equal(seen.some((m) => ["runStop", "runFail", "runFinish"].includes(m.type)), false, "before the process itself ended");
  assert.equal((await bridgeCall(url, token, "tools/list")).status, 401);
});

test("O5 in Plan mode a planner's launch of a seat that can write is refused, a read-only Claude seat is not", { timeout: 90_000 }, async () => {
  const id = "o-plan";
  await mode(id, "plan");
  runPlanner(id, [{ call: "launch_seat", args: { slot: "coderA", brief: "TEST ONLY: write" } }, { call: "launch_seat", args: { slot: "reviewer", brief: "TEST ONLY: read" } }]);
  await planDone(id, 2);
  const [writer, reader] = results(id);
  assert.equal(writer.isError, true);
  assert.match(writer.text, /Plan mode/);
  assert.equal(reader.isError, false, reader.text);
  // The page's state follows the planner's answer by a moment: wait for the reviewer's run to show, then nothing else may be there.
  await c.wait(() => c.tab(id).runs.some((run: any) => run.seatSlotId === "reviewer"), `${id}: the reviewer run shows`);
  assert.deepEqual(c.tab(id).runs.map((run: any) => run.seatSlotId).sort(), ["planner", "reviewer"], "no coder run was started");
  await endedRuns(id, 2);
});

test("O6 a seat cannot launch itself; where a planner runs the process the leader can launch only the planner and has no step tools", { timeout: 120_000 }, async () => {
  const id = "o-self";
  runPlanner(id, [{ call: "launch_seat", args: { slot: "planner", brief: "TEST ONLY: myself" } }, { call: "get_crew_status" }]);
  await planDone(id, 2);
  const [selfLaunch, statusCall] = results(id);
  assert.equal(selfLaunch.isError, true);
  assert.match(selfLaunch.text, /cannot launch itself/);
  await c.wait(() => c.tab(id).runs.some((run: any) => run.seatSlotId === "planner"), "the planner run arrives");
  assert.equal(c.tab(id).runs.filter((run: any) => run.seatSlotId === "planner").length, 1, "still the one planner run");
  assert.equal(JSON.parse(statusCall.text).crew.find((item: any) => item.slot === "planner").runnable, false);
  await endedRuns(id, 1);
  // The leader (a Codex leader on the fake app-server) talks, and may only launch the planner.
  const tool = async (name: string, args: object = {}) => (await c.chat(id, JSON.stringify([{ tool: name, args }]))).trim();
  await c.chat(id, "start the leader");
  const status = JSON.parse(/^\[tool ok: ([\s\S]*)\]$/.exec(await tool("get_crew_status"))![1]);
  assert.deepEqual(status.crew.filter((item: any) => item.runnable).map((item: any) => item.slot), ["planner"], "the only runnable seat is the planner");
  const refused = await tool("launch_seat", { slot: "coderA", brief: "TEST ONLY: leader tries a coder" });
  assert.match(refused, /^\[tool failed: launch failed: Sage runs the process in this tab, so the leader can only launch Sage\]$/);
  assert.match(await tool("advance_step", { fromStepId: "plan" }), /^\[tool failed: unknown tool: advance_step\]$/, "the leader has no step tools");
  assert.match(await tool("wait_for_runs", { runIds: ["x"] }), /^\[tool failed: unknown tool: wait_for_runs\]$/);
  setPlan(id, [{ sleep: 100 }]);
  const launched = await tool("launch_seat", { slot: "planner", brief: "TEST ONLY: planner, please" });
  assert.match(launched, /^\[tool ok: launched "o-self\.planner" as run /);
  const second = await c.wait(() => { const planners = c.tab(id).runs.filter((run: any) => run.seatSlotId === "planner"); return planners.length >= 2 ? planners.at(-1) : undefined; }, `${id}: the leader-launched planner run shows`);
  assert.deepEqual(second.launchedBy, { kind: "leader", slot: "leader", name: "Atlas" });
  await endedRuns(id, 2);
  console.log(`O6: leader refusal: ${refused}`);
});

test("O7 a second planner run is refused while one works", { timeout: 90_000 }, async () => {
  const id = "o-one";
  runPlanner(id, [{ sleep: 5000 }]);
  await plannerRun(id);
  const second = await c.attempt({ type: "run", confirmBusy: true, tabId: id, slot: "planner", prompt: "TEST ONLY: a second planner" });
  assert.match(second.error ?? "", /Sage already runs the process in this tab/);
  assert.equal(c.tab(id).runs.filter((run: any) => run.seatSlotId === "planner").length, 1);
  await endedRuns(id, 1);
  // A coder seat may run several at once: the rule is for the seat that runs the process only.
  c.send({ type: "run", confirmBusy: true, tabId: id, slot: "reviewer", prompt: "TEST ONLY: one" });
  assert.deepEqual(await c.attempt({ type: "run", confirmBusy: true, tabId: id, slot: "reviewer", prompt: "TEST ONLY: two" }), {});
  await endedRuns(id, 3);
});

test("O8 eight launches in five minutes on one tab (the planner's own Run is the first) are allowed, the ninth is refused naming the tab, and another tab still launches", { timeout: 150_000 }, async () => {
  const id = "o-budget";
  await mode(id, "bypass");
  runPlanner(id, Array.from({ length: 9 }, (_, i) => ({ call: "launch_seat", args: { slot: "reviewer", brief: `TEST ONLY: ${i + 1}` } })));
  await planDone(id, 9);
  const outcome = results(id);
  assert.deepEqual(outcome.map((r: any) => !r.isError), [true, true, true, true, true, true, true, false, false], "the planner's own Run was launch 1, its seven launches are 2 to 8");
  assert.match(outcome[7].text, /^launch failed: launch budget exceeded: 8 launches in 5 minutes on tab "o-budget", and your own Run counts too; the next one is allowed in \d+ s$/);
  await c.wait(() => c.state().launchSafety.notices.filter((n: any) => n.seatId.startsWith(`${id}.`)).length >= 8, `${id}: the page's state follows the planner's answer by a moment`);
  const notices = c.state().launchSafety.notices.filter((n: any) => n.seatId.startsWith(`${id}.`));
  assert.equal(notices.length, 8);
  assert.deepEqual(notices.filter((n: any) => n.seatId !== `${id}.planner`).map((n: any) => n.source), Array(7).fill("Sage"), "every launch the planner made names the planner");
  assert.equal(notices.find((n: any) => n.seatId === `${id}.planner`).source, "Local client");
  // At this moment another tab launches.
  c.send({ type: "run", confirmBusy: true, tabId: "o-budget2", slot: "reviewer", prompt: "TEST ONLY: other tab" });
  await c.wait(() => c.messages.find((m) => m.type === "runStart" && m.tabId === "o-budget2"), "the other tab's launch started");
  // The file holds per-tab stamps only; the eight plain numbers it was seeded with were dropped.
  const stamps = readJson(join(srv.data, "config", "launch-safety.json")).timestamps;
  assert.ok(stamps.length >= 9 && stamps.every((s: any) => typeof s === "object" && typeof s.tabId === "string" && typeof s.at === "number"), JSON.stringify(stamps).slice(0, 200));
  assert.equal(stamps.filter((s: any) => s.tabId === id).length, 8);
  await endedRuns(id, 8);
  console.log(`O8: ${notices.length} notices; refused: ${outcome[7].text}`);
});

test("O9/S13 wait_for_runs returns only when every run ended, hides the token; advance_step is refused while either coder works and allowed after both end", { timeout: 150_000 }, async () => {
  const id = "o-wait";
  await mode(id, "bypass");
  runPlanner(id, [
    { parallel: [
      { call: "launch_seat", args: { slot: "coderA", brief: "TEST ONLY: A. token {{TOKEN}}" }, save: "a" },
      { call: "launch_seat", args: { slot: "coderB", brief: "TEST ONLY: B. token {{TOKEN}}" }, save: "b" },
      { call: "launch_seat", args: { slot: "reviewer", brief: "TEST ONLY: C. token {{TOKEN}}" }, save: "c" },
    ] },
    { call: "wait_for_runs", args: { runIds: ["{{RUN:a}}", "{{RUN:b}}", "{{RUN:c}}"], maxWaitSeconds: 40 } },
  ]);
  await planDone(id, 4);
  const out = results(id);
  assert.deepEqual(out.slice(0, 3).map((r: any) => r.isError), [false, false, false], out.slice(0, 3).map((r: any) => r.text).join(" | "));
  const waited = JSON.parse(out[3].text);
  assert.equal(waited.allEnded, true, "it returned only when all three had ended");
  assert.deepEqual(waited.runs.map((r: any) => r.status), ["done", "done", "done"]);
  assert.deepEqual(waited.runs.map((r: any) => r.seatKey), ["o-wait.coderA", "o-wait.coderB", "o-wait.reviewer"]);
  const { token } = await session(id);
  assert.ok(waited.runs.every((r: any) => r.logPath && existsSync(r.logPath)), "every run has its log path on disk");
  assert.ok(waited.runs[0].tail.includes("TEST ONLY: A. token [hidden]"), `the coder echoed its brief; the planner's token is hidden: ${waited.runs[0].tail.slice(0, 300)}`);
  assert.equal(JSON.stringify(out).includes(token), false, "the token is nowhere in what the planner got back");
  assert.equal(waited.runs.every((r: any) => r.tail.length <= 8 * 1024), true);
  console.log(`O9: allEnded=${waited.allEnded}; statuses=${waited.runs.map((r: any) => r.status)}; tail[0]=${JSON.stringify(waited.runs[0].tail.slice(0, 60))}`);
});

test("a launch-safety file with plain numbers (from before the per-tab budget) still loads; the server turns it into per-tab stamps", () => {
  const path = join(srv.temp, "old-safety.json");
  writeFileSync(path, JSON.stringify({ blocked: [], timestamps: [5, 6], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] }));
  assert.deepEqual(config.readLaunchSafety(path).timestamps, [5, 6]);
  writeFileSync(path, JSON.stringify({ blocked: [], timestamps: [5, { tabId: "t", at: 6 }], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] }));
  assert.equal(config.readLaunchSafety(path).timestamps.length, 2, "a mixed list loads");
  writeFileSync(path, JSON.stringify({ blocked: [], timestamps: [{ tabId: "", at: 6 }], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] }));
  assert.throws(() => config.readLaunchSafety(path), /invalid launch safety state/, "a stamp must name a tab");
  unlinkSync(path);
});
