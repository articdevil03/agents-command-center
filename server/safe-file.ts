import { closeSync, constants, copyFileSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";

// The temp file is flushed to disk before the caller renames or links it into place, so a power cut can never
// publish an empty or half-written file under the real name.
export function writeFileSynced(path: string, contents: string | Buffer): void {
  const fd = openSync(path, "wx");
  try { writeFileSync(fd, contents); fsyncSync(fd); }
  finally { closeSync(fd); }
}

// A file the app cannot read is kept, never overwritten blind: the copy is "<name>.bad-<timestamp>" beside it.
export function keepBadCopy(path: string): string {
  const stamp = Date.now();
  for (let attempt = 0; ; attempt++) {
    const copy = `${path}.bad-${stamp}${attempt ? `-${attempt}` : ""}`;
    try { copyFileSync(path, copy, constants.COPYFILE_EXCL); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST" && attempt < 100) continue; throw err; }
    console.error(`${path} could not be read; a copy was kept at ${copy} and defaults are used`);
    return copy;
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
