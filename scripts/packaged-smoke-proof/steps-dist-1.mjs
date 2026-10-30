import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { makeTemp, removeOwnedTemp, runDistWrapper, brokenArtifacts, seedVerifiedExe, deadPid } from "./fixtures.mjs";
import { writeUnlinkFailurePreload, writeOwnerIdentityPreload } from "./preloads.mjs";
import assert from "node:assert/strict";

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
