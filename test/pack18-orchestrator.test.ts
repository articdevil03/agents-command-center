// Fixed crew orchestration through real server dispatch, durable files and finite owned CLIs.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { fixedServer, modules, plan } from "./fixed-crew-execution-helpers.ts";
import { client } from "./pack18-harness.ts";
import { scratchDir } from "./temp-root.ts";
import { bridgeCall } from "./pack18-orch-harness.ts";
import { createLeaderBridge } from "../server/leader-bridge.ts";
import { buildLeaderToolSpecs } from "../server/leader-tools.ts";
type Fixture = Awaited<ReturnType<typeof fixedServer>>;
const nativeProcess = process.env.CC_FCX_NATIVE_REPLAY === "1";
const leaderAssignment = { cli: "opencode", model: "opencode/mimo-v2.6-flash-free", effort: "max" };
const leaderIdentity = { kind: "leader", slot: "leader", name: "Leader" };
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const safetyPath = (f: Fixture) => join(f.server.data, "config", "launch-safety.json");
const safety = (f: Fixture) => existsSync(safetyPath(f)) ? json(safetyPath(f)) : null;
async function mode(f: Fixture, value: string) {
  assert.deepEqual(await f.c.request({ type: "setPermissionMode", tabId: "fixed", mode: value, confirm: true }), { ok: true });
}
function snapshot(f: Fixture) {
  const bytes = (folder: string) => {
    const path = join(f.server.data, folder, "fixed.json");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  return { journal: bytes("executions"), task: bytes("tasks"), safety: safety(f), runs: f.c.tab("fixed").runs.map((r: any) => ({ id: r.id, seatSlotId: r.seatSlotId, status: r.status })),
    starts: f.c.messages.filter((m) => m.type === "runStart").length, spawns: f.children().filter((e: any) => e.worker && e.event === "start").length };
}
async function call(bridge: { url: string; token: string }, name: string, args: object) {
  const response = await bridgeCall(bridge.url, bridge.token, "tools/call", { name, arguments: args });
  assert.equal(response.status, 200);
  const result = response.body.result;
  assert.ok(result, JSON.stringify(response.body));
  const text = result.content[0].text;
  let value: any; try { value = JSON.parse(text); } catch { value = text; }
  return { ok: result.isError !== true, text, value };
}
async function pending(f: Fixture, brief = "Ask before this fixed action") {
  assert.equal((await f.tool("get_fixed_task")).ok, true);
  const bridge = await f.control("leader-bridge");
  await mode(f, "ask");
  const result = call(bridge, "begin_planning", { expected: f.expected(), brief });
  const item = await f.c.wait(() => f.c.tab("fixed").pendingApprovals?.[0], "current leader approval");
  return { bridge, result, item };
}
async function deferred(f: Fixture) {
  if (!nativeProcess) writeFileSync(join(f.server.temp, "defer-worker-stop"), "1");
  f.worker({ delay: 3500 });
  const result = await f.tool("begin_planning", { expected: null, brief: "Finite controlled stop worker" });
  assert.equal(result.ok, true, result.text);
  const runId = result.value.runId;
  const observed = await f.c.wait(() => f.observation(runId), "worker started and recorded input");
  return { runId, observed };
}
async function command(f: Fixture, payload: object, marker: (m: any) => boolean) {
  const from = f.c.messages.length;
  f.c.send(payload);
  const end = await f.c.wait(() => f.c.messages.slice(from).find(marker), "command acknowledgement");
  return f.c.messages.slice(from, f.c.messages.indexOf(end) + 1);
}
function stillWorking(f: Fixture, runId: string, seen: any[]) {
  assert.equal(seen.some((m) => m.runId === runId && ["runFinish", "runStop", "runFail"].includes(m.type)), false, "no premature terminal message");
  assert.equal(f.c.tab("fixed").runs.find((r: any) => r.id === runId).status, "working", "stop acceptance leaves worker working");
  assert.equal(f.journal().executions.find((e: any) => e.id === runId).processEnded, false);
}
async function closed(f: Fixture, runId: string, pid: number) {
  const run = await f.ended(runId);
  assert.equal(run.status, "stopped");
  await f.c.wait(() => f.children().some((e: any) => e.event === "close" && (nativeProcess || e.pid === pid)), "owned worker controlled close");
  assert.equal(f.journal().executions.find((e: any) => e.id === runId).processEnded, true);
  assert.ok(f.c.messages.some((m) => m.type === "runStop" && m.runId === runId), "terminal confirmation after close");
}
function approvalClearedBeforeAck(seen: any[]) {
  const states = seen.filter((m) => m.type === "state");
  assert.ok(states.some((m) => m.projects.flatMap((p: any) => p.tabs).find((t: any) => t.id === "fixed").pendingApprovals.length === 0), "approval denied before acknowledgement");
}

test("O1 one bridge serves a leader's key and a run's key side by side, each with its own token", async () => {
  const bridge = createLeaderBridge();
  const supplied = [{ name: "get_fixed_task", description: "Read the task.", shape: {}, handler: async () => ({ content: [{ type: "text" as const, text: "{}" }] }) }];
  const specs = buildLeaderToolSpecs({ fixedSpecs: () => supplied, tabName: "t" });
  assert.deepEqual(specs.map((spec) => spec.name), ["get_fixed_task"], "the bridge serves the supplied fixed specs");
  const leader = bridge.open("tab-x", specs), run = bridge.open("tab-x.run-1", specs);
  const http = createServer((req, res) => { void bridge.handle(req, res, decodeURIComponent(req.url!.split("/").pop()!)); });
  try {
    http.listen(0, "127.0.0.1"); await once(http, "listening");
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}/api/leader-mcp/`;
    const ask = async (key: string, token: string) => (await bridgeCall(base + encodeURIComponent(key), token, "tools/list")).status;
    assert.deepEqual([await ask("tab-x", leader.token), await ask("tab-x.run-1", run.token)], [200, 200], "both entries answer");
    const listed = await bridgeCall(base + "tab-x", leader.token, "tools/list");
    assert.deepEqual(listed.body.result.tools.map((t: any) => t.name), ["get_fixed_task"], "an authenticated entry lists exactly the supplied fixed tools");
    assert.deepEqual([await ask("tab-x", run.token), await ask("tab-x.run-1", leader.token)], [401, 401], "tokens are key-specific");
    run.revoke();
    assert.deepEqual([await ask("tab-x", leader.token), await ask("tab-x.run-1", run.token)], [200, 401], "independent run revocation");
    const next = bridge.open("tab-x.run-2", specs); leader.revoke();
    assert.deepEqual([await ask("tab-x", leader.token), await ask("tab-x.run-2", next.token)], [401, 200], "independent leader revocation");
    next.revoke();
  } finally { leader.revoke(); run.revoke(); await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())); }
});

test("O3 fixed leader launches name the current Leader in runStart, live view and saved notices; manual Run requests the leader", { timeout: 60_000 }, async () => {
  const f = await fixedServer();
  try {
    f.worker({ delay: 2000 });
    const brief = "Inspect the owned file with this exact brief";
    const launch = await f.tool("begin_planning", { expected: null, brief }); assert.equal(launch.ok, true, launch.text);
    const start = f.c.messages.find((m) => m.type === "runStart" && m.runId === launch.value.runId);
    assert.ok(start, "actual runStart"); assert.deepEqual(start.launchedBy, leaderIdentity); assert.equal(start.seatKey, "fixed.planner");
    const live = f.c.tab("fixed").runs.find((r: any) => r.id === start.runId);
    assert.equal(live.status, "working"); assert.deepEqual(live.launchedBy, leaderIdentity); assert.equal(live.seatSlotId, "planner");
    assert.equal(live.label, brief);
    const notice = f.c.messages.find((m) => m.type === "leaderLaunch" && m.seatId === "fixed.planner");
    assert.ok(notice, "every launch broadcasts its notice");
    assert.deepEqual([notice.source, notice.seatId, notice.brief], ["Leader", start.seatKey, brief]);
    assert.ok(existsSync(safetyPath(f)), "launch safety is durably saved");
    assert.deepEqual(safety(f).notices, [notice], "saved notice matches actual broadcast");
    const reconnected = await client(f.server);
    try { assert.deepEqual(reconnected.state().launchSafety.notices, [notice], "reload replays queued notice"); }
    finally { reconnected.close(); }
    await f.ended(start.runId);
    const before = snapshot(f);
    const seen = await command(f, { type: "run", tabId: "fixed", slot: "coder", prompt: "Owner manual request" }, (m) => m.type === "fixedRunRequested");
    assert.ok(seen.some((m) => m.type === "fixedRunRequested" && m.slot === "coder"));
    await f.c.wait(() => f.c.messages.some((m) => m.type === "chatDone" && m.tabId === "fixed" && f.c.messages.indexOf(m) > f.c.messages.indexOf(seen.at(-1))), "manual request leader reply");
    assert.deepEqual(snapshot(f), before, "manual Run did not launch a worker or reserve budget");
  } finally { await f.close(); }
});

test("O4/O11 Ask uses one current-leader fixed-action approval and refuses Save/chat; wrong identity and denial launch nothing", { timeout: 60_000 }, async () => {
  const f = await fixedServer({ secondTab: true, assignments: { leader: leaderAssignment } });
  try {
    const { item, result } = await pending(f, "Exact approval brief");
    assert.deepEqual(item.askedBy, leaderIdentity); assert.equal(item.tool, "fixed-action"); assert.match(item.summary, /^Action: planning\nPosition: Planner \(planner\)\nExecution: codex \/ gpt-6.1-sol \/ medium\nFolder:/); assert.ok(item.summary.endsWith("Leader brief:\nExact approval brief"));
    assert.equal(f.c.tab("fixed").pendingApprovals.length, 1);
    const before = snapshot(f); assert.equal(before.journal, null); assert.equal(before.task, null); assert.equal(before.spawns, 0); assert.equal(before.starts, 0);
    assert.equal(before.safety?.timestamps.length ?? 0, 0); assert.equal(before.safety?.notices.length ?? 0, 0);
    assert.match((await f.c.attempt({ type: "save", tabId: "fixed" })).error ?? "", /Leader is waiting for your answer/);
    assert.match((await f.c.attempt({ type: "chat", tabId: "fixed", text: "Are you there?" })).error ?? "", /Leader is waiting for your answer/);
    for (const identity of [{ tabId: "fixed-second", approvalId: item.approvalId }, { tabId: "fixed", approvalId: "wrong-id" }]) {
      const answer = await f.c.request({ type: "answerApproval", ...identity, allow: true }); assert.equal(answer.ok, false); assert.match(answer.message!, /no longer available/);
      assert.equal(f.c.tab("fixed").pendingApprovals.length, 1); assert.deepEqual(snapshot(f), before);
    }
    assert.deepEqual(await f.c.request({ type: "answerApproval", tabId: "fixed", approvalId: item.approvalId, allow: false }), { ok: true });
    assert.equal((await result).ok, false); assert.deepEqual(snapshot(f), before, "denial has no execution effects");
    const allowed = await pending(f, "Separate allowed action");
    assert.deepEqual(await f.c.request({ type: "answerApproval", tabId: "fixed", approvalId: allowed.item.approvalId, allow: true }), { ok: true });
    const launched = await allowed.result; assert.equal(launched.ok, true, launched.text); await f.ended(launched.value.runId);
    assert.equal(f.c.tab("fixed").pendingApprovals.length, 0); assert.equal(f.journal().executions.length, 1);
    assert.equal(f.children().filter((e: any) => e.worker && e.event === "start").length, 1);
    assert.equal(f.c.messages.filter((m) => m.type === "runStart").length, 1);
  } finally { await f.close(); }
});

test("O4 Stop on a fixed worker persists a block until explicit unblock; Stop on the leader denies approval and revokes its bridge", { timeout: 60_000 }, async () => {
  const f = await fixedServer({ nativeProcess });
  try {
    const { runId, observed } = await deferred(f);
    const seen = await command(f, { type: "stopSeat", tabId: "fixed", slot: "planner" }, (m) => m.type === "state" && m.launchSafety.blocked.includes("fixed.planner"));
    assert.ok(safety(f).blocked.includes("fixed.planner"), "Stop block is durable");
    if (!nativeProcess) stillWorking(f, runId, seen);
    await closed(f, runId, observed.pid);
    const refused = await f.tool("begin_planning", { expected: null, brief: "Still blocked" });
    assert.equal(refused.ok, false, "another fixed launch stays blocked"); assert.match(refused.text, /launch blocked after a prior stop/);
    assert.equal(f.children().filter((e: any) => e.worker && e.event === "start").length, 1);
    await command(f, { type: "clearLaunchBlock", seatKey: "fixed.planner", confirm: "allow this seat to launch again" }, (m) => m.type === "launchBlockCleared");
    f.worker({}); const next = await f.tool("begin_planning", { expected: null, brief: "Explicitly unblocked" }); assert.equal(next.ok, true, next.text); await f.ended(next.value.runId);
  } finally { await f.close(); }
  const leader = await fixedServer({ nativeProcess, assignments: { leader: leaderAssignment } });
  try {
    const approval = await pending(leader);
    const seen = await command(leader, { type: "stopSeat", tabId: "fixed", slot: "leader" }, (m) => m.type === "state" && m.projects[0].tabs[0].leaderStatus === "not-started");
    approvalClearedBeforeAck(seen); assert.equal((await approval.result).ok, false);
    assert.equal((await bridgeCall(approval.bridge.url, approval.bridge.token, "tools/list")).status, 401);
    assert.equal(leader.c.messages.filter((m) => m.type === "runStart").length, 0);
  } finally { await leader.close(); }
});

test("O4 killRun dispatch stops the identified fixed worker, persists its block and confirms only after close", { timeout: 30_000 }, async () => {
  const f = await fixedServer({ nativeProcess });
  try {
    const { runId, observed } = await deferred(f);
    const seen = await command(f, { type: "killRun", runId }, (m) => m.type === "killAccepted" && m.runId === runId);
    assert.equal(seen.at(-1).runId, runId); assert.ok(safety(f).blocked.includes("fixed.planner"), "killRun block durably names the worker seat");
    if (!nativeProcess) stillWorking(f, runId, seen);
    await closed(f, runId, observed.pid);
  } finally { await f.close(); }
});

test("O4 Stop all denies the leader approval before acknowledgement, revokes its bridge and blocks the fixed worker until close", { timeout: 30_000 }, async () => {
  const f = await fixedServer({ nativeProcess, assignments: { leader: leaderAssignment } });
  try {
    const { runId, observed } = await deferred(f);
    const approval = await pending(f);
    const seen = await command(f, { type: "stopAll" }, (m) => m.type === "stopAllAccepted");
    approvalClearedBeforeAck(seen); assert.equal((await approval.result).ok, false);
    assert.equal((await bridgeCall(approval.bridge.url, approval.bridge.token, "tools/list")).status, 401, "actual leader bridge revoked");
    assert.ok(safety(f).blocked.includes("fixed.planner"));
    if (!nativeProcess) stillWorking(f, runId, seen);
    await closed(f, runId, observed.pid);
  } finally { await f.close(); }
});

test("O5 Plan refuses begin_planning and read-only assist without execution effects; bypass control succeeds", { timeout: 30_000 }, async () => {
  const f = await fixedServer();
  try {
    await f.tool("get_fixed_task"); await mode(f, "plan"); const before = snapshot(f);
    const result = await f.tool("begin_planning", { expected: null, brief: "Plan must change nothing" });
    assert.equal(result.ok, false, "Plan action must be refused"); assert.match(result.text, /Plan mode/);
    await assert.rejects(f.assist("researcher"), /Plan mode/); assert.deepEqual(snapshot(f), before, "Plan changes no journal, task, run, budget, notice or spawn");
    await mode(f, "bypass"); f.worker({}); const control = await f.assist("researcher"); await f.ended(control.runId);
    assert.equal(f.journal().executions.length, 1);
  } finally { await f.close(); }
});

test("O6 fixed Planner receives no bridge credentials; current leader exposes only fixed tools and direct workers require a reservation", { timeout: 30_000 }, async () => {
  const f = await fixedServer({ assignments: { leader: leaderAssignment } });
  try {
    await f.tool("get_fixed_task"); const bridge = await f.control("leader-bridge");
    const list = await bridgeCall(bridge.url, bridge.token, "tools/list");
    assert.equal(list.status, 200); assert.deepEqual(list.body.result.tools.map((t: any) => t.name).sort(), ["accept_planner_report", "begin_planning", "finish_fixed_task", "get_fixed_task", "get_task_archive", "list_task_archives", "reconcile_task_execution", "request_task_action", "verify_task_evidence"]);
    const before = snapshot(f);
    for (const name of ["launch_seat", "advance_step", "report_round", "finish_fix", "wait_for_runs"]) {
      const reply = await f.tool(name); assert.equal(reply.ok, false); assert.match(reply.text, /unknown tool/);
    }
    assert.deepEqual(snapshot(f), before);
    // Direct real launch boundary in the fixture's isolated module root, no server reservation.
    const tab = modules.config.defaultWorkspaces(f.server.work).projects[0].tabs[0]; tab.id = "direct";
    modules.state.setWorkspaces({ projects: [{ id: "direct", name: "Direct", folder: f.server.work, tabs: [tab] }] });
    const { launchWorker } = await import("../server/main/launch.ts");
    modules.state.setLaunchSafety({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] });
    const direct = launchWorker("direct", "planner", "Direct unreserved worker");
    assert.equal(direct.ok, false); assert.match((direct as any).error, /current leader/); assert.equal(modules.state.runRecords.size, 0);
    assert.equal(modules.state.launchSafety.timestamps.length, 0); assert.deepEqual(snapshot(f), before);
    f.worker({}); const started = await f.tool("begin_planning", { expected: null, brief: "Credential isolation" }); assert.equal(started.ok, true, started.text); await f.ended(started.value.runId);
    const input = f.observation(started.value.runId), spawn = f.spawnCapture(started.value.runId);
    assert.ok(input); assert.ok(spawn);
    assert.deepEqual([input.bridge, input.tokenPresent, input.mcp, input.opencodeConfigPresent], [null, false, null, false]);
    assert.deepEqual([spawn.crewUrlPresent, spawn.tokenPresent, spawn.mcpPresent, spawn.opencodeConfigPresent], [false, false, false, false]);
  } finally { await f.close(); }
});

test("O7 a working fixed execution blocks another position and another tab without reservation or spawn; confirmed end frees the slot", { timeout: 30_000 }, async () => {
  const f = await fixedServer({ secondTab: true });
  try {
    await f.tool("get_fixed_task", {}, "fixed-second");
    f.worker({ delay: 2500 }); const first = await f.tool("begin_planning", { expected: null, brief: "Hold heavy slot" }); assert.equal(first.ok, true, first.text);
    await f.c.wait(() => f.observation(first.value.runId), "first actual execution");
    const before = snapshot(f);
    await assert.rejects(f.assist("researcher"), /still active|already reserved|not.*ended|not confirmed/i, "second position cannot reserve or execute");
    const second = await f.tool("begin_planning", { expected: null, brief: "Other fixed tab" }, "fixed-second");
    assert.equal(second.ok, false, "second tab cannot execute"); assert.deepEqual(snapshot(f), before);
    assert.equal(existsSync(join(f.server.data, "executions", "fixed-second.json")), false, "no second-tab reservation");
    await f.ended(first.value.runId); assert.equal(f.journal().executions[0].processEnded, true);
    f.worker({}); const next = await f.assist("researcher"); await f.ended(next.runId); assert.equal(f.journal().executions.length, 2);
  } finally { await f.close(); }
});

test("O8 eight finite fixed launches save tab-scoped stamps and notices, ninth refuses with positive wait; another tab launches independently", { timeout: 60_000 }, async () => {
  const f = await fixedServer({ secondTab: true, extra: ({ data }) => writeFileSync(join(data, "config", "launch-safety.json"), JSON.stringify({ blocked: [], timestamps: Array(8).fill(Date.now()), notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] })) });
  try {
    for (let i = 0; i < 8; i++) {
      f.worker({}); const run = await f.tool("begin_planning", { expected: null, brief: `Finite launch ${i + 1}` });
      assert.equal(run.ok, true, `launch ${i + 1}: ${run.text}`); await f.ended(run.value.runId);
      assert.equal(f.journal().executions[i].processEnded, true);
      assert.equal(safety(f).timestamps.filter((s: any) => s.tabId === "fixed").length, i + 1, "each launch saves one budget stamp");
    }
    const before = safety(f), spawns = f.children().filter((e: any) => e.worker && e.event === "start").length;
    const ninth = await f.tool("begin_planning", { expected: null, brief: "Ninth must not spawn" }); assert.equal(ninth.ok, false, "ninth launch refused");
    const match = /8 launches in 5 minutes on tab "([^"]+)",.*allowed in (\d+) s/.exec(ninth.text);
    assert.ok(match, ninth.text); assert.equal(match[1], f.c.tab("fixed").name); assert.ok(Number(match[2]) > 0);
    assert.equal(before.notices.length, 8); assert.equal(before.timestamps.length, 8); assert.deepEqual(safety(f), before);
    assert.equal(f.children().filter((e: any) => e.worker && e.event === "start").length, spawns); assert.equal(spawns, 8);
    const other = await f.tool("begin_planning", { expected: null, brief: "Independent budget" }, "fixed-second"); assert.equal(other.ok, true, other.text); await f.ended(other.value.runId, "fixed-second");
    const stamps = safety(f).timestamps;
    assert.equal(stamps.length, 9); assert.ok(stamps.every((s: any) => typeof s === "object" && s.tabId && Number.isFinite(s.at)));
    assert.equal(stamps.filter((s: any) => s.tabId === "fixed").length, 8); assert.equal(stamps.filter((s: any) => s.tabId === "fixed-second").length, 1);
  } finally { await f.close(); }
});

test("O9/S13 fixed report intake refuses a working run, then accepts its matching ended journal identity and saved existing log", { timeout: 30_000 }, async () => {
  const f = await fixedServer();
  try {
    f.worker({ delay: 1800, plan: plan() }); const run = await f.tool("begin_planning", { expected: null, brief: "Bound planner report" }); assert.equal(run.ok, true, run.text);
    const refused = await f.tool("accept_planner_report", { expected: null, runId: run.value.runId }); assert.equal(refused.ok, false); assert.equal(f.task(), null);
    await f.ended(run.value.runId);
    const execution = f.journal().executions.find((e: any) => e.id === run.value.runId);
    assert.ok(execution); assert.equal(execution.processEnded, true); assert.equal(execution.status, "done");
    assert.equal(execution.tabId, "fixed"); assert.equal(execution.taskId, null); assert.equal(execution.planVersion, 0);
    assert.ok(execution.logPath && existsSync(execution.logPath), "matching saved log path exists");
    const accepted = await f.tool("accept_planner_report", { expected: null, runId: run.value.runId }); assert.equal(accepted.ok, true, accepted.text);
    assert.equal(accepted.value.tabId, "fixed"); assert.equal(accepted.value.id, f.task().id); assert.equal(accepted.value.plan.id, "pack");
    assert.equal(f.journal().executions.find((e: any) => e.id === run.value.runId).consumed, true);
  } finally { await f.close(); }
});

test("a launch-safety file with plain numbers (from before the per-tab budget) still loads; the server turns it into per-tab stamps", () => {
  const path = join(scratchDir(), "old-safety.json");
  const base = { blocked: [], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] };
  try {
    writeFileSync(path, JSON.stringify({ ...base, timestamps: [5, 6] })); assert.deepEqual(modules.config.readLaunchSafety(path).timestamps, [5, 6]);
    writeFileSync(path, JSON.stringify({ ...base, timestamps: [5, { tabId: "t", at: 6 }] })); assert.deepEqual(modules.config.readLaunchSafety(path).timestamps, [5, { tabId: "t", at: 6 }]);
    writeFileSync(path, JSON.stringify({ ...base, timestamps: [{ tabId: "", at: 6 }] })); assert.throws(() => modules.config.readLaunchSafety(path), /invalid launch safety state/);
  } finally { unlinkSync(path); }
});
