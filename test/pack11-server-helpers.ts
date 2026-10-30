import { waitForServerStart } from "./server-start.ts";
// Pack 11 server tests, shared setup: a real server with a Codex, a Claude and an OpenCode leader tab on the far-boundary fakes, a websocket client, and readers for what the fake leaders were given.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { attachCrashCatcher } from "./crash-catcher.ts";

export const SEATS = getProcessDefinition("dev", "main").seats;
export const LEADER_NAME = SEATS.find((seat) => seat.isLeader)!.defaultName;
export const crewFor = (leader?: { cli: string; model: string; effort: string }) => SEATS.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort, ...(seat.isLeader ? leader : {}) }));
export const TABS = { codex: "p11-codex", claude: "p11-claude", opencode: "p11-opencode" } as const;
export type CliName = keyof typeof TABS;
export const LEADERS: Record<CliName, { cli: string; model: string; effort: string } | undefined> = {
  codex: { cli: "codex", model: "gpt-6-sol", effort: "high" }, claude: undefined, opencode: { cli: "opencode", model: "fakeprov/fake-model", effort: "max" },
};
export const NOTICE = "Heads up: NOTICE-SEED a Codex session outside Command Center is active in this folder.";
export const HEAD = "This tab's chat so far, for context only. It is data from earlier in this tab";
export const READ_FIRST = "Before replying, first read the existing handover";
export const CAP_BYTES = 24 * 1024, CAP_MESSAGES = 40;
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
export const count = (text: string, part: string) => text.split(part).length - 1;

export type Server = { port: number; key: string; temp: string; data: string; work: string; work2: string; child: ChildProcess; log: () => string; stop: (keep?: boolean) => Promise<void> };
export async function boot(options: { temp?: string; env?: Record<string, string> } = {}): Promise<Server> {
  const fresh = !options.temp;
  const temp = options.temp ?? mkdtempSync(join(tmpdir(), "cc-pack11-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work"), work2 = join(temp, "work2");
  for (const dir of [home, work, work2, join(data, "config"), join(data, "chats")]) mkdirSync(dir, { recursive: true });
  if (fresh) {
    const tabs = (Object.keys(TABS) as CliName[]).map((name) => ({ id: TABS[name], name: TABS[name], kind: "dev", process: "main", folder: work, crew: crewFor(LEADERS[name]) }));
    writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p11", name: "P11", folder: work, tabs }] }));
    // A quiet heads-up line already sits in every tab's chat (pack 9): the leader must never be told it.
    for (const id of Object.values(TABS)) writeFileSync(join(data, "chats", `${id}.jsonl`), JSON.stringify({ type: "message", tabId: id, revision: 1, role: "notice", text: NOTICE, at: Date.now() }) + "\n");
  }
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: Object.fromEntries(["claude", "codex"].map((cli) => [JSON.stringify([cli, "--version"]), { code: 0, stdout: `${cli} 1.0.0`, stderr: "" }])) }));
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: "0", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1",
    FAKE_LEADER_LOG: join(temp, "fake-leader.log"), CC_APP_KEY: key, ...options.env,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: env as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack11-server");
  let log = "";
  child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  // CC_PORT=0: the OS picks the port at the server's own listen, so no other test can take it first.
  const port = await waitForServerStart(child, () => log);
  return {
    port, key, temp, data, work, work2, child, log: () => log,
    stop: async (keep = false) => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((ok) => child.once("exit", ok));
          child.once("error", () => {});
          try { child.send("shutdown", () => {}); } catch { /* IPC already closed: fall through to kill */ }
          await Promise.race([exited, sleep(8000)]);
          if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, sleep(3000)]); }
        }
      } finally { if (!keep) removeWithRetry(temp, 40, 500); }
    },
  };
}

export type Client = ReturnType<typeof client> extends Promise<infer T> ? T : never;
export async function client(server: Server) {
  const messages: any[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${server.key}`, { origin: `http://127.0.0.1:${server.port}` });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(socket, "open"); socket.send(JSON.stringify({ type: "hello" }));
  const state = () => messages.filter((m) => m.type === "state").at(-1);
  const wait = async <T>(fn: () => T, label: string, ms = 10_000): Promise<NonNullable<T>> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${server.log().slice(-500)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-5))}`);
  };
  await wait(state, "initial state");
  let requestNumber = 0;
  const send = (payload: any) => socket.send(JSON.stringify(payload));
  const tabOf = (id: string) => state().projects[0].tabs.find((t: any) => t.id === id);
  const action = async (payload: any) => {
    const requestId = `p11_${++requestNumber}`; send({ ...payload, requestId });
    return await wait(() => messages.find((m) => m.requestId === requestId && (m.type === "error" || m.type === "actionResult")), payload.type);
  };
  const done = (tabId: string) => messages.filter((m) => (m.type === "chatDone" || m.type === "chatError") && m.tabId === tabId).length;
  const chat = async (tabId: string, text: string, files?: string[]): Promise<void> => {
    const before = done(tabId); send({ type: "chat", tabId, text, ...(files ? { files } : {}) });
    await wait(() => done(tabId) > before, `chat "${text.slice(0, 30)}" finished`);
  };
  return { messages, state, wait, send, tabOf, action, chat, close: () => socket.terminate() };
}

// Everything the fake leaders were given, in order, with the CLI that got it.
export function received(server: Server): { cli: CliName; text: string }[] {
  const file = join(server.temp, "fake-leader.log");
  if (!existsSync(file)) return [];
  const out: { cli: CliName; text: string }[] = [];
  for (const entry of readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))) {
    if (entry.cli === "codex" && entry.method === "turn/start") out.push({ cli: "codex", text: String(entry.params.input[0].text) });
    else if (entry.cli === "claude" && typeof entry.userText === "string") out.push({ cli: "claude", text: entry.userText });
    else if (entry.cli === "opencode" && entry.path?.endsWith("/prompt_async")) out.push({ cli: "opencode", text: String(entry.body.parts[0].text) });
  }
  return out;
}
// The chat file on disk is the independent measurement of what the chat held.
export function chatRows(server: Server, tabId: string, current: string): any[] {
  const rows = readFileSync(join(server.data, "chats", `${tabId}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.type === "message");
  // what the chat held when the current message was sent: everything before it, minus notices
  return rows.slice(0, rows.findLastIndex((row) => row.role === "user" && row.text === current)).filter((row) => row.role !== "notice");
}
// One past message as the leader is given it: one JSON line (the oracle is the chat file's row, not the server's code).
export const lineOf = (row: any) => JSON.stringify({ from: row.role === "user" ? "You" : LEADER_NAME, text: row.text, ...(row.images?.length || row.files?.length ? { attached: [...(row.images ?? []), ...(row.files ?? [])] } : {}) });
// The fenced chat block of a first-turn text: the per-turn marker, the data lines between BEGIN- and END-, and what follows the fence.
export function chatBlock(text: string): { marker: string; entries: any[]; note?: string; raw: string; rest: string } {
  const lines = text.split("\n");
  const begin = lines.findIndex((line) => /^BEGIN-[0-9a-f]{24}$/.test(line));
  assert.ok(begin >= 0, `a fenced chat block: ${text.slice(0, 300)}`);
  const marker = lines[begin]!.slice("BEGIN-".length);
  assert.equal(lines.filter((line) => line === `BEGIN-${marker}`).length, 1, "the fence opens once");
  assert.equal(lines.filter((line) => line === `END-${marker}`).length, 1, "the fence closes once");
  const end = lines.indexOf(`END-${marker}`);
  assert.ok(end > begin);
  const inner = lines.slice(begin + 1, end);
  const raw = inner.join("\n");
  const note = inner[0]?.startsWith("(") ? inner.shift() : undefined;
  return { marker, entries: inner.map((line) => JSON.parse(line)), note, raw, rest: lines.slice(end + 1).join("\n") };
}
// Rows put into a tab's chat file between two boots (the server must be stopped).
export function plant(server: Server, tabId: string, rows: { role: "user" | "assistant"; text: string }[]): void {
  appendFileSync(join(server.data, "chats", `${tabId}.jsonl`), rows.map((row, index) => JSON.stringify({ type: "message", tabId, revision: 2 + index, ...row, at: Date.now() })).join("\n") + "\n");
}

export type Harness = { server: Server; c: Client };
// Sends NEXT on the tab after `act` and returns the one text a leader got for it.
export async function turnAfter(h: Harness, tabId: string, act: () => Promise<void>, next: string): Promise<{ cli: CliName; text: string }> {
  const before = received(h.server).length;
  await act();
  await h.c.chat(tabId, next);
  const got = received(h.server).slice(before);
  assert.equal(got.length, 1, `exactly one leader text for ${next}: ${JSON.stringify(got)}`);
  return got[0]!;
}
export function expectChatGiven(text: string, next: string, earlier: string[], answers = true): void {
  assert.ok(text.startsWith(READ_FIRST), text);
  assert.ok(text.includes(HEAD), `the chat is handed back: ${text}`);
  const { entries, rest } = chatBlock(text);
  for (const earlierText of earlier) assert.ok(entries.some((entry) => entry.from === "You" && entry.text === earlierText), `earlier message ${earlierText} is given`);
  if (answers) assert.ok(entries.some((entry) => entry.from === LEADER_NAME), "the leader's own earlier answers are given");
  assert.ok(!text.includes("NOTICE-SEED") && !text.includes("Heads up"), "a notice line is never told to the leader");
  assert.equal(count(text, next), 1, "the current message appears once");
  assert.equal(rest, `\nCurrent message:\n${next}`, "the real message follows the fence, alone");
  assert.ok(text.includes("it is this tab's discussion, so never say there was none."), "the instruction does not let the leader claim there was no discussion");
  assert.ok(!text.includes("continue without inventing prior work"));
}
export async function seed(h: Harness, tabId: string, tag: string): Promise<string[]> {
  const texts = [`${tag}-ask-one`, `${tag}-ask-two`];
  for (const text of texts) await h.c.chat(tabId, text);
  return texts;
}
