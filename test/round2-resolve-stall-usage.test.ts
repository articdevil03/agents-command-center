import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import * as stall from "../server/stall.ts";
import { scratchDir, tempRoot } from "./temp-root.ts";
import { config, leaderApi } from "./round2-setup.ts";
import { loadServer, loadFixed, connect, lastState, tick, ASSIST, startHelper, endRun } from "./round2-helpers.ts";

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

test("a fixed launch of the in-process leader slot is refused before any worker runner call", async () => {
  const server = await loadFixed({ skipHealth: true });
  server.createTabLeader("alpha-dev");
  const result = await server.launchFixedAction(server.currentActor("alpha-dev"), null, ASSIST, "not a worker", "leader").then(() => "launched", (error: Error) => error.message);
  assert.equal(result, "This position does not own the approved action.");
  assert.equal(server.launched.length, 0);
});

test("runSeat dispatch wires actual onOutput to the run replay buffer and WebSocket broadcast", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  await startHelper(server, "alpha-dev", "helper", "stream output"); const entry = server.launched[0];
  server.emitOutput(entry.run.runId, "visible answer");
  const run = server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
  assert.equal(run.output, "visible answer");
  assert.ok(ws.messages.some((message: any) => message.type === "output" && message.runId === entry.run.runId && message.chunk === "visible answer"));
  await endRun(server, entry.run.runId);
});

test("runSeat dispatch wires status changes to process state and run lifecycle broadcasts", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  await startHelper(server, "alpha-dev", "helper", "finish me"); const entry = server.launched[0];
  await endRun(server, entry.run.runId, "alpha-dev", 0);
  assert.ok(ws.messages.some((message: any) => message.type === "runFinish" && message.runId === entry.run.runId));
  assert.equal(server.stateMessage().projects[0].tabs[0].runs.find((run: any) => run.runId === entry.run.runId).status, "done");
  assert.equal(server.executionJournal(server.testRoot, "alpha-dev").executions.find((e: any) => e.id === entry.run.runId).status, "done");
});

test("stall: visible output after a stall recovers the actual run callback back to working", async () => {
  const server = await loadFixed({ skipHealth: true, deferKill: true }), ws = connect(server);
  await startHelper(server, "alpha-dev", "helper", "recover"); const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(entry.run.runId), true);
  server.emitOutput(entry.run.runId, "new visible bytes");
  assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(entry.run.runId), false);
  server.tick();
  assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(entry.run.runId), false, "recovered output restarted the growth clock, so the next tick does not stall it again");
  assert.equal(server.kills.length, 0); assert.equal(server.isRunning(entry.run.runId), true);
  assert.ok(ws.messages.some((message: any) => message.type === "output" && message.chunk === "new visible bytes"));
  server.closeRun(entry.run.runId, 0);
  await tick();
  assert.equal(server.active.size, 0, "the run this test started is closed");
});

test("stall: visible stderr bytes use the same real output callback and recover the tracker", async () => {
  const server = await loadFixed({ skipHealth: true, deferKill: true }); connect(server);
  await startHelper(server, "alpha-dev", "helper", "stderr recovery"); const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  server.emitOutput(entry.run.runId, "stderr: still working", "stderr");
  assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(entry.run.runId), false);
  assert.equal(server.stateMessage().projects[0].tabs[0].runs.find((run: any) => run.runId === entry.run.runId).output, "stderr: still working");
  server.closeRun(entry.run.runId, 0);
  await tick();
  assert.equal(server.active.size, 0, "the run this test started is closed");
});

test("stall: a flat run is marked stalled and escalated, and the timer never stops it", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  await startHelper(server, "alpha-dev", "helper", "flat output"); const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(entry.run.runId), true);
  assert.equal(server.kills.length, 0); assert.equal(server.launched.length, 1);
  assert.equal(server.isRunning(entry.run.runId), true, "still running after the stall");
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.action === "escalate"));
  await endRun(server, entry.run.runId);
});

test("startLeader wires its tab crew MCP server and explicit allowed-tools list without a prompt", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start leader" }); await tick();
  const tools = server.leaderToolOptions[0];
  assert.ok(tools.mcpServers["tab-crew"]); assert.deepEqual([...tools.allowedTools], ["finish_fixed_task", "list_task_archives", "get_task_archive", "get_fixed_task", "reconcile_task_execution", "begin_planning", "accept_planner_report", "request_task_action", "verify_task_evidence"].map((name) => `mcp__tab-crew__${name}`), "exactly the nine fixed tools, none of the retired four");
});

// The four updateSeat tests (live setModel, name/effort/pic save, dead leader, rejected live change) were retired in run 13b: a fixed crew has no updateSeat and never sends a live setModel; see test/round2-pack2-leader-save.test.ts "pack 2 C7" and test/fixed-crew-messages.test.ts "FCS active leader saves model and effort".

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
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  await startHelper(server, "alpha-dev", "helper", "review");
  const entry = server.launched[0], run = server.stateMessage().projects[0].tabs[0].runs[0];
  assert.equal(Object.hasOwn(run, "usage"), false);
  assert.equal(Object.hasOwn(run, "costUsd"), false);
  entry.callback.onUsage(entry.run, { modelId: null, contextTokens: 11, contextWindow: null, costUsd: 0.03 });
  const wireRun = lastState(ws).projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
  assert.equal(wireRun.usage.contextTokens, 11); assert.equal(wireRun.usage.costUsd, 0.03);
  await endRun(server, entry.run.runId);
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
