import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

// A streaming scan of a finished worker log for its CC_REPORT block. The whole log is read (never a tail), in fixed chunks:
// retained memory is one chunk, the marker state, the first report and ONE candidate report. A line outside a report is never kept.
export const REPORT_MAX_BYTES = 256 * 1024;
const CHUNK_BYTES = 64 * 1024;
const BEGIN = Buffer.from("CC_REPORT_BEGIN");
const END = Buffer.from("CC_REPORT_END");
const HEAD_BYTES = BEGIN.length + 2;
const LF = 10, CR = 13;

// counted: how many of the line's bytes were added to the block's size (a line short enough to be a delimiter is only counted once it ends as payload).
type Line = { head: Buffer; length: number; lastByte: number; counted: number };
const emptyLine = (): Line => ({ head: Buffer.alloc(0), length: 0, lastByte: -1, counted: 0 });
// The exact delimiter line: the marker alone, with an LF or CRLF ending (the LF is not part of the line).
function isMarker(line: Line, marker: Buffer): boolean {
  const length = line.lastByte === CR ? line.length - 1 : line.length;
  return length === marker.length && line.head.subarray(0, marker.length).equals(marker);
}
const refuseFraming = (why: "nested" | "unfinished"): never => { throw new Error(`Worker report block is ${why}.`); };

// Returns the unique report payload (line endings normalised to LF), or null when the log holds no report block.
// Refuses an unfinished, nested, oversized or conflicting block, and a log that changes while it is read.
// afterChunk: a seam for the test of a log that changes while it is read (called after every chunk).
export function scanWorkerReport(file: string, chunkBytes = CHUNK_BYTES, afterChunk?: () => void): Buffer | null {
  const linked = lstatSync(file);
  if (!linked.isFile()) throw new Error("Worker report log is not a regular file.");
  const fd = openSync(file, "r");
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== linked.size || opened.ino !== linked.ino || opened.dev !== linked.dev) throw new Error("Worker report log changed while opening.");
    const scan = createScan();
    const chunk = Buffer.alloc(chunkBytes);
    let total = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > opened.size) throw new Error("Worker report log changed while it was read.");
      scan.feed(chunk.subarray(0, count));
      afterChunk?.();
    }
    const after = fstatSync(fd);
    if (total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("Worker report log changed while it was read.");
    return scan.finish();
  } finally { closeSync(fd); }
}

function createScan() {
  let first: Buffer | null = null;
  let line = emptyLine();
  let inside = false;
  let payload: Buffer[] = [];
  let pending: Buffer[] = [];
  // Bytes of the block being collected, as logged (every line's own newline included); the one place the payload limit is enforced.
  let collected = 0;
  function collect(count: number): void {
    collected += count;
    if (collected > REPORT_MAX_BYTES + 1) throw new Error("Worker report payload exceeds its limit.");
  }

  function endLine(): void {
    if (!inside) {
      if (isMarker(line, BEGIN)) { inside = true; payload = []; collected = 0; }
    } else if (isMarker(line, BEGIN)) {
      refuseFraming("nested");
    } else if (isMarker(line, END)) {
      // The payload is what lies between the delimiter lines: the newline before the closing delimiter is not part of it.
      const joined = Buffer.concat(payload);
      const candidate = joined.length && joined[joined.length - 1] === LF ? joined.subarray(0, joined.length - 1) : joined;
      if (first === null) first = candidate;
      else if (!first.equals(candidate)) throw new Error("Worker report blocks differ.");
      inside = false; payload = [];
    } else {
      collect(line.length - line.counted + 1);
      const body = Buffer.concat(pending);
      // A CRLF ending is stored as LF, so the same report echoed with either line ending is one report.
      payload.push(Buffer.concat([line.lastByte === CR ? body.subarray(0, body.length - 1) : body, Buffer.from("\n")]));
    }
    line = emptyLine(); pending = [];
  }
  function addBytes(bytes: Buffer): void {
    if (bytes.length === 0) return;
    if (line.head.length < HEAD_BYTES) line.head = Buffer.concat([line.head, bytes.subarray(0, HEAD_BYTES - line.head.length)]);
    line.length += bytes.length; line.lastByte = bytes[bytes.length - 1];
    if (!inside) return;
    if (line.length > HEAD_BYTES) { collect(line.length - line.counted); line.counted = line.length; }
    pending.push(Buffer.from(bytes));
  }
  return {
    feed(chunk: Buffer): void {
      let start = 0;
      for (let at = chunk.indexOf(LF, start); at !== -1; at = chunk.indexOf(LF, start)) {
        addBytes(chunk.subarray(start, at));
        endLine();
        start = at + 1;
      }
      addBytes(chunk.subarray(start));
    },
    finish(): Buffer | null {
      // A last line with no newline can still be the closing delimiter.
      if (line.length > 0) { if (inside && !isMarker(line, END)) refuseFraming("unfinished"); endLine(); }
      if (inside) refuseFraming("unfinished");
      return first;
    },
  };
}
