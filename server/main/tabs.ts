import { statSync } from "node:fs";
import { join } from "node:path";
import { acpKindOf, isAcpKind, type WorkspaceProject, type WorkspaceTab, type CrewMember, type AcpCli } from "../config.ts";
import type { PermissionMode } from "../settings.ts";
import { createTabState, deriveSteps } from "../process.ts";
import { acpClis, folderActivity, publicDir, settingsService, tabs, workspaces, type TabRuntime } from "./state.ts";

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
  return tab.crew.find((seat) => seat.slot === slot);
}
// The one leader lookup: the tab's leader seat, if it has one.
export const leaderSeatOf = (tab: WorkspaceTab): CrewMember | undefined => tab.crew.find((member) => member.isLeader);
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
export function runtimeFor(tab: WorkspaceTab): TabRuntime {
  let runtime = tabs.get(tab.id);
  if (runtime) return runtime;
  runtime = { state: createTabState({ crew: tab.crew, steps: deriveSteps(tab.crew, tab.lookPause) }, { tabId: tab.id, folderPath: tab.folder }), stalledRuns: new Set() };
  tabs.set(tab.id, runtime);
  return runtime;
}
export const watchTabFolders = (): void => folderActivity.watchFolders(workspaces.projects.flatMap((project) => project.tabs.map((tab) => tab.folder)));
export function updateRuntimeSeat(tabId: string, seat: CrewMember): void {
  const runtime = tabs.get(tabId);
  const stateSeat = runtime?.state.seats.find((entry) => entry.slotId === seat.slot);
  if (!stateSeat) return;
  stateSeat.name = seat.name;
  stateSeat.cli = seat.cli;
  stateSeat.model = seat.model;
  stateSeat.effort = seat.effort;
  stateSeat.roleLabel = seat.role;
  stateSeat.canWrite = seat.canWrite;
  if (seat.advisor === undefined) delete stateSeat.advisor; else stateSeat.advisor = seat.advisor;
  if (seat.orchestrates === true) stateSeat.orchestrates = true; else delete stateSeat.orchestrates;
}
export function isAvatarRoute(value: string): boolean {
  return /^\/api\/avatar\/avatar-[0-9a-f-]{36}\.(?:png|jpg|webp)$/i.test(value);
}
// The preset grid sends "avatars/<name>.svg"; only files that ship in public/avatars count.
export function isPresetAvatar(value: string): boolean {
  const name = value.match(/^avatars\/([A-Za-z0-9-]{1,40}\.svg)$/)?.[1];
  if (!name) return false;
  try { return statSync(join(publicDir, "avatars", name)).isFile(); } catch { return false; }
}
