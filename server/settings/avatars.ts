import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Uploaded picture files are named avatar-<uuid>.<ext>. When a new one is saved, the ones no seat points at any more
// (and that are not the new one) are deleted: exact files only, never a folder.
// A file younger than AVATAR_MIN_AGE_MS is kept: another window may have just uploaded it and not yet saved the seat that uses it.
const AVATAR_MIN_AGE_MS = 10 * 60_000;
const AVATAR_FILE = /^avatar-[0-9a-f-]{36}\.(?:png|jpg|webp)$/i;
export function pruneAvatars(avatarDir: string, referencedPics: Iterable<string>, keepFile: string): string[] {
  const referenced = new Set<string>([keepFile]);
  for (const pic of referencedPics) if (typeof pic === "string" && pic.startsWith("/api/avatar/")) referenced.add(pic.slice("/api/avatar/".length));
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(avatarDir); } catch { return removed; }
  for (const name of names) {
    if (!AVATAR_FILE.test(name) || referenced.has(name)) continue;
    try { if (Date.now() - statSync(join(avatarDir, name)).mtimeMs < AVATAR_MIN_AGE_MS) continue; } catch { continue; }
    try { unlinkSync(join(avatarDir, name)); removed.push(name); } catch { /* a locked file stays for the next save */ }
  }
  return removed;
}
