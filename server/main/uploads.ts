import { readFile, readdir, lstat, realpath, unlink } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { join, extname, resolve, dirname, basename } from "node:path";
import { IMAGE_EXT_TO_MIME } from "../config.ts";
import { isWithinDir } from "../security.ts";
import { FILE_EXTENSIONS, FILE_MAX_BYTES, IMAGE_MAX_BYTES, avatarDir, chatStore, dataRoot, scratchDir } from "./state.ts";

const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A pasted image or file a saved chat still points at must stay, however old: its name appears in chats/<tab>.jsonl.
// Returns null when any chat file cannot be read: an unreadable chat may still point at an old upload, so nothing is deleted then.
async function referencedScratchNames(chatsDir: string, files: string[]): Promise<Set<string> | null> {
  let names: string[];
  try { names = await readdir(chatsDir); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? new Set() : null; }
  const referenced = new Set<string>();
  for (const name of names.filter((n) => n.endsWith(".jsonl"))) {
    let text: string;
    try { text = await readFile(join(chatsDir, name), "utf8"); } catch { return null; }
    for (const file of files) if (text.includes(file)) referenced.add(file);
  }
  return referenced;
}
// Only what the paste routes generate (paste-<uuid>.<image> and file-<uuid>.<ext>) is ever deleted, never a file someone else put there.
const SCRATCH_UPLOAD_NAME = /^(?:paste-[0-9a-f-]{36}\.(?:png|jpg|webp)|file-[0-9a-f-]{36}\.[a-z0-9]+)$/i;
export async function cleanScratch(dir: string = scratchDir, chatsDir: string = chatStore.directory): Promise<void> {
  const cutoff = Date.now() - SCRATCH_MAX_AGE_MS;
  // A scratch folder that is a link (a junction) or sits anywhere but where its name says would make this delete files elsewhere.
  try {
    const info = await lstat(dir);
    const expected = join(await realpath(dirname(dir)), basename(dir));
    if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(dir)).toLowerCase() !== expected.toLowerCase()) { console.log(`Scratch cleanup skipped: ${dir} is a link or is not where it should be`); return; }
  } catch { return; }
  let files: string[];
  try { files = (await readdir(dir)).filter((name) => SCRATCH_UPLOAD_NAME.test(name)); } catch { return; }
  const referenced = await referencedScratchNames(chatsDir, files);
  if (!referenced) { console.log("Scratch cleanup skipped: a saved chat could not be read"); return; }
  for (const file of files) {
    const path = join(dir, file);
    try { const info = await lstat(path); if (info.isFile() && info.mtimeMs < cutoff && !referenced.has(file)) await unlink(path); } catch { /* best effort on races */ }
  }
}
// Uploads are stored, and their paths handed back, through the real folder; a data root behind a junction or symlink must still match.
function folderRoots(dir: string): string[] {
  const roots = [resolve(dir)];
  try {
    // The folder's real path counts only when it is the folder itself under the data root's real path (a link further up the data root is
    // fine); a scratch folder that is itself a link to somewhere else is refused, as the upload routes refuse to write through it.
    const real = realpathSync(dir), expected = join(realpathSync(dataRoot), basename(dir));
    if (!roots.includes(expected) && real.toLowerCase() === expected.toLowerCase()) roots.push(real);
  } catch { /* not created yet: the plain path stands */ }
  return roots;
}
export const inScratch = (path: string): boolean => folderRoots(scratchDir).some((dir) => isWithinDir(path, dir));
export const inAvatars = (path: string): boolean => folderRoots(avatarDir).some((dir) => isWithinDir(path, dir));
export function validateImages(values: unknown): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 8 || values.some((value) => typeof value !== "string")) throw new Error("images must be a list of uploaded image paths");
  return values.map((value) => {
    const input = value as string;
    const absolute = resolve(input);
    const extension = extname(absolute).toLowerCase();
    if (input.split(/[\\/]+/).includes("..") || !inScratch(absolute)
      || !/^paste-[0-9a-f-]{36}\.(?:png|jpg|webp)$/i.test(basename(absolute)) || !IMAGE_EXT_TO_MIME[extension]) {
      throw new Error("image path must point to an uploaded scratch image");
    }
    try {
      const canonical = realpathSync(absolute);
      if (!inScratch(canonical)) throw new Error("uploaded image path escaped scratch");
      const info = statSync(canonical);
      if (!info.isFile() || info.size > IMAGE_MAX_BYTES) throw new Error("invalid uploaded image");
      return canonical;
    } catch { throw new Error("image path must point to an uploaded scratch image"); }
  });
}
export function validateFiles(values: unknown): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 8 || values.some((value) => typeof value !== "string")) throw new Error("files must be a list of uploaded file paths");
  return values.map((value) => {
    const input = value as string;
    if (input.split(/[\\/]+/).includes("..")) throw new Error("file path cannot contain traversal");
    const absolute = resolve(input);
    const extension = extname(absolute).toLowerCase();
    if (!inScratch(absolute) || !/^file-[0-9a-f-]{36}\.[a-z0-9]+$/i.test(basename(absolute)) || !FILE_EXTENSIONS.has(extension)) {
      throw new Error("file path must point to an uploaded scratch file");
    }
    try {
      const canonical = realpathSync(absolute);
      if (!inScratch(canonical)) throw new Error("uploaded file path escaped scratch");
      const info = statSync(canonical);
      if (!info.isFile() || info.size > FILE_MAX_BYTES) throw new Error("invalid uploaded file");
      return canonical;
    } catch { throw new Error("uploaded file is unavailable"); }
  });
}
