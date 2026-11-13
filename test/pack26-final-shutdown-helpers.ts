import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Only built-ins are imported statically: the server child loads this file as a preload, so everything heavy is imported when first used.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Server child (an `--import` of this file): the injected process list HOLDS while temp/hold-sweep exists, and reports unknown
// descendants while temp/unknown-tree exists. Imported after fixed-crew-execution-helpers.ts, so this tracker wins.
// Only the server process itself (never the fake CLIs it starts, which inherit this preload).
if (process.env.CC_P26F_HOLD === "1" && /[\\/]server[\\/]index\.ts$/.test(process.argv[1] ?? "")) {
  const { setProcessTreeForTests, createTreeTracker } = await import("../server/leader-common.ts");
  const temp = join(process.env.CC_DATA_DIR!, "..");
  setProcessTreeForTests(createTreeTracker({
    list: async () => {
      while (existsSync(join(temp, "hold-sweep"))) await new Promise((resolve) => setTimeout(resolve, 25));
      if (existsSync(join(temp, "unknown-tree"))) throw new Error("Injected unknown descendants");
      return [];
    },
    kill: async () => { throw new Error("The finite fake child must leave no processes to kill."); },
  }));
}

export async function holdServer(options: { secondTab?: boolean } = {}) {
  const { fixedServer } = await import("./fixed-crew-execution-helpers.ts");
  const imports = [new URL("./fixed-crew-execution-helpers.ts", import.meta.url).href, import.meta.url].map((href) => `--import ${href}`).join(" ");
  return fixedServer({ ...options, env: { CC_P26F_HOLD: "1", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} ${imports}` } });
}
export type HeldServer = Awaited<ReturnType<typeof holdServer>>;

export async function until(check: () => unknown, label: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await sleep(20); }
  throw new Error(`Timed out: ${label}`);
}
export const flag = (f: HeldServer, name: "hold-sweep" | "unknown-tree") => ({
  set: () => writeFileSync(join(f.server.temp, name), name),
  clear: () => rmSync(join(f.server.temp, name), { force: true }),
});
// Plan, approve and start a build worker that stays alive for a while; returns its run id once the real child is running.
export async function liveWorker(f: HeldServer, delay = 6000): Promise<string> {
  await f.planning(); await f.approve();
  f.worker({ delay, write: "after!" });
  const run = await f.action("build");
  if (!run.ok) throw new Error(run.text);
  await until(() => f.observation(run.value.runId), "worker observation");
  return run.value.runId;
}
export const exitWatch = (f: HeldServer) => {
  const result: { code?: number | null; at?: number } = {};
  f.server.child.once("exit", (code) => { result.code = code; result.at = Date.now(); });
  return result;
};
export const diskJournal = (f: HeldServer, tabId = "fixed") => JSON.parse(readFileSync(join(f.server.data, "executions", `${tabId}.json`), "utf8"));

// ---- In-process runner (the real runner source, fake process): lets a test hold each stage of a worker's finalization. ----
export type Hold = { promise: Promise<number | null>; resolve: (value: number | null) => void; reject: (error: Error) => void };
export const hold = (): Hold => {
  let resolve!: Hold["resolve"], reject!: Hold["reject"];
  const promise = new Promise<number | null>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};
// The drain's clock is a fake the test fires by hand: a drain that never settles fails an assertion, never a real timeout.
export function fakeClock() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers,
    clock: { setTimeout: ((fn: () => void, ms: number) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; }) as any, clearTimeout: ((timer: any) => { if (timer) timer.cleared = true; }) as any },
    fire: () => timers.filter((timer) => !timer.cleared).forEach((timer) => timer.fn()),
  };
}
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export async function runnerFixture(watch: { sweep: () => Promise<number | null>; failed: number } | null, callbacks: { onTreeEnd?: (run: any, evidence: string) => void; onStatus?: (run: any, status: string) => void } = {}) {
  const { loadRunnerHarness, isolatedRunnerProc, isolatedRun } = await import("./round2-runner-fixture.ts");
  const harness = loadRunnerHarness();
  const proc = isolatedRunnerProc(9123);
  const events: string[] = [];
  const cb = {
    onOutput: () => {},
    onTreeEnd: (run: any, evidence: string) => { events.push(`tree:${evidence}`); callbacks.onTreeEnd?.(run, evidence); },
    onStatus: (run: any, status: string) => { events.push(`status:${status}`); callbacks.onStatus?.(run, status); },
  };
  const spawns: unknown[] = [];
  const started = (run = isolatedRun()) => harness.runSeat(run, "brief", cb, ((...args: unknown[]) => { spawns.push(args); return proc; }) as any, watch ? { watch: watch as any } : {});
  return { harness, proc, events, started, spawns, cb };
}
export async function settled<T>(promise: Promise<T>): Promise<{ done: boolean; value?: T }> {
  let state: { done: boolean; value?: T } = { done: false };
  void promise.then((value) => { state = { done: true, value }; });
  await tick(); await tick();
  return state;
}
