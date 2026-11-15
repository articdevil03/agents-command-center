import type { MessageHandler } from "./messages/types.ts";
import { resolveCliOrThrow } from "../leader-common.ts";
import { writeAcpClis } from "../config-acp.ts";
import { registerCatalogConnection, validateCatalogRequest } from "../settings/catalog-acp.ts";
import { acpClis, setAcpClis, settingsService, workspaces } from "./state.ts";
import { broadcast, stateMessage } from "./broadcast.ts";
import { requiredRequestId, runAsyncAction } from "./workspace.ts";

export function catalogMessages(): Array<[string, MessageHandler]> {
  return [["registerCatalogCli", (ws, message) => {
    const requestId = requiredRequestId(message.requestId);
    validateCatalogRequest(message);
    runAsyncAction(ws, message.type, requestId, () => {
      const result = registerCatalogConnection(message, {
        clis: () => acpClis, resolve: (program) => resolveCliOrThrow(program, process.env,
          [process.cwd(), ...workspaces.projects.flatMap((project) => [project.folder, ...project.tabs.map((tab) => tab.folder)])]), write: writeAcpClis,
        publish: (next) => { setAcpClis(next); broadcast(stateMessage()); },
      });
      Object.assign(settingsService.state.catalogTools[message.cli], { installed: true, registered: true });
      return result;
    }, { cli: message.cli });
  }]];
}
