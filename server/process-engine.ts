import { type RunStatus } from "./process-types.ts";
import { cloneState, findSeat, type ProcessState, type ProcessRun } from "./process-core.ts";

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
  return next;
}

export function stopRun(state: ProcessState, runId: string, endedAt?: number): ProcessState {
  const next = cloneState(state);
  settleRun(next, runId, "stopped", "stopped", endedAt);
  return next;
}

export function failRun(state: ProcessState, runId: string, endedAt?: number, outcome = "failed"): ProcessState {
  const next = cloneState(state);
  settleRun(next, runId, "failed", outcome, endedAt);
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
 * the seat now, but those runs stay working (still busy) until
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
  return next;
}

/** See stopSeat for `closingRunIds`. */
export function stopAll(state: ProcessState, endedAt?: number, closingRunIds: ReadonlySet<string> = new Set()): ProcessState {
  const next = cloneState(state);
  const runIds = next.runs.filter((run) => run.status === "working").map((run) => run.id);
  const workingSeatIds = next.seats.filter((seat) => seat.status === "working").map((seat) => seat.slotId);

  for (const runId of runIds) if (!closingRunIds.has(runId)) settleRun(next, runId, "stopped", "stopped", endedAt);
  for (const slotId of workingSeatIds) {
    const seat = findSeat(next, slotId);
    if (seat) {
      seat.status = "stopped";
      seat.task = "Stopped by you";
    }
  }
  return next;
}
