import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leader, common, windowsOnly, sleep, until, alive, killTree, made, madeDirs, tracked, remember, killSeen, scratch, put, HOLD_JS } from "./pack2-process-helpers.ts";

// ---- leaders ----
test("trackLeaderChild: a watched child's leftovers are swept when it exits; an unwatched one is not tracked at all", async () => {
  const watched: number[] = [], swept: number[] = [], slow: Array<boolean | undefined> = [];
  common.setProcessTreeForTests({ watch: (pid, _startedAt, isSlow) => { watched.push(pid); slow.push(isSlow); return { sweep: async (endedAt) => { swept.push(endedAt ?? -1); return 0; }, release() {} }; }, flushRegistry() {} });
  try {
    const a = new EventEmitter() as ChildProcess; (a as any).pid = 8001;
    const b = new EventEmitter() as ChildProcess; (b as any).pid = 8002;
    common.trackLeaderChild(a, true);
    common.trackLeaderChild(b);
    a.emit("exit", 0); b.emit("exit", 0);
    await sleep(20);
    assert.deepEqual(watched, [8001]);
    assert.deepEqual(slow, [true], "a leader child is a long-lived process: it is polled slowly");
    assert.equal(swept.length, 1);
    assert.ok(swept[0] > 0, "the sweep gets the time the child ended");
  } finally { common.setProcessTreeForTests(null); }
});

test("a leader whose root exits while a tracked descendant cannot be stopped stays running and failed, is said once, and a recheck clears it", async () => {
  const now = Date.now();
  const root = 8101, grand = 8102;
  const state = { list: [{ pid: root, ppid: 1, created: now }, { pid: grand, ppid: root, created: now + 10 }, { pid: process.pid, ppid: 1, created: 1 }] };
  let killWorks = false;
  const killed: number[] = [];
  common.setProcessTreeForTests(common.createTreeTracker({ list: async () => state.list, kill: async (pid) => { killed.push(pid); return killWorks; }, pollMs: 15 }));
  try {
    const child = Object.assign(new EventEmitter(), { pid: root, exitCode: null as number | null, signalCode: null }) as unknown as ChildProcess;
    let said = 0;
    common.trackLeaderChild(child, true, () => said++);
    await sleep(60); // the tracker has seen the descendant
    const before = common.leaderProcessState(child, false);
    assert.deepEqual({ running: before.running, killFailed: before.killFailed }, { running: true, killFailed: false });
    state.list = state.list.filter((proc) => proc.pid !== root); // the root is gone, its descendant is not
    (child as any).exitCode = 0; child.emit("exit", 0);
    assert.equal(common.leaderProcessState(child, false).running, true, "the sweep has not finished: the leader is not gone yet");
    assert.ok(await until(() => said === 1), "the failed descendant kill is reported");
    const stuck = common.leaderProcessState(child, false);
    assert.equal(stuck.running, true, "a descendant that could not be stopped keeps the leader running");
    assert.equal(stuck.killFailed, true);
    assert.ok(killed.includes(grand), "the descendant was tried");
    await stuck.recheck!();
    assert.equal(said, 1, "a retry that fails again is not said again");
    assert.equal(common.leaderProcessState(child, false).running, true, "still failing, still blocking");
    killWorks = true;
    await common.leaderProcessState(child, false).recheck!();
    const cleared = common.leaderProcessState(child, false);
    assert.equal(cleared.running, false, "once the descendant is stopped the leader is gone");
    assert.equal(cleared.killFailed, false);
  } finally { common.setProcessTreeForTests(null); }
});

test("a retried exit sweep keeps the time the root really exited, so a later process on its reused pid never has its children killed", async () => {
  const now = Date.now();
  const root = 8111, grand = 8112, stranger = 8113;
  const state = { list: [{ pid: root, ppid: 1, created: now - 100 }, { pid: grand, ppid: root, created: now - 50 }, { pid: process.pid, ppid: 1, created: 1 }] };
  const killed: number[] = [];
  common.setProcessTreeForTests(common.createTreeTracker({ list: async () => state.list, kill: async (pid) => { killed.push(pid); return false; }, pollMs: 15 }));
  try {
    const child = Object.assign(new EventEmitter(), { pid: root, exitCode: null as number | null, signalCode: null }) as unknown as ChildProcess;
    common.trackLeaderChild(child, true);
    await sleep(60);
    state.list = state.list.filter((proc) => proc.pid !== root);
    (child as any).exitCode = 0; child.emit("exit", 0);
    assert.ok(await until(() => killed.includes(grand)), "the first sweep tried the leftover");
    await sleep(30);
    // the root's pid is reused by a process that has since exited too, leaving a child that began after the real exit
    state.list = [...state.list, { pid: stranger, ppid: root, created: Date.now() }];
    await sleep(30);
    await common.leaderProcessState(child, false).recheck!();
    assert.equal(killed.includes(stranger), false, "a child created after the root really exited is not ours");
    assert.ok(killed.filter((pid) => pid === grand).length >= 2, "the original leftover is retried");
  } finally { common.setProcessTreeForTests(null); }
});

test("killProcessTree: a taskkill that cannot start falls back to kill(), and a kill that fails is reported", windowsOnly, async () => {
  const previous = process.env.SystemRoot;
  process.env.SystemRoot = join(tmpdir(), "cc-pack2-no-such-windows");
  try {
    for (const [sent, expectedReports] of [[true, 0], [false, 1]] as const) {
      const child = Object.assign(new EventEmitter(), { pid: 6001, exitCode: null, signalCode: null, kill: () => sent }) as unknown as ChildProcess;
      let reports = 0;
      common.killProcessTree(child, () => { reports++; });
      await sleep(300);
      assert.equal(reports, expectedReports, `kill() returned ${sent}`);
    }
    const gone = Object.assign(new EventEmitter(), { pid: 6002, exitCode: null, signalCode: "SIGTERM", kill: () => false }) as unknown as ChildProcess;
    let reports = 0;
    common.killProcessTree(gone, () => { reports++; });
    await sleep(300);
    assert.equal(reports, 0, "a child that already ended is not a failure");
  } finally { if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous; }
});

test("a drive or share root as a project folder blocks only the root itself, not every program on that drive", () => {
  assert.equal(common.isInsideFolder("C:\\Users\\x\\bin", "C:\\"), false);
  assert.equal(common.isInsideFolder("C:\\", "C:\\"), true);
  const dir = scratch("cc-pack2-cli-");
  put(dir, "codex.cmd", "@echo off\r\n");
  assert.equal(common.resolveCliPath("codex", { PATH: dir }, "C:\\"), join(dir, "codex.cmd"), "a CLI elsewhere on the drive is found for a drive-root tab");
  assert.equal(common.resolveCliPath("codex", { PATH: dir }, dir), null, "an ordinary folder still blocks what lies inside it");
  assert.equal(common.isInsideFolder(join(dir, "sub"), dir), true);
});

test("describeSpawnError names a missing folder only when the folder is really missing", () => {
  const enoent = Object.assign(new Error("spawn cmd.exe ENOENT"), { code: "ENOENT" });
  assert.equal(common.describeSpawnError(enoent, join(tmpdir(), "cc-pack2-missing-x")), `the tab folder no longer exists: ${join(tmpdir(), "cc-pack2-missing-x")}`);
  assert.equal(common.describeSpawnError(enoent, tmpdir()), "spawn cmd.exe ENOENT");
  assert.equal(common.describeSpawnError(new Error("EPERM"), join(tmpdir(), "cc-pack2-missing-x")), "EPERM");
  assert.equal(common.describeSpawnError(enoent), "spawn cmd.exe ENOENT");
});

test("the Codex and OpenCode leaders watch their real child's process tree, and never a fake child from a test", async () => {
  const watched: number[] = [];
  common.setProcessTreeForTests({ watch: (pid) => { watched.push(pid); return { sweep: async () => 0, release() {} }; }, flushRegistry() {} });
  const { createCodexLeader } = await import("../server/leader-codex.ts");
  const { createOpencodeLeader } = await import("../server/leader-opencode.ts");
  const folder = scratch("cc-pack2-leaders-");
  const cb = { onDelta() {}, onDone() {}, onUsage() {}, onError() {}, onStop() {} };
  const never = 2_147_483_000; // a pid that cannot exist: a stop of the fake child must not name a real process
  const fakeChild = () => Object.assign(new EventEmitter(), { pid: never, exitCode: null, signalCode: null, stdin: Object.assign(new EventEmitter(), { writable: false }), stdout: new EventEmitter(), stderr: Object.assign(new EventEmitter(), { resume() {} }), kill: () => true }) as any;
  const made: Array<{ stop: () => void }> = [];
  try {
    made.push(createCodexLeader({ model: "gpt-6-sol", effort: "high" }, folder, cb, { tools: [], mode: "accept", ask: async () => true, startTimeoutMs: 300 }));
    made.push(createOpencodeLeader({ model: "fakeprov/fake-model", effort: "max" }, folder, cb, { bridge: { url: "http://127.0.0.1:1/mcp", token: "t" }, mode: "accept", ask: async () => true, startTimeoutMs: 300 }));
    assert.ok(await until(() => watched.length === 2, 5000), `both real children were watched: ${watched}`);
    watched.length = 0;
    made.push(createCodexLeader({ model: "gpt-6-sol", effort: "high" }, folder, cb, { tools: [], mode: "accept", ask: async () => true, startTimeoutMs: 300, spawnFn: () => fakeChild() }));
    made.push(createOpencodeLeader({ model: "fakeprov/fake-model", effort: "max" }, folder, cb, { bridge: { url: "http://127.0.0.1:1/mcp", token: "t" }, mode: "accept", ask: async () => true, startTimeoutMs: 300, spawnFn: () => fakeChild(), pickPort: async () => 1 }));
    await sleep(500);
    assert.deepEqual(watched, [], "a fake child has a made-up pid: it is not watched");
  } finally { for (const leaderHandle of made) leaderHandle.stop(); common.setProcessTreeForTests(null); await sleep(300); }
});

// ---- the Claude leader ----
test("resolveClaudeCli: npm's extensionless shim is never chosen; the real claude.exe beside it is", () => {
  const npm = scratch("cc-pack2-npm-");
  put(npm, "claude", "#!/bin/sh\n"); put(npm, "claude.cmd", "@echo off\r\n"); put(npm, "claude.ps1", "x");
  assert.equal(leader.resolveClaudeCli({ PATH: npm }, join(npm, "missing.exe")), null, "only shims: degraded, not a script the SDK cannot start");
  const pkg = join(npm, "node_modules", "@anthropic-ai", "claude-code", "bin");
  mkdirSync(pkg, { recursive: true }); madeDirs.push(join(npm, "node_modules"), join(npm, "node_modules", "@anthropic-ai"), join(npm, "node_modules", "@anthropic-ai", "claude-code"), pkg);
  const exe = put(pkg, "claude.exe", "x");
  assert.equal(leader.resolveClaudeCli({ PATH: npm }, join(npm, "missing.exe")), exe);
  assert.equal(leader.resolveClaudeCli({ PATH: "", CLAUDE_CLI_PATH: npm }, join(npm, "missing.exe")), exe, "an install folder named in the environment works the same way");
});

test("Claude leader: a question tool is declined without a card; approvals still ask; the SDK spawns through the tracked spawn", async () => {
  const asked: string[] = [];
  const options = leader.buildLeaderOptions({ model: "fake", effort: "medium" }, ".", null, undefined, "ask", async (tool) => { asked.push(tool); return true; });
  const question: any = await options.canUseTool!("AskUserQuestion", { questions: [{ question: "A or B?" }] }, { signal: new AbortController().signal, toolUseID: "q" } as any);
  assert.equal(question.behavior, "deny");
  assert.match(question.message, /Decide yourself/);
  assert.deepEqual(asked, [], "no approval card for a question");
  const edit: any = await options.canUseTool!("Write", { file_path: "x" }, { signal: new AbortController().signal, toolUseID: "w" } as any);
  assert.equal(edit.behavior, "allow");
  assert.deepEqual(asked, ["Write"]);
  assert.equal(options.spawnClaudeCodeProcess, common.spawnTrackedClaude);
});

test("Claude leader: in a Plan tab an approved ExitPlanMode does not turn later edits into silent ones", async () => {
  const run = async (mode: "plan" | "accept", live: string, holdsPlan?: () => boolean) => {
    const asked: string[] = [];
    const options = leader.buildLeaderOptions({ model: "fake", effort: "medium" }, ".", null, undefined, mode, async (tool) => { asked.push(tool); return true; }, () => false, () => {}, holdsPlan);
    const result: any = await options.hooks!.PreToolUse![0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "x" }, tool_use_id: "id", permission_mode: live, session_id: "s", transcript_path: "x", cwd: "." } as any, "id", { signal: new AbortController().signal });
    return { asked, result };
  };
  assert.deepEqual((await run("plan", "acceptEdits")).asked, ["Edit"], "a Plan tab whose live mode left plan asks before the edit");
  assert.deepEqual(await run("accept", "acceptEdits"), { asked: [], result: {} }, "an Accept tab is unaffected");
  assert.deepEqual((await run("accept", "acceptEdits", () => true)).asked, ["Edit"], "the leader reports a tab switched to Plan live");
});

test("Claude leader: a tab switched to Plan while running asks before edits once ExitPlanMode has put the live mode back", async () => {
  let optionsSeen: any;
  let release!: () => void;
  const held = new Promise<void>((ok) => { release = ok; });
  const handle: any = { async *[Symbol.asyncIterator]() { await held; }, setPermissionMode: async () => {}, setModel: async () => {}, return: async () => ({ done: true, value: undefined }) };
  const asked: string[] = [];
  const created = leader.createLeader({ model: "fake", effort: "medium" }, ".", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {} }, undefined, "accept", async (tool) => { asked.push(tool); return true; }, ((args: any) => { optionsSeen = args.options; return handle; }) as any);
  const edit = (live: string) => optionsSeen.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "x" }, tool_use_id: "id", permission_mode: live, session_id: "s", transcript_path: "x", cwd: "." }, "id", { signal: new AbortController().signal });
  await edit("acceptEdits");
  assert.deepEqual(asked, [], "an Accept tab edits without asking");
  assert.equal(await created.setPermissionMode("plan"), true);
  await edit("acceptEdits"); // the model called ExitPlanMode, the live mode is back to what it was before
  assert.deepEqual(asked, ["Edit"], "the tab is meant to be in Plan, so the edit asks");
  assert.equal(await created.setPermissionMode("accept"), true);
  await edit("acceptEdits");
  assert.deepEqual(asked, ["Edit"], "switching back to Accept stops the asking");
  created.stop();
  release();
});

test("Claude leader: a model or mode change that fails reports false and never ends the running answer", async () => {
  const errors: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((ok) => { release = ok; });
  const fakeQuery = (() => {
    const handle: any = {
      async *[Symbol.asyncIterator]() { await held; },
      setModel: async () => { throw new Error("cli said no"); },
      setPermissionMode: async () => { throw new Error("cli said no"); },
      return: async () => ({ done: true, value: undefined }),
    };
    return handle;
  }) as any;
  const created = leader.createLeader({ model: "fake", effort: "medium" }, ".", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (message: string) => errors.push(message) }, undefined, "accept", undefined, fakeQuery);
  assert.equal(await created.setModel("other"), false);
  assert.equal(await created.setPermissionMode("plan"), false);
  assert.deepEqual(errors, [], "the caller reports the failed change; an onError here would end a turn that is not this change's");
  created.stop();
  release();
});

test("the SDK is given a spawn that stops claude.exe's whole tree on abort, including a grandchild", windowsOnly, async () => {
  const grandchildJs = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log("grand=" + c.pid); setInterval(() => {}, 1000);`;
  const controller = new AbortController();
  const child = common.spawnTrackedClaude({ command: process.execPath, args: ["-e", grandchildJs], env: { ...process.env }, signal: controller.signal });
  let out = ""; child.stdout!.on("data", (d) => { out += d; });
  let grand = 0;
  try {
    await remember(child.pid!);
    assert.ok(await until(() => /grand=\d+/.test(out)), `the leader process started a child: ${out}`);
    grand = Number(/grand=(\d+)/.exec(out)![1]);
    await remember(grand);
    assert.ok(alive(grand));
    controller.abort();
    assert.ok(await until(() => !alive(child.pid!) && !alive(grand), 10_000), `abort ended the leader and its child (leader alive=${alive(child.pid!)}, grandchild alive=${alive(grand)})`);
  } finally {
    // A failed step above must not leave these running (they hold the test file's pipes): the tree of the child this test spawned, then the grandchild its output named.
    if (child.exitCode === null && child.signalCode === null) killTree(child.pid!);
    if (grand) await killSeen(tracked.filter((entry) => entry.pid === grand)); // only if its creation time was recorded: never a bare pid
  }
});

test("the Claude leader reports a kill it could not confirm, and says its process is still running until it exits", windowsOnly, async () => {
  const notices: string[] = [];
  const previous = { fake: process.env.CC_TEST_FAKE_CLI, killer: process.env.CC_TEST_KILLER_EXIT };
  process.env.CC_TEST_FAKE_CLI = "1"; process.env.CC_TEST_KILLER_EXIT = "1"; // the kill goes through a fake killer that fails
  let spawned: ChildProcess | undefined;
  const fakeQuery = ((args: any) => {
    spawned = args.options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: { ...process.env }, signal: args.options.abortController.signal });
    return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; }, return: async () => ({ done: true }), setModel: async () => {}, setPermissionMode: async () => {} };
  }) as any;
  try {
    const created = leader.createLeader({ model: "fake", effort: "medium" }, ".", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {}, onNotice: (message: string) => notices.push(message) }, undefined, "accept", undefined, fakeQuery);
    await remember(spawned!.pid!);
    const flags = () => { const { running, killFailed } = created.process(); return { running, killFailed }; };
    assert.deepEqual(flags(), { running: true, killFailed: false });
    created.stop();
    assert.ok(await until(() => notices.length === 1), "the failed kill is reported");
    assert.match(notices[0], /Could not confirm the old Claude leader stopped/);
    assert.deepEqual(flags(), { running: true, killFailed: true });
    killTree(spawned!.pid!);
    assert.ok(await until(() => !created.process().running), "once the process exits it no longer blocks anything");
  } finally {
    if (spawned && spawned.exitCode === null && spawned.signalCode === null) killTree(spawned.pid!);
    if (previous.fake === undefined) delete process.env.CC_TEST_FAKE_CLI; else process.env.CC_TEST_FAKE_CLI = previous.fake;
    if (previous.killer === undefined) delete process.env.CC_TEST_KILLER_EXIT; else process.env.CC_TEST_KILLER_EXIT = previous.killer;
  }
});

test("when the leader's CLI exits on its own, what it started is stopped too", windowsOnly, async () => {
  // A cmd.exe stands in for claude.exe: it starts a background process and ends, the way a native program that is not a Node program does
  // (a Node parent would take its own children with it when it exits, which is not the case being tested).
  const bin = scratch("cc-pack2-lead-");
  assert.ok(!/\s/.test(bin), `the temp folder name has no spaces: ${bin}`);
  put(bin, "hold.js", HOLD_JS);
  const pidFile = join(bin, "lead.pid"); made.push(pidFile);
  const goFile = join(bin, "lead.go"); made.push(goFile);
  // The stand-in ends only when the test says so (or after about a minute): a fixed pause let a busy machine run it out before the test looked.
  const lead = put(bin, "lead.cmd", `@echo off

start "" /b "${process.execPath}" "%~dp0hold.js" "%~dp0lead.pid"

for /l %%i in (1,1,60) do if not exist "%~dp0lead.go" ping -n 2 127.0.0.1 >nul

exit /b 0

`);
  const child = common.spawnTrackedClaude({ command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", lead], env: { ...process.env }, signal: new AbortController().signal });
  try {
    await remember(child.pid!);
    assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0));
    const held = Number(readFileSync(pidFile, "utf8"));
    await remember(held);
    assert.ok(alive(held));
    writeFileSync(goFile, "go");
    assert.ok(await until(() => !alive(child.pid!), 8000), "the leader process ended by itself");
    assert.ok(await until(() => !alive(held), 15_000), "what it had started was stopped after it");
  } finally {
    if (child.exitCode === null && child.signalCode === null) killTree(child.pid!);
  }
});
