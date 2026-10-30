import { copy, stepOwners, type Seat, type Step, type Setup, type RoundPair, type SeatStatus, type RunStatus, type ProcessPhase, type ApprovalState, type ReviewOutcome } from "./process-types.ts";

export interface SeatState {
  slotId: string;
  name: string;
  roleLabel: string;
  cli: string;
  model: string;
  effort: string;
  isLeader: boolean;
  canWrite: boolean;
  advisor?: string;
  orchestrates?: boolean;
  status: SeatStatus;
  task: string;
}

export interface RoundHistoryEntry {
  round: number;
  reviewerSlotId: string;
  reviewerName: string;
  outcome: ReviewOutcome;
  fixerSlotId: string | null;
  fixerName: string | null;
}

export interface ProcessRun {
  id: string;
  crewGenerationId: number;
  seatSlotId: string;
  seatName: string;
  seatIsLeader: boolean;
  label: string;
  status: RunStatus;
  outcome: string | null;
  cli: string;
  model: string;
  effort: string;
  folderPath: string;
  startedAt: number;
  endedAt: number | null;
}

export interface ProcessState {
  tabId: string;
  crewGenerationId: number;
  folderPath: string;
  steps: Step[];
  currentStepIndex: number;
  round: number;
  phase: ProcessPhase;
  approval: { state: ApprovalState; reviewWaits: boolean };
  roundHistory: RoundHistoryEntry[];
  seats: SeatState[];
  runs: ProcessRun[];
  selectedFixer: string | null;
}

export interface CreateTabStateOptions {
  tabId?: string;
  crewGenerationId?: number;
  folderPath?: string;
}

export function cloneState(state: ProcessState): ProcessState {
  return {
    ...state,
    steps: copy(state.steps),
    approval: { ...state.approval },
    roundHistory: state.roundHistory.map((entry) => ({ ...entry })),
    seats: state.seats.map((seat) => ({ ...seat })),
    runs: state.runs.map((run) => ({ ...run })),
  };
}

export function seatsFrom(crew: readonly Seat[]): SeatState[] {
  return crew.map((member): SeatState => ({
    slotId: member.slot,
    name: member.name,
    roleLabel: member.role,
    cli: member.cli,
    model: member.model,
    effort: member.effort,
    isLeader: member.isLeader,
    canWrite: member.canWrite,
    ...(member.advisor !== undefined ? { advisor: member.advisor } : {}),
    ...(member.orchestrates === true ? { orchestrates: true } : {}),
    status: "idle",
    task: "Ready",
  }));
}
// A rounds step with several fixers in a pair starts on the first one (the picker shows it checked).
export function initialFixer(steps: readonly Step[]): string | null {
  for (const step of steps) if (step.type === "rounds") for (const pair of step.pairs) if (pair.fixers.length > 1) return pair.fixers[0];
  return null;
}

export function createTabState(setup: Setup, options: CreateTabStateOptions = {}): ProcessState {
  return {
    tabId: options.tabId ?? "tab",
    crewGenerationId: options.crewGenerationId ?? 1,
    folderPath: options.folderPath ?? "",
    steps: copy(setup.steps),
    currentStepIndex: 0,
    round: 1,
    phase: "review",
    approval: { state: "none", reviewWaits: false },
    roundHistory: [],
    seats: seatsFrom(setup.crew),
    runs: [],
    selectedFixer: initialFixer(setup.steps),
  };
}

export function findSeat(state: ProcessState, slotId: string): SeatState | undefined {
  return state.seats.find((seat) => seat.slotId === slotId);
}

export function leaderSeat(state: ProcessState): SeatState | undefined {
  return state.seats.find((seat) => seat.isLeader) ?? state.seats[0];
}

export function getRoundStepIndex(state: ProcessState): number {
  return state.steps.findIndex((step) => step.type === "rounds");
}
export const lookStepIndex = (state: ProcessState): number => state.steps.findIndex((step) => step.type === "look");

export function supportsReviewRounds(state: ProcessState): boolean {
  return getRoundStepIndex(state) >= 0;
}

export function pairFor(state: ProcessState, round: number): RoundPair | null {
  const step = state.steps[getRoundStepIndex(state)];
  if (!step || step.type !== "rounds") return null;
  return step.pairs[(round - 1) % step.pairs.length];
}

export function getReviewerSlotId(state: ProcessState, round = state.round): string | null {
  return pairFor(state, round)?.reviewer ?? null;
}

export function getFixerSlotId(state: ProcessState, round = state.round): string | null {
  const pair = pairFor(state, round);
  if (!pair) return null;
  return state.selectedFixer && pair.fixers.includes(state.selectedFixer) ? state.selectedFixer : pair.fixers[0];
}

export function getStepOwners(state: ProcessState, stepIndex = state.currentStepIndex): readonly string[] {
  const step = state.steps[stepIndex];
  if (!step) return [];
  if (step.type === "rounds") {
    if (stepIndex !== state.currentStepIndex) return stepOwners(step);
    if (state.phase === "review") {
      const reviewer = getReviewerSlotId(state);
      return reviewer ? [reviewer] : [];
    }
    if (state.phase === "fix") {
      const assignedFixer = getFixerSlotId(state);
      return assignedFixer ? [assignedFixer] : [];
    }
    return [];
  }
  return step.owners;
}

export function getActiveWorkerRuns(state: ProcessState): readonly ProcessRun[] {
  // The seat that runs the process works for the whole pack: its own run never holds a review round back (it would wait for itself).
  return state.runs.filter((run) => run.status === "working" && !run.seatIsLeader && !findSeat(state, run.seatSlotId)?.orchestrates);
}

export function runIsWorkingForSeat(state: ProcessState, slotId: string): boolean {
  return state.runs.some((run) => run.seatSlotId === slotId && run.status === "working");
}

export function activeRunNames(state: ProcessState): string[] {
  const names = new Set<string>();
  for (const run of getActiveWorkerRuns(state)) {
    names.add(findSeat(state, run.seatSlotId)?.name ?? run.seatName ?? run.seatSlotId);
  }
  return [...names];
}

export function joinedNames(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function isAtCurrentReview(state: ProcessState): boolean {
  return getRoundStepIndex(state) >= 0 && state.currentStepIndex === getRoundStepIndex(state);
}

export function leaderTask(state: ProcessState): string {
  if (isAtCurrentReview(state) && state.phase !== "clean") return `Round ${state.round} running`;
  const step = state.steps[state.currentStepIndex];
  return step ? `Running ${step.label}` : "Ready";
}

export function currentAssignmentTask(state: ProcessState, slotId: string): string {
  if (isAtCurrentReview(state) && getStepOwners(state).includes(slotId)) {
    return `${state.phase === "fix" ? "Fixing" : "Reviewing"} · round ${state.round}`;
  }
  const step = state.steps[state.currentStepIndex];
  return step?.label ?? "Working";
}

export function activateCurrentAssignment(state: ProcessState, restartSlots: readonly string[]): void {
  const owners = getStepOwners(state).filter((slotId) => slotId !== "user");
  const restart = new Set(restartSlots);
  const assigned = new Set(owners);

  for (const seat of state.seats) {
    if (seat.status === "working" && !runIsWorkingForSeat(state, seat.slotId) && !assigned.has(seat.slotId)) {
      seat.status = "idle";
      seat.task = "Ready";
    }
  }

  for (const slotId of owners) {
    const seat = findSeat(state, slotId);
    if (!seat || (seat.status === "stopped" && !restart.has(slotId))) continue;
    seat.status = "working";
    seat.task = currentAssignmentTask(state, slotId);
  }

  const lookIndex = lookStepIndex(state);
  const lead = leaderSeat(state);
  if (lead && lookIndex >= 0 && state.currentStepIndex > lookIndex && !assigned.has(lead.slotId)) {
    if (lead.status !== "stopped" || restart.has(lead.slotId)) {
      lead.status = "working";
      lead.task = leaderTask(state);
    }
  }
}

export function holdReviewWhileWorkersRun(state: ProcessState): boolean {
  if (
    state.approval.state !== "approved" ||
    !state.approval.reviewWaits ||
    !isAtCurrentReview(state) ||
    activeRunNames(state).length === 0
  ) return false;

  const names = activeRunNames(state);
  const lead = leaderSeat(state);
  if (lead) {
    lead.status = "waiting";
    lead.task = `Waiting for ${joinedNames(names)} to finish`;
  }

  for (const slotId of getStepOwners(state)) {
    const seat = findSeat(state, slotId);
    if (!seat || seat.isLeader || seat.status === "stopped" || runIsWorkingForSeat(state, slotId)) continue;
    seat.status = "idle";
    seat.task = "Ready";
  }
  return true;
}

export function reevaluateReviewGate(state: ProcessState): void {
  if (state.approval.state !== "approved" || !state.approval.reviewWaits || !isAtCurrentReview(state)) return;
  if (holdReviewWhileWorkersRun(state)) return;

  state.approval.reviewWaits = false;
  activateCurrentAssignment(state, [...getStepOwners(state), "leader"]);
}

export function markCurrentAssignmentDone(state: ProcessState): void {
  const assigned = new Set(getStepOwners(state).filter((slotId) => slotId !== "user"));
  const lead = leaderSeat(state);
  if (lead && state.currentStepIndex >= 0) assigned.add(lead.slotId);
  for (const seat of state.seats) {
    if (assigned.has(seat.slotId) && seat.status === "working" && !runIsWorkingForSeat(state, seat.slotId)) {
      seat.status = "done";
      seat.task = "Finished";
    }
  }
}
