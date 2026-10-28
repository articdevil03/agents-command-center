import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, win32 } from "node:path";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mutations, pendingMutations, COPIED_PATHS, hasDesignFolder, isRealRed, MUTATION_DIR_PREFIX, EVIDENCE_PREFIX, TEMP_DIR_PREFIX, SYNTAX_CHECKED, removeWithRetry } from "../scripts/mutation-proof.mjs";
import { tempRoot } from "./temp-root.ts";
import { spawn, spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { assertMatchingBuildArtifacts, isOutsideRepo, runPackagedSmoke } from "../scripts/packaged-smoke.mjs";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

// test/temp-root.ts as a plain script for a fake-context run: types stripped, imports and exports removed.
function tempRootSource(): string {
  return stripTypeScriptTypes(readFileSync(join(root, "test/temp-root.ts"), "utf8"))
    .replace(/^import .*;\r?$/gm, "").replaceAll("import.meta.url", JSON.stringify(import.meta.url))
    .replace(/\bexport (async )?function\b/g, "$1function");
}

// A catalogue entry whose target text is gone aborts the sweep ("mutation target missing"), and one that matches twice may mutate the wrong
// place the moment file order shifts. So every entry, in every file, must find its text exactly once, and a stale one fails here by name.
// There is no list of files or entries that are exempt. pendingMutations (behaviour with no covering test yet) is checked the same way.
type CatalogueEntry = readonly string[];
function readTarget(file: string): string | null {
  try { return readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n"); } catch { return null; }
}
function targetProblems(entries: readonly CatalogueEntry[], read: (file: string) => string | null = readTarget): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const [name, file, from, to] of entries) {
    if (names.has(name)) problems.push(`${name}: listed twice`);
    names.add(name);
    const source = read(file);
    if (source === null) { problems.push(`${name}: target file ${file} does not exist`); continue; }
    if (!from) { problems.push(`${name}: empty target text`); continue; }
    const count = source.split(from).length - 1;
    if (count !== 1) problems.push(`${name}: target text ${count === 0 ? "is missing from" : `matches ${count} times in`} ${file} (expected exactly 1)`);
    if (to === from) problems.push(`${name}: the replacement equals the target, so it changes nothing`);
  }
  return problems;
}

// Intentional source mutations remove their own targets. They must fail a
// behavior test, not this catalogue check. Baseline/restored runs check all entries.
test("every mutation target exists exactly once", { skip: process.env.CC_MUTATION_PROOF === "1" }, () => {
  assert.ok(mutations.length > 500, "control: the catalogue is not empty");
  // Entries on the owner's private design/ folder are checked only where that folder exists (never because one file is missing).
  const present = [...mutations, ...pendingMutations].filter(([, file]) => !file.startsWith("design/") || hasDesignFolder(root));
  assert.ok(present.length > 500, "control: the checked entries are not empty");
  assert.deepEqual(targetProblems(present), []);
});

test("a stale entry is flagged whichever file it points at, and the guard-stale-entry canary injects exactly such an entry", () => {
  for (const file of ["server/index.ts", "server/config.ts", "server/runner.ts", "server/leader-tools.ts", "public/app.js", "public/index.html", "public/style.css", "electron/main.js"]) {
    assert.deepEqual(targetProblems([["deliberately-stale", file, "THIS TARGET DOES NOT EXIST", ""]]), [`deliberately-stale: target text is missing from ${file} (expected exactly 1)`]);
  }
  assert.deepEqual(targetProblems([["gone", "server/no-such-file.ts", "x", "y"]]), ["gone: target file server/no-such-file.ts does not exist"]);
  assert.deepEqual(targetProblems([["twice", "f", "a", "b"]], () => "a a"), ["twice: target text matches 2 times in f (expected exactly 1)"]);
  assert.deepEqual(targetProblems([["same", "f", "a", "a"]], () => "a"), ["same: the replacement equals the target, so it changes nothing"]);
  const canary = mutations.find(([name]) => name === "guard-stale-entry");
  assert.ok(canary, "the canary entry exists");
  const [, file, from, to] = canary;
  const mutated = readTarget(file)!.replace(from, () => to);
  const injected = mutated.match(/\["deliberately-stale", "([^"]+)", "([^"]+)", ""\]/);
  assert.ok(injected, "mutating the catalogue with the canary injects a deliberately stale entry");
  assert.equal(targetProblems([["deliberately-stale", injected[1], injected[2], ""]]).length, 1, "the injected entry is flagged by the check above");
});

test("pending mutations say why no test covers them, and stay out of the swept catalogue", () => {
  const swept = new Set(mutations.map(([name]) => name));
  for (const [name, , , , why] of pendingMutations) {
    assert.ok(why && why.length > 20, `${name}: say what test is missing`);
    assert.equal(swept.has(name), false, `${name}: listed as both swept and pending`);
  }
});

test("the legacy browser-only environment cannot bypass real browser audits", () => {
  const source = readFileSync(join(root, "test/browser.test.ts"), "utf8");
  assert.doesNotMatch(source, /if\s*\(\s*process\.env\.CC_BROWSER_ONLY\s*!==\s*["']b2["']\s*\)/, "remove the old CC_BROWSER_ONLY=b2 audit bypass");
  assert.match(source, /CC_BROWSER_DEBUG_ONLY/, "the only audit bypass is explicitly named for local debug use");
});

// The slice of mutation-proof.mjs's sweep body between two markers, run in a fresh context with fakes for everything it touches.
function sweepSlice(startMarker: string, endMarker: string): string {
  const source = readFileSync(join(root, "scripts/mutation-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} ... ${endMarker} must be found in the sweep`);
  return source.slice(start, end);
}
const RUN_SLICE = () => sweepSlice("    function run(label, red = false) {", "    // Writes are synchronous");

test("mutation sweep strips CC_DATA_DIR at its actual test spawn, in both the scoped and the whole-suite branch", () => {
  const slice = RUN_SLICE();
  for (const scoped of ["", "a.test.ts,b.test.ts"]) {
    for (const red of [false, true]) {
      let call: { command: string; args: string[]; options: any } | undefined;
      const env = { CC_DATA_DIR: tempRoot(), CC_TEST_FORCE_PACKAGED: "1", PATH: "kept", CC_MUTATION_FILES: scoped };
      const run = runInNewContext(`${slice}; run`, {
        process: { env, execPath: "node-exe" }, assert, resolve: join, directory: tempRoot(), sweepTmp: "private-temp", runTimeoutMs: 20_000,
        sweepStaleTempDirs() {}, killStrayServers() {}, readdirSync: () => [], writeFileSync() {},
        spawnSync: (command: string, args: string[], options: any) => {
          call = { command, args, options };
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      run("fake", red);
      assert.ok(call?.options.env, `${scoped || "whole suite"}: the child gets an environment`);
      if (scoped) assert.equal(JSON.stringify([call.command, call.args]), JSON.stringify(["node-exe", ["--import", "./test/crash-catcher-self.ts", "--test", "a.test.ts", "b.test.ts"]]), "scoped branch");
      else assert.equal(JSON.stringify([call.command, call.args]), JSON.stringify(["npm.cmd", ["test"]]), "whole-suite branch");
      assert.equal(Object.hasOwn(call.options.env, "CC_DATA_DIR"), false, `${scoped || "whole suite"}: CC_DATA_DIR stripped`);
      assert.equal(Object.hasOwn(call.options.env, "CC_TEST_FORCE_PACKAGED"), false, `${scoped || "whole suite"}: CC_TEST_FORCE_PACKAGED stripped`);
      assert.equal(call.options.env.PATH, "kept");
      assert.equal(call.options.env.CC_MUTATION_PROOF, red ? "1" : "");
      assert.equal(call.options.env.TEMP, "private-temp", "the child's temp folder is inside the sweep's own folder");
      assert.equal(call.options.env.TMP, "private-temp");
      assert.ok(env.CC_DATA_DIR, "must not change the parent environment");
    }
  }
});

test("mutation sweep: a .cc-test directory left behind fails a green run, but is never what makes a red run count as caught", () => {
  const make = (files: string[]) => runInNewContext(`${RUN_SLICE()}; run`, {
    process: { env: {} }, assert, resolve: join, directory: "fake-project-root", sweepTmp: "t", runTimeoutMs: 20_000,
    sweepStaleTempDirs() {}, killStrayServers() {}, readdirSync: () => files, writeFileSync() {},
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  const green = make([".cc-test-leftover"])("hygiene");
  assert.equal(green.code, 1);
  assert.match(green.output, /LEAK: hygiene: \.cc-test-\* directories remained after the run: \.cc-test-leftover/);
  const red = make([".cc-test-leftover"])("hygiene", true);
  assert.equal(red.code, 0, "a leak on a run that never failed is not a failure the mutation caused");
  assert.equal(isRealRed(red.code, red.output), false);
  assert.equal(make([])("clean").code, 0);
});

test("isRealRed: only exit code 1 with a real AssertionError counts; a crash, a timeout or a leak note does not", () => {
  const assertion = "✖ fails (0.9ms)\n  AssertionError [ERR_ASSERTION]: msg\n      at x";
  assert.equal(isRealRed(1, assertion), true);
  assert.equal(isRealRed(1, `npm warn\n${assertion}\n`), true);
  assert.equal(isRealRed(0, assertion), false, "a passing exit code is never red");
  assert.equal(isRealRed(null, assertion), false, "a timeout has no exit code");
  assert.equal(isRealRed(2, assertion), false, "only node:test's failing-tests code");
  assert.equal(isRealRed(1, "SyntaxError: Unexpected token '='\n✖ b.test.mjs (168ms)"), false, "a syntax error is not an assertion");
  assert.equal(isRealRed(1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'\n✖ b.test.mjs"), false, "an import crash is not an assertion");
  assert.equal(isRealRed(1, "✖ thrower\n  TypeError: boom"), false, "a thrown error is not an assertion");
  assert.equal(isRealRed(1, "LEAK: x-red: .cc-test-* directories remained after the run: .cc-test-a\nAssertionError: not a real report"), false, "the leak note and prose are not an assertion report");
  assert.equal(isRealRed(1, ""), false);
});

test("mutation sweep cleanup stops only processes holding this sweep's own folder, and never looks at ports", () => {
  const slice = sweepSlice("  function killStrayServers() {", "  let completed = false;");
  assert.doesNotMatch(slice, /FIXED_TEST_PORTS|NetTCP|LocalPort|43\d\d/, "no fixed-port kill");
  let call: { command: string; args: string[]; options: any } | undefined;
  const directory = join(tempRoot(), "it's here");
  const sweepTmp = join(tempRoot(), "tmp's");
  const cleanup = runInNewContext(`${slice}; killStrayServers`, {
    process: { env: { CC_DATA_DIR: tempRoot(), CC_TEST_FORCE_PACKAGED: "1", PATH: "kept" } },
    directory, sweepTmp,
    spawnSync: (command: string, args: string[], options: any) => { call = { command, args, options }; return { status: 0, stdout: "", stderr: "" }; },
  });
  cleanup();
  assert.ok(call?.options.env);
  assert.equal(Object.hasOwn(call.options.env, "CC_DATA_DIR"), false);
  assert.equal(Object.hasOwn(call.options.env, "CC_TEST_FORCE_PACKAGED"), false);
  assert.equal(call.options.env.PATH, "kept");
  const script = call.args.at(-1)!;
  assert.ok(script.includes(`.Contains('${directory.replace(/'/g, "''")}')`), "matches the sweep's own copy folder, quotes doubled");
  assert.ok(script.includes(`.Contains('${sweepTmp.replace(/'/g, "''")}')`), "and its private temp folder, where the test servers run from");
  assert.ok(script.includes("$_.ProcessId -ne $PID"), "the filtering shell excludes itself");
  assert.doesNotMatch(script, /Get-NetTCPConnection|-LocalPort/);
});

// A cleanup query or stop that timed out or failed must never read as "nothing to stop".
test("mutation sweep cleanup: a timed-out or failed process query or stop throws instead of being ignored", () => {
  const slice = sweepSlice("  function killStrayServers() {", "  let completed = false;");
  const cleanupWith = (answer: any) => runInNewContext(`${slice}; killStrayServers`, {
    process: { env: {} }, directory: join(tempRoot(), "copy"), sweepTmp: join(tempRoot(), "tmp"), spawnSync: () => answer,
  });
  assert.doesNotThrow(() => cleanupWith({ status: 0, stdout: "", stderr: "" })(), "control: a clean cleanup passes");
  const timedOut = { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }) };
  assert.throws(() => cleanupWith(timedOut)(), /process cleanup did not finish.*ETIMEDOUT/s);
  assert.throws(() => cleanupWith({ status: 1, stdout: "", stderr: "Get-CimInstance : Invalid class" })(), /exit 1.*Invalid class/s, "a failed query");
  assert.throws(() => cleanupWith({ status: 2, stdout: "", stderr: "" })(), /exit 2/, "a process still alive after its stop");
  const script = readFileSync(join(root, "scripts/mutation-proof.mjs"), "utf8");
  assert.match(script, /"\$ErrorActionPreference='Stop'; "/, "a failed query terminates the shell");
});

// The real thing, on processes this test starts itself: one whose command line carries the folder, one bystander without it.
test("mutation sweep cleanup really stops a process under the sweep folder and leaves an unrelated one alone", { skip: process.platform !== "win32" }, () => {
  const copyFolder = mkdtempSync(join(tmpdir(), "cc-stray-copy-"));
  const tempFolder = mkdtempSync(join(tmpdir(), "cc-stray-tmp-"));
  const hold = "setTimeout(() => {}, 120000)";
  const spawnHolder = (argument: string) => spawn(process.execPath, ["-e", hold, argument], { stdio: "ignore", windowsHide: true });
  const inCopy = spawnHolder(join(copyFolder, "test", "fake-cli.mjs"));
  const inTemp = spawnHolder(join(tempFolder, "cc-http-test-x", "server", "index.ts"));
  const bystander = spawnHolder("unrelated-argument");
  try {
    assert.ok(inCopy.pid && inTemp.pid && bystander.pid);
    const cleanup = runInNewContext(`${sweepSlice("  function killStrayServers() {", "  let completed = false;")}; killStrayServers`, { process: { env: process.env }, directory: copyFolder, sweepTmp: tempFolder, spawnSync });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // The command line is registered a moment after the spawn returns.
    for (let attempt = 0; attempt < 20 && (alive(inCopy.pid!) || alive(inTemp.pid!)); attempt++) { cleanup(); }
    assert.equal(alive(inCopy.pid!), false, "the process holding the sweep's copy folder is stopped");
    assert.equal(alive(inTemp.pid!), false, "the process holding the sweep's temp folder is stopped");
    assert.equal(alive(bystander.pid!), true, "a process without either is not touched");
  } finally {
    for (const child of [inCopy, inTemp, bystander]) child.kill();
    removeWithRetry(copyFolder);
    removeWithRetry(tempFolder);
  }
});

// A test server on a fixed port fails whenever anything else (a leaked listener, a dev server) holds it, for a reason unrelated to the code under test.
test("no test gives a server a fixed CC_PORT: 0 (the OS picks) or a port the test found free", () => {
  let found = 0;
  const fixed: string[] = [];
  for (const file of readdirSync(join(root, "test")).filter((f) => /\.(ts|mjs)$/.test(f))) {
    for (const m of file === "tooling.test.ts" ? [] : readFileSync(join(root, "test", file), "utf8").matchAll(/CC_PORT:\s*(["'`]?)([^,}\s"'`]+)\1/g)) { // this file holds the pattern itself
      found++;
      if (m[2] !== "0" && !/^String\(|^`?\$\{/.test(m[2])) fixed.push(`test/${file}: CC_PORT: ${m[0].slice(8).trim()}`);
    }
  }
  assert.deepEqual(fixed, []);
  assert.ok(found >= 5, `control: the scan found only ${found} CC_PORT settings`);
});

test("HTTP server and outside-upload roots use OS temp instead of the repository", () => {
  const source = readFileSync(join(root, "test/http.test.ts"), "utf8");
  assert.match(source, /const root = mkdtempSync\(join\(tmpdir\(\), "cc-http-test-"\)\)/);
  assert.match(source, /const outsideRoot = mkdtempSync\(join\(tmpdir\(\), "cc-http-outside-"\)\)/);
  assert.doesNotMatch(source, /tempRoot\s*\(/, "a killed HTTP test worker must not leave tempRoot directories in the repo");
});

// The mutation tool runs the suite in a disposable copy. A repo path a test reads at load
// that the copy lacks makes every baseline fail with ENOENT, so the copy list must cover them.
// Both syntaxes a test reads the repo with are scanned: join(<repo root>, "a", "b") and a bare relative literal such as
// readFileSync("electron/main.js"), through any of these calls, in the .ts and the .mjs test files. A name counts as the repo root only where
// the file defines it that way (a test's own mkdtemp "root" is not the repo).
const READ_CALLS = "readFileSync|readdirSync|existsSync|statSync|cpSync|createReadStream";
const BARE_READ = new RegExp(`\\b(?:${READ_CALLS})\\(\\s*"([^"/.:][^"]*)"`, "g");
const REPO_NAME_DEFINITION = /\b(?:const|let)\s+(\w+)\s*=\s*(?:realpathSync\()?(?:fileURLToPath\(new URL\("\.\.", import\.meta\.url\)\)|process\.cwd\(\)|resolve\("\."\))/g;
function repoReadsOf(source: string): string[] {
  const names = ["process\\.cwd\\(\\)", ...[...source.matchAll(REPO_NAME_DEFINITION)].map((m) => m[1])];
  const joined = new RegExp(`\\b(?:${READ_CALLS})\\(\\s*join\\(\\s*(?:${names.join("|")})\\s*((?:,\\s*"[^"]+"\\s*)+)\\)`, "g");
  return [
    ...[...source.matchAll(joined)].map((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((part) => part[1]).join("/")),
    ...[...source.matchAll(BARE_READ)].map((m) => m[1]),
  ];
}

test("mutation-proof copies every repo path a test file reads at load", () => {
  // node_modules is not copied: the copy sits inside the repo, so the dependencies resolve from the repo's own folder.
  const covered = (p: string) => /^node_modules(\/|$)/.test(p) || COPIED_PATHS.some((c) => p === c || p.startsWith(`${c}/`));
  for (const required of ["build/icon-source.svg", "build/icon.ico"]) assert.ok(covered(required), `${required} is outside the mutation tool's copy list ${JSON.stringify(COPIED_PATHS)}`);
  let found = 0;
  const uncovered: string[] = [];
  for (const file of readdirSync(join(root, "test")).filter((f) => /\.(ts|mjs)$/.test(f))) {
    for (const target of repoReadsOf(readFileSync(join(root, "test", file), "utf8"))) {
      found++;
      if (!covered(target)) uncovered.push(`test/${file} reads ${target}`);
    }
  }
  assert.deepEqual(uncovered, [], "the mutation tool's copy does not include these");
  assert.ok(found > 20, `control: the scan found only ${found} reads`);
  // The scan itself, on text built from pieces so this file does not match its own scan: a bare relative read and a join from the repo root are
  // seen, a join from some other name is not.
  const sample = "readFile" + 'Sync("electron/main.js", "utf8"); exists' + 'Sync(join(root, "design", "x.svg")); readdir' + 'Sync(join(tmp, "data"))';
  assert.deepEqual(repoReadsOf(`${sample}; const root = process.cwd();`).sort(), ["design/x.svg", "electron/main.js"]);
  assert.deepEqual(repoReadsOf(sample), ["electron/main.js"], "root is not the repo unless the file says so");
});

// Real behavior, real import: removeWithRetry against a real directory it can
// actually delete must succeed on the first attempt and report so.
test("removeWithRetry: a real removable directory is deleted on the first attempt", async () => {
  const { removeWithRetry } = await import("../scripts/mutation-proof.mjs");
  const dir = mkdtempSync(join(root, ".cc-test-removeWithRetry-"));
  writeFileSync(join(dir, "marker.txt"), "x");
  assert.equal(removeWithRetry(dir), true);
  assert.equal(existsSync(dir), false);
});

// Guard: a stuck handle that clears after a couple of retries must not be
// treated as a permanent failure -- this is the shape of the real EPERM race
// (AV scan, a child's handle not yet released) the retry exists to survive.
test("removeWithRetry: succeeds once the underlying failure clears, after backing off between attempts", () => {
  const source = readFileSync(join(root, "scripts/mutation-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("export function removeWithRetry");
  const end = source.indexOf("\n}\n", start) + "\n}\n".length;
  const body = source.slice(start, end).replaceAll("export function", "function");
  let calls = 0;
  const waits = [];
  const removeWithRetry = runInNewContext(`${body}; removeWithRetry`, {
    rmSync: () => { calls++; if (calls < 3) throw new Error("EPERM: resource busy or locked"); },
    console: { log: () => {} },
    Atomics: { wait: (_buf, _idx, _val, ms) => waits.push(ms) },
    SharedArrayBuffer, Int32Array,
  });
  assert.equal(removeWithRetry("C:/fake/dir", 5, 1), true);
  assert.equal(calls, 3, "must retry exactly until the underlying rmSync stops throwing");
  assert.deepEqual(waits, [1, 1], "must back off between the two failed attempts, not the succeeding one");
});

// Guard: exhausting every attempt on a permanently stuck handle must warn and
// return false -- never throw. This is the actual crash the brief describes
// (an uncaught EPERM in the sweep's own finally block, after every mutation
// had already been verified) -- reverting to a bare rmSync here must fail
// this test by throwing instead of returning.
test("removeWithRetry: a permanently stuck removal warns and returns false, never throws", () => {
  const source = readFileSync(join(root, "scripts/mutation-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("export function removeWithRetry");
  const end = source.indexOf("\n}\n", start) + "\n}\n".length;
  const body = source.slice(start, end).replaceAll("export function", "function");
  let calls = 0;
  const warnings = [];
  const removeWithRetry = runInNewContext(`${body}; removeWithRetry`, {
    rmSync: () => { calls++; throw new Error("EPERM: resource busy or locked"); },
    console: { log: (msg) => warnings.push(msg) },
    Atomics: { wait: () => {} },
    SharedArrayBuffer, Int32Array,
  });
  let result;
  assert.doesNotThrow(() => { result = removeWithRetry("C:/fake/dir", 3, 1); });
  assert.equal(result, false);
  assert.equal(calls, 3);
  assert.match(warnings[0], /WARNING.*could not remove/);
});

// Behavioral guard (replaces a source-text-only version: it checked that
// certain strings existed in the file, which stayed green even when an
// in-memory catch was wrapped around the verification asserts to swallow
// them -- see the brief, "guard the call site, not the helper"). Drives the
// sweep's REAL main body -- its own mutations array and spawnSync swapped for
// fakes -- so a mutation that SURVIVES its own "red" run, the genuine
// undetected regression this sweep exists to catch, must actually escape the
// sweep. removeWithRetry's real source is spliced in too (sharing the fake
// rmSync), so a real cleanup removal failure can't mask that escape either.
type FakeSweepOptions = {
  rmSync?: (path: string, options?: any) => void;
  spawnSync?: (command: string, args: string[], options: any, world: any) => any;
  mutations?: string[][];
  directoryEntries?: string[] | ((world: any) => string[]);
  rootEntries?: string[];
  tmpEntries?: string[];
  content?: string;
  argv?: string[];
};
const RED_OUTPUT = "✖ fake (1ms)\n  AssertionError [ERR_ASSERTION]: caught\n";
function fakeSweep(options: FakeSweepOptions = {}) {
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
const catchesMutation = (_command: string, _args: string[], spawnOptions: any) => (
  spawnOptions?.env?.CC_MUTATION_PROOF === "1" ? { status: 1, stdout: RED_OUTPUT, stderr: "" } : { status: 0, stdout: "", stderr: "" }
);

test("mutation sweep: a mutation that survives its own red run is still reported as a failure, not swallowed", async () => {
  await assert.rejects(fakeSweep().run(), /fake-guard: mutation survived/,
    "a genuinely undetected mutation must throw out of the sweep -- an in-memory catch around the verification asserts would leave this green");
});

test("mutation sweep: a real cleanup removal failure never masks a genuine verification failure", async () => {
  await assert.rejects(
    fakeSweep({ rmSync: () => { throw new Error("EPERM: resource busy or locked"); } }).run(),
    /fake-guard: mutation survived/,
    "even with the finally block's own cleanup hitting a real, persistent removal error, the actual mutation-survived failure must be what surfaces, never lost behind a cleanup crash"
  );
});

// Guard: the runner's spawnSync timing out (a busy machine, a wedged suite)
// must surface as its own distinct "TIMEOUT" failure -- never read as
// "mutation survived" (the fake mutation here never even goes red) and never
// swallowed by the generic runner-error check that timeout used to fall into
// undistinguished. spawnSync returns the actual Node shape a timed-out
// spawnSync produces on Windows: status null, an error with code ETIMEDOUT.
test("mutation sweep: a run that times out is reported as a timeout, never as a mutation result", async () => {
  const timedOut = () => ({
    status: null, stdout: "", stderr: "",
    error: Object.assign(new Error("spawnSync C:\\WINDOWS\\system32\\cmd.exe ETIMEDOUT"), { code: "ETIMEDOUT" }),
  });
  let thrown: Error | undefined;
  await assert.rejects(fakeSweep({ spawnSync: (command: string) => (isCleanupShell(command) ? { status: 0, stdout: "", stderr: "" } : timedOut()) }).run(), (err: Error) => { thrown = err; return true; });
  assert.match(thrown!.message, /TIMEOUT/);
  assert.doesNotMatch(thrown!.message, /mutation survived/);
  assert.doesNotMatch(thrown!.message, /runner error/);
});

test("mutation sweep: a catching run (exit 1, real assertion) completes, restores the file and removes its folder and old evidence", async () => {
  const sweep = fakeSweep({ spawnSync: catchesMutation, rootEntries: [".cc-test-evidence-old", ".cc-test-other"] });
  await sweep.run();
  assert.equal(sweep.world.files.get("fake-file.ts"), "before ORIGINAL_TARGET after", "the mutated file is restored byte for byte");
  assert.ok(sweep.world.removed.includes("/fake/.cc-test-mutations-x"), "a finished sweep removes its folder");
  assert.ok(sweep.world.removed.includes("/fake//.cc-test-evidence-old"), "and the evidence of an earlier failed sweep");
  assert.equal(sweep.world.removed.includes("/fake//.cc-test-other"), false, "but never another run's .cc-test folder");
  assert.deepEqual(sweep.world.renamed, []);
  assert.equal(sweep.world.released, 1, "the lock is released");
});

// D2: a crash is not a caught mutation.
test("mutation sweep: a mutation whose run fails WITHOUT a real assertion (syntax error, import crash) is an error, not RED", async () => {
  for (const crash of ["SyntaxError: Unexpected token '='\n✖ b.test.mjs (168ms)\n", "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'\n✖ b.test.mjs\n", "✖ thrower\n  TypeError: boom\n"]) {
    const fail = (_c: string, _a: string[], o: any) => (o?.env?.CC_MUTATION_PROOF === "1" ? { status: 1, stdout: crash, stderr: "" } : { status: 0, stdout: "", stderr: "" });
    await assert.rejects(fakeSweep({ spawnSync: fail }).run(), (err: Error) => /not on a test assertion/.test(err.message) && !/mutation survived/.test(err.message), crash);
  }
});

test("mutation sweep: a leaked .cc-test folder on a red run that never failed is still a surviving mutation", async () => {
  const leaky = fakeSweep({ directoryEntries: [".cc-test-leftover"] });
  // the leak makes the baseline fail first, which is the green-run rule; on a red run alone it must not read as caught
  await assert.rejects(leaky.run(), /baseline must be green/);
  const onlyRedLeaks = fakeSweep({ directoryEntries: (world) => (world.lastRunWasRed ? [".cc-test-leftover"] : []) });
  await assert.rejects(onlyRedLeaks.run(), /mutation survived/);
});

// D2: a mutation that leaves a script unparseable crashes every file that loads it.
test("mutation sweep: a mutation that breaks parsing is a catalogue error and never runs the suite", async () => {
  const sweep = fakeSweep({
    mutations: [["breaks-parsing", "fake-file.ts", "ORIGINAL_TARGET", "BROKEN SYNTAX"]],
    spawnSync: (_c, args, _o, world) => {
      if (args[0] === "--check") return { status: world.files.get(args[1]!)?.includes("BROKEN") ? 1 : 0 };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(sweep.run(), /breaks-parsing: the mutation leaves fake-file\.ts unparseable \(a catalogue error/);
  assert.equal(sweep.world.redRuns, 0, "no red run was started");
  assert.equal(sweep.world.files.get("fake-file.ts"), "before ORIGINAL_TARGET after", "the file was never touched");
});

test("mutation sweep: a target that is missing or matches twice stops the sweep before any file is touched", async () => {
  await assert.rejects(fakeSweep({ mutations: [["gone", "fake-file.ts", "NOT THERE", "x"]] }).run(), /gone: mutation target missing/);
  await assert.rejects(fakeSweep({ mutations: [["twice", "fake-file.ts", "T", "x"]] }).run(), /twice: mutation target matches 2 times/);
});

const isCleanupShell = (command: string) => command === "powershell.exe";
const timedOutCleanup = { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }) };

test("mutation sweep: a cleanup that fails stops the sweep with its evidence kept and the lock released", async () => {
  const sweep = fakeSweep({ spawnSync: (c, a, o, world) => (isCleanupShell(c) ? timedOutCleanup : catchesMutation(c, a, o)) });
  await assert.rejects(sweep.run(), /killStrayServers: the process cleanup did not finish/);
  assert.equal(sweep.world.redRuns, 0, "no suite run started on top of live test processes");
  assert.equal(sweep.world.renamed.length, 1, "evidence kept");
  assert.equal(sweep.world.released, 1, "lock released");
});

test("mutation sweep: a final cleanup that fails after every mutation passed still counts as unfinished, releases the lock and is reported", async () => {
  const failFinal = (c: string, a: string[], o: any, world: any) => (isCleanupShell(c) && world.chdirs >= 2 ? timedOutCleanup : catchesMutation(c, a, o));
  const sweep = fakeSweep({ spawnSync: failFinal, rootEntries: [".cc-test-evidence-old"] });
  await assert.rejects(sweep.run(), /killStrayServers: the process cleanup did not finish/);
  assert.equal(sweep.world.files.get("fake-file.ts"), "before ORIGINAL_TARGET after", "the file is restored");
  assert.equal(sweep.world.renamed.length, 1, "evidence kept, the folder is not deleted as a finished sweep's would be");
  assert.equal(sweep.world.removed.includes("/fake//.cc-test-evidence-old"), false, "and earlier evidence is not deleted");
  assert.equal(sweep.world.released, 1, "the lock is released");
  // an earlier failure that is already leaving is not replaced by the cleanup's
  const survived = fakeSweep({ spawnSync: (c, a, o, world) => (isCleanupShell(c) && world.chdirs >= 2 ? timedOutCleanup : { status: 0, stdout: "", stderr: "" }) });
  await assert.rejects(survived.run(), /fake-guard: mutation survived/);
  assert.equal(survived.world.released, 1);
});

test("mutation sweep: a filter part that matches no catalogue entry is refused before the lock, the copy or any suite run", async () => {
  const sweep = fakeSweep({
    argv: ["node", "mutation-proof.mjs", "alpha,misspelled-guard"],
    mutations: ["alpha-1", "beta-2"].map((name) => [name, "fake-file.ts", "ORIGINAL_TARGET", `MUTATED_${name}`]),
    spawnSync: catchesMutation,
    rootEntries: [".cc-test-evidence-old"],
  });
  await assert.rejects(sweep.run(), /no catalogue entry name contains misspelled-guard/);
  assert.equal(sweep.world.spawns.length, 0, "nothing was started");
  assert.deepEqual(sweep.world.removed, [], "earlier evidence is not deleted");
});

// A string replacement would expand these; the mutation must land byte for byte.
test("mutation sweep: $ patterns in a replacement are written literally", async () => {
  const to = "$& $$ $' $` $1";
  let seen: string | undefined;
  const sweep = fakeSweep({
    mutations: [["dollars", "fake-file.ts", "ORIGINAL_TARGET", to]],
    spawnSync: (c, a, o, world) => { if (o?.env?.CC_MUTATION_PROOF === "1") seen = world.files.get("fake-file.ts"); return catchesMutation(c, a, o); },
  });
  await sweep.run();
  assert.equal(seen, `before ${to} after`);
});

test("mutation sweep: argv[2] is a comma-separated list of name parts; only matching entries run", async () => {
  const ran: string[] = [];
  const sweep = fakeSweep({
    argv: ["node", "mutation-proof.mjs", "alpha,gamma"],
    mutations: ["alpha-1", "beta-2", "gamma-3"].map((name) => [name, "fake-file.ts", "ORIGINAL_TARGET", `MUTATED_${name}`]),
    spawnSync: (c, a, o, world) => { if (o?.env?.CC_MUTATION_PROOF === "1") ran.push(world.files.get("fake-file.ts")!); return catchesMutation(c, a, o); },
  });
  await sweep.run();
  assert.deepEqual(ran, ["before MUTATED_alpha-1 after", "before MUTATED_gamma-3 after"]);
});

// D3 / start-up: the sweep deletes only its own kind of folder, nothing an `npm test` running at the same time owns.
test("mutation sweep start-up removes older .cc-test-mutations-* folders and no other .cc-test-* folder", async () => {
  const sweep = fakeSweep({ rootEntries: [".cc-test-mutations-old", ".cc-test-AbC123", ".cc-test-evidence-1", "keep.txt"] });
  await assert.rejects(sweep.run(), /mutation survived/);
  assert.ok(sweep.world.removed.includes("/fake//.cc-test-mutations-old"));
  for (const kept of [".cc-test-AbC123", ".cc-test-evidence-1", "keep.txt"]) {
    assert.equal(sweep.world.removed.includes(`/fake//${kept}`), false, `${kept} must survive the start-up cleanup`);
  }
});

// The private temp folder every test process of the sweep runs in: outside the repo, removed whether the sweep finishes or not, and an older
// one a sweep that died hard left behind is cleared at start-up (only that prefix).
test("mutation sweep: its private temp folder is the TEMP/TMP of every suite run, and is removed on success and on failure", async () => {
  const temps: unknown[] = [];
  const done = fakeSweep({ spawnSync: (c, a, o, world) => { if (o?.env?.TEMP) temps.push([o.env.TEMP, o.env.TMP]); return catchesMutation(c, a, o); }, tmpEntries: ["cc-sweep-old", "cc-other", "cc-sweep-old2"] });
  await done.run();
  assert.ok(temps.length >= 3, "the baseline, red and restored runs all ran");
  assert.ok(temps.every((pair) => JSON.stringify(pair) === JSON.stringify(["/fake-tmp/cc-sweep-x", "/fake-tmp/cc-sweep-x"])), "every run's TEMP and TMP are the private folder");
  assert.ok(done.world.removed.includes("/fake-tmp/cc-sweep-x"), "removed after a finished sweep");
  assert.ok(done.world.removed.includes("/fake-tmp/cc-sweep-old") && done.world.removed.includes("/fake-tmp/cc-sweep-old2"), "older sweep temp folders are cleared at start-up");
  assert.equal(done.world.removed.includes("/fake-tmp/cc-other"), false, "but nothing else in the OS temp dir");
  const failed = fakeSweep();
  await assert.rejects(failed.run(), /mutation survived/);
  assert.ok(failed.world.removed.includes("/fake-tmp/cc-sweep-x"), "removed after a failed sweep too (it holds no evidence)");
});

// A sweep that fails keeps what it learned: the per-run outputs and results.json, not the copy of the source and config.
test("mutation sweep: a failing sweep keeps its run outputs and results.json under an evidence folder", async () => {
  const sweep = fakeSweep({ directoryEntries: ["baseline.txt", "fake-guard-red.txt", "results.json", "server", "config", "sweep-tmp"] });
  await assert.rejects(sweep.run(), /mutation survived/);
  assert.deepEqual(sweep.world.renamed, [["/fake/.cc-test-mutations-x", "/fake/.cc-test-evidence-x"]]);
  for (const gone of ["server", "config", "sweep-tmp"]) assert.ok(sweep.world.removed.includes(`/fake/.cc-test-mutations-x/${gone}`), `${gone} is not evidence`);
  for (const kept of ["baseline.txt", "fake-guard-red.txt", "results.json"]) assert.equal(sweep.world.removed.includes(`/fake/.cc-test-mutations-x/${kept}`), false, `${kept} is evidence`);
  assert.equal(sweep.world.removed.includes("/fake/.cc-test-mutations-x"), false, "the folder itself is never deleted on failure");
  assert.equal(sweep.world.released, 1, "the lock is released even so");
});

// SIGINT cannot run during spawnSync; the handler flags it and the loop stops at the next mutation boundary, restoring and cleaning up.
test("mutation sweep: Ctrl-C stops between mutations, restores the file, keeps the evidence and releases the lock", async () => {
  const sweep = fakeSweep({
    mutations: [["first", "fake-file.ts", "ORIGINAL_TARGET", "MUTATED_ONE"], ["second", "fake-file.ts", "ORIGINAL_TARGET", "MUTATED_TWO"]],
    spawnSync: (c, a, o, world) => {
      if (o?.env?.CC_MUTATION_PROOF === "1" && world.redRuns === 1) world.handlers.SIGINT();
      return catchesMutation(c, a, o);
    },
  });
  await assert.rejects(sweep.run(), /interrupted \(Ctrl-C\)/);
  assert.equal(sweep.world.redRuns, 1, "the second mutation never ran");
  assert.equal(sweep.world.files.get("fake-file.ts"), "before ORIGINAL_TARGET after", "the file is restored");
  assert.equal(sweep.world.renamed.length, 1, "evidence kept");
  assert.equal(sweep.world.released, 1, "lock released");
  assert.equal(typeof sweep.world.handlers.SIGINT, "function", "the sweep registers a SIGINT handler");
});

test("tempRoot isolates copied directories and removes them afterwards", async (t) => {
  let dir = "";
  await t.test("allocate and copy", () => {
    dir = tempRoot(["server", "config", "public"]);
    const actual = realpathSync(dir);
    assert.notEqual(actual, root, "tempRoot must not return the repository root");
    assert.equal(dirname(actual), root);
    assert.match(relative(root, actual), /^\.cc-test-[^\\/]+$/);
    assert.ok(statSync(actual).isDirectory());
    for (const [folder, file] of [["server", "index.ts"], ["config", ".gitkeep"], ["public", "index.html"]]) {
      assert.ok(statSync(join(dir, folder)).isDirectory());
      assert.deepEqual(readFileSync(join(dir, folder, file)), readFileSync(join(root, folder, file)));
    }
  });
  assert.equal(existsSync(dir), false, "tempRoot cleanup must remove the directory");
});

test("temporary test directories are gitignored", () => {
  assert.ok(readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(".cc-test-*/"));
  const proof = readFileSync(join(root, "scripts/electron-process-proof.mjs"), "utf8");
  const statement = proof.match(/const screenshotPath = .*;/)?.[0];
  assert.ok(statement);
  assert.equal(runInNewContext(`${statement}; screenshotPath`, { dir: "temporary", root: "repository", join }), join("temporary", "electron-process-proof.png"));
});

test("tempRoot rejects repository and parent paths before registering destructive cleanup", () => {
  const source = tempRootSource();
  for (const unsafe of [root, dirname(root)]) {
    let cleanupRegistered = false;
    const allocate = runInNewContext(`${source}; tempRoot`, {
      assert, join, relative, realpathSync, isAbsolute, URL, fileURLToPath: () => root,
      mkdtempSync: () => unsafe,
      after: () => { cleanupRegistered = true; },
      rmSync: () => assert.fail("must never remove the repository"),
      cpSync: () => assert.fail("must reject before copying"),
    });
    assert.throws(() => allocate(), /unsafe test root/);
    assert.equal(cleanupRegistered, false);
  }
});

// A private scratch root, never the shared repo, so this can safely prove real
// cleanup without any risk of racing other test files' own .cc-test-* dirs.
test("tempRoot removes the real directory it created when the safety check fails for a reason other than root/parent", () => {
  const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "cc-temproot-guard-")));
  try {
    const source = tempRootSource();
    const allocate = runInNewContext(`${source}; tempRoot`, {
      assert, join, isAbsolute, realpathSync, mkdtempSync, rmSync, cpSync: () => assert.fail("must reject before copying"),
      relative: () => "not-a-cc-test-dir",
      after: () => assert.fail("must not register cleanup on throw"),
      URL, fileURLToPath: () => scratchRoot,
    });
    assert.throws(() => allocate(), /unsafe test root/);
    assert.deepEqual(readdirSync(scratchRoot), [], "the mkdtemp'd directory must not survive the throw");
  } finally {
    removeWithRetry(scratchRoot);
  }
});

// Same shape as mutation-proof.mjs's own EPERM race, one level down: a test's
// tempRoot()-created directory can still have a handle held on it (AV scan, a
// just-exited child) when its `after()` cleanup runs. Splices the real
// removeWithRetry source in next to the real tempRoot source (not a
// reimplementation of either) so the call site under test is the real
// integration between them.
function buildSandboxedTempRoot(rmSyncImpl) {
  const rwrSource = readFileSync(join(root, "scripts/mutation-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  const rwrStart = rwrSource.indexOf("export function removeWithRetry");
  const rwrEnd = rwrSource.indexOf("\n}\n", rwrStart) + "\n}\n".length;
  const removeWithRetrySource = rwrSource.slice(rwrStart, rwrEnd).replaceAll("export function", "function");
  const trSource = tempRootSource();

  let afterCallback = null;
  const tempRoot = runInNewContext(`${removeWithRetrySource}\n${trSource}\ntempRoot`, {
    assert, join, relative, realpathSync, isAbsolute, mkdtempSync,
    URL, fileURLToPath: () => root,
    after: (cb) => { afterCallback = cb; },
    rmSync: rmSyncImpl,
    console: { log: () => {} },
    Atomics: { wait: () => {} }, SharedArrayBuffer, Int32Array,
  });
  return { tempRoot, runAfter: () => afterCallback() };
}

test("tempRoot: a permanently stuck cleanup handle warns instead of failing the test", () => {
  let calls = 0;
  const { tempRoot, runAfter } = buildSandboxedTempRoot(() => {
    calls++;
    throw new Error("EPERM: resource busy or locked");
  });
  const dir = tempRoot();
  try {
    assert.doesNotThrow(() => runAfter(), "a stuck Windows handle during cleanup must never fail a test that already passed");
    assert.ok(calls > 1, "cleanup must be routed through removeWithRetry's retries, not a single bare rmSync call");
  } finally {
    removeWithRetry(dir);
  }
});

test("tempRoot: a failing test is not masked by a cleanup failure", () => {
  const { tempRoot, runAfter } = buildSandboxedTempRoot(() => { throw new Error("EPERM: resource busy or locked"); });
  const dir = tempRoot();
  try {
    let bodyError;
    try {
      assert.equal(1, 2, "the real assertion this test is checking");
    } catch (err) {
      bodyError = err;
    }
    assert.ok(bodyError, "the test body's own failure must be recorded first");
    assert.doesNotThrow(() => runAfter(), "cleanup must never add a masking throw on top of a real test failure");
  } finally {
    removeWithRetry(dir);
  }
});

// >>> THE EXE SHIPPED BROKEN ON 2026-09-09 AND 616 GREEN TESTS SAW NOTHING. <<<
// `server/leader-tools.ts` imports zod, which was never in `dependencies` --
// it is a PEER dependency of the agent SDK, so npm installs it at the repo
// root and every test, every `npm start`, every dev run resolved it happily.
// electron-builder walks declared production dependencies and does not follow
// peers, so the packaged app shipped without it and died on launch with
// ERR_MODULE_NOT_FOUND before the server was ready.
//
// Cheap common-static-shape check, not a JavaScript parser or packaging proof.
// Round 1 found three defects; round 2 found five, all from hand-rolling a lexer.
// Unsupported constructs throw instead of guessing. scripts/packaged-smoke.mjs
// is the real proof that the packaged server resolves its startup imports --
// but it starts server/index.ts under plain node, same as production does. It
// never loads electron/main.js, so this static scan is the ONLY check on
// electron/'s imports; that directory has nothing beyond runtime-provided
// electron today, but the smoke's readiness proof does not extend to it.
type Token = { type: "word" | "punct" | "string" | "dynamic-template"; value?: string; escaped?: boolean; offset?: number; line: number };

// Keywords after which a following `/` starts a regex, not a division --
// needed so a regex literal (which can legally contain "//" or quotes) is
// consumed as one opaque unit instead of being misread as a comment or a
// stray string delimiter.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "yield", "case", "do", "else", "extends", "default", "await",
]);

// Keep this deliberately limited. Do not grow a JavaScript parser here.
function tokenize(source: string, label: string): Token[] {
  const fail = (line: number, construct: string): never => {
    throw new Error(`${label}:${line}: ${construct}; this construct cannot be checked statically; verify by hand that its package is declared`);
  };
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  // Last real code emitted: a "value" (identifier, number, `)`, `]`, a
  // literal) means a following `/` is division; anything else means `/` can
  // start a regex.
  let prevIsValue = false;

  while (i < source.length) {
    const c = source[i];

    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }

    if (c === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line++;
        i++;
      }
      if (i >= source.length) fail(line, "unterminated block comment");
      i += 2;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      const startLine = line;
      i++;
      let value = "";
      let escaped = false;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") { escaped = true; if (source[i + 1] === "\n") line++; value += source[i + 1] ?? ""; i += 2; continue; }
        if (source[i] === "\n") line++;
        value += source[i]; i++;
      }
      if (i >= source.length) fail(startLine, "unterminated string");
      i++;
      tokens.push({ type: "string", value, escaped, line: startLine });
      prevIsValue = true;
      continue;
    }

    if (c === "`") {
      const startLine = line;
      i++;
      let value = "";
      let escaped = false;
      let dynamic = false;
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") { escaped = true; if (source[i + 1] === "\n") line++; value += source[i + 1] ?? ""; i += 2; continue; }
        if (source[i] === "$" && source[i + 1] === "{") {
          dynamic = true;
          // Fail conservatively before skipping executable template text.
          if (/\b(?:import|require)\b/.test(source.slice(i + 2, source.indexOf("`", i + 2) < 0 ? source.length : source.indexOf("`", i + 2)))) fail(line, "template interpolation containing import/require");
          const expressionStart = i;
          i += 2;
          let depth = 1;
          while (i < source.length && depth > 0) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") depth--;
            if (source[i] === "\n") line++;
            i++;
          }
          if (/\b(?:import|require)\b/.test(source.slice(expressionStart, i))) fail(startLine, "template interpolation containing import/require");
          if (depth) fail(startLine, "unterminated template interpolation");
          continue;
        }
        if (source[i] === "\n") line++;
        value += source[i]; i++;
      }
      if (i >= source.length) fail(startLine, "unterminated template");
      i++;
      tokens.push(dynamic ? { type: "dynamic-template", line: startLine } : { type: "string", value, escaped, line: startLine });
      prevIsValue = true;
      continue;
    }

    if (c === "\\") fail(line, "escaped identifier");
    // Division and a regex literal are indistinguishable here without real
    // parsing -- unlike every other fail() below, nothing about this
    // construct implies an import is present, so it gets its own message
    // instead of the generic "verify by hand that its package is declared"
    // (that phrasing is honest for e.g. an unterminated string, where
    // anything, including an import, could be hiding past the cutoff -- it's
    // false for `(a + b) / 2`, which is plain arithmetic with nothing to
    // declare).
    if (c === "/" && ["}", ")", "]"].includes(tokens.at(-1)?.value ?? "")) {
      throw new Error(`${label}:${line}: regex-vs-division ambiguity; this line cannot be tokenized statically (a division and a regex literal look identical here) -- nothing on this line implies an import, but the scan has stopped, so check the rest of this file by hand if you need to be sure`);
    }
    if (c === "/" && !prevIsValue) {
      const regexLine = line;
      const regexStart = i;
      let closed = false;
      i++;
      let inClass = false;
      while (i < source.length) {
        const rc = source[i];
        if (rc === "\\") { i += 2; continue; }
        if (rc === "[") { inClass = true; i++; continue; }
        if (rc === "]") { inClass = false; i++; continue; }
        if (rc === "/" && !inClass) { i++; closed = true; break; }
        if (rc === "\n") break;
        i++;
      }
      if (/\b(?:import|require)\b/.test(source.slice(regexStart, i))) fail(regexLine, "regex-vs-division ambiguity containing import/require");
      if (!closed) fail(regexLine, "unterminated regex or regex-vs-division ambiguity");
      while (i < source.length && /[a-zA-Z]/.test(source[i])) i++;
      prevIsValue = true;
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
      const value = source.slice(start, i);
      tokens.push({ type: "word", value, line, offset: start });
      prevIsValue = !REGEX_PRECEDING_KEYWORDS.has(value);
      continue;
    }

    if (/[0-9]/.test(c)) {
      while (i < source.length && /[0-9.]/.test(source[i])) i++;
      prevIsValue = true;
      continue;
    }

    tokens.push({ type: "punct", value: c, line });
    prevIsValue = c === ")" || c === "]";
    i++;
  }

  return tokens;
}

function bareImportsOf(source: string, label = "source"): string[] {
  const tokens = tokenize(source, label);
  const fail = (t: Token, construct: string): never => {
    throw new Error(`${label}:${t.line}: ${construct}; this construct cannot be checked statically; verify by hand that its package is declared`);
  };
  // Backstop independent of interpolation brace counting: a raw load call in
  // a file with interpolation must have survived as a code token. This may
  // flag prose; it deliberately does not try to parse nested template syntax.
  if (source.includes("${")) {
    for (const match of source.matchAll(/\b(?:import|require)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\(/g)) {
      if (!tokens.some(t => t.type === "word" && t.offset === match.index)) {
        fail({ type: "word", line: source.slice(0, match.index).split("\n").length }, "template interpolation or opaque text containing import/require");
      }
    }
  }
  const literal = (t: Token) => {
    if (t.escaped) fail(t, "escape sequence in specifier");
    return t.value ?? "";
  };
  const found: string[] = [];

  const collect = (spec: string) => {
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return;
    // "@scope/pkg/sub" and "pkg/sub" both resolve to their package root.
    const parts = spec.split("/");
    found.push(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
  };

  // Forward scan without a token cap for `from "spec"` (import/export re-exports). Bails
  // at a `;` or the next import/export so a plain declaration with no
  // re-export never picks up an unrelated later "from".
  const findFrom = (start: number): number => {
    for (let j = start; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.type === "punct" && t.value === ";") return -1;
      if (t.type === "word" && (t.value === "import" || t.value === "export")) return -1;
      if (t.type === "word" && t.value === "from" && tokens[j + 1]?.type === "string") return j + 1;
    }
    return -1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "word") continue;

    if (t.value === "import") {
      const next = tokens[i + 1];
      if (next?.type === "punct" && next.value === "(") {
        const arg = tokens[i + 2];
        if (arg?.type === "string" && tokens[i + 3]?.value === ")") { collect(literal(arg)); continue; }
        // A genuinely dynamic specifier (a variable, a template with
        // interpolation) can't be resolved by a static scanner -- silently
        // accepting it would mean silently NOT checking it, exactly the gap
        // this guard exists to close. Fail loudly instead.
        fail(t, "dynamic import() has a non-literal or composed specifier");
      }
      if (next?.type === "string") { collect(literal(next)); continue; } // side-effect import
      if (next?.value === ".") continue; // import.meta
      const fromIdx = findFrom(i + 1);
      if (fromIdx < 0) fail(t, "unrecognized static import");
      collect(literal(tokens[fromIdx]));
      continue;
    }

    if (t.value === "export") {
      const fromIdx = findFrom(i + 1);
      if (fromIdx >= 0) collect(literal(tokens[fromIdx]));
      continue;
    }

    if (t.value === "require") {
      const open = tokens[i + 1];
      const arg = tokens[i + 2];
      if (open?.type === "punct" && open.value === "(") {
        if (arg?.type !== "string" || tokens[i + 3]?.value !== ")") fail(t, "require() has a non-literal or composed specifier");
        collect(literal(arg));
      } else fail(t, "indirect require reference");
      continue;
    }
  }

  return found;
}

function sourceFilesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...sourceFilesUnder(join(dir, entry.name), exts));
      continue;
    }
    if (exts.some((e) => entry.name.endsWith(e))) out.push(join(dir, entry.name));
  }
  return out;
}

type ShippedFile = { file: string; source: string; runtimeProvided: Set<string> };

// Electron itself is the host process, not something the app bundles -- it is
// a devDependency on purpose and is always present at runtime, but only
// inside electron/, which is the process that actually has it. server/ runs
// under plain `node` (electron/main.js:108 starts it) and has no Electron
// APIs, so the same exemption there would hide a real missing dependency.
const RUNTIME_PROVIDED = new Set(["electron"]);

function undeclaredImports(files: ShippedFile[], declared: Set<string>): string[] {
  const undeclared: string[] = [];
  for (const { file, source, runtimeProvided } of files) {
    for (const pkg of bareImportsOf(source, file)) {
      if (runtimeProvided.has(pkg) || declared.has(pkg)) continue;
      undeclared.push(`${file} imports "${pkg}"`);
    }
  }
  return undeclared;
}

// package.json's build.files ships every extension under server/ and
// electron/, not just the ones this repo happens to use today, so the scan
// covers the same set. public/ is deliberately excluded: the renderer runs
// with Node integration disabled and loads plain browser scripts, not runtime
// imports -- there is nothing for either to resolve.
function realShippedFiles(serverProbe?: string): ShippedFile[] {
  const load = (dir: string, runtimeProvided: Set<string>, probe?: string): ShippedFile[] => {
    const files = sourceFilesUnder(dir, [".ts", ".js", ".mjs", ".cjs"])
      .map((file) => ({ file, source: readFileSync(join(root, file), "utf8"), runtimeProvided }));
    if (probe !== undefined) files.push({ file: join(dir, "__packaging_probe__.ts"), source: probe, runtimeProvided });
    return files;
  };
  return [...load("server", new Set(), serverProbe), ...load("electron", RUNTIME_PROVIDED)];
}

test("common static imports in shipped code are declared dependencies", () => {
  const declared = new Set(Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies));
  const files = realShippedFiles();
  assert.ok(files.length > 0, "found no shipped source files to check");
  const undeclared = undeclaredImports(files, declared);
  assert.deepEqual(
    undeclared,
    [],
    `these resolve in the repo but NOT in the packaged app (electron-builder ships only declared dependencies):\n  ${undeclared.join("\n  ")}`
  );
});

// Guard: the check above is only worth anything if removing a real
// dependency actually trips it. Drives the REAL shipped files through
// undeclaredImports -- the exact function the test above calls -- with only
// the declared set faked in memory, never a broken manifest written to disk.
test("guard: a package shipped code imports but package.json doesn't declare fails, naming the file", () => {
  const declared = new Set(
    Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies).filter((p) => p !== "zod")
  );
  const undeclared = undeclaredImports(realShippedFiles(), declared);
  assert.ok(
    undeclared.some((line) => line === `${join("server", "leader-tools.ts")} imports "zod"`),
    `removing zod from the declared set must flag server/leader-tools.ts; got ${JSON.stringify(undeclared)}`
  );
});

// Guard: the electron exemption is per-directory, not global. electron/main.js
// runs inside Electron and may import it; a server file runs under plain node
// (electron/main.js:108) and must not get the same pass.
test("guard: the real shipped-file wiring exempts electron only inside electron/", () => {
  const probeFile = join("server", "__packaging_probe__.ts");
  const files = realShippedFiles('import { app } from "electron";');
  const probe = files.find((entry) => entry.file === probeFile);
  assert.ok(probe, `realShippedFiles did not include its server probe: ${JSON.stringify(files.map(({ file }) => file))}`);
  const declared = new Set(Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies));
  const undeclared = undeclaredImports(files, declared);
  assert.ok(
    undeclared.includes(`${probeFile} imports "electron"`),
    `the server-side electron probe must survive the exemption wiring; matches: ${JSON.stringify(undeclared)}`
  );
});

test("packed smoke sees a D-drive temp path as outside a C-drive repo", () => {
  assert.equal(isOutsideRepo("C:\\repo", "D:\\temp\\cc-smoke\\app", win32), true);
  assert.equal(isOutsideRepo("C:\\repo", "C:\\repo\\app", win32), false);
  assert.equal(isOutsideRepo("C:\\repo", "C:\\repo-sibling", win32), true);
});

test("standalone packaged checks require app and exe from the same explicit build output", async () => {
  await assert.rejects(runPackagedSmoke({ root }), /supply the app path from the same electron-builder output/);

  const fixture = mkdtempSync(join(realpathSync(tmpdir()), "cc-matching-artifacts-"));
  try {
    const app = join(fixture, "win-unpacked", "resources", "app");
    const exe = join(fixture, "Command Center.exe");
    const otherExe = join(fixture, "other-output", "Command Center.exe");
    mkdirSync(app, { recursive: true });
    mkdirSync(dirname(otherExe), { recursive: true });
    writeFileSync(exe, "matching exe");
    writeFileSync(otherExe, "unmatched exe");
    assert.equal(assertMatchingBuildArtifacts(app, exe).buildOutput, realpathSync(fixture));
    assert.throws(() => assertMatchingBuildArtifacts(app, otherExe), /same electron-builder output directory/);
    assert.throws(() => assertMatchingBuildArtifacts(app, exe, path, fixture), /published dist\/ folder.*fresh electron-builder output folder/);
  } finally {
    rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// The real call path, copied into a simulated repo root, so runPackagedSmoke's
// artifact guard rejects its default <root>/dist publish folder.
test("runPackagedSmoke rejects the default <root>/dist publish folder", async () => {
  const simRoot = mkdtempSync(join(realpathSync(tmpdir()), "cc-sim-repo-"));
  try {
    mkdirSync(join(simRoot, "scripts"));
    for (const name of ["packaged-smoke.mjs", "packaged-smoke-permissions.mjs"]) {
      writeFileSync(join(simRoot, "scripts", name), readFileSync(join(root, "scripts", name)));
    }
    const app = join(simRoot, "dist", "win-unpacked", "resources", "app");
    const exe = join(simRoot, "dist", "Command Center.exe");
    mkdirSync(app, { recursive: true });
    writeFileSync(exe, "published exe");
    const sim = await import(pathToFileURL(join(simRoot, "scripts", "packaged-smoke.mjs")).href);
    await assert.rejects(sim.runPackagedSmoke({
      root: simRoot,
      source: app,
      exe,
      spawnProcess: () => { throw new Error("published dist guard did not reject before exe launch"); },
      logger: { log() {} },
      runIsolated: false,
    }), /published dist\/ folder.*fresh electron-builder output folder/);
  } finally {
    rmSync(simRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("packed smoke removes its temp workspace when copying the app fails", async () => {
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), "cc-smoke-copy-fixture-"));
  try {
    const packedApp = join(fixture, "win-unpacked", "resources", "app");
    const portableExe = join(fixture, "Command Center.exe");
    mkdirSync(packedApp, { recursive: true });
    writeFileSync(portableExe, "fixture");
    const outsideRoot = mkdtempSync(join(realpathSync(tmpdir()), "cc-smoke-copy-failure-"));
    await assert.rejects(runPackagedSmoke({
      root,
      source: packedApp,
      exe: portableExe,
      createTempDir: () => outsideRoot,
      copyTree: () => { throw new Error("simulated copy failure"); },
      logger: { log() {} },
      runIsolated: false,
    }), /simulated copy failure/);
    assert.equal(existsSync(outsideRoot), false, "failed copying must not leak the smoke temp workspace");
  } finally {
    removeWithRetry(fixture);
  }
});

// The guard above is only worth anything if it actually reads imports the way
// shipped code actually writes them. Every row here is a real shape either
// found in this codebase or that broke an earlier version of this scan.
test("the shipped-import scan really reads import statements", () => {
  assert.deepEqual(bareImportsOf('import { z } from "zod";'), ["zod"]);
  assert.deepEqual(bareImportsOf('import x from "@scope/pkg/deep/path";'), ["@scope/pkg"]);
  assert.deepEqual(bareImportsOf('export { a } from "ws";'), ["ws"]);
  assert.deepEqual(bareImportsOf('export * from "missing-pkg";'), ["missing-pkg"]);
  assert.deepEqual(bareImportsOf('const ws = require("ws");'), ["ws"]);
  assert.deepEqual(bareImportsOf('const m = await import("ws");'), ["ws"]);
  // relative, absolute and builtin specifiers are not packages
  assert.deepEqual(bareImportsOf('import a from "./x.ts";import b from "node:fs";'), []);
  // >>> THE TWO REAL COMMENT LINES THAT FOOLED THE FIRST VERSION OF THIS SCAN. <<<
  // Both are verbatim from the shipped source. A `from "..."` inside prose is
  // not an import, and reading it as one failed the build on a sentence.
  assert.deepEqual(bareImportsOf('// moved from "medium" to "low" in this same pack; an install that already'), []);
  assert.deepEqual(bareImportsOf("// asked), so it can't distinguish \"the app's own UI\" from \"the preview"), []);
  assert.deepEqual(bareImportsOf('/* a block comment that says from "nope" */'), []);
  // a URL keeps its "//" and must not be mistaken for a comment
  assert.deepEqual(bareImportsOf('const u = "https://example.com"; import a from "ws";'), ["ws"]);
  // a real comment following a URL-bearing string must not resurrect a fake
  // "package" out of its own prose
  assert.deepEqual(bareImportsOf('const url="https://example.com"; // require("not-a-package")'), []);
  // a string containing "//" must not swallow the real import that follows it
  assert.deepEqual(bareImportsOf('const s="//"; import x from "missing-pkg";'), ["missing-pkg"]);
  // a template literal's contents are never re-read as code
  assert.deepEqual(bareImportsOf('const s = `require("x")`;'), []);
  // a multi-line import
  assert.deepEqual(bareImportsOf('import {\n  a\n} from "pkg";'), ["pkg"]);
  // a side-effect import has no "from" at all
  assert.deepEqual(bareImportsOf('import "pkg";'), ["pkg"]);
  // import() with a template literal that has no interpolation
  assert.deepEqual(bareImportsOf('import(`pkg`);'), ["pkg"]);
  // an escaped quote inside a specifier must not truncate it
  assert.throws(() => bareImportsOf('import x from "some\\"thing";'), /escape sequence in specifier/);
  // and it must genuinely see the file that broke the exe
  assert.ok(bareImportsOf(readFileSync(join(root, "server/leader-tools.ts"), "utf8")).includes("zod"));
});

// Guard: a genuinely dynamic specifier can't be resolved by a static scan --
// silently finding nothing there would silently stop checking it. There are
// none in the shipped code today (the real test above proves that by not
// throwing), so this only fires the moment one is ever added.
test("a dynamic import() with a non-literal specifier cannot be checked, so it fails loudly naming the file", () => {
  assert.throws(
    () => bareImportsOf("const p = pkg;\nimport(p);", "server/fake.ts"),
    /server\/fake\.ts:2: dynamic import\(\)/
  );
  assert.throws(
    () => bareImportsOf("import(`${base}/x`);", "server/fake.ts"),
    /server\/fake\.ts:1: dynamic import\(\)/
  );
});

// Mutate disposable REAL files and launch the REAL dependency test. A helper
// result is not the guard. Each failing child is followed by a restored pass.
test("shipped dependency call site rejects round-2 constructs and undeclared real-file imports", () => {
  const dir = tempRoot(["server", "electron", "test", "scripts"]);
  const manifest = readFileSync(join(root, "package.json"), "utf8");
  writeFileSync(join(dir, "package.json"), manifest);
  const probe = join(dir, "server", "round2-import-probe.ts");
  const run = () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.CC_DATA_DIR;
    delete env.CC_TEST_FORCE_PACKAGED;
    return spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^common static imports in shipped code are declared dependencies$", "test/tooling.test.ts"], {
      cwd: dir, env, encoding: "utf8", timeout: 20000,
    });
  };
  const cases: [string, string, RegExp][] = [
    ["regex ambiguity", 'const a = {} / 2; import "missing-round2";', /regex-vs-division ambiguity/],
    ["regex quote", '/"/.test(s); import "missing-round2";', /imports "missing-round2"/],
    ["template interpolation", 'const s = `${import("missing-round2")}`;', /template interpolation containing import\/require/],
    ["nested template with quoted brace", 'const s = `${"}" + `x` + import("missing-round2")}`;', /template interpolation/],
    ["nested template with commented import", 'const s = `${"}" + `x` + import /* comment */ ("missing-round2")}`;', /template interpolation/],
    ["template require", 'const s = `${require("missing-round2")}`;', /template interpolation/],
    ["composed dynamic import", 'import("ws" + suffix);', /non-literal or composed/],
    ["long import", `import { ${Array.from({ length: 41 }, (_, i) => `a${i}`).join(", ")} } from "missing-round2";`, /imports "missing-round2"/],
    ["escaped specifier", String.raw`import "\x7aod";`, /escape sequence in specifier/],
    ["continued specifier", 'import "zo\\\nd";', /escape sequence in specifier/],
    ["unterminated string", 'const s = "oops', /unterminated string/],
    ["unterminated template", 'const s = `oops', /unterminated template/],
    ["unterminated block comment", '/* oops', /unterminated block comment/],
    ["unterminated regex", 'const r = /oops', /unterminated regex/],
    ["multiline import", 'import {\n a\n} from "missing-round2";', /imports "missing-round2"/],
    ["side-effect import", 'import "missing-round2";', /imports "missing-round2"/],
    ["server electron", 'import { app } from "electron";', /imports "electron"/],
    ["dynamic require", 'require(name);', /non-literal or composed/],
  ];
  for (const [name, source, expected] of cases) {
    writeFileSync(probe, source);
    const red = run();
    const output = red.stdout + red.stderr;
    assert.equal(red.status, 1, `${name}: real test must fail\n${output}`);
    assert.match(output, expected, name);
    assert.match(output, /round2-import-probe\.ts/, name);
    if (!expected.source.startsWith('imports')) {
      assert.match(output, /round2-import-probe\.ts:\d+:/);
      if (name === "regex ambiguity") {
        // The one fail() case with nothing on its line implying an import
        // (plain division): must NOT get the "verify ... package is
        // declared" phrasing that every real import-shaped construct below does.
        assert.match(output, /cannot be tokenized statically/, name);
        assert.doesNotMatch(output, /verify by hand that its package is declared/, name);
      } else {
        assert.match(output, /verify by hand that its package is declared/);
      }
    }
    rmSync(probe);
    const green = run();
    assert.equal(green.status, 0, `${name}: restored real test\n${green.stdout}${green.stderr}`);
    console.log(`${name}: RED exit ${red.status}, GREEN exit ${green.status}`);
  }
  const withoutZod = JSON.parse(manifest);
  delete withoutZod.dependencies.zod;
  writeFileSync(join(dir, "package.json"), JSON.stringify(withoutZod));
  const red = run();
  assert.equal(red.status, 1, red.stdout + red.stderr);
  assert.match(red.stdout + red.stderr, /leader-tools\.ts imports "zod"/);
  writeFileSync(join(dir, "package.json"), manifest);
  const green = run();
  assert.equal(green.status, 0, green.stdout + green.stderr);
  console.log(`removed zod declaration: RED exit ${red.status}, GREEN exit ${green.status}`);
});

test("no test file calls rmSync with recursive: false (it always throws on a folder and leaks it)", () => {
  const files = readdirSync(join(root, "test")).filter((name) => /\.(ts|mjs)$/.test(name));
  assert.ok(files.length > 10, "the scan found the test files");
  const bad = files.filter((name) => /rmSync\([^)]*recursive:\s*false/.test(readFileSync(join(root, "test", name), "utf8").replace(/^ *\/\/.*$/gm, "")));
  assert.deepEqual(bad, []);
});

 test("approval mutation catalogue contains all 81 registered guards", () => {
  const entries = mutations.filter(([name]) => name.startsWith("guard-approval-"));
  assert.equal(entries.length, 81);
  for (const [name, file, from] of entries) {
    if (process.env.CC_MUTATION_PROOF !== "1") assert.ok(readFileSync(join(root,file),"utf8").replaceAll("\r\n","\n").includes(from), name);
  }
});

 test("final2 mutation catalogue contains all 28 registered guards", () => {
  const entries = mutations.filter(([name]) => name.startsWith("guard-packc-final2-"));
  assert.equal(entries.length, 28);
  if (process.env.CC_MUTATION_PROOF !== "1") for (const [name, file, from] of entries) assert.equal(readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n").split(from).length - 1, 1, name + " targets exactly one guard");
});

// The approval runner is a script that runs two whole test files per entry, so it is checked at its call sites, as text.
test("the approval mutation runner strips the data-root variables, verifies its write, keeps no junction and counts only a real assertion as RED", () => {
  const source = readFileSync(join(root, "test/approval-mutation-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  assert.match(source, /const \{ CC_DATA_DIR: _ccDataDir, CC_TEST_FORCE_PACKAGED: _ccTestForcePackaged, \.\.\.childEnv \} = process\.env;/);
  assert.match(source, /env: \{ \.\.\.childEnv, TEMP: privateTmp, TMP: privateTmp, CC_MUTATION_PROOF: red \? "1" : "" \}/, "children get a private TEMP/TMP");
  assert.match(source, /if \(result\.error\) stopOwned\(\);\s+assert\.ifError\(result\.error\);/, "a timed-out run stops its own descendants before the error is raised");
  assert.match(source, /CommandLine\.Contains\('\$\{a\}'\) -or \$_\.CommandLine\.Contains\('\$\{b\}'\)/, "only processes whose command line holds this run's folders");
  assert.match(source, /removeWithRetry\(privateTmp\);/);
  assert.match(source, /writeVerified\(target, source\.replace\(from, \(\) => to\)\)/);
  assert.match(source, /assert\.ok\(isRealRed\(result\.status, result\.output\)/);
  assert.doesNotMatch(source, /symlinkSync|junction/, "the scratch copy sits inside the repo, so there is no link to remove");
  assert.match(source, /mkdtempSync\(join\(root, "\.cc-test-approval-"\)\)/);
  assert.match(source, /removeWithRetry\(scratch\);/);
});

test("the Electron process proof starts its disposable copy on the first-run seed, never on a bundled or personal projects file", () => {
  const proof = readFileSync(join(root, "scripts/electron-process-proof.mjs"), "utf8");
  // config/ is not in the copy list at all, so no bundled or personal workspace can reach the disposable copy.
  assert.match(proof, /for \(const name of \["electron", "server", "public", "package\.json"\]\) \{\s*cpSync\(join\(root, name\), join\(dir, name\), \{ recursive: true \}\);/);
  assert.doesNotMatch(proof, /writeFileSync\(join\(dir, "config\/projects\.json"\)/);
});

// Source-text guards for pack 3 review round 1 (the browser tests are too slow to run per mutation, and these fixes are about where a call sits).
test("browser tests remove their temp folder even when stopServer rejects, and the harness reply waits start from the received count", () => {
  const browser = readFileSync(join(root, "test/browser.test.ts"), "utf8").replaceAll("\r\n", "\n");
  const guarded = browser.match(/try \{ await stopServer\(child\); \}[^\n]*\n\s*finally \{ rmSync\(temp, /g) ?? [];
  assert.equal(guarded.length, 2, "both browser tests that spawn a server clean their folder in a finally that follows the stop");
  assert.equal((browser.match(/await stopServer\(child\)/g) ?? []).length, 2, "and there are no other stop calls that skip it");
  const harness = readFileSync(join(root, "test/browser-harness.js"), "utf8").replaceAll("\r\n", "\n");
  assert.doesNotMatch(harness, /window\.__received\.slice\(from\)/, "no reply wait slices what the page received with an index taken from what it sent");
  assert.equal((harness.match(/window\.__received\.slice\(receivedFrom\)\.some\(\(message\) => message\.type === "chatDone" && message\.tabId === sent\[0\]\.tabId\)/g) ?? []).length, 2, "both waits count received messages from their own start and match their own tab");
});

// scripts/live-null-check.mjs runs a copy of itself against a stand-in server/index.ts that accepts the socket and never answers: with the script's
// 10 s limit cut to 1.5 s in the copy, the limit must end the waits, so the script exits non-zero, stops the server and removes its data folder.
test("live-null-check: a server that stops answering ends the script at its time limit, with the server stopped and the data folder removed", { timeout: 60_000 }, () => {
  const dir = tempRoot();
  mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "server"));
  const original = readFileSync(join(root, "scripts/live-null-check.mjs"), "utf8");
  assert.ok(original.includes("}, 10000);"), "the script's time limit is where this test expects it");
  writeFileSync(join(dir, "scripts/live-null-check.mjs"), original.replace("}, 10000);", "}, 1500);"));
  writeFileSync(join(dir, "server/index.ts"), [
    'import http from "node:http";', 'import { writeFileSync } from "node:fs";', 'import { WebSocketServer } from "ws";',
    'const server = http.createServer((request, response) => { response.writeHead(200); response.end("Command Center"); });',
    'new WebSocketServer({ server }).on("connection", () => { /* never answers */ });',
    'server.listen(0, "127.0.0.1", () => { writeFileSync("server.pid", String(process.pid)); console.log(`Command Center running at http://127.0.0.1:${server.address().port}`); });',
    // Ends itself if the script never stopped it, so this test needs no kill by a bare pid.
    'setTimeout(() => process.exit(0), 20000);',
  ].join("\n"));
  // The script gets its own TEMP/TMP, so the only cc-live-null-* folders in it are this invocation's.
  const privateTmp = join(dir, "tmp"); mkdirSync(privateTmp);
  const folders = () => readdirSync(privateTmp).filter((name) => name.startsWith("cc-live-null-"));
  const run = spawnSync(process.execPath, ["scripts/live-null-check.mjs"], { cwd: dir, encoding: "utf8", timeout: 20_000, windowsHide: true, env: { ...process.env, TEMP: privateTmp, TMP: privateTmp } });
  const pidFile = join(dir, "server.pid");
  const serverPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const stoppedByScript = serverPid > 0 && !alive(serverPid);
  const output = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.error, undefined, `the script did not hang past 20 s: ${run.error?.message}\n${output}`);
  assert.notEqual(run.status, 0, `the script fails when the server stops answering\n${output}`);
  assert.match(output, /timed out/);
  assert.ok(serverPid > 0, "the stand-in server started");
  assert.equal(stoppedByScript, true, "the script stopped the server itself");
  assert.deepEqual(folders(), [], "the script's data folder was removed");
});

// design/simple/mutate.py counts a mutation as caught only by a finished run with a real failed check; --check-parser runs those rules with no browser.
test("design/simple/mutate.py: a run that ran out of time, a crash-only run and a wrong check count are not counted as caught", { skip: !hasDesignFolder(root) && "design/ is not part of this checkout" }, () => {
  assert.ok(COPIED_PATHS.includes("design/simple/mutate.py"), "the mutation sweep's copy holds mutate.py, so this check runs there too");
  const run = spawnSync("python", ["-I", join(root, "design/simple/mutate.py"), "--check-parser"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (run.error && (run.error as NodeJS.ErrnoException).code === "ENOENT") return; // no python on this machine: the rules cannot be run here
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /result rules OK/);
});

// The design/ paths are dropped from the sweep's copy only when the design FOLDER is absent at the repo root, never because one file in it is missing.
test("mutation-proof: design/ counts as part of the checkout exactly when the design folder exists", () => {
  const base = mkdtempSync(join(tmpdir(), "cc-design-folder-"));
  try {
    assert.equal(hasDesignFolder(base), false, "no design folder: not part of the checkout");
    mkdirSync(join(base, "design"));
    assert.equal(hasDesignFolder(base), true, "an empty design folder still counts, so a missing file inside it fails loudly");
  } finally { removeWithRetry(base); }
  assert.equal(COPIED_PATHS.includes("design/simple/mutate.py"), hasDesignFolder(root), "the copy list follows the design folder");
});

// scripts/electron-process-proof.mjs opens a real window, so it is never run here; its tracking helpers are run from the real source text.
test("electron-process-proof: a tracked process is told from one that got its pid later, children of a reused pid are not adopted, and cleanup never uses /T", () => {
  const source = readFileSync(join(root, "scripts/electron-process-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("// Tracked only while the process is in"), end = source.indexOf("function alive(");
  assert.ok(start > 0 && end > start, "the tracking helpers were found");
  const load = () => runInNewContext(`const tracked = new Map(); ${source.slice(start, end)}; ({ track, isTracked, adoptDescendants, isThisRunsWorker, tracked })`, {});
  const proc = (ProcessId: number, ParentProcessId: number, Name: string, Created: number, CommandLine: string | null = null) => ({ ProcessId, ParentProcessId, Name, Created, CommandLine });
  const list = [proc(10, 1, "electron.exe", 1000, "electron main"), proc(11, 10, "node.exe", 1100, "node server"), proc(12, 11, "cmd.exe", 1200), proc(13, 11, "node.exe", 900, "older than its parent"), proc(99, 1, "node.exe", 1000, "unrelated")];
  const api = load();
  api.track(10, "electron.exe", list);
  api.track(777, "node.exe", list); // not in the list: nothing to verify it against
  api.adoptDescendants(list);
  assert.equal(JSON.stringify([...api.tracked.keys()].sort()), JSON.stringify([10, 11, 12]), "the root and its younger descendants are tracked; a child older than its parent, an unrelated process and an unseen pid are not");
  assert.equal(api.isTracked(proc(11, 10, "node.exe", 1100, "node server")), true, "the same process");
  assert.equal(api.isTracked(proc(11, 10, "node.exe", 5000, "node server")), false, "same pid and name, another creation time: another program that got the pid");
  assert.equal(api.isTracked(proc(11, 10, "node.exe", 1100, "node another-script.js")), false, "same pid, name and time, another command line");
  assert.equal(api.isTracked(proc(11, 10, "cmd.exe", 1100, "node server")), false, "another name");
  // The root's pid now belongs to something else: its children are not this run's.
  const reused = [proc(10, 1, "electron.exe", 9000, "somebody else's"), proc(50, 10, "node.exe", 9100, "their child")];
  api.adoptDescendants(reused);
  assert.equal(api.tracked.has(50), false, "a child of a reused pid is not adopted");
  assert.doesNotMatch(source, /"\/T"/, "no process is ended together with its whole tree");
  // The worker's own report of its pid is checked against the live list before it is tracked.
  const workerPath = "C:\proof\.cc-test-electron-proof-AAA\worker.cjs";
  const chain = [proc(10, 1, "electron.exe", 1000, "electron main"), proc(11, 10, "node.exe", 1100, "node server"), proc(12, 11, "cmd.exe", 1200, "cmd /c claude.cmd"), proc(20, 12, "node.exe", 1300, `"C:\node.exe" "${workerPath}"`)];
  const claim = { pid: 20, ppid: 12 };
  assert.equal(api.isThisRunsWorker(chain, claim, workerPath, 10), true, "control: the real worker passes");
  assert.equal(api.isThisRunsWorker(chain.map((p) => p.ProcessId === 20 ? proc(20, 12, "node.exe", 1300, "node somebody-elses-script.js") : p), claim, workerPath, 10), false, "a stale pid now held by another program is not this run's worker");
  assert.equal(api.isThisRunsWorker(chain.map((p) => p.ProcessId === 20 ? proc(20, 12, "node.exe", 1300, `"C:\node.exe" "C:\proof\.cc-test-electron-proof-BBB\worker.cjs"`) : p), claim, workerPath, 10), false, "another run's worker.cjs is not this run's");
  assert.equal(api.isThisRunsWorker(chain.filter((p) => p.ProcessId !== 20), claim, workerPath, 10), false, "a pid that is no longer in the list");
  assert.equal(api.isThisRunsWorker(chain.map((p) => p.ProcessId === 11 ? proc(11, 99, "node.exe", 1100, "node server") : p), claim, workerPath, 10), false, "a parent chain that does not reach the process this run started");
  assert.equal(api.isThisRunsWorker(chain, { pid: 20, ppid: 11 }, workerPath, 10), false, "a parent other than the reported one");
  const order = [source.indexOf('assert.ok(isThisRunsWorker(before, worker, join(dir, "worker.cjs"), desktop.pid)'), source.indexOf('track(worker.pid, "node.exe", before)')];
  assert.ok(order[0] > 0 && order[1] > order[0], "the worker is verified before it is tracked");
});
