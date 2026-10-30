
import { loadServer, connect, lastState, tick, waitFor } from "./round2-helpers.ts";

export async function launchGateServer(mode: "ask" | "plan" | "accept" | "bypass") {
  const server = await loadServer({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create leader" });
  await tick();
  if (mode !== "accept") {
    ws.message({ type: "setPermissionMode", requestId: `launch_gate_${mode}`, tabId: "alpha-dev", mode });
    await waitFor(() => server.settingsService.permissionMode("alpha-dev") === mode, `${mode} saved`);
  }
  return { server, ws, deps: server.leaderDeps.get("Development") };
}

export const pendingFor = (server: any) => [...server.pendingApprovals.values()];

export const tabState = (ws: any, tabId: string) => lastState(ws).projects.flatMap((project: any) => project.tabs).find((tab: any) => tab.id === tabId);
