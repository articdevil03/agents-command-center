import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { stateFixture } from "./pack26-review1-run2-process-helpers.ts";
import { populate } from "./pack26-review1-run2-helpers.ts";
import { socketGitFixture } from "./pack26-review1-run2-git-helpers.ts";

for (const change of ["leader", "folder", "store", "revision", "task", "version", "saved-mode", "live-mode", "assignment"] as const) {
  test(`P26R2A authority location revision selection recheck ${change} after command await`, async (t) => {
    const f = await stateFixture(t);
    const pending = f.launch();
    try {
      assert.equal(f.spawns.length, 1, "first real production child started and is pending");
      if (change === "leader") f.server.leaders.set(f.tabId, { ...f.server.leaders.get(f.tabId), isDead: () => false });
      if (change === "folder") f.tab.folder += "-changed";
      if (change === "store") f.server.fixedTasks.fixtureReplaceStore();
      if (change === "revision") {
        const current = f.server.fixedTasks.get(f.tabId);
        f.server.fixedTasks.apply({ tabId: f.tabId, ...f.expected(), requestId: "newer-event" }, { type: "approvePlan" }, f.server.fixedTasks.actor("owner"));
        assert.equal(f.server.fixedTasks.get(f.tabId).recordRevision, current.recordRevision + 1);
      }
      if (change === "task" || change === "version") {
        const get = f.server.fixedTasks.get;
        f.server.fixedTasks.get = (tabId: string) => { const value = get(tabId); return value && tabId === f.tabId ? { ...value, ...(change === "task" ? { id: "replacement-task" } : { planVersion: value.planVersion + 1 }) } : value; };
      }
      if (change === "saved-mode") f.server.settingsService.permissionMode = () => "plan";
      if (change === "live-mode") f.server.leaders.get(f.tabId).getPermissionMode = () => "plan";
      if (change === "assignment") f.tab.fixedCrew.preferences.leader.assignment.effort = "low";
      f.child.stdout.write("true"); f.exit();
      const error = await pending.then(() => null, (error: Error) => error);
      assert.equal(f.spawns.length, 1, "authority change prevents the NEXT command");
      assert.match(String(error), /changed|INCOMPLETE|permission/i);
      assert.equal(f.terminal().length, 1); assert.equal(f.terminal()[0].verification, "rejected");
      assert.equal(f.server.fixedTasks.get(f.tabId).checkpoints.length, 0);
    } finally { f.exit(1); await pending.catch(() => {}); f.server.stopLeaderSession(f.tabId); }
  });
}

test("P26R2A reservation global heavy slot holds through real async Git", async (t) => {
  const f = await stateFixture(t), pending = f.launch();
  try {
    const journal = f.journal(), id = journal.activeExecutionId;
    assert.ok(id); assert.equal(journal.executions.at(-1).processEnded, false);
    f.server.createTabLeader("beta-dev");
    await assert.rejects(() => f.server.launchFixedAction(f.server.currentActor("beta-dev"), null, { kind: "assist", route: "normal", change: "none" }, "Read files"), /previous process tree|reserved/);
    f.child.stdout.write("false"); f.exit(); await assert.rejects(pending, /outside a Git repository/);
    assert.equal(f.journal().executions.at(-1).processEnded, true);
  } finally { f.exit(1); await pending.catch(() => {}); f.server.stopLeaderSession(f.tabId); f.server.stopLeaderSession("beta-dev"); }
});

test("P26R2A durable result write failure rejects finalization without inventing unknown tree end", async (t) => {
  const f = await stateFixture(t), pending = f.launch();
  const apply = f.server.fixedTasks.apply;
  try {
    f.server.fixedTasks.apply = (expected: any, event: any, actor: any) => {
      if (event.type === "result") throw new Error("injected durable result write failure");
      return apply(expected, event, actor);
    };
    f.child.emit("close", 7, null);
    await assert.rejects(pending, /INCOMPLETE.*durable result write failure/);
    const terminal = f.terminal(); assert.equal(terminal.length, 1);
    assert.equal(terminal[0].command, "failure"); assert.equal(terminal[0].treeEnd, "confirmed");
    assert.equal(terminal[0].verification, "rejected"); assert.equal(terminal[0].finalized, false);
    assert.equal(f.journal().executions.at(-1).processEnded, true, "known ended tree is a separate fact from failed finalization");
    assert.ok(f.journal().activeExecutionId, "failed durable finalization retains a global reservation brake");
    assert.equal(f.operations.get(f.journal().activeExecutionId)?.finalized, false);
  } finally { f.server.fixedTasks.apply = apply; f.exit(1); await pending.catch(() => {}); f.server.stopLeaderSession(f.tabId); }
});

test("P26R2A freshness same-size restored-timestamp edit after awaited add prevents commit", async () => {
  const f = await socketGitFixture({ editAfterAdd: true });
  try {
    const reply = await f.call();
    assert.equal(reply.body.result.isError, true); assert.match(reply.body.result.content[0].text, /content changed|INCOMPLETE/i);
    assert.equal(f.rows("git-process-start.jsonl").some((entry) => entry.args[0] === "commit"), false);
    const terminal = f.terminal()[0];
    assert.equal(terminal.verification, "rejected");
    assert.equal(terminal.finalized, false, "stale read-only result cannot overwrite the covered task revision");
    assert.ok(f.journal().activeExecutionId, "failed task finalization keeps its safety brake");
    console.log(`P26R2_FINALIZATION ${JSON.stringify(terminal)}`);
  } finally { await f.close(); }
});

test("P26R2A tree result known command failure unknown tree keeps durable cross-tab reservation brake", async (t) => {
  const f = await stateFixture(t, { listFails: true }), pending = f.launch();
  try {
    f.child.emit("close", 7, null);
    await assert.rejects(pending, /failed|unknown/);
    const terminal = f.terminal();
    assert.equal(terminal.length, 1); assert.equal(terminal[0].command, "failure"); assert.equal(terminal[0].treeEnd, "unknown");
    assert.equal(f.journal().executions.at(-1).processEnded, false, "unknown tree end must never release the journal safety brake");
    assert.equal(f.journal().executions.at(-1).status, "interrupted");
    const disk = JSON.parse(readFileSync(join(f.server.testRoot, "executions", `${f.tabId}.json`), "utf8"));
    assert.equal(disk.executions.at(-1).processEnded, false, "restart disk retains unknown process end");
    f.server.createTabLeader("beta-dev");
    await assert.rejects(() => f.server.launchFixedAction(f.server.currentActor("beta-dev"), null, { kind: "assist", route: "normal", change: "none" }, "Read"), /previous process tree|reserved/);
  } finally { f.exit(1); await pending.catch(() => {}); f.server.stopLeaderSession(f.tabId); f.server.stopLeaderSession("beta-dev"); }
});

test("P26R2A budget real Git and evidence routes reject before publication or evidence consumption", async () => {
  const f = await socketGitFixture();
  try {
    f.worker({}); const check = await f.action("check"); assert.equal(check.ok, true, check.text); await f.ended(check.value.runId);
    const taskFile = join(f.server.data, "tasks", "fixed.json"), before = readFileSync(taskFile);
    unlinkSync(join(f.server.work, "owned.txt")); populate(join(f.server.work, "owned.txt"), 5000, 1);
    const evidence = await f.verify(check.value.runId);
    assert.equal(evidence.ok, false); assert.match(evidence.text, /4,096-entry\/64-MiB/);
    assert.equal(f.journal().executions.find((e: any) => e.id === check.value.runId).consumed, false);
    const git = await f.call(); assert.equal(git.body.result.isError, true); assert.match(git.body.result.content[0].text, /active reservation/, "unconsumed check still has its independent task gate");
    assert.deepEqual(readFileSync(taskFile), before); assert.equal(f.rows("git-spawn.jsonl").length, 0);
  } finally { await f.close(); }
});

test("P26R2A budget otherwise-approved Git action refuses oversized coverage before reservation", async () => {
  const f = await socketGitFixture();
  try {
    const taskFile = join(f.server.data, "tasks", "fixed.json"), before = readFileSync(taskFile), runs = f.journal().executions.length;
    unlinkSync(join(f.server.work, "owned.txt")); populate(join(f.server.work, "owned.txt"), 5000, 1);
    const git = await f.call(); assert.equal(git.body.result.isError, true); assert.match(git.body.result.content[0].text, /fingerprint budget/);
    assert.deepEqual(readFileSync(taskFile), before); assert.equal(f.rows("git-spawn.jsonl").length, 0); assert.equal(f.journal().executions.length, runs);
  } finally { await f.close(); }
});
