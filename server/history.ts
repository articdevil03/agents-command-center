// Run history is read straight off logs/<seatId>-<timestamp>.log and its
// sibling .brief.txt -- no index file, no database (see README/brief). Every
// function here is pure over data the caller already read from disk, so
// ordering/filtering/truncation can be proven with fabricated directory
// listings and stat results, never a real filesystem.
import { open } from "node:fs/promises";

export type HistoryEntry = {
  seatId: string;
  timestamp: number;
  logFile: string;
  briefFile: string | null;
  sizeBytes: number;
  mtimeMs: number;
};

// runner.ts writes logs as `${seat.id}-${ts}.log` / `${seat.id}-${ts}.brief.txt`.
// A seat key may itself contain hyphens (e.g. "sample-reviewer"), so this
// takes everything before the LAST "-<digits>.log" rather than splitting on
// the first hyphen.
const LOG_NAME = /^(.+)-(\d+)\.log$/;

export function parseLogFilename(name: string): { seatId: string; timestamp: number } | null {
  const match = LOG_NAME.exec(name);
  if (!match) return null;
  const timestamp = Number(match[2]);
  return Number.isFinite(timestamp) ? { seatId: match[1], timestamp } : null;
}

// `filenames` and `stats` are both already read by the caller (readdir + stat
// per file) -- this never touches disk, so ordering/filtering/a missing stat
// entry are all provable against fabricated input. A log whose stat lookup is
// missing (an unreadable or raced-away file) is skipped rather than thrown.
export function listSeatRuns(
  seatId: string,
  filenames: string[],
  stats: Map<string, { size: number; mtimeMs: number }>
): HistoryEntry[] {
  const briefNames = new Set(filenames.filter((f) => f.endsWith(".brief.txt")));
  const entries: HistoryEntry[] = [];
  for (const name of filenames) {
    const parsed = parseLogFilename(name);
    if (!parsed || parsed.seatId !== seatId) continue;
    const info = stats.get(name);
    if (!info) continue;
    const briefFile = `${seatId}-${parsed.timestamp}.brief.txt`;
    entries.push({
      seatId,
      timestamp: parsed.timestamp,
      logFile: name,
      briefFile: briefNames.has(briefFile) ? briefFile : null,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
    });
  }
  return entries.sort((a, b) => b.timestamp - a.timestamp);
}

// Written to the LOG FILE (never a separate index) by runner.ts the moment a
// run ends, so a past run's outcome survives a server restart without any
// in-memory state. Kept as one shared format/parse pair so the writer and the
// history reader can never drift apart from each other.
export function formatExitMarker(status: "done" | "failed" | "stopped", exitCode?: number): string {
  return `\n[exit] status=${status} code=${exitCode ?? "unknown"}\n`;
}

const EXIT_MARKER = /\[exit\] status=(done|failed|stopped) code=(-?\d+|unknown)\s*$/;

export type Outcome = { status: "done" | "failed" | "stopped"; exitCode: number | null };

// Reads the outcome back out of a tail of text (never the whole file -- see
// readTail). `null` means no marker was found in the given tail, which is
// exactly what an in-progress run's log looks like: it isn't a crash, it's
// "still running or the marker fell outside this tail."
export function parseOutcome(tail: string): Outcome | null {
  const match = EXIT_MARKER.exec(tail.trimEnd());
  if (!match) return null;
  return { status: match[1] as "done" | "failed" | "stopped", exitCode: match[2] === "unknown" ? null : Number(match[2]) };
}

export const HISTORY_TAIL_BYTES = 64 * 1024;

// The explicit "Load full output" escape hatch past HISTORY_TAIL_BYTES still
// needs a ceiling of its own: without one, a multi-gigabyte log (a runaway
// CLI writing forever) gets read whole, JSON-serialised, and shipped to the
// renderer in one message, which can exhaust memory or freeze both processes.
// This is generous enough to cover a real "show me everything" request while
// staying far short of that failure mode.
export const HISTORY_FULL_MAX_BYTES = 8 * 1024 * 1024;

// Reads at most `maxBytes` from the END of a file via a positioned read --
// never loads a multi-megabyte log in full just to preview it. `truncated`
// tells the UI it is looking at a partial file, rather than a short file
// pretending to be complete.
export async function readTail(
  path: string,
  maxBytes: number = HISTORY_TAIL_BYTES
): Promise<{ text: string; truncated: boolean; totalBytes: number }> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = length > 0 ? await handle.read(buffer, 0, length, start) : { bytesRead: 0 };
    // A cut inside a multi-byte character leaves continuation bytes (10xxxxxx) at the front: skip them rather than decode to U+FFFD.
    let from = 0;
    if (start > 0) while (from < bytesRead && (buffer[from] & 0xc0) === 0x80) from++;
    return { text: buffer.toString("utf8", from, bytesRead), truncated: start > 0, totalBytes: size };
  } finally {
    await handle.close();
  }
}
