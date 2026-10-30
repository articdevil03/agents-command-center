import { waitForServerStart } from "./server-start.ts";
// Pack 14 server tests, shared setup: a real server with an OpenCode, Codex or Claude leader on the far-boundary fakes, a websocket client, and the scripts each leader CLI is made to play.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { attachCrashCatcher } from "./crash-catcher.ts";

export const MAIN = getProcessDefinition("dev", "main").seats;
export const crewFor = (seats: typeof MAIN, leader?: { cli: string; model: string; effort: string }) => seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort, ...(seat.isLeader ? leader : {}) }));
export const CLIS = ["claude", "codex", "opencode"] as const;
export type Cli = (typeof CLIS)[number];
export const LEADERS: Record<Cli, { cli: string; model: string; effort: string } | undefined> = {
  claude: undefined, codex: { cli: "codex", model: "gpt-6-sol", effort: "high" }, opencode: { cli: "opencode", model: "fakeprov/fake-model", effort: "max" },
};
export const TAB_COUNT = 14;
export const tabOf = (cli: Cli, n: number) => `p14-${cli}-${n}`;
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// The made-up secret planted in every command, query, path, content and output the fakes play.
export const SECRET = "SECRET-P14-xK39qz";
// OpenCode holds back the last ~80 characters of a reply (its secret filter), so replies whose text matters start with more than that.
export const PAD = "-".repeat(100);
// Every label the leader may ever show: the fixed table, a helper count, or a skill's cleaned name.
export const ALLOWED = /^(Thinking|Running a command|Reading a file|Searching files|Editing files|Searching the web|Reading a web page|Planning|Using a tool|Using a skill|Using skill: [A-Za-z0-9:_-]{1,40}|[0-9]+ helpers? working)$/;

export type Server = { port: number; key: string; temp: string; data: string; work: string; child: ChildProcess; log: () => string; stop: () => Promise<void> };
export async function boot(env: Record<string, string> = {}): Promise<Server> {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack14-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work");
  for (const dir of [home, work, join(temp, "work2"), join(data, "config"), join(data, "chats"), join(data, "scratch")]) mkdirSync(dir, { recursive: true });
  const tab = (id: string, leader?: { cli: string; model: string; effort: string }) => ({ id, name: id, kind: "dev", process: "main", folder: work, crew: crewFor(MAIN, leader) });
  const tabs = CLIS.flatMap((cli) => Array.from({ length: TAB_COUNT }, (_, index) => tab(tabOf(cli, index + 1), LEADERS[cli])));
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p14", name: "P14", folder: work, tabs }] }));
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: Object.fromEntries(["claude", "codex"].map((cli) => [JSON.stringify([cli, "--version"]), { code: 0, stdout: `${cli} 1.0.0`, stderr: "" }])) }));
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const full: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: "0", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1",
    FAKE_LEADER_LOG: join(temp, "fake-leader.log"), CC_APP_KEY: key, CLAUDE_CLI_PATH: process.execPath, ...env,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: full as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack14-server");
  let log = "";
  child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  // CC_PORT=0: the OS picks the port at the server's own listen, so no other test can take it first.
  const port = await waitForServerStart(child, () => log);
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

export async function client(server: Server) {
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
export type Client = Awaited<ReturnType<typeof client>>;

export const fakeLog = (server: Server): any[] => (existsSync(join(server.temp, "fake-leader.log")) ? readFileSync(join(server.temp, "fake-leader.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
export const chatFile = (server: Server, tabId: string): any[] => readFileSync(join(server.data, "chats", `${tabId}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.type === "message" && row.role !== "notice");

export async function withServer(env: Record<string, string>, body: (server: Server, c: Client) => Promise<void>): Promise<void> {
  const server = await boot(env);
  const c = await client(server);
  try { await body(server, c); } finally { c.close(); await server.stop(); }
}

// ---- the scripts: what each leader CLI is made to do, with the secret in every input and output field the probe showed ----
// A skill name that is not an identifier (markup, a newline, spaces, far too long): only [A-Za-z0-9:_-], 40 characters, may come out.
export const DIRTY_SKILL = `<b>evil</b> name\nwith spaces ${"a".repeat(60)}`;
export const CLEAN_SKILL = DIRTY_SKILL.replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 40);
export const CLAUDE_STEPS = [
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
export const CLAUDE_LABELS = ["Thinking", "Running a command", "Thinking", "Reading a file", "Thinking", "Searching the web", "Thinking", "Searching files", "Thinking", "Editing files", "Thinking",
  "Using a skill", "Using skill: deep-research", "Thinking", "Using a skill", `Using skill: ${CLEAN_SKILL}`, "Thinking", "1 helper working", "2 helpers working", "1 helper working", "Thinking", "Planning", "Thinking", "Reading a web page", "Thinking", "Using a tool", "Thinking", null];
export const CODEX_STEPS = [
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
export const CODEX_LABELS = ["Thinking", "Running a command", "Thinking", "Reading a file", "Thinking", "Searching files", "Thinking", "Editing files", "Thinking", "Searching the web", "Thinking", "Using a tool", "Thinking", null];
export const OPENCODE_STEPS = [
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
export const OPENCODE_LABELS = ["Thinking", "Running a command", "Thinking", "Reading a file", "Thinking", "Searching files", "Thinking", "Editing files", "Thinking", "Searching the web", "Thinking", "Reading a web page", "Thinking",
  "1 helper working", "Thinking", "Planning", "Thinking", "Using a tool", "Thinking", null];
export const LABEL_RUN: Record<Cli, { steps: unknown[]; labels: Array<string | null> }> = {
  claude: { steps: CLAUDE_STEPS, labels: CLAUDE_LABELS }, codex: { steps: CODEX_STEPS, labels: CODEX_LABELS }, opencode: { steps: OPENCODE_STEPS, labels: OPENCODE_LABELS },
};
// A step left running, then a pause: the reply is still going when the test acts (`die` ends the leader process on the spot).
export const RUNNING: Record<Cli, (after: unknown[]) => string> = {
  claude: (after) => JSON.stringify([{ toolUse: { id: "x", name: "Bash", input: { command: SECRET } } }, ...after]),
  codex: (after) => JSON.stringify([{ itemRun: { type: "commandExecution", id: "x", command: SECRET, commandActions: [], noComplete: true, hold: 50 } }, ...after]),
  opencode: (after) => JSON.stringify([{ toolPart: { tool: "bash", id: "x", input: { command: SECRET }, noComplete: true, hold: 50 } }, ...after]),
};
// A reply that thinks, then writes its answer: its own labels are exactly Thinking, then nothing.
export const NEXT_REPLY: Record<Cli, string> = {
  claude: JSON.stringify([{ block: "thinking" }, { block: "text" }, { say: "ok" }]),
  codex: JSON.stringify([{ itemRun: { type: "reasoning", id: "r2", hold: 10 } }, { itemRun: { type: "agentMessage", id: "a2", hold: 10 } }, { say: "ok" }]),
  opencode: JSON.stringify([{ reasoning: "x" }, { say: "ok" }]),
};
export const PAUSE: Record<Cli, unknown> = { claude: { wait: 6000 }, codex: { sleep: 6000 }, opencode: { sleep: 6000 } };
export const DIE: Record<Cli, unknown[]> = { claude: [PAUSE.claude], codex: [{ exit: true }], opencode: [{ exit: true }] };
