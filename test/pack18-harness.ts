import { waitForServerStart } from "./server-start.ts";
// Pack 18 Block 1 test helper: a real server on a temp data root (never the repo's own config/), a keyed WebSocket client, and fake CLIs on PATH.
// A crew run is a do-nothing .cmd that writes run-wrote-<cli>.txt into its folder and stays FAKE_SLEEP_<CLI> seconds (ping counts N-1 seconds).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { LIST_TIMEOUT_MS, KILL_TIMEOUT_MS } from "../server/leader-common.ts";

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// A crew run is reported over only after its cleanup sweep, which the runner caps: a wait for a run's end outlasts that cap.
export const RUN_END_MS = LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000 + 7000;

export type Server = { port: number; key: string; temp: string; data: string; work: string; child: ChildProcess; log: () => string; stop: () => Promise<void> };
// extra runs after the default fake CLIs are written and before the server starts: a test may replace a CLI .cmd (bin) or add files (temp).
export type BootOptions = { tabs: (work: string) => any[]; acpClis?: any[]; env?: Record<string, string>; fakeLeader?: boolean; extra?: (paths: { temp: string; bin: string; work: string; data: string }) => void };

export async function boot(options: BootOptions): Promise<Server> {
  const temp = mkdtempSync(join(tmpdir(), "cc-p18s-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work"), bin = join(temp, "bin"), activityHome = join(temp, "activity-home");
  for (const dir of [home, work, bin, activityHome, join(data, "config"), join(data, "chats"), join(data, "scratch")]) mkdirSync(dir, { recursive: true });
  for (const name of ["claude", "codex", "opencode"]) {
    const sleepVar = `FAKE_SLEEP_${name.toUpperCase()}`;
    writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\necho ran> "%CD%\\run-wrote-${name}.txt"\r\nif defined ${sleepVar} ping -n %${sleepVar}% 127.0.0.1 >nul\r\nexit /b 0\r\n`);
  }
  writeFileSync(join(bin, "fake-acp.cmd"), "@echo off\r\n");
  options.extra?.({ temp, bin, work, data });
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p18", name: "P18", folder: work, tabs: options.tabs(work) }] }));
  if (options.acpClis) writeFileSync(join(data, "config", "acp-clis.json"), JSON.stringify({ clis: options.acpClis }));
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: Object.fromEntries(["claude", "codex"].map((cli) => [JSON.stringify([cli, "--version"]), { code: 0, stdout: `${cli} 1.0.0`, stderr: "" }])) }));
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [bin, dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: "0", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_CLI_ACTIVITY_HOME: activityHome,
    ...(options.fakeLeader ? { CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1", FAKE_LEADER_LOG: join(temp, "fake-leader.log") } : {}),
    CC_APP_KEY: key, CLAUDE_CLI_PATH: process.execPath, ...options.env,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: env as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack18-setups-server");
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
  const wait = async <T>(fn: () => T, label: string, ms = 12_000): Promise<NonNullable<T>> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${server.log().slice(-600)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-6))}`);
  };
  await wait(() => messages.find((m) => m.type === "state"), "initial state");
  let n = 0;
  const send = (payload: any) => socket.send(JSON.stringify(payload));
  const state = () => messages.filter((m) => m.type === "state").at(-1);
  const tab = (id: string) => state().projects.flatMap((project: any) => project.tabs).find((item: any) => item.id === id);
  // The unknown message answers after the preceding synchronous handler, so late refusals cannot be missed.
  const attempt = async (payload: any): Promise<{ error?: string }> => {
    const from = messages.length;
    send(payload);
    const barrier = `unknown message type: p18-barrier-${++n}`;
    send({ type: barrier.slice("unknown message type: ".length) });
    const reply = await wait(() => messages.slice(from).find((m) => m.type === "error" && m.message === barrier), "attempt barrier");
    const error = messages.slice(from, messages.indexOf(reply)).find((m) => m.type === "error");
    messages.splice(messages.indexOf(reply), 1);
    return error ? { error: error.message as string } : {};
  };
  // A request with a requestId answers with actionResult or an error.
  const request = async (payload: any): Promise<{ ok: boolean; message?: string }> => {
    const requestId = `p18r${++n}`; const from = messages.length;
    send({ ...payload, requestId });
    const reply = await wait(() => messages.slice(from).find((m) => m.requestId === requestId && (m.type === "actionResult" || m.type === "error")), `reply to ${payload.type}`);
    return reply.type === "actionResult" ? { ok: true } : { ok: false, message: reply.message };
  };
  const chat = async (tabId: string, text: string): Promise<string> => {
    const before = messages.filter((m) => (m.type === "chatDone" || m.type === "chatError") && m.tabId === tabId).length, from = messages.length;
    const requestId = `p18c${++n}`;
    send({ type: "chat", tabId, text, requestId });
    await wait(() => messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `chat ${requestId} taken`);
    await wait(() => messages.filter((m) => (m.type === "chatDone" || m.type === "chatError") && m.tabId === tabId).length > before, `chat ${requestId} answered`, 30_000);
    await sleep(100);
    return messages.slice(from).filter((m) => m.type === "chatDelta" && m.tabId === tabId).map((m) => m.text).join("");
  };
  const runEnds = (tabId?: string) => messages.filter((m) => (m.type === "runFinish" || m.type === "runFail" || m.type === "runStop") && (!tabId || m.tabId === tabId)).length;
  return { messages, state, tab, wait, send, attempt, request, chat, runEnds, close: () => socket.terminate() };
}
export type Client = Awaited<ReturnType<typeof client>>;

export const workspaceFile = (server: Server): any => JSON.parse(readFileSync(join(server.data, "config", "workspaces.json"), "utf8"));
export const workspaceBytes = (server: Server): string => readFileSync(join(server.data, "config", "workspaces.json"), "utf8");
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// A tab fixture in the CURRENT shape, built from a template's crew and steps.
export function tabOf(id: string, folder: string, template: { name: string; crew: any[]; steps: any[]; lookPause?: boolean }, change: (setup: { crew: any[]; steps: any[] }) => void = () => {}) {
  const setup = clone({ crew: template.crew, steps: template.steps });
  change(setup);
  return { id, name: id, kind: "dev", folder, setupName: template.name, crew: setup.crew, lookPause: template.lookPause ?? false, steps: setup.steps };
}
