import assert from "node:assert/strict";
import test from "node:test";
import { advanceStep, approveLook, createTabState, finishFix, finishRun, getActiveWorkerRuns, getApprovedCardLine, getFixerSlotId, getRoundFlag, getRoundStepIndex, getReviewerSlotId, getRunViews, getStepOwners, getWorkingSeats, isBusy, reviewClean, reviewFindings, selectFixer, startRun, stopAll, stopRun, stopSeat, switchProcess, supportsReviewRounds } from "../server/process.ts";
import { legacySetup, getProcessDefinition } from "./old-definitions.ts";
import { seat, atLook, activeReview, currentStepText } from "./process-helpers.ts";

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
  const leaderRun = startRun(createTabState(legacySetup("dev", "main")), { id: "leader-run", seatSlotId: "leader", label: "leader work", startedAt: 1 });
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
  assert.equal(state.selectedFixer, "socialMedia");
  state = reviewFindings(state);
  assert.equal(getFixerSlotId(state), "socialMedia");
  assert.equal(currentStepText(state), "Final check · round 1 · Vera fixing");
  assert.equal(state.roundHistory[0].fixerName, "Vera");

  state = stopSeat(state, "socialMedia", 5);
  assert.equal(seat(state, "socialMedia").status, "stopped");
  state = selectFixer(state, "socialMedia");
  assert.equal(seat(state, "socialMedia").status, "stopped", "choosing the same maker is not a new assignment");
  state = selectFixer(state, "image");
  assert.equal(state.selectedFixer, "image");
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
        const switched = switchProcess(state, legacySetup(kind, nextProcess), 8);

        assert.deepEqual(state.seats.map((item) => item.slotId), getProcessDefinition(kind, process).seats.map((item) => item.slotId), "switching must not mutate the old state");
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
