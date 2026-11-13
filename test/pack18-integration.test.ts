// Pack 18, Block 4, on the fixed lifecycle: end to end through real fixed servers with fake CLIs on PATH (never the repo's own config/).
// FI1 a real Claude Planner builds its command with --advisor and the read-only flags and NO crew tools, FI2 real ACP workers: done, log saved, Stop works, the per-tab budget counts both,
// FI3 the leader's fixed action on an ACP seat in Ask mode asks first, FI4 no worker of any CLI is given crew MCP options, FI5 a server started on an old-format data folder archives it byte for byte.
// The retired I5 (a Planner worker calling the crew bridge for launch_seat / wait_for_runs / advance_step) has no counterpart: a fixed worker has no bridge.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boot, client, workspaceFile } from "./pack18-harness.ts";
import { fixedServer, plan } from "./fixed-crew-execution-helpers.ts";
import { opencodeConfig } from "../server/runner-crew.ts";

type Fixture = Awaited<ReturnType<typeof fixedServer>>;
const nativeProcess = process.env.CC_FCX_NATIVE_PROCESS === "1";
const read = (path: string): any => { for (let i = 0; i < 5; i++) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { /* a write in progress */ } } return undefined; };
const acpClis = [
  { id: "fake-int", name: "Fake int", program: "fake-acp", args: ["--scenario=basic"] },
  { id: "fake-hold", name: "Fake hold", program: "fake-acp", args: ["--scenario=cancel"] },
];
const FAKE_ACP = new URL("./fake-acp-agent.mjs", import.meta.url);
// The fake ACP agent is a program on PATH (the server spawns it as a worker, with no test seam), and its CLIs are registered the way Settings would.
const withAcp = ({ bin, data }: { bin: string; data: string }) => {
  writeFileSync(join(bin, "fake-acp.cmd"), `@echo off\r\n"${process.execPath}" "${FAKE_ACP.pathname.slice(1).replaceAll("%20", " ")}" %*\r\n`);
  writeFileSync(join(data, "config", "acp-clis.json"), JSON.stringify({ clis: acpClis }));
};
const acp = (id: string) => ({ cli: `acp:${id}`, model: "default", effort: "default" });
const logFiles = (f: Fixture, prefix: string, ext: string) => readdirSync(join(f.server.data, "logs")).filter((name) => name.startsWith(prefix) && name.endsWith(ext));
const stamps = (f: Fixture, id = "fixed"): any[] => (read(join(f.server.data, "config", "launch-safety.json"))?.timestamps ?? []).filter((s: any) => s.tabId === id);
const idle = (f: Fixture) => f.c.wait(() => { try { return f.journal().activeExecutionId === null; } catch { return true; /* no execution yet */ } }, "the previous run's process tree is confirmed ended", 20_000);
const fakeLeaderLog = (f: Fixture): any[] => existsSync(join(f.server.temp, "fake-leader.log")) ? readFileSync(join(f.server.temp, "fake-leader.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

test("FI1 a real Claude Planner builds its command with --advisor and the read-only flags, no crew tools and no token, and leaves no crew-tools file", { timeout: 90_000 }, async () => {
  const planner = { cli: "claude", model: "claude-opus-5-5[1m]", effort: "medium", advisor: "claude-fable-5-1" };
  const f = await fixedServer({ nativeProcess, assignments: { planner } });
  try {
    f.worker({ plan: plan() });
    const start = await f.tool("begin_planning", { expected: null, brief: "TEST ONLY: plan." });
    assert.equal(start.ok, true, start.text);
    const run = await f.ended(start.value.runId);
    assert.equal(run.status, "done");
    const captured = await f.c.wait(() => f.spawnCapture(start.value.runId), "the runner's spawn-boundary command");
    const args = captured.program as string;
    assert.match(args, /--model claude-opus-5-5\[1m\]/);
    assert.match(args, / --advisor claude-fable-5-1 /, "the Planner's own advisor is on the command");
    assert.match(args, /--permission-mode plan --permission-prompts none --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit/, "read-only");
    assert.doesNotMatch(args, /--mcp-config|mcp__tab-crew|--allowedTools/, "no crew tools on the command");
    assert.equal(/Bearer ([A-Za-z0-9._~+-]{8,256})/.exec(args)?.[1], undefined, "no bearer token on the command line");
    assert.deepEqual(logFiles(f, "fixed.planner-", ".mcp.json"), [], "no crew-tools file (it would hold a token) exists after the run");
    assert.deepEqual([captured.crewUrlPresent, captured.tokenPresent, captured.mcpPresent, captured.opencodeConfigPresent], [false, false, false, false]);
    console.log(`FI1 command: ${args.trim().replace(/"Read the file[^"]*"/, "<brief>").slice(0, 400)}`);
  } finally { await f.close(); }
});

test("FI2 real ACP workers: the brief with its role instruction reaches the agent, the run is done and its log saved, a held run stops on Stop, and the per-tab budget counted both", { timeout: 120_000 }, async () => {
  const f = await fixedServer({ nativeProcess, assignments: { helper: acp("fake-int"), researcher: acp("fake-hold") }, extra: withAcp });
  try {
    assert.equal((await f.tool("get_fixed_task")).ok, true, "start the current leader");
    const task = "TEST ONLY: acp work";
    const helper = await f.assist("helper", task);
    const finish = await f.c.wait(() => f.c.messages.find((m) => m.type === "runFinish" && m.tabId === "fixed" && m.seatKey === "fixed.helper"), "the ACP Helper run is done", 60_000);
    assert.equal(finish.outcome, "done", "a normal end of the prompt is done");
    const [log] = logFiles(f, "fixed.helper-", ".log");
    assert.ok(log, "the run's log is saved");
    const text = readFileSync(join(f.server.data, "logs", log), "utf8");
    assert.ok(text.includes("Hello from the fake. You said: You are the Helper.") && text.includes(task), `the log holds the agent's text, the Helper instruction first: ${text.slice(0, 300)}`);
    assert.equal(text.split("You are the Helper.").length - 1, 1, "the role instruction is there once");
    await idle(f);
    // The held run: Stop ends it as stopped, never as done.
    const held = await f.assist("researcher", "TEST ONLY: hold");
    await f.c.wait(() => f.c.tab("fixed").runs.find((run: any) => run.id === held.runId && run.status === "working"), "the held run is working");
    await f.c.wait(() => f.c.messages.find((m) => m.type === "output" && m.seatKey === "fixed.researcher" && m.chunk.includes("working")), "the held agent streamed working");
    f.c.send({ type: "stopSeat", tabId: "fixed", slot: "researcher" });
    const stop = await f.c.wait(() => f.c.messages.find((m) => m.type === "runStop" && m.tabId === "fixed" && m.seatKey === "fixed.researcher"), "the held run is stopped", 60_000);
    assert.equal(stop.outcome, "stopped");
    assert.equal(f.c.messages.some((m) => m.type === "runFinish" && m.seatKey === "fixed.researcher"), false, "a stopped run is never reported done");
    assert.equal(stamps(f).length, 2, "the per-tab budget counted each of the two launches");
    assert.equal(helper.selectedSlot, "helper");
    console.log(`FI2: helper=${finish.outcome} researcher=${stop.outcome}; budget stamps on the tab=${stamps(f).length}; log=${log}`);
  } finally { await f.close(); }
});

test("FI3 the leader's fixed action on an ACP seat in Ask mode asks first (naming the leader), starts nothing until it is answered, then runs the ACP seat to done", { timeout: 120_000 }, async () => {
  const f = await fixedServer({ nativeProcess, assignments: { planner: acp("fake-int") }, extra: withAcp });
  try {
    assert.deepEqual(await f.c.request({ type: "setPermissionMode", tabId: "fixed", mode: "ask", confirm: true }), { ok: true });
    await f.c.chat("fixed", "start the leader");
    const brief = "TEST ONLY: acp plan after you say yes";
    const reply = f.c.chat("fixed", JSON.stringify([{ tool: "begin_planning", args: { expected: null, brief } }]));
    const item = await f.c.wait(() => f.c.tab("fixed").pendingApprovals?.[0], "the leader's approval card");
    assert.deepEqual(item.askedBy, { kind: "leader", slot: "leader", name: "Leader" });
    assert.equal(item.tool, "fixed-action");
    assert.equal(item.summary, `Action: planning\nPosition: Planner (planner)\nExecution: acp:fake-int / default / default\nFolder: ${f.server.work}\n\nLeader brief:\n${brief}`);
    assert.equal(f.c.tab("fixed").runs.length, 0, "nothing is started before the user answers");
    assert.equal(stamps(f).length, 0, "no budget is used before the user answers");
    assert.deepEqual(await f.c.request({ type: "answerApproval", tabId: "fixed", approvalId: item.approvalId, allow: true }), { ok: true });
    assert.match((await reply).trim(), /^\[tool ok: \{"runId":"[0-9a-f-]{36}",.*"selectedSlot":"planner"/);
    const finish = await f.c.wait(() => f.c.messages.find((m) => m.type === "runFinish" && m.tabId === "fixed" && m.seatKey === "fixed.planner"), "the ACP seat's run is done", 60_000);
    assert.equal(finish.outcome, "done");
    await f.c.wait(() => f.c.tab("fixed").pendingApprovals.length === 0, "the answered approval leaves the page");
    console.log(`FI3: approval ${item.tool} asked by ${item.askedBy.name}; run ${finish.outcome}`);
  } finally { await f.close(); }
});

test("FI4 no fixed worker of any CLI is given crew MCP options: no bridge, token, MCP file, config or session server", { timeout: 180_000 }, async () => {
  const f = await fixedServer({ nativeProcess, assignments: {
    helper: { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium" }, researcher: { cli: "opencode", model: "opencode/mimo-v2.6-flash-free", effort: "max" },
    reviewer1: { cli: "codex", model: "gpt-6.1-sol", effort: "low" }, reviewer2: acp("fake-int"),
  }, extra: withAcp });
  try {
    assert.equal((await f.tool("get_fixed_task")).ok, true, "start the current leader");
    f.worker({});
    for (const slot of ["helper", "researcher", "reviewer1", "reviewer2"]) {
      await idle(f);
      const start = await f.assist(slot, `TEST ONLY: ${slot}`);
      assert.equal((await f.ended(start.runId)).status, "done", `${slot} ran to done`);
      if (slot === "reviewer2") continue;
      const worker = await f.c.wait(() => f.observation(start.runId), `${slot} worker input`);
      const captured = f.spawnCapture(start.runId);
      assert.ok(captured, `${slot}: the runner's spawn-boundary command`);
      // An OpenCode read-only worker does get OPENCODE_CONFIG_CONTENT: its deny rules (checked below to hold no MCP server).
      const config = slot === "researcher";
      assert.deepEqual([worker.bridge, worker.tokenPresent, worker.mcp, worker.opencodeConfigPresent], [null, false, null, config], `${slot}: the worker's own environment`);
      assert.deepEqual([captured.crewUrlPresent, captured.tokenPresent, captured.mcpPresent, captured.opencodeConfigPresent], [false, false, false, config], `${slot}: the spawn environment`);
      assert.doesNotMatch(captured.program, /--mcp-config|mcp__tab-crew|mcp_servers|CC_CREW/, `${slot}: no crew tools on the command`);
    }
    const run = { runId: "r", seatKey: "fixed.researcher", slotId: "researcher", name: "R", cli: "opencode", model: "m", effort: "max", folder: "f", canWrite: false, startedAt: 1 } as any;
    assert.deepEqual(JSON.parse(opencodeConfig(run)!), { $schema: "https://opencode.ai/config.json", permission: { edit: "deny", bash: "deny" } }, "the OpenCode read-only config holds the deny rules and no MCP server");
    const sessions = fakeLeaderLog(f).filter((entry) => entry.cli === "acp" && entry.received === "session/new");
    assert.equal(sessions.length, 1, "the ACP worker opened one session");
    assert.deepEqual(sessions[0].params.mcpServers, [], "the ACP worker was handed no MCP server");
    assert.deepEqual(readdirSync(join(f.server.data, "logs")).filter((name) => name.endsWith(".mcp.json")), [], "no crew-tools file was ever left behind");
  } finally { await f.close(); }
});

test("FI5 a server started on an old-format data folder archives it byte for byte, keeps its history in place and serves one fresh fixed tab", { timeout: 90_000 }, async () => {
  const old: Record<string, string> = {
    "chats/old-dev.jsonl": "private chat\n", "logs/old-dev.coder-1.log": "private log", "tasks/old-dev.json": "task", "executions/old-dev.json": "journal",
    "config/setups.json": "unparseable saved setups", "requests.json": "private requests",
  };
  let original = "";
  const b = await boot({
    extra: ({ data }) => { for (const [path, bytes] of Object.entries(old)) { mkdirSync(join(data, path, ".."), { recursive: true }); writeFileSync(join(data, path), bytes); } },
    tabs: (work) => {
      const tabs = [{ id: "old-dev", name: "Old dev", kind: "dev", process: "main", folder: work, crew: [{ slot: "leader", name: "Old leader", cli: "codex", model: "gpt-6-sol", effort: "high", isLeader: true }] }];
      original = JSON.stringify({ projects: [{ id: "p18", name: "P18", folder: work, tabs }] });
      return tabs;
    },
  });
  const bc = await client(b);
  try {
    const backups = readdirSync(join(b.data, "backups"));
    assert.equal(backups.length, 1, "one archive was made");
    assert.match(backups[0], /^fixed-crew-v1-.*Z-[0-9a-f-]{36}$/);
    const archive = join(b.data, "backups", backups[0]);
    assert.equal(readFileSync(join(archive, "config", "workspaces.json"), "utf8"), original, "the archived workspaces file is the old file, byte for byte");
    for (const [path, bytes] of Object.entries(old)) {
      if (!existsSync(join(archive, path))) continue; // history folders stay in place; only the listed inventory is copied
      assert.equal(readFileSync(join(archive, path), "utf8"), bytes, `${path} archived byte for byte`);
    }
    assert.ok(existsSync(join(archive, "config", "setups.json")) && existsSync(join(archive, "requests.json")), "the saved setups and requests were archived");
    for (const [path, bytes] of Object.entries(old)) assert.equal(readFileSync(join(b.data, path), "utf8"), bytes, `${path} stays in place`);
    const saved = workspaceFile(b).projects;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].tabs.length, 1);
    const tab = saved[0].tabs[0];
    assert.match(tab.id, /^fresh-/);
    assert.equal(tab.fixedCrew.version, 1, "the new file is a fixed crew");
    assert.deepEqual([tab.crew, tab.steps], [[], []], "no legacy crew or steps");
    assert.equal(bc.tab(tab.id).id, tab.id, "the page is served the fresh tab");
    assert.equal(bc.tab("old-dev"), undefined, "the old tab is not served");
    console.log(`FI5: archive ${backups[0]}; old workspaces file ${original.length} bytes`);
  } finally { bc.close(); await b.stop(); }
});
