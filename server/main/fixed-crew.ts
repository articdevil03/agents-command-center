import { buildClis, CLAUDE_MODEL_INFO, OPENCODE_MODEL_SUGGESTIONS, fixedCrewRecovery, writeWorkspaces, type WorkspaceTab, type Workspaces } from "../config.ts";
import { independenceNotice, type AssignmentCatalogue } from "../fixed-crew/assignment.ts";
import { assignmentsDigest, bulkAssignment } from "../fixed-crew/bulk-assignment.ts";
import { creationCrew, exactKeys, fillCrew, knownSlot, setCrewAssignment, setCrewRoleExtra, validateFixedCrew, type FixedCrew } from "../fixed-crew/preferences.ts";
import { FIXED_CREW, type Assignment, type FixedSlot } from "../fixed-crew/roster.ts";
import { hasPendingApproval } from "./approvals.ts";
import { broadcast, stateMessage } from "./broadcast.ts";
import { acpClis, activeLeaderTurns, runContexts, savingTabs, selectedTabId, setWorkspaces, settingsService, workspaces } from "./state.ts";
import { tabLocation } from "./tabs.ts";
import { seatIsWorking } from "./workspace.ts";
import { fixedCrewOf, isFixedTab } from "../fixed-crew/runtime.ts";
import { assertTaskRecoveryReady, assertWorkspaceRecoveryReady, workspaceRecovery } from "../fixed-crew/recovery.ts";

type Dependencies = {
  workspace: () => Workspaces;
  selectedTabId: () => string;
  catalogue: () => AssignmentCatalogue;
  seatBusy: (tabId: string, slot: FixedSlot) => boolean;
  leaderActive: (tabId: string) => boolean;
  writeWorkspace: (draft: Workspaces) => void;
  setWorkspace: (draft: Workspaces) => void;
  announce: () => void;
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function manualAvailable(assignment: Assignment | null, catalogue: AssignmentCatalogue, previous?: Assignment | null): void {
  if (!assignment) return;
  const cli = catalogue.clis.find((cli) => cli.id === assignment.cli && cli.installed === true);
  if (!cli) throw new Error("This CLI is unavailable. Refresh installed tools first");
  const saved = previous?.cli === assignment.cli ? previous : undefined;
  const models = cli.models ?? catalogue.opencodeSuggestions ?? [];
  if (!models.includes(assignment.model) && assignment.model !== saved?.model && !cli.id.startsWith("opencode")) throw new Error("Unknown crew model");
  if (!cli.efforts.includes(assignment.effort) && assignment.effort !== saved?.effort) throw new Error("Unknown crew effort");
  if (assignment.advisor && (!cli.advisor || (!catalogue.claudeModels?.some((model) => model.value === assignment.advisor) && assignment.advisor !== saved?.advisor))) throw new Error("Unknown crew advisor");
}
export function createFixedCrewService(deps: Dependencies) {
  function commit(draft: Workspaces): void {
    deps.writeWorkspace(draft);
    deps.setWorkspace(draft);
  }
  function locate(tabId: unknown): WorkspaceTab {
    if (tabId !== deps.selectedTabId()) throw new Error("Select this tab before changing its crew");
    const tab = deps.workspace().projects.flatMap((project) => project.tabs).find((tab) => tab.id === tabId);
    if (!tab || !isFixedTab(tab)) throw new Error("This tab uses an existing crew");
    validateFixedCrew(tab.fixedCrew);
    return tab;
  }
  function refuseBusy(tabId: string, slot: FixedSlot): void {
    if (deps.seatBusy(tabId, slot)) throw new Error("This seat is working. Try again when it finishes");
  }
  function publish(tab: WorkspaceTab, next: FixedCrew): void {
    if (equal(tab.fixedCrew, next)) return;
    const draft = structuredClone(deps.workspace());
    draft.projects.flatMap((project) => project.tabs).find((item) => item.id === tab.id)!.fixedCrew = next;
    commit(draft);
    deps.announce();
  }
  function checkChanges(tab: WorkspaceTab, next: FixedCrew): void {
    for (const { slot } of FIXED_CREW) {
      const old = tab.fixedCrew!;
      const assignmentChanged = !equal(old.preferences[slot].assignment, next.preferences[slot].assignment);
      const extraChanged = old.roleExtras[slot] !== next.roleExtras[slot];
      if (!assignmentChanged && !extraChanged) continue;
      refuseBusy(tab.id, slot);
      if (slot === "leader" && deps.leaderActive(tab.id)) {
        const before = old.preferences.leader.assignment, after = next.preferences.leader.assignment;
        if (extraChanged || !before || !after || before.cli !== after.cli || before.advisor !== after.advisor) throw new Error("Finish the leader's current reply before changing its CLI or instructions");
      }
    }
  }
  return {
    setModelForAll(tabId: unknown, cli: unknown, model: unknown, expectedAssignmentsDigest: unknown, confirmReplace: unknown) {
      const tab = locate(tabId);
      const result = bulkAssignment(tab.fixedCrew!, deps.catalogue(), cli, model, expectedAssignmentsDigest, confirmReplace,
        (slot) => deps.seatBusy(tab.id, slot) || (slot === "leader" && deps.leaderActive(tab.id)));
      publish(tab, result.crew);
      const { crew, ...reply } = result;
      return { tabId, ...reply, assignmentsDigest: assignmentsDigest(crew) };
    },
    change(tabId: unknown, action: string, slot?: unknown, value?: unknown) {
      const tab = locate(tabId);
      let next: FixedCrew;
      if (action === "autoAssignCrew") next = fillCrew(tab.fixedCrew!, deps.catalogue(), true);
      else {
        knownSlot(slot);
        if (action === "setCrewAssignment" || action === "clearCrewAssignment") {
          next = setCrewAssignment(tab.fixedCrew!, slot, action === "clearCrewAssignment" ? null : value);
          manualAvailable(next.preferences[slot].assignment, deps.catalogue(), tab.fixedCrew!.preferences[slot].assignment);
        } else next = setCrewRoleExtra(tab.fixedCrew!, slot, action === "resetCrewRoleExtra" ? "" : value);
      }
      checkChanges(tab, next);
      publish(tab, next);
      return { tabId, ...(slot ? { slot } : {}) };
    },
    preview(choices: unknown, auto: unknown) {
      const next = creationCrew(choices, auto, deps.catalogue());
      for (const { slot } of FIXED_CREW) if (next.preferences[slot].source === "user") manualAvailable(next.preferences[slot].assignment, deps.catalogue());
      return next;
    },
    refresh() {
      const draft = structuredClone(deps.workspace());
      let changed = false;
      for (const tab of draft.projects.flatMap((project) => project.tabs)) {
        if (!tab.fixedCrew || tab.fixedCrew.version !== 1) continue;
        const next = fillCrew(tab.fixedCrew, deps.catalogue());
        try { checkChanges(tab, next); } catch { continue; }
        if (!equal(tab.fixedCrew, next)) { tab.fixedCrew = next; changed = true; }
      }
      if (changed) commit(draft);
    },
  };
}
export function fixedCatalogue(): AssignmentCatalogue {
  return { clis: buildClis((cli) => settingsService.state.tools[cli].installed ?? null, acpClis), opencodeSuggestions: OPENCODE_MODEL_SUGGESTIONS, claudeModels: CLAUDE_MODEL_INFO };
}
export const fixedCrewService = createFixedCrewService({
  workspace: () => workspaces, selectedTabId: () => selectedTabId, catalogue: fixedCatalogue,
  seatBusy: (tabId, slot) => seatIsWorking(tabId, slot) || savingTabs.has(tabId)
    || [...runContexts.values()].some((context) => context.tabId === tabId && context.slot === slot),
  leaderActive: (tabId) => activeLeaderTurns.has(tabId) || hasPendingApproval(tabId),
  writeWorkspace: writeWorkspaces, setWorkspace: setWorkspaces, announce: () => broadcast(stateMessage()),
});
export function fixedTab(id: string, name: string, folder: string, message: any): WorkspaceTab {
  if (message.fixedCrewVersion !== 1) throw new Error("Unsupported fixed crew version");
  return { id, name, folder, kind: "dev", setupName: "Fixed crew", crew: [], steps: [], lookPause: false, fixedCrew: fixedCrewService.preview(message.crewChoices, message.autoAssign) };
}
const OLD_MESSAGES = new Set(["updateSeat", "setSetup", "useSetup", "saveSetup", "approveLook", "advanceStep", "reviewFindings", "finishFix", "reviewClean", "selectFixer", "testGatedLaunch"]);
export function assertFixedCrewMessageAllowed(message: any): void {
  const taskAction = ["approveFixedPlan", "approveFixedRough", "requestFixedTaskAction"].includes(message.type);
  if (taskAction) assertTaskRecoveryReady();
  const changesWorkspace = ["addProject", "renameProject", "removeProject", "addTab", "renameTab", "removeTab", "changeFolder", "changeProjectFolder",
    "setCrewAssignment", "clearCrewAssignment", "autoAssignCrew", "setCrewModelForAll", "setCrewRoleExtra", "resetCrewRoleExtra", "updateSeat", "setSetup", "useSetup", "saveSetup", "removeSetup",
    "run", "chat", "steer", "save", "sendRequest", "resolveRequest"].includes(message.type);
  if (!taskAction && changesWorkspace) assertWorkspaceRecoveryReady("message");
  const tab = tabLocation(message.tabId ?? selectedTabId)?.tab;
  if (tab && isFixedTab(tab) && OLD_MESSAGES.has(message.type)) throw new Error("Fixed crews use task decisions. Legacy crew editing and step/review messages are unavailable.");
}
export function fixedCrewState(tab: WorkspaceTab) {
  if (!isFixedTab(tab)) return {};
  if (workspaceRecovery().blocked) return { fixedCrew: { version: tab.fixedCrew?.version ?? null, unavailable: true, notice: workspaceRecovery().notice } };
  let fixed: FixedCrew;
  try { fixed = fixedCrewOf(tab); }
  catch { return { fixedCrew: { version: tab.fixedCrew?.version ?? null, unavailable: true, notice: "This crew requires a newer version of Command Center or valid saved data" } }; }
  return { fixedCrew: { ...fixed, assignmentsDigest: assignmentsDigest(fixed), notice: fixedCrewRecovery(tab.id),
    busy: Object.fromEntries(FIXED_CREW.map(({ slot }) => [slot, seatIsWorking(tab.id, slot) || savingTabs.has(tab.id)
      || [...runContexts.values()].some((context) => context.tabId === tab.id && context.slot === slot)
      || (slot === "leader" && (activeLeaderTurns.has(tab.id) || hasPendingApproval(tab.id)))])),
    notices: Object.fromEntries(FIXED_CREW.filter((seat) => seat.reviews).map((seat) => [seat.slot, independenceNotice(fixed.preferences[seat.reviews!].assignment, fixed.preferences[seat.slot].assignment)])),
  } };
}
export function validateFixedCreationMessage(message: any): void {
  const common = ["type", "requestId", "name", "folder", "tabId", "projectOnly", "fixedCrewVersion", "crewChoices", "autoAssign"];
  const allowed = message.type === "addProject" ? [...common, "id", "tabFolder"] : [...common, "projectId"];
  exactKeys(message, allowed);
}
