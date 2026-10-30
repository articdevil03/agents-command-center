import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { deriveSteps, isKnownRole, legacySetup, LEADER_ROLE } from "./process.ts";
import { isObject, isSafeShape, publishConfigFile } from "./config-files.ts";

// ---- Pre-setups files: an old tab (a kind and a process id, a crew of name/CLI/model/effort/picture, maybe a tab advisor) becomes a tab that carries its own crew. ----
// Its saved name, CLI, model, effort and picture are laid over the seats of the crew it used to get; the tab advisor moves onto a Claude leader.
function migrateTab(tab: Record<string, unknown>, path: string): Record<string, unknown> {
  let base;
  try { base = legacySetup(tab.kind, tab.process); }
  catch { throw new Error(`config file malformed, unknown kind/process "${String(tab.kind)}/${String(tab.process)}" in tab "${String(tab.id)}": ${path}`); }
  if ((tab.crew as unknown[]).length !== base.crew.length) throw new Error(`config file malformed, crew slot count does not match process for tab "${String(tab.id)}": ${path}`);
  const saved = new Map<string, Record<string, unknown>>();
  for (const member of tab.crew as unknown[]) {
    if (!isObject(member) || typeof member.slot !== "string" || !base.crew.some((seat) => seat.slot === member.slot)) throw new Error(`config file malformed, invalid crew member in tab "${String(tab.id)}": ${path}`);
    if (saved.has(member.slot)) throw new Error(`config file malformed, invalid slot/model/effort for "${String(tab.id)}.${member.slot}": ${path}`);
    saved.set(member.slot, member);
  }
  if (tab.advisor !== undefined && (!isObject(tab.advisor) || !isSafeShape(tab.advisor.model))) throw new Error(`config file malformed, invalid advisor for tab "${String(tab.id)}": ${path}`);
  const crew = base.crew.map((seat) => {
    const old = saved.get(seat.slot)!;
    const next = { ...seat, name: old.name, cli: old.cli, model: old.model, effort: old.effort, ...(old.pic !== undefined ? { pic: old.pic } : {}) } as Record<string, unknown>;
    if (seat.isLeader && isObject(tab.advisor) && old.cli === "claude") next.advisor = tab.advisor.model;
    return next;
  });
  const { process: _process, advisor: _advisor, ...rest } = tab;
  return { ...rest, setupName: base.name, crew, lookPause: base.lookPause, steps: base.steps };
}

// ---- Role-less files: a tab or saved setup written while steps were stored (custom, zero or stale steps, free-text roles). ----
// Nothing here throws on an odd shape: a crew it cannot read is left for the normal check to refuse. Returns null when nothing changed.
const SUFFIX = /(?:\s+\d+|\s*\([^)]*\))+$/;
type Raw = Record<string, unknown>;
const raws = (value: unknown): Raw[] => Array.isArray(value) ? value.filter(isObject) : [];

function mappedRole(seat: Raw, steps: Raw[], kind: unknown): string {
  if (seat.isLeader === true) return LEADER_ROLE;
  const text = typeof seat.role === "string" ? seat.role.trim() : "";
  if (isKnownRole(text)) return text;
  const stripped = text.replace(SUFFIX, "").trim();
  if (isKnownRole(stripped)) return stripped;
  const owns = (step: Raw): boolean => Array.isArray(step.owners) && step.owners.includes(seat.slot);
  const works = steps.filter((step) => step.type === "work");
  const pairs = steps.filter((step) => step.type === "rounds").flatMap((step) => raws(step.pairs));
  if (seat.orchestrates === true) return "Planner";
  if (works.some((step) => owns(step) && /final/i.test(`${String(step.id)} ${String(step.label)}`))) return "Final reviewer";
  if (pairs.some((pair) => pair.reviewer === seat.slot)) return "Reviewer";
  if (seat.canWrite === true && works.some((step) => step !== steps[0] && owns(step))) return kind === "design" ? "Design coder" : "Coder";
  if (pairs.some((pair) => Array.isArray(pair.fixers) && pair.fixers.includes(seat.slot))) return "Fixer";
  return text || "Helper";
}

export function migrateRoles(entry: Raw): { oldStepIds: string } | null {
  const readable = Array.isArray(entry.crew) && entry.crew.length > 0 && entry.crew.every((seat) => isObject(seat) && typeof seat.slot === "string" && typeof seat.isLeader === "boolean");
  if (!readable) return null;
  const crew = entry.crew as Raw[];
  const stored = raws(entry.steps);
  // Only pack 18 wrote lookPause, and its roles are already the role shape: never re-mapped (the steps are derived again on every read).
  if (typeof entry.lookPause === "boolean") return null;
  const roles = crew.map((seat) => mappedRole(seat, stored, entry.kind));
  // At most one Planner (the first); only a Planner runs the process.
  let planner = false;
  roles.forEach((role, at) => {
    if (role !== "Planner") return;
    if (planner) roles[at] = "Helper";
    planner = true;
  });
  const lookPause = stored.some((step) => step.type === "look");
  const next = crew.map((seat, at) => {
    if (seat.orchestrates === true && roles[at] !== "Planner") { const { orchestrates: _dropped, ...rest } = seat; return { ...rest, role: roles[at] }; }
    return seat.role === roles[at] ? seat : { ...seat, role: roles[at] };
  });
  const steps = deriveSteps(next as never, lookPause);
  const oldStepIds = stored.map((step) => String(step.id)).join(", ") || "none";
  entry.crew = next; entry.lookPause = lookPause; entry.steps = steps;
  return { oldStepIds };
}
// One console line per tab (or saved setup), however often the file is read.
const logged = new Set<string>();
export function logMigration(key: string, what: string, oldStepIds: string): void {
  if (logged.has(key)) return;
  logged.add(key);
  console.log(`${what}: steps are now derived from the crew's roles (was: ${oldStepIds})`);
}

const tabsOf = (data: unknown): Raw[] => isObject(data) && Array.isArray(data.projects) ? raws(data.projects).flatMap((project) => raws(project.tabs)) : [];
export function migrateOldTabs(data: unknown, path: string): unknown {
  if (!isObject(data) || !Array.isArray(data.projects)) return data;
  return { ...data, projects: data.projects.map((project) => !isObject(project) || !Array.isArray(project.tabs) ? project : { ...project, tabs: project.tabs.map((tab) => {
    if (!isObject(tab) || !Array.isArray(tab.crew)) return tab;
    if (tab.steps === undefined) return migrateTab(tab, path);
    const migrated = migrateRoles(tab);
    if (migrated) logMigration(`${path}|${String(tab.id)}`, `tab ${String(tab.id)}`, migrated.oldStepIds);
    return tab;
  }) }) };
}

// ---- Backups: the first write over a file in an older shape keeps that file beside it once, before anything is replaced (an older version of the app cannot read the new shape). ----
// Written only when missing; a backup that cannot be made stops the write.
function keepBackup(target: string, name: string, isOldShape: (data: unknown) => boolean): void {
  const backup = join(dirname(target), name);
  if (existsSync(backup)) return;
  let raw: string;
  try { raw = readFileSync(target, "utf8"); } catch { return; }
  try { if (!isOldShape(JSON.parse(raw))) return; } catch { return; }
  publishConfigFile(raw, backup);
}
export function keepConfigBackups(target: string): void {
  keepBackup(target, "workspaces.before-setups.json", (data) => tabsOf(data).some((tab) => tab.steps === undefined));
  keepBackup(target, "workspaces.before-roles.json", (data) => tabsOf(data).some((tab) => Array.isArray(tab.crew) && tab.steps !== undefined && migrateRoles(JSON.parse(JSON.stringify(tab))) !== null));
}
