import { acpKindOf, isAcpKind, type WorkspaceProject, type WorkspaceTab, type CrewMember, type AcpCli } from "../config.ts";
import type { PermissionMode } from "../settings.ts";
import { acpClis, folderActivity, settingsService, tabs, workspaces, type TabRuntime } from "./state.ts";
import { fixedMembers, fixedState } from "../fixed-crew/runtime.ts";

export function runtimeCrew(tab: WorkspaceTab): CrewMember[] {
  try { return fixedMembers(tab); } catch { return []; }
}
export function runtimeFor(tab: WorkspaceTab): TabRuntime {
  const previous = tabs.get(tab.id);
  const runtime = previous ?? { state: fixedState(tab), stalledRuns: new Set<string>() };
  if (previous) runtime.state = fixedState(tab, previous.state);
  tabs.set(tab.id, runtime);
  return runtime;
}

export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function tabLocation(tabId: string): { project: WorkspaceProject; tab: WorkspaceTab } | null {
  for (const project of workspaces.projects) {
    const tab = project.tabs.find((item) => item.id === tabId);
    if (tab) return { project, tab };
  }
  return null;
}
// The seat itself carries its role, leader flag and write permission.
export function crewDefinition(tab: WorkspaceTab, slot: string): CrewMember | undefined {
  return runtimeCrew(tab).find((seat) => seat.slot === slot);
}
// The one leader lookup: the tab's leader seat, if it has one.
export const leaderSeatOf = (tab: WorkspaceTab): CrewMember | undefined => runtimeCrew(tab).find((member) => member.isLeader);
// A tab's leader CLI added in Settings (ACP), or null for Claude, Codex and OpenCode. An ACP CLI that was since removed counts as null (the dispatch says so).
export function acpLeaderOf(tabId: string): AcpCli | null {
  const location = tabLocation(tabId);
  const lead = location && leaderSeatOf(location.tab);
  return lead && isAcpKind(lead.cli) ? acpClis.find((cli) => acpKindOf(cli) === lead.cli) ?? null : null;
}
export const hasAcpLeader = (tabId: string): boolean => {
  const location = tabLocation(tabId);
  const lead = location && leaderSeatOf(location.tab);
  return Boolean(lead && isAcpKind(lead.cli));
};
// The mode the tab really runs in. An ACP leader has Full access only (the CLI decides by itself whether it asks), whatever mode the tab saved: the saved mode stays in the file and applies again if the leader is switched back.
export function effectiveMode(tabId: string): PermissionMode { return hasAcpLeader(tabId) ? "bypass" : settingsService.permissionMode(tabId); }
export const watchTabFolders = (): void => folderActivity.watchFolders(workspaces.projects.flatMap((project) => project.tabs.map((tab) => tab.folder)));
