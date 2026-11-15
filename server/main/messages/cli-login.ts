import { WebSocket } from "ws";
import { validateLoginRequest } from "../../settings/cli-login.ts";
import { settingsService } from "../state.ts";
import { requiredRequestId, runAsyncAction } from "../workspace.ts";
import type { MessageHandler } from "./types.ts";
export function cliLoginMessages(): Array<[string, MessageHandler]> {
  const handler: MessageHandler = (ws, message: any) => {
    const requestId = requiredRequestId(message.requestId);
    try { validateLoginRequest(message); } catch (error) { delete message.apiKey; throw error; }
    // Never echo request data. CliLogin consumes the key synchronously.
    runAsyncAction(ws, message.type, requestId, () => {
      try {
        return settingsService.cliLogin(message, (event) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
        });
      } finally { delete message.apiKey; }
    });
  };
  return ["cliLogin", "replaceCliLogin", "submitCliLoginKey", "getCliLoginState", "openCliLogin", "submitCliLoginCode", "cancelCliLogin"].map((type) => [type, handler]);
}
