import { WebSocket } from "ws";
import {
  MODEL_OPTIONS, EFFORT_OPTIONS, OPENCODE_MODEL_SUGGESTIONS, CLAUDE_MODEL_INFO, discoveryInfo, acpKindOf, visibleTemplates, buildClis,
} from "../config.ts";
import { isRunning } from "../runner.ts";
import { addUsage, zeroUsage, toUsageSnapshot } from "../usage.ts";
import {
  getStepBar, getApprovedCardLine, getLeaderStatusLine, getSeatTaskLine, getWorkingSeats, getRunViews, getRoundFlag, isBusy, rolesForPage,
} from "../process.ts";
import { askerOf } from "./approvals.ts";
import { launchedByOfRun } from "./launch.ts";
import {
  BACKPRESSURE_LIMIT, EMPTY_CHANGES, EMPTY_NOTES, MAX_RUN_OUTPUT, acpClis, activeLeaderTurns, changesByTab, chatStore, clientPrefs, clients, describeError,
  laggingClients, launchSafety, leaderActivity, leaderJobs, leaderModels, leaderUsage, leaders, notesByTab, pendingApprovals, reportedChatProblems,
  requestActions, requestsStore, runOutput, runUsage, savedSetups, savingTabs, selectedTabId, settingsService, workspaces,
} from "./state.ts";
import { acpLeaderOf, clone, effectiveMode, hasAcpLeader, runtimeFor, tabLocation } from "./tabs.ts";
import { tabHasActiveWork } from "./workspace.ts";

export function appendRunOutput(runId: string, chunk: string): void {
  const next = (runOutput.get(runId) ?? "") + chunk;
  const bytes = Buffer.from(next, "utf8");
  let start = Math.max(0, bytes.length - MAX_RUN_OUTPUT);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  runOutput.set(runId, bytes.subarray(start).toString("utf8"));
}
export function addRunUsage(runId: string, delta: Parameters<typeof addUsage>[1]): void {
  const usage = runUsage.get(runId) ?? zeroUsage();
  runUsage.set(runId, addUsage(usage, delta));
}
export function broadcast(message: Record<string, unknown>): void {
  for (const ws of clients) {
    try {
      if (ws.readyState !== WebSocket.OPEN) { laggingClients.delete(ws); continue; }
      const carriesRunOutput = message.type === "output" || message.type === "state";
      if (carriesRunOutput && ws.bufferedAmount > BACKPRESSURE_LIMIT) {
        laggingClients.add(ws);
        continue;
      }
      const recovered = resyncClient(ws);
      // The recovered state includes this run output already.
      if (recovered && carriesRunOutput) continue;
      ws.send(JSON.stringify(message));
    } catch { clients.delete(ws); laggingClients.delete(ws); }
  }
}
export function resyncClient(ws: WebSocket): boolean {
  if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > BACKPRESSURE_LIMIT || !laggingClients.has(ws)) return false;
  try {
    ws.send(JSON.stringify({ ...stateMessage(), notice: "[output dropped: client fell behind]" }));
    laggingClients.delete(ws);
    return true;
  } catch { clients.delete(ws); laggingClients.delete(ws); return false; }
}
export function stateMessage(): Record<string, unknown> {
  const projects = workspaces.projects.map((project) => ({
    ...project,
    tabs: project.tabs.map((tab) => {
      const runtime = runtimeFor(tab);
      const state = clone(runtime.state);
      const engineRuns = state.runs.map((run) => ({
        ...run,
        runId: run.id,
        seatKey: `${tab.id}.${run.seatSlotId}`,
        output: isRunning(run.id) ? runOutput.get(run.id) ?? "" : "",
        ...(isRunning(run.id) && runUsage.has(run.id) ? { usage: toUsageSnapshot(runUsage.get(run.id)!) } : {}),
        stalled: runtime.stalledRuns.has(run.id),
        launchedBy: launchedByOfRun(tab.id, run.id),
      }));
      const crew = tab.crew.map((member) => {
        const engineSeat = state.seats.find((seat) => seat.slotId === member.slot)!;
        const active = engineRuns.filter((run) => run.seatSlotId === member.slot && run.status === "working");
        const status = active.some((run) => run.stalled) ? "stalled" : active.length ? "working" : engineSeat.status;
        return { ...member, seatKey: `${tab.id}.${member.slot}`, status, task: getSeatTaskLine(state, member.slot), isLeader: engineSeat.isLeader, runs: active.map((run) => run.runId) };
      });
      // Two counters are all a state message needs; a transcript that cannot be read stops being counted for that one tab, never for the app.
      let chat = { revision: 0, savedRevision: 0 };
      let chatProblem: string | undefined;
      try { chat = chatStore.counters(tab.id); }
      catch (err) {
        chatProblem = describeError(err);
        if (!reportedChatProblems.has(tab.id)) { reportedChatProblems.add(tab.id); console.error(`chat transcript for ${tab.id} cannot be read: ${chatProblem}`); }
      }
      return {
        ...tab,
        crew,
        permissionMode: effectiveMode(tab.id),
        acpLeader: hasAcpLeader(tab.id) ? { name: acpLeaderOf(tab.id)?.name ?? null, model: leaderModels.get(tab.id) ?? null } : null,
        pendingApprovals: [...pendingApprovals.values()].filter((item) => item.tabId === tab.id).map(({ approvalId, tool, summary, createdAt, origin }) => ({ approvalId, tool, summary, createdAt, askedBy: askerOf(tab.id, origin) })),
        permissionAction: settingsService.state.permissionActions[tab.id],
        pendingRequestCount: requestsStore.pendingCount(tab.id),
        changes: changesByTab.get(tab.id) ?? { ...EMPTY_CHANGES },
        notes: notesByTab.get(tab.id) ?? { ...EMPTY_NOTES },
        runs: engineRuns,
        processState: state,
        derived: {
          stepBar: getStepBar(state), approvedCardLine: getApprovedCardLine(state), leaderStatusLine: getLeaderStatusLine(state),
          workingSeats: getWorkingSeats(state), runViews: getRunViews(state), roundFlag: getRoundFlag(state), leaderTurnActive: activeLeaderTurns.has(tab.id), busy: isBusy(state) || activeLeaderTurns.has(tab.id) || savingTabs.has(tab.id),
        },
        // The page asks before the app closes while any tab has this: the same check that refuses changing a busy tab's folder or process.
        activeWork: tabHasActiveWork(tab.id),
        leaderStatus: leaders.get(tab.id) ? (leaders.get(tab.id)!.isDead() ? "dead" : "ready") : "not-started",
        leaderUsage: leaderUsage.has(tab.id) ? toUsageSnapshot(leaderUsage.get(tab.id)!) : undefined,
        leaderActivity: leaderActivity.get(tab.id) ?? null,
        leaderJobs: leaderJobs.get(tab.id) ?? [],
        chatRevision: chat.revision,
        savedRevision: chat.savedRevision,
        ...(chatProblem ? { chatProblem } : {}),
      };
    }),
  }));
  return {
    type: "state", projects, selectedTabId,
    acpClis: acpClis.map((cli) => ({ ...cli, kind: acpKindOf(cli) })),
    clis: buildClis((cli) => settingsService.state.tools[cli].installed ?? null, acpClis),
    templates: TEMPLATES_FOR_PAGE,
    savedSetups: savedSetups.map(({ id, name, kind, crew, lookPause, steps }) => ({ id, name, kind, crew, lookPause, steps })),
    roles: rolesForPage(),
    modelOptions: MODEL_OPTIONS, effortOptions: EFFORT_OPTIONS, opencodeModels: OPENCODE_MODEL_SUGGESTIONS,
    claudeModels: CLAUDE_MODEL_INFO, discoveryInfo, clientPrefs,
    launchSafety: { blocked: launchSafety.blocked, uncertain: launchSafety.uncertain, released: launchSafety.released, notices: launchSafety.notices },
    releasedProcesses: launchSafety.released.map(({ seatId, pid }) => ({ seatId, pid })),
    settings: settingsService.snapshot(),
    requests: requestsStore.list().map((request) => request.status === "pending" && !tabLocation(request.toTabId) ? { ...request, status: "destinationRemoved" } : request),
    pendingRequestCounts: Object.fromEntries(workspaces.projects.flatMap((project) => project.tabs.map((tab) => [tab.id, requestsStore.pendingCount(tab.id)]))),
    requestActions: { ...requestActions },
    globalWork: globalWork(),
  };
}
// The templates never change while the app runs: built once for every state message.
const TEMPLATES_FOR_PAGE = visibleTemplates().map(({ id, name, kind, desc, crew, lookPause, steps }) => ({ id, name, kind, desc, crew, lookPause, steps }));
// Work that belongs to no tab and would be cut off by closing the app: a running Settings action (an install), an upload in flight,
// and a process from an earlier session that was never confirmed closed.
function globalWork(): string[] {
  const work: string[] = [];
  if (Object.values(requestActions).some((item) => item.status === "running")) work.push("a Settings action is running");
  if (Object.values(settingsService.state.uploads).some((item) => item.status === "running")) work.push("an upload is running");
  if (launchSafety.uncertain.some((row) => !row.seatId.includes("."))) work.push("a process from an earlier session may still be running");
  return work;
}
// Usage events can arrive many times a second and each full state message is large (and can trip the backpressure drop): the first goes out
// at once, the rest are folded into at most one more per 400 ms. A turn's end or any other change still broadcasts at once.
const USAGE_STATE_MIN_GAP_MS = 400;
let lastUsageBroadcast = 0;
let usageStateTimer: ReturnType<typeof setTimeout> | undefined;
export function broadcastUsageState(): void {
  const wait = lastUsageBroadcast + USAGE_STATE_MIN_GAP_MS - Date.now();
  if (wait <= 0) { lastUsageBroadcast = Date.now(); broadcast(stateMessage()); return; }
  if (usageStateTimer) return;
  usageStateTimer = setTimeout(() => { usageStateTimer = undefined; lastUsageBroadcast = Date.now(); broadcast(stateMessage()); }, wait);
  usageStateTimer.unref?.();
}
export function sendState(ws: WebSocket): void { ws.send(JSON.stringify(stateMessage())); }
export function sendError(ws: WebSocket, message: string, details: Record<string, unknown> = {}): void { ws.send(JSON.stringify({ type: "error", message, ...details })); }
