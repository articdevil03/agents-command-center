import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import * as stall from "../server/stall.ts";
import { scratchDir, tempRoot } from "./temp-root.ts";
import { config, leaderApi } from "./round2-setup.ts";
import { loadServer, connect, lastState, tick } from "./round2-helpers.ts";

test("resolveClaudeCli: CLAUDE_CLI_PATH may name an install directory", () => {
  const dir = tempRoot(), exe = path.join(dir, "claude.exe"); writeFileSync(exe, "binary placeholder");
  assert.equal(leaderApi.resolveClaudeCli({ CLAUDE_CLI_PATH: dir, PATH: "" }, path.join(dir, "absent.exe")), exe);
});

test("resolveClaudeCli: environment path wins, then known install, then PATH, then null", () => {
  const dir = tempRoot(), envExe = path.join(dir, "env.exe"), known = path.join(dir, "known.exe"), pathExe = path.join(dir, "path", "claude.exe");
  mkdirSync(path.dirname(pathExe)); writeFileSync(envExe, "x"); writeFileSync(known, "x"); writeFileSync(pathExe, "x");
  assert.equal(leaderApi.resolveClaudeCli({ CLAUDE_CLI_PATH: envExe, PATH: path.dirname(pathExe) }, known), envExe);
  assert.equal(leaderApi.resolveClaudeCli({ PATH: path.dirname(pathExe) }, known), known);
  assert.equal(leaderApi.resolveClaudeCli({ PATH: path.dirname(pathExe) }, path.join(dir, "missing.exe")), pathExe);
  assert.equal(leaderApi.resolveClaudeCli({ PATH: "" }, path.join(dir, "missing.exe")), null);
});

test("resolveClaudeCli: a script-only PATH degrades to null rather than handing the SDK a cmd wrapper", () => {
  const dir = tempRoot(), cmd = path.join(dir, "claude.cmd"); writeFileSync(cmd, "@echo off");
  assert.equal(leaderApi.resolveClaudeCli({ PATH: dir }, path.join(dir, "missing.exe")), null);
});

test("resolveClaudeCli: PATH tolerates surrounding quotes and a trailing slash", () => {
  const dir = tempRoot(), exe = path.join(dir, "claude.exe"); writeFileSync(exe, "x");
  assert.equal(leaderApi.resolveClaudeCli({ PATH: `"${dir}\\"` }, path.join(dir, "missing.exe")), exe);
});

test("resolveClaudeCli: its default environment parameter reads the active process environment", () => {
  const dir = tempRoot(), exe = path.join(dir, "claude-default.exe"), prior = process.env.CLAUDE_CLI_PATH; writeFileSync(exe, "x");
  process.env.CLAUDE_CLI_PATH = exe;
  try { assert.equal(leaderApi.resolveClaudeCli(), exe); }
  finally { if (prior === undefined) delete process.env.CLAUDE_CLI_PATH; else process.env.CLAUDE_CLI_PATH = prior; }
});

test("resolveClaudeCli: the native installer's folder is looked up under the running user's own home, not a fixed account", () => {
  const home = scratchDir(), data = scratchDir(), exe = path.join(home, ".local", "bin", "claude.exe");
  mkdirSync(path.dirname(exe), { recursive: true }); writeFileSync(exe, "x");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CC_DATA_DIR: data, CC_TEST_FORCE_PACKAGED: "1", PATH: "" };
  delete env.CLAUDE_CLI_PATH;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `const { resolveClaudeCli } = await import(${JSON.stringify(pathToFileURL(path.resolve("server/leader.ts")).href)}); console.log(JSON.stringify(resolveClaudeCli()));`], { env, encoding: "utf8", timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const resolved = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  assert.equal(typeof resolved, "string", `the resolver found no claude.exe under the home: ${run.stdout}`);
  assert.equal(resolved.toLowerCase(), exe.replaceAll("\\", "/").toLowerCase());
});

test("runSeat dispatch rejects the in-process leader slot before any worker runner call", async () => {
  const server = await loadServer({ skipHealth: true });
  assert.match(server.launchWorker("alpha-dev", "leader", "not a worker").error, /leader runs in-process/);
  assert.equal(server.launched.length, 0);
});

test("runSeat dispatch wires actual onOutput to the run replay buffer and WebSocket broadcast", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "stream output"); const entry = server.launched[0];
  server.emitOutput(entry.run.runId, "visible answer");
  const run = server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
  assert.equal(run.output, "visible answer");
  assert.ok(ws.messages.some((message: any) => message.type === "output" && message.runId === entry.run.runId && message.chunk === "visible answer"));
});

test("runSeat dispatch wires status changes to process state and run lifecycle broadcasts", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "finish me"); const entry = server.launched[0];
  server.closeRun(entry.run.runId, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "runFinish" && message.runId === entry.run.runId));
  assert.equal(server.stateMessage().projects[0].tabs[0].runs.find((run: any) => run.runId === entry.run.runId).status, "done");
});

test("server.listen returns without waiting for a hung startup check, which aborts at its timeout", async () => {
  const errors: string[] = [], logs = { log() {}, error: (text: string) => errors.push(text) } as any;
  let signal: AbortSignal | undefined;
  const server = await loadServer({ healthTimeoutMs: 10, console: logs, query: (args) => {
    signal = args.options.abortController.signal;
    return { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }) };
  } });
  assert.equal(server.listenCalls(), 1);
  assert.equal(server.listenedPort(), 0, "test server requests an OS-assigned port, not 4317");
  await server.leaderHealthCheck;
  assert.equal(signal?.aborted, true); assert.ok(errors.some((line) => /health check timed out/.test(line)));
});

test("stall: an Atlas-started worker stays attributed to Atlas through its one automatic rerun", async () => {
  const writes: config.LaunchSafety[] = [];
  const server = await loadServer({ relaunchable: true, skipHealth: true, deferKill: true, onSafetyWrite: (value) => writes.push(value) }), ws = connect(server);
  server.leaderLaunch("alpha-dev", "reviewer2", "Atlas brief"); const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  server.closeRun(first.run.runId);
  const second = server.launched[1];
  assert.equal(second.prompt, "Atlas brief");
  assert.equal(ws.messages.find((message: any) => message.type === "runStart" && message.runId === second.run.runId).launchedBy?.kind, "leader");
  const notices = ws.messages.filter((message: any) => message.type === "leaderLaunch");
  assert.equal(notices.length, 2);
  assert.deepEqual(notices.map((message: any) => message.source), ["Atlas", "Stall relaunch"]);
  assert.ok(writes.some((value) => value.notices.some((notice) => notice.seatId === "alpha-dev.reviewer2" && notice.source === "Stall relaunch" && notice.pending)), "the relaunch notice is durable before the stall replacement starts");
});

test("stall: a second stall for the same logical run escalates instead of relaunching again", async () => {
  const server = await loadServer({ skipHealth: true });
  server.launchWorker("alpha-dev", "reviewer2", "one retry"); const first = server.launched[0];
  server.stallTrackers.markRelaunched(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.launched.length, 1);
  assert.ok(server.stateMessage().projects[0].tabs[0].runs.some((run: any) => run.runId === first.run.runId));
});

test("stall: a silent read-only Codex run is marked stalled, killed, and relaunched with the same brief once", async () => {
  const server = await loadServer({ relaunchable: true, skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "identical retry brief"); const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.launched.length, 2); assert.equal(server.launched[1].prompt, "identical retry brief");
  assert.equal(server.launched[1].run.canWrite, false);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === first.run.runId && message.action === "relaunch"));
});

test("stall: visible output after a stall recovers the actual run callback back to working", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "recover"); const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(entry.run.runId), true);
  server.emitOutput(entry.run.runId, "new visible bytes");
  assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(entry.run.runId), false);
  assert.ok(ws.messages.some((message: any) => message.type === "output" && message.chunk === "new visible bytes"));
  server.closeRun(entry.run.runId, 0);
  assert.equal(server.active.size, 0, "the run this test started is closed");
});

test("stall: visible stderr bytes use the same real output callback and recover the tracker", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true }); connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "stderr recovery"); const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  server.emitOutput(entry.run.runId, "stderr: still working", "stderr");
  assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(entry.run.runId), false);
  assert.equal(server.stateMessage().projects[0].tabs[0].runs.find((run: any) => run.runId === entry.run.runId).output, "stderr: still working");
  server.closeRun(entry.run.runId, 0);
  assert.equal(server.active.size, 0, "the run this test started is closed");
});

test("stall: a run that cannot be relaunched is marked stalled immediately and never gets Kill", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "no relaunch"); const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.kills.length, 0); assert.equal(server.launched.length, 1);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.action === "escalate"));
});

test("startLeader wires its tab crew MCP server and explicit allowed-tools list without a prompt", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start leader" }); await tick();
  const tools = server.leaderToolOptions[0];
  assert.ok(tools.mcpServers["tab-crew"]); assert.deepEqual([...tools.allowedTools], ["get_crew_status", "launch_seat", "send_request", "list_requests"]);
});

test("two workspaces migrations racing for one destination preserve the first published file", () => {
  const root = tempRoot(), configDir = path.join(root, "config"); mkdirSync(configDir);
  const projects = path.join(configDir, "projects.json"), destination = path.join(configDir, "workspaces.json");
  writeFileSync(projects, JSON.stringify([{ id: "race", name: "First", dir: "C:/first" }]));
  const first = config.migrateWorkspaces(projects, destination); const before = readFileSync(destination, "utf8");
  writeFileSync(projects, JSON.stringify([{ id: "race", name: "Second", dir: "C:/second" }]));
  const second = config.migrateWorkspaces(projects, destination);
  assert.equal(first, true); assert.equal(second, false); assert.equal(readFileSync(destination, "utf8"), before);
});

test("updateSeat for the tab leader calls live setModel and does not stop or restart the session", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" }); await tick();
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5" }); await tick();
  assert.deepEqual(server.leaderHandles[0].modelCalls, ["claude-opus-5"]); assert.equal(server.leaderHandles[0].stopCalls, 0);
  assert.equal(lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader").model, "claude-opus-5");
});

test("live leader model change saves name, effort, and pic from the same message", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" }); await tick();
  const pic = "/api/avatar/avatar-00000000-0000-4000-8000-000000000001.png";
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", name: "Atlas New", model: "claude-opus-5", effort: "high", pic });
  await tick();
  const leader = lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader");
  assert.deepEqual([leader.name, leader.model, leader.effort, leader.pic], ["Atlas New", "claude-opus-5", "high", pic]);
  assert.deepEqual(server.leaderHandles[0].modelCalls, ["claude-opus-5"]);
});

test("updateSeat on a dead tab leader skips live setModel but still saves the chosen model", async () => {
  const server = await loadServer({ skipHealth: true, leaderDead: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create dead leader" }); await tick();
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5" });
  assert.deepEqual(server.leaderHandles[0].modelCalls, []);
  assert.equal(lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader").model, "claude-opus-5");
});

test("updateSeat: a rejected live model change keeps the old saved value and sends an error", async () => {
  const server = await loadServer({ skipHealth: true, setModelResult: false }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" }); await tick();
  const before = lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader").model;
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5" }); await tick();
  assert.equal(lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader").model, before);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /model change failed/.test(message.message)));
});

test("usage: a dead tab leader restart banks its previous spend before the next instance reports", async () => {
  const server = await loadServer({ skipHealth: true, usageDelta: { modelId: "claude-opus-5-5[1m]", contextTokens: 10, contextWindow: 1000000, costUsd: 0.1 } }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "first turn" }); await tick();
  assert.equal(lastState(ws).projects[0].tabs[0].leaderUsage.costUsd, 0.1);
  server.leaderHandles[0].dead = true;
  ws.message({ type: "chat", tabId: "alpha-dev", text: "new leader turn" }); await tick();
  assert.equal(server.leaderCreates.length, 2);
  assert.equal(lastState(ws).projects[0].tabs[0].leaderUsage.costUsd, 0.2);
});

test("usage: worker run state contains no fake usage entry before anything is measured", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "review");
  const entry = server.launched[0], run = server.stateMessage().projects[0].tabs[0].runs[0];
  assert.equal(Object.hasOwn(run, "usage"), false);
  assert.equal(Object.hasOwn(run, "costUsd"), false);
  entry.callback.onUsage(entry.run, { modelId: null, contextTokens: 11, contextWindow: null, costUsd: 0.03 });
  const wireRun = lastState(ws).projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
  assert.equal(wireRun.usage.contextTokens, 11); assert.equal(wireRun.usage.costUsd, 0.03);
});

test("usage: leader turns stay scoped to their tab and clearing one tab resets only its usage", async () => {
  const server = await loadServer({ skipHealth: true, usageDelta: { modelId: "claude-opus-5-5[1m]", contextTokens: 9, contextWindow: 1000000, costUsd: 0.09 } }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "alpha" }); ws.message({ type: "chat", tabId: "beta-dev", text: "beta" }); await tick();
  let tabs = lastState(ws).projects.flatMap((project: any) => project.tabs);
  assert.equal(tabs.find((tab: any) => tab.id === "alpha-dev").leaderUsage.costUsd, 0.09);
  assert.equal(tabs.find((tab: any) => tab.id === "beta-dev").leaderUsage.costUsd, 0.09);
  ws.message({ type: "clear", tabId: "alpha-dev" }); await server.flush();
  tabs = lastState(ws).projects.flatMap((project: any) => project.tabs);
  assert.equal(tabs.find((tab: any) => tab.id === "alpha-dev").leaderUsage, undefined);
  assert.equal(tabs.find((tab: any) => tab.id === "beta-dev").leaderUsage.costUsd, 0.09);
});

test("leader launch options let a running session switch to bypass, without changing the starting mode", () => {
  const opus = { model: "claude-opus-5-5[1m]", effort: "high" };
  assert.equal(leaderApi.buildLeaderOptions(opus, "C:/work", null).allowDangerouslySkipPermissions, true);
  assert.equal(leaderApi.buildLeaderOptions(opus, "C:/work", null).permissionMode, "acceptEdits", "the default starting mode stays acceptEdits");
  for (const [mode, sdk] of [["ask", "default"], ["accept", "acceptEdits"], ["plan", "plan"], ["bypass", "bypassPermissions"]]) {
    const options = leaderApi.buildLeaderOptions(opus, "C:/work", null, undefined, mode);
    assert.equal(options.permissionMode, sdk);
    assert.equal(options.allowDangerouslySkipPermissions, true);
  }
});
