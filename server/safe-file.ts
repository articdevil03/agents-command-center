import { closeSync, constants, copyFileSync, fsyncSync, openSync, writeFileSync } from "node:fs";

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
