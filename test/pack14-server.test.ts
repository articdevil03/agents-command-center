// Pack 14 (the leader's steps, its background jobs, its own follow-up replies, and no more glued text), the server side through real servers: a Claude, a Codex and
// an OpenCode leader on the far-boundary fakes (their events carry the SHAPES measured in the 2026-10-17 probe, with secrets planted in every input and output field).
// Sections: A the step line (labels, order, crew tools skipped, never in the chat log, never a secret), B it is cleared at every kind of turn end, C Claude's background
// jobs, D Claude's own follow-up reply, E a new message / item / part starts a new paragraph (and never at the start of a reply).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { attachCrashCatcher } from "./crash-catcher.ts";

const MAIN = getProcessDefinition("dev", "main").seats;
const crewFor = (seats: typeof MAIN, leader?: { cli: string; model: string; effort: string }) => seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort, ...(seat.isLeader ? leader : {}) }));
const CLIS = ["claude", "codex", "opencode"] as const;
type Cli = (typeof CLIS)[number];
const LEADERS: Record<Cli, { cli: string; model: string; effort: string } | undefined> = {
  claude: undefined, codex: { cli: "codex", model: "gpt-6-sol", effort: "high" }, opencode: { cli: "opencode", model: "fakeprov/fake-model", effort: "max" },
};
const TAB_COUNT = 14;
const tabOf = (cli: Cli, n: number) => `p14-${cli}-${n}`;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// The made-up secret planted in every command, query, path, content and output the fakes play.
const SECRET = "SECRET-P14-xK39qz";
// OpenCode holds back the last ~80 characters of a reply (its secret filter), so replies whose text matters start with more than that.
const PAD = "-".repeat(100);
// Every label the leader may ever show: the fixed table, a helper count, or a skill's cleaned name.
const ALLOWED = /^(Thinking|Running a command|Reading a file|Searching files|Editing files|Searching the web|Reading a web page|Planning|Using a tool|Using a skill|Using skill: [A-Za-z0-9:_-]{1,40}|[0-9]+ helpers? working)$/;

async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>((ok) => probe.close(() => ok()));
  return port;
}

type Server = { port: number; key: string; temp: string; data: string; work: string; child: ChildProcess; log: () => string; stop: () => Promise<void> };
async function boot(env: Record<string, string> = {}): Promise<Server> {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack14-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work");
  for (const dir of [home, work, join(temp, "work2"), join(data, "config"), join(data, "chats"), join(data, "scratch")]) mkdirSync(dir, { recursive: true });
  const tab = (id: string, leader?: { cli: string; model: string; effort: string }) => ({ id, name: id, kind: "dev", process: "main", folder: work, crew: crewFor(MAIN, leader) });
  const tabs = CLIS.flatMap((cli) => Array.from({ length: TAB_COUNT }, (_, index) => tab(tabOf(cli, index + 1), LEADERS[cli])));
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p14", name: "P14", folder: work, tabs }] }));
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: Object.fromEntries(["claude", "codex"].map((cli) => [JSON.stringify([cli, "--version"]), { code: 0, stdout: `${cli} 1.0.0`, stderr: "" }])) }));
  const port = await freePort();
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const full: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: String(port), CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1",
    FAKE_LEADER_LOG: join(temp, "fake-leader.log"), CC_APP_KEY: key, CLAUDE_CLI_PATH: process.execPath, ...env,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: full as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack14-server");
  let log = "";
  child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  const end = Date.now() + 10_000;
  while (!log.includes("127.0.0.1") && Date.now() < end) await sleep(10);
  assert.ok(log.includes("127.0.0.1"), `server did not start: ${log}`);
  return {
    port, key, temp, data, work, child, log: () => log,
    stop: async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((ok) => child.once("exit", ok));
          child.once("error", () => {});
          try { child.send("shutdown", () => {}); } catch { /* IPC already closed: fall through to kill */ }
          await Promise.race([exited, sleep(8000)]);
          if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, sleep(3000)]); }
        }
      } finally { removeWithRetry(temp, 40, 500); }
    },
  };
}

async function client(server: Server) {
  const messages: any[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${server.key}`, { origin: `http://127.0.0.1:${server.port}` });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(socket, "open"); socket.send(JSON.stringify({ type: "hello" }));
  const wait = async <T>(fn: () => T, label: string, ms = 10_000): Promise<NonNullable<T>> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${server.log().slice(-500)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-6))}`);
  };
  await wait(() => messages.find((m) => m.type === "state"), "initial state");
  let n = 0;
  const send = (payload: any) => socket.send(JSON.stringify(payload));
  const state = () => messages.filter((m) => m.type === "state").at(-1);
  const tabState = (id: string) => state().projects[0].tabs.find((t: any) => t.id === id);
  const done = (tabId: string) => messages.filter((m) => m.type === "chatDone" && m.tabId === tabId).length;
  const failed = (tabId: string) => messages.filter((m) => m.type === "chatError" && m.tabId === tabId).length;
  const answers = (tabId: string) => messages.filter((m) => m.type === "chatMessage" && m.tabId === tabId && m.role !== "notice").map((m) => ({ role: m.role as string, text: m.text as string, split: m.split === true }));
  const streamed = (tabId: string, from = 0) => messages.slice(from).filter((m) => m.type === "chatDelta" && m.tabId === tabId).map((m) => m.text).join("");
  // The step line as the page sees it: every leaderActivity message of the tab, in order (null = cleared).
  const labels = (tabId: string, from = 0): Array<string | null> => messages.slice(from).filter((m) => m.type === "leaderActivity" && m.tabId === tabId).map((m) => m.label);
  const start = async (tabId: string, text: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const requestId = `p14c${++n}`;
    send({ type: "chat", tabId, text, requestId, ...extra });
    await wait(() => messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `chat ${requestId} taken`);
    return requestId;
  };
  const finished = async (tabId: string, count: number, label: string, ms = 15_000) => { await wait(() => done(tabId) >= count, label, ms); await sleep(150); };
  return { messages, state, tabState, wait, send, start, done, failed, answers, streamed, labels, finished, close: () => socket.terminate() };
}
type Client = Awaited<ReturnType<typeof client>>;

const fakeLog = (server: Server): any[] => (existsSync(join(server.temp, "fake-leader.log")) ? readFileSync(join(server.temp, "fake-leader.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const chatFile = (server: Server, tabId: string): any[] => readFileSync(join(server.data, "chats", `${tabId}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.type === "message" && row.role !== "notice");

async function withServer(env: Record<string, string>, body: (server: Server, c: Client) => Promise<void>): Promise<void> {
  const server = await boot(env);
  const c = await client(server);
  try { await body(server, c); } finally { c.close(); await server.stop(); }
}

// ---- the scripts: what each leader CLI is made to do, with the secret in every input and output field the probe showed ----
// A skill name that is not an identifier (markup, a newline, spaces, far too long): only [A-Za-z0-9:_-], 40 characters, may come out.
const DIRTY_SKILL = `<b>evil</b> name\nwith spaces ${"a".repeat(60)}`;
const CLEAN_SKILL = DIRTY_SKILL.replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 40);
const CLAUDE_STEPS = [
  { message: true }, { block: "thinking" },
  { toolUse: { id: "t1", name: "Bash", input: { command: `echo ${SECRET}`, description: SECRET } } }, { toolResult: { id: "t1", output: SECRET } },
  { toolUse: { id: "t2", name: "Read", input: { file_path: `C:/${SECRET}/a.txt` } } }, { toolResult: { id: "t2", output: SECRET } },
  { toolUse: { id: "t3", name: "WebSearch", input: { query: SECRET, mode: "standard" } } }, { toolResult: { id: "t3", output: SECRET } },
  { toolUse: { id: "t4", name: "Grep", input: { pattern: SECRET } } }, { toolResult: { id: "t4" } },
  { toolUse: { id: "t5", name: "Edit", input: { file_path: "C:/x", old_string: SECRET, new_string: SECRET } } }, { toolResult: { id: "t5" } },
  { toolUse: { id: "t6", name: "Skill", input: { skill: "deep-research", args: SECRET } } }, { toolResult: { id: "t6" } },
  { toolUse: { id: "t6b", name: "Skill", input: { skill: DIRTY_SKILL } } }, { toolResult: { id: "t6b" } },
  { toolUse: { id: "t7", name: "mcp__tab-crew__get_crew_status", input: { note: SECRET } } }, { toolResult: { id: "t7", output: SECRET } },
  { toolUse: { id: "t8", name: "Task", input: { prompt: SECRET } } }, { toolUse: { id: "t9", name: "Agent", input: { prompt: SECRET } } }, { toolResult: { id: "t8" } }, { toolResult: { id: "t9" } },
  { toolUse: { id: "t10", name: "TodoWrite", input: { todos: [SECRET] } } }, { toolResult: { id: "t10" } },
  { toolUse: { id: "t11", name: "WebFetch", input: { url: `https://${SECRET}` } } }, { toolResult: { id: "t11" } },
  { toolUse: { id: "t12", name: "mcp__other__thing", input: { x: SECRET } } }, { toolResult: { id: "t12" } },
  { block: "text" }, { say: "All done." },
];
const CLAUDE_LABELS = ["Thinking", "Running a command", "Thinking", "Reading a file", "Thinking", "Searching the web", "Thinking", "Searching files", "Thinking", "Editing files", "Thinking",
  "Using a skill", "Using skill: deep-research", "Thinking", "Using a skill", `Using skill: ${CLEAN_SKILL}`, "Thinking", "1 helper working", "2 helpers working", "1 helper working", "Thinking", "Planning", "Thinking", "Reading a web page", "Thinking", "Using a tool", "Thinking", null];
const CODEX_STEPS = [
  { itemRun: { type: "reasoning", id: "r1", hold: 10 } },
  { itemRun: { type: "commandExecution", id: "c1", command: `echo ${SECRET}`, cwd: `C:/${SECRET}`, aggregatedOutput: SECRET, exitCode: 0, commandActions: [{ type: "unknown", command: `echo ${SECRET}` }] } },
  { itemRun: { type: "commandExecution", id: "c2", command: `cat ${SECRET}`, cwd: `C:/${SECRET}`, aggregatedOutput: SECRET, commandActions: [{ type: "read", command: `cat ${SECRET}`, name: SECRET, path: `C:/${SECRET}` }] } },
  { itemRun: { type: "commandExecution", id: "c3", command: `ls ${SECRET}`, aggregatedOutput: SECRET, commandActions: [{ type: "listFiles", command: `ls ${SECRET}`, path: SECRET }] } },
  { itemRun: { type: "fileChange", id: "f1", changes: [{ path: `C:/${SECRET}`, kind: { type: "add" }, diff: `+${SECRET}` }] } },
  { itemRun: { type: "webSearch", id: "w1", query: SECRET, action: { type: "search", query: SECRET }, results: [{ url: `https://${SECRET}`, title: SECRET, snippet: SECRET }] } },
  { itemRun: { type: "mcpToolCall", id: "m1", server: "tab-crew", tool: "get_crew_status", arguments: { x: SECRET } } },
  { itemRun: { type: "dynamicToolCall", id: "d1", tool: "get_crew_status", arguments: { x: SECRET } } },
  { itemRun: { type: "mcpToolCall", id: "m2", server: "other", tool: "thing", arguments: { x: SECRET }, result: SECRET } },
  { itemRun: { type: "agentMessage", id: "am1", text: SECRET, hold: 10 } },
  { say: "All done." },
];
const CODEX_LABELS = ["Thinking", "Running a command", "Thinking", "Reading a file", "Thinking", "Searching files", "Thinking", "Editing files", "Thinking", "Searching the web", "Thinking", "Using a tool", "Thinking", null];
const OPENCODE_STEPS = [
  { reasoning: `hidden thoughts ${SECRET}` },
  { toolPart: { tool: "bash", id: "p1", input: { command: `echo ${SECRET} $PASSWORD` }, output: `${SECRET} $TOKEN` } },
  { toolPart: { tool: "read", id: "p2", input: { filePath: `C:/${SECRET}` }, output: SECRET } },
  { toolPart: { tool: "glob", id: "p3", input: { pattern: SECRET }, output: SECRET } },
  { toolPart: { tool: "edit", id: "p4", input: { filePath: "C:/x", oldString: SECRET, newString: "$PASSWORD" }, output: SECRET } },
  { toolPart: { tool: "websearch", id: "p5", input: { query: SECRET }, output: SECRET } },
  { toolPart: { tool: "webfetch", id: "p6", input: { url: `https://${SECRET}` }, output: SECRET } },
  { toolPart: { tool: "task", id: "p7", input: { prompt: SECRET }, output: SECRET } },
  { toolPart: { tool: "todowrite", id: "p8", input: { todos: [SECRET] }, output: SECRET } },
  { toolPart: { tool: "tab-crew_get_crew_status", id: "p9", input: { x: SECRET }, output: SECRET } },
  { toolPart: { tool: "mystery", id: "p10", input: { x: SECRET }, output: SECRET } },
  { say: "All done." },
];
const OPENCODE_LABELS = ["Thinking", "Running a command", "Thinking", "Reading a file", "Thinking", "Searching files", "Thinking", "Editing files", "Thinking", "Searching the web", "Thinking", "Reading a web page", "Thinking",
  "1 helper working", "Thinking", "Planning", "Thinking", "Using a tool", "Thinking", null];
const LABEL_RUN: Record<Cli, { steps: unknown[]; labels: Array<string | null> }> = {
  claude: { steps: CLAUDE_STEPS, labels: CLAUDE_LABELS }, codex: { steps: CODEX_STEPS, labels: CODEX_LABELS }, opencode: { steps: OPENCODE_STEPS, labels: OPENCODE_LABELS },
};
// A step left running, then a pause: the reply is still going when the test acts (`die` ends the leader process on the spot).
const RUNNING: Record<Cli, (after: unknown[]) => string> = {
  claude: (after) => JSON.stringify([{ toolUse: { id: "x", name: "Bash", input: { command: SECRET } } }, ...after]),
  codex: (after) => JSON.stringify([{ itemRun: { type: "commandExecution", id: "x", command: SECRET, commandActions: [], noComplete: true, hold: 50 } }, ...after]),
  opencode: (after) => JSON.stringify([{ toolPart: { tool: "bash", id: "x", input: { command: SECRET }, noComplete: true, hold: 50 } }, ...after]),
};
// A reply that thinks, then writes its answer: its own labels are exactly Thinking, then nothing.
const NEXT_REPLY: Record<Cli, string> = {
  claude: JSON.stringify([{ block: "thinking" }, { block: "text" }, { say: "ok" }]),
  codex: JSON.stringify([{ itemRun: { type: "reasoning", id: "r2", hold: 10 } }, { itemRun: { type: "agentMessage", id: "a2", hold: 10 } }, { say: "ok" }]),
  opencode: JSON.stringify([{ reasoning: "x" }, { say: "ok" }]),
};
const PAUSE: Record<Cli, unknown> = { claude: { wait: 6000 }, codex: { sleep: 6000 }, opencode: { sleep: 6000 } };
const DIE: Record<Cli, unknown[]> = { claude: [PAUSE.claude], codex: [{ exit: true }], opencode: [{ exit: true }] };

// ---- A: the step line ----

test("A: the step line shows the KIND of each step, per CLI, in order; crew tools are skipped; it is never in the chat log; no secret is ever in it", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 1), from = c.messages.length;
      await c.start(tab, JSON.stringify(LABEL_RUN[cli].steps));
      await c.finished(tab, 1, `${cli}: the reply ends`);
      const seen = c.labels(tab, from);
      assert.deepEqual(seen, LABEL_RUN[cli].labels, `${cli}: the labels, in order`);
      for (const label of seen) if (label !== null) assert.match(label, ALLOWED, `${cli}: ${label} is on the fixed list`);
      // The step line goes quiet as the answer starts: the clear comes BEFORE the first text reaches the page, not only at the end.
      const firstDeltaAt = c.messages.findIndex((m, i) => i >= from && m.type === "chatDelta" && m.tabId === tab), firstClearAt = c.messages.findIndex((m, i) => i >= from && m.type === "leaderActivity" && m.tabId === tab && m.label === null);
      assert.ok(firstClearAt >= 0 && firstDeltaAt >= 0 && firstClearAt < firstDeltaAt, `${cli}: the step line is cleared before the answer streams (clear at ${firstClearAt}, first text at ${firstDeltaAt})`);
      // The end: cleared before the reply is closed, and the state agrees.
      assert.equal(c.tabState(tab).leaderActivity, null, `${cli}: nothing left in the state`);
      const clearedAt = c.messages.findLastIndex((m) => m.type === "leaderActivity" && m.tabId === tab), doneAt = c.messages.findLastIndex((m) => m.type === "chatDone" && m.tabId === tab);
      assert.ok(clearedAt < doneAt, `${cli}: the step line is gone before chatDone`);
      // Never in the chat: no row of the transcript holds a label.
      const chat = JSON.stringify(chatFile(server, tab));
      for (const label of new Set(seen)) if (label) assert.ok(!chat.includes(label), `${cli}: "${label}" is not in the chat log`);
      assert.ok(chat.includes("All done."), `${cli}: control: the reply itself is in the chat log`);
      // No secret anywhere the step line or the job list travels: its own messages and every state message's fields for this tab.
      const carried = JSON.stringify([c.messages.filter((m) => m.type === "leaderActivity"), c.messages.filter((m) => m.type === "state").map((m) => { const t = m.projects[0].tabs.find((x: any) => x.id === tab); return [t.leaderActivity, t.leaderJobs]; })]);
      assert.ok(!carried.includes(SECRET), `${cli}: the planted secret is not in any leaderActivity or leaderJobs data`);
      if (cli === "opencode") {
        const secrets = fakeLog(server).find((entry) => entry.toolSecrets)?.toolSecrets;
        assert.ok(secrets?.password && secrets?.token, "control: the fake put the OpenCode password and bridge token into tool input and output");
        assert.ok(!carried.includes(secrets.password) && !carried.includes(secrets.token), "opencode: neither the server password nor the bridge token is in the step line");
      }
    }
  });
});

test("A: a step line is only ever sent while a reply runs, and a Claude helper count follows the helpers that run", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 2), from = c.messages.length;
    // A sub-agent's own tool calls (they carry the id of the Task call that started it) never move the leader's step line.
    await c.start(tab, JSON.stringify([{ toolUse: { id: "h1", name: "Task", input: {} } }, { toolUse: { id: "h2", name: "Task", input: {} } }, { toolUse: { id: "s1", name: "WebSearch", input: { query: SECRET }, parent: "h1" } }, { toolResult: { id: "s1", parent: "h1" } },
      { toolUse: { id: "h3", name: "Task", input: {} } }, { toolResult: { id: "h1" } }, { block: "text" }, { say: "x" }]));
    await c.finished(tab, 1, "ends");
    assert.deepEqual(c.labels(tab, from), ["1 helper working", "2 helpers working", "3 helpers working", "2 helpers working", null], "the count follows the helpers that run now, a sub-agent's own steps are not shown; the end of the reply clears it");
    await sleep(300);
    const later = c.labels(tab, from).length;
    await sleep(600);
    assert.equal(c.labels(tab, from).length, later, "nothing more arrives after the reply");
  });
});

test("A: a steered message's own text part (OpenCode) is not the answer being written: the step line stays while the leader is still thinking", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 3), from = c.messages.length;
    await c.start(tab, JSON.stringify([{ reasoning: "hmm" }, { sleep: 1500 }, { say: "done" }]));
    await c.wait(() => c.labels(tab, from).includes("Thinking"), "thinking shows");
    c.send({ type: "steer", tabId: tab, text: "STEER-TEXT-PART", requestId: "p14-steer-part" });
    await c.wait(() => fakeLog(server).some((entry) => entry.midRun), "the steer reached OpenCode");
    await sleep(400);
    assert.deepEqual(c.labels(tab, from), ["Thinking"], "the steer's user text part did not clear the step line");
    await c.finished(tab, 1, "ends");
  });
});

// ---- B: cleared at every kind of turn end ----

test("B: the step line is cleared when a reply ends with a step still running, on Stop, when the leader dies, and on Clear (every CLI)", { timeout: 240_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const running = (tab: string, from: number) => c.wait(() => c.labels(tab, from).includes("Running a command"), `${cli}: the step shows`, 10_000);
      const cleared = (tab: string, from: number, how: string) => {
        const seen = c.labels(tab, from);
        assert.equal(seen.at(-1), null, `${cli} ${how}: the last thing sent is a clear: ${JSON.stringify(seen)}`);
        assert.equal(c.tabState(tab).leaderActivity, null, `${cli} ${how}: the state holds nothing`);
        assert.equal(c.tabState(tab).derived.leaderTurnActive, false, `${cli} ${how}: and the reply is over`);
      };
      // 1. the reply ends on its own with the step still open
      let tab = tabOf(cli, 2), from = c.messages.length;
      await c.start(tab, RUNNING[cli]([{ say: "ok" }]));
      await running(tab, from);
      await c.finished(tab, 1, `${cli}: ends`);
      cleared(tab, from, "end");
      assert.ok(c.messages.findLastIndex((m) => m.type === "leaderActivity" && m.tabId === tab) < c.messages.findLastIndex((m) => m.type === "chatDone" && m.tabId === tab), `${cli}: cleared before chatDone`);
      // The next reply on the same tab starts clean: the step the last one left open is not remembered (it would hide "Thinking" and the quiet while the answer is written).
      from = c.messages.length;
      await c.start(tab, NEXT_REPLY[cli]);
      await c.finished(tab, 2, `${cli}: the next reply ends`);
      assert.deepEqual(c.labels(tab, from), ["Thinking", null], `${cli}: a step left open by the last reply does not leak into the next one`);
      // 2. Stop all while the step runs
      tab = tabOf(cli, 3); from = c.messages.length;
      await c.start(tab, RUNNING[cli]([PAUSE[cli]]));
      await running(tab, from);
      // A page that connects now (a reload, a second window) is told what the leader is doing by the state itself.
      const late = await client(server);
      assert.equal(late.tabState(tab).leaderActivity, "Running a command", `${cli}: a page that connects mid-reply gets the step in its first state`);
      late.close();
      c.send({ type: "stopAll" });
      await c.wait(() => c.failed(tab) >= 1, `${cli}: the stopped reply reports`, 10_000); await sleep(150);
      cleared(tab, from, "stop");
      // 3. the leader dies while the step runs
      tab = tabOf(cli, 4); from = c.messages.length;
      await c.start(tab, RUNNING[cli](DIE[cli]));
      await running(tab, from);
      if (cli === "claude") server.child.send("end-query");
      await c.wait(() => c.failed(tab) >= 1, `${cli}: the death reports`, 15_000); await sleep(150);
      cleared(tab, from, "death");
      // 4. Clear while the step runs
      tab = tabOf(cli, 5); from = c.messages.length;
      await c.start(tab, RUNNING[cli]([PAUSE[cli]]));
      await running(tab, from);
      c.send({ type: "clear", tabId: tab });
      await c.wait(() => c.messages.slice(from).some((m) => m.type === "chatCleared" && m.tabId === tab), `${cli}: cleared`, 10_000); await sleep(150);
      cleared(tab, from, "clear");
    }
  });
});

// ---- C: Claude's background jobs ----

const JOB = (id: string, description: string) => ({ id, description });
test("C: Claude background jobs: listed in the state with a count and a start time, kept after the reply ends, cleaned, never carrying the command", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 6);
    const jobs = () => c.tabState(tab).leaderJobs as Array<{ id: string; description: string; startedAt: number }>;
    await c.start(tab, JSON.stringify([{ toolUse: { id: "bg", name: "Bash", input: { command: `sleep 99 # ${SECRET}`, run_in_background: true } } }, { bgJobs: [JOB("b1", "Generate 5 concept images")] }, { toolResult: { id: "bg", output: SECRET } }, { say: "Started it." }]));
    await c.finished(tab, 1, "the first reply ends");
    assert.equal(jobs().length, 1, "one job");
    assert.deepEqual([jobs()[0]!.id, jobs()[0]!.description, typeof jobs()[0]!.startedAt], ["b1", "Generate 5 concept images", "number"]);
    assert.equal(c.tabState(tab).derived.leaderTurnActive, false, "the job survives the end of the reply, and the leader is free");
    const firstStart = jobs()[0]!.startedAt;
    assert.ok(Math.abs(Date.now() - firstStart) < 15_000, "the start time is real");
    const long = `${"x".repeat(200)}`;
    await c.start(tab, JSON.stringify([{ bgJobs: [JOB("b1", "Generate 5 concept images"), JOB("b2", `line one\nline two\u0007 ${long}`), JOB("b3", "")] }, { say: "Three." }]));
    await c.finished(tab, 2, "the second reply ends");
    assert.equal(jobs().length, 3, "the list is the CLI's full list: three now");
    assert.equal(jobs().find((job) => job.id === "b1")!.startedAt, firstStart, "a job that was already there keeps its start time");
    const dirty = jobs().find((job) => job.id === "b2")!.description;
    assert.ok(!/[\u0000-\u001f]/.test(dirty) && dirty.length <= 80 && dirty.startsWith("line one line two"), `control characters out, 80 at most: ${JSON.stringify(dirty)}`);
    assert.equal(jobs().find((job) => job.id === "b3")!.description, "a background command", "an empty description reads a background command");
    await c.start(tab, JSON.stringify([{ bgJobs: [] }, { say: "None." }]));
    await c.finished(tab, 3, "the third reply ends");
    assert.deepEqual(jobs(), [], "the CLI said none: none");
    // The same id again later is a new job: it starts counting from now, not from the old one.
    await c.start(tab, JSON.stringify([{ bgJobs: [JOB("b1", "Generate 5 concept images")] }, { say: "Again." }]));
    await c.finished(tab, 4, "the fourth reply ends");
    assert.ok(jobs()[0]!.startedAt > firstStart, "a job that came back is a new job with a new start time");
    const carried = JSON.stringify(c.messages.filter((m) => m.type === "state").map((m) => m.projects[0].tabs.find((t: any) => t.id === tab).leaderJobs));
    assert.ok(!carried.includes(SECRET) && !carried.includes("sleep 99"), "the command (and the secret in it) is never in the job list");
  });
});

test("C: Claude background jobs end with their leader: Stop, death, a new folder, Clear and a replaced dead leader", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    const jobsOf = (tab: string) => c.tabState(tab).leaderJobs as unknown[];
    const withJob = async (n: number) => {
      const tab = tabOf("claude", n);
      await c.start(tab, JSON.stringify([{ bgJobs: [JOB("b1", "Render the video")] }, { say: "ok" }]));
      await c.finished(tab, 1, `tab ${n}: the reply ends`);
      assert.equal(jobsOf(tab).length, 1, `tab ${n}: control: a job runs`);
      return tab;
    };
    let tab = await withJob(7);
    c.send({ type: "stopAll" });
    await c.wait(() => jobsOf(tab).length === 0, "Stop clears the jobs");
    tab = await withJob(8);
    server.child.send("end-query");
    await c.wait(() => jobsOf(tab).length === 0, "a dying leader clears the jobs");
    // The dead leader is replaced by the tab's next message: still none, and a new leader's own jobs show again.
    await c.start(tab, JSON.stringify([{ bgJobs: [JOB("n1", "New job")] }, { say: "again" }]));
    await c.finished(tab, 2, "the replacement answers");
    assert.deepEqual((jobsOf(tab) as any[]).map((job) => job.id), ["n1"], "only the new leader's job");
    tab = await withJob(9);
    c.send({ type: "changeFolder", tabId: tab, folder: join(server.temp, "work2") });
    await c.wait(() => jobsOf(tab).length === 0, "a new folder clears the jobs");
    tab = await withJob(10);
    c.send({ type: "clear", tabId: tab });
    await c.wait(() => jobsOf(tab).length === 0, "Clear clears the jobs");
  });
});

test("C: an older leader that ends late (its stream closes after a newer leader started) never clears the newer leader's jobs", { timeout: 60_000 }, async () => {
  // The old Claude leader's stop is slow to reach its stream: the adapter reports onStop a second time then, long after the tab's next leader began.
  await withServer({ FAKE_CLAUDE_STOP_DELAY_MS: "2500" }, async (server, c) => {
    const tab = tabOf("claude", 11);
    await c.start(tab, JSON.stringify([{ bgJobs: [JOB("old", "Old leader's job")] }, { say: "ok" }]));
    await c.finished(tab, 1, "the first leader answers");
    c.send({ type: "stopAll" });
    await c.wait(() => (c.tabState(tab).leaderJobs as unknown[]).length === 0, "Stop clears the old leader's jobs");
    await c.start(tab, JSON.stringify([{ bgJobs: [JOB("new", "New leader's job")] }, { say: "ok" }]));
    await c.finished(tab, 2, "the new leader answers");
    assert.deepEqual((c.tabState(tab).leaderJobs as any[]).map((job) => job.id), ["new"], "control: the new leader's job shows");
    await sleep(3500);
    // A late clear sends no state of its own: a page that connects afterwards reads what the server holds.
    const fresh = await client(server);
    assert.deepEqual((fresh.tabState(tab).leaderJobs as any[]).map((job) => job.id), ["new"], "the old leader's late end left it alone");
    fresh.close();
  });
});

test("C: Codex and OpenCode never show background jobs (they start theirs detached where Command Center cannot see them)", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of ["codex", "opencode"] as const) {
      const tab = tabOf(cli, 6);
      await c.start(tab, JSON.stringify(cli === "codex"
        ? [{ itemRun: { type: "commandExecution", id: "bg", command: "nohup ping -n 40 127.0.0.1 &", commandActions: [] } }, { say: "started" }]
        : [{ toolPart: { tool: "bash", id: "bg", input: { command: "nohup ping -n 40 127.0.0.1 &" } } }, { say: "started" }]));
      await c.finished(tab, 1, `${cli}: ends`);
      assert.deepEqual(c.messages.filter((m) => m.type === "state").map((m) => m.projects[0].tabs.find((t: any) => t.id === tab).leaderJobs).filter((jobs) => jobs.length), [], `${cli}: no state message ever lists a job`);
    }
  });
});

// ---- D: Claude's own follow-up reply ----

test("D: a background job finishing makes Claude answer by itself: that reply streams, counts as replying, is saved ONCE as a leader message, ends with ONE chatDone, and nothing is carried into the next reply", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 11), from = c.messages.length;
    await c.start(tab, JSON.stringify([{ say: "First answer." }, { followUp: [{ message: true }, { block: "thinking" }, { block: "text" }, { say: "Background job finished: all 5 images are ready." }], after: 400 }]));
    await c.finished(tab, 2, "the follow-up reply ends too");
    assert.equal(c.done(tab), 2, "one chatDone for the asked reply, one for the follow-up: no stray third");
    assert.deepEqual(c.answers(tab).map((row) => [row.role, row.role === "user" ? "(asked)" : row.text]), [["user", "(asked)"], ["assistant", "First answer."], ["assistant", "Background job finished: all 5 images are ready."]], "both replies are saved, once each, as leader messages");
    assert.equal(chatFile(server, tab).filter((row) => row.role === "assistant").length, 2, "and on disk");
    const firstDoneAt = c.messages.findIndex((m, i) => i >= from && m.type === "chatDone" && m.tabId === tab);
    const replyingAfter = c.messages.slice(firstDoneAt).find((m) => m.type === "state" && m.projects[0].tabs.find((t: any) => t.id === tab).derived.leaderTurnActive === true);
    assert.ok(replyingAfter, "after the first chatDone the state still said the tab was replying: that is the follow-up");
    assert.equal(replyingAfter.projects[0].tabs.find((t: any) => t.id === tab).derived.busy, true, "and busy");
    assert.ok(c.streamed(tab, from).includes("Background job finished"), "it streamed to the page");
    assert.deepEqual(c.labels(tab, from).filter((label) => label !== null).slice(-1), ["Thinking"], "the follow-up showed its step line");
    assert.equal(c.tabState(tab).derived.leaderTurnActive, false);
    // The next message is a clean reply: nothing of the follow-up is in it.
    await c.start(tab, JSON.stringify([{ say: "Second answer." }]));
    await c.finished(tab, 3, "the next reply ends");
    const rows = c.answers(tab).filter((row) => row.role === "assistant");
    assert.equal(rows.at(-1)!.text, "Second answer.", "nothing carried into the next reply");
    assert.equal(rows.length, 3);
  });
});

test("D: while Claude answers by itself the tab is busy everywhere: a chat message is refused as busy (the page queues it), a steer is refused, a folder change is refused, and Stop saves what was said", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 12);
    await c.start(tab, JSON.stringify([{ say: "First." }, { followUp: [{ say: "part A " }, { wait: 3000 }, { say: "part B" }], after: 200 }]));
    await c.wait(() => c.done(tab) === 1, "the asked reply ends");
    await c.wait(() => c.streamed(tab).includes("part A"), "the follow-up streams");
    assert.equal(c.tabState(tab).derived.leaderTurnActive, true);
    const from = c.messages.length;
    c.send({ type: "chat", tabId: tab, text: "DURING-FOLLOWUP", requestId: "p14during" });
    c.send({ type: "steer", tabId: tab, text: "STEER-DURING", requestId: "p14steer" });
    c.send({ type: "changeFolder", tabId: tab, folder: join(server.temp, "work2") });
    await c.wait(() => c.messages.slice(from).filter((m) => m.type === "error" || m.type === "steerRefused").length >= 3, "three refusals");
    const refused = c.messages.slice(from).filter((m) => m.type === "error" || m.type === "steerRefused");
    assert.ok(refused.some((m) => m.type === "error" && m.reason === "busy" && m.requestId === "p14during"), "the chat message is refused as busy, typed, so the page can queue it");
    assert.ok(refused.some((m) => m.type === "steerRefused" && m.reason === "unavailable" && /answering on its own/.test(m.message)), "a steer has nothing to join, and the page is told why");
    assert.ok(refused.some((m) => m.type === "error" && /busy/.test(m.message)), "the folder cannot change");
    assert.ok(!c.answers(tab).some((row) => row.text === "DURING-FOLLOWUP" || row.text === "STEER-DURING"), "and neither message was written to the chat");
    // Stop: what was said is kept, marked, the tab is free.
    c.send({ type: "stopAll" });
    await c.wait(() => c.failed(tab) >= 1, "Stop reports");
    await sleep(150);
    assert.equal(c.tabState(tab).derived.leaderTurnActive, false, "the tab is free");
    assert.ok(c.answers(tab).some((row) => row.role === "assistant" && row.text.startsWith("part A") && row.text.includes("(Stopped before it finished.)")), "the part said is kept, marked as cut short");
    await c.start(tab, JSON.stringify([{ say: "After the stop." }]));
    await c.finished(tab, 2, "a new message works");
    assert.equal(c.answers(tab).at(-1)!.text, "After the stop.");
  });
});

test("D: Claude dying during its own follow-up ends that reply with the error saved; a follow-up with no text still settles; a result with nothing open ends nothing", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    let tab = tabOf("claude", 13);
    await c.start(tab, JSON.stringify([{ say: "First." }, { followUp: [{ say: "half an answer" }, { wait: 5000 }], after: 200 }]));
    await c.wait(() => c.streamed(tab).includes("half an answer"), "the follow-up streams");
    server.child.send("end-query");
    await c.wait(() => c.failed(tab) >= 1, "the death reports");
    await sleep(150);
    assert.equal(c.tabState(tab).derived.leaderTurnActive, false, "the tab is free again");
    assert.ok(c.answers(tab).some((row) => row.role === "assistant" && row.text.startsWith("half an answer")), "what it said is saved with the error");
    // A follow-up that only runs a tool (no text): its step shows, it settles with one chatDone, and nothing is saved for it.
    tab = tabOf("claude", 14);
    const from = c.messages.length;
    await c.start(tab, JSON.stringify([{ say: "First." }, { followUp: [{ toolUse: { id: "f1", name: "Bash", input: { command: SECRET } } }, { toolResult: { id: "f1", output: SECRET } }], after: 200 }]));
    await c.finished(tab, 2, "the text-less follow-up settles");
    assert.deepEqual(c.answers(tab).filter((row) => row.role === "assistant").map((row) => row.text), ["First."], "no empty message is saved");
    assert.ok(c.labels(tab, from).includes("Running a command"), "its step line showed");
    // A result with no reply open at all (nothing was said, nothing ran) is not a stray chatDone.
    tab = tabOf("claude", 10);
    await c.start(tab, JSON.stringify([{ say: "First." }, { followUp: [], after: 200 }]));
    await c.finished(tab, 1, "the asked reply ends");
    await sleep(1200);
    assert.equal(c.done(tab), 1, "still one chatDone");
    assert.equal(c.tabState(tab).derived.leaderTurnActive, false);
  });
});

// ---- E: separate messages never glue together ----

// Two separate messages of one reply, per CLI: Claude two assistant messages (a tool between), Codex two agentMessage items, OpenCode two text parts.
const TWO: Record<Cli, (first: string, second: string) => string> = {
  claude: (first, second) => JSON.stringify([{ message: true }, { block: "text" }, { say: first }, { toolUse: { id: "g1", name: "Bash", input: { command: "x" } } }, { toolResult: { id: "g1" } }, { message: true }, { block: "text" }, { say: second }]),
  codex: (first, second) => JSON.stringify([{ say: first, item: "m1" }, { say: second, item: "m2" }]),
  opencode: (first, second) => JSON.stringify([{ say: first, part: "prt_ga" }, { say: second, part: "prt_gb" }]),
};
const saved = (c: Client, tab: string) => c.answers(tab).filter((row) => row.role === "assistant").map((row) => row.text);

test("E: two separate messages in one reply are separated by one blank line, in all three CLIs (saved text and streamed text agree)", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 7), from = c.messages.length;
      await c.start(tab, TWO[cli]("one in-game scene.", "Codex is drawing"));
      await c.finished(tab, 1, `${cli}: ends`);
      assert.deepEqual(saved(c, tab), ["one in-game scene.\n\nCodex is drawing"], `${cli}: one blank line between the messages`);
      assert.equal(c.streamed(tab, from), "one in-game scene.\n\nCodex is drawing", `${cli}: the page's draft reads the same`);
      assert.ok(!/one in-game scene\.Codex/.test(JSON.stringify(chatFile(server, tab))), `${cli}: control: never glued`);
    }
  });
});

test("E: a text that already ends with a newline gets no extra blank line; the first text of a reply and of the next reply get none; text in the same message is not split", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      let tab = tabOf(cli, 8);
      await c.start(tab, TWO[cli]("line one.\n", "line two"));
      await c.finished(tab, 1, `${cli}: ends`);
      assert.deepEqual(saved(c, tab), ["line one.\nline two"], `${cli}: it already ended with a newline`);
      // The next reply on the same tab starts with a message other than the last one of the first reply: still no leading blank line.
      await c.start(tab, cli === "claude" ? JSON.stringify([{ message: true }, { block: "text" }, { say: "Second reply." }]) : cli === "codex" ? JSON.stringify([{ say: "Second reply.", item: "m9" }]) : JSON.stringify([{ say: "Second reply.", part: "prt_gz" }]));
      await c.finished(tab, 2, `${cli}: the second reply ends`);
      assert.equal(saved(c, tab).at(-1), "Second reply.", `${cli}: a reply never starts with a blank line`);
      // One message said in pieces stays one run of text.
      tab = tabOf(cli, 9);
      await c.start(tab, JSON.stringify(cli === "claude" ? [{ message: true }, { block: "text" }, { say: "in " }, { say: "pieces" }] : cli === "codex" ? [{ say: "in pieces", item: "m5" }] : [{ say: "in pieces", part: "prt_gp" }]));
      await c.finished(tab, 1, `${cli}: pieces end`);
      assert.deepEqual(saved(c, tab), ["in pieces"], `${cli}: one message is not split`);
    }
  });
});

test("E: Claude marks a new message in two ways (a new assistant message, a new text block): each one alone starts a new paragraph", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 11);
    await c.start(tab, JSON.stringify([{ block: "text" }, { say: "block one." }, { block: "text" }, { say: "block two." }]));
    await c.finished(tab, 1, "text blocks end");
    assert.deepEqual(saved(c, tab), ["block one.\n\nblock two."], "a second text block, same message");
    await c.start(tab, JSON.stringify([{ message: true }, { say: "message one." }, { message: true }, { say: "message two." }]));
    await c.finished(tab, 2, "messages end");
    assert.equal(saved(c, tab).at(-1), "message one.\n\nmessage two.", "a second assistant message, no block start seen");
    // A sub-agent's own message start does not break the leader's text.
    await c.start(tab, JSON.stringify([{ message: true }, { say: "leader says " }, { message: true, parent: "zz" }, { toolUse: { id: "z1", name: "Bash", input: {}, parent: "zz" } }, { say: "more" }]));
    await c.finished(tab, 3, "sub-agent mix ends");
    assert.equal(saved(c, tab).at(-1), "leader says more", "a sub-agent's own message start is not a new message of the leader");
  });
});

test("E: after a steer splits the reply, the part after it never starts with a blank line (a saved message never does)", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 10);
      await c.start(tab, JSON.stringify([{ say: `part one ${PAD}`, ...(cli === "opencode" ? { part: "prt_sa" } : {}) }, cli === "claude" ? { wait: 900 } : { sleep: 900 }, { say: "part two", ...(cli === "opencode" ? { part: "prt_sb" } : cli === "codex" ? { item: "m2" } : {}) }]));
      await c.wait(() => c.streamed(tab).includes("part one"), `${cli}: streaming`);
      c.send({ type: "steer", tabId: tab, text: `STEER-${cli}`, requestId: `p14s-${cli}` });
      await c.finished(tab, 1, `${cli}: ends`);
      const assistant = c.answers(tab).filter((row) => row.role === "assistant");
      assert.ok(assistant.length >= 2, `${cli}: the reply was split by the steer`);
      for (const row of assistant) assert.ok(!/^\s*\n/.test(row.text), `${cli}: a saved message never starts with a blank line: ${JSON.stringify(row.text.slice(0, 20))}`);
    }
  });
});

// A secret cut in two, half at the end of one text part and the rest at the start of the NEXT part (the leader puts a paragraph break between them): redaction must still find it.
const SPLIT_FORMS = ["password", "token", "basic"] as const;
const splitSecret = async (server: Server, c: Client, index: number): Promise<string> => (await c.wait(() => fakeLog(server).filter((entry) => entry.splitSecret)[index], "the fake sent the first half of the secret")).splitSecret;
const everythingOf = (server: Server, c: Client, tab: string) => JSON.stringify([c.messages.filter((m) => m.type !== "state" && m.tabId === tab), c.streamed(tab), chatFile(server, tab)]);
const noPieceOf = (everything: string, secret: string, label: string) => { for (let at = 0; at + 8 <= secret.length; at++) assert.ok(!everything.includes(secret.slice(at, at + 8)), `${label}: no 8 character piece of the secret at ${at}`); };

test("E secret: a secret split across two text parts (the paragraph break between them) is hidden whole, in either half and in its Basic-auth form; the break itself still shows between ordinary parts", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const [index, form] of SPLIT_FORMS.entries()) {
      const tab = tabOf("opencode", index + 1);
      await c.start(tab, JSON.stringify([{ say: PAD }, { leakParts: { form } }]));
      await c.finished(tab, 1, `${form}: ends`);
      const secret = await splitSecret(server, c, index);
      noPieceOf(everythingOf(server, c, tab), secret, form);
      assert.deepEqual(saved(c, tab), [`${PAD}\n\nvisible-end \n\n[hidden] after`], `${form}: hidden, with the break between the parts and the secret's own [hidden] after it`);
      assert.equal(c.streamed(tab), `${PAD}\n\nvisible-end \n\n[hidden] after`, `${form}: the page's draft reads the same`);
    }
  });
});

test("E secret: the same split across two text parts with a steer between the halves, and with a Stop between them, never shows any piece of it", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const [index, form] of SPLIT_FORMS.entries()) {
      const tab = tabOf("opencode", index + 1);
      await c.start(tab, JSON.stringify([{ say: PAD }, { leakParts: { form, sleep: 1200 } }]));
      const secret = await splitSecret(server, c, index);
      await sleep(300);
      const requestId = `p14sec${index}`;
      c.send({ type: "steer", tabId: tab, text: `STEER-SECRET-${form}`, requestId });
      await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `${form}: the steer is taken`);
      await c.finished(tab, 1, `${form}: ends`);
      noPieceOf(everythingOf(server, c, tab), secret, `${form} with a steer`);
      assert.ok(c.answers(tab).map((row) => row.text).join("").includes("[hidden] after"), `${form}: hidden once complete`);
    }
    for (const [index, form] of SPLIT_FORMS.entries()) {
      const tab = tabOf("opencode", index + 4);
      await c.start(tab, JSON.stringify([{ say: PAD }, { leakParts: { form, sleep: 8000 } }]));
      const secret = await splitSecret(server, c, SPLIT_FORMS.length + index);
      await sleep(300);
      c.send({ type: "stopAll" });
      await c.wait(() => c.failed(tab) >= 1, `${form}: the stop ends the reply`);
      await sleep(300);
      noPieceOf(everythingOf(server, c, tab), secret, `${form} stopped`);
      assert.ok(chatFile(server, tab).some((row) => row.role === "assistant" && row.text.includes("[hidden]")), `${form}: the held first half was written as [hidden]`);
    }
  });
});

test("E sweep: every place a leader's text is joined is listed, and each adapter puts the paragraph break in before the text leaves it", () => {
  // The join points, from the real files (not a hand-picked set): every server/*.ts that hands text to onDelta, with how many calls, and what each does.
  const counts: Record<string, number> = {};
  for (const name of readdirSync("server").filter((file) => file.endsWith(".ts"))) {
    const found = readFileSync(join("server", name), "utf8").match(/\.onDelta\(/g)?.length ?? 0;
    if (found) counts[name] = found;
  }
  assert.deepEqual(counts, { "leader-acp.ts": 2, "leader-codex.ts": 1, "leader-opencode.ts": 2,"leader.ts": 1 }, "a new onDelta call site means a new join point: add it here and give it the paragraph break");
  const read = (name: string) => readFileSync(join("server", name), "utf8");
  assert.ok(read("leader.ts").includes("cb.onDelta(own ? paragraphs.text(event.delta.text, messageKey) : event.delta.text)"), "Claude: the leader's own text goes through the paragraph helper (a sub-agent's text is passed on as it always was)");
  assert.ok(read("leader-codex.ts").includes("cb.onDelta(paragraphs.text(params.delta, String(params.itemId ?? \"\")))"), "Codex: keyed by the agentMessage item");
  assert.ok(read("leader-opencode.ts").includes("emitDelta(p.delta, paragraphs.text(p.delta, String(p.partID)).length > p.delta.length)"), "OpenCode: keyed by the text part; the break is handed to the secret filter as a mark, never put into the text it searches (flushTail and flushSafeTail only release text that already went through it)");
  assert.ok(read("leader-acp.ts").includes("const shown = paragraphs.text(text, messageKey); emit(text, shown.slice(0, shown.length - text.length));"), "ACP: keyed by the message (a tool step or a thought starts the next one); the break is passed to emit as `gap`, so the secret filter decides it and drops it while a token may be in progress");
  // The server's own two joins: the reply text, and the strip at the start of a reply.
  const index = read("index.ts");
  assert.equal((index.match(/leaderTurnText\.set\(tabId, \(leaderTurnText\.get\(tabId\) \?\? ""\) \+ text\)/g) ?? []).length, 1, "the server joins the reply text in one place");
  assert.ok(index.includes('const text = leaderTurnText.get(tabId) ? raw : raw.replace(/^\\n+/, "");'), "and strips blank lines only at the start of a reply (or of the part after a steer)");
});
