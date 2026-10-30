import type { PermissionMode } from "../settings.ts";
import type { AskApproval, LeaderSpawn } from "../leader-common.ts";

export type OpencodeLeaderDeps = {
  bridge: { url: string; token: string };
  mode: PermissionMode;
  ask: AskApproval;
  savedAsks?: () => boolean;
  spawnFn?: LeaderSpawn;
  startTimeoutMs?: number;
  // Tests only: a fixed port for a fake server. Otherwise OpenCode binds a port itself and says which (no probe-then-reuse race for another process to win).
  pickPort?: () => Promise<number>;
};
