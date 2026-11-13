import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fixedServer, modules, fixedTab, assignment } from "./fixed-crew-execution-helpers.ts";
import { launchWorker } from "../server/main/launch.ts";
import { scratchDir, fakeCliOnPath } from "./temp-root.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runSeat, isRunning, runIdsForSeat } from "../server/runner.ts";
import { validateAssignment } from "../server/fixed-crew/assignment.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";

test("FCX presence routes runtime without saving seats or imposing the legacy sixteen seat cap", () => {
  const tab = fixedTab("C:/test");
  modules.state.setWorkspaces({ projects: [{ id: "p", name: "P", folder: tab.folder, tabs: [tab] }] });
  const runtime = modules.tabs.runtimeFor(tab);
  assert.equal(runtime.state.seats.length, 18, "all fixed definitions project through the real runtime entry point");
  assert.equal("steps" in runtime.state, false, "the runtime state has no workflow steps"); assert.deepEqual(tab.crew, []);
  assert.equal(modules.tabs.crewDefinition(tab, "planner")?.orchestrates, undefined);
  (tab as any).fixedCrew = null;
  assert.equal(modules.runtime.isFixedTab(tab), true);
  assert.equal(modules.tabs.runtimeFor(tab).state.seats.length, 0, "unavailable fixed data never becomes legacy");
  assert.equal(launchWorker(tab.id, "coder", "build").ok, false);
  // A tab with no fixed crew at all never starts a worker (the legacy role-instruction launch is gone).
  const plain = fixedTab("C:/test"); plain.id = "plain-tab"; delete (plain as any).fixedCrew;
  modules.state.setWorkspaces({ projects: [{ id: "p", name: "P", folder: tab.folder, tabs: [tab, plain] }] });
  assert.deepEqual(launchWorker("plain-tab", "coder", "build"), { ok: false, error: "Only a fixed crew can start workers." });
  assert.equal(modules.state.runContexts.size, 0);
  tab.fixedCrew = fixedTab("C:/test").fixedCrew;
  modules.state.setUnconfirmedRunIds(new Set()); modules.state.setBlockedSeatKeys(new Set(["fixed.coder"]));
  modules.state.setLaunchSafety(modules.config.readLaunchSafety(join(scratchDir(), "absent.json")));
  for (const source of ["client", "leader", "seat"] as const) {
    const refused = launchWorker(tab.id, "coder", "build", source);
    assert.deepEqual(refused, { ok: false, error: "Fixed actions must be requested through the current leader." }, `${source} reaches the gate before spawn or budget`);
    assert.equal(modules.state.launchSafety.timestamps.length, 0); assert.equal(modules.state.runContexts.size, 0);
  }
});

test("FCX every known position resolves its own assignment and a cleared position has no fallback", () => {
  const tab = fixedTab(scratchDir());
  modules.state.setWorkspaces({ projects: [{ id: "p", name: "P", folder: tab.folder, tabs: [tab] }] });
  for (const { slot, role } of FIXED_CREW) {
    assert.deepEqual(modules.fixed.requireFixedAssignment(tab.id, slot), assignment, slot);
    tab.fixedCrew!.preferences[slot].assignment = null;
    assert.throws(() => modules.fixed.requireFixedAssignment(tab.id, slot), { message: `${role} has no model. Choose one in Settings before continuing.` });
    tab.fixedCrew!.preferences[slot].assignment = assignment;
  }
  assert.deepEqual(tab.crew, []);
});

test("FCX fixed manual routes refuse an unknown position and request the leader without a worker spawn", { timeout: 60_000 }, async () => {
  const f = await fixedServer();
  try {
    const notices = f.c.state().launchSafety.notices.length;
    assert.equal((await f.c.attempt({ type: "run", tabId: "fixed", slot: "missing", prompt: "work" })).error, "Unknown crew slot");
    assert.deepEqual(await f.c.attempt({ type: "run", tabId: "fixed", slot: "leader", prompt: "work" }), {});
    assert.ok(f.c.messages.some((m) => m.type === "fixedRunRequested" && m.tabId === "fixed" && m.slot === "leader"));
    assert.equal(f.c.tab("fixed").runs.length, 0); assert.equal(f.c.state().launchSafety.notices.length, notices);
  } finally { await f.close(); }
});

test("FCX a rejected real runner start leaves no stall tracker, context, notice or budget reservation", async () => {
  const folder = scratchDir(), root = scratchDir(), { state, config } = modules;
  const unavailable = { cli: "claude" as const, model: "claude-unavailable-fixture-1e", effort: "medium" };
  assert.deepEqual(validateAssignment(unavailable), unavailable, "fixed assignment shape accepts the unavailable model");
  assert.equal(config.MODEL_OPTIONS.claude!.includes(unavailable.model), false);
  assert.equal(config.isValidModel("claude", unavailable.model), false, "runner model validation rejects it before spawn");
  const tab = fixedTab(folder, { planner: unavailable }); tab.id = "fixed-rejected-1e";
  const instance = {}, actor = { tabId: tab.id, instance, sessionId: "fixture-leader-1e" };
  const previous = { workspaces: state.workspaces, root: state.dataRoot, tasks: state.fixedTasks,
    settings: state.settingsService, safety: state.launchSafety, blocked: state.blockedSeatKeys, unconfirmed: state.unconfirmedRunIds };
  const maps = [state.stallTrackers.trackers, state.runContexts, state.runRecords] as Map<string, any>[];
  const snapshots = maps.map((map) => new Map(map));
  const safetyBytes = existsSync(config.launchSafetyPath) ? readFileSync(config.launchSafetyPath) : null;
  try {
    state.setWorkspaces({ projects: [{ id: "p", name: "P", folder, tabs: [tab] }] });
    state.setDataRoot(root); state.setFixedTasks(createTaskStore(root, () => folder));
    state.setSettingsService({ permissionMode: () => "bypass" } as any);
    state.leaderInstances.set(tab.id, instance); state.leaders.set(tab.id, { isDead: () => false, getPermissionMode: () => "bypassPermissions" } as any);
    state.setUnconfirmedRunIds(new Set()); state.setBlockedSeatKeys(new Set());
    state.setLaunchSafety(config.readLaunchSafety(join(root, "absent.json")));
    config.writeLaunchSafety(state.launchSafety);
    const safety = structuredClone(state.launchSafety), runtime = modules.tabs.runtimeFor(tab);
    const runs = structuredClone(runtime.state.runs), runnerIds = runIdsForSeat(`${tab.id}.planner`);
    const before = modules.journal.executionJournal(root, tab.id);
    assert.equal(before.executions.length, 0);
    await assert.rejects(modules.tools.launchFixedAction(actor, null, "planning", "rejected brief"), {
      message: `buildCommand: refusing invalid model for "${tab.id}.planner": ${unavailable.model}`,
    });
    const journal = modules.journal.executionJournal(root, tab.id);
    assert.equal(journal.executions.length, 1, "fixed execution was reserved before real runner refusal");
    const execution = journal.executions[0];
    assert.equal(execution.kind, "planning"); assert.equal(execution.role, "planner");
    assert.deepEqual(execution.assignment, unavailable);
    assert.equal(execution.status, "failed"); assert.equal(execution.processEnded, true);
    assert.equal(execution.consumed, false); assert.equal(execution.logPath, null);
    assert.equal(journal.activeExecutionId, null);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "executions", `${tab.id}.json`), "utf8")), journal, "saved journal agrees with memory");
    assert.deepEqual(runtime.state.runs, runs, "refused runner leaves no runtime working run");
    assert.equal(isRunning(execution.id), false); assert.deepEqual(runIdsForSeat(`${tab.id}.planner`), runnerIds);
    for (const [index, label] of ["stall tracker", "run context", "run record"].entries()) {
      assert.deepEqual([...maps[index]], [...snapshots[index]], `a rejected runner must not start a ${label}`);
    }
    assert.deepEqual(state.launchSafety, safety, "no consumed timestamp, notice or live reservation remains");
    assert.deepEqual(config.readLaunchSafety(), safety, "saved safety agrees with rolled-back memory");
  } finally {
    state.setWorkspaces(previous.workspaces); state.setDataRoot(previous.root); state.setFixedTasks(previous.tasks);
    state.setSettingsService(previous.settings); state.setLaunchSafety(previous.safety);
    state.setBlockedSeatKeys(previous.blocked); state.setUnconfirmedRunIds(previous.unconfirmed);
    state.leaderInstances.delete(tab.id); state.leaders.delete(tab.id); state.tabs.delete(tab.id);
    maps.forEach((map, index) => { map.clear(); for (const [key, value] of snapshots[index]) map.set(key, value); });
    if (safetyBytes) writeFileSync(config.launchSafetyPath, safetyBytes);
    else if (existsSync(config.launchSafetyPath)) unlinkSync(config.launchSafetyPath);
  }
});

test("FCX low-priority runner applies the injected boundary to its owned child and reports confirmed or unknown trees separately", async () => {
  fakeCliOnPath();
  for (const confirmed of [true, false]) {
    const child = Object.assign(new EventEmitter(), { pid: 123456, stdout: new PassThrough(), stderr: new PassThrough() });
    const priorities: number[] = [], evidence: string[] = [], spawnOptions: any[] = [];
    let resolveEnd!: () => void;
    const ended = new Promise<void>((resolve) => { resolveEnd = resolve; });
    const result = runSeat({ runId: `priority-${confirmed}`, seatKey: "fixed.planner", slotId: "planner", name: "Planner", ...assignment,
      folder: scratchDir(), canWrite: false, startedAt: Date.now(), lowPriority: true }, "bounded brief", {
      onOutput() {}, onTreeEnd(_run, value) { evidence.push(value); }, onStatus(_run, status) { if (status !== "working") resolveEnd(); },
    }, ((_command: any, options: any) => { spawnOptions.push(options); return child; }) as any,
    { priority(pid) { priorities.push(pid); }, watch: { sweep: async () => confirmed ? 0 : null, failed: 0 } as any });
    assert.equal(result.ok, true); assert.deepEqual(priorities, [child.pid], "priority is applied exactly once to the owned child");
    assert.equal(spawnOptions[0].windowsHide, true);
    child.emit("close", 0); await ended;
    assert.deepEqual(evidence, [confirmed ? "confirmed" : "unknown"]);
  }
});

test("FCX manual Run routes a request through the leader and unassigned positions name Settings", { timeout: 60_000 }, async () => {
  const f = await fixedServer({ assignments: { leader: null } });
  try {
    const before = f.c.state().launchSafety.notices.length;
    assert.match((await f.c.attempt({ type: "run", tabId: "fixed", slot: "coder", prompt: "build" })).error!, /^Leader has no model\. Choose one in Settings before continuing\.$/);
    assert.equal(f.c.state().launchSafety.notices.length, before);
    assert.equal(f.c.tab("fixed").runs.length, 0);
    const saved = JSON.parse(readFileSync(join(f.server.data, "config", "workspaces.json"), "utf8"));
    assert.deepEqual(saved.projects[0].tabs[0].crew, [], "runtime never persists the projection");
  } finally { await f.close(); }
});

test("FCX real leader tools launch the Planner without a bridge and reserve one heavy execution atomically", { timeout: 90_000 }, async () => {
  const f = await fixedServer();
  try {
    f.worker({ delay: 600 });
    const start = await f.tool("begin_planning", { expected: null, brief: "plan" });
    assert.equal(start.ok, true, start.text);
    const second = await f.tool("begin_planning", { expected: null, brief: "another" });
    assert.equal(second.ok, false, "no second heavy worker");
    assert.match(second.text, /process tree|reserved/);
    assert.equal((await f.ended(start.value.runId)).status, "done", "the role/report brief reaches the actual Planner child");
    const observed = JSON.parse(readFileSync(join(f.server.temp, "worker-observed.json"), "utf8"));
    assert.ok(existsSync(join(f.server.temp, "priority-observed.jsonl")), "fixed launch must call the low-priority boundary");
    const priority = readFileSync(join(f.server.temp, "priority-observed.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(priority.length, 1, "fixed launch requests low priority exactly once");
    assert.ok(priority[0].pid > 0, "priority boundary receives its owned shell child");
    assert.ok(observed.priority > 0, "the actual fake worker inherits below-normal priority");
    assert.equal(observed.bridge, null); assert.equal(observed.mcp, null);
    assert.match(observed.brief, /You are the Planner/);
    assert.doesNotMatch(observed.brief, /Your role: Planner\. You run the process/);
    assert.deepEqual(start.value.assignment, assignment);
    const journal = JSON.parse(readFileSync(join(f.server.data, "executions", "fixed.json"), "utf8"));
    assert.equal(journal.executions.length, 1);
    assert.equal(journal.executions[0].processEnded, true);
    assert.equal(journal.activeExecutionId, null);
  } finally { await f.close(); }
});
