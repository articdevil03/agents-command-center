// Stall detection and auto-relaunch. Only idle/working/done/failed existed
// before this -- a hung agent looked exactly like a busy one (see CLAUDE.md's
// "a hung Codex looks exactly like a busy one", hit repeatedly on this exact
// codebase). Auto-relaunch spends real money on a re-run nobody asked for if
// it ever fires when it shouldn't, so every refusal path is independent,
// explicit, and mutation-proven (see scripts/mutation-proof.mjs).
//
// A later review found the byte-threshold reasoning below was solving the
// wrong problem: zero output is not proof that nothing happened. A worker
// that can edit files can make real, paid progress and write nothing to
// stdout/stderr for the whole stall window -- the tracker would see
// `bytes === 0`, conclude "nothing happened", and re-run the same brief,
// which duplicates paid work and can clobber the first run's edits. Any
// output means it did something (already handled below); zero output may
// ALSO mean it did something silently. There is no byte count at which
// auto-relaunching a seat that can write is safe, so `seatCanWrite` (see
// server/runner.ts's canRunWrite, the single source of truth for which
// seats can edit files) is its own independent, unconditional refusal in
// canAutoRelaunch below -- never just another byte-threshold tweak. A seat
// that can write still gets everything else this file does: detected,
// marked "stalled", left running, and escalated to the user. It just never gets
// relaunched automatically. See README.md's "Stall detection" section.

export const STALL_THRESHOLD_MS = 5 * 60 * 1000;
export const STALL_CHECK_INTERVAL_MS = 15 * 1000;

// Any real output at all now disqualifies an auto-relaunch: even CLAUDE.md's
// documented hang signature ("a few dozen bytes" waiting on stdin forever)
// might not be nothing -- a wrong relaunch spends real money and can clobber
// a run that only looked hung, while a wrongly-skipped relaunch just costs a
// notification (see the brief: "be conservative"). So this is 0, meaning
// "nothing happened at all"; anything above it reads as *possibly finished
// but hanging on exit* and escalates to the user instead of auto-relaunching.
// ponytail: a flat byte count, not real content/verdict inspection (no log
// parser dependency, per the brief).
export const STALL_CONTENT_THRESHOLD_BYTES = 0;

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

export type RelaunchDecisionInput = {
  alreadyRelaunched: boolean;
  logHasContent: boolean;
  wasKilled: boolean;
  autoRelaunchEnabled: boolean;
  // From server/runner.ts's canRunWrite -- true for a run whose process may
  // edit files: every claude/opencode run AND every codex run, read-only or
  // not (a `codex exec --sandbox read-only` probe wrote a file on this PC), so
  // in practice no run is relaunched automatically. Review-role tool denials and
  // read-only modes are not a sandbox. See this file's own top comment for why
  // this can never be a byte threshold instead.
  seatCanWrite: boolean;
};

// Pure. Every refusal is independent and explicit, in the order a reviewer
// would check them -- a mutation that drops any one of these five `if`s must
// let a relaunch through it shouldn't and turn the suite red (see
// scripts/mutation-proof.mjs's guard-relaunch-* entries).
export function canAutoRelaunch(input: RelaunchDecisionInput): boolean {
  if (!input.autoRelaunchEnabled) return false;
  if (input.seatCanWrite) return false;
  if (input.alreadyRelaunched) return false;
  if (input.wasKilled) return false;
  if (input.logHasContent) return false;
  return true;
}

type Tracker = { bytes: number; lastGrowthAt: number; relaunched: boolean; killed: boolean };

export type StallAction = { runId: string; action: "relaunch" | "escalate" };

// Deliberately a Map of plain objects plus functions, not a class -- a test
// drives every transition with an injected `now`, never a real clock or a
// spawned process.
export function createStallTrackers() {
  const trackers = new Map<string, Tracker>();

  // A genuinely NEW run (the user pressed Run): full reset, including the
  // one-relaunch allowance.
  function startRun(runId: string, now: number): void {
    trackers.set(runId, { bytes: 0, lastGrowthAt: now, relaunched: false, killed: false });
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

  function markKilled(runId: string): void {
    const t = trackers.get(runId);
    if (t) t.killed = true;
  }

  function isKilled(runId: string): boolean {
    return trackers.get(runId)?.killed ?? false;
  }

  function finishRun(runId: string): void {
    trackers.delete(runId);
  }

  // Consumes the run's one allowed relaunch and starts tracking the new
  // process's own output from zero. `relaunched` is never cleared by this --
  // that is precisely what makes a second stall on the SAME run escalate
  // instead of relaunching again.
  function markRelaunched(runId: string, now: number): void {
    const t = trackers.get(runId);
    trackers.set(runId, { bytes: 0, lastGrowthAt: now, relaunched: true, killed: t?.killed ?? false });
  }

  // Called once per periodic tick with every seat CURRENTLY reported
  // "working". A seat that gets an action here is expected to be moved out of
  // "working" by the caller (to "stalled") before the next tick, which is
  // what stops this from re-firing every 15s for the same stall -- this
  // function itself has no "already handled" bookkeeping of its own.
  // The `canSeatWrite` parameter is a lookup, not a single flag, since this runs across
  // every currently-working seat in one tick and different seats can have
  // different answers -- pass server/runner.ts's real canRunWrite (applied
  // to the seat behind the id) in production; see stall's own comment on why
  // a writable seat can never relaunch regardless of anything else here.
  function checkStalls(
    now: number,
    workingRunIds: string[],
    autoRelaunchEnabled: boolean,
    canSeatWrite: (runId: string) => boolean,
    thresholdMs: number = STALL_THRESHOLD_MS,
    contentThresholdBytes: number = STALL_CONTENT_THRESHOLD_BYTES
  ): StallAction[] {
    const actions: StallAction[] = [];
    for (const runId of workingRunIds) {
      const t = trackers.get(runId);
      if (!t) continue;
      // lastGrowthAt only moves when bytes grow, so "no growth for the threshold" is already carried by `elapsed`:
      // the byte pair isStalled also compares is always equal here and adds nothing.
      const elapsed = now - t.lastGrowthAt;
      if (!isStalled("working", t.bytes, t.bytes, elapsed, thresholdMs)) continue;
      const decision = canAutoRelaunch({
        alreadyRelaunched: t.relaunched,
        logHasContent: t.bytes > contentThresholdBytes,
        wasKilled: t.killed,
        autoRelaunchEnabled,
        seatCanWrite: canSeatWrite(runId),
      });
      actions.push({ runId, action: decision ? "relaunch" : "escalate" });
    }
    return actions;
  }

  return { startRun, noteOutput, markKilled, isKilled, markRelaunched, finishRun, checkStalls, trackers };
}

export type StallTrackers = ReturnType<typeof createStallTrackers>;
