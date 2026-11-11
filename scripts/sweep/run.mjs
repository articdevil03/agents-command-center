import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import os from "node:os";
import { relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { laneEnv } from "./lanes.mjs";
import { killTracked, watchTree } from "./proctree.mjs";

// The sweep's own machinery always runs from the REAL repo: a row may mutate scripts/sweep/run.mjs inside a lane, and the sweep must keep using the real one.
const REAL_REPORTER = fileURLToPath(new URL("./reporter.mjs", import.meta.url));
const KILL_WAIT_MS = 5000;

// Below normal, not LOW: the owner's own apps must always come first, but the idle class starves under load and turns waits into fake timeouts.
export const SWEEP_PRIORITY = os.constants.priority.PRIORITY_BELOW_NORMAL;

// Every process the sweep starts afterwards inherits this on Windows.
export function lowerOwnPriority() {
  os.setPriority(process.pid, SWEEP_PRIORITY);
  return os.getPriority(process.pid);
}

const laneRelative = (lane, file) => relative(lane.dir, file).split("\\").join("/");

function testArguments(files, concurrency, logPath) {
  return ["--import", "./test/crash-catcher-self.ts", "--test", `--test-concurrency=${concurrency}`,
    `--test-reporter=${pathToFileURL(REAL_REPORTER).href}`, "--test-reporter-destination=stdout", "--test-reporter=spec", `--test-reporter-destination=${logPath}`, ...(files ?? ["test/*.test.ts"])];
}

// Reads the reporter's JSON lines as they arrive. onAssertion fires on the first failing test whose cause is a real assertion.
function collectReport(lane, onAssertion) {
  const report = { failures: [], fileMs: {}, summary: null, catching: null };
  let pending = "";
  const accept = (text) => {
    let record;
    try { record = JSON.parse(text); } catch { return; }
    if (record.type === "summary") report.summary = record;
    else if (record.type === "file") report.fileMs[laneRelative(lane, record.file)] = record.ms;
    else if (record.type === "fail") {
      const failure = { file: laneRelative(lane, record.file), name: record.name, cause: record.cause, message: record.message };
      report.failures.push(failure);
      if (failure.cause === "ERR_ASSERTION" && !report.catching) { report.catching = { file: failure.file, name: failure.name }; onAssertion(); }
    }
  };
  return { report, feed(chunk) { pending += chunk; const lines = pending.split("\n"); pending = lines.pop(); lines.forEach(accept); } };
}

function decideOutcome({ stopReason, report, exitCode, spawnFailed }) {
  if (spawnFailed) return "runner-error";
  if (stopReason === "timeout" || stopReason === "aborted") return stopReason;
  if (report.catching) return "assertion";
  if (!stopReason && !report.summary) return "runner-error";
  return exitCode === 0 && !report.failures.length ? "pass" : "failure";
}

export async function runTests({ lane, files, red, earlyStop, timeoutMs, concurrency, logPath, signal }) {
  const started = Date.now();
  const emptyResult = (outcome) => ({ outcome, exitCode: null, ms: Date.now() - started, stoppedEarly: false, failures: [], catching: null, fileMs: {}, logPath });
  if (signal?.aborted) return emptyResult("aborted");
  let stopReason = null;
  let spawnFailed = false;
  let stderr = "";
  let giveUp;
  let child;
  const { report, feed } = collectReport(lane, () => { if (earlyStop) stop("early"); });
  const closed = new Promise((resolve) => {
    child = spawn(process.execPath, testArguments(files, concurrency, logPath), { cwd: lane.dir, env: laneEnv(lane, red), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => { spawnFailed = true; resolve(null); });
    child.on("close", resolve);
  });
  let killTimer;
  let stopped = Promise.resolve();
  let killError = null;
  let unwatch = () => {};
  const gaveUp = new Promise((resolve) => { giveUp = resolve; });
  function stop(reason) {
    if (stopReason || !child.pid) return;
    stopReason = reason;
    // The child's own pid is passed as root only while it has not exited (we hold its handle, so the pid cannot be reused yet).
    const root = child.exitCode === null && child.signalCode === null ? child.pid : undefined;
    stopped = killTracked(lane.tracked, { root }).catch((err) => { killError = err; });
    // After a kill the child's pipes can stay open for a moment: wait for its close event, but only this long.
    killTimer = setTimeout(() => giveUp(null), KILL_WAIT_MS);
  }
  try {
    if (child.pid) {
      try { os.setPriority(child.pid, SWEEP_PRIORITY); } catch { /* the child already ended */ }
      unwatch = watchTree(child.pid, lane.tracked);
    }
    child.stdout.setEncoding("utf8").on("data", feed);
    child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    let exitCode;
    try { exitCode = await Promise.race([closed, gaveUp]); } finally { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", onAbort); }
    await stopped;
    if (stderr) appendFileSync(logPath, `
--- stderr ---
${stderr}`);
    return { outcome: decideOutcome({ stopReason, report, exitCode, spawnFailed }), exitCode, ms: Date.now() - started, stoppedEarly: stopReason === "early", failures: report.failures, catching: report.catching, fileMs: report.fileMs, logPath };
  } finally {
    unwatch();
    await stopped;
    // Whatever the outcome, a lane with live leftovers must not run again: if this throws, runTests throws. Nothing tracked = nothing to look for.
    if (lane.tracked.size) await killTracked(lane.tracked);
    if (killError) throw killError;
  }
}
