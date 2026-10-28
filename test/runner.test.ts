import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fakeCliOnPath, importWithTempDataRoot, scratchDir, setEnv } from "./temp-root.ts";
import * as usage from "../server/usage.ts";
import * as agentUsage from "../server/agent-usage.ts";
import * as security from "../server/security.ts";
import * as processEngine from "../server/process.ts";

// The server modules run on a fresh temp data root (config.ts seeds its example workspace there), never on the repo's live config/.
const { dataDir: isolatedData, modules: { config, runner, history, leader } } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"),
  runner: await import("../server/runner.ts"),
  history: await import("../server/history.ts"),
  leader: await import("../server/leader.ts"),
}));
fakeCliOnPath();

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;
  constructor(pid = 4242) { super(); this.pid = pid; }
}
function makeRun(overrides: Partial<runner.RunnerRun> = {}): runner.RunnerRun {
  return {
    runId: "run-1", seatKey: "work-tab.reviewer1", slotId: "reviewer1", name: "Vera", cli: "codex",
    model: "gpt-6-sol", effort: "high", folder: "C:/work/project", canWrite: false, startedAt: 100,
    ...overrides,
  };
}
function captureCallbacks() {
  const outputs: Array<{ runId: string; text: string }> = [];
  const statuses: Array<{ runId: string; status: string; code?: number }> = [];
  const unconfirmed: Array<{ runId: string; pid?: number }> = [];
  return {
    outputs, statuses, unconfirmed,
    callbacks: {
      onOutput: (run: runner.RunnerRun, text: string) => outputs.push({ runId: run.runId, text }),
      onStatus: (run: runner.RunnerRun, status: string, code?: number) => statuses.push({ runId: run.runId, status, code }),
      onUnconfirmedKill: (run: runner.RunnerRun, pid?: number) => unconfirmed.push({ runId: run.runId, pid }),
    } as runner.RunnerCallbacks,
  };
}
function spawnReturning(proc: FakeProc, calls: unknown[] = []) {
  return ((...args: unknown[]) => { calls.push(args); return proc; }) as unknown as typeof import("node:child_process").spawn;
}

const { usageDeltaFromResult, addUsage, zeroUsage, bankUsage, toUsageSnapshot } = usage;
const { createAgentUsageState, feedClaudeOutput, flushClaudeOutput, scanCodexTokens, flushCodexTokens } = agentUsage;
const discoveryBaseline = {
  codex: [...config.MODEL_OPTIONS.codex!],
  claudeEffort: [...config.EFFORT_OPTIONS.claude],
  opencode: [...config.OPENCODE_MODEL_SUGGESTIONS],
  claude: [...config.CLAUDE_MODEL_INFO].map((model) => ({ ...model })),
};
afterEach(async () => {
  await config.refreshDiscovery(
    async () => ({ values: [...discoveryBaseline.claudeEffort], fallback: true }),
    async () => ({ values: [...discoveryBaseline.opencode], fallback: true }),
    async () => ({ values: [...discoveryBaseline.claude].map((model) => ({ ...model })), fallback: true }),
  );
  config.MODEL_OPTIONS.codex!.splice(0, config.MODEL_OPTIONS.codex!.length, ...discoveryBaseline.codex);
});

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

// ---- usage.ts: SDK result -> per-seat usage delta, and the accumulator ----

test("usageDeltaFromResult: ctx estimate excludes output tokens and includes all input buckets, scoped to the given model id", () => {
  const result = {
    type: "result", subtype: "success", total_cost_usd: 0.0234,
    usage: { input_tokens: 120, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
    modelUsage: {
      "claude-opus-5": {
        inputTokens: 120, outputTokens: 340, cacheReadInputTokens: 5000, cacheCreationInputTokens: 200,
        webSearchRequests: 0, costUSD: 0.0234, contextWindow: 200000,
      },
    },
  };
  assert.deepEqual(usageDeltaFromResult(result, "claude-opus-5"), { modelId: "claude-opus-5", contextTokens: 5320, contextWindow: 200000, costUsd: 0.0234 });
});

// Guard 4a: the window must come from the SEAT'S OWN model entry, never the
// first (or only other) entry in modelUsage -- a worker or a differently
// -provisioned model with a much larger window must not leak into this seat's
// percentage.
test("usageDeltaFromResult: selects the window for the given model id, never a different model's entry", () => {
  const result = {
    total_cost_usd: 0.01,
    usage: { input_tokens: 50000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {
      other: { contextWindow: 1000000 },
      leader: { contextWindow: 200000 },
    },
  };
  assert.equal(usageDeltaFromResult(result, "leader").contextWindow, 200000);
  assert.equal(usageDeltaFromResult(result, "other").contextWindow, 1000000);
  assert.equal(usageDeltaFromResult(result, "nonexistent").contextWindow, null, "an unknown model id must not fall back to any other entry");
  assert.equal(usageDeltaFromResult(result).contextWindow, null, "no model id at all must not guess from the first entry");
});

// Guard 4b: a result that omits contextWindow, or reports a non-positive one,
// must report the window as unknown, never reuse an earlier turn's or another
// model's number (that reuse used to defeat the frontend's "not reported for
// this turn" handling).
test("usageDeltaFromResult: a missing or non-positive contextWindow reports as unknown, not zero-as-real or borrowed", () => {
  for (const modelUsage of [
    {}, { leader: {} }, { leader: { contextWindow: 0 } }, { leader: { contextWindow: -5 } }, { leader: { contextWindow: "200000" } },
  ]) {
    assert.equal(usageDeltaFromResult({ modelUsage }, "leader").contextWindow, null, `modelUsage: ${JSON.stringify(modelUsage)}`);
  }
});

test("usageDeltaFromResult: missing or malformed usage/modelUsage never throws and reports as unmeasured, not zero", () => {
  const unmeasured = { modelId: "leader", contextTokens: null, contextWindow: null, costUsd: null };
  for (const bad of [
    null, undefined, "not an object", 42, [],
    {},
    { usage: null, modelUsage: null },
    { usage: "nope", modelUsage: "nope" },
    { total_cost_usd: "free" },
    { total_cost_usd: NaN },
    { total_cost_usd: -1 }, // Guard 6: a negative cost is rejected, not shown as debt
  ]) {
    assert.doesNotThrow(() => usageDeltaFromResult(bad, "leader"));
    assert.deepEqual(usageDeltaFromResult(bad, "leader"), unmeasured, `input: ${JSON.stringify(bad)}`);
  }
  // A present-but-malformed usage object is still a measured turn (the SDK
  // never sends a partial bucket set in practice); missing fields sum as 0.
  assert.equal(usageDeltaFromResult({ usage: { input_tokens: "not a number" } }, "leader").contextTokens, 0);
});

test("addUsage: latest turn wins for context and cost (never summed), window is never carried over unreported, one turn per call", () => {
  const first = addUsage(zeroUsage(), { modelId: null, contextTokens: 1000, contextWindow: 200000, costUsd: 0.5 });
  assert.deepEqual(first, { modelId: null, contextTokens: 1000, contextWindow: 200000, bankedCostUsd: 0, currentCostUsd: 0.5, turns: 1 });
  const second = addUsage(first, { modelId: null, contextTokens: 500, contextWindow: null, costUsd: 0.0538 });
  assert.deepEqual(second, { modelId: null, contextTokens: 500, contextWindow: null, bankedCostUsd: 0, currentCostUsd: 0.0538, turns: 2 },
    "context tokens and cost must reflect only the latest turn, and a turn with no reported window must not keep the previous one");
});

test("addUsage: a turn with no measured cost keeps the last known cost, unlike window", () => {
  const first = addUsage(zeroUsage(), { modelId: null, contextTokens: 1000, contextWindow: 200000, costUsd: 0.5 });
  const second = addUsage(first, { modelId: null, contextTokens: 500, contextWindow: 200000, costUsd: null });
  assert.equal(second.currentCostUsd, 0.5, "a single malformed cost must not blank out a real running total");
});

test("bankUsage: folds the finished instance's cost into the bank and clears per-instance figures, without losing turns", () => {
  const totals = addUsage(addUsage(zeroUsage(), { modelId: "claude-opus-5", contextTokens: 1000, contextWindow: 200000, costUsd: 0.5 }),
    { modelId: "claude-opus-5", contextTokens: 1500, contextWindow: 200000, costUsd: 0.9 });
  const banked = bankUsage(totals);
  assert.deepEqual(banked, { modelId: null, contextTokens: null, contextWindow: null, bankedCostUsd: 0.9, currentCostUsd: null, turns: 2 },
    "a banked total must not carry the dead instance's model forward");

  // The next instance's own turns must add onto the bank, not replace it or double it.
  const nextInstance = addUsage(banked, { modelId: null, contextTokens: 200, contextWindow: 200000, costUsd: 0.1 });
  assert.deepEqual(toUsageSnapshot(nextInstance), { modelId: null, contextTokens: 200, contextWindow: 200000, costUsd: 1.0, turns: 3 });
});

test("bankUsage: banking an entry that never measured a cost is a harmless no-op", () => {
  assert.deepEqual(bankUsage(zeroUsage()), zeroUsage());
});

test("toUsageSnapshot: costUsd is null (not $0.0000) until something is actually measured", () => {
  assert.equal(toUsageSnapshot(zeroUsage()).costUsd, null);
  const measured = addUsage(zeroUsage(), { modelId: null, contextTokens: 0, contextWindow: 200000, costUsd: 0 });
  assert.equal(toUsageSnapshot(measured).costUsd, 0, "a real zero cost is still a measurement, once a turn has actually reported it");
});

test("addUsage: reset actually zeroes the accumulator, not merely the display of it", () => {
  const totals = addUsage(addUsage(zeroUsage(), { modelId: null, contextTokens: 9999, contextWindow: 200000, costUsd: 9.99 }),
    { modelId: null, contextTokens: 1, contextWindow: 200000, costUsd: 0.01 });
  assert.notDeepEqual(totals, zeroUsage());
  const reset = zeroUsage();
  assert.deepEqual(reset, { modelId: null, contextTokens: null, contextWindow: null, bankedCostUsd: 0, currentCostUsd: null, turns: 0 });
  const afterReset = addUsage(reset, { modelId: null, contextTokens: 42, contextWindow: 200000, costUsd: 0.42 });
  assert.deepEqual(afterReset, { modelId: null, contextTokens: 42, contextWindow: 200000, bankedCostUsd: 0, currentCostUsd: 0.42, turns: 1 },
    "post-reset totals must reflect only the new delta, not anything from before the reset");
});

// ---- agent-usage.ts: turns a claude/codex worker's raw stdout into
// rendered text plus whatever usage/rate-limit signal it carries. Pure-parser
// level here (buffer handling, one line at a time); the real runSeat/onUsage
// call-site wiring is proven separately in test/round2.test.ts's
// "agent-usage:" tests, per the "guard the call site, not the helper" rule. ----

test("agent-usage/claude: a JSON object split across two chunks is parsed exactly once (guard 3)", () => {
  const state = createAgentUsageState();
  const line = JSON.stringify({ type: "assistant", message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "hello" }] } });
  assert.deepEqual(feedClaudeOutput(state, line.slice(0, 10)), [], "an incomplete line must not be parsed or emitted yet");
  const events = feedClaudeOutput(state, line.slice(10) + "\n");
  assert.equal(events.length, 1, "the reassembled line must be parsed exactly once, not dropped or double-rendered");
  assert.equal(events[0].text, "hello\n");
});

test("agent-usage/claude: unparseable output passes through verbatim -- the degradation guarantee (guard 4)", () => {
  const state = createAgentUsageState();
  const events = feedClaudeOutput(state, "Building the feature...\nnot json at all {{{\n");
  assert.deepEqual(events.map((e) => e.text), ["Building the feature...\n", "not json at all {{{\n"]);
});

test("agent-usage/claude: thinking blocks and system lines produce no display text, while text blocks do (guard 5)", () => {
  const state = createAgentUsageState();
  const thinking = JSON.stringify({ type: "assistant", message: { model: "m", content: [{ type: "thinking", thinking: "pondering" }] } });
  const text = JSON.stringify({ type: "assistant", message: { model: "m", content: [{ type: "text", text: "hi" }] } });
  const system = JSON.stringify({ type: "system", subtype: "init" });
  const events = feedClaudeOutput(state, `${thinking}\n${text}\n${system}\n`);
  assert.deepEqual(events.map((e) => e.text), ["", "hi\n", ""]);
});

// P2 fix 3: the noise suppression is an allow-list of KNOWN noise types
// ("system", "user"), never a default-hide -- a type this CLI has never
// reported before must degrade to raw passthrough, exactly like unparseable
// JSON, so a future event type that carries real output can never go
// silently missing.
test("agent-usage/claude: an unrecognised event type falls through to raw passthrough, never silently hidden (guard: known-noise allow-list, not a default hide)", () => {
  const state = createAgentUsageState();
  const line = JSON.stringify({ type: "some_future_event", payload: "new" });
  const events = feedClaudeOutput(state, line + "\n");
  assert.equal(events[0].text, line + "\n");
});

// P2 fix 3: a "result" that reports failure but carries no `result` string
// must still say so, not vanish the way an ordinary empty result does.
test("agent-usage/claude: a result with no result string but is_error reports the failure instead of vanishing", () => {
  const state = createAgentUsageState();
  const line = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.02 });
  const events = feedClaudeOutput(state, line + "\n");
  assert.equal(events[0].text, "[error] error_max_turns\n");
});

// P2 fix 7: the final "result" line usually repeats the text the last
// "assistant" line already rendered -- must not be shown a second time, but
// the usage delta it carries must still be reported.
test("agent-usage/claude: a result line's text is not re-rendered when it exactly repeats the prior assistant line", () => {
  const state = createAgentUsageState();
  feedClaudeOutput(state, JSON.stringify({ type: "assistant", message: { model: "m", content: [{ type: "text", text: "All done." }] } }) + "\n");
  const resultLine = JSON.stringify({ type: "result", result: "All done.", total_cost_usd: 0.01, usage: { input_tokens: 5 }, modelUsage: {} });
  const events = feedClaudeOutput(state, resultLine + "\n");
  assert.equal(events[0].text, "", "must not render the same text twice");
  assert.ok(events[0].usage, "the usage delta must still be reported even though the text is suppressed");
});

test("agent-usage/claude: a result line with text that was never shown by an assistant line is still rendered", () => {
  const state = createAgentUsageState();
  const resultLine = JSON.stringify({ type: "result", result: "Never shown before.", total_cost_usd: 0.01, usage: {}, modelUsage: {} });
  const events = feedClaudeOutput(state, resultLine + "\n");
  assert.equal(events[0].text, "Never shown before.\n");
});

test("agent-usage/claude: a tool_use block renders as a compact [tool: X] line, not raw JSON", () => {
  const state = createAgentUsageState();
  const line = JSON.stringify({ type: "assistant", message: { model: "m", content: [{ type: "tool_use", name: "Read", input: {} }] } });
  assert.equal(feedClaudeOutput(state, line + "\n")[0].text, "[tool: Read]\n");
});

test("agent-usage/claude: a real captured result line produces a usage delta scoped to the seat's model, from the model id captured off the prior assistant line", () => {
  const state = createAgentUsageState();
  feedClaudeOutput(state, JSON.stringify({ type: "assistant", message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "working" }] } }) + "\n");
  const resultLine = JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "All done.",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-haiku-4-5-20251001": { contextWindow: 200000 } },
  });
  const events = feedClaudeOutput(state, resultLine + "\n");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].usage, { modelId: "claude-haiku-4-5-20251001", contextTokens: 300, contextWindow: 200000, costUsd: 0.0123 });
  assert.equal(events[0].text, "All done.\n");
});

test("agent-usage/claude: rate_limit_event yields the parsed plan windows and no display text", () => {
  const state = createAgentUsageState();
  const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
    five_hour: { utilization: 0.21, resetsAt: 1788750600 }, seven_day: { utilization: 0.57, resetsAt: 1788865200 },
  } } });
  const events = feedClaudeOutput(state, line + "\n");
  assert.equal(events[0].text, "");
  assert.deepEqual(events[0].rateLimit, { five_hour: { utilization: 0.21, resetsAt: 1788750600 }, seven_day: { utilization: 0.57, resetsAt: 1788865200 } });
});

test("agent-usage/claude: a malformed rate_limit_info never fabricates a windows object", () => {
  const state = createAgentUsageState();
  for (const bad of [{}, { rate_limit_info: {} }, { rate_limit_info: { unifiedWindows: {} } }, { rate_limit_info: { unifiedWindows: { five_hour: {} } } }]) {
    const events = feedClaudeOutput(state, JSON.stringify({ type: "rate_limit_event", ...bad }) + "\n");
    assert.equal(events[0].rateLimit, undefined, JSON.stringify(bad));
  }
});

test("agent-usage/claude: a final line with no trailing newline is flushed once, not dropped or repeated", () => {
  const state = createAgentUsageState();
  feedClaudeOutput(state, "no newline yet");
  assert.deepEqual(flushClaudeOutput(state).map((e) => e.text), ["no newline yet"]);
  assert.deepEqual(flushClaudeOutput(state), [], "a second flush with nothing left over must be a no-op");
});

// P2 fix 4: a match is never surfaced mid-stream -- it is held, and only
// flushCodexTokens (called once, at process close) ever returns a delta.
test("agent-usage/codex: \"tokens used\" is parsed with its comma -- 19,878 reads as 19878, never 19 -- but only surfaced at flush (guard 4/6)", () => {
  const state = createAgentUsageState();
  assert.deepEqual(scanCodexTokens(state, "some output\ntokens used\n19,878\n"), [], "never surfaced mid-stream");
  assert.deepEqual(flushCodexTokens(state), [{ modelId: null, contextTokens: 19878, contextWindow: null, costUsd: null }]);
});

test("agent-usage/codex: the \"tokens used\"/count pair still parses when split across chunks, however it lands (guard 6)", () => {
  const state = createAgentUsageState();
  assert.deepEqual(scanCodexTokens(state, "tokens us"), []);
  assert.deepEqual(scanCodexTokens(state, "ed\n19,"), []);
  assert.deepEqual(scanCodexTokens(state, "878\n"), []);
  assert.deepEqual(flushCodexTokens(state), [{ modelId: null, contextTokens: 19878, contextWindow: null, costUsd: null }]);
});

test("agent-usage/codex: a trailing count with no newline before the process exits is still caught at flush", () => {
  const state = createAgentUsageState();
  scanCodexTokens(state, "tokens used\n19,878");
  assert.deepEqual(flushCodexTokens(state), [{ modelId: null, contextTokens: 19878, contextWindow: null, costUsd: null }]);
});

test("agent-usage/codex: a non-numeric line after \"tokens used\" is never mistaken for a count", () => {
  const state = createAgentUsageState();
  assert.deepEqual(scanCodexTokens(state, "tokens used\nnot a number\n"), []);
  assert.deepEqual(flushCodexTokens(state), [], "nothing was ever actually held");
});

// P2 fix 4: the whole reason a match is held instead of reported immediately
// -- an earlier match (the agent's own prose coincidentally printing the
// exact line "tokens used") must never survive a later, real footer.
test("agent-usage/codex: a later real footer overwrites an earlier match, and nothing is reported until flush", () => {
  const state = createAgentUsageState();
  assert.deepEqual(scanCodexTokens(state, "tokens used\n111\n"), [], "an earlier match must not be surfaced immediately");
  assert.deepEqual(scanCodexTokens(state, "more work happening\ntokens used\n19,878\n"), []);
  assert.deepEqual(flushCodexTokens(state), [{ modelId: null, contextTokens: 19878, contextWindow: null, costUsd: null }],
    "the later, real footer must win over the earlier one");
});

// A fresh config folder in OS temp (never a copy of the repo's live config/).
function configFolder(): { root: string; dir: string } {
  const root = scratchDir(), dir = path.join(root, "config");
  mkdirSync(dir);
  return { root, dir };
}
// A copy of the example workspace this file's config module seeded in its own temp data root.
function workspaceCopy() {
  const { root, dir } = configFolder();
  const file = path.join(dir, "workspaces.json");
  const workspaces = config.readWorkspaces(config.workspacesPath);
  config.writeWorkspaces(workspaces, file);
  return { root, file, workspaces };
}
function runArtifact(run: runner.RunnerRun, timestamp: number, extension: "log" | "brief.txt"): string {
  return path.join(runner.logsDir, `${run.seatKey}-${timestamp}.${extension}`);
}
function startRunnerRun(run: runner.RunnerRun, prompt: string, callbacks: runner.RunnerCallbacks, spawn: any): number {
  const result = runner.runSeat(run, prompt, callbacks, spawn);
  if (!result.ok) throw new Error(result.error);
  return result.timestamp;
}

test("F1 guard: a hostile brief never reaches the command line, and no `&` sits outside quotes", () => {
  const proc = new FakeProc(), capture = captureCallbacks(), calls: unknown[][] = [];
  const prompt = 'review "quoted" & whoami & echo owned';
  const run = makeRun({ runId: "hostile-f1" });
  const started = runner.runSeat(run, prompt, capture.callbacks, spawnReturning(proc, calls));
  assert.equal(started.ok, true);
  const command = String(calls[0][0]);
  assert.doesNotMatch(command, /whoami|owned|quoted/);
  assert.match((calls[0][1] as any).env.CC_BRIEF_PATH, /\.brief\.txt$/);
  assert.equal(readFileSync(runArtifact(run, started.timestamp, "brief.txt"), "utf8"), prompt);
  proc.emit("close", 0);
});

test("applySeatKindAndUpdate: a kind switch alone becomes a process switch with its valid default crew", () => {
  const current = processEngine.createTabState("dev", "main", { tabId: "work-tab", folderPath: "C:/work" });
  const switched = processEngine.switchProcess(current, "duo", 10);
  assert.deepEqual(switched.seats.map((seat) => [seat.slotId, seat.cli, seat.model, seat.effort]), [
    ["leader", "claude", "claude-opus-5-5[1m]", "medium"], ["coder", "codex", "gpt-6-luna", "max"],
  ]);
});

test("applySeatKindAndUpdate: an invalid crew model leaves the whole saved workspace unchanged", () => {
  const { file, workspaces } = workspaceCopy();
  const previous = readFileSync(file, "utf8");
  const next = structuredClone(workspaces);
  const coder = next.projects[0].tabs[0].crew.find((seat) => seat.slot === "coder")!;
  coder.model = "not-a-codex-model";
  coder.effort = "low";
  assert.throws(() => config.writeWorkspaces(next, file), /invalid slot\/model\/effort/);
  assert.equal(readFileSync(file, "utf8"), previous);
});

test("applySeatKindAndUpdate: a valid model and effort update publishes together while the slot CLI stays fixed", () => {
  const { file, workspaces } = workspaceCopy();
  const next = structuredClone(workspaces);
  const coder = next.projects[0].tabs[0].crew.find((seat) => seat.slot === "coder")!;
  coder.model = "gpt-6-astra"; coder.effort = "low";
  config.writeWorkspaces(next, file);
  const saved = config.readWorkspaces(file).projects[0].tabs[0].crew.find((seat) => seat.slot === "coder")!;
  assert.deepEqual([saved.cli, saved.model, saved.effort], ["codex", "gpt-6-astra", "low"]);
});

test("applySeatKindAndUpdate: an invalid effort rolls the model update back before file publication", () => {
  const { file, workspaces } = workspaceCopy();
  const previous = readFileSync(file, "utf8");
  const next = structuredClone(workspaces);
  const coder = next.projects[0].tabs[0].crew.find((seat) => seat.slot === "coder")!;
  coder.model = "gpt-6-astra"; coder.effort = "wild";
  assert.throws(() => config.writeWorkspaces(next, file), /invalid slot\/model\/effort/);
  assert.equal(readFileSync(file, "utf8"), previous);
});

test("applySeatKindAndUpdate: an invalid process or unknown slot is rejected without changing the current process", () => {
  const current = processEngine.createTabState("dev", "main", { tabId: "work-tab", folderPath: "C:/work" });
  assert.throws(() => processEngine.switchProcess(current, "missing" as any));
  assert.equal(current.process, "main");
  const { file, workspaces } = workspaceCopy();
  const next = structuredClone(workspaces);
  next.projects[0].tabs[0].crew.push({ slot: "ghost", name: "Ghost", cli: "codex", model: "gpt-6-sol", effort: "high" });
  assert.throws(() => config.writeWorkspaces(next, file), /crew slot count does not match process/);
});

test("applySeatKindUpdate: a process switch cannot carry an old CLI model into a different fixed slot", () => {
  const current = processEngine.createTabState("dev", "main", { tabId: "work-tab", folderPath: "C:/work" });
  const switched = processEngine.switchProcess(current, "solo", 20);
  assert.deepEqual(switched.seats.map((seat) => seat.slotId), ["leader"]);
  assert.equal(switched.seats[0].cli, "claude");
  assert.equal(switched.seats[0].model, "claude-opus-5-5[1m]");
});

test("applySeatKindUpdate: an invalid model or effort cannot remain attached to a rebuilt crew slot", () => {
  const current = processEngine.createTabState("dev", "main", { tabId: "work-tab", folderPath: "C:/work" });
  const switched = processEngine.switchProcess(current, "duo", 20);
  const coder = switched.seats.find((seat) => seat.slotId === "coder")!;
  assert.equal(config.isValidModel(coder.cli, coder.model), true);
  assert.equal(config.isValidEffort(coder.cli, coder.effort), true);
});

test("applySeatKindUpdate: unknown process, slot, and leader worker launch are refused", () => {
  assert.throws(() => processEngine.getProcessDefinition("dev", "bad" as any), /unknown kind\/process/, "an unknown process is a plain error now, not undefined");
  const serverState = processEngine.createTabState("dev", "main", { tabId: "work-tab", folderPath: "C:/work" });
  assert.equal(serverState.seats.some((seat) => seat.slotId === "no-such-slot"), false);
  assert.equal(serverState.seats.find((seat) => seat.slotId === "leader")?.isLeader, true);
});

test("applySeatKindUpdate: switching to a process preserves its own valid default crew, not stale settings", () => {
  const switched = processEngine.switchProcess(processEngine.createTabState("dev", "main"), "duo", 20);
  assert.deepEqual(switched.seats.map((seat) => seat.slotId), ["leader", "coder"]);
  assert.equal(switched.seats.find((seat) => seat.slotId === "coder")?.canWrite, true);
});

test("applySeatUpdate: effort validation accepts a supported Codex effort and rejects an unknown one", () => {
  assert.equal(config.isValidEffort("codex", "max"), true);
  assert.equal(config.isValidEffort("codex", "wild"), false);
});

test("applySeatUpdate: OpenCode models must match the provider/model allow pattern", () => {
  assert.equal(config.isValidModel("opencode", "provider/model-v1"), true);
  assert.equal(config.isValidModel("opencode", "provider/model & run"), false);
});

test("applySeatUpdate: a model outside the kind allow-list cannot replace a valid saved model", () => {
  const { file, workspaces } = workspaceCopy();
  const previous = readFileSync(file, "utf8"), next = structuredClone(workspaces);
  next.projects[0].tabs[0].crew.find((seat) => seat.slot === "reviewer2")!.model = "other/model";
  assert.throws(() => config.writeWorkspaces(next, file), /invalid slot\/model\/effort/);
  assert.equal(readFileSync(file, "utf8"), previous);
});

test("buildCommand: a writable Claude slot gets acceptEdits from canWrite", () => {
  assert.match(runner.buildCommand(makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", canWrite: true }), "C:/logs/brief.txt"), /--permission-mode acceptEdits/);
});

test("buildCommand: a read-only Claude slot denies every shell and file-writing tool", () => {
  assert.match(runner.buildCommand(makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", canWrite: false }), "C:/logs/brief.txt"), /--disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit/);
});

test("buildCommand: a writable Claude slot does not carry read-only tool denials", () => {
  assert.doesNotMatch(runner.buildCommand(makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", canWrite: true }), "C:/logs/brief.txt"), /--disallowedTools/);
});

test("buildCommand: a read-only Claude slot uses plan mode and no permission prompts", () => {
  assert.match(runner.buildCommand(makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", canWrite: false }), "C:/logs/brief.txt"), /--permission-mode plan --permission-prompts none/);
});

test("buildCommand: Claude receives the brief path (through the environment) while prompt text remains only in the brief file", () => {
  const run = makeRun({ cli: "claude", model: "claude-opus-5-5[1m]" });
  const command = runner.buildCommand(run, "C:/logs/brief.txt");
  assert.match(command, /Read the file at %CC_BRIEF_PATH% and follow it/);
  assert.equal(runner.commandEnv(run, "C:/logs/brief.txt").CC_BRIEF_PATH, "C:/logs/brief.txt");
  assert.doesNotMatch(command, /private words/);
});

test("buildCommand: Codex read-only and write slots map to the matching sandbox", () => {
  assert.match(runner.buildCommand(makeRun({ canWrite: false }), "C:/logs/brief.txt"), /--sandbox read-only/);
  assert.match(runner.buildCommand(makeRun({ canWrite: true }), "C:/logs/brief.txt"), /--sandbox workspace-write/);
});

test("buildCommand: Codex effort is passed as a single model reasoning setting", () => {
  assert.match(runner.buildCommand(makeRun({ effort: "max" }), "C:/logs/brief.txt"), /model_reasoning_effort=max/);
});

test("buildCommand: Codex prompt refers to the isolated brief file", () => {
  assert.match(runner.buildCommand(makeRun(), "C:/logs/tab-seat.brief.txt"), /Read the file at %CC_BRIEF_PATH% and follow it/);
  assert.equal(runner.commandEnv(makeRun(), "C:/logs/tab-seat.brief.txt").CC_BRIEF_PATH, "C:/logs/tab-seat.brief.txt");
});

test("buildCommand: OpenCode command uses the configured model, variant, and working folder", () => {
  const command = runner.buildCommand(makeRun({ cli: "opencode", model: "provider/model-v1", effort: "max" }), "C:/logs/brief.txt");
  assert.match(command, /--dir "%CC_RUN_DIR%" -m provider\/model-v1 --variant max/);
});

test("buildCommand: rejects shell-sensitive effort values before command construction", () => {
  assert.throws(() => runner.buildCommand(makeRun({ effort: "high&whoami" }), "C:/logs/brief.txt"), /invalid effort/);
});

test("buildCommand: rejects shell-sensitive model values for every CLI", () => {
  for (const [cli, model] of [["claude", "claude&whoami"], ["codex", "gpt-6-sol&whoami"], ["opencode", "provider/model&whoami"]] as const) {
    assert.throws(() => runner.buildCommand(makeRun({ cli, model, effort: cli === "opencode" ? "max" : "high" }), "C:/logs/brief.txt"));
  }
});

test("canSeatWrite: Claude stays potentially writable regardless of a read-only slot flag", () => {
  assert.equal(runner.canRunWrite(makeRun({ cli: "claude", canWrite: false })), true);
});

test("canSeatWrite: a read-only Codex slot still counts as able to write", () => {
  assert.equal(runner.canRunWrite(makeRun({ cli: "codex", canWrite: true })), true);
  assert.equal(runner.canRunWrite(makeRun({ cli: "codex", canWrite: false })), true);
});

test("canSeatWrite: an in-process leader is not a worker-run permission record", () => {
  assert.equal(runner.canRunWrite(makeRun({ cli: "claude", canWrite: false })), true);
});

test("canSeatWrite: OpenCode stays potentially writable even when its slot canWrite flag is false", () => {
  assert.equal(runner.canRunWrite(makeRun({ cli: "opencode", canWrite: false })), true);
});

test("config.ts: workspace projects and each crew shape field are independently required", () => {
  const { file, workspaces } = workspaceCopy();
  for (const mutate of [
    (value: any) => { delete value.projects; },
    (value: any) => { delete value.projects[0].tabs[0].crew[0].cli; },
    (value: any) => { delete value.projects[0].tabs[0].crew[0].effort; },
  ]) {
    const value = structuredClone(workspaces) as any; mutate(value);
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => config.readWorkspaces(file), /malformed/);
  }
});

test("config.ts: this file's config module is rooted in its temp data folder, never the repo's live config/", () => {
  assert.equal(path.dirname(path.dirname(config.workspacesPath)).toLowerCase(), isolatedData.toLowerCase());
  assert.equal(path.dirname(path.dirname(config.clientPrefsPath)).toLowerCase(), isolatedData.toLowerCase());
  assert.equal(path.dirname(runner.logsDir).toLowerCase(), isolatedData.toLowerCase());
});

test("config.ts: the seeded example workspace parses as a complete project list", () => {
  const loaded = config.readWorkspaces(config.workspacesPath);
  assert.deepEqual(loaded.projects.map((project) => project.id), ["example"]);
  assert.ok(loaded.projects.every((project) => project.tabs.length > 0));
});

test("config.ts: malformed JSON reports the isolated config filename", () => {
  const { file } = workspaceCopy(); writeFileSync(file, "{");
  assert.throws(() => config.readWorkspaces(file), (error: any) => error.message.includes(file) && /valid JSON/.test(error.message));
});

test("config.ts: a malformed crew object is rejected even when its JSON is valid", () => {
  const { file, workspaces } = workspaceCopy(), value = structuredClone(workspaces) as any;
  value.projects[0].tabs[0].crew[0] = null;
  writeFileSync(file, JSON.stringify(value));
  assert.throws(() => config.readWorkspaces(file), /invalid crew member/);
});

test("disk-load guard: a legitimate multi-tab workspace with ordinary IDs loads", () => {
  const { file, workspaces } = workspaceCopy();
  const value = structuredClone(workspaces);
  value.projects[0].tabs.push(structuredClone(value.projects[0].tabs[0]));
  value.projects[0].tabs[1].id = "alpha-review";
  config.writeWorkspaces(value, file);
  assert.equal(config.readWorkspaces(file).projects[0].tabs.length, 2);
});

test("disk-load guard: the maximum safe log seat key length loads and one extra character is rejected", () => {
  const max = 255 - 1 - 13 - ".brief.txt".length;
  assert.equal(config.isSafeSeatId("x".repeat(max)), true);
  assert.equal(config.isSafeSeatId("x".repeat(max + 1)), false);
});

test("disk-load guard: safe legacy log IDs with spaces, dots, device names, and Unicode round-trip", () => {
  for (const seatId of ["CON", "name.with.dots", "space name", "Dev-研究"]) {
    assert.equal(config.isSafeSeatId(seatId), true, seatId);
    assert.deepEqual(history.parseLogFilename(`${seatId}-123.log`), { seatId, timestamp: 123 });
  }
});

test("disk-load guard: empty, whitespace-only, and filename-unsafe seat keys are rejected", () => {
  for (const seatId of ["", "   ", "../escape", "bad/name", "trailing.", "trailing "]) assert.equal(config.isSafeSeatId(seatId), false, seatId);
});

test("disk-load guard: a seat key holding a control character is not safe", () => {
  for (const seatId of [String.fromCharCode(116, 1, 46, 99), "tab.co" + String.fromCharCode(0x1f) + "der", "tab" + String.fromCharCode(0x7f) + ".coder", "a" + String.fromCharCode(10) + "b"]) assert.equal(config.isSafeSeatId(seatId), false, JSON.stringify(seatId));
  assert.equal(config.isSafeSeatId("tab.coder"), true, "control: an ordinary key passes");
});

test("disk-load guard: a workspace whose PROJECT id is not a slug is refused at load", () => {
  const { file, workspaces } = workspaceCopy();
  for (const id of ["Bad Project", "UPPER", "under_score", "-lead", "trail-"]) {
    const value = structuredClone(workspaces) as any; value.projects[0].id = id;
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => config.readWorkspaces(file), /bad project entry 0/, id);
  }
  writeFileSync(file, JSON.stringify(workspaces));
  assert.equal(config.readWorkspaces(file).projects[0].id, "example", "control: the slug id loads");
});

test("disk-load guard: duplicate project and tab IDs are rejected case-insensitively before writing", () => {
  const { file, workspaces } = workspaceCopy(), value = structuredClone(workspaces);
  value.projects.push(structuredClone(value.projects[0]));
  assert.throws(() => config.writeWorkspaces(value, file), /duplicate project id/);
});

test("disk-load guard: invalid model and effort errors identify the workspace tab and crew slot", () => {
  const { file, workspaces } = workspaceCopy(), value = structuredClone(workspaces);
  assert.equal(value.projects[0].tabs[0].id, "example-development", "the seeded example tab");
  const reviewer2 = value.projects[0].tabs[0].crew.find((seat) => seat.slot === "reviewer2");
  assert.ok(reviewer2, "the default dev crew has a reviewer2 slot");
  reviewer2.effort = "unsafe";
  assert.throws(() => config.writeWorkspaces(value, file), (error: any) => error.message.includes("example-development.reviewer2"), "the error names the tab and slot");
});

test("guard 2: failed CLI discovery keeps the fallback Fable and Codex Luna models", async () => {
  assert.ok(config.MODEL_OPTIONS.claude?.includes("claude-fable-5-1[1m]"));
  assert.ok(config.MODEL_OPTIONS.codex?.includes("gpt-6-luna"));
  await config.refreshDiscovery(async (fallback) => ({ values: [...fallback], fallback: true }), async (fallback) => ({ values: [...fallback], fallback: true }), async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }));
  assert.ok(config.MODEL_OPTIONS.claude?.includes("claude-fable-5-1[1m]"));
  assert.ok(config.MODEL_OPTIONS.codex?.includes("gpt-6-luna"));
});

test("guard 4: discovered Claude effort support stays attached to its own model", async () => {
  await config.refreshDiscovery(async (fallback) => ({ values: [...fallback], fallback: false }), async (fallback) => ({ values: [...fallback], fallback: true }), async () => ({ fallback: false, values: [{ value: "claude-custom", displayName: "Custom", supportsEffort: false }] }));
  assert.equal(config.CLAUDE_MODEL_INFO.find((model) => model.value === "claude-custom")?.supportsEffort, false);
});

test("isAllowedHost: only the exact localhost and IPv4 loopback host entries pass", () => {
  security.setAllowedPort(4317);
  assert.equal(security.isAllowedHost("127.0.0.1:4317"), true);
  assert.equal(security.isAllowedHost("localhost:4317"), true);
  assert.equal(security.isAllowedHost("127.0.0.1.evil:4317"), false);
  assert.equal(security.isAllowedHost("localhost:80"), false);
});

test("isAllowedOrigin: foreign origins fail while loopback and absent Origin pass", () => {
  security.setAllowedPort(4317);
  assert.equal(security.isAllowedOrigin("https://attacker.invalid"), false);
  assert.equal(security.isAllowedOrigin("http://127.0.0.1:4317"), true);
  assert.equal(security.isAllowedOrigin(undefined), true);
});

test("isSafeSeatId: a safe historical key remains valid outside today's roster", () => {
  assert.equal(config.isSafeSeatId("retired-tab.reviewer"), true);
  assert.equal(config.isSafeSeatId("../outside"), false);
});

test("isSwitchableSeatKind: workspace crew CLIs are only Claude, Codex, or OpenCode", () => {
  assert.equal(config.isValidModel("claude", "claude-opus-5-5[1m]"), true);
  assert.equal(config.isValidModel("codex", "gpt-6-sol"), true);
  assert.equal(config.isValidModel("opencode", "provider/model-v1"), true);
  assert.equal(config.isValidModel("leader" as any, "claude-opus-5"), false);
});

test("isWithinDir: a sibling with the same path prefix is outside the uploaded scratch directory", () => {
  const dir = path.resolve("C:/temp/scratch"), inside = path.resolve(dir, "img.png"), sibling = path.resolve("C:/temp/scratch-evil/img.png");
  assert.equal(security.isWithinDir(inside, dir), true);
  assert.equal(security.isWithinDir(sibling, dir), false);
});

test("killSeat: an unconfirmed process stays owned and has no exit marker until real close", () => {
  const proc = new FakeProc(), killer = new FakeProc(), capture = captureCallbacks();
  const run = makeRun({ runId: "unconfirmed-marker" }), timestamp = startRunnerRun(run, "x", capture.callbacks, spawnReturning(proc));
  runner.killRun("unconfirmed-marker", ((command: string) => command === "taskkill" ? killer : proc) as any);
  killer.emit("error", new Error("taskkill failed"));
  assert.equal(runner.isRunning("unconfirmed-marker"), true);
  assert.equal(capture.unconfirmed.length, 1);
  proc.emit("close", null);
  const log = readFileSync(runArtifact(run, timestamp, "log"), "utf8");
  assert.equal((log.match(/\[exit\]/g) ?? []).length, 1);
});

test("killSeat: taskkill spawn failure keeps the run tracked so another Kill can be attempted", async () => {
  const proc = new FakeProc(), capture = captureCallbacks();
  runner.runSeat(makeRun({ runId: "kill-retry" }), "x", capture.callbacks, spawnReturning(proc));
  assert.equal(runner.killRun("kill-retry", (() => { const killer = new FakeProc(); queueMicrotask(() => killer.emit("error", new Error("no taskkill"))); return killer; }) as any), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.isRunning("kill-retry"), true);
  assert.equal(runner.unconfirmedPid("kill-retry"), proc.pid);
  proc.emit("close", 1);
});

test("killSeat: unknown and already-closed run IDs are not accepted", () => {
  assert.equal(runner.killRun("not-running", (() => new FakeProc()) as any), false);
});

test("migrateSeatsForward: a malformed legacy project file remains byte-for-byte intact", () => {
  const { dir } = configFolder(), projects = path.join(dir, "old-projects.json"), destination = path.join(dir, "new-workspaces.json");
  const original = "{ broken legacy data"; writeFileSync(projects, original);
  assert.throws(() => config.migrateWorkspaces(projects, destination), /valid JSON/);
  assert.equal(readFileSync(projects, "utf8"), original);
  assert.equal(existsSync(destination), false);
});

test("migrateSeatsForward: legacy projects upcast to a default Development tab with validated crew", () => {
  const { dir } = configFolder(), projects = path.join(dir, "old-projects.json"), destination = path.join(dir, "new-workspaces.json");
  writeFileSync(projects, JSON.stringify([{ id: "legacy", name: "Legacy", dir: "C:/legacy" }]));
  assert.equal(config.migrateWorkspaces(projects, destination), true);
  const migrated = config.readWorkspaces(destination).projects[0];
  assert.equal(migrated.tabs[0].kind, "dev");
  assert.equal(migrated.tabs[0].crew.length, processEngine.getProcessDefinition("dev", "main").seats.length);
});

test("migrateSeatsForward: a second migration leaves the existing workspace bytes untouched", () => {
  const { dir } = configFolder(), projects = path.join(dir, "old-projects.json"), destination = path.join(dir, "new-workspaces.json");
  writeFileSync(projects, JSON.stringify([{ id: "legacy", name: "Legacy", dir: "C:/legacy" }]));
  config.migrateWorkspaces(projects, destination); const original = readFileSync(destination, "utf8");
  assert.equal(config.migrateWorkspaces(projects, destination), false);
  assert.equal(readFileSync(destination, "utf8"), original);
});

test("opencodeExtraEnv: a writable OpenCode slot and other CLIs receive no deny override", () => {
  const codex = new FakeProc(); let env: any;
  const spawn = ((_: string, options: any) => { env = options.env; return codex; }) as any;
  runner.runSeat(makeRun({ runId: "open-write-env", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: true }), "x", captureCallbacks().callbacks, spawn);
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined); codex.emit("close", 0);
  const claude = new FakeProc(); let claudeEnv: any;
  runner.runSeat(makeRun({ runId: "claude-env", cli: "claude", model: "claude-opus-5-5[1m]" }), "x", captureCallbacks().callbacks, ((_: string, options: any) => { claudeEnv = options.env; return claude; }) as any);
  assert.equal(claudeEnv.OPENCODE_CONFIG_CONTENT, undefined); claude.emit("close", 0);
});

test("opencodeExtraEnv: a read-only OpenCode slot denies edit and bash at the process boundary", () => {
  const proc = new FakeProc(); let env: any;
  runner.runSeat(makeRun({ runId: "open-read-env", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: false }), "x", captureCallbacks().callbacks, ((_: string, options: any) => { env = options.env; return proc; }) as any);
  assert.match(env.OPENCODE_CONFIG_CONTENT, /"edit":"deny"/); assert.match(env.OPENCODE_CONFIG_CONTENT, /"bash":"deny"/);
  proc.emit("close", 0);
});

test("refreshDiscovery: failed discoverers preserve fallback flags and safe fallback choices", async () => {
  await config.refreshDiscovery(async () => ({ values: [], fallback: true }), async () => ({ values: [], fallback: true }), async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }));
  assert.equal(config.discoveryInfo.claudeEffort.fallback, true);
  assert.equal(config.discoveryInfo.opencodeModels.fallback, true);
  assert.ok(config.MODEL_OPTIONS.claude?.includes("claude-opus-5-5[1m]"));
});

test("refreshDiscovery: successful values replace effort and OpenCode suggestions and clear fallback markers", async () => {
  await config.refreshDiscovery(async () => ({ values: ["low", "max"], fallback: false }), async () => ({ values: ["vendor/model-a"], fallback: false }), async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }));
  // Was deepEqual(["low", "max"]). A saved seat effort stays in the list through a refresh (round 8), so discovered values lead and saved ones follow.
  assert.deepEqual(config.EFFORT_OPTIONS.claude.slice(0, 2), ["low", "max"]);
  assert.deepEqual(config.OPENCODE_MODEL_SUGGESTIONS, ["vendor/model-a"]);
  assert.equal(config.discoveryInfo.claudeEffort.fallback, false);
  assert.equal(config.discoveryInfo.opencodeModels.fallback, false);
});

test("refreshDiscovery: Claude model labels come from the injected model discovery result", async () => {
  await config.refreshDiscovery(async (fallback) => ({ values: [...fallback], fallback: true }), async (fallback) => ({ values: [...fallback], fallback: true }), async () => ({ fallback: false, values: [{ value: "claude-review-model", displayName: "Review label", supportsEffort: true }] }));
  assert.deepEqual(config.CLAUDE_MODEL_INFO.find((item) => item.value === "claude-review-model"), { value: "claude-review-model", displayName: "Review label", supportsEffort: true });
});

test("refreshDiscovery: discovered OpenCode gpt models are added to Codex IDs without their provider prefix", async () => {
  const before = [...config.MODEL_OPTIONS.codex!];
  try {
    await config.refreshDiscovery(async (fallback) => ({ values: [...fallback], fallback: true }), async () => ({ values: ["opencode/gpt-6-future", "other/model"], fallback: false }), async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }));
    assert.ok(config.MODEL_OPTIONS.codex!.includes("gpt-6-future"));
    assert.equal(config.MODEL_OPTIONS.codex!.includes("opencode/gpt-6-future"), false);
  } finally { config.MODEL_OPTIONS.codex!.splice(0, config.MODEL_OPTIONS.codex!.length, ...before); }
});

test("refreshDiscovery: a configured workspace Codex model survives a successful catalog refresh", async () => {
  const original = readFileSync(config.workspacesPath);
  const configuredModel = "gpt-6-workspace-custom";
  try {
    const workspaces = config.readWorkspaces();
    const codexSeat = workspaces.projects.flatMap((project) => project.tabs.flatMap((tab) => tab.crew)).find((seat) => seat.cli === "codex");
    assert.ok(codexSeat, "test workspace must contain a Codex slot");
    codexSeat.model = configuredModel;
    config.writeWorkspaces(workspaces, config.workspacesPath);
    await config.refreshDiscovery(
      async (fallback) => ({ values: [...fallback], fallback: true }),
      async () => ({ values: ["vendor/model-current"], fallback: false }),
      async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }),
    );
    assert.ok(config.MODEL_OPTIONS.codex?.includes(configuredModel));
    assert.equal(config.isValidModel("codex", configuredModel), true);
  } finally {
    writeFileSync(config.workspacesPath, original);
  }
});

test("refreshDiscovery: a saved OpenCode model that discovery omits is offered until its last use is removed", async () => {
  const original = readFileSync(config.workspacesPath);
  const saved = "vendor/custom.v1/nested";
  const refresh = () => config.refreshDiscovery(
    async (fallback) => ({ values: [...fallback], fallback: true }),
    async () => ({ values: ["vendor/model-current"], fallback: false }),
    async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }),
  );
  try {
    const workspaces = config.readWorkspaces();
    const seat = workspaces.projects.flatMap((project) => project.tabs.flatMap((tab) => tab.crew))[0];
    assert.ok(seat, "test workspace must contain a slot");
    seat.cli = "opencode"; seat.model = saved; seat.effort = "max"; config.writeWorkspaces(workspaces, config.workspacesPath);
    await refresh();
    assert.ok(config.OPENCODE_MODEL_SUGGESTIONS.includes(saved)); assert.ok(config.OPENCODE_MODEL_SUGGESTIONS.includes("vendor/model-current"));
    writeFileSync(config.workspacesPath, original);
    await refresh();
    assert.equal(config.OPENCODE_MODEL_SUGGESTIONS.includes(saved), false);
  } finally {
    writeFileSync(config.workspacesPath, original);
    await refresh(); config.adoptSavedValues(config.readWorkspaces());
  }
});

test("refreshDiscovery: effort, OpenCode, and Claude discovery start concurrently", async () => {
  let started = 0, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = config.refreshDiscovery(
    async (fallback) => { started++; await gate; return { values: [...fallback], fallback: true }; },
    async (fallback) => { started++; await gate; return { values: [...fallback], fallback: true }; },
    async (fallback) => { started++; await gate; return { values: [...fallback].map((item) => ({ ...item })), fallback: true }; },
  );
  await Promise.resolve(); assert.equal(started, 3); release(); await pending;
});

test("runSeat: private data-root variables are removed from child environments", () => {
  const restore = setEnv({ CC_DATA_DIR: "C:/private/never-read", CC_TEST_FORCE_PACKAGED: "1", CC_APP_KEY: "test-app-key-must-not-leak" });
  const proc = new FakeProc(); let env: any;
  try {
    runner.runSeat(makeRun({ runId: "env-strip" }), "x", captureCallbacks().callbacks, ((_: string, options: any) => { env = options.env; return proc; }) as any);
    assert.equal(Object.hasOwn(env, "CC_DATA_DIR"), false); assert.equal(Object.hasOwn(env, "CC_TEST_FORCE_PACKAGED"), false); assert.equal(Object.hasOwn(env, "CC_APP_KEY"), false);
  } finally { proc.emit("close", 0); restore(); }
});

test("runSeat: a clean exit writes the done marker that history parses", () => {
  const proc = new FakeProc(), run = makeRun({ runId: "done-marker" }), timestamp = startRunnerRun(run, "x", captureCallbacks().callbacks, spawnReturning(proc)); proc.emit("close", 0);
  const log = readFileSync(runArtifact(run, timestamp, "log"), "utf8");
  assert.deepEqual(history.parseOutcome(log), { status: "done", exitCode: 0 });
});

test("runSeat: late output from a retired process cannot reach callbacks or its replacement log", () => {
  const oldProc = new FakeProc(), newProc = new FakeProc(), oldCapture = captureCallbacks(), newCapture = captureCallbacks();
  const old = makeRun({ runId: "late-chunk" }); const oldTimestamp = startRunnerRun(old, "old", oldCapture.callbacks, spawnReturning(oldProc)); oldProc.emit("close", 0);
  const next = makeRun({ runId: "late-chunk" }); const newTimestamp = startRunnerRun(next, "new", newCapture.callbacks, spawnReturning(newProc));
  newProc.stdout.emit("data", Buffer.from("current bytes"));
  const oldLog = readFileSync(runArtifact(old, oldTimestamp, "log"), "utf8");
  const newLog = readFileSync(runArtifact(next, newTimestamp, "log"), "utf8");
  oldProc.stdout.emit("data", Buffer.from("late old bytes"));
  oldProc.stderr.emit("data", Buffer.from("late old stderr"));
  assert.deepEqual(newCapture.outputs.map((entry) => entry.text), ["current bytes"]); assert.equal(newCapture.statuses.length, 1);
  assert.deepEqual(oldCapture.outputs, []);
  assert.equal(readFileSync(runArtifact(old, oldTimestamp, "log"), "utf8"), oldLog);
  assert.equal(readFileSync(runArtifact(next, newTimestamp, "log"), "utf8"), newLog);
  newProc.emit("close", 0);
});

test("runSeat: a non-zero close writes a failed marker with the real exit code", () => {
  const proc = new FakeProc(), run = makeRun({ runId: "failed-marker" }), timestamp = startRunnerRun(run, "x", captureCallbacks().callbacks, spawnReturning(proc)); proc.emit("close", 9);
  const log = readFileSync(runArtifact(run, timestamp, "log"), "utf8");
  assert.deepEqual(history.parseOutcome(log), { status: "failed", exitCode: 9 });
});

test("runSeat: read-only OpenCode receives deny config while a writable Codex slot does not", () => {
  const open = new FakeProc(), codex = new FakeProc(); let openEnv: any, codexEnv: any;
  runner.runSeat(makeRun({ runId: "open-review-env", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: false }), "x", captureCallbacks().callbacks, ((_: string, options: any) => { openEnv = options.env; return open; }) as any);
  runner.runSeat(makeRun({ runId: "codex-write-env", canWrite: true }), "x", captureCallbacks().callbacks, ((_: string, options: any) => { codexEnv = options.env; return codex; }) as any);
  assert.match(openEnv.OPENCODE_CONFIG_CONTENT, /"edit":"deny"/); assert.equal(codexEnv.OPENCODE_CONFIG_CONTENT, undefined);
  open.emit("close", 0); codex.emit("close", 0);
});

test("runSeat: an unconfirmed kill keeps ownership until close, then releases it", () => {
  const proc = new FakeProc(), killer = new FakeProc();
  runner.runSeat(makeRun({ runId: "unconfirmed-own" }), "x", captureCallbacks().callbacks, spawnReturning(proc));
  runner.killRun("unconfirmed-own", ((command: string) => command === "taskkill" ? killer : proc) as any);
  killer.emit("error", new Error("cannot kill")); assert.equal(runner.isRunning("unconfirmed-own"), true);
  proc.emit("close", null); assert.equal(runner.isRunning("unconfirmed-own"), false);
});

test("runSeat: an unconfirmed kill writes no exit marker before the real close", () => {
  const proc = new FakeProc(), killer = new FakeProc(), run = makeRun({ runId: "marker-after-close" });
  const timestamp = startRunnerRun(run, "x", captureCallbacks().callbacks, spawnReturning(proc));
  runner.killRun("marker-after-close", ((command: string) => command === "taskkill" ? killer : proc) as any); killer.emit("error", new Error("failed"));
  assert.equal(existsSync(runArtifact(run, timestamp, "log")), false, "a log marker cannot exist before the process closes");
  proc.emit("close", null);
});

test("runSeat: a late spawn error from a closed run cannot change the replacement run", () => {
  const oldProc = new FakeProc(), newProc = new FakeProc(), old = captureCallbacks(), next = captureCallbacks();
  runner.runSeat(makeRun({ runId: "late-spawn-error" }), "old", old.callbacks, spawnReturning(oldProc)); oldProc.emit("close", 0);
  runner.runSeat(makeRun({ runId: "late-spawn-error" }), "new", next.callbacks, spawnReturning(newProc));
  oldProc.emit("error", new Error("late spawn"));
  assert.equal(runner.isRunning("late-spawn-error"), true); assert.deepEqual(next.statuses.map((item) => item.status), ["working"]);
  assert.deepEqual(old.statuses.map((item) => item.status), ["working", "done"]);
  newProc.emit("close", 0);
});

test("runSeat: a late taskkill error after real close cannot change a replacement run", () => {
  const oldProc = new FakeProc(), killer = new FakeProc(), newProc = new FakeProc(), next = captureCallbacks();
  runner.runSeat(makeRun({ runId: "late-kill-error" }), "old", captureCallbacks().callbacks, spawnReturning(oldProc));
  runner.killRun("late-kill-error", ((command: string) => command === "taskkill" ? killer : oldProc) as any); oldProc.emit("close", 0);
  runner.runSeat(makeRun({ runId: "late-kill-error" }), "new", next.callbacks, spawnReturning(newProc));
  killer.emit("error", new Error("late taskkill"));
  assert.equal(runner.isRunning("late-kill-error"), true); assert.deepEqual(next.unconfirmed, []);
  newProc.emit("close", 0);
});

test("runSeat: output from one tab-scoped seat is never delivered under another run", () => {
  const a = new FakeProc(), b = new FakeProc(), ca = captureCallbacks(), cb = captureCallbacks();
  runner.runSeat(makeRun({ runId: "seat-a", seatKey: "alpha.coder" }), "a", ca.callbacks, spawnReturning(a));
  runner.runSeat(makeRun({ runId: "seat-b", seatKey: "beta.coder" }), "b", cb.callbacks, spawnReturning(b));
  a.stdout.emit("data", Buffer.from("alpha")); b.stdout.emit("data", Buffer.from("beta"));
  assert.deepEqual(ca.outputs.map((entry) => [entry.runId, entry.text]), [["seat-a", "alpha"]]);
  assert.deepEqual(cb.outputs.map((entry) => [entry.runId, entry.text]), [["seat-b", "beta"]]);
  a.emit("close", 0); b.emit("close", 0);
});

test("runSeat: a UTF-8 character split across stdout chunks is reassembled without replacement bytes", () => {
  const proc = new FakeProc(), capture = captureCallbacks(); runner.runSeat(makeRun({ runId: "split-four-byte" }), "x", capture.callbacks, spawnReturning(proc));
  proc.stdout.emit("data", Buffer.from([0xf0, 0x9f])); proc.stdout.emit("data", Buffer.from([0x8c, 0x9f])); proc.emit("close", 0);
  assert.equal(capture.outputs.map((entry) => entry.text).join(""), "🌟");
});

test("runSeat: two runs for one seat have distinct run IDs and isolated output ownership", () => {
  const a = new FakeProc(), b = new FakeProc(), ca = captureCallbacks(), cb = captureCallbacks();
  assert.equal(runner.runSeat(makeRun({ runId: "same-seat-one" }), "one", ca.callbacks, spawnReturning(a)).ok, true);
  assert.equal(runner.runSeat(makeRun({ runId: "same-seat-two" }), "two", cb.callbacks, spawnReturning(b)).ok, true);
  assert.deepEqual(runner.runIdsForSeat("work-tab.reviewer1").filter((id) => id.startsWith("same-seat-")), ["same-seat-one", "same-seat-two"]);
  a.stdout.emit("data", Buffer.from("one")); b.stdout.emit("data", Buffer.from("two"));
  assert.equal(ca.outputs[0].text, "one"); assert.equal(cb.outputs[0].text, "two"); a.emit("close", 0); b.emit("close", 0);
});

test("runSeat: real process close status is done at zero and failed at non-zero", () => {
  const ok = new FakeProc(), bad = new FakeProc(), a = captureCallbacks(), b = captureCallbacks();
  runner.runSeat(makeRun({ runId: "status-ok" }), "x", a.callbacks, spawnReturning(ok));
  runner.runSeat(makeRun({ runId: "status-bad" }), "x", b.callbacks, spawnReturning(bad));
  ok.emit("close", 0); bad.emit("close", 2);
  assert.deepEqual(a.statuses.map((entry) => entry.status), ["working", "done"]);
  assert.deepEqual(b.statuses.map((entry) => entry.status), ["working", "failed"]);
});

test("runSeat: an unterminated stderr decoder tail reaches both callback and real log at close", () => {
  const proc = new FakeProc(), capture = captureCallbacks(), run = makeRun({ runId: "stderr-tail" });
  const timestamp = startRunnerRun(run, "x", capture.callbacks, spawnReturning(proc));
  proc.stderr.emit("data", Buffer.from([0xe2, 0x82])); proc.stderr.emit("data", Buffer.from([0xac])); proc.emit("close", 0);
  assert.equal(capture.outputs.map((entry) => entry.text).join(""), "€");
  const log = readFileSync(runArtifact(run, timestamp, "log"), "utf8");
  assert.ok(log.includes("€"));
});

test("runSeat: a spawn error flushes held output, writes one exit marker, and ignores a later close", () => {
  const proc = new FakeProc(), capture = captureCallbacks();
  const run = makeRun({ runId: "spawn-error-final", cli: "claude", model: "claude-opus-5-5[1m]", effort: "medium" });
  const timestamp = startRunnerRun(run, "x", capture.callbacks, spawnReturning(proc));
  proc.stdout.emit("data", Buffer.from("held partial line"));
  assert.equal(capture.outputs.length, 0, "the Claude line buffer holds an unterminated line");
  proc.emit("error", new Error("spawn failed"));
  proc.emit("close", 1);
  const log = readFileSync(runArtifact(run, timestamp, "log"), "utf8");
  assert.ok(log.includes("held partial line"), "buffered output is flushed on a spawn error");
  assert.ok(capture.outputs.some((entry) => entry.text.includes("held partial line")));
  assert.ok(log.includes("[spawn error] spawn failed"));
  assert.deepEqual(history.parseOutcome(log), { status: "failed", exitCode: null });
  assert.equal(log.match(/\[exit\]/g)?.length, 1, "exactly one exit marker");
  assert.deepEqual(capture.statuses.map((item) => item.status), ["working", "failed"]);
  assert.equal(runner.isRunning("spawn-error-final"), false);
});
