import { pack36ModeLockMutations } from "./mutations/pack36-mode-lock.mjs";
import { pack35MimoMutations } from "./mutations/pack35-mimo.mjs";
import { pack35RemoveMutations, pack35DefaultMutations } from "./mutations/pack35-remove.mjs";
import { pack34CopilotMutations } from "./mutations/pack34-copilot.mjs";
import { pack33GithubMutations } from "./mutations/pack33-github.mjs";
import { pack32KeyMutations } from "./mutations/pack32-key.mjs";
import { pack32UiMutations } from "./mutations/pack32-ui.mjs";
import { pack29OpenCodeModelsMutations } from "./mutations/pack29-opencode-models.mjs";
import { pack30OpenCodeBypassMutations } from "./mutations/pack30-opencode-bypass.mjs";
import { pack31VaultMutations } from "./mutations/pack31-vault.mjs";
import { pack30SettingsSpacingMutations } from "./mutations/pack30-settings-spacing.mjs";
import { pack29CliInstallMutations } from "./mutations/pack29-cli-install.mjs";
import { pack29OpenCodeInstallMutations } from "./mutations/pack29-opencode-install.mjs";
import { pack29OpenCodeKeyMutations } from "./mutations/pack29-opencode-key.mjs";
import { pack29OpenCodeUiMutations } from "./mutations/pack29-opencode-ui.mjs";
import { pack29CliLoginMutations } from "./mutations/pack29-cli-login.mjs";
import { pack29CliLoginUiMutations } from "./mutations/pack29-cli-login-ui.mjs";
import { pack29ScanMutations } from "./mutations/pack29-scan.mjs";
import { pack29RuntimeMutations } from "./mutations/pack29-runtime.mjs";
import { pack29InstallerMutations } from "./mutations/pack29-installer.mjs";
import { pack29FirstRunMutations } from "./mutations/pack29-first-run.mjs";
import { pack29OtherToolsMutations } from "./mutations/pack29-other-tools.mjs";
import { pack29PathRefreshMutations } from "./mutations/pack29-path-refresh.mjs";
import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
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
import { pack28ClosingNoticeMutations } from "./mutations/pack28-closing-notice.mjs";
import { pack27AdvisorMutations } from "./mutations/pack27-advisor.mjs";

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

// Only the supplied caller-owned root is removed. Links are never traversed.
function removeOwnedLink(path) {
  try { unlinkSync(path); }
  catch (error) {
    if (!["EPERM", "EISDIR"].includes(error.code) || !lstatSync(path).isSymbolicLink()) throw error;
    rmdirSync(path); // Windows directory junction, exact link object only.
  }
}

function removeOwnedEntry(entry) {
  const info = lstatSync(entry);
  if (info.isSymbolicLink()) { removeOwnedLink(entry); return; }
  if (!info.isDirectory()) { unlinkSync(entry); return; }
  let firstError;
  for (const name of readdirSync(entry)) {
    try { removeOwnedEntry(join(entry, name)); }
    catch (error) { if (error.code !== "ENOENT") firstError ??= error; }
  }
  if (firstError) throw firstError;
  const current = lstatSync(entry);
  if (current.isSymbolicLink() || !current.isDirectory()) throw new Error("temp directory changed during cleanup");
  if (readdirSync(entry).length) throw Object.assign(new Error("temp directory is not empty"), { code: "ENOTEMPTY" });
  rmdirSync(entry);
}

// Cleanup reports failure without replacing an earlier body error. Ten seconds
// of bounded retries covers slow Windows handle release; success never sleeps.
export function removeWithRetry(path, attempts = 41, delayMs = 250) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const rootInfo = lstatSync(path);
      if (rootInfo.isSymbolicLink()) throw new Error("refusing linked temp root");
      removeOwnedEntry(path);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return true;
      const retryable = ["EPERM", "EBUSY", "ENOTEMPTY"].includes(err.code);
      if (!retryable || attempt === attempts) {
        console.error(`TEMP_CLEANUP_LEFTOVER: root="${path}" error=${err.code ?? "Error"}: ${err.message} attempts=${attempt}`);
        if (Number(process.exitCode ?? 0) === 0) process.exitCode = 1;
        return false;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  return false;
}

export const mutations = [
  ...pack35MimoMutations, ...pack35RemoveMutations, ...pack35DefaultMutations,
  ...pack34CopilotMutations,
  ...pack33GithubMutations,
  ...pack31VaultMutations,
  ...pack32KeyMutations,
  ...pack32UiMutations,
  ...pack30OpenCodeBypassMutations,
  ...pack36ModeLockMutations,
  ...pack30SettingsSpacingMutations,
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
  ...pack27AdvisorMutations,
  ...pack28ClosingNoticeMutations,
  ...pack29ScanMutations,
  // Preserve runtime isolation mutations at the current launch boundaries.
  ...pack29RuntimeMutations.map((entry) => {
    const [name, file] = entry;
    if (["p29-env-worker", "p29-env-git"].includes(name)) return [name, file,
      'return stripElectronNodeEnv(disableCopilotUpdate(env, executable));',
      name === "p29-env-git" ? 'return Object.keys(extra).length ? stripElectronNodeEnv(disableCopilotUpdate(env, executable)) : disableCopilotUpdate(env, executable);' : 'return disableCopilotUpdate(env, executable);'];
    if (name === "p29-env-settings") return [name, file,
      'stripElectronNodeEnv(disableCopilotUpdate({ ...inherited, ...options.env, OPENCODE_DISABLE_AUTOUPDATE: "1", NoDefaultCurrentDirectoryInExePath: "1" }, launcher, env))',
      'disableCopilotUpdate({ ...inherited, ...options.env, OPENCODE_DISABLE_AUTOUPDATE: "1", NoDefaultCurrentDirectoryInExePath: "1" }, launcher, env)'];
    return entry;
  }),
  ...pack29InstallerMutations,
  ...pack29FirstRunMutations,
  ...pack29OtherToolsMutations,
  ...pack29PathRefreshMutations,
  ...pack29CliInstallMutations,
  ...pack29CliLoginMutations,
  ...pack29CliLoginUiMutations,
  ...pack29OpenCodeInstallMutations,
  ...pack29OpenCodeKeyMutations,
  ...pack29OpenCodeUiMutations,
  ...pack29OpenCodeModelsMutations,
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
