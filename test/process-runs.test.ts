import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FINISHED_RUNS, failRun, finishRun, getRunViews, getWorkingSeats, isBusy, runEvent, startRun, stopRun, stopSeat } from "../server/process.ts";
import { seat, fixedProcess } from "./process-helpers.ts";

test("run events snapshot assignment and folder, and finalize every terminal outcome", () => {
  const original = fixedProcess({ folderPath: "C:\\work\\one" });
  const started = runEvent(original, {
    type: "start",
    run: { id: "run-1", seatSlotId: "coder", label: "First", startedAt: 10 },
  });
  assert.notStrictEqual(started, original);
  assert.equal(original.runs.length, 0);
  assert.equal(startRun(started, { id: "run-1", seatSlotId: "coder", label: "duplicate", startedAt: 11 }).runs.length, 1, "duplicate run IDs are ignored");
  assert.equal(startRun(started, { id: "run-x", seatSlotId: "missing", label: "no seat", startedAt: 11 }).runs.length, 1, "a run for a missing seat is ignored");
  assert.deepEqual(started.runs[0], {
    id: "run-1", crewGenerationId: 1, seatSlotId: "coder", seatName: "Coder", seatIsLeader: false, label: "First",
    status: "working", outcome: null, cli: "codex", model: "gpt-6.1-sol", effort: "medium",
    folderPath: "C:\\work\\one", startedAt: 10, endedAt: null,
  });

  const changedSettings = {
    ...started,
    folderPath: "C:\\work\\two",
    seats: started.seats.map((item) => item.slotId === "coder"
      ? { ...item, cli: "opencode", model: "deepseek/deepseek-flash", effort: "high" }
      : { ...item }),
  };
  const second = startRun(changedSettings, { id: "run-2", seatSlotId: "coder", label: "Second", startedAt: 11 });
  assert.deepEqual(
    [second.runs[0].cli, second.runs[0].model, second.runs[0].effort, second.runs[0].folderPath],
    ["codex", "gpt-6.1-sol", "medium", "C:\\work\\one"],
  );
  assert.deepEqual(
    [second.runs[1].cli, second.runs[1].model, second.runs[1].effort, second.runs[1].folderPath],
    ["opencode", "deepseek/deepseek-flash", "high", "C:\\work\\two"],
  );
  const done = finishRun(second, "run-1", 20);
  assert.equal(done.runs[0].status, "done");
  assert.equal(done.runs[0].outcome, "done");
  assert.equal(done.runs[0].endedAt, 20);
  assert.equal(seat(done, "coder").status, "working", "the sibling run is still active");
  const failed = failRun(done, "run-2", 30, "command failed");
  assert.equal(failed.runs[1].status, "failed");
  assert.equal(failed.runs[1].outcome, "command failed");
  assert.equal(failed.runs[1].endedAt, 30);
  assert.equal(seat(failed, "coder").status, "failed");
});

test("finished and stopped runs stay live only while their seat has another working run", () => {
  let state = fixedProcess();
  state = startRun(state, { id: "run-a", seatSlotId: "coder", label: "A", startedAt: 1 });
  state = startRun(state, { id: "run-b", seatSlotId: "coder", label: "B", startedAt: 2 });
  state = finishRun(state, "run-a", 3);
  let views = getRunViews(state);
  assert.deepEqual(views.liveBySeat.coder?.map((run) => [run.id, run.status]), [["run-a", "done"], ["run-b", "working"]]);
  assert.deepEqual(views.history.map((run) => run.id), ["run-a"]);

  state = stopRun(state, "run-b", 4);
  views = getRunViews(state);
  assert.equal("coder" in views.liveBySeat, false);
  assert.deepEqual(views.history.map((run) => [run.id, run.status, run.outcome]), [
    ["run-a", "done", "done"], ["run-b", "stopped", "stopped"],
  ]);
  assert.equal(isBusy(state), false);
});

test("failed, missing, or repeated run events do not overwrite a terminal run", () => {
  let state = startRun(fixedProcess(), { id: "run", seatSlotId: "coder", label: "One", startedAt: 10 });
  state = failRun(state, "run", 12, "exit 1");
  const duplicateStop = stopRun(state, "run", 13);
  assert.equal(duplicateStop.runs[0].status, "failed");
  assert.equal(duplicateStop.runs[0].outcome, "exit 1");
  assert.equal(duplicateStop.runs[0].endedAt, 12);
  assert.equal(stopRun(state, "missing", 14).runs.length, 1);
});

test("stopping a seat settles all its parallel runs and leaves the other seats alone", () => {
  let state = fixedProcess();
  state = startRun(state, { id: "one", seatSlotId: "coder", label: "One", startedAt: 1 });
  state = startRun(state, { id: "two", seatSlotId: "coder", label: "Two", startedAt: 2 });
  state = startRun(state, { id: "other", seatSlotId: "reviewer1", label: "Other", startedAt: 3 });
  state = stopSeat(state, "coder", 5);
  const coderRuns = state.runs.filter((run) => run.seatSlotId === "coder");
  assert.equal(coderRuns.length, 2);
  assert.ok(coderRuns.every((run) => run.status === "stopped" && run.endedAt === 5));
  assert.equal(seat(state, "coder").status, "stopped");
  assert.equal(state.runs.find((run) => run.id === "other")!.status, "working");
  assert.equal(seat(state, "reviewer1").status, "working");
  assert.equal(isBusy(state), true);
});

test("working seats follow the runs: the leader is listed, a finished seat is not, and a missing seat keeps its run snapshot", () => {
  let state = fixedProcess();
  assert.deepEqual(getWorkingSeats(state), []);
  state = startRun(state, { id: "lead", seatSlotId: "leader", label: "Lead", startedAt: 1 });
  state = startRun(state, { id: "code", seatSlotId: "coder", label: "Code", startedAt: 2 });
  assert.deepEqual(getWorkingSeats(state).map((item) => item.slotId).sort(), ["coder", "leader"]);
  assert.equal(getWorkingSeats(state).find((item) => item.slotId === "leader")!.isLeader, true);
  state = finishRun(state, "code", 3);
  assert.deepEqual(getWorkingSeats(state).map((item) => item.slotId), ["leader"]);

  const orphan = { ...state, seats: state.seats.filter((item) => item.slotId !== "leader") };
  const listed = getWorkingSeats(orphan).find((item) => item.slotId === "leader")!;
  assert.deepEqual([listed.name, listed.isLeader], ["Leader", true], "the name and leader flag come from the run's own snapshot");
});

test("finished runs are bounded while every working run is kept", () => {
  let state = fixedProcess();
  state = startRun(state, { id: "live-first", seatSlotId: "coder", label: "Long build", startedAt: 1 });
  const total = MAX_FINISHED_RUNS + 15;
  for (let i = 0; i < total; i++) {
    state = startRun(state, { id: `done-${i}`, seatSlotId: "reviewer1", label: `Review ${i}`, startedAt: 10 + i });
    state = finishRun(state, `done-${i}`, 20 + i);
  }
  state = startRun(state, { id: "stopped-last", seatSlotId: "reviewer2", label: "Stopped", startedAt: 500 });
  state = stopRun(state, "stopped-last", 501);
  const finished = state.runs.filter((run) => run.status !== "working");
  assert.equal(finished.length, MAX_FINISHED_RUNS);
  assert.equal(finished.at(-1)?.id, "stopped-last", "the newest finished run is kept");
  assert.equal(state.runs.some((run) => run.id === "done-0"), false, "the oldest finished run is dropped");
  assert.equal(state.runs.find((run) => run.id === "live-first")?.status, "working", "a working run is never pruned");
  assert.equal(state.runs.length, MAX_FINISHED_RUNS + 1);
});

test("a run that settles is never pruned itself, even when it started first: the finished run that ended longest ago goes", () => {
  let state = fixedProcess();
  state = startRun(state, { id: "long-run", seatSlotId: "coder", label: "Long build", startedAt: 1 });
  for (let i = 0; i < MAX_FINISHED_RUNS; i++) {
    state = startRun(state, { id: `short-${i}`, seatSlotId: "reviewer1", label: `Review ${i}`, startedAt: 10 + i });
    state = finishRun(state, `short-${i}`, 100 + i);
  }
  assert.equal(state.runs.filter((run) => run.status !== "working").length, MAX_FINISHED_RUNS);
  state = finishRun(state, "long-run", 500);
  const finished = state.runs.filter((run) => run.status !== "working");
  assert.equal(finished.length, MAX_FINISHED_RUNS);
  assert.equal(state.runs.find((run) => run.id === "long-run")?.status, "done", "the run that just settled is kept");
  assert.equal(state.runs.some((run) => run.id === "short-0"), false, "the run that ended longest ago is dropped");
});

test("a run settled without an end time ends now, not at its own start (no zero-length run)", () => {
  let state = fixedProcess();
  state = startRun(state, { id: "no-end-time", seatSlotId: "coder", label: "Build", startedAt: 1 });
  const before = Date.now();
  state = finishRun(state, "no-end-time");
  const run = state.runs.find((item) => item.id === "no-end-time")!;
  assert.ok(run.endedAt! >= before && run.endedAt! > run.startedAt, `ended at ${run.endedAt}`);
});
