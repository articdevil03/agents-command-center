import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixed, connect, source, fixtureWorkspaces, settleLeaderTurns } from "./round2-helpers.ts";
import { fixedDependencies } from "./round2-fixed-deps.ts";
import { ownedTemp, testPlan } from "./pack26-review1-run2-helpers.ts";
import { saveJournal } from "../server/fixed-crew/task-execution.ts";
import { runLeaderTool } from "../server/leader-tools.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { createGitOperations } from "../server/fixed-crew/git-operations.ts";

export async function recoveryFixture(t: { after: (fn: () => any) => void }, options: { task?: boolean; confirmed?: boolean; kind?: string; running?: boolean } = {}) {
  let server: any;
  const registry = createGitOperations();
  t.after(async () => {
    if (!server) return;
    for (const entry of server.launched) {
      server.closeRun(entry.run.runId, 1);
      // Released synthetic handles no longer call onStatus; retire only our fixture's bookkeeping after close.
      server.active.delete(entry.run.runId);
      assert.equal(server.isRunning(entry.run.runId), false);
    }
    await settleLeaderTurns(server);
    for (const id of ["alpha-dev", "beta-dev"]) server.stopLeaderSession(id);
    assert.equal(server.active.size, 0, "all injected runner handles ended");
    registry.cancelAll();
  });
  const root = ownedTemp(t), folder = join(root, "work"), data = join(root, "data");
  mkdirSync(folder); writeFileSync(join(folder, "owned.txt"), "before");
  const workspaces = fixtureWorkspaces();
  for (const project of workspaces.projects) for (const tab of project.tabs) tab.folder = folder;
  let failJournal = 0, journalWrites = 0;
  const original = { ...fixedDependencies };
  fixedDependencies.createGitOperations = () => registry;
  fixedDependencies.saveJournal = (root, tab, journal) => {
    journalWrites++;
    if (failJournal && journalWrites === failJournal) throw new Error("injected journal publication failure");
    saveJournal(root, tab, journal);
  };
  try {
    server = await loadFixed({ skipHealth: true, testRoot: data, workspaces, deferKill: options.running,
      serverSource: source + `\nfixedTasks.run3 = {
        specs: (tabId) => fixedLeaderSpecs(tabId, leaderInstances.get(tabId)),
        install: (store) => { fixedTasks = store; },
        journal: (tabId, value) => saveJournal(dataRoot, tabId, value),
        tree: fixedTreeEnd, status: fixedRunStatus,
      };` });
  } finally { Object.assign(fixedDependencies, original); }
  const controls = server.fixedTasks.run3;
  const tabId = "alpha-dev", ws = connect(server);
  ws.terminate = () => { ws.readyState = 3; };
  server.createTabLeader(tabId);
  const tab = server.tabLocation(tabId).tab;
  const seats = Object.fromEntries(Object.entries(tab.fixedCrew.preferences).map(([slot, p]: [string, any]) => [slot, p.assignment]));
  const expected = (id = tabId) => { const task = server.fixedTasks.get(id); return task ? { taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision } : null; };
  const apply = (event: any) => server.fixedTasks.apply({ tabId, ...expected(), requestId: `run3-${Math.random().toString(36).slice(2)}` }, event, server.fixedTasks.actor("leader", "run3-leader"));
  if (options.task !== false) {
    server.fixedTasks.create(tabId, testPlan(), seats, server.fixedTasks.actor("planner"));
    server.fixedTasks.apply({ tabId, ...expected(), requestId: "approve" }, { type: "approvePlan" }, server.fixedTasks.actor("owner"));
  }
  const kind: any = options.kind ?? (options.task === false ? "planning" : { kind: "build", route: "normal", change: "none" });
  let runId: string;
  if (options.running) runId = (await server.launchFixedAction(server.currentActor(tabId), expected(), kind, "Owned fixture run")).runId;
  else {
    const { execution, context } = server.reserveFixedExecution(server.currentActor(tabId), kind);
    server.assertFixedTaskLaunch(tabId, execution.role, context); runId = execution.id;
  }
  const journal = () => server.executionJournal(data, tabId);
  const setJournal = (change: (value: any) => void) => { const value = journal(); change(value); controls.journal(tabId, value); };
  // Explicit injected state for the unit routes. Native confirmation is tested separately.
  setJournal((value) => { value.executions.at(-1).status = "interrupted"; value.executions.at(-1).processEnded = options.confirmed !== false; });
  const specs = controls.specs(tabId);
  const call = (args: any = {}, selected = specs) => runLeaderTool(selected, "reconcile_task_execution", { expected: expected(), runId, reason: "Abandon the interrupted run", ...args });
  const disk = () => ({ task: options.task === false ? null : readFileSync(join(data, "tasks", `${tabId}.json`), "utf8"), journal: readFileSync(join(data, "executions", `${tabId}.json`), "utf8") });
  const restart = () => {
    const store = createTaskStore(data, (id) => server.tabLocation(id).tab.folder);
    store.get(tabId); controls.install(store); server.fixedTasks = store;
  };
  return { server, root, folder, data, tabId, tab, ws, controls, registry, expected, apply, runId, journal, setJournal, specs, call, disk, restart,
    failJournalAt: (offset: number) => { failJournal = journalWrites + offset; } };
}

export async function assertOtherTabLaunch(f: Awaited<ReturnType<typeof recoveryFixture>>) {
  f.server.createTabLeader("beta-dev");
  const result = await f.server.launchFixedAction(f.server.currentActor("beta-dev"), null, { kind: "assist", route: "normal", change: "none" }, "Read files");
  assert.ok(result.runId, "another tab actually starts a heavy worker after reconciliation");
  assert.equal(f.server.isRunning(result.runId), true);
  f.server.closeRun(result.runId, 0);
}
