import { writeWorkspaces, isValidModel, isValidEffort, defaultEffort, acpKindOf, isAcpKind, writeSetups, type CrewMember } from "../config.ts";
import { resolveCliOrThrow } from "../leader-common.ts";
import { cliCaps, type ProcessState } from "../process.ts";
import { createCrewSetup } from "../crew-setup.ts";
import { hasPendingApproval } from "./approvals.ts";
import { broadcast, stateMessage } from "./broadcast.ts";
import { stopLeaderSession } from "./leader-session.ts";
import {
  acpClis, activeLeaderTurns, blockedSeatKeys, describeError, launchSafety, leaderSeats, leaders, pendingHandoverReads, queuedLeaderChanges, savedSetups,
  setSavedSetups, setWorkspaces, settingsService, tabs, unconfirmedRunIds, workspaces,
} from "./state.ts";
import { crewDefinition, isAvatarRoute, isPresetAvatar, tabLocation, updateRuntimeSeat } from "./tabs.ts";
import { saveWorkspaceDraft, seatIsWorking, syncWorkspace, tabHasActiveWork } from "./workspace.ts";

export function updateProcessState(tabId: string, update: (state: ProcessState) => ProcessState): void {
  const runtime = tabs.get(tabId);
  if (!runtime) throw new Error(`unknown tab: ${tabId}`);
  runtime.state = update(runtime.state);
  broadcast(stateMessage());
}
export function updateSeatPrefs(message: any): void {
  const tabId = message.tabId;
  const slot = message.slot;
  const location = tabLocation(tabId);
  if (!location || typeof slot !== "string") throw new Error("unknown tab or seat slot");
  const current = location.tab.crew.find((seat) => seat.slot === slot);
  if (!current) throw new Error(`unknown slot: ${slot}`);
  const next: CrewMember = { ...current };
  const leaderSlot = current.isLeader;
  // A working crew seat keeps its setup: refuse before anything is saved (name, role and pic still apply). The leader has its own deferred path.
  const setupChange = (message.cli !== undefined && message.cli !== current.cli) || (message.model !== undefined && message.model !== current.model) || (message.effort !== undefined && message.effort !== current.effort)
    || (message.canWrite !== undefined && message.canWrite !== current.canWrite) || (message.orchestrates !== undefined && Boolean(message.orchestrates) !== Boolean(current.orchestrates))
    || (message.advisor !== undefined && (message.advisor || undefined) !== current.advisor);
  if (!leaderSlot && seatIsWorking(tabId, slot) && setupChange) throw new Error(`${current.name} is working. Change the model when its runs finish.`);
  let cliChanged = false;
  if (message.cli !== undefined && message.cli !== current.cli) {
    if (typeof message.cli !== "string" || !cliCaps(message.cli)) throw new Error(`unknown CLI for ${slot}`);
    const kind = message.cli as CrewMember["cli"];
    if (isAcpKind(kind)) {
      // A CLI added in Settings can sit on any seat; it may edit files and run commands without asking, which the user confirms here.
      const acp = acpClis.find((cli) => acpKindOf(cli) === kind);
      if (!acp) throw new Error(`that CLI is not in your ACP CLIs list (${kind.slice(4)})`);
      if (message.confirm !== true) throw new Error(`Full access confirmation is required: ${acp.name} may edit files and run commands without asking`);
      resolveCliOrThrow(acp.program, process.env, location.tab.folder);
    } else {
      const installed = settingsService.state.tools[kind].installed;
      if (installed !== true) throw new Error(installed === false ? `${kind} is not installed` : `${kind} has not been checked yet; refresh the tools first`);
    }
    if (typeof message.model !== "string" || !isValidModel(kind, message.model)) throw new Error(`a valid ${kind} model is required with a new CLI for ${slot}`);
    if (leaderSlot && (activeLeaderTurns.has(tabId) || hasPendingApproval(tabId))) throw new Error(`Finish or stop ${current.name}'s current turn first`);
    next.cli = kind;
    next.effort = isValidEffort(kind, current.effort) ? current.effort : defaultEffort(kind);
    // The advisor is Claude's: a seat that moves to another CLI loses it.
    if (!cliCaps(kind)?.advisor) delete next.advisor;
    cliChanged = true;
  } else if (message.cli !== undefined && typeof message.cli !== "string") throw new Error(`unknown CLI for ${slot}`);
  if (message.name !== undefined) {
    if (typeof message.name !== "string" || !message.name.trim()) throw new Error("seat name is required");
    next.name = message.name.trim();
  }
  if (message.model !== undefined) {
    if (typeof message.model !== "string" || !isValidModel(next.cli, message.model)) throw new Error(`invalid model for ${slot}`);
    next.model = message.model;
  }
  if (message.effort !== undefined) {
    if (typeof message.effort !== "string" || !isValidEffort(next.cli, message.effort)) throw new Error(`invalid effort for ${slot}`);
    next.effort = message.effort;
  }
  if (message.pic !== undefined) {
    if (message.pic === null || message.pic === "") delete next.pic;
    else if (typeof message.pic === "string" && (isAvatarRoute(message.pic) || isPresetAvatar(message.pic))) next.pic = message.pic;
    else throw new Error("invalid seat pic");
  }
  if (message.role !== undefined) {
    if (typeof message.role !== "string" || !message.role.trim() || message.role.length > 60) throw new Error("seat role is required (60 characters at most)");
    next.role = message.role.trim();
  }
  if (message.canWrite !== undefined) {
    if (typeof message.canWrite !== "boolean") throw new Error("canWrite must be true or false");
    next.canWrite = message.canWrite;
  }
  if (message.orchestrates !== undefined) {
    if (typeof message.orchestrates !== "boolean") throw new Error("orchestrates must be true or false");
    if (message.orchestrates) next.orchestrates = true; else delete next.orchestrates;
  }
  if (message.advisor !== undefined) {
    if (message.advisor === null || message.advisor === "") delete next.advisor;
    else if (typeof message.advisor === "string" && isValidModel("claude", message.advisor)) next.advisor = message.advisor;
    else throw new Error("invalid advisor model");
  }
  // Whatever the seat turned into must still be a crew the process can run (one leader, a Planner that runs the process, an advisor only where the CLI has one); a new role re-derives the steps.
  const nextCrew = location.tab.crew.map((seat) => seat.slot === slot ? next : seat);
  const derived = crewSetup.stepsAfterSeatChange(tabId, location.tab, nextCrew);
  // A new leader CLI ends the current session the way Stop does (usage banked, chat log kept); the next message starts on the new CLI.
  if (cliChanged && leaderSlot) { stopLeaderSession(tabId); pendingHandoverReads.add(tabId); }
  const activeLeader = leaders.get(tabId);
  // While the leader is writing an answer its model and effort are not touched (a failed change would cut the answer): the new values are
  // saved now and reach the live leader when the answer ends (applyQueuedLeaderChange).
  const deferLive = Boolean(leaderSlot && activeLeader && !activeLeader.isDead() && activeLeaderTurns.has(tabId));
  if (!deferLive && leaderSlot && message.model !== undefined && activeLeader && !activeLeader.isDead()) {
    void activeLeader.setModel(next.model).then((ok) => {
      if (!ok) { broadcast({ type: "error", message: "leader model change failed" }); return; }
      const currentLocation = tabLocation(tabId);
      if (!currentLocation || leaders.get(tabId) !== activeLeader || !crewDefinition(currentLocation.tab, slot)?.isLeader) return;
      const currentSeat = currentLocation.tab.crew.find((seat) => seat.slot === slot);
      if (!currentSeat) return;
      const merged: CrewMember = { ...currentSeat };
      if (message.name !== undefined) merged.name = next.name;
      if (message.model !== undefined) merged.model = next.model;
      if (message.effort !== undefined) { merged.effort = next.effort; const liveSeat = leaderSeats.get(tabId); if (liveSeat) liveSeat.effort = next.effort; }
      if (message.pic !== undefined) {
        if (next.pic === undefined) delete merged.pic;
        else merged.pic = next.pic;
      }
      if (message.role !== undefined) merged.role = next.role;
      if (message.canWrite !== undefined) merged.canWrite = next.canWrite;
      if (message.orchestrates !== undefined) { if (next.orchestrates) merged.orchestrates = true; else delete merged.orchestrates; }
      if (message.advisor !== undefined) { if (next.advisor === undefined) delete merged.advisor; else merged.advisor = next.advisor; }
      const draft = saveWorkspaceDraft();
      const project = draft.projects.find((item) => item.id === currentLocation.project.id);
      const tab = project?.tabs.find((item) => item.id === tabId);
      if (!tab) return;
      tab.crew = tab.crew.map((seat) => seat.slot === slot ? merged : seat);
      syncWorkspace(draft); updateRuntimeSeat(tabId, merged); broadcast(stateMessage());
    }).catch((err) => broadcast({ type: "error", message: `leader model change failed: ${describeError(err)}` }));
    return;
  }
  const draft = saveWorkspaceDraft();
  const project = draft.projects.find((item) => item.id === location.project.id)!;
  const tab = project.tabs.find((item) => item.id === tabId)!;
  tab.crew = tab.crew.map((seat) => seat.slot === slot ? next : seat);
  syncWorkspace(draft);
  if (derived.changed) crewSetup.restartOnNewSteps(tabId, tab);
  // Queued only once the save held: a refused save must not change the live leader later.
  if (deferLive && (message.model !== undefined || message.effort !== undefined)) {
    const queued = queuedLeaderChanges.get(tabId);
    queuedLeaderChanges.set(tabId, { liveLeader: activeLeader!, model: message.model !== undefined ? next.model : queued?.model, effort: message.effort !== undefined ? next.effort : queued?.effort });
  }
  updateRuntimeSeat(tabId, next);
  const liveSeat = leaderSlot && !deferLive ? leaderSeats.get(tabId) : undefined;
  if (liveSeat) liveSeat.effort = next.effort;
  broadcast(stateMessage());
}
export const crewSetup = createCrewSetup({
  tabLocation, tabHasActiveWork, seatIsWorking, stopLeaderSession, tabs, updateRuntimeSeat,
  seatIsBlocked: (key) => blockedSeatKeys.has(key) || unconfirmedRunIds.has(key) || launchSafety.uncertain.some((row) => row.seatId === key),
  workspaces: () => workspaces, setWorkspaces: (next) => { setWorkspaces(next); },
  savedSetups: () => savedSetups, setSavedSetups: (next) => { setSavedSetups(next); },
  isValidPic: (pic) => typeof pic === "string" && (isAvatarRoute(pic) || isPresetAvatar(pic)),
  announce: () => broadcast(stateMessage()), writeWorkspaces, writeSetups,
});
