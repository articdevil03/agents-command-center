import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ChatStore } from "../server/chat-store.ts";
import { tempWorkspaceFolders, loadServer, connect, lastState, tick, waitFor } from "./round2-helpers.ts";

const notesOf = (server: any, tabId: string): string | undefined => server.stateMessage().projects.flatMap((project: any) => project.tabs).find((tab: any) => tab.id === tabId)?.notes?.content;

test("a completed leader turn refreshes its tab Changes and Notes snapshot", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
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
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
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
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "finish and refresh" });
  const runId = server.launched[0].run.runId;
  server.detailReads.length = 0;
  server.noteReads.length = 0;
  server.closeRun(runId, 0);
  await waitFor(() => server.detailReads.includes("C:/work/alpha"), "finished-worker git refresh");
  assert.ok(server.noteReads.includes("C:/work/alpha"), "the finished worker handover note is reread");
  await waitFor(() => notesOf(server, "alpha-dev") === "notes of alpha-dev", "the note read for this tab's id reaches its state").catch(() => {});
  assert.equal(notesOf(server, "alpha-dev"), "notes of alpha-dev", "the note was read with this tab's id");
});

test("the last workspace project cannot be removed", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "removeProject", projectId: "beta" });
  assert.equal(lastState(ws).projects.length, 1);
  ws.message({ type: "removeProject", projectId: "alpha" });
  assert.match(ws.messages.at(-1).message, /last project/);
  assert.equal(lastState(ws).projects[0].id, "alpha");
});

test("run snapshots its tab folder and an idle leader restarts after the folder changes", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-design", slot: "designer", prompt: "design work" });
  const run = server.launched[0].run;
  assert.equal(run.folder, "C:/work/alpha/design");
  assert.equal(ws.messages.find((message: any) => message.type === "runStart" && message.runId === run.runId).folder, run.folder);
  ws.message({ type: "changeFolder", tabId: "alpha-design", folder: "C:/work/new-design" });
  assert.match(ws.messages.at(-1).message, /tab is busy/);
  server.closeRun(run.runId, 0);
  ws.message({ type: "chat", tabId: "alpha-design", text: "start old-folder leader" });
  await tick();
  const oldLeader = server.leaders.get("alpha-design");
  ws.message({ type: "changeFolder", tabId: "alpha-design", folder: "C:/work/new-design" });
  assert.equal(oldLeader === server.leaders.get("alpha-design"), false);
  assert.equal(server.leaders.has("alpha-design"), false, "no leader runs in the new folder until the next message (its project hooks never run unasked)");
  ws.message({ type: "chat", tabId: "alpha-design", text: "start new-folder leader" });
  await tick();
  assert.equal(server.leaderCreates.at(-1).folder, "C:/work/new-design");
});

test("seat updates validate the whole request and preserve the prior member after a rejected field", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "hello" });
  const before = lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "reviewer1");
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "reviewer1", name: "Changed", effort: "wild" });
  assert.match(ws.messages.at(-1).message, /invalid effort/);
  const after = lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "reviewer1");
  assert.equal(after.name, before.name);
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "reviewer1", name: "Changed", effort: "high" });
  assert.equal(lastState(ws).projects[0].tabs[0].crew.find((seat: any) => seat.slot === "reviewer1").name, "Changed");
});

// Pack 7: a working crew seat keeps its model, effort and CLI; name and picture still change; the lock ends with the last run.
test("pack 7: a working crew seat refuses a model, effort or CLI change and accepts it again once its runs end", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const seatOf = () => server.getWorkspaces().projects[0].tabs[0].crew.find((seat: any) => seat.slot === "coder");
  const before = { ...seatOf() };
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "working" });
  const runId = server.launched[0].run.runId;
  for (const change of [{ model: "gpt-6-sol" }, { effort: before.effort === "high" ? "low" : "high" }, { cli: "claude", model: "claude-opus-5" }]) {
    const sent = ws.messages.length;
    ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", ...change });
    assert.equal(ws.messages.slice(sent).findLast((message: any) => message.type === "error")?.message, `${before.name} is working. Change the model when its runs finish.`, JSON.stringify(change));
    assert.deepEqual(seatOf(), before, "nothing is saved when the change is refused");
  }
  const sent = ws.messages.length;
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", name: "Renamed", model: before.model });
  assert.equal(ws.messages.slice(sent).some((message: any) => message.type === "error"), false, "a rename (with an unchanged model) still works: " + JSON.stringify(ws.messages.slice(sent).filter((message: any) => message.type === "error")));
  assert.equal(seatOf().name, "Renamed");
  server.closeRun(runId, 0);
  await waitFor(() => !lastState(ws).projects[0].tabs[0].runs.some((run: any) => run.status === "working"), "the run ends");
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", model: "gpt-6-sol" });
  assert.equal(seatOf().model, "gpt-6-sol", "after the run ends the same change is accepted");
});

// Pack 7 round 1: a stop that was not confirmed may still be running, so its seat stays locked until the owner releases it.
test("pack 7: a seat with an unconfirmed process refuses a model change until it is released; an old row with no seat locks nothing", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const seatOf = () => server.getWorkspaces().projects[0].tabs[0].crew.find((seat: any) => seat.slot === "coder");
  const before = { ...seatOf() };
  server.launchSafety.uncertain.push({ seatId: "old-seat", pid: 778 });
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", model: "gpt-6-sol" });
  assert.equal(seatOf().model, "gpt-6-sol", "a legacy row with no seat locks no seat");
  server.launchSafety.uncertain.push({ seatId: "alpha-dev.coder", pid: 779 });
  const sent = ws.messages.length;
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", model: before.model });
  assert.equal(ws.messages.slice(sent).findLast((message: any) => message.type === "error")?.message, `${before.name} is working. Change the model when its runs finish.`);
  assert.equal(seatOf().model, "gpt-6-sol", "nothing is saved while the seat has an unconfirmed process");
  ws.message({ type: "releaseUnconfirmedSeat", seatId: "alpha-dev.coder", confirm: "release may leave a process running and editing files" });
  ws.message({ type: "updateSeat", tabId: "alpha-dev", slot: "coder", model: before.model });
  assert.equal(seatOf().model, before.model, "after the release the same change is accepted");
});

test("process changes reject busy tabs and seats blocked after a stop, then rebuild the saved crew once released", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  const oldCrew = structuredClone(server.getWorkspaces().projects[0].tabs[0].crew);
  const coder = oldCrew.find((seat: any) => seat.slot === "coder");
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "working" });
  ws.message({ type: "useSetup", tabId: "alpha-dev", templateId: "blank" });
  assert.match(ws.messages.at(-1).message, /busy/);
  ws.message({ type: "killRun", runId: server.launched[0].run.runId });
  ws.message({ type: "useSetup", tabId: "alpha-dev", templateId: "blank" });
  const error = ws.messages.findLast((message: any) => message.type === "error");
  assert.match(error.message, /cannot be taken out yet/);
  assert.ok(error.message.includes(coder.name), "the refusal names the coder seat");
  const unchanged = lastState(ws).projects[0].tabs[0];
  assert.equal(unchanged.setupName, "The Main Crew");
  assert.deepEqual(unchanged.crew.map((seat: any) => seat.slot), oldCrew.map((seat: any) => seat.slot));
  assert.deepEqual(server.getWorkspaces().projects[0].tabs[0].crew, oldCrew, "nothing is saved while the stopped seat is blocked");
  ws.message({ type: "unblockSeat", seatKey: "alpha-dev.coder", confirm: "allow this seat to launch again" });
  assert.equal(ws.messages.findLast((message: any) => message.type === "launchBlockCleared")?.cleared, true);
  ws.message({ type: "useSetup", tabId: "alpha-dev", templateId: "blank" });
  const tab = lastState(ws).projects[0].tabs[0];
  assert.equal(tab.setupName, "Start blank");
  assert.deepEqual(tab.crew.map((seat: any) => seat.slot), ["leader"]);
});

test("chat, clear, and transcript revisions stay scoped to their tab", async () => {
  const server = await loadServer({ skipHealth: true });
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
  const workspaces = tempWorkspaceFolders();
  const server = await loadServer({ skipHealth: true, writeHandover: true, workspaces }), ws = connect(server);
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
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
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
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
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
