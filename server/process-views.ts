import { findSeat, type ProcessState, type ProcessRun } from "./process-core.ts";

export function getSeatTaskLine(state: ProcessState, seatSlotId: string): string {
  const seat = findSeat(state, seatSlotId);
  if (!seat || seat.isLeader) return "";
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
