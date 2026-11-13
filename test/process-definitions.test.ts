import assert from "node:assert/strict";
import test from "node:test";
import { finishRun, getWorkingSeats, isBusy, startRun, stopAll, stopSeat } from "../server/process.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import { seat, fixedProcess } from "./process-helpers.ts";

test("state creation applies the assigned seats and folder without changing the shared roster", () => {
  const roster = JSON.stringify(FIXED_CREW);
  const state = fixedProcess({
    tabId: "tab-1", folderPath: "C:\\work\\tab-1",
    choices: { coder: { cli: "claude", model: "claude-opus-5-5[1m]", effort: "high" } },
  });
  assert.equal(state.tabId, "tab-1");
  assert.equal(state.folderPath, "C:\\work\\tab-1");
  assert.equal(state.crewGenerationId, 1);
  assert.deepEqual(Object.keys(state).sort(), ["crewGenerationId", "folderPath", "runs", "seats", "tabId"], "a fixed runtime state holds only its identity, seats and runs: no steps, round, phase or approval");
  assert.deepEqual(state.runs, []);
  assert.deepEqual(state.seats.map((item) => item.slotId), ["leader", "coder", "reviewer1", "reviewer2"], "only assigned slots become seats");
  assert.deepEqual([seat(state, "coder").cli, seat(state, "coder").model, seat(state, "coder").effort], ["claude", "claude-opus-5-5[1m]", "high"]);
  assert.equal(seat(state, "coder").name, "Coder");
  assert.equal(seat(state, "coder").canWrite, true);
  assert.equal(seat(state, "leader").canWrite, false);
  assert.equal(seat(state, "leader").isLeader, true);
  assert.equal(seat(state, "coder").status, "idle");
  assert.equal(JSON.stringify(FIXED_CREW), roster, "assigning a seat leaves the roster untouched");
  assert.equal(FIXED_CREW.find((item) => item.slot === "coder")!.preferred.model, "gpt-6.1-sol");
});

test("Stop all stops every run, the seats and the leader; a late close of a stopped run changes nothing; a new run restarts a seat", () => {
  let state = fixedProcess();
  state = startRun(state, { id: "build-1", seatSlotId: "coder", label: "Build 1", startedAt: 1 });
  state = startRun(state, { id: "build-2", seatSlotId: "coder", label: "Build 2", startedAt: 2 });
  state = startRun(state, { id: "lead-1", seatSlotId: "leader", label: "Lead", startedAt: 3 });
  const before = JSON.stringify(state);
  const stopped = stopAll(state, 9);
  assert.equal(JSON.stringify(state), before, "stopping must not mutate the input state");
  state = stopped;

  assert.ok(state.runs.every((run) => run.status === "stopped" && run.outcome === "stopped" && run.endedAt === 9));
  assert.equal(state.runs.length, 3);
  assert.equal(seat(state, "coder").status, "stopped");
  assert.equal(seat(state, "leader").status, "stopped", "the leader stops too: nothing runs after Stop all");
  assert.deepEqual(getWorkingSeats(state), []);
  assert.equal(isBusy(state), false);

  state = finishRun(state, "build-1", 20);
  assert.equal(state.runs.find((run) => run.id === "build-1")!.status, "stopped", "a late close does not overwrite a stopped run");
  assert.equal(state.runs.find((run) => run.id === "build-1")!.endedAt, 9);
  assert.equal(seat(state, "coder").status, "stopped");
  assert.equal(isBusy(state), false);

  state = startRun(state, { id: "review-again", seatSlotId: "reviewer1", label: "Review again", startedAt: 30 });
  assert.equal(seat(state, "reviewer1").status, "working");
  assert.equal(isBusy(state), true);
  state = startRun(state, { id: "build-3", seatSlotId: "coder", label: "Build 3", startedAt: 31 });
  assert.equal(seat(state, "coder").status, "working", "a stopped seat starts again on a new run");
});

test("closing records: stopped seats stay busy until every stored closing run is confirmed, then nothing is busy", () => {
  // Several stored closing records are valid unit inputs here; the shipped app launches one real fixed worker at a time.
  let state = fixedProcess();
  state = startRun(state, { id: "close-a", seatSlotId: "coder", label: "A", startedAt: 1 });
  state = startRun(state, { id: "close-b", seatSlotId: "coder", label: "B", startedAt: 2 });
  state = startRun(state, { id: "free-c", seatSlotId: "reviewer1", label: "C", startedAt: 3 });
  state = stopAll(state, 10, new Set(["close-a", "close-b"]));
  const status = (id: string) => state.runs.find((run) => run.id === id)!.status;
  assert.deepEqual([status("close-a"), status("close-b"), status("free-c")], ["working", "working", "stopped"], "closing runs stay working until confirmed");
  assert.equal(seat(state, "coder").status, "stopped", "the stop is recorded on the seat now");
  assert.equal(seat(state, "reviewer1").status, "stopped");
  assert.equal(isBusy(state), true, "a closing run still counts as busy");

  state = finishRun(state, "close-a", 11);
  assert.equal(seat(state, "coder").status, "stopped", "the requested stop stays visible while the other run is closing");
  assert.equal(isBusy(state), true);
  state = finishRun(state, "close-b", 12);
  assert.deepEqual([status("close-a"), status("close-b")], ["done", "done"]);
  assert.equal(seat(state, "coder").status, "stopped");
  assert.equal(isBusy(state), false);

  let one = startRun(fixedProcess(), { id: "seat-run", seatSlotId: "coder", label: "Seat", startedAt: 1 });
  one = stopSeat(one, "coder", 5, new Set(["seat-run"]));
  assert.equal(one.runs[0].status, "working", "a closing run is not settled by stopSeat");
  assert.equal(seat(one, "coder").status, "stopped");
  assert.equal(isBusy(one), true);
});

test("Stop all stops a working leader and orphaned run IDs without a current seat", () => {
  let solo = startRun(fixedProcess({ slots: ["leader"] }), { id: "lead", seatSlotId: "leader", label: "Lead", startedAt: 1 });
  assert.equal(seat(solo, "leader").status, "working");
  solo = stopSeat(solo, "leader", 20);
  assert.equal(seat(solo, "leader").status, "stopped");
  assert.equal(isBusy(solo), false);

  const oldCrew = startRun(fixedProcess({ folderPath: "C:\\old" }), { id: "orphan-run", seatSlotId: "coder", label: "Old coder", startedAt: 2 });
  const newCrew = fixedProcess({ slots: ["leader"], folderPath: "C:\\new" });
  newCrew.runs = oldCrew.runs.map((run) => ({ ...run }));
  assert.equal(isBusy(newCrew), true);
  const stopped = stopAll(newCrew, 12);
  assert.equal(stopped.runs[0].status, "stopped");
  assert.equal(stopped.runs[0].endedAt, 12);
  assert.equal(isBusy(stopped), false);
});
