import assert from "node:assert/strict";
import test from "node:test";
import { KINDS, approveLook, createTabState, finishRun, getActiveWorkerRuns, getApprovedCardLine, getLeaderStatusLine, getRoundStepIndex, getReviewWaitNames, getSeatTaskLine, getStepOwners, getWorkingSeats, isBusy, reviewFindings, startRun, stopAll, stopRun, stopSeat } from "../server/process.ts";
import { LEGACY, findTemplate, legacySetup, getProcessDefinition } from "./old-definitions.ts";
import { seat, atLook, activeReview, currentStepText } from "./process-helpers.ts";

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
  assert.deepEqual(Object.fromEntries(["main", "duo", "solo"].map((id) => [id, findTemplate(LEGACY.dev[id as "main"])?.name])), {
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
  const setup = legacySetup("dev", "main");
  Object.assign(setup.crew.find((item) => item.slot === "coder")!, { name: "Custom Coder", model: "gpt-6-sol", effort: "high" });
  const state = createTabState(setup, {
    tabId: "tab-1",
    folderPath: "C:\\work\\tab-1",
  });
  assert.equal(state.currentStepIndex, 0);
  assert.equal(state.round, 1);
  assert.equal(state.phase, "review");
  assert.deepEqual(state.approval, { state: "none", reviewWaits: false });
  assert.equal(seat(state, "coder").name, "Custom Coder");
  assert.equal(seat(state, "coder").model, "gpt-6-sol");
  assert.equal(seat(state, "leader").canWrite, false);
  assert.equal(getProcessDefinition("dev", "main").seats[1].model, "gpt-6-luna");
});

test("look approval is only available at the pending look and is consumed once", () => {
  const initial = createTabState(legacySetup("dev", "main"));
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

  const oldCrew = startRun(createTabState(legacySetup("dev", "main"), { folderPath: "C:\\old" }), {
    id: "orphan-run", seatSlotId: "coder", label: "Old coder", startedAt: 2,
  });
  const newCrew = createTabState(legacySetup("dev", "solo"), { folderPath: "C:\\new" });
  newCrew.runs = oldCrew.runs.map((run) => ({ ...run }));
  assert.equal(isBusy(newCrew), true);
  const stopped = stopAll(newCrew, 12);
  assert.equal(stopped.runs[0].status, "stopped");
  assert.equal(stopped.runs[0].endedAt, 12);
  assert.equal(isBusy(stopped), false);
});
