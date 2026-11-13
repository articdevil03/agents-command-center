import { isObject } from "../config-files.ts";
import { autoFillPreferences, freshPreferences, validatePreference, type AssignmentCatalogue, type CrewPreferences } from "./assignment.ts";
import { FIXED_CREW, type Assignment, type FixedSlot } from "./roster.ts";
import type { Workspaces } from "../config.ts";

export const ROLE_EXTRAS_BYTES = 8192;
export type FixedCrew = { version: 1; preferences: CrewPreferences; roleExtras: Partial<Record<FixedSlot, string>> };
export function exactKeys(value: unknown, allowed: readonly string[]): asserts value is Record<string, any> {
  if (!isObject(value)) throw new Error("Expected a crew object");
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unknown or locked crew field");
}
export function knownSlot(slot: unknown): asserts slot is FixedSlot {
  if (!FIXED_CREW.some((seat) => seat.slot === slot)) throw new Error("Unknown crew slot");
}
export function checkAssignmentKeys(value: unknown): void {
  if (value !== null) exactKeys(value, ["cli", "model", "effort", "advisor"]);
}
export function extraText(text: unknown): string {
  if (typeof text !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error("Invalid extra instructions");
  if (Buffer.byteLength(text, "utf8") > ROLE_EXTRAS_BYTES) throw new Error("Extra instructions are too long");
  return text;
}
export function freshFixedCrew(): FixedCrew { return { version: 1, preferences: freshPreferences(), roleExtras: {} }; }
export function validateFixedCrew(value: unknown): FixedCrew {
  exactKeys(value, ["version", "preferences", "roleExtras"]);
  if (value.version !== 1) throw new Error("Unsupported fixed crew version");
  exactKeys(value.preferences, FIXED_CREW.map((seat) => seat.slot));
  exactKeys(value.roleExtras, FIXED_CREW.map((seat) => seat.slot));
  const next = freshFixedCrew();
  for (const [slot, raw] of Object.entries(value.preferences)) {
    knownSlot(slot);
    exactKeys(raw, ["assignment", "source"]);
    checkAssignmentKeys(raw.assignment);
    const preference = validatePreference(raw);
    next.preferences[slot] = preference;
  }
  for (const [slot, raw] of Object.entries(value.roleExtras)) {
    knownSlot(slot);
    const text = extraText(raw);
    if (text.trim()) Object.assign(next.roleExtras, { [slot]: text });
  }
  return next;
}
export function setCrewAssignment(current: FixedCrew, slot: unknown, raw: unknown): FixedCrew {
  knownSlot(slot);
  checkAssignmentKeys(raw);
  const assignment = validatePreference({ assignment: raw, source: "user" }).assignment;
  const next = validateFixedCrew(current);
  next.preferences[slot] = { assignment, source: "user" };
  return next;
}
export function fillCrew(current: FixedCrew, catalogue: AssignmentCatalogue, refill = false): FixedCrew {
  const next = validateFixedCrew(current);
  for (const current of Object.values(next.preferences)) {
    if (refill && current.source === "auto") current.assignment = null;
  }
  next.preferences = autoFillPreferences(next.preferences, catalogue);
  return next;
}
export function setCrewRoleExtra(current: FixedCrew, slot: unknown, raw: unknown): FixedCrew {
  knownSlot(slot);
  const text = extraText(raw);
  const next = validateFixedCrew(current);
  if (text.trim()) next.roleExtras[slot] = text;
  else delete next.roleExtras[slot];
  return next;
}
// Creation accepts choices, never client-supplied preference sources or defaults.
export function creationCrew(choices: unknown = {}, auto: unknown = false, catalogue: AssignmentCatalogue = { clis: [] }): FixedCrew {
  exactKeys(choices, FIXED_CREW.map((seat) => seat.slot));
  if (typeof auto !== "boolean") throw new Error("autoAssign must be true or false");
  let next = freshFixedCrew();
  for (const [slot, assignment] of Object.entries(choices)) next = setCrewAssignment(next, slot, assignment);
  return auto ? fillCrew(next, catalogue) : next;
}
export function assignments(fixed: FixedCrew): Assignment[] {
  return Object.values(fixed.preferences).flatMap((preference) => preference.assignment ? [preference.assignment] : []);
}
export function preserveFutureCrews(saved: unknown, next: Workspaces): void {
  if (!isObject(saved) || !Array.isArray(saved.projects)) return;
  const originals = saved.projects.flatMap((project) => isObject(project) && Array.isArray(project.tabs) ? project.tabs : []);
  for (const tab of originals) {
    if (!isObject(tab) || !isObject(tab.fixedCrew) || typeof tab.fixedCrew.version !== "number" || tab.fixedCrew.version <= 1) continue;
    const replacement = next.projects.flatMap((project) => project.tabs).find((item) => item.id === tab.id);
    if (replacement && JSON.stringify(replacement.fixedCrew) !== JSON.stringify(tab.fixedCrew)) throw new Error("Future crew settings cannot be overwritten");
  }
}
