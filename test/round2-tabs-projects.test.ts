import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as usage from "../server/usage.ts";
import { moduleDataDir, config } from "./round2-setup.ts";
import { fixtureWorkspaces, loadServer, connect, lastState, tick, waitFor } from "./round2-helpers.ts";
import { loadLeaderHarness } from "./round2-leader-harness.ts";

test("this file's config module keeps its files in a temp data folder, never in the repo's config/", () => {
  assert.equal(path.dirname(path.dirname(config.workspacesPath)).toLowerCase(), moduleDataDir.toLowerCase());
  assert.equal(path.dirname(path.dirname(config.clientPrefsPath)).toLowerCase(), moduleDataDir.toLowerCase());
});

test("hello sends projects -> tabs -> crew and does not create a leader; chat lazily creates one in the tab folder", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "hello" });
  const state = lastState(ws);
  assert.equal(state.projects[0].tabs[0].crew.length, 6);
  assert.equal(state.projects[0].tabs[0].processState.tabId, "alpha-dev");
  assert.equal(server.leaders.size, 0, "hello must not start any per-tab leader");
  ws.message({ type: "chat", tabId: "alpha-design", text: "Design this" });
  const answered = () => ws.messages.some((message: any) => message.type === "chatMessage" && message.tabId === "alpha-design" && message.role === "assistant");
  await waitFor(() => server.leaders.size === 1 && answered(), "the chat's leader and its assistant message", 30_000);
  assert.equal(server.leaders.size, 1);
  assert.deepEqual(server.leaderCreates[0], { settings: { model: "claude-opus-5-5[1m]", effort: "high" }, folder: "C:/work/alpha/design", cliPath: null });
  assert.ok(answered());
  assert.equal(lastState(ws).projects[0].tabs[1].chatRevision, 2);
});

test("a damaged settings file: the first page is told once, and the tabs ask", async () => {
  const server = await loadServer({ skipHealth: true, preload: (root) => writeFileSync(path.join(root, "settings.json"), "{not json") });
  const ws = connect(server);
  ws.message({ type: "hello" }); ws.message({ type: "hello" });
  const told = ws.messages.filter((message: any) => message.type === "error" && /damaged/.test(message.message));
  assert.equal(told.length, 1, "told once, not on every hello");
  assert.ok(lastState(ws).projects[0].tabs.every((tab: any) => tab.permissionMode === "ask"), "every tab without a saved mode asks");
});

test("the startup health check runs once and hello never starts another check or leader", async () => {
  const server = await loadServer();
  const ws = connect(server);
  ws.message({ type: "hello" }); ws.message({ type: "hello" });
  await waitFor(() => server.queryCount() >= 1, "the startup health check to run", 30_000);
  await tick(); // a short settle: a second check or a leader would show by now
  assert.equal(server.queryCount(), 1);
  assert.equal(server.leaders.size, 0);
});

test("real tab leader SDK options use the tab folder and load user, project, and local settings", () => {
  let sdkOptions: any;
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }) };
  const createLeader = loadLeaderHarness((args) => { sdkOptions = args.options; return handle; });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work/alpha/design", null, {
    onDelta() {}, onDone() {}, onUsage() {}, onError() {},
  });
  try {
    assert.equal(sdkOptions.cwd, "C:/work/alpha/design");
    assert.deepEqual([...sdkOptions.settingSources], ["user", "project", "local"]);
  } finally { instance.stop(); }
});

test("stopping a tab leader settles its pending input, aborts the SDK, and ignores late output", async () => {
  let input: any, sdkOptions: any, resolveOutput: ((value: any) => void) | undefined, returns = 0;
  const events: string[] = [];
  const handle = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise((resolve) => { resolveOutput = resolve; }),
    return: async () => { returns++; resolveOutput?.({ done: true }); return { done: true }; },
  };
  const createLeader = loadLeaderHarness((args) => { input = args.prompt; sdkOptions = args.options; return handle; });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work/alpha/design", null, {
    onDelta: (text: string) => events.push(text), onDone: () => events.push("done"), onUsage: () => {}, onError: (error: string) => events.push(error),
  });
  await tick(0);
  const waiting = input.next();
  instance.stop();
  const settled = await Promise.race([waiting, tick(100).then(() => "timeout")]);
  assert.notEqual(settled, "timeout");
  assert.equal(settled.done, true);
  assert.equal(sdkOptions.abortController.signal.aborted, true);
  resolveOutput?.({ done: false, value: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "late" } } } });
  await tick(0);
  assert.equal(returns, 1);
  assert.deepEqual(events, []);
});

test("live leader model changes use the SDK handle and scope later usage to the new model", async () => {
  let resolveOutput: ((value: any) => void) | undefined;
  const modelCalls: string[] = [];
  const usageEvents: any[] = [];
  const handle = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise((resolve) => { resolveOutput = resolve; }),
    return: async () => { resolveOutput?.({ done: true }); return { done: true }; },
    setModel: async (model: string) => { modelCalls.push(model); },
  };
  let queryCount = 0;
  const createLeader = loadLeaderHarness(() => { queryCount++; return handle; });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work/alpha/design", null, {
    onDelta() {}, onDone() {}, onUsage: (delta: any) => usageEvents.push(delta), onError() {},
  });
  await tick(0);
  assert.equal(await instance.setModel("claude-opus-5"), true);
  resolveOutput?.({ done: false, value: { type: "result", total_cost_usd: 0.01, usage: { input_tokens: 9 }, modelUsage: { "claude-opus-5": { contextWindow: 200_000 } } } });
  await tick(0);
  assert.deepEqual(modelCalls, ["claude-opus-5"]);
  assert.equal(queryCount, 1, "changing the model must not restart the leader");
  assert.equal(usageEvents[0].modelId, "claude-opus-5");
  instance.stop();
});

test("runner call site derives write access from process slot definitions and allows concurrent same-seat runs", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer1", prompt: "review" });
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "code" });
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "second coder run" });
  assert.equal(server.launched.length, 3);
  assert.equal(server.launched[0].run.seatKey, "alpha-dev.reviewer1");
  assert.equal(server.launched[0].run.canWrite, false);
  assert.equal(server.launched[0].run.cli, "claude");
  assert.equal(server.launched[1].run.canWrite, true);
  assert.equal(server.launched[2].run.canWrite, true);
  assert.notEqual(server.launched[1].run.runId, server.launched[2].run.runId);
  assert.equal(lastState(ws).projects[0].tabs[0].runs.filter((run: any) => run.status === "working" && run.seatSlotId === "coder").length, 2);
});

test("killRun stops only its run id and emits a real run stop event", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "one" });
  ws.message({ type: "run", tabId: "alpha-dev", slot: "coder", prompt: "two" });
  const [first, second] = server.launched.map((entry: any) => entry.run.runId);
  ws.message({ type: "killRun", runId: first });
  assert.deepEqual(server.kills, [first]);
  assert.equal(server.active.has(first), false);
  assert.equal(server.active.has(second), true);
  assert.ok(ws.messages.some((message: any) => message.type === "runStop" && message.runId === first));
  assert.ok(ws.messages.some((message: any) => message.type === "killAccepted" && message.runId === first), "the kill is acknowledged with its run id");
  assert.equal(ws.messages.some((message: any) => message.type === "killAccepted" && message.runId === second), false, "and only that run id");
});

test("old and new log ids remain valid history queries without requiring a current roster entry", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "historyList", seatKey: "removed-old-seat" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "historyList"), "the history answer", 30_000);
  const answer = ws.messages.find((message: any) => message.type === "historyList");
  assert.deepEqual(answer.runs, []);
  ws.message({ type: "historyList", seatKey: "../escape" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error"), "the invalid seat key error", 30_000);
  assert.match(ws.messages.findLast((message: any) => message.type === "error").message, /invalid seat key/);
});

test("tab ids are globally unique and removal enforces last-tab and busy guards", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "hello" });
  ws.message({ type: "removeTab", tabId: "beta-dev" });
  assert.match(ws.messages.at(-1).message, /last tab/);
  ws.message({ type: "addTab", projectId: "beta", tabId: "beta-review", kind: "dev", template: "duo", name: "Review" });
  ws.message({ type: "addTab", projectId: "alpha", tabId: "beta-review", kind: "dev" });
  assert.match(ws.messages.at(-1).message, /invalid or duplicate tab id/);
  ws.message({ type: "run", tabId: "beta-review", slot: "coder", prompt: "work" });
  ws.message({ type: "removeTab", tabId: "beta-review" });
  assert.match(ws.messages.at(-1).message, /busy/);
});

test("removeTab stops no busy worker and succeeds only after it has closed", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "addTab", projectId: "beta", tabId: "beta-review", kind: "dev", template: "duo", name: "Review" });
  ws.message({ type: "run", tabId: "beta-dev", slot: "coder", prompt: "work" });
  ws.message({ type: "removeTab", tabId: "beta-dev" });
  assert.match(ws.messages.at(-1).message, /busy/);
  const runId = server.launched[0].run.runId;
  ws.message({ type: "killRun", runId });
  ws.message({ type: "removeTab", tabId: "beta-dev" });
  assert.equal(lastState(ws).projects.find((project: any) => project.id === "beta").tabs.length, 1);
});

test("removing the selected tab sends the visible fallback tab's transcript", async () => {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  const chats = path.join(server.testRoot, "chats");
  mkdirSync(chats, { recursive: true });
  writeFileSync(path.join(chats, "alpha-dev.jsonl"), `${JSON.stringify({ type: "message", tabId: "alpha-dev", revision: 1, role: "assistant", text: "Development fallback transcript", at: 1 })}\n`);

  ws.message({ type: "hello" });
  ws.message({ type: "selectTab", tabId: "alpha-design" });
  assert.equal(lastState(ws).selectedTabId, "alpha-design");
  ws.message({ type: "removeTab", tabId: "alpha-design" });

  const visible = lastState(ws).selectedTabId;
  const fallbackHistory = ws.messages.findLast((message: any) => message.type === "chatHistory");
  assert.equal(visible, "alpha-dev");
  assert.equal(fallbackHistory?.tabId, visible);
  assert.equal(fallbackHistory?.messages?.[0]?.text, "Development fallback transcript");
});

test("busy leader turns block folder changes and project removal", async () => {
  const server = await loadServer({ skipHealth: true, hangLeader: true }), ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "active leader" });
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: "C:/work/new" });
  assert.match(ws.messages.at(-1).message, /tab is busy/);
  ws.message({ type: "removeProject", projectId: "alpha" });
  assert.match(ws.messages.at(-1).message, /busy project/);
  assert.equal(lastState(ws).projects.some((project: any) => project.id === "alpha"), true);
});

test("changeProjectFolder persists only the project default and supplies it to new tabs", async () => {
  const workspaces = fixtureWorkspaces();
  const originalFolders = workspaces.projects.find((project: any) => project.id === "alpha").tabs.map((tab: any) => tab.folder);
  const server = await loadServer({ skipHealth: true, workspaces }), ws = connect(server);
  ws.message({ type: "changeProjectFolder", projectId: "alpha", folder: "C:/work/alpha-default" });
  const updated = lastState(ws).projects.find((project: any) => project.id === "alpha");
  assert.equal(updated.folder, "C:/work/alpha-default");
  assert.deepEqual(updated.tabs.map((tab: any) => tab.folder), originalFolders);
  assert.equal(server.getWorkspaces().projects.find((project: any) => project.id === "alpha").folder, "C:/work/alpha-default", "the workspace write persisted the default");
  ws.message({ type: "addTab", projectId: "alpha", tabId: "alpha-default-folder", kind: "dev" });
  assert.equal(lastState(ws).projects.find((project: any) => project.id === "alpha").tabs.find((tab: any) => tab.id === "alpha-default-folder").folder, "C:/work/alpha-default");
  ws.message({ type: "changeProjectFolder", projectId: "alpha", folder: " " });
  assert.match(ws.messages.at(-1).message, /folder is required/);
  ws.message({ type: "changeProjectFolder", projectId: "unknown", folder: "C:/work/other" });
  assert.match(ws.messages.at(-1).message, /unknown project/);
});

test("Settings default folder is saved with an id and supplies new projects", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "setDefaultProjectFolder", requestId: "global_folder_save", folder: server.testRoot });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "global_folder_save"), "default folder result");
  assert.equal(server.stateMessage().settings.folders.defaultProjectFolder, server.testRoot);
  ws.message({ type: "addProject", id: "globaldefault", name: "Uses Settings folder" });
  const project = server.stateMessage().projects.find((item: any) => item.id === "globaldefault");
  assert.equal(project.folder, server.testRoot);
  assert.equal(project.tabs[0].folder, server.testRoot);
});

test("Settings writes reject an unsafe request id before any action starts", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "installCli", requestId: "../unsafe", cli: "claude", confirm: true });
  const error = ws.messages.at(-1);
  assert.equal(error.type, "error");
  assert.match(error.message, /invalid request id/);
  assert.equal(error.requestId, undefined, "an unsafe id is never echoed");
  assert.equal(server.settingsService.state.tools.claude.action, undefined);
  assert.equal(Object.keys(server.stateMessage().requestActions).length, 0, "no action state exists for an unsafe id");
});

test("every Settings, permission, and request write rejects an unsafe request id before dispatch", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const messages = [
    { type: "installCli", cli: "claude", confirm: true },
    { type: "cliLogin", cli: "claude" },
    { type: "ghLogin" },
    { type: "setNotesVault", path: server.testRoot },
    { type: "setDefaultProjectFolder", folder: server.testRoot },
    { type: "mcpAdd", cli: "claude", name: "safe", commandOrUrl: "npx server" },
    { type: "mcpRemove", cli: "claude", name: "safe", confirm: true },
    { type: "pluginInstall", name: "helper@official" },
    { type: "pluginUninstall", name: "helper@official", confirm: true },
    { type: "setPermissionMode", tabId: "alpha-dev", mode: "plan" },
    { type: "sendRequest", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Review", body: "Please review." },
    { type: "resolveRequest", id: "00000000-0000-4000-8000-000000000001", status: "accepted" },
  ];
  for (const message of messages) {
    ws.message({ ...message, requestId: "../unsafe" });
    const error = ws.messages.at(-1);
    assert.equal(error.type, "error", `${message.type} was refused`);
    assert.match(error.message, /invalid request id/);
    assert.equal(error.requestId, undefined, `${message.type} did not echo an unsafe id`);
  }
  assert.equal(Object.keys(server.stateMessage().requestActions).length, 0);
  assert.equal(server.requestsStore.list().length, 0);
  assert.equal(server.settingsService.state.vault.path, null);
  assert.equal(server.settingsService.permissionMode("alpha-dev"), "accept");
});

test("CLI, GitHub, MCP, and plugin action refusals echo their safe request ids and finish failed", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  const messages = [
    { type: "installCli", cli: "claude", confirm: true },
    { type: "cliLogin", cli: "claude" },
    { type: "ghLogin" },
    { type: "mcpAdd", cli: "claude", name: "safe", commandOrUrl: "npx server" },
    { type: "mcpRemove", cli: "claude", name: "safe", confirm: true },
    { type: "pluginInstall", name: "helper@official" },
    { type: "pluginUninstall", name: "helper@official", confirm: true },
  ];
  for (const [index, message] of messages.entries()) {
    const requestId = `settings_failure_${index}`;
    ws.message({ ...message, requestId });
    await waitFor(() => ws.messages.some((item: any) => item.type === "error" && item.requestId === requestId), `${message.type} refusal`);
    assert.equal(server.stateMessage().requestActions[requestId].status, "failed", `${message.type} state is server-owned`);
  }
});

test("a disconnected socket cannot turn a completed Settings write into a failed action", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.send = () => { throw new Error("socket closed during send"); };
  ws.message({ type: "setDefaultProjectFolder", requestId: "folder_disconnect", folder: server.testRoot });
  await waitFor(() => server.stateMessage().requestActions.folder_disconnect?.status === "done", "completed folder write");
  assert.equal(server.stateMessage().settings.folders.defaultProjectFolder, server.testRoot);
});
