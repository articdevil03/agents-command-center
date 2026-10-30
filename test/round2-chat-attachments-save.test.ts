import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as history from "../server/history.ts";
import { ChatStore } from "../server/chat-store.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { tempWorkspaceFolders, loadServer, connect, lastState, tick, waitFor, flushMicrotasks } from "./round2-helpers.ts";

test("chat rejects images outside the upload scratch directory at the WebSocket boundary", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const outside = path.join(server.testRoot, `paste-${randomUUID()}.png`);
  writeFileSync(outside, "outside image");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "outside image", images: [outside] });
  assert.match(ws.messages.at(-1).message, /uploaded scratch image/);
  assert.equal(server.leaders.size, 0);
  assert.equal(ws.messages.some((message: any) => message.type === "chatMessage"), false);
});

test("chat accepts only an existing generated image in scratch", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const scratch = path.join(server.testRoot, "scratch");
  mkdirSync(scratch, { recursive: true });
  const image = path.join(scratch, `paste-${randomUUID()}.png`);
  writeFileSync(image, "uploaded image bytes");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "Describe this image", images: [image], requestId: "image_chat_valid" });
  const echo = ws.messages.find((message: any) => message.type === "chatMessage" && message.requestId === "image_chat_valid");
  assert.deepEqual(echo?.images, [image]);
  assert.equal(server.leaders.size, 1);
  await tick();
  await server.flush();
  assert.equal(server.activeLeaderTurns.size, 0, "the leader turn is settled when the test ends");
});

test("chat rejects attachment paths outside scratch and over-limit file lists before creating a leader", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const outside = path.join(server.testRoot, "file-00000000-0000-4000-8000-000000000001.txt");
  writeFileSync(outside, "outside scratch");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "read this", files: [outside], requestId: "file_bad_path" });
  assert.equal(ws.messages.at(-1).requestId, "file_bad_path");
  assert.match(ws.messages.at(-1).message, /uploaded scratch file/);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "too many", files: Array.from({ length: 9 }, () => "file-00000000-0000-4000-8000-000000000001.txt"), requestId: "file_too_many" });
  assert.equal(ws.messages.at(-1).requestId, "file_too_many");
  assert.match(ws.messages.at(-1).message, /list of uploaded file paths/);
  assert.equal(server.leaders.size, 0);
  assert.equal(ws.messages.some((message: any) => message.type === "chatMessage"), false);
});

test("chat refuses a generated-looking attachment reached through a scratch directory junction", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const scratch = path.join(server.testRoot, "scratch");
  const outside = path.join(server.testRoot, "outside-scratch");
  mkdirSync(outside, { recursive: true });
  const name = `file-${randomUUID()}.txt`;
  writeFileSync(path.join(outside, name), "outside attachment");
  removeWithRetry(scratch);
  symlinkSync(outside, scratch, "junction");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "read the linked file", files: [path.join(scratch, name)], requestId: "file_symlink_escape" });
  assert.equal(ws.messages.at(-1).requestId, "file_symlink_escape");
  assert.match(ws.messages.at(-1).message, /uploaded file is unavailable/);
  assert.equal(server.leaders.size, 0);
});

test("chat accepts a generated scratch attachment and names its path in the leader prompt", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const scratch = path.join(server.testRoot, "scratch");
  mkdirSync(scratch, { recursive: true });
  const file = path.join(scratch, `file-${randomUUID()}.txt`);
  writeFileSync(file, "attachment contents", "utf8");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "Read this file", files: [file], requestId: "file_chat_valid" });
  const echo = ws.messages.find((message: any) => message.type === "chatMessage" && message.requestId === "file_chat_valid");
  assert.deepEqual(echo?.files, [file]);
  await tick();
  assert.match(server.chats[0].text, /Attached files\. Read these local paths/);
  assert.ok(server.chats[0].text.includes(file));
  assert.equal(server.leaders.size, 1);
});

test("chat request ids ride the echo, the persisted history and the refusal; an invalid id is refused", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "with id", requestId: "req-echo-1" });
  const echo = ws.messages.find((message: any) => message.type === "chatMessage");
  assert.equal(echo?.text, "with id", "the accepted chat was echoed");
  assert.equal(echo.requestId, "req-echo-1", "the echo carries the sender's request id");
  ws.message({ type: "selectTab", tabId: "alpha-design" });
  ws.message({ type: "selectTab", tabId: "alpha-dev" });
  const history = ws.messages.findLast((message: any) => message.type === "chatHistory" && message.tabId === "alpha-dev");
  assert.equal(history?.messages?.find((message: any) => message.text === "with id")?.requestId, "req-echo-1", "chatHistory replays the request id");
  const reloaded = new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev");
  assert.equal(reloaded.messages.find((message: any) => message.text === "with id")?.requestId, "req-echo-1", "a reloaded store keeps the request id");

  const chatsBefore = server.chats.length;
  ws.message({ type: "chat", tabId: "alpha-dev", text: "refused", requestId: "req-refused-2", images: [path.join(server.testRoot, "outside.png")] });
  const refusal = ws.messages.at(-1);
  assert.equal(refusal.type, "error");
  assert.match(refusal.message, /uploaded scratch image/);
  assert.deepEqual({ action: refusal.action, tabId: refusal.tabId, requestId: refusal.requestId }, { action: "chat", tabId: "alpha-dev", requestId: "req-refused-2" });

  await waitFor(() => !server.activeLeaderTurns.has("alpha-dev"), "the first leader turn to finish");
  const messagesBefore = ws.messages.length;
  ws.message({ type: "chat", tabId: "alpha-dev", text: "bad id", requestId: "../escape" });
  const invalid = ws.messages.slice(messagesBefore);
  assert.deepEqual(invalid.map((message: any) => message.type), ["error"], "an invalid request id gets only an error");
  assert.match(invalid[0].message, /invalid request id/);
  assert.equal(invalid[0].requestId, undefined, "an unsafe id is never echoed back");
  assert.equal(server.chats.length, chatsBefore, "no leader turn started for refused chats");
  assert.equal(new ChatStore(path.join(server.testRoot, "chats")).snapshot("alpha-dev").messages.some((message: any) => message.text === "bad id" || message.text === "refused"), false, "refused chats were not stored");
});

test("a second chat is rejected while the leader is answering and busy includes that leader turn", async () => {
  const server = await loadServer({ skipHealth: true, hangLeader: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "first" });
  assert.equal(lastState(ws).projects[0].tabs[0].derived.busy, true);
  assert.equal(lastState(ws).projects[0].tabs[0].derived.leaderTurnActive, true);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "too soon" });
  assert.match(ws.messages.at(-1).message, /leader is still answering/);
  assert.equal(server.chats.length, 1);
});

test("derived.leaderTurnActive tracks leader turns and excludes a running worker", async () => {
  const server = await loadServer({ skipHealth: true, hangLeader: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "worker while the leader is idle");
  const workerRunId = server.launched[0].run.runId;
  const workerOnly = server.stateMessage().projects[0].tabs[0];
  assert.equal(workerOnly.derived.busy, true);
  assert.equal(workerOnly.derived.leaderTurnActive, false);

  ws.message({ type: "chat", tabId: "alpha-dev", text: "start leader turn" });
  assert.equal(lastState(ws).projects[0].tabs[0].derived.leaderTurnActive, true);
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const workerAfterLeaderStops = server.stateMessage().projects[0].tabs[0];
  assert.equal(workerAfterLeaderStops.derived.busy, true, "the worker is still running");
  assert.equal(workerAfterLeaderStops.derived.leaderTurnActive, false);
  server.closeRun(workerRunId);
});

// The app asks before it closes while a tab is working (answerCloseRequest in public/app/06-crew-rail.js): it reads each tab's activeWork, which is the
// server's own tabHasActiveWork, the check that refuses changing a busy tab's folder.
test("every tab's state carries activeWork: true while a worker or a leader turn runs in it, false when it is idle", async () => {
  const server = await loadServer({ skipHealth: true, hangLeader: true }), ws = connect(server);
  const tab = (id: string, state = server.stateMessage()) => state.projects.flatMap((project: any) => project.tabs).find((item: any) => item.id === id);
  assert.deepEqual([tab("alpha-dev").activeWork, tab("alpha-design").activeWork], [false, false], "idle tabs");
  server.launchWorker("alpha-dev", "reviewer2", "a worker");
  const runId = server.launched[0].run.runId;
  assert.deepEqual([tab("alpha-dev").activeWork, tab("alpha-design").activeWork], [true, false], "only the tab with the running worker");
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/new" });
  assert.match(ws.messages.at(-1).message, /tab is busy/, "the same check refuses its folder change");
  server.closeRun(runId);
  assert.equal(tab("alpha-dev").activeWork, false, "the worker exited");
  ws.message({ type: "chat", tabId: "alpha-design", text: "a leader turn" });
  assert.equal(tab("alpha-design", lastState(ws)).activeWork, true, "a leader turn, as broadcast to the page");
});

test("Saves of different tabs run side by side and only record the revision after a successful leader turn", async () => {
  const workspaces = tempWorkspaceFolders();
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 25, writeHandover: true, workspaces });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "alpha" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "beta" });
  await tick(40);
  ws.message({ type: "save", tabId: "alpha-dev" });
  ws.message({ type: "save", tabId: "beta-dev" });
  await waitFor(() => {
    const tabs = lastState(ws).projects.flatMap((project: any) => project.tabs);
    return ["alpha-dev", "beta-dev"].every((id) => {
      const tab = tabs.find((item: any) => item.id === id);
      return tab && tab.savedRevision === tab.chatRevision && tab.savedRevision > 2;
    });
  }, "both tabs to finish their Saves");
  assert.equal(server.maxSaveActive(), 2, "tab B's Save does not wait for tab A's");
  const tabs = lastState(ws).projects.flatMap((project: any) => project.tabs);
  for (const id of ["alpha-dev", "beta-dev"]) {
    const tab = tabs.find((item: any) => item.id === id);
    assert.equal(tab.savedRevision, tab.chatRevision, `${id} Save leaves the current revision saved`);
    assert.ok(tab.savedRevision > 2, `${id} includes the assistant's successful handover response`);
  }
  assert.ok(ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"));
  assert.ok(ws.messages.some((message: any) => message.type === "saved" && message.tabId === "beta-dev"));
  assert.ok(server.chats.some((entry: any) => entry.tabId === "alpha-dev" && entry.text.replaceAll("\\", "/").includes(`${workspaces.projects[0].tabs[0].folder.replaceAll("\\", "/")}/.command-center/alpha-dev/RESUME.md`)));
});

test("Save broadcasts activeWork true when it starts on an idle tab and false when it ends, so the close warning is never stale", async () => {
  const hung = await loadServer({ skipHealth: true, hangSave: true }), hungWs = connect(hung);
  const working = (ws: any) => lastState(ws).projects[0].tabs[0].activeWork;
  hungWs.message({ type: "chat", tabId: "alpha-dev", text: "alpha" });
  await tick(40);
  assert.equal(working(hungWs), false, "idle before Save");
  hungWs.message({ type: "save", tabId: "alpha-dev" });
  await flushMicrotasks();
  assert.equal(working(hungWs), true, "the state broadcast by the Save start already says working");
  // A failed Save has no other broadcast after it, so only the Save's own end can clear the tab's activeWork.
  const server = await loadServer({ skipHealth: true, failSave: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "alpha" });
  await tick(40);
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.action === "save"), "the Save to fail");
  await waitFor(() => working(ws) === false, "a state broadcast after the Save ended to say idle");
});

test("a hung Save does not block Clear for another tab", async () => {
  const server = await loadServer({ skipHealth: true, hangSave: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "alpha" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "beta" });
  await tick(10);
  ws.message({ type: "save", tabId: "alpha-dev" });
  await flushMicrotasks();
  ws.message({ type: "clear", tabId: "beta-dev" });
  assert.equal(server.leaders.has("beta-dev"), false);
  const beta = lastState(ws).projects[1].tabs[0];
  assert.equal(beta.chatRevision, 3);
  assert.equal(beta.savedRevision, 0);
  const clearedAt = ws.messages.findIndex((message: any) => message.type === "chatCleared" && message.tabId === "beta-dev");
  assert.ok(clearedAt >= 0, "Clear completes while another tab's Save remains hung");
  assert.equal(server.activeLeaderTurns.has("alpha-dev"), true);
});

test("Save waits for the active leader turn, then records the fully answered revision", async () => {
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 35, writeHandover: true, workspaces: tempWorkspaceFolders() });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "answer before saving" });
  ws.message({ type: "save", tabId: "alpha-dev" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "saved" && message.tabId === "alpha-dev"), "Save after the active leader turn");
  const tab = lastState(ws).projects[0].tabs[0];
  assert.equal(tab.savedRevision, tab.chatRevision);
  assert.equal(tab.chatRevision, 3);
  assert.ok(ws.messages.some((message: any) => message.type === "saved" && message.savedRevision === 3));
});

test("a hung leader turn times out of the Save queue so another tab can save", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const server = await loadServer({ skipHealth: true, leaderDelayMs: 10, hangLeader: true, hangTab: "alpha-dev", writeHandover: true, workspaces: tempWorkspaceFolders() });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "hang" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "complete" });
  t.mock.timers.tick(10);
  await flushMicrotasks();
  ws.message({ type: "save", tabId: "alpha-dev" });
  ws.message({ type: "save", tabId: "beta-dev" });
  await flushMicrotasks();
  t.mock.timers.tick(30_000);
  await flushMicrotasks();
  t.mock.timers.tick(10);
  await flushMicrotasks();
  await server.flush();
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /timed out waiting for the active leader turn/.test(message.message)));
  const beta = lastState(ws).projects[1].tabs[0];
  assert.equal(beta.savedRevision, beta.chatRevision);
});

test("a failed leader Save leaves the transcript marked unsaved and clears the busy guard", async () => {
  const server = await loadServer({ skipHealth: true, failSave: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "work" });
  await tick();
  ws.message({ type: "save", tabId: "alpha-dev" });
  await tick();
  await server.flush();
  const tab = lastState(ws).projects[0].tabs[0];
  assert.equal(tab.savedRevision, 0);
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /could not save/.test(message.message)));
  assert.equal(ws.messages.some((message: any) => message.type === "saved"), false);
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/after-failed-save" });
  assert.equal(lastState(ws).projects[0].tabs.find((item: any) => item.id === "alpha-dev").folder, "C:/work/after-failed-save");
  ws.message({ type: "removeTab", tabId: "alpha-dev" });
  assert.equal(lastState(ws).projects[0].tabs.some((item: any) => item.id === "alpha-dev"), false);
});
