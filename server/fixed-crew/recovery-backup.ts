import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { publishConfigFile } from "../config-files.ts";

export type BackupEntry = { path: string; size: number | null; sha256: string | null };
export const hashBytes = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function noLinks(path: string): void {
  const parent = dirname(path);
  if (parent !== path) noLinks(parent);
  try { if (lstatSync(path).isSymbolicLink()) throw new Error("Recovery refuses linked paths."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function entryFor(root: string, path: string): BackupEntry {
  const source = join(root, path);
  noLinks(source);
  try {
    if (!lstatSync(source).isFile()) throw new Error("Recovery source is not a regular file.");
    const bytes = readFileSync(source);
    return { path, size: bytes.length, sha256: hashBytes(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { path, size: null, sha256: null };
  }
}
export function backupInventory(root: string): BackupEntry[] {
  const paths = ["config/workspaces.json", "config/projects.json", "config/setups.json", "config/launch-safety.json", "requests.json"];
  const avatars = join(root, "avatars");
  noLinks(avatars);
  try {
    for (const name of readdirSync(avatars).sort()) {
      const info = lstatSync(join(avatars, name));
      if (info.isFile() && !info.isSymbolicLink()) paths.push(`avatars/${name}`);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return paths.map((path) => entryFor(root, path));
}
export function verifyBackup(archive: string, entries: BackupEntry[]): void {
  for (const entry of entries) {
    if (entry.sha256 === null) continue;
    const destination = join(archive, entry.path);
    noLinks(destination);
    const bytes = readFileSync(destination);
    const actualHash = hashBytes(bytes);
    if (actualHash !== entry.sha256) throw new Error("Legacy backup verification failed.");
    if (bytes.length !== entry.size) throw new Error("Legacy backup size verification failed.");
  }
}
export function copyBackup(root: string, archive: string, entries: BackupEntry[]): void {
  for (const entry of entries) {
    if (entry.sha256 === null) continue;
    const source = join(root, entry.path), destination = join(archive, entry.path);
    noLinks(source); noLinks(destination);
    mkdirSync(dirname(destination), { recursive: true });
    try { copyFileSync(source, destination, constants.COPYFILE_EXCL); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (hashBytes(readFileSync(destination)) !== entry.sha256) {
        // A crash can leave a partial exclusive copy. Repair only from the
        // still-identical source, with atomic synced publication.
        const original = readFileSync(source);
        if (hashBytes(original) !== entry.sha256) throw new Error("Recovery source changed during preparation.");
        publishConfigFile(original, destination, true);
      }
    }
  }
  verifyBackup(archive, entries);
}
export function saveRecoveryRecord(path: string, record: unknown): void {
  noLinks(path);
  publishConfigFile(JSON.stringify(record, null, 2) + "\n", path, true);
}
