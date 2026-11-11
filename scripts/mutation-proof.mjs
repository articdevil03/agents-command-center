import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// Rows added to every sweep: a harmless edit that must SURVIVE. If one comes back RED, everything is going red for a wrong reason.
export const controlMutations = [
  ["control-must-survive", "scripts/sweep/main.mjs", "// Control row target: the sweep rewrites this comment and it must survive.", "// Control row target: rewritten by the control row, harmless."],
];

// The sweep lives in scripts/sweep/. Started with .then (not top-level await) because the sweep's modules import this one, which must have finished loading.
if (import.meta.main) {
  import("./sweep/main.mjs").then(({ main }) => main(process.argv.slice(2))).then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });
}
