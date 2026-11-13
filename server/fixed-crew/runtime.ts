import type { WorkspaceTab, CrewMember } from "../config.ts";
import { createTabState, type ProcessState } from "../process.ts";
import { FIXED_CREW } from "./roster.ts";
import { validateFixedCrew } from "./preferences.ts";

// Presence is the format discriminator, including malformed and future data.
export const isFixedTab = (tab: WorkspaceTab): boolean => Object.hasOwn(tab, "fixedCrew");
export function fixedCrewOf(tab: WorkspaceTab) {
  if (!isFixedTab(tab)) throw new Error("A fixed crew tab is required.");
  return validateFixedCrew(tab.fixedCrew);
}
export function fixedMembers(tab: WorkspaceTab): CrewMember[] {
  const fixed = fixedCrewOf(tab);
  return FIXED_CREW.flatMap(({ slot, role, canWrite }) => {
    const assignment = fixed.preferences[slot].assignment;
    return assignment ? [{ slot, name: role, role, canWrite, isLeader: slot === "leader", ...assignment }] : [];
  });
}
export function fixedState(tab: WorkspaceTab, previous?: ProcessState): ProcessState {
  // Unavailable fixed data stays visible but has no executable seats.
  let crew: CrewMember[] = [];
  try { crew = fixedMembers(tab); } catch { /* launches validate and explain the unavailable data */ }
  const state = createTabState(crew, { tabId: tab.id, folderPath: tab.folder });
  if (!previous) return state;
  state.runs = previous.runs;
  state.seats = state.seats.map((seat) => {
    const old = previous.seats.find((s) => s.slotId === seat.slotId);
    return old ? { ...seat, status: old.status, task: old.task } : seat;
  });
  return state;
}
