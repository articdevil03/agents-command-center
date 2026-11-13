import { exactKeys } from "../../fixed-crew/preferences.ts";
import { getCrewRolePrompt } from "../../fixed-crew/role-prompts.ts";
import { fixedCrewService } from "../fixed-crew.ts";
import { requiredRequestId, runAsyncAction } from "../workspace.ts";
import type { MessageHandler } from "./types.ts";

const CHANGES: Record<string, string[]> = {
  setCrewAssignment: ["slot", "assignment"], clearCrewAssignment: ["slot"], autoAssignCrew: [],
  setCrewRoleExtra: ["slot", "text"], resetCrewRoleExtra: ["slot"],
};
export function fixedCrewMessages(): Array<[string, MessageHandler]> {
  const handlers: Array<[string, MessageHandler]> = Object.entries(CHANGES).map(([action, keys]) => [action, (ws, message) => {
    exactKeys(message, ["type", "requestId", "tabId", ...keys]);
    const requestId = requiredRequestId(message.requestId);
    runAsyncAction(ws, action, requestId, () => fixedCrewService.change(message.tabId, action, message.slot, action === "setCrewRoleExtra" ? message.text : message.assignment));
  }]);
  handlers.push(["setCrewModelForAll", (ws, message) => {
    exactKeys(message, ["type", "requestId", "tabId", "cli", "model", "expectedAssignmentsDigest", "confirmReplace"]);
    const requestId = requiredRequestId(message.requestId);
    runAsyncAction(ws, "setCrewModelForAll", requestId, () => fixedCrewService.setModelForAll(message.tabId, message.cli, message.model, message.expectedAssignmentsDigest, message.confirmReplace));
  }]);
  handlers.push(["getCrewRolePrompt", (ws, message) => {
    exactKeys(message, ["type", "requestId", "slot"]);
    const requestId = requiredRequestId(message.requestId);
    ws.send(JSON.stringify({ type: "crewRolePrompt", requestId, ...getCrewRolePrompt(message.slot) }));
  }]);
  handlers.push(["previewCrewAssignments", (ws, message) => {
    exactKeys(message, ["type", "requestId", "draftId", "choices", "autoAssign"]);
    const requestId = requiredRequestId(message.requestId);
    if (typeof message.draftId !== "string" || !message.draftId || message.draftId.length > 128) throw new Error("draftId is required");
    const fixedCrew = fixedCrewService.preview(message.choices, message.autoAssign);
    ws.send(JSON.stringify({ type: "crewAssignmentsPreview", requestId, draftId: message.draftId, fixedCrew }));
  }]);
  return handlers;
}
