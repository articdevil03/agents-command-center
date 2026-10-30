import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { makeTemp, removeOwnedTemp, runDistWrapper, seedVerifiedExe } from "./fixtures.mjs";
import { writeAmbiguousPidPreload, writeOwnerIdentityPreload, writePublishFailurePreload, writeSiblingRenameFailurePreload, writeLockedSidecarPreload } from "./preloads.mjs";
import assert from "node:assert/strict";

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
