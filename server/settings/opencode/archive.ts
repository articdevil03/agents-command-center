import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";
import { ReleaseFailure } from "./releases.ts";

import { RELEASE_TOOLS, type ReleaseTool } from "./release-tools.ts";

export const EXPANDED_LIMIT = 512 * 1024 * 1024;
function validName(path: string): boolean {
  if (!path || path.includes("\\") || path.startsWith("/") || /[\x00-\x1f\x7f:<>"|?*]/.test(path)) return false;
  return path.replace(/\/$/, "").split("/").every((part) => part && part !== "." && part !== ".." &&
    !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export async function extractExecutable(archive: string, dir: string, signal: AbortSignal, tool: ReleaseTool = "opencode"): Promise<string> {
  const profile = RELEASE_TOOLS[tool], expandedLimit = profile.expandedLimit;
  signal.throwIfAborted();
  const size = (await stat(archive)).size;
  // A fixed end-record envelope bounds the library BEFORE Open allocates its
  // entry array. ZIP64, split disks and comments are deliberately unsupported.
  const file = await open(archive, "r");
  const tail = Buffer.alloc(22);
  try { if (size < 22 || (await file.read(tail, 0, 22, size - 22)).bytesRead !== 22) throw new ReleaseFailure(); }
  finally { await file.close(); }
  const count = tail.readUInt16LE(10), centralSize = tail.readUInt32LE(12), offset = tail.readUInt32LE(16);
  if (tail.readUInt32LE(0) !== 0x06054b50 || tail.readUInt16LE(4) !== 0 || tail.readUInt16LE(6) !== 0 ||
    tail.readUInt16LE(8) !== count || !count || count > 64 || tail.readUInt16LE(20) !== 0 ||
    centralSize > 1024 * 1024 || offset + centralSize !== size - 22) throw new ReleaseFailure();
  const directory = await unzipper.Open.custom({
    size: async () => size,
    stream: (start: number, length?: number) => createReadStream(archive, { start, ...(length ? { end: start + length - 1 } : {}), signal }),
  }, { tailSize: 22 });
  if (profile.singleEntry && directory.files.length !== 1) throw new ReleaseFailure();
  const destinations = new Set<string>();
  let executable: any;
  if (directory.files.length !== count || directory.files.reduce((bytes: number, entry: any) =>
    bytes + 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength, 0) !== centralSize) throw new ReleaseFailure();
  for (const entry of directory.files) {
    signal.throwIfAborted();
    const path = entry.path, key = path.replace(/\/$/, "").toLowerCase();
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
    if (entry.signature !== 0x02014b50 || !validName(path) || destinations.has(key) || (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) ||
      (entry.externalFileAttributes & 0x400) !== 0 || entry.diskNumber !== 0 || entry.flags & 1 ||
      ![0, 8].includes(entry.compressionMethod) || entry.versionsNeededToExtract > 20 ||
      entry.uncompressedSize > expandedLimit || entry.compressedSize > size || entry.offsetToLocalFileHeader >= offset) throw new ReleaseFailure();
    destinations.add(key);
    if (path === profile.executable && entry.type === "File" && mode !== 0x4000) executable = entry;
  }
  if (!executable || executable.uncompressedSize <= 0) throw new ReleaseFailure();
  const path = join(dir, profile.executable);
  let expanded = 0;
  const bound = new Transform({ transform(chunk, _encoding, done) {
    expanded += chunk.length;
    if (expanded > expandedLimit || expanded > executable.uncompressedSize) done(new ReleaseFailure()); else done(null, chunk);
  } });
  await pipeline(executable.stream(), bound, createWriteStream(path, { flags: "wx" }), { signal });
  if (expanded !== executable.uncompressedSize) throw new ReleaseFailure();
  return path;
}
