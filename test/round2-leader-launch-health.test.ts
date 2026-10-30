import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, rmdirSync, utimesSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { tempRoot } from "./temp-root.ts";
import { config, leaderApi } from "./round2-setup.ts";
import { loadServer, loadRunnerHarness, connect, lastState, tick } from "./round2-helpers.ts";

test("leaderLaunchSeat: the durable launch brake includes manual and leader starts and stops at its limit", async () => {
  const server = await loadServer({ skipHealth: true });
  for (let i = 0; i < 7; i++) assert.equal(server.launchWorker("alpha-dev", "reviewer2", `manual ${i}`).ok, true);
  assert.equal(server.leaderLaunch("alpha-dev", "reviewer2", "eighth launch").ok, true);
  assert.match(server.leaderLaunch("alpha-dev", "reviewer2", "ninth launch").error, /budget/);
  assert.equal(server.safety().timestamps.length, 8);
});

test("leaderLaunchSeat: a real reviewer launch still builds a read-only Codex command", async () => {
  const server = await loadServer({ skipHealth: true }), runner = loadRunnerHarness();
  assert.equal(server.leaderLaunch("alpha-dev", "reviewer2", "review the change").ok, true);
  const run = server.launched[0].run;
  assert.equal(run.canWrite, false);
  assert.match(runner.buildCommand(run, path.join(server.testRoot, "logs", "review.brief.txt")), /--sandbox read-only/);
});

test("leaderLaunchSeat: a real writable slot keeps its explicit write permission", async () => {
  const server = await loadServer({ skipHealth: true }), runner = loadRunnerHarness();
  assert.equal(server.leaderLaunch("alpha-dev", "coder", "implement the approved change").ok, true);
  const run = server.launched[0].run;
  assert.equal(run.canWrite, true);
  assert.match(runner.buildCommand(run, path.join(server.testRoot, "logs", "coder.brief.txt")), /--sandbox workspace-write/);
});

test("leaderLaunchSeat: every successful launch persists and broadcasts its tab, slot, and brief", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  assert.equal(server.leaderLaunch("alpha-design", "designer", "create a new layout").ok, true);
  const notice = ws.messages.find((message: any) => message.type === "leaderLaunch");
  assert.equal(notice.seatId, "alpha-design.designer"); assert.equal(notice.brief, "create a new layout");
  assert.equal(server.safety().notices.at(-1).seatId, "alpha-design.designer");
});

test("leaderLaunchSeat: refused launches never broadcast a success notice", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  assert.equal(server.leaderLaunch("alpha-dev", "missing", "no slot").ok, false);
  assert.equal(server.leaderLaunch("alpha-dev", "leader", "self").ok, false);
  assert.equal(ws.messages.some((message: any) => message.type === "leaderLaunch"), false);
});

test("leaderLaunchSeat: run-start attribution distinguishes leader starts from later manual starts", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.leaderLaunch("alpha-dev", "coder", "leader start");
  const leaderRun = server.launched[0].run.runId;
  assert.equal(ws.messages.find((message: any) => message.type === "runStart" && message.runId === leaderRun).launchedBy?.kind, "leader");
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "manual start" });
  const manualRun = server.launched.at(-1).run.runId;
  assert.equal(ws.messages.find((message: any) => message.type === "runStart" && message.runId === manualRun).launchedBy, null);
});

test("leaderLaunchSeat: concurrent same-slot launches keep distinct run ownership and notices", async () => {
  const server = await loadServer({ skipHealth: true });
  assert.equal(server.leaderLaunch("alpha-dev", "reviewer2", "first").ok, true);
  assert.equal(server.leaderLaunch("alpha-dev", "reviewer2", "second").ok, true);
  assert.notEqual(server.launched[0].run.runId, server.launched[1].run.runId);
  assert.deepEqual(server.launched.map((entry: any) => entry.prompt), ["first", "second"]);
});

test("leaderLaunchSeat: an unknown crew slot is refused", async () => {
  const server = await loadServer({ skipHealth: true });
  const result = server.leaderLaunch("alpha-dev", "unknown", "task");
  assert.equal(result.ok, false);
  assert.equal(server.launched.length, 0, "an unknown slot launches nothing");
  assert.match(result.error, /unknown slot/);
});

test("leaderLaunchSeat: Atlas cannot launch the tab leader as a worker", async () => {
  const server = await loadServer({ skipHealth: true });
  assert.match(server.leaderLaunch("alpha-dev", "leader", "self launch").error, /leader runs in-process/);
  assert.equal(server.launched.length, 0);
});

test("leaderLaunchSeat: an explicit unblock clears the durable kill block before the next leader launch", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json"), first = await loadServer({ skipHealth: true, safetyPath }), ws = connect(first);
  first.leaderLaunch("alpha-dev", "coder", "first"); ws.message({ type: "killRun", runId: first.launched[0].run.runId });
  assert.deepEqual(config.readLaunchSafety(safetyPath).blocked, ["alpha-dev.coder"]);
  ws.message({ type: "unblockSeat", seatId: "alpha-dev.coder", confirm: "allow this seat to launch again" });
  assert.deepEqual(config.readLaunchSafety(safetyPath).blocked, []);
  assert.equal(first.leaderLaunch("alpha-dev", "coder", "after explicit unblock").ok, true);
});

test("buildLeaderOptions: a resolved native CLI carries its path and effort option", () => {
  const options = leaderApi.buildLeaderOptions({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", "C:/bin/claude.exe");
  assert.equal(options.pathToClaudeCodeExecutable, "C:/bin/claude.exe"); assert.deepEqual(options.extraArgs, { effort: "high", "replay-user-messages": null });
});

test("buildLeaderOptions: no resolved CLI omits both native-path and effort options", () => {
  const options = leaderApi.buildLeaderOptions({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null);
  assert.equal(Object.hasOwn(options, "pathToClaudeCodeExecutable"), false); assert.equal(Object.hasOwn(options, "extraArgs"), false);
});

test("buildLeaderOptions applies the saved permission mode when a leader session starts", () => {
  assert.deepEqual(["ask", "accept", "plan", "bypass"].map((mode) => leaderApi.buildLeaderOptions({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, undefined, mode as any).permissionMode), ["default", "acceptEdits", "plan", "bypassPermissions"]);
});

test("chat project guard rejects missing and stale project-only ids before any leader send", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", projectId: "missing", text: "stale project request" }); await tick();
  assert.equal(server.chats.length, 0); assert.equal(server.leaders.size, 0);
  assert.match(ws.messages.at(-1).message, /unknown tab/);
});

test("checkLeaderHealth: a real result logs healthy and sends no client error", async () => {
  const info: string[] = [], errors: string[] = [], logs = { log: (text: string) => info.push(text), error: (text: string) => errors.push(text) } as any;
  const server = await loadServer({ console: logs }); const ws = connect(server); await server.leaderHealthCheck;
  assert.ok(info.some((line) => /health check passed/.test(line))); assert.equal(errors.length, 0);
  assert.equal(ws.messages.some((message: any) => message.type === "error"), false);
});

test("checkLeaderHealth: an empty iterator is reported as failure rather than healthy", async () => {
  const errors: string[] = [], logs = { log() {}, error: (text: string) => errors.push(text) } as any;
  const server = await loadServer({ console: logs, query: () => ({ [Symbol.asyncIterator]: async function* () {} }) }); await server.leaderHealthCheck;
  assert.ok(errors.some((line) => /ended without a result/.test(line)));
});

test("checkLeaderHealth: an is_error result is failure, never a healthy result", async () => {
  const info: string[] = [], errors: string[] = [], logs = { log: (text: string) => info.push(text), error: (text: string) => errors.push(text) } as any;
  const server = await loadServer({ console: logs, query: () => ({ [Symbol.asyncIterator]: async function* () { yield { type: "result", is_error: true }; } }) }); await server.leaderHealthCheck;
  assert.equal(info.some((line) => /health check passed/.test(line)), false); assert.ok(errors.some((line) => /error result/.test(line)));
});

test("checkLeaderHealth: a Claude CLI inside the first tab's folder is refused and no query starts", async () => {
  const info: string[] = [], errors: string[] = [], logs = { log: (text: string) => info.push(text), error: (text: string) => errors.push(text) } as any;
  const planted = await loadServer({ console: logs, claudeCli: "C:/work/alpha/tools/claude.exe" }); await planted.leaderHealthCheck;
  assert.equal(planted.queryCount(), 0, "no health-check query may start the planted CLI");
  assert.ok(errors.some((line) => /lies inside the tab folder/.test(line)), errors.join("|"));
  const outside = await loadServer({ console: logs, claudeCli: "C:/elsewhere/claude.exe" }); await outside.leaderHealthCheck;
  assert.equal(outside.queryCount(), 1, "control: a CLI outside the tab folder still gets checked");
});

test("B8: cleanScratch keeps an old upload a saved chat still points at, and deletes an old unreferenced one", async () => {
  const server = await loadServer({ skipHealth: true }), dir = path.join(server.testRoot, "scratch-referenced"); mkdirSync(dir);
  const chats = path.join(server.testRoot, "chats"); mkdirSync(chats, { recursive: true });
  const kept = "paste-11111111-1111-1111-1111-111111111111.png", gone = "paste-22222222-2222-2222-2222-222222222222.png";
  const chatFile = path.join(chats, "alpha-dev.jsonl");
  writeFileSync(chatFile, `${JSON.stringify({ role: "user", text: "look", images: [`C:/data/scratch/${kept}`] })}\n`);
  writeFileSync(path.join(dir, kept), "x"); writeFileSync(path.join(dir, gone), "y");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(path.join(dir, kept), old, old); utimesSync(path.join(dir, gone), old, old);
  try {
    await server.cleanScratch(dir);
    assert.equal(existsSync(path.join(dir, kept)), true, "referenced by a saved chat: kept");
    assert.equal(existsSync(path.join(dir, gone)), false, "control: unreferenced and old: deleted");
  } finally { rmSync(chatFile, { force: true }); }
});

test("B8: Clear Undo is refused while the leader is answering or a Save runs, and stays available", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "old work" });
  await tick();
  ws.message({ type: "clear", tabId: "alpha-dev" });
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true);
  const revisionBefore = lastState(ws).projects[0].tabs[0].chatRevision;
  server.activeLeaderTurns.add("alpha-dev");
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.deepEqual([ws.messages.at(-1).type, ws.messages.at(-1).reason], ["chatUndoRejected", "busy"], "the page can tell this refusal from an expired undo");
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true, "the undo is still available");
  assert.equal(lastState(ws).projects[0].tabs[0].chatRevision, revisionBefore, "nothing was restored");
  server.activeLeaderTurns.delete("alpha-dev");
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.equal(server.pendingClearUndos.has("alpha-dev"), false, "control: once the leader is idle the undo works");
});

test("Clear Undo is refused as busy while only a Save runs (no leader turn), and works after", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "old work" });
  await tick();
  ws.message({ type: "clear", tabId: "alpha-dev" });
  server.savingTabs.set("alpha-dev", 1);
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.deepEqual([ws.messages.at(-1).type, ws.messages.at(-1).reason], ["chatUndoRejected", "busy"]);
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true, "the undo is still available");
  server.savingTabs.delete("alpha-dev");
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.equal(server.pendingClearUndos.has("alpha-dev"), false, "control: once the Save is done the undo works");
});

test("cleanScratch deletes nothing when a saved chat cannot be read (a chat path that is a directory)", async () => {
  const server = await loadServer({ skipHealth: true }), dir = path.join(server.testRoot, "scratch-unreadable"); mkdirSync(dir);
  const chats = path.join(server.testRoot, "chats-unreadable"); mkdirSync(chats, { recursive: true });
  const unreadable = path.join(chats, "beta-dev.jsonl"); mkdirSync(unreadable);
  const oldFile = path.join(dir, "paste-33333333-3333-3333-3333-333333333333.png"); writeFileSync(oldFile, "x");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); utimesSync(oldFile, old, old);
  try {
    await server.cleanScratch(dir, chats);
    assert.equal(existsSync(oldFile), true, "an unreadable chat may reference it: kept");
    rmdirSync(unreadable);
    await server.cleanScratch(dir, chats);
    assert.equal(existsSync(oldFile), false, "control: with every chat readable it is deleted");
  } finally { for (const empty of [unreadable, chats]) { try { rmdirSync(empty); } catch { /* already removed */ } } }
});

test("cleanScratch: a chats path that is a file keeps old uploads; a missing chats folder lets an old unreferenced upload go", async () => {
  const server = await loadServer({ skipHealth: true }), dir = path.join(server.testRoot, "scratch-chatsfile"); mkdirSync(dir);
  const oldFile = path.join(dir, "paste-44444444-4444-4444-4444-444444444444.png"); writeFileSync(oldFile, "x");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); utimesSync(oldFile, old, old);
  const chatsAsFile = path.join(server.testRoot, "chats-is-a-file"); writeFileSync(chatsAsFile, "not a folder");
  try {
    await server.cleanScratch(dir, chatsAsFile);
    assert.equal(existsSync(oldFile), true, "chats folder unreadable (ENOTDIR): cleanup skipped, upload kept");
    await server.cleanScratch(dir, path.join(server.testRoot, "chats-missing"));
    assert.equal(existsSync(oldFile), false, "control: a missing chats folder means no references, old upload deleted");
  } finally { rmSync(chatsAsFile, { force: true }); rmSync(oldFile, { force: true }); }
});

test("approvalSummary never hides a path silently: 600 long paths show whole paths and a count of the hidden files", async () => {
  const server = await loadServer({ skipHealth: true });
  const paths = Array.from({ length: 600 }, (_, i) => `C:/work/project/src/deeply/nested/folder/file-number-${String(i).padStart(4, "0")}.ts`);
  const summary: string = server.approvalSummary({ paths, changes: "the change text", grantRoot: "C:/granted-root" });
  assert.ok(summary.length <= 20000, `capped: ${summary.length}`);
  const lines = summary.split("\n");
  const shownPaths = lines.filter((line) => paths.includes(line));
  assert.ok(shownPaths.length > 0 && shownPaths.length < 600, "some but not all paths fit");
  assert.deepEqual(shownPaths, paths.slice(0, shownPaths.length), "whole paths, in order, none cut mid-way");
  const hidden = 600 - shownPaths.length;
  const notice = lines.find((line) => line.startsWith("... and "));
  const hiddenChars = paths.slice(shownPaths.length).join("\n").length;
  assert.equal(notice, `... and ${hidden} more files not shown (${hiddenChars} characters)`, "exact hidden count and character count");
  assert.ok(summary.length > 19000, `shown paths use the room: ${summary.length}`);
  assert.ok(summary.endsWith("\nAlso asks for write access to: C:/granted-root"), "grantRoot survives");
  assert.equal(lines.every((line) => line === notice || line.startsWith("Also asks") || paths.includes(line)), true, "no partial line");
  const small = server.approvalSummary({ paths: ["C:/a.ts", "C:/b.ts"], changes: "edit" });
  assert.equal(small, "C:/a.ts\nC:/b.ts\n\nedit", "control: a short list is unchanged");
});

test("approvalSummary carries what Allow approves: OpenCode patterns and diff, Codex folder and reason, a long Write with its notice", async () => {
  const server = await loadServer({ skipHealth: true });
  assert.equal(server.approvalSummary({ file_path: "C:/w/a.ts", patterns: ["C:/w/a.ts", "C:/w/b.ts"], diff: "-old\n+new" }, "Edit"), "C:/w/a.ts\nC:/w/b.ts\n\n-old\n+new");
  assert.equal(server.approvalSummary({ command: "git status", cwd: "C:/repo", reason: "check the tree" }, "Bash"), "git status\n\nRuns in: C:/repo\n\nReason: check the tree");
  assert.equal(server.approvalSummary({ command: "Get-Date" }, "PowerShell"), "Get-Date", "control: a bare command is unchanged");
  assert.equal(server.approvalSummary({ weird: 1 }, "Other"), '{"weird":1}', "anything else keeps the JSON fallback");
  const big = server.approvalSummary({ file_path: "C:/w/big.txt", content: "x".repeat(30000) }, "Write");
  const bigMain = "C:/w/big.txt\n\nNew content:\n" + "x".repeat(30000);
  assert.equal(big, `${bigMain.slice(0, 20000)}\n... (${bigMain.length - 20000} more characters not shown)`, "exact shown text and exact hidden count");
});

test("clients exist before crash handlers run during startup, so an early broadcast cannot hit a TDZ", async () => {
  const errors: string[] = [], logs = { log() {}, error: (value: string) => errors.push(value) } as any;
  const server = await loadServer({ skipHealth: true, console: logs });
  assert.doesNotThrow(() => server.processHandlers.uncaughtException(new Error("startup probe")));
  assert.ok(errors.some((line) => /uncaught exception: startup probe/.test(line)));
  assert.equal(errors.some((line) => /handler itself failed/.test(line)), false);
});

test("crash handlers survive null and plain-object errors and describe each through broadcast", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.processHandlers.uncaughtException(null);
  server.processHandlers.unhandledRejection({ message: "plain rejection" });
  const messages = ws.messages.filter((message: any) => message.type === "error").map((message: any) => message.message);
  assert.ok(messages.some((message: string) => /internal error: null/.test(message)));
  assert.ok(messages.some((message: string) => /plain rejection/.test(message)));
});
