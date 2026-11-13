import { LIST_TIMEOUT_MS, KILL_TIMEOUT_MS } from "../leader-common/types.ts";
import { drainProcessTreeHelpers } from "../leader-common/process-tree.ts";

// Strict cleanup needs an initial list, parallel kills, and a fresh absence list.
export const GIT_SWEEP_MS = 2 * LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000;
export const GIT_DRAIN_MS = GIT_SWEEP_MS + 2000;
export type GitOperation = {
  id: string; tabId: string; seatKey: string; instance: object;
  cancelled: boolean; cancelChild: (() => void) | null;
  terminal: boolean; finalized: boolean; treesEnded: boolean; cleanup: Set<Promise<unknown>>;
  done: Promise<void>; finish: () => void;
};
export function createGitOperations() {
  const operations = new Map<string, GitOperation>();
  let closed = false;
  function cancel(op: GitOperation): void {
    op.cancelled = true;
    op.cancelChild?.();
  }
  return {
    register(id: string, tabId: string, instance: object): GitOperation {
      if (closed) throw new Error("Git admission is closed for shutdown.");
      if (operations.has(id)) throw new Error("Git operation is already registered.");
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const op: GitOperation = { id, tabId, seatKey: `${tabId}.leader`, instance,
        cancelled: false, cancelChild: null, terminal: false, finalized: false, treesEnded: true, cleanup: new Set(), done, finish };
      operations.set(id, op);
      return op;
    },
    assertOpen() { if (closed) throw new Error("Git admission is closed for shutdown."); },
    get(id: string) { return operations.get(id); },
    retireConfirmed(id: string) {
      const op = operations.get(id);
      if (!op) return;
      if (!op.terminal || !op.treesEnded || op.cancelChild || op.cleanup.size !== 0) throw new Error("Git operation still has an unsettled process tree or cleanup.");
      operations.delete(id);
    },
    ids(seatKey?: string) { return [...operations.values()].filter((op) => !seatKey || op.seatKey === seatKey).map((op) => op.id); },
    cancel(id: string) { const op = operations.get(id); if (!op) return false; cancel(op); return true; },
    cancelTab(tabId: string, instance?: object) {
      for (const op of operations.values()) if (op.tabId === tabId && (instance === undefined || op.instance === instance)) cancel(op);
    },
    cancelAll() { for (const op of operations.values()) cancel(op); },
    complete(op: GitOperation) {
      op.finish();
      if (op.finalized && op.treesEnded && !op.cleanup.size) operations.delete(op.id);
    },
    close() { closed = true; for (const op of operations.values()) cancel(op); },
    async drain(): Promise<boolean> {
      const pending = [...operations.values()];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          Promise.all(pending.map(async (op) => { await op.done; await Promise.allSettled([...op.cleanup]); })).then(() => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), GIT_DRAIN_MS); }),
        ]);
        const helpersEnded = await drainProcessTreeHelpers();
        return settled && helpersEnded && pending.every((op) => op.terminal && op.finalized && op.treesEnded && !op.cleanup.size);
      } finally { clearTimeout(timer); }
    },
  };
}
