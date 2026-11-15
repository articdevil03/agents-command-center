import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { scratchDir, importWithTempDataRoot } from "./temp-root.ts";
import { lowerOwnPriority } from "../scripts/sweep/run.mjs";

lowerOwnPriority();
// Observe calls to the real writer without substituting its implementation. Also inject a disk failure at its boundary.
const signature = "export function writeWorkspaces(workspaces: Workspaces, path?: string): void {";
const hooks = registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith("/server/config.ts")) {
    const source = String(result.source);
    assert.equal(source.split(signature).length, 2, "writer instrumentation target must exist once");
    return { ...result, source: source.replace(signature, signature + "\n(globalThis as any).__p29BeforeWrite?.();") };
  }
  if (url.endsWith("/server/first-run/state.ts")) {
    const source = String(result.source), target = "export function finishFirstRun(): void {";
    assert.equal(source.split(target).length, 2, "finish instrumentation target must exist once");
    return { ...result, source: source.replace(target, target + "\n(globalThis as any).__p29BeforeFinish?.();") };
  }
  return result;
} });
export const { dataDir, modules: api } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"), state: await import("../server/main/state.ts"),
  messages: await import("../server/main/messages/index.ts"), broadcast: await import("../server/main/broadcast.ts"),
  first: await import("../server/first-run/state.ts"), recovery: await import("../server/fixed-crew/recovery.ts"),
  SettingsService: (await import("../server/settings.ts")).SettingsService,
  ChatStore: (await import("../server/chat-store.ts")).ChatStore, RequestsStore: (await import("../server/requests.ts")).RequestsStore,
}));
hooks.deregister();
export const markerBytes = JSON.stringify({ version: 1, status: "pending", createdAt: "2026-01-01T00:00:00.000Z" });
export function put(root: string, path: string, bytes: string) {
  mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), bytes);
}
export function startup(root: string) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const config = await import('./server/config.ts');
    const first = await import('./server/first-run/state.ts');
    const recovery = await import('./server/fixed-crew/recovery.ts');
    console.log(JSON.stringify({ required: first.firstRunRequired(config.readWorkspaces()), marker: first.firstRunMarker(), recovery: recovery.workspaceRecovery(), workspace: config.readWorkspaces() }));
  `], { encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, CC_DATA_DIR: root, CC_TEST_FORCE_PACKAGED: "1" } });
  assert.equal(result.status, 0, `startup failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}
export function setup() {
  const { config, state, SettingsService, ChatStore, RequestsStore, first } = api;
  state.tabs.clear(); state.clients.clear(); state.activeLeaderTurns.clear(); state.savingTabs.clear(); state.runContexts.clear();
  (globalThis as any).__p29BeforeFinish = undefined;
  state.setDataRoot(dataDir); state.setBlockedSeatKeys(new Set());
  state.setWorkspaces(config.defaultWorkspaces()); state.setSelectedTabId("example-development");
  state.setLaunchSafety({ blocked: [], uncertain: [], released: [], notices: [] });
  const histories = scratchDir();
  state.setChatStore(new ChatStore(join(histories, "chats"))); state.setRequestsStore(new RequestsStore(histories));
  state.setClientPrefs(config.readClientPrefs()); state.setAcpClis([]);
  state.setFolderActivity({ watchFolders() {} } as any);
  state.setCliRunner(async () => ({ code: 1, stdout: "", stderr: "not a git repo" }));
  state.setSettingsService(new SettingsService({ dataRoot: scratchDir(), runCli: state.cliRunner }));
  for (const cli of ["claude", "codex", "opencode"] as const) {
    Object.assign(state.settingsService.state.tools[cli], { installed: true, signedIn: cli === "codex" });
  }
  Object.assign(state.settingsService.state.catalogTools.opencode, { installed: true, version: "1.0.0", supportedVersion: true, signedIn: false });
  Object.assign(state.settingsService.state.tools.opencode, { version: "1.0.0", supportedVersion: true });
  writeFileSync(config.workspacesPath, JSON.stringify(state.workspaces));
  writeFileSync(first.firstRunPath, markerBytes);
  api.recovery.initializeWorkspaceRecovery(config.defaultWorkspaces);
  const replies: any[] = [];
  const socket = { readyState: 1, bufferedAmount: 0, send(raw: string) { replies.push(JSON.parse(raw)); } } as any;
  state.clients.add(socket);
  let calls = 0, failWrite = false;
  (globalThis as any).__p29BeforeWrite = () => {
    calls++;
    assert.equal(first.firstRunMarker()?.status, "pending", "workspace must publish before completing marker");
    if (failWrite) throw new Error("forced workspace write failure");
  };
  const work = scratchDir();
  let sequence = 0;
  const dispatch = async (fields: any = {}) => {
    const requestId = `p29_${++sequence}`, start = replies.length;
    api.messages.handleMessage(socket, JSON.stringify({ type: "completeFirstRun", requestId, name: "My Project", folder: work, cli: "codex", ...fields }));
    await new Promise((done) => setImmediate(done));
    return replies.slice(start).find((reply) => ["error", "actionResult"].includes(reply.type) && reply.requestId === requestId);
  };
  const bytes = () => [readFileSync(config.workspacesPath, "utf8"), readFileSync(first.firstRunPath, "utf8")];
  return { work, replies, dispatch, bytes, calls: () => calls, failWrite: () => { failWrite = true; },
    failFinish: () => { (globalThis as any).__p29BeforeFinish = () => { throw new Error("forced finish failure"); }; } };
}
