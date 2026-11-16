import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

function load(file: string, expression: string, context: Record<string, any>) {
  const source = stripTypeScriptTypes(readFileSync(file, "utf8"))
    .replace(/^import\s+(?:.|\r?\n)*?from\s+"[^"]+";\r?\n/gm, "")
    .replaceAll("export async function", "async function")
    .replaceAll("export function", "function");
  return runInNewContext(`${source};${expression}`, context);
}
function context() {
  const state: Record<string, any> = {
    tabLocation: () => ({ tab: { folder: "fake" } }),
    broadcast() {}, stateMessage: () => ({}), stopLeaderSession() {},
    chatStore: { setAsideIfUnreadable() {}, snapshot: () => ({}), clear: () => ({}), restore: () => ({}), forget() {} },
    CLEAR_UNDO_MS: 1000, setTimeout: () => 1, clearTimeout() {},
  };
  for (const name of ["vaultSaveRetries", "pendingClearUndos", "chatClearGenerations", "changesByTab", "notesByTab", "changeGeneration", "tabs"]) state[name] = new Map();
  for (const name of ["vaultCopyAttention", "reportedChatProblems", "expiredClearUndos", "pendingHandoverReads", "handoverReadTurns", "activeLeaderTurns", "savingTabs", "blockedSeatKeys"]) state[name] = new Set();
  return state;
}
test("Clear and Undo prune a tab's retry and vault warning without affecting another tab", () => {
  const state = context();
  const handlers = new Map(load("server/main/messages/chat.ts", "chatMessages()", state));
  const seed = () => { state.vaultSaveRetries.set("one", { revision: 1, path: "note" }); state.vaultSaveRetries.set("two", { revision: 1, path: "other" }); state.vaultCopyAttention.add("one"); state.vaultCopyAttention.add("two"); };
  seed();
  handlers.get("clear")({ send() {} }, { tabId: "one" });
  assert.equal(state.vaultSaveRetries.has("one"), false);
  assert.equal(state.vaultSaveRetries.has("two"), true);
  assert.equal(state.vaultCopyAttention.has("one"), false, "a cleared or restored chat shows no stale vault warning");
  assert.equal(state.vaultCopyAttention.has("two"), true);
  seed();
  handlers.get("undoClear")({ send() {} }, { tabId: "one" });
  assert.equal(state.vaultSaveRetries.has("one"), false);
  assert.equal(state.vaultSaveRetries.has("two"), true);
  assert.equal(state.vaultCopyAttention.has("one"), false, "a cleared or restored chat shows no stale vault warning");
  assert.equal(state.vaultCopyAttention.has("two"), true);
});
test("tab removal prunes retry and warning after the workspace write succeeds", () => {
  const state = context();
  state.workspaces = { projects: [{ tabs: [{ id: "one" }, { id: "two" }] }] };
  state.launchSafety = { notices: [] };
  state.selectedTabId = "two";
  Object.assign(state, { writeWorkspaces() {}, settingsService: { removePermissionModes() {}, refreshProjectInstructions() {} }, requestsStore: { markDestinationRemoved() {} }, setWorkspaces: (next: any) => { state.workspaces = next; }, runtimeFor() {}, watchTabFolders() {} });
  for (const id of ["one", "two"]) { state.vaultSaveRetries.set(id, { revision: 1, path: id }); state.vaultCopyAttention.add(id); }
  const sync = load("server/main/workspace.ts", "syncWorkspace", state);
  sync({ projects: [{ tabs: [{ id: "two" }] }] });
  assert.equal(state.vaultSaveRetries.has("one"), false);
  assert.equal(state.vaultCopyAttention.has("one"), false);
  assert.equal(state.vaultSaveRetries.has("two"), true);
});
