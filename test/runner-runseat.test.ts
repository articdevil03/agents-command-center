import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { setEnv } from "./temp-root.ts";
import { config, runner, history, leader, FakeProc, makeRun, captureCallbacks, spawnReturning, runArtifact, startRunnerRun } from "./runner-helpers.ts";

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
  const newPath = runArtifact(next, newTimestamp, "log");
  const newLog = existsSync(newPath) ? readFileSync(newPath, "utf8") : ""; // a log that was never written is a failed assertion below, not a crash
  assert.ok(newLog.includes("current bytes"), "the live run's output reaches its own log");
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

test("runSeat: a stderr decoder tail left incomplete at close is flushed to the callback and the real log", () => {
  const proc = new FakeProc(), capture = captureCallbacks(), run = makeRun({ runId: "stderr-tail-incomplete" });
  const timestamp = startRunnerRun(run, "x", capture.callbacks, spawnReturning(proc));
  proc.stderr.emit("data", Buffer.from([0xe2, 0x82])); // half a character: only the decoder's end() can release it
  assert.equal(capture.outputs.length, 0, "nothing is released before close");
  proc.emit("close", 0);
  assert.equal(capture.outputs.map((entry) => entry.text).join(""), "�");
  assert.ok(readFileSync(runArtifact(run, timestamp, "log"), "utf8").includes("�"));
});

test("runSeat: a stdout decoder tail left incomplete at close is flushed to the callback and the real log", () => {
  const proc = new FakeProc(), capture = captureCallbacks(), run = makeRun({ runId: "stdout-tail-incomplete" });
  const timestamp = startRunnerRun(run, "x", capture.callbacks, spawnReturning(proc));
  proc.stdout.emit("data", Buffer.from([0xe2, 0x82]));
  assert.equal(capture.outputs.length, 0, "nothing is released before close");
  proc.emit("close", 0);
  assert.equal(capture.outputs.map((entry) => entry.text).join(""), "�");
  assert.ok(readFileSync(runArtifact(run, timestamp, "log"), "utf8").includes("�"));
});

test("runSeat: a Claude result line shows its text before its usage is broadcast", () => {
  const proc = new FakeProc(), order: string[] = [];
  const callbacks = { ...captureCallbacks().callbacks, onOutput: (_: unknown, text: string) => order.push(`output:${text}`), onUsage: () => order.push("usage") } as runner.RunnerCallbacks;
  const run = makeRun({ runId: "text-before-usage", cli: "claude", model: "claude-opus-5-5[1m]", effort: "medium" });
  startRunnerRun(run, "x", callbacks, spawnReturning(proc));
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", result: "final answer", usage: { input_tokens: 10 } })}\n`));
  proc.emit("close", 0);
  assert.deepEqual(order.slice(0, 2), ["output:final answer\n", "usage"]);
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

// ---- Pack 18, Block 2: the advisor flag, and the command and environment each CLI gets ----
const BRIEF = "C:/logs/work-tab.reviewer1-100.brief.txt";

const CLAUDE = { cli: "claude" as const, model: "claude-opus-5-5[1m]", effort: "high" };

const mcpFiles = (): string[] => readdirSync(runner.logsDir).filter((name) => name.endsWith(".mcp.json"));

// Starts a run through the real runSeat with only the spawn replaced; returns what spawn was given.
function spawnedRun(run: runner.RunnerRun, proc = new FakeProc()) {
  const calls: unknown[][] = [], capture = captureCallbacks();
  const timestamp = startRunnerRun(run, "the brief", capture.callbacks, spawnReturning(proc, calls));
  return { proc, command: String(calls[0][0]), options: calls[0][1] as any, capture, timestamp };
}

test("R1: a Claude run gets --advisor after the model check, a bad advisor throws, Codex and OpenCode never get the flag", () => {
  const advisor = "claude-fable-5-1";
  assert.equal(config.isValidModel("claude", advisor), true, "the advisor id is a Claude model");
  const withAdvisor = runner.buildCommand(makeRun({ ...CLAUDE, canWrite: true, advisor }), BRIEF);
  assert.match(withAdvisor, / --effort high --advisor claude-fable-5-1 --permission-mode acceptEdits /);
  assert.doesNotMatch(runner.buildCommand(makeRun({ ...CLAUDE, canWrite: true }), BRIEF), /--advisor/, "no advisor, no flag");
  for (const bad of ["x & calc", "gpt-6-sol", "claude-fable-5-1 --dangerously-skip-permissions", "", "not-a-model"]) {
    assert.throws(() => runner.buildCommand(makeRun({ ...CLAUDE, canWrite: true, advisor: bad }), BRIEF), /invalid advisor/, JSON.stringify(bad));
  }
  assert.doesNotMatch(runner.buildCommand(makeRun({ canWrite: true, advisor }), BRIEF), /--advisor/, "Codex");
  assert.doesNotMatch(runner.buildCommand(makeRun({ cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: true, advisor }), BRIEF), /--advisor/, "OpenCode");
  // The real call site: the command the spawn receives.
  const started = spawnedRun(makeRun({ ...CLAUDE, runId: "r1-claude", canWrite: true, advisor }));
  assert.match(started.command, /--advisor claude-fable-5-1/);
  started.proc.emit("close", 0);
  assert.throws(() => runner.runSeat(makeRun({ ...CLAUDE, runId: "r1-bad", canWrite: true, advisor: "x & calc" }), "p", captureCallbacks().callbacks, spawnReturning(new FakeProc())), /invalid advisor/);
  assert.equal(runner.isRunning("r1-bad"), false);
});

test("R6: a Claude seat that may write runs in acceptEdits mode, a read-only one in plan mode with the edit tools denied, and neither gets an MCP flag", () => {
  const worker = runner.buildCommand(makeRun({ ...CLAUDE, canWrite: false }), BRIEF);
  assert.match(worker, /--permission-mode plan --permission-prompts none --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit --output-format stream-json/, "a read-only seat keeps plan mode, byte for byte");
  assert.doesNotMatch(worker, /mcp|--permission-mode default/);
  const writer = runner.buildCommand(makeRun({ ...CLAUDE, canWrite: true }), BRIEF);
  assert.match(writer, /--permission-mode acceptEdits --output-format stream-json/);
  assert.doesNotMatch(writer, /--disallowedTools|mcp/);
});

test("R8: a read-only OpenCode seat gets the deny rules as its only config, a writing seat gets none", () => {
  const started = spawnedRun(makeRun({ runId: "r8-plain", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: false }));
  assert.equal(started.options.env.OPENCODE_CONFIG_CONTENT, JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { edit: "deny", bash: "deny" } }), "the read-only config is exactly the deny rules");
  started.proc.emit("close", 0);
  const writer = spawnedRun(makeRun({ runId: "r8-writer", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: true }));
  assert.equal(writer.options.env.OPENCODE_CONFIG_CONTENT, undefined, "a writing seat is not denied anything and gets no config");
  writer.proc.emit("close", 0);
});

test("R11: a seat that does not run the process gets no MCP config, no crew variables and no extra flag, in any CLI", () => {
  const cases = [
    makeRun({ runId: "r11-claude", ...CLAUDE, canWrite: false }),
    makeRun({ runId: "r11-claude-w", ...CLAUDE, canWrite: true }),
    makeRun({ runId: "r11-codex", canWrite: false }),
    makeRun({ runId: "r11-opencode", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: false }),
    makeRun({ runId: "r11-opencode-w", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: true }),
  ];
  const before = mcpFiles().length;
  for (const run of cases) {
    const started = spawnedRun(run);
    assert.doesNotMatch(started.command, /--allowedTools|--mcp-config|mcp_servers|CC_CREW|CC_MCP|approval_mode/, `${run.runId}: command`);
    for (const key of ["CC_MCP_CONFIG", "CC_CREW_URL", "CC_CREW_TOKEN"]) assert.equal(Object.hasOwn(started.options.env, key), false, `${run.runId}: ${key}`);
    assert.doesNotMatch(String(started.options.env.OPENCODE_CONFIG_CONTENT ?? ""), /mcp/, `${run.runId}: OpenCode config`);
    started.proc.emit("close", 0);
  }
  assert.equal(mcpFiles().length, before, "no config file was written");
  assert.deepEqual(runner.commandEnv(makeRun({ canWrite: true }), BRIEF), { CC_BRIEF_PATH: BRIEF }, "the environment holds the brief path alone");
});
