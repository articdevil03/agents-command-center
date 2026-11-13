// Stall detection. Only idle/working/done/failed existed before this -- a hung
// agent looked exactly like a busy one (see CLAUDE.md's "a hung Codex looks
// exactly like a busy one", hit repeatedly on this exact codebase). A stalled
// run is only SHOWN as stalled and escalated to the user: this file (and the
// timer that calls it) never stops or restarts a run because its output is
// flat, since zero output is not proof that nothing happened (a worker that can
// edit files makes real, paid progress and writes nothing for a long time).
// Any new output clears the stalled state again. See README.md's "Stall detection" section.

export const STALL_THRESHOLD_MS = 5 * 60 * 1000;
export const STALL_CHECK_INTERVAL_MS = 15 * 1000;

export type SeatStatusValue = "idle" | "working" | "done" | "failed" | "stalled";

// Pure: true exactly when a "working" seat's output byte count has not grown
// for at least `thresholdMs`. Never fires before the threshold, fires at it
// (inclusive), and any growth (currentByteCount !== lastByteCount) clears it
// immediately -- that IS what "recovered" means, so there is no separate
// "recovery" branch to get out of sync with this one.
export function isStalled(
  status: SeatStatusValue,
  lastByteCount: number,
  currentByteCount: number,
  elapsedMs: number,
  thresholdMs: number = STALL_THRESHOLD_MS
): boolean {
  return status === "working" && currentByteCount === lastByteCount && elapsedMs >= thresholdMs;
}

type Tracker = { bytes: number; lastGrowthAt: number };

// Deliberately a Map of plain objects plus functions, not a class -- a test
// drives every transition with an injected `now`, never a real clock or a
// spawned process.
export function createStallTrackers() {
  const trackers = new Map<string, Tracker>();

  // A genuinely NEW run: full reset.
  function startRun(runId: string, now: number): void {
    trackers.set(runId, { bytes: 0, lastGrowthAt: now });
  }

  // Called on every output chunk. `wasStalled` is the seat's status just
  // before this chunk arrived; the return value tells the caller whether to
  // flip that status back to "working" -- growth is the only way out of
  // "stalled" (see isStalled's own comment).
  function noteOutput(runId: string, chunkByteLength: number, now: number, wasStalled: boolean): boolean {
    const t = trackers.get(runId);
    if (!t || chunkByteLength <= 0) return false;
    t.bytes += chunkByteLength;
    t.lastGrowthAt = now;
    return wasStalled;
  }

  function finishRun(runId: string): void {
    trackers.delete(runId);
  }

  // Called once per periodic tick with every run CURRENTLY reported "working";
  // returns the ids whose output has not grown for `thresholdMs`. The caller
  // marks them "stalled" (which is what stops this from re-firing every tick for
  // the same stall) and tells the user. Nothing here ever stops or restarts a run.
  function checkStalls(now: number, workingRunIds: string[], thresholdMs: number = STALL_THRESHOLD_MS): string[] {
    const stalled: string[] = [];
    for (const runId of workingRunIds) {
      const t = trackers.get(runId);
      if (!t) continue;
      // lastGrowthAt only moves when bytes grow, so "no growth for the threshold" is already carried by `elapsed`:
      // the byte pair isStalled also compares is always equal here and adds nothing.
      if (isStalled("working", t.bytes, t.bytes, now - t.lastGrowthAt, thresholdMs)) stalled.push(runId);
    }
    return stalled;
  }

  return { startRun, noteOutput, finishRun, checkStalls, trackers };
}

export type StallTrackers = ReturnType<typeof createStallTrackers>;
