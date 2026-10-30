import { fakeCliOnPath, importWithTempDataRoot } from "./temp-root.ts";

fakeCliOnPath();

// The server modules that read their data root at import (config.ts and everything importing it) are loaded on a fresh temp folder, never on
// the repo's own (live) config/. Every path the tests hand them is explicit and inside their own temp roots.
export const { dataDir: moduleDataDir, modules: { config, createCrewSetup, leaderApi, createCodexLeader, createOpencodeLeader, createAcpLeader, createLeaderBridge, buildLeaderToolSpecs } } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"),
  createCrewSetup: (await import("../server/crew-setup.ts")).createCrewSetup,
  leaderApi: await import("../server/leader.ts"),
  createCodexLeader: (await import("../server/leader-codex.ts")).createCodexLeader,
  createOpencodeLeader: (await import("../server/leader-opencode.ts")).createOpencodeLeader,
  createAcpLeader: (await import("../server/leader-acp.ts")).createAcpLeader,
  createLeaderBridge: (await import("../server/leader-bridge.ts")).createLeaderBridge,
  buildLeaderToolSpecs: (await import("../server/leader-tools.ts")).buildLeaderToolSpecs,
}));
