import { SERVER_START_MS, waitForServerStart } from "./server-start.ts";
// Pack 9 server tests, shared setup: a real server with fake CLIs and a fake activity home, a websocket client, and writers for the fake Codex, Claude and OpenCode session records.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { KILL_TIMEOUT_MS, LIST_TIMEOUT_MS } from "../server/leader-common.ts";
import { scratchDir } from "./temp-root.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { codexRecord as plantCodexRecord } from "./codex-record.ts";

export const SEATS = getProcessDefinition("dev", "main").seats;
export const LEADERS = { codex: { cli: "codex", model: "gpt-6-sol", effort: "high" }, claude: { cli: "claude", model: SEATS.find((seat) => seat.isLeader)!.model, effort: SEATS.find((seat) => seat.isLeader)!.effort }, opencode: { cli: "opencode", model: "fakeprov/fake-model", effort: "max" } };
export const crewFor = (process: "main" | "solo" = "main", leader: keyof typeof LEADERS = "codex") => getProcessDefinition("dev", process).seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort, ...(seat.isLeader ? LEADERS[leader] : {}) }));
export const TAB_A = "p9-a", TAB_B = "p9-b";
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// A crew run is reported over only after its cleanup sweep, which the runner caps at SWEEP_WAIT_MS (LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000): a wait for a run's end outlasts that cap.
export const RUN_END_MS = LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000 + 7000;
// A fake run that sleeps N pings takes about N s before its sweep starts, so its end comes that much later.
export const runEndMs = (fakeRunSleep = "0") => RUN_END_MS + Number(fakeRunSleep) * 1000;
// A test's own timeout: the server start, every run-end wait it does, and 30 s for the rest.
export const testTimeoutMs = (...runEndWaits: number[]) => SERVER_START_MS + runEndWaits.reduce((sum, ms) => sum + ms, 0) + 30_000;
export const touch = (path: string, mtimeMs: number) => utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);

// The fake CLIs: a crew run "writes a file" in the folder it runs in, optionally stays a few seconds (FAKE_RUN_SLEEP), and ends.
export const cliDir = scratchDir();
for (const name of ["claude", "codex", "opencode"]) writeFileSync(join(cliDir, `${name}.cmd`), "@echo off\r\necho ran> \"%CD%\\run-wrote.txt\"\r\nif defined FAKE_RUN_SLEEP ping -n %FAKE_RUN_SLEEP% 127.0.0.1 >nul\r\nexit /b 0\r\n");

export type Server = { port: number; key: string; temp: string; data: string; work: string; activityHome: string; child: ChildProcess; log: () => string; stop: (keep?: boolean) => Promise<void> };
export type TabSpec = { id: string; name?: string; process?: "main" | "solo"; folder: string };
export async function boot(options: { temp?: string; env?: Record<string, string>; noActivityHome?: boolean; leader?: keyof typeof LEADERS; tabs?: (work: string) => TabSpec[] } = {}): Promise<Server> {
  const fresh = !options.temp;
  const temp = options.temp ?? mkdtempSync(join(tmpdir(), "cc-pack9-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work"), activityHome = join(temp, "activity-home");
  for (const dir of [home, work, activityHome, join(data, "config")]) mkdirSync(dir, { recursive: true });
  if (fresh) {
    const tab = (spec: TabSpec) => ({ id: spec.id, name: spec.name ?? spec.id, kind: "dev", process: spec.process ?? "main", folder: spec.folder, crew: crewFor(spec.process ?? "main", options.leader) });
    const specs = options.tabs?.(work) ?? [{ id: TAB_A, folder: work }, { id: TAB_B, folder: work }];
    for (const spec of specs) mkdirSync(spec.folder, { recursive: true });
    writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p9", name: "P9", folder: work, tabs: specs.map(tab) }] }));
  }
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: {} }));
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [cliDir, dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: "0", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1",
    FAKE_LEADER_LOG: join(temp, "fake-leader.log"), CC_APP_KEY: key, ...(options.noActivityHome ? {} : { CC_TEST_FAKE_CLI_ACTIVITY_HOME: activityHome }), ...options.env,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: env as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack9-server");
  let log = "";
  child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  // CC_PORT=0: the OS picks the port at the server's own listen, so no other test can take it first.
  const port = await waitForServerStart(child, () => log);
  return {
    port, key, temp, data, work, activityHome, child, log: () => log,
    stop: async (keep = false) => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((ok) => child.once("exit", ok));
          child.once("error", () => {});
          try { child.send("shutdown", () => {}); } catch { /* IPC already closed: fall through to kill */ }
          await Promise.race([exited, sleep(8000)]);
          if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, sleep(3000)]); }
        }
      // A crew run's fake CLI can still hold the work folder for a few seconds (a failed test leaves it running): retry rather than let the removal error hide the real failure.
      } finally { if (!keep) removeWithRetry(temp, 40, 500); }
    },
  };
}

export async function client(server: Server) {
  const messages: any[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${server.key}`, { origin: `http://127.0.0.1:${server.port}` });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(socket, "open");
  const send = (payload: any) => socket.send(JSON.stringify(payload));
  const wait = async <T>(fn: () => T, label: string, ms = 10_000): Promise<NonNullable<T>> => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${server.log().slice(-500)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-5))}`);
  };
  send({ type: "hello" });
  await wait(() => messages.find((m) => m.type === "state"), "first state");
  let n = 0;
  const api = {
    messages, send, wait, close: () => socket.terminate(),
    state: () => messages.filter((m) => m.type === "state").at(-1),
    tab: (id: string) => api.state().projects[0].tabs.find((t: any) => t.id === id),
    // A chat message and what the server answered to it: held (folderBusy), taken (the user's message echoed with this request id), or refused (error).
    chat: async (tabId: string, text: string, options: { confirmBusy?: boolean } = {}) => {
      const requestId = `p9r${++n}`;
      send({ type: "chat", tabId, text, requestId, ...(options.confirmBusy ? { confirmBusy: true } : {}) });
      const answer = await wait(() => messages.find((m) => (m.type === "folderBusy" || m.type === "error") && m.requestId === requestId) ?? messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `an answer to ${requestId}`);
      return { requestId, answer, held: answer.type === "folderBusy", taken: answer.type === "chatMessage" };
    },
    turnDone: (tabId: string) => messages.filter((m) => (m.type === "chatDone" || m.type === "chatError") && m.tabId === tabId).length,
    chatAndFinish: async (tabId: string, text: string, options: { confirmBusy?: boolean } = {}) => {
      const before = api.turnDone(tabId);
      const result = await api.chat(tabId, text, options);
      if (result.taken) await wait(() => api.turnDone(tabId) > before, `the turn of ${result.requestId} finished`);
      return result;
    },
    busyProbe: async (tabId: string) => {
      const start = messages.length;
      send({ type: "testFolderBusy", tabId });
      return (await wait(() => messages.slice(start).find((m) => m.type === "testFolderBusyResult" && m.tabId === tabId), "the folder probe")).items as { tool: string | null; agoSeconds: number; writer?: { seatName: string; roleLabel: string; tabName: string } }[];
    },
    // Windows can report a file change late or in bursts: retry on the read-only probe, never assert on the first tick.
    busyUntil: async (tabId: string, ms = 10_000) => {
      const until = Date.now() + ms;
      for (;;) { const probe = await api.busyProbe(tabId); if (probe.length || Date.now() > until) return probe; await sleep(50); }
    },
    runEnds: () => messages.filter((m) => m.type === "runFinish" || m.type === "runFail" || m.type === "runStop").length,
  };
  return api;
}

// ---- fake records ----
export function codexRecord(server: Server, id: string, mtimeMs: number, cwd = server.work): string {
  return plantCodexRecord(server.activityHome, cwd, id, mtimeMs);
}
export function claudeRecord(server: Server, id: string, mtimeMs: number): string {
  const dir = join(server.activityHome, ".claude", "projects", server.work.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `{"type":"user","sessionId":"${id}"}\n`);
  touch(file, mtimeMs);
  return file;
}
export function opencodeRecord(server: Server, id: string, mtimeMs: number, createdMs = mtimeMs): void {
  const path = join(server.activityHome, ".local", "share", "opencode", "opencode.db");
  mkdirSync(dirname(path), { recursive: true });
  const db = new (process.getBuiltinModule("node:sqlite")!).DatabaseSync(path);
  db.exec("create table if not exists session (id text primary key, directory text, time_updated integer, time_created integer)");
  db.prepare("insert or replace into session (id, directory, time_updated, time_created) values (?, ?, ?, ?)").run(id, server.work, mtimeMs, createdMs);
  db.close();
}
export const fakeLeaderTurns = (server: Server) => (existsSync(join(server.temp, "fake-leader.log")) ? readFileSync(join(server.temp, "fake-leader.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e: any) => e.method === "turn/start").length;

export async function withServer(options: Parameters<typeof boot>[0], body: (server: Server, c: Awaited<ReturnType<typeof client>>) => Promise<void>): Promise<void> {
  const server = await boot(options);
  const c = await client(server);
  try { await body(server, c); } finally { c.close(); await server.stop(); }
}
