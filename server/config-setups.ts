import { readFileSync } from "node:fs";
import { KINDS, validateSetup, type ProcessKind, type Seat, type Setup, type Step } from "./process.ts";
import { setupsPath, publishConfigFile, liveWritePath, isObject, validSlug, validText } from "./config-files.ts";
import { migrateRoles, logMigration } from "./config-migrate.ts";
import { checkSeatValues } from "./config.ts";

// ---- Saved setups (config/setups.json): crews the user kept by name, at most MAX_SAVED_SETUPS. A tab keeps its own copy of whatever it uses. ----
export type SavedSetup = { id: string; name: string; kind: ProcessKind; crew: Seat[]; lookPause: boolean; steps: Step[] };
export const MAX_SAVED_SETUPS = 50;
export const setupIdFromName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
function checkSavedSetup(value: unknown, strict: boolean, path: string): SavedSetup {
  if (!isObject(value) || !validSlug(value.id) || !validText(value.name) || value.name.length > 60 || typeof value.kind !== "string" || !Object.hasOwn(KINDS, value.kind)) throw new Error(`saved setups malformed, bad setup entry: ${path}`);
  let setup: Setup & { lookPause: boolean };
  try { setup = validateSetup({ crew: value.crew, lookPause: value.lookPause }); }
  catch (err) { throw new Error(`saved setups malformed, invalid crew or steps in "${value.id}" (${(err as Error).message}): ${path}`, { cause: err }); }
  checkSeatValues(`setup-${value.id}`, setup.crew, strict, path);
  return { id: value.id, name: value.name.trim(), kind: value.kind as ProcessKind, crew: setup.crew, lookPause: setup.lookPause, steps: setup.steps };
}
export function readSetups(path: string = setupsPath): SavedSetup[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error(`saved setups are unreadable: ${path} (${(err as Error).message}); fix or delete it`); }
  if (!isObject(raw) || !Array.isArray(raw.setups) || raw.setups.length > MAX_SAVED_SETUPS) throw new Error(`saved setups malformed, expected { setups: [] } with at most ${MAX_SAVED_SETUPS}: ${path}`);
  const list = raw.setups.map((item) => {
    const migrated = isObject(item) ? migrateRoles(item) : null;
    if (migrated) logMigration(`${path}|${String(item.id)}`, `saved setup ${String(item.id)}`, migrated.oldStepIds);
    return checkSavedSetup(item, false, path);
  });
  if (new Set(list.map((item) => item.id)).size !== list.length) throw new Error(`saved setups malformed, duplicate id: ${path}`);
  return list;
}
export function writeSetups(setups: SavedSetup[], path?: string): void {
  if (setups.length > MAX_SAVED_SETUPS) throw new Error(`at most ${MAX_SAVED_SETUPS} saved setups`);
  const target = liveWritePath(path, setupsPath);
  const checked = setups.map((item) => checkSavedSetup(item, true, target));
  if (new Set(checked.map((item) => item.id)).size !== checked.length) throw new Error("that name is already used by another saved setup");
  publishConfigFile(JSON.stringify({ setups: checked }, null, 2) + "\n", target, true);
}
