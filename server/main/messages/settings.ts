import { WebSocket } from "ws";
import { writeAcpClis, validateAcpCli, parseAcpStartCommand, acpKindOf, ACP_MAX_CLIS } from "../../config.ts";
import { resolveCliOrThrow, type LeaderHandle } from "../../leader-common.ts";
import { readChatRequestId } from "../../chat-store.ts";
import { ModeBusyError } from "../../settings.ts";
import { broadcast, sendError, stateMessage } from "../broadcast.ts";
import { stopLeaderSession } from "../leader-session.ts";
import type { MessageHandler } from "./types.ts";
import {
  acpClis, activeLeaderTurns, describeError, leaders, pendingHandoverReads, savedSetups, selectedTabId, setAcpClis, settingsService, workspaces,
} from "../state.ts";
import { acpLeaderOf, hasAcpLeader, leaderSeatOf, tabLocation } from "../tabs.ts";
import { readCliId, requiredRequestId, runAsyncAction } from "../workspace.ts";

function onRefreshSettings(ws: WebSocket, message: any): void {
  const folder = tabLocation(selectedTabId)?.tab.folder ?? null;
  const requestId = readChatRequestId(message.requestId);
  const refresh = async () => {
    await settingsService.refreshAll(folder);
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "settingsRefreshed" })); } catch { /* a closed socket cannot change the outcome */ }
  };
  // With a requestId the page gets the normal actionResult or error for it (also when the check fails); without one, a failure is still reported.
  if (requestId !== undefined) runAsyncAction(ws, message.type, requestId, refresh);
  else void refresh().catch((err) => sendError(ws, describeError(err), { action: message.type }));
  return;
}
function onInstallCli(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  const cli = message.cli;
  runAsyncAction(ws, message.type, requestId, () => settingsService.installCli(readCliId(cli), requestId, message.confirm), { cli });
  return;
}
function onCliLogin(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  const cli = message.cli;
  const folder = tabLocation(selectedTabId)?.tab.folder ?? null;
  runAsyncAction(ws, message.type, requestId, () => settingsService.loginCli(readCliId(cli), requestId, folder), { cli });
  return;
}
function onGhLogin(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  runAsyncAction(ws, message.type, requestId, () => settingsService.loginGitHub(requestId));
  return;
}
function onSetNotesVault(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  runAsyncAction(ws, message.type, requestId, () => settingsService.setNotesVault(requestId, message.path));
  return;
}
function onSetDefaultProjectFolder(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  runAsyncAction(ws, message.type, requestId, () => settingsService.setDefaultProjectFolder(requestId, message.folder));
  return;
}
function onMcpAdd(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  const cli = message.cli;
  runAsyncAction(ws, message.type, requestId, () => settingsService.addMcp(readCliId(cli), requestId, message.name, message.commandOrUrl), { cli });
  return;
}
function onMcpRemove(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  const cli = message.cli;
  runAsyncAction(ws, message.type, requestId, () => settingsService.removeMcp(readCliId(cli), requestId, message.name, message.confirm), { cli });
  return;
}
function onPluginInstall(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  runAsyncAction(ws, message.type, requestId, () => settingsService.installPlugin(requestId, message.name), { cli: "claude" });
  return;
}
function onPluginUninstall(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  runAsyncAction(ws, message.type, requestId, () => settingsService.uninstallPlugin(requestId, message.name, message.confirm), { cli: "claude" });
  return;
}
function onAddAcpCli(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  runAsyncAction(ws, message.type, requestId, () => {
    const { program, args } = parseAcpStartCommand(message.command);
    const cli = validateAcpCli({ name: message.name, program, args });
    if (acpClis.some((item) => item.id === cli.id)) throw new Error(`There is already a CLI named "${cli.name}"`);
    if (acpClis.length >= ACP_MAX_CLIS) throw new Error(`At most ${ACP_MAX_CLIS} ACP CLIs`);
    try { resolveCliOrThrow(cli.program, process.env, process.cwd()); }
    catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      throw new Error(/was not found on PATH$/.test(text) ? `${cli.program} was not found. Install it first, or check the name.` : text.charAt(0).toUpperCase() + text.slice(1));
    }
    writeAcpClis([...acpClis, cli]);
    setAcpClis([...acpClis, cli]);
    broadcast(stateMessage());
    return { id: cli.id };
  });
  return;
}
function onRemoveAcpCli(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  runAsyncAction(ws, message.type, requestId, () => {
    const cli = acpClis.find((item) => item.id === message.id);
    if (!cli) throw new Error("Unknown ACP CLI");
    const kind = acpKindOf(cli);
    for (const tab of workspaces.projects.flatMap((project) => project.tabs)) {
      const member = tab.crew.find((seat) => seat.cli === kind);
      if (member) throw new Error(`${cli.name} is used by ${member.name} (${member.role}) in "${tab.name}". Pick another CLI for that seat first.`);
    }
    const savedUse = savedSetups.find((setup) => setup.crew.some((seat) => seat.cli === kind));
    if (savedUse) throw new Error(`${cli.name} is used by the saved setup "${savedUse.name}". Remove that setup, or change the CLI there, first.`);
    writeAcpClis(acpClis.filter((item) => item !== cli));
    setAcpClis(acpClis.filter((item) => item !== cli));
    broadcast(stateMessage());
    return { id: cli.id };
  });
  return;
}
function onSetPermissionMode(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  const tabId = message.tabId;
  runAsyncAction(ws, message.type, requestId, async () => {
    if (typeof tabId !== "string" || !tabLocation(tabId)) throw new Error("unknown tab");
    // An ACP leader has Full access only: anything else is refused, and Full access needs no change (it is what the leader runs in; the tab's saved mode is left as it is).
    if (hasAcpLeader(tabId)) {
      if (message.mode !== "bypass") throw new Error(`${acpLeaderOf(tabId)?.name ?? "This leader"} can only run with Full access: it may edit files and run commands without asking, and Command Center cannot make it ask yet.`);
      return { tabId, mode: "bypass" };
    }
    // A Codex turn keeps the policy it started with: say so, instead of letting the failed apply stop the chat.
    const busy = () => {
      const location = tabLocation(tabId);
      return new ModeBusyError(`Finish or stop ${(location && leaderSeatOf(location.tab))?.name ?? "the leader"}'s current turn first, then change the mode.`);
    };
    const running = leaders.get(tabId);
    if (running && !running.isDead() && running.modeLocked?.()) throw busy();
    let appliedLeader: LeaderHandle | undefined;
    const mode = await settingsService.setPermissionMode(tabId, requestId, message.mode, message.confirm, async (nextMode) => {
      const leader = leaders.get(tabId);
      if (!leader || leader.isDead()) return true;
      // The real guard: this runs after earlier queued changes, so the leader (and its lock) may be a different one than at request time.
      if (leader.modeLocked?.()) throw busy();
      appliedLeader = leader;
      return leader.setPermissionMode(nextMode);
    }, (reason) => {
      if (!appliedLeader || leaders.get(tabId) !== appliedLeader) return false;
      const leader = appliedLeader;
      const chatWasRunning = Boolean((leader && !leader.isDead()) || activeLeaderTurns.has(tabId));
      stopLeaderSession(tabId, false, reason);
      pendingHandoverReads.add(tabId);
      return chatWasRunning;
    }, () => tabLocation(tabId) !== null);
    return { tabId, mode };
  });
  return;
}
export function settingsMessages(): Array<[string, MessageHandler]> {
  return [
    ["refreshSettings", onRefreshSettings],
    ["installCli", onInstallCli],
    ["cliLogin", onCliLogin],
    ["ghLogin", onGhLogin],
    ["setNotesVault", onSetNotesVault],
    ["setDefaultProjectFolder", onSetDefaultProjectFolder],
    ["mcpAdd", onMcpAdd],
    ["mcpRemove", onMcpRemove],
    ["pluginInstall", onPluginInstall],
    ["pluginUninstall", onPluginUninstall],
    ["addAcpCli", onAddAcpCli],
    ["removeAcpCli", onRemoveAcpCli],
    ["setPermissionMode", onSetPermissionMode],
  ];
}
