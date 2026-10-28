import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeCliOnPath, scratchDir, setEnv } from "./temp-root.ts";
import { resolveDataRoot } from "../server/data-root.ts";

// The modules read their data root at import, and the process tracker reads it again each time it writes its registry (a real launch below):
// for this whole file the root stays a fresh temp folder, never the repo's live config/ or logs/. The environment is put back when the file ends.
const isolatedData = scratchDir();
const restoreDataEnv = setEnv({ CC_DATA_DIR: isolatedData, CC_TEST_FORCE_PACKAGED: "1" });
const runner = await import("../server/runner.ts");
const leader = await import("../server/leader.ts");
const common = await import("../server/leader-common.ts");
fakeCliOnPath();
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4343;
}
function makeRun(overrides: Partial<import("../server/runner.ts").RunnerRun> = {}): import("../server/runner.ts").RunnerRun {
  return {
    runId: "p1-run", seatKey: "p1-tab.reviewer1", slotId: "reviewer1", name: "Vera", cli: "codex",
    model: "gpt-6-sol", effort: "high", folder: "C:/work/project", canWrite: false, startedAt: 100,
    ...overrides,
  };
}
function capture() {
  const statuses: Array<{ status: string; code?: number }> = [];
  const outputs: string[] = [];
  return {
    statuses, outputs,
    cb: {
      onOutput: (_run: unknown, text: string) => outputs.push(text),
      onStatus: (_run: unknown, status: string, code?: number) => statuses.push({ status, code }),
    } as import("../server/runner.ts").RunnerCallbacks,
  };
}
const fakeSpawn = (proc: FakeProc, calls: unknown[][] = []) => ((...args: unknown[]) => { calls.push(args); return proc; }) as unknown as typeof import("node:child_process").spawn;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(50);
}
const windowsOnly = { skip: process.platform !== "win32" ? "cmd.exe behaviour" : false };

// Files this test creates, removed one by one at the end (never a recursive delete).
const made: string[] = [];
const madeDirs: string[] = [];
function scratch(): string { const dir = mkdtempSync(join(tmpdir(), "cc-pack1-")); madeDirs.push(dir); return dir; }
function put(dir: string, name: string, text: string): string { const path = join(dir, name); writeFileSync(path, text); made.push(path); return path; }
test.after(() => {
  restoreDataEnv();
  for (const file of made) try { unlinkSync(file); } catch { /* already gone */ }
  for (const dir of madeDirs.reverse()) try { rmdirSync(dir); } catch { /* not empty: left for the OS temp cleaner */ }
});

test("A5: a codex.cmd planted in the tab folder is NOT run; the one found on PATH is", windowsOnly, async () => {
  const folder = scratch();
  const bin = scratch();
  put(folder, "codex.cmd", `@echo off\r\necho planted> "%~dp0PLANTED.txt"\r\n`);
  put(bin, "codex.cmd", `@echo off\r\necho real> "%~dp0real.txt"\r\n`);
  made.push(join(folder, "PLANTED.txt"), join(bin, "real.txt"));
  const oldPath = process.env.PATH;
  const oldFlag = process.env.NoDefaultCurrentDirectoryInExePath;
  delete process.env.NoDefaultCurrentDirectoryInExePath; // the shell running the tests may already set it
  process.env.PATH = `${bin}${delimiter}${oldPath}`;
  try {
    const { statuses, cb } = capture();
    const result = runner.runSeat(makeRun({ runId: "p1-a5-real", folder }), "go", cb);
    assert.equal(result.ok, true);
    await until(() => statuses.some((s) => s.status !== "working"), common.LIST_TIMEOUT_MS + common.KILL_TIMEOUT_MS + 1000 + 7000); // outlasts the runner's cleanup cap (SWEEP_WAIT_MS)
    assert.equal(existsSync(join(bin, "real.txt")), true, "the CLI found on PATH ran");
    assert.equal(existsSync(join(folder, "PLANTED.txt")), false, "the planted codex.cmd in the folder did not run");
  } finally { process.env.PATH = oldPath; if (oldFlag !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = oldFlag; }
});

test("A5: with no codex on PATH, a codex.cmd in the tab folder still does not run", windowsOnly, async () => {
  const folder = scratch();
  put(folder, "codex.cmd", `@echo off\r\necho planted> "%~dp0PLANTED.txt"\r\n`);
  made.push(join(folder, "PLANTED.txt"));
  const oldPath = process.env.PATH;
  const oldFlag = process.env.NoDefaultCurrentDirectoryInExePath;
  delete process.env.NoDefaultCurrentDirectoryInExePath; // the shell running the tests may already set it
  process.env.PATH = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  try {
    const { statuses, cb } = capture();
    const calls: unknown[][] = [];
    const result = runner.runSeat(makeRun({ runId: "p1-a5-none", folder }), "go", cb, fakeSpawn(new FakeProc(), calls));
    assert.deepEqual(result, { ok: false, error: "codex was not found on PATH" }, "no resolved CLI: the launch is refused");
    assert.equal(calls.length, 0, "nothing was spawned");
    assert.equal(statuses.length, 0);
    assert.equal(existsSync(join(folder, "PLANTED.txt")), false);
  } finally { process.env.PATH = oldPath; if (oldFlag !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = oldFlag; }
});

test("A5: resolveCliPath searches PATH only (not the cwd, not relative entries) and withResolvedCli quotes the absolute path", () => {
  const dir = scratch();
  const cwdDir = scratch();
  const cmd = put(dir, "codex.cmd", "@echo off\r\n");
  put(cwdDir, "codex.cmd", "@echo off\r\n");
  assert.equal(common.resolveCliPath("codex", { PATH: dir }), cmd);
  assert.equal(common.resolveCliPath("codex", { PATH: dir }, dir), null, "a PATH entry that is the run folder is skipped");
  assert.equal(common.resolveCliPath("codex", { PATH: "." }), null);
  assert.equal(common.resolveCliPath("codex", { PATH: "" }), null);
  assert.equal(common.resolveCliPath("codex", { Path: dir }), cmd, "the PATH key is found whatever its case");
  assert.equal(common.withResolvedCli("codex app-server", { PATH: dir }), `"${cmd}" app-server`);
  assert.throws(() => common.withResolvedCli("codex app-server", { PATH: "" }), /codex was not found on PATH/, "an unresolved CLI fails closed instead of falling back to the bare name");
  const inside = join(dir, "sub"); mkdirSync(inside, { recursive: true }); madeDirs.push(inside);
  put(inside, "codex.cmd", "@echo off\r\n");
  assert.equal(common.resolveCliPath("codex", { PATH: inside }, dir), null, "a PATH entry INSIDE the run folder is skipped too");
  assert.throws(() => common.withResolvedCli("codex app-server", { PATH: inside }, dir), (err: Error) => err.message === `codex was found only inside a project folder (${inside}), which is never used; install it outside your project folders or remove that project folder`, "found only inside a project folder: says so, names the PATH entry");
  assert.throws(() => common.withResolvedCli("codex app-server", { PATH: scratch() }, dir), (err: Error) => err.message === "codex was not found on PATH", "nothing found anywhere: the plain text");
  assert.equal(common.withResolvedCli("node server.js", { PATH: dir }), "node server.js");
  assert.equal(common.leaderChildEnv().NoDefaultCurrentDirectoryInExePath, "1");
});

test("A5: a PATH entry that is an 8.3 short alias of the run folder is skipped (identity, not spelling)", (t) => {
  const dir = scratch();
  put(dir, "codex.cmd", "@echo off\r\n");
  let short = "";
  try { short = execSync(`cmd /c for %I in ("${dir}") do @echo %~sI`, { encoding: "utf8" }).trim(); } catch { /* no cmd */ }
  if (!short || short.toLowerCase() === dir.toLowerCase()) { t.skip("8.3 short names are not available for this folder"); return; }
  assert.equal(common.resolveCliPath("codex", { PATH: short }, dir), null, "the short alias of the run folder is the run folder");
  assert.equal(common.isInsideFolder(join(short, "x"), dir), true);
  assert.equal(common.resolveCliPath("codex", { PATH: short }), join(short, "codex.cmd"), "without a run folder the alias still resolves");
});

test("A5: the Claude lookup returns only absolute paths and refuses a CLI inside the tab folder", () => {
  const dir = scratch(); const tab = scratch();
  const exe = put(dir, "claude.exe", "x");
  const planted = put(tab, "claude.exe", "x");
  const old = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(leader.resolveClaudeCli({ PATH: ".;tools" }, join(dir, "missing.exe")), null, "relative PATH entries are skipped");
    assert.equal(leader.resolveClaudeCli({ PATH: "." , CLAUDE_CLI_PATH: "claude.exe" }, "claude.exe"), null, "relative env and known paths are refused");
  } finally { process.chdir(old); }
  assert.equal(leader.resolveClaudeCli({ PATH: dir }, join(dir, "missing.exe")), exe);
  const seat = { model: "claude-opus-5-5[1m]", effort: "high" };
  assert.throws(() => leader.buildLeaderOptions(seat, tab, planted), /lies inside the tab folder/);
  assert.equal(leader.buildLeaderOptions(seat, tab, exe).pathToClaudeCodeExecutable, exe);
});

test("A5: a drive-relative or rooted-without-drive path is not fully qualified and never resolves a CLI", () => {
  for (const ok of ["C:\\a", "c:/a", "\\\\server\\share\\bin"]) assert.equal(common.isFullyQualified(ok), true, ok);
  for (const bad of ["\\Users\\admin\\.local\\bin", "/Users/admin", "C:bin", "\\\\server", "claude.exe", ""]) assert.equal(common.isFullyQualified(bad), false, bad);
  const dir = scratch(); put(dir, "codex.cmd", "@echo off\r\n");
  const rooted = dir.slice(2); // same folder without its drive letter
  assert.equal(common.resolveCliPath("codex", { PATH: rooted }), null, "a PATH entry without a drive letter is skipped");
  const exe = put(dir, "claude.exe", "x");
  assert.equal(leader.resolveClaudeCli({ PATH: rooted, CLAUDE_CLI_PATH: rooted + "\\claude.exe" }, rooted + "\\claude.exe"), null, "env, known and PATH lookups all refuse a drive-less path");
  assert.equal(leader.resolveClaudeCli({ PATH: dir }, "x:\\none"), exe);
});

test("A5: runSeat hands the shell an absolute CLI path and keeps the folder out of the search", () => {
  const bin = scratch();
  put(bin, "codex.cmd", "@echo off\r\n");
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const proc = new FakeProc(); const calls: unknown[][] = [];
    runner.runSeat(makeRun({ runId: "p1-a5-cmd" }), "x", capture().cb, fakeSpawn(proc, calls));
    assert.ok(String(calls[0][0]).startsWith(`"${join(bin, "codex.cmd")}" exec `), String(calls[0][0]));
    assert.equal((calls[0][1] as any).env.NoDefaultCurrentDirectoryInExePath, "1");
    proc.emit("close", 0);
  } finally { process.env.PATH = oldPath; }
});

test("A11: a read-only Claude worker also denies PowerShell and MultiEdit", () => {
  const command = runner.buildCommand(makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", effort: "high" }), "C:/logs/brief.txt");
  const denied = command.match(/--disallowedTools (\S+)/)?.[1].split(",") ?? [];
  for (const tool of ["Bash", "PowerShell", "Edit", "MultiEdit", "Write", "NotebookEdit"]) assert.ok(denied.includes(tool), `${tool} is denied`);
});

test("A2: no child gets CC_APP_KEY or a stray OpenCode password", () => {
  process.env.CC_APP_KEY = "k".repeat(64);
  process.env.OPENCODE_SERVER_PASSWORD = "stray";
  try {
    const proc = new FakeProc(); const calls: unknown[][] = [];
    runner.runSeat(makeRun({ runId: "p1-a2" }), "x", capture().cb, fakeSpawn(proc, calls));
    const runEnv = (calls[0][1] as any).env;
    assert.equal(Object.hasOwn(runEnv, "CC_APP_KEY"), false);
    assert.equal(Object.hasOwn(runEnv, "OPENCODE_SERVER_PASSWORD"), false);
    proc.emit("close", 0);
    assert.equal(Object.hasOwn(common.leaderChildEnv(), "CC_APP_KEY"), false);
    assert.equal(common.leaderChildEnv({ OPENCODE_SERVER_PASSWORD: "own" }).OPENCODE_SERVER_PASSWORD, "own", "the opencode server still gets its own password");
    assert.equal(Object.hasOwn(leader.buildLeaderOptions({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null).env, "CC_APP_KEY"), false);
    assert.equal(Object.hasOwn(leader.buildLeaderOptions({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null).env, "OPENCODE_SERVER_PASSWORD"), false, "the Claude leader strips the same names as every other leader");
  } finally { delete process.env.CC_APP_KEY; delete process.env.OPENCODE_SERVER_PASSWORD; }
});

test("stall: a read-only Codex run counts as able to write, so it is never relaunched by itself", () => {
  assert.equal(runner.canRunWrite(makeRun({ cli: "codex", canWrite: false })), true);
  assert.equal(runner.canRunWrite(makeRun({ cli: "claude", canWrite: false })), true);
});

test("B1: a state write that throws at launch still leaves the child tracked and stoppable", async () => {
  const proc = new FakeProc();
  const statuses: string[] = [];
  const cb = {
    onOutput: () => {},
    onStatus: (_run: unknown, status: string) => { statuses.push(status); if (status === "working") throw new Error("disk full"); },
  } as import("../server/runner.ts").RunnerCallbacks;
  const result = runner.runSeat(makeRun({ runId: "p1-b1-launch" }), "x", cb, fakeSpawn(proc));
  assert.equal(result.ok, true);
  assert.equal(runner.isRunning("p1-b1-launch"), true, "tracked, so Stop can reach it");
  proc.emit("close", 0);
  assert.deepEqual(statuses, ["working", "done"]);
  assert.equal(runner.isRunning("p1-b1-launch"), false);
});

test("B1: a failed log write does not leave the run working for ever", () => {
  const proc = new FakeProc();
  const { statuses, outputs, cb } = capture();
  runner.runSeat(makeRun({ runId: "p1-b1-log" }), "x", cb, fakeSpawn(proc));
  // Remove the exact files in the logs folder, then the folder itself: every log append now fails.
  const files = readdirSync(runner.logsDir).map((name) => join(runner.logsDir, name));
  for (const file of files) unlinkSync(file);
  rmdirSync(runner.logsDir);
  try {
    proc.stdout.emit("data", Buffer.from("hello"));
    proc.emit("close", 3);
  } finally { mkdirSync(runner.logsDir, { recursive: true }); }
  // The first failed write is said once on screen (not per line, not again for the exit marker); the output itself still arrives.
  assert.equal(outputs.length, 2, JSON.stringify(outputs));
  assert.match(outputs[0], /^\n\[log\] could not save this run's output to disk \(.+\); History will be missing it\n$/);
  assert.equal(outputs[1], "hello");
  assert.deepEqual(statuses.map((s) => s.status), ["working", "failed"]);
  assert.equal(runner.isRunning("p1-b1-log"), false);
});

test("B1: a run finishes when the process exits even if a grandchild keeps the pipes open", async () => {
  const proc = new FakeProc();
  const { statuses, cb } = capture();
  runner.runSeat(makeRun({ runId: "p1-b1-exit" }), "x", cb, fakeSpawn(proc));
  proc.stdout.emit("data", Buffer.from("tail"));
  proc.emit("exit", 0); // no "close" ever follows
  await until(() => statuses.some((s) => s.status === "done"), 3000);
  assert.deepEqual(statuses.map((s) => s.status), ["working", "done"]);
  assert.equal(runner.isRunning("p1-b1-exit"), false);
  proc.emit("close", 0); // a late close changes nothing
  assert.equal(statuses.length, 2);
});

test("the process tracker's registry goes to the isolated data root: the repo's own logs folder gets none from this file", () => {
  assert.equal(resolveDataRoot(process.env, repoRoot), isolatedData, "the data root the tracker resolves while the tests run is the temp folder");
  assert.equal(existsSync(join(repoRoot, "logs", `.children-${process.pid}.json`)), false, "no registry file of this process in the repo's logs folder");
});
