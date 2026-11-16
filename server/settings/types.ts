import type { OpenCodeModelInfo, ModelRefreshState } from "./opencode/models.ts";
import type { LoginReason, LoginPhase } from "./cli-login.ts";
import type { RunLogin } from "./cli-login-runner.ts";
export type CliId = "claude" | "codex" | "opencode" | "gemini";
export type CliResult = { code: number; stdout: string; stderr: string; cleanupConfirmed?: boolean; cancelled?: boolean; retryCleanup?: () => Promise<boolean> };
// env: extra variables for the child. verbatimArgs: Windows hands the args to the child exactly as written (the caller quotes them for cmd).
export type RunCli = (bin: string, args: string[], options: { timeoutMs: number; env?: Record<string, string>; verbatimArgs?: boolean; directExecutable?: boolean; cwd?: string; installer?: { signal: AbortSignal } }) => Promise<CliResult>;
export type CredentialSource = "stored" | "environment" | "none" | "unknown";
// Injection is a function boundary, never a user-configurable address or path.
export type InstallTransport = (url: string, options: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> }) => Promise<Response>;
export type OpenCodeInstallOptions = { transport?: InstallTransport; arch?: string; phase?: (message: string) => void };
export type InstallTransaction = { result: CliResult; candidate?: string; commit?: () => Promise<void>; rollback?: () => Promise<void> };
export type KeyRunOptions = { env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number; apiKey: string; replace: boolean; onWriteAttempt?: () => void };
export type KeyRunResult = { saved: boolean; cleanupConfirmed: boolean; persisted?: boolean; retryCleanup?: () => Promise<boolean> };
export type RunKey = (options: KeyRunOptions) => Promise<KeyRunResult>;
export type PermissionMode = "ask" | "accept" | "plan" | "bypass";
export type ActionStatus = "running" | "done" | "failed";
export type InstallReason = "needsNode" | "needsGit" | "needsWinget" | "needsPowerShell" | "downloadFailed" | "blockedByWindows" | "notFoundAfterInstall" | "cancelled" | "cleanupUnconfirmed" | "timeout" | "installFailed";
export type ActionState = { requestId: string; status: ActionStatus; message: string; kind?: "install" | "login" | "remove"; phase?: "checking" | "installing" | "verifying" | "cancelling" | LoginPhase; reason?: InstallReason | LoginReason | null };

export type InstalledTool = { managedInstall?: boolean; installed: boolean | null; version: string | null; signedIn: boolean | null; supportedVersion?: boolean | null; credentialSource?: CredentialSource; action?: ActionState };
export type CatalogToolFacts = InstalledTool & {
  keyProfile?: { fields: import("./cli-key-profiles.ts").KeyField[] } | null; keySaved?: boolean;
  registered: boolean; leaderEligible: boolean; tested: boolean; leaderLabel: "Tested" | "Not tested yet"; connection: "unknown" | "verified" | "failed";
};
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
  catalogTools: Record<string, CatalogToolFacts>;
  tools: Record<CliId, InstalledTool>;
  github: { connected: boolean | null; account: string | null; action?: ActionState };
  vault: { path: string | null; status?: import("./vault.ts").VaultStatus };
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
  credentialStore?: import("./cli-key-store.ts").CredentialStore;
  dataRoot: string;
  env?: NodeJS.ProcessEnv;
  runCli?: RunCli;
  installOptions?: OpenCodeInstallOptions;
  runKey?: RunKey;
  onOpenCodeModels?: (models: OpenCodeModelInfo[] | null, state: Partial<ModelRefreshState>) => void;
  onChange?: () => void;
  permissionTimeoutMs?: number;
  // How often the sign-in status is read again after a login window opened (default 3 s, for up to 3 minutes).
  loginRecheckMs?: number;
  refreshPath?: () => Promise<unknown>;
  installAdmission?: () => boolean;
  runLogin?: RunLogin;
  loginTimeoutMs?: number;
  openLogin?: (cli: string, url: string) => Promise<boolean>;
};
