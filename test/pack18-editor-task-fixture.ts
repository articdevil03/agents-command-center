import { createTask } from "../server/fixed-crew/task-plan.ts";
import { digest, fingerprint } from "../server/fixed-crew/task-revision.ts";

// ---- Pack 26 Block 3c (fixed crew tasks) ----
// A task record the server's own createTask builds and validates, moved to a stage the way its setters leave it. Plan files are
// fingerprinted in `folder`, so the record's revision is the folder's real one (missing files count as "missing").
export type TaskStage = "planned" | "approved" | "inspected" | "roughApproved" | "staleRough" | "staleReview" | "fixOpen" | "interrupted";
export const TASK_SEATS = { leader: { cli: "codex", model: "gpt-6.1-sol", effort: "medium" }, planner: { cli: "codex", model: "gpt-6.1-sol", effort: "xhigh" }, coder: { cli: "codex", model: "gpt-6.1-sol", effort: "medium" },
  reviewer1: { cli: "claude", model: "claude-sonnet-5-5", effort: "high" }, fixer1: { cli: "codex", model: "gpt-6.1-sol", effort: "medium" } };
export function taskFixture(folder: string, tabId: string, stage: TaskStage, text: { scope?: string; finding?: string } = {}) {
  const plan = { id: "plan1", scope: text.scope ?? "Add the task panel above the chat", criteria: ["The decision shows risk, reviews and the final review", "Approvals carry the server's identity"],
    blocks: [{ id: "panel", scope: "Task panel", paths: ["src/panel.js"] }, { id: "styles", scope: "Panel styles", paths: ["src/panel.css"] }],
    risk: { level: "standard", reason: "Visible page change; approvals stay on the server.", paths: ["src/panel.js"], verification: ["Browser test of the panel"] },
    visibleWork: true, large: false, integration: false, design: false, paths: ["src/panel.js", "src/panel.css"], consumers: ["src/app.js"], sharedInputs: [],
    checks: ["unit"], shipping: ["commit"], reviewReason: "Contained change with no stored-data or shared behaviour changes." };
  const task: any = createTask("task-one", tabId, plan as any, structuredClone(TASK_SEATS) as any, fingerprint(folder, plan as any));
  const now = task.revision.digest, old = { files: { "src/panel.js": "a".repeat(64) }, digest: "" };
  old.digest = digest(old.files);
  const run = (id: string, kind: string, role: string, evidence: string[], revision = now) => ({ id, taskId: task.id, planVersion: 1, role, sessionId: `session-${id}`, kind, status: "success",
    revision, resultRevision: revision, processEnd: "confirmed", verified: true, evidence, findings: [] as string[], route: "normal", change: "none", batch: [] as string[] });
  if (stage === "planned") return task;
  task.ownerScopeApproval = { planVersion: 1, digest: task.planDigest, revision: null }; task.recordRevision = 2;
  if (stage === "approved") return task;
  if (["inspected", "roughApproved", "staleRough"].includes(stage)) {
    if (stage === "staleRough") task.revisions.unshift(old);
    const at = stage === "staleRough" ? old.digest : now;
    task.executions = [run("rough1", "rough", "coder", ["shots/rough-desktop.png"], at), run("visual1", "visualCheck", "leader", ["shots/rough-desktop.png", "shots/rough-narrow.png"], at), run("inspect1", "inspect", "leader", ["notes/leader-inspection.md"], at)];
    Object.assign(task, { stage: "inspected", roughRevision: at, recordRevision: 5 });
    if (stage === "roughApproved") task.ownerRoughApproval = { planVersion: 1, digest: task.planDigest, revision: now };
    return task;
  }
  if (stage === "interrupted") {
    task.executions = [{ ...run("build1", "build", "coder", []), status: "interrupted", processEnd: "unknown", verified: false, resultRevision: null }];
    return Object.assign(task, { stage: "interrupted", recordRevision: 3 });
  }
  const at = stage === "staleReview" ? old.digest : now;
  if (stage === "staleReview") task.revisions.unshift(old);
  task.executions = [run("build1", "build", "coder", ["src/panel.js"], at), run("check1", "check", "leader", ["logs/unit.log"], at), run("review1", "review", "reviewer1", ["reviews/round1.md"], at)];
  task.checks = [{ executionId: "check1", revision: at, evidence: ["logs/unit.log"], name: "unit" }];
  task.reviews = [{ executionId: "review1", revision: at, evidence: ["reviews/round1.md"], final: false, findings: [] as string[], resolved: [], baseFinal: null, unchanged: [] }];
  if (stage === "fixOpen") {
    task.findings = [{ id: "finding1", executionId: "review1", text: text.finding ?? "The approve button stays enabled after a refusal", real: true, minimal: false },
      { id: "finding2", executionId: "review1", text: "A comment names the old file", real: true, minimal: true }];
    task.executions[2].findings = task.reviews[0].findings = ["finding1", "finding2"];
    task.triage = { finding1: { outcome: "FIX", reason: "Wrong behaviour the owner would notice" }, finding2: { outcome: "PASS", reason: "Comment only" } };
  }
  return Object.assign(task, { stage: "review", recordRevision: 7 });
}

// ---- S-F3 (Finished tasks) ----
// Shared row/detail metadata, sorted by ID, matching the verified server projection.
export const archiveMetadata = (n: number) => ({ scope: ["Add the task panel above the chat", "Keep finished task history readable", "Show recorded checks and reviews"][n - 1] ?? `Finished task ${n}`,
  completedAt: `2026-11-${String(13 - ((n - 1) % 10)).padStart(2, "0")}T14:30:00.000Z` });
export const archiveItems = (count: number, from = 0) => Array.from({ length: count }, (_, i) => ({ id: `finished-${String(from + i + 1).padStart(3, "0")}`, kind: "task", ...archiveMetadata(from + i + 1) }));
// A finished task as getFixedTaskArchive returns it: the completed snapshot, its retired journal runs and its manifest, all bound to one
// tab and task. Built on the review record above: the FIX finding resolved by a second review, a final review, a local commit that was
// recorded and a push that failed. Publish is planned and never ran, so nothing may call it shipped.
export function archiveFixture(folder: string, tabId: string, taskId: string, text: { scope?: string; finding?: string; reason?: string; evidence?: string } = {}) {
  const metadata = archiveMetadata(Number(taskId.match(/finished-(\d+)/)?.[1] ?? 1));
  const task: any = { ...taskFixture(folder, tabId, "fixOpen", { scope: text.scope ?? metadata.scope, finding: text.finding }), id: taskId };
  const at = task.revision.digest;
  const run = (id: string, kind: string, role: string, evidence: string[], status = "success") => ({ id, taskId, planVersion: 1, role, sessionId: `session-${id}`, kind, status,
    revision: at, resultRevision: status === "success" ? at : null, processEnd: "confirmed", verified: status === "success", evidence, findings: [] as string[], route: "normal", change: "none", batch: [] as string[] });
  for (const execution of task.executions) execution.taskId = taskId;
  task.executions.push(run("fix1", "fix", "fixer1", ["src/panel.js"]), run("review2", "review", "reviewer1", ["reviews/round2.md"]), run("final1", "final", "reviewer1", ["reviews/final.md"]),
    run("commit1", "commit", "leader", [text.evidence ?? "git/commit-4f2a9c1.txt"]), run("push1", "push", "leader", ["logs/push-refused.log"], "failed"));
  task.reviews.push({ executionId: "review2", revision: at, evidence: ["reviews/round2.md"], final: false, findings: [], resolved: ["finding1"], baseFinal: null, unchanged: [] },
    { executionId: "final1", revision: at, evidence: ["reviews/final.md"], final: true, findings: [], resolved: [], baseFinal: null, unchanged: [] });
  task.plan.shipping = ["commit", "push", "publish"];
  Object.assign(task, { stage: "complete", recordRevision: 12 });
  const assignment = { cli: "codex", model: "gpt-6.1-sol", effort: "medium" };
  const journal = (id: string, kind: string, role: string, status: string, owner: string | null = taskId) => ({ id, tabId, taskId: owner, planVersion: owner ? 1 : 0, role, selectedSlot: role,
    selectionReason: `The Planner selected ${role} for ${kind}`, assignment, kind, status, processEnded: true, consumed: true, logPath: `logs/${id}.log` });
  const executions = [journal("plan-run", "planning", "planner", "done", null), journal("build-run", "build", "coder", "done"), journal("push-run", "push", "leader", "failed")];
  const identity = { bytes: 1024, hash: "c".repeat(64) };
  const manifest = { version: 1, tabId, taskId, planVersion: 1, recordRevision: 12, reason: text.reason ?? "The leader finished it after the final review", completedAt: metadata.completedAt,
    source: identity, task: identity, executions: executions.map((execution) => ({ id: execution.id, bytes: 512, hash: "d".repeat(64) })) };
  return { task, executions, manifest };
}

