import test from "node:test";
import assert from "node:assert/strict";
import {
  isStalled, createStallTrackers, STALL_THRESHOLD_MS,
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

// ---- createStallTrackers: the stateful wiring pure functions sit behind. checkStalls only NAMES stalled runs; it never stops or restarts one. ----

test("stallTrackers: startRun resets bytes and the growth clock for a fresh run", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 1000);
  trackers.noteOutput("sonny", 10, 2000, false);
  trackers.startRun("sonny", 3000); // a brand-new run on the same id: full reset
  assert.equal(trackers.trackers.get("sonny")?.bytes, 0);
  assert.deepEqual(trackers.checkStalls(3000 + STALL_THRESHOLD_MS - 1, ["sonny"]), []);
  assert.deepEqual(trackers.checkStalls(3000 + STALL_THRESHOLD_MS, ["sonny"]), ["sonny"]);
});

test("stallTrackers: noteOutput accumulates bytes and reports recovery only when the seat WAS stalled", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  assert.equal(trackers.noteOutput("sonny", 10, 100, false), false, "not recovering: wasn't stalled");
  assert.equal(trackers.noteOutput("sonny", 5, 200, true), true, "must report recovery when it WAS stalled");
  assert.deepEqual(trackers.checkStalls(200 + STALL_THRESHOLD_MS - 1, ["sonny"]), [], "must not fire before the threshold from the LATEST growth (200), not the run start");
});

test("stallTrackers: any output, even one byte, restarts the growth clock (output recovery)", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  assert.deepEqual(trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"]), ["sonny"]);
  assert.equal(trackers.noteOutput("sonny", 1, STALL_THRESHOLD_MS + 5, true), true);
  assert.deepEqual(trackers.checkStalls(STALL_THRESHOLD_MS + 6, ["sonny"]), [], "growth clears the stall");
  assert.deepEqual(trackers.checkStalls(STALL_THRESHOLD_MS * 2 + 5, ["sonny"]), ["sonny"], "and flat output after it stalls again");
});

test("stallTrackers: noteOutput ignores an empty chunk (no growth, no lastGrowthAt bump)", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.noteOutput("sonny", 0, 999999, false);
  assert.deepEqual(trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"]), ["sonny"], "an empty chunk must not have reset the growth clock");
});

test("stallTrackers: checkStalls only considers runs explicitly passed as working", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.startRun("sol", 0);
  assert.deepEqual(trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny"]), ["sonny"]);
});

test("stallTrackers: a stalled run is named whatever it is or has written (no retry or write-capability branch exists)", () => {
  const trackers = createStallTrackers();
  trackers.startRun("quiet", 0);
  trackers.startRun("chatty", 0);
  trackers.noteOutput("chatty", 5000, 0, false);
  assert.deepEqual(trackers.checkStalls(STALL_THRESHOLD_MS, ["quiet", "chatty"]).sort(), ["chatty", "quiet"]);
});

test("stallTrackers: a custom threshold is honoured by checkStalls", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  assert.deepEqual(trackers.checkStalls(999, ["sonny"], 1000), []);
  assert.deepEqual(trackers.checkStalls(1000, ["sonny"], 1000), ["sonny"]);
});

test("stallTrackers: the tracker holds only the output-growth clock (no retry or kill flags)", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 7);
  assert.deepEqual(trackers.trackers.get("sonny"), { bytes: 0, lastGrowthAt: 7 });
  assert.deepEqual(Object.keys(trackers).sort(), ["checkStalls", "finishRun", "noteOutput", "startRun", "trackers"]);
});

test("stallTrackers: finishRun forgets the run (no tracker, never checked again, output ignored) and a later startRun is fresh", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.finishRun("sonny");
  assert.equal(trackers.trackers.has("sonny"), false);
  assert.deepEqual(trackers.checkStalls(STALL_THRESHOLD_MS * 10, ["sonny"]), [], "a finished run must never be named stalled");
  assert.equal(trackers.noteOutput("sonny", 10, 5, true), false, "output for a finished run must not report recovery");
  assert.equal(trackers.trackers.has("sonny"), false, "output for a finished run must not recreate its tracker");
  trackers.startRun("sonny", 100);
  assert.deepEqual(trackers.checkStalls(100 + STALL_THRESHOLD_MS, ["sonny"]), ["sonny"]);
});

test("stallTrackers: finishRun leaves every other run's tracker alone", () => {
  const trackers = createStallTrackers();
  trackers.startRun("sonny", 0);
  trackers.startRun("sol", 0);
  trackers.finishRun("sonny");
  assert.deepEqual([...trackers.trackers.keys()], ["sol"]);
  assert.deepEqual(trackers.checkStalls(STALL_THRESHOLD_MS, ["sonny", "sol"]), ["sol"]);
});

test("stallTrackers: checkStalls on an untracked run id never throws", () => {
  assert.deepEqual(createStallTrackers().checkStalls(STALL_THRESHOLD_MS, ["nobody"]), []);
});
