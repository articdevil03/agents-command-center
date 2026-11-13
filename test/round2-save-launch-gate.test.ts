import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { ChatStore } from "../server/chat-store.ts";
import { tempWorkspaceFolders, loadFixed, fixedGateServer, startHelper, endRun, ASSIST, connect, lastState, tick, waitFor } from "./round2-helpers.ts";
import { pendingFor } from "./round2-gate-helpers.ts";

async function assertSaveRejectsHandover(mode: "missing" | "stale") {
  const workspaces = tempWorkspaceFolders("fixed");
  const folder = workspaces.projects[0].tabs[0].folder;
  const handoverPath = path.join(folder, ".command-center", "alpha-dev", "RESUME.md");
  if (mode === "stale") {
    mkdirSync(path.dirname(handoverPath), { recursive: true });
    writeFileSync(handoverPath, "old handover", "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(handoverPath, old, old);
  }
  const server = await loadFixed({ skipHealth: true, workspaces }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "work" });
  await tick();
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)), `${mode} handover refusal`);
  const tab = lastState(ws).projects[0].tabs[0];
  assert.equal(tab.savedRevision, 0, `${mode} handover must not advance savedRevision`);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)), `${mode} handover must fail Save`);
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false, `${mode} handover must not emit saved`);
  if (mode === "missing") assert.equal(existsSync(handoverPath), false);
}

// The Save turn's handover check (stat) is an await: chat and clear are not serialized behind Save and can land in it.
async function saveWithGapAction(action: (ws: any) => Promise<void>) {
  let enterGap!: () => void, releaseGap!: () => void;
  const inGap = new Promise<void>((resolveGap) => { enterGap = resolveGap; });
  const gapOpen = new Promise<void>((resolveGap) => { releaseGap = resolveGap; });
  const gatedStat = (async (file: any, ...rest: any[]) => {
    if (String(file).endsWith("RESUME.md")) { enterGap(); await gapOpen; }
    return (stat as any)(file, ...rest);
  }) as typeof stat;
  const server = await loadFixed({ skipHealth: true, writeHandover: true, workspaces: tempWorkspaceFolders("fixed"), stat: gatedStat }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "work" });
  await tick();
  ws.message({ type: "save", tabId: "alpha-dev" });
  await inGap;
  const atSave = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  try {
    await action(ws);
  } finally {
    releaseGap();
  }
  await tick();
  await server.flush();
  return { server, ws, atSave, after: new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev") };
}

test("a chat sent during Save's handover check is not marked saved", async () => {
  const { ws, atSave, after } = await saveWithGapAction(async (ws) => { ws.message({ type: "chat", tabId: "alpha-dev", text: "never handed over" }); await tick(); });
  assert.ok(after.revision > atSave.revision, "the gap chat advanced the transcript");
  assert.equal(after.savedRevision, atSave.revision, "Save marks the revision the leader handed over, not the gap chat");
  assert.deepEqual(ws.messages.filter((message: any) => message.type === "saved").map((message: any) => message.savedRevision), [atSave.revision]);
});

test("a Clear during Save's handover check fails the Save and leaves the cleared tab unsaved", async () => {
  const { ws, after } = await saveWithGapAction(async (ws) => { ws.message({ type: "clear", tabId: "alpha-dev" }); });
  assert.equal(after.messages.length, 0);
  assert.equal(after.savedRevision, 0, "the empty cleared transcript must not come out saved");
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)));
});

test("a Stop during Save's handover check (leader replaced, handover unread) fails the Save and leaves the tab unsaved", async () => {
  const { ws, after } = await saveWithGapAction(async (ws) => { ws.message({ type: "stopAll" }); });
  assert.equal(after.savedRevision, 0, "a stopped leader's late Save must not mark the transcript saved");
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)));
});

test("Save keeps its tab busy during the handover check, then releases it", async () => {
  const { server, ws, after } = await saveWithGapAction(async (ws) => {
    ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/too-early" });
    assert.equal(ws.messages.at(-1).type, "error", "folder changes during Save must be rejected");
    assert.match(ws.messages.at(-1).message, /tab is busy/);
    ws.message({ type: "removeTab", tabId: "alpha-dev" });
    assert.equal(ws.messages.at(-1).type, "error", "tab removal during Save must be rejected");
    assert.match(ws.messages.at(-1).message, /busy/);
    assert.ok(lastState(ws).projects[0].tabs.some((tab: any) => tab.id === "alpha-dev"));
  });
  assert.equal(after.savedRevision, after.revision);
  assert.ok(ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"));
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/after-save" });
  assert.equal(lastState(ws).projects[0].tabs.find((tab: any) => tab.id === "alpha-dev").folder, "C:/work/after-save");
  ws.message({ type: "removeTab", tabId: "alpha-dev" });
  assert.equal(lastState(ws).projects[0].tabs.some((tab: any) => tab.id === "alpha-dev"), false);
});

test("a queued Save marks its tab busy before its serialized turn starts", async () => {
  let enterGap!: () => void, releaseGap!: () => void, held = false;
  const inGap = new Promise<void>((resolveGap) => { enterGap = resolveGap; });
  const gapOpen = new Promise<void>((resolveGap) => { releaseGap = resolveGap; });
  const gatedStat = (async (file: any, ...rest: any[]) => {
    if (!held && String(file).endsWith("RESUME.md")) { held = true; enterGap(); await gapOpen; }
    return (stat as any)(file, ...rest);
  }) as typeof stat;
  const workspaces = tempWorkspaceFolders("fixed");
  const server = await loadFixed({ skipHealth: true, writeHandover: true, workspaces, stat: gatedStat });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "alpha work" });
  await tick();
  ws.message({ type: "save", tabId: "alpha-dev" });
  await inGap;
  try {
    ws.message({ type: "save", tabId: "alpha-dev" });
    assert.deepEqual(server.chats.filter((entry: any) => entry.text.includes("Current message:\nSave a concise handover")).map((entry: any) => entry.tabId), ["alpha-dev"], "the second Save of the same tab waits for the first");
    assert.equal(server.stateMessage().projects[0].tabs[0].derived.busy, true);
    ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/too-early" });
    assert.equal(ws.messages.at(-1).type, "error", "queued Save folder change must be rejected");
    assert.match(ws.messages.at(-1).message, /tab is busy/);
  } finally {
    releaseGap();
  }
  await tick();
  await server.flush();
  await tick();
  await server.flush();
  assert.deepEqual(ws.messages.filter((message: any) => message.type === "saved").map((message: any) => message.tabId), ["alpha-dev", "alpha-dev"]);
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/after-queue" });
  assert.equal(lastState(ws).projects.flatMap((project: any) => project.tabs).find((tab: any) => tab.id === "alpha-dev").folder, "C:/work/after-queue");
});

test("a Save still waiting on its own tab does not hold up another tab's Save", async () => {
  const server = await loadFixed({ skipHealth: true, leaderDelayMs: 10, hangLeader: true, hangTab: "alpha-dev", writeHandover: true, workspaces: tempWorkspaceFolders("fixed") });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "hang" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "complete" });
  await tick(40);
  ws.message({ type: "save", tabId: "alpha-dev" });
  ws.message({ type: "save", tabId: "beta-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "saved" && message.tabId === "beta-dev"), "tab B's Save while tab A's Save is still waiting");
  assert.equal(ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"), false, "tab A is still waiting");
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), true);
});

test("Ask mode: a fixed launch asks the user first; Allow starts the run, Deny starts nothing", async () => {
  const { server, ws, deps } = await fixedGateServer("ask");
  const allowed = deps.launch("helper", "Fix the login bug\nthen run the tests");
  await waitFor(() => pendingFor(server).length === 1, "launch approval");
  const [item] = pendingFor(server);
  assert.equal(item.tool, "fixed-action");
  assert.equal(item.summary, "Action: assist\nPosition: Helper (helper)\nExecution: codex / gpt-6.1-sol / low\nFolder: C:/work/alpha\n\nLeader brief:\nFix the login bug\nthen run the tests", "the approval shows the WHOLE brief, line breaks kept");
  assert.equal(server.launched.length, 0, "nothing starts before Allow");
  assert.equal(lastState(ws).projects[0].tabs[0].pendingApprovals[0].tool, "fixed-action");
  ws.message({ type: "answerApproval", requestId: "launch_allow", tabId: "alpha-dev", approvalId: item.approvalId, allow: true });
  const started = await allowed;
  assert.equal(started.ok, true);
  assert.equal(server.launched.length, 1);
  await endRun(server, started.runId);
  const denied = deps.launch("helper", "Another job");
  await waitFor(() => pendingFor(server).length === 1, "second launch approval");
  ws.message({ type: "answerApproval", requestId: "launch_deny", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: false });
  const denial = await denied;
  assert.equal(denial.ok, false);
  assert.equal(denial.error, "The owner denied this action.");
  assert.equal(server.launched.length, 1, "Deny starts no run");
  assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "a denied launch reserves nothing");
  server.stopLeaderSession("alpha-dev");
});

test("Ask mode: a fixed launch asks even for a read-only seat, with no seat-specific exception", async () => {
  const { server, deps } = await fixedGateServer("ask");
  const outcome = await Promise.race([deps.launch("reviewer1", "review it"), tick(200).then(() => "held for approval")]);
  assert.equal(outcome, "held for approval", "a read-only fixed seat is held for approval too");
  assert.equal(pendingFor(server).length, 1);
  assert.equal(server.launched.length, 0);
  pendingFor(server).forEach((item: any) => item.settle(false));
  server.stopLeaderSession("alpha-dev");
});

test("Plan mode refuses every fixed launch, read-only seats included", async () => {
  const { server, deps } = await fixedGateServer("plan");
  for (const slot of ["helper", "reviewer1"]) {
    const refused = await deps.launch(slot, "work");
    assert.equal(refused.ok, false, slot);
    assert.match(refused.error, /Plan mode/, slot);
  }
  assert.equal(server.launched.length, 0);
  assert.equal(pendingFor(server).length, 0);
  assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "a refused launch reserves nothing");
  server.stopLeaderSession("alpha-dev");
});

test("Accept mode launches a fixed seat without asking", async () => {
  const { server, deps } = await fixedGateServer("accept");
  assert.equal((await deps.launch("helper", "work")).ok, true);
  assert.equal(pendingFor(server).length, 0);
  assert.equal(server.launched.length, 1);
  server.stopLeaderSession("alpha-dev");
});

test("a launch approval is denied when the leader is replaced while it waits", async () => {
  const { server, ws, deps } = await fixedGateServer("ask");
  const waiting = deps.launch("helper", "work");
  await waitFor(() => pendingFor(server).length === 1, "launch approval");
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const denial = await waiting;
  assert.equal(denial.ok, false);
  assert.equal(denial.error, "The owner denied this action.");
  assert.equal(server.launched.length, 0);
  assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null);
});

test("Undo is rejected once its expiry has passed even if the expiry timer has not fired yet", async () => {
  let clock = 1_000_000;
  const server = await loadFixed({ skipHealth: true, now: () => clock }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "gone" });
  await tick();
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const cleared = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  clock += 10_000;
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true, "the real expiry timer has not fired");
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.deepEqual(ws.messages.at(-1), { type: "chatUndoRejected", tabId: "alpha-dev", reason: "expired" });
  assert.deepEqual(new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev"), cleared);
});

test("Save fails when the handover file is missing", async () => assertSaveRejectsHandover("missing"));

test("Save fails when the handover file is stale", async () => assertSaveRejectsHandover("stale"));

test("leader tools launch only the crew belonging to their tab", async () => {
  const server = await loadFixed({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" });
  ws.message({ type: "chat", tabId: "alpha-design", text: "start" });
  await tick();
  const designDeps = server.leaderDeps.get("Design");
  const devDeps = server.leaderDeps.get("Development");
  const fixedNames = ["finish_fixed_task", "list_task_archives", "get_task_archive", "get_fixed_task", "reconcile_task_execution", "begin_planning", "accept_planner_report", "request_task_action", "verify_task_evidence"];
  assert.deepEqual([...designDeps.fixedSpecs().map((spec: any) => spec.name)], fixedNames, "each tab's leader offers exactly the fixed tools");
  assert.deepEqual([...devDeps.fixedSpecs().map((spec: any) => spec.name)], fixedNames);
  const { runId } = await server.launchFixedAction(server.currentActor("alpha-design"), null, ASSIST, "design work", "helper");
  assert.equal(server.launched.at(-1).run.seatKey, "alpha-design.helper");
  await endRun(server, runId, "alpha-design");
  await assert.rejects(server.launchFixedAction(server.currentActor("alpha-design"), null, ASSIST, "self launch", "leader"));
  assert.equal(server.launched.length, 1, "the leader's own seat is never launched as a worker");
  await assert.rejects(server.launchFixedAction({ ...server.currentActor("alpha-design"), tabId: "alpha-dev" }, null, ASSIST, "another tab's leader", "helper"), /no longer current/);
  assert.equal(server.launched.length, 1, "a leader cannot launch into another tab");
  server.stopLeaderSession("alpha-dev"); server.stopLeaderSession("alpha-design");
});

test("request actions echo ids, track state, enforce source and destination scope, and resolve from the destination tab", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  ws.message({ type: "sendRequest", requestId: "send_request_1", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Review", body: "Check the patch." });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "send_request_1"), "send request result");
  const sent = ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === "send_request_1");
  assert.equal(sent.status, "pending");
  assert.deepEqual(JSON.parse(JSON.stringify(server.stateMessage().requestActions.send_request_1)), { requestId: "send_request_1", status: "done", message: "Done" });
  assert.equal(server.requestsStore.pendingCount("beta-dev"), 1);

  ws.message({ type: "sendRequest", requestId: "send_spoofed", fromTabId: "beta-dev", toTabId: "alpha-dev", title: "Spoof", body: "No." });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "send_spoofed"), "source scope refusal");
  assert.equal(server.requestsStore.list().length, 1);

  const request = server.requestsStore.list()[0];
  ws.message({ type: "resolveRequest", requestId: "resolve_no_tab", id: request.id, status: "accepted" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "resolve_no_tab"), "a missing tabId is refused");
  assert.match(ws.messages.find((message: any) => message.requestId === "resolve_no_tab").message, /tabId is required/);
  ws.message({ type: "resolveRequest", requestId: "resolve_wrong_tab", id: request.id, status: "accepted", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "resolve_wrong_tab"), "wrong destination refusal");
  assert.match(ws.messages.find((message: any) => message.requestId === "resolve_wrong_tab").message, /not addressed to this tab/);
  assert.equal(server.requestsStore.pendingCount("beta-dev"), 1);

  // The destination tab answers whichever tab is open (alpha-dev stays selected here): Needs you lists requests for every tab.
  assert.equal(lastState(ws).selectedTabId, "alpha-dev");
  ws.message({ type: "resolveRequest", requestId: "resolve_request_1", id: request.id, status: "accepted", tabId: "beta-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "resolve_request_1"), "resolve request result");
  assert.equal(ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === "resolve_request_1").status, "accepted");
  assert.equal(server.requestsStore.pendingCount("beta-dev"), 0);
  assert.equal(server.stateMessage().requests[0].status, "accepted");
});

test("removing a request destination persists destinationRemoved", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "sendRequest", requestId: "send_remove_target", fromTabId: "alpha-dev", toTabId: "alpha-design", title: "Design review", body: "Please review." });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "send_remove_target"), "request creation");
  const request = server.requestsStore.list()[0];
  ws.message({ type: "removeTab", tabId: "alpha-design" });
  assert.equal(server.requestsStore.list().find((item: any) => item.id === request.id).status, "destinationRemoved");
  assert.equal(server.stateMessage().requests[0].status, "destinationRemoved");
});
