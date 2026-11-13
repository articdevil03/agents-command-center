import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ChatStore } from "../server/chat-store.ts";
import { config } from "./round2-setup.ts";
import { tempWorkspaceFolders, loadFixed, startHelper, setAssignment, connect, lastState, tick, waitFor } from "./round2-helpers.ts";

const notesOf = (server: any, tabId: string): string | undefined => server.stateMessage().projects.flatMap((project: any) => project.tabs).find((tab: any) => tab.id === tabId)?.notes?.content;

test("a completed leader turn refreshes its tab Changes and Notes snapshot", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  await tick();
  server.detailReads.length = 0;
  server.noteReads.length = 0;
  ws.message({ type: "chat", tabId: "alpha-dev", text: "finish and refresh" });
  await waitFor(() => server.detailReads.includes("C:/work/alpha"), "post-turn tab detail refresh");
  assert.ok(server.noteReads.includes("C:/work/alpha"), "the handover note is reread with git status");
  await waitFor(() => notesOf(server, "alpha-dev") === "notes of alpha-dev", "the note read for this tab's id reaches its state").catch(() => {});
  assert.equal(notesOf(server, "alpha-dev"), "notes of alpha-dev", "the note was read with this tab's id");
});

test("selecting a tab refreshes that tab's Changes and Notes snapshot", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  await tick();
  server.detailReads.length = 0;
  server.noteReads.length = 0;
  ws.message({ type: "selectTab", tabId: "beta-dev" });
  await waitFor(() => server.detailReads.includes("C:/work/beta"), "selected-tab git refresh");
  assert.ok(server.noteReads.includes("C:/work/beta"), "the selected tab handover note is reread");
  await waitFor(() => notesOf(server, "beta-dev") === "notes of beta-dev", "the note read for this tab's id reaches its state").catch(() => {});
  assert.equal(notesOf(server, "beta-dev"), "notes of beta-dev", "the note was read with this tab's id");
});

test("a finished worker refreshes its tab's Changes and Notes snapshot", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  const { runId } = await startHelper(server);
  server.detailReads.length = 0;
  server.noteReads.length = 0;
  server.closeRun(runId, 0);
  await waitFor(() => server.detailReads.includes("C:/work/alpha"), "finished-worker git refresh");
  assert.ok(server.noteReads.includes("C:/work/alpha"), "the finished worker handover note is reread");
  await waitFor(() => notesOf(server, "alpha-dev") === "notes of alpha-dev", "the note read for this tab's id reaches its state").catch(() => {});
  assert.equal(notesOf(server, "alpha-dev"), "notes of alpha-dev", "the note was read with this tab's id");
  server.stopLeaderSession("alpha-dev");
});

test("the last workspace project cannot be removed", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "removeProject", projectId: "beta" });
  assert.equal(lastState(ws).projects.length, 1);
  ws.message({ type: "removeProject", projectId: "alpha" });
  assert.match(ws.messages.at(-1).message, /last project/);
  assert.equal(lastState(ws).projects[0].id, "alpha");
});

test("a worker snapshots its tab folder and an idle leader restarts after the folder changes", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  const { runId } = await startHelper(server, "alpha-design", "helper", "design work");
  const run = server.launched[0].run;
  assert.equal(run.runId, runId);
  assert.equal(run.folder, "C:/work/alpha/design");
  assert.equal(ws.messages.find((message: any) => message.type === "runStart" && message.runId === run.runId).folder, run.folder);
  ws.message({ type: "changeFolder", tabId: "alpha-design", folder: "C:/work/new-design" });
  assert.match(ws.messages.at(-1).message, /tab is busy/);
  server.closeRun(run.runId, 0);
  await waitFor(() => !server.stateMessage().projects[0].tabs[1].activeWork, "the worker and its process tree end");
  ws.message({ type: "chat", tabId: "alpha-design", text: "start old-folder leader" });
  await tick();
  await waitFor(() => !server.activeLeaderTurns.has("alpha-design"), "the old-folder answer ends");
  const oldLeader = server.leaders.get("alpha-design");
  assert.ok(oldLeader, "the idle leader exists");
  ws.message({ type: "changeFolder", tabId: "alpha-design", folder: "C:/work/new-design" });
  assert.equal(oldLeader === server.leaders.get("alpha-design"), false);
  assert.equal(server.leaders.has("alpha-design"), false, "no leader runs in the new folder until the next message (its project hooks never run unasked)");
  ws.message({ type: "chat", tabId: "alpha-design", text: "start new-folder leader" });
  await tick();
  assert.equal(server.leaderCreates.at(-1).folder, "C:/work/new-design");
  await waitFor(() => !server.activeLeaderTurns.has("alpha-design"), "the new-folder answer ends");
});

const slotOf = (server: any, slot: string) => server.getWorkspaces().projects[0].tabs[0].fixedCrew.preferences[slot];
const CODEX_SOL = { cli: "codex", model: "gpt-6.1-sol", effort: "low" };

test("a whole-assignment save validates every field and preserves the saved assignment after a rejected one", async () => {
  const server = await loadFixed({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "hello" });
  const before = structuredClone(slotOf(server, "reviewer1"));
  const refused = await setAssignment(ws, "alpha-dev", "reviewer1", { ...CODEX_SOL, effort: "wild" });
  assert.equal(refused.type, "error");
  assert.match(refused.message, /Unknown crew effort/);
  assert.deepEqual(slotOf(server, "reviewer1"), before, "nothing is saved after the rejected field");
  const refusedModel = await setAssignment(ws, "alpha-dev", "reviewer1", { ...CODEX_SOL, model: "not-a-model" });
  assert.match(refusedModel.message, /crew model/);
  assert.deepEqual(slotOf(server, "reviewer1"), before);
  const saved = await setAssignment(ws, "alpha-dev", "reviewer1", { ...CODEX_SOL, effort: "high" });
  assert.equal(saved.type, "actionResult");
  assert.deepEqual(slotOf(server, "reviewer1"), { assignment: { ...CODEX_SOL, effort: "high" }, source: "user" });
  assert.equal(lastState(ws).projects[0].tabs[0].fixedCrew.preferences.reviewer1.assignment.effort, "high", "the page's state carries the saved assignment");
});

// Pack 7: a working crew seat keeps its assignment; the lock ends with the last run.
test("pack 7: a working crew seat refuses an assignment change and accepts it again once its runs end", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  const before = structuredClone(slotOf(server, "helper"));
  const { runId } = await startHelper(server);
  const otherModel = config.MODEL_OPTIONS.codex!.find((model) => model !== CODEX_SOL.model)!;
  const changes = [{ ...CODEX_SOL, model: otherModel }, { ...CODEX_SOL, effort: "high" }, { cli: "claude", model: config.MODEL_OPTIONS.claude![0], effort: "high" }];
  for (const assignment of changes) {
    const answer = await setAssignment(ws, "alpha-dev", "helper", assignment);
    assert.equal(answer.message, "This seat is working. Try again when it finishes", JSON.stringify(assignment));
    assert.deepEqual(slotOf(server, "helper"), before, "nothing is saved when the change is refused");
  }
  server.closeRun(runId, 0);
  await waitFor(() => !lastState(ws).projects[0].tabs[0].runs.some((run: any) => run.status === "working") && !server.stateMessage().projects[0].tabs[0].activeWork, "the run and its process tree end");
  const accepted = await setAssignment(ws, "alpha-dev", "helper", changes[0]);
  assert.equal(accepted.type, "actionResult");
  assert.deepEqual(slotOf(server, "helper").assignment, changes[0], "after the run ends the same change is accepted");
  server.stopLeaderSession("alpha-dev");
});

// Pack 7 round 1: a stop that was not confirmed may still be running, so its seat stays locked until the owner releases it.
test("pack 7: a seat with an unconfirmed process refuses an assignment change until it is released; an old row with no seat locks nothing", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  const before = structuredClone(slotOf(server, "coder").assignment);
  const changed = { ...CODEX_SOL, effort: "high" };
  server.launchSafety.uncertain.push({ seatId: "old-seat", pid: 778 });
  assert.equal((await setAssignment(ws, "alpha-dev", "coder", changed)).type, "actionResult");
  assert.deepEqual(slotOf(server, "coder").assignment, changed, "a legacy row with no seat locks no seat");
  server.launchSafety.uncertain.push({ seatId: "alpha-dev.coder", pid: 779 });
  const refused = await setAssignment(ws, "alpha-dev", "coder", before);
  assert.equal(refused.message, "This seat is working. Try again when it finishes");
  assert.deepEqual(slotOf(server, "coder").assignment, changed, "nothing is saved while the seat has an unconfirmed process");
  ws.message({ type: "releaseUnconfirmedSeat", seatId: "alpha-dev.coder", confirm: "release may leave a process running and editing files" });
  assert.equal((await setAssignment(ws, "alpha-dev", "coder", before)).type, "actionResult");
  assert.deepEqual(slotOf(server, "coder").assignment, before, "after the release the same change is accepted");
});

test("a seat blocked after a stop refuses a new launch until the owner unblocks it", async () => {
  const server = await loadFixed({ skipHealth: true });
  const ws = connect(server);
  const { runId } = await startHelper(server);
  ws.message({ type: "killRun", runId });
  await waitFor(() => server.blockedSeatKeys.has("alpha-dev.helper") && server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId === null, "the stopped seat is blocked and its process tree confirmed ended");
  await assert.rejects(startHelper(server), /launch blocked after a prior stop: alpha-dev\.helper/);
  assert.equal(server.launched.length, 1, "no second run started");
  ws.message({ type: "unblockSeat", seatKey: "alpha-dev.helper", confirm: "allow this seat to launch again" });
  assert.equal(ws.messages.findLast((message: any) => message.type === "launchBlockCleared")?.cleared, true);
  assert.equal(typeof (await startHelper(server)).runId, "string");
  assert.equal(server.launched.length, 2);
  server.stopLeaderSession("alpha-dev");
});

test("chat, clear, and transcript revisions stay scoped to their tab", async () => {
  const server = await loadFixed({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "alpha" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "beta" });
  await tick();
  assert.equal(server.leaders.size, 2);
  assert.deepEqual(server.leaderCreates.map((entry: any) => entry.folder).sort(), ["C:/work/alpha", "C:/work/beta"]);
  ws.message({ type: "clear", tabId: "alpha-dev" });
  await server.flush();
  const state = lastState(ws);
  assert.equal(state.projects[0].tabs[0].chatRevision, 3);
  assert.equal(state.projects[1].tabs[0].chatRevision, 2);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "fresh" });
  await tick();
  assert.equal(server.leaderCreates.length, 3, "clear starts a fresh leader on its next chat only");
  assert.match(server.chats.at(-1).text, /\.command-center[\\/]alpha-dev[\\/]RESUME\.md/);
  assert.match(server.chats.at(-1).text, /first read the existing handover/);
});

test("Clear Undo restores the exact transcript and revisions and stops a fresh leader", async () => {
  const workspaces = tempWorkspaceFolders("fixed");
  const server = await loadFixed({ skipHealth: true, writeHandover: true, workspaces }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "old work" });
  await tick();
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => {
    const snapshot = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
    return snapshot.revision > 0 && snapshot.savedRevision === snapshot.revision;
  }, "the leader Save to persist its revision");
  const before = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  assert.equal(before.savedRevision, before.revision);

  ws.message({ type: "clear", tabId: "alpha-dev" });
  ws.message({ type: "chat", tabId: "alpha-dev", text: "fresh work" });
  await tick();
  assert.equal(server.leaderCreates.length, 2, "Clear's first new chat creates a fresh leader");
  assert.equal(server.leaders.has("alpha-dev"), true);
  ws.message({ type: "undoClear", tabId: "alpha-dev" });

  const restored = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  assert.deepEqual(restored, before);
  assert.deepEqual(lastState(ws).projects[0].tabs[0].chatRevision, before.revision);
  assert.deepEqual(lastState(ws).projects[0].tabs[0].savedRevision, before.savedRevision);
  assert.deepEqual(ws.messages.findLast((message: any) => message.type === "chatRestored"), {
    type: "chatRestored", tabId: "alpha-dev", ...before,
  });
  assert.equal(server.leaders.has("alpha-dev"), false, "Undo discards the fresh leader session");
  assert.equal(server.leaderHandles[1].stopCalls, 1);
  assert.equal(server.pendingHandoverReads.has("alpha-dev"), true);
  assert.equal(server.pendingClearUndos.has("alpha-dev"), false);
});

test("Clear Undo expires after 10 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => t.mock.timers.reset());
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "clear", tabId: "alpha-dev" });
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true);
  t.mock.timers.tick(9_999);
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true);
  t.mock.timers.tick(1);
  assert.equal(server.pendingClearUndos.has("alpha-dev"), false);
  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.deepEqual(ws.messages.at(-1), { type: "chatUndoRejected", tabId: "alpha-dev", reason: "expired" });
  const tab = lastState(ws).projects[0].tabs[0];
  assert.equal(tab.chatRevision, 1);
  assert.equal(tab.savedRevision, 0);
});

test("Undo on another tab leaves the cleared tab and its pending snapshot unchanged", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "keep this" });
  await tick();
  const before = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const cleared = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  const betaBefore = new ChatStore(path.join(server.testRoot, "chats")).snapshot("beta-dev");

  ws.message({ type: "undoClear", tabId: "beta-dev" });
  assert.deepEqual(ws.messages.at(-1), { type: "chatUndoRejected", tabId: "beta-dev", reason: "unavailable" });
  assert.deepEqual(new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev"), cleared);
  assert.deepEqual(new ChatStore(path.join(server.testRoot, "chats")).snapshot("beta-dev"), betaBefore);
  assert.equal(server.pendingClearUndos.has("alpha-dev"), true);

  ws.message({ type: "undoClear", tabId: "alpha-dev" });
  assert.deepEqual(new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev"), before);
});
