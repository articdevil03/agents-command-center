import assert from "node:assert/strict";
import { writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { boot, client, RUN_END_MS, type BootOptions } from "./pack18-harness.ts";
import { importWithTempDataRoot } from "./temp-root.ts";
import { lowerOwnPriority } from "../scripts/sweep/run.mjs";
import { createTreeTracker, setProcessTreeForTests, killProcessTree } from "../server/leader-common.ts";
import { constants as osConstants, setPriority } from "node:os";
import childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { waitForServerStart } from "./server-start.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";
lowerOwnPriority();
const serverPreload = process.env.CC_FCX_SERVER === "1" || process.env.CC_FCX_TREE_BOUNDARY === "1";
const injectedTree = process.env.CC_FCX_TREE_BOUNDARY === "1";
// Explicit process-list boundary for the owned, finite fake CLIs. The sandbox
// cannot list descendants from the server child. This is injected evidence,
// never a claim that the operating system confirmed a real tree here.
if (process.env.CC_FCX_TREE_BOUNDARY === "1") setProcessTreeForTests(createTreeTracker({
  list: async () => {
    if (existsSync(join(process.env.CC_DATA_DIR!, "..", "unknown-tree"))) throw new Error("Injected unknown descendants");
    return [];
  }, kill: async () => { throw new Error("The finite fake child must leave no processes to kill."); },
}));
if (serverPreload) {
  // taskkill is unavailable in some sandboxes. The injected boundary holds
  // actual ChildProcess handles created by THIS fake server, never PID matches.
  const spawn = childProcess.spawn, owned = new Map<number, ReturnType<typeof spawn>>();
  childProcess.spawn = ((program: string, args: any, options: any) => {
    if (injectedTree && /(?:^|[\\/])taskkill(?:\.exe)?$/i.test(program)) {
      const target = owned.get(Number(args[args.indexOf("/pid") + 1]));
      const result = new EventEmitter();
      const deferred = target && existsSync(join(process.env.CC_DATA_DIR!, "..", "defer-worker-stop"));
      if (deferred) appendFileSync(join(process.env.CC_DATA_DIR!, "..", "stop-observed.jsonl"), JSON.stringify({ pid: target.pid, accepted: true }) + "\n");
      queueMicrotask(() => result.emit("exit", deferred ? 0 : target && target.exitCode === null && target.signalCode === null ? target.kill() ? 0 : 1 : 128));
      return result;
    }
    const temp = join(process.env.CC_DATA_DIR!, "..");
    const cli = ["codex", "claude", "opencode"].find((name) => program.startsWith(`"${join(temp, "bin", `${name}.cmd`)}" `));
    if (cli) {
      const env = args.env ?? {};
      appendFileSync(join(temp, "spawn-observed.jsonl"), JSON.stringify({ program, shell: args.shell, windowsHide: args.windowsHide ?? false,
        cwd: args.cwd, briefPath: env.CC_BRIEF_PATH, tokenPresent: !!env.CC_CREW_TOKEN, crewUrlPresent: !!env.CC_CREW_URL,
        mcpPresent: !!env.CC_MCP_CONFIG, opencodeConfigPresent: !!env.OPENCODE_CONFIG_CONTENT }) + "\n");
    }
    // Start the fixture itself as the owned child. A cmd wrapper would leave
    // an untracked fake grandchild when a RED assertion stops the test early.
    const child = cli && injectedTree ? spawn(process.execPath, [join(temp, "worker.cjs"), cli], { ...args, shell: false }) : spawn(program, args, options);
    if (child.pid) {
      const log = (event: string) => appendFileSync(join(temp, "children.jsonl"), JSON.stringify({ event, pid: child.pid, worker: !!cli }) + "\n");
      log("start"); owned.set(child.pid, child);
      child.once("exit", () => log("exit"));
      child.once("close", () => { log("close"); if (owned.get(child.pid!) === child) owned.delete(child.pid!); });
    }
    return child;
  }) as typeof spawn;
  syncBuiltinESMExports();
  process.on("message", (message) => {
    if (message !== "fcx-stop-owned") return;
    void (async () => {
      const children = [...owned.values()];
      const exits = children.map((child) => once(child, "close"));
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        if (injectedTree) child.kill(); else killProcessTree(child, () => {});
      }
      await Promise.all(exits);
      process.send?.({ fcxOwnedEnded: true, pids: children.map((child) => child.pid) });
    })();
  });
}
const loadModules = async () => ({
  config: await import("../server/config.ts"), state: await import("../server/main/state.ts"),
  fixed: await import("../server/main/fixed-task-launch.ts"), tools: await import("../server/main/fixed-task-tools.ts"),
  runtime: await import("../server/fixed-crew/runtime.ts"), tabs: await import("../server/main/tabs.ts"),
  journal: await import("../server/fixed-crew/task-execution.ts"), reports: await import("../server/fixed-crew/task-reports.ts"),
  tasks: await import("../server/main/fixed-tasks.ts"),
});
// A server preload already has its isolated data root. Never replace it while
// loading config, whose import-time paths must belong to that server.
export const { dataDir, modules } = serverPreload
  ? { dataDir: process.env.CC_DATA_DIR!, modules: await loadModules() }
  : await importWithTempDataRoot(loadModules);
if (serverPreload) process.on("message", (message: any) => {
  if (!message?.fcxControl) return;
  void (async () => {
    const { state } = modules;
    let value: any = null;
    const tabId = message.tabId ?? "fixed";
    if (message.fcxControl === "announce") {
      value = (await import("../server/main/launch-gates.ts")).announceFolderBusy(tabId);
    } else if (message.fcxControl === "leader-bridge") {
      const entries = readFileSync(join(dataDir, "..", "fake-leader.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const setup = entries.filter((entry) => entry.path === "/mcp" && entry.method === "POST" && entry.body?.config?.url?.endsWith(`/api/leader-mcp/${encodeURIComponent(tabId)}`)).at(-1);
      if (!setup) throw new Error("No actual OpenCode /mcp setup for this tab");
      value = { url: setup.body.config.url, token: setup.body.config.headers.Authorization.slice("Bearer ".length) };
    } else if (message.fcxControl === "assist") {
      if (!modules.runtime.fixedMembers(modules.tabs.tabLocation(tabId)!.tab).some((seat) => seat.slot === message.slot && !seat.canWrite && !seat.isLeader)) throw new Error("Explicit read-only assist position required");
      const instance = state.leaderInstances.get(tabId);
      if (!instance) throw new Error("Start the current leader before assist");
      value = await modules.tools.launchFixedAction({ tabId, instance, sessionId: `fixture-${tabId}` }, message.expected,
        { kind: "assist", route: "normal", change: "none" }, message.brief, message.slot);
    } else if (message.fcxControl === "bridge") {
      const { openBridge } = await import("../server/main/crew-tools.ts");
      value = openBridge("fcx-test", modules.tools.fixedLeaderSpecs(tabId, state.leaderInstances.get(tabId)!));
      value = { token: value.token };
    } else if (message.fcxControl === "reuse-session") {
      const store = state.fixedTasks;
      state.setFixedTasks({ ...store, apply(expected, event, actor) {
        if (event.type === "action" && event.action.kind === "review") {
          state.setFixedTasks(store);
          event = { ...event, sessionId: message.sessionId };
        }
        return store.apply(expected, event, actor);
      } });
    } else if (message.fcxControl === "defaults") {
      state.fixedLeaderSettings.set(tabId, "previous-default-version");
    } else if (message.fcxControl === "environment") {
      value = process.env;
    } else if (message.fcxControl === "retirement") {
      const leader = state.leaders.get(tabId)!, stop = leader.stop.bind(leader), processState = leader.process?.bind(leader);
      leader.stop = () => { stop(); appendFileSync(join(dataDir, "..", "retired"), "stopped\n"); };
      leader.process = () => existsSync(join(dataDir, "..", "hold-retirement"))
        ? { running: true, killFailed: true, recheck: async () => {} } as any : processState?.() ?? { running: false } as any;
    }
    process.send?.({ fcxReply: message.id, value });
  })().catch((error) => process.send?.({ fcxReply: message.id, error: error.message }));
});
if (serverPreload) {
  const { setFixedPriorityBoundaryForTests } = await import("../server/runner.ts");
  setFixedPriorityBoundaryForTests((pid) => {
    appendFileSync(join(dataDir, "..", "priority-observed.jsonl"), JSON.stringify({ pid }) + "\n");
    setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
  });
}
if (process.env.CC_FCX_GIT_BOUNDARY === "1") {
  const { setFixedGitBoundaryForTests } = await import("../server/main/fixed-task-actions.ts");
  let commits = 0, subject = "";
  setFixedGitBoundaryForTests((folder, args) => {
    appendFileSync(join(folder, "..", "git-observed.jsonl"), JSON.stringify(args) + "\n");
    const settingsPath = join(folder, "..", "git-options.json");
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
    if (args[0] === "rev-parse") return args[1] === "--is-inside-work-tree" ? "true" : String.fromCharCode(97 + commits).repeat(40);
    if (args[0] === "status") return settings.clean ? "" : " M owned.txt\0";
    if (args[0] === "commit") { commits++; subject = args[args.indexOf("-m") + 1]; return "committed"; }
    if (args[0] === "diff-tree") return settings.unrelated ? "unrelated.txt\0" : "owned.txt\0";
    if (args[0] === "log") return subject;
    return "";
  });
}
export const assignment = { cli: "codex" as const, model: "gpt-6.1-sol", effort: "medium" };
export const plan = (high = false) => ({ id: "pack", scope: "Change the owned file", criteria: ["File is correct"],
  blocks: [{ id: "one", scope: "File", paths: ["owned.txt"] }], risk: { level: high ? "high" : "small", reason: "Contained file", paths: ["owned.txt"], verification: ["focused"] },
  visibleWork: false, large: false, integration: false, design: false, paths: ["owned.txt"], consumers: [], sharedInputs: [], checks: ["focused"], shipping: ["commit"], reviewReason: "Fresh independent review" });
export function fixedTab(work: string, assignments: Record<string, any> = {}) {
  const tab = modules.config.defaultWorkspaces(work).projects[0].tabs[0]; tab.id = "fixed";
  for (const slot of Object.keys(tab.fixedCrew!.preferences)) tab.fixedCrew!.preferences[slot as keyof typeof tab.fixedCrew.preferences] = { assignment: assignments[slot] === undefined ? assignment : assignments[slot], source: "user" };
  return tab;
}
const WORKER = `
const fs = require('fs'), path = require('path'), os = require('os');
const brief = fs.readFileSync(process.env.CC_BRIEF_PATH, 'utf8');
const base = path.resolve(process.cwd(), '..');
const options = JSON.parse(fs.readFileSync(path.join(base, 'worker-options.json'), 'utf8'));
const observation = { pid: process.pid, priority: os.getPriority(), bridge: process.env.CC_CREW_URL ?? null,
  tokenPresent: !!process.env.CC_CREW_TOKEN, mcp: process.env.CC_MCP_CONFIG ?? null,
  opencodeConfigPresent: !!process.env.OPENCODE_CONFIG_CONTENT, briefPath: process.env.CC_BRIEF_PATH, brief };
fs.writeFileSync(path.join(base, 'worker-observed.json'), JSON.stringify(observation));
fs.appendFileSync(path.join(base, 'worker-observed.jsonl'), JSON.stringify(observation) + '\\n');
const identity = (key) => { const match = brief.split(key + ' (')[1]; if (!match) return undefined; try { return JSON.parse(match.split(')')[0]); } catch { return undefined; } };
const runId = identity('runId'), taskId = identity('taskId'), planVersion = identity('planVersion');
if (runId === undefined || taskId === undefined || planVersion === undefined) {
  process.stderr.write('Fixture report identity missing; worker input was recorded\\n'); process.exit(2);
}
const report = { version: 1, runId, taskId, planVersion, evidence: ['owned.txt'], plan: options.plan ?? null, findings: [], resolved: [], baseFinal: null, unchanged: [], decisions: [], ...options.report };
if (options.finding) report.findings = [{ id: 'finding', executionId: runId, text: 'Optional wording', real: true, minimal: true }];
const text = 'CC_REPORT_BEGIN\\n' + JSON.stringify(report) + '\\nCC_REPORT_END\\n';
const emit = () => { if (options.write) fs.writeFileSync(path.join(process.cwd(), 'owned.txt'), options.write); process.stdout.write(process.argv[2] === 'claude' ? JSON.stringify({ type: 'assistant', message: { content: [{type: 'text', text}] } }) + '\\n' : text); if (options.duplicate) process.stdout.write(options.duplicate === 'different' ? 'CC_REPORT_BEGIN\\n' + JSON.stringify({ ...report, evidence: [] }) + '\\nCC_REPORT_END\\n' : text); process.exitCode = options.exit ?? 0; };
setTimeout(emit, Math.min(options.delay ?? 5, 15000));
`;
// Native replay (outside sandbox): fixedServer({ nativeProcess: true }). Keeps controls/data isolation, substitutes neither process lists nor taskkill nor worker transport.
export async function fixedServer(options: { assignments?: Record<string, any>; high?: boolean; extra?: BootOptions["extra"]; env?: BootOptions["env"]; git?: boolean; gitProcess?: boolean; shipping?: string[]; secondTab?: boolean; nativeProcess?: boolean } = {}) {
  const env = { CC_FCX_SERVER: "1", CC_FCX_TREE_BOUNDARY: options.nativeProcess ? "0" : "1", CC_FCX_GIT_BOUNDARY: options.git ? "1" : "0",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${new URL("./fixed-crew-execution-helpers.ts", import.meta.url).href}${options.gitProcess ? ` --import ${new URL("./pack26-review1-run2-preload.ts", import.meta.url).href}` : ""}`, ...options.env };
  const server = await boot({ fakeLeader: true, env, tabs: (work) => {
    writeFileSync(join(work, "owned.txt"), "before");
    const fixed = fixedTab(work, options.assignments);
    return options.secondTab ? [fixed, { ...fixedTab(work, options.assignments), id: "fixed-second", name: "Second fixed" }] : [fixed];
  }, extra(paths) {
    if (options.env?.PATH) env.PATH = `${paths.bin};${options.env.PATH}`;
    writeFileSync(join(paths.temp, "worker.cjs"), WORKER);
    writeFileSync(join(paths.temp, "worker-options.json"), JSON.stringify({ plan: plan(options.high) }));
    for (const cli of ["codex", "claude", "opencode"]) writeFileSync(join(paths.bin, `${cli}.cmd`), `@echo off\r\nnode "%~dp0..\\worker.cjs" ${cli}\r\nexit /b %ERRORLEVEL%\r\n`);
    options.extra?.(paths);
  } });
  let c: Awaited<ReturnType<typeof client>> | undefined;
  let ready = false;
  const originalStop = server.stop;
  const endOwned = async () => {
      if (server.child.connected && server.child.exitCode === null && server.child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { server.child.off("message", onMessage); reject(new Error(`Owned fake children were not confirmed ended for server ${server.child.pid}`)); }, 5000);
          const onMessage = (message: any) => { if (message?.fcxOwnedEnded) { clearTimeout(timer); server.child.off("message", onMessage); resolve(); } };
          server.child.on("message", onMessage); server.child.send("fcx-stop-owned");
        });
      }
  };
  const endServer = async () => {
    if (server.child.exitCode !== null || server.child.signalCode !== null) return;
    const exited = once(server.child, "exit");
    server.child.send("shutdown");
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned server did not exit")), 8000); })]); }
    finally { clearTimeout(timer!); }
  };
  const stop = async () => {
    try { await endOwned(); await endServer(); }
    finally { await originalStop(); }
  };
  try {
  c = await client(server);
  let controlId = 0;
  const control = (fcxControl: string, args = {}) => new Promise<any>((resolve, reject) => {
    const id = ++controlId;
    const timer = setTimeout(() => { server.child.off("message", receive); reject(new Error(`Control ${fcxControl} timed out`)); }, 5000);
    const receive = (message: any) => {
      if (message?.fcxReply !== id) return;
      clearTimeout(timer); server.child.off("message", receive);
      if (message.error) reject(new Error(message.error)); else resolve(message.value);
    };
    server.child.on("message", receive); server.child.send({ fcxControl, id, ...args });
  });
  const restart = async (restoreCrashSnapshot?: () => void) => {
    const env = await control("environment");
    c!.close(); await endOwned(); await endServer();
    restoreCrashSnapshot?.();
    const oldPid = server.child.pid;
    const child = childProcess.spawn(process.execPath, ["server/index.ts"], { cwd: process.cwd(), windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...env, CC_PORT: "0", CC_APP_KEY: server.key } });
    attachCrashCatcher(child.pid, "fixed-crew-restart");
    server.child = child;
    let log = ""; child.stdout!.on("data", (data) => { log += data; }); child.stderr!.on("data", (data) => { log += data; });
    server.log = () => log;
    server.port = await waitForServerStart(child, server.log);
    c = await client(server);
    return { oldPid, newPid: child.pid };
  };
  for (const tabId of options.secondTab ? ["fixed", "fixed-second"] : ["fixed"])
    assert.deepEqual(await c.request({ type: "setPermissionMode", tabId, mode: "bypass", confirm: true }), { ok: true });
  const tool = async (name: string, args: any = {}, tabId = "fixed") => {
    const answer = (await c!.chat(tabId, JSON.stringify([{ tool: name, args }]))).trim();
    const match = /^\[tool (ok|failed): ([\s\S]*)\]$/.exec(answer);
    assert.ok(match, `tool reply missing: ${answer}; errors=${JSON.stringify(c.messages.filter((m) => m.type === "chatError").slice(-3))}`);
    let value: any; try { value = JSON.parse(match[2]); } catch { value = match[2]; }
    return { ok: match[1] === "ok", value, text: match[2] };
  };
  const task = (tabId = "fixed") => { try { return JSON.parse(readFileSync(join(server.data, "tasks", `${tabId}.json`), "utf8")); } catch { return null; } };
  const expected = (tabId = "fixed") => { const t = task(tabId); return t ? { taskId: t.id, planVersion: t.planVersion, recordRevision: t.recordRevision } : null; };
  const worker = (options: any) => writeFileSync(join(server.temp, "worker-options.json"), JSON.stringify(options));
  const ended = async (runId: string, tabId = "fixed") => c!.wait(() => c!.tab(tabId).runs.find((r: any) => r.id === runId && r.status !== "working"), `fixed run ${runId} ended`, RUN_END_MS);
  const journal = (tabId = "fixed") => JSON.parse(readFileSync(join(server.data, "executions", `${tabId}.json`), "utf8"));
  const rows = (file: string) => existsSync(join(server.temp, file)) ? readFileSync(join(server.temp, file), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const observation = (runId: string, tabId = "fixed") => {
    const execution = journal(tabId).executions.find((entry: any) => entry.id === runId);
    const briefPath = execution?.logPath?.replace(/\.log$/, ".brief.txt");
    return rows("worker-observed.jsonl").find((entry: any) => entry.briefPath === briefPath);
  };
  const spawnCapture = (runId: string, tabId = "fixed") => {
    const logPath = journal(tabId).executions.find((entry: any) => entry.id === runId)?.logPath;
    return rows("spawn-observed.jsonl").find((entry: any) => entry.briefPath === logPath?.replace(/\.log$/, ".brief.txt"));
  };
  const assist = (slot: string, brief = "Read and report", tabId = "fixed") => control("assist", { tabId, slot, brief, expected: expected(tabId) });
  const planning = async (tabId = "fixed") => {
    worker({ plan: { ...plan(options.high), ...(options.shipping ? { shipping: options.shipping } : {}) } });
    const result = await tool("begin_planning", { expected: expected(tabId), brief: "Inspect and return a plan" }, tabId);
    assert.equal(result.ok, true, result.text); const finished = await ended(result.value.runId, tabId);
    const savedJournal = journal(tabId);
    const record = savedJournal.executions.find((e: any) => e.id === result.value.runId);
    assert.equal(record.status, "done", `Planner status=${finished.status}, journal=${JSON.stringify(record)}, log=${record.logPath ? readFileSync(record.logPath, "utf8") : "missing"}`);
    const accepted = await tool("accept_planner_report", { expected: expected(tabId), runId: result.value.runId }, tabId);
    assert.equal(accepted.ok, true, accepted.text);
    return accepted.value;
  };
  const approve = async (tabId = "fixed") => {
    c!.send({ type: "selectTab", tabId });
    await c!.wait(() => c!.state().selectedTabId === tabId, "approval tab selected");
    const t = task(tabId); assert.ok(t);
    const id = `approval-${tabId}-${t.recordRevision}`;
    c.send({ type: "approveFixedPlan", tabId, requestId: id, ...expected(tabId) });
    const result = await c.wait(() => c.messages.find((m) => m.requestId === id), "owner plan approval");
    assert.equal(result.type, "fixedTaskResult", JSON.stringify(result));
  };
  const action = (kind: string, extras = {}, tabId = "fixed") => tool("request_task_action", { expected: expected(tabId), kind, brief: `Perform ${kind}`, ...extras }, tabId);
  const verify = (runId: string, checkName: string | null = null, tabId = "fixed") => tool("verify_task_evidence", { expected: expected(tabId), runId, checkName }, tabId);
  const close = async () => { c?.close(); await stop(); assert.ok(server.child.exitCode !== null || server.child.signalCode !== null, "owned server ended"); };
  ready = true;
  return { server, get c() { return c!; }, tool, worker, task, expected, ended, planning, approve, action, verify, close, control, restart, journal, observation, spawnCapture, assist, children: () => rows("children.jsonl"), stops: () => rows("stop-observed.jsonl") };
  } finally {
    if (!ready) { c?.close(); await stop(); }
  }
}
