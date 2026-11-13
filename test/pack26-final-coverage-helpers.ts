import { join } from "node:path";
import { importWithTempDataRoot } from "./temp-root.ts";

// The real server modules on an isolated data root, set up only as far as stopLeaderSession needs: the tab list, the chat log and no clients.
export async function loadStopSession() {
  const { dataDir, modules } = await importWithTempDataRoot(async () => ({
    config: await import("../server/config.ts"),
    state: await import("../server/main/state.ts"),
    session: await import("../server/main/leader-session.ts"),
    ChatStore: (await import("../server/chat-store.ts")).ChatStore,
  }));
  const { config, state, session, ChatStore } = modules;
  const workspaces = config.defaultWorkspaces(dataDir);
  state.setWorkspaces(workspaces);
  state.setSelectedTabId(workspaces.projects[0].tabs[0].id);
  state.setChatStore(new ChatStore(join(dataDir, "chats")));
  state.clients.clear();
  state.setFolderActivity({ beginOwn: () => 0, endOwn: () => {}, watchFolders() {} } as unknown as Parameters<typeof state.setFolderActivity>[0]);
  return { state, stopLeaderSession: session.stopLeaderSession, tabId: workspaces.projects[0].tabs[0].id as string };
}
