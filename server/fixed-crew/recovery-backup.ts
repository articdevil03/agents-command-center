import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { publishConfigFile } from "../config-files.ts";
import { resolveOwnedRoot, assertOwnedPath } from "../owned-path.js";

export type BackupEntry = { path: string; size: number | null; sha256: string | null };
export const hashBytes = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const recoveryRoots = new Map<string, ReturnType<typeof resolveOwnedRoot>>();
// Keep successful pins after refusal. Only a restart may adopt a replaced root.
export function noLinks(path: string, root: string): void {
  if (!root) throw new Error("A recovery root is required.");
  let boundary = recoveryRoots.get(root);
  if (!boundary) { boundary = resolveOwnedRoot(root, { allowRootLink: true }); recoveryRoots.set(root, boundary); }
  assertOwnedPath(boundary, path, { allowMissingLeaf: true });
}
function entryFor(root: string, path: string): BackupEntry {
  const source = join(root, path);
  noLinks(source, root);
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
  noLinks(avatars, root);
  try {
    for (const name of readdirSync(avatars).sort()) {
      const info = lstatSync(join(avatars, name));
      if (info.isFile() && !info.isSymbolicLink()) paths.push(`avatars/${name}`);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return paths.map((path) => entryFor(root, path));
}
export function verifyBackup(archive: string, entries: BackupEntry[], boundary: string): void {
  noLinks(archive, boundary);
  for (const entry of entries) {
    if (entry.sha256 === null) continue;
    const destination = join(archive, entry.path);
    noLinks(destination, boundary);
    const bytes = readFileSync(destination);
    const actualHash = hashBytes(bytes);
    if (actualHash !== entry.sha256) throw new Error("Legacy backup verification failed.");
    if (bytes.length !== entry.size) throw new Error("Legacy backup size verification failed.");
  }
}
export function copyBackup(root: string, archive: string, entries: BackupEntry[], boundary: string): void {
  noLinks(archive, boundary);
  for (const entry of entries) {
    if (entry.sha256 === null) continue;
    const source = join(root, entry.path), destination = join(archive, entry.path);
    noLinks(source, root); noLinks(destination, boundary);
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
  verifyBackup(archive, entries, boundary);
}
export function saveRecoveryRecord(path: string, record: unknown, root: string): void {
  noLinks(path, root);
  publishConfigFile(JSON.stringify(record, null, 2) + "\n", path, true);
}
