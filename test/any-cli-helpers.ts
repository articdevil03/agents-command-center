import test from "node:test";
import { KILL_TIMEOUT_MS, LIST_TIMEOUT_MS, SWEEP_CAP_MS } from "../server/leader-common/types.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { importWithTempDataRoot, newAppKey, keyedWsUrl } from "./temp-root.ts";
import { attachCrashCatcher, crashFactsAfterDeath } from "./crash-catcher.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { waitForServerStart } from "./server-start.ts";

// The server modules that read their data root at import (config.ts and everything importing it) are loaded on a fresh temp folder,
// never on the repo's own (live) config/. The servers this file starts get their own data folders.
export const { dataDir: moduleDataDir, modules: { config, leaderApi, codexApi, opencodeApi, leaderCommon } } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"),
  leaderApi: await import("../server/leader.ts"),
  codexApi: await import("../server/leader-codex.ts"),
  opencodeApi: await import("../server/leader-opencode.ts"),
  leaderCommon: await import("../server/leader-common.ts"),
}));

export const { readWorkspaces } = config;

export const { buildLeaderOptions } = leaderApi;

export const { codexPolicy, createCodexLeader } = codexApi;

export const { opencodeRules, opencodeApprovalRequest, createOpencodeLeader } = opencodeApi;

// Every test here starts the real server with fake Codex / OpenCode CLIs behind the leader's spawn.
// Guards are driven through WebSocket messages and the bridge HTTP route, never through helpers.

export const SEATS = getProcessDefinition("dev", "main").seats;

export const LEADER = SEATS.find((seat) => seat.isLeader)!;

// Seats that start on Claude, so a switch to Codex or OpenCode really changes the CLI.
export const WORKER = SEATS.find((seat) => !seat.isLeader && seat.canWrite === true && seat.cli === "claude")!;

export const READER = SEATS.find((seat) => !seat.isLeader && seat.canWrite !== true && seat.cli === "claude")!;

export const TAB = "anycli-dev";

export const CODEX_LEADER = { cli: "codex", model: "gpt-6-sol", effort: "high" };

export const OPENCODE_LEADER = { cli: "opencode", model: "fakeprov/fake-model", effort: "max" };

export const CLAUDE_LEADER = { cli: "claude", model: LEADER.model, effort: LEADER.effort };

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

// Waits for a child THIS test spawned to exit; one that never does is killed through its own object and fails the test with a message.
export async function exitWithin(child: ReturnType<typeof spawn>, ms = 30_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Infrastructure timeout stays a plain Error, never a caught mutation.
    await Promise.race([once(child, "exit"), new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error(`the child process did not exit within ${ms}ms`)); }, ms); })]);
  } finally { clearTimeout(timer); }
}

// A leftover fake CLI is killed only when the process behind its logged pid is provably this run's fake: its command line names one of these scripts
// AND holds this run's own temp folder (the fake is started with the tab folder, which sits inside it; another run's fake has the same script
// name), and its creation time is the one the fake logged (a pid the fake gave up can be handed to any program, so the pid alone proves nothing).
const FAKE_CLI_SCRIPTS = ["fake-codex-app-server.mjs", "fake-opencode-server.mjs"];

const FAKE_CLI_CREATION_TOLERANCE_MS = 1500;

// The app's worst case to stop a fake CLI, plus 5 s: the budget to start queries; a final full query can add LIST_TIMEOUT_MS.
export const NO_FAKE_CLI_ALIVE_MS = SWEEP_CAP_MS + 5_000;

function commandLineOf(pid: number): string {
  const result = spawnSync(leaderCommon.windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true, timeout: LIST_TIMEOUT_MS });
  return result.status === 0 ? String(result.stdout).trim() : "";
}

function isLoggedFakeCli(proc: { pid: number; created: number } | undefined, loggedStartedAt: number, runFolder: string): boolean {
  if (!proc || Math.abs(proc.created - loggedStartedAt) >= FAKE_CLI_CREATION_TOLERANCE_MS) return false;
  const line = commandLineOf(proc.pid);
  return FAKE_CLI_SCRIPTS.some((name) => line.includes(name)) && line.includes(runFolder);
}

// The pids of the processes whose command line holds this folder (a folder only one caller knows), never the lister's own.
// A query that did not complete (nonzero exit, timeout, no exit status) throws with its stderr: an empty answer from a failed query would read as "nothing is running".
export function pidsFromQuery(result: { status: number | null; stdout: unknown; stderr: unknown; error?: Error }): number[] {
  if (result.status !== 0) throw new Error(`the process query did not complete: status=${result.status} error=${result.error?.message ?? "none"} stderr=${String(result.stderr).trim()}`);
  return String(result.stdout).split(/\s+/).filter(Boolean).map(Number);
}

export function pidsHolding(folder: string): number[] {
  return pidsFromQuery(spawnSync(leaderCommon.windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${folder.replace(/'/g, "''")}') } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8", windowsHide: true, timeout: LIST_TIMEOUT_MS }));
}

// The pids of this run's fake CLIs: the command line names a fake script AND holds this run's folder. Never the server, whose command line holds the folder but no fake script.
export function fakeCliPids(folder: string, timeoutMs = LIST_TIMEOUT_MS): number[] {
  const scripts = FAKE_CLI_SCRIPTS.map((name) => name.replace(/\./g, "\\.")).join("|");
  return pidsFromQuery(spawnSync(leaderCommon.windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${folder.replace(/'/g, "''")}') -and $_.CommandLine -match '${scripts}' } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8", windowsHide: true, timeout: timeoutMs }));
}

// Node's fatal-error report (report.*.json) in the temp folder: event, trigger and the first 40 stack lines.
function readCrashReport(temp: string): string {
  try {
    const name = readdirSync(temp).find((f) => /^report\..*\.json$/.test(f));
    if (!name) return "";
    const report = JSON.parse(readFileSync(join(temp, name), "utf8"));
    const js = report.javascriptStack, native = report.nativeStack;
    const lines = [...(js ? [js.message, ...(js.stack ?? [])] : []), ...(Array.isArray(native) ? native.map((n: any) => `${n.pc} ${n.symbol}`) : [])].slice(0, 40);
    return `\nnode crash report: event=${report.header?.event} trigger=${report.header?.trigger}\n${lines.join("\n")}`;
  } catch (error) { return `\nnode crash report unreadable: ${error instanceof Error ? error.message : String(error)}`; }
}

export type Boot = { leader: { cli: string; model: string; effort: string }; killDoesNothing?: boolean; tree?: boolean; env?: Record<string, string>; installed?: string[]; unknown?: string[]; advisor?: string; workerModel?: string; workerEffort?: string };

export async function boot(options: Boot) {
  const temp = mkdtempSync(join(tmpdir(), "cc-anycli-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work");
  mkdirSync(home); mkdirSync(work); mkdirSync(join(data, "config"), { recursive: true });
  const crew = SEATS.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, ...(seat.isLeader ? options.leader : { cli: seat.cli, model: seat === WORKER && options.workerModel ? options.workerModel : seat.model, effort: seat === WORKER && options.workerEffort ? options.workerEffort : seat.effort }) }));
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "anycli", name: "AnyCli", folder: work, tabs: [{ id: TAB, name: TAB, kind: "dev", process: "main", folder: work, crew, ...(options.advisor ? { advisor: { model: options.advisor } } : {}) }] }] }));
  const responses: Record<string, unknown> = {};
  for (const cli of ["claude", ...(options.installed ?? [])]) responses[JSON.stringify([cli, "--version"])] = { code: 0, stdout: `${cli} 1.0.0`, stderr: "" };
  // Exit code 1 is neither "ran" nor "not found": installed stays null (not checked).
  for (const cli of options.unknown ?? []) responses[JSON.stringify([cli, "--version"])] = { code: 1, stdout: "", stderr: "" };
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses }));
  const cliLog = join(temp, "fake-cli.log");
  const key = newAppKey();
  // --report-on-fatalerror: a native crash (0xC0000409) leaves its report in the test's temp folder, where withServer reads it before the cleanup.
  const child = spawn(process.execPath, ["--report-on-fatalerror", `--report-directory=${temp}`, "server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: "0", CC_APP_KEY: key, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1", CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER_CLI: "1", FAKE_LEADER_LOG: cliLog, ...(options.tree ? { CC_TEST_TREE_FILE: join(temp, "tree.json") } : {}), ...options.env } });
  attachCrashCatcher(child.pid, "any-cli");
  // Test seam for the boot-failure cleanup: a kill that does not work, so the cleanup's own failure report can be seen.
  if (options.killDoesNothing) child.kill = () => false;
  const ipc: any[] = [], messages: any[] = []; let log = "";
  // The server's own exit, recorded as it happens: a dead server must fail the test and say how it died.
  let exit: { code: number | null; signal: string | null; at: string } | null = null;
  child.on("exit", (code, signal) => { exit = { code, signal, at: new Date().toISOString() }; });
  // A send on a channel that is closing (a server killed under the crash catcher takes a moment to be gone) reports EPIPE as an event; the exit says how it ended.
  child.on("error", () => { /* the exit event and the log tail carry the facts */ });
  // stdout/stderr can still deliver data after "exit"; "close" means every stdio stream is drained.
  const closed = new Promise<void>((ok) => child.once("close", () => ok()));
  child.on("message", (m) => ipc.push(m)); child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  const wait = async <T>(fn: () => T, label: string, ms = KILL_TIMEOUT_MS + 5_000): Promise<NonNullable<T>> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${log.slice(-600)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-6))} types=${messages.slice(-8).map((m) => m.type)}`);
  };
  // A boot that fails has returned no handle, so withServer cannot clean up after it: stop the socket and the child this boot started, wait for
  // the child to be gone, and remove the temp folder before the failure is raised.
  let opening: WebSocket | undefined;
  const abandon = async (error: unknown): Promise<never> => {
    opening?.terminate();
    if (!exit) { try { child.kill(); } catch { /* already gone */ } await Promise.race([closed, sleep(5000)]); }
    const stillRunning = child.exitCode === null && child.signalCode === null;
    try { removeWithRetry(temp); } finally {
      // The bounded wait above can end with the server still alive (the kill failed): that is a cleanup failure of its own, said out loud.
      if (stillRunning) throw new Error(`cleanup failed: server ${child.pid} is still running after the kill and a 5000 ms wait; the boot failed first with: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    throw error;
  };
  const state = () => messages.filter((m) => m.type === "state").at(-1);
  // The server binds an OS-assigned port and prints it. A start that fails has already been stopped by waitForServerStart (and said so if it could not be), so only the temp folder is left.
  const port = await waitForServerStart(child, () => log).catch((error) => {
    try { removeWithRetry(temp); } catch { /* the start failure is the one to report */ }
    throw error;
  });
  opening = new WebSocket(keyedWsUrl(`ws://127.0.0.1:${port}`, key), { origin: `http://127.0.0.1:${port}` });
  const socket: WebSocket = opening;
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(socket, "open").then(() => { socket.send(JSON.stringify({ type: "hello" })); return wait(state, "initial state"); }).catch(abandon);
  const tab = () => state().projects[0].tabs[0];
  const seat = (slot: string) => tab().crew.find((s: any) => s.slot === slot);
  let number = 0, asked = false;
  const h = {
    port, temp, work, child, messages, exit: () => exit, log: () => log, state, tab, seat, wait, ipc,
    cliEntries: () => (existsSync(cliLog) ? readFileSync(cliLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []) as any[],
    savedCrew: () => JSON.parse(readFileSync(join(data, "config", "workspaces.json"), "utf8")).projects[0].tabs[0].crew as any[],
    send: (payload: any) => socket.send(JSON.stringify(payload)),
    // The made-up processes the server's process list also shows, and which of them cannot be killed (Boot.tree).
    // Written beside the file and renamed over it: the server reads it at every list and kill and must never see half of it.
    setTree: (extra: Array<{ pid: number; ppid: number; created: number }>, failKill: number[]) => { writeFileSync(join(temp, "tree.json.tmp"), JSON.stringify({ extra, failKill })); renameSync(join(temp, "tree.json.tmp"), join(temp, "tree.json")); },
    // Every pretended kill of a made-up process the server was asked for, in order.
    treeKills: () => (existsSync(join(temp, "tree.json.kills")) ? readFileSync(join(temp, "tree.json.kills"), "utf8").split("\n").filter((line) => line.endsWith("}")).map((line) => JSON.parse(line)) : []) as Array<{ pid: number; ok: boolean; at: number }>,
    // A message is answered by an error frame, or by a state that satisfies `done`.
    update: async (payload: any, done?: () => any) => {
      const start = messages.length; socket.send(JSON.stringify({ type: "updateSeat", tabId: TAB, ...payload }));
      return await wait(() => messages.slice(start).find((m) => m.type === "error") ?? (done?.() ? { type: "ok" } : null), `updateSeat ${JSON.stringify(payload)}`);
    },
    action: async (payload: any) => {
      const requestId = `anycli_${++number}`; socket.send(JSON.stringify({ ...payload, requestId }));
      return await wait(() => messages.find((m) => m.requestId === requestId && (m.type === "error" || m.type === "actionResult" || m.type === "permissionModeChanged")), payload.type);
    },
    chat: (text: string) => { const start = messages.length; socket.send(JSON.stringify({ type: "chat", tabId: TAB, text })); return start; },
    turnEnded: (start: number) => messages.slice(start).filter((m) => (m.type === "chatDone" || m.type === "chatError") && m.tabId === TAB),
    idle: () => wait(() => !tab().derived.leaderTurnActive, "leader idle"),
    deltas: (start: number) => messages.slice(start).filter((m) => m.type === "chatDelta" && m.tabId === TAB).map((m) => m.text).join(""),
    pending: () => tab().pendingApprovals as any[],
    pidAlive: (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    // Waits until no fake CLI of this run is alive, found by command line: under load the start deadline can kill the fake before it logged "started".
    noFakeCliAlive: async () => {
      const end = Date.now() + NO_FAKE_CLI_ALIVE_MS;
      let lastError: unknown;
      let pids: number[] | undefined;
      while (Date.now() < end) {
        try {
          pids = fakeCliPids(temp, LIST_TIMEOUT_MS);
          lastError = undefined;
          if (pids.length === 0) return true;
        } catch (error) { lastError = error; }
        await sleep(Math.min(100, Math.max(0, end - Date.now())));
      }
      if (lastError) throw lastError;
      assert.fail(`this run's fake CLI killed: still alive=${JSON.stringify(pids)}`);
    },
    refresh: async () => { const start = messages.length; socket.send(JSON.stringify({ type: "refreshSettings" })); await wait(() => messages.slice(start).some((m) => m.type === "settingsRefreshed"), "tools checked"); },
    shutdownAsked: () => asked,
    close: async () => {
      try {
        socket.close();
        // A server that is already gone has nobody to send "shutdown" to.
        if (!exit && child.connected) {
          const exited = new Promise<void>((ok) => child.once("exit", () => ok()));
          asked = h.pidAlive(child.pid!); // a server already dead before we asked died on its own
          try { child.send("shutdown"); } catch { /* channel closed under us: the exit below says why */ }
          await Promise.race([exited, sleep(8000)]);
        }
        if (!exit) { asked ||= h.pidAlive(child.pid!); child.kill(); }
        // A fake CLI the server did not stop is killed only if that pid is still the process that logged it (same creation time and
        // a command line that names the fake), never by a bare number that may name one of the user's programs after a pid reuse.
        const leftovers = h.cliEntries().filter((entry) => entry.started && typeof entry.startedAt === "number" && h.pidAlive(entry.pid));
        if (leftovers.length) {
          const list = await leaderCommon.listProcesses();
          for (const entry of leftovers) {
            const proc = list?.find((item: any) => item.pid === entry.pid);
            if (isLoggedFakeCli(proc, entry.startedAt, temp)) { try { process.kill(entry.pid); } catch { /* gone */ } }
          }
        }
      } finally {
        h.crashReport = readCrashReport(temp);
        removeWithRetry(temp);
      }
    },
    // Bounded wait for the child's stdio to drain after it exited on its own.
    drained: () => Promise.race([closed, sleep(2000)]),
    crashReport: "",
  };
  return h;
}

export type Harness = Awaited<ReturnType<typeof boot>>;

export async function withServer(options: Boot, body: (h: Harness) => Promise<void>) {
  const h = await boot(options);
  let failure: unknown, failed = false;
  try { await body(h); } catch (error) { failure = error; failed = true; }
  const early = h.exit();
  // A kill the body sent that the exit has not shown yet (a debugger attached by the crash catcher delays it) is still a death nobody asked for.
  const killedByBody = h.child.killed;
  await h.close();
  // Our own shutdown (or close()'s kill) is not a death: only an exit nobody asked for is, even one that lands during cleanup.
  if (killedByBody && !h.exit()) await h.drained();
  const died = early ?? (killedByBody || !h.shutdownAsked() ? h.exit() : null);
  if (died) await h.drained();
  const crash = died ? await crashFactsAfterDeath(h.child.pid) : "";
  const tail = h.log().slice(-3000);
  if (died) {
    const facts = `server exited before the test finished: code=${died.code} signal=${died.signal} at=${died.at}\nserver log (last 3000 chars):\n${tail}${h.crashReport}${crash}`;
    throw new Error(failed ? `${failure instanceof Error ? failure.message : String(failure)}\n${facts}` : facts, { cause: failure });
  }
  if (failed) throw failure;
}

export const script = (...steps: object[]) => JSON.stringify(steps);

// ---- the bridge route ----

export function bridgePost(port: number, path: string, headers: Record<string, string>, body: string, method = "POST"): Promise<{ status: number; body: string }> {
  return new Promise((resolveReply, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } }, (res) => {
      let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolveReply({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject); req.end(method === "GET" ? undefined : body);
  });
}

// ---- round 1 fixes ----

export const startedPids = (h: Harness) => h.cliEntries().filter((e) => e.started).map((e) => e.pid as number);

export const errorsSince = (h: Harness, start: number) => h.messages.slice(start).filter((m) => m.type === "chatError" && m.tabId === TAB);
