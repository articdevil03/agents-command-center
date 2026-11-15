import { exactKeys } from "../fixed-crew/preferences.ts";
import { broadcast, stateMessage } from "../main/broadcast.ts";
import type { MessageHandler } from "../main/messages/types.ts";
import { requiredRequestId } from "../main/workspace.ts";
import { assertFirstRunPending, completeFirstRun } from "./complete.ts";
import { finishFirstRun } from "./state.ts";

export function firstRunMessages(): Array<[string, MessageHandler]> {
  return [
    ["completeFirstRun", (ws, message) => {
      exactKeys(message, ["type", "requestId", "name", "folder", "cli", "projectOnly", "acpConsent"]);
      const requestId = requiredRequestId(message.requestId);
      if (message.projectOnly !== undefined && typeof message.projectOnly !== "boolean") throw new Error("projectOnly must be true or false");
      if (message.acpConsent !== undefined && typeof message.acpConsent !== "boolean") throw new Error("acpConsent must be true or false");
      completeFirstRun(ws, message);
      ws.send(JSON.stringify({ type: "actionResult", action: message.type, requestId }));
    }],
    ["skipFirstRun", (ws, message) => {
      exactKeys(message, ["type", "requestId"]);
      const requestId = requiredRequestId(message.requestId);
      assertFirstRunPending(); finishFirstRun(); broadcast(stateMessage());
      ws.send(JSON.stringify({ type: "actionResult", action: message.type, requestId }));
    }],
  ];
}
