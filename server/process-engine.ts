import { type Setup, type RunStatus } from "./process-types.ts";
import { createTabState, cloneState, findSeat, leaderSeat, lookStepIndex, getRoundStepIndex, supportsReviewRounds, isAtCurrentReview, getReviewerSlotId, getFixerSlotId, getStepOwners, runIsWorkingForSeat, activateCurrentAssignment, reevaluateReviewGate, markCurrentAssignmentDone, type ProcessState, type ProcessRun } from "./process-core.ts";

/**
 * Moves to the next step. Refused (state unchanged) while any owner of the current step has a working run, except `callerSlot`
 * (the seat that is making this call: its own run is of course still working). The page button has no caller.
 */
export function advanceStep(state: ProcessState, callerSlot?: string): ProcessState {
  const next = cloneState(state);
  const current = next.steps[next.currentStepIndex];
  if (!current || next.currentStepIndex >= next.steps.length - 1) return next;
  if (current.type === "look" || next.currentStepIndex === getRoundStepIndex(next)) return next;
  if (getStepOwners(next).some((slotId) => slotId !== "user" && slotId !== callerSlot && runIsWorkingForSeat(next, slotId))) return next;

  markCurrentAssignmentDone(next);
  next.currentStepIndex += 1;
  const step = next.steps[next.currentStepIndex];
  if (step.type === "look") {
    next.approval = { state: "pending", reviewWaits: false };
    const lead = leaderSeat(next);
    if (lead) {
      lead.status = "waiting";
      lead.task = "Waiting on your look";
    }
  } else if (step.type === "rounds" && lookStepIndex(next) < 0) {
    // No look step: Gate hands straight over to the rounds, which open exactly as they do after the look is approved.
    next.approval = { state: "approved", reviewWaits: true };
    next.round = 1;
    next.phase = "review";
    reevaluateReviewGate(next);
  } else {
    next.approval = { ...next.approval, reviewWaits: false };
    activateCurrentAssignment(next, getStepOwners(next));
  }
  return next;
}

export function approveLook(state: ProcessState): ProcessState {
  const next = cloneState(state);
  const lookIndex = lookStepIndex(next);
  if (lookIndex < 0 || next.currentStepIndex !== lookIndex || next.approval.state !== "pending") return next;

  next.approval.state = "approved";
  if (!supportsReviewRounds(next)) {
    next.phase = "clean";
    next.approval.reviewWaits = false;
    next.currentStepIndex = lookIndex + 1;
    activateCurrentAssignment(next, getStepOwners(next));
    return next;
  }

  next.round = 1;
  next.phase = "review";
  next.currentStepIndex = getRoundStepIndex(next);
  next.approval.reviewWaits = true;
  reevaluateReviewGate(next);
  return next;
}

export interface StartRunInput {
  id: string;
  seatSlotId: string;
  label: string;
  startedAt: number;
}

function createRun(state: ProcessState, input: StartRunInput): ProcessRun | null {
  const seat = findSeat(state, input.seatSlotId);
  if (!seat || state.runs.some((run) => run.id === input.id)) return null;
  return {
    id: input.id,
    crewGenerationId: state.crewGenerationId,
    seatSlotId: seat.slotId,
    seatName: seat.name,
    seatIsLeader: seat.isLeader,
    label: input.label,
    status: "working",
    outcome: null,
    cli: seat.cli,
    model: seat.model,
    effort: seat.effort,
    folderPath: state.folderPath,
    startedAt: input.startedAt,
    endedAt: null,
  };
}

export function startRun(state: ProcessState, input: StartRunInput): ProcessState {
  const next = cloneState(state);
  const run = createRun(next, input);
  if (!run) return next;
  next.runs.push(run);
  const seat = findSeat(next, run.seatSlotId);
  if (seat) {
    seat.status = "working";
    seat.task = input.label;
  }
  reevaluateReviewGate(next);
  return next;
}

function settleRun(state: ProcessState, runId: string, status: Exclude<RunStatus, "working">, outcome: string, endedAt?: number): void {
  const run = state.runs.find((item) => item.id === runId);
  if (!run || run.status !== "working") return;
  run.status = status;
  run.outcome = outcome;
  run.endedAt = endedAt ?? Date.now();

  pruneFinishedRuns(state, runId);
  const seat = findSeat(state, run.seatSlotId);
  if (!seat) return;
  const stillWorking = state.runs.find((item) => item.seatSlotId === run.seatSlotId && item.status === "working");
  if (stillWorking) {
    // A requested stop stays visible while its other runs are still closing.
    if (seat.status !== "stopped") {
      seat.status = "working";
      seat.task = stillWorking.label;
    }
  } else if (seat.status === "working") {
    seat.status = status;
    seat.task = status === "stopped" ? "Stopped by you" : status === "failed" ? "Failed" : "Finished";
  }
}

/** Finished runs kept in state; older ones stay readable through the run logs. */
export const MAX_FINISHED_RUNS = 50;
// Drops the finished runs that ended longest ago, never the one that just settled (a long run started first is not "oldest").
function pruneFinishedRuns(state: ProcessState, keepRunId: string): void {
  const finished = state.runs.filter((run) => run.status !== "working" && run.id !== keepRunId).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  const excess = finished.length + 1 - MAX_FINISHED_RUNS;
  if (excess <= 0) return;
  const dropped = new Set(finished.slice(0, excess).map((run) => run.id));
  state.runs = state.runs.filter((run) => !dropped.has(run.id));
}

export function finishRun(state: ProcessState, runId: string, endedAt?: number, outcome = "done"): ProcessState {
  const next = cloneState(state);
  settleRun(next, runId, "done", outcome, endedAt);
  reevaluateReviewGate(next);
  return next;
}

export function stopRun(state: ProcessState, runId: string, endedAt?: number): ProcessState {
  const next = cloneState(state);
  settleRun(next, runId, "stopped", "stopped", endedAt);
  reevaluateReviewGate(next);
  return next;
}

export function failRun(state: ProcessState, runId: string, endedAt?: number, outcome = "failed"): ProcessState {
  const next = cloneState(state);
  settleRun(next, runId, "failed", outcome, endedAt);
  reevaluateReviewGate(next);
  return next;
}

export type RunEvent =
  | { type: "start"; run: StartRunInput }
  | { type: "finish"; runId: string; endedAt?: number; outcome?: string }
  | { type: "stop"; runId: string; endedAt?: number }
  | { type: "fail"; runId: string; endedAt?: number; outcome?: string };

export function runEvent(state: ProcessState, event: RunEvent): ProcessState {
  if (event.type === "start") return startRun(state, event.run);
  if (event.type === "finish") return finishRun(state, event.runId, event.endedAt, event.outcome);
  if (event.type === "stop") return stopRun(state, event.runId, event.endedAt);
  return failRun(state, event.runId, event.endedAt, event.outcome);
}

/**
 * `closingRunIds` are runs whose process is still alive: the stop is recorded on
 * the seat now, but those runs stay working (holding the review gate) until
 * their confirmed close or an explicit release settles them.
 */
export function stopSeat(state: ProcessState, seatSlotId: string, endedAt?: number, closingRunIds: ReadonlySet<string> = new Set()): ProcessState {
  const next = cloneState(state);
  const runIds = next.runs
    .filter((run) => run.seatSlotId === seatSlotId && run.status === "working")
    .map((run) => run.id);
  for (const runId of runIds) if (!closingRunIds.has(runId)) settleRun(next, runId, "stopped", "stopped", endedAt);
  const seat = findSeat(next, seatSlotId);
  if (seat && (seat.status === "working" || runIds.length > 0)) {
    seat.status = "stopped";
    seat.task = "Stopped by you";
  }
  reevaluateReviewGate(next);
  return next;
}

/** See stopSeat for `closingRunIds`. */
export function stopAll(state: ProcessState, endedAt?: number, closingRunIds: ReadonlySet<string> = new Set()): ProcessState {
  const next = cloneState(state);
  const runIds = next.runs.filter((run) => run.status === "working").map((run) => run.id);
  const workingSeatIds = next.seats.filter((seat) => seat.status === "working").map((seat) => seat.slotId);

  // A review that was waiting for workers must not open on its own after Stop all: its owners and the leader stop with everything else,
  // and the round stays paused until a seat is run again.
  const pausedSlotIds = next.approval.state === "approved" && next.approval.reviewWaits && isAtCurrentReview(next)
    ? [...getStepOwners(next), leaderSeat(next)?.slotId ?? ""] : [];
  if (pausedSlotIds.length) next.approval.reviewWaits = false;

  for (const runId of runIds) if (!closingRunIds.has(runId)) settleRun(next, runId, "stopped", "stopped", endedAt);
  for (const slotId of new Set([...workingSeatIds, ...pausedSlotIds])) {
    const seat = findSeat(next, slotId);
    if (seat) {
      seat.status = "stopped";
      seat.task = "Stopped by you";
    }
  }

  reevaluateReviewGate(next);
  return next;
}

/** Puts a whole new crew and steps on the tab: everything running stops, the process starts again from step one. The caller has already carried over what stays (names, pictures, models). */
export function switchProcess(state: ProcessState, setup: Setup, endedAt?: number): ProcessState {
  const stopped = stopAll(state, endedAt);
  const fresh = createTabState(setup, { tabId: state.tabId, crewGenerationId: state.crewGenerationId + 1, folderPath: state.folderPath });
  return { ...stopped, crewGenerationId: fresh.crewGenerationId, steps: fresh.steps, currentStepIndex: 0, round: 1, phase: "review", approval: fresh.approval, roundHistory: [], seats: fresh.seats, selectedFixer: fresh.selectedFixer };
}

function canReportReview(state: ProcessState, callerSlot?: string): boolean {
  if (
    state.approval.state !== "approved" ||
    state.approval.reviewWaits ||
    !isAtCurrentReview(state) ||
    state.phase !== "review"
  ) return false;
  const reviewer = getReviewerSlotId(state);
  const seat = reviewer ? findSeat(state, reviewer) : undefined;
  // A reviewer may report its own working run; the page must wait for that run to finish.
  return !!seat && seat.status !== "stopped" && seat.status !== "failed" && (reviewer === callerSlot || !runIsWorkingForSeat(state, reviewer));
}

export function reviewFindings(state: ProcessState, callerSlot?: string): ProcessState {
  const next = cloneState(state);
  if (!canReportReview(next, callerSlot)) return next;

  const reviewerSlotId = getReviewerSlotId(next)!;
  const reviewer = findSeat(next, reviewerSlotId)!;
  const fixerSlotId = getFixerSlotId(next)!;
  const assignedFixer = findSeat(next, fixerSlotId);
  if (!assignedFixer) return next;

  next.roundHistory.push({
    round: next.round,
    reviewerSlotId,
    reviewerName: reviewer.name,
    outcome: "findings",
    fixerSlotId,
    fixerName: assignedFixer.name,
  });
  markCurrentAssignmentDone(next);
  next.phase = "fix";
  next.approval.reviewWaits = false;
  activateCurrentAssignment(next, [fixerSlotId, "leader"]);
  return next;
}

export function finishFix(state: ProcessState): ProcessState {
  const next = cloneState(state);
  if (
    next.approval.state !== "approved" ||
    !isAtCurrentReview(next) ||
    next.phase !== "fix"
  ) return next;

  const fixerSlotId = getFixerSlotId(next);
  const seat = fixerSlotId ? findSeat(next, fixerSlotId) : undefined;
  if (!seat || seat.status === "stopped" || seat.status === "failed" || runIsWorkingForSeat(next, fixerSlotId)) {
    return next;
  }

  markCurrentAssignmentDone(next);
  next.round += 1;
  next.phase = "review";
  next.approval.reviewWaits = true;
  reevaluateReviewGate(next);
  return next;
}

export function reviewClean(state: ProcessState, callerSlot?: string): ProcessState {
  const next = cloneState(state);
  if (!canReportReview(next, callerSlot)) return next;

  const reviewerSlotId = getReviewerSlotId(next)!;
  const reviewer = findSeat(next, reviewerSlotId)!;
  next.roundHistory.push({
    round: next.round,
    reviewerSlotId,
    reviewerName: reviewer.name,
    outcome: "clean",
    fixerSlotId: null,
    fixerName: null,
  });
  markCurrentAssignmentDone(next);
  next.phase = "clean";
  next.approval.reviewWaits = false;
  next.currentStepIndex = getRoundStepIndex(next) + 1;
  activateCurrentAssignment(next, getStepOwners(next, next.currentStepIndex).concat("leader"));
  return next;
}

/** Picks who fixes when a pair lists several fixers. Any seat that is a fixer in some pair can be picked; a pair without it keeps its first fixer. */
export function selectFixer(state: ProcessState, seatSlotId: string): ProcessState {
  const next = cloneState(state);
  const roundStep = next.steps[getRoundStepIndex(next)];
  if (!roundStep || roundStep.type !== "rounds" || !roundStep.pairs.some((pair) => pair.fixers.includes(seatSlotId))) return next;
  if (next.selectedFixer === seatSlotId) return next;

  const oldFixer = getFixerSlotId(next);
  next.selectedFixer = seatSlotId;
  const newFixer = getFixerSlotId(next);
  if (isAtCurrentReview(next) && next.phase === "fix" && newFixer && newFixer !== oldFixer) {
    const oldSeat = oldFixer ? findSeat(next, oldFixer) : undefined;
    if (oldSeat?.status === "working" && !runIsWorkingForSeat(next, oldSeat.slotId)) {
      oldSeat.status = "idle";
      oldSeat.task = "Ready";
    }
    const history = [...next.roundHistory].reverse().find((entry) => entry.round === next.round);
    const newSeat = findSeat(next, newFixer);
    if (history && newSeat) {
      history.fixerSlotId = newFixer;
      history.fixerName = newSeat.name;
    }
    activateCurrentAssignment(next, [newFixer]);
  }
  return next;
}

