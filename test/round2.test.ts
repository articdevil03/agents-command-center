import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync, readdirSync, mkdirSync, realpathSync, statSync, rmSync, rmdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, lstat, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { runInNewContext } from "node:vm";
import * as path from "node:path";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import * as security from "../server/security.ts";
import * as usage from "../server/usage.ts";
import * as stall from "../server/stall.ts";
import * as history from "../server/history.ts";
import * as processEngine from "../server/process.ts";
import { ChatStore, chatMessageEvent, chatRequestErrorDetails, isTabSlug, readChatRequestId } from "../server/chat-store.ts";
import { createTestCliRunner } from "../server/test-cli-runner.ts";
import { isSafeRequestId } from "../server/chat-store.ts";
import { RequestsStore } from "../server/requests.ts";
import { createFolderActivity, relatedFolders } from "../server/folder-activity.ts";
import { SettingsService, permissionModeForSdk } from "../server/settings.ts";
import * as agentUsage from "../server/agent-usage.ts";
import * as leaderCommon from "../server/leader-common.ts";
import * as changesApi from "../server/changes.ts";
import { leaderChildEnv, withResolvedCli, isInsideFolder, isFullyQualified, setCliSkipFolders, windowsTaskkillPath, resolveCliOrThrow, leaderKindOf, USER_DENIED } from "../server/leader-common.ts";
import { keepBadCopy } from "../server/safe-file.ts";
import { fakeCliOnPath, importWithTempDataRoot, scratchDir, tempRoot, newAppKey } from "./temp-root.ts";
import { actionClient } from "./action-client.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

fakeCliOnPath();

// The server modules that read their data root at import (config.ts and everything importing it) are loaded on a fresh temp folder, never on
// the repo's own (live) config/. Every path the tests hand them is explicit and inside their own temp roots.
const { dataDir: moduleDataDir, modules: { config, leaderApi, createCodexLeader, createOpencodeLeader, createAcpLeader, createLeaderBridge, buildLeaderToolSpecs } } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"),
  leaderApi: await import("../server/leader.ts"),
  createCodexLeader: (await import("../server/leader-codex.ts")).createCodexLeader,
  createOpencodeLeader: (await import("../server/leader-opencode.ts")).createOpencodeLeader,
  createAcpLeader: (await import("../server/leader-acp.ts")).createAcpLeader,
  createLeaderBridge: (await import("../server/leader-bridge.ts")).createLeaderBridge,
  buildLeaderToolSpecs: (await import("../server/leader-tools.ts")).buildLeaderToolSpecs,
}));

test("this file's config module keeps its files in a temp data folder, never in the repo's config/", () => {
  assert.equal(path.dirname(path.dirname(config.workspacesPath)).toLowerCase(), moduleDataDir.toLowerCase());
  assert.equal(path.dirname(path.dirname(config.clientPrefsPath)).toLowerCase(), moduleDataDir.toLowerCase());
});

function fixtureCrew(kind: processEngine.ProcessKind, processId: processEngine.ProcessId) {
  return processEngine.getProcessDefinition(kind, processId).seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort }));
}
function fixtureWorkspaces() {
  return { projects: [
    { id: "alpha", name: "Alpha", folder: "C:/work/alpha", tabs: [
      { id: "alpha-dev", name: "Development", kind: "dev", process: "main", folder: "C:/work/alpha", crew: fixtureCrew("dev", "main") },
      { id: "alpha-design", name: "Design", kind: "design", process: "main", folder: "C:/work/alpha/design", crew: fixtureCrew("design", "main") },
      { id: "alpha-marketing", name: "Marketing", kind: "mkt", process: "main", folder: "C:/work/alpha/marketing", crew: fixtureCrew("mkt", "main") },
    ] },
    { id: "beta", name: "Beta", folder: "C:/work/beta", tabs: [
      { id: "beta-dev", name: "Development", kind: "dev", process: "main", folder: "C:/work/beta", crew: fixtureCrew("dev", "main") },
    ] },
  ] };
}
function tempWorkspaceFolders() {
  const root = tempRoot();
  const workspaces = fixtureWorkspaces();
  for (const project of workspaces.projects) for (const tab of project.tabs) {
    tab.folder = path.join(root, tab.id);
    mkdirSync(tab.folder, { recursive: true });
  }
  return workspaces;
}
const source = stripTypeScriptTypes(readFileSync("server/index.ts", "utf8"))
  .replace(/^import\s+(?:.|\r?\n)*?from\s+["'][^"']+["'];\r?\n/gm, "")
  .replaceAll("import.meta.url", '"file:///server/index.ts"');

async function loadServer(options: { relaunchable?: boolean; failSafety?: () => boolean; onSafetyWrite?: (value: config.LaunchSafety) => void; skipHealth?: boolean; leaderDelayMs?: number; hangLeader?: boolean; hangTab?: string; hangSave?: boolean; failSave?: boolean; writeHandover?: boolean; safetyPath?: string; deferKill?: boolean; rejectNextRun?: boolean; query?: (args: any) => any; healthTimeoutMs?: number; readdir?: typeof readdir; console?: Console; releaseUnconfirmed?: (runId: string) => boolean; workspaces?: any; leaderDead?: boolean; setModelResult?: boolean; setPermissionResult?: boolean; deferFirstPermission?: boolean; usageDelta?: any; realLeaderOptions?: boolean; sdkLeader?: (args: any) => any; stat?: typeof stat; now?: () => number; leaderSeamOnly?: boolean; bothSeams?: boolean; gitChanges?: (folder: string) => Promise<any>; runCli?: any; seatCapability?: () => boolean; claudeCli?: string; preload?: (testRoot: string) => void; failWorkspaceWrite?: () => boolean; createLeaderThrows?: boolean; opencodeThrows?: boolean; failAssistantAppend?: boolean; neverListen?: boolean; writeFile?: typeof writeFile } = {}) {
  const testRoot = tempRoot();
  mkdirSync(path.join(testRoot, "server"), { recursive: true });
  mkdirSync(path.join(testRoot, "logs"), { recursive: true });
  options.preload?.(testRoot);
  let savedWorkspaces = options.workspaces ?? fixtureWorkspaces();
  const safetyPath = options.safetyPath ?? path.join(testRoot, "launch-safety.json");
  let safety = config.readLaunchSafety(safetyPath);
  const launched: Array<{ run: any; prompt: string; callback: any }> = [];
  const active = new Map<string, { run: any; callback: any }>();
  const kills: string[] = [];
  const runnerProcesses = new Map<string, any>();
  const pidRuns = new Map<number, string>();
  let currentLaunchRunId: string | undefined;
  let nextPid = 9200;
  const fakeSpawn = (command: string, argsOrOptions: any, _options?: any) => {
    if (command === "taskkill") {
      const args = argsOrOptions as string[];
      const pid = Number(args[1]);
      const runId = pidRuns.get(pid);
      if (runId) kills.push(runId);
      if (!options.deferKill) runnerProcesses.get(runId ?? "")?.emit("close", 1);
      return isolatedRunnerProc(0);
    }
    const proc = isolatedRunnerProc(nextPid++);
    if (currentLaunchRunId) {
      runnerProcesses.set(currentLaunchRunId, proc);
      pidRuns.set(proc.pid, currentLaunchRunId);
    }
    return proc;
  };
  const realRunner = loadRunnerHarness({ testRoot, spawn: fakeSpawn });
  const leaderDeps = new Map<string, any>();
  const leaderCreates: Array<{ settings: any; folder: string; cliPath: string | null }> = [];
  const leaderToolOptions: any[] = [];
  const leaderHandles: Array<{ modelCalls: string[]; permissionCalls: string[]; stopCalls: number; callbacks: any; resolvePermission?: (result: boolean) => void }> = [];
  const leaderModes: string[] = [];
  let firstPermissionDeferred = false;
  const chats: Array<{ tabId: string; text: string }> = [];
  const processHandlers: Record<string, (...args: any[]) => void> = {};
  const prefWrites: Array<{ value: any; onlyIfMissing: boolean }> = [];
  const detailReads: string[] = [];
  const noteReads: string[] = [];
  const noteTabs: string[] = [];
  let listenCalls = 0, listenedPort: number | undefined;
  let saveActive = 0, maxSaveActive = 0;
  let queryCount = 0;
  const server = new EventEmitter() as any;
  const exitCodes: Array<number | undefined> = [];
  server.listen = (port: number, _host: string, callback: () => void) => { listenCalls++; listenedPort = port; server.address = () => ({ port }); if (!options.neverListen) callback(); };
  server.close = (callback?: () => void) => callback?.();
  const wss = new EventEmitter() as any;
  wss.close = () => {};
  const ticks: Array<() => void> = [];
  const setIntervalStub = (fn: () => void) => { ticks.push(fn); return { unref() {} }; };
  let rejectNextRun = options.rejectNextRun === true;
  let throwNextRun = false;
  const runSeatReal = (run: any, prompt: string, callback: any) => {
    if (rejectNextRun) { rejectNextRun = false; return { ok: false, error: "injected runner refusal" }; }
    if (throwNextRun) { throwNextRun = false; throw new Error("injected runner crash"); }
    if (active.has(run.runId)) return { ok: false, error: "duplicate run id" };
    const entry = { run: { ...run }, callback };
    const wrapped = { ...callback, onStatus: (startedRun: any, status: string, code?: number) => {
      if (status === "working") active.set(run.runId, entry);
      else active.delete(run.runId);
      callback.onStatus(startedRun, status, code);
    } };
    currentLaunchRunId = run.runId;
    let result: any;
    try { result = realRunner.runSeat(run, prompt, wrapped); }
    finally { currentLaunchRunId = undefined; }
    if (result.ok) launched.push({ run: entry.run, prompt, callback });
    return result;
  };
  const killRunReal = (runId: string) => realRunner.killRun(runId);
  const createLeaderStub = (settings: any, folder: string, cliPath: string | null, callbacks: any, tools?: any, mode = "accept") => {
    leaderToolOptions.push(tools);
    const handle = { modelCalls: [] as string[], permissionCalls: [] as string[], stopCalls: 0, dead: options.leaderDead ?? false, callbacks, resolvePermission: undefined as ((result: boolean) => void) | undefined };
    leaderHandles.push(handle);
    leaderCreates.push({ settings: { ...settings }, folder, cliPath });
    leaderModes.push(mode);
    return {
      send: (text: string, _images: string[]) => {
        const tabId = folder.includes("beta") ? "beta-dev" : folder.includes("design") ? "alpha-design" : "alpha-dev";
        chats.push({ tabId, text });
        const isSave = text.startsWith("Save a concise handover");
        if (isSave) { saveActive++; maxSaveActive = Math.max(maxSaveActive, saveActive); }
        if ((options.hangLeader && (!options.hangTab || options.hangTab === tabId)) || (isSave && options.hangSave)) return;
        if (isSave && options.writeHandover && !options.failSave) {
          const pathStart = text.indexOf(" to ") + 4;
          const pathEnd = text.indexOf(". Include current decisions", pathStart);
          const handoverPath = pathStart >= 4 && pathEnd > pathStart ? text.slice(pathStart, pathEnd) : "";
          if (!handoverPath) { callbacks.onError("Save prompt did not contain a handover path"); return; }
          mkdirSync(path.dirname(handoverPath), { recursive: true });
          writeFileSync(handoverPath, "test handover", "utf8");
          const changed = new Date(Date.now() + 1000);
          utimesSync(handoverPath, changed, changed);
        }
        setTimeout(() => {
          if (isSave) saveActive--;
          if (isSave && options.failSave) { callbacks.onError("injected Save failure"); return; }
          callbacks.onDelta(isSave ? "handover saved" : `answer:${text}`);
          if (options.usageDelta) callbacks.onUsage(options.usageDelta);
          callbacks.onDone();
        }, options.leaderDelayMs ?? 2);
      },
      getPermissionMode: () => permissionModeForSdk(mode), stop: () => { handle.stopCalls++; handle.dead = true; }, isDead: () => handle.dead, setModel: async (model: string) => { handle.modelCalls.push(model); return options.setModelResult ?? true; },
      setPermissionMode: async (nextMode: string) => {
        handle.permissionCalls.push(nextMode);
        if (options.deferFirstPermission && !firstPermissionDeferred) {
          firstPermissionDeferred = true;
          return await new Promise<boolean>((resolvePermission) => { handle.resolvePermission = resolvePermission; });
        }
        if (options.setPermissionResult !== false) mode = nextMode;
        return options.setPermissionResult ?? true;
      },
    };
  };
  const readPrefsPath = path.join(testRoot, "client-prefs.json");
  const testEnv: NodeJS.ProcessEnv = {
    CC_DATA_DIR: testRoot,
    HOME: path.join(testRoot, "home"),
    USERPROFILE: path.join(testRoot, "home"),
    CC_TEST_FAKE_CLI: "1",
    CC_PORT: "0",
    CC_APP_KEY: newAppKey(),
    CC_SKIP_DISCOVERY: "1",
    ...(options.skipHealth ? { CC_SKIP_LEADER_CHECK: "1" } : {}),
  };
  // The test-seam gate needs BOTH flags: leaderSeamOnly keeps the fake CLI runner but hides that flag from the server source.
  const runnerEnv = { ...testEnv };
  if (options.leaderSeamOnly || options.bothSeams) testEnv.CC_TEST_FAKE_LEADER = "1";
  if (options.leaderSeamOnly) delete testEnv.CC_TEST_FAKE_CLI;
  const testPathExists = (value: string) => /^C:[\\/]work(?:[\\/]|$)/i.test(value);
  const dependencies = {
    ...path,
    ...config,
    ...security,
    ...usage,
    ...stall,
    ...history,
    ...processEngine,
    getProcessDefinition: (kind: any, id: any) => { const definition = processEngine.getProcessDefinition(kind, id); return options.seatCapability ? { ...definition, seats: definition.seats.map((seat: any) => seat.slotId === "coder" ? { ...seat, canWrite: options.seatCapability!() } : seat) } : definition; },
    Buffer, URL, AbortController, EventEmitter, randomUUID, randomBytes, timingSafeEqual, console: options.console ?? console,
    setTimeout, clearTimeout, setInterval: setIntervalStub, clearInterval: () => {},
    fileURLToPath: () => path.join(testRoot, "server", "index.ts"),
    readWorkspaces: () => JSON.parse(JSON.stringify(savedWorkspaces)),
    writeWorkspaces: (value: unknown) => { if (options.failWorkspaceWrite?.()) throw new Error("workspace disk failed"); savedWorkspaces = JSON.parse(JSON.stringify(value)); },
    readClientPrefs: () => ({ ...config.DEFAULT_CLIENT_PREFS }),
    writeClientPrefs: (value: unknown, _path?: string, onlyIfMissing = false) => {
      prefWrites.push({ value: JSON.parse(JSON.stringify(value)), onlyIfMissing });
      return config.writeClientPrefs(value as config.ClientPrefs, readPrefsPath, onlyIfMissing);
    },
    readLaunchSafety: () => safety,
    writeLaunchSafety: (value: config.LaunchSafety) => {
      if (options.failSafety?.()) throw new Error("safety disk failed");
      options.onSafetyWrite?.(JSON.parse(JSON.stringify(value)));
      config.writeLaunchSafety(value, safetyPath);
      safety = JSON.parse(JSON.stringify(value));
      return true;
    },
    clientPrefsPath: readPrefsPath,
    resolveDataRoot: (_env: unknown, _root: string) => testRoot,
    existsSync: (file: string) => { try { return readFileSync(file) !== undefined; } catch { return false; } },
    mkdir, readFile, readdir: options.readdir ?? readdir, readdirSync, stat: options.stat ?? stat, lstat, realpath, unlink, writeFile: options.writeFile ?? writeFile,
    ...(options.now ? { Date: class extends Date { static now() { return options.now!(); } } } : {}),
    createServer: () => server,
    WebSocketServer: function () { return wss; },
    WebSocket: { OPEN: 1 },
    setAllowedPort: () => {},
    query: (args: any) => {
      queryCount++;
      return options.query ? options.query(args) : { [Symbol.asyncIterator]: async function* () { yield { type: "result" }; }, return: async () => ({ done: true }) };
    },
    resolveClaudeCli: () => options.claudeCli ?? null,
    isInsideFolder, setCliSkipFolders, windowsTaskkillPath, resolveCliOrThrow, leaderKindOf, keepBadCopy, USER_DENIED,
    // The start-up orphan sweep reads the real process list: the start-up test for it is in pack2-server.test.ts, through a real server.
    sweepOrphans: async () => ({ checked: 0, killed: 0 }),
    buildLeaderOptions: options.realLeaderOptions ? leaderApi.buildLeaderOptions : (settings: any, folder: string) => ({ model: settings.model, cwd: folder, settingSources: ["user", "project", "local"] }),
    createLeader: options.createLeaderThrows ? () => { throw new Error("leader could not start"); } : options.sdkLeader ? loadLeaderHarness(options.sdkLeader) : createLeaderStub,
    createLeaderTools: (deps: any) => { leaderDeps.set(deps.tabName, deps); return { deps }; },
    createCodexLeader, createAcpLeader, createOpencodeLeader: options.opencodeThrows ? () => { throw new Error("opencode could not start"); } : createOpencodeLeader, createLeaderBridge, buildLeaderToolSpecs,
    LEADER_ALLOWED_TOOLS: ["get_crew_status", "launch_seat", "send_request", "list_requests"],
    runSeat: runSeatReal,
    killRun: killRunReal,
    stopProcessSeat: processEngine.stopSeat,
    stopProcessAll: processEngine.stopAll,
    isRunning: realRunner.isRunning,
    isSeatRunning: realRunner.isSeatRunning,
    runIdsForSeat: realRunner.runIdsForSeat,
    stopAllRunning: realRunner.stopAllRunning,
    // The real canRunWrite counts every run as able to write (no CLI read-only mode is a safe boundary), so no real run is ever
    // relaunched by itself. "relaunchable" fakes a run that is not, only to keep the relaunch machinery itself under test.
    canRunWrite: options.relaunchable ? () => false : realRunner.canRunWrite,
    // A test that fakes the runner's release (releaseUnconfirmed) fakes what the server checks before releasing too: the same answer.
    unconfirmedPid: options.releaseUnconfirmed ? (runId: string) => (options.releaseUnconfirmed!(runId) ? 1 : undefined) : realRunner.unconfirmedPid,
    releaseUnconfirmedRun: options.releaseUnconfirmed ?? realRunner.releaseUnconfirmedRun,
    logsDir: realRunner.logsDir,
    ChatStore: options.failAssistantAppend ? class extends ChatStore { appendMessage(tabId: string, role: any, ...rest: any[]) { if (role === "assistant") throw new Error("chat disk failed"); return (super.appendMessage as any)(tabId, role, ...rest); } } : ChatStore,
    SettingsService,
    RequestsStore,
    // This harness runs the server with fake runs and a made-up clock: it never reads the tools' real records or watches a folder (pack9-folder-activity.test.ts covers that through real servers).
    createFolderActivity: (given: any) => createFolderActivity({ ...given, home: null }),
    relatedFolders,
    createTestCliRunner: () => options.runCli ?? createTestCliRunner(runnerEnv),
    readGitChanges: async (folder: string) => { detailReads.push(folder); if (options.gitChanges) return options.gitChanges(folder); return { repo: false, branch: null, ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [] }; },
    handoverPath: changesApi.handoverPath, legacyHandoverPath: changesApi.legacyHandoverPath,
    // Like the real reader the notes belong to a tab: a call that leaves the tab id out gets nothing.
    readTabNotes: async (folder: string, tabId?: string) => { noteReads.push(folder); noteTabs.push(String(tabId)); return { path: null, content: tabId ? `notes of ${tabId}` : "", truncated: false }; },
    chatMessageEvent,
    chatRequestErrorDetails,
    isTabSlug,
    isSafeRequestId,
    readChatRequestId,
    process: { env: testEnv, connected: true, send: () => {}, on: (event: string, handler: (...args: any[]) => void) => { processHandlers[event] = handler; }, exit: (code?: number) => { exitCodes.push(code); } },
    realpathSync: (value: string) => testPathExists(value) ? value : realpathSync(value),
    statSync: (value: string) => testPathExists(value) ? { isDirectory: () => true, isFile: () => false } : statSync(value),
    permissionModeForSdk,
    leaderCheckTimeout: options.healthTimeoutMs ?? 100,
  };
  const result = await runInNewContext(`(async () => { ${source}
    return { wss, server, handleMessage, stateMessage, broadcast, leaders, tabs, runContexts, launchSafety, leaderHealthCheck, settingsService, requestsStore,
      activeLeaderTurns, pendingHandoverReads, pendingClearUndos, expiredClearUndos, pendingRelaunch, runOutput, runUsage, userKilledRuns, stallKillRuns, isRunning,
      cleanScratch, scratchDir, stallTrackers, leaderLaunch, launchWorker, listHistory, getQueue: () => Promise.all([...chatOperationQueues.values()]), unconfirmedRunIds, pendingApprovals, leaderInstances, gatedLeaderLaunch, savingTabs, approvalSummary,
      chatStore, leaderSeats, leaderBridge, queuedLeaderChanges, blockedSeatKeys, requestActions };
  })()`, dependencies);
  return { ...result, testRoot, exitCodes, getWorkspaces: () => JSON.parse(JSON.stringify(savedWorkspaces)), launched, active, kills, runnerProcesses, leaderDeps, leaderCreates, leaderHandles, leaderModes, leaderToolOptions, chats, processHandlers, prefWrites, detailReads, noteReads, noteTabs, listenCalls: () => listenCalls, listenedPort: () => listenedPort, queryCount: () => queryCount, maxSaveActive: () => maxSaveActive, safety: () => safety, rejectRun: () => { rejectNextRun = true; }, throwRun: () => { throwNextRun = true; }, closeRun: (runId: string, code = 1) => runnerProcesses.get(runId)?.emit("close", code), emitOutput: (runId: string, text: string, stream: "stdout" | "stderr" = "stdout") => runnerProcesses.get(runId)?.[stream]?.emit("data", Buffer.from(text)), tick: () => ticks[0](), tickResync: () => ticks[1](), flush: () => Promise.resolve(result.getQueue()) };
}

function loadRunnerHarness(options: { testRoot?: string; spawn?: (command: string, argsOrOptions: any, options?: any) => any } = {}) {
  const testRoot = options.testRoot ?? tempRoot();
  mkdirSync(path.join(testRoot, "server"), { recursive: true });
  mkdirSync(path.join(testRoot, "logs"), { recursive: true });
  const runnerSource = stripTypeScriptTypes(readFileSync("server/runner.ts", "utf8"))
    .replace(/^import\s+(?:.|\r?\n)*?from\s+["'][^"']+["'];\r?\n/gm, "")
    .replaceAll("import.meta.url", '"file:///server/runner.ts"')
    .replaceAll("export ", "");
  const module = runInNewContext(`(() => { ${runnerSource}\n const optional = (name) => { try { return eval(name); } catch { return undefined; } };
 return { buildCommand, runSeat, killRun, killRunAndConfirm: optional("killRunAndConfirm"), isRunning, isSeatRunning: optional("isSeatRunning"), runIdsForSeat, canRunWrite, unconfirmedPid, releaseUnconfirmedRun, stopAllRunning, logsDir }; })()`, {
    ...path, mkdirSync, writeFileSync, appendFileSync, Buffer, StringDecoder, spawn: options.spawn ?? (() => isolatedRunnerProc(0)),
    fileURLToPath: () => path.join(testRoot, "server", "runner.ts"), process: { env: { CC_DATA_DIR: "C:/never-open-this", CC_TEST_FORCE_PACKAGED: "1" } },
    isValidModel: config.isValidModel, isValidEffort: config.isValidEffort, formatExitMarker: history.formatExitMarker,
    // Everything the runner imports from leader-common reaches the loaded source whole (new exports included); the fake pids here name no real process tree, so none is watched.
    resolveDataRoot: () => testRoot, ...agentUsage, ...leaderCommon, watchProcessTree: () => null, leaderChildEnv, withResolvedCli, isInsideFolder, setTimeout, clearTimeout, console,
  }) as any;
  return { ...module, testRoot };
}

function isolatedRunnerProc(pid = 9123) {
  return Object.assign(new EventEmitter(), { pid, stdout: new EventEmitter(), stderr: new EventEmitter() }) as any;
}
function isolatedRunnerCapture() {
  const events: any[] = [];
  return { events, callbacks: {
    onOutput: (_run: any, text: string) => events.push({ type: "output", text }),
    onStatus: (_run: any, status: string, code?: number) => events.push({ type: "status", status, code }),
    onUsage: (_run: any, usage: any) => events.push({ type: "usage", usage }),
    onRateLimit: (windows: any) => events.push({ type: "rateLimit", windows }),
    onUnconfirmedKill: (_run: any, pid?: number) => events.push({ type: "unconfirmed", pid }),
  } };
}
function isolatedRun(overrides: any = {}) {
  return { runId: "isolated-run", seatKey: "alpha-tab.reviewer", slotId: "reviewer", name: "Vera", cli: "claude", model: "claude-opus-5-5[1m]", effort: "medium", folder: "C:/work/alpha", canWrite: false, startedAt: Date.now(), ...overrides };
}
function startIsolatedRunner(harness: any, run: any, prompt: string, capture: any, proc: any) {
  const result = harness.runSeat(run, prompt, capture.callbacks, ((_command: string, _options: any) => proc) as any);
  if (!result.ok) throw new Error(result.error);
  return result.timestamp;
}

function connect(server: any) {
  const ws = new EventEmitter() as any;
  ws.OPEN = ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.messages = [];
  ws.send = (raw: string) => ws.messages.push(JSON.parse(raw));
  server.wss.emit("connection", ws);
  ws.message = (message: unknown) => ws.emit("message", Buffer.from(typeof message === "string" ? message : JSON.stringify(message)));
  return ws;
}
function lastState(ws: any) { return [...ws.messages].reverse().find((message: any) => message.type === "state"); }
// A test that fails part-way leaves its leader turns running; they write to the chat store after the file is done and re-create its folder. A finally waits them out.
async function settleLeaderTurns(...servers: any[]) {
  for (const server of servers) {
    await waitFor(() => server.activeLeaderTurns.size === 0, "the leader turns settle", 3_000).catch(() => {});
    await server.getQueue();
  }
}
async function tick(ms = 20) { await new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
async function waitFor(check: () => boolean, description: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await tick(10);
  }
}
async function flushMicrotasks(rounds = 12) { for (let i = 0; i < rounds; i++) await Promise.resolve(); }
function loadLeaderHarness(query: (args: any) => any, env: Record<string, string> = {}) {
  const leaderSource = stripTypeScriptTypes(readFileSync("server/leader.ts", "utf8"))
    .replace(/^import\s+(?:.|\r?\n)*?from\s+["'][^"']+["'];\r?\n/gm, "")
    .replaceAll("export function", "function");
  return runInNewContext(`${leaderSource}; createLeader`, {
    ...path, ...leaderCommon, isInsideFolder, isFullyQualified, leaderChildEnv, homedir,
    process: { env },
    AbortController,
    readFileSync,
    randomUUID,
    IMAGE_EXT_TO_MIME: config.IMAGE_EXT_TO_MIME,
    usageDeltaFromResult: usage.usageDeltaFromResult,
    permissionModeForSdk,
    query,
  }) as (settings: { model: string; effort: string }, folder: string, cliPath: string | null, callbacks: any, tools?: any, mode?: string) => any;
}

test("hello sends projects -> tabs -> crew and does not create a leader; chat lazily creates one in the tab folder", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "hello" });
  const state = lastState(ws);
  assert.equal(state.projects[0].tabs[0].crew.length, 6);
  assert.equal(state.projects[0].tabs[0].processState.tabId, "alpha-dev");
  assert.equal(server.leaders.size, 0, "hello must not start any per-tab leader");
  ws.message({ type: "chat", tabId: "alpha-design", text: "Design this" });
  await tick();
  assert.equal(server.leaders.size, 1);
  assert.deepEqual(server.leaderCreates[0], { settings: { model: "claude-opus-5-5[1m]", effort: "high" }, folder: "C:/work/alpha/design", cliPath: null });
  assert.ok(ws.messages.some((message: any) => message.type === "chatMessage" && message.tabId === "alpha-design" && message.role === "assistant"));
  assert.equal(lastState(ws).projects[0].tabs[1].chatRevision, 2);
});

test("a damaged settings file: the first page is told once, and the tabs ask", async () => {
  const server = await loadServer({ skipHealth: true, preload: (root) => writeFileSync(path.join(root, "settings.json"), "{not json") });
  const ws = connect(server);
  ws.message({ type: "hello" }); ws.message({ type: "hello" });
  const told = ws.messages.filter((message: any) => message.type === "error" && /damaged/.test(message.message));
  assert.equal(told.length, 1, "told once, not on every hello");
  assert.ok(lastState(ws).projects[0].tabs.every((tab: any) => tab.permissionMode === "ask"), "every tab without a saved mode asks");
});

test("the startup health check runs once and hello never starts another check or leader", async () => {
  const server = await loadServer();
  const ws = connect(server);
  ws.message({ type: "hello" }); ws.message({ type: "hello" });
  await tick();
  assert.equal(server.queryCount(), 1);
  assert.equal(server.leaders.size, 0);
});

test("real tab leader SDK options use the tab folder and load user, project, and local settings", () => {
  let sdkOptions: any;
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }) };
  const createLeader = loadLeaderHarness((args) => { sdkOptions = args.options; return handle; });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work/alpha/design", null, {
    onDelta() {}, onDone() {}, onUsage() {}, onError() {},
  });
  try {
    assert.equal(sdkOptions.cwd, "C:/work/alpha/design");
    assert.deepEqual([...sdkOptions.settingSources], ["user", "project", "local"]);
  } finally { instance.stop(); }
});

test("stopping a tab leader settles its pending input, aborts the SDK, and ignores late output", async () => {
  let input: any, sdkOptions: any, resolveOutput: ((value: any) => void) | undefined, returns = 0;
  const events: string[] = [];
  const handle = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise((resolve) => { resolveOutput = resolve; }),
    return: async () => { returns++; resolveOutput?.({ done: true }); return { done: true }; },
  };
  const createLeader = loadLeaderHarness((args) => { input = args.prompt; sdkOptions = args.options; return handle; });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work/alpha/design", null, {
    onDelta: (text: string) => events.push(text), onDone: () => events.push("done"), onUsage: () => {}, onError: (error: string) => events.push(error),
  });
  await tick(0);
  const waiting = input.next();
  instance.stop();
  const settled = await Promise.race([waiting, tick(100).then(() => "timeout")]);
  assert.notEqual(settled, "timeout");
  assert.equal(settled.done, true);
  assert.equal(sdkOptions.abortController.signal.aborted, true);
  resolveOutput?.({ done: false, value: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "late" } } } });
  await tick(0);
  assert.equal(returns, 1);
  assert.deepEqual(events, []);
});

test("live leader model changes use the SDK handle and scope later usage to the new model", async () => {
  let resolveOutput: ((value: any) => void) | undefined;
  const modelCalls: string[] = [];
  const usageEvents: any[] = [];
  const handle = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise((resolve) => { resolveOutput = resolve; }),
    return: async () => { resolveOutput?.({ done: true }); return { done: true }; },
    setModel: async (model: string) => { modelCalls.push(model); },
  };
  let queryCount = 0;
  const createLeader = loadLeaderHarness(() => { queryCount++; return handle; });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work/alpha/design", null, {
    onDelta() {}, onDone() {}, onUsage: (delta: any) => usageEvents.push(delta), onError() {},
  });
  await tick(0);
  assert.equal(await instance.setModel("claude-opus-5"), true);
  resolveOutput?.({ done: false, value: { type: "result", total_cost_usd: 0.01, usage: { input_tokens: 9 }, modelUsage: { "claude-opus-5": { contextWindow: 200_000 } } } });
  await tick(0);
  assert.deepEqual(modelCalls, ["claude-opus-5"]);
  assert.equal(queryCount, 1, "changing the model must not restart the leader");
  assert.equal(usageEvents[0].modelId, "claude-opus-5");
  instance.stop();
});

test("runner call site derives write access from process slot definitions and allows concurrent same-seat runs", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer1", prompt: "review" });
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "code" });
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "second coder run" });
  assert.equal(server.launched.length, 3);
  assert.equal(server.launched[0].run.seatKey, "alpha-dev.reviewer1");
  assert.equal(server.launched[0].run.canWrite, false);
  assert.equal(server.launched[0].run.cli, "claude");
  assert.equal(server.launched[1].run.canWrite, true);
  assert.equal(server.launched[2].run.canWrite, true);
  assert.notEqual(server.launched[1].run.runId, server.launched[2].run.runId);
  assert.equal(lastState(ws).projects[0].tabs[0].runs.filter((run: any) => run.status === "working" && run.seatSlotId === "coder").length, 2);
});

test("killRun stops only its run id and emits a real run stop event", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "one" });
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "two" });
  const [first, second] = server.launched.map((entry: any) => entry.run.runId);
  ws.message({ type: "killRun", runId: first });
  assert.deepEqual(server.kills, [first]);
  assert.equal(server.active.has(first), false);
  assert.equal(server.active.has(second), true);
  assert.ok(ws.messages.some((message: any) => message.type === "runStop" && message.runId === first));
  assert.ok(ws.messages.some((message: any) => message.type === "killAccepted" && message.runId === first), "the kill is acknowledged with its run id");
  assert.equal(ws.messages.some((message: any) => message.type === "killAccepted" && message.runId === second), false, "and only that run id");
});

test("old and new log ids remain valid history queries without requiring a current roster entry", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "historyList", seatKey: "removed-old-seat" });
  await tick();
  const answer = ws.messages.find((message: any) => message.type === "historyList");
  assert.deepEqual(answer.runs, []);
  ws.message({ type: "historyList", seatKey: "../escape" });
  await tick();
  assert.match(ws.messages.findLast((message: any) => message.type === "error").message, /invalid seat key/);
});

test("tab ids are globally unique and removal enforces last-tab and busy guards", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "hello" });
  ws.message({ type: "removeTab", tabId: "beta-dev" });
  assert.match(ws.messages.at(-1).message, /last tab/);
  ws.message({ type: "addTab", projectId: "beta", tabId: "beta-review", kind: "dev", process: "duo", name: "Review" });
  ws.message({ type: "addTab", projectId: "alpha", tabId: "beta-review", kind: "dev", process: "main" });
  assert.match(ws.messages.at(-1).message, /invalid or duplicate tab id/);
  ws.message({ type: "run", tabId: "beta-review", slot: "coder", prompt: "work" });
  ws.message({ type: "removeTab", tabId: "beta-review" });
  assert.match(ws.messages.at(-1).message, /busy/);
});

test("removeTab stops no busy worker and succeeds only after it has closed", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "addTab", projectId: "beta", tabId: "beta-review", kind: "dev", process: "duo", name: "Review" });
  ws.message({ type: "run", tabId: "beta-dev", slot: "coder", prompt: "work" });
  ws.message({ type: "removeTab", tabId: "beta-dev" });
  assert.match(ws.messages.at(-1).message, /busy/);
  const runId = server.launched[0].run.runId;
  ws.message({ type: "killRun", runId });
  ws.message({ type: "removeTab", tabId: "beta-dev" });
  assert.equal(lastState(ws).projects.find((project: any) => project.id === "beta").tabs.length, 1);
});

test("removing the selected tab sends the visible fallback tab's transcript", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  const chats = path.join(server.testRoot, "chats");
  mkdirSync(chats, { recursive: true });
  writeFileSync(path.join(chats, "alpha-dev.jsonl"), `${JSON.stringify({ type: "message", tabId: "alpha-dev", revision: 1, role: "assistant", text: "Development fallback transcript", at: 1 })}\n`);

  ws.message({ type: "hello" });
  ws.message({ type: "selectTab", tabId: "alpha-design" });
  assert.equal(lastState(ws).selectedTabId, "alpha-design");
  ws.message({ type: "removeTab", tabId: "alpha-design" });

  const visible = lastState(ws).selectedTabId;
  const fallbackHistory = ws.messages.findLast((message: any) => message.type === "chatHistory");
  assert.equal(visible, "alpha-dev");
  assert.equal(fallbackHistory?.tabId, visible);
  assert.equal(fallbackHistory?.messages?.[0]?.text, "Development fallback transcript");
});

test("busy leader turns block folder changes and project removal", async () => {
  const server = await loadServer({ skipHealth: true, hangLeader: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "active leader" });
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/new" });
  assert.match(ws.messages.at(-1).message, /tab is busy/);
  ws.message({ type: "removeProject", projectId: "alpha" });
  assert.match(ws.messages.at(-1).message, /busy project/);
  assert.equal(lastState(ws).projects.some((project: any) => project.id === "alpha"), true);
});

test("changeProjectFolder persists only the project default and supplies it to new tabs", async () => {
  const workspaces = fixtureWorkspaces();
  const originalFolders = workspaces.projects.find((project: any) => project.id === "alpha").tabs.map((tab: any) => tab.folder);
  const server = await loadServer({ skipHealth: true, workspaces }), ws = connect(server);
  ws.message({ type: "changeProjectFolder", projectId: "alpha", folder: "C:/work/alpha-default" });
  const updated = lastState(ws).projects.find((project: any) => project.id === "alpha");
  assert.equal(updated.folder, "C:/work/alpha-default");
  assert.deepEqual(updated.tabs.map((tab: any) => tab.folder), originalFolders);
  assert.equal(server.getWorkspaces().projects.find((project: any) => project.id === "alpha").folder, "C:/work/alpha-default", "the workspace write persisted the default");
  ws.message({ type: "addTab", projectId: "alpha", tabId: "alpha-default-folder", kind: "dev", process: "main" });
  assert.equal(lastState(ws).projects.find((project: any) => project.id === "alpha").tabs.find((tab: any) => tab.id === "alpha-default-folder").folder, "C:/work/alpha-default");
  ws.message({ type: "changeProjectFolder", projectId: "alpha", folder: " " });
  assert.match(ws.messages.at(-1).message, /folder is required/);
  ws.message({ type: "changeProjectFolder", projectId: "unknown", folder: "C:/work/other" });
  assert.match(ws.messages.at(-1).message, /unknown project/);
});

test("Settings default folder is saved with an id and supplies new projects", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "setDefaultProjectFolder", requestId: "global_folder_save", folder: server.testRoot });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "global_folder_save"), "default folder result");
  assert.equal(server.stateMessage().settings.folders.defaultProjectFolder, server.testRoot);
  ws.message({ type: "addProject", id: "globaldefault", name: "Uses Settings folder" });
  const project = server.stateMessage().projects.find((item: any) => item.id === "globaldefault");
  assert.equal(project.folder, server.testRoot);
  assert.equal(project.tabs[0].folder, server.testRoot);
});

test("Settings writes reject an unsafe request id before any action starts", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "installCli", requestId: "../unsafe", cli: "claude", confirm: true });
  const error = ws.messages.at(-1);
  assert.equal(error.type, "error");
  assert.match(error.message, /invalid request id/);
  assert.equal(error.requestId, undefined, "an unsafe id is never echoed");
  assert.equal(server.settingsService.state.tools.claude.action, undefined);
  assert.equal(Object.keys(server.stateMessage().requestActions).length, 0, "no action state exists for an unsafe id");
});

test("every Settings, permission, and request write rejects an unsafe request id before dispatch", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const messages = [
    { type: "installCli", cli: "claude", confirm: true },
    { type: "cliLogin", cli: "claude" },
    { type: "ghLogin" },
    { type: "setNotesVault", path: server.testRoot },
    { type: "setDefaultProjectFolder", folder: server.testRoot },
    { type: "mcpAdd", cli: "claude", name: "safe", commandOrUrl: "npx server" },
    { type: "mcpRemove", cli: "claude", name: "safe", confirm: true },
    { type: "pluginInstall", name: "helper@official" },
    { type: "pluginUninstall", name: "helper@official", confirm: true },
    { type: "setPermissionMode", tabId: "alpha-dev", mode: "plan" },
    { type: "sendRequest", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Review", body: "Please review." },
    { type: "resolveRequest", id: "00000000-0000-4000-8000-000000000001", status: "accepted" },
  ];
  for (const message of messages) {
    ws.message({ ...message, requestId: "../unsafe" });
    const error = ws.messages.at(-1);
    assert.equal(error.type, "error", `${message.type} was refused`);
    assert.match(error.message, /invalid request id/);
    assert.equal(error.requestId, undefined, `${message.type} did not echo an unsafe id`);
  }
  assert.equal(Object.keys(server.stateMessage().requestActions).length, 0);
  assert.equal(server.requestsStore.list().length, 0);
  assert.equal(server.settingsService.state.vault.path, null);
  assert.equal(server.settingsService.permissionMode("alpha-dev"), "accept");
});

test("CLI, GitHub, MCP, and plugin action refusals echo their safe request ids and finish failed", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const messages = [
    { type: "installCli", cli: "claude", confirm: true },
    { type: "cliLogin", cli: "claude" },
    { type: "ghLogin" },
    { type: "mcpAdd", cli: "claude", name: "safe", commandOrUrl: "npx server" },
    { type: "mcpRemove", cli: "claude", name: "safe", confirm: true },
    { type: "pluginInstall", name: "helper@official" },
    { type: "pluginUninstall", name: "helper@official", confirm: true },
  ];
  for (const [index, message] of messages.entries()) {
    const requestId = `settings_failure_${index}`;
    ws.message({ ...message, requestId });
    await waitFor(() => ws.messages.some((item: any) => item.type === "error" && item.requestId === requestId), `${message.type} refusal`);
    assert.equal(server.stateMessage().requestActions[requestId].status, "failed", `${message.type} state is server-owned`);
  }
});

test("a disconnected socket cannot turn a completed Settings write into a failed action", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.send = () => { throw new Error("socket closed during send"); };
  ws.message({ type: "setDefaultProjectFolder", requestId: "folder_disconnect", folder: server.testRoot });
  await waitFor(() => server.stateMessage().requestActions.folder_disconnect?.status === "done", "completed folder write");
  assert.equal(server.stateMessage().settings.folders.defaultProjectFolder, server.testRoot);
});

const notesOf = (server: any, tabId: string): string | undefined => server.stateMessage().projects.flatMap((project: any) => project.tabs).find((tab: any) => tab.id === tabId)?.notes?.content;

test("a completed leader turn refreshes its tab Changes and Notes snapshot", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  await tick();
  server.detailReads.length = 0;
  server.noteReads.length = 0;
  ws.message({ type: "chat", tabId: "alpha-dev", text: "finish and refresh" });
  await waitFor(() => server.detailReads.includes("C:/work/alpha"), "post-turn tab detail refresh");
  assert.ok(server.noteReads.includes("C:/work/alpha"), "the handover note is reread with git status");
  await waitFor(() => notesOf(server, "alpha-dev") === "notes of alpha-dev", "the note read for this tab's id reaches its state").catch(() => {});
  assert.equal(notesOf(server, "alpha-dev"), "notes of alpha-dev", "the note was read with this tab's id");
});

test("selecting a tab refreshes that tab's Changes and Notes snapshot", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  await tick();
  server.detailReads.length = 0;
  server.noteReads.length = 0;
  ws.message({ type: "selectTab", tabId: "beta-dev" });
  await waitFor(() => server.detailReads.includes("C:/work/beta"), "selected-tab git refresh");
  assert.ok(server.noteReads.includes("C:/work/beta"), "the selected tab handover note is reread");
  await waitFor(() => notesOf(server, "beta-dev") === "notes of beta-dev", "the note read for this tab's id reaches its state").catch(() => {});
  assert.equal(notesOf(server, "beta-dev"), "notes of beta-dev", "the note was read with this tab's id");
});

test("a finished worker refreshes its tab's Changes and Notes snapshot", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "finish and refresh" });
  const runId = server.launched[0].run.runId;
  server.detailReads.length = 0;
  server.noteReads.length = 0;
  server.closeRun(runId, 0);
  await waitFor(() => server.detailReads.includes("C:/work/alpha"), "finished-worker git refresh");
  assert.ok(server.noteReads.includes("C:/work/alpha"), "the finished worker handover note is reread");
  await waitFor(() => notesOf(server, "alpha-dev") === "notes of alpha-dev", "the note read for this tab's id reaches its state").catch(() => {});
  assert.equal(notesOf(server, "alpha-dev"), "notes of alpha-dev", "the note was read with this tab's id");
});

test("the last workspace project cannot be removed", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "removeProject", projectId: "beta" });
  assert.equal(lastState(ws).projects.length, 1);
  ws.message({ type: "removeProject", projectId: "alpha" });
  assert.match(ws.messages.at(-1).message, /last project/);
  assert.equal(lastState(ws).projects[0].id, "alpha");
});

test("run snapshots its tab folder and an idle leader restarts after the folder changes", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-design", slot: "designer", prompt: "design work" });
  const run = server.launched[0].run;
  assert.equal(run.folder, "C:/work/alpha/design");
  assert.equal(ws.messages.find((message: any) => message.type === "runStart" && message.runId === run.runId).folder, run.folder);
  ws.message({ type: "changeFolder", tabId: "alpha-design", folder: "C:/work/new-design" });
  assert.match(ws.messages.at(-1).message, /tab is busy/);
  server.closeRun(run.runId, 0);
  ws.message({ type: "chat", tabId: "alpha-design", text: "start old-folder leader" });
  await tick();
  const oldLeader = server.leaders.get("alpha-design");
  ws.message({ type: "changeFolder", tabId: "alpha-design", folder: "C:/work/new-design" });
  assert.equal(oldLeader === server.leaders.get("alpha-design"), false);
  assert.equal(server.leaders.has("alpha-design"), false, "no leader runs in the new folder until the next message (its project hooks never run unasked)");
  ws.message({ type: "chat", tabId: "alpha-design", text: "start new-folder leader" });
  await tick();
  assert.equal(server.leaderCreates.at(-1).folder, "C:/work/new-design");
});

test("seat updates validate the whole request and preserve the prior member after a rejected field", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "hello" });
  const before = lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "reviewer1");
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "reviewer1", name: "Changed", effort: "wild" });
  assert.match(ws.messages.at(-1).message, /invalid effort/);
  const after = lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "reviewer1");
  assert.equal(after.name, before.name);
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "reviewer1", name: "Changed", effort: "high" });
  assert.equal(lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "reviewer1").name, "Changed");
});

// Pack 7: a working crew seat keeps its model, effort and CLI; name and picture still change; the lock ends with the last run.
test("pack 7: a working crew seat refuses a model, effort or CLI change and accepts it again once its runs end", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const seatOf = () => server.getWorkspaces().projects[0].tabs[0].crew.find((seat: any) => seat.slot === "coder");
  const before = { ...seatOf() };
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "working" });
  const runId = server.launched[0].run.runId;
  for (const change of [{ model: "gpt-6-sol" }, { effort: before.effort === "high" ? "low" : "high" }, { cli: "claude", model: "claude-opus-5" }]) {
    const sent = ws.messages.length;
    ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", ...change });
    assert.equal(ws.messages.slice(sent).findLast((message: any) => message.type === "error")?.message, `${before.name} is working. Change the model when its runs finish.`, JSON.stringify(change));
    assert.deepEqual(seatOf(), before, "nothing is saved when the change is refused");
  }
  const sent = ws.messages.length;
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", name: "Renamed", model: before.model });
  assert.equal(ws.messages.slice(sent).some((message: any) => message.type === "error"), false, "a rename (with an unchanged model) still works");
  assert.equal(seatOf().name, "Renamed");
  server.closeRun(runId, 0);
  await waitFor(() => !lastState(ws).projects[0].tabs[0].runs.some((run: any) => run.status === "working"), "the run ends");
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", model: "gpt-6-sol" });
  assert.equal(seatOf().model, "gpt-6-sol", "after the run ends the same change is accepted");
});

// Pack 7 round 1: a stop that was not confirmed may still be running, so its seat stays locked until the owner releases it.
test("pack 7: a seat with an unconfirmed process refuses a model change until it is released; an old row with no seat locks nothing", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const seatOf = () => server.getWorkspaces().projects[0].tabs[0].crew.find((seat: any) => seat.slot === "coder");
  const before = { ...seatOf() };
  server.launchSafety.uncertain.push({ seatId: "old-seat", pid: 778 });
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", model: "gpt-6-sol" });
  assert.equal(seatOf().model, "gpt-6-sol", "a legacy row with no seat locks no seat");
  server.launchSafety.uncertain.push({ seatId: "alpha-dev.coder", pid: 779 });
  const sent = ws.messages.length;
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", model: before.model });
  assert.equal(ws.messages.slice(sent).findLast((message: any) => message.type === "error")?.message, `${before.name} is working. Change the model when its runs finish.`);
  assert.equal(seatOf().model, "gpt-6-sol", "nothing is saved while the seat has an unconfirmed process");
  ws.message({ type: "releaseUnconfirmedSeat", seatId: "alpha-dev.coder", confirm: "release may leave a process running and editing files" });
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", model: before.model });
  assert.equal(seatOf().model, before.model, "after the release the same change is accepted");
});

test("process changes reject busy tabs and rebuild the saved crew from process definitions", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "working" });
  ws.message({ type: "setProcess", tabId: "alpha-dev", process: "solo" });
  assert.match(ws.messages.at(-1).message, /busy/);
  ws.message({ type: "killRun", runId: server.launched[0].run.runId });
  ws.message({ type: "setProcess", tabId: "alpha-dev", process: "solo" });
  const tab = lastState(ws).projects[0].tabs[0];
  assert.equal(tab.process, "solo");
  assert.deepEqual(tab.crew.map((seat: any) => seat.slot), ["leader"]);
});

test("chat, clear, and transcript revisions stay scoped to their tab", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "alpha" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "beta" });
  await tick();
  assert.equal(server.leaders.size, 2);
  assert.deepEqual(server.leaderCreates.map((entry: any) => entry.folder).sort(), ["C:/work/alpha", "C:/work/beta"]);
  ws.message({ type: "clear", tabId: "alpha-dev" });
  await server.flush();
  const state = lastState(ws);
  assert.equal(state.projects[0].tabs[0].chatRevision, 3);
  assert.equal(state.projects[1].tabs[0].chatRevision, 2);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "fresh" });
  await tick();
  assert.equal(server.leaderCreates.length, 3, "clear starts a fresh leader on its next chat only");
  assert.match(server.chats.at(-1).text, /\.command-center[\\/]alpha-dev[\\/]RESUME\.md/);
  assert.match(server.chats.at(-1).text, /first read the existing handover/);
});

test("Clear Undo restores the exact transcript and revisions and stops a fresh leader", async () => {
  const workspaces = tempWorkspaceFolders();
  const server = await loadServer({ skipHealth: true, writeHandover: true, workspaces }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "old work" });
  await tick();
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => {
    const snapshot = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
    return snapshot.revision > 0 && snapshot.savedRevision === snapshot.revision;
  }, "the leader Save to persist its revision");
  const before = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  assert.equal(before.savedRevision, before.revision);

  ws.message({ type: "clear", tabId: "alpha-dev" });
  ws.message({ type: "chat", tabId: "alpha-dev", text: "fresh work" });
  await tick();
  assert.equal(server.leaderCreates.length, 2, "Clear's first new chat creates a fresh leader");
  assert.equal(server.leaders.has("alpha-dev"), true);
  ws.message({ type: "undoClear", tabId: "alpha-dev" });

  const restored = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  assert.deepEqual(restored, before);
  assert.deepEqual(lastState(ws).projects[0].tabs[0].chatRevision, before.revision);
  assert.deepEqual(lastState(ws).projects[0].tabs[0].savedRevision, before.savedRevision);
  assert.deepEqual(ws.messages.findLast((message: any) => message.type === "chatRestored"), {
    type: "chatRestored", tabId: "alpha-dev", ...before,
  });
  assert.equal(server.leaders.has("alpha-dev"), false, "Undo discards the fresh leader session");
  assert.equal(server.leaderHandles[1].stopCalls, 1);
  assert.equal(server.pendingHandoverReads.has("alpha-dev"), true);
  assert.equal(server.pendingClearUndos.has("alpha-dev"), false);
});

test("Clear Undo expires after 10 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => t.mock.timers.reset());
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "clear", tabId: "alpha-dev" });
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true);
  t.mock.timers.tick(9_999);
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true);
  t.mock.timers.tick(1);
  assert.equal(server.pendingClearUndos.has("alpha-dev"), false);
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.deepEqual(ws.messages.at(-1), { type: "chatUndoRejected", tabId: "alpha-dev", reason: "expired" });
  const tab = lastState(ws).projects[0].tabs[0];
  assert.equal(tab.chatRevision, 1);
  assert.equal(tab.savedRevision, 0);
});

test("Undo on another tab leaves the cleared tab and its pending snapshot unchanged", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "keep this" });
  await tick();
  const before = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const cleared = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  const betaBefore = new ChatStore(path.join(server.testRoot, "chats")).snapshot("beta-dev");

  ws.message({ type: "undoClear", tabId: "beta-dev" });
  assert.deepEqual(ws.messages.at(-1), { type: "chatUndoRejected", tabId: "beta-dev", reason: "unavailable" });
  assert.deepEqual(new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev"), cleared);
  assert.deepEqual(new ChatStore(path.join(server.testRoot, "chats")).snapshot("beta-dev"), betaBefore);
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true);

  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.deepEqual(new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev"), before);
});

test("chat rejects images outside the upload scratch directory at the WebSocket boundary", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const outside = path.join(server.testRoot, `paste-${randomUUID()}.png`);
  writeFileSync(outside, "outside image");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "outside image", images: [outside] });
  assert.match(ws.messages.at(-1).message, /uploaded scratch image/);
  assert.equal(server.leaders.size, 0);
  assert.equal(ws.messages.some((message: any) => message.type === "chatMessage"), false);
});

test("chat accepts only an existing generated image in scratch", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const scratch = path.join(server.testRoot, "scratch");
  mkdirSync(scratch, { recursive: true });
  const image = path.join(scratch, `paste-${randomUUID()}.png`);
  writeFileSync(image, "uploaded image bytes");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "Describe this image", images: [image], requestId: "image_chat_valid" });
  const echo = ws.messages.find((message: any) => message.type === "chatMessage" && message.requestId === "image_chat_valid");
  assert.deepEqual(echo?.images, [image]);
  assert.equal(server.leaders.size, 1);
  await tick();
  await server.flush();
  assert.equal(server.activeLeaderTurns.size, 0, "the leader turn is settled when the test ends");
});

test("chat rejects attachment paths outside scratch and over-limit file lists before creating a leader", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const outside = path.join(server.testRoot, "file-00000000-0000-4000-8000-000000000001.txt");
  writeFileSync(outside, "outside scratch");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "read this", files: [outside], requestId: "file_bad_path" });
  assert.equal(ws.messages.at(-1).requestId, "file_bad_path");
  assert.match(ws.messages.at(-1).message, /uploaded scratch file/);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "too many", files: Array.from({ length: 9 }, () => "file-00000000-0000-4000-8000-000000000001.txt"), requestId: "file_too_many" });
  assert.equal(ws.messages.at(-1).requestId, "file_too_many");
  assert.match(ws.messages.at(-1).message, /list of uploaded file paths/);
  assert.equal(server.leaders.size, 0);
  assert.equal(ws.messages.some((message: any) => message.type === "chatMessage"), false);
});

test("chat refuses a generated-looking attachment reached through a scratch directory junction", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const scratch = path.join(server.testRoot, "scratch");
  const outside = path.join(server.testRoot, "outside-scratch");
  mkdirSync(outside, { recursive: true });
  const name = `file-${randomUUID()}.txt`;
  writeFileSync(path.join(outside, name), "outside attachment");
  removeWithRetry(scratch);
  symlinkSync(outside, scratch, "junction");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "read the linked file", files: [path.join(scratch, name)], requestId: "file_symlink_escape" });
  assert.equal(ws.messages.at(-1).requestId, "file_symlink_escape");
  assert.match(ws.messages.at(-1).message, /uploaded file is unavailable/);
  assert.equal(server.leaders.size, 0);
});

test("chat accepts a generated scratch attachment and names its path in the leader prompt", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const scratch = path.join(server.testRoot, "scratch");
  mkdirSync(scratch, { recursive: true });
  const file = path.join(scratch, `file-${randomUUID()}.txt`);
  writeFileSync(file, "attachment contents", "utf8");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "Read this file", files: [file], requestId: "file_chat_valid" });
  const echo = ws.messages.find((message: any) => message.type === "chatMessage" && message.requestId === "file_chat_valid");
  assert.deepEqual(echo?.files, [file]);
  await tick();
  assert.match(server.chats[0].text, /Attached files\. Read these local paths/);
  assert.ok(server.chats[0].text.includes(file));
  assert.equal(server.leaders.size, 1);
});

test("chat request ids ride the echo, the persisted history and the refusal; an invalid id is refused", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "with id", requestId: "req-echo-1" });
  const echo = ws.messages.find((message: any) => message.type === "chatMessage");
  assert.equal(echo?.text, "with id", "the accepted chat was echoed");
  assert.equal(echo.requestId, "req-echo-1", "the echo carries the sender's request id");
  ws.message({ type: "selectTab", tabId: "alpha-design" });
  ws.message({ type: "selectTab", tabId: "alpha-dev" });
  const history = ws.messages.findLast((message: any) => message.type === "chatHistory" && message.tabId === "alpha-dev");
  assert.equal(history?.messages?.find((message: any) => message.text === "with id")?.requestId, "req-echo-1", "chatHistory replays the request id");
  const reloaded = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  assert.equal(reloaded.messages.find((message: any) => message.text === "with id")?.requestId, "req-echo-1", "a reloaded store keeps the request id");

  const chatsBefore = server.chats.length;
  ws.message({ type: "chat", tabId: "alpha-dev", text: "refused", requestId: "req-refused-2", images: [path.join(server.testRoot, "outside.png")] });
  const refusal = ws.messages.at(-1);
  assert.equal(refusal.type, "error");
  assert.match(refusal.message, /uploaded scratch image/);
  assert.deepEqual({ action: refusal.action, tabId: refusal.tabId, requestId: refusal.requestId }, { action: "chat", tabId: "alpha-dev", requestId: "req-refused-2" });

  await waitFor(() => !server.activeLeaderTurns.has("alpha-dev"), "the first leader turn to finish");
  const messagesBefore = ws.messages.length;
  ws.message({ type: "chat", tabId: "alpha-dev", text: "bad id", requestId: "../escape" });
  const invalid = ws.messages.slice(messagesBefore);
  assert.deepEqual(invalid.map((message: any) => message.type), ["error"], "an invalid request id gets only an error");
  assert.match(invalid[0].message, /invalid request id/);
  assert.equal(invalid[0].requestId, undefined, "an unsafe id is never echoed back");
  assert.equal(server.chats.length, chatsBefore, "no leader turn started for refused chats");
  assert.equal(new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev").messages.some((message: any) => message.text === "bad id" || message.text === "refused"), false, "refused chats were not stored");
});

test("a second chat is rejected while the leader is answering and busy includes that leader turn", async () => {
  const server = await loadServer({ skipHealth: true, hangLeader: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "first" });
  assert.equal(lastState(ws).projects[0].tabs[0].derived.busy, true);
  assert.equal(lastState(ws).projects[0].tabs[0].derived.leaderTurnActive, true);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "too soon" });
  assert.match(ws.messages.at(-1).message, /leader is still answering/);
  assert.equal(server.chats.length, 1);
});

test("derived.leaderTurnActive tracks leader turns and excludes a running worker", async () => {
  const server = await loadServer({ skipHealth: true, hangLeader: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "worker while the leader is idle");
  const workerRunId = server.launched[0].run.runId;
  const workerOnly = server.stateMessage().projects[0].tabs[0];
  assert.equal(workerOnly.derived.busy, true);
  assert.equal(workerOnly.derived.leaderTurnActive, false);

  ws.message({ type: "chat", tabId: "alpha-dev", text: "start leader turn" });
  assert.equal(lastState(ws).projects[0].tabs[0].derived.leaderTurnActive, true);
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const workerAfterLeaderStops = server.stateMessage().projects[0].tabs[0];
  assert.equal(workerAfterLeaderStops.derived.busy, true, "the worker is still running");
  assert.equal(workerAfterLeaderStops.derived.leaderTurnActive, false);
  server.closeRun(workerRunId);
});

// The app asks before it closes while a tab is working (public/app.js answerCloseRequest): it reads each tab's activeWork, which is the
// server's own tabHasActiveWork, the check that refuses changing a busy tab's folder.
test("every tab's state carries activeWork: true while a worker or a leader turn runs in it, false when it is idle", async () => {
  const server = await loadServer({ skipHealth: true, hangLeader: true }), ws = connect(server);
  const tab = (id: string, state = server.stateMessage()) => state.projects.flatMap((project: any) => project.tabs).find((item: any) => item.id === id);
  assert.deepEqual([tab("alpha-dev").activeWork, tab("alpha-design").activeWork], [false, false], "idle tabs");
  server.launchWorker("alpha-dev", "reviewer2", "a worker");
  const runId = server.launched[0].run.runId;
  assert.deepEqual([tab("alpha-dev").activeWork, tab("alpha-design").activeWork], [true, false], "only the tab with the running worker");
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/new" });
  assert.match(ws.messages.at(-1).message, /tab is busy/, "the same check refuses its folder change");
  server.closeRun(runId);
  assert.equal(tab("alpha-dev").activeWork, false, "the worker exited");
  ws.message({ type: "chat", tabId: "alpha-design", text: "a leader turn" });
  assert.equal(tab("alpha-design", lastState(ws)).activeWork, true, "a leader turn, as broadcast to the page");
});

test("Saves of different tabs run side by side and only record the revision after a successful leader turn", async () => {
  const workspaces = tempWorkspaceFolders();
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 25, writeHandover: true, workspaces });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "alpha" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "beta" });
  await tick(40);
  ws.message({ type: "save", tabId: "alpha-dev" });
  ws.message({ type: "save", tabId: "beta-dev" });
  await waitFor(() => {
    const tabs = lastState(ws).projects.flatMap((project: any) => project.tabs);
    return ["alpha-dev", "beta-dev"].every((id) => {
      const tab = tabs.find((item: any) => item.id === id);
      return tab && tab.savedRevision === tab.chatRevision && tab.savedRevision > 2;
    });
  }, "both tabs to finish their Saves");
  assert.equal(server.maxSaveActive(), 2, "tab B's Save does not wait for tab A's");
  const tabs = lastState(ws).projects.flatMap((project: any) => project.tabs);
  for (const id of ["alpha-dev", "beta-dev"]) {
    const tab = tabs.find((item: any) => item.id === id);
    assert.equal(tab.savedRevision, tab.chatRevision, `${id} Save leaves the current revision saved`);
    assert.ok(tab.savedRevision > 2, `${id} includes the assistant's successful handover response`);
  }
  assert.ok(ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"));
  assert.ok(ws.messages.some((message: any) => message.type === "saved" && message.tabId === "beta-dev"));
  assert.ok(server.chats.some((entry: any) => entry.tabId === "alpha-dev" && entry.text.replaceAll("\\", "/").includes(`${workspaces.projects[0].tabs[0].folder.replaceAll("\\", "/")}/.command-center/alpha-dev/RESUME.md`)));
});

test("Save broadcasts activeWork true when it starts on an idle tab and false when it ends, so the close warning is never stale", async () => {
  const hung = await loadServer({ skipHealth: true, hangSave: true }), hungWs = connect(hung);
  const working = (ws: any) => lastState(ws).projects[0].tabs[0].activeWork;
  hungWs.message({ type: "chat", tabId: "alpha-dev", text: "alpha" });
  await tick(40);
  assert.equal(working(hungWs), false, "idle before Save");
  hungWs.message({ type: "save", tabId: "alpha-dev" });
  await flushMicrotasks();
  assert.equal(working(hungWs), true, "the state broadcast by the Save start already says working");
  // A failed Save has no other broadcast after it, so only the Save's own end can clear the tab's activeWork.
  const server = await loadServer({ skipHealth: true, failSave: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "alpha" });
  await tick(40);
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.action === "save"), "the Save to fail");
  await waitFor(() => working(ws) === false, "a state broadcast after the Save ended to say idle");
});

test("a hung Save does not block Clear for another tab", async () => {
  const server = await loadServer({ skipHealth: true, hangSave: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "alpha" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "beta" });
  await tick(10);
  ws.message({ type: "save", tabId: "alpha-dev" });
  await flushMicrotasks();
  ws.message({ type: "clear", tabId: "beta-dev" });
  assert.equal(server.leaders.has("beta-dev"), false);
  const beta = lastState(ws).projects[1].tabs[0];
  assert.equal(beta.chatRevision, 3);
  assert.equal(beta.savedRevision, 0);
  const clearedAt = ws.messages.findIndex((message: any) => message.type === "chatCleared" && message.tabId === "beta-dev");
  assert.ok(clearedAt >= 0, "Clear completes while another tab's Save remains hung");
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), true);
});

test("Save waits for the active leader turn, then records the fully answered revision", async () => {
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 35, writeHandover: true, workspaces: tempWorkspaceFolders() });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "answer before saving" });
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"), "Save after the active leader turn");
  const tab = lastState(ws).projects[0].tabs[0];
  assert.equal(tab.savedRevision, tab.chatRevision);
  assert.equal(tab.chatRevision, 3);
  assert.ok(ws.messages.some((message: any) => message.type === "saved" && message.savedRevision === 3));
});

test("a hung leader turn times out of the Save queue so another tab can save", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 10, hangLeader: true, hangTab: "alpha-dev", writeHandover: true, workspaces: tempWorkspaceFolders() });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "hang" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "complete" });
  t.mock.timers.tick(10);
  await flushMicrotasks();
  ws.message({ type: "save", tabId: "alpha-dev" });
  ws.message({ type: "save", tabId: "beta-dev" });
  await flushMicrotasks();
  t.mock.timers.tick(30_000);
  await flushMicrotasks();
  t.mock.timers.tick(10);
  await flushMicrotasks();
  await server.flush();
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /timed out waiting for the active leader turn/.test(message.message)));
  const beta = lastState(ws).projects[1].tabs[0];
  assert.equal(beta.savedRevision, beta.chatRevision);
});

test("a failed leader Save leaves the transcript marked unsaved and clears the busy guard", async () => {
  const server = await loadServer({ skipHealth: true, failSave: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "work" });
  await tick();
  ws.message({ type: "save", tabId: "alpha-dev" });
  await tick();
  await server.flush();
  const tab = lastState(ws).projects[0].tabs[0];
  assert.equal(tab.savedRevision, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)));
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false);
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/after-failed-save" });
  assert.equal(lastState(ws).projects[0].tabs.find((item: any) => item.id === "alpha-dev").folder, "C:/work/after-failed-save");
  ws.message({ type: "removeTab", tabId: "alpha-dev" });
  assert.equal(lastState(ws).projects[0].tabs.some((item: any) => item.id === "alpha-dev"), false);
});

async function assertSaveRejectsHandover(mode: "missing" | "stale") {
  const workspaces = tempWorkspaceFolders();
  const folder = workspaces.projects[0].tabs[0].folder;
  const handoverPath = path.join(folder, ".command-center", "alpha-dev", "RESUME.md");
  if (mode === "stale") {
    mkdirSync(path.dirname(handoverPath), { recursive: true });
    writeFileSync(handoverPath, "old handover", "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(handoverPath, old, old);
  }
  const server = await loadServer({ skipHealth: true, workspaces }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "work" });
  await tick();
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)), `${mode} handover refusal`);
  const tab = lastState(ws).projects[0].tabs[0];
  assert.equal(tab.savedRevision, 0, `${mode} handover must not advance savedRevision`);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)), `${mode} handover must fail Save`);
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false, `${mode} handover must not emit saved`);
  if (mode === "missing") assert.equal(existsSync(handoverPath), false);
}

// The Save turn's handover check (stat) is an await: chat and clear are not serialized behind Save and can land in it.
async function saveWithGapAction(action: (ws: any) => Promise<void>) {
  let enterGap!: () => void, releaseGap!: () => void;
  const inGap = new Promise<void>((resolveGap) => { enterGap = resolveGap; });
  const gapOpen = new Promise<void>((resolveGap) => { releaseGap = resolveGap; });
  const gatedStat = (async (file: any, ...rest: any[]) => {
    if (String(file).endsWith("RESUME.md")) { enterGap(); await gapOpen; }
    return (stat as any)(file, ...rest);
  }) as typeof stat;
  const server = await loadServer({ skipHealth: true, writeHandover: true, workspaces: tempWorkspaceFolders(), stat: gatedStat }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "work" });
  await tick();
  ws.message({ type: "save", tabId: "alpha-dev" });
  await inGap;
  const atSave = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  try {
    await action(ws);
  } finally {
    releaseGap();
  }
  await tick();
  await server.flush();
  return { server, ws, atSave, after: new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev") };
}

test("a chat sent during Save's handover check is not marked saved", async () => {
  const { ws, atSave, after } = await saveWithGapAction(async (ws) => { ws.message({ type: "chat", tabId: "alpha-dev", text: "never handed over" }); await tick(); });
  assert.ok(after.revision > atSave.revision, "the gap chat advanced the transcript");
  assert.equal(after.savedRevision, atSave.revision, "Save marks the revision the leader handed over, not the gap chat");
  assert.deepEqual(ws.messages.filter((message: any) => message.type === "saved").map((message: any) => message.savedRevision), [atSave.revision]);
});

test("a Clear during Save's handover check fails the Save and leaves the cleared tab unsaved", async () => {
  const { ws, after } = await saveWithGapAction(async (ws) => { ws.message({ type: "clear", tabId: "alpha-dev" }); });
  assert.equal(after.messages.length, 0);
  assert.equal(after.savedRevision, 0, "the empty cleared transcript must not come out saved");
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)));
});

test("a Stop during Save's handover check (leader replaced, handover unread) fails the Save and leaves the tab unsaved", async () => {
  const { ws, after } = await saveWithGapAction(async (ws) => { ws.message({ type: "stopAll" }); });
  assert.equal(after.savedRevision, 0, "a stopped leader's late Save must not mark the transcript saved");
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)));
});

test("Save keeps its tab busy during the handover check, then releases it", async () => {
  const { server, ws, after } = await saveWithGapAction(async (ws) => {
    ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/too-early" });
    assert.equal(ws.messages.at(-1).type, "error", "folder changes during Save must be rejected");
    assert.match(ws.messages.at(-1).message, /tab is busy/);
    ws.message({ type: "removeTab", tabId: "alpha-dev" });
    assert.equal(ws.messages.at(-1).type, "error", "tab removal during Save must be rejected");
    assert.match(ws.messages.at(-1).message, /busy/);
    assert.ok(lastState(ws).projects[0].tabs.some((tab: any) => tab.id === "alpha-dev"));
  });
  assert.equal(after.savedRevision, after.revision);
  assert.ok(ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"));
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/after-save" });
  assert.equal(lastState(ws).projects[0].tabs.find((tab: any) => tab.id === "alpha-dev").folder, "C:/work/after-save");
  ws.message({ type: "removeTab", tabId: "alpha-dev" });
  assert.equal(lastState(ws).projects[0].tabs.some((tab: any) => tab.id === "alpha-dev"), false);
});

test("a queued Save marks its tab busy before its serialized turn starts", async () => {
  let enterGap!: () => void, releaseGap!: () => void, held = false;
  const inGap = new Promise<void>((resolveGap) => { enterGap = resolveGap; });
  const gapOpen = new Promise<void>((resolveGap) => { releaseGap = resolveGap; });
  const gatedStat = (async (file: any, ...rest: any[]) => {
    if (!held && String(file).endsWith("RESUME.md")) { held = true; enterGap(); await gapOpen; }
    return (stat as any)(file, ...rest);
  }) as typeof stat;
  const workspaces = tempWorkspaceFolders();
  const server = await loadServer({ skipHealth: true, writeHandover: true, workspaces, stat: gatedStat });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "alpha work" });
  await tick();
  ws.message({ type: "save", tabId: "alpha-dev" });
  await inGap;
  try {
    ws.message({ type: "save", tabId: "alpha-dev" });
    assert.deepEqual(server.chats.filter((entry: any) => entry.text.startsWith("Save a concise handover")).map((entry: any) => entry.tabId), ["alpha-dev"], "the second Save of the same tab waits for the first");
    assert.equal(server.stateMessage().projects[0].tabs[0].derived.busy, true);
    ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/too-early" });
    assert.equal(ws.messages.at(-1).type, "error", "queued Save folder change must be rejected");
    assert.match(ws.messages.at(-1).message, /tab is busy/);
  } finally {
    releaseGap();
  }
  await tick();
  await server.flush();
  await tick();
  await server.flush();
  assert.deepEqual(ws.messages.filter((message: any) => message.type === "saved").map((message: any) => message.tabId), ["alpha-dev", "alpha-dev"]);
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/after-queue" });
  assert.equal(lastState(ws).projects.flatMap((project: any) => project.tabs).find((tab: any) => tab.id === "alpha-dev").folder, "C:/work/after-queue");
});

test("a Save still waiting on its own tab does not hold up another tab's Save", async () => {
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 10, hangLeader: true, hangTab: "alpha-dev", writeHandover: true, workspaces: tempWorkspaceFolders() });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "hang" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "complete" });
  await tick(40);
  ws.message({ type: "save", tabId: "alpha-dev" });
  ws.message({ type: "save", tabId: "beta-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "saved" && message.tabId === "beta-dev"), "tab B's Save while tab A's Save is still waiting");
  assert.equal(ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"), false, "tab A is still waiting");
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), true);
});

async function launchGateServer(mode: "ask" | "plan" | "accept" | "bypass") {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create leader" });
  await tick();
  if (mode !== "accept") {
    ws.message({ type: "setPermissionMode", requestId: `launch_gate_${mode}`, tabId: "alpha-dev", mode });
    await waitFor(() => server.settingsService.permissionMode("alpha-dev") === mode, `${mode} saved`);
  }
  return { server, ws, deps: server.leaderDeps.get("Development") };
}
const pendingFor = (server: any) => [...server.pendingApprovals.values()];

test("Ask mode: launching a write seat asks the user first; Allow starts the run, Deny starts nothing", async () => {
  const { server, ws, deps } = await launchGateServer("ask");
  const allowed = deps.launch("coder", "Fix the login bug\nthen run the tests");
  await waitFor(() => pendingFor(server).length === 1, "launch approval");
  const [item] = pendingFor(server);
  assert.equal(item.tool, "launch:Sonny");
  assert.equal(item.summary, "Sonny (Coder)\nFix the login bug\nthen run the tests", "the approval shows the seat on line 1 and the WHOLE brief, line breaks kept");
  assert.equal(server.launched.length, 0, "nothing starts before Allow");
  assert.equal(lastState(ws).projects[0].tabs[0].pendingApprovals[0].tool, "launch:Sonny");
  ws.message({ type: "answerApproval", requestId: "launch_allow", tabId: "alpha-dev", approvalId: item.approvalId, allow: true });
  assert.equal((await allowed).ok, true);
  assert.equal(server.launched.length, 1);
  const denied = deps.launch("coder", "Another job");
  await waitFor(() => pendingFor(server).length === 1, "second launch approval");
  ws.message({ type: "answerApproval", requestId: "launch_deny", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: false });
  const denial = await denied;
  assert.equal(denial.ok, false);
  assert.equal(denial.error, "The user denied this.");
  assert.equal(server.launched.length, 1, "Deny starts no run");
});

test("Ask mode: a read-only seat launches without asking", async () => {
  const { server, deps } = await launchGateServer("ask");
  // A launch wrongly held for an approval would never settle, so race it against a short wait.
  const outcome = await Promise.race([deps.launch("reviewer1", "review it"), tick(200).then(() => "held for approval")]);
  assert.notEqual(outcome, "held for approval", "a read-only seat is never held for an approval");
  assert.equal(outcome.ok, true);
  assert.equal(pendingFor(server).length, 0);
  assert.equal(server.launched.length, 1);
});

test("Plan mode refuses to launch a write seat and still launches a read-only seat", async () => {
  const { server, deps } = await launchGateServer("plan");
  const refused = await deps.launch("coder", "write code");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Plan mode/);
  assert.equal(server.launched.length, 0);
  assert.equal(pendingFor(server).length, 0);
  assert.equal((await deps.launch("reviewer1", "review it")).ok, true);
});

test("Accept mode launches a write seat without asking", async () => {
  const { server, deps } = await launchGateServer("accept");
  assert.equal((await deps.launch("coder", "write code")).ok, true);
  assert.equal(pendingFor(server).length, 0);
});

test("a launch approval is denied when the leader is replaced while it waits", async () => {
  const { server, ws, deps } = await launchGateServer("ask");
  const waiting = deps.launch("coder", "work");
  await waitFor(() => pendingFor(server).length === 1, "launch approval");
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const denial = await waiting;
  assert.equal(denial.ok, false);
  assert.equal(denial.error, "The user denied this.");
  assert.equal(server.launched.length, 0);
});

test("Undo is rejected once its expiry has passed even if the expiry timer has not fired yet", async () => {
  let clock = 1_000_000;
  const server = await loadServer({ skipHealth: true, now: () => clock }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "gone" });
  await tick();
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const cleared = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  clock += 10_000;
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true, "the real expiry timer has not fired");
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.deepEqual(ws.messages.at(-1), { type: "chatUndoRejected", tabId: "alpha-dev", reason: "expired" });
  assert.deepEqual(new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev"), cleared);
});

test("Save fails when the handover file is missing", async () => assertSaveRejectsHandover("missing"));
test("Save fails when the handover file is stale", async () => assertSaveRejectsHandover("stale"));

test("leader tools can see and launch only the crew belonging to their tab", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" });
  ws.message({ type: "chat", tabId: "alpha-design", text: "start" });
  await tick();
  const designDeps = server.leaderDeps.get("Design");
  const devDeps = server.leaderDeps.get("Development");
  assert.ok(designDeps.crew().every((seat: any) => seat.seatKey.startsWith("alpha-design.")));
  assert.ok(devDeps.crew().every((seat: any) => seat.seatKey.startsWith("alpha-dev.")));
  assert.equal((await designDeps.launch("designer", "design work")).ok, true);
  assert.equal(server.launched.at(-1).run.seatKey, "alpha-design.designer");
  assert.equal((await designDeps.launch("leader", "self launch")).ok, false);
});

test("request actions echo ids, track state, enforce source and destination scope, and resolve from the destination tab", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  ws.message({ type: "sendRequest", requestId: "send_request_1", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Review", body: "Check the patch." });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "send_request_1"), "send request result");
  const sent = ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === "send_request_1");
  assert.equal(sent.status, "pending");
  assert.deepEqual(JSON.parse(JSON.stringify(server.stateMessage().requestActions.send_request_1)), { requestId: "send_request_1", status: "done", message: "Done" });
  assert.equal(server.requestsStore.pendingCount("beta-dev"), 1);

  ws.message({ type: "sendRequest", requestId: "send_spoofed", fromTabId: "beta-dev", toTabId: "alpha-dev", title: "Spoof", body: "No." });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "send_spoofed"), "source scope refusal");
  assert.equal(server.requestsStore.list().length, 1);

  const request = server.requestsStore.list()[0];
  ws.message({ type: "resolveRequest", requestId: "resolve_no_tab", id: request.id, status: "accepted" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "resolve_no_tab"), "a missing tabId is refused");
  assert.match(ws.messages.find((message: any) => message.requestId === "resolve_no_tab").message, /tabId is required/);
  ws.message({ type: "resolveRequest", requestId: "resolve_wrong_tab", id: request.id, status: "accepted", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "resolve_wrong_tab"), "wrong destination refusal");
  assert.match(ws.messages.find((message: any) => message.requestId === "resolve_wrong_tab").message, /not addressed to this tab/);
  assert.equal(server.requestsStore.pendingCount("beta-dev"), 1);

  // The destination tab answers whichever tab is open (alpha-dev stays selected here): Needs you lists requests for every tab.
  assert.equal(lastState(ws).selectedTabId, "alpha-dev");
  ws.message({ type: "resolveRequest", requestId: "resolve_request_1", id: request.id, status: "accepted", tabId: "beta-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "resolve_request_1"), "resolve request result");
  assert.equal(ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === "resolve_request_1").status, "accepted");
  assert.equal(server.requestsStore.pendingCount("beta-dev"), 0);
  assert.equal(server.stateMessage().requests[0].status, "accepted");
});

test("removing a request destination persists destinationRemoved", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "sendRequest", requestId: "send_remove_target", fromTabId: "alpha-dev", toTabId: "alpha-design", title: "Design review", body: "Please review." });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "send_remove_target"), "request creation");
  const request = server.requestsStore.list()[0];
  ws.message({ type: "removeTab", tabId: "alpha-design" });
  assert.equal(server.requestsStore.list().find((item: any) => item.id === request.id).status, "destinationRemoved");
  assert.equal(server.stateMessage().requests[0].status, "destinationRemoved");
});

test("leader request tools keep the sender and incoming list bound to their own tab", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.requestsStore.send({ fromTabId: "beta-dev", toTabId: "alpha-dev", title: "Incoming", body: "For alpha." }, (tabId: string) => ["alpha-dev", "alpha-design", "beta-dev"].includes(tabId));
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start scoped leader" });
  await tick();
  const deps = server.leaderDeps.get("Development");
  const created = deps.sendRequest("alpha-design", "From alpha", "Sent by the alpha leader.");
  assert.equal(created.ok, true);
  assert.equal(created.request.fromTabId, "alpha-dev");
  assert.equal(server.stateMessage().requestActions[created.requestId].status, "done");
  assert.deepEqual(deps.listRequests().map((item: any) => item.title), ["Incoming"]);
  assert.equal(deps.listRequests().some((item: any) => item.toTabId === "alpha-design"), false);
});

test("permission mode persists per tab, applies live, requires bypass confirmation, and reaches a new session", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "setPermissionMode", requestId: "bypass_unconfirmed", tabId: "alpha-design", mode: "bypass" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "bypass_unconfirmed"), "bypass confirmation refusal");
  assert.equal(server.settingsService.permissionMode("alpha-design"), "accept");

  ws.message({ type: "setPermissionMode", requestId: "bypass_confirmed", tabId: "alpha-design", mode: "bypass", confirm: true });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "bypass_confirmed"), "bypass mode result").catch((error) => { throw new Error(`${error.message}; recent messages: ${JSON.stringify(ws.messages.slice(-8))}`); });
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start with default" });
  await tick();
  assert.equal(server.leaderModes[0], "accept");

  ws.message({ type: "setPermissionMode", requestId: "plan_live", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "plan_live"), "live plan result");
  assert.deepEqual(server.leaderHandles[0].permissionCalls, ["plan"]);
  assert.equal(server.settingsService.permissionMode("alpha-dev"), "plan");

  ws.message({ type: "chat", tabId: "alpha-design", text: "start with saved bypass" });
  await tick();
  assert.equal(server.leaderModes[1], "bypass");
  assert.equal(server.settingsService.permissionMode("alpha-design"), "bypass");
});

test("the WebSocket permission call site stops a leader exactly once when live apply returns false", async () => {
  const server = await loadServer({ skipHealth: true, setPermissionResult: false }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create leader" });
  await tick();
  const leader = server.leaderHandles[0];
  ws.message({ type: "setPermissionMode", requestId: "perm_false_callsite", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "perm_false_callsite"), "false live permission apply");
  const failure = ws.messages.findLast((message: any) => message.type === "error" && message.requestId === "perm_false_callsite");
  assert.match(failure.message, /permission mode change failed/i);
  assert.equal(leader.stopCalls, 1, "the live leader is stopped exactly once");
  assert.equal(server.leaders.has("alpha-dev"), false, "the failed live leader is removed");
  assert.equal(server.settingsService.permissionMode("alpha-dev"), "accept", "saved mode stays unchanged");
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionModes, "alpha-dev"), false);
  assert.equal(server.stateMessage().settings.permissionActions["alpha-dev"].status, "failed");
});

test("a queued permission request looks up a leader created after it was queued", async () => {
  const server = await loadServer({ skipHealth: true, deferFirstPermission: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create first leader" });
  await tick();
  const firstLeader = server.leaderHandles[0];
  ws.message({ type: "setPermissionMode", requestId: "perm_hold", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => typeof firstLeader.resolvePermission === "function", "first permission apply is pending");

  ws.message({ type: "clear", tabId: "alpha-dev" });
  ws.message({ type: "setPermissionMode", requestId: "perm_queued", tabId: "alpha-dev", mode: "ask" });
  await flushMicrotasks();
  assert.equal(server.leaders.has("alpha-dev"), false, "the second request is queued while no leader exists");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create replacement leader" });
  await waitFor(() => server.leaderHandles.length === 2, "replacement leader created before queued apply");
  const replacement = server.leaderHandles[1];

  firstLeader.resolvePermission!(true);
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "perm_queued"), "queued permission result");
  assert.deepEqual(replacement.permissionCalls, ["ask"], "the queued ask mode reaches the replacement leader");
  assert.equal(server.settingsService.permissionMode("alpha-dev"), "ask");
});

test("a failed stale permission request does not stop a replacement leader", async () => {
  const server = await loadServer({ skipHealth: true, deferFirstPermission: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create first leader" });
  await tick();
  const firstLeader = server.leaderHandles[0];
  ws.message({ type: "setPermissionMode", requestId: "perm_stale", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => typeof firstLeader.resolvePermission === "function", "stale permission apply is pending");

  ws.message({ type: "clear", tabId: "alpha-dev" });
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create replacement leader" });
  await waitFor(() => server.leaderHandles.length === 2, "replacement leader created");
  const replacement = server.leaderHandles[1];
  firstLeader.resolvePermission!(false);

  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "perm_stale"), "stale permission failure");
  assert.equal(firstLeader.stopCalls, 1, "Clear stopped the old leader");
  assert.equal(replacement.stopCalls, 0, "the stale failure leaves the replacement leader alone");
  assert.equal(server.leaders.has("alpha-dev"), true);
  assert.equal(server.settingsService.permissionMode("alpha-dev"), "accept");
});

test("a permission failure saves the partial answer and makes the next leader read the handover", async () => {
  const server = await loadServer({ skipHealth: true, hangLeader: true, setPermissionResult: false }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start a long answer" });
  await waitFor(() => server.leaderHandles.length === 1, "leader created");
  server.leaderHandles[0].callbacks.onDelta("partial answer");

  ws.message({ type: "setPermissionMode", requestId: "perm_partial", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "perm_partial"), "permission failure with active turn");
  const savedPartial = ws.messages.findLast((message: any) => message.type === "chatMessage" && message.tabId === "alpha-dev" && message.text.includes("partial answer"));
  assert.equal(savedPartial.text, "partial answer\nPermission mode change failed.");
  assert.equal(server.pendingHandoverReads.has("alpha-dev"), true, "the next session is marked to read RESUME.md");

  ws.message({ type: "chat", tabId: "alpha-dev", text: "continue" });
  await waitFor(() => server.chats.some((entry: any) => entry.text.startsWith("Before replying, first read the existing handover")), "next turn handover read");
  assert.match(server.chats.findLast((entry: any) => entry.tabId === "alpha-dev").text, /\.command-center[\\/]alpha-dev[\\/]RESUME\.md/);
});

test("removing a tab during a live permission request deletes its saved mode and blocks a late save", async () => {
  const server = await loadServer({ skipHealth: true, deferFirstPermission: true }), ws = connect(server);
  ws.message({ type: "setPermissionMode", requestId: "perm_seed", tabId: "alpha-design", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "perm_seed"), "seed permission mode");
  ws.message({ type: "chat", tabId: "alpha-design", text: "create design leader" });
  await tick();
  const leader = server.leaderHandles[0];
  ws.message({ type: "setPermissionMode", requestId: "perm_removed", tabId: "alpha-design", mode: "ask" });
  await waitFor(() => typeof leader.resolvePermission === "function", "tab permission apply is pending");

  ws.message({ type: "removeTab", tabId: "alpha-design" });
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionModes, "alpha-design"), false);
  leader.resolvePermission!(true);
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "perm_removed"), "removed tab permission refusal");

  const persisted = JSON.parse(readFileSync(path.join(server.testRoot, "settings.json"), "utf8"));
  assert.equal(Object.hasOwn(persisted.permissionModes, "alpha-design"), false, "disk has no mode for the removed tab");
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionModes, "alpha-design"), false, "the late completion does not restore the mode");
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionActions, "alpha-design"), false, "the removed tab has no orphaned action state");
});

test("leader launch budget is durable and a failed durable reservation prevents spawn", async () => {
  let fail = true;
  const server = await loadServer({ skipHealth: true, failSafety: () => fail });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create leader" });
  await tick();
  const deps = server.leaderDeps.get("Development");
  assert.equal((await deps.launch("coder", "run")).ok, false);
  assert.equal(server.launched.length, 0);
  fail = false;
  for (let i = 0; i < 4; i++) assert.equal((await deps.launch("coder", `run ${i}`)).ok, true);
  assert.equal((await deps.launch("coder", "over budget")).ok, false);
  assert.equal(server.safety().timestamps.length, 4);
});

test("client, leader, and stall relaunches persist pending launch notices with their source", async () => {
  const writes: config.LaunchSafety[] = [];
  const server = await loadServer({ skipHealth: true, onSafetyWrite: (value) => writes.push(value) });
  const ws = connect(server);
  const client = server.launchWorker("alpha-dev", "reviewer2", "client work");
  assert.equal(client.ok, true);
  assert.deepEqual([writes[0].notices.at(-1)?.source, writes[0].notices.at(-1)?.pending], ["Local client", true]);
  assert.deepEqual([server.safety().notices.at(-1)?.source, server.safety().notices.at(-1)?.pending], ["Local client", false]);
  assert.ok(ws.messages.some((message: any) => message.type === "leaderLaunch" && message.source === "Local client"));
  server.leaderLaunch("alpha-dev", "coder", "leader work");
  assert.equal(writes.at(-2)?.notices.at(-1)?.source, "Atlas");
  assert.equal(writes.at(-2)?.notices.at(-1)?.pending, true);
  assert.equal(server.safety().notices.at(-1)?.source, "Atlas");
  assert.ok(ws.messages.some((message: any) => message.type === "leaderLaunch" && message.source === "Atlas"));
});

test("a renamed leader is named in the approval-wait refusal and in the launch notice, never a hard-coded name", async () => {
  const { server, ws, deps } = await launchGateServer("ask");
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", name: "Ada" }); await tick();
  assert.equal(lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader").name, "Ada", "control: the leader is renamed");
  const waiting = deps.launch("coder", "Needs an answer");
  await waitFor(() => pendingFor(server).length === 1, "launch approval");
  ws.message({ type: "save", tabId: "alpha-dev" });
  await tick();
  assert.equal(ws.messages.filter((message: any) => message.type === "error").at(-1)?.message, "Ada is waiting for your answer on a change", "the save refusal names the renamed leader");
  ws.message({ type: "answerApproval", requestId: "rename_allow", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
  assert.equal((await waiting).ok, true);
  assert.equal(server.safety().notices.at(-1)?.source, "Ada", "the launch notice names the renamed leader");
});

test("a launch-safety disk failure never suppresses a requested Kill", async () => {
  let fail = false;
  const server = await loadServer({ skipHealth: true, failSafety: () => fail });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create leader" });
  await tick();
  await server.leaderDeps.get("Development").launch("coder", "work");
  const runId = server.launched[0].run.runId;
  fail = true;
  ws.message({ type: "killRun", runId });
  assert.deepEqual(server.kills, [runId]);
  assert.ok(ws.messages.some((message: any) => message.type === "killAccepted" && message.runId === runId));
});

test("leader launch budget and seat stop block survive a fresh server instance", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  const first = await loadServer({ skipHealth: true, safetyPath });
  const ws = connect(first);
  assert.equal(first.leaderLaunch("alpha-dev", "coder", "first task").ok, true);
  const runId = first.launched[0].run.runId;
  ws.message({ type: "killRun", runId });
  assert.deepEqual(config.readLaunchSafety(safetyPath).blocked, ["alpha-dev.coder"]);
  assert.equal(config.readLaunchSafety(safetyPath).timestamps.length, 1);
  assert.equal(config.readLaunchSafety(safetyPath).notices[0].seatId, "alpha-dev.coder");

  const restarted = await loadServer({ skipHealth: true, safetyPath });
  const rejected = restarted.leaderLaunch("alpha-dev", "coder", "must stay blocked");
  assert.match(rejected.ok ? "unexpected launch" : rejected.error, /launch blocked/);
  assert.equal(restarted.launched.length, 0);
  assert.equal(restarted.safety().timestamps.length, 1);
});

test("legacy bare-id launch safety stays visible while new records use tab-scoped keys", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  const old: config.LaunchSafety = {
    blocked: ["sonny"], timestamps: [Date.now()],
    notices: [{ type: "leaderLaunch", id: 1, seatId: "sonny", seatName: "Sonny", brief: "old work", source: "alpha" }],
    nextNoticeId: 2, released: [], uncertain: [{ seatId: "sonny", pid: 9876 }],
  };
  config.writeLaunchSafety(old, safetyPath);
  const server = await loadServer({ skipHealth: true, safetyPath });
  const state = server.stateMessage().launchSafety as config.LaunchSafety;
  assert.deepEqual(state.blocked, ["sonny"]);
  assert.deepEqual(state.uncertain, [{ seatId: "sonny", pid: 9876 }]);
  assert.equal(state.notices[0].seatId, "sonny");

  const rejectedClient = server.launchWorker("alpha-dev", "coder", "new work");
  const rejectedLeader = server.leaderLaunch("alpha-dev", "reviewer2", "new work");
  assert.equal(rejectedClient.ok, false);
  assert.equal(rejectedLeader.ok, false);
  assert.match(rejectedClient.error, /unconfirmed process/);
  assert.match(rejectedLeader.error, /unconfirmed process/);
  assert.equal(server.launched.length, 0);
  const unblocked = await loadServer({ skipHealth: true, safetyPath });
  const unblockWs = connect(unblocked);
  unblockWs.message({ type: "clearLaunchBlock", seatKey: "sonny", confirm: "allow this seat to launch again" });
  assert.equal(unblocked.leaderLaunch("alpha-dev", "reviewer2", "still uncertain").ok, false);
  assert.equal(unblocked.launched.length, 0);
  unblockWs.message({ type: "releaseUnconfirmedSeat", seatId: "sonny", confirm: "release may leave a process running and editing files" });
  unblockWs.message({ type: "clearLaunchBlock", seatKey: "sonny", confirm: "allow this seat to launch again" });
  const released = await loadServer({ skipHealth: true, safetyPath });
  assert.equal(released.leaderLaunch("alpha-dev", "reviewer2", "released bare id").ok, true);
  const saved = config.readLaunchSafety(safetyPath);
  assert.deepEqual(saved.blocked, []);
  assert.deepEqual(saved.uncertain, []);
  assert.deepEqual(saved.released, [{ seatId: "sonny", pid: 9876 }]);
  assert.equal(saved.notices.at(-1)?.seatId, "alpha-dev.reviewer2");
});

test("corrupt launch safety refuses server startup instead of resetting brakes", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  await writeFile(safetyPath, "{");
  await assert.rejects(loadServer({ skipHealth: true, safetyPath }), /JSON|Unexpected/);
  await writeFile(safetyPath, "{}");
  await assert.rejects(loadServer({ skipHealth: true, safetyPath }), /launch safety|malformed|blocked/i);
  await writeFile(safetyPath, JSON.stringify({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [{ seatId: "alpha.dev", pid: "not-a-pid", runId: "run-1" }] }));
  await assert.rejects(loadServer({ skipHealth: true, safetyPath }), /launch safety|malformed|unconfirmed/i);
});

test("run output replay stays under 200 KB and trims only at UTF-8 boundaries through the real callback", async () => {
  const server = await loadServer({ skipHealth: true });
  connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "inspect output");
  const entry = server.launched[0];
  const cap = 200 * 1024;
  for (const text of ["x".repeat(cap + 1), "😀".repeat(cap), "界".repeat(cap), "😀" + "a".repeat(cap - 1)]) {
    server.emitOutput(entry.run.runId, text);
    const run = server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
    const bytes = Buffer.byteLength(run.output, "utf8");
    assert.ok(bytes <= cap && bytes >= cap - 3, `output bytes=${bytes} for input bytes=${Buffer.byteLength(text, "utf8")}`);
    assert.equal(run.output.isWellFormed(), true);
    assert.doesNotMatch(run.output, /�/);
    assert.ok(text.endsWith(run.output), "the replay is a whole-character suffix of the input");
  }
  const run = server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
  assert.equal(run.output.endsWith("a"), true);
  assert.ok(Buffer.byteLength(run.output, "utf8") <= cap);
  server.launchWorker("alpha-dev", "reviewer2", "short output");
  const short = server.launched[1];
  server.emitOutput(short.run.runId, "abc");
  server.emitOutput(short.run.runId, "界😀");
  assert.equal(server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === short.run.runId).output, "abc界😀");
});

test("slow clients skip output and state, receive small errors, then quiet resync with a drop notice", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.bufferedAmount = 8 * 1024 * 1024 + 1;
  server.broadcast({ type: "output", runId: "run-a", chunk: "missed output" });
  server.broadcast({ type: "state" });
  server.broadcast({ type: "error", message: "small control event" });
  assert.deepEqual(ws.messages.map((message: any) => message.type), ["error"]);
  ws.bufferedAmount = 0;
  server.tickResync();
  assert.equal(ws.messages.at(-1).type, "state");
  assert.equal(ws.messages.at(-1).notice, "[output dropped: client fell behind]");
});

test("real stall timer relaunches a silent read-only Codex run once and escalates the next stall", async () => {
  const server = await loadServer({ relaunchable: true, skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "review this" });
  const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.launched.length, 2);
  assert.equal(server.launched[1].prompt, "review this");
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === first.run.runId && message.action === "relaunch"));
  assert.ok(ws.messages.some((message: any) => message.type === "runStop" && message.runId === first.run.runId && message.internal === true));
  assert.equal(server.safety().notices.at(-1)?.source, "Stall relaunch");

  const second = server.launched[1];
  const tracker = server.stallTrackers.trackers.get(second.run.runId);
  tracker.lastGrowthAt = Date.now() - stall.STALL_THRESHOLD_MS - 1;
  server.tick();
  assert.equal(server.launched.length, 2);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === second.run.runId && message.action === "escalate"));
});

test("a stalled run is never relaunched by itself: the real canRunWrite counts every run as able to write, so a silent read-only Codex run escalates at once", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "review this" });
  const first = server.launched[0];
  assert.equal(first.run.cli, "codex"); assert.equal(first.run.canWrite, false, "control: a read-only Codex slot");
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.launched.length, 1, "no second launch");
  assert.equal(server.pendingRelaunch.size, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === first.run.runId && message.action === "escalate"), "the stall is escalated to the user");
  assert.equal(ws.messages.some((message: any) => message.type === "runStalled" && message.action === "relaunch"), false);
});

test("output after a stall cancels the queued relaunch before the real child closes", async () => {
  const server = await loadServer({ relaunchable: true, skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "recover before relaunch");
  const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.pendingRelaunch.has(first.run.runId), true);
  server.emitOutput(first.run.runId, "late recovery output");
  assert.equal(server.pendingRelaunch.has(first.run.runId), false);
  server.closeRun(first.run.runId);
  assert.equal(server.launched.length, 1);
  assert.ok(ws.messages.some((message: any) => message.type === "output" && message.chunk === "late recovery output"));
});

test("Stop seat stops only its engine seat and cancels its queued stall relaunch", async () => {
  const server = await loadServer({ relaunchable: true, skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "stalling run");
  server.launchWorker("beta-dev", "coder", "other tab run");
  const stalled = server.launched[0], other = server.launched[1];
  server.stallTrackers.startRun(stalled.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.pendingRelaunch.has(stalled.run.runId), true);
  ws.message({ type: "stopSeat", tabId: "alpha-dev", slot: "reviewer2" });
  assert.equal(server.pendingRelaunch.has(stalled.run.runId), false);
  const engine = () => server.tabs.get("alpha-dev").state;
  assert.equal(engine().seats.find((seat: any) => seat.slotId === "reviewer2").status, "stopped", "the stop request shows at once");
  assert.equal(engine().runs.find((run: any) => run.id === stalled.run.runId).status, "working", "a live run is not settled before its close");
  assert.ok(server.safety().blocked.includes(stalled.run.seatKey));
  assert.equal(server.userKilledRuns.has(stalled.run.runId), true);
  assert.equal(server.stallTrackers.isKilled(stalled.run.runId), true);
  assert.equal(server.isRunning(other.run.runId), true);
  server.closeRun(stalled.run.runId);
  assert.equal(engine().runs.find((run: any) => run.id === stalled.run.runId).status, "stopped");
  assert.equal(server.launched.length, 2);
});

test("Stop all stops the engine, leaders, and workers and cancels a queued stall relaunch", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true, hangLeader: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start leader" });
  server.launchWorker("alpha-dev", "reviewer2", "stalling run");
  server.launchWorker("beta-dev", "coder", "second run");
  const stalled = server.launched[0], second = server.launched[1];
  server.stallTrackers.startRun(stalled.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  ws.message({ type: "stopAll" });
  assert.ok(ws.messages.some((message: any) => message.type === "stopAllAccepted"), JSON.stringify(ws.messages));
  assert.equal(server.pendingRelaunch.has(stalled.run.runId), false);
  const runStatus = (tabId: string, runId: string) => server.tabs.get(tabId).state.runs.find((run: any) => run.id === runId).status;
  assert.equal(runStatus("alpha-dev", stalled.run.runId), "working", "a live run is not settled before its close");
  assert.equal(runStatus("beta-dev", second.run.runId), "working");
  assert.equal(server.tabs.get("alpha-dev").state.seats.find((seat: any) => seat.slotId === "reviewer2").status, "stopped");
  assert.deepEqual(new Set(server.safety().blocked), new Set([stalled.run.seatKey, second.run.seatKey]));
  assert.equal(server.userKilledRuns.has(stalled.run.runId), true);
  assert.equal(server.stallTrackers.isKilled(stalled.run.runId), true);
  assert.ok(server.leaderHandles[0].stopCalls > 0);
  server.closeRun(stalled.run.runId); server.closeRun(second.run.runId);
  assert.equal(runStatus("alpha-dev", stalled.run.runId), "stopped");
  assert.equal(runStatus("beta-dev", second.run.runId), "stopped");
  assert.equal(server.launched.length, 2);
});

function approvedLookWithWorker(server: any, ws: any, tabId: string) {
  for (let i = 0; i < 8 && server.tabs.get(tabId).state.approval.state !== "pending"; i++) ws.message({ type: "advanceStep", tabId });
  assert.equal(server.launchWorker(tabId, "coder", "still editing").ok, true);
  ws.message({ type: "approveLook", tabId });
  assert.equal(server.tabs.get(tabId).state.approval.reviewWaits, true, "review waits for the working coder");
  return server.launched.at(-1).run.runId;
}
const reviewerStatus = (server: any, tabId: string) => server.tabs.get(tabId).state.seats.find((seat: any) => seat.slotId === "reviewer1").status;

test("Stop seat keeps the review gate closed until the stopped worker's close is confirmed", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true }), ws = connect(server);
  const runId = approvedLookWithWorker(server, ws, "alpha-dev");
  ws.message({ type: "stopSeat", tabId: "alpha-dev", slot: "coder" });
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, true, "the reviewer must not start while the worker may still edit");
  assert.notEqual(reviewerStatus(server, "alpha-dev"), "working");
  server.closeRun(runId);
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, false);
  assert.equal(reviewerStatus(server, "alpha-dev"), "working");
});

test("Stop all pauses a waiting review: it stays closed when each stopped worker's close is confirmed", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true }), ws = connect(server);
  const runId = approvedLookWithWorker(server, ws, "alpha-dev");
  ws.message({ type: "stopAll" });
  // Stop all pauses the waiting review at once: it never opens by itself, neither now nor when the stopped worker's close is confirmed.
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, false);
  assert.equal(reviewerStatus(server, "alpha-dev"), "stopped", "the reviewer must not start while the worker may still edit");
  server.closeRun(runId);
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, false);
  assert.equal(reviewerStatus(server, "alpha-dev"), "stopped", "the confirmed close does not open the paused review");
  assert.equal(server.tabs.get("alpha-dev").state.seats.find((seat: any) => seat.slotId === "leader").status, "stopped");
  assert.equal(server.stateMessage().projects[0].tabs[0].derived.busy, false, "a stopped tab is not busy");
});

test("Stop all settles a stopped worker on explicit release when its close is never confirmed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const server = await loadServer({ skipHealth: true, deferKill: true }), ws = connect(server);
  const runId = approvedLookWithWorker(server, ws, "alpha-dev");
  ws.message({ type: "stopAll" });
  t.mock.timers.tick(5_000);
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, false);
  ws.message({ type: "releaseUnconfirmed", runId, confirm: "release may leave a process running and editing files" });
  assert.equal(server.tabs.get("alpha-dev").state.runs.find((run: any) => run.id === runId).status, "failed");
  assert.equal(server.tabs.get("alpha-dev").state.approval.reviewWaits, false);
  assert.equal(reviewerStatus(server, "alpha-dev"), "stopped", "releasing the worker does not open the paused review");
  server.closeRun(runId);
});

test("Stop seat on an idle worker seat still blocks its next launch", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "stopSeat", tabId: "alpha-dev", slot: "reviewer1" });
  assert.ok(server.safety().blocked.includes("alpha-dev.reviewer1"));
  const refused = server.leaderLaunch("alpha-dev", "reviewer1", "start anyway");
  assert.match(refused.ok ? "launched" : refused.error, /launch blocked/);
  assert.equal(server.launched.length, 0);
});

test("changing process or kind banks and stops the live leader, and the next chat starts a fresh one", async () => {
  const server = await loadServer({ skipHealth: true, usageDelta: { modelId: "claude-opus-5-5[1m]", contextTokens: 10, contextWindow: 1_000_000, costUsd: 0.5 } }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "before" });
  await tick();
  const first = server.leaders.get("alpha-dev");
  ws.message({ type: "setProcess", tabId: "alpha-dev", process: "duo" });
  assert.equal(server.leaders.has("alpha-dev"), false, "the old leader must not keep answering for the new process");
  assert.equal(server.leaderHandles[0].stopCalls, 1);
  assert.ok(lastState(ws).projects[0].tabs[0].leaderUsage, "the stopped leader's spend stays banked");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "after" });
  await tick();
  assert.notEqual(server.leaders.get("alpha-dev"), first);
  assert.equal(server.leaderCreates.length, 2);
  ws.message({ type: "setProcess", tabId: "alpha-dev", kind: "design", process: "main" });
  assert.equal(server.leaders.has("alpha-dev"), false);
  assert.equal(server.leaderHandles[1].stopCalls, 1);
});

test("an SDK error result during Save is a failed handover, never a saved one", async () => {
  const sdkLeader = (args: any) => {
    const turns = (async function* () {
      for await (const message of args.prompt) {
        const text = message.message.content[0].text;
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "reply" } } };
        yield text.startsWith("Save a concise handover")
          ? { type: "result", subtype: "error_during_execution", is_error: true }
          : { type: "result", subtype: "success", is_error: false };
      }
    })();
    return Object.assign(turns, { setModel: async () => {} });
  };
  const server = await loadServer({ skipHealth: true, sdkLeader }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "work" });
  await tick();
  assert.ok(ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "alpha-dev"), "an ordinary result still completes");
  ws.message({ type: "save", tabId: "alpha-dev" });
  await tick(40);
  assert.equal(lastState(ws).projects[0].tabs[0].savedRevision, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)));
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false);
  server.leaders.get("alpha-dev").stop();
});

test("Clear recovers the same tab while its own Save is hung", async () => {
  const server = await loadServer({ skipHealth: true, hangSave: true, writeHandover: true, workspaces: tempWorkspaceFolders() }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "work" });
  await tick(10);
  ws.message({ type: "save", tabId: "alpha-dev" });
  await flushMicrotasks();
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), true, "the Save turn is hung");
  ws.message({ type: "clear", tabId: "alpha-dev" });
  assert.ok(ws.messages.some((message: any) => message.type === "chatCleared" && message.tabId === "alpha-dev"));
  await tick(10);
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), false);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)), "the hung Save ends as a failure");
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false);
  assert.equal(lastState(ws).projects[0].tabs[0].savedRevision, 0);
  ws.message({ type: "chat", tabId: "beta-dev", text: "other" });
  await tick(10);
  ws.message({ type: "save", tabId: "beta-dev" });
  await tick(20);
  assert.ok(server.chats.some((entry: any) => entry.tabId === "beta-dev" && entry.text.startsWith("Save a concise handover")), "the Save queue is free again");
  ws.message({ type: "clear", tabId: "beta-dev" });
  await tick(10);
});

test("a thrown runner start rolls back its launch-budget reservation and pending notice", async () => {
  const server = await loadServer({ skipHealth: true });
  const priorTimestamps = [...server.safety().timestamps], priorNotices = [...server.safety().notices];
  server.throwRun();
  const refused = server.launchWorker("alpha-dev", "reviewer2", "crashing start");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /injected runner crash/);
  assert.deepEqual(server.safety().timestamps, priorTimestamps);
  assert.deepEqual(server.safety().notices, priorNotices);
  assert.equal(server.runContexts.size, 0);
});

test("a closed run leaves no per-run output, usage, or kill flags behind", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "finishes");
  server.launchWorker("alpha-dev", "reviewer2", "killed");
  const [done, killed] = server.launched.map((entry: any) => entry.run.runId);
  server.emitOutput(done, "some output");
  server.emitOutput(killed, "more output");
  assert.equal(server.runOutput.has(done), true);
  assert.equal(server.runOutput.has(killed), true);
  server.closeRun(done, 0);
  ws.message({ type: "killRun", runId: killed });
  for (const runId of [done, killed]) {
    for (const [name, map] of Object.entries({ runOutput: server.runOutput, runUsage: server.runUsage, userKilledRuns: server.userKilledRuns, stallKillRuns: server.stallKillRuns, pendingRelaunch: server.pendingRelaunch, runContexts: server.runContexts })) {
      assert.equal((map as any).has(runId), false, `${name} still holds ${runId}`);
    }
    const replay = server.stateMessage().projects[0].tabs[0].runs.find((run: any) => run.runId === runId);
    assert.equal(replay.output, "");
    assert.equal(replay.usage, undefined);
  }
  assert.equal(server.runOutput.size, 0);
  assert.equal(server.runUsage.size, 0);
});

test("every recovery alias requires its confirmation phrase and leaves state unchanged when refused", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const server = await loadServer({ skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "will not die");
  const run = server.launched[0].run;
  ws.message({ type: "killRun", runId: run.runId });
  t.mock.timers.tick(5_000);
  assert.equal(server.safety().uncertain.length, 1);
  const before = JSON.stringify(server.safety());
  for (const message of [
    { type: "releaseUnconfirmed", runId: run.runId },
    { type: "releaseUnconfirmed", runId: run.runId, confirm: "yes" },
    { type: "releaseUnconfirmed", runId: run.runId, confirm: "release may leave a process running and editing files " },
    { type: "releaseUnconfirmedSeat", seatId: run.seatKey },
  ]) {
    ws.message(message);
    assert.match(ws.messages.at(-1).message, /explicit release confirmation/, JSON.stringify(message));
    assert.equal(JSON.stringify(server.safety()), before);
    assert.equal(server.isRunning(run.runId), true);
    assert.equal(server.runContexts.has(run.runId), true);
  }
  for (const message of [
    { type: "clearLaunchBlock", seatKey: run.seatKey },
    { type: "clearLaunchBlock", seatId: run.seatKey, confirm: "ok" },
    { type: "clearLaunchBlock", seatKey: run.seatKey, confirm: "allow this seat to launch again " },
    { type: "unblockSeat", seatKey: run.seatKey },
  ]) {
    ws.message(message);
    assert.match(ws.messages.at(-1).message, /explicit launch-block confirmation/, JSON.stringify(message));
    assert.equal(JSON.stringify(server.safety()), before);
  }
  ws.message({ type: "releaseUnconfirmed", runId: run.runId, confirm: "release may leave a process running and editing files" });
  assert.equal(server.isRunning(run.runId), false);
  ws.message({ type: "clearLaunchBlock", seatKey: run.seatKey, confirm: "allow this seat to launch again" });
  assert.equal(server.safety().blocked.includes(run.seatKey), false);
  server.closeRun(run.runId);
});

test("unconfirmed kill grace and recovery use the real runner, and refusals require both phrases", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const server = await loadServer({ relaunchable: true, skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "unconfirmed stall");
  const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.pendingRelaunch.has(entry.run.runId), true);
  t.mock.timers.tick(4_999);
  assert.equal(server.safety().uncertain.length, 0);
  t.mock.timers.tick(1);
  assert.equal(server.pendingRelaunch.has(entry.run.runId), false);
  assert.equal(server.stallTrackers.isKilled(entry.run.runId), true);
  assert.equal(server.safety().uncertain.length, 1);
  assert.equal(server.isRunning(entry.run.runId), true);
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey });
  assert.match(ws.messages.at(-1).message, /explicit release confirmation/);
  ws.message({ type: "unblockSeat", seatId: entry.run.seatKey });
  assert.match(ws.messages.at(-1).message, /explicit launch-block confirmation/);
  assert.equal(server.safety().uncertain.length, 1);
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.equal(server.isRunning(entry.run.runId), false);
  assert.equal(server.tabs.get("alpha-dev").state.runs.find((run: any) => run.id === entry.run.runId).status, "failed");
  assert.equal(server.runContexts.has(entry.run.runId), false);
  assert.equal(server.pendingRelaunch.has(entry.run.runId), false);
  assert.equal(server.stallTrackers.isKilled(entry.run.runId), true);
  assert.ok(server.safety().blocked.includes(entry.run.seatKey));
  server.closeRun(entry.run.runId);
  assert.equal(server.safety().released.length, 0);
  assert.equal(server.launched.length, 1);
});

test("release refuses when the real runner does not own an unconfirmed kill", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "still running");
  const run = server.launched[0].run;
  const row = { seatId: run.seatKey, pid: server.runnerProcesses.get(run.runId).pid, runId: run.runId };
  server.launchSafety.uncertain.push(row);
  ws.message({ type: "releaseUnconfirmedSeat", seatId: run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.match(ws.messages.at(-1).message, /process is not tracked as unconfirmed/);
  assert.deepEqual(server.launchSafety.uncertain, [row]);
  assert.deepEqual(server.launchSafety.released, []);
  assert.equal(server.isRunning(run.runId), true);
  assert.equal(server.runContexts.has(run.runId), true);
  assert.equal(server.tabs.get("alpha-dev").state.runs.find((entry: any) => entry.id === run.runId).status, "working");
  server.closeRun(run.runId);
});

test("real stall timer never kills or relaunches a writable slot", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "edit carefully" });
  const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  assert.equal(server.launched.length, 1);
  assert.equal(server.kills.length, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === entry.run.runId && message.action === "escalate"));
  assert.equal(server.stateMessage().projects[0].tabs[0].crew.find((seat: any) => seat.slot === "coder").status, "stalled");
});

test("a manual Kill that arrives during a stall kill wins over the queued relaunch", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "review this" });
  const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1);
  server.tick();
  ws.message({ type: "killRun", runId: first.run.runId });
  server.closeRun(first.run.runId);
  assert.equal(server.launched.length, 1, "a user Kill during the automatic kill must suppress the relaunch");
});

test("any real output at the runner callback disqualifies a stall relaunch", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "review this" });
  const entry = server.launched[0];
  server.emitOutput(entry.run.runId, "progress");
  server.stallTrackers.trackers.get(entry.run.runId).lastGrowthAt = Date.now() - stall.STALL_THRESHOLD_MS - 1;
  server.tick();
  assert.equal(server.launched.length, 1);
  assert.equal(server.kills.length, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === entry.run.runId && message.action === "escalate"));
});

test("tab process state transitions and client message validation are wired at the WebSocket call site", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "hello" });
  for (const raw of ["null", "[]", "3", '"text"', "true", "{}", '{"type":3}', "{"]) {
    assert.doesNotThrow(() => ws.message(raw));
    assert.equal(ws.messages.at(-1).type, "error");
  }
  for (let i = 0; i < 8 && lastState(ws).projects[0].tabs[0].processState.approval.state !== "pending"; i++) ws.message({ type: "advanceStep", tabId: "alpha-dev" });
  ws.message({ type: "approveLook", tabId: "alpha-dev" });
  assert.equal(lastState(ws).projects[0].tabs[0].processState.approval.state, "approved");
  ws.message({ type: "reviewFindings", tabId: "alpha-dev" });
  assert.equal(lastState(ws).projects[0].tabs[0].processState.phase, "fix");
  ws.message({ type: "selectMarketingMaker", tabId: "alpha-marketing", slot: "image" });
  assert.equal(lastState(ws).projects[0].tabs.find((tab: any) => tab.id === "alpha-marketing").processState.selectedMakerSlotId, "image");
});

test("reviewClean is wired at the WebSocket call site: a clean review closes the round once the look is approved, and before that nothing happens", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  const processOf = () => lastState(ws).projects[0].tabs[0].processState;
  ws.message({ type: "reviewClean", tabId: "alpha-dev" });
  assert.deepEqual([processOf().phase === "clean", processOf().roundHistory.length], [false, 0], "control: before the review stage the message changes nothing");
  for (let i = 0; i < 8 && processOf().approval.state !== "pending"; i++) ws.message({ type: "advanceStep", tabId: "alpha-dev" });
  ws.message({ type: "approveLook", tabId: "alpha-dev" });
  assert.equal(processOf().phase, "review");
  ws.message({ type: "reviewClean", tabId: "alpha-dev" });
  assert.equal(processOf().phase, "clean");
  assert.deepEqual(processOf().roundHistory.map((round: any) => round.outcome), ["clean"]);
  assert.equal(lastState(ws).projects[1].tabs[0].processState.roundHistory.length, 0, "another tab's process is untouched");
  ws.message({ type: "reviewClean", tabId: "no-such-tab" });
  assert.equal(ws.messages.at(-1).type, "error");
  assert.match(ws.messages.at(-1).message, /unknown tab/);
});

test("renameTab is wired at the WebSocket call site: it trims the name and saves it, and a blank, missing or non-string name or an unknown tab is refused with nothing changed", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  const before = tabState(ws, "alpha-dev").name;
  ws.message({ type: "renameTab", tabId: "alpha-dev", name: "  Fresh name  " });
  assert.equal(tabState(ws, "alpha-dev").name, "Fresh name");
  assert.equal(server.getWorkspaces().projects[0].tabs[0].name, "Fresh name", "saved to the workspace");
  assert.equal(tabState(ws, "alpha-design").name, "Design", "another tab keeps its name");
  for (const bad of [{ tabId: "alpha-dev", name: "   " }, { tabId: "alpha-dev", name: 5 }, { tabId: "alpha-dev" }, { tabId: "no-such-tab", name: "Anything" }]) {
    ws.message({ type: "renameTab", ...bad });
    assert.equal(ws.messages.at(-1).type, "error", JSON.stringify(bad));
    assert.match(ws.messages.at(-1).message, /invalid tab or name/);
  }
  assert.equal(tabState(ws, "alpha-dev").name, "Fresh name", "every refusal left the name alone");
  // A save that fails keeps the old name, on the page and in the file.
  let fail = false;
  const failing = await loadServer({ skipHealth: true, failWorkspaceWrite: () => fail }), failingWs = connect(failing);
  failingWs.message({ type: "hello" });
  fail = true;
  failingWs.message({ type: "renameTab", tabId: "alpha-dev", name: "Never saved" });
  assert.equal(failingWs.messages.at(-1).type, "error");
  assert.match(failingWs.messages.at(-1).message, /workspace disk failed/);
  assert.equal(tabState(failingWs, "alpha-dev").name, before);
  assert.equal(failing.getWorkspaces().projects[0].tabs[0].name, before);
});

test("ackLaunchNotices is wired at the WebSocket call site: it removes exactly the listed notices, saves that, answers with the ids, and a bad list or a failed save removes nothing", async () => {
  let fail = false;
  const safetyPath = path.join(tempRoot(), "launch-safety.json"), server = await loadServer({ skipHealth: true, safetyPath, failSafety: () => fail }), ws = connect(server);
  for (const brief of ["notice one", "notice two", "notice three"]) assert.equal(server.leaderLaunch("alpha-dev", "coder", brief).ok, true);
  ws.message({ type: "hello" });
  const ids = lastState(ws).launchSafety.notices.map((notice: any) => notice.id);
  assert.equal(ids.length, 3, "control: three notices are waiting");
  const sent = (type: string) => ws.messages.filter((message: any) => message.type === type);
  for (const bad of [{ ids: [0] }, { ids: [1.5] }, { ids: ["1"] }, { ids: [ids[0], -2] }, { ids: "all" }, {}]) {
    ws.message({ type: "ackLaunchNotices", ...bad });
    assert.equal(ws.messages.at(-1).type, "error", JSON.stringify(bad));
    assert.match(ws.messages.at(-1).message, /notice ids must be positive integers/);
  }
  assert.equal(server.launchSafety.notices.length, 3, "a bad list removed nothing");
  fail = true;
  ws.message({ type: "ackLaunchNotices", ids: [ids[0]] });
  assert.equal(ws.messages.at(-1).type, "error");
  assert.match(ws.messages.at(-1).message, /safety disk failed/);
  assert.equal(server.launchSafety.notices.length, 3, "a failed save puts the notices back");
  assert.equal(sent("launchNoticesAcked").length, 0, "and nothing was reported as acknowledged");
  fail = false;
  ws.message({ type: "ackLaunchNotices", ids: [ids[0], ids[1], 9999] });
  assert.deepEqual(sent("launchNoticesAcked").at(-1).ids, [ids[0], ids[1], 9999], "the reply carries the ids it was given");
  assert.deepEqual(config.readLaunchSafety(safetyPath).notices.map((notice: any) => notice.id), [ids[2]], "only the unlisted notice is left on disk");
  assert.deepEqual(lastState(ws).launchSafety.notices.map((notice: any) => notice.id), [ids[2]], "and in the state the page gets");
  ws.message({ type: "ackLaunchNotices", ids: [] });
  assert.deepEqual(config.readLaunchSafety(safetyPath).notices.map((notice: any) => notice.id), [ids[2]], "an empty list removes nothing");
});

test("uncertain kill PIDs stay visible in server state and release requires the real run id", async () => {
  const server = await loadServer({ skipHealth: true });
  server.launchSafety.uncertain.push({ seatId: "old-seat", pid: 777 });
  const ws = connect(server);
  ws.message({ type: "hello" });
  assert.deepEqual(lastState(ws).launchSafety.uncertain, [{ seatId: "old-seat", pid: 777 }]);
  ws.message({ type: "releaseUnconfirmed", runId: "unknown-run", confirm: "release may leave a process running and editing files" });
  assert.match(ws.messages.at(-1).message, /not tracked as unconfirmed/);
});

test("setAdvisor validates model ids and history stays path safe", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "setAdvisor", tabId: "alpha-dev", advisor: { model: "nope" } });
  assert.match(ws.messages.at(-1).message, /invalid advisor/);
  ws.message({ type: "setAdvisor", tabId: "alpha-dev", advisor: { model: "claude-opus-5-5[1m]" } });
  assert.equal(lastState(ws).projects[0].tabs[0].advisor.model, "claude-opus-5-5[1m]");
});

test("cleanScratch removes expired uploads while preserving fresh files", async () => {
  const server = await loadServer({ skipHealth: true });
  const dir = path.join(server.testRoot, "scratch-clean-test");
  mkdirSync(dir);
  const fresh = path.join(dir, "paste-33333333-3333-3333-3333-333333333333.png"), expired = path.join(dir, "paste-44444444-4444-4444-4444-444444444444.png");
  writeFileSync(fresh, "fresh");
  writeFileSync(expired, "expired");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(expired, old, old);
  try {
    await server.cleanScratch(dir);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(expired), false);
  } finally { removeWithRetry(dir); }
});

test("cleanScratch deletes only its own generated upload names, only regular files, and never through a link", async () => {
  const server = await loadServer({ skipHealth: true });
  const dir = path.join(server.testRoot, "scratch-own-names"), outside = path.join(server.testRoot, "scratch-outside"), link = path.join(server.testRoot, "scratch-link");
  mkdirSync(dir); mkdirSync(outside);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const uuid = "55555555-5555-5555-5555-555555555555";
  const generated = [path.join(dir, "paste-" + uuid + ".png"), path.join(dir, "file-" + uuid + ".txt")];
  const foreign = [path.join(dir, "notes.txt"), path.join(dir, "paste-" + uuid + ".exe"), path.join(dir, "mine.png")];
  for (const file of [...generated, ...foreign]) { writeFileSync(file, "x"); utimesSync(file, old, old); }
  const lookalikeDir = path.join(dir, "paste-66666666-6666-6666-6666-666666666666.png"); mkdirSync(lookalikeDir); utimesSync(lookalikeDir, old, old);
  const important = path.join(outside, "paste-" + uuid + ".png"); writeFileSync(important, "keep me"); utimesSync(important, old, old);
  try {
    await server.cleanScratch(dir);
    assert.deepEqual(generated.map((file) => existsSync(file)), [false, false], "the generated names go");
    assert.deepEqual(foreign.map((file) => existsSync(file)), [true, true, true], "anything else stays, however old");
    assert.equal(existsSync(lookalikeDir), true, "a folder named like an upload stays");
    symlinkSync(outside, link, "junction");
    await server.cleanScratch(link);
    assert.equal(existsSync(important), true, "a scratch folder that is a junction is skipped, nothing outside is deleted");
  } finally { try { rmdirSync(link); } catch { /* removes the link itself only, never what it points at */ } removeWithRetry(dir); removeWithRetry(outside); }
});

test("start-up cleans the scratch folder itself: an old generated upload is deleted, an old file that is not one of ours and a fresh upload stay", async () => {
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const names = { oldUpload: "paste-77777777-7777-7777-7777-777777777777.png", freshUpload: "paste-88888888-8888-8888-8888-888888888888.png", oldForeign: "notes.txt" };
  // The files exist BEFORE the server starts: nothing here calls cleanScratch, so only the call made while the server starts can remove one.
  const server = await loadServer({ skipHealth: true, preload: (root) => {
    const dir = path.join(root, "scratch");
    mkdirSync(dir, { recursive: true });
    for (const name of Object.values(names)) writeFileSync(path.join(dir, name), "x");
    utimesSync(path.join(dir, names.oldUpload), old, old);
    utimesSync(path.join(dir, names.oldForeign), old, old);
  } });
  const dir = server.scratchDir;
  assert.equal(path.dirname(dir), server.testRoot, "the scratch folder the server cleaned is the one the fixture was put in");
  assert.equal(existsSync(path.join(dir, names.oldUpload)), false, "the old generated upload was deleted at start-up");
  assert.equal(existsSync(path.join(dir, names.freshUpload)), true, "a fresh upload stays");
  assert.equal(existsSync(path.join(dir, names.oldForeign)), true, "an old file that is not a generated upload name stays");
});

test("MONEY GUARD 1: a rejected runner start preserves the active run's relaunch allowance and next prompt", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "active brief" });
  const active = server.launched[0]; server.stallTrackers.markRelaunched(active.run.runId, active.run.startedAt);
  const priorTimestamps = [...server.safety().timestamps], priorNotices = [...server.safety().notices];
  server.rejectRun();
  const refused = server.launchWorker("alpha-dev", "reviewer2", "refused brief");
  assert.equal(refused.ok, false);
  assert.deepEqual(server.safety().timestamps, priorTimestamps, "a runner refusal rolls back its launch-budget reservation");
  assert.deepEqual(server.safety().notices, priorNotices, "a runner refusal removes its pending notice");
  assert.equal(server.runContexts.get(active.run.runId).prompt, "active brief");
  assert.equal(server.stallTrackers.trackers.get(active.run.runId).relaunched, true);
  const accepted = server.launchWorker("alpha-dev", "reviewer2", "next brief");
  assert.equal(accepted.ok, true);
  assert.equal(server.launched.at(-1).prompt, "next brief");
  assert.equal(server.safety().timestamps.length, priorTimestamps.length + 1);
});

test("MONEY GUARD 1c: a rejected second start leaves the active tab, slot, and prompt context unchanged", async () => {
  const server = await loadServer({ skipHealth: true });
  server.launchWorker("alpha-design", "designer", "design the page");
  const active = server.launched[0]; server.rejectRun();
  const refused = server.launchWorker("alpha-design", "designer", "must not replace it");
  assert.equal(refused.ok, false);
  assert.deepEqual([server.runContexts.get(active.run.runId).tabId, server.runContexts.get(active.run.runId).slot, server.runContexts.get(active.run.runId).prompt], ["alpha-design", "designer", "design the page"]);
});

test("MONEY GUARD 3 (call site): any actual output before the stall causes escalation and no relaunch", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "has started real work"); const active = server.launched[0];
  server.emitOutput(active.run.runId, "made progress");
  server.stallTrackers.trackers.get(active.run.runId).lastGrowthAt = Date.now() - stall.STALL_THRESHOLD_MS - 1; server.tick();
  assert.equal(server.launched.length, 1); assert.equal(server.kills.length, 0);
  assert.ok(ws.messages.some((item: any) => item.type === "runStalled" && item.action === "escalate"));
});

test("MONEY GUARD 4: a writable Claude crew slot is escalated, never automatically rerun", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-design", "designer", "design task"); const active = server.launched[0];
  assert.equal(active.run.cli, "claude"); assert.equal(active.run.canWrite, true);
  server.stallTrackers.startRun(active.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.launched.length, 1); assert.equal(server.kills.length, 0);
  assert.ok(ws.messages.some((item: any) => item.type === "runStalled" && item.action === "escalate"));
});

test("MONEY GUARD 4: an OpenCode worker is unsafe for automatic relaunch even when its slot is read-only", async () => {
  const workspaces = fixtureWorkspaces();
  const reviewer = workspaces.projects[0].tabs[0].crew.find((seat) => seat.slot === "reviewer2")!;
  reviewer.cli = "opencode"; reviewer.model = "vendor/model-a"; reviewer.effort = "max";
  const server = await loadServer({ skipHealth: true, workspaces }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "review task"); const active = server.launched[0];
  assert.equal(active.run.cli, "opencode"); assert.equal(active.run.canWrite, false);
  server.stallTrackers.startRun(active.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.launched.length, 1); assert.equal(server.kills.length, 0);
  assert.ok(ws.messages.some((item: any) => item.type === "runStalled" && item.action === "escalate"));
});

test("WS call site: client preference updates validate, persist to the isolated file, and broadcast", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "updateClientPref", key: "sidebarCollapsed", value: true });
  assert.equal(server.prefWrites.length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(server.testRoot, "client-prefs.json"), "utf8")).sidebarCollapsed, true);
  assert.equal(lastState(ws).clientPrefs.sidebarCollapsed, true);
  ws.message({ type: "updateClientPref", key: "sidebarCollapsed", value: "yes" });
  assert.equal(server.prefWrites.length, 1, "invalid input must never write");
  assert.equal(lastState(ws).clientPrefs.sidebarCollapsed, true);
});

test("an Atlas-started run can be killed immediately by its real run ID", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  assert.equal(server.leaderLaunch("alpha-dev", "coder", "Atlas task").ok, true);
  const run = server.launched[0].run;
  ws.message({ type: "killRun", runId: run.runId });
  assert.deepEqual(server.kills, [run.runId]);
  assert.equal(server.active.has(run.runId), false);
  assert.ok(ws.messages.some((item: any) => item.type === "runStop" && item.runId === run.runId));
});

test("a rejected leader transport marks the leader dead, reports once, and makes the next send safe", async () => {
  const errors: string[] = [];
  const createLeader = loadLeaderHarness(() => ({ [Symbol.asyncIterator]() { return this; }, next: () => Promise.reject(new Error("transport rejected")), return: async () => ({ done: true }) }));
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (value: string) => errors.push(value) });
  await tick(0); assert.equal(instance.isDead(), true); assert.equal(errors.length, 1);
  assert.doesNotThrow(() => instance.send("queued after failure"));
  assert.equal(errors.length, 2); assert.match(errors[1], /not available/);
});

test("a message queued before the leader iterator fails is still reported and never throws on send", async () => {
  let reject!: (error: Error) => void;
  const errors: string[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }), return: async () => ({ done: true }) };
  const createLeader = loadLeaderHarness(() => handle);
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (value: string) => errors.push(value) });
  await tick(0); instance.send("first queued message"); instance.send("second queued message");
  reject(new Error("stream failed while input waited")); await tick(0);
  assert.equal(instance.isDead(), true); assert.equal(errors.filter((value) => value.includes("stream failed")).length, 1);
  assert.doesNotThrow(() => instance.send("later"));
});

test("agent-usage: a Claude final partial line is held through an unconfirmed kill and flushed once on close", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), killer = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  const line = JSON.stringify({ type: "result", result: "final Claude answer", usage: {}, modelUsage: {} });
  harness.runSeat(isolatedRun({ runId: "claude-held", seatKey: "usage-tab.claude", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(line));
  harness.killRun("claude-held", ((command: string) => command === "taskkill" ? killer : proc) as any); killer.emit("error", new Error("kill refused"));
  assert.equal(capture.events.some((event) => event.text?.includes("final Claude answer")), false);
  proc.emit("close", null);
  assert.equal(capture.events.filter((event) => event.text?.includes("final Claude answer")).length, 1);
});

test("agent-usage: the actual Claude run command carries stream-json flags", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(); let command = "";
  const run = isolatedRun({ runId: "claude-stream-flags", cli: "claude", model: "claude-opus-5-5[1m]" });
  const started = harness.runSeat(run, "x", isolatedRunnerCapture().callbacks, ((cmd: string) => { command = cmd; return proc; }) as any);
  assert.equal(started.ok, true); assert.match(command, /--output-format stream-json --verbose/); proc.emit("close", 0);
});

test("agent-usage: a huge Claude system error line is capped before it reaches the output pane", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  const run = isolatedRun({ runId: "system-cap", cli: "claude", model: "claude-opus-5-5[1m]" });
  harness.runSeat(run, "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "system", subtype: "error_diagnostic", is_error: true, stderr: "x".repeat(20_000) }) + "\n")); proc.emit("close", 0);
  const shown = capture.events.filter((event) => event.type === "output").map((event) => event.text).join("");
  assert.ok(shown.length <= 220); assert.match(shown, /truncated/);
});

test("agent-usage: each new Claude run starts with its own usage accumulator", () => {
  const harness = loadRunnerHarness(), first = isolatedRunnerProc(), second = isolatedRunnerProc();
  const a = isolatedRunnerCapture(), b = isolatedRunnerCapture();
  const run = isolatedRun({ runId: "usage-first", seatKey: "usage-tab.sonny", model: "claude-opus-5-5[1m]" });
  const result1 = { type: "result", usage: { input_tokens: 7 }, modelUsage: {}, total_cost_usd: 0.1 };
  harness.runSeat(run, "x", a.callbacks, (() => first) as any); first.stdout.emit("data", Buffer.from(JSON.stringify(result1) + "\n")); first.emit("close", 0);
  harness.runSeat({ ...run, runId: "usage-second" }, "x", b.callbacks, (() => second) as any); second.stdout.emit("data", Buffer.from(JSON.stringify({ ...result1, usage: { input_tokens: 2 }, total_cost_usd: 0.02 }) + "\n")); second.emit("close", 0);
  assert.equal(a.events.find((event) => event.type === "usage").usage.contextTokens, 7);
  assert.equal(b.events.find((event) => event.type === "usage").usage.contextTokens, 2);
});

test("agent-usage: a normal Claude close emits one usage delta for its one result", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "once-usage", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", usage: { input_tokens: 5 }, modelUsage: {}, total_cost_usd: 0.01 }) + "\n")); proc.emit("close", 0); proc.emit("close", 0);
  assert.equal(capture.events.filter((event) => event.type === "usage").length, 1);
});

test("agent-usage: a captured Claude assistant and result stream renders text and scopes its usage", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "claude-stream", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5[1m]", content: [{ type: "text", text: "clean response" }] } }) + "\n"));
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", result: "clean response", usage: { input_tokens: 12 }, modelUsage: { "claude-opus-5-5[1m]": { contextWindow: 1_000_000 } }, total_cost_usd: 0.1 }) + "\n")); proc.emit("close", 0);
  assert.equal(capture.events.filter((event) => event.type === "output").map((event) => event.text).join(""), "clean response\n");
  assert.deepEqual(capture.events.find((event) => event.type === "usage").usage, { modelId: "claude-opus-5-5[1m]", contextTokens: 12, contextWindow: 1_000_000, costUsd: 0.1 });
});

test("agent-usage: Claude result text reaches output before the usage callback fires", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "order-usage", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", result: "text first", usage: {}, modelUsage: {} }) + "\n")); proc.emit("close", 0);
  assert.deepEqual(capture.events.filter((event) => ["output", "usage"].includes(event.type)).map((event) => event.type), ["output", "usage"]);
});

test("agent-usage: a blank line after the Codex footer does not erase its held measurement", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "codex-blank", cli: "codex", model: "gpt-6-sol" }), "x", capture.callbacks, (() => proc) as any);
  proc.stderr.emit("data", Buffer.from("tokens used\n19,878\n\n"));
  assert.equal(capture.events.some((event) => event.type === "usage"), false); proc.emit("close", 0);
  assert.equal(capture.events.find((event) => event.type === "usage").usage.contextTokens, 19878);
});

test("agent-usage: OpenCode never fabricates a usage entry when it reports no measurement", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "opencode-no-usage", cli: "opencode", model: "vendor/model-a", effort: "max" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from("ordinary text\n")); proc.emit("close", 0);
  assert.equal(capture.events.some((event) => event.type === "usage"), false);
});

test("agent-usage: an unconfirmed kill does not flush a held Codex measurement", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), killer = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "codex-held-kill", cli: "codex", model: "gpt-6-sol" }), "x", capture.callbacks, (() => proc) as any);
  proc.stderr.emit("data", Buffer.from("tokens used\n1000\n")); harness.killRun("codex-held-kill", ((command: string) => command === "taskkill" ? killer : proc) as any); killer.emit("error", new Error("no taskkill"));
  assert.equal(capture.events.some((event) => event.type === "usage"), false); proc.emit("close", null);
  assert.equal(capture.events.filter((event) => event.type === "usage").length, 1);
});

test("agent-usage: a taskkill spawn error holds Codex usage until the later real close", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "codex-taskkill-error", cli: "codex", model: "gpt-6-sol" }), "x", capture.callbacks, (() => proc) as any);
  proc.stderr.emit("data", Buffer.from("tokens used\n2000\n"));
  harness.killRun("codex-taskkill-error", (() => { const killer = isolatedRunnerProc(); queueMicrotask(() => killer.emit("error", new Error("spawn failed"))); return killer; }) as any);
  assert.equal(capture.events.some((event) => event.type === "usage"), false); proc.emit("close", null);
  assert.equal(capture.events.filter((event) => event.type === "usage").length, 1);
});

test("agent-usage: Codex footer counts are held, not surfaced before close", () => {
  const state = agentUsage.createAgentUsageState();
  assert.deepEqual(agentUsage.scanCodexTokens(state, "tokens used\n1234\n"), []);
  assert.deepEqual(agentUsage.flushCodexTokens(state), [{ modelId: null, contextTokens: 1234, contextWindow: null, costUsd: null }]);
});

test("agent-usage: footer-like prose followed by ordinary text is unmeasured at close", () => {
  const state = agentUsage.createAgentUsageState();
  agentUsage.scanCodexTokens(state, "tokens used\n1234\nnot a footer\n");
  assert.deepEqual(agentUsage.flushCodexTokens(state), []);
});

test("agent-usage: a Claude rate-limit event reaches the runner's plan-window callback", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "rate-limit", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 123 } } } }) + "\n")); proc.emit("close", 0);
  assert.deepEqual(capture.events.find((event) => event.type === "rateLimit").windows, { five_hour: { utilization: 0.2, resetsAt: 123 } });
});

test("agent-usage: Codex stdout after its stderr footer does not erase the held measurement", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "stdout-after-footer", cli: "codex", model: "gpt-6-sol" }), "x", capture.callbacks, (() => proc) as any);
  proc.stderr.emit("data", Buffer.from("tokens used\n5000\n")); proc.stdout.emit("data", Buffer.from("final answer\n")); proc.emit("close", 0);
  assert.equal(capture.events.find((event) => event.type === "usage").usage.contextTokens, 5000);
  assert.ok(capture.events.some((event) => event.text === "final answer\n"));
});

test("agent-usage: system failures and unknown Claude shapes stay visible while known lifecycle noise stays quiet", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "system-shapes", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from([
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "system", subtype: "error", stderr: "failed" }),
    JSON.stringify({ type: "future_event", value: 1 }),
  ].join("\n") + "\n")); proc.emit("close", 0);
  const text = capture.events.filter((event) => event.type === "output").map((event) => event.text).join("");
  assert.doesNotMatch(text, /\[system\] init/); assert.match(text, /\[error\] error/); assert.match(text, /future_event/);
});

test("agent-usage: Codex stderr footer, stdout answer, and close produce one real usage delta", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "codex-order", cli: "codex", model: "gpt-6-sol" }), "x", capture.callbacks, (() => proc) as any);
  proc.stderr.emit("data", Buffer.from("tokens used\n3,210\n")); proc.stdout.emit("data", Buffer.from("done\n")); proc.emit("close", 0);
  assert.equal(capture.events.filter((event) => event.type === "usage").length, 1);
  assert.equal(capture.events.find((event) => event.type === "usage").usage.contextTokens, 3210);
});

test("agent-usage: two results in one Claude run produce two deltas instead of resetting the turn count", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "two-turns", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  for (const tokens of [3, 8]) proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", usage: { input_tokens: tokens }, modelUsage: {}, total_cost_usd: tokens / 100 }) + "\n")); proc.emit("close", 0);
  assert.deepEqual(capture.events.filter((event) => event.type === "usage").map((event) => event.usage.contextTokens), [3, 8]);
});

test("agent-usage: malformed Claude JSON is passed through verbatim by the real runner", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "malformed-claude", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  const bad = "{not json but visible}"; proc.stdout.emit("data", Buffer.from(bad + "\n")); proc.emit("close", 0);
  assert.ok(capture.events.some((event) => event.type === "output" && event.text === bad + "\n"));
});

test("leaderLaunchSeat: the durable launch brake includes manual and leader starts and stops at its limit", async () => {
  const server = await loadServer({ skipHealth: true });
  for (let i = 0; i < 3; i++) assert.equal(server.launchWorker("alpha-dev", "reviewer2", `manual ${i}`).ok, true);
  assert.equal(server.leaderLaunch("alpha-dev", "reviewer2", "fourth launch").ok, true);
  assert.match(server.leaderLaunch("alpha-dev", "reviewer2", "fifth launch").error, /budget/);
  assert.equal(server.safety().timestamps.length, 4);
});

test("leaderLaunchSeat: a real reviewer launch still builds a read-only Codex command", async () => {
  const server = await loadServer({ skipHealth: true }), runner = loadRunnerHarness();
  assert.equal(server.leaderLaunch("alpha-dev", "reviewer2", "review the change").ok, true);
  const run = server.launched[0].run;
  assert.equal(run.canWrite, false);
  assert.match(runner.buildCommand(run, path.join(server.testRoot, "logs", "review.brief.txt")), /--sandbox read-only/);
});

test("leaderLaunchSeat: a real writable slot keeps its explicit write permission", async () => {
  const server = await loadServer({ skipHealth: true }), runner = loadRunnerHarness();
  assert.equal(server.leaderLaunch("alpha-dev", "coder", "implement the approved change").ok, true);
  const run = server.launched[0].run;
  assert.equal(run.canWrite, true);
  assert.match(runner.buildCommand(run, path.join(server.testRoot, "logs", "coder.brief.txt")), /--sandbox workspace-write/);
});

test("leaderLaunchSeat: every successful launch persists and broadcasts its tab, slot, and brief", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  assert.equal(server.leaderLaunch("alpha-design", "designer", "create a new layout").ok, true);
  const notice = ws.messages.find((message: any) => message.type === "leaderLaunch");
  assert.equal(notice.seatId, "alpha-design.designer"); assert.equal(notice.brief, "create a new layout");
  assert.equal(server.safety().notices.at(-1).seatId, "alpha-design.designer");
});

test("leaderLaunchSeat: refused launches never broadcast a success notice", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  assert.equal(server.leaderLaunch("alpha-dev", "missing", "no slot").ok, false);
  assert.equal(server.leaderLaunch("alpha-dev", "leader", "self").ok, false);
  assert.equal(ws.messages.some((message: any) => message.type === "leaderLaunch"), false);
});

test("leaderLaunchSeat: run-start attribution distinguishes leader starts from later manual starts", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.leaderLaunch("alpha-dev", "coder", "leader start");
  const leaderRun = server.launched[0].run.runId;
  assert.equal(ws.messages.find((message: any) => message.type === "runStart" && message.runId === leaderRun).launchedByLeader, true);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "manual start" });
  const manualRun = server.launched.at(-1).run.runId;
  assert.equal(ws.messages.find((message: any) => message.type === "runStart" && message.runId === manualRun).launchedByLeader, false);
});

test("leaderLaunchSeat: concurrent same-slot launches keep distinct run ownership and notices", async () => {
  const server = await loadServer({ skipHealth: true });
  assert.equal(server.leaderLaunch("alpha-dev", "reviewer2", "first").ok, true);
  assert.equal(server.leaderLaunch("alpha-dev", "reviewer2", "second").ok, true);
  assert.notEqual(server.launched[0].run.runId, server.launched[1].run.runId);
  assert.deepEqual(server.launched.map((entry: any) => entry.prompt), ["first", "second"]);
});

test("leaderLaunchSeat: an unknown crew slot is refused", async () => {
  const server = await loadServer({ skipHealth: true });
  const result = server.leaderLaunch("alpha-dev", "unknown", "task");
  assert.equal(result.ok, false);
  assert.equal(server.launched.length, 0, "an unknown slot launches nothing");
  assert.match(result.error, /unknown slot/);
});

test("leaderLaunchSeat: Atlas cannot launch the tab leader as a worker", async () => {
  const server = await loadServer({ skipHealth: true });
  assert.match(server.leaderLaunch("alpha-dev", "leader", "self launch").error, /leader runs in-process/);
  assert.equal(server.launched.length, 0);
});

test("leaderLaunchSeat: an explicit unblock clears the durable kill block before the next leader launch", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json"), first = await loadServer({ skipHealth: true, safetyPath }), ws = connect(first);
  first.leaderLaunch("alpha-dev", "coder", "first"); ws.message({ type: "killRun", runId: first.launched[0].run.runId });
  assert.deepEqual(config.readLaunchSafety(safetyPath).blocked, ["alpha-dev.coder"]);
  ws.message({ type: "unblockSeat", seatId: "alpha-dev.coder", confirm: "allow this seat to launch again" });
  assert.deepEqual(config.readLaunchSafety(safetyPath).blocked, []);
  assert.equal(first.leaderLaunch("alpha-dev", "coder", "after explicit unblock").ok, true);
});

test("buildLeaderOptions: a resolved native CLI carries its path and effort option", () => {
  const options = leaderApi.buildLeaderOptions({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", "C:/bin/claude.exe");
  assert.equal(options.pathToClaudeCodeExecutable, "C:/bin/claude.exe"); assert.deepEqual(options.extraArgs, { effort: "high", "replay-user-messages": null });
});

test("buildLeaderOptions: no resolved CLI omits both native-path and effort options", () => {
  const options = leaderApi.buildLeaderOptions({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null);
  assert.equal(Object.hasOwn(options, "pathToClaudeCodeExecutable"), false); assert.equal(Object.hasOwn(options, "extraArgs"), false);
});

test("buildLeaderOptions applies the saved permission mode when a leader session starts", () => {
  assert.deepEqual(["ask", "accept", "plan", "bypass"].map((mode) => leaderApi.buildLeaderOptions({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, undefined, mode as any).permissionMode), ["default", "acceptEdits", "plan", "bypassPermissions"]);
});

test("chat project guard rejects missing and stale project-only ids before any leader send", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", projectId: "missing", text: "stale project request" }); await tick();
  assert.equal(server.chats.length, 0); assert.equal(server.leaders.size, 0);
  assert.match(ws.messages.at(-1).message, /unknown tab/);
});

test("checkLeaderHealth: a real result logs healthy and sends no client error", async () => {
  const info: string[] = [], errors: string[] = [], logs = { log: (text: string) => info.push(text), error: (text: string) => errors.push(text) } as any;
  const server = await loadServer({ console: logs }); const ws = connect(server); await server.leaderHealthCheck;
  assert.ok(info.some((line) => /health check passed/.test(line))); assert.equal(errors.length, 0);
  assert.equal(ws.messages.some((message: any) => message.type === "error"), false);
});

test("checkLeaderHealth: an empty iterator is reported as failure rather than healthy", async () => {
  const errors: string[] = [], logs = { log() {}, error: (text: string) => errors.push(text) } as any;
  const server = await loadServer({ console: logs, query: () => ({ [Symbol.asyncIterator]: async function* () {} }) }); await server.leaderHealthCheck;
  assert.ok(errors.some((line) => /ended without a result/.test(line)));
});

test("checkLeaderHealth: an is_error result is failure, never a healthy result", async () => {
  const info: string[] = [], errors: string[] = [], logs = { log: (text: string) => info.push(text), error: (text: string) => errors.push(text) } as any;
  const server = await loadServer({ console: logs, query: () => ({ [Symbol.asyncIterator]: async function* () { yield { type: "result", is_error: true }; } }) }); await server.leaderHealthCheck;
  assert.equal(info.some((line) => /health check passed/.test(line)), false); assert.ok(errors.some((line) => /error result/.test(line)));
});

test("checkLeaderHealth: a Claude CLI inside the first tab's folder is refused and no query starts", async () => {
  const info: string[] = [], errors: string[] = [], logs = { log: (text: string) => info.push(text), error: (text: string) => errors.push(text) } as any;
  const planted = await loadServer({ console: logs, claudeCli: "C:/work/alpha/tools/claude.exe" }); await planted.leaderHealthCheck;
  assert.equal(planted.queryCount(), 0, "no health-check query may start the planted CLI");
  assert.ok(errors.some((line) => /lies inside the tab folder/.test(line)), errors.join("|"));
  const outside = await loadServer({ console: logs, claudeCli: "C:/elsewhere/claude.exe" }); await outside.leaderHealthCheck;
  assert.equal(outside.queryCount(), 1, "control: a CLI outside the tab folder still gets checked");
});

test("B8: cleanScratch keeps an old upload a saved chat still points at, and deletes an old unreferenced one", async () => {
  const server = await loadServer({ skipHealth: true }), dir = path.join(server.testRoot, "scratch-referenced"); mkdirSync(dir);
  const chats = path.join(server.testRoot, "chats"); mkdirSync(chats, { recursive: true });
  const kept = "paste-11111111-1111-1111-1111-111111111111.png", gone = "paste-22222222-2222-2222-2222-222222222222.png";
  const chatFile = path.join(chats, "alpha-dev.jsonl");
  writeFileSync(chatFile, `${JSON.stringify({ role: "user", text: "look", images: [`C:/data/scratch/${kept}`] })}\n`);
  writeFileSync(path.join(dir, kept), "x"); writeFileSync(path.join(dir, gone), "y");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(path.join(dir, kept), old, old); utimesSync(path.join(dir, gone), old, old);
  try {
    await server.cleanScratch(dir);
    assert.equal(existsSync(path.join(dir, kept)), true, "referenced by a saved chat: kept");
    assert.equal(existsSync(path.join(dir, gone)), false, "control: unreferenced and old: deleted");
  } finally { rmSync(chatFile, { force: true }); }
});

test("B8: Clear Undo is refused while the leader is answering or a Save runs, and stays available", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "old work" });
  await tick();
  ws.message({ type: "clear", tabId: "alpha-dev" });
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true);
  const revisionBefore = lastState(ws).projects[0].tabs[0].chatRevision;
  server.activeLeaderTurns.add("alpha-dev");
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.deepEqual([ws.messages.at(-1).type, ws.messages.at(-1).reason], ["chatUndoRejected", "busy"], "the page can tell this refusal from an expired undo");
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true, "the undo is still available");
  assert.equal(lastState(ws).projects[0].tabs[0].chatRevision, revisionBefore, "nothing was restored");
  server.activeLeaderTurns.delete("alpha-dev");
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.equal(server.pendingClearUndos.has("alpha-dev"), false, "control: once the leader is idle the undo works");
});

test("Clear Undo is refused as busy while only a Save runs (no leader turn), and works after", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "old work" });
  await tick();
  ws.message({ type: "clear", tabId: "alpha-dev" });
  server.savingTabs.set("alpha-dev", 1);
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.deepEqual([ws.messages.at(-1).type, ws.messages.at(-1).reason], ["chatUndoRejected", "busy"]);
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true, "the undo is still available");
  server.savingTabs.delete("alpha-dev");
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.equal(server.pendingClearUndos.has("alpha-dev"), false, "control: once the Save is done the undo works");
});

test("cleanScratch deletes nothing when a saved chat cannot be read (a chat path that is a directory)", async () => {
  const server = await loadServer({ skipHealth: true }), dir = path.join(server.testRoot, "scratch-unreadable"); mkdirSync(dir);
  const chats = path.join(server.testRoot, "chats-unreadable"); mkdirSync(chats, { recursive: true });
  const unreadable = path.join(chats, "beta-dev.jsonl"); mkdirSync(unreadable);
  const oldFile = path.join(dir, "paste-33333333-3333-3333-3333-333333333333.png"); writeFileSync(oldFile, "x");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); utimesSync(oldFile, old, old);
  try {
    await server.cleanScratch(dir, chats);
    assert.equal(existsSync(oldFile), true, "an unreadable chat may reference it: kept");
    rmdirSync(unreadable);
    await server.cleanScratch(dir, chats);
    assert.equal(existsSync(oldFile), false, "control: with every chat readable it is deleted");
  } finally { for (const empty of [unreadable, chats]) { try { rmdirSync(empty); } catch { /* already removed */ } } }
});

test("cleanScratch: a chats path that is a file keeps old uploads; a missing chats folder lets an old unreferenced upload go", async () => {
  const server = await loadServer({ skipHealth: true }), dir = path.join(server.testRoot, "scratch-chatsfile"); mkdirSync(dir);
  const oldFile = path.join(dir, "paste-44444444-4444-4444-4444-444444444444.png"); writeFileSync(oldFile, "x");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); utimesSync(oldFile, old, old);
  const chatsAsFile = path.join(server.testRoot, "chats-is-a-file"); writeFileSync(chatsAsFile, "not a folder");
  try {
    await server.cleanScratch(dir, chatsAsFile);
    assert.equal(existsSync(oldFile), true, "chats folder unreadable (ENOTDIR): cleanup skipped, upload kept");
    await server.cleanScratch(dir, path.join(server.testRoot, "chats-missing"));
    assert.equal(existsSync(oldFile), false, "control: a missing chats folder means no references, old upload deleted");
  } finally { rmSync(chatsAsFile, { force: true }); rmSync(oldFile, { force: true }); }
});

test("approvalSummary never hides a path silently: 600 long paths show whole paths and a count of the hidden files", async () => {
  const server = await loadServer({ skipHealth: true });
  const paths = Array.from({ length: 600 }, (_, i) => `C:/work/project/src/deeply/nested/folder/file-number-${String(i).padStart(4, "0")}.ts`);
  const summary: string = server.approvalSummary({ paths, changes: "the change text", grantRoot: "C:/granted-root" });
  assert.ok(summary.length <= 20000, `capped: ${summary.length}`);
  const lines = summary.split("\n");
  const shownPaths = lines.filter((line) => paths.includes(line));
  assert.ok(shownPaths.length > 0 && shownPaths.length < 600, "some but not all paths fit");
  assert.deepEqual(shownPaths, paths.slice(0, shownPaths.length), "whole paths, in order, none cut mid-way");
  const hidden = 600 - shownPaths.length;
  const notice = lines.find((line) => line.startsWith("... and "));
  const hiddenChars = paths.slice(shownPaths.length).join("\n").length;
  assert.equal(notice, `... and ${hidden} more files not shown (${hiddenChars} characters)`, "exact hidden count and character count");
  assert.ok(summary.length > 19000, `shown paths use the room: ${summary.length}`);
  assert.ok(summary.endsWith("\nAlso asks for write access to: C:/granted-root"), "grantRoot survives");
  assert.equal(lines.every((line) => line === notice || line.startsWith("Also asks") || paths.includes(line)), true, "no partial line");
  const small = server.approvalSummary({ paths: ["C:/a.ts", "C:/b.ts"], changes: "edit" });
  assert.equal(small, "C:/a.ts\nC:/b.ts\n\nedit", "control: a short list is unchanged");
});

test("approvalSummary carries what Allow approves: OpenCode patterns and diff, Codex folder and reason, a long Write with its notice", async () => {
  const server = await loadServer({ skipHealth: true });
  assert.equal(server.approvalSummary({ file_path: "C:/w/a.ts", patterns: ["C:/w/a.ts", "C:/w/b.ts"], diff: "-old\n+new" }, "Edit"), "C:/w/a.ts\nC:/w/b.ts\n\n-old\n+new");
  assert.equal(server.approvalSummary({ command: "git status", cwd: "C:/repo", reason: "check the tree" }, "Bash"), "git status\n\nRuns in: C:/repo\n\nReason: check the tree");
  assert.equal(server.approvalSummary({ command: "Get-Date" }, "PowerShell"), "Get-Date", "control: a bare command is unchanged");
  assert.equal(server.approvalSummary({ weird: 1 }, "Other"), '{"weird":1}', "anything else keeps the JSON fallback");
  const big = server.approvalSummary({ file_path: "C:/w/big.txt", content: "x".repeat(30000) }, "Write");
  const bigMain = "C:/w/big.txt\n\nNew content:\n" + "x".repeat(30000);
  assert.equal(big, `${bigMain.slice(0, 20000)}\n... (${bigMain.length - 20000} more characters not shown)`, "exact shown text and exact hidden count");
});

test("clients exist before crash handlers run during startup, so an early broadcast cannot hit a TDZ", async () => {
  const errors: string[] = [], logs = { log() {}, error: (value: string) => errors.push(value) } as any;
  const server = await loadServer({ skipHealth: true, console: logs });
  assert.doesNotThrow(() => server.processHandlers.uncaughtException(new Error("startup probe")));
  assert.ok(errors.some((line) => /uncaught exception: startup probe/.test(line)));
  assert.equal(errors.some((line) => /handler itself failed/.test(line)), false);
});

test("crash handlers survive null and plain-object errors and describe each through broadcast", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.processHandlers.uncaughtException(null);
  server.processHandlers.unhandledRejection({ message: "plain rejection" });
  const messages = ws.messages.filter((message: any) => message.type === "error").map((message: any) => message.message);
  assert.ok(messages.some((message: string) => /internal error: null/.test(message)));
  assert.ok(messages.some((message: string) => /plain rejection/.test(message)));
});

test("createLeader: a null native CLI path reaches the SDK builder without a fallback", () => {
  let options: any;
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }) };
  const createLeader = loadLeaderHarness((args) => { options = args.options; return handle; });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {} });
  assert.equal(Object.hasOwn(options, "pathToClaudeCodeExecutable"), false); instance.stop();
});

test("createLeader: a real result message reaches the usage callback scoped to the current model", async () => {
  const output: any[] = []; let resolve!: (value: any) => void;
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((done) => { resolve = done; }), return: async () => ({ done: true }) };
  const createLeader = loadLeaderHarness(() => handle);
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage: (event: any) => output.push(event), onError() {} });
  await tick(0); resolve({ done: false, value: { type: "result", usage: { input_tokens: 4 }, modelUsage: { "claude-opus-5-5[1m]": { contextWindow: 1000000 } }, total_cost_usd: 0.04 } }); await tick(0);
  assert.deepEqual(output[0], { modelId: "claude-opus-5-5[1m]", contextTokens: 4, contextWindow: 1000000, costUsd: 0.04 }); instance.stop();
});

test("createLeader: a resolved CLI path reaches the SDK options unchanged", () => {
  let options: any; const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }) };
  const createLeader = loadLeaderHarness((args) => { options = args.options; return handle; });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", "C:/bin/claude.exe", { onDelta() {}, onDone() {}, onUsage() {}, onError() {} });
  assert.equal(options.pathToClaudeCodeExecutable, "C:/bin/claude.exe"); assert.equal(options.extraArgs.effort, "high"); instance.stop();
});

test("createLeader: a successful live model change scopes the next result to the new model", async () => {
  let resolve!: (value: any) => void; const received: any[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((done) => { resolve = done; }), return: async () => ({ done: true }), setModel: async () => {} };
  const instance = loadLeaderHarness(() => handle)({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage: (delta: any) => received.push(delta), onError() {} });
  await tick(0); assert.equal(await instance.setModel("claude-opus-5"), true);
  resolve({ done: false, value: { type: "result", usage: { input_tokens: 6 }, modelUsage: { "claude-opus-5": { contextWindow: 200000 } } } }); await tick(0);
  assert.equal(received[0].modelId, "claude-opus-5"); assert.equal(received[0].contextWindow, 200000); instance.stop();
});

test("createLeader: a live model change does not rewrite the model captured by an in-flight turn", async () => {
  let resolve!: (value: any) => void; const received: any[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((done) => { resolve = done; }), return: async () => ({ done: true }), setModel: async () => {} };
  const instance = loadLeaderHarness(() => handle)({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage: (delta: any) => received.push(delta), onError() {} });
  await tick(0); resolve({ done: false, value: { type: "result", usage: { input_tokens: 6 }, modelUsage: { "claude-opus-5-5[1m]": { contextWindow: 1000000 } } } }); await tick(0);
  assert.equal(received[0].modelId, "claude-opus-5-5[1m]"); instance.stop();
});

test("createLeader: setModel calls the SDK handle directly without stop, return, abort, or restart", async () => {
  let returns = 0, abortSignal: any; const models: string[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => { returns++; return { done: true }; }, setModel: async (model: string) => { models.push(model); } };
  const instance = loadLeaderHarness((args) => { abortSignal = args.options.abortController.signal; return handle; })({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {} });
  await tick(0); assert.equal(await instance.setModel("claude-opus-5"), true);
  assert.deepEqual(models, ["claude-opus-5"]); assert.equal(returns, 0); assert.equal(abortSignal.aborted, false); instance.stop();
});

test("createLeader: setModel after stop is a no-op and never reaches the SDK handle", async () => {
  let calls = 0; const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }), setModel: async () => { calls++; } };
  const instance = loadLeaderHarness(() => handle)({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {} });
  await tick(0); instance.stop(); assert.equal(await instance.setModel("claude-opus-5"), false); assert.equal(calls, 0);
});

test("createLeader applies its startup mode and forwards live mode changes to the SDK handle", async () => {
  const startupModes: string[] = [], liveModes: string[] = [];
  const handle = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise(() => {}),
    return: async () => ({ done: true }),
    setPermissionMode: async (mode: string) => { liveModes.push(mode); },
  };
  const instance = loadLeaderHarness((args) => { startupModes.push(args.options.permissionMode); return handle; })(
    { model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null,
    { onDelta() {}, onDone() {}, onUsage() {}, onError() {} }, undefined, "bypass",
  );
  await tick(0);
  assert.deepEqual(startupModes, ["bypassPermissions"]);
  assert.equal(await instance.setPermissionMode("ask"), true);
  assert.deepEqual(liveModes, ["default"]);
  instance.stop();
});

test("createLeader returns false when a live permission apply resolves after stop", async () => {
  let resolvePermission!: () => void;
  const handle = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise(() => {}),
    return: async () => ({ done: true }),
    setPermissionMode: () => new Promise<void>((resolve) => { resolvePermission = resolve; }),
  };
  const instance = loadLeaderHarness(() => handle)(
    { model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null,
    { onDelta() {}, onDone() {}, onUsage() {}, onError() {} },
  );
  await tick(0);
  const applying = instance.setPermissionMode("plan");
  await tick(0);
  instance.stop();
  resolvePermission();
  assert.equal(await applying, false, "the stopped SDK handle cannot report a successful live change");
});

test("isSeatBusy: working runs count as busy and completed process state does not", () => {
  const state = processEngine.createTabState("dev", "main", { tabId: "tab", folderPath: "C:/work" });
  assert.equal(processEngine.isBusy(state), false);
  const working = processEngine.runEvent(state, { type: "start", run: { id: "run-1", seatSlotId: "coder", label: "work", startedAt: 1 } });
  assert.equal(processEngine.isBusy(working), true);
  const done = processEngine.runEvent(working, { type: "finish", runId: "run-1", endedAt: 2, outcome: "done" });
  assert.equal(processEngine.isBusy(done), false);
});

test("launch brakes: kill blocks and launch-budget timestamps survive a fresh server module", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json"), first = await loadServer({ skipHealth: true, safetyPath });
  first.launchWorker("alpha-dev", "reviewer2", "run then stop");
  const ws = connect(first); ws.message({ type: "killRun", runId: first.launched[0].run.runId });
  const restarted = await loadServer({ skipHealth: true, safetyPath });
  assert.deepEqual(restarted.safety().blocked, ["alpha-dev.reviewer2"]);
  assert.equal(restarted.safety().timestamps.length, 1);
  assert.match(restarted.launchWorker("alpha-dev", "reviewer2", "client bypass").error, /launch blocked/);
  assert.match(restarted.leaderLaunch("alpha-dev", "reviewer2", "blocked").error, /launch blocked/);
});

test("launch brakes: a stall relaunch is recorded only after its real close callback and keeps the same brief", async () => {
  const server = await loadServer({ relaunchable: true, skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "same original brief"); const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.launched.length, 1); assert.equal(server.safety().timestamps.length, 1);
  server.closeRun(first.run.runId);
  assert.equal(server.launched.length, 2); assert.equal(server.launched[1].prompt, "same original brief");
  assert.equal(server.safety().timestamps.length, 1, "the automatic retry reuses its reserved launch and costs no second slot");
  assert.ok(ws.messages.some((message: any) => message.type === "runStop" && message.runId === first.run.runId));
});

test("launch notices: an offline launch survives restart, replays to the client, and its single-message ACK persists", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json"), first = await loadServer({ skipHealth: true, safetyPath });
  first.leaderLaunch("alpha-dev", "coder", "offline notice");
  const restarted = await loadServer({ skipHealth: true, safetyPath }), ws = connect(restarted);
  ws.message({ type: "hello" });
  const notice = lastState(ws).launchSafety.notices[0];
  assert.equal(notice.brief, "offline notice");
  ws.message({ type: "ackLaunchNotice", id: notice.id });
  assert.equal(config.readLaunchSafety(safetyPath).notices.length, 0);
});

test("launch recovery UI: the released PID warning survives state replay and a confirmed close removes it", async () => {
  const server = await loadServer({ skipHealth: true, releaseUnconfirmed: () => true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "uncertain run"); const entry = server.launched[0];
  entry.callback.onUnconfirmedKill(entry.run, 4321);
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.deepEqual(JSON.parse(JSON.stringify(server.stateMessage().releasedProcesses)), [{ seatId: "alpha-dev.reviewer2", pid: 4321 }]);
  assert.equal(server.stateMessage().launchSafety.uncertain.length, 0);
  server.closeRun(entry.run.runId);
  assert.deepEqual(server.stateMessage().releasedProcesses, []);
});

test("launch recovery: a restarted server preserves unconfirmed ownership until the user deliberately releases it", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json"), first = await loadServer({ skipHealth: true, safetyPath });
  first.launchWorker("alpha-dev", "reviewer2", "uncertain"); const entry = first.launched[0]; entry.callback.onUnconfirmedKill(entry.run, 7654);
  const restarted = await loadServer({ skipHealth: true, safetyPath });
  assert.match(restarted.launchWorker("alpha-dev", "reviewer2", "blocked").error, /unconfirmed process/);
  const ws = connect(restarted); ws.message({ type: "releaseUnconfirmedSeat", seatId: "alpha-dev.reviewer2", confirm: "release may leave a process running and editing files" });
  assert.equal(restarted.launchSafety.uncertain.length, 0);
  assert.equal(restarted.launchSafety.released[0].pid, 7654);
  assert.match(restarted.launchWorker("alpha-dev", "reviewer2", "still blocked").error, /launch blocked/);
  ws.message({ type: "unblockSeat", seatKey: "alpha-dev.reviewer2", confirm: "allow this seat to launch again" });
  assert.equal(restarted.launchWorker("alpha-dev", "reviewer2", "explicitly released").ok, true);
});

test("launch recovery: retry keeps unconfirmed ownership until explicit release frees the seat", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true, releaseUnconfirmed: () => true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "uncertain run"); const entry = server.launched[0]; entry.callback.onUnconfirmedKill(entry.run, 2222);
  assert.match(server.launchWorker("alpha-dev", "reviewer2", "blocked").error, /unconfirmed process/);
  ws.message({ type: "killRun", runId: entry.run.runId }); assert.deepEqual(server.kills, [entry.run.runId]);
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.equal(server.launchSafety.released[0].runId, entry.run.runId);
  assert.match(server.launchWorker("alpha-dev", "reviewer2", "still blocked").error, /launch blocked/);
  ws.message({ type: "unblockSeat", seatKey: entry.run.seatKey, confirm: "allow this seat to launch again" });
  assert.equal(server.launchWorker("alpha-dev", "reviewer2", "after explicit release").ok, true);
  for (const launched of server.launched) server.closeRun(launched.run.runId, 0);
  assert.equal(server.active.size, 0, "every run this test started is closed");
});

test("launch safety: a failed durable reservation blocks spawn, but disk failure never suppresses Kill", async () => {
  let fail = true; const server = await loadServer({ skipHealth: true, failSafety: () => fail }), ws = connect(server);
  assert.equal(server.launchWorker("alpha-dev", "reviewer2", "must not spawn").ok, false);
  assert.equal(server.launched.length, 0); fail = false;
  server.launchWorker("alpha-dev", "reviewer2", "running"); const id = server.launched[0].run.runId; fail = true;
  ws.message({ type: "killRun", runId: id }); assert.deepEqual(server.kills, [id]);
});

test("launch safety: corrupt persisted state refuses startup instead of resetting brakes", async () => {
  const safetyPath = path.join(tempRoot(), "corrupt-launch-safety.json"); await writeFile(safetyPath, "not JSON");
  await assert.rejects(loadServer({ skipHealth: true, safetyPath }), /JSON|Unexpected/);
});

test("leader health-check options strip CC_DATA_DIR from the actual SDK environment", async () => {
  const previousRoot = process.env.CC_DATA_DIR, previousPackaged = process.env.CC_TEST_FORCE_PACKAGED;
  process.env.CC_DATA_DIR = "C:/private/never-open-this"; process.env.CC_TEST_FORCE_PACKAGED = "1"; process.env.CC_APP_KEY = "test-app-key-must-not-leak";
  let env: any;
  try {
    const server = await loadServer({ realLeaderOptions: true, query: (args) => { env = args.options.env; return { [Symbol.asyncIterator]: async function* () { yield { type: "result" }; } }; } });
    await server.leaderHealthCheck;
  } finally {
    delete process.env.CC_APP_KEY;
    if (previousRoot === undefined) delete process.env.CC_DATA_DIR; else process.env.CC_DATA_DIR = previousRoot;
    if (previousPackaged === undefined) delete process.env.CC_TEST_FORCE_PACKAGED; else process.env.CC_TEST_FORCE_PACKAGED = previousPackaged;
  }
  assert.equal(Object.hasOwn(env, "CC_DATA_DIR"), false); assert.equal(Object.hasOwn(env, "CC_TEST_FORCE_PACKAGED"), false); assert.equal(Object.hasOwn(env, "CC_APP_KEY"), false, "the leader's SDK child never sees the app key");
});

test("leader launch strips CC_DATA_DIR from the actual SDK options", () => {
  const previousRoot = process.env.CC_DATA_DIR, previousPackaged = process.env.CC_TEST_FORCE_PACKAGED;
  process.env.CC_DATA_DIR = "C:/private/never-open-this"; process.env.CC_TEST_FORCE_PACKAGED = "1"; process.env.CC_APP_KEY = "test-app-key-must-not-leak";
  try {
    const options = leaderApi.buildLeaderOptions({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null);
    assert.equal(Object.hasOwn(options.env, "CC_DATA_DIR"), false); assert.equal(Object.hasOwn(options.env, "CC_TEST_FORCE_PACKAGED"), false); assert.equal(Object.hasOwn(options.env, "CC_APP_KEY"), false);
  } finally {
    delete process.env.CC_APP_KEY;
    if (previousRoot === undefined) delete process.env.CC_DATA_DIR; else process.env.CC_DATA_DIR = previousRoot;
    if (previousPackaged === undefined) delete process.env.CC_TEST_FORCE_PACKAGED; else process.env.CC_TEST_FORCE_PACKAGED = previousPackaged;
  }
});

test("leader stop settles waiting input, aborts and returns the query, and suppresses late errors", async () => {
  let input: any, output!: (value: any) => void, returns = 0; const errors: string[] = [], deltas: string[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((resolve) => { output = resolve; }), return: async () => { returns++; output?.({ done: true }); return { done: true }; } };
  const instance = loadLeaderHarness((args) => { input = args.prompt; return handle; })({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta: (text: string) => deltas.push(text), onDone() {}, onUsage() {}, onError: (error: string) => errors.push(error) });
  await tick(0); const pending = input.next(); instance.stop();
  const settled = await Promise.race([pending, tick(100).then(() => "hung")]); assert.notEqual(settled, "hung");
  output({ done: false, value: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "late" } } } }); await tick(0);
  assert.equal(returns, 1); assert.deepEqual(deltas, []); assert.deepEqual(errors, []);
});

test("leader stop then a rejecting iterator reports no error to the client and the leader is dead", async () => {
  let reject!: (error: Error) => void; const errors: string[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((_ok, no) => { reject = no; }), return: async () => ({ done: true }) };
  const instance = loadLeaderHarness(() => handle)({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (error: string) => errors.push(error) });
  await tick(0); instance.stop();
  reject(new Error("late sdk failure")); await tick(0);
  assert.deepEqual(errors, []); assert.equal(instance.isDead(), true);
});

test("leader send after an intentional stop is ignored: no 'not available' error reaches the client", async () => {
  let output!: (value: any) => void; const errors: string[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((resolve) => { output = resolve; }), return: async () => { output?.({ done: true }); return { done: true }; } };
  const instance = loadLeaderHarness(() => handle)({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (error: string) => errors.push(error) });
  await tick(0); instance.stop(); await tick(0);
  assert.equal(instance.isDead(), true, "control: the stopped leader's loop has ended, so send would reach the dead branch");
  instance.send("after stop");
  assert.deepEqual(errors, []);
});

test("listHistory rejects an unsafe seat key before asking the filesystem for any directory", async () => {
  const reads: string[] = [], server = await loadServer({ skipHealth: true, readdir: (async (dir: any) => { reads.push(String(dir)); return readdir(dir); }) as any }), ws = connect(server);
  const before = reads.length; ws.message({ type: "historyList", seatKey: "../escape" }); await tick();
  assert.equal(reads.length, before); assert.match(ws.messages.at(-1).message, /invalid seat key/);
});

test("listHistory reports a missing or unreadable logs directory instead of returning fake empty history", async () => {
  const server = await loadServer({ skipHealth: true, readdir: (async () => { throw new Error("logs directory missing"); }) as any }), ws = connect(server);
  ws.message({ type: "historyList", seatKey: "alpha-dev.reviewer2" }); await tick();
  assert.match(ws.messages.at(-1).message, /logs directory missing/);
});

test("message handler catches a dispatch error and continues handling a following valid message", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "setProcess", tabId: "missing", process: "solo" });
  ws.message({ type: "hello" });
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /unknown tab/.test(message.message)));
  assert.ok(lastState(ws));
});

test("normal leader iterator completion marks the leader dead and reports the ended instance once", async () => {
  const errors: string[] = [], createLeader = loadLeaderHarness(() => ({ [Symbol.asyncIterator]() { return this; }, next: async () => ({ done: true }), return: async () => ({ done: true }) }));
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (error: string) => errors.push(error) });
  await tick(0); assert.equal(instance.isDead(), true); assert.equal(errors.length, 1);
});

test("a dead tab leader rejects new chat instead of silently queueing it for a replacement", async () => {
  let input: any;
  const errors: string[] = [];
  const createLeader = loadLeaderHarness((args) => {
    input = args.prompt;
    return { [Symbol.asyncIterator]() { return this; }, next: async () => ({ done: true }), return: async () => ({ done: true }) };
  });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (error: string) => errors.push(error) });
  await tick(0);
  assert.equal(instance.isDead(), true);
  instance.send("must not queue");
  assert.match(errors.at(-1) ?? "", /not available/);
  const pending = input.next();
  const result = await Promise.race([pending, tick(20).then(() => undefined)]);
  assert.equal(result, undefined, "dead leader input must not yield the rejected chat to its old prompt stream");
  instance.stop();
  assert.equal((await pending).done, true);
});

test("null-message guard: the actual WebSocket callback rejects invalid envelopes and stays alive", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  for (const raw of ["null", "[]", "3", "{}", "{\"type\":3}"]) ws.message(raw);
  assert.equal(ws.messages.filter((message: any) => message.type === "error").length, 5);
  ws.message({ type: "hello" }); assert.ok(lastState(ws));
});

test("output trim: the real runner callback keeps a 200KB UTF-8 cap at whole-character boundaries", async () => {
  const server = await loadServer({ skipHealth: true }); connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "large output"); const entry = server.launched[0];
  server.emitOutput(entry.run.runId, "🙂".repeat(90_000));
  const run = server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
  assert.equal(Buffer.byteLength(run.output, "utf8"), 200 * 1024); assert.equal(run.output.endsWith("🙂"), true);
});

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
  assert.equal(JSON.parse(run.stdout.trim().split("\n").at(-1)!).toLowerCase(), exe.replaceAll("\\", "/").toLowerCase());
});

test("runSeat dispatch rejects the in-process leader slot before any worker runner call", async () => {
  const server = await loadServer({ skipHealth: true });
  assert.match(server.launchWorker("alpha-dev", "leader", "not a worker").error, /leader runs in-process/);
  assert.equal(server.launched.length, 0);
});

test("runSeat dispatch wires actual onOutput to the run replay buffer and WebSocket broadcast", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "stream output"); const entry = server.launched[0];
  server.emitOutput(entry.run.runId, "visible answer");
  const run = server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
  assert.equal(run.output, "visible answer");
  assert.ok(ws.messages.some((message: any) => message.type === "output" && message.runId === entry.run.runId && message.chunk === "visible answer"));
});

test("runSeat dispatch wires status changes to process state and run lifecycle broadcasts", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "finish me"); const entry = server.launched[0];
  server.closeRun(entry.run.runId, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "runFinish" && message.runId === entry.run.runId));
  assert.equal(server.stateMessage().projects[0].tabs[0].runs.find((run: any) => run.runId === entry.run.runId).status, "done");
});

test("server.listen returns without waiting for a hung startup check, which aborts at its timeout", async () => {
  const errors: string[] = [], logs = { log() {}, error: (text: string) => errors.push(text) } as any;
  let signal: AbortSignal | undefined;
  const server = await loadServer({ healthTimeoutMs: 10, console: logs, query: (args) => {
    signal = args.options.abortController.signal;
    return { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }) };
  } });
  assert.equal(server.listenCalls(), 1);
  assert.equal(server.listenedPort(), 0, "test server requests an OS-assigned port, not 4317");
  await server.leaderHealthCheck;
  assert.equal(signal?.aborted, true); assert.ok(errors.some((line) => /health check timed out/.test(line)));
});

test("stall: an Atlas-started worker stays attributed to Atlas through its one automatic rerun", async () => {
  const writes: config.LaunchSafety[] = [];
  const server = await loadServer({ relaunchable: true, skipHealth: true, deferKill: true, onSafetyWrite: (value) => writes.push(value) }), ws = connect(server);
  server.leaderLaunch("alpha-dev", "reviewer2", "Atlas brief"); const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  server.closeRun(first.run.runId);
  const second = server.launched[1];
  assert.equal(second.prompt, "Atlas brief");
  assert.equal(ws.messages.find((message: any) => message.type === "runStart" && message.runId === second.run.runId).launchedByLeader, true);
  const notices = ws.messages.filter((message: any) => message.type === "leaderLaunch");
  assert.equal(notices.length, 2);
  assert.deepEqual(notices.map((message: any) => message.source), ["Atlas", "Stall relaunch"]);
  assert.ok(writes.some((value) => value.notices.some((notice) => notice.seatId === "alpha-dev.reviewer2" && notice.source === "Stall relaunch" && notice.pending)), "the relaunch notice is durable before the stall replacement starts");
});

test("stall: a second stall for the same logical run escalates instead of relaunching again", async () => {
  const server = await loadServer({ skipHealth: true });
  server.launchWorker("alpha-dev", "reviewer2", "one retry"); const first = server.launched[0];
  server.stallTrackers.markRelaunched(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.launched.length, 1);
  assert.ok(server.stateMessage().projects[0].tabs[0].runs.some((run: any) => run.runId === first.run.runId));
});

test("stall: a silent read-only Codex run is marked stalled, killed, and relaunched with the same brief once", async () => {
  const server = await loadServer({ relaunchable: true, skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "identical retry brief"); const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.launched.length, 2); assert.equal(server.launched[1].prompt, "identical retry brief");
  assert.equal(server.launched[1].run.canWrite, false);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.runId === first.run.runId && message.action === "relaunch"));
});

test("stall: visible output after a stall recovers the actual run callback back to working", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "recover"); const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(entry.run.runId), true);
  server.emitOutput(entry.run.runId, "new visible bytes");
  assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(entry.run.runId), false);
  assert.ok(ws.messages.some((message: any) => message.type === "output" && message.chunk === "new visible bytes"));
  server.closeRun(entry.run.runId, 0);
  assert.equal(server.active.size, 0, "the run this test started is closed");
});

test("stall: visible stderr bytes use the same real output callback and recover the tracker", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true }); connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "stderr recovery"); const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  server.emitOutput(entry.run.runId, "stderr: still working", "stderr");
  assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(entry.run.runId), false);
  assert.equal(server.stateMessage().projects[0].tabs[0].runs.find((run: any) => run.runId === entry.run.runId).output, "stderr: still working");
  server.closeRun(entry.run.runId, 0);
  assert.equal(server.active.size, 0, "the run this test started is closed");
});

test("stall: a run that cannot be relaunched is marked stalled immediately and never gets Kill", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "no relaunch"); const entry = server.launched[0];
  server.stallTrackers.startRun(entry.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.kills.length, 0); assert.equal(server.launched.length, 1);
  assert.ok(ws.messages.some((message: any) => message.type === "runStalled" && message.action === "escalate"));
});

test("startLeader wires its tab crew MCP server and explicit allowed-tools list without a prompt", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start leader" }); await tick();
  const tools = server.leaderToolOptions[0];
  assert.ok(tools.mcpServers["tab-crew"]); assert.deepEqual([...tools.allowedTools], ["get_crew_status", "launch_seat", "send_request", "list_requests"]);
});


test("two workspaces migrations racing for one destination preserve the first published file", () => {
  const root = tempRoot(), configDir = path.join(root, "config"); mkdirSync(configDir);
  const projects = path.join(configDir, "projects.json"), destination = path.join(configDir, "workspaces.json");
  writeFileSync(projects, JSON.stringify([{ id: "race", name: "First", dir: "C:/first" }]));
  const first = config.migrateWorkspaces(projects, destination); const before = readFileSync(destination, "utf8");
  writeFileSync(projects, JSON.stringify([{ id: "race", name: "Second", dir: "C:/second" }]));
  const second = config.migrateWorkspaces(projects, destination);
  assert.equal(first, true); assert.equal(second, false); assert.equal(readFileSync(destination, "utf8"), before);
});

test("updateSeat for the tab leader calls live setModel and does not stop or restart the session", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" }); await tick();
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5" }); await tick();
  assert.deepEqual(server.leaderHandles[0].modelCalls, ["claude-opus-5"]); assert.equal(server.leaderHandles[0].stopCalls, 0);
  assert.equal(lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader").model, "claude-opus-5");
});

test("live leader model change saves name, effort, and pic from the same message", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" }); await tick();
  const pic = "/api/avatar/avatar-00000000-0000-4000-8000-000000000001.png";
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", name: "Atlas New", model: "claude-opus-5", effort: "high", pic });
  await tick();
  const leader = lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader");
  assert.deepEqual([leader.name, leader.model, leader.effort, leader.pic], ["Atlas New", "claude-opus-5", "high", pic]);
  assert.deepEqual(server.leaderHandles[0].modelCalls, ["claude-opus-5"]);
});

test("updateSeat on a dead tab leader skips live setModel but still saves the chosen model", async () => {
  const server = await loadServer({ skipHealth: true, leaderDead: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create dead leader" }); await tick();
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5" });
  assert.deepEqual(server.leaderHandles[0].modelCalls, []);
  assert.equal(lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader").model, "claude-opus-5");
});

test("updateSeat: a rejected live model change keeps the old saved value and sends an error", async () => {
  const server = await loadServer({ skipHealth: true, setModelResult: false }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" }); await tick();
  const before = lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader").model;
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5" }); await tick();
  assert.equal(lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "leader").model, before);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /model change failed/.test(message.message)));
});

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
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "review");
  const entry = server.launched[0], run = server.stateMessage().projects[0].tabs[0].runs[0];
  assert.equal(Object.hasOwn(run, "usage"), false);
  assert.equal(Object.hasOwn(run, "costUsd"), false);
  entry.callback.onUsage(entry.run, { modelId: null, contextTokens: 11, contextWindow: null, costUsd: 0.03 });
  const wireRun = lastState(ws).projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
  assert.equal(wireRun.usage.contextTokens, 11); assert.equal(wireRun.usage.costUsd, 0.03);
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

test("a leader's send_request always comes from the leader's own tab, even when another tab is selected", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start scoped leader" });
  await tick();
  const deps = server.leaderDeps.get("Development");
  ws.message({ type: "selectTab", tabId: "beta-dev" });
  assert.equal(lastState(ws).selectedTabId, "beta-dev");
  const created = deps.sendRequest("alpha-design", "From alpha", "Sent while beta is selected.");
  assert.equal(created.request.fromTabId, "alpha-dev", "the source is the leader's tab, not the selected tab");
  assert.equal(server.requestsStore.list().find((row: any) => row.id === created.request.id).fromTabId, "alpha-dev");
});

test("a tab over the pending request cap is refused with a clear message and the echoed id, from the panel and from the leader", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  const exists = (tabId: string) => ["alpha-dev", "beta-dev"].includes(tabId);
  for (let index = 0; index < 50; index++) server.requestsStore.send({ fromTabId: "alpha-dev", toTabId: "beta-dev", title: `Fill ${index}`, body: "Filler." }, exists);
  ws.message({ type: "sendRequest", requestId: "send_over_cap", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "One too many", body: "Refused." });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "send_over_cap"), "over-cap refusal");
  const refusal = ws.messages.find((message: any) => message.type === "error" && message.requestId === "send_over_cap");
  assert.match(refusal.message, /too many pending requests from this tab/);
  assert.equal(server.requestsStore.list().length, 50);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start scoped leader" });
  await tick();
  assert.throws(() => server.leaderDeps.get("Development").sendRequest("beta-dev", "Leader extra", "Refused."), /too many pending requests/);
  const failed = Object.values(server.stateMessage().requestActions).filter((action: any) => action.status === "failed" && /too many pending/.test(action.message));
  assert.equal(failed.length >= 1, true);
  assert.equal(server.requestsStore.list().length, 50);
});

test("a permission change for a tab that does not exist is refused and leaves nothing in state", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  ws.message({ type: "setPermissionMode", requestId: "perm_ghost", tabId: "zz-not-a-tab", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "perm_ghost"), "unknown tab refusal");
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionActions, "zz-not-a-tab"), false);
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionModes, "zz-not-a-tab"), false);
  ws.message({ type: "setPermissionMode", requestId: "perm_real", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "perm_real"), "real tab result");
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionActions, "alpha-dev"), true, "a real tab still records its action");
});

async function twoTabApprovals() {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create leader" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "create leader" });
  await tick();
  for (const tabId of ["alpha-dev", "beta-dev"]) {
    ws.message({ type: "setPermissionMode", requestId: `two_tab_${tabId}`, tabId, mode: "ask" });
    await waitFor(() => server.settingsService.permissionMode(tabId) === "ask", `${tabId} ask`);
  }
  return { server, ws };
}
const tabState = (ws: any, tabId: string) => lastState(ws).projects.flatMap((project: any) => project.tabs).find((tab: any) => tab.id === tabId);

test("each tab's state lists only its own pending approvals", async () => {
  const { server, ws } = await twoTabApprovals();
  void server.gatedLeaderLaunch("alpha-dev", server.leaderInstances.get("alpha-dev"), "coder", "alpha work");
  void server.gatedLeaderLaunch("beta-dev", server.leaderInstances.get("beta-dev"), "coder", "beta work");
  await waitFor(() => server.pendingApprovals.size === 2, "two pending approvals");
  const listed = server.stateMessage().projects.flatMap((project: any) => project.tabs).map((tab: any) => [tab.id, tab.pendingApprovals.map((item: any) => item.summary)]).filter(([, list]: any) => list.length);
  assert.equal(JSON.stringify(listed), JSON.stringify([["alpha-dev", ["Sonny (Coder)\nalpha work"]], ["beta-dev", ["Sonny (Coder)\nbeta work"]]]));
});

test("answering an approval with another tab's id is refused even when that tab has a live leader", async () => {
  const { server, ws } = await twoTabApprovals();
  const waiting = server.gatedLeaderLaunch("alpha-dev", server.leaderInstances.get("alpha-dev"), "coder", "alpha work");
  await waitFor(() => server.pendingApprovals.size === 1, "alpha approval");
  const [item] = [...server.pendingApprovals.values()] as any[];
  ws.message({ type: "answerApproval", requestId: "wrong_tab_answer", tabId: "beta-dev", approvalId: item.approvalId, allow: true });
  assert.equal(ws.messages.at(-1).type, "error");
  assert.match(ws.messages.at(-1).message, /no longer available/);
  assert.equal(server.pendingApprovals.size, 1, "the approval is still waiting");
  assert.equal(server.launched.length, 0);
  ws.message({ type: "answerApproval", requestId: "right_tab_answer", tabId: "alpha-dev", approvalId: item.approvalId, allow: false });
  assert.equal((await waiting).ok, false);
});

test("answerApproval without a request id is refused and settles nothing", async () => {
  const { server, ws } = await twoTabApprovals();
  const waiting = server.gatedLeaderLaunch("alpha-dev", server.leaderInstances.get("alpha-dev"), "coder", "alpha work");
  await waitFor(() => server.pendingApprovals.size === 1, "alpha approval");
  const [item] = [...server.pendingApprovals.values()] as any[];
  ws.message({ type: "answerApproval", tabId: "alpha-dev", approvalId: item.approvalId, allow: true });
  assert.equal(ws.messages.at(-1).type, "error");
  assert.match(ws.messages.at(-1).message, /requestId is required/);
  assert.equal(server.pendingApprovals.size, 1);
  assert.equal(server.launched.length, 0);
  ws.message({ type: "answerApproval", requestId: "with_request_id", tabId: "alpha-dev", approvalId: item.approvalId, allow: false });
  assert.equal((await waiting).ok, false);
});

test("the leader test seam needs BOTH test flags; the fake leader flag alone never loads the test module", async () => {
  const server = await loadServer({ skipHealth: true, leaderSeamOnly: true });
  assert.ok(server.wss, "the server starts and ignores a lone CC_TEST_FAKE_LEADER");
  // Control: with both flags the server source does reach for the test module (the vm has no dynamic import), so the check above can go red.
  await assert.rejects(loadServer({ skipHealth: true, bothSeams: true }), { code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING" });
});

test("a slower, older Changes and Notes refresh cannot overwrite a newer one", async () => {
  const gates: Array<(value: any) => void> = [];
  const server = await loadServer({ skipHealth: true, gitChanges: () => new Promise((resolveChanges) => { gates.push(resolveChanges); }) });
  const ws = connect(server);
  const before = gates.length;
  ws.message({ type: "selectTab", tabId: "alpha-dev" });
  ws.message({ type: "selectTab", tabId: "alpha-dev" });
  await waitFor(() => gates.length === before + 2, "two refreshes in flight");
  const changes = (branch: string) => ({ repo: true, branch, ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [] });
  gates[before + 1](changes("newer"));
  await tick();
  assert.equal(tabState(ws, "alpha-dev").changes.branch, "newer");
  gates[before](changes("older"));
  await tick();
  assert.equal(tabState(ws, "alpha-dev").changes.branch, "newer", "the late older refresh was dropped");
});

test("chat refuses a scratch attachment whose name is not file-<uuid>, and takes one that is", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const scratch = path.join(server.testRoot, "scratch");
  mkdirSync(scratch, { recursive: true });
  const odd = path.join(scratch, "notes.txt");
  writeFileSync(odd, "not generated by an upload");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "read this", files: [odd], requestId: "file_odd_name" });
  assert.equal(ws.messages.at(-1).requestId, "file_odd_name");
  assert.match(ws.messages.at(-1).message, /uploaded scratch file/);
  assert.equal(server.leaders.size, 0);
  const good = path.join(scratch, `file-${randomUUID()}.txt`);
  writeFileSync(good, "generated");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "read this", files: [good], requestId: "file_good_name" });
  assert.ok(ws.messages.some((message: any) => message.type === "chatMessage" && message.requestId === "file_good_name"));
  await tick();
});


test("final2 Allow then Plan refuses the writer at resume", async () => {
  for (const timing of ["before Allow", "after Allow"]) {
    const { server, ws, deps } = await launchGateServer("ask");
    const launch = deps.launch("coder", "write");
    await waitForApproval(() => pendingFor(server).length === 1, "launch approval");
    if (timing === "before Allow") server.settingsService.state.permissionModes["alpha-dev"] = "plan";
    ws.message({ type: "answerApproval", requestId: "after_plan", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
    if (timing === "after Allow") server.settingsService.state.permissionModes["alpha-dev"] = "plan";
    const result = await launch;
    assert.equal(server.launched.length, 0, "Plan is active, but Allow launched a write-capable worker");
    assert.match(result.error, /Plan mode/);
  }
});

test("final2 Allow then Clear before resume starts nothing", async () => {
  const { server, ws, deps } = await launchGateServer("ask");
  const launch = deps.launch("coder", "write");
  await waitForApproval(() => pendingFor(server).length === 1, "launch approval");
  ws.message({ type: "answerApproval", requestId: "before_clear", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const result = await launch;
  assert.equal(server.launched.length, 0, "Cleared leader still launches its worker after Allow resumes");
  assert.match(result.error, /leader changed/);
});

test("final2 live default with saved Accept asks through the real SDK hook and launch call site", async () => {
  let sdk: any;
  const server = await loadServer({ skipHealth: true, sdkLeader: ({ options }: any) => {
    sdk = options;
    return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, async return() { return { done: true }; }, async setModel() {}, async setPermissionMode() {} };
  } });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" });
  await sdk.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", permission_mode: "default", tool_name: "mcp__tab-crew__launch_seat", tool_input: {} }, "id", { signal: new AbortController().signal });
  const launch = server.leaderDeps.get("Development").launch("coder", "write");
  await waitForApproval(() => pendingFor(server).length === 1, "live default launch approval");
  assert.equal(server.launched.length, 0, "live default with saved Accept bypassed approval");
  ws.message({ type: "answerApproval", requestId: "live_allow", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
  assert.equal((await launch).ok, true);
  server.leaders.get("alpha-dev").stop();
});

test("final2 live Plan refuses and a changed write capability cancels after Allow", async () => {
  let writable = true;
  const server = await loadServer({ skipHealth: true, seatCapability: () => writable }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" }); await tick();
  const deps = server.leaderDeps.get("Development"), leader = server.leaders.get("alpha-dev");
  leader.getPermissionMode = () => "plan";
  server.settingsService.state.permissionModes["alpha-dev"] = "ask";
  const plan = await Promise.race([deps.launch("coder", "write"), tick(150).then(() => null)]);
  try { assert.equal(plan?.ok, false, "live Plan must refuse without waiting for approval"); }
  finally { pendingFor(server).forEach((item: any) => item.settle(false)); }
  leader.getPermissionMode = () => "default";
  const launch = deps.launch("coder", "write");
  await waitForApproval(() => pendingFor(server).length === 1, "launch approval");
  writable = false;
  ws.message({ type: "answerApproval", requestId: "changed_capability", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
  const result = await launch;
  assert.equal(server.launched.length, 0, "changed seat capability launched after Allow");
  assert.match(result.error, /seat capability changed/);
});

test("final2 an approved launch still runs after switching to Accept or Bypass", async () => {
  for (const mode of ["accept", "bypass"] as const) {
    const { server, ws, deps } = await launchGateServer("ask");
    const launch = deps.launch("coder", "write");
    await waitForApproval(() => pendingFor(server).length === 1, "launch approval");
    await server.leaders.get("alpha-dev").setPermissionMode(mode);
    server.settingsService.state.permissionModes["alpha-dev"] = mode;
    ws.message({ type: "answerApproval", requestId: "changed_" + mode, tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
    assert.equal((await launch).ok, true);
  }
});

async function permissionCompletions(server: any, ws: any, count: number, client: any) {
  for (let index = 0; index < count; index++) {
    const requestId = `final2_permission_${index}`;
    ws.message({ type: "setPermissionMode", requestId, tabId: "beta-dev", mode: "accept" });
    await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === requestId), "permission completed");
    client.onMessage(ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === requestId));
    client.onMessage(server.stateMessage());
  }
}

test("final2 in-flight MCP Add survives overwrite and 33 real permission completions", async () => {
  let release!: () => void, entered = false;
  const server = await loadServer({ skipHealth: true, runCli: async (_bin: string, args: string[]) => {
    if (args[0] === "mcp" && args[1] === "add") { entered = true; await new Promise<void>((resolve) => { release = resolve; }); }
    return { code: 0, stdout: "", stderr: "" };
  } });
  const ws = connect(server), client = actionClient();
  client.setState(server.stateMessage());
  client.pendingSettingsActions.set("mcp-add-claude", "held_mcp");
  ws.message({ type: "mcpAdd", requestId: "held_mcp", cli: "claude", name: "held", commandOrUrl: "npx held" });
  await waitFor(() => entered, "fake MCP Add entered");
  try {
    ws.message({ type: "mcpRemove", requestId: "other_mcp", cli: "claude", name: "other", confirm: true });
    await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "other_mcp"), "other MCP completed");
    await permissionCompletions(server, ws, 33, client);
    assert.equal(server.stateMessage().requestActions.held_mcp?.status, "running", "recent actions evicted a running MCP Add");
    assert.equal(Object.values(server.stateMessage().requestActions).filter((a: any) => a.status !== "running").length, 32);
    assert.equal(client.settingsActionRunning("mcp-add-claude"), true, "MCP add is still in flight, but its Add button is enabled and status is unknown");
    assert.match(client.actionStatusMarkup("mcp-add-claude"), /Working/);
  } finally { release(); }
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "held_mcp"), "held Add completed");
  assert.equal(server.stateMessage().requestActions.held_mcp?.status, "done", "fresh completion must remain among the 32 finished results");
  client.onMessage(ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === "held_mcp"));
  client.onMessage(server.stateMessage());
  assert.equal(client.settingsActionRunning("mcp-add-claude"), false);
  assert.match(client.actionStatusMarkup("mcp-add-claude"), /Done/);
  assert.equal(client.pendingSettingsActions.has("mcp-add-claude"), false, "terminal result retires the pending MCP action");
});

test("final2 folder Save stays Done after 1001 real permission completions and stale running state", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server), client = actionClient();
  client.setState(server.stateMessage());
  client.pendingSettingsActions.set("folder-save", "completed_folder");
  ws.message({ type: "setDefaultProjectFolder", requestId: "completed_folder", folder: server.testRoot });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "completed_folder"), "folder completed");
  client.onMessage(ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === "completed_folder"));
  client.pendingSettingsActions.set("vault-save", "completed_vault");
  ws.message({ type: "setNotesVault", requestId: "completed_vault", path: null });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "completed_vault"), "vault completed");
  client.onMessage(ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === "completed_vault"));
  await permissionCompletions(server, ws, 1001, client);
  assert.equal(client.settingsActionRunning("folder-save"), false, "Completed folder save is disabled as Working after 1001 real server action completions");
  assert.match(client.actionStatusMarkup("folder-save"), /Done/);
  assert.equal(client.pendingSettingsActions.has("folder-save"), false, "onMessage retires completed folder pending record");
  assert.equal(client.resultSize(), 2, "unrelated completions do not grow control results");
  const stale = server.stateMessage(); stale.requestActions.completed_folder = { requestId: "completed_folder", status: "running", message: "Working" };
  client.onMessage(stale);
  assert.equal(client.settingsActionRunning("folder-save"), false, "received completion overrides stale running state");
});

test("final2 request form cleared ids stay bounded across 1100 completions", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  client.setState(server.stateMessage());
  for (let index = 0; index < 1100; index++) {
    const requestId = `cleared_${index}`;
    client.pendingRequestActions.set("alpha-dev", requestId);
    client.node("reqTitle").value = "Title"; client.node("reqBody").value = "Body";
    client.onMessage({ type: "actionResult", action: "sendRequest", requestId });
    client.renderRequests();
    assert.equal(client.node("reqTitle").value, "", "successful send clears its title");
    assert.equal(client.node("reqBody").value, "", "successful send clears its body");
    client.node("reqTitle").value = "next draft"; client.renderRequests();
    assert.equal(client.node("reqTitle").value, "next draft", "same completion never clears a newer draft");
  }
  assert.equal(client.requestFormCleared.size, 1, "requestFormCleared retains every successful send forever");
  assert.equal(client.pendingRequestActions.size, 0, "completed requests retire pending records");
  const state = server.stateMessage(); state.projects = []; client.onMessage(state);
  assert.equal(client.requestFormCleared.size, 0, "removed tabs release cleared ids");
});


test("final2 never evicts more than 32 running actions and releases failed settings actions", async () => {
  const releases: Array<() => void> = [];
  const server = await loadServer({ skipHealth: true, runCli: async (_bin: string, args: string[]) => {
    if (args[0] === "mcp" && args[1] === "add") { await new Promise<void>((resolve) => releases.push(resolve)); return { code: 1, stdout: "", stderr: "failed" }; }
    return { code: 0, stdout: "", stderr: "" };
  } }), ws = connect(server);
  for (let index = 0; index < 40; index++) ws.message({ type: "mcpAdd", cli: "claude", requestId: `running_${index}`, name: "held", commandOrUrl: "npx held" });
  await waitFor(() => releases.length === 40, "40 fake MCP calls");
  try {
    assert.equal(Object.keys(server.stateMessage().requestActions).length, 40, "32 cap must not evict any running action");
  } finally { releases.forEach((release) => release()); }
  await waitFor(() => ws.messages.filter((m: any) => m.type === "error" && m.action === "mcpAdd").length === 40, "all failures finish");
  assert.equal(Object.keys(server.stateMessage().requestActions).length, 32, "finished action history remains bounded");
});

test("final2 a pending id seen listed and then dropped is finished, never stuck on Working", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  const listing = (ids: string[]) => { const state = server.stateMessage(); state.requestActions = Object.fromEntries(ids.map((id) => [id, { requestId: id, status: "running", message: "Working" }])); return state; };
  client.setState(server.stateMessage());
  client.pendingSettingsActions.set("mcp-add-claude", "restart_mcp");
  client.pendingRequestActions.set("alpha-dev", "restart_send");
  client.pendingPermissionAction.set("alpha-dev", "restart_perm");
  client.onMessage(listing(["restart_mcp", "restart_send", "restart_perm"]));
  assert.equal(client.settingsActionRunning("mcp-add-claude"), true, "a listed running id is Working");
  assert.equal(client.seenListedActions.size, 3, "listed pending ids are tracked");
  client.onMessage(listing([]));
  assert.equal(client.settingsActionRunning("mcp-add-claude"), false, "after a server restart the MCP Add button stays disabled as Working forever");
  assert.doesNotMatch(client.actionStatusMarkup("mcp-add-claude"), /Working/);
  assert.equal(client.pendingSettingsActions.size + client.pendingRequestActions.size + client.pendingPermissionAction.size, 0, "dropped ids are retired");
  assert.equal(client.seenListedActions.size, 0, "tracking is bounded by what is still pending");
  client.onMessage({ type: "actionResult", action: "mcpAdd", requestId: "restart_mcp" });
  assert.match(client.actionStatusMarkup("mcp-add-claude"), /Done/, "a late real result replaces the unknown one");
});

test("final2 pending unlisted ids stay running and terminal snapshots retire only the matching id", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  client.setState(server.stateMessage());
  client.pendingSettingsActions.set("folder-save", "new_folder");
  client.onMessage({ type: "actionResult", action: "setDefaultProjectFolder", requestId: "old_folder" });
  assert.equal(client.pendingSettingsActions.get("folder-save"), "new_folder", "old completion must not retire a newer pending id");
  assert.equal(client.settingsActionRunning("folder-save"), true, "a sent id not yet listed stays running");
  const state = server.stateMessage(); state.requestActions.new_folder = { requestId: "new_folder", status: "done", message: "Done" };
  client.onMessage(state); state.requestActions = {}; client.onMessage(state);
  assert.equal(client.pendingSettingsActions.has("folder-save"), false, "listed terminal result retires matching pending id");
  assert.equal(client.settingsActionRunning("folder-save"), false, "listed completed result does not become running when evicted");
  assert.match(client.actionStatusMarkup("folder-save"), /Done/);
});

test("final2 SDK live mode tracks successful switches and tool hook context", async () => {
  let sdk: any, fail = false;
  const leader = loadLeaderHarness(({ options }: any) => {
    sdk = options;
    return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, async return() { return { done: true }; }, async setPermissionMode() { if (fail) throw new Error("failed"); } };
  })({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {} }, undefined, "ask");
  assert.equal(leader.getPermissionMode(), "default", "initial live mode follows saved mode");
  assert.equal(await leader.setPermissionMode("plan"), true);
  assert.equal(leader.getPermissionMode(), "plan", "successful live switch updates launch mode");
  fail = true; assert.equal(await leader.setPermissionMode("accept"), false);
  assert.equal(leader.getPermissionMode(), "plan", "failed live switch preserves launch mode");
  await sdk.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", permission_mode: "default", tool_name: "Read", tool_input: {} }, "id", { signal: new AbortController().signal });
  assert.equal(leader.getPermissionMode(), "default", "hook context updates live launch mode");
  leader.stop(); assert.equal(leader.isDead(), true, "stopped leader cannot resume an approved launch");
});

test("final2 Requests pending status belongs only to the sending tab", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  const state = server.stateMessage(); client.setState(state);
  client.pendingRequestActions.set("alpha-dev", "only_alpha");
  client.renderRequests(); assert.equal(client.node("reqSend").disabled, true);
  state.selectedTabId = "beta-dev"; client.setState(state); client.renderRequests();
  assert.equal(client.node("reqSend").disabled, false, "other tab Send is enabled");
});

async function waitForApproval(predicate: () => boolean, label: string) { try { await waitFor(predicate, label); } catch (error) { assert.fail((error as Error).message); } }


test("final2 dead or replaced leader cannot initiate launch in Accept", async () => {
  const { server, ws, deps } = await launchGateServer("accept");
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const result = await deps.launch("coder", "stale write").catch(() => assert.fail("stale launch threw instead of refusing"));
  assert.equal(server.launched.length, 0, "stale leader launches a writer in Accept");
  assert.match(result.error, /no longer current/);
});

test("final2 terminal control records are bounded by current controls", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  client.setState(server.stateMessage());
  for (let index = 0; index < 1100; index++) {
    const id = `repeat_${index}`;
    client.pendingSettingsActions.set("folder-save", id);
    client.onMessage({ type: "actionResult", action: "setDefaultProjectFolder", requestId: id });
  }
  assert.equal(client.resultSize(), 1, "one control retains only its latest terminal result");
  const keys = ["request-resolve-removed", "mcp-remove-claude-removed", "plugin-remove-removed"];
  for (const key of keys) {
    client.pendingSettingsActions.set(key, key);
    client.onMessage({ type: "actionResult", action: "mcpRemove", requestId: key });
  }
  client.pendingPermissionAction.set("removed-tab", "removed_permission");
  client.pendingRequestActions.set("removed-tab", "removed_request");
  client.onMessage({ type: "actionResult", action: "setPermissionMode", requestId: "removed_permission" });
  client.onMessage({ type: "actionResult", action: "sendRequest", requestId: "removed_request" });
  client.onMessage(server.stateMessage());
  assert.equal(client.resultSize(), 1, "removed request and inventory controls release terminal results");
  assert.equal(client.actionStateFor("removed_permission"), null, "removed tab releases its permission result");
  assert.equal(client.actionStateFor("removed_request"), null, "removed tab releases its request result");
});

test("final2 running snapshots never retire pending records", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  const state = server.stateMessage();
  client.setState(state); client.pendingSettingsActions.set("folder-save", "still_running");
  state.requestActions.still_running = { requestId: "still_running", status: "running", message: "Working" };
  client.onMessage(state);
  assert.equal(client.pendingSettingsActions.get("folder-save"), "still_running", "running result must not retire pending action");
  client.onMessage({ type: "error", action: "setDefaultProjectFolder", requestId: "still_running", message: "Failed to save" });
  assert.equal(client.pendingSettingsActions.has("folder-save"), false, "failed result retires pending action");
  assert.match(client.actionStatusMarkup("folder-save"), /Failed to save/);
  assert.equal(client.settingsActionRunning("folder-save"), false);
});

// ---- Fix pack 2, block 1 (server core): behaviours driven through the real handlers (handleMessage) of the loaded server.

const LEADER_SLOT = (tab: any) => tab.crew.find((member: any) => member.slot === "leader");

test("pack 2 C7: a leader model/effort change asked for mid-answer is saved at once and reaches the live leader only when the answer ends", async () => {
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 150 }), ws = connect(server);
  try {
  ws.message({ type: "chat", tabId: "alpha-dev", text: "long answer" });
  await tick(20);
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), true, "an answer is being written");
  const handle = server.leaderHandles[0];
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5", effort: "high" });
  assert.deepEqual(handle.modelCalls, [], "the live leader is not touched while it answers");
  assert.equal(server.leaderSeats.get("alpha-dev").effort, "medium", "nor is the effort the next turn will read");
  const saved = LEADER_SLOT(server.getWorkspaces().projects[0].tabs[0]);
  assert.deepEqual([saved.model, saved.effort], ["claude-opus-5", "high"], "the choice itself is saved at once");
  assert.equal(server.queuedLeaderChanges.has("alpha-dev"), true);
  await waitFor(() => !server.activeLeaderTurns.has("alpha-dev"), "the answer ends");
  await tick(10);
  assert.deepEqual(handle.modelCalls, ["claude-opus-5"], "the change reaches the live leader after the answer");
  assert.equal(server.leaderSeats.get("alpha-dev").effort, "high");
  assert.equal(server.queuedLeaderChanges.size, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "chatMessage" && message.role === "assistant" && message.text.endsWith("long answer")), "the answer was never cut");
  assert.equal(ws.messages.some((message: any) => message.type === "chatError"), false);
  } finally { await settleLeaderTurns(server); }
});

test("pack 2 C7: a queued model change that fails at the end of the answer reports it once and ends nothing; Stop drops a queued change", async () => {
  const failing = await loadServer({ skipHealth: true, leaderDelayMs: 100, setModelResult: false }), ws = connect(failing);
  let stopped: any = null;
  try {
  ws.message({ type: "chat", tabId: "alpha-dev", text: "answer" });
  await tick(10);
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && /leader model change failed/.test(message.message)), "the failed change is reported");
  assert.equal(ws.messages.some((message: any) => message.type === "chatError"), false, "a failed change never fails a turn");

  stopped = await loadServer({ skipHealth: true, hangLeader: true });
  const wsStopped = connect(stopped);
  wsStopped.message({ type: "chat", tabId: "alpha-dev", text: "hang" });
  await tick(10);
  wsStopped.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5" });
  assert.equal(stopped.queuedLeaderChanges.has("alpha-dev"), true);
  wsStopped.message({ type: "stopSeat", tabId: "alpha-dev", slot: "leader" });
  assert.equal(stopped.queuedLeaderChanges.size, 0, "a stopped leader has nothing to change; its successor reads the saved seat");
  assert.deepEqual(stopped.leaderHandles[0].modelCalls, []);
  } finally { await settleLeaderTurns(...[failing, stopped].filter(Boolean)); }
});

test("round 1 fix 1: a model/effort change whose save failed mid-answer never reaches the live leader afterwards", async () => {
  let failWrite = false;
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 150, failWorkspaceWrite: () => failWrite }), ws = connect(server);
  try {
    ws.message({ type: "chat", tabId: "alpha-dev", text: "long answer" });
    await tick(20);
    assert.equal(server.activeLeaderTurns.has("alpha-dev"), true, "an answer is being written");
    const handle = server.leaderHandles[0];
    failWrite = true;
    ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5", effort: "high" });
    failWrite = false;
    assert.match(ws.messages.findLast((message: any) => message.type === "error").message, /workspace disk failed/, "the refusal is reported");
    assert.equal(server.queuedLeaderChanges.size, 0, "nothing is queued for a save that did not happen");
    await waitFor(() => !server.activeLeaderTurns.has("alpha-dev"), "the answer ends");
    await tick(10);
    assert.deepEqual(handle.modelCalls, [], "the live leader keeps the model the saved settings have");
    assert.equal(server.leaderSeats.get("alpha-dev").effort, "medium");
  } finally { await settleLeaderTurns(server); }
});

test("round 1 fix 3: Save broadcasts 'saved' only after the leader's history entry exists, even when that write is slow", async () => {
  const slowWrite = (async (file: any, ...rest: any[]) => { if (String(file).endsWith(".brief.txt")) await tick(120); return (writeFile as any)(file, ...rest); }) as typeof writeFile;
  const server = await loadServer({ skipHealth: true, writeHandover: true, workspaces: tempWorkspaceFolders(), writeFile: slowWrite });
  const ws = connect(server);
  const logs = path.join(server.testRoot, "logs");
  const entriesAtSaved: string[][] = [];
  const send = ws.send;
  ws.send = (raw: string) => { send(raw); if (JSON.parse(raw).type === "saved") entriesAtSaved.push(readdirSync(logs).filter((name) => name.startsWith("alpha-dev.leader-") && name.endsWith(".brief.txt"))); };
  try {
    ws.message({ type: "chat", tabId: "alpha-dev", text: "answer before saving" });
    await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone"), "the answer");
    ws.message({ type: "save", tabId: "alpha-dev" });
    await waitFor(() => entriesAtSaved.length > 0, "Save finished", 5_000);
    assert.equal(entriesAtSaved[0].length, 1, "the history entry was already on disk when the page was told");
    ws.message({ type: "historyList", seatKey: "alpha-dev.leader" });
    await waitFor(() => ws.messages.some((message: any) => message.type === "historyList"), "the history list");
    assert.equal(ws.messages.findLast((message: any) => message.type === "historyList").runs.length, 1, "so the first list the page asks for already shows it");
  } finally { await settleLeaderTurns(server); }
});

test("round 2 fix 2: a Clear while Save's history entry is being written leaves no 'saved' for the old revision and the cleared chat unsaved", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((ok) => { enter = ok; });
  const open = new Promise<void>((ok) => { release = ok; });
  const heldWrite = (async (file: any, ...rest: any[]) => { if (String(file).endsWith(".brief.txt")) { enter(); await open; } return (writeFile as any)(file, ...rest); }) as typeof writeFile;
  const server = await loadServer({ skipHealth: true, writeHandover: true, workspaces: tempWorkspaceFolders(), writeFile: heldWrite }), ws = connect(server);
  try {
    ws.message({ type: "chat", tabId: "alpha-dev", text: "answer before saving" });
    await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone"), "the answer");
    ws.message({ type: "save", tabId: "alpha-dev" });
    await entered;
    ws.message({ type: "clear", tabId: "alpha-dev" });
    await waitFor(() => ws.messages.some((message: any) => message.type === "chatCleared" && message.tabId === "alpha-dev"), "Clear done");
    release();
    await tick(150);
    await server.flush();
    assert.equal(ws.messages.some((message: any) => message.type === "saved"), false, "no 'saved' goes out for the chat that was cleared");
    const cleared = ws.messages.find((message: any) => message.type === "chatCleared" && message.tabId === "alpha-dev");
    assert.deepEqual(new ChatStore(path.join(server.testRoot, "chats")).counters("alpha-dev"), { revision: cleared.revision, savedRevision: 0 }, "the cleared chat keeps its own counters");
  } finally { release(); await settleLeaderTurns(server); }
});

test("pack 2 C1: Accept/Decline is answered by the tab the request was sent to, whichever tab is open", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  ws.message({ type: "sendRequest", requestId: "c1_send", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Review", body: "Check it." });
  await waitFor(() => ws.messages.some((message: any) => message.requestId === "c1_send" && message.type === "actionResult"), "request sent");
  const request = server.requestsStore.list()[0];
  assert.equal(lastState(ws).selectedTabId, "alpha-dev", "the open tab is not the destination");
  ws.message({ type: "resolveRequest", requestId: "c1_none", id: request.id, status: "declined" });
  await waitFor(() => ws.messages.some((message: any) => message.requestId === "c1_none" && message.type === "error"), "no tabId");
  assert.match(ws.messages.find((message: any) => message.requestId === "c1_none").message, /tabId is required/);
  ws.message({ type: "resolveRequest", requestId: "c1_wrong", id: request.id, status: "declined", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.requestId === "c1_wrong" && message.type === "error"), "wrong tab");
  ws.message({ type: "resolveRequest", requestId: "c1_gone", id: request.id, status: "declined", tabId: "no-such-tab" });
  await waitFor(() => ws.messages.some((message: any) => message.requestId === "c1_gone" && message.type === "error"), "unknown tab");
  assert.equal(server.requestsStore.pendingCount("beta-dev"), 1, "none of the refusals resolved it");
  ws.message({ type: "resolveRequest", requestId: "c1_ok", id: request.id, status: "declined", tabId: "beta-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.requestId === "c1_ok" && message.type === "actionResult"), "answered from the destination tab");
  assert.equal(server.requestsStore.list()[0].status, "declined");
  assert.equal(lastState(ws).selectedTabId, "alpha-dev", "answering never switched tabs");
});

test("pack 2 C5: the crew rail and details panel layout is a client pref the server saves", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  assert.deepEqual([lastState(ws).clientPrefs.crewRailOpen, lastState(ws).clientPrefs.detailsOpen], [true, false]);
  ws.message({ type: "updateClientPref", key: "crewRailOpen", value: false });
  ws.message({ type: "setClientPref", key: "detailsOpen", value: true });
  assert.deepEqual([lastState(ws).clientPrefs.crewRailOpen, lastState(ws).clientPrefs.detailsOpen], [false, true]);
  const written = server.prefWrites.at(-1).value;
  assert.deepEqual([written.crewRailOpen, written.detailsOpen], [false, true], "written through the same client-prefs path as theme and avatar");
  ws.message({ type: "updateClientPref", key: "crewRailOpen", value: "no" });
  assert.equal(ws.messages.at(-1).type, "error");
  assert.equal(lastState(ws).clientPrefs.crewRailOpen, false, "a bad value changes nothing");
});

test("pack 2: hello ignores a localPrefs field (the localStorage migration is gone) and Settings Check again answers with the page's requestId, also on failure", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello", localPrefs: { sidebarCollapsed: true } });
  assert.equal(server.prefWrites.length, 0);
  assert.equal(lastState(ws).clientPrefs.sidebarCollapsed, false);

  server.settingsService.refreshAll = async () => {};
  ws.message({ type: "refreshSettings", requestId: "chk_ok" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "chk_ok" && message.action === "refreshSettings"), "actionResult carries the requestId");
  assert.ok(ws.messages.some((message: any) => message.type === "settingsRefreshed"), "the older settingsRefreshed still follows");

  server.settingsService.refreshAll = async () => { throw new Error("tools unreachable"); };
  ws.message({ type: "refreshSettings", requestId: "chk_fail" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "chk_fail"), "error carries the requestId");
  const failure = ws.messages.find((message: any) => message.type === "error" && message.requestId === "chk_fail");
  assert.deepEqual([failure.action, failure.message], ["refreshSettings", "tools unreachable"]);
  assert.equal(server.stateMessage().requestActions.chk_fail.status, "failed");

  ws.message({ type: "refreshSettings" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.action === "refreshSettings" && message.requestId === undefined), "without an id a failure is still reported, never an unhandled rejection");
});

test("pack 2 C8: a successful Save writes one leader history entry (transcript + handover path) that the seat's history lists", async () => {
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 10, writeHandover: true, workspaces: tempWorkspaceFolders() }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "decide the plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "alpha-dev"), "first answer");
  assert.equal((await server.listHistory("alpha-dev.leader")).length, 0, "nothing is saved yet");
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"), "Save done");
  let entries: any[] = [];
  await waitFor(() => { void server.listHistory("alpha-dev.leader").then((list: any[]) => { entries = list; }); return entries.length === 1; }, "the history lists the saved session");
  assert.equal(entries[0].seatId, "alpha-dev.leader");
  assert.deepEqual(JSON.parse(JSON.stringify(entries[0].outcome)), { status: "done", exitCode: 0 });
  assert.ok(entries[0].briefFile, "the brief file sits beside the log");
  const handoverPath = path.join(server.getWorkspaces().projects[0].tabs[0].folder, ".command-center", "alpha-dev", "RESUME.md");
  const brief = readFileSync(path.join(server.testRoot, "logs", entries[0].briefFile), "utf8");
  assert.equal(brief, `Saved handover: ${handoverPath}`);
  const log = readFileSync(path.join(server.testRoot, "logs", entries[0].logFile), "utf8");
  assert.match(log, /^You: decide the plan\n\nAtlas: answer:.*decide the plan/s);
  assert.match(log, /\[exit\] status=done code=0\s*$/);
  // The page loads it exactly like a worker run.
  ws.message({ type: "historyRun", seatKey: "alpha-dev.leader", timestamp: entries[0].timestamp });
  await waitFor(() => ws.messages.some((message: any) => message.type === "historyRun" && message.seatKey === "alpha-dev.leader"), "historyRun reply");
  const run = ws.messages.find((message: any) => message.type === "historyRun" && message.seatKey === "alpha-dev.leader");
  assert.equal(run.brief, brief);
  assert.match(run.output, /You: decide the plan/);
  // A refused/failed Save records nothing.
  const failed = await loadServer({ skipHealth: true, failSave: true, workspaces: tempWorkspaceFolders() }), wsFailed = connect(failed);
  wsFailed.message({ type: "chat", tabId: "alpha-dev", text: "x" }); await tick(20);
  wsFailed.message({ type: "save", tabId: "alpha-dev" }); await tick(120);
  assert.equal((await failed.listHistory("alpha-dev.leader")).length, 0);
});

test("pack 2 C8: only the newest 50 saved sessions of a leader are kept, oldest removed file by file", async () => {
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 5, writeHandover: true, workspaces: tempWorkspaceFolders() }), ws = connect(server);
  const logs = path.join(server.testRoot, "logs");
  for (let i = 1; i <= 52; i++) { writeFileSync(path.join(logs, `alpha-dev.leader-${i}.log`), "old"); writeFileSync(path.join(logs, `alpha-dev.leader-${i}.brief.txt`), "old"); }
  writeFileSync(path.join(logs, "beta-dev.leader-1.log"), "another seat's");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "x" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone"), "answer");
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "saved"), "saved");
  await waitFor(() => !existsSync(path.join(logs, "alpha-dev.leader-3.log")), "the oldest entries are pruned");
  const left = (await readdir(logs)).filter((name) => name.startsWith("alpha-dev.leader-") && name.endsWith(".log"));
  assert.equal(left.length, 50);
  assert.equal(existsSync(path.join(logs, "alpha-dev.leader-2.brief.txt")), false, "a pruned entry loses its brief too");
  assert.equal(existsSync(path.join(logs, "alpha-dev.leader-52.log")), true);
  assert.equal(existsSync(path.join(logs, "beta-dev.leader-1.log")), true, "another seat's history is never touched");
});

test("pack 2: Stop keeps the half answer the leader had already written, marked as cut short; a stop with no text adds nothing", async () => {
  const server = await loadServer({ skipHealth: true, hangLeader: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "write a lot" });
  await tick(10);
  server.leaderHandles[0].callbacks.onDelta("half an ans");
  server.leaderHandles[0].callbacks.onDelta("wer");
  ws.message({ type: "stopSeat", tabId: "alpha-dev", slot: "leader" });
  const kept = ws.messages.find((message: any) => message.type === "chatMessage" && message.role === "assistant");
  assert.equal(kept.text, "half an answer\n\n(Stopped before it finished.)");
  assert.equal(server.chatStore.snapshot("alpha-dev").messages.at(-1).text, kept.text, "and it is in the saved transcript");
  assert.ok(ws.messages.some((message: any) => message.type === "chatError" && message.message === "leader turn stopped"));

  ws.message({ type: "chat", tabId: "beta-dev", text: "silent" });
  await tick(10);
  ws.message({ type: "stopAll" });
  assert.equal(ws.messages.some((message: any) => message.type === "chatMessage" && message.role === "assistant" && message.tabId === "beta-dev"), false, "no text, no assistant message");
});

test("pack 2: finishing a turn survives a chat log that cannot be written, and a result with no turn waiting sends no stray chatDone", async () => {
  const server = await loadServer({ skipHealth: true, failAssistantAppend: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "answer please" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "alpha-dev"), "the turn still ends");
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save the answer to the chat log: chat disk failed/.test(message.message)));
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), false, "the tab is not left busy");
  const doneCount = () => ws.messages.filter((message: any) => message.type === "chatDone").length;
  const before = doneCount();
  server.leaderHandles[0].callbacks.onDone();
  assert.equal(doneCount(), before, "the CLI finishing background work is not a turn's end");
});

test("pack 2: a leader that cannot start fails the chat as a turn error and leaves nothing registered", async () => {
  const server = await loadServer({ skipHealth: true, createLeaderThrows: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start please" });
  await tick(10);
  assert.ok(ws.messages.some((message: any) => message.type === "chatMessage" && message.role === "user"), "the user's message is saved");
  assert.ok(ws.messages.some((message: any) => message.type === "chatError" && message.tabId === "alpha-dev" && /leader could not start/.test(message.message)), "reported as the turn's error");
  assert.equal(ws.messages.some((message: any) => message.type === "error" && /leader could not start/.test(message.message)), false, "not as a refusal that would roll the message back");
  assert.equal(server.leaderInstances.size, 0);
  assert.equal(server.leaderSeats.size, 0);
  assert.equal(server.activeLeaderTurns.size, 0);

  const workspaces = fixtureWorkspaces();
  for (const member of workspaces.projects[0].tabs[0].crew) if (member.slot === "leader") { member.cli = "opencode"; member.model = "opencode/glm-5.2"; member.effort = "max"; }
  const bridge = await loadServer({ skipHealth: true, opencodeThrows: true, workspaces }), wsBridge = connect(bridge);
  wsBridge.message({ type: "chat", tabId: "alpha-dev", text: "start please" });
  await tick(10);
  assert.ok(wsBridge.messages.some((message: any) => message.type === "chatError" && /opencode could not start/.test(message.message)));
  assert.equal(bridge.leaderBridge.isOpen("alpha-dev"), false, "the OpenCode bridge token of the failed start is revoked");
  assert.equal(bridge.leaderSeats.size, 0);
});

test("pack 2: activeWork counts an unconfirmed process of an earlier session in its own tab; globalWork names work that belongs to no tab", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  config.writeLaunchSafety({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [{ seatId: "alpha-dev.coder", pid: 4242, runId: "old-run" }], live: [] }, safetyPath);
  const server = await loadServer({ skipHealth: true, safetyPath }), ws = connect(server);
  ws.message({ type: "hello" });
  const tabOf = (id: string) => lastState(ws).projects.flatMap((project: any) => project.tabs).find((tab: any) => tab.id === id);
  assert.deepEqual([tabOf("alpha-dev").activeWork, tabOf("beta-dev").activeWork], [true, false]);
  assert.deepEqual(JSON.parse(JSON.stringify(lastState(ws).globalWork)), []);
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: server.testRoot });
  assert.match(ws.messages.at(-1).message, /cannot change the folder while the tab is busy/, "the same check refuses a folder change while that process may still be working");
  server.launchSafety.uncertain.push({ seatId: "sonny", pid: 77 });
  server.settingsService.refreshAll = () => new Promise(() => {});
  ws.message({ type: "refreshSettings", requestId: "work_1" });
  server.settingsService.beginUpload("up_work");
  assert.deepEqual(JSON.parse(JSON.stringify(server.stateMessage().globalWork)), ["a Settings action is running", "an upload is running", "a process from an earlier session may still be running"]);
  server.settingsService.finishUpload("up_work", true, "done");
  assert.equal(server.stateMessage().globalWork.includes("an upload is running"), false);
});

test("pack 2: a damaged chat transcript costs only its own tab, never the whole state message", async () => {
  const server = await loadServer({ skipHealth: true, preload: (root) => mkdirSync(path.join(root, "chats", "alpha-dev.jsonl"), { recursive: true }) }), ws = connect(server);
  ws.message({ type: "hello" });
  const tabs = lastState(ws).projects.flatMap((project: any) => project.tabs);
  assert.match(tabs.find((tab: any) => tab.id === "alpha-dev").chatProblem, /EISDIR|illegal operation|directory/i);
  assert.deepEqual([tabs.find((tab: any) => tab.id === "alpha-dev").chatRevision, tabs.find((tab: any) => tab.id === "alpha-dev").savedRevision], [0, 0]);
  assert.equal(Object.hasOwn(tabs.find((tab: any) => tab.id === "beta-dev"), "chatProblem"), false);
  ws.message({ type: "chat", tabId: "beta-dev", text: "still works" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "beta-dev"), "another tab keeps chatting");
});

test("pack 2: a burst of usage events sends one state at once and folds the rest into one more", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "busy"); const entry = server.launched[0];
  const states = () => ws.messages.filter((message: any) => message.type === "state").length;
  const before = states();
  for (let i = 1; i <= 20; i++) entry.callback.onUsage(entry.run, { modelId: null, contextTokens: i, contextWindow: null, costUsd: i / 100 });
  assert.equal(states() - before, 1, "the first event goes out at once, the other 19 do not each send a full state");
  await tick(520);
  assert.equal(states() - before, 2, "one trailing state carries the latest numbers");
  assert.equal(lastState(ws).projects[0].tabs[0].runs.find((run: any) => run.runId === entry.run.runId).usage.contextTokens, 20);
});

test("pack 2: a launch notice keeps a 4000-character reminder of a long brief while the run gets the whole brief; state carries no duplicate notices list", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const brief = "b".repeat(10_000);
  assert.equal(server.leaderLaunch("alpha-dev", "coder", brief).ok, true);
  assert.equal(server.launched[0].prompt.length, 10_000, "the run itself gets the whole brief");
  const notice = server.launchSafety.notices[0];
  assert.equal(notice.brief, `${"b".repeat(4000)}...`);
  ws.message({ type: "hello" });
  assert.equal(Object.hasOwn(lastState(ws), "launchNotices"), false);
  assert.equal(lastState(ws).launchSafety.notices.length, 1);
});

test("pack 2: the launch budget refusal says it counts your own Run too and when the next launch is allowed", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  for (let i = 0; i < 4; i++) ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: `manual ${i}` });
  assert.equal(server.launched.length, 4, "manual runs use the budget");
  ws.message({ type: "run", tabId: "beta-dev", slot: "coder", prompt: "one too many" });
  const refusal = ws.messages.filter((message: any) => message.type === "error").at(-1).message;
  assert.match(refusal, /^launch budget exceeded: 4 launches in 5 minutes, and your own Run counts too; the next one is allowed in \d+ s$/);
  const seconds = Number(/in (\d+) s/.exec(refusal)![1]);
  assert.ok(seconds >= 295 && seconds <= 300, `the oldest launch clears in about 5 minutes, not ${seconds}`);
});

test("pack 2: an old unconfirmed or blocked row from before seat keys blocks every launch and the refusal names that row", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  config.writeLaunchSafety({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [{ seatId: "sonny", pid: 9 }], live: [] }, safetyPath);
  const first = await loadServer({ skipHealth: true, safetyPath });
  assert.match(first.launchWorker("alpha-dev", "reviewer2", "go").error, /old unconfirmed process \(sonny\) blocks every launch/);
  const blockedPath = path.join(tempRoot(), "launch-safety.json");
  config.writeLaunchSafety({ blocked: ["vera"], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] }, blockedPath);
  const second = await loadServer({ skipHealth: true, safetyPath: blockedPath });
  assert.match(second.launchWorker("alpha-dev", "reviewer2", "go").error, /old launch block \(vera\) blocks every launch/);
  assert.equal(second.launched.length, 0);
});

test("pack 2: a run the last session never saw end blocks its seat on the next start; a clean exit leaves nothing to block", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  const first = await loadServer({ skipHealth: true, safetyPath });
  assert.equal(first.launchWorker("alpha-dev", "coder", "work").ok, true);
  const runId = first.launched[0].run.runId;
  assert.deepEqual(config.readLaunchSafety(safetyPath).live, [{ seatId: "alpha-dev.coder", runId }], "recorded before the process starts");
  first.closeRun(runId, 0);
  assert.deepEqual(config.readLaunchSafety(safetyPath).live, [], "and forgotten when it ends");

  // A crash: the run was live and nobody saw it end.
  const crashPath = path.join(tempRoot(), "launch-safety.json");
  const crashed = await loadServer({ skipHealth: true, safetyPath: crashPath });
  crashed.launchWorker("alpha-dev", "coder", "work");
  const restarted = await loadServer({ skipHealth: true, safetyPath: crashPath });
  assert.match(restarted.launchWorker("alpha-dev", "coder", "again").error, /launch blocked after a prior stop: alpha-dev\.coder/);
  assert.equal(restarted.launchWorker("alpha-dev", "reviewer1", "other seat").ok, true, "only that seat is blocked");
  assert.ok(config.readLaunchSafety(crashPath).blocked.includes("alpha-dev.coder"), "the block is saved");
  assert.deepEqual(config.readLaunchSafety(crashPath).live.map((row) => row.seatId), ["alpha-dev.reviewer1"], "the stale rows were replaced by what runs now");

  // A clean exit: the workers were asked to stop, nothing is left to block.
  const cleanPath = path.join(tempRoot(), "launch-safety.json");
  const clean = await loadServer({ skipHealth: true, safetyPath: cleanPath });
  clean.launchWorker("alpha-dev", "coder", "work");
  clean.processHandlers.exit(1);
  assert.equal(config.readLaunchSafety(cleanPath).live.length, 1, "a failing exit code is not a clean exit");
  clean.processHandlers.exit(0);
  assert.deepEqual(config.readLaunchSafety(cleanPath).live, []);
  const afterClean = await loadServer({ skipHealth: true, safetyPath: cleanPath });
  assert.equal(afterClean.launchWorker("alpha-dev", "coder", "fresh").ok, true);
});

test("pack 2: a release whose save fails changes nothing, and the same release then succeeds", async () => {
  let fail = false;
  const server = await loadServer({ skipHealth: true, releaseUnconfirmed: () => true, failSafety: () => fail }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "uncertain run"); const entry = server.launched[0];
  entry.callback.onUnconfirmedKill(entry.run, 4321);
  const engineRun = () => server.tabs.get("alpha-dev").state.runs.find((run: any) => run.id === entry.run.runId);
  fail = true;
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.match(ws.messages.at(-1).message, /safety disk failed/);
  assert.equal(server.launchSafety.uncertain.length, 1, "still unconfirmed");
  assert.equal(server.launchSafety.released.length, 0, "not released (the rollback restores the list it pushed to)");
  assert.equal(server.blockedSeatKeys.has("alpha-dev.reviewer2"), false, "no block added");
  assert.equal(server.unconfirmedRunIds.has(entry.run.runId), true);
  assert.equal(engineRun().status, "working", "the engine still sees the run");
  assert.equal(server.runContexts.has(entry.run.runId), true);
  assert.equal(server.stateMessage().releasedProcesses.length, 0);
  fail = false;
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.equal(server.launchSafety.uncertain.length, 0);
  assert.equal(server.launchSafety.released.length, 1);
  assert.equal(engineRun().status, "failed");
  assert.equal(server.launchSafety.live.length, 0, "a released run is no longer a live one");
});

test("pack 2: a release with one row the runner does not hold unconfirmed releases none of them", async () => {
  let second = "";
  const server = await loadServer({ skipHealth: true, releaseUnconfirmed: (runId: string) => runId !== second }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "first"); server.launchWorker("alpha-dev", "reviewer2", "second");
  const [one, two] = server.launched; second = two.run.runId;
  one.callback.onUnconfirmedKill(one.run, 4321);
  // The second run is running in the runner but is not unconfirmed there, although a row says so (a stale or damaged row).
  server.launchSafety.uncertain.push({ seatId: two.run.seatKey, pid: 99, runId: two.run.runId });
  ws.message({ type: "releaseUnconfirmedSeat", seatId: one.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.match(ws.messages.at(-1).message, new RegExp(`process is not tracked as unconfirmed: ${two.run.runId}`));
  assert.equal(server.launchSafety.uncertain.length, 2, "neither row is released");
  assert.equal(server.launchSafety.released.length, 0);
  assert.equal(server.runContexts.has(one.run.runId), true, "the first run keeps its context");
  assert.equal(server.tabs.get("alpha-dev").state.runs.find((run: any) => run.id === one.run.runId).status, "working", "and its engine run");
  assert.equal(server.blockedSeatKeys.has("alpha-dev.reviewer2"), false);
});

test("pack 2: setProcess with an unknown kind or process is refused before the leader is touched", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" });
  await tick(20);
  assert.equal(server.leaders.size, 1);
  for (const bad of [{ process: "nope" }, { process: undefined }, { kind: "constructor", process: "main" }, { process: "__proto__" }]) {
    ws.message({ type: "setProcess", tabId: "alpha-dev", ...bad });
    assert.match(ws.messages.at(-1).message, /^unknown kind\/process: /, JSON.stringify(bad));
  }
  assert.equal(server.leaderHandles[0].stopCalls, 0, "the leader was never stopped for a request that could not succeed");
  assert.equal(server.leaders.size, 1);
  assert.equal(server.getWorkspaces().projects[0].tabs[0].process, "main");
  ws.message({ type: "addProject", id: "extra", name: "Extra", folder: server.testRoot, process: "nope" });
  assert.match(ws.messages.at(-1).message, /^unknown kind\/process: /, "addProject says it plainly too");
});

test("pack 2: removing a tab whose workspace write fails keeps the tab and its leader; a removal that holds drops every trace and its id is not reused", async () => {
  let failWrite = false;
  const server = await loadServer({ skipHealth: true, failWorkspaceWrite: () => failWrite, workspaces: tempWorkspaceFolders() }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-design", text: "hello" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "alpha-design"), "a chat exists for the tab");
  server.blockedSeatKeys.add("alpha-design.designer");
  server.launchSafety.notices.push({ type: "leaderLaunch", id: 5, seatId: "alpha-design.designer", seatName: "Terra", brief: "old", source: "Atlas" }); server.launchSafety.nextNoticeId = 6;
  failWrite = true;
  ws.message({ type: "removeTab", tabId: "alpha-design" });
  assert.match(ws.messages.at(-1).message, /workspace disk failed/);
  assert.equal(server.leaderHandles[0].stopCalls, 0, "the leader of a tab that stays is not stopped");
  assert.equal(server.leaders.has("alpha-design"), true);
  assert.ok(server.getWorkspaces().projects[0].tabs.some((tab: any) => tab.id === "alpha-design"));

  failWrite = false;
  ws.message({ type: "removeTab", tabId: "alpha-design" });
  assert.equal(server.getWorkspaces().projects[0].tabs.some((tab: any) => tab.id === "alpha-design"), false);
  assert.equal(server.leaderHandles[0].stopCalls, 1);
  assert.equal(server.blockedSeatKeys.has("alpha-design.designer"), false, "its launch blocks go with it");
  assert.equal(server.launchSafety.notices.some((notice: any) => notice.seatId.startsWith("alpha-design.")), false, "and its launch notices");
  assert.equal(config.readLaunchSafety(path.join(server.testRoot, "launch-safety.json")).blocked.includes("alpha-design.designer"), false, "saved too");
  assert.equal(server.pendingHandoverReads.has("alpha-design"), false);
  assert.ok(existsSync(path.join(server.testRoot, "chats", "alpha-design.jsonl")), "the chat file itself is never deleted");
  appendFileSync(path.join(server.testRoot, "chats", "alpha-design.jsonl"), `${JSON.stringify({ type: "message", tabId: "alpha-design", revision: 3, role: "user", text: "late", at: 1 })}\n`);
  assert.equal(server.chatStore.counters("alpha-design").revision, 3, "the removed tab's transcript is no longer held in memory");

  ws.message({ type: "addTab", projectId: "alpha", tabId: "alpha-design", name: "Again" });
  assert.match(ws.messages.at(-1).message, /tab id was used before and still has history: alpha-design/);
  ws.message({ type: "addTab", projectId: "alpha", tabId: "alpha-fresh", name: "Fresh", folder: server.testRoot });
  assert.equal(server.getWorkspaces().projects[0].tabs.some((tab: any) => tab.id === "alpha-fresh"), true, "an id with no history is fine");
  ws.message({ type: "addTab", projectId: "alpha", name: "Random", folder: server.testRoot });
  assert.equal(server.getWorkspaces().projects[0].tabs.length, 4, "a generated id never collides");
});

test("pack 2: the leader's saved-session history ids are not shared with a tab id that had a history", async () => {
  const server = await loadServer({ skipHealth: true, workspaces: tempWorkspaceFolders() }), ws = connect(server);
  writeFileSync(path.join(server.testRoot, "logs", "alpha-ghost.leader-1.log"), "old");
  ws.message({ type: "addTab", projectId: "alpha", tabId: "alpha-ghost", name: "Ghost", folder: server.testRoot });
  assert.match(ws.messages.at(-1).message, /tab id was used before/, "a log of that id's seats counts as history");
});

test("pack 2: history lists and stats only the asked seat's files, newest first, at most 200", async () => {
  const stats: string[] = [];
  const server = await loadServer({ skipHealth: true, stat: async (file: any, ...rest: any[]) => { stats.push(path.basename(String(file))); return (stat as any)(file, ...rest); } });
  const logs = path.join(server.testRoot, "logs");
  for (const name of ["beta-dev.coder-5.log", "beta-dev.coder-5.brief.txt", "alpha-dev.coder-3.log", "alpha-dev.coder-3.brief.txt", "alpha-dev.reviewer1-4.log"]) writeFileSync(path.join(logs, name), "x");
  stats.length = 0;
  const list = await server.listHistory("alpha-dev.coder");
  assert.deepEqual(JSON.parse(JSON.stringify(list.map((entry: any) => entry.timestamp))), [3]);
  assert.deepEqual([...stats], ["alpha-dev.coder-3.log"], "no other seat's log is looked at");
  for (let i = 0; i < 210; i++) writeFileSync(path.join(logs, `alpha-dev.coder-${1000 + i}.log`), "x");
  const many = await server.listHistory("alpha-dev.coder");
  assert.equal(many.length, 200);
  assert.equal(many[0].timestamp, 1209, "newest first");
  assert.equal(many.at(-1).timestamp, 1010, "the 10 oldest of the 210 are past the cap");
});

test("pack 2: the startup health check is skipped when it passed in the last day for the same model, and runs again when stale or for another model", async () => {
  const fresh = await loadServer({ query: undefined });
  await fresh.leaderHealthCheck;
  assert.equal(fresh.queryCount(), 1, "first start: one check");
  const saved = JSON.parse(readFileSync(path.join(fresh.testRoot, "leader-check.json"), "utf8"));
  assert.deepEqual([saved.model, saved.cli], ["claude-opus-5-5[1m]", ""]);
  const withFile = (content: unknown) => (root: string) => writeFileSync(path.join(root, "leader-check.json"), JSON.stringify(content));
  const recent = await loadServer({ preload: withFile({ ...saved, at: Date.now() - 3600_000 }) });
  await recent.leaderHealthCheck;
  assert.equal(recent.queryCount(), 0, "passed an hour ago: no paid turn");
  for (const stale of [{ ...saved, at: Date.now() - 2 * 24 * 3600_000 }, { ...saved, model: "another-model" }, { ...saved, cli: "C:/other/claude.exe" }, { ...saved, at: Date.now() + 3600_000 }, { nonsense: true }]) {
    const again = await loadServer({ preload: withFile(stale) });
    await again.leaderHealthCheck;
    assert.equal(again.queryCount(), 1, JSON.stringify(stale));
  }
  const corrupt = await loadServer({ preload: (root) => writeFileSync(path.join(root, "leader-check.json"), "not json") });
  await corrupt.leaderHealthCheck;
  assert.equal(corrupt.queryCount(), 1, "an unreadable record just means: check now");
  const failing = await loadServer({ query: () => { throw new Error("no key"); }, console: { log() {}, error() {} } as any });
  await failing.leaderHealthCheck;
  assert.equal(existsSync(path.join(failing.testRoot, "leader-check.json")), false, "a failed check is never remembered as passed");
});

test("pack 2: an uncaught error or a server error before the server listens ends the process; once it listens they are only reported", async () => {
  const early = await loadServer({ skipHealth: true, neverListen: true });
  early.processHandlers.uncaughtException(new Error("never came up"));
  assert.deepEqual([...early.exitCodes], [1]);
  early.server.emit("error", new Error("listen EADDRINUSE"));
  assert.deepEqual([...early.exitCodes], [1, 1]);
  const up = await loadServer({ skipHealth: true }), ws = connect(up);
  up.processHandlers.uncaughtException(new Error("a later fault"));
  up.server.emit("error", new Error("a later server error"));
  assert.deepEqual([...up.exitCodes], [], "a running server stays up");
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /a later fault/.test(message.message)), "and says so");
});

test("pack 3: a client that fell behind and recovers is sent the full state once, not that state plus the output chunk that triggered the resync", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "stream output" });
  const runId = server.launched[0].run.runId;
  ws.bufferedAmount = 8 * 1024 * 1024 + 1;
  server.emitOutput(runId, "dropped-");
  ws.bufferedAmount = 0;
  ws.messages.length = 0;
  server.emitOutput(runId, "trigger");
  assert.equal(ws.messages.filter((message: any) => message.type === "output").length, 0, "the chunk is inside the resynced state, so it is not sent again");
  const resync = ws.messages.find((message: any) => message.type === "state" && message.notice);
  assert.ok(resync, "the client got the full state with the drop notice");
  assert.equal(resync.projects[0].tabs[0].runs.find((run: any) => run.runId === runId).output, "dropped-trigger");
  server.closeRun(runId, 0);
});

test("pack 3: stopping a tab's leader with spend on it banks the total; the next leader's spend is added on top", async () => {
  const server = await loadServer({ skipHealth: true, usageDelta: { modelId: "claude-opus-5-5[1m]", contextTokens: 10, contextWindow: 1_000_000, costUsd: 0.5 } }), ws = connect(server);
  const leaderUsage = () => lastState(ws).projects[0].tabs[0].leaderUsage;
  ws.message({ type: "chat", tabId: "alpha-dev", text: "before" });
  await tick();
  assert.equal(leaderUsage().contextTokens, 10, "control: the live leader's own figures are shown");
  ws.message({ type: "setProcess", tabId: "alpha-dev", process: "duo" });
  assert.equal(leaderUsage().contextTokens, null, "stopping banks the usage: the per-instance figures are cleared");
  assert.equal(leaderUsage().costUsd, 0.5, "and the spend stays");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "after" });
  await tick();
  assert.equal(leaderUsage().costUsd, 1, "the new leader's 0.5 is added to the banked 0.5, not shown instead of it");
  await settleLeaderTurns(server);
});

test("pack 3: a worker run's usage reports add up through the server instead of the second starting over", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer1", prompt: "claude worker" });
  const run = server.launched[0].run;
  assert.equal(run.cli, "claude");
  const result = (extra: object) => JSON.stringify({ type: "result", usage: { input_tokens: 7 }, modelUsage: { [run.model]: { contextWindow: 1_000_000 } }, ...extra }) + "\n";
  server.emitOutput(run.runId, result({ total_cost_usd: 0.02 }));
  server.emitOutput(run.runId, result({}));
  const usage = server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === run.runId).usage;
  assert.equal(usage.turns, 2, "two reports counted");
  assert.equal(usage.costUsd, 0.02, "the second report had no cost, so the first one's stays");
  server.closeRun(run.runId, 0);
});

test("pack 3: a worker's plan-limit report is broadcast to the page as a rateLimit message", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer1", prompt: "claude worker" });
  const run = server.launched[0].run;
  server.emitOutput(run.runId, JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 123 } } } }) + "\n");
  const sent = ws.messages.find((message: any) => message.type === "rateLimit");
  assert.ok(sent, "a rateLimit message reached the client");
  assert.deepEqual([sent.tabId, sent.runId, sent.windows], ["alpha-dev", run.runId, { five_hour: { utilization: 0.2, resetsAt: 123 } }]);
  server.closeRun(run.runId, 0);
});

test("pack 3: a launch the runner refuses leaves no run context and no stall tracker behind", async () => {
  const server = await loadServer({ skipHealth: true });
  server.rejectRun();
  const refused = server.launchWorker("alpha-dev", "reviewer2", "refused brief");
  assert.equal(refused.ok, false);
  assert.equal(server.runContexts.size, 0, "no context for a run that never started");
  assert.equal(server.stallTrackers.trackers.size, 0, "no stall tracker for a run that never started");
});

test("pack 3: a killRun message whose run id holds a control character is refused as an invalid run id", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "killRun", runId: "run\u0001id" });
  const error = ws.messages.find((message: any) => message.type === "error");
  assert.match(error?.message ?? "", /invalid run id/);
  assert.equal(ws.messages.some((message: any) => message.type === "killAccepted"), false);
});

test("pack 9: a heads-up line in the chat is never part of the saved session log, and is not something the leader is sent", async () => {
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 10, writeHandover: true, workspaces: tempWorkspaceFolders(), preload: (root) => {
    mkdirSync(path.join(root, "chats"), { recursive: true });
    writeFileSync(path.join(root, "chats", "alpha-dev.jsonl"), [
      { type: "message", tabId: "alpha-dev", revision: 1, role: "notice", text: "Heads up: a Codex session outside Command Center is active in this folder.", at: 1 },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  } }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "decide the plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "alpha-dev"), "first answer");
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"), "Save done");
  let entries: any[] = [];
  await waitFor(() => { void server.listHistory("alpha-dev.leader").then((list: any[]) => { entries = list; }); return entries.length === 1; }, "the history lists the saved session");
  const log = readFileSync(path.join(server.testRoot, "logs", entries[0].logFile), "utf8");
  assert.match(log, /^You: decide the plan/, "the log starts with the person's words: the notice line is not in it");
  assert.equal(log.includes("Heads up"), false);
  assert.equal(server.chats.some((turn: any) => String(turn.text).includes("Heads up")), false, "nothing the leader was sent carries it");
});
