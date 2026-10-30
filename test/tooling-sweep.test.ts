import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mutations, isRealRed, removeWithRetry } from "../scripts/mutation-proof.mjs";
import { tempRoot } from "./temp-root.ts";
import { spawn, spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { fakeSweep, catchesMutation, isCleanupShell, timedOutCleanup } from "./tooling-helpers.ts";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

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
