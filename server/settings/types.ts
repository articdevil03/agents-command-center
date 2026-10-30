export type CliId = "claude" | "codex" | "opencode" | "gemini";
export type CliResult = { code: number; stdout: string; stderr: string };
// env: extra variables for the child. verbatimArgs: Windows hands the args to the child exactly as written (the caller quotes them for cmd).
export type RunCli = (bin: string, args: string[], options: { timeoutMs: number; env?: Record<string, string>; verbatimArgs?: boolean }) => Promise<CliResult>;
export type PermissionMode = "ask" | "accept" | "plan" | "bypass";
export type ActionStatus = "running" | "done" | "failed";
export type ActionState = { requestId: string; status: ActionStatus; message: string };

export type InstalledTool = { installed: boolean | null; version: string | null; signedIn: boolean | null; action?: ActionState };
export type InstructionFile = { path: string; scope: "global" | "project" };
export type McpItem = { name: string; detail?: string };
export type CliInventory = {
  instructionFiles: InstructionFile[];
  skills: string[];
  mcpServers: McpItem[];
  plugins: string[];
  action?: ActionState;
  inventoryError?: string;
};
export type SettingsState = {
  tools: Record<CliId, InstalledTool>;
  github: { connected: boolean | null; account: string | null; action?: ActionState };
  vault: { path: string | null };
  folders: { defaultProjectFolder: string };
  skills: Record<CliId, CliInventory>;
  permissionModes: Record<string, PermissionMode>;
  permissionActions: Record<string, ActionState>;
  preferenceAction?: ActionState;
  uploads: Record<string, ActionState>;
};

export type PersistedSettings = {
  notesVaultPath: string | null;
  defaultProjectFolder: string;
  permissionModes: Record<string, PermissionMode>;
  // Set when a damaged file was recovered: a tab with no saved mode asks before changing files until the owner picks a mode for it.
  askUntilChosen?: boolean;
};

export type SettingsServiceOptions = {
  dataRoot: string;
  env?: NodeJS.ProcessEnv;
  runCli?: RunCli;
  onChange?: () => void;
  permissionTimeoutMs?: number;
  // How often the sign-in status is read again after a login window opened (default 3 s, for up to 3 minutes).
  loginRecheckMs?: number;
};
