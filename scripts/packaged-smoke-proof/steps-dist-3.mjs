import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTemp, removeOwnedTemp, runDistWrapper, processExists, brokenArtifacts, seedVerifiedExe, deadPid } from "./fixtures.mjs";
import { writeOwnerIdentityPreload, writeSiblingRenameFailurePreload, writeLockReplacedPreload } from "./preloads.mjs";
import assert from "node:assert/strict";

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
