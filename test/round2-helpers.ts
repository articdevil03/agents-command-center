import { connect, lastState, settleLeaderTurns, tick, waitFor, flushMicrotasks } from "./round2-test-clients.ts";
export { connect, lastState, settleLeaderTurns, tick, waitFor, flushMicrotasks } from "./round2-test-clients.ts";
import { loadRunnerHarness, isolatedRunnerProc } from "./round2-runner-fixture.ts";
export { loadRunnerHarness, isolatedRunnerProc, isolatedRunnerCapture, isolatedRun, startIsolatedRunner } from "./round2-runner-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeProjectRules } from "../server/project-rules.ts";
import { EventEmitter } from "node:events";
import { appendFileSync, readFileSync, readdirSync, mkdirSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, lstat, realpath, unlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
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
import { SettingsService, permissionModeForSdk, ModeBusyError, runCli } from "../server/settings.ts";
import * as agentUsage from "../server/agent-usage.ts";
import * as leaderCommon from "../server/leader-common.ts";
import * as changesApi from "../server/changes.ts";
import { leaderChildEnv, withResolvedCli, isInsideFolder, setCliSkipFolders, windowsTaskkillPath, resolveCliOrThrow, leaderKindOf, USER_DENIED } from "../server/leader-common.ts";
import { keepBadCopy } from "../server/safe-file.ts";
import { scratchDir, tempRoot, newAppKey } from "./temp-root.ts";
import { sourceText } from "./source-text.ts";
import { config, leaderApi, createCodexLeader, createOpencodeLeader, createAcpLeader, createLeaderBridge, buildLeaderToolSpecs } from "./round2-setup.ts";
import { loadLeaderHarness } from "./round2-leader-harness.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { isFixedTab, fixedMembers, fixedState, fixedCrewOf } from "../server/fixed-crew/runtime.ts";
import { DEFAULTS_VERSION } from "../server/fixed-crew/role-prompts.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import { unavailableWorkspace } from "../server/fixed-crew/recovery.ts";
import { fixedDependencies, round2FixedTab } from "./round2-fixed-deps.ts";

import { fixtureTab, fixtureWorkspaces, tempWorkspaceFolders } from "./round2-workspaces.ts";
export { fixtureTab, fixtureWorkspaces, tempWorkspaceFolders } from "./round2-workspaces.ts";

export const source = stripTypeScriptTypes(sourceText("server/index.ts"))
  .replace(/^import\s+(?:.|\r?\n)*?from\s+["'][^"']+["'];\r?\n/gm, "")
  .replace(/^export /gm, "")
  .replaceAll("import.meta.url", '"file:///server/index.ts"');

export async function loadServer(options: { testRoot?: string; serverSource?: string; fixed?: boolean; treeWatch?: () => leaderCommon.TreeWatch | null; relaunchable?: boolean; failSafety?: () => boolean; onSafetyWrite?: (value: config.LaunchSafety) => void; skipHealth?: boolean; leaderDelayMs?: number; hangLeader?: boolean; hangTab?: string; hangSave?: boolean; failSave?: boolean; writeHandover?: boolean; safetyPath?: string; deferKill?: boolean; rejectNextRun?: boolean; query?: (args: any) => any; readdir?: typeof readdir; console?: Console; releaseUnconfirmed?: (runId: string) => boolean; workspaces?: any; leaderDead?: boolean; setModelResult?: boolean; setPermissionResult?: boolean; deferFirstPermission?: boolean; usageDelta?: any; realLeaderOptions?: boolean; sdkLeader?: (args: any) => any; stat?: typeof stat; now?: () => number; leaderSeamOnly?: boolean; bothSeams?: boolean; gitChanges?: (folder: string) => Promise<any>; runCli?: any; seatCapability?: () => boolean; claudeCli?: string; preload?: (testRoot: string) => void; failWorkspaceWrite?: () => boolean; createLeaderThrows?: boolean; opencodeThrows?: boolean; failAssistantAppend?: boolean; neverListen?: boolean; writeFile?: typeof writeFile } = {}) {
  const testRoot = options.testRoot ?? tempRoot();
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
  const realRunner = loadRunnerHarness({ testRoot, spawn: fakeSpawn, treeWatch: options.treeWatch });
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
    // The role instruction every launch starts with is covered by pack18-rw-launch.test.ts; the launch logic here is about the brief itself.
    if (result.ok) launched.push({ run: entry.run, prompt: prompt.replace(/^Your role: [^\n]*\n\n/, ""), callback });
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
        const currentMessage = text.slice(text.lastIndexOf("Current message:\n") + "Current message:\n".length);
        const saveText = text.includes("Current message:\n") ? currentMessage : text;
        const isSave = saveText.startsWith("Save a concise handover");
        if (isSave) { saveActive++; maxSaveActive = Math.max(maxSaveActive, saveActive); }
        if ((options.hangLeader && (!options.hangTab || options.hangTab === tabId)) || (isSave && options.hangSave)) return;
        if (isSave && options.writeHandover && !options.failSave) {
          const pathStart = saveText.indexOf(" to ") + 4;
          const pathEnd = saveText.indexOf(". Include current decisions", pathStart);
          const handoverPath = pathStart >= 4 && pathEnd > pathStart ? saveText.slice(pathStart, pathEnd) : "";
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
  const recoveryState = { blocked: false, recovered: false };
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
    ...fixedDependencies, structuredClone,
    createTaskStore, isFixedTab, fixedMembers, fixedState, fixedCrewOf, DEFAULTS_VERSION, FIXED_CREW,
    // The start-up recovery runs in its own tests (fixed-crew-recovery*.test.ts); here the saved workspace is the one the test gives, so recovery state is per server and starts clear.
    workspaceRecovery: () => ({ ...recoveryState }), blockWorkspaceRecovery: () => { recoveryState.blocked = true; }, unavailableWorkspace,
    assertWorkspaceRecoveryReady: (operation: string) => { if (recoveryState.blocked) throw new Error(`Workspace unavailable (${operation})`); },
    assertTaskRecoveryReady: () => { if (recoveryState.blocked) throw new Error("Workspace unavailable (task-action)"); },
    ...path,
    ...config,
    ...security,
    ...usage,
    ...stall,
    ...history,
    ...processEngine,
    Error, Buffer, URL, AbortController, EventEmitter, randomUUID, randomBytes, timingSafeEqual, console: options.console ?? console,
    setTimeout, clearTimeout, setInterval: setIntervalStub, clearInterval: () => {},
    fileURLToPath: () => path.join(testRoot, "server", "index.ts"),
    readWorkspaces: () => {
      const value = JSON.parse(JSON.stringify(savedWorkspaces));
      // The tab's coder seat reads its write permission from the test while the server runs (a capability that changes mid-approval).
      if (options.seatCapability) for (const project of value.projects) for (const tab of project.tabs) for (const seat of tab.crew) if (seat.slot === "coder") Object.defineProperty(seat, "canWrite", { get: () => options.seatCapability!(), enumerable: true, configurable: true });
      return value;
    },
    writeWorkspaces: (value: unknown) => { if (options.failWorkspaceWrite?.()) throw new Error("workspace disk failed"); savedWorkspaces = JSON.parse(JSON.stringify(value)); },
    readClientPrefs: () => config.readClientPrefs(readPrefsPath),
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
    // The start-up orphan sweep reads the real process list: the start-up test for it is in pack2-server-engine-startup.test.ts, through a real server.
    SWEEP_CAP_MS: leaderCommon.SWEEP_CAP_MS, reportStartupSweep: leaderCommon.reportStartupSweep,
    KILL_TIMEOUT_MS: leaderCommon.KILL_TIMEOUT_MS, KILL_CONFIRM_MS: leaderCommon.KILL_CONFIRM_MS,
    sweepOrphans: async () => ({ checked: 0, killed: 0, finished: true, late: Promise.resolve({ checked: 0, killed: 0 }) }),
    buildLeaderOptions: options.realLeaderOptions ? leaderApi.buildLeaderOptions : (settings: any, folder: string) => ({ model: settings.model, cwd: folder, settingSources: ["user", "project", "local"] }),
    createLeader: options.createLeaderThrows ? () => { throw new Error("leader could not start"); } : options.sdkLeader ? loadLeaderHarness(options.sdkLeader) : createLeaderStub,
    createLeaderTools: (deps: any) => { leaderDeps.set(deps.tabName, deps); return { deps }; },
    createCodexLeader, createAcpLeader, createOpencodeLeader: options.opencodeThrows ? () => { throw new Error("opencode could not start"); } : createOpencodeLeader, createLeaderBridge, buildLeaderToolSpecs,
    runSeat: runSeatReal,
    killRun: killRunReal,
    stopProcessSeat: processEngine.stopSeat,
    stopProcessAll: processEngine.stopAll,
    isRunning: realRunner.isRunning,
    isSeatRunning: realRunner.isSeatRunning,
    runIdsForSeat: realRunner.runIdsForSeat,
    stopAllRunning: realRunner.stopAllRunning,
    closeWorkerAdmission: realRunner.closeWorkerAdmission, drainWorkers: realRunner.drainWorkers,
    // The real canRunWrite counts every run as able to write (no CLI read-only mode is a safe boundary), so no real run is ever
    // relaunched by itself. "relaunchable" fakes a run that is not, only to keep the relaunch machinery itself under test.
    canRunWrite: options.relaunchable ? () => false : realRunner.canRunWrite,
    // A test that fakes the runner's release (releaseUnconfirmed) fakes what the server checks before releasing too: the same answer.
    unconfirmedPid: options.releaseUnconfirmed ? (runId: string) => (options.releaseUnconfirmed!(runId) ? 1 : undefined) : realRunner.unconfirmedPid,
    releaseUnconfirmedRun: options.releaseUnconfirmed ?? realRunner.releaseUnconfirmedRun,
    logsDir: realRunner.logsDir,
    ChatStore: options.failAssistantAppend ? class extends ChatStore { appendMessage(tabId: string, role: any, ...rest: any[]) { if (role === "assistant") throw new Error("chat disk failed"); return (super.appendMessage as any)(tabId, role, ...rest); } } : ChatStore,
    SettingsService, ModeBusyError, runCli, spawnSync: (fixedDependencies as { spawnSync?: typeof spawnSync }).spawnSync ?? spawnSync, writeProjectRules,
    RequestsStore,
    // This harness runs the server with fake runs and a made-up clock: it never reads the tools' real records or watches a folder (pack9-folder-activity-*.test.ts covers that through real servers).
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
  };
  const result = await runInNewContext(`(async () => { ${options.serverSource ?? source}
    return { wss, server, handleMessage, stateMessage, broadcast, leaders, tabs, runContexts, launchSafety, settingsService, requestsStore,
      activeLeaderTurns, pendingHandoverReads, pendingClearUndos, expiredClearUndos, runOutput, runUsage, isRunning,
      cleanScratch, scratchDir, stallTrackers, launchWorker, listHistory, getQueue: () => Promise.all([...chatOperationQueues.values()]), unconfirmedRunIds, pendingApprovals, leaderInstances, savingTabs, approvalSummary,
      chatStore, leaderSeats, leaderBridge, blockedSeatKeys, requestActions,
      fixedTasks, runRecords, createTabLeader, stopLeaderSession, launchFixedAction, reserveFixedExecution, assertFixedTaskLaunch,
      acceptPlannerReport, verifyFixedEvidence, tabLocation, sendLeaderTurn, executionJournal, fixedExecution,
      currentActor: (tabId) => ({ tabId, instance: leaderInstances.get(tabId), sessionId: "fixture-" + tabId }) };
  })()`, dependencies);
  return { ...result, testRoot, exitCodes, getWorkspaces: () => JSON.parse(JSON.stringify(savedWorkspaces)), launched, active, kills, runnerProcesses, leaderDeps, leaderCreates, leaderHandles, leaderModes, leaderToolOptions, chats, processHandlers, prefWrites, detailReads, noteReads, noteTabs, listenCalls: () => listenCalls, listenedPort: () => listenedPort, queryCount: () => queryCount, maxSaveActive: () => maxSaveActive, safety: () => safety, rejectRun: () => { rejectNextRun = true; }, throwRun: () => { throwNextRun = true; }, closeRun: (runId: string, code = 1) => runnerProcesses.get(runId)?.emit("close", code), emitOutput: (runId: string, text: string, stream: "stdout" | "stderr" = "stdout") => runnerProcesses.get(runId)?.[stream]?.emit("data", Buffer.from(text)), tick: () => ticks[0](), tickResync: () => ticks[1](), flush: () => Promise.resolve(result.getQueue()) };
}

// Fixed-mode entry for the converted Round2 files: every server here runs a saved fixed crew, with Claude and Codex marked installed
// (a whole-assignment save is checked against the installed tools) and, unless a test brings its own, a tree watch that confirms every
// closed run's process tree ended (a fixed crew runs one heavy execution at a time and a close alone is not proof).
export async function loadFixed(options: Parameters<typeof loadServer>[0] = {}) {
  const server = await loadServer({ fixed: true, treeWatch: () => ({ sweep: async () => 0, release() {}, failed: 0 }), ...options });
  server.settingsService.state.tools.claude.installed = true;
  server.settingsService.state.tools.codex.installed = true;
  return server;
}

import { ASSIST } from "./round2-fixed-deps.ts";
export { ASSIST, startHelper, setAssignment, endRun, fixedCreation } from "./round2-fixed-deps.ts";

export async function fixedGateServer(mode: "ask" | "plan" | "accept" | "bypass") {
  const server = await loadFixed({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create leader" });
  await tick();
  if (mode !== "accept") {
    ws.message({ type: "setPermissionMode", requestId: `launch_gate_${mode}`, tabId: "alpha-dev", mode });
    await waitFor(() => server.settingsService.permissionMode("alpha-dev") === mode, `${mode} saved`);
  }
  // The fixed launch call site (launchFixedAction, the leader's one launch path) behind the old deps.launch shape: a refusal comes back as { ok: false, error }.
  const launch = async (slot: string, brief: string) => {
    try { return { ok: true, ...(await server.launchFixedAction(server.currentActor("alpha-dev"), null, ASSIST, brief, slot)) }; }
    catch (error) { return { ok: false, error: (error as Error).message }; }
  };
  return { server, ws, deps: { ...server.leaderDeps.get("Development"), launch } };
}
