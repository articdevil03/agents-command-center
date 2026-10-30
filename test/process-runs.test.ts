import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FINISHED_RUNS, advanceStep, approveLook, createTabState, failRun, finishFix, finishRun, getApprovedCardLine, getLeaderStatusLine, getRoundStepIndex, getRunViews, getStepBar, getStepOwners, getWorkingSeats, isBusy, reviewClean, reviewFindings, runEvent, selectFixer, startRun, stopRun, stopSeat } from "../server/process.ts";
import { legacySetup, getProcessDefinition } from "./old-definitions.ts";
import { seat, atLook, activeReview } from "./process-helpers.ts";

test("run events snapshot setup and folder, and finalize every terminal outcome", () => {
  const original = createTabState(legacySetup("dev", "main"), {
    folderPath: "C:\\work\\one",
  });
  const started = runEvent(original, {
    type: "start",
    run: { id: "run-1", seatSlotId: "coder", label: "First", startedAt: 10 },
  });
  assert.notStrictEqual(started, original);
  assert.equal(original.runs.length, 0);
  assert.equal(startRun(started, { id: "run-1", seatSlotId: "coder", label: "duplicate", startedAt: 11 }).runs.length, 1, "duplicate run IDs are ignored");
  assert.deepEqual(started.runs[0], {
    id: "run-1", crewGenerationId: 1, seatSlotId: "coder", seatName: "Sonny", seatIsLeader: false, label: "First",
    status: "working", outcome: null, cli: "codex", model: "gpt-6-luna", effort: "max",
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
    ["codex", "gpt-6-luna", "max", "C:\\work\\one"],
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
  let state = createTabState(legacySetup("dev", "main"));
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
  let state = startRun(createTabState(legacySetup("dev", "main")), {
    id: "run", seatSlotId: "coder", label: "One", startedAt: 10,
  });
  state = failRun(state, "run", 12, "exit 1");
  const duplicateStop = stopRun(state, "run", 13);
  assert.equal(duplicateStop.runs[0].status, "failed");
  assert.equal(duplicateStop.runs[0].outcome, "exit 1");
  assert.equal(duplicateStop.runs[0].endedAt, 12);
  assert.equal(stopRun(state, "missing", 14).runs.length, 1);
});

test("review waits are rechecked once after stopping a seat's parallel runs", () => {
  let state = atLook();
  state = startRun(state, { id: "one", seatSlotId: "coder", label: "One", startedAt: 1 });
  state = startRun(state, { id: "two", seatSlotId: "coder", label: "Two", startedAt: 2 });
  state = approveLook(state);
  state = stopSeat(state, "coder", 5);
  assert.ok(state.runs.every((run) => run.status === "stopped" && run.endedAt === 5));
  assert.equal(seat(state, "coder").status, "stopped");
  assert.equal(state.approval.reviewWaits, false);
  assert.equal(seat(state, "reviewer1").status, "working");
  assert.equal(seat(state, "leader").status, "working");
});

test("step advancement cannot skip the look approval or the round result", () => {
  let state = createTabState(legacySetup("dev", "main"));
  while (state.currentStepIndex < 3) state = advanceStep(state);
  assert.equal(state.approval.state, "pending");
  assert.equal(advanceStep(state).currentStepIndex, 3);
  state = approveLook(state);
  assert.equal(advanceStep(state).currentStepIndex, getRoundStepIndex(state));
  state = reviewClean(state);
  assert.equal(state.currentStepIndex, 5);
  assert.equal(getStepOwners(state, 5)[0], "finalReviewer");
  state = advanceStep(state);
  assert.equal(getProcessDefinition("dev", "main").steps[state.currentStepIndex].label, "Ship");
});

test("review history captures assigned names and marketing maker changes", () => {
  let dev = activeReview();
  seat(dev, "reviewer1").name = "Vera Current";
  dev = reviewFindings(dev);
  assert.equal(dev.roundHistory[0].reviewerName, "Vera Current");
  assert.equal(dev.roundHistory[0].fixerName, "Sonny");

  let marketing = activeReview("mkt", "main");
  marketing = reviewFindings(marketing);
  marketing = selectFixer(marketing, "videoAndMotion");
  assert.equal(marketing.roundHistory[0].fixerName, "Terra");
  assert.equal(marketing.roundHistory[0].fixerSlotId, "videoAndMotion");
});

test("derived owners, round flag, approval line, and working seat list follow the current state", () => {
  let state = activeReview();
  assert.deepEqual(getStepOwners(state), ["reviewer1"]);
  assert.deepEqual(getWorkingSeats(state).map((item) => item.slotId).sort(), ["leader", "reviewer1"]);
  assert.equal(getLeaderStatusLine(state), "Working · Round 1 running");
  state = reviewFindings(state);
  assert.deepEqual(getStepOwners(state), ["coder"]);
  assert.equal(getLeaderStatusLine(state), "Working · Round 1 running");
  assert.equal(getApprovedCardLine(state), "Round 1: Sonny is fixing.");
});

test("finished runs are bounded while every working run is kept", () => {
  let state = createTabState(legacySetup("dev", "main"));
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

test("getProcessDefinition: an unknown kind or process is a plain error, never undefined", () => {
  for (const [kind, process] of [["dev", "bad"], ["nope", "main"], ["dev", "constructor"], ["constructor", "main"], ["dev", "__proto__"]] as const) {
    assert.throws(() => getProcessDefinition(kind as ProcessKind, process as ProcessId), /unknown kind\/process/, `${kind}/${process}`);
  }
  assert.equal(getProcessDefinition("dev", "main").steps.length > 0, true);
});

test("a run that settles is never pruned itself, even when it started first: the finished run that ended longest ago goes", () => {
  let state = createTabState(legacySetup("dev", "main"));
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
  let state = createTabState(legacySetup("dev", "main"));
  state = startRun(state, { id: "no-end-time", seatSlotId: "coder", label: "Build", startedAt: 1 });
  const before = Date.now();
  state = finishRun(state, "no-end-time");
  const run = state.runs.find((item) => item.id === "no-end-time")!;
  assert.ok(run.endedAt! >= before && run.endedAt! > run.startedAt, `ended at ${run.endedAt}`);
});

test("the step bar says '1 round' for one finished round and '2 rounds' for two", () => {
  let state = activeReview();
  state = reviewClean(state);
  assert.equal(state.roundHistory.length, 1);
  const labels = getStepBar(state).map((step) => step.label);
  assert.ok(labels.some((label) => label.endsWith("· 1 round")), `one round reads singular: ${JSON.stringify(labels)}`);
  assert.ok(!labels.some((label) => /1 rounds/.test(label)));
  let two = activeReview();
  two = reviewFindings(two);
  two = finishFix(two);
  two = reviewClean(two);
  assert.equal(two.roundHistory.length, 2);
  assert.ok(getStepBar(two).map((step) => step.label).some((label) => label.endsWith("· 2 rounds")));
});
