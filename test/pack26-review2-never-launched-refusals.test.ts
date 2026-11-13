import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { neverFixture, assertCancelled } from "./pack26-review2-never-launched-helpers.ts";
import { executionArchivePath, archiveJson } from "../server/fixed-crew/task-archive-files.ts";
import { executionArchiveBytes } from "../server/fixed-crew/task-journal-archive.ts";

test("P26R7N request receipt refusal matrix", async t => {
  for (const change of ["missing", "digest", "request", "session", "pending-prefix", "result", "coordinator", "kind", "route", "batch"] as const) {
    const f = await neverFixture(t), id = await f.direct();
    f.rewrite(task => {
      const run = task.executions.at(-1), receipt = task.requests.find(r => r.result.executionId === id);
      assert.ok(receipt, `FOUND receipt substitution ${change}`);
      if (change === "missing") task.requests = task.requests.filter(r => r !== receipt);
      if (change === "digest") receipt.digest = "a".repeat(64);
      if (change === "request") receipt.id = "foreign-request";
      if (change === "session") run.sessionId = "foreign-session";
      if (change === "pending-prefix") run.sessionId = "pending-loose-prefix";
      if (change === "result") receipt.result.executionId = null;
      if (change === "coordinator") task.coordinatorSessions = task.coordinatorSessions.slice(0, 1);
      if (change === "kind") run.kind = "assist";
      if (change === "route") run.route = "postFinal";
      if (change === "batch") run.batch = ["foreign-batch"];
      run.status = "interrupted";
    });
    await f.refused(`receipt ${change}`, /authentic original action receipt/, id);
  }
  const f = await neverFixture(t); const id = await f.request();
  f.rewrite(task => { task.executions.at(-1).sessionId = "pending-" + "f".repeat(64); task.executions.at(-1).status = "interrupted"; });
  await f.refused("browser exact pending session", /authentic original action receipt/, id);
});

test("P26R7N journal admission remains held", async t => {
  for (const admission of ["consumed", "reserved", "running", "unknown", "other-active"]) {
    const f = await neverFixture(t), id = await f.request(), journal = f.journal(), row = f.journalRow();
    if (admission === "reserved" || admission === "running") { row.status = admission; row.processEnded = false; }
    if (admission === "unknown") { row.status = "interrupted"; row.processEnded = false; }
    if (admission === "other-active") { row.id = "another-execution"; row.status = "interrupted"; row.processEnded = false; journal.activeExecutionId = row.id; }
    journal.executions.push(row); f.saveJournal(journal);
    const reasons = { consumed: /No interrupted execution/, reserved: /app has not confirmed this whole process tree ended/,
      running: /app has not confirmed this whole process tree ended/, unknown: /app has not confirmed this whole process tree ended/,
      "other-active": /Another execution owns/ };
    await f.refused(`journal ${admission}`, reasons[admission], id);
  }
});

test("P26R7N archived admission remains held", async t => {
  for (const state of ["valid", "corrupt", "mismatched", "unreadable", "linked"]) {
    const f = await neverFixture(t), id = await f.request();
    const file = executionArchivePath(f.data, f.tabId, id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, state === "corrupt" ? "{bad" : executionArchiveBytes({ ...f.journalRow(), ...(state === "mismatched" ? { id: "foreign" } : {}) }));
    const read = fs.openSync, lstat = fs.lstatSync;
    let mock: any;
    if (state === "unreadable") mock = t.mock.method(fs, "openSync", (path: any, ...args: any[]) => { if (String(path) === file) throw Object.assign(new Error("archive access denied"), { code: "EACCES" }); return read(path, ...args); });
    // Do not create a filesystem link. Exercise the actual no-link guard with
    // an injected lstat result; native link acceptance remains the leader's.
    if (state === "linked") mock = t.mock.method(fs, "lstatSync", (path: any, ...args: any[]) => { const info = lstat(path, ...args); if (String(path) === file) info.isSymbolicLink = () => true; return info; });
    syncBuiltinESMExports();
    const reasons = { valid: /archived admission cannot be cancelled/, corrupt: /JSON/,
      mismatched: /Execution archive identity mismatch/, unreadable: /archive access denied/, linked: /link/i };
    try { await f.refused(`archive ${state}`, reasons[state], id); }
    finally { mock?.mock.restore(); syncBuiltinESMExports(); }
  }
});

test("P26R7N runtime contradictions remain held", async t => {
  for (const state of ["runner", "context", "approval", "save", "git", "record", "live", "uncertain", "persisted-live", "persisted-uncertain"]) {
    const f = await neverFixture(t), id = await f.request(), controls = f.controls;
    let op: any;
    const live = f.server.launchSafety.live, uncertain = f.server.launchSafety.uncertain;
    if (state === "runner") {
      f.bindings.setRunner((runId: string) => runId === id || f.server.isRunning(runId));
    }
    if (state === "context") controls.runContexts.set(id, { tabId: f.tabId, run: { runId: id } });
    if (state === "approval") controls.pendingApprovals.set("held", { tabId: f.tabId });
    if (state === "save") controls.savingTabs.set(f.tabId, 1);
    if (state === "git") op = controls.fixedGitOperations.register(id, f.tabId, f.server.leaderInstances.get(f.tabId));
    if (state === "record") f.server.runRecords.set(id, { tabId: f.tabId });
    if (state === "live") live.push({ seatId: `${f.tabId}.coder`, runId: id });
    if (state === "uncertain") uncertain.push({ seatId: `${f.tabId}.coder`, runId: id, pid: 1 });
    if (state.startsWith("persisted-")) mkdirSync(join(f.data, "config"), { recursive: true });
    if (state.startsWith("persisted-")) writeFileSync(join(f.data, "config/launch-safety.json"), JSON.stringify({ live: state === "persisted-live" ? [{ seatId: `${f.tabId}.coder`, runId: id }] : [], uncertain: state === "persisted-uncertain" ? [{ seatId: `${f.tabId}.coder`, runId: id, pid: 1 }] : [] }));
    try { await f.refused(`runtime ${state}`, /Runtime or persisted launch facts/, id); }
    finally {
      f.bindings.setRunner(f.server.isRunning);
      controls.runContexts.delete(id); controls.pendingApprovals.delete("held"); controls.savingTabs.delete(f.tabId); f.server.runRecords.delete(id);
      live.length = 0; uncertain.length = 0;
      if (op) { op.terminal = true; op.treesEnded = true; op.finalized = true; controls.fixedGitOperations.complete(op); }
    }
  }
});

test("P26R7N captured authority and location remain bound", async t => {
  for (const state of ["store", "root", "tab", "folder", "leader", "instance", "fixed"] as const) {
    const f = await neverFixture(t), id = await f.request(), tab = f.server.tabLocation(f.tabId).tab;
    const location = f.server.tabLocation(f.tabId), index = location.project.tabs.indexOf(tab);
    const store = f.server.fixedTasks, folder = tab.folder, leader = f.server.leaders.get(f.tabId), instance = f.server.leaderInstances.get(f.tabId), fixed = tab.fixedCrew;
    const before = f.taskBytes(); let invoked = 0;
    f.setDiskHook(() => {
      invoked++;
      if (state === "store") f.install({ ...store });
      if (state === "root") f.bindings.setRoot(f.data + "-foreign");
      if (state === "tab") location.project.tabs[index] = { ...tab };
      if (state === "folder") tab.folder += "-foreign";
      if (state === "leader") f.server.leaders.set(f.tabId, { ...leader });
      if (state === "instance") f.server.leaderInstances.set(f.tabId, {});
      if (state === "fixed") tab.fixedCrew = undefined;
    });
    let result: any;
    try { result = await f.reconcile(id); }
    finally { f.setDiskHook(); f.install(store); f.bindings.setRoot(f.data); location.project.tabs[index] = tab; tab.folder = folder; tab.fixedCrew = fixed; f.server.leaders.set(f.tabId, leader); f.server.leaderInstances.set(f.tabId, instance); }
    assert.equal(invoked, 1, `FOUND captured binding ${state}`);
    assert.deepEqual(f.taskBytes(), before, `${state} cannot publish cancellation`);
    assert.equal(result.isError, true, `${state}: ${result.text}`);
    console.log(`REFUSAL captured ${state}: expected=captured authority observed=${result.text}`);
    assert.match(result.text, /Captured task-only authority or location changed/, `${state}: intended captured binding guard`);
  }
});

test("P26R7N positive result provenance remains held", async t => {
  for (const state of ["evidence", "result", "findings"]) {
    const f = await neverFixture(t), id = await f.request();
    f.rewrite(task => {
      const run = task.executions.at(-1); run.status = "interrupted";
      if (state === "evidence") run.evidence = ["owned.txt"];
      if (state === "result") run.resultRevision = task.revision.digest;
      if (state === "findings") run.findings = ["positive-result"];
    });
    await f.refused(`positive ${state}`, /Positive result provenance/, id);
  }
});

test("P26R7N identity status stale leader and disk contradictions refuse", async t => {
  for (const state of ["task", "version", "revision", "foreign-run", "running", "success", "verified", "replaced-leader", "dead-leader", "corrupt-journal", "changed-journal"] as const) {
    const f = await neverFixture(t), id = await f.request();
    const expected = f.expected(); let target = id, selected = f.specs;
    const leader = f.server.leaders.get(f.tabId), instance = f.server.leaderInstances.get(f.tabId);
    if (state === "task") expected.taskId = "foreign";
    if (state === "version") expected.planVersion++;
    if (state === "revision") expected.recordRevision++;
    if (state === "foreign-run") target = "foreign";
    if (["running", "success", "verified"].includes(state)) {
      const store = f.server.fixedTasks, run = f.last();
      const apply = (event: any, role: any = "leader", session = "status-leader") => store.apply(
        { tabId: f.tabId, ...f.expected(), requestId: `status-${f.task().recordRevision}` }, event, store.actor(role, session));
      apply({ type: "start", executionId: id });
      if (state !== "running") apply({ type: "result", executionId: id, taskId: f.task().id, planVersion: f.task().planVersion,
        role: run.role, success: true, processEnd: "confirmed", evidence: ["owned.txt"] }, run.role, run.sessionId);
      if (state === "verified") apply({ type: "verify", executionId: id, checkName: null, findings: [], resolved: [], baseFinal: null, unchanged: [] });
      Object.assign(expected, f.expected());
      assert.equal(f.last().status, state === "running" ? "running" : "success", `FOUND live status ${state}`);
      assert.equal(f.last().verified, state === "verified");
    }
    if (state === "replaced-leader") f.server.leaderInstances.set(f.tabId, {});
    if (state === "dead-leader") f.server.leaders.set(f.tabId, { ...leader, isDead: () => true });
    if (state === "corrupt-journal" || state === "changed-journal") writeFileSync(join(f.data, "executions", `${f.tabId}.json`), state === "corrupt-journal" ? "{bad" : archiveJson({ ...f.journal(), executions: [...f.journal().executions, f.journalRow()] }));
    const reasons = { task: /Stale task identity or version/, version: /Stale task identity or version/,
      revision: /Stale task identity or version/, "foreign-run": /journal execution does not match the current task identity/,
      running: /Not an unconsumed task-only reservation/, success: /Positive result provenance/,
      verified: /Positive result provenance/, "replaced-leader": /Only the current leader/,
      "dead-leader": /Only the current leader/, "corrupt-journal": /JSON/,
      "changed-journal": /Current journal disk facts differ/ };
    try { await f.refused(state, reasons[state], target, { expected }, selected); }
    finally { f.server.leaders.set(f.tabId, leader); f.server.leaderInstances.set(f.tabId, instance); }
  }
});


test("P26R7N cold persisted launch contradiction interrupts the stage", async t => {
  for (const key of ["live", "uncertain"]) {
    const f = await neverFixture(t), id = await f.request();
    mkdirSync(join(f.data, "config"), { recursive: true });
    writeFileSync(join(f.data, "config/launch-safety.json"), JSON.stringify({ [key]: [{ seatId: `${f.tabId}.coder`, runId: id, pid: 1 }] }));
    const cold = f.restart(); assert.equal(cold.stage, "interrupted"); assert.equal(cold.executions.at(-1).status, "interrupted");
    await f.refused(`cold launch contradiction ${key}`, /Runtime or persisted launch facts/, id);
  }
});


test("P26R7N malformed retained journal facts cannot prove no admission", async t => {
  for (const field of ["taskId", "planVersion", "role", "selectedSlot", "kind", "selectionReason", "logPath", "duplicate"]) {
    const f = await neverFixture(t), id = await f.request(), journal = f.journal(), row = f.journalRow("other-admission");
    if (field === "taskId") row.taskId = "../foreign";
    if (field === "planVersion") row.planVersion = 0;
    if (field === "role") row.role = "foreign-role";
    if (field === "selectedSlot") row.selectedSlot = "foreign-slot";
    if (field === "kind") row.kind = "foreign-kind";
    if (field === "selectionReason") row.selectionReason = "";
    if (field === "logPath") row.logPath = 3;
    journal.executions.push(row);
    if (field === "duplicate") journal.executions.push({ ...row });
    f.saveJournal(journal);
    const reasons = { taskId: /Invalid task identity/, planVersion: /Invalid journal execution version/,
      role: /Invalid task enum/, selectedSlot: /Invalid task enum/, kind: /Invalid task enum/,
      selectionReason: /Invalid task text/, logPath: /Invalid task text/, duplicate: /Duplicate journal execution/ };
    await f.refused(`malformed journal ${field}`, reasons[field], id);
  }
});
