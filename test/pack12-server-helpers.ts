import { waitForServerStart } from "./server-start.ts";
// Pack 12 server tests, shared setup: a real server on a temp data root with a Claude, a Codex and an OpenCode leader, a websocket client, and readers for what the fake CLIs recorded.
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

export const MAIN = getProcessDefinition("dev", "main").seats, SOLO = getProcessDefinition("dev", "solo").seats;
export const crewFor = (seats: typeof MAIN, leader?: { cli: string; model: string; effort: string }) => seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort, ...(seat.isLeader ? leader : {}) }));
export const CLIS = ["claude", "codex", "opencode"] as const;
export type Cli = (typeof CLIS)[number];
export const LEADERS: Record<Cli, { cli: string; model: string; effort: string } | undefined> = {
  claude: undefined, codex: { cli: "codex", model: "gpt-6-sol", effort: "high" }, opencode: { cli: "opencode", model: "fakeprov/fake-model", effort: "max" },
};
export const TAB_COUNT = 7;
export const tabOf = (cli: Cli, n: number) => `p12-${cli}-${n}`;
export const SOLO_TAB = "p12-solo", SPARE_TAB = "p12-spare";
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
export const ECHO: Record<Cli, (text: string) => RegExp> = {
  claude: (text) => new RegExp(`\\[folded: ${text}\\]`), codex: (text) => new RegExp(`\\[steer: ${text}\\]`), opencode: (text) => new RegExp(`\\[steer: ${text}\\]`),
};
// A reply with a pause in the middle: the steer lands during the pause.
export const slow = (cli: Cli, head: string, tail: string, ms = 900): string => JSON.stringify([{ say: head }, cli === "claude" ? { wait: ms } : { sleep: ms }, { say: tail }]);

export type Server = { port: number; key: string; temp: string; data: string; work: string; child: ChildProcess; log: () => string; stop: () => Promise<void> };
export async function boot(env: Record<string, string> = {}): Promise<Server> {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack12-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work");
  for (const dir of [home, work, join(data, "config"), join(data, "chats"), join(data, "scratch")]) mkdirSync(dir, { recursive: true });
  const tab = (id: string, seats: typeof MAIN, leader?: { cli: string; model: string; effort: string }, process = "main") => ({ id, name: id, kind: "dev", process, folder: work, crew: crewFor(seats, leader) });
  const tabs = [
    ...CLIS.flatMap((cli) => Array.from({ length: TAB_COUNT }, (_, index) => tab(tabOf(cli, index + 1), MAIN, LEADERS[cli]))),
    tab(SPARE_TAB, MAIN, LEADERS.codex), tab(SOLO_TAB, SOLO, LEADERS.codex, "solo"),
  ];
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p12", name: "P12", folder: work, tabs }] }));
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: Object.fromEntries(["claude", "codex"].map((cli) => [JSON.stringify([cli, "--version"]), { code: 0, stdout: `${cli} 1.0.0`, stderr: "" }])) }));
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const full: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: "0", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1",
    // A native Claude path, so the leader passes --replay-user-messages (the Claude fake echoes only when it gets that flag, as the real CLI does).
    FAKE_LEADER_LOG: join(temp, "fake-leader.log"), CC_APP_KEY: key, CLAUDE_CLI_PATH: process.execPath, ...env,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: full as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack12-server");
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
  const answers = (tabId: string) => messages.filter((m) => m.type === "chatMessage" && m.tabId === tabId && m.role !== "notice").map((m) => ({ role: m.role as string, text: m.text as string, requestId: m.requestId as string | undefined, files: m.files as string[] | undefined, split: m.split === true }));
  const streamed = (tabId: string, from = 0) => messages.slice(from).filter((m) => m.type === "chatDelta" && m.tabId === tabId).map((m) => m.text).join("");
  // Starts a turn and returns once the server took the message; the reply is left running.
  const start = async (tabId: string, text: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const requestId = `p12c${++n}`;
    send({ type: "chat", tabId, text, requestId, ...extra });
    await wait(() => messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `chat ${requestId} taken`);
    return requestId;
  };
  const steer = (tabId: string, text: string, extra: Record<string, unknown> = {}): string => { const requestId = `p12s${++n}`; send({ type: "steer", tabId, text, requestId, ...extra }); return requestId; };
  const finished = async (tabId: string, count: number, label: string, ms = 15_000) => { await wait(() => done(tabId) >= count, label, ms); await sleep(120); };
  return { messages, state, tabState, wait, send, start, steer, done, failed, answers, streamed, finished, close: () => socket.terminate() };
}
export type Client = Awaited<ReturnType<typeof client>>;

// What the fake leaders recorded (the far boundary): every line carries its CLI.
export const fakeLog = (server: Server): any[] => (existsSync(join(server.temp, "fake-leader.log")) ? readFileSync(join(server.temp, "fake-leader.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
export type Seen = { kind: "steer" | "start"; whileTurnOpen?: boolean; images?: string[] };
// Every time `text` reached a leader of this CLI, and how: as a steer into the running turn or as the start of a turn.
export function reached(server: Server, cli: Cli, text: string): Seen[] {
  const out: Seen[] = [];
  for (const entry of fakeLog(server)) {
    if (cli === "claude" && entry.cli === "claude" && typeof entry.userText === "string" && entry.userText.includes(text)) out.push({ kind: entry.whileTurnOpen ? "steer" : "start", whileTurnOpen: entry.whileTurnOpen });
    if (cli === "codex" && entry.cli === "codex" && entry.method === "turn/steer" && String(entry.params?.input?.[0]?.text).includes(text)) out.push({ kind: "steer", images: entry.params.input.slice(1).map((item: any) => item.path) });
    if (cli === "codex" && entry.cli === "codex" && entry.method === "turn/start" && String(entry.params?.input?.[0]?.text).includes(text)) out.push({ kind: "start" });
    if (cli === "opencode" && entry.cli === "opencode" && entry.path?.endsWith("/prompt_async") && String(entry.body?.parts?.[0]?.text).includes(text)) out.push({ kind: "start" });
  }
  // OpenCode's fake also notes a prompt that arrived while its run was going: that one was a steer.
  if (cli === "opencode") for (const entry of fakeLog(server)) if (entry.midRun && String(entry.text).includes(text)) out[out.findIndex((item) => item.kind === "start")]!.kind = "steer";
  return out;
}
// OpenCode holds back the last ~80 characters of a reply (its secret filter), so test replies start with more than that to stream at once.
export const PAD = "-".repeat(100);
export const HEAD = `part one ${PAD}`;
export const promptCount = (server: Server) => fakeLog(server).filter((entry) => entry.cli === "opencode" && entry.path?.endsWith("/prompt_async")).length;
// The chat file on disk is the independent measurement of what the chat held.
export const chatFile = (server: Server, tabId: string): any[] => readFileSync(join(server.data, "chats", `${tabId}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.type === "message" && row.role !== "notice");
export const upload = (server: Server, name: string): string => { const path = join(server.data, "scratch", name); writeFileSync(path, "x"); return path; };

export async function withServer(env: Record<string, string>, body: (server: Server, c: Client) => Promise<void>): Promise<void> {
  const server = await boot(env);
  const c = await client(server);
  try { await body(server, c); } finally { c.close(); await server.stop(); }
}

export const unansweredNotices = (c: Client, tab: string) => c.messages.filter((m) => m.type === "chatMessage" && m.tabId === tab && m.role === "notice" && /may not have been answered/.test(m.text));
