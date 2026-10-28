// npm run dist: build into an isolated staging directory, then publish only
// after the portable exe and its packaged server both pass the smoke checks.
//
// The CC_DIST_*_OVERRIDE vars exist for packaged-smoke-proof.mjs to drive this
// against a throwaway directory instead of the real dist/ folder.
import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = resolve(process.env.CC_DIST_DIR_OVERRIDE ?? join(root, "dist"));
const buildOverride = process.env.CC_DIST_BUILD_OVERRIDE;
const smokeScript = process.env.CC_DIST_SMOKE_OVERRIDE ?? join(root, "scripts", "packaged-smoke.mjs");
const lockPath = resolve(process.env.CC_DIST_LOCK_OVERRIDE ?? join(root, ".dist-build.lock"));
const exe = join(distDir, "Command Center.exe");
const lastGood = join(distDir, "Command Center.exe.last-good");
const token = randomUUID();
const MAX_LOCK_AGE_MS = 2 * 60 * 60 * 1000;
// A hung builder or smoke must not hold the lock for ever. The overrides exist for packaged-smoke-proof.mjs.
const BUILD_TIMEOUT_MS = Number(process.env.CC_DIST_BUILD_TIMEOUT_MS) || 20 * 60 * 1000;
const SMOKE_TIMEOUT_MS = Number(process.env.CC_DIST_SMOKE_TIMEOUT_MS) || 5 * 60 * 1000;
const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");

let lockOwned = false;
let stageDir;
let exitCode = 1;

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isInside(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    return error?.code === "ESRCH" || error?.code === "EINVAL" ? "gone" : "unknown";
  }
}

function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `try { $p = [Diagnostics.Process]::GetProcessById(${pid}); [Console]::Write($p.StartTime.ToUniversalTime().Ticks) } catch { exit 1 }`,
    ], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const identity = result.stdout?.trim();
    return !result.error && result.status === 0 && /^\d+$/.test(identity ?? "") ? identity : null;
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

const ownerStartedAt = processStartIdentity(process.pid);

function removeDisplacedBestEffort(path) {
  try { unlinkSync(path); }
  catch (error) { console.warn(`Could not remove displaced exe "${path}": ${error.message}. It will be retried on the next build.`); }
}

// Runs only while this build holds the lock, after restoreFromLastGood: a `.last-good.old-*` file is a recovery candidate until last-good
// exists again, and a quarantined exe is only kept until the next build (the failed one printed its path).
function sweepPublishFiles() {
  const oldPrefix = `${basename(lastGood)}.old-`;
  for (const name of readdirSync(distDir)) {
    if (name.startsWith(".cc-exe-publish-") || name.startsWith(".cc-exe-restore-") || name.startsWith(".cc-last-good-next-") || (existsSync(exe) && name.startsWith(".cc-exe-displaced-"))
      || (name.startsWith("Command Center.BROKEN-") && name.endsWith(".exe")) || (existsSync(lastGood) && name.startsWith(oldPrefix))) {
      removeDisplacedBestEffort(join(distDir, name));
    }
  }
}

function backupRecoveryCandidates() {
  const oldPrefix = `${basename(lastGood)}.old-`;
  return readdirSync(distDir)
    .filter((name) => name.startsWith(oldPrefix))
    .map((name) => join(distDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function recoverLastGoodName() {
  if (existsSync(lastGood)) return;
  const prior = backupRecoveryCandidates()[0];
  if (prior) renameSync(prior, lastGood);
}

function restoreFromLastGood() {
  recoverLastGoodName();
  if (!existsSync(lastGood)) return false;
  if (!existsSync(exe) || fileHash(exe) !== fileHash(lastGood)) swapInVerifiedExe(lastGood, "restore");
  return true;
}

function removeRecordedStage(record) {
  if (typeof record?.stageDir !== "string") return;
  const candidate = resolve(record.stageDir);
  const rel = relative(distDir, candidate);
  if (!isInside(distDir, candidate) || rel === "" || !basename(candidate).startsWith(".cc-dist-stage-")) return;
  if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

// Returns the record of the stale lock this run took over (its leftovers are cleaned by the caller once the lock is owned), or null.
function acquireLock() {
  let takenOver = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: Date.now(), ownerStartedAt }));
      closeSync(fd);
      lockOwned = true;
      return takenOver;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (error?.code !== "EEXIST") throw error;

      const modifiedAt = statSync(lockPath).mtimeMs;
      let record;
      let rawLock;
      try { rawLock = readFileSync(lockPath, "utf8"); record = JSON.parse(rawLock); } catch {}
      const startedAt = Number.isFinite(record?.startedAt) ? record.startedAt : modifiedAt;
      const ageMs = Date.now() - startedAt;
      if (ageMs >= MAX_LOCK_AGE_MS) console.warn(`Dist build lock is older than two hours; verifying its owner before takeover: ${lockPath}`);
      if (!Number.isSafeInteger(record?.pid) || record.pid <= 0) {
        if (ageMs < 5000) throw new Error(`dist build lock is still being created; retry shortly: ${lockPath}`);
        throw new Error(`dist build lock has no verifiable owner; inspect and delete only if stale: ${lockPath}`);
      }
      const owner = processIsRunning(record.pid);
      if (owner === "unknown") {
        throw new Error(`dist build lock may be stale (PID check is ambiguous, pid ${record.pid}); inspect and delete only if stale: ${lockPath}`);
      }
      if (owner === "running") {
        const currentOwnerStartedAt = processStartIdentity(record.pid);
        // Both identities must be the digits-only form processStartIdentity
        // returns; a malformed recorded value is unverifiable, not proof of reuse.
        if (typeof record.ownerStartedAt !== "string" || !/^\d+$/.test(record.ownerStartedAt) || !/^\d+$/.test(currentOwnerStartedAt ?? "")) {
          throw new Error(`dist build lock owner identity could not be verified (pid ${record.pid}); inspect and delete only if stale: ${lockPath}`);
        }
        if (record.ownerStartedAt === currentOwnerStartedAt) {
          throw new Error(`another dist build is active (pid ${record.pid}); lock: ${lockPath}`);
        }
        console.warn(`Lock PID ${record.pid} has a different process start time than recorded; treating it as a reused PID: ${lockPath}`);
      }

      // A dead owner means the prior build was interrupted. Nothing is restored or deleted until this run owns the lock (the caller then
      // restores only the separate verified copy and never promotes the exe left in staging). The stale file is first moved aside: one
      // run wins that rename, the others find nothing to move and then meet the winner's new lock, so two runs started together after a
      // crash cannot unlink each other's fresh lock.
      if (ageMs >= MAX_LOCK_AGE_MS) console.warn(`Taking over the confirmed-stale dist build lock older than two hours: ${lockPath}`);
      const aside = `${lockPath}.stale-${token}`;
      try { renameSync(lockPath, aside); }
      catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      let moved;
      try { moved = readFileSync(aside, "utf8"); } catch {}
      if (moved !== rawLock) {
        // What was moved is not the file judged stale (its owner replaced it in between): put it back and stop.
        try { if (!existsSync(lockPath)) renameSync(aside, lockPath); else unlinkSync(aside); } catch {}
        throw new Error(`dist build lock changed while it was being taken over; retry: ${lockPath}`);
      }
      removeDisplacedBestEffort(aside);
      takenOver = record;
    }
  }
  throw new Error(`could not acquire dist build lock: ${lockPath}`);
}

// Runs a child with a time limit; on a timeout the whole process tree is ended (spawnSync's timeout ends only the direct child).
// A kill that fails, or a child that still has not closed stopWaitMs after it, is reported as such instead of waiting for ever: the build lock and
// the staging folder are held until this returns.
function runLimited(command, args, options, timeoutMs, what, stopWaitMs = 15000) {
  return new Promise((resolveRun) => {
    let timedOut = false;
    let stopWait;
    let child;
    try { child = spawn(command, args, options); }
    catch (error) { resolveRun({ status: null, error }); return; }
    const timer = setTimeout(() => {
      timedOut = true;
      let killed = false;
      if (child.pid) killed = spawnSync(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15000 }).status === 0;
      if (!killed) { try { child.kill(); } catch {} }
      stopWait = setTimeout(() => {
        resolveRun({ status: null, error: new Error(`${what} timed out after ${Math.round(timeoutMs / 1000)} s and could not be stopped (pid ${child.pid} may still be running); stop it before building again`) });
      }, stopWaitMs);
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); clearTimeout(stopWait); resolveRun({ status: null, error }); });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(stopWait);
      resolveRun(timedOut ? { status: null, error: new Error(`${what} timed out after ${Math.round(timeoutMs / 1000)} s and its process tree was stopped`) } : { status: code });
    });
  });
}

function updateLastGood(verifiedExe) {
  const next = join(distDir, `.cc-last-good-next-${token}.exe`);
  const previous = join(distDir, `${basename(lastGood)}.old-${token}`);
  const hadPrevious = existsSync(lastGood);
  try {
    copyFileSync(verifiedExe, next);
    if (fileHash(verifiedExe) !== fileHash(next)) throw new Error("last-good copy did not match the smoke-verified exe");
    if (hadPrevious) renameSync(lastGood, previous);
    renameSync(next, lastGood);
  } catch (error) {
    if (hadPrevious && existsSync(previous) && !existsSync(lastGood)) {
      try { renameSync(previous, lastGood); }
      catch (restoreError) {
        error.message = `${error.message}; previous last-good rollback was retained at "${previous}" because restore failed: ${restoreError.message}`;
      }
    }
    throw error;
  } finally {
    if (existsSync(next)) removeDisplacedBestEffort(next);
  }
  if (hadPrevious && existsSync(previous)) unlinkSync(previous);
}

// The one way the published exe changes (a publish, or a restore from last-good): the exe and its fingerprint never disagree afterwards.
// `kind` only names the temp files ("publish" or "restore"). Returns the new exe's SHA-256.
function swapInVerifiedExe(verifiedExe, kind) {
  const next = join(distDir, `.cc-exe-${kind}-${token}.tmp`);
  const previous = join(distDir, `.cc-exe-displaced-${token}.tmp`);
  const sidecar = `${exe}.sha256`;
  const nextSidecar = join(distDir, `.cc-exe-${kind}-${token}.sha256.tmp`);
  const previousSidecar = join(distDir, `.cc-exe-displaced-${token}.sha256.tmp`);
  let displaced = false;
  let sidecarDisplaced = false;
  let published = false;
  let digest;
  try {
    copyFileSync(verifiedExe, next);
    digest = fileHash(next);
    if (fileHash(verifiedExe) !== digest) throw new Error(`${kind} copy did not match the verified exe`);
    // The fingerprint of what is published, in sha256sum format, written before the swap so a failure here leaves the old exe untouched.
    writeFileSync(nextSidecar, `${digest} *Command Center.exe\n`);

    // The old fingerprint leaves BEFORE the exe swap: if it cannot move, nothing is published and the old exe stays. No sidecar beside a new exe is better than a wrong one.
    if (existsSync(sidecar)) {
      renameSync(sidecar, previousSidecar);
      sidecarDisplaced = true;
    }
    if (existsSync(exe)) {
      renameSync(exe, previous);
      displaced = true;
    }
    renameSync(next, exe);
    published = true;
    renameSync(nextSidecar, sidecar);
  } catch (error) {
    if (displaced && !existsSync(exe)) {
      try { renameSync(previous, exe); }
      catch (restoreError) {
        error.message = `${error.message}; previous exe rollback was retained at "${previous}" because restore failed: ${restoreError.message}`;
      }
    }
    // Nothing new was published, so the old exe's own fingerprint goes back beside it.
    if (!published && sidecarDisplaced && !existsSync(sidecar)) {
      try { renameSync(previousSidecar, sidecar); sidecarDisplaced = false; }
      catch (restoreError) {
        error.message = `${error.message}; previous fingerprint was retained at "${previousSidecar}" because restore failed: ${restoreError.message}`;
      }
    }
    throw error;
  } finally {
    if (published && existsSync(previousSidecar)) removeDisplacedBestEffort(previousSidecar);
    if (existsSync(next)) {
      try { unlinkSync(next); }
      catch (error) { console.error(`Could not remove unpublished exe copy "${next}": ${error.message}. It will be retried on the next build.`); }
    }
    if (existsSync(nextSidecar)) {
      try { unlinkSync(nextSidecar); }
      catch (error) { console.error(`Could not remove unpublished fingerprint copy "${nextSidecar}": ${error.message}. It will be retried on the next build.`); }
    }
  }
  if (displaced && existsSync(previous)) removeDisplacedBestEffort(previous);
  return digest;
}

function quarantineBuiltExe(stagedExe) {
  if (!existsSync(stagedExe)) return null;
  const broken = join(distDir, `Command Center.BROKEN-${token}.exe`);
  renameSync(stagedExe, broken);
  return broken;
}

function saveStageInLock() {
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, startedAt: Date.now(), ownerStartedAt, stageDir }), "utf8");
}

function releaseLock() {
  if (!lockOwned || !existsSync(lockPath)) return;
  try {
    const record = JSON.parse(readFileSync(lockPath, "utf8"));
    if (record.token === token) unlinkSync(lockPath);
  } catch {
    // A malformed lock is left for stale-lock recovery after its owner exits.
  }
}

function reportBuildFailure(kind, detail, stagedExe) {
  let quarantined;
  try { quarantined = quarantineBuiltExe(stagedExe); }
  catch (error) { console.error(`Could not quarantine the staged exe: ${error.message}`); }
  const restored = restoreFromLastGood();
  const quarantineText = quarantined ? ` The unverified exe was quarantined at "${quarantined}".` : "";
  const restoreText = restored
    ? ` The last verified exe remains at "${exe}".`
    : ` There was no last verified exe to restore; "${exe}" was left untouched.`;
  console.error(`${kind}: ${detail}.${quarantineText}${restoreText}`);
}

try {
  mkdirSync(distDir, { recursive: true });
  mkdirSync(dirname(lockPath), { recursive: true });
  const staleRecord = acquireLock();
  restoreFromLastGood();
  if (staleRecord) removeRecordedStage(staleRecord);
  sweepPublishFiles();

  stageDir = mkdtempSync(join(distDir, ".cc-dist-stage-"));
  saveStageInLock();
  const stagedExe = join(stageDir, "Command Center.exe");
  const stagedApp = join(stageDir, "win-unpacked", "resources", "app");
  // The real builder gets plain arguments (no shell), so a `%` or quote in the repo path is never expanded by cmd.exe. Only the test
  // override is a shell command line.
  const buildEnv = { ...process.env, CC_DIST_BUILD_OUTPUT_DIR: stageDir };
  const build = buildOverride
    ? await runLimited(buildOverride, [], { stdio: "inherit", shell: true, cwd: root, env: buildEnv }, BUILD_TIMEOUT_MS, "the builder")
    : await runLimited(process.execPath, [join(root, "node_modules", "electron-builder", "cli.js"), `--config.directories.output=${stageDir}`],
      { stdio: "inherit", cwd: root, env: buildEnv }, BUILD_TIMEOUT_MS, "electron-builder");

  if (build.status !== 0) {
    reportBuildFailure("BUILD FAILED", build.error?.message ?? `electron-builder exited ${build.status ?? "without a code"}`, stagedExe);
  } else if (!existsSync(stagedExe)) {
    reportBuildFailure("BUILD FAILED", "electron-builder exited successfully without producing Command Center.exe", stagedExe);
  } else {
    const smoke = await runLimited(process.execPath, [smokeScript, stagedApp, stagedExe], { stdio: "inherit", cwd: root, env: process.env }, SMOKE_TIMEOUT_MS, "the packaged smoke");
    if (smoke.status !== 0) {
      reportBuildFailure("SMOKE FAILED", smoke.error?.message ?? `packaged smoke exited ${smoke.status ?? "without a code"}`, stagedExe);
    } else {
      updateLastGood(stagedExe);
      console.log(`dist: SHA-256 ${swapInVerifiedExe(stagedExe, "publish")}`);
      exitCode = 0;
      console.log(`dist: build verified; the exe and its packaged server passed smoke checks before publication at "${exe}".`);
    }
  }
} catch (error) {
  console.error(`dist failed: ${error.message}`);
  exitCode = 1;
} finally {
  if (stageDir && existsSync(stageDir)) {
    try { rmSync(stageDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { console.error(`Could not remove this run's staging directory "${stageDir}": ${error.message}`); }
  }
  releaseLock();
}

process.exitCode = exitCode;
