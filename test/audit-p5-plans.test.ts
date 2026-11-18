import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixed-crew-task-plan.test.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { digest } from "../server/fixed-crew/task-revision.ts";
import { validateTask, type Plan, type Task } from "../server/fixed-crew/task-types.ts";
import { saveJournal, type FixedExecution } from "../server/fixed-crew/task-execution.ts";
import { readTaskArchive, listTaskArchives } from "../server/fixed-crew/task-archive-files.ts";
import { assertTaskGate, selectedRole } from "../server/fixed-crew/task-gates.ts";

// All imports with data-root side effects and every fixture live below our own nested root.
const root = mkdtempSync(join(tmpdir(), "cc-p5-plans-"));
const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, CC_DATA_DIR: process.env.CC_DATA_DIR, CC_TEST_FORCE_PACKAGED: process.env.CC_TEST_FORCE_PACKAGED };
process.env.TEMP = root; process.env.TMP = root;
process.env.CC_DATA_DIR = join(root, "imports"); process.env.CC_TEST_FORCE_PACKAGED = "1";
mkdirSync(process.env.CC_DATA_DIR);
const state = await import("../server/main/state.ts");
const { defaultWorkspaces } = await import("../server/config.ts");
const { fixedLeaderSpecs } = await import("../server/main/fixed-task-tools.ts");
const { runLeaderTool, leaderToolJsonSchema } = await import("../server/leader-tools.ts");
const { SettingsService } = await import("../server/settings.ts");
const { ChatStore } = await import("../server/chat-store.ts");
const { RequestsStore } = await import("../server/requests.ts");
const { readLaunchSafety } = await import("../server/config-prefs.ts");
after(() => {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const remove = (folder: string) => {
    assert.equal(lstatSync(folder).isSymbolicLink(), false);
    for (const name of readdirSync(folder)) {
      const file = join(folder, name), info = lstatSync(file);
      assert.equal(info.isSymbolicLink(), false);
      if (info.isDirectory()) remove(file); else unlinkSync(file);
    }
    assert.deepEqual(readdirSync(folder), []); rmdirSync(folder);
  };
  remove(root);
});
const refusal = "Publishing is not supported here; ship with commit and push only.";
type Fixture = ReturnType<typeof fixture>;
function tools(f: Fixture, store = f.store) {
  const tab = defaultWorkspaces(f.project).projects[0].tabs[0]; tab.id = "tab1";
  for (const [slot, assignment] of Object.entries(f.seats)) tab.fixedCrew!.preferences[slot as keyof typeof tab.fixedCrew.preferences] = { assignment, source: "user" };
  state.setWorkspaces({ projects: [{ id: "p", name: "Project", folder: f.project, tabs: [tab] }] });
  state.setDataRoot(f.root); state.setFixedTasks(store);
  state.setLaunchSafety(readLaunchSafety(join(f.root, "launch-safety.json")));
  state.setBlockedSeatKeys(new Set()); state.setUnconfirmedRunIds(new Set());
  state.setSettingsService(new SettingsService({ dataRoot: f.root, runCli: async () => { throw new Error("No vendor command is allowed in plan tests"); } }));
  state.setChatStore(new ChatStore(join(f.root, "chats"))); state.setRequestsStore(new RequestsStore(f.root));
  const instance = {}; state.leaderInstances.set("tab1", instance);
  state.leaders.set("tab1", { isDead: () => false } as any);
  return fixedLeaderSpecs("tab1", instance);
}
async function offerPlan(f: Fixture, plan: Plan, store = f.store) {
  const specs = tools(f, store), task = store.get("tab1"), runId = randomUUID();
  const logPath = join(f.root, `${runId}.log`);
  writeFileSync(logPath, `CC_REPORT_BEGIN\n${JSON.stringify({ version: 1, runId, taskId: task?.id ?? null, planVersion: task?.planVersion ?? 0,
    evidence: [], plan, findings: [], resolved: [], baseFinal: null, unchanged: [], decisions: [] })}\nCC_REPORT_END\n`);
  saveJournal(f.root, "tab1", { version: 1, activeExecutionId: null, executions: [{ id: runId, tabId: "tab1", taskId: task?.id ?? null,
    planVersion: task?.planVersion ?? 0, role: "planner", selectedSlot: "planner", selectionReason: "Assigned Planner", assignment: f.seats.planner,
    kind: "planning", status: "done", processEnded: true, consumed: false, logPath }] });
  state.runRecords.set(runId, { tabId: "tab1", seatKey: "tab1.planner", status: "done", logPath } as any);
  try {
    return await runLeaderTool(specs, "accept_planner_report", { expected: task ? { taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision } : null, runId });
  } finally { state.runRecords.delete(runId); }
}

test("P5 new publish plans are refused through the real Planner acceptance tool", async (t) => {
  const f = fixture(t, { shipping: [] }), empty = createTaskStore(join(f.root, "empty"), () => f.project);
  // Keep journal and task roots identical, as the real app does.
  const oldRoot = f.root; f.root = join(oldRoot, "empty"); mkdirSync(f.root);
  const result = await offerPlan(f, { ...f.plan, shipping: ["publish"] }, empty);
  assert.equal(result.isError, true, result.text); assert.ok(result.text.includes(refusal), result.text);
  assert.equal(empty.get("tab1"), null);
});

test("P5 new and revised plan admission reject publish without changing the saved task", async (t) => {
  const f = fixture(t, { shipping: [] }), plan = { ...f.plan, shipping: ["publish"] } as Plan;
  assert.throws(() => f.store.create("other", plan, f.seats, f.actors.planner), { message: refusal });
  const bytes = readFileSync(join(f.root, "tasks/tab1.json"));
  const result = await offerPlan(f, plan);
  assert.equal(result.isError, true, result.text); assert.ok(result.text.includes(refusal), result.text);
  assert.deepEqual(readFileSync(join(f.root, "tasks/tab1.json")), bytes);
});

function saveLegacy(f: Fixture, task: Task) {
  task.plan.shipping = ["publish"]; task.planDigest = digest({ plan: task.plan, seats: task.seats });
  if (task.ownerScopeApproval) task.ownerScopeApproval.digest = task.planDigest;
  for (const run of task.executions) delete run.executionCapability;
  writeFileSync(join(f.root, "tasks/tab1.json"), JSON.stringify(task));
  return createTaskStore(f.root, () => f.project);
}
test("P5 saved publish task stays readable and re-plans in app without publish", async (t) => {
  const f = fixture(t, { shipping: [] }); f.approve(); f.run("check", { checkName: "unit" });
  const store = saveLegacy(f, f.get());
  assert.doesNotThrow(() => store.get("tab1"), "legacy publish and missing capability must still load");
  assert.deepEqual(store.get("tab1")!.plan.shipping, ["publish"]);
  assert.equal(store.get("tab1")!.executions[0].executionCapability, undefined);
  const result = await offerPlan(f, { ...f.plan, shipping: ["commit", "push"] }, store);
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(store.get("tab1")!.plan.shipping, ["commit", "push"]);
  assert.equal(store.get("tab1")!.ownerScopeApproval, null);
  assert.equal(store.get("tab1")!.planVersion, 2);
});

test("P5 historical publish tasks remain archivable listable and readable", (t) => {
  const f = fixture(t, { shipping: [] }); f.approve(); f.run("build"); f.run("check", { checkName: "unit" }); f.run("review");
  const legacy = f.get();
  // Historical input only. No publish action or external command is executed.
  legacy.executions.push({ ...legacy.executions[0], id: "old-publish", sessionId: "old-publisher", kind: "publish", role: "leader" });
  const store = saveLegacy(f, legacy), loaded = store.get("tab1")!;
  const entry = (id: string, role: FixedExecution["role"], kind: FixedExecution["kind"], version = 1): FixedExecution => ({
    id, tabId: "tab1", taskId: loaded.id, planVersion: version, role, selectedSlot: role, assignment: f.seats[role], selectionReason: "Historical assigned position",
    kind, status: "done", processEnded: true, consumed: true, logPath: null });
  const journal = { version: 1 as const, activeExecutionId: null, executions: [entry("planner-session", "planner", "planning"),
    ...loaded.executions.map((run) => entry(run.id, run.role, run.kind))] };
  saveJournal(f.root, "tab1", journal);
  store.finish({ tabId: "tab1", taskId: loaded.id, planVersion: 1, recordRevision: loaded.recordRevision }, "Historical completed work", store.actor("leader"), journal);
  assert.equal(store.get("tab1"), null);
  const listed = listTaskArchives(f.root, "tab1", "task", null, 50);
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].id, loaded.id);
  assert.deepEqual(readTaskArchive(f.root, "tab1", loaded.id).task.plan.shipping, ["publish"]);
});

test("P5 gate stamps command capability only on approved check and visualCheck reservations", (t) => {
  const f = fixture(t, { shipping: [], visibleWork: true });
  assert.throws(() => f.action("check"), /Approve/); assert.deepEqual(f.get().executions, []);
  f.approve(); f.run("rough");
  const visual = f.run("visualCheck");
  const visualRun = f.get().executions.find((run) => run.id === visual)!;
  assert.equal(visualRun.role, "leader"); assert.equal(visualRun.executionCapability, "run-commands");
  function assertNoCapability(kind: "review" | "inspect") {
    const task = f.get(), action = { kind, route: "normal" as const, change: "none" as const };
    const execution = { ...task.executions.at(-1)!, id: `direct-${kind}`, sessionId: `direct-${kind}`, kind, role: selectedRole(task, action) };
    assertTaskGate(task, action, execution);
    assert.equal(execution.executionCapability, undefined, `${kind} must never receive command capability at the gate itself`);
  }
  assertNoCapability("inspect");
  f.run("inspect"); f.apply({ type: "approveRough", roughRevision: f.get().roughRevision! }, f.actors.owner);
  f.run("polish"); f.run("check", { checkName: "unit" });
  assertNoCapability("review"); f.run("review");
  const runs = f.get().executions;
  assert.deepEqual(runs.filter((run) => run.executionCapability !== undefined).map((run) => run.kind), ["visualCheck", "check"]);
  assert.equal(runs.find((run) => run.kind === "check")!.executionCapability, "run-commands");
  assert.doesNotThrow(() => validateTask(f.get()));

});

test("P5 caller cannot forge command capability or save it on reviewers and inspectors", (t) => {
  const f = fixture(t, { shipping: [] }); f.approve(); f.run("build"); f.run("check", { checkName: "unit" }); f.run("review");
  assert.equal(f.get().executions.find((run) => run.kind === "check")!.executionCapability, "run-commands");
  for (const kind of ["review", "inspect", "assist"] as const) {
    assert.throws(() => f.apply({ type: "action", action: { kind, route: "normal", change: "none", executionCapability: "run-commands" } as any, sessionId: "forged", batch: [] }), /keys/);
    const task = f.get(), run = task.executions.at(-1)!;
    run.kind = kind; run.executionCapability = "run-commands";
    assert.throws(() => validateTask(task), /capability/i);
  }
  const task = f.get(), check = task.executions.find((run) => run.kind === "check")!;
  check.executionCapability = "run-commands"; check.role = "reviewer1";
  assert.throws(() => validateTask(task), /capability/i);
  check.role = "leader"; (check as any).executionCapability = "all";
  assert.throws(() => validateTask(task), /capability|enum/i);
});

test("P5 tool schema and docs offer commit and push only and describe honest check permissions and logs", (t) => {
  const f = fixture(t, { shipping: [] }), specs = tools(f);
  const action = specs.find((spec) => spec.name === "request_task_action")!;
  const schema = leaderToolJsonSchema(action) as any;
  assert.ok(schema.properties.kind.enum.includes("push")); assert.ok(schema.properties.kind.enum.includes("commit"));
  assert.equal(schema.properties.kind.enum.includes("publish"), false);
  assert.equal(Object.hasOwn(schema.properties, "executionCapability"), false);
  for (const file of ["PROTOCOL.md", "README.md"]) {
    const doc = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(doc.includes(refusal), `${file} must explain unsupported publishing`);
    assert.match(doc, /re-plan/i); assert.match(doc, /command-running worker can write files/i);
  }
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /incrementally.*redact|redact.*incrementally/i); assert.match(readme, /final.*tail.*exit marker/i);
  assert.equal(readme.includes("Logs are flushed once when the process closes."), false);
  assert.equal(readme.includes("Commit, push and publish are part of the plan"), false);
  const protocol = readFileSync(new URL("../PROTOCOL.md", import.meta.url), "utf8");
  assert.match(protocol, /Headless check workers use action-level approval; per-command approval does not apply/);
});
