import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run4Fixture } from "./pack26-review1-run4-helpers.ts";
import { fixedDependencies } from "./round2-fixed-deps.ts";
import { invalidateJournal } from "../server/fixed-crew/task-execution.ts";

export async function refusedStartFixture(t: any) {
  const original = fixedDependencies.saveJournal;
  let onSave: ((journal: any) => void) | undefined;
  let failAfter = 0;
  fixedDependencies.saveJournal = (root, tab, journal) => {
    if (failAfter && --failAfter === 0) throw new Error("R8 journal publication failure");
    original(root, tab, journal); onSave?.(journal);
  };
  let f: Awaited<ReturnType<typeof run4Fixture>>;
  try { f = await run4Fixture(t); } finally { fixedDependencies.saveJournal = original; }
  await f.ready();
  const workers = f.server.launched.length;
  // The actual review start gate re-fingerprints after journal admission.
  onSave = journal => {
    if (journal.executions.at(-1).status === "reserved") {
      onSave = undefined; writeFileSync(join(f.folder, "owned.txt"), "changed after admission");
    }
  };
  const failed = await f.call("request_task_action", { expected: f.expected(), kind: "review", brief: "Start gate must refresh covered content" });
  assert.equal(failed.isError, true, failed.text); assert.match(failed.text, /check|revision|changed|stale/i);
  const runId = f.task().executions.at(-1).id;
  assert.equal(f.task().executions.at(-1).status, "reserved");
  const row = f.journal().executions.find(e => e.id === runId)!;
  assert.equal(row.status, "failed"); assert.equal(row.processEnded, true); assert.equal(row.consumed, false); assert.equal(row.logPath, null);
  const reconcile = () => f.call("reconcile_task_execution", { expected: f.expected(), runId, reason: "Explicitly settle the app-proven refused start" });
  const retry = () => f.call("request_task_action", { expected: f.expected(), kind: "review", reservedExecutionId: runId, brief: "Old admission cannot relaunch" });
  const journalBytes = () => readFileSync(join(f.data, "executions", `${f.tabId}.json`));
  const taskBytes = () => readFileSync(join(f.data, "tasks", `${f.tabId}.json`));
  return { ...f, runId, workers, reconcile, retry, journalBytes, taskBytes,
    failJournal: (offset: number) => { failAfter = offset; },
    cold: () => { invalidateJournal(f.data, f.tabId); f.restart(); return f.task(); } };
}
