import test from "node:test";
import assert from "node:assert/strict";
import {
  isStalled, canAutoRelaunch, createStallTrackers, STALL_THRESHOLD_MS, STALL_CONTENT_THRESHOLD_BYTES,
} from "../server/stall.ts";

// ---- isStalled: never early, fires at the threshold, clears on growth ----

test("isStalled: does not fire before the threshold", () => {
  assert.equal(isStalled("working", 100, 100, STALL_THRESHOLD_MS - 1), false);
  assert.equal(isStalled("working", 0, 0, 0), false);
});

test("isStalled: fires exactly at the threshold (inclusive)", () => {
  assert.equal(isStalled("working", 100, 100, STALL_THRESHOLD_MS), true);
  assert.equal(isStalled("working", 100, 100, STALL_THRESHOLD_MS + 1000), true);
});

// isStalled's own contract. In production checkStalls passes the same byte count twice and moves the growth clock in noteOutput instead;
// that real path is the "noteOutput ... LATEST growth" test below.
test("isStalled (helper contract): differing byte counts clear it, however small the growth and long the wait", () => {
  assert.equal(isStalled("working", 100, 101, STALL_THRESHOLD_MS * 10), false);
  assert.equal(isStalled("working", 0, 1, STALL_THRESHOLD_MS), false);
});

test("isStalled: only a \"working\" seat can be stalled", () => {
  for (const status of ["idle", "done", "failed", "stalled"]) {
    assert.equal(isStalled(status, 100, 100, STALL_THRESHOLD_MS * 10), false, status);
  }
});

test("isStalled: a custom threshold is honoured", () => {
  assert.equal(isStalled("working", 5, 5, 999, 1000), false);
  assert.equal(isStalled("working", 5, 5, 1000, 1000), true);
});

// ---- canAutoRelaunch: every refusal is independent and explicit ----

function permit(overrides = {}) {
  return { alreadyRelaunched: false, logHasContent: false, wasKilled: false, autoRelaunchEnabled: true, seatCanWrite: false, ...overrides };
}

test("canAutoRelaunch: permits exactly when every condition is favourable", () => {
  assert.equal(canAutoRelaunch(permit()), true);
});

test("canAutoRelaunch: refuses when the feature is switched off", () => {
  assert.equal(canAutoRelaunch(permit({ autoRelaunchEnabled: false })), false);
});

test("canAutoRelaunch: refuses when this run already used its one relaunch", () => {
  assert.equal(canAutoRelaunch(permit({ alreadyRelaunched: true })), false);
});

test("canAutoRelaunch: refuses when the user killed the run", () => {
  assert.equal(canAutoRelaunch(permit({ wasKilled: true })), false);
});

test("canAutoRelaunch: refuses when the log already has content (possibly finished, just hanging)", () => {
  assert.equal(canAutoRelaunch(permit({ logHasContent: true })), false);
});

// ---- MONEY GUARD 4: a seat that can edit files is NEVER auto-relaunched,
// not at any byte count -- see this file's own (stall.ts) top comment on why
// zero output is not proof nothing happened for a writable seat. ----

test("MONEY GUARD 4: canAutoRelaunch refuses a writable seat even with every other condition favourable", () => {
  assert.equal(canAutoRelaunch(permit({ seatCanWrite: true })), false);
});

test("MONEY GUARD 4: a writable seat is refused regardless of auto-relaunch being switched on", () => {
  assert.equal(canAutoRelaunch({ alreadyRelaunched: false, logHasContent: false, wasKilled: false, autoRelaunchEnabled: true, seatCanWrite: true }), false);
});

test("canAutoRelaunch: every refusal wins even when combined with otherwise-favourable conditions", () => {
  assert.equal(canAutoRelaunch({ alreadyRelaunched: true, logHasContent: false, wasKilled: false, autoRelaunchEnabled: true, seatCanWrite: false }), false);
  assert.equal(canAutoRelaunch({ alreadyRelaunched: false, logHasContent: true, wasKilled: false, autoRelaunchEnabled: true, seatCanWrite: false }), false);
  assert.equal(canAutoRelaunch({ alreadyRelaunched: false, logHasContent: false, wasKilled: true, autoRelaunchEnabled: true, seatCanWrite: false }), false);
  assert.equal(canAutoRelaunch({ alreadyRelaunched: false, logHasContent: false, wasKilled: false, autoRelaunchEnabled: false, seatCanWrite: false }), false);
  assert.equal(canAutoRelaunch({ alreadyRelaunched: false, logHasContent: false, wasKilled: false, autoRelaunchEnabled: true, seatCanWrite: true }), false);
});

// ---- createStallTrackers: the stateful wiring pure functions sit behind ----

test("stallTrackers: startRun resets bytes/relaunched/killed for a fresh run", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 1000);
  trackers.markKilled("sonny");
  trackers.markRelaunched("sonny", 2000);
  assert.equal(trackers.isKilled("sonny"), true);
  trackers.startRun("sonny", 3000); // a brand-new manual run: full reset
  assert.equal(trackers.isKilled("sonny"), false);
  const actions = trackers.checkStalls(3000 + STALL_THRESHOLD_MS, ["sonny"], true, () => false);
  assert.deepEqual(actions, [{ runId: "sonny", action: "relaunch" }], "relaunched must have been cleared too");
});

test("stallTrackers: noteOutput accumulates bytes and reports recovery only when the seat WAS stalled", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  assert.equal(trackers.noteOutput("sonny", 10, 100, false), false, "not recovering: wasn't stalled");
  assert.equal(trackers.noteOutput("sonny", 5, 200, true), true, "must report recovery when it WAS stalled");
  const actions = trackers.checkStalls(200 + STALL_THRESHOLD_MS - 1, ["sonny"], true, () => false);
  assert.deepEqual(actions, [], "must not fire before the threshold from the LATEST growth (200), not the run start");
});

test("stallTrackers: noteOutput ignores an empty chunk (no growth, no lastGrowthAt bump)", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.noteOutput("sonny", 0, 999999, false);
  const actions = trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"], true, () => false);
  assert.deepEqual(actions, [{ runId: "sonny", action: "relaunch" }], "an empty chunk must not have reset the growth clock");
});

test("stallTrackers: checkStalls only considers seats explicitly passed as working", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.startRun("sol", 0);
  const actions = trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"], true, () => false);
  assert.deepEqual(actions.map((a) => a.runId), ["sonny"]);
});

test("stallTrackers: checkStalls escalates once a run has already used its relaunch", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.markRelaunched("sonny", 0);
  const actions = trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"], true, () => false);
  assert.deepEqual(actions, [{ runId: "sonny", action: "escalate" }]);
});

test("stallTrackers: checkStalls escalates a run with more than the content threshold of output already", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.noteOutput("sonny", STALL_CONTENT_THRESHOLD_BYTES + 1, 0, false);
  const actions = trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"], true, () => false);
  assert.deepEqual(actions, [{ runId: "sonny", action: "escalate" }]);
});

test("stallTrackers: checkStalls relaunches a run with output at or under the content threshold", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.noteOutput("sonny", STALL_CONTENT_THRESHOLD_BYTES, 0, false);
  const actions = trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"], true, () => false);
  assert.deepEqual(actions, [{ runId: "sonny", action: "relaunch" }]);
});

test("stallTrackers: checkStalls escalates a killed run instead of relaunching", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.markKilled("sonny");
  const actions = trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"], true, () => false);
  assert.deepEqual(actions, [{ runId: "sonny", action: "escalate" }]);
});

test("stallTrackers: checkStalls escalates every stall while auto-relaunch is switched off", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  const actions = trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"], false, () => false);
  assert.deepEqual(actions, [{ runId: "sonny", action: "escalate" }]);
});

test("stallTrackers: markRelaunched resets the growth clock but never clears the one-relaunch flag", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.markRelaunched("sonny", 500);
  assert.equal(trackers.checkStalls(500 + STALL_THRESHOLD_MS - 1, ["sonny"], true, () => false).length, 0, "growth clock must restart from the relaunch, not the original run start");
  const actions = trackers.checkStalls(500 + STALL_THRESHOLD_MS, ["sonny"], true, () => false);
  assert.deepEqual(actions, [{ runId: "sonny", action: "escalate" }], "relaunched must still be true after the reset");
});

test("stallTrackers: markRelaunched preserves an existing killed flag", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.markKilled("sonny");
  trackers.markRelaunched("sonny", 0);
  assert.equal(trackers.isKilled("sonny"), true);
});

// ---- MONEY GUARD 3: any real output at all disqualifies a relaunch, never
// just output above some byte threshold -- a wrong relaunch spends real
// money, so ambiguous cases (was it hanging, or did it finish and just not
// exit?) must escalate, never auto-relaunch. ----

test("MONEY GUARD 3: STALL_CONTENT_THRESHOLD_BYTES is 0 -- any real output disqualifies an auto-relaunch", () => {
  assert.equal(STALL_CONTENT_THRESHOLD_BYTES, 0);
});

test("MONEY GUARD 3: checkStalls escalates a run with even a single byte of real output, not just output above an old byte threshold", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.noteOutput("sonny", 1, 0, false);
  const actions = trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"], true, () => false);
  assert.deepEqual(actions, [{ runId: "sonny", action: "escalate" }]);
});

test("MONEY GUARD 3: checkStalls still relaunches a run with truly zero output (the hang-before-any-work case)", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  const actions = trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"], true, () => false);
  assert.deepEqual(actions, [{ runId: "sonny", action: "relaunch" }]);
});

// ---- MONEY GUARD 4 (call-site version): a writable seat escalates instead
// of relaunching even with truly zero output and auto-relaunch on -- the
// exact "hang-before-any-work" case MONEY GUARD 3 just proved DOES relaunch
// for a read-only seat. Only `canSeatWrite` differs between the two tests. ----

test("MONEY GUARD 4: checkStalls escalates a writable seat with truly zero output, auto-relaunch on (never relaunches a seat that can edit files)", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  const actions = trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"], true, () => true);
  assert.deepEqual(actions, [{ runId: "sonny", action: "escalate" }]);
});

test("MONEY GUARD 4: checkStalls resolves writability per seat id, not globally, when several seats stall in the same tick", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0); // writable
  trackers.startRun("sol", 0); // read-only
  const actions = trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny", "sol"], true, (runId) => runId === "sonny");
  assert.deepEqual(actions.sort((a, b) => a.runId.localeCompare(b.runId)), [
    { runId: "sol", action: "relaunch" },
    { runId: "sonny", action: "escalate" },
  ]);
});

test("stallTrackers: finishRun forgets the run (no tracker, never checked again, killed flag gone, output ignored) and a later startRun is fresh", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.markKilled("sonny");
  trackers.finishRun("sonny");
  assert.equal(trackers.trackers.has("sonny"), false);
  assert.equal(trackers.isKilled("sonny"), false);
  assert.deepEqual(trackers.checkStalls(STALL_THRESHOLD_MS * 10, ["sonny"], true, () => false), [], "a finished run must never produce a stall action");
  assert.equal(trackers.noteOutput("sonny", 10, 5, true), false, "output for a finished run must not report recovery");
  assert.equal(trackers.trackers.has("sonny"), false, "output for a finished run must not recreate its tracker");
  trackers.startRun("sonny", 100);
  assert.deepEqual(trackers.checkStalls(100 + STALL_THRESHOLD_MS, ["sonny"], true, () => false), [{ runId: "sonny", action: "relaunch" }]);
});

test("stallTrackers: finishRun leaves every other run's tracker alone", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.startRun("sol", 0);
  trackers.finishRun("sonny");
  assert.deepEqual([...trackers.trackers.keys()], ["sol"]);
  assert.deepEqual(trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny", "sol"], true, () => false), [{ runId: "sol", action: "relaunch" }]);
});

test("stallTrackers: isKilled/checkStalls on an untracked seat id never throw", () => {
  const trackers = createStallTrackers();
  assert.equal(trackers.isKilled("nobody"), false);
  assert.deepEqual(trackers.checkStalls(STALL_THRESHOLD_MS, ["nobody"], true, () => false), []);
});
