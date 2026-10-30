import { readFileSync, writeFileSync, cpSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, releaseLock } from "./lock.mjs";
import { electronMutations } from "./mutations/electron.mjs";
import { pageMutations } from "./mutations/page.mjs";
import { serverIndexMutations } from "./mutations/server-index.mjs";
import { serverLeaderMutations } from "./mutations/server-leader.mjs";
import { serverOtherMutations } from "./mutations/server-other.mjs";
import { serverSettingsMutations } from "./mutations/server-settings.mjs";
import { testsBrowserMutations } from "./mutations/tests-browser.mjs";
import { testsCliMutations } from "./mutations/tests-cli.mjs";
import { testsRound2Mutations } from "./mutations/tests-round2.mjs";
import { testsServerPacksMutations } from "./mutations/tests-server-packs.mjs";
import { testsToolingMutations } from "./mutations/tests-tooling.mjs";
import { toolingMutations } from "./mutations/tooling.mjs";

// design/ is the owner's private design workspace and is not part of a shared checkout: its paths are copied (and its catalogue entries swept)
// only when the design folder exists at the repo root. The condition is the folder, never one file inside it, so a missing file still fails loudly.
export const hasDesignFolder = (repoRoot) => existsSync(join(repoRoot, "design"));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Everything the disposable copy holds. build holds the icon source test/icon.test.ts reads; never copy design/ wholesale (large untracked art).
export const COPIED_PATHS = ["server", "public", "config", "test", "scripts", "electron", "package.json", ".gitignore", "design/simple/mutate.py", "build"]
  .filter((name) => !name.startsWith("design/") || hasDesignFolder(REPO_ROOT));

// The sweep's disposable copy lives in the repo root under this prefix (gitignored through ".cc-test-*/"); a sweep that stopped early
// keeps its run outputs under the evidence prefix. Start-up cleanup touches only the first, never another ".cc-test-*" folder.
export const MUTATION_DIR_PREFIX = ".cc-test-mutations-";
export const EVIDENCE_PREFIX = ".cc-test-evidence-";
// Each sweep's private temp folder (TEMP/TMP of every test process), in the OS temp dir: some tests insist their copies live outside the repo.
export const TEMP_DIR_PREFIX = "cc-sweep-";
// Files `node --check` can parse: a mutation must not turn one of them into a syntax error.
export const SYNTAX_CHECKED = new Set([".ts", ".js", ".mjs", ".cjs"]);

// A mutation counts as caught only by a real failed assertion: node:test exits 1 and reports "AssertionError [ERR_ASSERTION]". A syntax
// error, a failed import, a timeout (no exit code) or the sweep's own leaked-folder note is not a caught mutation.
export function isRealRed(code, output) {
  return code === 1 && /^\s*AssertionError \[ERR_ASSERTION\]/m.test(output);
}

// Windows can still hold a handle inside a mutation run's temp directory (an
// AV scan, a just-exited child whose handle hasn't released yet) even after
// every mutation this sweep ran has already verified RED/GREEN -- rmSync's
// own throw used to reach the caller uncaught at that point, so a fully
// passing sweep still crashed instead of printing its completion line, and
// the directory it choked on was left behind for the next run to trip over.
// The verification is already complete by the time this runs; a leftover
// temp directory is disk clutter, never evidence the sweep itself failed.
export function removeWithRetry(path, attempts = 5, delayMs = 300) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (attempt === attempts) {
        console.log(`WARNING: could not remove "${path}" after ${attempts} attempts (${err.message}); leaving it on disk -- the sweep's own results are unaffected.`);
        return false;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  return false;
}

export const mutations = [
  ...electronMutations,
  ...pageMutations,
  ...serverIndexMutations,
  ...serverLeaderMutations,
  ...serverOtherMutations,
  ...serverSettingsMutations,
  ...testsBrowserMutations,
  ...testsCliMutations,
  ...testsRound2Mutations,
  ...testsServerPacksMutations,
  ...testsToolingMutations,
  ...toolingMutations,
];

// Behaviour a mutation exists for but that no test at HEAD would fail on yet. Each entry is [name, file, from, to, why no test]. The sweep does not
// run them (it would report "mutation survived"); test/tooling-catalogue.test.ts still requires every target to exist once, so they cannot go stale. Move an
// entry up into `mutations` the day a test covers it.
export const pendingMutations = [
];

if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const LOCK_PATH = resolve(root, ".mutation-proof.lock");
  // argv[2]: comma-separated name parts. A part that matches no entry is a typo: running anyway would finish "0/0 RED" and delete earlier
  // evidence, so it is refused before the lock, the copy and the baseline.
  const filters = (process.argv[2] ?? "").split(",").filter(Boolean);
  const unmatchedFilters = filters.filter((part) => !mutations.some(([name]) => name.includes(part)));
  if (unmatchedFilters.length) throw new Error(`argv[2]: no catalogue entry name contains ${unmatchedFilters.join(", ")}`);
  acquireLock(LOCK_PATH);
  // The suite runs under spawnSync, so this handler only gets to run between two mutations (the loop below yields once per
  // entry). It asks the loop to stop; the finally block then restores the mutated file, keeps the evidence and releases the lock.
  let interrupted = false;
  process.on("SIGINT", () => { interrupted = true; });

  // The lock means no other sweep is alive, so every older mutations folder is the leftover of one that died before its cleanup
  // (the EPERM race removeWithRetry exists for, a crash). Only that prefix: any other ".cc-test-*" folder in the repo root belongs to
  // an `npm test` running at the same time and is never ours to delete.
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(MUTATION_DIR_PREFIX)) removeWithRetry(resolve(root, entry));
  }

  const directory = mkdtempSync(resolve(root, MUTATION_DIR_PREFIX));
  // Every test process of this sweep gets a private temp folder in the OS temp dir (TEMP/TMP below; outside the repo, as some tests require), so
  // the HTTP test server, which runs from <temp>\cc-http-test-*, carries this sweep's unique temp folder name on its command line and
  // killStrayServers can find it. A sweep that died hard left its own behind; the lock means none is alive.
  for (const entry of readdirSync(tmpdir())) {
    if (entry.startsWith(TEMP_DIR_PREFIX)) removeWithRetry(resolve(tmpdir(), entry));
  }
  const sweepTmp = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
  const previousCwd = process.cwd();
  function killStrayServers() {
    // A mutated shutdown path (e.g. guard-server-shutdown-http) can leave the real server child test/http-*.test.ts spawns running as
    // an orphan, and its open listener would poison the next run. Stops only processes whose command line holds THIS sweep's own
    // copy or temp folder (unique per run, so it can only be a child of this sweep) and never by port or by name: a dev server of the user's, or
    // another terminal's node.exe, is never touched. The shell running this filter carries the folder in its own command line, so it
    // excludes itself. Declared here (not inside try{}) so the final cleanup in finally{} can call it too.
    const [escaped, escapedTmp] = [directory, sweepTmp].map((path) => path.replace(/'/g, "''"));
    const { CC_DATA_DIR: _ccDataDir, CC_TEST_FORCE_PACKAGED: _ccTestForcePackaged, ...cleanupEnv } = process.env;
    // A failed or timed-out query or stop must not read as "nothing to stop": it throws, so the sweep ends with its evidence kept. The
    // preference makes a failed query terminate (exit 1); a process still alive 5 s after its stop exits 2.
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-Command", "$ErrorActionPreference='Stop'; " +
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains('${escaped}') -or $_.CommandLine.Contains('${escapedTmp}')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; for ($i = 0; $i -lt 50 -and (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }; if (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue) { $stuck = 1 } }; if ($stuck) { exit 2 }`],
      { encoding: "utf8", env: cleanupEnv, windowsHide: true, timeout: 20000 });
    if (cleanup.error || cleanup.status !== 0) {
      throw new Error(`killStrayServers: the process cleanup did not finish (exit ${cleanup.status}${cleanup.error ? `, ${cleanup.error.message}` : ""}); this sweep's test processes may still be running\n${cleanup.stderr ?? ""}`);
    }
  }
  let completed = false;
  let sweepError;
  try {
    // Mutate disposable copies, never the user's production files or directories.
    for (const name of COPIED_PATHS) {
      cpSync(resolve(root, name), resolve(directory, name), { recursive: true });
    }
    process.chdir(directory);
    function sweepStaleTempDirs() {
      // A run one test file leaked into (a race, a killed process) must never
      // poison the next run's baseline -- clear it before every single invocation.
      for (const entry of readdirSync(directory)) {
        if (entry.startsWith(".cc-test-")) removeWithRetry(resolve(directory, entry));
      }
    }
    function restoreTree() {
      // A mutated run's tests can write real files (config/*.json, etc), not just
      // .cc-test-* dirs. Re-copy everything from the real source so that state
      // never bleeds from one run into the next.
      for (const name of COPIED_PATHS) {
        rmSync(resolve(directory, name), { recursive: true, force: true });
        cpSync(resolve(root, name), resolve(directory, name), { recursive: true });
      }
    }
    // Sized off the baseline run's own measured duration (below), not a fixed
    // guess -- a fixed number is what rotted last time: 20s was set when the
    // suite took ~3.5s, the suite grew to 533 tests / 6.4s, and two back-to-
    // back `npm test` runs per mutation under a busy machine started tripping
    // it. Starts at a generous fixed ceiling only the baseline call uses,
    // since there's no measurement yet to size a tighter number from.
    let runTimeoutMs = 900_000;
    function run(label, red = false) {
      sweepStaleTempDirs();
      killStrayServers();
      const { CC_DATA_DIR: _ccDataDir, CC_TEST_FORCE_PACKAGED: _ccTestForcePackaged, ...childEnv } = process.env;
      const env = { ...childEnv, TEMP: sweepTmp, TMP: sweepTmp, CC_MUTATION_PROOF: red ? "1" : "" };
      // CC_MUTATION_FILES=a.test.ts,b.test.ts scopes every run to those files; unset runs the whole suite.
      const scoped = process.env.CC_MUTATION_FILES?.split(",").filter(Boolean);
      const result = scoped?.length ? spawnSync(process.execPath, ["--import", "./test/crash-catcher-self.ts", "--test", ...scoped], { encoding: "utf8", timeout: runTimeoutMs, windowsHide: true, env })
      : spawnSync("npm.cmd", ["test"], { shell: true, encoding: "utf8", timeout: runTimeoutMs, windowsHide: true, env });
      let output = result.stdout + result.stderr;
      let code = result.status;
      // If this run got cut off by the timeout above, the spawnSync kill only
      // reaches the immediate shelled cmd.exe on Windows, not node --test's
      // full descendant tree, so a test server it had spawned can still be
      // running. Sweep immediately rather than leaving that to the next run.
      killStrayServers();
      const leakedRoots = readdirSync(directory).filter((entry) => entry.startsWith(".cc-test-"));
      if (leakedRoots.length) {
        // A leak fails a green run. On a red run it adds nothing: only a real assertion failure (isRealRed) counts as caught.
        output += `\nLEAK: ${label}: .cc-test-* directories remained after the run: ${leakedRoots.join(", ")}\n`;
        if (!red) code = 1;
      }
      writeFileSync(resolve(directory, `${label}.txt`), output);
      // A runner timeout is an infrastructure failure, not a verification
      // result -- it must never be read as "mutation survived" or "suite
      // failed". Reported loudly and distinctly, before the generic error
      // check below, so it can't be conflated with either.
      if (result.error?.code === "ETIMEDOUT") {
        throw new Error(`${label}: TIMEOUT -- npm test exceeded the ${runTimeoutMs}ms runner budget (this is an infrastructure failure, not a mutation result)\n${output}`);
      }
      assert.equal(result.error, undefined, `${label}: runner error\n${output}`);
      return { code, output };
    }
    // Writes are synchronous, but this sweep has seen the immediately-following
    // spawned suite occasionally read stale content back on this filesystem --
    // so every mutate and every restore reads the file back and confirms it
    // matches before anything is spawned against it, retrying briefly rather
    // than trusting the write blind.
    function writeFileVerified(path, content) {
      const expected = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      for (let attempt = 1; attempt <= 5; attempt++) {
        writeFileSync(path, content);
        if (readFileSync(path).equals(expected)) return;
        console.log(`WARNING: ${path} did not read back as written (attempt ${attempt}/5), retrying`);
      }
      throw new Error(`${path}: content did not settle after 5 write/read-back attempts`);
    }
    // A mutation that leaves a script unparseable crashes every test file that loads it, which would look like a caught mutation. It is a
    // catalogue error instead: `node --check` the original and the mutated text and refuse a mutation that turns a parsing file into a broken one.
    function parses(file, text) {
      const path = resolve(directory, `.parse-check${extname(file)}`);
      writeFileSync(path, text);
      try { return spawnSync(process.execPath, ["--check", path], { encoding: "utf8", windowsHide: true, timeout: 30000 }).status === 0; }
      finally { removeWithRetry(path); }
    }
    const baselineStart = Date.now();
    const baseline = run("baseline");
    const baselineMs = Date.now() - baselineStart;
    assert.equal(baseline.code, 0, `baseline must be green\n${baseline.output}`);
    // Every run from here on gets 6x the measured baseline (a busy machine
    // running two `npm test` executions back to back per mutation), floored
    // at 60s so a fast suite still keeps real headroom. Re-measure (i.e. just
    // rerun the sweep) if the suite's baseline duration grows enough to matter.
    runTimeoutMs = Math.max(60_000, Math.round(baselineMs * 6));
    const results = [];
    for (const [name, file, from, to] of mutations) {
      if (filters.length && !filters.some((part) => name.includes(part))) continue; // argv[2]: comma-separated name parts
      if (file.startsWith("design/") && !hasDesignFolder(root)) continue; // not part of this checkout
      await new Promise((done) => setImmediate(done)); // lets the SIGINT handler run between mutations
      if (interrupted) throw new Error("interrupted (Ctrl-C): stopped between mutations; the mutated file is restored");
      const originalBytes = readFileSync(file);
      const original = originalBytes.toString("utf8").replaceAll("\r\n", "\n");
      const matches = from.length === 0 ? 0 : original.split(from).length - 1;
      assert.ok(matches > 0, `${name}: mutation target missing`);
      assert.equal(matches, 1, `${name}: mutation target matches ${matches} times in ${file} (expected exactly 1)`);
      // A function replacement: a string `to` would expand $&, $', $` and $$ patterns.
      const mutated = original.replace(from, () => to);
      if (SYNTAX_CHECKED.has(extname(file)) && parses(file, original) && !parses(file, mutated)) {
        throw new Error(`${name}: the mutation leaves ${file} unparseable (a catalogue error, not a caught mutation)`);
      }
      let red;
      try {
        writeFileVerified(file, mutated);
        red = run(`${name}-red`, name !== "guard-stale-entry");
      } finally {
        // A mutation to the isolation mechanism itself (temp-root.ts) can let
        // concurrent test files corrupt real files they believe are private
        // copies, so it needs a full restore. Every other mutation keeps its own
        // files isolated, so reverting just the one changed file is enough --
        // and keeps the sweep's normal per-mutation cost unchanged.
        if (file === "test/temp-root.ts") restoreTree(); else writeFileVerified(file, originalBytes);
      }
      let green = run(`${name}-restored`);
      let restoredRetried = false;
      if (green.code !== 0) {
        // Backstop only, after the real causes above (leaked test servers, an
        // unsettled write) are already handled -- a genuinely red
        // restored tree must still fail the sweep, so this re-runs the SAME
        // check once and keeps whichever result actually decides the
        // assertion below, loudly, rather than silently swallowing a retry.
        restoredRetried = true;
        console.log(`RETRY: ${name}-restored failed on its first run (exit ${green.code}); re-running once before treating it as a real regression.`);
        green = run(`${name}-restored-retry`);
        console.log(`RETRY RESULT: ${name}-restored-retry exited ${green.code}.`);
      }
      const summary = { name, red: red.code, restored: green.code, restoredRetried };
      results.push(summary);
      console.log(JSON.stringify(summary));
      console.log(red.output.split("\n").filter(line => /^\s*(?:✖|AssertionError|ℹ (?:tests|pass|fail|skipped))/.test(line)).join("\n"));
      writeFileSync(resolve(directory, "results.json"), JSON.stringify(results, null, 2) + "\n");
      assert.equal(green.code, 0, `${name}: restored suite must be green\n${green.output}`);
      assert.notEqual(red.code, 0, `${name}: mutation survived`);
      assert.ok(isRealRed(red.code, red.output), `${name}: the run failed (exit ${red.code}) but not on a test assertion; a crash, import error or timeout is not a caught mutation\n${red.output}`);
    }
    console.log(`Mutation proof complete: ${results.length}/${results.length} RED, all restored GREEN; no missing targets.`);
    completed = true;
  } catch (err) {
    sweepError = err;
    throw err;
  } finally {
    process.chdir(previousCwd);
    // A failed final cleanup means test processes may still hold the folders: the sweep counts as unfinished (evidence kept, nothing
    // earlier deleted), the lock is still released below, and the failure is thrown after that unless an earlier error is already leaving.
    let cleanupFailure;
    try { killStrayServers(); } catch (err) { cleanupFailure = err; completed = false; }
    // Retried and swallowed on failure (see removeWithRetry's own comment):
    // every mutation above has already been verified RED/GREEN by this
    // point, so a stuck Windows handle here must never crash the sweep or
    // skip releasing the lock below.
    removeWithRetry(sweepTmp);
    if (completed) {
      removeWithRetry(directory);
      for (const entry of readdirSync(root)) {
        if (entry.startsWith(EVIDENCE_PREFIX)) removeWithRetry(resolve(root, entry));
      }
    } else {
      // A sweep that stopped early keeps its evidence: every run's output and results.json. The copies of the source and config are
      // not evidence, so they go; the folder is renamed so the next sweep's start-up cleanup does not delete it.
      for (const entry of readdirSync(directory)) {
        if (!/\.txt$/.test(entry) && entry !== "results.json") removeWithRetry(resolve(directory, entry));
      }
      const kept = directory.replace(MUTATION_DIR_PREFIX, EVIDENCE_PREFIX);
      try { renameSync(directory, kept); console.log(`The sweep did not finish; its run outputs and results.json are kept in ${kept}`); }
      catch { console.log(`The sweep did not finish; its run outputs and results.json are kept in ${directory}`); }
    }
    releaseLock(LOCK_PATH);
    if (cleanupFailure) {
      if (!sweepError) throw cleanupFailure;
      console.log(`ALSO: ${cleanupFailure.message}`);
    }
  }
}
