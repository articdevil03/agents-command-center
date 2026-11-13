import { KILL_TIMEOUT_MS, LIST_TIMEOUT_MS } from "../leader-common/types.ts";

// Shutdown tracking for workers. A worker is "finished" only when its final callbacks (the tree-end fact and the status, which publish
// the execution journal) have completed. The runner's own map forgets a run BEFORE those callbacks, so it cannot answer that.
export const KILL_GRACE_MS = 5000;
export const EXIT_DRAIN_MS = 750;
// The cap must cover the work it waits for: one process list, then the kills (they run together), plus a margin.
export const SWEEP_WAIT_MS = LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000;
const DRAIN_MARGIN_MS = 5000;
// Kill grace, the exit pipe drain, the sweep's own cap and a margin: after this a worker's end is unknown, never assumed.
export const WORKER_DRAIN_MS = KILL_GRACE_MS + EXIT_DRAIN_MS + SWEEP_WAIT_MS + DRAIN_MARGIN_MS;

type Tracked = { runId: string; settled: boolean; wait: Promise<void>; finish: () => void };
const live = new Set<Tracked>();
// A worker whose finalization did not complete (unknown tree end, a callback that threw, a released run): the drain can never be green again.
const unconfirmed = new Set<string>();
let admissionClosed = false;

export function closeWorkerAdmission(): void { admissionClosed = true; }
export function workerAdmissionClosed(): boolean { return admissionClosed; }

// Called when a worker has started. settle(true) only after the tree end is confirmed AND every final callback completed.
export function trackWorker(runId: string): { settle: (completed: boolean) => void } {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const item: Tracked = { runId, settled: false, wait, finish };
  live.add(item);
  return {
    settle(completed: boolean): void {
      if (item.settled) return;
      item.settled = true;
      if (!completed) unconfirmed.add(runId);
      live.delete(item);
      item.finish();
    },
  };
}

type Clock = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
// True only when every tracked worker finished with a confirmed end inside the budget. Closes admission first, so nothing new can start.
export async function drainWorkers(budgetMs = WORKER_DRAIN_MS, clock: Clock = globalThis): Promise<boolean> {
  closeWorkerAdmission();
  const pending = [...live];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const finished = await Promise.race([
      Promise.all(pending.map((item) => item.wait)).then(() => true),
      new Promise<false>((resolve) => { timer = clock.setTimeout(() => resolve(false), budgetMs); }),
    ]);
    return finished && live.size === 0 && unconfirmed.size === 0;
  } finally { clock.clearTimeout(timer); }
}
