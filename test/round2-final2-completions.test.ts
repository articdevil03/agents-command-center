import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { actionClient } from "./action-client.ts";
import { loadServer, connect, waitFor } from "./round2-helpers.ts";
import { loadLeaderHarness } from "./round2-leader-harness.ts";
import { launchGateServer } from "./round2-gate-helpers.ts";

async function permissionCompletions(server: any, ws: any, count: number, client: any) {
  for (let index = 0; index < count; index++) {
    const requestId = `final2_permission_${index}`;
    ws.message({ type: "setPermissionMode", requestId, tabId: "beta-dev", mode: "accept" });
    await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === requestId), "permission completed");
    client.onMessage(ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === requestId));
    client.onMessage(server.stateMessage());
  }
}

test("final2 in-flight MCP Add survives overwrite and 33 real permission completions", async () => {
  let release!: () => void, entered = false;
  const server = await loadServer({ skipHealth: true, runCli: async (_bin: string, args: string[]) => {
    if (args[0] === "mcp" && args[1] === "add") { entered = true; await new Promise<void>((resolve) => { release = resolve; }); }
    return { code: 0, stdout: "", stderr: "" };
  } });
  const ws = connect(server), client = actionClient();
  client.setState(server.stateMessage());
  client.pendingSettingsActions.set("mcp-add-claude", "held_mcp");
  ws.message({ type: "mcpAdd", requestId: "held_mcp", cli: "claude", name: "held", commandOrUrl: "npx held" });
  await waitFor(() => entered, "fake MCP Add entered");
  try {
    ws.message({ type: "mcpRemove", requestId: "other_mcp", cli: "claude", name: "other", confirm: true });
    await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "other_mcp"), "other MCP completed");
    await permissionCompletions(server, ws, 33, client);
    assert.equal(server.stateMessage().requestActions.held_mcp?.status, "running", "recent actions evicted a running MCP Add");
    assert.equal(Object.values(server.stateMessage().requestActions).filter((a: any) => a.status !== "running").length, 32);
    assert.equal(client.settingsActionRunning("mcp-add-claude"), true, "MCP add is still in flight, but its Add button is enabled and status is unknown");
    assert.match(client.actionStatusMarkup("mcp-add-claude"), /Working/);
  } finally { release(); }
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "held_mcp"), "held Add completed");
  assert.equal(server.stateMessage().requestActions.held_mcp?.status, "done", "fresh completion must remain among the 32 finished results");
  client.onMessage(ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === "held_mcp"));
  client.onMessage(server.stateMessage());
  assert.equal(client.settingsActionRunning("mcp-add-claude"), false);
  assert.match(client.actionStatusMarkup("mcp-add-claude"), /Done/);
  assert.equal(client.pendingSettingsActions.has("mcp-add-claude"), false, "terminal result retires the pending MCP action");
});

test("final2 folder Save stays Done after 1001 real permission completions and stale running state", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server), client = actionClient();
  client.setState(server.stateMessage());
  client.pendingSettingsActions.set("folder-save", "completed_folder");
  ws.message({ type: "setDefaultProjectFolder", requestId: "completed_folder", folder: server.testRoot });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "completed_folder"), "folder completed");
  client.onMessage(ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === "completed_folder"));
  client.pendingSettingsActions.set("vault-save", "completed_vault");
  ws.message({ type: "setNotesVault", requestId: "completed_vault", path: null });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "completed_vault"), "vault completed");
  client.onMessage(ws.messages.find((message: any) => message.type === "actionResult" && message.requestId === "completed_vault"));
  await permissionCompletions(server, ws, 1001, client);
  assert.equal(client.settingsActionRunning("folder-save"), false, "Completed folder save is disabled as Working after 1001 real server action completions");
  assert.match(client.actionStatusMarkup("folder-save"), /Done/);
  assert.equal(client.pendingSettingsActions.has("folder-save"), false, "onMessage retires completed folder pending record");
  assert.equal(client.resultSize(), 2, "unrelated completions do not grow control results");
  const stale = server.stateMessage(); stale.requestActions.completed_folder = { requestId: "completed_folder", status: "running", message: "Working" };
  client.onMessage(stale);
  assert.equal(client.settingsActionRunning("folder-save"), false, "received completion overrides stale running state");
});

test("final2 request form cleared ids stay bounded across 1100 completions", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  client.setState(server.stateMessage());
  for (let index = 0; index < 1100; index++) {
    const requestId = `cleared_${index}`;
    client.pendingRequestActions.set("alpha-dev", requestId);
    client.node("reqTitle").value = "Title"; client.node("reqBody").value = "Body";
    client.onMessage({ type: "actionResult", action: "sendRequest", requestId });
    client.renderRequests();
    assert.equal(client.node("reqTitle").value, "", "successful send clears its title");
    assert.equal(client.node("reqBody").value, "", "successful send clears its body");
    client.node("reqTitle").value = "next draft"; client.renderRequests();
    assert.equal(client.node("reqTitle").value, "next draft", "same completion never clears a newer draft");
  }
  assert.equal(client.requestFormCleared.size, 1, "requestFormCleared retains every successful send forever");
  assert.equal(client.pendingRequestActions.size, 0, "completed requests retire pending records");
  const state = server.stateMessage(); state.projects = []; client.onMessage(state);
  assert.equal(client.requestFormCleared.size, 0, "removed tabs release cleared ids");
});

test("final2 never evicts more than 32 running actions and releases failed settings actions", async () => {
  const releases: Array<() => void> = [];
  const server = await loadServer({ skipHealth: true, runCli: async (_bin: string, args: string[]) => {
    if (args[0] === "mcp" && args[1] === "add") { await new Promise<void>((resolve) => releases.push(resolve)); return { code: 1, stdout: "", stderr: "failed" }; }
    return { code: 0, stdout: "", stderr: "" };
  } }), ws = connect(server);
  for (let index = 0; index < 40; index++) ws.message({ type: "mcpAdd", cli: "claude", requestId: `running_${index}`, name: "held", commandOrUrl: "npx held" });
  await waitFor(() => releases.length === 40, "40 fake MCP calls");
  try {
    assert.equal(Object.keys(server.stateMessage().requestActions).length, 40, "32 cap must not evict any running action");
  } finally { releases.forEach((release) => release()); }
  await waitFor(() => ws.messages.filter((m: any) => m.type === "error" && m.action === "mcpAdd").length === 40, "all failures finish");
  assert.equal(Object.keys(server.stateMessage().requestActions).length, 32, "finished action history remains bounded");
});

test("final2 a pending id seen listed and then dropped is finished, never stuck on Working", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  const listing = (ids: string[]) => { const state = server.stateMessage(); state.requestActions = Object.fromEntries(ids.map((id) => [id, { requestId: id, status: "running", message: "Working" }])); return state; };
  client.setState(server.stateMessage());
  client.pendingSettingsActions.set("mcp-add-claude", "restart_mcp");
  client.pendingRequestActions.set("alpha-dev", "restart_send");
  client.pendingPermissionAction.set("alpha-dev", "restart_perm");
  client.onMessage(listing(["restart_mcp", "restart_send", "restart_perm"]));
  assert.equal(client.settingsActionRunning("mcp-add-claude"), true, "a listed running id is Working");
  assert.equal(client.seenListedActions.size, 3, "listed pending ids are tracked");
  client.onMessage(listing([]));
  assert.equal(client.settingsActionRunning("mcp-add-claude"), false, "after a server restart the MCP Add button stays disabled as Working forever");
  assert.doesNotMatch(client.actionStatusMarkup("mcp-add-claude"), /Working/);
  assert.equal(client.pendingSettingsActions.size + client.pendingRequestActions.size + client.pendingPermissionAction.size, 0, "dropped ids are retired");
  assert.equal(client.seenListedActions.size, 0, "tracking is bounded by what is still pending");
  client.onMessage({ type: "actionResult", action: "mcpAdd", requestId: "restart_mcp" });
  assert.match(client.actionStatusMarkup("mcp-add-claude"), /Done/, "a late real result replaces the unknown one");
});

test("final2 pending unlisted ids stay running and terminal snapshots retire only the matching id", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  client.setState(server.stateMessage());
  client.pendingSettingsActions.set("folder-save", "new_folder");
  client.onMessage({ type: "actionResult", action: "setDefaultProjectFolder", requestId: "old_folder" });
  assert.equal(client.pendingSettingsActions.get("folder-save"), "new_folder", "old completion must not retire a newer pending id");
  assert.equal(client.settingsActionRunning("folder-save"), true, "a sent id not yet listed stays running");
  const state = server.stateMessage(); state.requestActions.new_folder = { requestId: "new_folder", status: "done", message: "Done" };
  client.onMessage(state); state.requestActions = {}; client.onMessage(state);
  assert.equal(client.pendingSettingsActions.has("folder-save"), false, "listed terminal result retires matching pending id");
  assert.equal(client.settingsActionRunning("folder-save"), false, "listed completed result does not become running when evicted");
  assert.match(client.actionStatusMarkup("folder-save"), /Done/);
});

test("final2 SDK live mode tracks successful switches and tool hook context", async () => {
  let sdk: any, fail = false;
  const leader = loadLeaderHarness(({ options }: any) => {
    sdk = options;
    return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, async return() { return { done: true }; }, async setPermissionMode() { if (fail) throw new Error("failed"); } };
  })({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {} }, undefined, "ask");
  assert.equal(leader.getPermissionMode(), "default", "initial live mode follows saved mode");
  assert.equal(await leader.setPermissionMode("plan"), true);
  assert.equal(leader.getPermissionMode(), "plan", "successful live switch updates launch mode");
  fail = true; assert.equal(await leader.setPermissionMode("accept"), false);
  assert.equal(leader.getPermissionMode(), "plan", "failed live switch preserves launch mode");
  await sdk.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", permission_mode: "default", tool_name: "Read", tool_input: {} }, "id", { signal: new AbortController().signal });
  assert.equal(leader.getPermissionMode(), "default", "hook context updates live launch mode");
  leader.stop(); assert.equal(leader.isDead(), true, "stopped leader cannot resume an approved launch");
});

test("final2 Requests pending status belongs only to the sending tab", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  const state = server.stateMessage(); client.setState(state);
  client.pendingRequestActions.set("alpha-dev", "only_alpha");
  client.renderRequests(); assert.equal(client.node("reqSend").disabled, true);
  state.selectedTabId = "beta-dev"; client.setState(state); client.renderRequests();
  assert.equal(client.node("reqSend").disabled, false, "other tab Send is enabled");
});

test("final2 dead or replaced leader cannot initiate launch in Accept", async () => {
  const { server, ws, deps } = await launchGateServer("accept");
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const result = await deps.launch("coder", "stale write").catch(() => assert.fail("stale launch threw instead of refusing"));
  assert.equal(server.launched.length, 0, "stale leader launches a writer in Accept");
  assert.match(result.error, /no longer current/);
});

test("final2 terminal control records are bounded by current controls", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  client.setState(server.stateMessage());
  for (let index = 0; index < 1100; index++) {
    const id = `repeat_${index}`;
    client.pendingSettingsActions.set("folder-save", id);
    client.onMessage({ type: "actionResult", action: "setDefaultProjectFolder", requestId: id });
  }
  assert.equal(client.resultSize(), 1, "one control retains only its latest terminal result");
  const keys = ["request-resolve-removed", "mcp-remove-claude-removed", "plugin-remove-removed"];
  for (const key of keys) {
    client.pendingSettingsActions.set(key, key);
    client.onMessage({ type: "actionResult", action: "mcpRemove", requestId: key });
  }
  client.pendingPermissionAction.set("removed-tab", "removed_permission");
  client.pendingRequestActions.set("removed-tab", "removed_request");
  client.onMessage({ type: "actionResult", action: "setPermissionMode", requestId: "removed_permission" });
  client.onMessage({ type: "actionResult", action: "sendRequest", requestId: "removed_request" });
  client.onMessage(server.stateMessage());
  assert.equal(client.resultSize(), 1, "removed request and inventory controls release terminal results");
  assert.equal(client.actionStateFor("removed_permission"), null, "removed tab releases its permission result");
  assert.equal(client.actionStateFor("removed_request"), null, "removed tab releases its request result");
});

test("final2 running snapshots never retire pending records", async () => {
  const server = await loadServer({ skipHealth: true }), client = actionClient();
  const state = server.stateMessage();
  client.setState(state); client.pendingSettingsActions.set("folder-save", "still_running");
  state.requestActions.still_running = { requestId: "still_running", status: "running", message: "Working" };
  client.onMessage(state);
  assert.equal(client.pendingSettingsActions.get("folder-save"), "still_running", "running result must not retire pending action");
  client.onMessage({ type: "error", action: "setDefaultProjectFolder", requestId: "still_running", message: "Failed to save" });
  assert.equal(client.pendingSettingsActions.has("folder-save"), false, "failed result retires pending action");
  assert.match(client.actionStatusMarkup("folder-save"), /Failed to save/);
  assert.equal(client.settingsActionRunning("folder-save"), false);
});
