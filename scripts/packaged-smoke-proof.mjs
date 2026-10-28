// Scoped packaging mutation proof. Every fixture lives in an OS temp directory;
// no builder invocation or smoke run targets the repo's real dist/ folder.
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { packagedSmokePermissionArgs } from "./packaged-smoke-permissions.mjs";
import { assertMatchingBuildArtifacts, removeSmokeTemp, runIsolatedPackagedServer, runIsolatedProofs } from "./packaged-smoke.mjs";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = realpathSync(tmpdir());
const distScript = join(root, "scripts", "dist.mjs");
const tempOnly = process.argv.includes("--temp-only");
const artifactArgs = process.argv.slice(2).filter((arg) => arg !== "--temp-only");
if ((tempOnly && artifactArgs.length !== 0) || (!tempOnly && artifactArgs.length !== 2)) {
  console.error("Usage: node scripts/packaged-smoke-proof.mjs <win-unpacked/resources/app> <matching Command Center.exe> | --temp-only");
  process.exit(2);
}
const matchingArtifacts = tempOnly
  ? null
  : assertMatchingBuildArtifacts(realpathSync(artifactArgs[0]), realpathSync(artifactArgs[1]));
const packedAppSource = matchingArtifacts?.app;

function makeTemp(prefix) {
  return mkdtempSync(join(tempRoot, prefix));
}

function removeOwnedTemp(dir) {
  const resolved = realpathSync(dir);
  const rel = relative(tempRoot, resolved);
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`), `refusing cleanup outside OS temp: ${resolved}`);
  removeSmokeTemp(resolved);
  assert.equal(existsSync(resolved), false, `temp directory remains: ${resolved}`);
}

function builderSource() {
  return `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const out = process.env.CC_DIST_BUILD_OUTPUT_DIR;
const ownerStartedAt = JSON.parse(readFileSync(process.env.CC_DIST_LOCK_OVERRIDE, "utf8")).ownerStartedAt;
if (!/^\\d+$/.test(String(ownerStartedAt ?? ""))) throw new Error("dist lock omitted the numeric process start identity");
mkdirSync(out, { recursive: true });
if (process.env.CC_TEST_BUILD_HANG) { writeFileSync(process.env.CC_TEST_BUILD_HANG, String(process.pid)); await new Promise(() => setInterval(() => {}, 1000)); }
writeFileSync(join(out, "Command Center.exe"), process.env.CC_TEST_BUILD_CONTENT ?? "BROKEN");
if (process.env.CC_TEST_BUILD_MARKER) writeFileSync(process.env.CC_TEST_BUILD_MARKER, out);
process.exit(Number(process.env.CC_TEST_BUILD_EXIT ?? 0));
`;
}

function smokeSource() {
  return `import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dist = process.env.CC_DIST_DIR_OVERRIDE;
const exe = join(dist, "Command Center.exe");
const lastGood = join(dist, "Command Center.exe.last-good");
if (process.env.CC_TEST_EXPECTED_PUBLISHED === "__ABSENT__") assert.equal(existsSync(exe), false, "published exe appeared before smoke started");
else assert.equal(readFileSync(exe, "utf8"), process.env.CC_TEST_EXPECTED_PUBLISHED, "published exe changed before smoke started");
if (process.env.CC_TEST_EXPECTED_LAST_GOOD === "__ABSENT__") assert.equal(existsSync(lastGood), false, "last-good appeared before smoke started");
else assert.equal(readFileSync(lastGood, "utf8"), process.env.CC_TEST_EXPECTED_LAST_GOOD, "last-good changed before smoke started");
if (process.env.CC_TEST_SMOKE_HANG) { writeFileSync(process.env.CC_TEST_SMOKE_HANG, String(process.pid)); await new Promise(() => setInterval(() => {}, 1000)); }
process.exitCode = Number(process.env.CC_TEST_SMOKE_EXIT ?? 0);
`;
}

function makeDistEnv(distDir, builderFile, smokeFile, {
  buildContent = "GOOD BUILD v2",
  buildExit = 0,
  smokeExit = 0,
  marker,
  env = {},
} = {}) {
  return {
    ...process.env,
    CC_DIST_DIR_OVERRIDE: distDir,
    CC_DIST_LOCK_OVERRIDE: join(distDir, ".dist-build.lock"),
    CC_DIST_BUILD_OVERRIDE: `"${process.execPath}" "${builderFile}"`,
    CC_DIST_SMOKE_OVERRIDE: smokeFile,
    CC_TEST_BUILD_CONTENT: buildContent,
    CC_TEST_BUILD_EXIT: String(buildExit),
    CC_TEST_SMOKE_EXIT: String(smokeExit),
    ...(marker ? { CC_TEST_BUILD_MARKER: marker } : {}),
    ...env,
  };
}

function writeDistSimulations(distDir) {
  const builderFile = join(distDir, "builder-sim.mjs");
  const smokeFile = join(distDir, "smoke-sim.mjs");
  writeFileSync(builderFile, builderSource(), "utf8");
  writeFileSync(smokeFile, smokeSource(), "utf8");
  return { builderFile, smokeFile };
}

function runDistWrapper(distDir, { preload, ...options } = {}) {
  const { builderFile, smokeFile } = writeDistSimulations(distDir);
  const lastGood = join(distDir, "Command Center.exe.last-good");
  const exe = join(distDir, "Command Center.exe");
  const expectedLastGood = existsSync(lastGood) ? readFileSync(lastGood, "utf8") : "__ABSENT__";
  const expectedPublished = expectedLastGood !== "__ABSENT__"
    ? expectedLastGood
    : existsSync(exe) ? readFileSync(exe, "utf8") : "__ABSENT__";
  return spawnSync(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []), distScript], {
    encoding: "utf8",
    timeout: 30000,
    cwd: root,
    env: {
      ...makeDistEnv(distDir, builderFile, smokeFile, options),
      CC_TEST_EXPECTED_PUBLISHED: expectedPublished,
      CC_TEST_EXPECTED_LAST_GOOD: expectedLastGood,
    },
  });
}

function writeUnlinkFailurePreload(dir) {
  const preload = join(dir, "unlink-failure.mjs");
  writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.unlinkSync;
fs.unlinkSync = (path) => {
  if (String(path).includes(".cc-exe-displaced-")) {
    const error = new Error("simulated EPERM on displaced exe");
    error.code = "EPERM";
    throw error;
  }
  return original(path);
};
syncBuiltinESMExports();
`, "utf8");
  return preload;
}

function writeAmbiguousPidPreload(dir) {
  const preload = join(dir, "ambiguous-pid.mjs");
  writeFileSync(preload, `const original = process.kill;
process.kill = (pid, signal) => {
  if (pid === 987654321 && signal === 0) {
    const error = new Error("simulated EPERM PID check");
    error.code = "EPERM";
    throw error;
  }
  return original(pid, signal);
};
`, "utf8");
  return preload;
}

function writeOwnerIdentityPreload(dir, identity) {
  const preload = join(dir, "owner-identity.mjs");
  const targetPid = process.pid;
  const statFields = ["S", ...Array(18).fill("0"), identity].join(" ");
  const statPath = `/proc/${targetPid}/stat`;
  const statLine = `${targetPid} (node) ${statFields}\n`;
  writeFileSync(preload, `import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const targetPid = ${targetPid};
const identity = ${JSON.stringify(identity)};
const statPath = ${JSON.stringify(statPath)};
const originalRead = fs.readFileSync;
const originalSpawn = childProcess.spawnSync;
fs.readFileSync = (path, ...args) => {
  if (String(path).replaceAll(String.fromCharCode(92), "/") === statPath) return ${JSON.stringify(statLine)};
  return originalRead(path, ...args);
};
childProcess.spawnSync = (command, args, options) => {
  if (String(command).toLowerCase() === "powershell.exe") return { status: 0, stdout: identity, stderr: "", error: undefined };
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
`, "utf8");
  return preload;
}

function writePublishFailurePreload(dir, failRestore = false) {
  const preload = join(dir, "publish-failure.mjs");
  writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.renameSync;
fs.renameSync = (from, to) => {
  const source = String(from);
  const destination = String(to);
  if (source.includes(".cc-exe-publish-") && destination.endsWith("Command Center.exe")) {
    const error = new Error("simulated EPERM on publish rename"); error.code = "EPERM"; throw error;
  }
  if (${failRestore} && source.includes(".cc-exe-displaced-") && destination.endsWith("Command Center.exe")) {
    const error = new Error("simulated EPERM on rollback restore"); error.code = "EPERM"; throw error;
  }
  return original(from, to);
};
syncBuiltinESMExports();
`, "utf8");
  return preload;
}

function writeSiblingRenameFailurePreload(dir, prefix, target, rollbackPrefix = null) {
  const preload = join(dir, "sibling-rename-failure.mjs");
  writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.renameSync;
fs.renameSync = (from, to) => {
  if ((String(from).includes(${JSON.stringify(prefix)}) || (${JSON.stringify(rollbackPrefix)} && String(from).includes(${JSON.stringify(rollbackPrefix)}))) && String(to).endsWith(${JSON.stringify(target)})) {
    const error = new Error("simulated sibling rename failure"); error.code = "EPERM"; throw error;
  }
  return original(from, to);
};
syncBuiltinESMExports();
`, "utf8");
  return preload;
}

// The moment this run moves the stale lock aside, another run has already replaced it with its own live lock.
function writeLockReplacedPreload(dir) {
  const preload = join(dir, "lock-replaced.mjs");
  writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).includes(".dist-build.lock.stale-")) {
    fs.unlinkSync(from);
    fs.writeFileSync(from, JSON.stringify({ pid: 1, token: "other-run", startedAt: Date.now() }));
  }
  return original(from, to);
};
syncBuiltinESMExports();
`, "utf8");
  return preload;
}

// A read-only or locked old fingerprint: it can be neither replaced nor displaced nor deleted.
function writeLockedSidecarPreload(dir) {
  const preload = join(dir, "locked-sidecar.mjs");
  writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const locked = (path) => String(path).endsWith("Command Center.exe.sha256");
const fail = () => { const error = new Error("simulated locked sidecar"); error.code = "EPERM"; throw error; };
const rename = fs.renameSync, unlink = fs.unlinkSync;
fs.renameSync = (from, to) => (locked(from) || locked(to) ? fail() : rename(from, to));
fs.unlinkSync = (path) => (locked(path) ? fail() : unlink(path));
syncBuiltinESMExports();
`, "utf8");
  return preload;
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH" && error?.code !== "EINVAL"; }
}

function brokenArtifacts(distDir) {
  return readdirSync(distDir).filter((name) => name.startsWith("Command Center.BROKEN-"));
}

function seedVerifiedExe(distDir, value = "VERIFIED BUILD v1") {
  writeFileSync(join(distDir, "Command Center.exe"), value);
  writeFileSync(join(distDir, "Command Center.exe.last-good"), value);
}

function deadPid() {
  for (let pid = 900000; pid < 901000; pid++) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error?.code === "ESRCH" || error?.code === "EINVAL") return pid;
    }
  }
  throw new Error("could not find an unused process id for the interrupted-build fixture");
}

// 1. A builder that writes the staged exe and exits non-zero must use the
// same quarantine/restore route as a smoke failure.
{
  const dir = makeTemp("cc-dist-builder-failure-");
  try {
    seedVerifiedExe(dir);
    const run = runDistWrapper(dir, { buildContent: "BROKEN BUILDER OUTPUT", buildExit: 1 });
    assert.equal(run.status, 1, `builder failure must fail the wrapper: ${run.stderr}`);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v1");
    assert.equal(readFileSync(join(dir, "Command Center.exe.last-good"), "utf8"), "VERIFIED BUILD v1");
    const quarantined = brokenArtifacts(dir);
    assert.equal(quarantined.length, 1, `expected one quarantined exe, found ${JSON.stringify(quarantined)}; stdout=${run.stdout}; stderr=${run.stderr}`);
    assert.equal(readFileSync(join(dir, quarantined[0]), "utf8"), "BROKEN BUILDER OUTPUT");
    assert.match(run.stderr, /BUILD FAILED/);
    assert.match(run.stderr, /last verified exe remains/);
    assert.equal(existsSync(join(dir, ".dist-build.lock")), false, "failed build must release its lock");
    console.log("BUILDER FAILURE RED: exit 1, broken staged exe quarantined, verified exe and last-good preserved");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 2. A smoke failure leaves the published exe and verified backup intact.
{
  const dir = makeTemp("cc-dist-smoke-failure-");
  try {
    seedVerifiedExe(dir);
    const run = runDistWrapper(dir, { buildContent: "SMOKE-FAIL BUILD", smokeExit: 1 });
    assert.equal(run.status, 1, `smoke failure must fail the wrapper: ${run.stderr}`);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v1");
    assert.equal(readFileSync(join(dir, "Command Center.exe.last-good"), "utf8"), "VERIFIED BUILD v1");
    const quarantined = brokenArtifacts(dir);
    assert.equal(quarantined.length, 1);
    assert.equal(readFileSync(join(dir, quarantined[0]), "utf8"), "SMOKE-FAIL BUILD");
    assert.match(run.stderr, /SMOKE FAILED/);
    console.log("SMOKE FAILURE RED: exit 1, unverified exe quarantined, verified exe restored");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 3. A successful smoke promotes only the verified staged exe and backup.
{
  const dir = makeTemp("cc-dist-success-");
  try {
    seedVerifiedExe(dir);
    const run = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v2" });
    assert.equal(run.status, 0, `verified build should pass: ${run.stdout}\n${run.stderr}`);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v2");
    assert.equal(readFileSync(join(dir, "Command Center.exe.last-good"), "utf8"), "VERIFIED BUILD v2");
    assert.equal(brokenArtifacts(dir).length, 0);
    assert.equal(existsSync(join(dir, ".dist-build.lock")), false);
    assert.equal(readdirSync(dir).some((name) => name.startsWith(".cc-dist-stage-")), false, "successful stage must be removed");
    console.log("SMOKE ORDER PREVIOUS BUILD GREEN: simulated smoke required the prior exe and last-good before publication");
    const digest = createHash("sha256").update("VERIFIED BUILD v2").digest("hex");
    assert.ok(existsSync(join(dir, "Command Center.exe.sha256")), "the SHA-256 file was not written beside the published exe");
    assert.equal(readFileSync(join(dir, "Command Center.exe.sha256"), "utf8"), `${digest} *Command Center.exe\n`);
    assert.ok(run.stdout.includes(`SHA-256 ${digest}`), `the fingerprint was not printed: ${run.stdout}`);
    console.log("EXE FINGERPRINT GREEN: the published exe's SHA-256 was written beside it and printed");
    console.log("DIST SUCCESS GREEN: only the smoke-verified exe was published");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4a. An active lock prevents another wrapper from reaching its builder.
{
  const dir = makeTemp("cc-dist-overlap-");
  try {
    seedVerifiedExe(dir);
    writeFileSync(join(dir, ".dist-build.lock"), JSON.stringify({
      pid: process.pid, token: "active-proof-owner", startedAt: Date.now(), ownerStartedAt: "111111",
    }));
    const run = runDistWrapper(dir, { buildContent: "MUST NOT BUILD", preload: writeOwnerIdentityPreload(dir, "111111") });
    assert.equal(run.status, 1, `an active lock with the same live process start time must refuse takeover: ${run.stderr}`);
    assert.match(run.stderr, /another dist build is active/);
    assert.ok(run.stderr.includes(join(dir, ".dist-build.lock")), `missing lock path: ${run.stderr}`);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v1");
    console.log("DIST OVERLAP RED: active owner blocked before builder; exe unchanged");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4b. Resume from the exact on-disk state an interrupted build can leave: a
// stale lock, a recorded staging directory, an unverified exe at the target,
// and a separate verified backup. The real wrapper must recover that state.
{
  const dir = makeTemp("cc-dist-interrupted-");
  try {
    seedVerifiedExe(dir);
    const interruptedStage = mkdtempSync(join(dir, ".cc-dist-stage-interrupted-"));
    writeFileSync(join(interruptedStage, "Command Center.exe"), "INTERRUPTED UNVERIFIED");
    writeFileSync(join(dir, "Command Center.exe"), "INTERRUPTED UNVERIFIED AT PUBLISHED PATH");
    writeFileSync(join(dir, ".dist-build.lock"), JSON.stringify({
      pid: deadPid(),
      token: "interrupted-proof-owner",
      startedAt: Date.now() - 60000,
      stageDir: interruptedStage,
    }));

    const failedRetry = runDistWrapper(dir, { buildContent: "FAILED RETRY OUTPUT", buildExit: 1 });
    assert.equal(failedRetry.status, 1);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v1", "retry must restore the separate verified exe");
    assert.equal(readFileSync(join(dir, "Command Center.exe.last-good"), "utf8"), "VERIFIED BUILD v1", "retry must never copy the unverified exe over last-good");
    assert.equal(existsSync(interruptedStage), false, "retry must remove the recorded interrupted stage");

    const retry = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v2" });
    assert.equal(retry.status, 0, `retry after interruption should recover: ${retry.stdout}\n${retry.stderr}`);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v2");
    assert.equal(readFileSync(join(dir, "Command Center.exe.last-good"), "utf8"), "VERIFIED BUILD v2");
    assert.equal(existsSync(join(dir, ".dist-build.lock")), false);
    console.log("DIST INTERRUPTION GREEN: stale lock recovered; unverified exe discarded; last-good preserved before v2 publication");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4c. Windows can keep the displaced running exe mapped after publication.
// Patch only this child process's fs.unlinkSync and verify the next run sweeps it.
{
  const dir = makeTemp("cc-dist-displaced-eperm-");
  try {
    seedVerifiedExe(dir);
    const preload = writeUnlinkFailurePreload(dir);
    const first = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v2", preload });
    assert.equal(first.status, 0, `published exe must succeed despite EPERM: ${first.stdout}\n${first.stderr}`);
    assert.match(first.stderr, /simulated EPERM on displaced exe/);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v2");
    assert.equal(readdirSync(dir).filter((name) => name.startsWith(".cc-exe-displaced-")).length, 1);
    const second = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v3" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readdirSync(dir).filter((name) => name.startsWith(".cc-exe-displaced-")).length, 0);
    console.log("DISPLACED EXE EPERM GREEN: publication succeeds; next build sweeps the leftover");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4c2. If the fingerprint cannot be put in place after the exe swap, the old fingerprint must not stay beside the new exe.
{
  const dir = makeTemp("cc-dist-sidecar-failure-");
  try {
    seedVerifiedExe(dir);
    const sidecar = join(dir, "Command Center.exe.sha256");
    writeFileSync(sidecar, `${createHash("sha256").update("VERIFIED BUILD v1").digest("hex")} *Command Center.exe\n`);
    const preload = writeSiblingRenameFailurePreload(dir, ".cc-exe-publish-", ".sha256");
    const run = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v2", preload });
    assert.equal(run.status, 1, `a fingerprint failure must fail the wrapper: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /simulated sibling rename failure/);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v2");
    if (existsSync(sidecar)) {
      const exeDigest = createHash("sha256").update(readFileSync(join(dir, "Command Center.exe"))).digest("hex");
      assert.equal(readFileSync(sidecar, "utf8"), `${exeDigest} *Command Center.exe\n`, "the sidecar disagrees with the published exe");
    }
    assert.equal(readdirSync(dir).filter((name) => name.startsWith(".cc-exe-publish-")).length, 0, "the fingerprint copy must be cleaned up");
    console.log("EXE FINGERPRINT FAILURE GREEN: a failed sidecar write never leaves a hash that disagrees with the exe");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4c3. If the old fingerprint can be neither replaced nor removed, nothing is published: the old exe stays beside its own hash.
{
  const dir = makeTemp("cc-dist-sidecar-locked-");
  try {
    seedVerifiedExe(dir);
    const sidecar = join(dir, "Command Center.exe.sha256");
    const oldLine = `${createHash("sha256").update("VERIFIED BUILD v1").digest("hex")} *Command Center.exe
`;
    writeFileSync(sidecar, oldLine);
    const run = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v2", preload: writeLockedSidecarPreload(dir) });
    assert.equal(run.status, 1, `a locked old fingerprint must fail the wrapper: ${run.stdout}
${run.stderr}`);
    assert.match(run.stderr, /simulated locked sidecar/);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v1", "the new exe was published beside an old fingerprint");
    assert.equal(readFileSync(sidecar, "utf8"), oldLine, "the old fingerprint must stay beside the old exe");
    assert.equal(readdirSync(dir).filter((name) => name.startsWith(".cc-exe-publish-")).length, 0, "the publish copies must be cleaned up");
    console.log("LOCKED FINGERPRINT GREEN: nothing published while the old hash cannot be removed; old exe and hash stay together");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4c4. Every path that changes the published exe keeps the fingerprint with it: a restore from last-good (after a publish that a locked
// fingerprint blocked, or with the exe gone) never leaves the restored exe beside another exe's hash.
{
  const dir = makeTemp("cc-dist-restore-fingerprint-");
  try {
    seedVerifiedExe(dir);
    const sidecar = join(dir, "Command Center.exe.sha256");
    const line = (value) => `${createHash("sha256").update(value).digest("hex")} *Command Center.exe
`;
    const agree = (what) => {
      assert.equal(readdirSync(dir).filter((name) => name.startsWith(".cc-exe-")).length, 0, `${what}: no .cc-exe-* file may be left`);
      if (existsSync(sidecar)) assert.equal(readFileSync(sidecar, "utf8"), line(readFileSync(join(dir, "Command Center.exe"), "utf8")), `${what}: the fingerprint disagrees with the exe`);
    };
    writeFileSync(sidecar, line("VERIFIED BUILD v1"));
    // v2 verifies and becomes last-good, but the locked fingerprint blocks its publication: v1 and its own hash stay.
    const blocked = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v2", preload: writeLockedSidecarPreload(dir) });
    assert.equal(blocked.status, 1, `${blocked.stdout}
${blocked.stderr}`);
    assert.equal(readFileSync(join(dir, "Command Center.exe.last-good"), "utf8"), "VERIFIED BUILD v2");
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v1");
    // The next build restores v2 first, then fails.
    const failed = runDistWrapper(dir, { buildContent: "BROKEN BUILDER OUTPUT", buildExit: 1 });
    assert.equal(failed.status, 1, `${failed.stdout}
${failed.stderr}`);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v2");
    assert.equal(existsSync(sidecar), true, "the restore must publish the restored exe's fingerprint");
    agree("restore after a blocked publish");
    // A locked old fingerprint also stops a restore: the exe stays beside its own hash.
    writeFileSync(join(dir, "Command Center.exe"), "VERIFIED BUILD v1");
    writeFileSync(sidecar, line("VERIFIED BUILD v1"));
    const lockedRestore = runDistWrapper(dir, { buildContent: "BROKEN BUILDER OUTPUT", buildExit: 1, preload: writeLockedSidecarPreload(dir) });
    assert.equal(lockedRestore.status, 1, `${lockedRestore.stdout}
${lockedRestore.stderr}`);
    assert.match(lockedRestore.stderr, /simulated locked sidecar/);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v1", "a restore must not swap the exe while the old fingerprint cannot move");
    agree("restore with a locked fingerprint");
    // Plain restore: the exe is gone, last-good and an old fingerprint exist.
    rmSync(join(dir, "Command Center.exe"));
    writeFileSync(sidecar, line("SOME OLDER EXE"));
    const gone = runDistWrapper(dir, { buildContent: "BROKEN BUILDER OUTPUT", buildExit: 1 });
    assert.equal(gone.status, 1, `${gone.stdout}
${gone.stderr}`);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v2");
    agree("restore of a missing exe");
    console.log("RESTORE FINGERPRINT GREEN: a restored exe always sits beside its own hash; a locked old hash stops the restore");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4d. A failed publication always cleans its candidate copy, but preserves a
// rollback exe if restoring the displaced exe also fails. Old candidates are
// swept only after the lock proves no build owns them.
{
  const dir = makeTemp("cc-dist-publish-failure-");
  try {
    seedVerifiedExe(dir);
    writeFileSync(join(dir, ".cc-exe-publish-interrupted.tmp"), "partial publish copy");
    const preload = writePublishFailurePreload(dir, true);
    const run = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v2", preload });
    assert.equal(run.status, 1, `injected publication failure must fail: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /simulated EPERM on publish rename/);
    assert.match(run.stderr, /previous exe rollback was retained/);
    assert.equal(readdirSync(dir).filter((name) => name.startsWith(".cc-exe-publish-")).length, 0,
      "the in-flight publish copy and stale publish copies must be removed");
    const rollback = readdirSync(dir).filter((name) => name.startsWith(".cc-exe-displaced-"));
    assert.equal(rollback.length, 1, `failed rollback must preserve exactly one displaced exe: ${JSON.stringify(rollback)}`);
    assert.equal(readFileSync(join(dir, rollback[0]), "utf8"), "VERIFIED BUILD v1");
    assert.equal(existsSync(join(dir, "Command Center.exe")), false, "failed restoration leaves the rollback file available");
    console.log("FAILED PUBLISH CLEANUP GREEN: candidate removed, rollback retained after restore failure");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4e. Age cannot authorize takeover of a still-live owner or delete its stage.
{
  const dir = makeTemp("cc-dist-aged-live-lock-");
  try {
    seedVerifiedExe(dir);
    const stage = mkdtempSync(join(dir, ".cc-dist-stage-live-owner-"));
    writeFileSync(join(stage, "keep.txt"), "owned by live build");
    const lock = join(dir, ".dist-build.lock");
    writeFileSync(lock, JSON.stringify({
      pid: process.pid, token: "old-live-owner", startedAt: Date.now() - 3 * 60 * 60 * 1000,
      ownerStartedAt: "111111", stageDir: stage,
    }));
    const run = runDistWrapper(dir, { buildContent: "MUST NOT BUILD", preload: writeOwnerIdentityPreload(dir, "111111") });
    assert.equal(run.status, 1, `an aged lock with the same live process start time must refuse takeover: ${run.stderr}`);
    assert.match(run.stderr, /older than two hours; verifying its owner/);
    assert.match(run.stderr, /another dist build is active/);
    assert.ok(run.stderr.includes(`pid ${process.pid}`), `missing owner pid: ${run.stderr}`);
    assert.ok(run.stderr.includes(lock), `missing lock path: ${run.stderr}`);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v1");
    assert.equal(readFileSync(join(stage, "keep.txt"), "utf8"), "owned by live build", "a live owner's stage must stay untouched");
    console.log("AGED LIVE LOCK RED: age warns, matching PID and start time block takeover; stage preserved");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4f. A live PID with a different recorded process start time is a reused PID.
{
  const dir = makeTemp("cc-dist-reused-pid-lock-");
  try {
    seedVerifiedExe(dir);
    const stage = mkdtempSync(join(dir, ".cc-dist-stage-dead-owner-"));
    writeFileSync(join(stage, "remove.txt"), "orphaned stage");
    writeFileSync(join(dir, ".dist-build.lock"), JSON.stringify({
      pid: process.pid, token: "reused-owner", startedAt: Date.now() - 3 * 60 * 60 * 1000,
      ownerStartedAt: "111111", stageDir: stage,
    }));
    const run = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v2", preload: writeOwnerIdentityPreload(dir, "222222") });
    assert.equal(run.status, 0, `reused PID lock must be recoverable: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /different process start time than recorded/);
    assert.equal(existsSync(stage), false, "a stage is removed after its recorded owner is proven gone");
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v2");
    console.log("REUSED PID LOCK GREEN: different process start time permits safe takeover");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4g. An ambiguous PID check must name the lock and explain manual recovery.
{
  const dir = makeTemp("cc-dist-ambiguous-lock-");
  try {
    seedVerifiedExe(dir);
    const lock = join(dir, ".dist-build.lock");
    writeFileSync(lock, JSON.stringify({ pid: 987654321, token: "ambiguous-owner", startedAt: Date.now() }));
    const run = runDistWrapper(dir, { preload: writeAmbiguousPidPreload(dir) });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /lock may be stale \(PID check is ambiguous, pid 987654321\)/);
    assert.ok(run.stderr.includes(lock), `missing exact lock path: ${run.stderr}`);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v1");
    console.log("AMBIGUOUS LOCK RED: EPERM names the possibly stale lock without building");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4h. A live owner without a valid start identity on either side must retain its lock and stage.
for (const missing of ["record", "lookup", "malformed", "number", "array"]) {
  const dir = makeTemp(`cc-dist-missing-identity-${missing}-`);
  try {
    seedVerifiedExe(dir);
    const stage = mkdtempSync(join(dir, ".cc-dist-stage-live-owner-"));
    writeFileSync(join(stage, "keep.txt"), "owned by live build");
    const lock = join(dir, ".dist-build.lock");
    writeFileSync(lock, JSON.stringify({
      pid: process.pid, token: "live-owner", startedAt: Date.now() - 3 * 60 * 60 * 1000,
      ...(missing === "record" ? {} : {
        ownerStartedAt: missing === "malformed" ? "bad" : missing === "number" ? 1 : missing === "array" ? ["111111"] : "111111",
      }), stageDir: stage,
    }));
    const run = runDistWrapper(dir, { buildContent: "MUST NOT BUILD", preload: writeOwnerIdentityPreload(dir, missing === "lookup" ? "" : "111111") });
    assert.equal(run.status, 1, `missing ${missing} identity must refuse takeover: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /owner identity could not be verified/);
    assert.equal(existsSync(lock), true);
    assert.equal(readFileSync(join(stage, "keep.txt"), "utf8"), "owned by live build");
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v1");
    console.log(`MISSING ${missing.toUpperCase()} IDENTITY RED: live lock refused; stage preserved`);
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4i. Failed restore and last-good renames leave no candidate copies. A later
// run also sweeps candidates stranded by an interrupted process.
for (const kind of ["restore", "last-good"]) {
  const dir = makeTemp(`cc-dist-sibling-${kind}-`);
  try {
    seedVerifiedExe(dir);
    if (kind === "restore") writeFileSync(join(dir, "Command Center.exe"), "UNVERIFIED");
    const prefix = kind === "restore" ? ".cc-exe-restore-" : ".cc-last-good-next-";
    const target = kind === "restore" ? "Command Center.exe" : "Command Center.exe.last-good";
    const run = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v2", preload: writeSiblingRenameFailurePreload(dir, prefix, target) });
    assert.equal(run.status, 1, `${kind} rename failure must fail: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /simulated sibling rename failure/);
    assert.equal(readdirSync(dir).filter((name) => name.startsWith(prefix)).length, 0, `${kind} candidate must be cleaned`);
    assert.equal(readFileSync(join(dir, "Command Center.exe.last-good"), "utf8"), "VERIFIED BUILD v1");
    console.log(`${kind.toUpperCase()} CANDIDATE CLEANUP GREEN: failed rename removed temp copy and kept last-good`);
  } finally {
    removeOwnedTemp(dir);
  }
}
for (const kind of ["restore", "last-good"]) {
  const dir = makeTemp(`cc-dist-sibling-rollback-${kind}-`);
  try {
    seedVerifiedExe(dir);
    if (kind === "restore") writeFileSync(join(dir, "Command Center.exe"), "UNVERIFIED");
    const prefix = kind === "restore" ? ".cc-exe-restore-" : ".cc-last-good-next-";
    const target = kind === "restore" ? "Command Center.exe" : "Command Center.exe.last-good";
    const rollbackPrefix = kind === "restore" ? ".cc-exe-displaced-" : "Command Center.exe.last-good.old-";
    const run = runDistWrapper(dir, {
      buildContent: "VERIFIED BUILD v2",
      preload: writeSiblingRenameFailurePreload(dir, prefix, target, rollbackPrefix),
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /rollback was retained/);
    assert.equal(readdirSync(dir).filter((name) => name.startsWith(prefix)).length, 0, "candidate copy must be removed");
    const rollback = readdirSync(dir).filter((name) => name.startsWith(rollbackPrefix));
    assert.equal(rollback.length, 1, `failed ${kind} rollback must remain available`);
    assert.equal(readFileSync(join(dir, rollback[0]), "utf8"), kind === "restore" ? "UNVERIFIED" : "VERIFIED BUILD v1");
    console.log(`${kind.toUpperCase()} ROLLBACK RETAINED GREEN: candidate removed; failed restore kept rollback file`);
  } finally {
    removeOwnedTemp(dir);
  }
}
{
  const dir = makeTemp("cc-dist-sibling-sweep-");
  try {
    seedVerifiedExe(dir);
    writeFileSync(join(dir, ".cc-exe-restore-interrupted.tmp"), "stale restore");
    writeFileSync(join(dir, ".cc-last-good-next-interrupted.exe"), "stale backup candidate");
    const run = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v2" });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(readdirSync(dir).some((name) => name.startsWith(".cc-exe-restore-") || name.startsWith(".cc-last-good-next-")), false,
      "interrupted sibling copies must be swept on the next locked run");
    console.log("SIBLING CANDIDATE SWEEP GREEN: interrupted restore and last-good copies removed");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4j. The stale-lock takeover must not act before it owns the lock: when the lock it judged stale was replaced by another run's
// fresh one, it puts that lock back, deletes nothing of its own recorded stage, and does not build.
{
  const dir = makeTemp("cc-dist-lock-race-");
  try {
    seedVerifiedExe(dir);
    writeFileSync(join(dir, "Command Center.exe"), "UNVERIFIED AT PUBLISHED PATH");
    const stage = mkdtempSync(join(dir, ".cc-dist-stage-stale-owner-"));
    writeFileSync(join(stage, "keep.txt"), "must survive the lost race");
    const lock = join(dir, ".dist-build.lock");
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), token: "stale-owner", startedAt: Date.now() - 60000, stageDir: stage }));
    const run = runDistWrapper(dir, { buildContent: "MUST NOT BUILD", preload: writeLockReplacedPreload(dir) });
    assert.equal(run.status, 1, `a lost takeover race must fail: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /dist build lock changed while it was being taken over/);
    assert.match(readFileSync(lock, "utf8"), /other-run/, "the other run's lock must be put back");
    assert.equal(readFileSync(join(stage, "keep.txt"), "utf8"), "must survive the lost race", "the recorded stage must not be removed before the lock is owned");
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "UNVERIFIED AT PUBLISHED PATH", "nothing is restored before the lock is owned");
    assert.equal(readdirSync(dir).filter((name) => name.includes(".lock.stale-")).length, 0, "no moved-aside lock may remain");
    console.log("LOCK TAKEOVER RACE RED: a replaced lock is put back; stage and exe untouched; no build");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4k. A quarantined exe and a spent last-good backup are swept by the next build; last-good itself stays.
{
  const dir = makeTemp("cc-dist-leftover-sweep-");
  try {
    seedVerifiedExe(dir);
    writeFileSync(join(dir, "Command Center.BROKEN-old-run.exe"), "BROKEN FROM AN EARLIER RUN");
    writeFileSync(join(dir, "Command Center.exe.last-good.old-spent"), "SPENT BACKUP");
    const run = runDistWrapper(dir, { buildContent: "VERIFIED BUILD v2" });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.deepEqual(brokenArtifacts(dir), [], "the earlier quarantined exe must be swept");
    assert.equal(readdirSync(dir).some((name) => name.startsWith("Command Center.exe.last-good.old-")), false, "the spent last-good backup must be swept");
    assert.equal(readFileSync(join(dir, "Command Center.exe.last-good"), "utf8"), "VERIFIED BUILD v2");
    // The backup is a recovery candidate while last-good is missing: it is restored, not swept.
    rmSync(join(dir, "Command Center.exe.last-good"));
    writeFileSync(join(dir, "Command Center.exe.last-good.old-only-copy"), "ONLY COPY");
    const second = runDistWrapper(dir, { buildContent: "FAILED", buildExit: 1 });
    assert.equal(second.status, 1);
    assert.equal(readFileSync(join(dir, "Command Center.exe.last-good"), "utf8"), "ONLY COPY", "a lone backup must be recovered, not swept");
    console.log("LEFTOVER SWEEP GREEN: old quarantine and spent backup removed; a lone backup is recovered first");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4l. A hung builder or smoke is stopped (whole process tree) after the time limit, the build fails, and the lock is released.
for (const hung of ["builder", "smoke"]) {
  const dir = makeTemp(`cc-dist-hang-${hung}-`);
  try {
    seedVerifiedExe(dir);
    const pidFile = join(dir, "hung.pid");
    const run = runDistWrapper(dir, {
      buildContent: "HUNG RUN OUTPUT",
      env: { [hung === "builder" ? "CC_TEST_BUILD_HANG" : "CC_TEST_SMOKE_HANG"]: pidFile, [hung === "builder" ? "CC_DIST_BUILD_TIMEOUT_MS" : "CC_DIST_SMOKE_TIMEOUT_MS"]: "2500" },
    });
    assert.equal(run.status, 1, `a hung ${hung} must fail the wrapper: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, hung === "builder" ? /the builder timed out after 3 s/ : /the packaged smoke timed out after 3 s/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0, `the ${hung} must have started`);
    const end = Date.now() + 5000;
    while (processExists(pid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(processExists(pid), false, `the hung ${hung} process ${pid} must be gone after the wrapper returns`);
    assert.equal(readFileSync(join(dir, "Command Center.exe"), "utf8"), "VERIFIED BUILD v1");
    assert.equal(existsSync(join(dir, ".dist-build.lock")), false, "a timed-out build must release its lock");
    console.log(`HUNG ${hung.toUpperCase()} RED: stopped after the limit, process tree gone, exe preserved, lock released`);
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4m. The isolated-server run must report why readiness failed even when the server then refuses to stop.
{
  const { EventEmitter } = await import("node:events");
  const dir = makeTemp("cc-isolated-error-");
  try {
    const stuck = new EventEmitter();
    Object.assign(stuck, { pid: deadPid(), exitCode: null, signalCode: null, connected: false, stdout: new EventEmitter(), stderr: new EventEmitter() });
    let message = "";
    try {
      await runIsolatedPackagedServer({ app: dir, outsideRoot: dir, data: dir, spawnProcess: () => stuck, logger: { log() {} }, timeoutMs: 100, stopTimeoutMs: 100 });
    } catch (error) { message = error.message; }
    assert.match(message, /isolated server readiness timeout/, "the readiness failure must survive");
    assert.match(message, /did not close after shutdown and process-tree stop/, "the stop failure is reported too");
    assert.ok(message.indexOf("readiness timeout") < message.indexOf("did not close"), "the readiness failure comes first");
    console.log("ISOLATED STOP FAILURE KEEPS CAUSE GREEN: readiness error reported before the stop error");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4n. The isolated server runs twice on one fresh folder: first without the permission flags (it seeds the folder, which needs
// fsync, disabled under --permission), then with them on the seeded folder. A permission run on an empty folder goes red here.
{
  const { EventEmitter } = await import("node:events");
  const dir = makeTemp("cc-isolated-order-");
  try {
    const folder = join(dir, "isolated-data");
    const runs = [];
    const spawnProcess = (_exe, args) => {
      const permission = args.includes("--permission");
      const child = new EventEmitter();
      Object.assign(child, { pid: 0, exitCode: null, signalCode: null, connected: true, stdout: new EventEmitter(), stderr: new EventEmitter() });
      child.disconnect = () => { child.connected = false; child.exitCode = 0; child.emit("exit", 0, null); };
      const run = { permission, seededBefore: null, write: args.find((a) => a.startsWith("--allow-fs-write=")) };
      runs.push(run);
      setImmediate(() => {
        run.seededBefore = readdirSync(folder).length > 0;
        if (permission && !run.seededBefore) { child.exitCode = 1; child.emit("exit", 1, null); return; } // Node: fsync is disabled under --permission
        if (!permission) writeFileSync(join(folder, "seed.json"), "{}");
        child.stdout.emit("data", "Command Center running at http://127.0.0.1:5\n");
      });
      return child;
    };
    const lines = [];
    await runIsolatedProofs({ app: dir, outsideRoot: dir, spawnProcess, logger: { log: (line) => lines.push(line) }, timeoutMs: 1000, stopTimeoutMs: 1000 });
    assert.deepEqual(runs.map((r) => r.permission), [false, true], "first launch without the permission flags, then with them");
    assert.deepEqual(runs.map((r) => r.seededBefore), [false, true], "the permission run happens only on an already seeded folder");
    assert.equal(runs[1].write, `--allow-fs-write=${folder}`, "write containment is scoped to the same folder");
    assert.equal(lines.filter((l) => l.startsWith("PASS")).length, 2, "each run logs its own PASS line");
    console.log("ISOLATED RUN ORDER GREEN: fresh-folder launch first, permission run on the seeded folder second, two PASS lines");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 5. Keep the real isolated server proof: removing zod from a temp copy must
// fail with ERR_MODULE_NOT_FOUND, while the untouched packaged copy reaches ready.
if (!tempOnly) {
  const dir = makeTemp("cc-packaged-server-proof-");
  try {
    const app = join(dir, "app");
    const data = join(dir, "data");
    cpSync(packedAppSource, app, { recursive: true });
    mkdirSync(data);
    const zod = realpathSync(join(app, "node_modules", "zod"));
    assert.equal(relative(dir, zod), join("app", "node_modules", "zod"));
    rmSync(zod, { recursive: true });
    let missingZod;
    try {
      await runIsolatedPackagedServer({ app, outsideRoot: dir, data, logger: { log() {} } });
    } catch (error) {
      missingZod = error;
    }
    assert.ok(missingZod, "removing zod must make the real isolated server fail");
    assert.match(missingZod.message, /ERR_MODULE_NOT_FOUND/);
    assert.match(missingZod.message, /zod/);
    assert.doesNotMatch(missingZod.message, /ERR_ACCESS_DENIED/);
    console.log("MISSING ZOD RED: exit 1, ERR_MODULE_NOT_FOUND, zod");

    const greenApp = join(dir, "green-app");
    const greenData = join(dir, "green-data");
    cpSync(packedAppSource, greenApp, { recursive: true });
    mkdirSync(greenData);
    await runIsolatedPackagedServer({ app: greenApp, outsideRoot: dir, data: greenData, logger: { log() {} } });
    console.log("PACKAGED SERVER GREEN: copied app reached ready using only its own files");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 6. The actual Node permission flags used by the smoke allow writes only in
// the temporary data directory. Needs no build artifacts, so it runs in --temp-only too.
{
  const dir = makeTemp("cc-write-permission-proof-");
  try {
    const data = join(dir, "data");
    mkdirSync(data);
    const forbidden = join(dir, "should-not-write.txt");
    const bad = spawnSync(process.execPath, [
      ...packagedSmokePermissionArgs(data), "-e", 'require("node:fs").writeFileSync(process.argv[1], "nope")', forbidden,
    ], { encoding: "utf8", timeout: 10000 });
    assert.notEqual(bad.status, 0, "write outside the data dir must be denied");
    assert.match(bad.stderr, /ERR_ACCESS_DENIED/);
    assert.equal(existsSync(forbidden), false);
    console.log(`WRITE OUTSIDE DATA RED: exit ${bad.status}, ${bad.stderr.split("\n")[0]}`);

    const allowed = join(data, "ok.txt");
    const good = spawnSync(process.execPath, [
      ...packagedSmokePermissionArgs(data), "-e", 'require("node:fs").writeFileSync(process.argv[1], "ok")', allowed,
    ], { encoding: "utf8", timeout: 10000 });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(readFileSync(allowed, "utf8"), "ok");
    console.log("WRITE INSIDE DATA GREEN: exit 0");
  } finally {
    removeOwnedTemp(dir);
  }
}

console.log(tempOnly
  ? "ALL PACKAGED SMOKE GUARDS PASSED (temp-only: dist wrapper and write containment; the isolated server steps need a build)"
  : "ALL PACKAGED SMOKE GUARDS PASSED");
