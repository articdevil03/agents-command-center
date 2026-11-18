import { closeSync, constants, copyFileSync, fsyncSync, openSync, renameSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// The temp file is flushed to disk before the caller renames or links it into place, so a power cut can never
// publish an empty or half-written file under the real name.
export function writeFileSynced(path: string, contents: string | Buffer): void {
  const fd = openSync(path, "wx");
  try { writeFileSync(fd, contents); fsyncSync(fd); }
  finally { closeSync(fd); }
}

// A file the app cannot read is kept, never overwritten blind: the copy is "<name>.bad-<timestamp>" beside it.
export type PreservationResult = { ok: true; path: string } | { ok: false };

// Failure grants no permission to replace the source. Callers must block their store's writes.
// Compare the copied bytes, so even a source that cannot be read directly can be preserved.
export function preserveBadFile(path: string): PreservationResult {
  try { return { ok: true, path: keepBadCopy(path) }; }
  catch { return { ok: false }; }
}

export function keepBadCopy(path: string): string {
  const stamp = Date.now();
  for (let attempt = 0; ; attempt++) {
    const copy = `${path}.bad-${stamp}${attempt ? `-${attempt}` : ""}`;
    try { copyFileSync(path, copy, constants.COPYFILE_EXCL); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST" && attempt < 100) continue; throw err; }
    try {
      const bytes = readFileSync(copy);
      for (const name of readdirSync(dirname(path))) {
        // Only reuse an earlier name: two simultaneous preservers cannot delete each other's copies.
        if (!name.startsWith(`${basename(path)}.bad-`) || name >= basename(copy)) continue;
        const previous = join(dirname(path), name);
        if (previous === copy) continue;
        let identical = false;
        try { identical = readFileSync(previous).equals(bytes); } catch { continue; }
        if (identical) { unlinkSync(copy); return previous; }
      }
    } catch { throw new Error("The original file could not be safely preserved."); }
    return copy;
  }
}

export function readFileWithRetry(path: string): Buffer {
  for (let attempt = 0; ; attempt++) {
    try { return readFileSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || attempt === 2) throw error;
      Atomics.wait(replaceWait, 0, 0, 10 * (attempt + 1));
    }
  }
}

const replaceWait = new Int32Array(new SharedArrayBuffer(4));
const replaceDelays = [10, 20, 40, 80, 160, 320, 640, 1000, 1000, 1000, 1000]; // about 5.3 s in total

// Windows refuses to replace a file another process holds open for a moment.
export function replaceFile(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt === replaceDelays.length) throw error;
      // ponytail: blocks the event loop only while a file is held (up to about 5.3 s); async retry is the upgrade path if that ever matters.
      Atomics.wait(replaceWait, 0, 0, replaceDelays[attempt]);
    }
  }
}
