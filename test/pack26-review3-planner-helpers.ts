import assert from "node:assert/strict";
import { run4Fixture } from "./pack26-review1-run4-helpers.ts";
import { fixedDependencies } from "./round2-fixed-deps.ts";
import { waitFor } from "./round2-helpers.ts";
import { invalidateJournal } from "../server/fixed-crew/task-execution.ts";

export async function plannerRetryFixture(t: any, kind: "initial" | "plan" | "triage") {
  const save = fixedDependencies.saveJournal;
  let failId: string | undefined;
  fixedDependencies.saveJournal = (root, tab, journal) => {
    if (failId && journal.executions.some(e => e.id === failId && e.consumed)) throw new Error("R8 consume publication failure");
    save(root, tab, journal);
  };
  let f: Awaited<ReturnType<typeof run4Fixture>>;
  try { f = await run4Fixture(t); } finally { fixedDependencies.saveJournal = save; }
  if (kind === "initial") { await f.ready(); await f.tool("finish_fixed_task", { expected: f.expected(), reason: "Start another initial task" }); }
  if (kind === "triage") {
    await f.worker("build"); await f.worker("check");
    // Use a real successful review to introduce an actual finding.
    const started = await f.tool("request_task_action", { expected: f.expected(), kind: "review", brief: "Find a real issue" });
    const row = f.journal().executions.find(e => e.id === started.runId)!;
    f.server.emitOutput(row.id, `CC_REPORT_BEGIN\n${JSON.stringify({ version: 1, runId: row.id, taskId: row.taskId,
      planVersion: row.planVersion, evidence: ["owned.txt"], plan: null, findings: [{ id: "r8-finding", executionId: row.id, text: "Fix observed behavior", real: true, minimal: false }],
      decisions: [], resolved: [], baseFinal: null, unchanged: [] })}\nCC_REPORT_END\n`);
    f.server.closeRun(row.id, 0); await waitFor(() => f.journal().executions.find(e => e.id === row.id)?.status === "done", "review ended");
    await f.tool("verify_task_evidence", { expected: f.expected(), runId: row.id });
  }
  const { runId } = await f.tool("begin_planning", { expected: f.expected(), brief: "Actual Planner acceptance", triage: kind === "triage" });
  const row = f.journal().executions.find(e => e.id === runId)!;
  const plan = kind === "initial" ? f.plan : kind === "plan" ? { ...f.plan, scope: "Changed accepted plan" } : null;
  f.server.emitOutput(runId, `CC_REPORT_BEGIN\n${JSON.stringify({ version: 1, runId, taskId: row.taskId, planVersion: row.planVersion,
    evidence: [], plan, findings: [], resolved: [], baseFinal: null, unchanged: [],
    decisions: kind === "triage" ? [{ findingId: "r8-finding", outcome: "FIX", reason: "Observed behavior" }] : [] })}\nCC_REPORT_END\n`);
  f.server.closeRun(runId, 0); await waitFor(() => f.journal().executions.find(e => e.id === runId)?.status === "done", "Planner successful end");
  failId = runId;
  const accept = () => f.call("accept_planner_report", { expected: f.expected(), runId });
  const failed = await accept(); assert.equal(failed.isError, true); assert.match(failed.text, /R8 consume publication failure/);
  assert.ok(f.task().coordinatorSessions.includes(runId)); assert.equal(f.journal().executions.find(e => e.id === runId)?.consumed, false);
  return { ...f, runId, accept, allow: () => { failId = undefined; }, fail: () => { failId = runId; },
    cold: () => { f.server.runRecords.delete(runId); invalidateJournal(f.data, f.tabId); f.restart(); return f.task(); } };
}
