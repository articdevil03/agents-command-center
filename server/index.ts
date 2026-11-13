import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  readWorkspaces, adoptSavedValues, refreshDiscovery, readClientPrefs, readLaunchSafety, readAcpClis, acpClisPath, defaultWorkspaces,
} from "./config.ts";
import { keepBadCopy } from "./safe-file.ts";
import { isRunning, stopAllRunning } from "./runner.ts";
import { closeWorkerAdmission, drainWorkers } from "./runner/lifecycle.ts";
import { resolveClaudeCli } from "./leader.ts";
import { SWEEP_CAP_MS, reportStartupSweep, setCliSkipFolders, sweepOrphans, windowsTaskkillPath } from "./leader-common.ts";
import { isAllowedOrigin, isAllowedHost, setAllowedPort, setAppKey, hasValidAppKey, wsKeyFromUrl } from "./security.ts";
import { STALL_CHECK_INTERVAL_MS, STALL_THRESHOLD_MS } from "./stall.ts";
import { resolveDataRoot } from "./data-root.ts";
import { ChatStore } from "./chat-store.ts";
import { RequestsStore } from "./requests.ts";
import { createFolderActivity } from "./folder-activity.ts";
import { SettingsService, runCli } from "./settings.ts";
import { createTestCliRunner } from "./test-cli-runner.ts";
import { broadcast, resyncClient, stateMessage } from "./main/broadcast.ts";
import { handleHttpRequest } from "./main/http.ts";
import { persistLaunchSafety } from "./main/launch-safety.ts";
import { leadersAndWaitingTurns, stopLeaderSession } from "./main/leader-session.ts";
import { handleMessage } from "./main/messages/index.ts";
import {
  HOST, PORT, blockedSeatKeys, claudeCliPath, cliRunner, clients, dataRoot, describeError, folderActivity, laggingClients, launchSafety,
  pendingApprovals, pendingHandoverReads, requestsStore, runContexts, scratchDir, selectedTabId, setAcpClis, setAcpSpawn,
  setAvatarDir, setBlockedSeatKeys, setBoundPort, setChatStore, setClaudeCliPath, setCliRunner, setClientPrefs, setDataRoot, setFolderActivity,
  setLaunchSafety, setLeaderQuery, setLeaderSpawn, setPublicDir, setRequestsStore, setScratchDir, setSelectedTabId, setSettingsService,
  setUnconfirmedRunIds, setWorkspaces, settingsService, stallTrackers, tabs, workspaces,
} from "./main/state.ts";
import { runtimeFor, tabLocation, watchTabFolders } from "./main/tabs.ts";
import { cleanScratch } from "./main/uploads.ts";
import { refreshTabDetails } from "./main/workspace.ts";
import { fixedCrewService } from "./main/fixed-crew.ts";
import { initializeFixedTasks } from "./main/fixed-tasks.ts";
import { blockWorkspaceRecovery, unavailableWorkspace, workspaceRecovery } from "./fixed-crew/recovery.ts";
import { fixedGitOperations } from "./main/fixed-task-actions.ts";

// Until the server is listening, an uncaught error means it never came up (a taken port, a broken start): ending beats staying as a process that serves nothing.
let serverListening = false;
process.on("uncaughtException", (err) => {
  try { const message = describeError(err); console.error(`uncaught exception: ${message}`); if (!serverListening) process.exit(1); broadcast({ type: "error", message: `internal error: ${message}` }); }
  catch (handlerErr) { console.error("uncaughtException handler itself failed:", handlerErr); }
});
process.on("unhandledRejection", (reason) => {
  try { const message = describeError(reason); console.error(`unhandled rejection: ${message}`); broadcast({ type: "error", message: `internal error: ${message}` }); }
  catch (handlerErr) { console.error("unhandledRejection handler itself failed:", handlerErr); }
});

const root = dirname(dirname(fileURLToPath(import.meta.url)));
setPublicDir(join(root, "public"));
setDataRoot(resolveDataRoot(process.env, root));
setScratchDir(join(dataRoot, "scratch"));
setAvatarDir(join(dataRoot, "avatars"));
setChatStore(new ChatStore(join(dataRoot, "chats")));
setFolderActivity(createFolderActivity({ env: process.env, dataRoot }));
await mkdir(scratchDir, { recursive: true });
// The app key is read once and removed from the environment, so no child process can inherit it.
const suppliedAppKey = process.env.CC_APP_KEY;
delete process.env.CC_APP_KEY;
if (suppliedAppKey !== undefined && !/^[0-9a-f]{64}$/.test(suppliedAppKey)) { console.error("CC_APP_KEY must be 64 lowercase hex characters; refusing to start."); process.exit(1); }
const appKey = suppliedAppKey || randomBytes(32).toString("hex");
setAppKey(appKey);
// Only the fake-CLI test runner may shorten the stall clock, to prove what keeps a waiting seat from being called stalled.
const stallThresholdMs = process.env.CC_TEST_FAKE_CLI === "1" && process.env.CC_TEST_STALL_THRESHOLD_MS ? Number(process.env.CC_TEST_STALL_THRESHOLD_MS) : STALL_THRESHOLD_MS;
const stallCheckMs = process.env.CC_TEST_FAKE_CLI === "1" && process.env.CC_TEST_STALL_CHECK_MS ? Number(process.env.CC_TEST_STALL_CHECK_MS) : STALL_CHECK_INTERVAL_MS;
await cleanScratch();

setClaudeCliPath(resolveClaudeCli());
if (!claudeCliPath) console.log("Claude CLI not found; the leader will run without --effort");
setWorkspaces(readWorkspaces());
try { setAcpClis(readAcpClis()); }
catch (err) { console.error(describeError(err)); try { keepBadCopy(acpClisPath); } catch { /* nothing to keep */ } }
// An unreadable brake is never reset on disk. Serve a blocked workspace so the
// owner can see why startup is unavailable without allowing another writer.
try { setLaunchSafety(readLaunchSafety()); }
catch { blockWorkspaceRecovery(); setWorkspaces(unavailableWorkspace(defaultWorkspaces)); setLaunchSafety({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] }); }
initializeFixedTasks();
setCliSkipFolders(() => workspaces.projects.flatMap((project) => [project.folder, ...project.tabs.map((tab) => tab.folder)]));
// Saved models and efforts are valid from the first request; discovery finishes later and may not list them.
adoptSavedValues(workspaces);
// A previous server that crashed may have left agent processes running (its registry file in logs/ names them): end them now, before the server listens (so nothing can launch first). A failed sweep never stops the start.
// When the cap wins, the server starts and the work finishes in the background; its result is said when it ends.
try { const swept = await sweepOrphans();
  reportStartupSweep(swept, SWEEP_CAP_MS, console.log, describeError);
}
catch (err) { console.log(`Orphan sweep failed: ${describeError(err)}`); }
setSelectedTabId(workspaces.projects[0]?.tabs[0]?.id ?? "");
// Far-boundary query injection is available only with the existing fake CLI test runner.
setLeaderQuery(process.env.CC_TEST_FAKE_CLI === "1" && process.env.CC_TEST_FAKE_LEADER === "1"
  ? (await import("../test/approval-query.ts")).query : undefined);
// Same rule for the Codex and OpenCode leader children: tests swap the spawn for fake CLIs, never the real ones.
setLeaderSpawn(process.env.CC_TEST_FAKE_CLI === "1" && process.env.CC_TEST_FAKE_LEADER_CLI === "1"
  ? (await import("../test/fake-leader-cli.ts")).spawnFakeLeaderCli : undefined);
setAcpSpawn(process.env.CC_TEST_FAKE_CLI === "1" && process.env.CC_TEST_FAKE_LEADER_CLI === "1"
  ? (await import("../test/fake-leader-cli.ts")).spawnFakeAcp : undefined);
setClientPrefs(readClientPrefs());
const testCliRunner = createTestCliRunner();
setCliRunner(testCliRunner ?? runCli);
setSettingsService(new SettingsService({ dataRoot, runCli: cliRunner }));
setRequestsStore(new RequestsStore(dataRoot));
for (const project of workspaces.projects) for (const tab of project.tabs) runtimeFor(tab);
watchTabFolders();
// A restart leaves every tab with no leader memory: its first leader turn reads its handover (RESUME.md) first.
for (const project of workspaces.projects) for (const tab of project.tabs) pendingHandoverReads.add(tab.id);

setBlockedSeatKeys(new Set(launchSafety.blocked));
setUnconfirmedRunIds(new Set(launchSafety.uncertain.map((row) => row.runId ?? row.seatId)));
// A run the previous server never saw end (a crash or a hard kill) has a process nobody tracks any more, maybe still editing files:
// its seat stays blocked until the user allows launching again, so a second writer cannot start on the same folder.
if (launchSafety.live.length && !workspaceRecovery().blocked) {
  for (const row of launchSafety.live) blockedSeatKeys.add(row.seatId);
  launchSafety.live = [];
  try { persistLaunchSafety(); } catch (err) { console.error(`could not save the blocks for runs the last session never saw end: ${describeError(err)}`); }
}
// A clean exit has already asked every worker to stop: nothing is left untracked, so the next start has nothing to block.
process.on("exit", (code) => {
  if (code !== 0 || !launchSafety.live.length) return;
  launchSafety.live = [];
  try { persistLaunchSafety(); } catch { /* the next start then blocks those seats: safe, if noisy */ }
});
settingsService.setOnChange(() => {
  try { fixedCrewService.refresh(); }
  catch (err) { broadcast({ type: "error", message: `Crew discovery could not be saved: ${describeError(err)}` }); }
  broadcast(stateMessage());
});
if (!workspaceRecovery().blocked && !workspaceRecovery().recovered) for (const request of requestsStore.list()) if (request.status === "pending" && !tabLocation(request.toTabId)) requestsStore.markDestinationRemoved(request.toTabId);

const server = createServer(handleHttpRequest);
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 2 * 1024 * 1024,
  verifyClient: (info, done) => {
    const host = info.req.headers.host;
    const origin = info.origin;
    if (!isAllowedHost(host) || !isAllowedOrigin(origin) || !hasValidAppKey(wsKeyFromUrl(info.req.url))) { done(false, 403, "forbidden"); return; }
    done(true);
  },
});
server.on("upgrade", (req, socket, head) => {
  if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin) || !hasValidAppKey(wsKeyFromUrl(req.url))) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("message", (data) => handleMessage(ws, data.toString()));
  ws.on("close", () => { clients.delete(ws); laggingClients.delete(ws); });
  ws.on("error", () => { clients.delete(ws); laggingClients.delete(ws); });
});
server.on("error", (err) => {
  // A taken port or a refused bind: a process that never listens is only a hidden orphan.
  console.error(`server error: ${describeError(err)}`);
  if (!serverListening) process.exit(1);
});
server.listen(PORT, HOST, () => {
  serverListening = true;
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  setAllowedPort(port);
  setBoundPort(port);
  console.log(`Command Center running at http://${HOST}:${port}`);
  // Without Electron nobody handed the page its key: the one line below carries it (the page reads #key= and removes it).
  if (!suppliedAppKey) console.log(`Open http://${HOST}:${port}/#key=${appKey}`);
  if (process.env.CC_SKIP_DISCOVERY !== "1") {
    void refreshDiscovery(undefined, undefined, undefined, claudeCliPath).then(() => { fixedCrewService.refresh(); broadcast(stateMessage()); }).catch((err) => broadcast({ type: "error", message: describeError(err) }));
    const selected = tabLocation(selectedTabId);
    void settingsService.refreshAll(selected?.tab.folder ?? null);
    if (selected) void refreshTabDetails(selected.tab.id);
  }
});

let stallTimer: ReturnType<typeof setInterval> | undefined;
stallTimer = setInterval(() => {
      const workingRunIds = [...runContexts.keys()].filter((runId) => isRunning(runId) && ![...pendingApprovals.values()].some((item) => item.origin.kind === "seat" && item.origin.runId === runId) && ![...tabs.values()].some((runtime) => runtime.stalledRuns.has(runId)));
  for (const runId of stallTrackers.checkStalls(Date.now(), workingRunIds, stallThresholdMs)) {
    const context = runContexts.get(runId);
    if (!context) continue;
    tabs.get(context.tabId)?.stalledRuns.add(runId);
    // Flat output is only shown and escalated to the owner; the run is never stopped or restarted from here.
    broadcast({ type: "runStalled", tabId: context.tabId, runId, seatKey: context.run.seatKey, action: "escalate" });
  }
}, stallCheckMs);
stallTimer.unref?.();
const backpressureTimer = setInterval(() => {
  for (const ws of laggingClients) resyncClient(ws);
}, 250);
backpressureTimer.unref?.();

let shutdownWork: Promise<void> | undefined;
function shutdown(signal: string): Promise<void> {
  if (shutdownWork) return shutdownWork;
  // Admission and cancellation latch synchronously, before ANY shutdown await: a worker approved after this point is never started.
  closeWorkerAdmission();
  fixedGitOperations.close();
  shutdownWork = drainShutdown(signal);
  return shutdownWork;
}
async function drainShutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; stopping agents`);
  if (stallTimer) clearInterval(stallTimer);
  if (backpressureTimer) clearInterval(backpressureTimer);
  folderActivity.endAllOwn();
  folderActivity.closeWatchers();
  for (const tabId of leadersAndWaitingTurns()) stopLeaderSession(tabId);
  stopAllRunning();
  const gitDrain = fixedGitOperations.drain();
  // Both drains start now and run in parallel, so their budgets are never added up.
  const workerDrain = drainWorkers();
  if (!process.connected) {
    const [gitConfirmed, workersConfirmed] = await Promise.all([gitDrain, workerDrain]);
    if (!gitConfirmed) console.error("Git shutdown INCOMPLETE: cleanup or finalization remains unknown.");
    if (!workersConfirmed) console.error("Worker shutdown INCOMPLETE: a worker's end was not confirmed and published.");
    if (!gitConfirmed || !workersConfirmed) { process.exit(1); return; }
    if (signal === "disconnect") spawnSync(windowsTaskkillPath(), ["/pid", String(process.pid), "/T", "/F"], { windowsHide: true });
    process.exit(0);
    return;
  }
  for (const client of clients) client.terminate();
  wss.close();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const serverClosed = new Promise<boolean>((resolve) => {
    server.close(() => resolve(true));
    closeTimer = setTimeout(() => resolve(false), 7000);
  });
  server.closeAllConnections?.();
  const [gitConfirmed, workersConfirmed, closed] = await Promise.all([gitDrain, workerDrain, serverClosed]);
  clearTimeout(closeTimer);
  if (!gitConfirmed) console.error("Git shutdown INCOMPLETE: cleanup or finalization remains unknown.");
  if (!workersConfirmed) console.error("Worker shutdown INCOMPLETE: a worker's end was not confirmed and published.");
  const clean = gitConfirmed && workersConfirmed && closed;
  process.exit(clean ? 0 : 1);
}
function requestShutdown(signal: string): void {
  void shutdown(signal).catch(async (error) => {
    // A synchronous Stop/close failure must still wait for owned Git and worker work already started; this is never a second cancellation pass and never a success.
    console.error(`Shutdown INCOMPLETE: ${describeError(error)}`);
    try { await Promise.all([fixedGitOperations.drain(), drainWorkers()]); } finally { process.exit(1); }
  });
}
process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("disconnect", () => requestShutdown("disconnect"));
process.on("message", (message) => {
  if (message === "shutdown") requestShutdown("IPC shutdown");
});
// The parent can disconnect before the IPC listener is registered.
if (process.send && !process.connected) requestShutdown("disconnect");
