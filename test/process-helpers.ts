import assert from "node:assert/strict";
import { FIXED_CREW, type Assignment, type FixedSlot } from "../server/fixed-crew/roster.ts";
import { fixedState } from "../server/fixed-crew/runtime.ts";
import type { ProcessState } from "../server/process.ts";
import { fixedTab } from "./fixed-server-fixture.ts";

export const WORK_SLOTS: readonly FixedSlot[] = ["leader", "coder", "reviewer1", "reviewer2"];

export function seat(state: ProcessState, slotId: string) {
  const result = state.seats.find((item) => item.slotId === slotId);
  assert.ok(result, `missing seat ${slotId}`);
  return result;
}

// A real fixed-crew runtime state: a fixed tab whose listed slots hold the roster's preferred assignment (a slot with no assignment has no seat),
// then `choices` replace individual slots. Built by the shipped fixedState(), never by hand.
export function fixedProcess(options: { slots?: readonly FixedSlot[]; folderPath?: string; tabId?: string; choices?: Partial<Record<FixedSlot, Assignment>> } = {}): ProcessState {
  const choices: Partial<Record<FixedSlot, Assignment>> = {};
  for (const slot of options.slots ?? WORK_SLOTS) choices[slot] = { ...FIXED_CREW.find((item) => item.slot === slot)!.preferred };
  Object.assign(choices, options.choices);
  return fixedState(fixedTab(options.tabId ?? "dev-main", options.folderPath ?? "C:\\work", choices));
}
