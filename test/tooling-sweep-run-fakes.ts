import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Executes the current runner source, including mutations, with no OS process or timer boundary.
export function fakeRun() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; call: () => void }>();
  const events: any[][] = [];
  const child: any = new EventEmitter();
  child.pid = 12345; child.exitCode = null; child.signalCode = null;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = function () { return this; };
  const lane = { dir: "fake-lane", temp: "fake-temp", tracked: new Map<number, number>() };
  const setTimer = (call: () => void, ms: number) => {
    const id = ++nextId; timers.set(id, { at: now + ms, call }); return id;
  };
  const clearTimer = (id: number) => { timers.delete(id); };
  const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  const advance = async (to: number) => {
    await flush();
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.at <= to).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) break;
      now = entry[1].at; timers.delete(entry[0]); entry[1].call(); await flush();
    }
    now = to; await flush();
  };
  let closed = false;
  const close = (code = 0) => {
    if (closed) return;
    closed = true; child.exitCode = code; events.push(["close", now, code]); child.emit("close", code);
  };
  const emit = (record: object) => child.stdout.emit("data", JSON.stringify(record) + "\n");
  const fixture = () => {
    events.push(["ready", now]);
    setTimer(() => { events.push(["natural-end", now]); emit({ type: "summary", pass: 1, fail: 0 }); close(); }, 10_000);
  };
  const world = {
    events, child, lane, advance, close, emit, fixture, setTimer,
    spawnArgs: [] as string[], spawnEnv: {} as any,
    onKill: undefined as undefined | ((root: number | undefined, early: boolean) => void),
    message: () => `events=${JSON.stringify(events)}`,
  };
  const spawn = (_exe: string, args: string[], options: any) => {
    events.push(["spawn", now, child.pid]); world.spawnArgs = args; world.spawnEnv = options.env;
    return child;
  };
  const killTracked = async (_tracked: any, options?: any) => {
    events.push(["kill", now, options?.root, !!options]);
    close(1); world.onKill?.(options?.root, !!options);
  };
  const watchTree = (pid: number, tracked: Map<number, number>) => {
    events.push(["watch", now, pid]); tracked.set(pid, 100);
    return () => { events.push(["unwatch", now]); };
  };
  const fakeOs = { constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } }, setPriority: (pid: number, priority: number) => { events.push(["priority", now, pid, priority]); } };
  const source = readFileSync(new URL("../scripts/sweep/run.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const body = source.replace(/^import .*;\n/gm, "").replaceAll("export ", "").replaceAll("import.meta.url", JSON.stringify(import.meta.url));
  const load = new Function("spawn", "appendFileSync", "os", "relative", "fileURLToPath", "pathToFileURL", "laneEnv", "killTracked", "watchTree", "setTimeout", "clearTimeout", "Date", body + "; return runTests;");
  const runner = load(spawn, () => {}, fakeOs, relative, fileURLToPath, pathToFileURL, () => ({ isolated: "yes" }), killTracked, watchTree, setTimer, clearTimer, { now: () => now });
  let running: Promise<any> | undefined;
  return Object.assign(world, {
    start(extra: object = {}) {
      running = runner({ lane, files: ["test/fake.test.ts"], red: false, earlyStop: true, timeoutMs: 60_000, concurrency: 1, logPath: "fake-log", ...extra });
      // Observe rejections at creation, even when an assertion fails before awaiting the result.
      running!.catch(() => {});
      return running!;
    },
    async finish() {
      try { close(1); await advance(120_000); await running; }
      finally { timers.clear(); }
    },
  });
}
