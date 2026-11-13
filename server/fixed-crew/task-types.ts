import { validateAssignment } from "./assignment.ts";
import { FIXED_CREW, type Assignment, type FixedSlot } from "./roster.ts";

export const STAGES = ["discussion", "planned", "rough", "inspected", "polish", "checks", "review", "fix", "final", "shipping", "complete", "interrupted"] as const;
export const ACTIONS = ["assist", "rough", "build", "polish", "check", "visualCheck", "inspect", "review", "checkpoint", "fix", "final", "commit", "push", "publish"] as const;
export type Stage = typeof STAGES[number];
export type ActionKind = typeof ACTIONS[number];
export type Revision = { digest: string; files: Record<string, string> };
export type Plan = {
  id: string; scope: string; criteria: string[];
  blocks: { id: string; scope: string; paths: string[] }[];
  risk: { level: "small" | "standard" | "high" | "unknown"; reason: string; paths: string[]; verification: string[] };
  visibleWork: boolean; large: boolean; integration: boolean; design: boolean;
  paths: string[]; consumers: string[]; sharedInputs: string[]; checks: string[];
  shipping: ("commit" | "push" | "publish")[];
  reviewReason: string;
};
export type Approval = { planVersion: number; digest: string; revision: string | null };
export type Execution = {
  id: string; taskId: string; planVersion: number; role: FixedSlot; sessionId: string;
  kind: ActionKind; status: "reserved" | "running" | "success" | "failed" | "interrupted";
  revision: string; resultRevision: string | null; processEnd: "unknown" | "confirmed" | "failed";
  verified: boolean; evidence: string[]; findings: string[]; route: "normal" | "minimal" | "postFinal";
  change: "none" | "minimal" | "logic"; batch: string[];
};
export type Evidence = { executionId: string; revision: string; evidence: string[] };
export type Review = Evidence & { final: boolean; findings: string[]; resolved: string[]; baseFinal: string | null; unchanged: string[] };
export type Check = Evidence & { name: string };
export type Finding = { id: string; executionId: string; text: string; real: boolean; minimal: boolean };
export type Decision = { outcome: "FIX" | "PASS"; reason: string };
export type Task = {
  schemaVersion: 1; id: string; tabId: string; plan: Plan; planVersion: number; planDigest: string; recordRevision: number;
  stage: Stage; reviewPolicy: { finalRequired: boolean; reason: string };
  coordinatorSessions: string[];
  seats: Partial<Record<FixedSlot, Assignment>>;
  ownerScopeApproval: Approval | null; ownerRoughApproval: Approval | null; roughRevision: string | null;
  revision: Revision; revisions: Revision[]; executions: Execution[]; checks: Check[]; reviews: Review[]; checkpoints: Evidence[];
  findings: Finding[]; triage: Record<string, Decision>; requests: { id: string; digest: string; result: { recordRevision: number; executionId: string | null } }[];
};

export function object(value: unknown, keys: readonly string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) throw new Error("Invalid task object keys");
}
export function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error("Invalid task text");
}
export function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
    || Object.hasOwn(Object.prototype, value)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) throw new Error("Invalid task identity");
}
export function path(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 512 || !value || value.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) || /[\\:\x00-\x1f<>"|?*]/.test(value)) throw new Error("Unsafe task path");
}
export function array(value: unknown, validate: (item: any) => void, maximum = 500): asserts value is any[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Invalid task list");
  for (const item of value) validate(item);
}
export function unique(value: unknown, validate: (item: any) => void): asserts value is string[] {
  array(value, validate);
  if (new Set(value).size !== value.length) throw new Error("Duplicate task reference");
}
export function enumeration(value: unknown, allowed: readonly unknown[]): void {
  if (!allowed.includes(value)) throw new Error("Invalid task enum");
}
export function integer(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Invalid task version");
}
export function hash(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid task digest");
}
function bool(value: unknown): void { enumeration(value, [true, false]); }
export function validatePlan(raw: unknown): Plan {
  object(raw, ["id", "scope", "criteria", "blocks", "risk", "visibleWork", "large", "integration", "design", "paths", "consumers", "sharedInputs", "checks", "shipping", "reviewReason"]);
  id(raw.id); text(raw.scope); unique(raw.criteria, text); text(raw.reviewReason);
  array(raw.blocks, (block) => { object(block, ["id", "scope", "paths"]); id(block.id); text(block.scope); unique(block.paths, path); });
  if (!raw.criteria.length || !raw.blocks.length || new Set(raw.blocks.map((b: any) => b.id)).size !== raw.blocks.length) throw new Error("Task needs criteria and unique blocks");
  object(raw.risk, ["level", "reason", "paths", "verification"]);
  enumeration(raw.risk.level, ["small", "standard", "high", "unknown"]); text(raw.risk.reason);
  unique(raw.risk.paths, path); unique(raw.risk.verification, text);
  for (const key of ["visibleWork", "large", "integration", "design"]) bool(raw[key]);
  for (const key of ["paths", "consumers", "sharedInputs"]) unique(raw[key], path);
  unique(raw.checks, id); unique(raw.shipping, (v) => enumeration(v, ["commit", "push", "publish"]));
  if (!raw.paths.length || !raw.checks.length) throw new Error("Task needs paths and required checks");
  const paths = [...raw.paths, ...raw.consumers, ...raw.sharedInputs];
  for (const p of [...raw.risk.paths, ...raw.blocks.flatMap((b: any) => b.paths)]) if (!paths.includes(p)) throw new Error("Unapproved task path reference");
  return structuredClone(raw) as Plan;
}
function evidence(raw: unknown, extra: string[] = []): void {
  object(raw, ["executionId", "revision", "evidence", ...extra]); id(raw.executionId); hash(raw.revision); unique(raw.evidence, path);
  if (!raw.evidence.length) throw new Error("Evidence references required");
}
export function validateTask(raw: unknown): Task {
  object(raw, ["schemaVersion", "id", "tabId", "plan", "planVersion", "planDigest", "recordRevision", "stage", "reviewPolicy", "coordinatorSessions", "seats", "ownerScopeApproval", "ownerRoughApproval", "roughRevision", "revision", "revisions", "executions", "checks", "reviews", "checkpoints", "findings", "triage", "requests"]);
  enumeration(raw.schemaVersion, [1]); id(raw.id); id(raw.tabId); validatePlan(raw.plan);
  integer(raw.planVersion); integer(raw.recordRevision); hash(raw.planDigest); enumeration(raw.stage, STAGES);
  unique(raw.coordinatorSessions, id);
  object(raw.reviewPolicy, ["finalRequired", "reason"]); bool(raw.reviewPolicy.finalRequired); text(raw.reviewPolicy.reason);
  if (!raw.seats || typeof raw.seats !== "object" || Array.isArray(raw.seats)) throw new Error("Invalid selected seats");
  for (const [slot, seat] of Object.entries(raw.seats)) {
    enumeration(slot, FIXED_CREW.map((s) => s.slot));
    if (!seat || typeof seat !== "object" || Array.isArray(seat)) throw new Error("Invalid seat snapshot");
    object(seat, Object.hasOwn(seat, "advisor") ? ["cli", "model", "effort", "advisor"] : ["cli", "model", "effort"]);
    validateAssignment(seat);
  }
  for (const approval of [raw.ownerScopeApproval, raw.ownerRoughApproval]) if (approval !== null) {
    object(approval, ["planVersion", "digest", "revision"]); integer(approval.planVersion); hash(approval.digest);
    if (approval.revision !== null) hash(approval.revision);
    if (approval.planVersion !== raw.planVersion || approval.digest !== raw.planDigest) throw new Error("Stale saved approval");
  }
  if (raw.ownerScopeApproval?.revision !== null && raw.ownerScopeApproval !== null) throw new Error("Scope approval cannot approve a file revision");
  if (raw.ownerRoughApproval !== null && (!raw.roughRevision || raw.ownerRoughApproval.revision !== raw.roughRevision)) throw new Error("Rough approval reference mismatch");
  if (raw.roughRevision !== null) hash(raw.roughRevision);
  object(raw.revision, ["digest", "files"]); hash(raw.revision.digest);
  const files = raw.revision.files;
  if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length > 10000) throw new Error("Invalid revision files");
  for (const [name, digest] of Object.entries(files)) { path(name); if (digest !== "missing" && digest !== "directory") hash(digest); }
  array(raw.revisions, (r) => {
    object(r, ["digest", "files"]); hash(r.digest);
    if (!r.files || typeof r.files !== "object" || Array.isArray(r.files) || Object.keys(r.files).length > 10000) throw new Error("Invalid saved coverage");
    for (const [name, value] of Object.entries(r.files)) { path(name); if (value !== "missing" && value !== "directory") hash(value); }
  });
  const revisions = new Set(raw.revisions.map((r: Revision) => r.digest));
  if (revisions.size !== raw.revisions.length || !revisions.has(raw.revision.digest)) throw new Error("Invalid revision references");
  array(raw.executions, (e) => {
    object(e, ["id", "taskId", "planVersion", "role", "sessionId", "kind", "status", "revision", "resultRevision", "processEnd", "verified", "evidence", "findings", "route", "change", "batch"]);
    id(e.id); id(e.sessionId); integer(e.planVersion); enumeration(e.role, Object.keys(raw.seats));
    if (e.taskId !== raw.id || e.planVersion > raw.planVersion) throw new Error("Wrong execution identity");
    enumeration(e.kind, ACTIONS); enumeration(e.status, ["reserved", "running", "success", "failed", "interrupted"]);
    hash(e.revision); if (e.resultRevision !== null) hash(e.resultRevision);
    if (!revisions.has(e.revision) || e.resultRevision !== null && !revisions.has(e.resultRevision)) throw new Error("Unknown execution coverage");
    enumeration(e.processEnd, ["unknown", "confirmed", "failed"]); bool(e.verified); unique(e.evidence, path); unique(e.findings, id);
    enumeration(e.route, ["normal", "minimal", "postFinal"]); enumeration(e.change, ["none", "minimal", "logic"]); unique(e.batch, id);
    if (e.verified && (e.status !== "success" || e.processEnd !== "confirmed" || !e.evidence.length || e.resultRevision === null)) throw new Error("Invalid verified execution");
  });
  if (new Set(raw.executions.map((e: any) => e.id)).size !== raw.executions.length) throw new Error("Duplicate execution");
  const executions = new Map<string, Execution>(raw.executions.map((e: Execution) => [e.id, e]));
  const reference = (entry: any, kind: string) => {
    const run = executions.get(entry.executionId);
    if (!run || run.kind !== kind || !run.verified || run.status !== "success" || run.processEnd !== "confirmed" || run.resultRevision !== entry.revision) throw new Error("Invalid execution evidence reference");
  };
  array(raw.checks, (c) => { evidence(c, ["name"]); id(c.name); if (!raw.plan.checks.includes(c.name)) throw new Error("Unknown check"); reference(c, "check"); });
  array(raw.checkpoints, (c) => { evidence(c); reference(c, "checkpoint"); });
  array(raw.findings, (f) => {
    object(f, ["id", "executionId", "text", "real", "minimal"]); id(f.id); text(f.text); bool(f.real); bool(f.minimal);
    if (!["review", "final"].includes(executions.get(f.executionId)?.kind ?? "")) throw new Error("Unknown finding execution");
  });
  if (new Set(raw.findings.map((f: any) => f.id)).size !== raw.findings.length) throw new Error("Duplicate finding");
  array(raw.reviews, (r) => {
    evidence(r, ["final", "findings", "resolved", "baseFinal", "unchanged"]); bool(r.final); unique(r.findings, id); unique(r.resolved, id); unique(r.unchanged, path);
    if (r.baseFinal !== null) id(r.baseFinal);
    reference(r, r.final ? "final" : "review");
    for (const f of [...r.findings, ...r.resolved]) if (!raw.findings.some((finding: Finding) => finding.id === f)) throw new Error("Unknown review finding");
    if (r.findings.some((f: string) => !raw.findings.some((finding: Finding) => finding.id === f && finding.executionId === r.executionId))) throw new Error("Wrong finding provenance");
  });
  for (const review of raw.reviews) if (review.baseFinal !== null && !raw.reviews.some((r: Review) => r.final && r.executionId === review.baseFinal)) throw new Error("Unknown base final reference");
  if (!raw.triage || typeof raw.triage !== "object" || Array.isArray(raw.triage)) throw new Error("Invalid triage");
  for (const [key, d] of Object.entries(raw.triage)) {
    if (!raw.findings.some((f: Finding) => f.id === key && f.real)) throw new Error("Unknown real finding");
    object(d, ["outcome", "reason"]); enumeration(d.outcome, ["FIX", "PASS"]); text(d.reason);
  }
  array(raw.requests, (r) => {
    object(r, ["id", "digest", "result"]); id(r.id); hash(r.digest); object(r.result, ["recordRevision", "executionId"]); integer(r.result.recordRevision);
    if (r.result.recordRevision > raw.recordRevision || (r.result.executionId !== null && !executions.has(r.result.executionId))) throw new Error("Invalid saved request result");
  }, 2000);
  if (new Set(raw.requests.map((r: any) => r.id)).size !== raw.requests.length) throw new Error("Duplicate request");
  return structuredClone(raw) as Task;
}
