import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_ORIGIN, root, keyedSocket, openWs, nextMessage, nextState } from "./http-helpers.ts";

test("WebSocket: a foreign Origin is rejected", async () => {
  const ws = keyedSocket({ origin: "https://evil.example" });
  const outcome = await new Promise((resolvePromise) => {
    ws.once("open", () => resolvePromise("open"));
    ws.once("unexpected-response", () => resolvePromise("rejected"));
    ws.once("error", () => resolvePromise("rejected"));
  });
  assert.equal(outcome, "rejected");
});

test("WebSocket: no Origin header (non-browser client) is accepted", async () => {
  const ws = keyedSocket();
  const outcome = await new Promise((resolvePromise, reject) => {
    ws.once("open", () => resolvePromise("open"));
    ws.once("error", reject);
  });
  assert.equal(outcome, "open");
  ws.close();
});

test("WebSocket: a loopback Origin is accepted", async () => {
  const ws = keyedSocket({ origin: BASE_ORIGIN });
  const outcome = await new Promise((resolvePromise, reject) => {
    ws.once("open", () => resolvePromise("open"));
    ws.once("error", reject);
  });
  assert.equal(outcome, "open");
  ws.close();
});

test("WebSocket: history rejects an unsafe legacy seat id (path-traversal attempt)", async () => {
  const ws = await openWs();
  try {
    const reply1 = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyList", seatKey: "../outside/run" }));
    const listReply = await reply1;
    assert.equal(listReply.type, "error");
    assert.match(listReply.message, /invalid seat key/);

    const reply2 = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyRun", seatKey: "../outside/run", timestamp: 123 }));
    const runReply = await reply2;
    assert.equal(runReply.type, "error");
    assert.match(runReply.message, /invalid history run/);
  } finally {
    ws.close();
  }
});

test("WebSocket: historyList + historyRun round-trip for an old bare seat id and log file", async () => {
  const seatId = "sonny";
  const timestamp = Date.now();
  const logsDirPath = join(root, "data", "logs");
  mkdirSync(logsDirPath, { recursive: true });
  const logPath = join(logsDirPath, `${seatId}-${timestamp}.log`);
  writeFileSync(logPath, "hello from history\n[exit] status=done code=0\n");
  writeFileSync(join(logsDirPath, `${seatId}-${timestamp}.brief.txt`), "the brief");

  const ws = await openWs();
  try {
    const listReplyP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyList", seatKey: seatId }));
    const listReply = await listReplyP;
    assert.equal(listReply.type, "historyList");
    assert.ok(listReply.runs.some((e: { timestamp: number }) => e.timestamp === timestamp));

    const runReplyP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyRun", seatKey: seatId, timestamp }));
    const runReply = await runReplyP;
    assert.equal(runReply.type, "historyRun");
    assert.equal(runReply.seatKey, seatId);
    assert.equal(runReply.timestamp, timestamp);
    assert.equal(runReply.brief, "the brief");
    assert.match(runReply.output, /hello from history/);
    assert.equal(runReply.totalBytes, readFileSync(logPath, "utf8").length);
    assert.equal(runReply.full, false, "a plain request is echoed as not the fuller log");
  } finally {
    ws.close();
  }
});

test("WebSocket: an explicit 'full' history load still has a hard ceiling, never the entire (oversized) file", async () => {
  const seatId = "sonny";
  const timestamp = Date.now() + 1; // distinct from the round-trip test's file
  const logsDirPath = join(root, "data", "logs");
  mkdirSync(logsDirPath, { recursive: true });
  const oversized = "a".repeat(9 * 1024 * 1024); // bigger than the 8 MiB ceiling
  writeFileSync(join(logsDirPath, `${seatId}-${timestamp}.log`), oversized);

  const ws = await openWs();
  try {
    const replyP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyRun", seatKey: seatId, timestamp, full: true }));
    const reply = await replyP;
    assert.equal(reply.type, "historyRun");
    assert.equal(reply.truncated, true, "even an explicit full request must still be capped");
    assert.ok(reply.output.length < oversized.length, "must never ship the whole oversized file");
    assert.equal(reply.totalBytes, oversized.length);
    assert.equal(reply.full, true, "a fuller-log request is echoed so the page labels the reply from it");
  } finally {
    ws.close();
  }
});

// Legacy bare-id logs stay readable even though workspace seats now use tab-scoped keys.
test("WebSocket: history remains readable for a retired legacy bare seat id", async () => {
  const seatId = "retired-x";
  const timestamp = Date.now() + 2;
  const logsDirPath = join(root, "data", "logs");
  mkdirSync(logsDirPath, { recursive: true });
  writeFileSync(join(logsDirPath, `${seatId}-${timestamp}.log`), "the retired seat's own old output\n[exit] status=done code=0\n");
  writeFileSync(join(logsDirPath, `${seatId}-${timestamp}.brief.txt`), "the retired seat's old brief");

  const ws = await openWs();
  try {
    const listReplyP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyList", seatKey: seatId }));
    const listReply = await listReplyP;
    assert.equal(listReply.type, "historyList", "a removed seat's history must remain readable");
    assert.ok(listReply.runs.some((e: { timestamp: number }) => e.timestamp === timestamp));

    const runReplyP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyRun", seatKey: seatId, timestamp }));
    const runReply = await runReplyP;
    assert.equal(runReply.type, "historyRun");
    assert.equal(runReply.brief, "the retired seat's old brief");
    assert.match(runReply.output, /the retired seat's own old output/);
  } finally {
    ws.close();
  }
});

test("selected-tab instruction inventory stays scoped during a background folder refresh", async () => {
  const firstFolder = join(root, "settings-scope-first");
  const secondFolder = join(root, "settings-scope-second");
  const changedFirstFolder = join(root, "settings-scope-first-changed");
  for (const folder of [firstFolder, secondFolder, changedFirstFolder]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(firstFolder, "CLAUDE.md"), "first tab");
  writeFileSync(join(secondFolder, "CLAUDE.md"), "selected tab");
  writeFileSync(join(changedFirstFolder, "CLAUDE.md"), "background refresh");

  const ws = await openWs();
  try {
    const addFirst = nextState(ws, (state) => state.projects.some((project: any) => project.id === "settingsscopefirst"));
    ws.send(JSON.stringify({ type: "addProject", requestId: "scope_first", fixedCrewVersion: 1, crewChoices: {}, autoAssign: false, id: "settingsscopefirst", name: "First", folder: firstFolder, tabId: "settingsscopefirst-development" }));
    await addFirst;
    const addSecond = nextState(ws, (state) => state.projects.some((project: any) => project.id === "settingsscopesecond"));
    ws.send(JSON.stringify({ type: "addProject", requestId: "scope_second", fixedCrewVersion: 1, crewChoices: {}, autoAssign: false, id: "settingsscopesecond", name: "Second", folder: secondFolder, tabId: "settingsscopesecond-development" }));
    await addSecond;

    const changed = nextState(ws, (state) => state.projects.some((project: any) => project.id === "settingsscopefirst"
      && project.tabs.some((tab: any) => tab.folder === changedFirstFolder)));
    ws.send(JSON.stringify({ type: "changeFolder", tabId: "settingsscopefirst-development", folder: changedFirstFolder }));
    await changed;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    const fresh = await openWs();
    try {
      const statePromise = nextState(fresh, () => true);
      fresh.send(JSON.stringify({ type: "hello"}));
      const state = await statePromise;
      const projectInstructions = state.settings.skills.claude.instructionFiles.filter((item: any) => item.scope === "project");
      assert.equal(state.selectedTabId, "settingsscopesecond-development");
      assert.deepEqual(projectInstructions.map((item: any) => item.path), [join(secondFolder, "CLAUDE.md")]);
    } finally { fresh.close(); }
  } finally { ws.close(); }
});
