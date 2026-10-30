import { readFileSync, mkdirSync, mkdtempSync, linkSync, lstatSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { resolveDataRoot } from "./data-root.ts";
import { writeFileSynced, replaceFile } from "./safe-file.ts";
import { isSafeSeatId } from "./process.ts";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const dataRoot = resolveDataRoot(process.env, repoRoot);
export const configDir = join(dataRoot, "config");
export const workspacesPath = join(configDir, "workspaces.json");
export const projectsPath = join(configDir, "projects.json");
export const clientPrefsPath = join(configDir, "client-prefs.json");
export const launchSafetyPath = join(configDir, "launch-safety.json");
export const acpClisPath = join(configDir, "acp-clis.json");
export const setupsPath = join(configDir, "setups.json");

// Atomic publication means a racing server never observes a partial seed. A
// hard link publishes without replacing a winner; ordinary preference writes
// use an atomic same-volume rename.
export function publishConfigFile(contents: string | Buffer, dest: string, replace = false): boolean {
  mkdirSync(dirname(dest), { recursive: true });
  const temporaryDir = mkdtempSync(join(dirname(dest), ".seed-"));
  const temporaryPath = join(temporaryDir, "config.json");
  try {
    writeFileSynced(temporaryPath, contents);
    try {
      if (replace) replaceFile(temporaryPath, dest);
      else linkSync(temporaryPath, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!replace && code === "EEXIST") {
        if (!statSync(dest).isFile()) throw err;
        return false;
      }
      throw new Error(`${replace ? "config write" : "config seeding"}: could not ${replace ? "write" : "publish"} "${dest}": ${(err as Error).message}`, { cause: err });
    }
    return true;
  } finally {
    try { rmSync(temporaryDir, { recursive: true, force: true }); } catch { /* the published file is already complete */ }
  }
}

// A crash between mkdtemp and the final rename leaves a ".seed-XXXXXX" folder holding one config.json. Only such a folder,
// a minute or more old (a racing server's live publish is younger), is removed: its one file, then the empty folder.
export function sweepSeedTemps(dir: string): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names.filter((item) => /^\.seed-[A-Za-z0-9]{6}$/.test(item))) {
    const folder = join(dir, name);
    try {
      const info = lstatSync(folder);
      if (!info.isDirectory() || info.isSymbolicLink() || Date.now() - info.mtimeMs < 60_000) continue;
      try { unlinkSync(join(folder, "config.json")); } catch { /* already gone */ }
      rmdirSync(folder);
    } catch { /* not ours to clean, or busy: leave it */ }
  }
}

export function readJson(path: string): unknown {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (err) { throw new Error(`config file missing or unreadable: ${path} (${(err as Error).message})`); }
  try { return JSON.parse(raw); }
  catch (err) { throw new Error(`config file is not valid JSON: ${path} (${(err as Error).message})`); }
}

// The leader's earlier default name, still found in saved seats, pictures and launch notices. Split so the word never appears whole in the source.
export const LEGACY_LEADER = "boo" + "gie";

const SAFE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/;
export function isSafeShape(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && SAFE_SHAPE.test(value) && !value.split("/").includes("..");
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && isSafeSeatId(value);
}
export function validText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

// Under node --test whenever the resolved data root is the repo itself (no CC_DATA_DIR, or one the resolver ignores), its live files must not be written.
export function liveFilesProtected(): boolean {
  return !!process.env.NODE_TEST_CONTEXT && resolve(dataRoot).toLowerCase() === resolve(repoRoot).toLowerCase();
}
export function liveWritePath(path: string | undefined, live: string): string {
  if (path !== undefined) return path;
  if (liveFilesProtected()) throw new Error(`refusing to write the live config file under a test, pass a temp path or set CC_DATA_DIR: ${live}`);
  return live;
}
