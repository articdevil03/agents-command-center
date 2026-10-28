import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { appendFileSync, mkdtempSync, mkdirSync, renameSync, writeFileSync, readFileSync, readdirSync, rmSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { importWithTempDataRoot, newAppKey, keyedWsUrl, setEnv } from "./temp-root.ts";
import { attachCrashCatcher, crashFactsAfterDeath } from "./crash-catcher.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

// The server modules that read their data root at import (config.ts and everything importing it) are loaded on a fresh temp folder,
// never on the repo's own (live) config/. The servers this file starts get their own data folders.
const { dataDir: moduleDataDir, modules: { config, leaderApi, codexApi, opencodeApi, leaderCommon } } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"),
  leaderApi: await import("../server/leader.ts"),
  codexApi: await import("../server/leader-codex.ts"),
  opencodeApi: await import("../server/leader-opencode.ts"),
  leaderCommon: await import("../server/leader-common.ts"),
}));
const { readWorkspaces } = config;
const { buildLeaderOptions } = leaderApi;
const { codexPolicy, createCodexLeader } = codexApi;
const { opencodeRules, opencodeApprovalRequest, createOpencodeLeader } = opencodeApi;

// Every test here starts the real server with fake Codex / OpenCode CLIs behind the leader's spawn.
// Guards are driven through WebSocket messages and the bridge HTTP route, never through helpers.

const SEATS = getProcessDefinition("dev", "main").seats;
const LEADER = SEATS.find((seat) => seat.isLeader)!;
// Seats that start on Claude, so a switch to Codex or OpenCode really changes the CLI.
const WORKER = SEATS.find((seat) => !seat.isLeader && seat.canWrite === true && seat.cli === "claude")!;
const READER = SEATS.find((seat) => !seat.isLeader && seat.canWrite !== true && seat.cli === "claude")!;
const TAB = "anycli-dev";
const CODEX_LEADER = { cli: "codex", model: "gpt-6-sol", effort: "high" };
const OPENCODE_LEADER = { cli: "opencode", model: "fakeprov/fake-model", effort: "max" };
const CLAUDE_LEADER = { cli: "claude", model: LEADER.model, effort: LEADER.effort };
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// Waits for a child THIS test spawned to exit; one that never does is killed through its own object and fails the test with a message.
async function exitWithin(child: ReturnType<typeof spawn>, ms = 30_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([once(child, "exit"), new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error(`the child process did not exit within ${ms}ms`)); }, ms); })]);
  } finally { clearTimeout(timer); }
}

// A leftover fake CLI is killed only when the process behind its logged pid is provably this run's fake: its command line names one of these scripts
// AND holds this run's own temp folder (the fake is started with the tab folder, which sits inside it; another run's fake has the same script
// name), and its creation time is the one the fake logged (a pid the fake gave up can be handed to any program, so the pid alone proves nothing).
const FAKE_CLI_SCRIPTS = ["fake-codex-app-server.mjs", "fake-opencode-server.mjs"];
const FAKE_CLI_CREATION_TOLERANCE_MS = 1500;
function commandLineOf(pid: number): string {
  const result = spawnSync(leaderCommon.windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return result.status === 0 ? String(result.stdout).trim() : "";
}
function isLoggedFakeCli(proc: { pid: number; created: number } | undefined, loggedStartedAt: number, runFolder: string): boolean {
  if (!proc || Math.abs(proc.created - loggedStartedAt) >= FAKE_CLI_CREATION_TOLERANCE_MS) return false;
  const line = commandLineOf(proc.pid);
  return FAKE_CLI_SCRIPTS.some((name) => line.includes(name)) && line.includes(runFolder);
}
// The pids of the processes whose command line holds this folder (a folder only one caller knows), never the lister's own.
// A query that did not complete (nonzero exit, timeout, no exit status) throws with its stderr: an empty answer from a failed query would read as "nothing is running".
function pidsFromQuery(result: { status: number | null; stdout: unknown; stderr: unknown; error?: Error }): number[] {
  if (result.status !== 0) throw new Error(`the process query did not complete: status=${result.status} error=${result.error?.message ?? "none"} stderr=${String(result.stderr).trim()}`);
  return String(result.stdout).split(/\s+/).filter(Boolean).map(Number);
}
function pidsHolding(folder: string): number[] {
  return pidsFromQuery(spawnSync(leaderCommon.windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${folder.replace(/'/g, "''")}') } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8", windowsHide: true, timeout: 20_000 }));
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

type Boot = { leader: { cli: string; model: string; effort: string }; killDoesNothing?: boolean; tree?: boolean; env?: Record<string, string>; installed?: string[]; unknown?: string[]; advisor?: string; workerModel?: string; workerEffort?: string };
async function boot(options: Boot) {
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
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as any).port; await new Promise<void>((ok) => probe.close(() => ok()));
  const key = newAppKey();
  // --report-on-fatalerror: a native crash (0xC0000409) leaves its report in the test's temp folder, where withServer reads it before the cleanup.
  const child = spawn(process.execPath, ["--report-on-fatalerror", `--report-directory=${temp}`, "server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: String(port), CC_APP_KEY: key, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1", CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER_CLI: "1", FAKE_LEADER_LOG: cliLog, ...(options.tree ? { CC_TEST_TREE_FILE: join(temp, "tree.json") } : {}), ...options.env } });
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
  const wait = async <T>(fn: () => T, label: string, ms = 8000): Promise<NonNullable<T>> => {
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
  await wait(() => log.includes("127.0.0.1"), "server start").catch(abandon);
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
type Harness = Awaited<ReturnType<typeof boot>>;
async function withServer(options: Boot, body: (h: Harness) => Promise<void>) {
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
const script = (...steps: object[]) => JSON.stringify(steps);

// ---- the harness itself ----

test("harness: the server modules this file imports keep their data in a temp folder, not the repo's config/", () => {
  assert.equal(path.dirname(path.dirname(config.workspacesPath)).toLowerCase(), moduleDataDir.toLowerCase());
  assert.equal(path.dirname(path.dirname(config.clientPrefsPath)).toLowerCase(), moduleDataDir.toLowerCase());
});

test("harness: a server that dies mid-test fails the test with its exit facts and log tail, keeps the body error, and still removes the temp folder", { timeout: 60000 }, async () => {
  let temp = "";
  await assert.rejects(
    withServer({ leader: CLAUDE_LEADER }, async (h) => {
      temp = h.temp;
      h.child.kill();
      await h.wait(() => h.exit(), "server death seen");
      assert.fail("body error survives");
    }),
    (error: Error) => {
      assert.match(error.message, /body error survives/, "the body's error is kept");
      assert.match(error.message, /server exited before the test finished: code=\S+ signal=\S+/);
      assert.match(error.message, /server log \(last 3000 chars\):\n[\s\S]*127\.0\.0\.1/, "the log tail is attached");
      return true;
    },
  );
  assert.ok(temp && !existsSync(temp), "temp folder removed although the server was already gone");
  // A body that passes against a server that died is still a failure.
  await assert.rejects(
    withServer({ leader: CLAUDE_LEADER }, async (h) => { h.child.kill(); await h.wait(() => h.exit(), "server death seen"); }),
    /server exited before the test finished/,
  );
});

test("harness: output the server writes just before it dies, and its node crash report, appear in the failure text", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-anycli-preload-"));
  const preload = join(dir, "die.cjs");
  const pidFile = join(dir, "grandchild.pid");
  // The grandchild shares the server's stderr pipe and speaks only after it has SEEN the server gone (polls its pid), so "close" (pipe released) comes last; it gives up after 10 s. Detached, or Windows ends it together with the server. Its pid goes to a file so the test can kill it.
  const lateScript = "const p = +process.argv[1], t = Date.now(); const i = setInterval(() => { let alive = true; try { process.kill(p, 0); } catch { alive = false; } if (!alive) { process.stderr.write('LATE-WORDS-AFTER-EXIT'); clearInterval(i); } else if (Date.now() - t > 10000) clearInterval(i); }, 20);";
  writeFileSync(preload, `process.on("message", (m) => { if (m !== "die-now") return; process.stderr.write("LAST-WORDS-BEFORE-DEATH\\n"); process.report.writeReport("report.fake.json"); const { NODE_OPTIONS, ...env } = process.env; const gc = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(lateScript)}, String(process.pid)], { stdio: ["ignore", "ignore", 2], windowsHide: true, detached: true, env }); require("node:fs").writeFileSync(${JSON.stringify(pidFile.replaceAll("\\", "/"))}, String(gc.pid)); gc.unref(); process.exit(9); });`);
  try {
    await assert.rejects(
      withServer({ leader: CLAUDE_LEADER, env: { NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll("\\", "/"))}` } }, async (h) => {
        h.child.send("die-now");
        await h.wait(() => h.exit(), "server death seen");
      }),
      (error: Error) => {
        assert.match(error.message, /server exited before the test finished: code=9/);
        assert.match(error.message, /LAST-WORDS-BEFORE-DEATH/, "stderr written just before death is in the failure text");
        assert.match(error.message, /LATE-WORDS-AFTER-EXIT/, "stderr that arrives after the server's exit but before its pipes close is in the failure text");
        assert.match(error.message, /node crash report: event=JavaScript API trigger=API/, "the crash report header is attached");
        return true;
      },
    );
  } finally {
    // The grandchild gives up by itself after 10 s: it is waited for (bounded), never killed by a bare pid that may have been reused.
    let grandchild = NaN;
    try { grandchild = Number(readFileSync(pidFile, "utf8")); } catch { /* no pid file */ }
    for (const end = Date.now() + 12_000; Number.isFinite(grandchild) && Date.now() < end;) {
      try { process.kill(grandchild, 0); } catch { break; }
      await sleep(50);
    }
    rmSync(preload, { force: true }); rmSync(pidFile, { force: true }); rmdirSync(dir);
  }
});

test("harness: a server killed by the body that is not awaited still fails the test", { timeout: 60000 }, async () => {
  await assert.rejects(
    withServer({ leader: CLAUDE_LEADER }, async (h) => { h.child.kill(); }),
    /server exited before the test finished/,
  );
});

test("harness: a process query that failed or timed out throws with its stderr instead of reading as an empty list", () => {
  assert.throws(() => pidsFromQuery({ status: 1, stdout: "", stderr: "CIM-QUERY-BROKE" }), /did not complete.*CIM-QUERY-BROKE/);
  assert.throws(() => pidsFromQuery({ status: null, stdout: "", stderr: "", error: new Error("spawnSync ETIMEDOUT") }), /ETIMEDOUT/);
  assert.deepEqual(pidsFromQuery({ status: 0, stdout: "12\r\n34\r\n", stderr: "" }), [12, 34], "control: a completed query is parsed");
});

test("harness: a boot that fails after the server started stops that server and removes its temp folder", { timeout: 60000 }, async () => {
  // The boot gets its own TEMP/TMP, so the only folder in it and the only processes holding it are this boot's.
  const privateTmp = mkdtempSync(join(tmpdir(), "cc-anycli-private-"));
  const restore = setEnv({ TEMP: privateTmp, TMP: privateTmp });
  let running: number[] = [], unexpected: Harness | undefined;
  try {
    try {
      // A key the server was not given: the socket is refused, which is a connection error inside boot, before any handle exists.
      await assert.rejects(boot({ leader: CLAUDE_LEADER, env: { CC_APP_KEY: "f".repeat(64) } }).then((h) => { unexpected = h; return h; }), (error: unknown) => error instanceof Error);
    } finally { restore(); }
    running = pidsHolding(privateTmp);
    assert.deepEqual(readdirSync(privateTmp), [], "the failed boot left no temp folder behind");
    assert.deepEqual(running, [], "and its server is no longer running");
  } finally {
    // A boot that unexpectedly succeeded is shut down through its own handle; anything found by a folder only this test knows is stopped here, so a failing run leaves nothing behind.
    await unexpected?.close().catch(() => {});
    for (const pid of running) { try { process.kill(pid); } catch { /* gone */ } }
    removeWithRetry(privateTmp);
  }
});

test("harness: a boot failure whose server cannot be stopped says so, as a cleanup failure", { timeout: 60000 }, async () => {
  const privateTmp = mkdtempSync(join(tmpdir(), "cc-anycli-private-"));
  const restore = setEnv({ TEMP: privateTmp, TMP: privateTmp });
  let running: number[] = [];
  try {
    try {
      await assert.rejects(boot({ leader: CLAUDE_LEADER, killDoesNothing: true, env: { CC_APP_KEY: "f".repeat(64) } }), /cleanup failed: server \d+ is still running/);
    } finally { restore(); running = pidsHolding(privateTmp); }
    assert.equal(running.length > 0, true, "control: the server really was still running");
  } finally {
    for (const pid of running) { try { process.kill(pid); } catch { /* gone */ } }
    removeWithRetry(privateTmp, 20, 250);
  }
});

test("harness: teardown kills a leftover fake CLI only while its pid still has the creation time it logged and its command line names the fake", { timeout: 60000 }, async () => {
  // All four are children of this test, so even a bug in the teardown only ever touches them. Three carry the fake's script name in their command line:
  // `same` (this run's folder) is logged with its real creation time, `reused` (this run's folder) with a wrong one (a reused pid), and `foreign`
  // (ANOTHER run's folder) with its real time. The fourth has the right time but is not a fake at all.
  const idle = (...extra: string[]) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...extra], { windowsHide: true, stdio: "ignore" });
  const bystander = idle(), foreign = idle("fake-codex-app-server.mjs", join(tmpdir(), "cc-anycli-another-run", "work"));
  let same: ReturnType<typeof idle> | undefined, reused: ReturnType<typeof idle> | undefined;
  const exited = (proc: ReturnType<typeof idle>) => proc.exitCode !== null || proc.signalCode !== null;
  try {
    await withServer({ leader: CLAUDE_LEADER }, async (h) => {
      same = idle("fake-codex-app-server.mjs", join(h.temp, "work")); reused = idle("fake-codex-app-server.mjs", join(h.temp, "work"));
      const all = [same, reused, bystander, foreign];
      let created: Map<number, number>;
      for (let attempt = 0; ; attempt++) {
        created = new Map((await leaderCommon.listProcesses() ?? []).map((item: any) => [item.pid, item.created]));
        if (all.every((proc) => created.has(proc.pid!))) break;
        assert.ok(attempt < 100, "the process list shows all idle children");
        await sleep(100);
      }
      const line = (pid: number, startedAt: number) => JSON.stringify({ cli: "codex", started: true, pid, startedAt }) + "\n";
      appendFileSync(join(h.temp, "fake-cli.log"), line(same.pid!, created.get(same.pid!)!) + line(reused.pid!, created.get(reused.pid!)! - 3_600_000) + line(bystander.pid!, created.get(bystander.pid!)!) + line(foreign.pid!, created.get(foreign.pid!)!));
      assert.equal(h.cliEntries().filter((entry) => entry.started).length, 4, "control: all four are in the CLI log");
    });
    for (const end = Date.now() + 8000; !exited(same!) && Date.now() < end;) await sleep(50);
    assert.equal(exited(same!), true, "the process whose creation time matches its log line is killed by the teardown");
    assert.equal(exited(reused!), false, "a pid whose creation time differs from the logged one (a reused pid) is left alone");
    assert.equal(exited(bystander), false, "a process with the logged creation time whose command line is not a fake CLI is left alone");
    assert.equal(exited(foreign), false, "another run's fake (same script name, right creation time, a different folder) is left alone");
  } finally { same?.kill(); reused?.kill(); bystander.kill(); foreign.kill(); }
});

// ---- updateSeat.cli ----

test("updateSeat cli: a CLI that was not checked yet is refused", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, unknown: ["codex"] }, async (h) => {
    assert.equal(h.state().settings.tools.codex.installed, null);
    const reply = await h.update({ slot: WORKER.slotId, cli: "codex", model: "gpt-6-sol" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /has not been checked yet/);
    assert.equal(h.seat(WORKER.slotId).cli, WORKER.cli);
  });
});

test("updateSeat cli: refused unless installed, then needs a model valid for the NEW cli, then persists like model", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["codex"] }, async (h) => {
    await h.refresh();
    assert.equal(h.state().settings.tools.codex.installed, true, "the client receives installed per CLI");
    assert.equal(h.state().settings.tools.opencode.installed, false);
    let reply = await h.update({ slot: WORKER.slotId, cli: "opencode", model: "opencode/claude-sonnet-5" });
    assert.match(reply.message, /not installed/);
    reply = await h.update({ slot: WORKER.slotId, cli: "gemini", model: "gemini-2" });
    assert.match(reply.message, /unknown CLI/);
    reply = await h.update({ slot: WORKER.slotId, cli: "codex", model: WORKER.model });
    assert.match(reply.message, /valid codex model is required/);
    reply = await h.update({ slot: WORKER.slotId, cli: "codex" });
    assert.match(reply.message, /valid codex model is required/);
    assert.equal(h.seat(WORKER.slotId).cli, WORKER.cli, "every refusal left the seat alone");
    await h.update({ slot: WORKER.slotId, effort: "high" }, () => h.seat(WORKER.slotId).effort === "high");
    reply = await h.update({ slot: WORKER.slotId, cli: "codex", model: "gpt-6-sol" }, () => h.seat(WORKER.slotId).cli === "codex");
    assert.equal(reply.type, "ok");
    assert.deepEqual([h.seat(WORKER.slotId).model, h.seat(WORKER.slotId).effort], ["gpt-6-sol", "high"], "effort kept: it exists on Codex");
    const saved = h.savedCrew().find((s) => s.slot === WORKER.slotId);
    assert.deepEqual([saved.cli, saved.model, saved.effort], ["codex", "gpt-6-sol", "high"]);
  });
});

test("updateSeat cli: an effort that does not exist on the new CLI falls back to that CLI's default", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["codex", "claude"] }, async (h) => {
    await h.refresh();
    await h.update({ slot: WORKER.slotId, effort: "xhigh" }, () => h.seat(WORKER.slotId).effort === "xhigh");
    await h.update({ slot: WORKER.slotId, cli: "codex", model: "gpt-6-sol" }, () => h.seat(WORKER.slotId).cli === "codex");
    assert.equal(h.seat(WORKER.slotId).effort, "medium", "xhigh is not a Codex effort: the CLI default is used");
    assert.equal(h.savedCrew().find((s) => s.slot === WORKER.slotId).effort, "medium");
  });
});

test("updateSeat cli on the leader: refused while a turn or an approval is open, then ends the session like Stop", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["codex"], env: { CC_TEST_FAKE_LEADER: "1" } }, async (h) => {
    await h.refresh();
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(JSON.stringify([{ tool: "Write", input: { file_path: "C:/w/f.ts", content: "x" } }]));
    await h.wait(() => h.pending().length === 1, "approval waiting");
    const reply = await h.update({ slot: LEADER.slotId, cli: "codex", model: "gpt-6-sol" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /Finish or stop .*'s current turn first/);
    assert.equal(h.seat(LEADER.slotId).cli, "claude");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done"); await h.idle();
    assert.equal(h.tab().leaderStatus, "ready");
    const chatBefore = h.messages.filter((m) => m.type === "chatMessage").length;
    await h.update({ slot: LEADER.slotId, cli: "codex", model: "gpt-6-sol" }, () => h.seat(LEADER.slotId).cli === "codex");
    assert.equal(h.tab().leaderStatus, "not-started", "the Claude session ended");
    assert.equal(h.messages.filter((m) => m.type === "chatMessage").length, chatBefore, "the chat log is kept");
    // The next message starts the leader on Codex.
    const next = h.chat("hello after the switch");
    await h.wait(() => h.turnEnded(next).length === 1, "codex turn"); assert.equal(h.turnEnded(next)[0].type, "chatDone");
    assert.match(h.deltas(next), /codex says hi/);
    // The new leader reads the saved handover first, like after a mode-change restart.
    assert.match(h.cliEntries().find((e) => e.method === "turn/start").params.input[0].text, /^Before replying, first read the existing handover at .*RESUME\.md/);
  });
});

test("updateSeat cli on the leader: refused while only a turn is open", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, installed: ["opencode"] }, async (h) => {
    await h.refresh();
    const start = h.chat(script({ sleep: 1500 }, { say: "slow" }));
    await h.wait(() => h.tab().derived.leaderTurnActive, "turn running");
    assert.equal(h.pending().length, 0, "no approval is open");
    const reply = await h.update({ slot: LEADER.slotId, cli: "opencode", model: "opencode/glm-5.2" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /Finish or stop .*'s current turn first/);
    assert.equal(h.seat(LEADER.slotId).cli, "codex");
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
  });
});

test("updateSeat cli on the leader: refused while only an approval is open", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, installed: ["opencode"] }, async (h) => {
    await h.refresh();
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ commandNoWait: "rm -rf left-open" }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn done with the request still open");
    await h.wait(() => h.pending().length === 1, "approval waiting"); await h.idle();
    assert.equal(h.tab().derived.leaderTurnActive, false, "no turn is open");
    const reply = await h.update({ slot: LEADER.slotId, cli: "opencode", model: "opencode/glm-5.2" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /Finish or stop .*'s current turn first/);
    assert.equal(h.seat(LEADER.slotId).cli, "codex");
  });
});

test("updateSeat effort on a live Codex leader applies from the next turn", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat("first"); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    await h.update({ slot: LEADER.slotId, effort: "low" }, () => h.seat(LEADER.slotId).effort === "low");
    start = h.chat("second"); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    // Model and effort in one message take the other branch (the model applies first): effort must still follow.
    await h.update({ slot: LEADER.slotId, model: "gpt-6-astra", effort: "max" }, () => h.seat(LEADER.slotId).effort === "max");
    start = h.chat("third"); await h.wait(() => h.turnEnded(start).length === 1, "third turn");
    assert.deepEqual(h.cliEntries().filter((e) => e.method === "turn/start").map((t) => [t.params.model, t.params.effort]), [["gpt-6-sol", "high"], ["gpt-6-sol", "low"], ["gpt-6-astra", "max"]]);
  });
});

test("updateSeat model on a live Codex leader applies from the next turn", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat("first"); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    await h.update({ slot: LEADER.slotId, model: "gpt-6-astra" }, () => h.seat(LEADER.slotId).model === "gpt-6-astra");
    start = h.chat("second"); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    const turns = h.cliEntries().filter((e) => e.method === "turn/start");
    assert.deepEqual(turns.map((t) => t.params.model), ["gpt-6-sol", "gpt-6-astra"]);
    assert.equal(h.cliEntries().filter((e) => e.method === "thread/start").length, 1, "the same thread, no restart");
  });
});

// ---- Codex leader ----

test("real server: live chat messages carry a unique increasing revision and no id, across two turns in one tab", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const first = h.chat(script({ say: "First answer." }));
    await h.wait(() => h.turnEnded(first).length === 1, "first turn done");
    const second = h.chat(script({ say: "Second answer." }));
    await h.wait(() => h.turnEnded(second).length === 1, "second turn done");
    const live = h.messages.filter((m) => m.type === "chatMessage");
    assert.deepEqual(live.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.ok(live.every((m) => !("id" in m)), "the server sends no message id, so the page must not key on one");
    assert.ok(live.every((m, i) => Number.isSafeInteger(m.revision) && (i === 0 || m.revision > live[i - 1].revision)), `revisions ${live.map((m) => m.revision)} increase`);
    assert.deepEqual(live.filter((m) => m.role === "assistant").map((m) => m.text), ["First answer.", "Second answer."]);
  });
});

test("Codex leader: deltas reach chatDelta, reasoning does not, the turn ends once, usage fills the meter", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const start = h.chat(script({ reasoning: "SECRET THOUGHT" }, { say: "Hello from Codex." }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.deltas(start), "Hello from Codex.", "only the answer text is forwarded");
    const assistant = h.messages.slice(start).find((m) => m.type === "chatMessage" && m.role === "assistant");
    assert.equal(assistant.text, "Hello from Codex.");
    const usage = h.tab().leaderUsage;
    assert.deepEqual([usage.modelId, usage.contextTokens, usage.contextWindow, usage.costUsd], ["gpt-6-sol", 1000, 258000, null]);
    const entries = h.cliEntries();
    const thread = entries.find((e) => e.method === "thread/start").params;
    assert.deepEqual(thread.dynamicTools.map((t: any) => t.name).sort(), ["get_crew_status", "launch_seat", "list_requests", "send_request"]);
    assert.equal(thread.dynamicTools.find((t: any) => t.name === "launch_seat").inputSchema.properties.slot.type, "string");
    assert.equal(thread.cwd, h.work);
    const turn = entries.find((e) => e.method === "turn/start").params;
    assert.deepEqual([turn.model, turn.effort, turn.approvalPolicy], ["gpt-6-sol", "high", "on-request"]);
    assert.equal(turn.sandboxPolicy.type, "workspaceWrite");
  });
});

test("Codex leader: permission modes map to approval policy and sandbox on the next turn", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const policies: any[] = [];
    for (const mode of ["ask", "plan", "bypass", "accept"]) {
      await h.action({ type: "setPermissionMode", tabId: TAB, mode, confirm: true });
      const start = h.chat(mode); await h.wait(() => h.turnEnded(start).length === 1, `${mode} turn`); await h.idle();
      const turn = h.cliEntries().filter((e) => e.method === "turn/start").at(-1).params;
      policies.push([turn.approvalPolicy, turn.sandboxPolicy.type]);
    }
    assert.deepEqual(policies, [["untrusted", "workspaceWrite"], ["on-request", "readOnly"], ["never", "dangerFullAccess"], ["on-request", "workspaceWrite"]]);
    assert.deepEqual(codexPolicy("ask", "C:/x").approvalPolicy, "untrusted");
  });
});

test("Codex leader: crew tools go through the same gate, and a tool failure is a failed result", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ tool: "get_crew_status" }));
    await h.wait(() => h.turnEnded(start).length === 1, "status turn"); await h.idle();
    const crew = JSON.parse(h.deltas(start).replace(/^\[tool ok: /, "").replace(/\]$/, ""));
    assert.equal(crew.tab, TAB); assert.equal(crew.crew.length, SEATS.length);
    // Plan mode: launch_seat on a seat that can write is refused by the existing gate.
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "plan", confirm: true });
    start = h.chat(script({ tool: "launch_seat", args: { slot: WORKER.slotId, brief: "write a file" } }));
    await h.wait(() => h.turnEnded(start).length === 1, "plan launch turn"); await h.idle();
    assert.match(h.deltas(start), /\[tool failed: launch failed: this tab is in Plan mode/);
    // Ask mode: the launch asks the browser first; denying it launches nothing.
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask", confirm: true });
    start = h.chat(script({ tool: "launch_seat", args: { slot: WORKER.slotId, brief: "write a file" } }));
    await h.wait(() => h.pending().length === 1, "launch asks");
    assert.match(h.pending()[0].tool, /^launch:/);
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.turnEnded(start).length === 1, "denied launch turn"); await h.idle();
    assert.match(h.deltas(start), /\[tool failed: launch failed: The user denied this\./);
    assert.equal(h.tab().runs.length, 0, "nothing was launched");
    // Invalid arguments fail the call instead of throwing.
    start = h.chat(script({ tool: "launch_seat", args: { slot: 5 } }));
    await h.wait(() => h.turnEnded(start).length === 1, "invalid args turn");
    assert.match(h.deltas(start), /\[tool failed: invalid arguments for launch_seat/);
  });
});

test("Codex leader: command and file approvals reach the browser; Allow and Deny reach the CLI", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    let start = h.chat(script({ command: "rm -rf build" }, { command: "echo ok" }, { fileChange: "two" }));
    await h.wait(() => h.pending().length === 1, "command approval");
    assert.equal(h.pending()[0].tool, "Bash"); assert.match(h.pending()[0].summary, /rm -rf build/);
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.pending().length === 1 && /echo ok/.test(h.pending()[0].summary), "second command approval");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.pending().length === 1 && h.pending()[0].tool === "Edit", "file approval");
    const fileSummary = h.pending()[0].summary;
    assert.ok(fileSummary.startsWith("C:/work/a.txt\nC:/work/b.txt\n\n"), "every changed path, one per line");
    assert.match(fileSummary, /SECOND-FILE-TEXT/, "the second file's change text is shown");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.deltas(start), "[command accept][command decline][file accept]");
    const decisions = h.cliEntries().filter((e) => e.response >= 1000).map((e) => e.result.decision);
    assert.deepEqual(decisions, ["accept", "decline", "accept"], "the CLI saw exactly what the browser answered");
  });
});

test("Codex leader: requests with no screen are refused and the turn goes on", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const start = h.chat(script({ unknownRequest: "item/tool/requestUserInput" }, { unknownRequest: "mcpServer/elicitation/request" }, { unknownRequest: "weird/new/request" }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    const text = h.deltas(start);
    assert.match(text, /requestUserInput -> \{"answers":\{\}\}/);
    assert.match(text, /elicitation\/request -> \{"action":"decline"/);
    assert.match(text, /weird\/new\/request -> \{"code":-32601/);
  });
});

test("Codex leader: every failure path ends the turn exactly once", { timeout: 90000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    for (const [label, steps, expected] of [
      ["error notification", [{ error: "boom from codex" }], /boom from codex/],
      ["turn failed status", [{ status: "failed" }], /leader turn failed/],
      ["turn interrupted status", [{ status: "interrupted" }], /leader turn interrupted/],
    ] as const) {
      const start = h.chat(script(...steps));
      await h.wait(() => h.turnEnded(start).length >= 1, label); await h.idle(); await sleep(100);
      const ended = h.turnEnded(start);
      assert.equal(ended.length, 1, `${label}: exactly one end`); assert.equal(ended[0].type, "chatError"); assert.match(ended[0].message, expected);
    }
    // A retrying error is not the end.
    let start = h.chat(script({ retryError: "transient" }, { say: "recovered" }));
    await h.wait(() => h.turnEnded(start).length === 1, "retry turn"); assert.equal(h.turnEnded(start)[0].type, "chatDone"); await h.idle();
    // The child dying mid-turn ends the turn once; the next message starts a fresh leader.
    start = h.chat(script({ exit: true }));
    await h.wait(() => h.turnEnded(start).length >= 1, "exit turn"); await sleep(300);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError");
    assert.equal(h.tab().derived.leaderTurnActive, false, "no turn stays Working after its leader is gone");
    await h.wait(() => h.tab().leaderStatus === "dead", "leader dead");
    start = h.chat("alive again"); await h.wait(() => h.turnEnded(start).length === 1, "fresh leader turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    // Every failed turn retires its leader (error, failed, interrupted, then the exit): five children in all.
    assert.equal(h.cliEntries().filter((e) => e.started).length, 5);
  });
});

test("Codex leader: a CLI that never answers fails the turn at the start deadline and the child is killed", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, env: { FAKE_CODEX_NEVER_ANSWER: "1", CC_TEST_LEADER_START_TIMEOUT_MS: "600" } }, async (h) => {
    const start = h.chat("anyone there");
    await h.wait(() => h.turnEnded(start).length >= 1, "start deadline");
    const ended = h.turnEnded(start);
    assert.equal(ended.length, 1); assert.equal(ended[0].type, "chatError"); assert.match(ended[0].message, /did not start within 20 seconds/);
    await h.wait(() => h.tab().leaderStatus === "dead", "leader dead");
    const pid = h.cliEntries().find((e) => e.started).pid;
    await h.wait(() => !h.pidAlive(pid), "child killed");
  });
});

test("Codex leader: Stop answers every open request, denies the approval and kills the child", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ command: "rm -rf /" }));
    await h.wait(() => h.pending().length === 1, "approval pending");
    const pid = h.cliEntries().find((e) => e.started).pid;
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.pending().length === 0, "approval removed");
    await h.wait(() => h.turnEnded(start).some((m) => m.type === "chatError"), "turn stopped");
    // The CLI got a decline for its request (not silence) and an interrupt for the turn, before the kill.
    await h.wait(() => h.cliEntries().some((e) => e.response >= 1000 && e.result?.decision === "decline"), "decline written");
    assert.ok(h.cliEntries().some((e) => e.method === "turn/interrupt"), "the turn was interrupted");
    await h.wait(() => !h.pidAlive(pid), "child killed");
    assert.equal(h.tab().derived.leaderTurnActive, false);
  });
});

// ---- OpenCode leader ----

test("OpenCode leader: answer text only (no reasoning, no echo of the user), one turn end, usage counted once", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ reasoning: "SECRET THOUGHT" }, { say: "Hello from OpenCode." }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.deltas(start), "Hello from OpenCode.");
    const usage = h.tab().leaderUsage;
    assert.deepEqual([usage.modelId, usage.contextTokens, usage.contextWindow, usage.costUsd], ["fakeprov/fake-model", 1000, 200000, 0.25], "the duplicated completed message is counted once");
    const entries = h.cliEntries();
    assert.ok(entries.filter((e) => e.path).every((e) => e.authorized === true), "every request carried the password");
    assert.ok(entries.filter((e) => e.path && e.path !== "/global/health").every((e) => e.directory === h.work), "every call carries the tab folder");
    assert.ok(entries.some((e) => e.bridgeInit === 200 && e.bridgeTools.length === 4), "the bridge served initialize and the four tools");
    const session = entries.find((e) => e.method === "POST" && e.path === "/session").body;
    assert.deepEqual(session.permission, opencodeRules("accept"));
    const prompt = entries.find((e) => e.path?.endsWith("/prompt_async")).body;
    assert.deepEqual(prompt.model, { providerID: "fakeprov", modelID: "fake-model" });
    // Keys from the providers payload and the bridge token never reach the browser.
    const token = entries.find((e) => e.path === "/mcp").body.config.headers.Authorization.slice("Bearer ".length);
    const everything = JSON.stringify(h.messages);
    assert.ok(!everything.includes("SECRET-KEY-MUST-NOT-LEAK") && !everything.includes(token));
  });
});

test("OpenCode leader: crew tools come through the bridge; mode changes patch the session", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    let start = h.chat(script({ tool: "get_crew_status" }));
    await h.wait(() => h.turnEnded(start).length === 1, "tool turn"); await h.idle();
    assert.match(h.deltas(start), /^\[tool ok: \{"tab":"anycli-dev","crew":\[/);
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "plan", confirm: true });
    const patch = h.cliEntries().find((e) => e.method === "PATCH");
    assert.deepEqual(patch.body.permission, opencodeRules("plan"));
    // Plan mode through the bridge: the same gate refuses a writing seat.
    start = h.chat(script({ tool: "launch_seat", args: { slot: WORKER.slotId, brief: "write" } }));
    await h.wait(() => h.turnEnded(start).length === 1, "plan launch"); await h.idle();
    assert.match(h.deltas(start), /\[tool failed: launch failed: this tab is in Plan mode/);
    // Last match wins: looking is allowed, a .env read asks again after that, the crew tools come last.
    const looking = ["*:*:ask", "read:*:allow", "glob:*:allow", "grep:*:allow", "list:*:allow", "read:*.env:ask", "read:*.env.*:ask"];
    const flat = (mode: Parameters<typeof opencodeRules>[0]) => opencodeRules(mode).map((r) => `${r.permission}:${r.pattern}:${r.action}`);
    assert.deepEqual(flat("ask"), [...looking, "tab-crew_*:*:allow"]);
    assert.deepEqual(flat("accept"), [...looking, "edit:*:allow", "tab-crew_*:*:allow"]);
    assert.deepEqual(flat("plan"), [...looking, "edit:*:deny", "tab-crew_*:*:allow"]);
    assert.equal(opencodeRules("bypass")[0].action, "allow");
  });
});

test("OpenCode leader: approvals map to Bash and Edit and Allow/Deny reach the CLI", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ bash: "npm test" }, { edit: true }, { bash: "rm x" }));
    await h.wait(() => h.pending().length === 1, "bash approval");
    assert.equal(h.pending()[0].tool, "Bash"); assert.equal(h.pending()[0].summary, "npm test");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.pending().length === 1 && h.pending()[0].tool === "Edit", "edit approval");
    assert.match(h.pending()[0].summary, /a\.txt/);
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.pending().length === 1 && /rm x/.test(h.pending()[0].summary), "second bash");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.deltas(start), "[permission once][permission reject][permission reject]");
    assert.deepEqual(opencodeApprovalRequest("webfetch", ["https://x"], { a: 1 }), { tool: "webfetch", input: { patterns: ["https://x"], a: 1 } });
  });
});

test("OpenCode leader: an Edit permission with two paths and a diff shows both paths and the diff on the approval card", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ editFull: true }));
    await h.wait(() => h.pending().length === 1, "edit approval");
    assert.equal(h.pending()[0].tool, "Edit");
    assert.equal(h.pending()[0].summary, "C:/work/a.txt\nC:/work/b.txt\n\n-OLD-LINE\n+NEW-LINE", "both paths and the whole diff reach the card");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.deltas(start), "[permission reject]");
  });
});

test("OpenCode leader: every failure path ends the turn exactly once", { timeout: 90000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    let start = h.chat(script({ error: "boom from opencode" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "session.error"); await h.idle(); await sleep(100);
    assert.equal(h.turnEnded(start).length, 1); assert.match(h.turnEnded(start)[0].message, /boom from opencode/);
    start = h.chat(script({ exit: true }));
    await h.wait(() => h.turnEnded(start).length >= 1, "exit turn"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError");
    assert.equal(h.tab().derived.leaderTurnActive, false); await h.wait(() => h.tab().leaderStatus === "dead", "leader dead");
    start = h.chat("alive again"); await h.wait(() => h.turnEnded(start).length === 1, "fresh leader");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
  });
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_PROMPT_FAILS: "1" } }, async (h) => {
    const start = h.chat("will be refused");
    await h.wait(() => h.turnEnded(start).length >= 1, "failed prompt"); await sleep(100);
    assert.equal(h.turnEnded(start).length, 1); assert.match(h.turnEnded(start)[0].message, /prompt_async returned 500: prompt refused by fake/);
  });
});

test("OpenCode leader: Stop rejects what is waiting, kills the child, and the bridge token dies", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ bash: "rm -rf /" }));
    await h.wait(() => h.pending().length === 1, "approval pending");
    const entries = h.cliEntries();
    const token = entries.find((e) => e.path === "/mcp").body.config.headers.Authorization.slice("Bearer ".length);
    const bridge = `/api/leader-mcp/${TAB}`;
    const call = (headers: Record<string, string>, body = { jsonrpc: "2.0", id: 1, method: "tools/list" }) => bridgePost(h.port, bridge, headers, JSON.stringify(body));
    assert.equal((await call({ authorization: `Bearer ${token}` })).status, 200, "alive before Stop");
    const pid = entries.find((e) => e.started).pid;
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.pending().length === 0, "approval removed");
    await h.wait(() => h.cliEntries().some((e) => e.path?.includes("/permission/") && e.body?.reply === "reject"), "reject written");
    await h.wait(() => h.cliEntries().some((e) => e.path?.endsWith("/abort")), "abort written");
    await h.wait(() => !h.pidAlive(pid), "child killed");
    assert.equal((await call({ authorization: `Bearer ${token}` })).status, 401, "the token is dead after Stop");
    assert.ok(h.turnEnded(start).some((m) => m.type === "chatError"));
  });
});

test("OpenCode leader: a server that never comes up fails the turn at the start deadline", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { CC_TEST_LEADER_START_TIMEOUT_MS: "800", FAKE_OPENCODE_NEVER_UP: "1" } }, async (h) => {
    const start = h.chat("hello");
    await h.wait(() => h.turnEnded(start).length >= 1, "start deadline");
    assert.equal(h.turnEnded(start).length, 1); assert.match(h.turnEnded(start)[0].message, /did not start within 20 seconds/);
    await h.wait(() => h.tab().leaderStatus === "dead", "leader dead");
    const pid = h.cliEntries().find((e) => e.started).pid;
    await h.wait(() => !h.pidAlive(pid), "child killed");
  });
});

// ---- the bridge route ----

function bridgePost(port: number, path: string, headers: Record<string, string>, body: string, method = "POST"): Promise<{ status: number; body: string }> {
  return new Promise((resolveReply, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } }, (res) => {
      let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolveReply({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject); req.end(method === "GET" ? undefined : body);
  });
}

test("bridge: bearer token, no Origin, POST only, 1 MiB cap, the MCP methods", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat("start the leader"); await h.wait(() => h.turnEnded(start).length === 1, "turn"); await h.idle();
    const token = h.cliEntries().find((e) => e.path === "/mcp").body.config.headers.Authorization.slice("Bearer ".length);
    const path = `/api/leader-mcp/${TAB}`;
    const rpc = (method: string, params: object = {}, id: number | false = 1) => JSON.stringify({ jsonrpc: "2.0", ...(id === false ? {} : { id }), method, params });
    const good = { authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-11-25" };
    // The header set measured from OpenCode's MCP client: Host 127.0.0.1:<port>, Accept json+sse, no Origin, no session id.
    assert.equal((await bridgePost(h.port, path, {}, rpc("tools/list"))).status, 401, "no token");
    assert.equal((await bridgePost(h.port, path, { authorization: `Bearer ${"0".repeat(token.length)}` }, rpc("tools/list"))).status, 401, "wrong token");
    assert.equal((await bridgePost(h.port, path, { authorization: `Bearer ${token}x` }, rpc("tools/list"))).status, 401, "longer token");
    assert.equal((await bridgePost(h.port, path, { authorization: token }, rpc("tools/list"))).status, 401, "not a Bearer header");
    assert.equal((await bridgePost(h.port, path, { ...good, Origin: `http://127.0.0.1:${h.port}` }, rpc("tools/list"))).status, 403, "even the app's own Origin is refused");
    assert.equal((await bridgePost(h.port, path, { ...good, Origin: "http://evil.example" }, rpc("tools/list"))).status, 403, "a foreign Origin is refused");
    assert.equal((await bridgePost(h.port, path, { ...good, Host: "evil.example" }, rpc("tools/list"))).status, 403, "the Host check still applies");
    assert.equal((await bridgePost(h.port, path, good, "", "GET")).status, 405);
    assert.equal((await bridgePost(h.port, `/api/leader-mcp/other-tab`, good, rpc("tools/list"))).status, 401, "another tab is not reachable");
    const init = await bridgePost(h.port, path, good, rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    assert.equal(init.status, 200); assert.equal(JSON.parse(init.body).result.serverInfo.name, "tab-crew");
    const note = await bridgePost(h.port, path, good, rpc("notifications/initialized", {}, false));
    assert.deepEqual([note.status, note.body], [202, ""]);
    const list = JSON.parse((await bridgePost(h.port, path, good, rpc("tools/list"))).body).result.tools;
    assert.deepEqual(list.map((t: any) => t.name).sort(), ["get_crew_status", "launch_seat", "list_requests", "send_request"]);
    const status = JSON.parse((await bridgePost(h.port, path, good, rpc("tools/call", { name: "get_crew_status", arguments: {} }))).body).result;
    assert.equal(JSON.parse(status.content[0].text).tab, TAB); assert.equal(status.isError, undefined);
    const bad = JSON.parse((await bridgePost(h.port, path, good, rpc("tools/call", { name: "launch_seat", arguments: { slot: 1 } }))).body).result;
    assert.equal(bad.isError, true); assert.match(bad.content[0].text, /invalid arguments/);
    const missing = JSON.parse((await bridgePost(h.port, path, good, rpc("tools/call", { name: "nope" }))).body).result;
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse((await bridgePost(h.port, path, good, rpc("resources/list"))).body).error.code, -32601);
    assert.equal((await bridgePost(h.port, path, good, "{not json")).status, 400);
    assert.equal((await bridgePost(h.port, path, good, "x".repeat(1024 * 1024 + 10))).status, 413);
    // Never in state or logs.
    assert.ok(!JSON.stringify(h.messages).includes(token));
  });
});

// ---- saved models must never stop the app from starting ----

test("saved models: an advisor alias, a seat alias and an unlisted full id start the server and stay in state", { timeout: 60000 }, async () => {
  await withServer({ leader: { ...CLAUDE_LEADER, model: "claude-opus-6-0" }, advisor: "fable", workerModel: "fable" }, async (h) => {
    assert.equal(h.tab().advisor?.model, "fable");
    assert.equal(h.seat(WORKER.slotId).model, "fable");
    assert.equal(h.seat(LEADER.slotId).model, "claude-opus-6-0");
    const saved = JSON.parse(readFileSync(join(h.temp, "data", "config", "workspaces.json"), "utf8")).projects[0].tabs[0];
    assert.equal(saved.advisor.model, "fable", "his saved value is not rewritten");
  });
});

test("saved models: a malformed Claude model or advisor is still refused at load", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-savedmodel-"));
  try {
    const path = join(dir, "workspaces.json");
    const write = (model: string, advisor?: string) => writeFileSync(path, JSON.stringify({ projects: [{ id: "p", name: "P", folder: dir, tabs: [{ id: "p-dev", name: "Dev", kind: "dev", process: "main", folder: dir, ...(advisor !== undefined ? { advisor: { model: advisor } } : {}), crew: SEATS.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat === WORKER ? model : seat.model, effort: seat.effort })) }] }] }));
    // Was: ... "not-a-claude-model" ... refused at load. It is safe in shape, so round 8 loads it (the live list judges it only when a user picks it).
    for (const bad of ["../x", "a".repeat(200), "fa ble", 'fa"ble', "fa;ble", "fa&ble", "fa|ble", "fa\u0001ble", "fa\nble", "-flag", "a/../b", ""]) {
      write(bad);
      assert.throws(() => readWorkspaces(path), /invalid slot\/model\/effort/, `seat model ${JSON.stringify(bad.slice(0, 20))}`);
      write("sonnet", bad);
      assert.throws(() => readWorkspaces(path), /invalid advisor/, `advisor ${JSON.stringify(bad.slice(0, 20))}`);
    }
    write("fable", "claude-opus-6-0"); readWorkspaces(path);
    write("not-a-claude-model", "not-a-claude-model"); readWorkspaces(path);
  } finally { removeWithRetry(dir); }
});

test("saved models: setAdvisor from the app still refuses an unknown model", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, advisor: "fable" }, async (h) => {
    const start = h.messages.length;
    h.send({ type: "setAdvisor", tabId: TAB, advisor: { model: "nope" } });
    const error = await h.wait(() => h.messages.slice(start).find((m) => m.type === "error"), "setAdvisor refused");
    assert.match(error.message, /invalid advisor/);
    assert.equal(h.tab().advisor?.model, "fable");
  });
});

const SAVED_MODEL_CASES = ["fable", "fable.5", "fable-5", "default", "claude-opus-6-0[1m]"];
for (const saved of SAVED_MODEL_CASES) {
  test(`saved models: ${saved} as the advisor and as a Claude seat model starts the server, is listed, and later saves still work`, { timeout: 60000 }, async () => {
    await withServer({ leader: CLAUDE_LEADER, advisor: saved, workerModel: saved }, async (h) => {
      assert.equal(h.tab().advisor?.model, saved);
      assert.equal(h.seat(WORKER.slotId).model, saved);
      // Discovery is skipped in this server, so the live list holds the saved value only through the boot adoption.
      assert.ok(h.state().modelOptions.claude.includes(saved), "listed in modelOptions");
      assert.ok(h.state().claudeModels.some((m: any) => m.value === saved), "listed in claudeModels");
      const answer = await h.update({ slot: READER.slotId, model: saved }, () => h.seat(READER.slotId).model === saved);
      assert.notEqual(answer.type, "error", "the live list accepts a saved value for another seat");
      const renamed = await h.update({ slot: WORKER.slotId, name: "Renamed" }, () => h.seat(WORKER.slotId).name === "Renamed");
      assert.notEqual(renamed.type, "error", "a later save of another field works");
      assert.equal(h.savedCrew().find((s) => s.slot === WORKER.slotId).model, saved, "his value is not rewritten");
      assert.equal(JSON.parse(readFileSync(join(h.temp, "data", "config", "workspaces.json"), "utf8")).projects[0].tabs[0].advisor.model, saved);
    });
  });
}

test("saved models: a saved discovered effort (ultra) starts the server, is listed, and later saves still work", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, workerEffort: "ultra" }, async (h) => {
    assert.equal(h.seat(WORKER.slotId).effort, "ultra");
    assert.ok(h.state().effortOptions.claude.includes("ultra"), "listed in effortOptions");
    const renamed = await h.update({ slot: WORKER.slotId, name: "Renamed" }, () => h.seat(WORKER.slotId).name === "Renamed");
    assert.notEqual(renamed.type, "error");
    assert.equal(h.savedCrew().find((s) => s.slot === WORKER.slotId).effort, "ultra");
  });
});

test("saved models: updateSeat and setAdvisor still refuse a model or effort that is not in the live list", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, advisor: "fable", workerModel: "fable", workerEffort: "ultra" }, async (h) => {
    for (const payload of [{ model: "nope" }, { model: "fable.7" }, { effort: "turbo" }, { effort: "ul tra" }, { model: "../x" }]) {
      const answer = await h.update({ slot: WORKER.slotId, ...payload });
      assert.equal(answer.type, "error", JSON.stringify(payload));
    }
    const start = h.messages.length;
    h.send({ type: "setAdvisor", tabId: TAB, advisor: { model: "fable.7" } });
    assert.match((await h.wait(() => h.messages.slice(start).find((m) => m.type === "error"), "setAdvisor refused")).message, /invalid advisor/);
    assert.equal(h.tab().advisor?.model, "fable");
  });
});

// A server run cannot spawn a real Claude worker, so the boot sequence index.ts runs (read the file, adopt, then build
// commands and take discovery) is driven in a child process with the real config and runner modules.
test("saved models: before discovery, and after a discovery that narrows the lists, saved models and efforts still build commands and save", { timeout: 60000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "cc-savedboot-"));
  try {
    const data = join(temp, "data"), work = join(temp, "work"), home = join(temp, "home");
    for (const dir of [join(data, "config"), work, home]) mkdirSync(dir, { recursive: true });
    const crew = SEATS.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat === WORKER ? "fable.5" : seat.model, effort: seat === WORKER ? "ultra" : seat.isLeader ? "xhigh" : seat.effort }));
    writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p", name: "P", folder: work, tabs: [{ id: "p-dev", name: "Dev", kind: "dev", process: "main", folder: work, crew, advisor: { model: "fable-5" } }] }] }));
    const script = join(temp, "boot.mjs");
    const url = (file: string) => pathToFileURL(resolve(file)).href;
    writeFileSync(script, `
      const config = await import(${JSON.stringify(url("server/config.ts"))});
      const runner = await import(${JSON.stringify(url("server/runner.ts"))});
      const out = {};
      const run = (cli, model, effort) => ({ runId: "r1", seatKey: "p-dev.coder", slotId: "coder", name: "N", cli, model, effort, folder: ${JSON.stringify(work)}, canWrite: false, startedAt: 1 });
      const tryBuild = (key, model, effort) => { try { out[key] = runner.buildCommand(run("claude", model, effort), "C:/x/brief.txt"); } catch (e) { out[key] = "THROWS " + e.message; } };
      const workspaces = config.readWorkspaces();
      tryBuild("beforeAdopt", "fable.5", "ultra");
      config.adoptSavedValues(workspaces); // the line index.ts runs right after readWorkspaces
      tryBuild("beforeDiscovery", "fable.5", "ultra");
      tryBuild("advisorModel", "fable-5", "xhigh");
      await config.refreshDiscovery(async () => ({ values: ["low", "medium", "high"], fallback: false }), async (f) => ({ values: [...f], fallback: true }), async () => ({ fallback: false, values: [{ value: "claude-opus-5-5[1m]", displayName: "Opus", supportsEffort: true }] }));
      tryBuild("afterNarrowed", "fable.5", "ultra");
      tryBuild("afterNarrowedXhigh", "claude-opus-5-5[1m]", "xhigh");
      out.efforts = config.EFFORT_OPTIONS.claude;
      out.models = config.MODEL_OPTIONS.claude;
      try { config.writeWorkspaces(workspaces); out.write = "ok"; } catch (e) { out.write = "THROWS " + e.message; }
      out.strict = config.isValidModel("claude", "nope") || config.isValidEffort("claude", "turbo") ? "LOOSE" : "strict";
      console.log("RESULT " + JSON.stringify(out));
    `);
    const child = spawn(process.execPath, [script], { cwd: resolve("."), windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data } });
    let output = ""; child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { output += d; });
    await exitWithin(child);
    const line = output.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `child output: ${output.slice(-800)}`);
    const out = JSON.parse(line.slice(7));
    assert.match(out.beforeAdopt, /^THROWS .*refusing invalid/, "control: without the adoption the command is refused, so the rest proves the adoption");
    assert.match(out.beforeDiscovery, /--model fable\.5 --effort ultra/);
    assert.match(out.advisorModel, /--model fable-5 --effort xhigh/);
    assert.match(out.afterNarrowed, /--model fable\.5 --effort ultra/);
    assert.match(out.afterNarrowedXhigh, /--model claude-opus-5-5\[1m\] --effort xhigh/, "a saved xhigh survives a discovery that narrows to low/medium/high");
    assert.ok(out.efforts.includes("xhigh") && out.efforts.includes("ultra") && out.efforts.includes("low"), `efforts ${out.efforts}`);
    assert.ok(out.models.includes("fable-5") && out.models.includes("fable.5"), "the saved advisor and seat model stay listed after a refresh that omits them");
    assert.equal(out.write, "ok", "a later workspace write still passes");
    assert.equal(out.strict, "strict");
  } finally { removeWithRetry(temp); }
});

// Runs `body` in a child process that has the real config module, a data folder holding `workspace` (or none),
// and `make(patch, advisor)` which returns that workspace with the coder seat / advisor changed.
async function configChild(workspace: object | null, body: string): Promise<any> {
  const temp = mkdtempSync(join(tmpdir(), "cc-configchild-"));
  try {
    const data = join(temp, "data"), work = join(temp, "work"), home = join(temp, "home");
    for (const dir of [join(data, "config"), work, home]) mkdirSync(dir, { recursive: true });
    if (workspace) writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify(workspace));
    const script = join(temp, "child.mjs");
    const crew = SEATS.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort }));
    writeFileSync(script, `
      import { join } from "node:path";
      const config = await import(${JSON.stringify(pathToFileURL(resolve("server/config.ts")).href)});
      const out = {};
      const tmpPath = join(${JSON.stringify(temp)}, "scratch-workspaces.json");
      const make = (patch, advisor) => ({ projects: [{ id: "p", name: "P", folder: ${JSON.stringify(work)}, tabs: [{ id: "p-dev", name: "Dev", kind: "dev", process: "main", folder: ${JSON.stringify(work)}, ...(advisor ? { advisor: { model: advisor } } : {}), crew: ${JSON.stringify(crew)}.map((s) => s.slot === ${JSON.stringify(WORKER.slotId)} ? { ...s, ...patch } : s) }] }] });
      const attempt = (fn) => { try { fn(); return "ok"; } catch (e) { return "THROWS " + e.message; } };
      ${body}
      console.log("RESULT " + JSON.stringify(out));
    `);
    const child = spawn(process.execPath, [script], { cwd: resolve("."), windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data } });
    let output = ""; child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { output += d; });
    await exitWithin(child);
    const line = output.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `child output: ${output.slice(-800)}`);
    return JSON.parse(line.slice(7));
  } finally { removeWithRetry(temp); }
}
const DISCOVERED_CLAUDE = (extra: string[]) => `[${["sonnet", ...extra].map((value) => JSON.stringify({ value, displayName: value.slice(0, 20), supportsEffort: true })).join(",")}]`;

test("saved values: a write and a user pick need a safe shape AND the list/CLI check; unsafe discovery values are never offered, and every offered value saves and loads", { timeout: 60000 }, async () => {
  const out = await configChild(null, `
    const unsafeClaude = ["has space", "a".repeat(101), "-flag", "a/../b"];
    out.picks = [["opencode", "-vendor/model"], ["opencode", "vendor/../model"], ["claude", "has space"], ["claude", "a".repeat(101)], ["codex", "gpt-6 sol"]].map(([k, m]) => config.isValidModel(k, m));
    out.writes = ["-vendor/model", "vendor/../model"].map((m) => attempt(() => config.writeWorkspaces(make({ cli: "opencode", model: m, effort: "max" }), tmpPath)));
    out.advisorWrite = attempt(() => config.writeWorkspaces(make({}, "has space"), tmpPath));
    out.fileWritten = (await import("node:fs")).existsSync(tmpPath);
    await config.refreshDiscovery(async () => ({ values: ["low", "high", "bad eff", "-x"], fallback: false }), async () => ({ values: ["okprov/ok-model", "-vendor/model", "vendor/../model", "opencode/gpt-fine", "opencode/gpt-bad one"], fallback: false }), async () => ({ fallback: false, values: JSON.parse(${JSON.stringify(DISCOVERED_CLAUDE(["has space", "a".repeat(101), "-flag", "a/../b", "claude-x[1m]"]))}) }));
    out.claudeListed = config.MODEL_OPTIONS.claude; out.claudeInfo = config.CLAUDE_MODEL_INFO.map((m) => m.value);
    out.claudeEfforts = config.EFFORT_OPTIONS.claude; out.opencode = config.OPENCODE_MODEL_SUGGESTIONS; out.codex = config.MODEL_OPTIONS.codex;
    const trips = [];
    const trip = (cli, model, effort, advisor) => { try { config.writeWorkspaces(make({ cli, model, effort }, advisor), tmpPath); config.readWorkspaces(tmpPath); } catch (e) { trips.push(cli + " " + model + " " + effort + " -> " + e.message); } };
    for (const m of config.MODEL_OPTIONS.claude) trip("claude", m, "high", m);
    for (const m of config.MODEL_OPTIONS.codex) trip("codex", m, "high");
    for (const m of config.OPENCODE_MODEL_SUGGESTIONS) trip("opencode", m, "max");
    for (const e of config.EFFORT_OPTIONS.claude) trip("claude", "sonnet", e);
    for (const e of config.EFFORT_OPTIONS.codex) trip("codex", "gpt-6-sol", e);
    for (const e of config.EFFORT_OPTIONS.opencode) trip("opencode", "okprov/ok-model", e);
    out.trips = trips;
  `);
  assert.deepEqual(out.picks, [false, false, false, false, false], "user picks with an unsafe shape are refused");
  assert.ok(out.writes.every((w: string) => /^THROWS .*invalid slot\/model\/effort/.test(w)), `writes ${out.writes}`);
  assert.match(out.advisorWrite, /^THROWS .*invalid advisor/);
  assert.equal(out.fileWritten, false, "nothing was written for any refused value");
  const unsafe = ["has space", "a".repeat(101), "-flag", "a/../b", "bad eff", "-x", "-vendor/model", "vendor/../model", "gpt-bad one", "opencode/gpt-bad one"];
  for (const list of [out.claudeListed, out.claudeInfo, out.claudeEfforts, out.opencode, out.codex]) for (const bad of unsafe) assert.ok(!list.includes(bad), `${JSON.stringify(bad.slice(0, 20))} must not be offered`);
  assert.ok(out.claudeListed.includes("claude-x[1m]") && out.claudeEfforts.includes("high") && out.opencode.includes("okprov/ok-model") && out.codex.includes("gpt-fine"), "control: the safe discovered values are offered");
  assert.deepEqual(out.trips, [], "every offered value saves and loads");
});

test("saved values: the saved sets follow the current workspace, so a value nobody uses any more is not listed or accepted after a refresh", { timeout: 60000 }, async () => {
  const seed = (model: string, effort: string, advisor?: string) => ({ projects: [{ id: "p", name: "P", folder: ".", tabs: [{ id: "p-dev", name: "Dev", kind: "dev", process: "main", folder: ".", ...(advisor ? { advisor: { model: advisor } } : {}), crew: SEATS.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat === WORKER ? model : seat.model, effort: seat === WORKER ? effort : seat.effort })) }] }] });
  const out = await configChild(seed("fable.5", "ultra", "fable-5"), `
    config.adoptSavedValues(config.readWorkspaces());
    const snapshot = () => ({ listed: config.MODEL_OPTIONS.claude.slice(), efforts: config.EFFORT_OPTIONS.claude.slice(), info: config.CLAUDE_MODEL_INFO.map((m) => m.value), fableOk: config.isValidModel("claude", "fable.5"), advisorOk: config.isValidModel("claude", "fable-5"), ultraOk: config.isValidEffort("claude", "ultra") });
    out.start = snapshot();
    // The coder seat moves to sonnet/high through a real workspace write; the advisor still uses fable-5.
    config.writeWorkspaces(make({ model: "sonnet", effort: "high" }, "fable-5"));
    out.afterWrite = snapshot();
    await config.refreshDiscovery(async () => ({ values: ["low", "medium", "high"], fallback: false }), async (f) => ({ values: [...f], fallback: true }), async () => ({ fallback: false, values: JSON.parse(${JSON.stringify(DISCOVERED_CLAUDE([]))}) }));
    out.afterRefresh = snapshot();
    config.writeWorkspaces(make({ model: "sonnet", effort: "high" }));
    out.afterAdvisorGone = snapshot();
    await config.refreshDiscovery(async () => ({ values: ["low", "medium", "high"], fallback: false }), async (f) => ({ values: [...f], fallback: true }), async () => ({ fallback: false, values: JSON.parse(${JSON.stringify(DISCOVERED_CLAUDE([]))}) }));
    out.afterSecondRefresh = snapshot();
  `);
  assert.ok(out.start.listed.includes("fable.5") && out.start.listed.includes("fable-5") && out.start.efforts.includes("ultra"), "control: adopted at boot");
  assert.ok(!out.afterWrite.listed.includes("fable.5") && !out.afterWrite.fableOk && !out.afterWrite.efforts.includes("ultra") && !out.afterWrite.ultraOk, "unused by the written workspace: gone at once");
  assert.ok(out.afterWrite.advisorOk && out.afterWrite.listed.includes("fable-5"), "a still-used value stays");
  for (const key of ["afterRefresh"]) {
    assert.ok(!out[key].listed.includes("fable.5") && !out[key].info.includes("fable.5") && !out[key].fableOk && !out[key].efforts.includes("ultra"), `${key}: a refresh does not bring the unused value back`);
    assert.ok(out[key].advisorOk && out[key].info.includes("fable-5"), `${key}: the still-used value survives the refresh`);
  }
  for (const key of ["afterAdvisorGone", "afterSecondRefresh"]) assert.ok(!out[key].listed.includes("fable-5") && !out[key].advisorOk, `${key}: the advisor's value is gone once the advisor stops using it`);
});

test("saved values: through the real server, a value whose last use is removed is no longer listed or accepted for user input (a still-used one stays)", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, advisor: "fable", workerModel: "fable.5", workerEffort: "ultra" }, async (h) => {
    assert.ok(h.state().modelOptions.claude.includes("fable.5") && h.state().effortOptions.claude.includes("ultra"), "control: adopted at boot");
    const moved = await h.update({ slot: WORKER.slotId, model: "sonnet", effort: "high" }, () => h.seat(WORKER.slotId).model === "sonnet" && h.seat(WORKER.slotId).effort === "high");
    assert.notEqual(moved.type, "error");
    await h.wait(() => !h.state().modelOptions.claude.includes("fable.5") && !h.state().effortOptions.claude.includes("ultra"), "unused values unlisted");
    assert.ok(h.state().modelOptions.claude.includes("fable"), "the advisor's value stays");
    const again = await h.update({ slot: READER.slotId, model: "fable.5" });
    assert.equal(again.type, "error", "no longer accepted for user input");
    const start = h.messages.length;
    h.send({ type: "setAdvisor", tabId: TAB, advisor: null });
    await h.wait(() => !h.tab().advisor && !h.state().modelOptions.claude.includes("fable"), "advisor removed, its value unlisted");
    assert.equal(h.messages.slice(start).some((m) => m.type === "error"), false);
  });
});

// ---- the advisor ----

test("advisor: buildLeaderOptions passes --advisor only with the native CLI and a chosen advisor", () => {
  const seat = { model: "claude-opus-5-5[1m]", effort: "high", advisor: "claude-fable-5-1[1m]" };
  assert.deepEqual(buildLeaderOptions(seat, ".", "C:/x/claude.exe").extraArgs, { effort: "high", advisor: "claude-fable-5-1[1m]", "replay-user-messages": null });
  assert.deepEqual(buildLeaderOptions({ ...seat, advisor: undefined }, ".", "C:/x/claude.exe").extraArgs, { effort: "high", "replay-user-messages": null });
  assert.equal(buildLeaderOptions(seat, ".", null).extraArgs, undefined, "no native CLI, no extra args at all");
});

test("advisor: the tab's saved advisor reaches the Claude leader's CLI args when its session starts", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, env: { CC_TEST_FAKE_LEADER: "1", CLAUDE_CLI_PATH: process.execPath } }, async (h) => {
    let start = h.chat(script({ tool: "Read", input: { file_path: "x" } }));
    await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    assert.deepEqual(h.ipc.find((m) => m.type === "queryStarted").extraArgs, { effort: LEADER.effort, "replay-user-messages": null }, "no advisor yet");
    // A changed advisor applies when the next session starts: end this one, then chat.
    h.send({ type: "setAdvisor", tabId: TAB, advisor: { model: "claude-fable-5-1[1m]" } });
    await h.wait(() => h.tab().advisor?.model === "claude-fable-5-1[1m]", "advisor saved");
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.tab().leaderStatus === "not-started", "session ended");
    const before = h.ipc.filter((m) => m.type === "queryStarted").length;
    start = h.chat(script({ tool: "Read", input: { file_path: "x" } }));
    await h.wait(() => h.ipc.filter((m) => m.type === "queryStarted").length > before, "new session");
    assert.deepEqual(h.ipc.filter((m) => m.type === "queryStarted").at(-1).extraArgs, { effort: LEADER.effort, advisor: "claude-fable-5-1[1m]", "replay-user-messages": null });
  });
});

// ---- other seats ----

test("a non-leader read-only seat can also change CLI (the worker setup is per run)", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["opencode"] }, async (h) => {
    await h.refresh();
    await h.update({ slot: READER.slotId, cli: "opencode", model: "opencode/glm-5.2" }, () => h.seat(READER.slotId).cli === "opencode");
    assert.deepEqual([h.seat(READER.slotId).model, h.seat(READER.slotId).effort], ["opencode/glm-5.2", "max"]);
    // A restart reads the saved seat back: a CLI that differs from the slot default is valid.
    assert.equal(h.savedCrew().find((s) => s.slot === READER.slotId).cli, "opencode");
  });
});

test("the state the client receives carries the OpenCode catalogue, including a saved seat model discovery did not return", { timeout: 60000 }, async () => {
  await withServer({ leader: { cli: "opencode", model: "savedprov/saved-model", effort: "max" }, installed: ["opencode"] }, async (h) => {
    const models = h.state().opencodeModels;
    assert.ok(Array.isArray(models) && models.includes("savedprov/saved-model"), `client state opencodeModels=${JSON.stringify(models)}`);
  });
});

// ---- round 1 fixes ----

const startedPids = (h: Harness) => h.cliEntries().filter((e) => e.started).map((e) => e.pid as number);
const errorsSince = (h: Harness, start: number) => h.messages.slice(start).filter((m) => m.type === "chatError" && m.tabId === TAB);

test("Codex leader: the mode cannot change while a turn runs, and the chat is not stopped by the refusal", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const start = h.chat(script({ sleep: 1200 }, { say: "still going" }));
    await h.wait(() => h.tab().derived.leaderTurnActive, "turn running");
    const reply = await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    assert.equal(reply.type, "error"); assert.match(reply.message, /Finish or stop .*'s current turn first, then change the mode\./);
    await h.wait(() => h.turnEnded(start).length === 1, "turn done"); assert.equal(h.turnEnded(start)[0].type, "chatDone", "the refusal did not stop the chat");
    assert.equal(h.deltas(start), "still going");
    assert.equal(h.cliEntries().filter((e) => e.method === "turn/start")[0].params.approvalPolicy, "on-request", "the running turn kept its policy");
    await h.idle();
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const next = h.chat("again"); await h.wait(() => h.turnEnded(next).length === 1, "next turn");
    assert.equal(h.cliEntries().filter((e) => e.method === "turn/start").at(-1).params.approvalPolicy, "untrusted", "between turns it applies to the next turn");
  });
});

test("Codex leader: a failed turn reports once and retires the leader; the next message starts a fresh one without old deltas", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const before = h.messages.length;
    let start = h.chat(script({ say: "partial" }, { error: "boom" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "failed turn"); await sleep(500);
    assert.equal(errorsSince(h, before).length, 1, "one error, none from the later exit");
    const [oldPid] = startedPids(h);
    await h.wait(() => !h.pidAlive(oldPid), "the old child is gone");
    await h.wait(() => h.tab().leaderStatus === "dead", "leader dead");
    start = h.chat(script({ staleDelta: "OLD-TURN-TEXT" }, { say: "fresh" }));
    await h.wait(() => h.turnEnded(start).length === 1, "fresh turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone"); assert.equal(h.deltas(start), "fresh", "a delta from another turn is dropped");
    assert.equal(startedPids(h).length, 2);
  });
});

test("Codex leader: a turn/start the CLI refuses retires the leader", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, env: { FAKE_CODEX_TURN_START_FAILS: "1" } }, async (h) => {
    const start = h.chat("hello");
    await h.wait(() => h.turnEnded(start).length >= 1, "refused turn"); await sleep(300);
    assert.equal(h.turnEnded(start).length, 1); assert.match(h.turnEnded(start)[0].message, /turn start refused by fake/);
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the child is gone");
  });
});

test("Codex leader: a line that is not an object ends that leader only, the server stays up", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ raw: "null" }, { say: "never" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "odd line"); await sleep(300);
    assert.equal(h.turnEnded(start).length, 1); assert.match(h.turnEnded(start)[0].message, /could not be read/);
    assert.equal(h.child.exitCode, null, "the server is still running");
    start = h.chat("after"); await h.wait(() => h.turnEnded(start).length === 1, "fresh leader");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
  });
});

test("Codex leader: a multi-byte character split across two reads arrives whole", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const start = h.chat(script({ splitUnicode: "é😀 ok" }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.deltas(start), "é😀 ok");
  });
});

test("Codex leader: a killer that fails is reported once, a missing process is not", { timeout: 60000 }, async () => {
  for (const [code, reported] of [["1", true], ["128", false]] as const) {
    await withServer({ leader: CODEX_LEADER, env: { CC_TEST_KILLER_EXIT: code } }, async (h) => {
      const start = h.chat("hello"); await h.wait(() => h.turnEnded(start).length === 1, "turn done"); await h.idle();
      const before = h.messages.length;
      h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
      await sleep(3500); // the kill starts after 200 ms and a failed one is confirmed unstopped only after the 2 s wait for the process to exit
      const notices = h.messages.slice(before).filter((m) => m.type === "chatNotice" && m.tabId === TAB && /Could not confirm the old Codex leader stopped\. Check Task Manager\./.test(m.message));
      assert.equal(notices.length, reported ? 1 : 0, `killer exit ${code}`);
    });
  }
});

test("OpenCode leader: a failed turn reports once, retires the leader and a failed prompt does too", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const before = h.messages.length;
    let start = h.chat(script({ error: "boom" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "failed turn"); await sleep(600);
    assert.equal(errorsSince(h, before).length, 1, "one error, none from the later exit");
    const [oldPid] = startedPids(h);
    await h.wait(() => !h.pidAlive(oldPid), "the old server is gone");
    // The old session's idle can no longer complete the next turn early: the next turn runs on a fresh server.
    start = h.chat(script({ sleep: 300 }, { say: "fresh" }));
    await h.wait(() => h.turnEnded(start).length === 1, "fresh turn");
    assert.equal(h.deltas(start), "fresh"); assert.equal(startedPids(h).length, 2);
  });
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_PROMPT_FAILS: "1" } }, async (h) => {
    const start = h.chat("refused"); await h.wait(() => h.turnEnded(start).length >= 1, "failed prompt");
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the server is gone");
  });
});

test("OpenCode leader: a permission reply that fails fails the turn and retires the leader", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_REPLY_FAILS: "1" } }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ bash: "npm test" }));
    await h.wait(() => h.pending().length === 1, "bash approval");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length >= 1, "the turn failed instead of hanging");
    assert.match(h.turnEnded(start)[0].message, /could not answer an OpenCode permission request/);
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the server is gone");
  });
});

test("OpenCode leader: errors never carry the bridge token or the server password", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ error: "boom", leak: true }));
    await h.wait(() => h.turnEnded(start).length >= 1, "leaky error");
    const token = h.cliEntries().find((e) => e.path === "/mcp").body.config.headers.Authorization.slice("Bearer ".length);
    const text = JSON.stringify(h.messages);
    assert.match(h.turnEnded(start)[0].message, /boom/);
    assert.ok(!text.includes(token), "no bridge token"); assert.ok(!/[0-9a-f]{40,}/.test(h.turnEnded(start)[0].message), "no password or token");
  });
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_SESSION_FAILS: "1" } }, async (h) => {
    const start = h.chat("hello"); await h.wait(() => h.turnEnded(start).length >= 1, "setup failure");
    const message = h.turnEnded(start)[0].message;
    assert.match(message, /POST \/session returned 500/); assert.ok(!/session refused|password|[0-9a-f]{40,}/.test(message), `setup detail dropped: ${message}`);
  });
});

test("bridge: a client that drops mid-body does not take the server down", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat("start the leader"); await h.wait(() => h.turnEnded(start).length === 1, "turn"); await h.idle();
    const token = h.cliEntries().find((e) => e.path === "/mcp").body.config.headers.Authorization.slice("Bearer ".length);
    const socket = (await import("node:net")).connect(h.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(`POST /api/leader-mcp/${TAB} HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"jsonrpc":`);
    await sleep(100); socket.resetAndDestroy();
    await sleep(500);
    assert.equal(h.child.exitCode, null, "the server survived the dropped body");
    assert.ok(!h.messages.some((m) => m.type === "error" && /internal error/.test(m.message)), "no 'internal error' reached the browser: the route caught it");
    const ok = await bridgePost(h.port, `/api/leader-mcp/${TAB}`, { authorization: `Bearer ${token}` }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    assert.equal(ok.status, 200);
  });
});

// ---- round 2 fixes ----

const modeReply = (h: Harness, from: number, requestId: string) => h.wait(() => h.messages.slice(from).find((m) => m.requestId === requestId && (m.type === "error" || m.type === "permissionModeChanged" || m.type === "actionResult")), `reply to ${requestId}`, 15000);
const permissionCalls = (h: Harness, reply: string) => h.cliEntries().filter((e) => e.path?.includes("/permission/") && e.body?.reply === reply);

test("mode change race: a queued change that reaches a busy Codex leader is refused by the queued callback's own check, the chat is not stopped, and nothing from the old leader fails the new turn", { timeout: 90000 }, async () => {
  // The old leader is Claude (its replacement does not wait for a process), so the new Codex leader is running a turn when race_2's turn in the queue comes.
  await withServer({ leader: CLAUDE_LEADER, installed: ["codex"], env: { CC_TEST_FAKE_LEADER: "1", FAKE_CLAUDE_MODE_DELAY_MS: "2500" } }, async (h) => {
    await h.refresh();
    const warm = h.chat(JSON.stringify([{ tool: "Read", input: { file_path: "x" } }])); await h.wait(() => h.turnEnded(warm).length === 1, "claude turn"); await h.idle();
    const mark = h.messages.length;
    h.send({ type: "setPermissionMode", tabId: TAB, mode: "plan", confirm: true, requestId: "race_1" });
    await h.wait(() => h.ipc.some((m) => m.type === "modeChangeStarted"), "the first change is in flight");
    // No busy leader at request time, so race_2 passes the first check and queues behind race_1: only the queued callback's check can refuse it.
    h.send({ type: "setPermissionMode", tabId: TAB, mode: "ask", confirm: true, requestId: "race_2" });
    await h.update({ slot: LEADER.slotId, cli: "codex", model: "gpt-6-sol" }, () => h.seat(LEADER.slotId).cli === "codex");
    const start = h.chat(script({ sleep: 3500 }, { say: "still going" }));
    await h.wait(() => startedPids(h).length === 1 && h.tab().derived.leaderTurnActive, "the Codex leader is running the turn");
    const second = await modeReply(h, mark, "race_2");
    assert.equal(second.type, "error"); assert.match(second.message, /Finish or stop .*'s current turn first, then change the mode./, "the busy refusal, not a failed apply");
    assert.equal((await modeReply(h, mark, "race_1")).type, "error", "the change that was in flight when the leader was replaced fails");
    await h.wait(() => h.turnEnded(start).length === 1, "codex turn done", 15000);
    assert.equal(h.turnEnded(start)[0].type, "chatDone", "the busy refusal did not stop the chat and the old leader did not fail it");
    assert.equal(h.deltas(start), "still going");
    assert.equal(errorsSince(h, mark).length, 0, "no chat error frame at all");
  });
});

test("OpenCode leader: a server that dies during a mode change reports one chat error, not two", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_PATCH_EXITS: "1" } }, async (h) => {
    const warm = h.chat("start the leader"); await h.wait(() => h.turnEnded(warm).length === 1, "opencode turn"); await h.idle();
    const mark = h.messages.length;
    const reply = await h.action({ type: "setPermissionMode", tabId: TAB, mode: "plan", confirm: true });
    assert.equal(reply.type, "error");
    await sleep(700);
    const errors = errorsSince(h, mark);
    assert.equal(errors.length, 1, `one chat error: ${JSON.stringify(errors.map((e) => e.message))}`);
    assert.match(errors[0].message, /session ended/);
  });
});

test("OpenCode leader: when it dies with a permission still open, the CLI gets a reject for it", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ bashNoWait: "rm -rf left-open" }, { error: "boom" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "the turn failed with a permission open");
    await h.wait(() => permissionCalls(h, "reject").length === 1, "a reject was posted for the open permission");
    await h.wait(() => h.pending().length === 0, "the approval card is gone");
  });
});

test("OpenCode leader: Stop while a reply is still being acknowledged still rejects that permission", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_REPLY_DELAY_MS: "4000" } }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    h.chat(script({ bash: "npm test" }));
    await h.wait(() => h.pending().length === 1, "approval pending");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => permissionCalls(h, "once").length === 1, "the allow reached the CLI, its acknowledgement is still pending");
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => permissionCalls(h, "reject").length === 1, "Stop rejected the permission that was not acknowledged yet");
  });
});

test("OpenCode leader: the effort sent with each prompt follows the saved seat", { timeout: 60000 }, async () => {
  // OpenCode offers one effort today: the test runner widens the list to two so a leader that froze its effort at start is caught.
  await withServer({ leader: OPENCODE_LEADER, env: { CC_TEST_OPENCODE_EFFORTS: "max,high" } }, async (h) => {
    let start = h.chat("first"); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    await h.update({ slot: LEADER.slotId, effort: "high" }, () => h.seat(LEADER.slotId).effort === "high");
    start = h.chat("second"); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.deepEqual(h.cliEntries().filter((e) => e.path?.endsWith("/prompt_async")).map((e) => e.body.variant), ["max", "high"]);
  });
});

test("OpenCode leader: an error that echoes the base64 credential never reaches the chat", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ error: "boom", leakB64: true }));
    await h.wait(() => h.turnEnded(start).length >= 1, "leaky error");
    const message = h.turnEnded(start)[0].message;
    assert.match(message, /boom credential \[hidden\]/);
    assert.ok(!/[A-Za-z0-9+/=]{40,}/.test(JSON.stringify(h.messages.filter((m) => m.type !== "state"))), "no credential-sized string anywhere in the chat frames");
  });
});

test("OpenCode leader: a prompt error is redacted before it is shortened", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_PROMPT_FAILS: "1", FAKE_OPENCODE_PROMPT_LEAK: "1" } }, async (h) => {
    const start = h.chat("will be refused"); await h.wait(() => h.turnEnded(start).length >= 1, "failed prompt");
    const message = h.turnEnded(start)[0].message;
    assert.match(message, /x{100,}\[hidden\]/, "the password became [hidden] before the cut");
    assert.ok(!/[0-9a-f]{12,}/.test(message.replace(/x+/g, "")), `no part of the password survives: ${message}`);
  });
});

test("Codex leader: a delta from an older turn that lands before the new turn is announced is dropped, and a late turn/started cannot replace the id", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ staleNext: "OLD-BEFORE-START" }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ say: "fresh" })); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone"); assert.equal(h.deltas(start), "fresh", "the old turn's delta never reached this turn");
    await h.idle();
    start = h.chat(script({ staleStarted: true }, { say: "after" })); await h.wait(() => h.turnEnded(start).length === 1, "third turn");
    assert.equal(h.deltas(start), "after", "a turn/started naming an older turn did not take over the turn id");
  });
});

test("Codex leader: an older turn's started, text and completion that land before the new turn's reply are ignored", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ staleTurnNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ sleep: 300 }, { say: "own text" })); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone"); assert.equal(h.deltas(start), "own text", "only the real turn's text, finished by its own completion");
  });
});

test("Codex leader: text and a completion that name no turn, landing before the reply, neither reach chat nor end the turn", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ unidentNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ sleep: 300 }, { say: "own text" })); await h.wait(() => h.turnEnded(start).length >= 1, "second turn"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.deltas(start), "own text", "the unidentified text never reached chat and the unidentified completion did not end the turn early");
  });
});

test("Codex leader: a final error that names no turn, before and after the reply, does not end the turn or the leader", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ unidentErrorNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ sleep: 300 }, { say: "own text" })); await h.wait(() => h.turnEnded(start).length >= 1, "second turn"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatDone", "no chat error from the unidentified error");
    assert.equal(h.deltas(start), "own text");
    assert.equal(startedPids(h).length, 1, "the same leader served both turns");
    start = h.chat(script({ say: "third" })); await h.wait(() => h.turnEnded(start).length === 1, "third turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone"); assert.equal(startedPids(h).length, 1, "the next message reused the leader");
  });
});

test("Codex leader: a turn/start that is never answered retires the leader with one plain error, and the next message starts fresh", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, env: { FAKE_CODEX_TURN_START_NEVER_ANSWERED: "1", CC_TEST_LEADER_START_TIMEOUT_MS: "600" } }, async (h) => {
    const start = h.chat("hello"); await h.wait(() => h.turnEnded(start).length >= 1, "the unanswered turn ended"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError"); assert.match(h.turnEnded(start)[0].message, /Codex did not answer the turn request/);
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the leader's child is gone");
    await h.wait(() => !h.tab().derived.leaderTurnActive, "the tab is no longer busy");
    h.chat("again"); await h.wait(() => startedPids(h).length === 2, "the next message started a fresh leader");
  });
});

test("Codex leader: a turn/start reply with no turn id ends that leader with one plain error, and the next message starts fresh", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ noIdNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat("no id please"); await h.wait(() => h.turnEnded(start).length >= 1, "the unidentified turn ended"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError"); assert.match(h.turnEnded(start)[0].message, /did not identify the turn/);
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the leader's child is gone");
    start = h.chat("fresh again"); await h.wait(() => h.turnEnded(start).length === 1, "next turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone"); assert.match(h.deltas(start), /fresh again/);
  });
});

test("Codex leader: a request it cannot handle is refused and ends that leader once", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const start = h.chat(script({ badFileChange: true }, { say: "never" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "the turn ended"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError"); assert.match(h.turnEnded(start)[0].message, /could not be handled/);
    assert.ok(h.cliEntries().some((e) => e.response >= 1000 && e.result?.decision === "decline"), "the CLI got its refusal");
    assert.equal(h.child.exitCode, null, "the server is still running");
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the leader's child is gone");
  });
});

test("Codex leader: when it fails with an approval open, the CLI still gets its refusal", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ commandNoWait: "rm -rf left-open" }, { error: "boom" }));
    await h.wait(() => h.turnEnded(start).length >= 1, "the turn failed with a request open");
    await h.wait(() => h.cliEntries().some((e) => e.response >= 1000 && e.result?.decision === "decline"), "the refusal was written before the kill");
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the child is gone");
  });
});

test("a leader whose kill could not be confirmed blocks the tab's next leader until its process is seen to exit", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, env: { CC_TEST_KILLER_EXIT: "1" } }, async (h) => {
    const warm = h.chat("hello"); await h.wait(() => h.turnEnded(warm).length === 1, "first turn"); await h.idle();
    const [oldPid] = startedPids(h);
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.messages.some((m) => m.type === "chatNotice" && /Could not confirm the old Codex leader stopped/.test(m.message)), "the failed kill is reported");
    assert.ok(h.pidAlive(oldPid), "the fake killer left the old leader running");
    const blocked = h.chat("while the old one lives"); await h.wait(() => h.turnEnded(blocked).length === 1, "refused");
    assert.equal(h.turnEnded(blocked)[0].type, "chatError");
    assert.match(h.turnEnded(blocked)[0].message, /could not be confirmed stopped and may still be running/);
    assert.equal(startedPids(h).length, 1, "no second leader process was started beside it");
    process.kill(oldPid); await h.wait(() => !h.pidAlive(oldPid), "the old leader exits");
    // The server learns of the exit a moment after the pid is gone: ask again until it has (a still-blocked answer is the same refusal as above).
    let next = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      next = h.chat("after it exited"); await h.wait(() => h.turnEnded(next).length === 1, "answered");
      if (h.turnEnded(next)[0].type === "chatDone") break;
      await sleep(250);
    }
    assert.equal(h.turnEnded(next)[0].type, "chatDone", h.turnEnded(next)[0].message); assert.equal(startedPids(h).length, 2);
  });
});

test("a message sent right after Stop, before the old kill's result is known, never starts a second leader beside one whose kill then fails", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER, env: { CC_TEST_KILLER_EXIT: "1" } }, async (h) => {
    const warm = h.chat("hello"); await h.wait(() => h.turnEnded(warm).length === 1, "first turn"); await h.idle();
    const [oldPid] = startedPids(h);
    const mark = h.messages.length;
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.tab().leaderStatus === "not-started", "the old leader is stopped");
    // The kill runs after a short grace and its (failing) result comes later: this message arrives before either.
    const start = h.chat(script({ sleep: 1800 }, { say: "still going" }));
    const notice = await h.wait(() => h.messages.slice(mark).find((m) => m.type === "chatNotice"), "the failed kill is reported", 15000);
    assert.match(notice.message, /Could not confirm the old Codex leader stopped/); assert.equal(notice.tabId, TAB);
    await h.wait(() => h.turnEnded(start).length === 1, "the message was refused", 15000);
    assert.equal(h.turnEnded(start)[0].type, "chatError");
    assert.match(h.turnEnded(start)[0].message, /could not be confirmed stopped and may still be running/);
    assert.ok(h.pidAlive(oldPid), "the fake killer left the old leader running");
    assert.equal(startedPids(h).length, 1, "no second leader process was started beside it");
    assert.ok(!errorsSince(h, mark).some((m) => m.message === notice.message), "the notice is not a chat error");
  });
});

// A normal Stop can run two overlapping taskkills on one tree and one of them exits with another code though the tree is gone (CC_TEST_KILLER_EXIT=1 plays that exit code).
// The old leader really exits a moment after the failed kill: that is a confirmed stop, with no notice and no refusal of the next message.
for (const c of [{ name: "Codex", leader: CODEX_LEADER, notice: /Could not confirm the old Codex leader stopped/ }, { name: "OpenCode", leader: OPENCODE_LEADER, notice: /Could not confirm the old OpenCode leader stopped/ }]) {
  test(`${c.name} leader: a Stop whose killer exits with another code but whose process then exits raises no could-not-confirm alarm`, { timeout: 60000 }, async () => {
    await withServer({ leader: c.leader, env: { CC_TEST_KILLER_EXIT: "1" } }, async (h) => {
      const warm = h.chat("hello"); await h.wait(() => h.turnEnded(warm).length === 1, "first turn"); await h.idle();
      const [oldPid] = startedPids(h);
      const mark = h.messages.length;
      h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
      await sleep(900); // the kill starts after the 200 ms grace and its fake killer has failed by now; the old leader is still alive
      assert.ok(h.pidAlive(oldPid), "the fake killer left the old leader running for the moment");
      process.kill(oldPid); await h.wait(() => !h.pidAlive(oldPid), "the old leader exits");
      await sleep(3000); // past the confirm wait: a false alarm would have come by now
      assert.ok(!h.messages.slice(mark).some((m) => m.type === "chatNotice" && c.notice.test(m.message)), "no could-not-confirm notice");
      const next = h.chat("after it exited"); await h.wait(() => h.turnEnded(next).length === 1, "answered", 20000);
      assert.equal(h.turnEnded(next)[0].type, "chatDone", h.turnEnded(next)[0].message); assert.equal(startedPids(h).length, 2, "a new leader started normally");
    });
  });
}

test("Stop and an immediate message: the new leader starts once the old one has exited, with no error", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    const warm = h.chat("hello"); await h.wait(() => h.turnEnded(warm).length === 1, "first turn"); await h.idle();
    const [oldPid] = startedPids(h);
    const mark = h.messages.length;
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    const next = h.chat(script({ say: "fresh" }));
    await h.wait(() => h.turnEnded(next).length === 1, "the new turn", 20000);
    assert.equal(h.turnEnded(next)[0].type, "chatDone", h.turnEnded(next)[0].message); assert.equal(h.deltas(next), "fresh");
    assert.equal(startedPids(h).length, 2); assert.ok(!h.pidAlive(oldPid), "the old leader was gone before the new answer");
    assert.equal(errorsSince(h, mark).length, 0, "no chat error frame at all");
  });
});

test("Stop all ends a turn that is waiting for the old leader to exit, and no leader starts after it", { timeout: 60000 }, async () => {
  // CC_TEST_KILLER_EXIT=0: the kill reports success but stops nothing, so the old leader stays alive and the next turn has to wait for it.
  await withServer({ leader: CODEX_LEADER, env: { CC_TEST_KILLER_EXIT: "0" } }, async (h) => {
    const warm = h.chat("hello"); await h.wait(() => h.turnEnded(warm).length === 1, "first turn"); await h.idle();
    const [oldPid] = startedPids(h);
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.tab().leaderStatus === "not-started", "the old leader is stopped");
    const waiting = h.chat(script({ say: "must never run" }));
    await h.wait(() => h.tab().derived.leaderTurnActive, "the message is waiting for the old leader");
    assert.ok(h.pidAlive(oldPid), "the old leader is still alive");
    h.send({ type: "stopAll" });
    await h.wait(() => h.turnEnded(waiting).length === 1, "the waiting turn ended", 15000);
    assert.equal(h.turnEnded(waiting)[0].type, "chatError");
    assert.equal(h.turnEnded(waiting)[0].message, "leader turn stopped");
    await h.idle();
    assert.equal(h.tab().derived.busy, false, "the tab is not busy after Stop all");
    process.kill(oldPid); await h.wait(() => !h.pidAlive(oldPid), "the old leader exits");
    await sleep(1500); // well past the 25 ms recheck of the wait: a leader would have started by now
    assert.equal(startedPids(h).length, 1, "no new leader process was ever started");
    assert.equal(h.deltas(waiting), "");
  });
});

// The old leader's root exits but a descendant of it cannot be stopped. The process list and the kill of that one made-up descendant are the only
// fakes (Boot.tree); the leader, its exit sweep, the tab's retired-leader check and the chat all run for real.
const GRAND = 2_147_400_001;
const sweepCases = [
  { name: "Codex", leader: CODEX_LEADER, env: {}, notice: /Could not confirm the old Codex leader stopped/, text: () => script({ say: "fresh" }), pids: (h: Harness) => startedPids(h) },
  { name: "OpenCode", leader: OPENCODE_LEADER, env: {}, notice: /Could not confirm the old OpenCode leader stopped/, text: () => script({ say: "fresh" }), pids: (h: Harness) => startedPids(h) },
  { name: "Claude", leader: CLAUDE_LEADER, env: { CC_TEST_FAKE_LEADER: "1", FAKE_CLAUDE_SPAWN: "1" }, notice: /Could not confirm the old Claude leader stopped/, text: () => JSON.stringify([{ tool: "Read", input: { file_path: "x" } }]), pids: (h: Harness) => h.ipc.filter((m) => m.type === "claudeSpawned").map((m) => m.pid as number) },
];
for (const c of sweepCases) {
  test(`${c.name} leader: a descendant of the stopped leader that cannot be killed is said once, refuses the next message with no new leader, and once it can be killed the next message starts one`, { timeout: 90000 }, async () => {
    await withServer({ leader: c.leader, tree: true, env: c.env }, async (h) => {
      const warm = h.chat(c.text()); await h.wait(() => h.turnEnded(warm).length === 1, "first turn", 15000); await h.idle();
      const [oldPid] = c.pids(h);
      assert.ok(oldPid, "the old leader's process started");
      const leftover = { pid: GRAND, ppid: oldPid, created: Date.now() }; // the same process on every setTree: a new created would be a different one
      h.setTree([leftover], [GRAND]);
      const notices = () => h.messages.filter((m) => m.type === "chatNotice" && c.notice.test(m.message)).length;
      h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
      await h.wait(() => notices() === 1, "the failed descendant kill is reported", 20000);
      await h.wait(() => !h.pidAlive(oldPid), "the old leader's own process is gone");
      // The notice can come from Stop's own kill before the exit sweep has looked: go on only once the sweep has tried (and failed) to kill the descendant.
      await h.wait(() => h.treeKills().some((kill) => kill.pid === GRAND && !kill.ok), "the exit sweep's failed kill of the descendant", 30000);
      const blocked = h.chat(c.text()); await h.wait(() => h.turnEnded(blocked).length === 1, "refused", 25000);
      assert.equal(h.turnEnded(blocked)[0].type, "chatError");
      assert.match(h.turnEnded(blocked)[0].message, /could not be confirmed stopped and may still be running/);
      assert.equal(c.pids(h).length, 1, "no new leader process was started");
      assert.equal(notices(), 1, "said once, not again by the retry");
      h.setTree([leftover], []); // the descendant can be killed now: the retry has to kill this very process, or the next message is refused again
      const next = h.chat(c.text()); await h.wait(() => h.turnEnded(next).length === 1, "the next message", 25000);
      assert.equal(h.turnEnded(next)[0].type, "chatDone", h.turnEnded(next)[0].message);
      assert.equal(c.pids(h).length, 2, "a new leader started normally");
    });
  });
}

// Every kill of the stopped leader fails (CC_TEST_KILLER_EXIT=1) and its descendant cannot be stopped either, so the kill and the exit sweep both report: one notice, not one per report.
for (const c of sweepCases) {
  test(`${c.name} leader: a kill that cannot be confirmed and a sweep that fails afterwards are said once`, { timeout: 90000 }, async () => {
    await withServer({ leader: c.leader, tree: true, env: { ...c.env, CC_TEST_KILLER_EXIT: "1" } }, async (h) => {
      const warm = h.chat(c.text()); await h.wait(() => h.turnEnded(warm).length === 1, "first turn", 15000); await h.idle();
      const [oldPid] = c.pids(h);
      assert.ok(oldPid, "the old leader's process started");
      h.setTree([{ pid: GRAND, ppid: oldPid, created: Date.now() }], [GRAND]);
      const notices = () => h.messages.filter((m) => m.type === "chatNotice" && c.notice.test(m.message)).length;
      h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
      await h.wait(() => notices() >= 1, "the failed kill is reported", 20000);
      assert.ok(h.pidAlive(oldPid), "the fake killer left the old leader running");
      const exitedAfter = Date.now();
      process.kill(oldPid); await h.wait(() => !h.pidAlive(oldPid), "the old leader exits");
      // The exit sweep has tried (and failed) to kill the descendant: only now can a second notice be on its way.
      await h.wait(() => h.treeKills().some((kill) => kill.pid === GRAND && !kill.ok && kill.at >= exitedAfter), "the exit sweep's failed kill of the descendant", 30000);
      const blocked = h.chat(c.text()); await h.wait(() => h.turnEnded(blocked).length === 1, "refused", 25000);
      assert.match(h.turnEnded(blocked)[0].message, /could not be confirmed stopped and may still be running/);
      await sleep(2500); // the sweep's report follows its kill within a moment (about 1.6 s after the exit when the dedupe is missing, measured)
      assert.equal(notices(), 1, "the kill and the sweep said it once between them");
    });
  });
}

// ---- final-review fixes ----

test("OpenCode leader: an unreadable successful reply never puts a piece of the password or the bridge token in chat", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_SESSION_MALFORMED: "1" } }, async (h) => {
    const start = h.chat("hello"); await h.wait(() => h.turnEnded(start).length >= 1, "setup failure");
    const message = h.turnEnded(start)[0].message;
    assert.match(message, /POST \/session returned unreadable data/);
    const { password, token } = h.cliEntries().find((e) => e.leaked).leaked;
    const everything = JSON.stringify(h.messages.filter((m) => m.type !== "state"));
    for (const secret of [password, token]) for (let at = 0; at + 8 <= secret.length; at++) assert.ok(!everything.includes(secret.slice(at, at + 8)), `no 8 character piece of a secret at ${at}: ${message}`);
  });
});

test("OpenCode leader: a duplicate session.idle while the window is read neither ends the turn early nor completes the next turn with the old numbers", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_DUP_IDLE: "1", FAKE_OPENCODE_PROVIDERS_DELAY_MS: "700" } }, async (h) => {
    const start = h.chat("first"); await h.wait(() => h.turnEnded(start).length >= 1, "first turn"); await h.idle();
    // The duplicate idle came 50 ms after the first, while the window was still being read: it did not finish the turn with no window.
    assert.equal(h.tab().leaderUsage.contextWindow, 200000, "the turn ended on the idle that read the window");
    // Both idles for turn 1 are in; the second turn starts right away.
    const second = h.chat(script({ sleep: 1200 }, { say: "second" }));
    await h.wait(() => h.turnEnded(second).length >= 1, "second turn", 15000); await sleep(400);
    assert.equal(h.turnEnded(start).length, 2, "one completion per turn, two in all");
    assert.equal(h.turnEnded(second).length, 1, "one completion for the second turn"); assert.equal(h.turnEnded(second)[0].type, "chatDone");
    assert.equal(h.deltas(second), "second", "the second turn ended on its own idle, after its own text");
    assert.equal(h.tab().leaderUsage.contextTokens, 2000, "the second turn's own usage, not the first turn's");
  });
});

test("OpenCode leader: a turn that started while the first one's window lookup was held gets no usage or completion from the first", { timeout: 60000 }, async () => {
  // The leader driven directly: the server never starts a second turn while one is open, so the guard is only reachable here.
  const temp = mkdtempSync(join(tmpdir(), "cc-gen-"));
  const logFile = join(temp, "fake.log");
  const bridge = createHttpServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result: { tools: [] } })); }); });
  bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
  const events = { deltas: "", done: 0, usage: [] as any[], errors: [] as string[] };
  const leader = createOpencodeLeader({ model: "fakeprov/fake-model", effort: "max" }, temp, {
    onDelta: (text) => { events.deltas += text; }, onDone: () => { events.done++; }, onUsage: (u) => { events.usage.push(u); }, onError: (m) => { events.errors.push(m); },
  }, {
    bridge: { url: `http://127.0.0.1:${(bridge.address() as any).port}/mcp`, token: "bridge-token-0123456789abcdef0123456789abcdef" }, mode: "bypass", ask: async () => true, // a real token is 64 hex characters; streamed text is redacted against it
    spawnFn: (command, options) => spawn(process.execPath, [resolve("test/fake-opencode-server.mjs"), "--port", /--port (\d+)/.exec(command)![1]], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...options.env, FAKE_LEADER_LOG: logFile, FAKE_OPENCODE_PROVIDERS_DELAY_MS: "1500" } }),
  });
  const providerHits = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split(String.fromCharCode(10)).filter((line) => line.includes('"/config/providers"')).length : 0);
  const until = async (fn: () => unknown, label: string, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(20); } assert.fail(label); };
  try {
    leader.send("first");
    await until(() => providerHits() === 1, "turn 1 is waiting on its window lookup");
    // Turn 2 starts while turn 1's lookup is still held, and stays open past the moment that lookup is released.
    leader.send(script({ sleep: 3500 }, { say: "two" }));
    await sleep(2200);
    assert.deepEqual([events.done, events.usage.length], [0, 0], "turn 1's late lookup gave turn 2 no usage and no completion");
    await until(() => events.done === 1, "turn 2 ends on its own idle", 10000);
    assert.equal(events.usage.length, 1, "one usage, turn 2's own");
    assert.equal(events.usage[0].contextTokens, 2000, "the usage is turn 2's tokens, not turn 1's");
    assert.match(events.deltas, /two$/, "turn 2's text came before its completion");
    assert.deepEqual(events.errors, []);
  } finally {
    leader.stop();
    bridge.close();
    await sleep(600);
    rmSync(logFile, { force: true });
    // The stopped server may still hold the folder for a moment: retry the empty-folder removal, and say so (never silently) if it stays.
    let removeError: unknown;
    for (const end = Date.now() + 2000; Date.now() < end;) { try { rmdirSync(temp); removeError = undefined; break; } catch (error) { removeError = error; await sleep(50); } }
    if (removeError) console.warn(`could not remove the temp folder ${temp}: ${String(removeError)}`);
  }
});

test("OpenCode leader: a question is rejected, and a reject that fails retires the leader with one plain error", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ question: true }, { say: "after" })); await h.wait(() => h.turnEnded(start).length === 1, "turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.cliEntries().filter((e) => e.method === "POST" && e.path === "/question/que_1/reject").length, 1, "the reject reached OpenCode");
  });
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_QUESTION_REJECT_FAILS: "1" } }, async (h) => {
    const start = h.chat(script({ question: true }, { hang: true }));
    await h.wait(() => h.turnEnded(start).length >= 1, "the turn failed instead of waiting for ever"); await sleep(400);
    assert.equal(h.turnEnded(start).length, 1); assert.equal(h.turnEnded(start)[0].type, "chatError");
    assert.match(h.turnEnded(start)[0].message, /could not answer an OpenCode question \(OpenCode POST \/question\/\S+\/reject returned 500\)/);
    await h.wait(() => !h.pidAlive(startedPids(h)[0]), "the server is gone");
    const next = h.chat("fresh"); await h.wait(() => h.turnEnded(next).length === 1, "next message");
    assert.equal(startedPids(h).length, 2, "the next message started a fresh leader");
  });
});

test("OpenCode leader: in Ask mode reading is not sent to the approval path, a .env read and a shell command are", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ read: "C:/work/.command-center/RESUME.md" }, { read: "C:/work/.env" }, { bash: "npm test" }));
    await h.wait(() => h.pending().length === 1, "the first approval");
    assert.equal(h.pending()[0].tool, "read", "the first thing to ask is the .env read; the plain read passed without asking");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.pending().length === 1 && h.pending()[0].tool === "Bash", "the shell command still asks");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.deltas(start), "[read C:/work/.command-center/RESUME.md auto][read C:/work/.env reject][permission once]");
  });
});

test("Codex leader: a crew-tool call that names the previous turn is refused during the next turn, which completes normally", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ staleCallNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ say: "fresh" })); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.deltas(start), "[stale call refused]fresh", "the stale call did not run and the turn went on");
    assert.ok(h.cliEntries().some((e) => e.response >= 1000 && e.result?.success === false && /leader stopped/.test(e.result?.contentItems?.[0]?.text)), "the CLI got its refusal");
    assert.equal(startedPids(h).length, 1, "the same leader served both turns");
  });
});

test("Codex leader: a request with no thread id, another thread, or an old v1 name is refused and never asks", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const base = { turnId: "$turn", itemId: "i9", command: "echo hi", cwd: "C:/work", reason: "x" };
    const raws = [
      { method: "item/tool/call", params: { turnId: "$turn", callId: "c9", tool: "get_crew_status", arguments: {} } },
      { method: "item/commandExecution/requestApproval", params: base },
      { method: "item/fileChange/requestApproval", params: { turnId: "$turn", itemId: "f9" } },
      { method: "item/commandExecution/requestApproval", params: { ...base, threadId: "thread-other" } },
      { method: "execCommandApproval", params: { conversationId: "thread-other", callId: "x", command: ["echo", "hi"], cwd: "C:/work", reason: "x" } },
      { method: "execCommandApproval", params: { conversationId: "thread-1", callId: "x", command: ["echo", "hi"], cwd: "C:/work", reason: "x" } },
      { method: "applyPatchApproval", params: { conversationId: "thread-other", callId: "y", fileChanges: {}, reason: "x" } },
      { method: "applyPatchApproval", params: { conversationId: "thread-1", callId: "y", fileChanges: {}, reason: "x" } },
    ];
    const start = h.chat(script(...raws.map((raw) => ({ raw })), { say: "end" }));
    await h.wait(() => h.turnEnded(start).length === 1 || h.pending().length > 0, "the turn ends without asking");
    assert.equal(h.pending().length, 0, "nothing reached the approval path");
    assert.equal(h.turnEnded(start)[0]?.type, "chatDone");
    const text = h.deltas(start);
    const denied = '{"decision":{"denied":{"rejection":"The user denied this."}}}';
    assert.match(text, /\[item\/tool\/call -> \{"contentItems":\[\{"type":"inputText","text":"leader stopped"\}\],"success":false\}\]/, "a tool call with no thread id is refused");
    assert.equal(text.match(/\[item\/commandExecution\/requestApproval -> \{"decision":"decline"\}\]/g)?.length, 2, "a command approval with no thread id, and with another thread, is declined");
    assert.match(text, /\[item\/fileChange\/requestApproval -> \{"decision":"decline"\}\]/, "a file approval with no thread id is declined");
    assert.equal(text.split(`execCommandApproval -> ${denied}`).length - 1, 2, "both execCommandApproval requests are denied");
    assert.equal(text.split(`applyPatchApproval -> ${denied}`).length - 1, 2, "both applyPatchApproval requests are denied");
  });
});

const APPROVALS = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"];
const declines = (h: Harness) => h.cliEntries().filter((e) => e.response >= 1000 && e.result?.decision === "decline").length;

test("Codex leader: a command or file approval with no turn id, an old turn id, another thread, or a finished turn is declined and never asks", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const raws = APPROVALS.flatMap((method) => [
      { method, params: { threadId: "thread-1", itemId: "m1", command: "echo hi", cwd: "C:/work", reason: "x" } },
      { method, params: { threadId: "thread-1", turnId: "turn-old", itemId: "s1", command: "echo hi", cwd: "C:/work", reason: "x" } },
      { method, params: { threadId: "thread-other", turnId: "$turn", itemId: "f1", command: "echo hi", cwd: "C:/work", reason: "x" } },
    ]);
    const late = APPROVALS.map((method) => ({ lateRaw: { method, params: { threadId: "thread-1", turnId: "$turn", itemId: "l1", command: "echo hi", cwd: "C:/work", reason: "x" } } }));
    const start = h.chat(script(...late, ...raws.map((raw) => ({ raw })), { say: "end" }));
    await h.wait(() => h.turnEnded(start).length === 1 || h.pending().length > 0, "the turn ends without asking");
    await h.idle();
    await h.wait(() => declines(h) === raws.length + late.length, `every one of the ${raws.length + late.length} requests was declined (saw ${declines(h)})`);
    assert.equal(h.pending().length, 0, "nothing reached the approval path");
    assert.equal(h.turnEnded(start)[0]?.type, "chatDone");
    for (const method of APPROVALS) assert.equal(h.deltas(start).split(`[${method} -> {"decision":"decline"}]`).length - 1, 3, `${method}: missing turn id, old turn id and another thread are each declined in the turn`);
  });
});

test("Codex leader: a command or file approval that lands before the turn/start reply is declined when it names another turn and handled when it names this one", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    for (const method of APPROVALS) {
      let start = h.chat(script({ earlyApprovalNext: { who: "other", method } }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
      start = h.chat(script({ say: "next" })); await h.wait(() => h.turnEnded(start).length === 1, `${method}: turn after an early request for another turn`);
      assert.equal(h.deltas(start), "[early call refused]next", `${method}: an early request naming another turn is declined on the reply`);
      assert.equal(h.pending().length, 0, `${method}: nothing was asked`);
    }
  });
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    let start = h.chat(script({ earlyApprovalNext: { who: "own", method: APPROVALS[0] } }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ say: "own" }));
    await h.wait(() => h.pending().length === 1, "the early request naming this turn reached the approval path");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.equal(h.deltas(start), "[early call ran]own", "control: an early request naming the coming turn is handled once the reply names it");
  });
});

test("Codex leader: a crew-tool call that lands before the turn/start reply waits for it, runs when it names the turn and is refused when it names another", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    let start = h.chat(script({ earlyOwnNext: true }, { say: "one" })); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    start = h.chat(script({ say: "own" })); await h.wait(() => h.turnEnded(start).length === 1, "second turn"); await h.idle();
    assert.equal(h.deltas(start), "[early call ran]own", "a call naming the coming turn ran once the reply named it");
    start = h.chat(script({ earlyOtherNext: true }, { say: "three" })); await h.wait(() => h.turnEnded(start).length === 1, "third turn"); await h.idle();
    start = h.chat(script({ say: "other" })); await h.wait(() => h.turnEnded(start).length === 1, "fourth turn");
    assert.equal(h.deltas(start), "[early call refused]other", "a call naming another turn was refused on the reply");
  });
});

test("leader CLI children (Codex and OpenCode) are spawned without the app key in their environment", async () => {
  const previous = process.env.CC_APP_KEY;
  process.env.CC_APP_KEY = "test-app-key-must-not-leak";
  const seen: Record<string, any> = {};
  const events = { onDelta() {}, onDone() {}, onUsage() {}, onError() {} };
  try {
    try {
      createCodexLeader({ model: "gpt-6-sol", effort: "low" }, ".", events as any, { tools: [], mode: "bypass", ask: async () => true, spawnFn: ((_command: string, options: any) => { seen.codex = options.env; throw new Error("stop after capturing the environment"); }) as any });
    } catch { /* the capture throws on purpose */ }
    const opencode = createOpencodeLeader({ model: "fakeprov/fake-model", effort: "max" }, ".", events as any, {
      bridge: { url: "http://127.0.0.1:1/mcp", token: "t" }, mode: "bypass", ask: async () => true,
      spawnFn: ((_command: string, options: any) => { seen.opencode = options.env; throw new Error("stop after capturing the environment"); }) as any,
    });
    opencode.send("hi");
    const end = Date.now() + 5000;
    while (!seen.opencode && Date.now() < end) await sleep(20);
    opencode.stop?.();
    assert.ok(seen.codex && seen.opencode, `both spawn calls were captured: ${Object.keys(seen)}`);
    for (const [name, env] of Object.entries(seen)) assert.equal(Object.hasOwn(env, "CC_APP_KEY"), false, `${name} child must not see CC_APP_KEY`);
    assert.ok(Object.keys(seen.codex).length > 3, "the captured environment is a real one (control: other variables are kept)");
  } finally { if (previous === undefined) delete process.env.CC_APP_KEY; else process.env.CC_APP_KEY = previous; }
});

// ---- fix pack 2, block 2: OpenCode sub-agents, the port, secrets in streamed text, bounded memory, stale Codex file changes ----

test("OpenCode leader: a sub-agent's requests are answered by the tab's mode; a session that is not the leader's is ignored", { timeout: 90000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    // Accept mode: edits and plain reads pass without a card; a shell command and a .env read ask, wherever in the tree of sub-agents they come from.
    const start = h.chat(script({ childEdit: true }, { childRead: "C:/work/a.txt" }, { childBash: "npm test" }, { childRead: "C:/work/.env" }, { foreignBash: "evil" }, { grandBash: "npm run build" }, { childQuestion: true }, { say: "done" }));
    await h.wait(() => h.pending().length === 1, "the shell command asks");
    assert.equal(h.pending()[0].tool, "Bash"); assert.equal(h.pending()[0].summary, "npm test");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.pending().length === 1 && h.pending()[0].tool === "read", "the .env read asks");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.pending().length === 1 && /npm run build/.test(h.pending()[0].summary), "the grandchild's shell command asks");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "turn done");
    assert.equal(h.turnEnded(start)[0].type, "chatDone");
    assert.equal(h.deltas(start), "[child edit once][child read C:/work/a.txt once][child bash once][child read C:/work/.env reject][foreign sent][grand bash once]done");
    const entries = h.cliEntries();
    assert.equal(entries.filter((e) => e.method === "POST" && /^\/question\/que_\d+\/reject$/.test(e.path ?? "")).length, 1, "the sub-agent's question was rejected");
    assert.equal(entries.filter((e) => /per_foreign/.test(e.path ?? "")).length, 0, "a session that is not under the leader's is never answered");
  });
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "plan", confirm: true });
    const start = h.chat(script({ childEdit: true }, { childRead: "C:/work/a.txt" }, { say: "x" }));
    await h.wait(() => h.turnEnded(start).length === 1, "plan turn");
    assert.equal(h.deltas(start), "[child edit reject][child read C:/work/a.txt once]x", "Plan: a sub-agent's edit is refused without a card, looking is free");
    assert.equal(h.pending().length, 0);
  });
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    const start = h.chat(script({ childEdit: true }, { say: "y" }));
    await h.wait(() => h.pending().length === 1, "Ask: the sub-agent's edit asks");
    assert.equal(h.pending()[0].tool, "Edit");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "ask turn");
    assert.equal(h.deltas(start), "[child edit once]y");
  });
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "bypass", confirm: true });
    const start = h.chat(script({ childBash: "anything" }, { say: "z" }));
    await h.wait(() => h.turnEnded(start).length === 1, "bypass turn");
    assert.equal(h.deltas(start), "[child bash once]z", "Bypass: nothing asks");
  });
});

test("OpenCode leader: the server gets a baseline that makes sub-agents ask, and OpenCode picks its own port", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat("hello"); await h.wait(() => h.turnEnded(start).length === 1, "turn");
    const started = h.cliEntries().find((e) => e.started);
    const config = JSON.parse(started.config);
    assert.equal(config.permission["*"], "ask");
    assert.equal(config.permission["tab-crew_*"], "allow");
    assert.equal(config.permission.read["*.env"], "ask");
    assert.deepEqual(started.args.slice(started.args.indexOf("--port"), started.args.indexOf("--port") + 2), ["--port", "0"], "no port is probed and reused: OpenCode binds one itself and says which");
    assert.ok(h.cliEntries().filter((e) => e.path).every((e) => e.authorized === true), "and every call reached the server that was started");
  });
});

test("OpenCode leader: streamed text never carries the server password or the bridge token, even when a secret is split across deltas", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ say: "start " }, { leakDelta: true }, { say: " tail" }));
    await h.wait(() => h.turnEnded(start).length === 1, "turn");
    const mcp = h.cliEntries().find((e) => e.path === "/mcp");
    const token = mcp.body.config.headers.Authorization.slice("Bearer ".length);
    const text = h.deltas(start);
    assert.equal(text, "start before [hidden] between [hidden] after tail", `the secrets are gone and nothing else was lost: ${text}`);
    assert.equal(JSON.stringify(h.messages).includes(token), false);
  });
});

test("OpenCode leader: a failed provider read is tried again on the next turn instead of leaving the window unknown", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER, env: { FAKE_OPENCODE_PROVIDERS_FAIL_ONCE: "1" } }, async (h) => {
    let start = h.chat("one"); await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    assert.equal(h.tab().leaderUsage.contextWindow, null, "the failed read leaves this turn's window unknown");
    start = h.chat("two"); await h.wait(() => h.turnEnded(start).length === 1, "second turn");
    assert.equal(h.tab().leaderUsage.contextWindow, 200000, "the next turn read it again");
    assert.equal(h.cliEntries().filter((e) => e.path === "/config/providers").length, 2);
  });
});

test("OpenCode leader: per-message memory is bounded (the oldest parts and message ids are forgotten, the newest kept)", { timeout: 90000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ flood: 4300 }, { say: "end" }));
    await h.wait(() => h.turnEnded(start).length === 1, "flood turn", 30000);
    // "end" is said in another text part than [NEWEST]: pack 14 puts a paragraph break between separate parts.
    assert.equal(h.deltas(start), "[NEWEST]\n\nend", "the oldest part id was forgotten, the newest is still known");
  });
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat(script({ floodMessages: 4100 }));
    await h.wait(() => h.turnEnded(start).length === 1, "message flood turn", 30000);
    const cost = h.tab().leaderUsage.costUsd;
    assert.ok(Math.abs(cost - (4100 * 0.001 + 0.001 + 0.25)) < 1e-6, `the evicted first message is counted again, the kept last one is not: ${cost}`);
  });
});

test("Codex leader: an approval never shows the file changes of an earlier turn", { timeout: 60000 }, async () => {
  await withServer({ leader: CODEX_LEADER }, async (h) => {
    await h.action({ type: "setPermissionMode", tabId: TAB, mode: "ask" });
    let start = h.chat(script({ fileChange: "two" }));
    await h.wait(() => h.pending().length === 1 && h.pending()[0].tool === "Edit", "file approval, first turn");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: true });
    await h.wait(() => h.turnEnded(start).length === 1, "first turn done"); await h.idle();
    start = h.chat(script({ raw: { method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "$turn", itemId: "f1", reason: "again" } } }));
    await h.wait(() => h.pending().length === 1, "second approval");
    assert.doesNotMatch(h.pending()[0].summary, /a\.txt|SECOND-FILE-TEXT/, "item f1 belonged to the first turn; its changes are gone");
    await h.action({ type: "answerApproval", tabId: TAB, approvalId: h.pending()[0].approvalId, allow: false });
    await h.wait(() => h.turnEnded(start).length === 1, "second turn done");
  });
});
