import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { ChatStore } from "../server/chat-store.ts";
import { tempRoot } from "./temp-root.ts";
import { config } from "./round2-setup.ts";
import { fixtureWorkspaces, tempWorkspaceFolders, loadServer, connect, lastState, settleLeaderTurns, tick, waitFor } from "./round2-helpers.ts";

const LEADER_SLOT = (tab: any) => tab.crew.find((member: any) => member.slot === "leader");

test("pack 2 C7: a leader model/effort change asked for mid-answer is saved at once and reaches the live leader only when the answer ends", async () => {
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 150 }), ws = connect(server);
  try {
  ws.message({ type: "chat", tabId: "alpha-dev", text: "long answer" });
  await tick(20);
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), true, "an answer is being written");
  const handle = server.leaderHandles[0];
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5", effort: "high" });
  assert.deepEqual(handle.modelCalls, [], "the live leader is not touched while it answers");
  assert.equal(server.leaderSeats.get("alpha-dev").effort, "medium", "nor is the effort the next turn will read");
  const saved = LEADER_SLOT(server.getWorkspaces().projects[0].tabs[0]);
  assert.deepEqual([saved.model, saved.effort], ["claude-opus-5", "high"], "the choice itself is saved at once");
  assert.equal(server.queuedLeaderChanges.has("alpha-dev"), true);
  await waitFor(() => !server.activeLeaderTurns.has("alpha-dev"), "the answer ends");
  await tick(10);
  assert.deepEqual(handle.modelCalls, ["claude-opus-5"], "the change reaches the live leader after the answer");
  assert.equal(server.leaderSeats.get("alpha-dev").effort, "high");
  assert.equal(server.queuedLeaderChanges.size, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "chatMessage" && message.role === "assistant" && message.text.endsWith("long answer")), "the answer was never cut");
  assert.equal(ws.messages.some((message: any) => message.type === "chatError"), false);
  } finally { await settleLeaderTurns(server); }
});

test("pack 2 C7: a queued model change that fails at the end of the answer reports it once and ends nothing; Stop drops a queued change", async () => {
  const failing = await loadServer({ skipHealth: true, leaderDelayMs: 100, setModelResult: false }), ws = connect(failing);
  let stopped: any = null;
  try {
  ws.message({ type: "chat", tabId: "alpha-dev", text: "answer" });
  await tick(10);
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && /leader model change failed/.test(message.message)), "the failed change is reported");
  assert.equal(ws.messages.some((message: any) => message.type === "chatError"), false, "a failed change never fails a turn");

  stopped = await loadServer({ skipHealth: true, hangLeader: true });
  const wsStopped = connect(stopped);
  wsStopped.message({ type: "chat", tabId: "alpha-dev", text: "hang" });
  await tick(10);
  wsStopped.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5" });
  assert.equal(stopped.queuedLeaderChanges.has("alpha-dev"), true);
  wsStopped.message({ type: "stopSeat", tabId: "alpha-dev", slot: "leader" });
  assert.equal(stopped.queuedLeaderChanges.size, 0, "a stopped leader has nothing to change; its successor reads the saved seat");
  assert.deepEqual(stopped.leaderHandles[0].modelCalls, []);
  } finally { await settleLeaderTurns(...[failing, stopped].filter(Boolean)); }
});

test("round 1 fix 1: a model/effort change whose save failed mid-answer never reaches the live leader afterwards", async () => {
  let failWrite = false;
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 150, failWorkspaceWrite: () => failWrite }), ws = connect(server);
  try {
    ws.message({ type: "chat", tabId: "alpha-dev", text: "long answer" });
    await tick(20);
    assert.equal(server.activeLeaderTurns.has("alpha-dev"), true, "an answer is being written");
    const handle = server.leaderHandles[0];
    failWrite = true;
    ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "leader", model: "claude-opus-5", effort: "high" });
    failWrite = false;
    assert.match(ws.messages.findLast((message: any) => message.type === "error").message, /workspace disk failed/, "the refusal is reported");
    assert.equal(server.queuedLeaderChanges.size, 0, "nothing is queued for a save that did not happen");
    await waitFor(() => !server.activeLeaderTurns.has("alpha-dev"), "the answer ends");
    await tick(10);
    assert.deepEqual(handle.modelCalls, [], "the live leader keeps the model the saved settings have");
    assert.equal(server.leaderSeats.get("alpha-dev").effort, "medium");
  } finally { await settleLeaderTurns(server); }
});

test("round 1 fix 3: Save broadcasts 'saved' only after the leader's history entry exists, even when that write is slow", async () => {
  const slowWrite = (async (file: any, ...rest: any[]) => { if (String(file).endsWith(".brief.txt")) await tick(120); return (writeFile as any)(file, ...rest); }) as typeof writeFile;
  const server = await loadServer({ skipHealth: true, writeHandover: true, workspaces: tempWorkspaceFolders(), writeFile: slowWrite });
  const ws = connect(server);
  const logs = path.join(server.testRoot, "logs");
  const entriesAtSaved: string[][] = [];
  const send = ws.send;
  ws.send = (raw: string) => { send(raw); if (JSON.parse(raw).type === "saved") entriesAtSaved.push(readdirSync(logs).filter((name) => name.startsWith("alpha-dev.leader-") && name.endsWith(".brief.txt"))); };
  try {
    ws.message({ type: "chat", tabId: "alpha-dev", text: "answer before saving" });
    await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone"), "the answer");
    ws.message({ type: "save", tabId: "alpha-dev" });
    await waitFor(() => entriesAtSaved.length > 0, "Save finished", 5_000);
    assert.equal(entriesAtSaved[0].length, 1, "the history entry was already on disk when the page was told");
    ws.message({ type: "historyList", seatKey: "alpha-dev.leader" });
    await waitFor(() => ws.messages.some((message: any) => message.type === "historyList"), "the history list");
    assert.equal(ws.messages.findLast((message: any) => message.type === "historyList").runs.length, 1, "so the first list the page asks for already shows it");
  } finally { await settleLeaderTurns(server); }
});

test("round 2 fix 2: a Clear while Save's history entry is being written leaves no 'saved' for the old revision and the cleared chat unsaved", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((ok) => { enter = ok; });
  const open = new Promise<void>((ok) => { release = ok; });
  const heldWrite = (async (file: any, ...rest: any[]) => { if (String(file).endsWith(".brief.txt")) { enter(); await open; } return (writeFile as any)(file, ...rest); }) as typeof writeFile;
  const server = await loadServer({ skipHealth: true, writeHandover: true, workspaces: tempWorkspaceFolders(), writeFile: heldWrite }), ws = connect(server);
  try {
    ws.message({ type: "chat", tabId: "alpha-dev", text: "answer before saving" });
    await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone"), "the answer");
    ws.message({ type: "save", tabId: "alpha-dev" });
    await entered;
    ws.message({ type: "clear", tabId: "alpha-dev" });
    await waitFor(() => ws.messages.some((message: any) => message.type === "chatCleared" && message.tabId === "alpha-dev"), "Clear done");
    release();
    await tick(150);
    await server.flush();
    assert.equal(ws.messages.some((message: any) => message.type === "saved"), false, "no 'saved' goes out for the chat that was cleared");
    const cleared = ws.messages.find((message: any) => message.type === "chatCleared" && message.tabId === "alpha-dev");
    assert.deepEqual(new ChatStore(path.join(server.testRoot, "chats")).counters("alpha-dev"), { revision: cleared.revision, savedRevision: 0 }, "the cleared chat keeps its own counters");
  } finally { release(); await settleLeaderTurns(server); }
});

test("pack 2 C1: Accept/Decline is answered by the tab the request was sent to, whichever tab is open", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  ws.message({ type: "sendRequest", requestId: "c1_send", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Review", body: "Check it." });
  await waitFor(() => ws.messages.some((message: any) => message.requestId === "c1_send" && message.type === "actionResult"), "request sent");
  const request = server.requestsStore.list()[0];
  assert.equal(lastState(ws).selectedTabId, "alpha-dev", "the open tab is not the destination");
  ws.message({ type: "resolveRequest", requestId: "c1_none", id: request.id, status: "declined" });
  await waitFor(() => ws.messages.some((message: any) => message.requestId === "c1_none" && message.type === "error"), "no tabId");
  assert.match(ws.messages.find((message: any) => message.requestId === "c1_none").message, /tabId is required/);
  ws.message({ type: "resolveRequest", requestId: "c1_wrong", id: request.id, status: "declined", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.requestId === "c1_wrong" && message.type === "error"), "wrong tab");
  ws.message({ type: "resolveRequest", requestId: "c1_gone", id: request.id, status: "declined", tabId: "no-such-tab" });
  await waitFor(() => ws.messages.some((message: any) => message.requestId === "c1_gone" && message.type === "error"), "unknown tab");
  assert.equal(server.requestsStore.pendingCount("beta-dev"), 1, "none of the refusals resolved it");
  ws.message({ type: "resolveRequest", requestId: "c1_ok", id: request.id, status: "declined", tabId: "beta-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.requestId === "c1_ok" && message.type === "actionResult"), "answered from the destination tab");
  assert.equal(server.requestsStore.list()[0].status, "declined");
  assert.equal(lastState(ws).selectedTabId, "alpha-dev", "answering never switched tabs");
});

test("pack 2 C5: the crew rail and details panel layout is a client pref the server saves", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  assert.deepEqual([lastState(ws).clientPrefs.crewRailOpen, lastState(ws).clientPrefs.detailsOpen], [true, false]);
  ws.message({ type: "updateClientPref", key: "crewRailOpen", value: false });
  ws.message({ type: "setClientPref", key: "detailsOpen", value: true });
  assert.deepEqual([lastState(ws).clientPrefs.crewRailOpen, lastState(ws).clientPrefs.detailsOpen], [false, true]);
  const written = server.prefWrites.at(-1).value;
  assert.deepEqual([written.crewRailOpen, written.detailsOpen], [false, true], "written through the same client-prefs path as theme and avatar");
  ws.message({ type: "updateClientPref", key: "crewRailOpen", value: "no" });
  assert.equal(ws.messages.at(-1).type, "error");
  assert.equal(lastState(ws).clientPrefs.crewRailOpen, false, "a bad value changes nothing");
});

test("pack 2: hello ignores a localPrefs field (the localStorage migration is gone) and Settings Check again answers with the page's requestId, also on failure", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello", localPrefs: { sidebarCollapsed: true } });
  assert.equal(server.prefWrites.length, 0);
  assert.equal(lastState(ws).clientPrefs.sidebarCollapsed, false);

  server.settingsService.refreshAll = async () => {};
  ws.message({ type: "refreshSettings", requestId: "chk_ok" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "chk_ok" && message.action === "refreshSettings"), "actionResult carries the requestId");
  assert.ok(ws.messages.some((message: any) => message.type === "settingsRefreshed"), "the older settingsRefreshed still follows");

  server.settingsService.refreshAll = async () => { throw new Error("tools unreachable"); };
  ws.message({ type: "refreshSettings", requestId: "chk_fail" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "chk_fail"), "error carries the requestId");
  const failure = ws.messages.find((message: any) => message.type === "error" && message.requestId === "chk_fail");
  assert.deepEqual([failure.action, failure.message], ["refreshSettings", "tools unreachable"]);
  assert.equal(server.stateMessage().requestActions.chk_fail.status, "failed");

  ws.message({ type: "refreshSettings" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.action === "refreshSettings" && message.requestId === undefined), "without an id a failure is still reported, never an unhandled rejection");
});

test("pack 2 C8: a successful Save writes one leader history entry (transcript + handover path) that the seat's history lists", async () => {
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 10, writeHandover: true, workspaces: tempWorkspaceFolders() }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "decide the plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "alpha-dev"), "first answer");
  assert.equal((await server.listHistory("alpha-dev.leader")).length, 0, "nothing is saved yet");
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"), "Save done");
  let entries: any[] = [];
  await waitFor(() => { void server.listHistory("alpha-dev.leader").then((list: any[]) => { entries = list; }); return entries.length === 1; }, "the history lists the saved session");
  assert.equal(entries[0].seatId, "alpha-dev.leader");
  assert.deepEqual(JSON.parse(JSON.stringify(entries[0].outcome)), { status: "done", exitCode: 0 });
  assert.ok(entries[0].briefFile, "the brief file sits beside the log");
  const handoverPath = path.join(server.getWorkspaces().projects[0].tabs[0].folder, ".command-center", "alpha-dev", "RESUME.md");
  const brief = readFileSync(path.join(server.testRoot, "logs", entries[0].briefFile), "utf8");
  assert.equal(brief, `Saved handover: ${handoverPath}`);
  const log = readFileSync(path.join(server.testRoot, "logs", entries[0].logFile), "utf8");
  assert.match(log, /^You: decide the plan\n\nAtlas: answer:.*decide the plan/s);
  assert.match(log, /\[exit\] status=done code=0\s*$/);
  // The page loads it exactly like a worker run.
  ws.message({ type: "historyRun", seatKey: "alpha-dev.leader", timestamp: entries[0].timestamp });
  await waitFor(() => ws.messages.some((message: any) => message.type === "historyRun" && message.seatKey === "alpha-dev.leader"), "historyRun reply");
  const run = ws.messages.find((message: any) => message.type === "historyRun" && message.seatKey === "alpha-dev.leader");
  assert.equal(run.brief, brief);
  assert.match(run.output, /You: decide the plan/);
  // A refused/failed Save records nothing.
  const failed = await loadServer({ skipHealth: true, failSave: true, workspaces: tempWorkspaceFolders() }), wsFailed = connect(failed);
  wsFailed.message({ type: "chat", tabId: "alpha-dev", text: "x" }); await tick(20);
  wsFailed.message({ type: "save", tabId: "alpha-dev" }); await tick(120);
  assert.equal((await failed.listHistory("alpha-dev.leader")).length, 0);
});

test("pack 2 C8: only the newest 50 saved sessions of a leader are kept, oldest removed file by file", async () => {
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 5, writeHandover: true, workspaces: tempWorkspaceFolders() }), ws = connect(server);
  const logs = path.join(server.testRoot, "logs");
  for (let i = 1; i <= 52; i++) { writeFileSync(path.join(logs, `alpha-dev.leader-${i}.log`), "old"); writeFileSync(path.join(logs, `alpha-dev.leader-${i}.brief.txt`), "old"); }
  writeFileSync(path.join(logs, "beta-dev.leader-1.log"), "another seat's");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "x" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone"), "answer");
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "saved"), "saved");
  await waitFor(() => !existsSync(path.join(logs, "alpha-dev.leader-3.log")), "the oldest entries are pruned");
  const left = (await readdir(logs)).filter((name) => name.startsWith("alpha-dev.leader-") && name.endsWith(".log"));
  assert.equal(left.length, 50);
  assert.equal(existsSync(path.join(logs, "alpha-dev.leader-2.brief.txt")), false, "a pruned entry loses its brief too");
  assert.equal(existsSync(path.join(logs, "alpha-dev.leader-52.log")), true);
  assert.equal(existsSync(path.join(logs, "beta-dev.leader-1.log")), true, "another seat's history is never touched");
});

test("pack 2: Stop keeps the half answer the leader had already written, marked as cut short; a stop with no text adds nothing", async () => {
  const server = await loadServer({ skipHealth: true, hangLeader: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "write a lot" });
  await tick(10);
  server.leaderHandles[0].callbacks.onDelta("half an ans");
  server.leaderHandles[0].callbacks.onDelta("wer");
  ws.message({ type: "stopSeat", tabId: "alpha-dev", slot: "leader" });
  const kept = ws.messages.find((message: any) => message.type === "chatMessage" && message.role === "assistant");
  assert.equal(kept.text, "half an answer\n\n(Stopped before it finished.)");
  assert.equal(server.chatStore.snapshot("alpha-dev").messages.at(-1).text, kept.text, "and it is in the saved transcript");
  assert.ok(ws.messages.some((message: any) => message.type === "chatError" && message.message === "leader turn stopped"));

  ws.message({ type: "chat", tabId: "beta-dev", text: "silent" });
  await tick(10);
  ws.message({ type: "stopAll" });
  assert.equal(ws.messages.some((message: any) => message.type === "chatMessage" && message.role === "assistant" && message.tabId === "beta-dev"), false, "no text, no assistant message");
});

test("pack 2: finishing a turn survives a chat log that cannot be written, and a result with no turn waiting sends no stray chatDone", async () => {
  const server = await loadServer({ skipHealth: true, failAssistantAppend: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "answer please" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "alpha-dev"), "the turn still ends");
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save the answer to the chat log: chat disk failed/.test(message.message)));
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), false, "the tab is not left busy");
  const doneCount = () => ws.messages.filter((message: any) => message.type === "chatDone").length;
  const before = doneCount();
  server.leaderHandles[0].callbacks.onDone();
  assert.equal(doneCount(), before, "the CLI finishing background work is not a turn's end");
});

test("pack 2: a leader that cannot start fails the chat as a turn error and leaves nothing registered", async () => {
  const server = await loadServer({ skipHealth: true, createLeaderThrows: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start please" });
  await tick(10);
  assert.ok(ws.messages.some((message: any) => message.type === "chatMessage" && message.role === "user"), "the user's message is saved");
  assert.ok(ws.messages.some((message: any) => message.type === "chatError" && message.tabId === "alpha-dev" && /leader could not start/.test(message.message)), "reported as the turn's error");
  assert.equal(ws.messages.some((message: any) => message.type === "error" && /leader could not start/.test(message.message)), false, "not as a refusal that would roll the message back");
  assert.equal(server.leaderInstances.size, 0);
  assert.equal(server.leaderSeats.size, 0);
  assert.equal(server.activeLeaderTurns.size, 0);

  const workspaces = fixtureWorkspaces();
  for (const member of workspaces.projects[0].tabs[0].crew) if (member.slot === "leader") { member.cli = "opencode"; member.model = "opencode/glm-5.2"; member.effort = "max"; }
  const bridge = await loadServer({ skipHealth: true, opencodeThrows: true, workspaces }), wsBridge = connect(bridge);
  wsBridge.message({ type: "chat", tabId: "alpha-dev", text: "start please" });
  await tick(10);
  assert.ok(wsBridge.messages.some((message: any) => message.type === "chatError" && /opencode could not start/.test(message.message)));
  assert.equal(bridge.leaderBridge.isOpen("alpha-dev"), false, "the OpenCode bridge token of the failed start is revoked");
  assert.equal(bridge.leaderSeats.size, 0);
});

test("pack 2: activeWork counts an unconfirmed process of an earlier session in its own tab; globalWork names work that belongs to no tab", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json");
  config.writeLaunchSafety({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [{ seatId: "alpha-dev.coder", pid: 4242, runId: "old-run" }], live: [] }, safetyPath);
  const server = await loadServer({ skipHealth: true, safetyPath }), ws = connect(server);
  ws.message({ type: "hello" });
  const tabOf = (id: string) => lastState(ws).projects.flatMap((project: any) => project.tabs).find((tab: any) => tab.id === id);
  assert.deepEqual([tabOf("alpha-dev").activeWork, tabOf("beta-dev").activeWork], [true, false]);
  assert.deepEqual(JSON.parse(JSON.stringify(lastState(ws).globalWork)), []);
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: server.testRoot });
  assert.match(ws.messages.at(-1).message, /cannot change the folder while the tab is busy/, "the same check refuses a folder change while that process may still be working");
  server.launchSafety.uncertain.push({ seatId: "sonny", pid: 77 });
  server.settingsService.refreshAll = () => new Promise(() => {});
  ws.message({ type: "refreshSettings", requestId: "work_1" });
  server.settingsService.beginUpload("up_work");
  assert.deepEqual(JSON.parse(JSON.stringify(server.stateMessage().globalWork)), ["a Settings action is running", "an upload is running", "a process from an earlier session may still be running"]);
  server.settingsService.finishUpload("up_work", true, "done");
  assert.equal(server.stateMessage().globalWork.includes("an upload is running"), false);
});

test("pack 2: a damaged chat transcript costs only its own tab, never the whole state message", async () => {
  const server = await loadServer({ skipHealth: true, preload: (root) => mkdirSync(path.join(root, "chats", "alpha-dev.jsonl"), { recursive: true }) }), ws = connect(server);
  ws.message({ type: "hello" });
  const tabs = lastState(ws).projects.flatMap((project: any) => project.tabs);
  assert.match(tabs.find((tab: any) => tab.id === "alpha-dev").chatProblem, /EISDIR|illegal operation|directory/i);
  assert.deepEqual([tabs.find((tab: any) => tab.id === "alpha-dev").chatRevision, tabs.find((tab: any) => tab.id === "alpha-dev").savedRevision], [0, 0]);
  assert.equal(Object.hasOwn(tabs.find((tab: any) => tab.id === "beta-dev"), "chatProblem"), false);
  ws.message({ type: "chat", tabId: "beta-dev", text: "still works" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "chatDone" && message.tabId === "beta-dev"), "another tab keeps chatting");
});

test("pack 2: a burst of usage events sends one state at once and folds the rest into one more", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "busy"); const entry = server.launched[0];
  const states = () => ws.messages.filter((message: any) => message.type === "state").length;
  const before = states();
  for (let i = 1; i <= 20; i++) entry.callback.onUsage(entry.run, { modelId: null, contextTokens: i, contextWindow: null, costUsd: i / 100 });
  assert.equal(states() - before, 1, "the first event goes out at once, the other 19 do not each send a full state");
  await tick(520);
  assert.equal(states() - before, 2, "one trailing state carries the latest numbers");
  assert.equal(lastState(ws).projects[0].tabs[0].runs.find((run: any) => run.runId === entry.run.runId).usage.contextTokens, 20);
});
