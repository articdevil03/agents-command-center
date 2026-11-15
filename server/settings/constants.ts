import type { CliId, PermissionMode } from "./types.ts";

export const CLI_IDS: CliId[] = ["claude", "codex", "opencode", "gemini"];
export const AUTH_ARGS: Partial<Record<CliId, string[]>> = {
  claude: ["auth", "status"],
  codex: ["login", "status"],
  opencode: ["auth", "list"],
};
export const CLI_TIMEOUT_MS = 8_000;
export const ACTION_TIMEOUT_MS = 180_000;
export const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@/-]{0,127}$/;
export const PERMISSION_MODES = new Set<PermissionMode>(["ask", "accept", "plan", "bypass"]);
