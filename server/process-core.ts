import type { Seat, SeatStatus, RunStatus } from "./process-types.ts";

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

// A fixed tab's runtime state: its assigned seats and every run it has had.
export interface ProcessState {
  tabId: string;
  crewGenerationId: number;
  folderPath: string;
  seats: SeatState[];
  runs: ProcessRun[];
}

export interface CreateTabStateOptions {
  tabId?: string;
  crewGenerationId?: number;
  folderPath?: string;
}

export function cloneState(state: ProcessState): ProcessState {
  return {
    ...state,
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

// The one construction of a fixed tab's runtime state, from the seats its assignments give it.
export function createTabState(crew: readonly Seat[], options: CreateTabStateOptions = {}): ProcessState {
  return {
    tabId: options.tabId ?? "tab",
    crewGenerationId: options.crewGenerationId ?? 1,
    folderPath: options.folderPath ?? "",
    seats: seatsFrom(crew),
    runs: [],
  };
}

export function findSeat(state: ProcessState, slotId: string): SeatState | undefined {
  return state.seats.find((seat) => seat.slotId === slotId);
}
