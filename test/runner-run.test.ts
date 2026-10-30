import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { setEnv } from "./temp-root.ts";
import * as usage from "../server/usage.ts";
import { config, runner, history, FakeProc, makeRun, captureCallbacks, spawnReturning, runArtifact, startRunnerRun } from "./runner-helpers.ts";

test("buildCommand maps explicit slot canWrite to Claude, Codex, and OpenCode flags", () => {
  const brief = "C:/logs/work-tab.reviewer1-100.brief.txt";
  const claudeRead = runner.buildCommand(makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", effort: "medium", canWrite: false }), brief);
  const claudeWrite = runner.buildCommand(makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", effort: "medium", canWrite: true }), brief);
  const codexRead = runner.buildCommand(makeRun({ canWrite: false }), brief);
  const codexWrite = runner.buildCommand(makeRun({ canWrite: true }), brief);
  const openRead = runner.buildCommand(makeRun({ cli: "opencode", model: "opencode/x-preview-f-free", effort: "max", canWrite: false }), brief);
  const openWrite = runner.buildCommand(makeRun({ cli: "opencode", model: "opencode/x-preview-f-free", effort: "max", canWrite: true }), brief);
  assert.match(claudeRead, /--permission-mode plan .*--disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit/);
  assert.match(claudeWrite, /--permission-mode acceptEdits/);
  assert.doesNotMatch(claudeWrite, /--disallowedTools/);
  assert.match(codexRead, /--sandbox read-only/);
  assert.match(codexWrite, /--sandbox workspace-write/);
  assert.match(openRead, /--dir "%CC_RUN_DIR%"/);
  assert.match(openWrite, /--dir "%CC_RUN_DIR%"/);
  assert.equal(runner.commandEnv(makeRun({ cli: "opencode" }), brief).CC_RUN_DIR, "C:/work/project", "the folder itself travels in the environment");
  assert.match(codexRead, /^codex exec --skip-git-repo-check /, "a tab folder that is not a git repo must not stop Codex at once");
});

test("buildCommand refuses unsafe model, effort, quote or control characters in paths, seat key, and run id before shell spawn", () => {
  const brief = "C:/logs/run-1.brief.txt";
  assert.throws(() => runner.buildCommand(makeRun({ model: "gpt-6-sol & calc" }), brief), /invalid model/);
  assert.throws(() => runner.buildCommand(makeRun({ effort: "high & calc" }), brief), /invalid effort/);
  assert.throws(() => runner.buildCommand(makeRun({ folder: 'C:/work/"bad' }), brief), /unsafe folder/);
  assert.throws(() => runner.buildCommand(makeRun({ folder: "C:/work/line" + String.fromCharCode(10) + "break" }), brief), /unsafe folder/);
  assert.throws(() => runner.buildCommand(makeRun(), 'C:/logs/run-"x".brief.txt'), /unsafe brief path/);
  assert.throws(() => runner.buildCommand(makeRun(), "C:/logs/run-" + String.fromCharCode(7) + ".brief.txt"), /unsafe brief path/);
  assert.throws(() => runner.buildCommand(makeRun({ seatKey: "../escape" }), brief), /unsafe seat key/);
  assert.throws(() => runner.buildCommand(makeRun({ runId: "bad;cmd" }), brief), /unsafe run id/);
});

test("buildCommand accepts a folder and brief path holding ( ) & % ^ and keeps them out of the command line", () => {
  const folder = "C:/Projects/App (v2) & Co %x% ^caret", brief = "C:/Shared/example & Co (2)/logs/run-1.brief.txt";
  for (const cli of ["claude", "codex", "opencode"] as const) {
    const run = makeRun({ cli, model: cli === "claude" ? "claude-opus-5-5[1m]" : cli === "codex" ? "gpt-6-sol" : "provider/model-v1", effort: cli === "opencode" ? "max" : "high", folder });
    const command = runner.buildCommand(run, brief);
    assert.doesNotMatch(command, /App|R&D|caret/, `${cli}: the paths travel in the environment, not the command`);
    const env = runner.commandEnv(run, brief);
    assert.equal(env.CC_BRIEF_PATH, brief);
    if (cli === "opencode") assert.equal(env.CC_RUN_DIR, folder);
  }
});

test("hostile prompt stays in the brief file and never reaches the shell command", () => {
  const proc = new FakeProc();
  const captured: unknown[][] = [];
  const safe = captureCallbacks();
  const prompt = 'hello" & whoami & echo "owned';
  const result = runner.runSeat(makeRun(), prompt, safe.callbacks, spawnReturning(proc, captured));
  assert.equal(result.ok, true);
  const command = captured[0][0] as string;
  assert.doesNotMatch(command, /whoami|owned/);
  assert.match((captured[0][1] as any).env.CC_BRIEF_PATH, /\.brief\.txt$/, "the brief path travels in the environment");
  const brief = readdirSync(runner.logsDir).find((name) => name.endsWith(".brief.txt"));
  assert.ok(brief);
  assert.equal(readFileSync(`${runner.logsDir}/${brief}`, "utf8"), prompt);
  proc.emit("close", 0);
});

test("run records immutable start settings and logs tab-scoped seat keys", () => {
  const first = new FakeProc(), second = new FakeProc();
  const one = captureCallbacks(), two = captureCallbacks();
  const snapshot = makeRun({ runId: "run-snapshot" });
  const seenSettings: Array<{ model: string; folder: string }> = [];
  const callbacks = { ...one.callbacks, onStatus: (run: runner.RunnerRun, status: "working" | "done" | "failed" | "stopped", code?: number) => {
    seenSettings.push({ model: run.model, folder: run.folder });
    one.callbacks.onStatus(run, status, code);
  } };
  runner.runSeat(snapshot, "first", callbacks, spawnReturning(first));
  snapshot.model = "gpt-6-astra";
  snapshot.folder = "C:/changed";
  runner.runSeat(makeRun({ runId: "run-snapshot-2" }), "second", two.callbacks, spawnReturning(second));
  assert.equal(runner.isRunning("run-snapshot"), true);
  assert.equal(runner.isRunning("run-snapshot-2"), true);
  assert.equal(runner.runIdsForSeat("work-tab.reviewer1").length, 2);
  first.emit("close", 0); second.emit("close", 0);
  assert.deepEqual(seenSettings, [{ model: "gpt-6-sol", folder: "C:/work/project" }, { model: "gpt-6-sol", folder: "C:/work/project" }]);
  assert.equal(runner.runIdsForSeat("work-tab.reviewer1").length, 0);
});

test("two runs may execute for one seat and output/status stay keyed by run id", () => {
  const a = new FakeProc(1), b = new FakeProc(2);
  const ca = captureCallbacks(), cb = captureCallbacks();
  assert.equal(runner.runSeat(makeRun({ runId: "same-seat-a" }), "a", ca.callbacks, spawnReturning(a)).ok, true);
  assert.equal(runner.runSeat(makeRun({ runId: "same-seat-b" }), "b", cb.callbacks, spawnReturning(b)).ok, true);
  a.stdout.emit("data", Buffer.from("only A"));
  b.stdout.emit("data", Buffer.from("only B"));
  a.emit("close", 0); b.emit("close", 7);
  assert.deepEqual(ca.outputs.map((x) => x.text), ["only A"]);
  assert.deepEqual(cb.outputs.map((x) => x.text), ["only B"]);
  assert.deepEqual(ca.statuses.map((x) => x.status), ["working", "done"]);
  assert.deepEqual(cb.statuses.map((x) => x.status), ["working", "failed"]);
});

test("each start gets a unique run id file pair, and parser keeps the tab key before the last timestamp", () => {
  const procA = new FakeProc(), procB = new FakeProc();
  runner.runSeat(makeRun({ runId: "file-a" }), "a", captureCallbacks().callbacks, spawnReturning(procA));
  runner.runSeat(makeRun({ runId: "file-b" }), "b", captureCallbacks().callbacks, spawnReturning(procB));
  const logs = readdirSync(runner.logsDir).filter((name) => /^work-tab\.reviewer1-\d+\.log$/.test(name));
  assert.equal(logs.length >= 2, true);
  const parsed = history.parseLogFilename(logs[0]);
  assert.equal(parsed?.seatId, "work-tab.reviewer1");
  assert.equal(typeof parsed?.timestamp, "number");
  procA.emit("close", 0); procB.emit("close", 0);
});

test("spawn strips private data-root variables and read-only OpenCode deny config is applied at the call", () => {
  // Restored (not deleted) afterwards, even when an assertion below throws.
  const restore = setEnv({ CC_DATA_DIR: "C:/private/data", CC_TEST_FORCE_PACKAGED: "1", CC_APP_KEY: "test-app-key-must-not-leak" });
  const proc = new FakeProc();
  try {
    let spawnOptions: any;
    const fake = ((command: string, options: unknown) => { spawnOptions = options; return proc; }) as unknown as typeof import("node:child_process").spawn;
    const run = makeRun({ cli: "opencode", model: "opencode/x-preview-f-free", effort: "max", canWrite: false });
    runner.runSeat(run, "read this", captureCallbacks().callbacks, fake);
    assert.equal(Object.hasOwn(spawnOptions.env, "CC_DATA_DIR"), false);
    assert.equal(Object.hasOwn(spawnOptions.env, "CC_TEST_FORCE_PACKAGED"), false);
    assert.equal(Object.hasOwn(spawnOptions.env, "CC_APP_KEY"), false, "a spawned CLI never sees the app key");
    assert.match(spawnOptions.env.OPENCODE_CONFIG_CONTENT, /"edit":"deny"/);
    assert.match(spawnOptions.env.OPENCODE_CONFIG_CONTENT, /"bash":"deny"/);
  } finally { proc.emit("close", 0); restore(); }
});

test("writability: every CLI counts as able to write, Codex read-only included (no read-only mode is a safe boundary)", () => {
  assert.equal(runner.canRunWrite(makeRun({ cli: "codex", canWrite: false })), true, "no CLI read-only mode is a safe boundary (a codex read-only probe wrote a file), so a stall is never auto-relaunched");
  assert.equal(runner.canRunWrite(makeRun({ cli: "codex", canWrite: true })), true);
  assert.equal(runner.canRunWrite(makeRun({ cli: "claude", canWrite: false })), true);
  assert.equal(runner.canRunWrite(makeRun({ cli: "opencode", canWrite: false })), true);
});

test("stderr and split UTF-8 output are decoded; close flushes the partial tail exactly once", () => {
  const proc = new FakeProc(), capture = captureCallbacks();
  runner.runSeat(makeRun({ runId: "utf8-run" }), "prompt", capture.callbacks, spawnReturning(proc));
  proc.stdout.emit("data", Buffer.from([0xf0, 0x9f]));
  proc.stdout.emit("data", Buffer.from([0x8c, 0x9f]));
  proc.stderr.emit("data", Buffer.from("stderr-tail"));
  proc.emit("close", 0);
  proc.emit("close", 0);
  assert.equal(capture.outputs.map((entry) => entry.text).join(""), "🌟stderr-tail");
  assert.deepEqual(capture.statuses.map((entry) => entry.status), ["working", "done"]);
});

test("a stream that ends on an unfinished multi-byte character still flushes the held tail at close (stdout and stderr)", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const proc = new FakeProc(), capture = captureCallbacks(), run = makeRun({ runId: `utf8-tail-${stream}` });
    const timestamp = startRunnerRun(run, "prompt", capture.callbacks, spawnReturning(proc));
    proc[stream].emit("data", Buffer.from([0xf0, 0x9f]));
    assert.equal(capture.outputs.length, 0, `${stream}: nothing is decodable before close`);
    proc.emit("close", 0);
    assert.equal(capture.outputs.map((entry) => entry.text).join(""), "\ufffd", `${stream}: the held tail is flushed at close`);
    // This run's own log, not any log in the folder: the other stream's iteration wrote one too.
    assert.ok(readFileSync(runArtifact(run, timestamp, "log"), "utf8").includes("\ufffd"), `${stream}: the held tail also reaches this run's log`);
  }
});

test("killRun refuses a run whose process has no pid yet and sends no taskkill", () => {
  const proc = new FakeProc(), capture = captureCallbacks();
  runner.runSeat(makeRun({ runId: "no-pid-run" }), "prompt", capture.callbacks, spawnReturning(proc));
  proc.pid = undefined as unknown as number;
  const calls: unknown[][] = [];
  const dispatch = ((...args: unknown[]) => { calls.push(args); return new FakeProc(); }) as unknown as typeof import("node:child_process").spawn;
  assert.equal(runner.killRun("no-pid-run", dispatch), false);
  assert.equal(calls.length, 0);
  proc.emit("close", 0);
});

test("the real runner call site renders Claude stream JSON and reports model-scoped usage", () => {
  const proc = new FakeProc(), capture = captureCallbacks();
  const usageEvents: Array<{ runId: string; delta: usage.UsageDelta }> = [];
  const run = makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", effort: "high", canWrite: true });
  runner.runSeat(run, "review", { ...capture.callbacks, onUsage: (startedRun, delta) => usageEvents.push({ runId: startedRun.runId, delta }) }, spawnReturning(proc));
  const assistant = { type: "assistant", message: { model: run.model, content: [{ type: "text", text: "visible answer" }] } };
  const result = { type: "result", total_cost_usd: 0.02, usage: { input_tokens: 7, output_tokens: 3 }, modelUsage: { [run.model]: { contextWindow: 1_000_000 } } };
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(assistant)}\n${JSON.stringify(result)}\n`));
  proc.emit("close", 0);
  assert.equal(capture.outputs.map((entry) => entry.text).join(""), "visible answer\n");
  assert.equal(usageEvents.length, 1);
  assert.deepEqual(usageEvents[0].delta, { modelId: run.model, contextTokens: 7, contextWindow: 1_000_000, costUsd: 0.02 });
});

test("the real runner holds Codex token usage until process close", () => {
  const proc = new FakeProc(), capture = captureCallbacks();
  const usageEvents: usage.UsageDelta[] = [];
  const run = makeRun({ canWrite: false });
  runner.runSeat(run, "review", { ...capture.callbacks, onUsage: (_startedRun, delta) => usageEvents.push(delta) }, spawnReturning(proc));
  proc.stderr.emit("data", Buffer.from("tokens used\n19,878\n"));
  assert.equal(usageEvents.length, 0);
  proc.emit("close", 0);
  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0].contextTokens, 19878);
});

test("an unconfirmed Codex kill holds its footer until the real close and flushes it once", () => {
  const proc = new FakeProc(), killer = new FakeProc(9898), capture = captureCallbacks();
  const usageEvents: usage.UsageDelta[] = [];
  const run = makeRun({ runId: "run-codex-kill", canWrite: false });
  runner.runSeat(run, "review", { ...capture.callbacks, onUsage: (_startedRun, delta) => usageEvents.push(delta) }, spawnReturning(proc));
  proc.stderr.emit("data", Buffer.from("tokens used\n12,345\n"));
  assert.equal(runner.killRun(run.runId, spawnReturning(killer)), true);
  killer.emit("error", new Error("taskkill unavailable"));
  assert.equal(usageEvents.length, 0);
  assert.equal(capture.unconfirmed.length, 1);
  proc.emit("close", null);
  proc.emit("close", null);
  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0].contextTokens, 12345);
  assert.equal(capture.statuses.filter((entry) => entry.status === "stopped").length, 1);
});

test("unconfirmed kill keeps the run owned until close; late taskkill errors are silent after retirement", () => {
  const proc = new FakeProc(), killer = new FakeProc(), capture = captureCallbacks();
  runner.runSeat(makeRun({ runId: "kill-run" }), "prompt", capture.callbacks, spawnReturning(proc));
  const calls: unknown[][] = [];
  const dispatch = ((command: string, ...args: unknown[]) => { calls.push([command, ...args]); return command === "taskkill" ? killer : proc; }) as unknown as typeof import("node:child_process").spawn;
  assert.equal(runner.killRun("kill-run", dispatch), true);
  assert.deepEqual(calls[0].slice(0, 2), ["taskkill", ["/pid", "4242", "/T", "/F"]]);
  killer.emit("error", new Error("taskkill unavailable"));
  assert.equal(runner.unconfirmedPid("kill-run"), 4242);
  assert.equal(runner.isRunning("kill-run"), true);
  assert.deepEqual(capture.unconfirmed, [{ runId: "kill-run", pid: 4242 }]);
  proc.emit("close", 1);
  killer.emit("error", new Error("late error"));
  assert.equal(capture.unconfirmed.length, 1);
  assert.equal(runner.isRunning("kill-run"), false);
});

test("explicit release frees a run but Stop all still kills its released process", () => {
  const proc = new FakeProc(), killer = new FakeProc();
  const capture = captureCallbacks();
  const releasedCloses: Array<{ runId: string; code?: number }> = [];
  const callbacks = { ...capture.callbacks, onReleasedClose: (run: runner.RunnerRun, code?: number) => releasedCloses.push({ runId: run.runId, code }) } as runner.RunnerCallbacks;
  runner.runSeat(makeRun({ runId: "release-run" }), "prompt", callbacks, spawnReturning(proc));
  runner.killRun("release-run", ((command: string) => command === "taskkill" ? killer : proc) as unknown as typeof import("node:child_process").spawn);
  killer.emit("error", new Error("no taskkill"));
  assert.equal(runner.releaseUnconfirmedRun("release-run"), true);
  assert.equal(runner.isRunning("release-run"), false);
  assert.equal(runner.releaseUnconfirmedRun("release-run"), false);
  proc.stdout.emit("data", Buffer.from("late output"));
  assert.equal(capture.outputs.some((entry) => entry.text === "late output"), false);
  const shutdownCalls: unknown[][] = [];
  runner.stopAllRunning(((command: string, args: unknown[]) => { shutdownCalls.push([command, args]); return new FakeProc(); }) as any);
  assert.deepEqual(shutdownCalls, [["taskkill", ["/pid", "4242", "/T", "/F"]]]);
  assert.deepEqual(releasedCloses, [], "a released process that is still alive reports nothing");
  proc.emit("close", 1);
  assert.deepEqual(releasedCloses, [{ runId: "release-run", code: 1 }], "the real close of a released process reaches onReleasedClose exactly once, with its exit code");
  proc.emit("close", 1);
  assert.equal(releasedCloses.length, 1, "a second close is ignored");
  assert.deepEqual(capture.statuses.map((entry) => entry.status), ["working"], "a released run is never reported as done, failed or stopped");
  const afterClose: unknown[][] = [];
  runner.stopAllRunning(((command: string, args: unknown[]) => { afterClose.push([command, args]); return new FakeProc(); }) as any);
  assert.deepEqual(afterClose, [], "once the released process has closed, Stop all has nothing left to kill");
});

test("kill grace timer reports an unconfirmed live process only after five seconds", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const proc = new FakeProc(), killer = new FakeProc(), capture = captureCallbacks();
  const usageEvents: usage.UsageDelta[] = [];
  const run = makeRun({ runId: "grace-period-run", canWrite: false });
  const started = runner.runSeat(run, "review", { ...capture.callbacks, onUsage: (_startedRun, delta) => usageEvents.push(delta) }, spawnReturning(proc));
  assert.equal(started.ok, true);
  proc.stderr.emit("data", Buffer.from("tokens used\n12,345\n"));
  assert.equal(runner.killRun(run.runId, spawnReturning(killer)), true);
  t.mock.timers.tick(4_999);
  assert.deepEqual(capture.unconfirmed, []);
  assert.equal(usageEvents.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(capture.unconfirmed, [{ runId: run.runId, pid: 4242 }]);
  assert.equal(runner.isRunning(run.runId), true);
  assert.equal(runner.unconfirmedPid(run.runId), 4242);
  assert.equal(usageEvents.length, 0, "Codex usage stays held until the real close");
  const log = readFileSync(runArtifact(run, started.timestamp, "log"), "utf8");
  assert.equal((log.match(/\[exit\]/g) ?? []).length, 0);
  proc.emit("close", 1);
  assert.equal(usageEvents.length, 1);
  assert.deepEqual(capture.statuses.map((entry) => entry.status), ["working", "stopped"]);
});

test("closed run handlers cannot emit for a replacement with a reused run id", () => {
  const oldProc = new FakeProc(), nextProc = new FakeProc();
  const oldCapture = captureCallbacks(), nextCapture = captureCallbacks();
  runner.runSeat(makeRun({ runId: "reused-run" }), "first", oldCapture.callbacks, spawnReturning(oldProc));
  oldProc.emit("close", 0);
  runner.runSeat(makeRun({ runId: "reused-run" }), "second", nextCapture.callbacks, spawnReturning(nextProc));
  oldProc.stdout.emit("data", Buffer.from("old late output"));
  assert.equal(oldCapture.outputs.some((entry) => entry.text === "old late output"), false);
  assert.equal(nextCapture.outputs.length, 0);
  nextProc.emit("close", 0);
});

test("stopped runs write a stopped marker that the history API can read", () => {
  const proc = new FakeProc(), killer = new FakeProc(), capture = captureCallbacks();
  runner.runSeat(makeRun({ runId: "stopped-run" }), "prompt", capture.callbacks, spawnReturning(proc));
  runner.killRun("stopped-run", ((command: string) => command === "taskkill" ? killer : proc) as unknown as typeof import("node:child_process").spawn);
  proc.emit("close", 1);
  assert.equal(capture.statuses.at(-1)?.status, "stopped");
  const log = readdirSync(runner.logsDir).filter((name) => name.startsWith("work-tab.reviewer1-") && name.endsWith(".log")).at(-1)!;
  assert.deepEqual(history.parseOutcome(readFileSync(`${runner.logsDir}/${log}`, "utf8")), { status: "stopped", exitCode: 1 });
});

test("config rejects unsafe tab-scoped seat keys while accepting old log ids", () => {
  assert.equal(config.isSafeSeatId("old-seat-id"), true);
  assert.equal(config.isSafeSeatId("tab-id.reviewer1"), true);
  assert.equal(config.isSafeSeatId("../escape"), false);
  assert.equal(config.isSafeSeatId("x".repeat(300)), false);
});
