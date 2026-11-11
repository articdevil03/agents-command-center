import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../scripts/sweep/main.mjs";

// Fakes of Block A's contract (run.mjs, lanes.mjs) for the sweep's own tests. Nothing here starts a process, a lane folder or a real run:
// a lane is a Map of file texts, and a "run" is a function of what is currently written in the lane.
export type Call = { lane: FakeLane; files: string[] | null; red: boolean; earlyStop: boolean; concurrency: number; logPath: string; signal?: AbortSignal; n: number; mutated: string[]; slotsHeld: number };
export type FakeLane = { index: number; dir: string; temp: string; source: string; copiedPaths: string[]; pristine: Map<string, Buffer>; hashes: Map<string, string>; tracked: Map<number, number>; files: Map<string, string>; leaked: string[]; removed: string[] };
export type Run = Record<string, any>;

export const SOURCE: Record<string, string> = { "src/a.js": "const a = 1;\n", "src/b.js": "const b = 2;\n", "src/c.js": "// ctl\nconst c = 3;\n" };
export const row = (name: string, file = "src/a.js", from = "1", to = "9") => [name, file, from, to];
export const CANARY_ROW = ["guard-stale-entry", "src/a.js", "const a", "let a"];
export const CONTROL_ROW = ["control-must-survive", "src/c.js", "// ctl", "// ctl2"];
const CATCH_FILE: Record<string, string> = { "src/a.js": "test/a.test.ts", "src/b.js": "test/b.test.ts" };

export const pass = (extra: Run = {}): Run => ({ outcome: "pass", exitCode: 0, failures: [], catching: null, ...extra });
export const assertion = (file: string, name = "t1", extra: Run = {}): Run => ({ outcome: "assertion", exitCode: 1, stoppedEarly: true, failures: [{ file, name, cause: "ERR_ASSERTION", message: "boom" }], catching: { file, name }, ...extra });
export const failure = (cause = "TypeError", extra: Run = {}): Run => ({ outcome: "failure", exitCode: 1, failures: [{ file: "test/z.test.ts", name: "zz", cause, message: "bad" }], catching: null, ...extra });

export type WorldOptions = {
  rows?: string[][]; source?: Record<string, string>;
  // Overrides the default behaviour of one run; undefined falls back to "fails iff the mutation is in place and the run covers its catching file".
  behave?: (call: Call, world: World) => Run | undefined | Promise<Run | undefined>;
  removeLane?: (lane: FakeLane) => { leftovers: string[] };
  killTracked?: (tracked: Map<number, number>) => void | Promise<void>;
};
export type World = ReturnType<typeof makeWorld>;

export function makeWorld(dir: string, options: WorldOptions = {}) {
  const source = options.source ?? SOURCE;
  const world = {
    dir, events: [] as string[], calls: [] as Call[], lanes: [] as FakeLane[], removedLanes: [] as number[], acquired: [] as number[], logs: [] as string[],
    clock: new Date(2026, 9, 30, 22, 0, 0), git: { head: "a".repeat(40), dirty: "" }, signals: new EventEmitter(), resyncs: [] as string[][], kills: [] as number[][],
    rows: options.rows ?? [CANARY_ROW, row("r1"), row("r2"), row("r3", "src/b.js", "2", "8")],
    sweep: {} as any, deps: {} as any,
  };
  const textOf = (bytes: Buffer) => bytes.toString("utf8");
  world.sweep = {
    lowerOwnPriority: () => { world.events.push("priority"); return 10; },
    cleanupLeftovers: () => { world.events.push("cleanup-leftovers"); return { removed: [], leftovers: [] }; },
    createLane: (_root: string, copiedPaths: string[], index: number): FakeLane => {
      world.events.push(`create-lane-${index}`);
      const pristine = new Map(Object.entries(source).map(([file, text]) => [file, Buffer.from(text)]));
      const lane: FakeLane = { index, dir: join(dir, `lane${index}`), temp: join(dir, `temp${index}`), source: dir, copiedPaths, pristine, hashes: new Map(), tracked: new Map(), files: new Map(Object.entries(source)), leaked: [], removed: [] };
      world.lanes.push(lane);
      return lane;
    },
    readPristine: (lane: FakeLane, file: string) => { const bytes = lane.pristine.get(file); if (!bytes) throw new Error(`${file} is not in the copy`); return bytes; },
    writeVerified: (lane: FakeLane, file: string, content: string | Buffer) => { lane.files.set(file, Buffer.isBuffer(content) ? textOf(content) : content); },
    resyncLane: (lane: FakeLane) => {
      const recopied = [...lane.pristine].filter(([file, bytes]) => lane.files.get(file) !== textOf(bytes)).map(([file]) => file);
      for (const file of recopied) lane.files.set(file, textOf(lane.pristine.get(file)!));
      world.resyncs.push(recopied);
      const leaked = lane.leaked;
      lane.leaked = [];
      const removed = lane.removed;
      lane.removed = [];
      return { recopied, removed, leaked, tempLeftovers: [] };
    },
    removeLane: (lane: FakeLane) => { world.events.push(`remove-lane-${lane.index}`); world.removedLanes.push(lane.index); return options.removeLane?.(lane) ?? { leftovers: [] }; },
    killTracked: async (tracked: Map<number, number>) => { world.events.push("kill-tracked"); world.kills.push([...tracked.keys()]); await options.killTracked?.(tracked); return { killed: [] }; },
    createSlots: (total: number) => ({ total, acquire: async (count: number) => { world.acquired.push(count); }, release() {}, inUse: () => 0 }),
    runTests: async (args: any) => {
      const lane = args.lane as FakeLane;
      const mutated = [...lane.files].filter(([file, text]) => text !== textOf(lane.pristine.get(file)!)).map(([file]) => file);
      const call: Call = { ...args, n: world.calls.length + 1, mutated, slotsHeld: world.acquired.at(-1) ?? 0 };
      world.calls.push(call);
      const custom = await options.behave?.(call, world);
      let result = custom;
      if (!result && args.signal?.aborted) result = { outcome: "aborted", exitCode: null, failures: [], catching: null };
      if (!result) {
        const catchFile = mutated.length ? (mutated[0] === "src/c.js" ? undefined : CATCH_FILE[mutated[0]]) : undefined;
        result = catchFile && (!args.files || args.files.includes(catchFile)) ? assertion(catchFile) : pass();
      }
      mkdirSync(join(args.logPath, ".."), { recursive: true });
      writeFileSync(args.logPath, `log of run ${call.n}\n`);
      return { ms: 5, stoppedEarly: false, fileMs: {}, logPath: args.logPath, ...result };
    },
  };
  const catalogue = { mutations: world.rows, controlMutations: [CONTROL_ROW], COPIED_PATHS: ["src", "test"], hasDesignFolder: () => true, SYNTAX_CHECKED: new Set([".js"]) };
  world.deps = {
    root: dir, catalogue, sweep: world.sweep, catchMapPath: join(dir, "catch-map.json"),
    git: { state: () => ({ ...world.git }) },
    lock: { acquireLock: () => { world.events.push("lock"); }, releaseLock: () => { world.events.push("unlock"); } },
    parses: async (_lane: FakeLane, _file: string, text: string) => !text.includes("BROKEN"),
    now: () => new Date(world.clock), signals: world.signals, log: (line: string) => { world.logs.push(line); },
  };
  return world;
}

// The context row.mjs expects, with the bookkeeping main.mjs would do kept to the minimum a row test needs.
export function rowContext(world: World, extra: { catchMap?: Record<string, string>; targets?: Record<string, string>; syntaxChecked?: Set<string> } = {}) {
  const runsDir = join(world.dir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const learned = new Map<string, Map<string, number>>();
  const flakes: { file: string; name: string }[] = [];
  let sequence = 0;
  const ctx = {
    sweep: world.sweep, slots: world.sweep.createSlots(12), sweepDir: world.dir, runsDir, signal: undefined as AbortSignal | undefined, syntaxChecked: extra.syntaxChecked ?? new Set([".js"]),
    parses: world.deps.parses, catchMap: new Map(Object.entries(extra.catchMap ?? {})), targetOf: new Map(Object.entries(extra.targets ?? {})), learned,
    learn: (target: string, file: string) => { const counts = learned.get(target) ?? new Map(); counts.set(file, (counts.get(file) ?? 0) + 1); learned.set(target, counts); },
    addFlakes: (failures: { file: string; name: string }[]) => { flakes.push(...failures); }, seq: () => String(++sequence).padStart(3, "0"), timeoutFor: () => 60_000, flakes,
  };
  return ctx;
}

export const readJson = (path: string) => {
  assert.ok(existsSync(path), `the persistent sweep report exists: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
};
export const sweepFolder = (out: string) => join(out, "2026-10-30", "sweep-220000");
export const results = (out: string): Run[] => readJson(join(sweepFolder(out), "results.json"));
export const statusOf = (out: string): Record<string, string> => Object.fromEntries(results(out).map((entry) => [entry.name, entry.status]));
export const summaryOf = (out: string) => readFileSync(join(sweepFolder(out), "summary.txt"), "utf8");
export const hasFile = (path: string) => existsSync(path);
export const statusLines = (world: World): Run[] => world.logs.filter((line) => line.startsWith('{"name"')).map((line) => JSON.parse(line));

export const outOf = (world: World) => join(world.dir, "out");
// The real entry point with the fakes injected; one lane unless a test says otherwise.
export const go = (world: World, args: string[] = [], deps: object = {}): Promise<number> => main(["--out", outOf(world), "--lanes", "1", ...args], { ...world.deps, ...deps });
// The sweep folder a run belongs to, from its log path (<sweep folder>/runs/<log>).
export const folderOf = (call: Call) => dirname(dirname(call.logPath));
export const finishedNames = (world: World): string[] => [...new Set(statusLines(world).map((line) => line.name))];
