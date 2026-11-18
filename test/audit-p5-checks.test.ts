import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLeaderTool } from "../server/leader-tools.ts";
import { assertTaskGate } from "../server/fixed-crew/task-gates.ts";

const root = mkdtempSync(join(tmpdir(), "cc-p5-checks-"));
const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP };
process.env.TEMP = root; process.env.TMP = root;
const { loadFixed, fixtureWorkspaces, endRun, source, connect } = await import("./round2-helpers.ts");
const { loadRunnerHarness, isolatedRun, isolatedRunnerProc } = await import("./round2-runner-fixture.ts");
const { config } = await import("./round2-setup.ts");
const { opencodeConfig } = await import("../server/runner-crew.ts");
after(() => {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  function remove(folder: string) {
    assert.equal(lstatSync(folder).isSymbolicLink(), false);
    for (const name of readdirSync(folder)) {
      const file = join(folder, name), info = lstatSync(file);
      assert.equal(info.isSymbolicLink(), false);
      if (info.isDirectory()) remove(file); else unlinkSync(file);
    }
    assert.deepEqual(readdirSync(folder), []); rmdirSync(folder);
  }
  remove(root);
});

const noShipping = "Do not run git commit or git push: shipping happens only through the app's own commit and push actions.";
const honesty = /can run commands and may write files/i;
for (const cli of ["claude", "codex", "opencode"] as const) test(`P5 ${cli} command-capable checks preserve ordinary read-only launches`, () => {
  for (const capability of [undefined, "run-commands"] as const) {
    config.applyOpenCodeModels([{ value: "provider/check", providerID: "provider", modelID: "check", displayName: "Check", variants: [] }], { fallback: true });
    const harness = loadRunnerHarness({ testRoot: mkdtempSync(join(root, "runner-")) });
    const run = isolatedRun({ cli, slotId: "leader", model: cli === "claude" ? "claude-sonnet-5-5[1m]" : cli === "codex" ? "gpt-6.1-sol" : "provider/check",
      effort: cli === "opencode" ? "" : "medium", executionCapability: capability });
    const proc = isolatedRunnerProc(0), calls: any[] = [];
    const started = harness.runSeat(run, "Run approved checks", { onOutput() {}, onStatus() {} }, (command: string, options: any) => { calls.push({ command, options }); return proc; });
    assert.equal(started.ok, true);
    proc.emit("close", 0);
    assert.equal(harness.isRunning(run.runId), false);
    const { command, options } = calls[0];
    if (cli === "claude") {
      assert.match(command, capability ? /--permission-mode default/ : /--permission-mode plan --permission-prompts none/);
      assert.match(command, capability ? /--allowedTools Bash,PowerShell/ : /--disallowedTools Bash,PowerShell,Edit/);
      assert.doesNotMatch(command, /bypassPermissions|dangerously-skip/);
    } else if (cli === "codex") {
      assert.match(command, capability ? /--sandbox workspace-write/ : /--sandbox read-only/);
      assert.doesNotMatch(command, /bypass|dangerously/);
    } else {
      const permissions = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).permission;
      assert.equal(permissions.bash, capability ? "allow" : "deny");
      assert.equal(permissions.edit, "deny");
    }
    const brief = readFileSync(options.env.CC_BRIEF_PATH, "utf8");
    const report = readFileSync(join(harness.logsDir, `${run.seatKey}-${started.timestamp}.log`), "utf8");
    if (capability) { assert.match(brief, honesty); assert.match(report, honesty); assert.ok(brief.includes(noShipping)); assert.ok(report.includes(noShipping)); }
    else { assert.doesNotMatch(brief, honesty); assert.doesNotMatch(report, honesty); }
  }
});

async function fixture(serverSource = source, cli = "claude") {
  const testRoot = mkdtempSync(join(root, "launch-")), folder = join(testRoot, "project"); mkdirSync(folder); writeFileSync(join(folder, "a.txt"), "one");
  const workspaces = fixtureWorkspaces("fixed"), tab = workspaces.projects[0].tabs[0]; tab.folder = folder;
  const f = await loadFixed({ testRoot, workspaces, serverSource, skipHealth: true, console: { ...console, log() {} } });
  f.settingsService.state.permissionModes[tab.id] = "bypass";
  f.createTabLeader(tab.id);
  const assignment = cli === "codex" ? { cli, model: "gpt-6.1-sol", effort: "low" }
    : cli === "opencode" ? { cli, model: "provider/check", effort: "" }
    : cli.startsWith("acp:") ? { cli, model: "default", effort: "default" } : tab.fixedCrew!.preferences.leader.assignment;
  tab.fixedCrew!.preferences.leader.assignment = assignment as any;
  f.tabLocation(tab.id).tab.fixedCrew.preferences.leader.assignment = assignment;
  f.settingsService.state.catalogTools.opencode.installed = true;
  const store = f.fixedTasks;
  const seats = Object.fromEntries(Object.entries(tab.fixedCrew!.preferences).map(([slot, preference]: any) => [slot, preference.assignment]));
  store.create(tab.id, { id: "plan", scope: "Check file", criteria: ["Works"], blocks: [{ id: "one", scope: "File", paths: ["a.txt"] }],
    risk: { level: "small", reason: "Contained", paths: ["a.txt"], verification: ["unit"] }, visibleWork: false, large: false,
    integration: false, design: false, paths: ["a.txt"], consumers: [], sharedInputs: [], checks: ["unit"], shipping: [], reviewReason: "Independent" }, seats, store.actor("planner"));
  let sequence = 0;
  const get = () => store.get(tab.id)!;
  const expected = () => { const task = get(); return { taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision }; };
  const apply = (event: any, actor = store.actor("leader")) => { const task = get(); return store.apply({ tabId: tab.id, taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision, requestId: `request-${++sequence}` }, event, actor); };
  apply({ type: "approvePlan" }, store.actor("owner"));
  const action = (kind: string) => ({ kind, route: "normal", change: "none" });
  const complete = (kind: string) => {
    const id = apply({ type: "action", action: action(kind), sessionId: `worker-${++sequence}`, batch: [] }).executionId;
    apply({ type: "start", executionId: id });
    const run = get().executions.find((e: any) => e.id === id)!;
    apply({ type: "result", executionId: id, taskId: get().id, planVersion: get().planVersion, role: run.role, success: true, processEnd: "confirmed", evidence: ["a.txt"] }, store.actor(run.role, run.sessionId));
    apply({ type: "verify", executionId: id, checkName: kind === "check" ? "unit" : null, findings: [], resolved: [], baseFinal: null, unchanged: [] });
  };
  const close = async () => { for (const entry of f.launched) if (f.active.has(entry.run.runId)) await endRun(f, entry.run.runId); f.stopLeaderSession(tab.id); };
  return { f, tab, get, expected, action, complete, close };
}

test("P5 real launch binds admitted check capability and records honest brief and report", async () => {
  const x = await fixture();
  try {
    const result = await x.f.launchFixedAction(x.f.currentActor(x.tab.id), x.expected(), x.action("check"), "Run unit checks");
    const launched = x.f.launched[0];
    assert.equal(launched.run.executionCapability, "run-commands");
    assert.equal(launched.run.canWrite, false, "the roster itself remains unchanged");
    assert.match(launched.prompt, honesty);
    assert.ok(launched.prompt.includes(noShipping));
    assert.doesNotMatch(launched.prompt, /You are read-only\. Do not edit project files\./);
    await endRun(x.f, result.runId);
    const saved = x.f.executionJournal(x.f.testRoot, x.tab.id).executions[0];
    assert.match(readFileSync(saved.logPath, "utf8"), honesty);
  } finally { await x.close(); }
  for (const kind of ["inspect", "review"]) await observeReadOnly(kind);
});

for (const cli of ["claude", "codex", "opencode", "acp:custom"]) test(`P5 ${cli} check capability matches executable support`, async () => {
  const x = await fixture(source, cli);
  try {
    if (cli.startsWith("acp:")) {
      await assert.rejects(x.f.launchFixedAction(x.f.currentActor(x.tab.id), x.expected(), x.action("check"), "Run checks"), (error: Error) => {
        assert.ok(error.message.includes(`Leader position in ${x.tab.name} cannot run checks`), error.message);
        assert.match(error.message, /Choose a Claude, OpenCode or Codex position for checks/);
        assert.doesNotMatch(error.message, /acp:|alpha-dev|can run commands/); return true;
      });
      assert.equal(x.f.launched.length, 0);
      assert.equal(x.get().executions.length, 0, "ACP refusal must happen before reservation or connection preparation");
      const directGate: any = { role: "leader", kind: "check" };
      assertTaskGate(x.get(), x.action("check"), directGate);
      assert.equal(directGate.executionCapability, undefined, "the gate itself withholds ACP command access");
      const { execution, context } = x.f.reserveFixedExecution(x.f.currentActor(x.tab.id), x.action("check"));
      assert.equal(x.get().executions.find((e: any) => e.id === execution.id).executionCapability, undefined);
      const direct = x.f.launchWorker(x.tab.id, "leader", "Run checks", "leader", undefined, undefined, context);
      assert.equal(direct.ok, false); assert.match(direct.error, /cannot run checks/);
      assert.equal(x.f.launched.length, 0);
    } else {
      await x.f.launchFixedAction(x.f.currentActor(x.tab.id), x.expected(), x.action("check"), "Run checks");
      assert.equal(x.f.launched[0].run.executionCapability, "run-commands");
      assert.match(x.f.launched[0].prompt, honesty);
    }
  } finally { await x.close(); }
});

for (const mode of ["ask", "accept", "bypass"]) for (const kind of ["check", "visualCheck"]) test(`P5 ${mode} ${kind} approval discloses command access and only the folder name`, async () => {
  const x = await fixture();
  try {
    if (kind === "visualCheck") x.complete("rough");
    const ws = connect(x.f); x.f.settingsService.state.permissionModes[x.tab.id] = mode;
    const pending = runLeaderTool(x.f.fixedLeaderSpecs(x.tab.id, x.f.leaderInstances.get(x.tab.id)), "request_task_action", { expected: x.expected(), kind, brief: "Run approved checks" });
    const approval = [...x.f.pendingApprovals.values()][0] as any;
    if (mode === "bypass") {
      assert.equal(approval, undefined); assert.equal((await pending).isError, false); assert.equal(x.f.launched.length, 1); return;
    }
    assert.ok(approval, "the check action must wait for approval");
    assert.ok(approval.summary.includes("This position will run commands and may write files in project."), approval.summary);
    assert.equal(approval.summary.includes(x.tab.folder), false);
    assert.equal(approval.summary.includes(x.tab.id), false);
    assert.equal(x.f.launched.length, 0);
    ws.message({ type: "answerApproval", tabId: x.tab.id, requestId: "allow-check", approvalId: approval.approvalId, allow: true });
    assert.equal((await pending).isError, false); assert.equal(x.f.launched.length, 1);
  } finally { await x.close(); }
});

test("P5 runner refuses ACP command capability and never writes a dishonest brief", () => {
  const harness = loadRunnerHarness({ testRoot: mkdtempSync(join(root, "acp-")) });
  const run = isolatedRun({ cli: "acp:custom", model: "default", effort: "default", name: "Leader", executionCapability: "run-commands" });
  assert.throws(() => harness.buildCommand(run, "brief"), /No start command.*Leader position/);
  let spawns = 0;
  const result = harness.runSeat(run, "Check", { onOutput() {}, onStatus() {} }, () => { spawns++; throw new Error("No vendor process allowed"); });
  assert.equal(result.ok, false); assert.match(result.error, /Leader position cannot run checks/);
  assert.doesNotMatch(result.error, /acp:|alpha-dev|can run commands/);
  assert.equal(spawns, 0); assert.deepEqual(readdirSync(harness.logsDir), []);
  const missing = harness.runSeat({ ...run, executionCapability: undefined }, "Read", { onOutput() {}, onStatus() {} });
  assert.equal(missing.ok, false); assert.match(missing.error, /No start command.*Leader position/);
  assert.doesNotMatch(missing.error, /acp:|alpha-dev/);
});

async function observeMismatch(mismatch: string, serverSource = source) {
  const x = await fixture(serverSource);
  try {
    const { execution, context } = x.f.reserveFixedExecution(x.f.currentActor(x.tab.id), x.action("check"));
    const original = x.f.fixedTasks.get.bind(x.f.fixedTasks);
    x.f.fixedTasks.get = (tabId: string) => {
      const task = original(tabId);
      const journal = x.f.executionJournal(x.f.testRoot, tabId);
      if (journal.executions.find((e: any) => e.id === execution.id)?.status === "running") {
        const run = task.executions.find((e: any) => e.id === execution.id);
        if (["missing", "context-capability"].includes(mismatch)) delete run.executionCapability;
        else if (mismatch !== "forged-context") run[mismatch] = mismatch === "planVersion" ? 999 : "forged";
      }
      return task;
    };
    if (mismatch === "context-capability") context.executionCapability = "run-commands";
    const result = x.f.launchWorker(x.tab.id, "leader", "Run checks", "leader", undefined, undefined,
      mismatch === "forged-context" ? { ...context, executionCapability: "run-commands" } : context);
    if (mismatch === "forged-context") { assert.equal(result.ok, false); assert.equal(x.f.launched.length, 0); }
    else { assert.equal(result.ok, true); assert.equal(x.f.launched[0].run.executionCapability, undefined); }
  } finally { await x.close(); }
}
test("P5 execution binding mutations fail by assertion through the real launch path", async () => {
  for (const mismatch of ["missing", "taskId", "planVersion", "kind", "role", "forged-context", "context-capability"])
    await observeMismatch(mismatch);
  const mutations = [
    ["missing", ' && reservation.executionCapability === "run-commands"'],
    ["taskId", " && reservation.taskId === selected.taskId"],
    ["planVersion", " && reservation.planVersion === selected.planVersion"],
    ["kind", " && reservation.kind === selected.kind"],
    ["role", " && reservation.role === selected.role"],
  ];
  for (const [mismatch, anchor] of mutations) {
    assert.equal(source.split(anchor).length - 1, 1, `mutation target found: ${anchor}`);
    await observeMismatch(mismatch);
    await assert.rejects(observeMismatch(mismatch, source.replace(anchor, "")), (error: any) => {
      assert.equal(error.code, "ERR_ASSERTION");
      console.log(`INTENDED ASSERTION RED: ${mismatch} binding removed: ${error.message.split("\n")[0]}`);
      return true;
    });
    await observeMismatch(mismatch);
  }
});

test("P5 visualCheck receives command capability through the admitted launch", async () => {
  const x = await fixture();
  try {
    x.complete("rough");
    await x.f.launchFixedAction(x.f.currentActor(x.tab.id), x.expected(), x.action("visualCheck"), "Check the rough");
    assert.equal(x.f.launched[0].run.executionCapability, "run-commands");
    assert.match(x.f.launched[0].prompt, honesty);
  } finally { await x.close(); }
});

async function observeReadOnly(kind: string) {
  const x = await fixture();
  try {
    x.complete("build"); x.complete("check");
    if (kind === "inspect") { x.complete("rough"); x.complete("visualCheck"); }
    const result = await x.f.launchFixedAction(x.f.currentActor(x.tab.id), x.expected(), x.action(kind), "Inspect evidence");
    assert.ok(result.runId);
    const run = x.f.launched[0].run;
    assert.equal(run.executionCapability, undefined);
    assert.match(loadRunnerHarness({ testRoot: mkdtempSync(join(root, "denied-")) }).buildCommand({ ...run, cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium" }, "brief"), /--disallowedTools Bash,PowerShell,Edit/);
    assert.equal(JSON.parse(opencodeConfig(run)!).permission.bash, "deny");
  } finally { await x.close(); }
}

for (const reason of ["uncertain", "unconfirmed", "blocked", "legacy-uncertain", "legacy-blocked"]) test(`P5 ${reason} refusal names position and recovery without internal keys`, async () => {
  const x = await fixture();
  try {
    const key = `${x.tab.id}.helper`, legacy = "retired-private-seat";
    if (reason === "uncertain") x.f.launchSafety.uncertain.push({ seatId: key, pid: 123 });
    if (reason === "unconfirmed") x.f.unconfirmedRunIds.add(key);
    if (reason === "blocked") x.f.blockedSeatKeys.add(key);
    if (reason === "legacy-uncertain") x.f.launchSafety.uncertain.push({ seatId: legacy, pid: 123 });
    if (reason === "legacy-blocked") x.f.blockedSeatKeys.add(legacy);
    const result = await x.f.launchFixedAction(x.f.currentActor(x.tab.id), x.expected(), x.action("assist"), "Read", "helper").then(() => "unexpected launch", (e: Error) => e.message);
    assert.match(result, /cannot start/i);
    assert.match(result, reason.startsWith("legacy") ? /an earlier position/ : /Helper position/);
    assert.ok(result.includes(x.tab.name), result);
    assert.match(result, /Needs you/);
    assert.match(result, reason.includes("blocked") ? /Allow again/ : /Try to stop again.*Release/);
    for (const internal of [key, legacy, x.tab.id]) assert.equal(result.includes(internal), false, result);
    assert.equal(x.f.launched.length, 0);
  } finally { await x.close(); }
});
