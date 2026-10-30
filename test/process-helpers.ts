import assert from "node:assert/strict";
import { advanceStep, approveLook, createTabState, getStepBar } from "../server/process.ts";
import { legacySetup, getProcessDefinition } from "./old-definitions.ts";

export function seat(state: ProcessState, slotId: string) {
  const result = state.seats.find((item) => item.slotId === slotId);
  assert.ok(result, `missing seat ${slotId}`);
  return result;
}

export function atLook(kind: ProcessKind = "dev", process: ProcessId = "main", folderPath = "C:\\work") {
  let state = createTabState(legacySetup(kind, process), { tabId: `${kind}-${process}`, folderPath });
  const lookIndex = getProcessDefinition(kind, process).steps.findIndex((step) => step.id === "look");
  assert.notEqual(lookIndex, -1);
  while (state.currentStepIndex < lookIndex) state = advanceStep(state);
  assert.equal(state.currentStepIndex, lookIndex);
  assert.equal(state.approval.state, "pending");
  return state;
}

export function activeReview(kind: ProcessKind = "dev", process: ProcessId = "main") {
  return approveLook(atLook(kind, process));
}

export function currentStepText(state: ProcessState) {
  return getStepBar(state)[state.currentStepIndex]?.label;
}
