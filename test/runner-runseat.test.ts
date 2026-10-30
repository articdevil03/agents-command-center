import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
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

// ---- Pack 18, Block 2: the advisor flag, and how a seat that runs the process reaches the crew tools (url + token) in each CLI ----
const BRIEF = "C:/logs/work-tab.reviewer1-100.brief.txt";

const CREW = { url: "http://127.0.0.1:4317/api/leader-mcp/work-tab.run-18", token: "tok-p18-0123456789abcdef0123456789abcdef" };

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

test("R6: a Claude seat that runs the process gets the MCP config and its tools, a read-only one default mode instead of plan, and the config file is gone when the run ends", async () => {
  const crewTools = CREW;
  const orch = runner.buildCommand(makeRun({ ...CLAUDE, canWrite: false, crewTools }), BRIEF);
  assert.match(orch, /--permission-mode default --permission-prompts none --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit --mcp-config "%CC_MCP_CONFIG%" --allowedTools mcp__tab-crew --output-format stream-json/);
  assert.doesNotMatch(orch, /--permission-mode plan/, "plan mode blocks the MCP tools");
  const worker = runner.buildCommand(makeRun({ ...CLAUDE, canWrite: false }), BRIEF);
  assert.match(worker, /--permission-mode plan --permission-prompts none --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit --output-format stream-json/, "a read-only seat that does not run the process keeps plan mode, byte for byte");
  assert.doesNotMatch(worker, /mcp|--permission-mode default/);
  const writer = runner.buildCommand(makeRun({ ...CLAUDE, canWrite: true, crewTools }), BRIEF);
  assert.match(writer, /--permission-mode acceptEdits --mcp-config "%CC_MCP_CONFIG%" --allowedTools mcp__tab-crew /);
  assert.doesNotMatch(writer, /--disallowedTools/);
  assert.ok(!orch.includes(crewTools.token) && !orch.includes(crewTools.url), "the token and the url are not on the command line");
  assert.throws(() => runner.buildCommand(makeRun({ ...CLAUDE, canWrite: false, crewTools: { ...crewTools, url: "http://127.0.0.1:1/x & calc" } }), BRIEF), /unsafe crew tools url/);
  assert.throws(() => runner.buildCommand(makeRun({ ...CLAUDE, canWrite: false, crewTools: { ...crewTools, token: "bad token" } }), BRIEF), /unsafe crew tools token/);

  // The real call site, through every way a run can end: the file exists while it runs, holds the config, and is deleted at the end.
  const before = mcpFiles().length;
  const ends: Array<[string, (proc: FakeProc) => void | Promise<void>]> = [
    ["close", (proc) => { proc.emit("close", 0); }],
    ["spawn error", (proc) => { proc.emit("error", new Error("spawn failed")); }],
    ["exit without close", async (proc) => { proc.emit("exit", 0); await new Promise((resolve) => setTimeout(resolve, 1000)); }],
  ];
  for (const [label, end] of ends) {
    const runId = `r6-${label.replace(/ /g, "-")}`;
    const started = spawnedRun(makeRun({ ...CLAUDE, runId, canWrite: false, crewTools }));
    const file = started.options.env.CC_MCP_CONFIG as string;
    assert.ok(file && file.endsWith(".mcp.json") && path.dirname(file).toLowerCase() === runner.logsDir.toLowerCase(), `${label}: the config is a file in the logs folder`);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mcpServers: { "tab-crew": { type: "http", url: crewTools.url, headers: { Authorization: `Bearer ${crewTools.token}` } } } }, `${label}: the config holds the http server with the auth header`);
    assert.match(started.command, /--mcp-config "%CC_MCP_CONFIG%"/);
    assert.ok(!started.command.includes(crewTools.token), `${label}: no token on the command line`);
    await end(started.proc);
    assert.equal(existsSync(file), false, `${label}: the config file is deleted when the run ends`);
    assert.equal(runner.isRunning(runId), false);
  }
  // A start that throws, and a start that is refused (the CLI is not on PATH): no file is left either way.
  assert.throws(() => runner.runSeat(makeRun({ ...CLAUDE, runId: "r6-throws", canWrite: false, crewTools }), "p", captureCallbacks().callbacks, (() => { throw new Error("spawn exploded"); }) as any), /spawn exploded/);
  const restore = setEnv({ PATH: "" });
  try {
    const refused = runner.runSeat(makeRun({ ...CLAUDE, runId: "r6-refused", canWrite: false, crewTools }), "p", captureCallbacks().callbacks, spawnReturning(new FakeProc()));
    assert.equal(refused.ok, false, "a refused start");
  } finally { restore(); }
  assert.equal(mcpFiles().length, before, "no config file is left behind by any of the paths");
});

test("R7: Codex reaches the crew tools with three -c keys and the url and token in the environment; the token is never on the command line", () => {
  const run = makeRun({ runId: "r7-codex", canWrite: false, crewTools: CREW });
  const command = runner.buildCommand(run, BRIEF);
  assert.match(command, / -c "mcp_servers\.tab-crew\.url=%CC_CREW_URL%"/);
  assert.match(command, / -c mcp_servers\.tab-crew\.bearer_token_env_var=CC_CREW_TOKEN /);
  assert.match(command, / -c mcp_servers\.tab-crew\.default_tools_approval_mode=approve /);
  assert.match(command, /--sandbox read-only /);
  assert.ok(!command.includes(CREW.token), "the token is not on the command line");
  const env = runner.commandEnv(run, BRIEF);
  assert.equal(env.CC_CREW_URL, CREW.url); assert.equal(env.CC_CREW_TOKEN, CREW.token);
  // The real call site.
  const started = spawnedRun(run);
  assert.ok(!started.command.includes(CREW.token), "the command the spawn receives has no token");
  assert.match(started.command, /mcp_servers\.tab-crew\.default_tools_approval_mode=approve/);
  assert.equal(started.options.env.CC_CREW_URL, CREW.url); assert.equal(started.options.env.CC_CREW_TOKEN, CREW.token);
  assert.equal(started.options.env.CC_MCP_CONFIG, undefined, "Codex has no config file");
  started.proc.emit("close", 0);
});

test("R8: a read-only OpenCode seat that runs the process gets ONE config holding both the deny rules and the crew tools", () => {
  const run = makeRun({ runId: "r8-both", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: false, crewTools: CREW });
  const started = spawnedRun(run);
  const merged = JSON.parse(started.options.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(merged.permission, { edit: "deny", bash: "deny" }, "the deny part is kept");
  assert.deepEqual(merged.mcp, { "tab-crew": { type: "remote", url: CREW.url, headers: { Authorization: "Bearer {env:CC_CREW_TOKEN}" }, oauth: false } }, "the crew tools are in the same config");
  assert.ok(!started.options.env.OPENCODE_CONFIG_CONTENT.includes(CREW.token), "the config names the environment variable, not the token");
  assert.equal(started.options.env.CC_CREW_TOKEN, CREW.token);
  started.proc.emit("close", 0);
  const writer = spawnedRun(makeRun({ runId: "r8-writer", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: true, crewTools: CREW }));
  const writerConfig = JSON.parse(writer.options.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(writerConfig.permission, undefined, "a writing seat is not denied anything");
  assert.ok(writerConfig.mcp["tab-crew"]);
  writer.proc.emit("close", 0);
  const plain = spawnedRun(makeRun({ runId: "r8-plain", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: false }));
  assert.equal(plain.options.env.OPENCODE_CONFIG_CONTENT, JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { edit: "deny", bash: "deny" } }), "without crew tools the read-only config is exactly as before");
  plain.proc.emit("close", 0);
});

test("R9: the crew token never reaches the log or a single output chunk, whole or split across writes (stdout, stderr, Claude events, a run ended inside it)", () => {
  const token = "tok-r9-0123456789abcdef0123456789abcdef";
  const check = (label: string, outputs: string[], log: string): void => {
    assert.ok(!outputs.join("").includes(token) && !log.includes(token), `${label}: the token is not shown or saved`);
    for (const chunk of outputs) assert.ok(!chunk.includes(token.slice(0, 12)), `${label}: no output chunk starts the token: ${JSON.stringify(chunk)}`);
    assert.ok(outputs.join("").includes("[hidden]") && log.includes("[hidden]"), `${label}: it is replaced where it was`);
  };
  const plain = makeRun({ runId: "r9-plain", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: true, crewTools: { ...CREW, token } });
  const proc = new FakeProc(), capture = captureCallbacks();
  const stamp = startRunnerRun(plain, "p", capture.callbacks, spawnReturning(proc));
  proc.stdout.emit("data", Buffer.from(`before ${token} after `));
  proc.stdout.emit("data", Buffer.from(`split ${token.slice(0, 10)}`));
  assert.ok(!capture.outputs.map((entry) => entry.text).join("").includes(token.slice(0, 10)), "the start of a token waits for the next write");
  proc.stdout.emit("data", Buffer.from(`${token.slice(10)} end `));
  proc.stderr.emit("data", Buffer.from(`err ${token.slice(0, 30)}`));
  proc.stderr.emit("data", Buffer.from(`${token.slice(30)} done`));
  proc.emit("close", 0);
  const shown = capture.outputs.map((entry) => entry.text).join("");
  check("plain", capture.outputs.map((entry) => entry.text), readFileSync(runArtifact(plain, stamp, "log"), "utf8"));
  assert.match(shown, /before \[hidden\] after split \[hidden\] end /, "the text around the token is kept, in order");
  assert.match(shown, /err \[hidden\] done/);
  // A Claude run: the token inside an assistant event, then an event whose JSON line is split across two writes.
  const claude = makeRun({ runId: "r9-claude", ...CLAUDE, canWrite: true, crewTools: { ...CREW, token } });
  const cproc = new FakeProc(), ccapture = captureCallbacks();
  const cstamp = startRunnerRun(claude, "p", ccapture.callbacks, spawnReturning(cproc));
  const event = (text: string) => JSON.stringify({ type: "assistant", message: { model: claude.model, content: [{ type: "text", text }] } });
  const line = event(`key ${token} end`);
  const cut = line.indexOf(token) + 20;
  cproc.stdout.emit("data", Buffer.from(event(`first ${token} second`) + "\n"));
  cproc.stdout.emit("data", Buffer.from(line.slice(0, cut)));
  cproc.stdout.emit("data", Buffer.from(line.slice(cut) + "\n"));
  cproc.emit("close", 0);
  check("claude", ccapture.outputs.map((entry) => entry.text), readFileSync(runArtifact(claude, cstamp, "log"), "utf8"));
  assert.match(ccapture.outputs.map((entry) => entry.text).join(""), /first \[hidden\] second\n/);
  // A run that ends inside the token: the start of it is hidden, not shown.
  const ended = makeRun({ runId: "r9-cut", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: true, crewTools: { ...CREW, token } });
  const p2 = new FakeProc(), c2 = captureCallbacks();
  const s2 = startRunnerRun(ended, "p", c2.callbacks, spawnReturning(p2));
  p2.stdout.emit("data", Buffer.from(`ends in ${token.slice(0, 25)}`));
  p2.emit("close", 0);
  assert.ok(!c2.outputs.map((entry) => entry.text).join("").includes(token.slice(0, 12)));
  assert.ok(!readFileSync(runArtifact(ended, s2, "log"), "utf8").includes(token.slice(0, 12)));
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

test("R6b: the MCP config of a released (unconfirmed-kill) run is deleted when its process really closes", () => {
  const proc = new FakeProc(), killer = new FakeProc();
  const started = spawnedRun(makeRun({ ...CLAUDE, runId: "r6b-released", canWrite: false, crewTools: CREW }), proc);
  const file = started.options.env.CC_MCP_CONFIG as string;
  runner.killRun("r6b-released", ((command: string) => (command === "taskkill" ? killer : proc)) as any);
  killer.emit("error", new Error("no taskkill"));
  assert.equal(runner.releaseUnconfirmedRun("r6b-released"), true);
  assert.equal(existsSync(file), true, "the process may still be alive: its config stays until it closes");
  proc.emit("close", 1);
  assert.equal(existsSync(file), false, "deleted at the real close");
});
