import test from "node:test";
import assert from "node:assert/strict";
import { fixedServer, modules, fixedTab, dataDir, assignment } from "./fixed-crew-execution-helpers.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { fixedLeaderSpecs } from "../server/main/fixed-task-tools.ts";
import { runLeaderTool } from "../server/leader-tools.ts";
import { assertFixedTaskAction } from "../server/main/fixed-task-actions.ts";
import { plan } from "./fixed-crew-execution-helpers.ts";
import { scratchDir, setEnv } from "./temp-root.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("FCXT old leader instance has no authority even for status and cannot choose its own actor", async () => {
  const tab = fixedTab(dataDir), instance = {};
  modules.state.setWorkspaces({ projects: [{ id: "p", name: "P", folder: dataDir, tabs: [tab] }] });
  modules.state.setFixedTasks(createTaskStore(scratchDir(), () => dataDir));
  modules.state.setDataRoot(scratchDir());
  modules.state.leaderInstances.set("fixed", instance);
  modules.state.leaders.set("fixed", { isDead: () => false } as any);
  const specs = fixedLeaderSpecs("fixed", instance);
  assert.equal((await runLeaderTool(specs, "get_fixed_task", {})).isError, false);
  modules.state.leaderInstances.set("fixed", {});
  const stale = await runLeaderTool(specs, "get_fixed_task", { actor: { role: "leader" } });
  assert.equal(stale.isError, true, "stale instance cannot read or launch through its old tools");
  assert.match(stale.text, /Only the current leader/);
});

test("FCXT action boundary checks exact reviewed revision and approved shipping scope", async (t) => {
  t.after(setEnv({ CC_TEST_FAKE_CLI: "1" }));
  const tab = fixedTab(dataDir), instance = {};
  modules.state.setWorkspaces({ projects: [{ id: "p", name: "P", folder: dataDir, tabs: [tab] }] });
  modules.state.setFixedTasks(createTaskStore(scratchDir(), () => dataDir));
  modules.state.setDataRoot(scratchDir());
  modules.state.setSettingsService({ permissionMode: () => "bypass" } as any);
  modules.state.leaderInstances.set("fixed", instance); modules.state.leaders.set("fixed", { isDead: () => false, getPermissionMode: () => "bypass" } as any);
  const task = modules.state.fixedTasks.create("fixed", plan() as any, { leader: assignment }, modules.state.fixedTasks.actor("planner"));
  const actor = { tabId: "fixed", instance, sessionId: "server-leader" };
  assert.throws(() => assertFixedTaskAction(task, { kind: "push", route: "normal", change: "none" }, actor, task.revision.digest), /Approve this plan/);
  const { executeFixedGit } = await import("../server/main/fixed-task-actions.ts");
  let commands = 0;
  await assert.rejects(() => executeFixedGit(actor, task, { kind: "commit", route: "normal", change: "none" }, () => { commands++; return ""; }), /Approve this plan/);
  assert.equal(commands, 0, "shipping boundary never executes an unapproved command");
  modules.state.fixedTasks.apply({ tabId: "fixed", taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision, requestId: "approve-foreign-control" },
    { type: "approvePlan" }, modules.state.fixedTasks.actor("owner"));
  const approved = modules.state.fixedTasks.get("fixed")!;
  await assert.rejects(() => executeFixedGit(actor, { ...approved, tabId: "foreign" }, { kind: "checkpoint", route: "normal", change: "none" }, () => { commands++; return ""; }), (error: Error) => {
    assert.equal(commands, 0, "foreign task identity must be refused before ANY Git command");
    assert.match(error.message, /reviewed content changed/); return true;
  });
  assert.equal(commands, 0, "the action call site rejects another task before any Git command");
});

test("FCXT real tool route requires Planner report and owner approval before a writer, then checks and fresh review", { timeout: 120_000 }, async () => {
  const f = await fixedServer();
  try {
    const t = await f.planning();
    assert.equal(t.planVersion, 1);
    assert.equal((await f.action("build")).ok, false, "no build before owner approval");
    await f.approve(); f.worker({ write: "after!" });
    const built = await f.action("build"); assert.equal(built.ok, true, built.text);
    await f.ended(built.value.runId);
    assert.equal((await f.verify(built.value.runId)).ok, true);
    assert.equal((await f.action("review")).ok, false, "checks gate sits on the tool route");
    f.worker({}); const check = await f.action("check"); assert.equal(check.ok, true, check.text);
    await f.ended(check.value.runId); assert.equal((await f.verify(check.value.runId, "focused")).ok, true);
    const review = await f.action("review"); assert.equal(review.ok, true, review.text);
    assert.notEqual(review.value.runId, built.value.runId, "one-model reviews still have fresh execution identity");
    assert.match(review.value.reason, /same model|same company/i);
    await f.ended(review.value.runId); const verified = await f.verify(review.value.runId);
    assert.equal(verified.ok, true, verified.text); assert.equal(verified.value.reviews.length, 1);
    assert.equal((await f.action("push")).ok, false, "push is outside the approved scope");
    assert.equal((await f.tool("launch_seat", { slot: "coder", brief: "bypass" })).ok, false, "fixed leader has no legacy launch tool");
  } finally { await f.close(); }
});

test("FCXT high-risk lifecycle triages a report, requires final, and consumes checkpoint and shipping button reservations once", { timeout: 120_000 }, async () => {
  const f = await fixedServer({ high: true, git: true, shipping: ["commit", "push"], assignments: { reviewer2: { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium" } } });
  try {
    const button = async (action: string) => {
      const requestId = `button-${action}`, before = f.c.messages.length;
      f.c.send({ type: "requestFixedTaskAction", tabId: "fixed", requestId, ...f.expected(), action });
      const reply = await f.c.wait(() => f.c.messages.slice(before).find((m) => m.requestId === requestId), "button reservation");
      assert.equal(reply.type, "fixedTaskResult", JSON.stringify(reply)); assert.equal(reply.executionAvailable, true);
      await f.c.wait(() => f.c.messages.slice(before).find((m) => m.type === "chatDone"), "leader receives reservation");
      return reply.executionId;
    };
    await f.planning(); await f.approve(); f.worker({ write: "after!" });
    const buildId = await button("build");
    const starts = f.c.tab("fixed").runs.length;
    assert.equal(f.task().executions.filter((e: any) => e.kind === "build").length, 1);
    const build = await f.action("build", { reservedExecutionId: buildId }); assert.equal(build.ok, true, build.text);
    assert.equal(build.value.runId, buildId); await f.ended(build.value.runId);
    assert.equal(f.c.tab("fixed").runs.length, starts + 1, "one reserved button request starts exactly one worker");
    assert.equal((await f.verify(build.value.runId)).ok, true);
    f.worker({}); const check = await f.action("check"); assert.equal(check.ok, true, check.text); await f.ended(check.value.runId);
    assert.equal((await f.verify(check.value.runId, "focused")).ok, true);
    f.worker({ finding: true }); const review = await f.action("review"); assert.equal(review.ok, true, review.text);
    assert.equal(review.value.selectedSlot, "reviewer2", "select the eligible assigned different-company reviewer");
    assert.equal(f.task().seats.reviewer1.cli, "codex", "selection never rewrites preferences or task snapshots");
    await f.ended(review.value.runId); assert.equal((await f.verify(review.value.runId)).ok, true);
    assert.match((await f.action("commit")).text, /triage every finding/);
    f.worker({ report: { decisions: [{ findingId: "finding", outcome: "PASS", reason: "Harmless wording" }] } });
    const triage = await f.tool("begin_planning", { expected: f.expected(), brief: "Triage the finding", triage: true });
    assert.equal(triage.ok, true, triage.text); await f.ended(triage.value.runId);
    const accepted = await f.tool("accept_planner_report", { expected: f.expected(), runId: triage.value.runId });
    assert.equal(accepted.ok, true, accepted.text); assert.deepEqual(f.task().triage.finding, { outcome: "PASS", reason: "Harmless wording" });
    assert.match((await f.action("commit")).text, /final review/);
    const checkpointId = await button("checkpoint");
    const checkpoint = await f.action("checkpoint", { reservedExecutionId: checkpointId });
    assert.equal(checkpoint.ok, true, checkpoint.text); assert.equal(checkpoint.value.runId, checkpointId);
    assert.equal((await f.verify(checkpointId)).ok, true); assert.equal(f.task().checkpoints.length, 1);
    f.worker({}); const final = await f.action("final"); assert.equal(final.ok, true, final.text); await f.ended(final.value.runId);
    assert.equal((await f.verify(final.value.runId)).ok, true);
    const commitId = await button("commit");
    const commit = await f.action("commit", { reservedExecutionId: commitId });
    assert.equal(commit.ok, true, commit.text); assert.equal(commit.value.runId, commitId);
    assert.equal((await f.verify(commitId)).ok, true);
    assert.equal((await f.action("commit", { reservedExecutionId: commitId })).ok, false, "a consumed reservation cannot repeat Git");
    writeFileSync(join(f.server.temp, "git-options.json"), JSON.stringify({ clean: true }));
    const pushId = await button("push");
    const pushed = await f.action("push", { reservedExecutionId: pushId });
    assert.equal(pushed.ok, true, pushed.text); assert.equal(pushed.value.runId, pushId);
    assert.equal((await f.verify(pushId)).ok, true);
    assert.equal((await f.action("push", { reservedExecutionId: pushId })).ok, false, "shipping is never replayed");
    const commands = readFileSync(join(f.server.temp, "git-observed.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const commits = commands.filter((args) => args[0] === "commit"); assert.equal(commits.length, 2);
    assert.ok(commits[0].includes("checkpoint: Change the owned file"));
    assert.deepEqual(commits.map((args) => args.slice(-2)), [["--", "owned.txt"], ["--", "owned.txt"]]);
    assert.deepEqual(commands.filter((args) => args[0] === "push"), [["push"]], "one approved structured push, through the fake boundary only");
  } finally { await f.close(); }
});

test("FCXT checkpoint refuses a Git result containing unrelated files and never invents success", { timeout: 60_000 }, async () => {
  const f = await fixedServer({ git: true });
  try {
    await f.planning(); await f.approve();
    writeFileSync(join(f.server.temp, "git-options.json"), JSON.stringify({ unrelated: true }));
    const checkpoint = await f.action("checkpoint");
    assert.equal(checkpoint.ok, false, "unrelated committed paths must fail verification");
    assert.match(checkpoint.text, /Git did not verify a commit containing only pack-owned files/);
    assert.equal(f.task().checkpoints.length, 0);
    const journal = JSON.parse(readFileSync(join(f.server.data, "executions", "fixed.json"), "utf8"));
    assert.equal(journal.executions.at(-1).status, "failed", "a known completed command with rejected verification records failure");
    const count = readFileSync(join(f.server.temp, "git-observed.jsonl"), "utf8").split("\n").filter(Boolean).length;
    const failed = journal.executions.at(-1);
    const replay = await f.action("checkpoint", { reservedExecutionId: failed.id });
    assert.equal(replay.ok, false, "the exact failed execution cannot be replayed");
    assert.deepEqual(JSON.parse(readFileSync(join(f.server.data, "executions", "fixed.json"), "utf8")), journal, "failed history stays unchanged");
    assert.equal(readFileSync(join(f.server.temp, "git-observed.jsonl"), "utf8").split("\n").filter(Boolean).length, count);
  } finally { await f.close(); }
});

test("FCXT an assignment changed during async approval cancels before reservation or spawn", { timeout: 60_000 }, async () => {
  const f = await fixedServer();
  try {
    await f.planning(); await f.approve();
    assert.equal((await f.c.request({ type: "refreshSettings" })).ok, true);
    assert.equal((await f.c.request({ type: "setPermissionMode", tabId: "fixed", mode: "ask", confirm: true })).ok, true);
    const before = f.task().executions.length, runs = f.c.tab("fixed").runs.length;
    const action = f.action("build");
    const approval = await f.c.wait(() => f.c.tab("fixed").pendingApprovals[0], "fixed launch waits for approval");
    assert.deepEqual(await f.c.request({ type: "setCrewAssignment", tabId: "fixed", slot: "coder", assignment: { ...assignment, effort: "high" } }), { ok: true });
    assert.equal((await f.c.request({ type: "answerApproval", tabId: "fixed", approvalId: approval.approvalId, allow: true })).ok, true);
    const refused = await action; assert.equal(refused.ok, false); assert.match(refused.text, /assignment or permission changed while approving/);
    assert.equal(f.task().executions.length, before); assert.equal(f.c.tab("fixed").runs.length, runs);
  } finally { await f.close(); }
});
