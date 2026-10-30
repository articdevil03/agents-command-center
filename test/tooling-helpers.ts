import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mutations, COPIED_PATHS, isRealRed, MUTATION_DIR_PREFIX, EVIDENCE_PREFIX, TEMP_DIR_PREFIX, SYNTAX_CHECKED, removeWithRetry } from "../scripts/mutation-proof.mjs";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

// Behavioral guard (replaces a source-text-only version: it checked that
// certain strings existed in the file, which stayed green even when an
// in-memory catch was wrapped around the verification asserts to swallow
// them -- see the brief, "guard the call site, not the helper"). Drives the
// sweep's REAL main body -- its own mutations array and spawnSync swapped for
// fakes -- so a mutation that SURVIVES its own "red" run, the genuine
// undetected regression this sweep exists to catch, must actually escape the
// sweep. removeWithRetry's real source is spliced in too (sharing the fake
// rmSync), so a real cleanup removal failure can't mask that escape either.
export type FakeSweepOptions = {
  rmSync?: (path: string, options?: any) => void;
  spawnSync?: (command: string, args: string[], options: any, world: any) => any;
  mutations?: string[][];
  directoryEntries?: string[] | ((world: any) => string[]);
  rootEntries?: string[];
  tmpEntries?: string[];
  content?: string;
  argv?: string[];
};
export const RED_OUTPUT = "✖ fake (1ms)\n  AssertionError [ERR_ASSERTION]: caught\n";
export function fakeSweep(options: FakeSweepOptions = {}) {
  const source = readFileSync(join(root, "scripts/mutation-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  const rwrStart = source.indexOf("export function removeWithRetry");
  const rwrEnd = source.indexOf("\n}\n", rwrStart) + "\n}\n".length;
  const removeWithRetrySource = source.slice(rwrStart, rwrEnd).replaceAll("export function", "function");

  const mainMarker = "if (import.meta.main) {";
  const mainStart = source.indexOf(mainMarker);
  assert.ok(mainStart >= 0, "the sweep's own top-level entry point must exist");
  const mainBody = source.slice(mainStart + mainMarker.length, source.lastIndexOf("}"))
    .replaceAll("import.meta.url", JSON.stringify("file:///fake/scripts/mutation-proof.mjs"));

  const original = options.content ?? "before ORIGINAL_TARGET after";
  const files = new Map<string, string>([["fake-file.ts", original]]);
  const world = {
    files,
    removed: [] as string[], renamed: [] as [string, string][], released: 0, handlers: {} as Record<string, () => void>,
    spawns: [] as { command: string; args: string[]; options: any }[],
    redRuns: 0, lastRunWasRed: false, chdirs: 0,
  };
  const rmSyncImpl = options.rmSync ?? (() => {});
  const fakeSpawn = options.spawnSync ?? ((_command: string, _args: string[]) => ({ status: 0, stdout: "", stderr: "" }));
  const context = {
    process: {
      argv: options.argv ?? [], env: {}, cwd: () => "/fake", chdir: () => { world.chdirs++; },
      on: (signal: string, handler: () => void) => { world.handlers[signal] = handler; },
    },
    URL, fileURLToPath: () => "/fake/",
    resolve: (...parts: string[]) => parts.join("/"),
    extname: path.extname, setImmediate,
    acquireLock: () => {}, releaseLock: () => { world.released++; },
    readdirSync: (dir: string) => (dir === "/fake/" ? options.rootEntries ?? [] : dir === "/fake-tmp" ? options.tmpEntries ?? [] : typeof options.directoryEntries === "function" ? options.directoryEntries(world) : options.directoryEntries ?? []),
    tmpdir: () => "/fake-tmp",
    mkdtempSync: (prefix: string) => `${prefix.replace("//", "/")}x`, // "/fake/.cc-test-mutations-x" and "/fake-tmp/cc-sweep-x"
    renameSync: (from: string, to: string) => { world.renamed.push([from, to]); },
    cpSync: () => {}, COPIED_PATHS, MUTATION_DIR_PREFIX, EVIDENCE_PREFIX, TEMP_DIR_PREFIX, SYNTAX_CHECKED, isRealRed,
    rmSync: (path: string, rmOptions?: any) => { world.removed.push(path); rmSyncImpl(path, rmOptions); },
    Atomics: { wait: () => {} }, SharedArrayBuffer, Int32Array, Buffer,
    writeFileSync: (path: string, content: string | Buffer) => { files.set(path, Buffer.isBuffer(content) ? content.toString("utf8") : String(content)); },
    readFileSync: (path: string) => Buffer.from(files.get(path) ?? "", "utf8"),
    assert, console: { log: () => {} },
    // A single fake mutation stands in for the real (huge) catalogue --
    // its own red/restored runs are entirely driven by the fake spawnSync
    // below, never touching a real file or a real npm test.
    mutations: options.mutations ?? [["fake-guard", "fake-file.ts", "ORIGINAL_TARGET", "MUTATED_TARGET"]],
    // Every run -- baseline, this mutation's own "red" run, and the restored
    // run -- comes back green (status 0) unless a test overrides this. The
    // mutation never actually going red is exactly the real, undetected
    // regression the default fake proves.
    spawnSync: (command: string, args: string[], spawnOptions: any) => {
      world.spawns.push({ command, args, options: spawnOptions });
      if (spawnOptions?.env && "CC_MUTATION_PROOF" in spawnOptions.env) world.lastRunWasRed = spawnOptions.env.CC_MUTATION_PROOF === "1"; // a suite run, not the cleanup shell or the parse check
      if (spawnOptions?.env?.CC_MUTATION_PROOF === "1") world.redRuns++;
      return fakeSpawn(command, args, spawnOptions, world);
    },
  };
  return { world, run: (): Promise<void> => runInNewContext(`${removeWithRetrySource}\n(async () => {\n${mainBody}\n})()`, context) };
}
// A suite that goes red (a real assertion) on the mutated run and green otherwise; `node --check` always parses.
export const catchesMutation = (_command: string, _args: string[], spawnOptions: any) => (
  spawnOptions?.env?.CC_MUTATION_PROOF === "1" ? { status: 1, stdout: RED_OUTPUT, stderr: "" } : { status: 0, stdout: "", stderr: "" }
);

export const isCleanupShell = (command: string) => command === "powershell.exe";
export const timedOutCleanup = { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }) };
