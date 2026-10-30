import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mutations, isRealRed, removeWithRetry } from "../scripts/mutation-proof.mjs";

// Runs every guard-approval-* mutation against the test file that covers its target:
// server code -> approvals.test.ts, public/app/*.js -> browser-approval.test.ts. Optional argv[2] (comma-separated) keeps only names containing one of its parts.
// The scratch copy lives under the repo root (like the main sweep's), so the dependencies resolve from the repo's own node_modules by walking up:
// nothing linked to clean up. A RED is the same as the main sweep's: exit code 1 and a real AssertionError.
const root = resolve(".");
const scratch = mkdtempSync(join(root, ".cc-test-approval-"));
const reports = mkdtempSync(join(tmpdir(), "cc-approval-mutation-reports-"));
// TEMP/TMP of every test process: the servers and Chrome profiles a hung run leaves behind sit in here, so they can be told from anyone else's.
const privateTmp = mkdtempSync(join(tmpdir(), "cc-approval-mutation-tmp-"));
const testFor = (file) => file.startsWith("public/") ? "test/browser-approval.test.ts" : "test/approvals.test.ts";
const entries = mutations.filter(([name]) => name.startsWith("guard-approval-") && (!process.argv[2] || process.argv[2].split(",").some((part) => name.includes(part))));
// A run that hangs past its timeout only loses its direct child; servers and Chrome below it keep running. Stops only processes whose command line
// holds this run's own scratch copy or private temp folder (unique per run), never by name or bare pid.
const stopOwned = () => {
  const [a, b] = [scratch, privateTmp].map((path) => path.replace(/'/g, "''"));
  spawnSync("powershell.exe", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains('${a}') -or $_.CommandLine.Contains('${b}')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { windowsHide: true, timeout: 20000 });
};
// A write the next run may not see yet is read back and compared before anything is spawned against it.
const writeVerified = (path, content) => {
  const expected = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  for (let attempt = 1; attempt <= 5; attempt++) {
    writeFileSync(path, content);
    if (readFileSync(path).equals(expected)) return;
  }
  throw new Error(`${path}: content did not settle after 5 write/read-back attempts`);
};
try {
  assert.ok(entries.length > 0, "no mutation matched the filter");
  for (const name of ["server", "test", "scripts", "public", "config", "avatars", "package.json"]) if (existsSync(join(root, name))) cpSync(join(root, name), join(scratch, name), { recursive: true });
  const run = (name, testFile, red = false) => {
    // The data root and the packaged-mode switch of a developer shell must never reach the tests (the main sweep strips them too).
    const { CC_DATA_DIR: _ccDataDir, CC_TEST_FORCE_PACKAGED: _ccTestForcePackaged, ...childEnv } = process.env;
    const result = spawnSync(process.execPath, ["--test", ...(testFile === "test/browser-approval.test.ts" ? ["--test-name-pattern=approval browser guards"] : []), testFile], { cwd: scratch, windowsHide: true, timeout: 300000, encoding: "utf8", env: { ...childEnv, TEMP: privateTmp, TMP: privateTmp, CC_MUTATION_PROOF: red ? "1" : "" } });
    if (result.error) stopOwned();
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    writeFileSync(join(reports, name + ".log"), output);
    return { status: result.status, output };
  };
  for (const testFile of [...new Set(entries.map(([, file]) => testFor(file)))]) assert.equal(run("baseline-" + testFile.replace(/\W/g, "_"), testFile).status, 0, testFile + " baseline must be green");
  let red = 0, restored = 0;
  for (const [name, file, from, to] of entries) {
    const testFile = testFor(file), target = join(scratch, file), bytes = readFileSync(target);
    const source = bytes.toString("utf8").replaceAll("\r\n", "\n");
    assert.equal(source.split(from).length - 1, 1, name + " must match one call site");
    let result;
    try { writeVerified(target, source.replace(from, () => to)); result = run(name + "-red", testFile, true); }
    finally { writeVerified(target, bytes); assert.deepEqual(readFileSync(target), bytes, name + " restored byte-exactly"); }
    assert.ok(isRealRed(result.status, result.output), name + " must go RED on a real assertion, not a crash (" + testFile + ", exit " + result.status + ")\n" + result.output);
    red++;
    console.log(name + " [" + testFile + "]: " + result.output.split("\n").find((line) => line.includes("AssertionError"))?.trim().slice(0, 240));
    const green = run(name + "-restored", testFile); assert.equal(green.status, 0, green.output);
    restored++;
    console.log(name + ": restored GREEN, byte-exact");
  }
  console.log(`Mutation proof: ${red}/${entries.length} RED, ${restored}/${entries.length} restored GREEN.`);
} finally {
  // Retried and swallowed like the main sweep's cleanup, so a stuck handle never hides the real error above.
  stopOwned();
  removeWithRetry(scratch);
  removeWithRetry(reports);
  removeWithRetry(privateTmp);
}
