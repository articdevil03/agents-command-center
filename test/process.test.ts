import assert from "node:assert/strict";
import test from "node:test";
import {
  KINDS,
  MAX_FINISHED_RUNS,
  PROCESS_DEFINITIONS,
  PROCESSES,
  advanceStep,
  approveLook,
  createTabState,
  failRun,
  finishFix,
  finishRun,
  getActiveWorkerRuns,
  getApprovedCardLine,
  getFixerSlotId,
  getLeaderStatusLine,
  getProcessDefinition,
  getRoundFlag,
  getRoundStepIndex,
  getReviewerSlotId,
  getReviewWaitNames,
  getRunViews,
  getSeatTaskLine,
  getStepBar,
  getStepOwners,
  getWorkingSeats,
  isBusy,
  reviewClean,
  reviewFindings,
  runEvent,
  selectMarketingMaker,
  startRun,
  stopAll,
  stopRun,
  stopSeat,
  switchProcess,
  supportsReviewRounds,
  type ProcessId,
  type ProcessKind,
  type ProcessState,
} from "../server/process.ts";

function seat(state: ProcessState, slotId: string) {
  const result = state.seats.find((item) => item.slotId === slotId);
  assert.ok(result, `missing seat ${slotId}`);
  return result;
}

function atLook(kind: ProcessKind = "dev", process: ProcessId = "main", folderPath = "C:\\work") {
  let state = createTabState(kind, process, { tabId: `${kind}-${process}`, folderPath });
  const lookIndex = getProcessDefinition(kind, process).steps.findIndex((step) => step.id === "look");
  assert.notEqual(lookIndex, -1);
  while (state.currentStepIndex < lookIndex) state = advanceStep(state);
  assert.equal(state.currentStepIndex, lookIndex);
  assert.equal(state.approval.state, "pending");
  return state;
}

function activeReview(kind: ProcessKind = "dev", process: ProcessId = "main") {
  return approveLook(atLook(kind, process));
}

function currentStepText(state: ProcessState) {
  return getStepBar(state)[state.currentStepIndex]?.label;
}

test("definitions cover every kind/process pair with the fixed ordered steps and seats", async (t) => {
  const expected: Record<string, { seats: string[]; steps: string[] }> = {
    "dev/main": {
      seats: ["leader", "coder", "reviewer1", "reviewer2", "fixer", "finalReviewer"],
      steps: ["Brief", "Build", "Gate", "Your look", "Review", "Final review", "Ship"],
    },
    "design/main": {
      seats: ["leader", "designer", "imageAndAssets", "designReviewer"],
      steps: ["Brief", "Mock", "Your look", "Review", "Hand off"],
    },
    "mkt/main": {
      seats: ["leader", "secondOpinion", "socialMedia", "image", "videoAndMotion"],
      steps: ["Brief", "Second opinion", "Create", "Your look", "Final check", "Ready"],
    },
    "dev/duo": { seats: ["leader", "coder"], steps: ["Brief", "Build", "Gate", "Your look", "Review", "Ship"] },
    "design/duo": { seats: ["leader", "coder"], steps: ["Brief", "Build", "Gate", "Your look", "Review", "Ship"] },
    "mkt/duo": { seats: ["leader", "coder"], steps: ["Brief", "Build", "Gate", "Your look", "Review", "Ship"] },
    "dev/solo": { seats: ["leader"], steps: ["Brief", "Work", "Your look", "Done"] },
    "design/solo": { seats: ["leader"], steps: ["Brief", "Work", "Your look", "Done"] },
    "mkt/solo": { seats: ["leader"], steps: ["Brief", "Work", "Your look", "Done"] },
  };

  assert.deepEqual(Object.fromEntries(Object.entries(KINDS).map(([id, item]) => [id, item.label])), {
    dev: "Development", design: "Design", mkt: "Marketing",
  });
  assert.deepEqual(Object.fromEntries(Object.entries(PROCESSES).map(([id, item]) => [id, item.label])), {
    main: "The Main Crew", duo: "The Duo", solo: "Stand-alone",
  });

  for (const kind of ["dev", "design", "mkt"] as const) {
    for (const process of ["main", "duo", "solo"] as const) {
      await t.test(`${kind}/${process}`, () => {
        const definition = getProcessDefinition(kind, process);
        const want = expected[`${kind}/${process}`];
        assert.equal(definition.kind, kind);
        assert.equal(definition.process, process);
        assert.deepEqual(definition.seats.map((item) => item.slotId), want.seats);
        assert.deepEqual(definition.steps.map((item) => item.label), want.steps);
        assert.equal(definition.supportsRounds, process !== "solo");
        assert.ok(Object.isFrozen(definition));
      });
    }
  }
});

test("the roster defaults match the mockup and every write permission is explicit", () => {
  const roster = (kind: ProcessKind, process: ProcessId) => getProcessDefinition(kind, process).seats.map((item) => [
    item.slotId, item.defaultName, item.roleLabel, item.cli, item.model, item.effort,
  ]);
  assert.deepEqual(roster("dev", "main"), [
    ["leader", "Atlas", "Leader", "claude", "claude-opus-5-5[1m]", "medium"],
    ["coder", "Sonny", "Coder", "codex", "gpt-6-luna", "max"],
    ["reviewer1", "Vera", "Reviewer 1", "claude", "claude-opus-5-5[1m]", "medium"],
    ["reviewer2", "Sol", "Reviewer 2", "codex", "gpt-6-sol", "high"],
    ["fixer", "Nova", "Fixer", "claude", "claude-opus-5-5[1m]", "medium"],
    ["finalReviewer", "Terra", "Final reviewer", "codex", "gpt-6-sol", "high"],
  ]);
  assert.deepEqual(roster("design", "main"), [
    ["leader", "Atlas", "Leads design", "claude", "claude-opus-5-5[1m]", "high"],
    ["designer", "Terra", "UI and UX designer", "claude", "claude-opus-5-5[1m]", "high"],
    ["imageAndAssets", "X", "Image and assets", "codex", "gpt-6-astra", "medium"],
    ["designReviewer", "Sol", "Design reviewer", "codex", "gpt-6-sol", "high"],
  ]);
  assert.deepEqual(roster("mkt", "main"), [
    ["leader", "Atlas", "Leads marketing", "claude", "claude-opus-5-5[1m]", "high"],
    ["secondOpinion", "Astra", "Second opinion and research", "codex", "gpt-6-astra", "high"],
    ["socialMedia", "Vera", "Social media manager", "claude", "claude-opus-5-5[1m]", "medium"],
    ["image", "X", "Image generation", "codex", "gpt-6-astra", "medium"],
    ["videoAndMotion", "Terra", "Video and motion", "claude", "claude-opus-5-5[1m]", "high"],
  ]);

  for (const kind of ["dev", "design", "mkt"] as const) {
    for (const process of ["main", "duo", "solo"] as const) {
      for (const item of getProcessDefinition(kind, process).seats) {
        if (item.isLeader) assert.equal("canWrite" in item, false, `${kind}/${process}/${item.slotId}`);
        else assert.equal(typeof item.canWrite, "boolean", `${kind}/${process}/${item.slotId}`);
      }
    }
  }
  const canWrite = (kind: ProcessKind, process: ProcessId) => Object.fromEntries(
    getProcessDefinition(kind, process).seats.filter((item) => !item.isLeader).map((item) => [item.slotId, item.canWrite]),
  );
  assert.deepEqual(canWrite("dev", "main"), {
    coder: true, reviewer1: false, reviewer2: false, fixer: true, finalReviewer: false,
  });
  assert.deepEqual(canWrite("dev", "duo"), { coder: true });
  assert.deepEqual(canWrite("design", "main"), {
    designer: true, imageAndAssets: true, designReviewer: false,
  });
  assert.deepEqual(canWrite("mkt", "main"), {
    secondOpinion: false, socialMedia: true, image: true, videoAndMotion: true,
  });
});

test("state creation applies seat preferences without changing the shared definitions", () => {
  const state = createTabState("dev", "main", {
    tabId: "tab-1",
    folderPath: "C:\\work\\tab-1",
    seatOverrides: { coder: { name: "Custom Coder", model: "gpt-6-sol", effort: "high" } },
  });
  assert.equal(state.currentStepIndex, 0);
  assert.equal(state.round, 1);
  assert.equal(state.phase, "review");
  assert.deepEqual(state.approval, { state: "none", reviewWaits: false });
  assert.equal(seat(state, "coder").name, "Custom Coder");
  assert.equal(seat(state, "coder").model, "gpt-6-sol");
  assert.equal("canWrite" in seat(state, "leader"), false);
  assert.equal(getProcessDefinition("dev", "main").seats[1].model, "gpt-6-luna");
});

test("look approval is only available at the pending look and is consumed once", () => {
  const initial = createTabState("dev", "main");
  const misplaced = { ...initial, approval: { state: "pending" as const, reviewWaits: false } };
  const wrongStep = approveLook(misplaced);
  assert.deepEqual(wrongStep, misplaced);
  assert.notStrictEqual(wrongStep, misplaced);

  const pending = atLook();
  const approved = approveLook(pending);
  assert.equal(approved.approval.state, "approved");
  assert.equal(approved.currentStepIndex, getRoundStepIndex(approved));
  assert.equal(approved.phase, "review");
  assert.equal(approved.approval.reviewWaits, false);
  assert.equal(seat(approved, "reviewer1").status, "working");
  assert.equal(getStepOwners(approved)[0], "reviewer1");
  assert.equal(getApprovedCardLine(approved), "Round 1: Vera is reviewing.");
  assert.equal(approveLook(approved).currentStepIndex, approved.currentStepIndex);
  assert.deepEqual(approveLook(approved).approval, approved.approval);
  assert.equal(pending.approval.state, "pending", "transition must not mutate the input state");
});

test("the approval gate waits for every worker run, including runs started during the wait", () => {
  let state = atLook();
  state = startRun(state, { id: "run-a", seatSlotId: "coder", label: "Build A", startedAt: 10 });
  state = startRun(state, { id: "run-b", seatSlotId: "coder", label: "Build B", startedAt: 11 });
  const runStatuses = state.runs.map((run) => [run.id, run.status]);
  state = approveLook(state);

  assert.equal(state.approval.reviewWaits, true);
  assert.equal(seat(state, "leader").status, "waiting");
  assert.equal(seat(state, "reviewer1").status, "idle");
  assert.deepEqual(getActiveWorkerRuns(state).map((run) => run.id), ["run-a", "run-b"]);
  assert.deepEqual(state.runs.map((run) => [run.id, run.status]), runStatuses, "approval must not finish worker runs");
  assert.deepEqual(getReviewWaitNames(state), ["Sonny"]);
  assert.equal(getLeaderStatusLine(state), "Waiting · Waiting for Sonny to finish");
  assert.equal(getApprovedCardLine(state), "Waiting for Sonny to finish.");
  assert.equal(currentStepText(state), "Review · waiting for Sonny to finish");
  assert.equal(getSeatTaskLine(state, "reviewer1"), "Waiting to review");
  assert.equal(isBusy(state), true);

  state = finishRun(state, "run-a", 20);
  assert.equal(seat(state, "reviewer1").status, "idle", "the second original run still blocks review");
  state = startRun(state, { id: "run-late", seatSlotId: "reviewer2", label: "Late work", startedAt: 21 });
  state = stopRun(state, "run-b", 22);
  assert.equal(state.approval.reviewWaits, true);
  assert.equal(seat(state, "reviewer1").status, "idle", "a run added during the wait also blocks review");
  assert.equal(getApprovedCardLine(state), "Waiting for Sol to finish.");
  state = finishRun(state, "run-late", 30);
  assert.equal(state.approval.reviewWaits, false);
  assert.equal(seat(state, "reviewer1").status, "working");
  assert.equal(seat(state, "leader").status, "working");
  assert.equal(currentStepText(state), "Review · round 1 · Vera reviewing");
  assert.equal(getApprovedCardLine(state), "Round 1: Vera is reviewing.");
});

test("Stop all stops the runs and pauses a waiting review: it does not open on its own, and the round stays paused", () => {
  let state = atLook();
  state = startRun(state, { id: "build-1", seatSlotId: "coder", label: "Build 1", startedAt: 1 });
  state = startRun(state, { id: "build-2", seatSlotId: "coder", label: "Build 2", startedAt: 2 });
  state = approveLook(state);
  assert.equal(state.approval.reviewWaits, true, "the review is waiting for the builds before Stop all");
  state = stopAll(state, 9);

  assert.ok(state.runs.every((run) => run.status === "stopped" && run.outcome === "stopped" && run.endedAt === 9));
  assert.equal(seat(state, "coder").status, "stopped");
  assert.equal(seat(state, "reviewer1").status, "stopped", "the waiting reviewer is stopped with everything else");
  assert.equal(seat(state, "leader").status, "stopped", "so is the leader: nothing runs after Stop all");
  assert.equal(state.approval.reviewWaits, false);
  assert.equal(currentStepText(state), "Review · round 1 · Vera stopped");
  assert.deepEqual(getWorkingSeats(state), []);
  assert.equal(isBusy(state), false);

  // The runs that were stopped close later; their close must not open the review either.
  state = finishRun(state, "build-1", 20);
  assert.equal(seat(state, "reviewer1").status, "stopped");
  assert.equal(isBusy(state), false);

  // "Until a seat is run again": a new run of the reviewer starts it.
  state = startRun(state, { id: "review-again", seatSlotId: "reviewer1", label: "Review again", startedAt: 30 });
  assert.equal(seat(state, "reviewer1").status, "working");
});

test("stopping a reviewer does not restart it during gate reevaluation", () => {
  let state = activeReview();
  state = stopAll(state, 5);
  assert.equal(seat(state, "reviewer1").status, "stopped");
  assert.equal(seat(state, "leader").status, "stopped");
  assert.equal(state.approval.reviewWaits, false);
  assert.equal(isBusy(state), false);
  assert.equal(currentStepText(state), "Review · round 1 · Vera stopped");
  assert.equal(getSeatTaskLine(state, "reviewer1"), "Stopped · round 1");
  assert.equal(getApprovedCardLine(state), "Round 1 is paused. Vera was stopped.");

  const unchanged = stopAll(state, 6);
  assert.equal(seat(unchanged, "reviewer1").status, "stopped");
  assert.equal(isBusy(unchanged), false);
  assert.equal(reviewFindings(unchanged).phase, "review", "a stopped reviewer cannot report an outcome");
});

test("Stop all stops a working leader and orphaned run IDs without a current seat", () => {
  let solo = approveLook(atLook("dev", "solo"));
  assert.equal(seat(solo, "leader").status, "working");
  solo = stopSeat(solo, "leader", 20);
  assert.equal(seat(solo, "leader").status, "stopped");
  assert.equal(isBusy(solo), false);

  const oldCrew = startRun(createTabState("dev", "main", { folderPath: "C:\\old" }), {
    id: "orphan-run", seatSlotId: "coder", label: "Old coder", startedAt: 2,
  });
  const newCrew = createTabState("dev", "solo", { folderPath: "C:\\new" });
  newCrew.runs = oldCrew.runs.map((run) => ({ ...run }));
  assert.equal(isBusy(newCrew), true);
  const stopped = stopAll(newCrew, 12);
  assert.equal(stopped.runs[0].status, "stopped");
  assert.equal(stopped.runs[0].endedAt, 12);
  assert.equal(isBusy(stopped), false);
});

test("Development alternates reviewers and fixers while the review bar stays fixed", () => {
  let state = activeReview();
  assert.equal(getReviewerSlotId(state), "reviewer1");
  assert.equal(getFixerSlotId(state), "coder");
  assert.equal(currentStepText(state), "Review · round 1 · Vera reviewing");
  assert.equal(getRoundFlag(state), null);

  state = reviewFindings(state);
  assert.equal(state.phase, "fix");
  assert.equal(getStepOwners(state)[0], "coder");
  assert.equal(currentStepText(state), "Review · round 1 · Sonny fixing");
  assert.deepEqual(state.roundHistory[0], {
    round: 1,
    reviewerSlotId: "reviewer1",
    reviewerName: "Vera",
    outcome: "findings",
    fixerSlotId: "coder",
    fixerName: "Sonny",
  });

  state = finishFix(state);
  assert.equal(state.round, 2);
  assert.equal(state.phase, "review");
  assert.equal(getReviewerSlotId(state), "reviewer2");
  assert.equal(seat(state, "reviewer2").status, "working");
  assert.equal(getRoundFlag(state), null, "round 2 does not display the escalation flag");
  assert.equal(getFixerSlotId(state), "fixer");
  state = reviewFindings(state);
  assert.equal(getStepOwners(state)[0], "fixer");
  assert.equal(currentStepText(state), "Review · round 2 · Nova fixing");
  state = finishFix(state);
  assert.equal(state.round, 3);
  assert.equal(getReviewerSlotId(state), "reviewer1");
  assert.equal(getRoundFlag(state), "↻ Round 3");
  state = reviewClean(state);
  assert.equal(state.phase, "clean");
  assert.equal(state.currentStepIndex, 5);
  assert.equal(getStepOwners(state)[0], "finalReviewer");
  assert.equal(seat(state, "finalReviewer").status, "working");
  assert.equal(getApprovedCardLine(state), "Final review is running.");
  assert.equal(getRoundFlag(state), null);
  assert.deepEqual(state.roundHistory.map((item) => [item.round, item.reviewerName, item.outcome, item.fixerName]), [
    [1, "Vera", "findings", "Sonny"],
    [2, "Sol", "findings", "Nova"],
    [3, "Vera", "clean", null],
  ]);
});

test("a newly assigned development fixer restarts, but a stopped reviewer stays stopped", () => {
  let state = activeReview();
  state = startRun(state, { id: "parallel-coder", seatSlotId: "coder", label: "Extra work", startedAt: 1 });
  state = stopRun(state, "parallel-coder", 2);
  assert.equal(seat(state, "coder").status, "stopped");
  state = reviewFindings(state);
  assert.equal(seat(state, "coder").status, "working");

  state = stopSeat(state, "coder", 3);
  assert.equal(seat(state, "coder").status, "stopped");
  assert.equal(finishFix(state).phase, "fix", "a stopped fixer cannot finish the assignment");
  assert.equal(seat(finishFix(state), "coder").status, "stopped");
});

test("review and fix outcomes wait until their actual runs have settled", () => {
  let review = startRun(activeReview(), { id: "reviewer-run", seatSlotId: "reviewer1", label: "reviewing", startedAt: 1 });
  assert.equal(reviewFindings(review).phase, "review");
  assert.equal(reviewClean(review).phase, "review");
  review = finishRun(review, "reviewer-run", 2);
  let fix = reviewFindings(activeReview());
  fix = startRun(fix, { id: "fixer-run", seatSlotId: "coder", label: "fixing", startedAt: 3 });
  assert.equal(finishFix(fix).phase, "fix");
  assert.equal(finishFix(fix).round, 1);
  fix = finishRun(fix, "fixer-run", 4);
  assert.equal(finishFix(fix).round, 2);
});

test("leader runs are visible but excluded from the active worker list", () => {
  const leaderRun = startRun(createTabState("dev", "main"), { id: "leader-run", seatSlotId: "leader", label: "leader work", startedAt: 1 });
  assert.equal(leaderRun.runs[0].seatIsLeader, true);
  assert.deepEqual(getActiveWorkerRuns(leaderRun), []);
  assert.equal(getWorkingSeats(leaderRun).some((item) => item.slotId === "leader" && item.isLeader), true);
});

test("Duo uses the leader as reviewer and coder as fixer, with the same wait gate", () => {
  let state = atLook("design", "duo");
  state = startRun(state, { id: "duo-coder", seatSlotId: "coder", label: "Duo work", startedAt: 1 });
  state = approveLook(state);
  assert.equal(getReviewerSlotId(state), "leader");
  assert.equal(state.approval.reviewWaits, true);
  assert.equal(seat(state, "leader").status, "waiting");
  assert.equal(getApprovedCardLine(state), "Waiting for Sonny to finish.");
  state = finishRun(state, "duo-coder", 3);
  assert.equal(seat(state, "leader").status, "working");
  assert.equal(currentStepText(state), "Review · round 1 · Atlas reviewing");
  state = reviewFindings(state);
  assert.equal(getStepOwners(state)[0], "coder");
  assert.equal(currentStepText(state), "Review · round 1 · Sonny fixing");
  state = finishFix(state);
  assert.equal(state.round, 2);
  assert.equal(getReviewerSlotId(state), "leader");
  assert.equal(currentStepText(state), "Review · round 2 · Atlas reviewing");
  assert.deepEqual(state.roundHistory[0], {
    round: 1, reviewerSlotId: "leader", reviewerName: "Atlas", outcome: "findings",
    fixerSlotId: "coder", fixerName: "Sonny",
  });
  state = reviewClean(state);
  assert.equal(getProcessDefinition("design", "duo").steps[state.currentStepIndex].label, "Ship");

  let stopped = activeReview("dev", "duo");
  stopped = reviewFindings(stopped);
  stopped = stopAll(stopped);
  assert.equal(seat(stopped, "coder").status, "stopped");
  assert.equal(isBusy(stopped), false);
  assert.equal(currentStepText(stopped), "Review · round 1 · Sonny stopped");
  assert.equal(getApprovedCardLine(stopped), "Round 1 is paused. Sonny was stopped.");
});

test("Design review findings go to Terra and return to Sol for another check", () => {
  let state = activeReview("design", "main");
  assert.equal(getReviewerSlotId(state), "designReviewer");
  assert.equal(currentStepText(state), "Review · round 1 · Sol reviewing");
  state = reviewFindings(state);
  assert.equal(getFixerSlotId(state), "designer");
  assert.equal(currentStepText(state), "Review · round 1 · Terra fixing");
  state = finishFix(state);
  assert.equal(state.round, 2);
  assert.equal(getReviewerSlotId(state), "designReviewer");
  assert.equal(currentStepText(state), "Review · round 2 · Sol reviewing");
  state = reviewClean(state);
  assert.equal(getProcessDefinition("design", "main").steps[state.currentStepIndex].label, "Hand off");
});

test("Marketing uses Astra for checks and only restarts a maker after reassignment", () => {
  let state = activeReview("mkt", "main");
  assert.equal(getReviewerSlotId(state), "secondOpinion");
  assert.equal(state.selectedMakerSlotId, "socialMedia");
  state = reviewFindings(state);
  assert.equal(getFixerSlotId(state), "socialMedia");
  assert.equal(currentStepText(state), "Final check · round 1 · Vera fixing");
  assert.equal(state.roundHistory[0].fixerName, "Vera");

  state = stopSeat(state, "socialMedia", 5);
  assert.equal(seat(state, "socialMedia").status, "stopped");
  state = selectMarketingMaker(state, "socialMedia");
  assert.equal(seat(state, "socialMedia").status, "stopped", "choosing the same maker is not a new assignment");
  state = selectMarketingMaker(state, "image");
  assert.equal(state.selectedMakerSlotId, "image");
  assert.equal(seat(state, "image").status, "working");
  assert.equal(seat(state, "socialMedia").status, "stopped");
  assert.equal(getFixerSlotId(state), "image");
  assert.equal(state.roundHistory[0].fixerName, "X");
  assert.equal(currentStepText(state), "Final check · round 1 · X fixing");

  state = finishFix(state);
  assert.equal(state.round, 2);
  assert.equal(getReviewerSlotId(state), "secondOpinion");
  assert.equal(seat(state, "secondOpinion").status, "working");
  state = reviewClean(state);
  assert.equal(getProcessDefinition("mkt", "main").steps[state.currentStepIndex].label, "Ready");
  assert.equal(getApprovedCardLine(state), "Atlas is finishing up.");
});

test("Stand-alone has no review rounds and approval moves directly to Done", () => {
  let state = atLook("mkt", "solo");
  assert.equal(supportsReviewRounds(state), false);
  assert.equal(getRoundStepIndex(state), -1);
  assert.equal(getReviewerSlotId(state), null);
  assert.equal(getFixerSlotId(state), null);
  state = approveLook(state);
  assert.equal(getProcessDefinition("mkt", "solo").steps[state.currentStepIndex].label, "Done");
  assert.equal(state.phase, "clean");
  assert.equal(seat(state, "leader").status, "working");
  assert.equal(getApprovedCardLine(state), "Atlas is finishing up.");
  assert.equal(reviewFindings(state).currentStepIndex, state.currentStepIndex);
  assert.equal(reviewClean(state).roundHistory.length, 0);
  assert.equal(getRoundFlag(state), null);
});

test("all nine combinations can reach the look and either start a round or finish solo", async (t) => {
  const firstReview: Record<ProcessKind, string> = { dev: "reviewer1", design: "designReviewer", mkt: "secondOpinion" };
  for (const kind of ["dev", "design", "mkt"] as const) {
    for (const process of ["main", "duo", "solo"] as const) {
      await t.test(`${kind}/${process}`, () => {
        let state = approveLook(atLook(kind, process));
        if (process === "solo") {
          const done = getProcessDefinition(kind, process).steps[state.currentStepIndex];
          assert.equal(done.label, "Done");
          assert.equal(seat(state, "leader").status, "working");
          return;
        }
        const reviewer = process === "duo" ? "leader" : firstReview[kind];
        const worker = getProcessDefinition(kind, process).seats.find((item) => !item.isLeader && item.slotId !== reviewer)!;
        assert.ok(worker, `no worker for ${kind}/${process}`);
        state = atLook(kind, process);
        state = startRun(state, { id: `${kind}-${process}-gate`, seatSlotId: worker.slotId, label: "Gate check", startedAt: 1 });
        state = approveLook(state);
        assert.equal(state.approval.reviewWaits, true);
        assert.equal(getReviewerSlotId(state), reviewer);
        assert.notEqual(seat(state, reviewer).status, "working");
        state = finishRun(state, `${kind}-${process}-gate`, 2);
        assert.equal(state.approval.reviewWaits, false);
        assert.equal(seat(state, reviewer).status, "working");
        assert.equal(getStepOwners(state)[0], reviewer);
      });
    }
  }
});

test("all nine combinations switch cleanly, stop old runs, and keep old run identity", async (t) => {
  for (const kind of ["dev", "design", "mkt"] as const) {
    for (const process of ["main", "duo", "solo"] as const) {
      await t.test(`${kind}/${process}`, () => {
        const processes: ProcessId[] = ["main", "duo", "solo"];
        const nextProcess = processes[(processes.indexOf(process) + 1) % processes.length];
        let state = atLook(kind, process, "C:\\work\\switch");
        const worker = getProcessDefinition(kind, process).seats.find((item) => !item.isLeader);
        const assignedSlot = worker?.slotId ?? "leader";
        state = startRun(state, { id: `old-${kind}-${process}`, seatSlotId: assignedSlot, label: "Old work", startedAt: 1 });
        const switched = switchProcess(state, nextProcess, 8);

        assert.equal(state.process, process, "switching must not mutate the old state");
        assert.equal(switched.process, nextProcess);
        assert.equal(switched.crewGenerationId, state.crewGenerationId + 1);
        assert.equal(switched.currentStepIndex, 0);
        assert.deepEqual(switched.approval, { state: "none", reviewWaits: false });
        assert.equal(switched.roundHistory.length, 0);
        assert.equal(switched.folderPath, "C:\\work\\switch");
        assert.equal(switched.runs[0].status, "stopped");
        assert.equal(switched.runs[0].endedAt, 8);
        assert.equal(switched.runs[0].crewGenerationId, state.crewGenerationId);
        assert.equal(getRunViews(switched).retiredHistory[0].id, `old-${kind}-${process}`);
        assert.deepEqual(switched.seats.map((item) => item.slotId), getProcessDefinition(kind, nextProcess).seats.map((item) => item.slotId));
        assert.equal(isBusy(switched), false);

        let ready = switched;
        const lookIndex = getProcessDefinition(kind, nextProcess).steps.findIndex((step) => step.id === "look");
        while (ready.currentStepIndex < lookIndex) ready = advanceStep(ready);
        ready = approveLook(ready);
        if (nextProcess === "solo") assert.equal(getProcessDefinition(kind, nextProcess).steps[ready.currentStepIndex].label, "Done");
        else assert.equal(seat(ready, getReviewerSlotId(ready)!).status, "working");
      });
    }
  }
});

test("run events snapshot setup and folder, and finalize every terminal outcome", () => {
  const original = createTabState("dev", "main", {
    folderPath: "C:\\work\\one",
    seatOverrides: { coder: { cli: "codex", model: "gpt-6-luna", effort: "max" } },
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
  let state = createTabState("dev", "main");
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
  let state = startRun(createTabState("dev", "main"), {
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
  let state = createTabState("dev", "main");
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
  marketing = selectMarketingMaker(marketing, "videoAndMotion");
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
  let state = createTabState("dev", "main");
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
  let state = createTabState("dev", "main");
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
  let state = createTabState("dev", "main");
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
