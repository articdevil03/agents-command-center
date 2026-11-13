import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { run4Fixture } from "./pack26-review1-run4-helpers.ts";
import { fixedDependencies } from "./round2-fixed-deps.ts";
import { waitFor, settleLeaderTurns } from "./round2-helpers.ts";
import { invalidateJournal, saveJournal } from "../server/fixed-crew/task-execution.ts";

export async function neverFixture(t: any, visibleWork = false) {
  const original = fixedDependencies.saveJournal;
  const readFacts = fixedDependencies.readJournalSnapshot;
  let diskHook: (() => void) | undefined;
  fixedDependencies.readJournalSnapshot = (...args) => { const journal = readFacts(...args); diskHook?.(); return journal; };
  let failAdmission = false, gitCalls = 0;
  fixedDependencies.saveJournal = (root, tab, journal) => {
    if (failAdmission) { failAdmission = false; throw new Error("F1 admission publication failure"); }
    return original(root, tab, journal);
  };
  let f: Awaited<ReturnType<typeof run4Fixture>>;
  try { f = await run4Fixture(t, { visibleWork, shipping: ["commit"] }, `fixedTasks.never = { setRoot: (value) => { dataRoot = value; }, setRunner: (value) => { isRunning = value; } };`); }
  finally { fixedDependencies.saveJournal = original; fixedDependencies.readJournalSnapshot = readFacts; }
  f.controls.git(() => { gitCalls++; throw new Error("Unexpected Git spawn"); });
  const bindings = f.server.fixedTasks.never;
  const file = join(f.data, "tasks", `${f.tabId}.json`);
  const disk = () => readFileSync(file);
  const last = () => f.task().executions.at(-1)!;
  const idle = () => settleLeaderTurns(f.server);
  const request = async (action = visibleWork ? "rough" : "build", beforeReply?: () => void) => {
    const workers = f.server.launched.length, commands = gitCalls;
    const executionCount = f.task().executions.length, chats = f.server.chats.length;
    const requestId = `never-${f.task().recordRevision}`;
    const message = { type: "requestFixedTaskAction", requestId, tabId: f.tabId, ...f.expected(), action };
    const send = f.ws.send;
    if (beforeReply) f.ws.send = (raw: string) => {
      if (JSON.parse(raw).type === "fixedTaskResult") { beforeReply(); throw new Error("F1 reply before delivery failed"); }
      return send(raw);
    };
    try { f.ws.message(message); await idle(); }
    finally { f.ws.send = send; }
    assert.equal(f.task().requests.some(r => r.id === requestId), true, `FOUND ${requestId}`);
    assert.equal(f.task().executions.length, executionCount + 1, "one saved task-only reservation");
    if (beforeReply) assert.equal(f.server.chats.length, chats, "response failure precedes Leader delivery");
    assertNoLaunch(workers, commands);
    return last().id;
  };
  const reconcile = (runId = last().id, extra = {}, specs = f.specs) => f.call("reconcile_task_execution",
    { expected: f.expected(), runId, reason: "Explicitly abandon authenticated no-admission intent", ...extra }, specs);
  const restart = () => { invalidateJournal(f.data, f.tabId); f.restart(); return f.task(); };
  const direct = async (kind = "build") => {
    const workers = f.server.launched.length, commands = gitCalls;
    f.controls.git(() => { gitCalls++; throw new Error("Unexpected Git spawn after failed admission"); });
    failAdmission = true;
    const result = await f.call("request_task_action", { expected: f.expected(), kind, brief: "Admission must fail before launch" });
    assert.equal(result.isError, true); assert.match(result.text, /F1 admission publication failure/);
    assert.equal(f.journal().executions.some(e => e.id === last().id), false);
    assertNoLaunch(workers, commands);
    return last().id;
  };
  const assertNoLaunch = (workers: number, commands = gitCalls) => {
    assert.equal(f.server.launched.length, workers, "zero worker launches attributable to cancellation");
    assert.equal(gitCalls, commands, "zero Git commands attributable to cancellation");
  };
  const rewrite = (change: (task: any) => void) => { const task = f.task(); change(task); f.writeTask(task); return f.task(); };
  const withPublishFailure = async (operation: () => Promise<any>) => {
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === file) throw new Error("F1 task publication failed");
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try { return await operation(); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
  };
  const snapshot = () => ({ disk: disk(), task: f.task(), journal: f.journal() });
  const refused = async (label: string, expectedReason: RegExp, runId = last().id, extra = {}, specs = f.specs) => {
    const before = snapshot(), workers = f.server.launched.length, commands = gitCalls;
    const result = await reconcile(runId, extra, specs);
    assert.equal(result.isError, true, `FOUND refusal ${label}: ${result.text}`);
    console.log(`REFUSAL ${label}: expected=${expectedReason} observed=${result.text}`);
    assert.match(result.text, expectedReason, `${label}: intended refusal boundary`);
    assert.deepEqual(snapshot(), before, `${label}: disk/cache/journal unchanged`);
    assertNoLaunch(workers, commands); console.log(`FOUND refusal ${label}`);
  };
  return { ...f, file, bindings, setDiskHook: (hook?: () => void) => { diskHook = hook; }, taskBytes: disk, last, idle, request, reconcile, restart, direct, rewrite, assertNoLaunch, withPublishFailure, snapshot, refused,
    journalRow: (runId = last().id) => ({ ...f.journal().executions[0], id: runId, taskId: f.task().id, planVersion: f.task().planVersion, role: last().role,
      selectedSlot: last().role, kind: last().kind, status: "failed", consumed: true }),
    saveJournal: (j: any) => saveJournal(f.data, f.tabId, j), gitCount: () => gitCalls };
}
export async function assertCancelled(f: Awaited<ReturnType<typeof neverFixture>>, runId: string) {
  const before = f.task(), workers = f.server.launched.length, git = f.gitCount();
  const result = await f.reconcile(runId); assert.equal(result.isError, false, result.text);
  const task = f.task(), run = task.executions.find(e => e.id === runId)!;
  assert.equal(run.status, "failed"); assert.equal(run.processEnd, "confirmed");
  assert.equal(run.verified, false); assert.deepEqual(run.evidence, []); assert.equal(run.resultRevision, null);
  assert.equal(task.recordRevision, before.recordRevision + 1);
  assert.equal(task.requests.length, before.requests.length + 1);
  for (const key of ["ownerScopeApproval", "ownerRoughApproval", "roughRevision", "revision", "revisions", "checks", "reviews", "checkpoints", "findings", "triage"]) assert.deepEqual(task[key], before[key], `preserved ${key}`);
  assert.deepEqual(task.executions.filter(e => e.id !== runId), before.executions.filter(e => e.id !== runId));
  assert.equal(f.journal().executions.some(e => e.id === runId), false);
  assert.deepEqual(JSON.parse(f.taskBytes().toString()), task); f.assertNoLaunch(workers, git);
  return task;
}
export { waitFor };
