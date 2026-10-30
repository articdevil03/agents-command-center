import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runner, common, windowsOnly, sleep, until, END_WAIT_MS, alive, killTree, made, madeDirs, tracked, remember, killSeen, scratch, put, HOLD_JS } from "./pack2-process-helpers.ts";

// ---- a worker run, end to end through the real runner ----
function fakeCliDir(script: string, name = "codex"): { dir: string; bin: string } {
  const bin = scratch("cc-pack2-bin-");
  put(bin, `${name}.cmd`, script);
  return { dir: scratch("cc-pack2-work-"), bin };
}

function withPath<T>(bin: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
  return work().finally(() => { process.env.PATH = previous; });
}

function makeRun(folder: string, overrides: Record<string, unknown> = {}) {
  return { runId: "p2-run", seatKey: "p2-tab.coder", slotId: "coder", name: "Sonny", cli: "codex", model: "gpt-6-sol", effort: "high", folder, canWrite: true, startedAt: 100, ...overrides } as import("../server/runner.ts").RunnerRun;
}

function capture() {
  const statuses: Array<{ status: string; code?: number }> = [], outputs: string[] = [];
  return { statuses, outputs, cb: { onOutput: (_run: unknown, text: string) => outputs.push(text), onStatus: (_run: unknown, status: string, code?: number) => statuses.push({ status, code }) } as import("../server/runner.ts").RunnerCallbacks };
}

test("a background process the CLI leaves behind is stopped when the run ends, and the log says so", windowsOnly, async () => {
  const { dir, bin } = fakeCliDir(`@echo off\r\nstart "" /b "${process.execPath}" "%~dp0hold.js" "%~dp0hold.pid"\r\nping -n 3 127.0.0.1 >nul\r\nexit /b 0\r\n`);
  put(bin, "hold.js", HOLD_JS);
  const pidFile = join(bin, "hold.pid"); made.push(pidFile);
  const c = capture();
  await withPath(bin, async () => {
    const started = runner.runSeat(makeRun(dir, { runId: "p2-leftover" }), "go", c.cb, spawn);
    assert.equal(started.ok, true);
    assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0), "the fake CLI started its background process");
    const held = Number(readFileSync(pidFile, "utf8"));
    await remember(held);
    assert.ok(alive(held));
    assert.ok(await until(() => c.statuses.some((entry) => entry.status !== "working"), END_WAIT_MS), `the run ended: ${c.statuses.map((s) => s.status)}`);
    const outs = c.outputs.join("");
    assert.equal(c.statuses.at(-1)?.status, "done", `output: ${outs}`);
    // The runner prints this one line for three causes: the report cap (SWEEP_WAIT_MS in server/runner.ts), a process list that could not be read, or a sweep that threw. It never tells them apart, and "unchecked" is never a pass.
    if (/could not check for processes this run left running/.test(outs)) {
      const late = await until(() => !alive(held), END_WAIT_MS); // a sweep that was only capped keeps going after the report
      if (!late) killTree(held); // the leftover is stopped here, not left holding the test file's pipes
      assert.fail(`the cleanup of leftover processes was NOT checked (the report cap SWEEP_WAIT_MS, an unreadable process list, or a failed sweep); the leftover was ${late ? "stopped afterwards" : "STILL ALIVE after the cleanup allowance"}. output: ${c.outputs.join("")}`);
    }
    assert.equal(alive(held), false, `the leftover process was stopped before the run was reported over. output: ${outs}`);
    assert.match(outs, /\[cleanup\] stopped 1 process this run left running/);
  });
});

// The process list is slowed (or made unreadable) through the tree seam; the real runner, real tracker and a real leftover process run as usual.
async function runWithLeftover(runId: string, seam: Record<string, unknown>) {
  const { dir, bin } = fakeCliDir(`@echo off\r\nstart "" /b "${process.execPath}" "%~dp0hold.js" "%~dp0hold.pid"\r\nping -n 3 127.0.0.1 >nul\r\nexit /b 0\r\n`);
  put(bin, "hold.js", HOLD_JS);
  const pidFile = join(bin, "hold.pid"); made.push(pidFile);
  const seamFile = put(bin, "tree.json", JSON.stringify({ extra: [], failKill: [], ...seam }));
  made.push(`${seamFile}.kills`);
  const previous = { fake: process.env.CC_TEST_FAKE_CLI, tree: process.env.CC_TEST_TREE_FILE };
  process.env.CC_TEST_FAKE_CLI = "1"; process.env.CC_TEST_TREE_FILE = seamFile;
  const c = capture();
  try {
    return await withPath(bin, async () => {
      assert.equal(runner.runSeat(makeRun(dir, { runId }), "go", c.cb, spawn).ok, true);
      assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0), "the fake CLI started its background process");
      const held = Number(readFileSync(pidFile, "utf8"));
      await remember(held);
      assert.ok(await until(() => c.statuses.some((entry) => entry.status !== "working"), END_WAIT_MS), `the run ended: ${c.statuses.map((s) => s.status)}`);
      const aliveAtReport = alive(held);
      if (aliveAtReport) killTree(held); // the failing-list case leaves it running: stopped here, not left for teardown
      return { outs: c.outputs.join(""), status: c.statuses.at(-1)?.status, aliveAtReport };
    });
  } finally {
    if (previous.fake === undefined) delete process.env.CC_TEST_FAKE_CLI; else process.env.CC_TEST_FAKE_CLI = previous.fake;
    if (previous.tree === undefined) delete process.env.CC_TEST_TREE_FILE; else process.env.CC_TEST_TREE_FILE = previous.tree;
  }
}

test("a slow process list (longer than the old 4 s cap) still ends with the leftover stopped and no 'could not check'", windowsOnly, async () => {
  const r = await runWithLeftover("p2-slowlist", { listDelayMs: 5000 });
  assert.equal(r.status, "done", `output: ${r.outs}`);
  assert.doesNotMatch(r.outs, /could not check/, r.outs);
  assert.match(r.outs, /\[cleanup\] stopped 1 process this run left running/);
  assert.equal(r.aliveAtReport, false, "the leftover was dead when the run was reported over");
});

test("a process list that cannot be read still says 'could not check' (the branch is kept)", windowsOnly, async () => {
  const r = await runWithLeftover("p2-faillist", { failList: true });
  assert.equal(r.status, "done", `output: ${r.outs}`);
  assert.match(r.outs, /\[cleanup\] could not check for processes this run left running/);
});

test("stopping a run kills the shell wrapper, the CLI and what it started", windowsOnly, async () => {
  const { dir, bin } = fakeCliDir(`@echo off\r\nstart "" /b "${process.execPath}" "%~dp0hold.js" "%~dp0hold2.pid"\r\nping -n 60 127.0.0.1 >nul\r\n`);
  put(bin, "hold.js", HOLD_JS);
  const pidFile = join(bin, "hold2.pid"); made.push(pidFile);
  const c = capture();
  await withPath(bin, async () => {
    assert.equal(runner.runSeat(makeRun(dir, { runId: "p2-stop" }), "go", c.cb, spawn).ok, true);
    assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0));
    const held = Number(readFileSync(pidFile, "utf8"));
    await remember(held);
    assert.equal(runner.killRun("p2-stop"), true);
    assert.ok(await until(() => c.statuses.some((entry) => entry.status === "stopped"), END_WAIT_MS), `stopped: ${JSON.stringify(c.statuses)}`);
    assert.equal(alive(held), false, "the background process died with the run");
  });
});

test("killRun starts the real System32 taskkill even when the server's own folder holds a decoy", windowsOnly, async () => {
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const decoyDir = scratch("cc-pack2-decoy-");
  const decoy = join(decoyDir, "taskkill.exe");
  copyFileSync(join(system32, "whoami.exe"), decoy); made.push(decoy);
  const { dir, bin } = fakeCliDir(`@echo off\r\nping -n 60 127.0.0.1 >nul\r\n`);
  const c = capture();
  const before = process.cwd();
  await withPath(bin, async () => {
    assert.equal(runner.runSeat(makeRun(dir, { runId: "p2-decoy" }), "go", c.cb, spawn).ok, true);
    await sleep(500);
    process.chdir(decoyDir); // the folder a server started from
    try {
      assert.equal(runner.killRun("p2-decoy"), true);
      assert.ok(await until(() => c.statuses.some((entry) => entry.status === "stopped"), END_WAIT_MS), `the real taskkill ran: ${JSON.stringify(c.statuses)}`);
    } finally {
      process.chdir(before);
      if (!c.statuses.some((entry) => entry.status === "stopped")) runner.killRun("p2-decoy"); // a failed run must not leave its process behind
    }
  });
});

test("Stop all also sweeps what a released (unconfirmed) run left behind", windowsOnly, async () => {
  const { dir, bin } = fakeCliDir(`@echo off

ping -n 40 127.0.0.1 >nul

`);
  const sweeps: number[] = [];
  common.setProcessTreeForTests({ watch: () => ({ sweep: async (endedAt) => { sweeps.push(endedAt ?? -1); return 0; }, release() {} }), flushRegistry() {} });
  const killer = Object.assign(new EventEmitter(), { pid: 1 });
  const fakeKill = (() => killer) as any;
  let pid = 0;
  try {
    await withPath(bin, async () => {
      assert.equal(runner.runSeat(makeRun(dir, { runId: "p2-released" }), "go", capture().cb, spawn).ok, true);
      await sleep(400);
      runner.killRun("p2-released", fakeKill);
      killer.emit("error", new Error("taskkill could not start")); // the kill is unconfirmed, so the run can be released
      pid = runner.unconfirmedPid("p2-released")!;
      assert.ok(pid > 0);
      await remember(pid);
      assert.equal(runner.releaseUnconfirmedRun("p2-released"), true);
      assert.equal(sweeps.length, 0);
      runner.stopAllRunning(fakeKill);
      assert.equal(sweeps.length, 1, "Stop all asked for the released run's leftovers to be swept too");
    });
  } finally { if (pid) await killSeen(tracked.filter((entry) => entry.pid === pid)); common.setProcessTreeForTests(null); await sleep(300); }
});

test("a tab folder with ( ) & ^ and % in its name, and a drive root, reach OpenCode intact", windowsOnly, async () => {
  const { bin } = fakeCliDir("", "opencode");
  put(bin, "opencode.cmd", `@echo off\r\n"${process.execPath}" "%~dp0argv.js" %*\r\n`);
  put(bin, "argv.js", `require("node:fs").writeFileSync(require("node:path").join(__dirname, "argv-" + process.env.CC_TEST_TAG + ".json"), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));`);
  const parent = scratch("cc-pack2-odd-");
  const odd = join(parent, "p%PATH%x (v2) & ^caret");
  mkdirSync(odd);
  madeDirs.push(odd);
  const cases: Array<[string, string]> = [["odd", odd], ["root", "C:\\"]];
  for (const [tag, folder] of cases) {
    const out = join(bin, `argv-${tag}.json`); made.push(out);
    process.env.CC_TEST_TAG = tag;
    const c = capture();
    await withPath(bin, async () => {
      const result = runner.runSeat(makeRun(folder, { runId: `p2-odd-${tag}`, cli: "opencode", model: "provider/model-v1", effort: "max" }), "go", c.cb, spawn);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(await until(() => c.statuses.some((entry) => entry.status !== "working"), END_WAIT_MS), `ran: ${c.outputs.join("")}`);
      assert.equal(c.statuses.at(-1)?.status, "done", c.outputs.join(""));
    });
    const seen = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(seen.argv[0], "run");
    assert.equal(seen.argv[seen.argv.indexOf("--dir") + 1], folder, `${tag}: --dir arrives exactly as the folder`);
    assert.equal(seen.cwd.toLowerCase().replace(/\\+$/, ""), folder.toLowerCase().replace(/\\+$/, ""));
    assert.match(seen.argv.at(-1), /^Read the file at .*\.brief\.txt and follow it exactly as your instructions\.$/);
  }
  delete process.env.CC_TEST_TAG;
});

// ---- the run's end is reported through the real call site, with a fake tracker ----
class FakeChild extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); pid = 4545;
}

test("runSeat: the status waits for the sweep, a cleanup line names what was stopped, and a sweep that cannot check says so but never blocks or changes the report", async () => {
  const dir = scratch("cc-pack2-fake-");
  const calls: Array<{ pid: number; startedAt?: number; slow?: boolean }> = [];
  const sweeps: Array<{ endedAt?: number; release: (value: number | null) => void }> = [];
  common.setProcessTreeForTests({
    watch: (pid, startedAt, slow) => { calls.push({ pid, startedAt, slow }); return { sweep: (endedAt) => new Promise<number | null>((resolve, reject) => { sweeps.push({ endedAt, release: (value) => (value === -1 ? reject(new Error("list failed")) : resolve(value)) }); }), release() {} }; },
    flushRegistry() {},
  });
  try {
    const bin = scratch("cc-pack2-bin-"); put(bin, "codex.cmd", "@echo off\r\n");
    await withPath(bin, async () => {
      const STOPPED = /\[cleanup\] stopped 3 processes/, UNCHECKED = /\[cleanup\] could not check for processes this run left running/;
      // 3 = three stopped; -1 = the check rejects; null = no process list; "cap" = the sweep never answers, so the runner's cap (SWEEP_WAIT_MS) wins
      for (const [id, outcome] of [["p2-fake-a", 3], ["p2-fake-b", -1], ["p2-fake-c", null], ["p2-fake-d", "cap"]] as const) {
        const c = capture();
        runner.runSeat(makeRun(dir, { runId: id }), "x", c.cb, spawn);
        assert.equal(calls.at(-1)?.startedAt !== undefined, true, "a real child is watched from its start");
        assert.notEqual(calls.at(-1)?.slow, true, "a worker run needs the fast poll");
        assert.ok(await until(() => sweeps.length > 0 && sweeps.at(-1)!.endedAt !== undefined, 15_000), "the end of the run asks for a sweep");
        const sweep = sweeps.at(-1)!;
        assert.ok(sweep.endedAt! > calls.at(-1)!.startedAt! - 1, "the sweep is told when the process ended");
        await sleep(100);
        assert.deepEqual(c.statuses.map((entry) => entry.status), ["working"], "not reported over while the sweep is still running");
        if (outcome !== "cap") sweep.release(outcome);
        assert.ok(await until(() => c.statuses.length === 2, END_WAIT_MS), "reported once the sweep answered (or the cap won)");
        const log = c.outputs.join("");
        assert.equal(STOPPED.test(log), outcome === 3, `${id}: the stopped line only when processes were stopped`);
        assert.equal(UNCHECKED.test(log), outcome !== 3, `${id}: a check that could not finish is said in the log`);
        assert.equal(c.statuses.at(-1)?.status, "done", `${id}: the run's own outcome is kept`);
        sweeps.length = 0;
      }
    });
  } finally { common.setProcessTreeForTests(null); }
});

test("runSeat: a leftover process that could not be stopped is said in the output and log, next to the ones that were stopped", async () => {
  const dir = scratch("cc-pack2-failkill-");
  const state = { list: null as Array<{ pid: number; ppid: number; created: number }> | null };
  const killed: number[] = [];
  let rootPid = 0;
  // The real tracker with a fake process list: the root and one leftover child are alive after the run; only the root can be stopped.
  const tracker = common.createTreeTracker({ list: async () => state.list, kill: async (pid) => { killed.push(pid); return pid === rootPid; }, pollMs: 15 });
  common.setProcessTreeForTests({
    watch: (pid, startedAt, slow) => { rootPid = pid; state.list = [{ pid, ppid: 1, created: startedAt! }, { pid: 987654, ppid: pid, created: startedAt! + 10 }, { pid: process.pid, ppid: 1, created: 1 }]; return tracker.watch(pid, startedAt, slow); },
    flushRegistry() {},
  });
  try {
    const bin = scratch("cc-pack2-bin-"); put(bin, "codex.cmd", "@echo off\r\n");
    await withPath(bin, async () => {
      const c = capture();
      runner.runSeat(makeRun(dir, { runId: "p2-failkill", seatKey: "p2-failkill-tab.coder" }), "x", c.cb, spawn);
      assert.ok(await until(() => c.statuses.length === 2, END_WAIT_MS), "the run is reported over");
      const log = c.outputs.join("");
      assert.ok(killed.includes(987654), "the leftover child was tried");
      assert.match(log, /\[cleanup\] stopped 1 process this run left running/);
      assert.match(log, /\[cleanup\] could not stop 1 process this run left running/, "a leftover that stays alive is never a silent Done");
      // History reads the saved file, not the live output: the same line must be on disk.
      const saved = readdirSync(runner.logsDir).filter((name) => name.startsWith("p2-failkill-tab.coder-"));
      for (const name of saved) made.push(join(runner.logsDir, name));
      const logFiles = saved.filter((name) => name.endsWith(".log"));
      assert.equal(logFiles.length, 1, `this run's saved log: ${saved}`);
      assert.match(readFileSync(join(runner.logsDir, logFiles[0]), "utf8"), /\[cleanup\] could not stop 1 process this run left running/, "the saved run log carries the cleanup warning");
    });
  } finally { common.setProcessTreeForTests(null); }
});

test("runSeat: a fake process (tests) is never watched, so its made-up pid cannot name a real process", async () => {
  let watched = 0;
  common.setProcessTreeForTests({ watch: () => { watched++; return { sweep: async () => 0, release() {} }; }, flushRegistry() {} });
  try {
    const proc = Object.assign(new EventEmitter(), { pid: 4343, stdout: new EventEmitter(), stderr: new EventEmitter() });
    const c = capture();
    runner.runSeat(makeRun("C:/work/project", { runId: "p2-nowatch" }), "x", c.cb, (() => proc) as any);
    proc.emit("close", 0);
    assert.equal(watched, 0);
    assert.deepEqual(c.statuses.map((entry) => entry.status), ["working", "done"], "and the report is immediate");
  } finally { common.setProcessTreeForTests(null); }
});

test("runSeat: a process that closes without an exit code is a failed run, not a failed spawn; a spawn error for a missing folder names the folder", () => {
  const proc = Object.assign(new EventEmitter(), { pid: 4344, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const c = capture();
  runner.runSeat(makeRun("C:/work/project", { runId: "p2-nullcode" }), "x", c.cb, (() => proc) as any);
  proc.emit("close", null);
  assert.deepEqual(c.statuses.at(-1), { status: "failed", code: -1 }, "killed from outside: an exit code, so the page does not say 'spawn error'");
  const missing = join(tmpdir(), "cc-pack2-never-created-folder");
  for (const [folder, expected] of [[missing, `the tab folder no longer exists: ${missing}`], [tmpdir(), "spawn cmd.exe ENOENT"]] as const) {
    const bad = Object.assign(new EventEmitter(), { pid: 4346, stdout: new EventEmitter(), stderr: new EventEmitter() });
    const d = capture();
    runner.runSeat(makeRun(folder, { runId: "p2-enoent" }), "x", d.cb, (() => bad) as any);
    bad.emit("error", Object.assign(new Error("spawn cmd.exe ENOENT"), { code: "ENOENT" }));
    assert.deepEqual(d.statuses.at(-1), { status: "failed", code: undefined });
    assert.ok(d.outputs.join("").includes(`[spawn error] ${expected}`), d.outputs.join(""));
  }
});

test("killRun and Stop all start taskkill without a shell, from System32", () => {
  const proc = Object.assign(new EventEmitter(), { pid: 4347, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const calls: unknown[][] = [];
  const killer = Object.assign(new EventEmitter(), { pid: 1 });
  runner.runSeat(makeRun("C:/work/project", { runId: "p2-kill-shape" }), "x", capture().cb, (() => proc) as any);
  runner.killRun("p2-kill-shape", ((...args: unknown[]) => { calls.push(args); return killer; }) as any);
  runner.stopAllRunning(((...args: unknown[]) => { calls.push(args); return killer; }) as any);
  proc.emit("close", 1);
  assert.ok(calls.length >= 1);
  const mine = (calls as Array<[string, string[], Record<string, unknown>]>).filter(([, args]) => args[1] === "4347");
  assert.ok(mine.length >= 2, "both paths killed this run");
  for (const [command, args, options] of mine) {
    assert.equal(command, "taskkill");
    assert.deepEqual(args, ["/pid", "4347", "/T", "/F"]);
    assert.equal(options.shell, undefined, "no shell: an args array with a shell is deprecated (DEP0190) and re-parsed");
    assert.equal(String(options.cwd).toLowerCase(), join(process.env.SystemRoot ?? "C:\\Windows", "System32").toLowerCase(), "looked up in System32, not the server's folder");
  }
});
