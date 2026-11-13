import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setGitProcessBoundaryForTests, runGitCommand } from "../server/fixed-crew/git-process.ts";
import { createGitOperations } from "../server/fixed-crew/git-operations.ts";
import { createTreeTracker } from "../server/leader-common/process-tree.ts";
import { setCliSkipFolders } from "../server/leader-common/cli-path.ts";
import { ownedTemp, testPlan } from "./pack26-review1-run2-helpers.ts";
import { loadFixed, connect, source } from "./round2-helpers.ts";
import { fixedDependencies } from "./round2-fixed-deps.ts";

export function processFixture(t: { after: (fn: () => void) => void }, options: {
  listFails?: boolean; survives?: boolean; spawnThrows?: boolean; timeoutMs?: number; drainMs?: number; sweepMs?: number;
  holdCleanup?: boolean;
  unreadableCreation?: boolean;
} = {}) {
  const root = ownedTemp(t), bin = join(root, "bin"), folder = join(root, "project");
  mkdirSync(bin); mkdirSync(folder); writeFileSync(join(bin, "git.exe"), "never executed");
  const previous = { PATH: process.env.PATH, CC_TEST_FAKE_CLI: process.env.CC_TEST_FAKE_CLI };
  process.env.PATH = bin; process.env.CC_TEST_FAKE_CLI = "1";
  const registry = createGitOperations(), op = registry.register("git-test", "tab", {});
  const child = Object.assign(new EventEmitter(), { pid: 987650, exitCode: null as number | null, signalCode: null as string | null,
    stdout: new PassThrough(), stderr: new PassThrough() });
  let alive = true, listCalls = 0, killCalls = 0, sweepCalls = 0, rootStops = 0;
  Object.assign(child, { kill() { rootStops++; alive = false; child.exitCode = 1; child.emit("exit", 1, null); child.emit("close", 1, null); return true; } });
  const tracker = createTreeTracker({ list: async () => {
    listCalls++;
    if (options.listFails) return null;
    return alive ? [{ pid: child.pid, ppid: process.pid, created: options.unreadableCreation ? 0 : at }] : [];
  }, kill: async (pid) => { if (pid !== child.pid) throw new Error("Unowned synthetic identity"); killCalls++; if (!options.survives) alive = false; return true; } });
  const at = Date.now();
  const spawns: any[] = [];
  let releaseCleanup!: () => void;
  const cleanupHold = new Promise<void>((done) => { releaseCleanup = done; });
  t.after(releaseCleanup);
  setCliSkipFolders(() => [folder]);
  setGitProcessBoundaryForTests({ ...options, spawn(program, args, spawnOptions) {
    spawns.push({ program, args, ...spawnOptions });
    if (options.spawnThrows) throw new Error("injected spawn throw");
    if (spawns.length > 1) queueMicrotask(() => { child.stdout.write("a".repeat(40)); child.emit("close", 0, null); });
    return child as any;
  }, watch: (pid, started) => {
    const watch = tracker.watch(pid, started);
    return { get failed() { return watch.failed; }, release: watch.release,
      sweep: async (end, strict) => { sweepCalls++; if (options.holdCleanup) await cleanupHold; return watch.sweep(end, strict); } };
  } });
  t.after(() => {
    child.stdout.destroy(); child.stderr.destroy();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    process.env.CC_TEST_FAKE_CLI = "1"; setGitProcessBoundaryForTests();
    if (previous.CC_TEST_FAKE_CLI === undefined) delete process.env.CC_TEST_FAKE_CLI; else process.env.CC_TEST_FAKE_CLI = previous.CC_TEST_FAKE_CLI;
    setCliSkipFolders(() => []);
    registry.cancelAll();
  });
  const exit = (code = 0, close = true) => {
    child.exitCode = code; alive = false; child.emit("exit", code, null);
    if (close) child.emit("close", code, null);
  };
  return { root, bin, folder, registry, op, child, spawns, exit, releaseCleanup,
    run: () => runGitCommand(op, folder, ["status"]), listCalls: () => listCalls, killCalls: () => killCalls, sweepCalls: () => sweepCalls, rootStops: () => rootStops };
}

export async function stateFixture(t: Parameters<typeof processFixture>[0], options: Parameters<typeof processFixture>[1] = {}) {
  const f = processFixture(t, options);
  writeFileSync(join(f.folder, "owned.txt"), "before");
  const factory = fixedDependencies.createGitOperations;
  let operations!: ReturnType<typeof factory>;
  fixedDependencies.createGitOperations = () => (operations = factory());
  let server: Awaited<ReturnType<typeof loadFixed>>;
  try { server = await loadFixed({ skipHealth: true, testRoot: join(f.root, "server-data"),
    serverSource: source + '\nfixedTasks.fixtureReplaceStore = () => { fixedTasks = { ...fixedTasks }; };' }); }
  finally { fixedDependencies.createGitOperations = factory; }
  for (const project of server.getWorkspaces().projects) for (const tab of project.tabs) server.tabLocation(tab.id).tab.folder = f.folder;
  const tabId = "alpha-dev", ws = connect(server);
  ws.terminate = () => { ws.readyState = 3; };
  server.createTabLeader(tabId);
  const tab = server.tabLocation(tabId).tab;
  const seats = Object.fromEntries(Object.entries(tab.fixedCrew.preferences).map(([slot, pref]: [string, any]) => [slot, pref.assignment]));
  const task = server.fixedTasks.create(tabId, testPlan(), seats, server.fixedTasks.actor("planner"));
  server.fixedTasks.apply({ tabId, taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision, requestId: "approve" }, { type: "approvePlan" }, server.fixedTasks.actor("owner"));
  const expected = () => { const task = server.fixedTasks.get(tabId); return { taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision }; };
  const launch = () => server.launchFixedAction(server.currentActor(tabId), expected(), { kind: "checkpoint", route: "normal", change: "none" }, "Approved checkpoint");
  const journal = () => server.executionJournal(server.testRoot, tabId);
  const terminal = () => readFileSync(journal().executions.at(-1).logPath, "utf8").split("\n").flatMap((line) => { try { const item = JSON.parse(line); return item.type === "git-terminal" ? [item] : []; } catch { return []; } });
  return { ...f, server, operations, tab, tabId, ws, expected, launch, journal, terminal };
}

export async function shutdownFixture(t: Parameters<typeof ownedTemp>[0], disconnected = false, startup = false) {
  const testRoot = ownedTemp(t);
  const calls: any[] = [], deps = fixedDependencies as any, original = deps.spawnSync;
  deps.spawnSync = (...args: any[]) => { calls.push(args); return { status: 0 }; };
  const initialize = 'process.connected = false; process.pid = 123456;\n';
  const serverSource = startup ? source.replace("let shutdownWork", `${initialize}let shutdownWork`)
    : source + (disconnected ? `\n${initialize}` : "");
  try { return { server: await loadFixed({ skipHealth: true, serverSource, testRoot }), calls }; }
  finally { if (original === undefined) delete deps.spawnSync; else deps.spawnSync = original; }
}
