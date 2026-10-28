export type ProcessKind = "dev" | "design" | "mkt";
export type ProcessId = "main" | "duo" | "solo";
export type ProcessPhase = "review" | "fix" | "clean";
export type ApprovalState = "none" | "pending" | "approved";
export type SeatStatus = "idle" | "working" | "waiting" | "done" | "stopped" | "failed";
export type RunStatus = "working" | "done" | "stopped" | "failed";
export type ReviewOutcome = "findings" | "clean";

export interface SeatDefinition {
  slotId: string;
  defaultName: string;
  roleLabel: string;
  cli: string;
  model: string;
  effort: string;
  isLeader: boolean;
  canWrite?: boolean;
}

export interface ProcessStep {
  id: string;
  label: string;
  /** All slots that may own this fixed step. Review/fix ownership is resolved by round. */
  owners: readonly string[];
}

export interface ProcessDefinition {
  kind: ProcessKind;
  process: ProcessId;
  label: string;
  supportsRounds: boolean;
  steps: readonly ProcessStep[];
  seats: readonly SeatDefinition[];
}

type DeepReadonly<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const KINDS = deepFreeze({
  dev: { label: "Development" },
  design: { label: "Design" },
  mkt: { label: "Marketing" },
} satisfies Record<ProcessKind, { label: string }>);

export const PROCESSES = deepFreeze({
  main: { label: "The Main Crew" },
  duo: { label: "The Duo" },
  solo: { label: "Stand-alone" },
} satisfies Record<ProcessId, { label: string }>);

const leadDev: SeatDefinition = {
  slotId: "leader",
  defaultName: "Atlas",
  roleLabel: "Leader",
  cli: "claude",
  model: "claude-opus-5-5[1m]",
  effort: "medium",
  isLeader: true,
};
const coder: SeatDefinition = {
  slotId: "coder",
  defaultName: "Sonny",
  roleLabel: "Coder",
  cli: "codex",
  model: "gpt-6-luna",
  effort: "max",
  isLeader: false,
  canWrite: true,
};
const reviewer1: SeatDefinition = {
  slotId: "reviewer1",
  defaultName: "Vera",
  roleLabel: "Reviewer 1",
  cli: "claude",
  model: "claude-opus-5-5[1m]",
  effort: "medium",
  isLeader: false,
  canWrite: false,
};
const reviewer2: SeatDefinition = {
  slotId: "reviewer2",
  defaultName: "Sol",
  roleLabel: "Reviewer 2",
  cli: "codex",
  model: "gpt-6-sol",
  effort: "high",
  isLeader: false,
  canWrite: false,
};
const fixer: SeatDefinition = {
  slotId: "fixer",
  defaultName: "Nova",
  roleLabel: "Fixer",
  cli: "claude",
  model: "claude-opus-5-5[1m]",
  effort: "medium",
  isLeader: false,
  canWrite: true,
};
const finalReviewer: SeatDefinition = {
  slotId: "finalReviewer",
  defaultName: "Terra",
  roleLabel: "Final reviewer",
  cli: "codex",
  model: "gpt-6-sol",
  effort: "high",
  isLeader: false,
  canWrite: false,
};

const devMainSeats = [leadDev, coder, reviewer1, reviewer2, fixer, finalReviewer];
const duoSeats = [leadDev, coder];
const soloSeats = [leadDev];

const designMainSeats: SeatDefinition[] = [
  {
    slotId: "leader",
    defaultName: "Atlas",
    roleLabel: "Leads design",
    cli: "claude",
    model: "claude-opus-5-5[1m]",
    effort: "high",
    isLeader: true,
  },
  {
    slotId: "designer",
    defaultName: "Terra",
    roleLabel: "UI and UX designer",
    cli: "claude",
    model: "claude-opus-5-5[1m]",
    effort: "high",
    isLeader: false,
    canWrite: true,
  },
  {
    slotId: "imageAndAssets",
    defaultName: "X",
    roleLabel: "Image and assets",
    cli: "codex",
    model: "gpt-6-astra",
    effort: "medium",
    isLeader: false,
    canWrite: true,
  },
  {
    slotId: "designReviewer",
    defaultName: "Sol",
    roleLabel: "Design reviewer",
    cli: "codex",
    model: "gpt-6-sol",
    effort: "high",
    isLeader: false,
    canWrite: false,
  },
];

const marketingMainSeats: SeatDefinition[] = [
  {
    slotId: "leader",
    defaultName: "Atlas",
    roleLabel: "Leads marketing",
    cli: "claude",
    model: "claude-opus-5-5[1m]",
    effort: "high",
    isLeader: true,
  },
  {
    slotId: "secondOpinion",
    defaultName: "Astra",
    roleLabel: "Second opinion and research",
    cli: "codex",
    model: "gpt-6-astra",
    effort: "high",
    isLeader: false,
    canWrite: false,
  },
  {
    slotId: "socialMedia",
    defaultName: "Vera",
    roleLabel: "Social media manager",
    cli: "claude",
    model: "claude-opus-5-5[1m]",
    effort: "medium",
    isLeader: false,
    canWrite: true,
  },
  {
    slotId: "image",
    defaultName: "X",
    roleLabel: "Image generation",
    cli: "codex",
    model: "gpt-6-astra",
    effort: "medium",
    isLeader: false,
    canWrite: true,
  },
  {
    slotId: "videoAndMotion",
    defaultName: "Terra",
    roleLabel: "Video and motion",
    cli: "claude",
    model: "claude-opus-5-5[1m]",
    effort: "high",
    isLeader: false,
    canWrite: true,
  },
];

const mainDevSteps: ProcessStep[] = [
  { id: "brief", label: "Brief", owners: ["leader"] },
  { id: "build", label: "Build", owners: ["coder"] },
  { id: "gate", label: "Gate", owners: ["leader"] },
  { id: "look", label: "Your look", owners: ["user"] },
  { id: "review", label: "Review", owners: ["reviewer1", "reviewer2", "coder", "fixer"] },
  { id: "finalReview", label: "Final review", owners: ["finalReviewer"] },
  { id: "ship", label: "Ship", owners: ["leader"] },
];
const designMainSteps: ProcessStep[] = [
  { id: "brief", label: "Brief", owners: ["leader"] },
  { id: "mock", label: "Mock", owners: ["designer"] },
  { id: "look", label: "Your look", owners: ["user"] },
  { id: "review", label: "Review", owners: ["designReviewer", "designer"] },
  { id: "handOff", label: "Hand off", owners: ["leader"] },
];
const marketingMainSteps: ProcessStep[] = [
  { id: "brief", label: "Brief", owners: ["leader"] },
  { id: "secondOpinion", label: "Second opinion", owners: ["secondOpinion"] },
  { id: "create", label: "Create", owners: ["socialMedia", "image", "videoAndMotion"] },
  { id: "look", label: "Your look", owners: ["user"] },
  { id: "finalCheck", label: "Final check", owners: ["secondOpinion", "socialMedia", "image", "videoAndMotion"] },
  { id: "ready", label: "Ready", owners: ["leader"] },
];
const duoSteps: ProcessStep[] = [
  { id: "brief", label: "Brief", owners: ["leader"] },
  { id: "build", label: "Build", owners: ["coder"] },
  { id: "gate", label: "Gate", owners: ["leader"] },
  { id: "look", label: "Your look", owners: ["user"] },
  { id: "review", label: "Review", owners: ["leader", "coder"] },
  { id: "ship", label: "Ship", owners: ["leader"] },
];
const soloSteps: ProcessStep[] = [
  { id: "brief", label: "Brief", owners: ["leader"] },
  { id: "work", label: "Work", owners: ["leader"] },
  { id: "look", label: "Your look", owners: ["user"] },
  { id: "done", label: "Done", owners: ["leader"] },
];

function definition(
  kind: ProcessKind,
  process: ProcessId,
  seats: readonly SeatDefinition[],
  steps: readonly ProcessStep[],
  supportsRounds: boolean,
): ProcessDefinition {
  return {
    kind,
    process,
    label: PROCESSES[process].label,
    supportsRounds,
    seats: seats.map((seat) => ({ ...seat })),
    steps: steps.map((step) => ({ ...step, owners: [...step.owners] })),
  };
}

function mainDefinition(kind: ProcessKind): ProcessDefinition {
  if (kind === "design") return definition(kind, "main", designMainSeats, designMainSteps, true);
  if (kind === "mkt") return definition(kind, "main", marketingMainSeats, marketingMainSteps, true);
  return definition(kind, "main", devMainSeats, mainDevSteps, true);
}

function duoDefinition(kind: ProcessKind): ProcessDefinition {
  return definition(kind, "duo", duoSeats, duoSteps, true);
}

function soloDefinition(kind: ProcessKind): ProcessDefinition {
  return definition(kind, "solo", soloSeats, soloSteps, false);
}

export const PROCESS_DEFINITIONS = deepFreeze({
  dev: { main: mainDefinition("dev"), duo: duoDefinition("dev"), solo: soloDefinition("dev") },
  design: { main: mainDefinition("design"), duo: duoDefinition("design"), solo: soloDefinition("design") },
  mkt: { main: mainDefinition("mkt"), duo: duoDefinition("mkt"), solo: soloDefinition("mkt") },
} satisfies Record<ProcessKind, Record<ProcessId, ProcessDefinition>>);

export interface SeatState {
  slotId: string;
  name: string;
  roleLabel: string;
  cli: string;
  model: string;
  effort: string;
  isLeader: boolean;
  canWrite?: boolean;
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
  kind: ProcessKind;
  process: ProcessId;
  folderPath: string;
  currentStepIndex: number;
  round: number;
  phase: ProcessPhase;
  approval: { state: ApprovalState; reviewWaits: boolean };
  roundHistory: RoundHistoryEntry[];
  seats: SeatState[];
  runs: ProcessRun[];
  selectedMakerSlotId: string | null;
}

export interface SeatPreferences {
  name?: string;
  cli?: string;
  model?: string;
  effort?: string;
}

export interface CreateTabStateOptions {
  tabId?: string;
  crewGenerationId?: number;
  folderPath?: string;
  seatOverrides?: Readonly<Record<string, SeatPreferences>>;
}

function cloneState(state: ProcessState): ProcessState {
  return {
    ...state,
    approval: { ...state.approval },
    roundHistory: state.roundHistory.map((entry) => ({ ...entry })),
    seats: state.seats.map((seat) => ({ ...seat })),
    runs: state.runs.map((run) => ({ ...run })),
  };
}

export function getProcessDefinition(kind: ProcessKind, process: ProcessId): DeepReadonly<ProcessDefinition> {
  // Own-property lookup: an unknown kind/process (or "constructor") is a plain error, never undefined or a TypeError downstream.
  const definition = Object.hasOwn(PROCESS_DEFINITIONS, kind) && Object.hasOwn(PROCESS_DEFINITIONS[kind], process) ? PROCESS_DEFINITIONS[kind][process] : undefined;
  if (!definition) throw new Error(`unknown kind/process: ${String(kind)}/${String(process)}`);
  return definition;
}

export function createTabState(
  kind: ProcessKind,
  process: ProcessId,
  options: CreateTabStateOptions = {},
): ProcessState {
  const definition = getProcessDefinition(kind, process);
  const seats = definition.seats.map((slot): SeatState => {
    const override = options.seatOverrides?.[slot.slotId] ?? {};
    const seat: SeatState = {
      slotId: slot.slotId,
      name: override.name ?? slot.defaultName,
      roleLabel: slot.roleLabel,
      cli: override.cli ?? slot.cli,
      model: override.model ?? slot.model,
      effort: override.effort ?? slot.effort,
      isLeader: slot.isLeader,
      status: "idle",
      task: "Ready",
    };
    if (slot.canWrite !== undefined) seat.canWrite = slot.canWrite;
    return seat;
  });

  return {
    tabId: options.tabId ?? "tab",
    crewGenerationId: options.crewGenerationId ?? 1,
    kind,
    process,
    folderPath: options.folderPath ?? "",
    currentStepIndex: 0,
    round: 1,
    phase: "review",
    approval: { state: "none", reviewWaits: false },
    roundHistory: [],
    seats,
    runs: [],
    selectedMakerSlotId: kind === "mkt" && process === "main" ? "socialMedia" : null,
  };
}

function findSeat(state: ProcessState, slotId: string): SeatState | undefined {
  return state.seats.find((seat) => seat.slotId === slotId);
}

function leaderSeat(state: ProcessState): SeatState | undefined {
  return state.seats.find((seat) => seat.isLeader) ?? state.seats[0];
}

export function getRoundStepIndex(state: ProcessState): number {
  const definition = getProcessDefinition(state.kind, state.process);
  if (!definition.supportsRounds) return -1;
  return definition.steps.findIndex((step) => step.id === "review" || step.id === "finalCheck");
}

export function supportsReviewRounds(state: ProcessState): boolean {
  return getRoundStepIndex(state) >= 0;
}

export function getReviewerSlotId(state: ProcessState, round = state.round): string | null {
  if (!supportsReviewRounds(state)) return null;
  if (state.process === "duo") return "leader";
  if (state.kind === "design") return "designReviewer";
  if (state.kind === "mkt") return "secondOpinion";
  return round % 2 === 1 ? "reviewer1" : "reviewer2";
}

export function getFixerSlotId(state: ProcessState, round = state.round): string | null {
  if (!supportsReviewRounds(state)) return null;
  if (state.process === "duo") return "coder";
  if (state.kind === "design") return "designer";
  if (state.kind === "mkt") {
    const selected = state.selectedMakerSlotId;
    return selected && ["socialMedia", "image", "videoAndMotion"].includes(selected)
      ? selected
      : "socialMedia";
  }
  return round % 2 === 1 ? "coder" : "fixer";
}

export function getStepOwners(state: ProcessState, stepIndex = state.currentStepIndex): readonly string[] {
  const definition = getProcessDefinition(state.kind, state.process);
  const step = definition.steps[stepIndex];
  if (!step) return [];
  if (stepIndex === getRoundStepIndex(state)) {
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
  return state.runs.filter((run) => run.status === "working" && !run.seatIsLeader);
}

function runIsWorkingForSeat(state: ProcessState, slotId: string): boolean {
  return state.runs.some((run) => run.seatSlotId === slotId && run.status === "working");
}

function activeRunNames(state: ProcessState): string[] {
  const names = new Set<string>();
  for (const run of getActiveWorkerRuns(state)) {
    names.add(findSeat(state, run.seatSlotId)?.name ?? run.seatName ?? run.seatSlotId);
  }
  return [...names];
}

function joinedNames(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function isAtCurrentReview(state: ProcessState): boolean {
  return getRoundStepIndex(state) >= 0 && state.currentStepIndex === getRoundStepIndex(state);
}

function leaderTask(state: ProcessState): string {
  if (isAtCurrentReview(state) && state.phase !== "clean") return `Round ${state.round} running`;
  const step = getProcessDefinition(state.kind, state.process).steps[state.currentStepIndex];
  return step ? `Running ${step.label}` : "Ready";
}

function currentAssignmentTask(state: ProcessState, slotId: string): string {
  if (isAtCurrentReview(state) && getStepOwners(state).includes(slotId)) {
    return `${state.phase === "fix" ? "Fixing" : "Reviewing"} · round ${state.round}`;
  }
  const step = getProcessDefinition(state.kind, state.process).steps[state.currentStepIndex];
  return step?.label ?? "Working";
}

function activateCurrentAssignment(state: ProcessState, restartSlots: readonly string[]): void {
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

  const lookIndex = getProcessDefinition(state.kind, state.process).steps.findIndex((step) => step.id === "look");
  const lead = leaderSeat(state);
  if (lead && state.currentStepIndex > lookIndex && !assigned.has(lead.slotId)) {
    if (lead.status !== "stopped" || restart.has(lead.slotId)) {
      lead.status = "working";
      lead.task = leaderTask(state);
    }
  }
}

function holdReviewWhileWorkersRun(state: ProcessState): boolean {
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

function reevaluateReviewGate(state: ProcessState): void {
  if (state.approval.state !== "approved" || !state.approval.reviewWaits || !isAtCurrentReview(state)) return;
  if (holdReviewWhileWorkersRun(state)) return;

  state.approval.reviewWaits = false;
  activateCurrentAssignment(state, [...getStepOwners(state), "leader"]);
}

function markCurrentAssignmentDone(state: ProcessState): void {
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

export function advanceStep(state: ProcessState): ProcessState {
  const next = cloneState(state);
  const definition = getProcessDefinition(next.kind, next.process);
  const current = definition.steps[next.currentStepIndex];
  if (!current || next.currentStepIndex >= definition.steps.length - 1) return next;
  if (current.id === "look" || next.currentStepIndex === getRoundStepIndex(next)) return next;

  markCurrentAssignmentDone(next);
  next.currentStepIndex += 1;
  const step = definition.steps[next.currentStepIndex];
  if (step.id === "look") {
    next.approval = { state: "pending", reviewWaits: false };
    const lead = leaderSeat(next);
    if (lead) {
      lead.status = "waiting";
      lead.task = "Waiting on your look";
    }
  } else {
    next.approval = { ...next.approval, reviewWaits: false };
    activateCurrentAssignment(next, getStepOwners(next));
  }
  return next;
}

export function approveLook(state: ProcessState): ProcessState {
  const next = cloneState(state);
  const definition = getProcessDefinition(next.kind, next.process);
  const lookIndex = definition.steps.findIndex((step) => step.id === "look");
  if (next.currentStepIndex !== lookIndex || next.approval.state !== "pending") return next;

  next.approval.state = "approved";
  if (!definition.supportsRounds) {
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

export function switchProcess(state: ProcessState, process: ProcessId, endedAt?: number): ProcessState {
  if (state.process === process) return cloneState(state);
  const stopped = stopAll(state, endedAt);
  const definition = getProcessDefinition(state.kind, process);
  const seats = definition.seats.map((slot): SeatState => {
    const seat: SeatState = {
      slotId: slot.slotId,
      name: slot.defaultName,
      roleLabel: slot.roleLabel,
      cli: slot.cli,
      model: slot.model,
      effort: slot.effort,
      isLeader: slot.isLeader,
      status: "idle",
      task: "Ready",
    };
    if (slot.canWrite !== undefined) seat.canWrite = slot.canWrite;
    return seat;
  });
  return {
    ...stopped,
    crewGenerationId: state.crewGenerationId + 1,
    process,
    currentStepIndex: 0,
    round: 1,
    phase: "review",
    approval: { state: "none", reviewWaits: false },
    roundHistory: [],
    seats,
    selectedMakerSlotId: state.kind === "mkt" && process === "main" ? "socialMedia" : null,
  };
}

function canReportReview(state: ProcessState): boolean {
  if (
    state.approval.state !== "approved" ||
    state.approval.reviewWaits ||
    !isAtCurrentReview(state) ||
    state.phase !== "review"
  ) return false;
  const reviewer = getReviewerSlotId(state);
  const seat = reviewer ? findSeat(state, reviewer) : undefined;
  return !!seat && seat.status !== "stopped" && seat.status !== "failed" && !runIsWorkingForSeat(state, reviewer);
}

export function reviewFindings(state: ProcessState): ProcessState {
  const next = cloneState(state);
  if (!canReportReview(next)) return next;

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

export function reviewClean(state: ProcessState): ProcessState {
  const next = cloneState(state);
  if (!canReportReview(next)) return next;

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

export function selectMarketingMaker(state: ProcessState, seatSlotId: string): ProcessState {
  const next = cloneState(state);
  if (next.kind !== "mkt" || next.process !== "main") return next;
  if (!["socialMedia", "image", "videoAndMotion"].includes(seatSlotId)) return next;
  if (next.selectedMakerSlotId === seatSlotId) return next;

  const oldFixer = getFixerSlotId(next);
  next.selectedMakerSlotId = seatSlotId;
  if (isAtCurrentReview(next) && next.phase === "fix") {
    const oldSeat = oldFixer ? findSeat(next, oldFixer) : undefined;
    if (oldSeat?.status === "working" && !runIsWorkingForSeat(next, oldSeat.slotId)) {
      oldSeat.status = "idle";
      oldSeat.task = "Ready";
    }
    const history = [...next.roundHistory].reverse().find((entry) => entry.round === next.round);
    const newFixer = findSeat(next, seatSlotId);
    if (history && newFixer) {
      history.fixerSlotId = seatSlotId;
      history.fixerName = newFixer.name;
    }
    activateCurrentAssignment(next, [seatSlotId]);
  }
  return next;
}

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
  state: "done" | "current" | "upcoming";
  owners: readonly string[];
}[] {
  const definition = getProcessDefinition(state.kind, state.process);
  const reviewIndex = getRoundStepIndex(state);
  const waiting = getReviewWaitNames(state);
  return definition.steps.map((step, index) => {
    let label = step.label;
    let owners = step.owners;
    if (index === reviewIndex) {
      if (index === state.currentStepIndex && state.phase !== "clean") {
        owners = getStepOwners(state, index);
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
      state: index < state.currentStepIndex ? "done" : index === state.currentStepIndex ? "current" : "upcoming",
      owners,
    };
  });
}

export function getApprovedCardLine(state: ProcessState): string | null {
  if (state.approval.state !== "approved") return null;
  const waiting = getReviewWaitNames(state);
  if (waiting.length) return `Waiting for ${joinedNames(waiting)} to finish.`;

  const definition = getProcessDefinition(state.kind, state.process);
  if (state.currentStepIndex === getRoundStepIndex(state) && state.phase !== "clean") {
    const slotId = getStepOwners(state)[0];
    const seat = slotId ? findSeat(state, slotId) : undefined;
    if (seat?.status === "stopped") return `Round ${state.round} is paused. ${seat.name} was stopped.`;
    return `Round ${state.round}: ${seat?.name ?? slotId ?? "The assigned seat"} is ${state.phase === "fix" ? "fixing" : "reviewing"}.`;
  }

  const step = definition.steps[state.currentStepIndex];
  if (!step) return "Waiting for the next step.";
  if (["done", "ship", "handOff", "ready"].includes(step.id)) {
    return `${leaderSeat(state)?.name ?? "Leader"} is finishing up.`;
  }
  return `${step.label} is running.`;
}

export function getLeaderStatusLine(state: ProcessState): string {
  const lead = leaderSeat(state);
  if (!lead) return "Idle · Ready";
  const waiting = getReviewWaitNames(state);
  if (waiting.length) return `Waiting · Waiting for ${joinedNames(waiting)} to finish`;
  const step = getProcessDefinition(state.kind, state.process).steps[state.currentStepIndex];
  if (step?.id === "look" && state.approval.state === "pending") return "Waiting · Waiting on your look";
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
