import { findSeat, isAtCurrentReview, getReviewerSlotId, getFixerSlotId, leaderSeat, getRoundStepIndex, supportsReviewRounds, getStepOwners, activeRunNames, joinedNames, leaderTask, type ProcessState, type ProcessRun } from "./process-core.ts";
import type { StepType } from "./process-types.ts";

export function getReviewWaitNames(state: ProcessState): readonly string[] {
  if (
    state.approval.state !== "approved" ||
    !state.approval.reviewWaits ||
    !isAtCurrentReview(state)
  ) return [];
  return activeRunNames(state);
}

export function getStepBar(state: ProcessState): readonly {
  stepId: string;
  label: string;
  type: StepType;
  state: "done" | "current" | "upcoming";
  owners: readonly string[];
}[] {
  const reviewIndex = getRoundStepIndex(state);
  const waiting = getReviewWaitNames(state);
  return state.steps.map((step, index) => {
    let label = step.label;
    let owners: readonly string[] = getStepOwners(state, index);
    if (index === reviewIndex) {
      if (index === state.currentStepIndex && state.phase !== "clean") {
        const actor = owners[0] ? findSeat(state, owners[0]) : undefined;
        if (waiting.length) label += ` · waiting for ${joinedNames(waiting)} to finish`;
        else if (actor?.status === "stopped") label += ` · round ${state.round} · ${actor.name} stopped`;
        else label += ` · round ${state.round} · ${actor?.name ?? owners[0] ?? ""} ${state.phase === "fix" ? "fixing" : "reviewing"}`;
      } else if (index < state.currentStepIndex && state.roundHistory.length > 0) {
        label += ` · ${state.roundHistory.length} ${state.roundHistory.length === 1 ? "round" : "rounds"}`;
      }
    }
    return {
      stepId: step.id,
      label,
      type: step.type,
      state: index < state.currentStepIndex ? "done" : index === state.currentStepIndex ? "current" : "upcoming",
      owners,
    };
  });
}

export function getApprovedCardLine(state: ProcessState): string | null {
  if (state.approval.state !== "approved") return null;
  const waiting = getReviewWaitNames(state);
  if (waiting.length) return `Waiting for ${joinedNames(waiting)} to finish.`;

  if (state.currentStepIndex === getRoundStepIndex(state) && state.phase !== "clean") {
    const slotId = getStepOwners(state)[0];
    const seat = slotId ? findSeat(state, slotId) : undefined;
    if (seat?.status === "stopped") return `Round ${state.round} is paused. ${seat.name} was stopped.`;
    return `Round ${state.round}: ${seat?.name ?? slotId ?? "The assigned seat"} is ${state.phase === "fix" ? "fixing" : "reviewing"}.`;
  }

  const step = state.steps[state.currentStepIndex];
  if (!step) return "Waiting for the next step.";
  if (step.type === "finish") {
    const owner = step.owners.map((slotId) => findSeat(state, slotId)).find(Boolean);
    return `${owner?.name ?? leaderSeat(state)?.name ?? "Leader"} is finishing up.`;
  }
  return `${step.label} is running.`;
}

export function getLeaderStatusLine(state: ProcessState): string {
  const lead = leaderSeat(state);
  if (!lead) return "Idle · Ready";
  const waiting = getReviewWaitNames(state);
  if (waiting.length) return `Waiting · Waiting for ${joinedNames(waiting)} to finish`;
  const step = state.steps[state.currentStepIndex];
  if (step?.type === "look" && state.approval.state === "pending") return "Waiting · Waiting on your look";
  if (lead.status === "stopped") return "Stopped · Stopped by you";
  if (lead.status === "failed") return "Failed · Failed";
  if (lead.status === "done") return "Done · Finished";
  if (lead.status === "waiting") return `Waiting · ${lead.task}`;
  if (lead.status === "working") return `Working · ${leaderTask(state)}`;
  return "Idle · Ready";
}

export function getSeatTaskLine(state: ProcessState, seatSlotId: string): string {
  const seat = findSeat(state, seatSlotId);
  if (!seat || seat.isLeader) return "";
  const reviewIndex = getRoundStepIndex(state);
  if (state.currentStepIndex === reviewIndex && state.phase !== "clean" && getStepOwners(state).includes(seatSlotId)) {
    if (getReviewWaitNames(state).length) return "Waiting to review";
    if (seat.status === "stopped") return `Stopped · round ${state.round}`;
    return `${state.phase === "fix" ? "Fixing" : "Reviewing"} · round ${state.round}`;
  }
  const live = state.runs.filter((run) => run.seatSlotId === seatSlotId && run.status === "working");
  if (live.length > 1) return "";
  if (live[0]) return live[0].label;
  return seat.status === "working" ? seat.task : "";
}

export function getWorkingSeats(state: ProcessState): readonly { slotId: string; name: string; isLeader: boolean }[] {
  const working = new Map<string, { slotId: string; name: string; isLeader: boolean }>();
  for (const seat of state.seats) {
    if (seat.status === "working") working.set(seat.slotId, { slotId: seat.slotId, name: seat.name, isLeader: seat.isLeader });
  }
  for (const run of state.runs) {
    if (run.status !== "working") continue;
    const seat = findSeat(state, run.seatSlotId);
    working.set(run.seatSlotId, {
      slotId: run.seatSlotId,
      name: seat?.name ?? run.seatName,
      isLeader: seat?.isLeader ?? run.seatIsLeader,
    });
  }
  return [...working.values()];
}

export function isBusy(state: ProcessState): boolean {
  return state.seats.some((seat) => seat.status === "working") || state.runs.some((run) => run.status === "working");
}

export interface RunViews {
  liveBySeat: Readonly<Record<string, readonly ProcessRun[]>>;
  history: readonly ProcessRun[];
  retiredHistory: readonly ProcessRun[];
}

export function getRunViews(state: ProcessState): RunViews {
  const liveBySeat: Record<string, readonly ProcessRun[]> = {};
  for (const seat of state.seats) {
    const runs = state.runs.filter((run) => run.crewGenerationId === state.crewGenerationId && run.seatSlotId === seat.slotId);
    if (runs.some((run) => run.status === "working")) {
      liveBySeat[seat.slotId] = runs.map((run) => ({ ...run }));
    }
  }
  return {
    liveBySeat,
    history: state.runs
      .filter((run) => run.crewGenerationId === state.crewGenerationId && run.status !== "working")
      .map((run) => ({ ...run })),
    retiredHistory: state.runs
      .filter((run) => run.crewGenerationId !== state.crewGenerationId)
      .map((run) => ({ ...run })),
  };
}

export function getRoundFlag(state: ProcessState): string | null {
  return supportsReviewRounds(state) && state.currentStepIndex === getRoundStepIndex(state) && state.round > 2
    ? `↻ Round ${state.round}`
    : null;
}
