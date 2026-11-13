import { object, id, text, unique, path, validatePlan, type Plan, type Finding } from "./task-types.ts";
import type { FixedExecution } from "./task-execution.ts";
import { assertExecutionEnded } from "./task-execution.ts";
import { scanWorkerReport } from "./task-report-scan.ts";

export type WorkerReport = {
  version: 1; runId: string; taskId: string | null; planVersion: number;
  evidence: string[]; plan: Plan | null;
  findings: Finding[]; resolved: string[]; baseFinal: string | null; unchanged: string[];
  decisions: { findingId: string; outcome: "FIX" | "PASS"; reason: string }[];
};
export function readWorkerReport(execution: FixedExecution, record: { status: string; logPath: string | null }): WorkerReport {
  if (execution.status !== "done") throw new Error("This run did not finish successfully.");
  assertExecutionEnded(execution);
  if (record.status !== "done" || !record.logPath || record.logPath !== execution.logPath) throw new Error("Missing server-bound successful run record.");
  // The whole server-bound log is scanned as a stream: only a report block's own bytes are bounded, never the transcript around it.
  const scanned = scanWorkerReport(record.logPath);
  if (!scanned) throw new Error("Expected exactly one bounded structured worker report.");
  const decoded = scanned.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(scanned)) throw new Error("Worker report is not valid UTF-8.");
  const report = JSON.parse(decoded);
  object(report, ["version", "runId", "taskId", "planVersion", "evidence", "plan", "findings", "resolved", "baseFinal", "unchanged", "decisions"]);
  if (report.version !== 1) throw new Error("Unsupported worker report version.");
  if (report.runId !== execution.id) throw new Error("Report belongs to another run.");
  if (report.taskId !== execution.taskId || report.planVersion !== execution.planVersion) throw new Error("Report belongs to another task version.");
  unique(report.evidence, path); unique(report.resolved, id); unique(report.unchanged, path);
  if (report.baseFinal !== null) id(report.baseFinal);
  if (report.plan !== null) validatePlan(report.plan);
  if (!Array.isArray(report.findings) || report.findings.length > 500 || !Array.isArray(report.decisions) || report.decisions.length > 500) throw new Error("Invalid worker report lists.");
  for (const f of report.findings) {
    object(f, ["id", "executionId", "text", "real", "minimal"]); id(f.id); text(f.text);
    if (f.executionId !== execution.id || typeof f.real !== "boolean" || typeof f.minimal !== "boolean") throw new Error("Wrong finding provenance.");
  }
  for (const d of report.decisions) {
    object(d, ["findingId", "outcome", "reason"]); id(d.findingId); text(d.reason);
    if (!["FIX", "PASS"].includes(d.outcome)) throw new Error("Invalid Planner decision.");
  }
  return report as WorkerReport;
}
export function reportInstructions(execution: FixedExecution): string {
  return `Return one JSON object between separate CC_REPORT_BEGIN and CC_REPORT_END lines. Do not repeat these delimiters elsewhere. Schema: version (1), runId (${JSON.stringify(execution.id)}), taskId (${JSON.stringify(execution.taskId)}), planVersion (${execution.planVersion}), evidence (relative paths), plan (a complete task Plan for planning, otherwise null), findings (id, executionId, text, real, minimal), resolved (finding ids), baseFinal (run id or null), unchanged (relative paths), decisions (findingId, outcome FIX or PASS, reason). Empty lists are []. Your report does not approve or launch anything.`;
}
