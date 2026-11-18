import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { loadFixed, connect, source, fixtureWorkspaces, settleLeaderTurns } from "./round2-helpers.ts";
import { ownedTemp, testPlan } from "./pack26-review1-run2-helpers.ts";
import { runLeaderTool } from "../server/leader-tools.ts";

for (const failure of ["failed-fingerprint", "stopped-fingerprint", "publication", "cleanup-and-brake"] as const) {
  test(`P1 C-3 ${failure} cleans runtime and pipes, retains recovery brake and fails shutdown`, async (t) => {
    const root = ownedTemp(t), folder = join(root, "work"), data = join(root, "data");
    mkdirSync(folder); writeFileSync(join(folder, "owned.txt"), "before");
    const workspaces = fixtureWorkspaces();
    for (const project of workspaces.projects) for (const tab of project.tabs) tab.folder = folder;
    const server = await loadFixed({ skipHealth: true, testRoot: data, workspaces, deferKill: true,
      // No process-tree work is needed for our synthetic, pid-less child. Its root close is confirmed synchronously.
      treeWatch: () => null,
      serverSource: source + `\nfixedTasks.finalization = { stop: killRun, windows: runWindows,
        revokers: runBridgeRevokers, specs: fixedLeaderSpecs, shutdown, drain: drainWorkers };` });
    t.after(async () => {
      for (const entry of server.launched) server.closeRun(entry.run.runId, 1);
      await settleLeaderTurns(server); server.stopLeaderSession("alpha-dev");
      assert.equal(server.active.size, 0, "all synthetic workers ended");
    });
    const ws = connect(server); ws.terminate = () => { ws.readyState = 3; };
    server.createTabLeader("alpha-dev");
    const seats = Object.fromEntries(Object.entries(server.tabLocation("alpha-dev").tab.fixedCrew.preferences)
      .map(([slot, preference]: [string, any]) => [slot, preference.assignment]));
    const store = server.fixedTasks, controls = store.finalization;
    store.create("alpha-dev", testPlan(), seats, store.actor("planner"));
    const expected = () => { const task = store.get("alpha-dev"); return { taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision }; };
    store.apply({ tabId: "alpha-dev", ...expected(), requestId: "approve" }, { type: "approvePlan" }, store.actor("owner"));
    const { runId } = await server.launchFixedAction(server.currentActor("alpha-dev"), expected(),
      { kind: "build", route: "normal", change: "none" }, "Update the owned file");
    const proc = server.runnerProcesses.get(runId);
    let pipesReleased = 0, bridgeRevoked = 0, approvalsDenied = 0;
    server.pendingApprovals.set("fixture-approval", { tabId: "alpha-dev", origin: { kind: "seat", runId, slot: "coder" },
      settle: (allowed: boolean) => { assert.equal(allowed, false); approvalsDenied++; server.pendingApprovals.delete("fixture-approval"); } });
    proc.stdout.destroy = () => { pipesReleased++; };
    proc.stderr.destroy = () => { pipesReleased++; };
    controls.revokers.set(runId, () => { bridgeRevoked++; });
    server.runOutput.set(runId, "buffered output"); server.runUsage.set(runId, {});
    server.tabs.get("alpha-dev").stalledRuns.add(runId);
    assert.equal(controls.windows.has(runId), true, "real working callback opened an activity window");
    const before = readFileSync(join(data, "tasks", "alpha-dev.json"), "utf8");
    const rename = fs.renameSync;
    let rejectedWrites = 0;
    if (failure === "cleanup-and-brake") {
      let journalWrites = 0;
      fs.renameSync = (from, to) => {
        if (String(to) === join(data, "executions", "alpha-dev.json") && ++journalWrites > 2) throw new Error("injected brake write failure");
        return rename(from, to);
      };
      syncBuiltinESMExports();
      server.launchSafety.live = new Proxy(server.launchSafety.live, { get(target, property, receiver) {
        if (property === "filter") throw new Error("injected first cleanup failure");
        return Reflect.get(target, property, receiver);
      } });
    }
    if (failure === "publication") {
      fs.renameSync = (from, to) => {
        if (String(to) === join(data, "tasks", "alpha-dev.json")) {
          rejectedWrites++; throw new Error("injected task publication failure");
        }
        return rename(from, to);
      };
      syncBuiltinESMExports();
    }
    else truncateSync(join(folder, "owned.txt"), 20 * 1024 * 1024 + 1);
    if (failure === "stopped-fingerprint") assert.equal(controls.stop(runId), true);
    proc.pid = undefined;
    let finalizationError: unknown;
    try { server.closeRun(runId, 1); } catch (error) { finalizationError = error; }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    // Check cleanup BEFORE checking the error, so the old implementation fails by the missing-cleanup assertion.
    assert.equal(server.runContexts.has(runId), false, "task publication must not retain the runtime context");
    assert.equal(pipesReleased, 2, "both output pipes are released despite failed publication");
    assert.equal(bridgeRevoked, 1); assert.equal(controls.revokers.has(runId), false);
    assert.equal(approvalsDenied, 1, "pending approvals are denied despite earlier cleanup failure");
    assert.equal(controls.windows.has(runId), false);
    assert.equal(server.runOutput.has(runId), false); assert.equal(server.runUsage.has(runId), false);
    assert.equal(server.tabs.get("alpha-dev").stalledRuns.has(runId), false);
    if (failure !== "cleanup-and-brake") assert.equal(server.launchSafety.live.some((row: any) => row.runId === runId), false);
    assert.equal(server.isRunning(runId), false);
    assert.equal(server.runRecords.get(runId).status, failure === "stopped-fingerprint" ? "stopped" : "failed");
    assert.match(String(finalizationError), failure === "publication" ? /task publication failure/ : /Unsupported task input/);
    if (failure === "cleanup-and-brake") {
      assert.match(String(finalizationError), /injected brake write failure/);
      assert.match(String(finalizationError), /injected first cleanup failure/);
      assert.equal(await controls.drain(), false);
      // The first cleanup was deliberately prevented. Restore only that fixture state before shutdown.
      server.launchSafety.live = [];
      await controls.shutdown("test cleanup failure");
      assert.deepEqual(server.exitCodes, [1]);
      return;
    }
    if (failure === "publication") assert.equal(rejectedWrites, 1, "real atomic task publication reached the filesystem boundary");
    assert.ok(ws.messages.some((row: any) => row.type === "error" && /could not be saved/i.test(row.message)), "the finalization failure is reported");
    assert.equal(readFileSync(join(data, "tasks", "alpha-dev.json"), "utf8"), before, "no successful result is invented");
    const journal = JSON.parse(readFileSync(join(data, "executions", "alpha-dev.json"), "utf8"));
    assert.equal(journal.activeExecutionId, runId, "durable brake still owns admission");
    assert.equal(journal.executions.at(-1).status, "interrupted");
    assert.equal(journal.executions.at(-1).processEnded, true);
    assert.equal(journal.executions.at(-1).consumed, false);
    assert.equal(await controls.drain(), false, "failed finalization cannot satisfy worker shutdown");
    await controls.shutdown("test finalization");
    assert.deepEqual(server.exitCodes, [1], "real server shutdown refuses success");
    // Reconciliation bypasses fingerprinting and abandons the failed execution through the existing leader tool.
    server.createTabLeader("alpha-dev");
    const reconciled = await runLeaderTool(controls.specs("alpha-dev", server.leaderInstances.get("alpha-dev")),
      "reconcile_task_execution", { expected: expected(), runId, reason: "Abandon failed finalization" });
    assert.equal(reconciled.isError, false, reconciled.text);
    const recovered = JSON.parse(readFileSync(join(data, "executions", "alpha-dev.json"), "utf8"));
    assert.equal(recovered.activeExecutionId, null); assert.equal(recovered.executions.at(-1).consumed, true);
    assert.equal(store.get("alpha-dev").executions.at(-1).status, "failed");
  });
}
