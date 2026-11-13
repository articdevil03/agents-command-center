import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixed, connect, source, fixtureWorkspaces, settleLeaderTurns, waitFor } from "./round2-helpers.ts";
import { ownedTemp, testPlan } from "./pack26-review1-run2-helpers.ts";
import { runLeaderTool } from "../server/leader-tools.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { saveJournal } from "../server/fixed-crew/task-execution.ts";
import type { Plan } from "../server/fixed-crew/task-types.ts";

export async function run4Fixture(t: { after: (fn: () => any) => void }, overrides: Partial<Plan> = {}, serverExtension = "") {
  let server: any;
  t.after(async () => {
    if (!server) return;
    for (const entry of server.launched) server.closeRun(entry.run.runId, 1);
    await waitFor(() => server.active.size === 0, "owned synthetic runner end");
    await settleLeaderTurns(server);
    for (const id of ["alpha-dev", "beta-dev"]) server.stopLeaderSession(id);
    assert.equal(server.active.size, 0);
    console.log("Run 4 owned synthetic runner handles ended; no native process was spawned by this fixture.");
  });
  const root = ownedTemp(t), folder = join(root, "work"), data = join(root, "data");
  mkdirSync(folder); writeFileSync(join(folder, "owned.txt"), "before");
  const workspaces = fixtureWorkspaces();
  for (const project of workspaces.projects) for (const tab of project.tabs) tab.folder = folder;
  server = await loadFixed({ skipHealth: true, testRoot: data, workspaces, serverSource: source + `
    fixedTasks.run4 = {
      specs: (tabId) => fixedLeaderSpecs(tabId, leaderInstances.get(tabId)),
      install: (store) => { fixedTasks = store; },
      git: setFixedGitBoundaryForTests, callbacks: { tree: fixedTreeEnd, status: fixedRunStatus, log: fixedRunLog },
      pendingApprovals, savingTabs, runContexts, fixedGitOperations, initialize: initializeFixedTasks,
      failDelivery: () => { sendLeaderTurn = async () => false; },
    };
    ${serverExtension}` });
  const controls = server.fixedTasks.run4;
  const tabId = "alpha-dev", ws = connect(server);
  ws.terminate = () => { ws.readyState = 3; };
  server.createTabLeader(tabId);
  const task = () => server.fixedTasks.get(tabId);
  const expected = () => { const current = task(); return current ? { taskId: current.id, planVersion: current.planVersion, recordRevision: current.recordRevision } : null; };
  const specs = controls.specs(tabId);
  const call = (name: string, args: any = {}, selected = specs) => runLeaderTool(selected, name, args);
  const tool = async (name: string, args: any = {}) => {
    const reply = await call(name, args);
    assert.equal(reply.isError, false, reply.text);
    return JSON.parse(reply.text);
  };
  const journal = () => server.executionJournal(data, tabId);
  const worker = async (kind: string, report: Record<string, unknown> = {}) => {
    const result = await tool(kind === "planning" ? "begin_planning" : "request_task_action", { expected: expected(), kind, brief: "Owned Run 4 execution" });
    const runId = result.runId;
    const bound = journal().executions.find((e: any) => e.id === runId);
    const payload = { version: 1, runId, taskId: bound.taskId, planVersion: bound.planVersion, evidence: ["owned.txt"],
      plan: null, findings: [], resolved: [], baseFinal: null, unchanged: [], decisions: [], ...report };
    server.emitOutput(runId, `CC_REPORT_BEGIN\n${JSON.stringify(payload)}\nCC_REPORT_END\n`);
    server.closeRun(runId, 0);
    await waitFor(() => journal().executions.find((e: any) => e.id === runId)?.status === "done", "production status and tree callbacks");
    if (kind === "planning") await tool("accept_planner_report", { expected: expected(), runId });
    else await tool("verify_task_evidence", { expected: expected(), runId, checkName: kind === "check" ? "focused" : null });
    return runId;
  };
  const plan = { ...testPlan(), shipping: [], ...overrides };
  await worker("planning", { plan });
  const approve = () => ws.message({ type: "approveFixedPlan", requestId: `owner-${task().recordRevision}`, tabId, ...expected() });
  approve(); assert.ok(task().ownerScopeApproval);
  const ready = async () => {
    if (plan.visibleWork) {
      await worker("rough"); await worker("visualCheck"); await worker("inspect");
      ws.message({ type: "approveFixedRough", requestId: "rough-owner", tabId, ...expected(), roughRevision: task().roughRevision });
      assert.ok(task().ownerRoughApproval);
      await worker("polish");
    } else await worker("build");
    await worker("check"); await worker("review");
    if (task().reviewPolicy.finalRequired) await worker("final");
    if (plan.shipping.length) {
      let commits = 0;
      controls.git((_folder: string, args: string[]) => {
        if (args[0] === "rev-parse") return args[1] === "--is-inside-work-tree" ? "true" : String.fromCharCode(97 + commits).repeat(40);
        if (args[0] === "status") return " M owned.txt\0";
        if (args[0] === "commit") { commits++; return "committed"; }
        if (args[0] === "diff-tree") return "owned.txt\0";
        return "";
      });
      for (const kind of plan.shipping) {
        const { runId } = await tool("request_task_action", { expected: expected(), kind, brief: "Approved local fake shipping route" });
        await tool("verify_task_evidence", { expected: expected(), runId });
      }
    }
  };
  const finish = (args: any = {}) => call("finish_fixed_task", { expected: expected(), reason: "Reviewed work is finished", ...args });
  const disk = () => ({ task: readFileSync(join(data, "tasks", `${tabId}.json`), "utf8"), journal: readFileSync(join(data, "executions", `${tabId}.json`), "utf8") });
  const install = (value: any) => { controls.install(value); server.fixedTasks = value; };
  const restart = () => install(createTaskStore(data, (id) => server.tabLocation(id).tab.folder));
  const writeTask = (value: any) => { writeFileSync(join(data, "tasks", `${tabId}.json`), JSON.stringify(value, null, 2) + "\n"); restart(); };
  const setJournal = (value: any) => saveJournal(data, tabId, value);
  return { server, controls, tabId, data, root, folder, ws, task, expected, specs, call, tool, journal, worker, ready, finish, disk, install, restart, writeTask, setJournal, approve, plan };
}
export type Run4Fixture = Awaited<ReturnType<typeof run4Fixture>>;
