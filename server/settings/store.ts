import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { preserveBadFile, readFileWithRetry, writeFileSynced, replaceFile } from "../safe-file.ts";
import { PERMISSION_MODES } from "./constants.ts";
import { keyProfile } from "./cli-key-profiles.ts";
import { CLI_CATALOG } from "./cli-catalog.ts";
import { initialVaultStatus } from "./vault.ts";
import type { CliInventory, PermissionMode, PersistedSettings, SettingsState } from "./types.ts";

const EMPTY_SETTINGS: PersistedSettings = { notesVaultPath: null, defaultProjectFolder: "", permissionModes: {} };

function freshInventory(): CliInventory {
  return { instructionFiles: [], skills: [], mcpServers: [], plugins: [] };
}

export function freshState(saved: PersistedSettings, vaultStatus: typeof initialVaultStatus = initialVaultStatus): SettingsState {
  return {
    catalogTools: Object.fromEntries(CLI_CATALOG.map(({ id, leader }) => [id, { keyProfile: keyProfile(id), keySaved: false, installed: null, version: null, signedIn: null,
      registered: false, leaderEligible: false, tested: leader.qualified === true, leaderLabel: leader.qualified === true ? "Tested" as const : "Not tested yet" as const, connection: "unknown" as const }])),
    tools: {
      claude: { installed: null, version: null, signedIn: null },
      codex: { installed: null, version: null, signedIn: null },
      opencode: { installed: null, version: null, signedIn: null },
      gemini: { installed: null, version: null, signedIn: null },
    },
    github: { connected: null, account: null },
    vault: { path: saved.notesVaultPath, status: vaultStatus(saved.notesVaultPath) },
    folders: { defaultProjectFolder: saved.defaultProjectFolder },
    skills: { claude: freshInventory(), codex: freshInventory(), opencode: freshInventory(), gemini: freshInventory() },
    permissionModes: { ...saved.permissionModes },
    permissionActions: {},
    uploads: {},
  };
}

// A settings file that is empty, unparsable or malformed starts the app on defaults; the bad file is kept first,
// so the next save never overwrites it blind. Its tabs' saved modes are lost, so none of them may fall back to auto-accepting edits.
const blockedPaths = new Set<string>();
export function readPersisted(path: string): { settings: PersistedSettings; recovered: boolean; notice?: string } {
  let bytes: Buffer;
  try { bytes = readFileWithRetry(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      blockedPaths.delete(path);
      return { settings: { ...EMPTY_SETTINGS, permissionModes: {} }, recovered: false };
    }
    return recoverSettings(path, false);
  }
  try {
    const settings = parsePersisted(bytes.toString("utf8"));
    blockedPaths.delete(path);
    return { settings, recovered: false };
  } catch { return recoverSettings(path, true); }
}

function recoverSettings(path: string, invalid: boolean) {
  const preserved = preserveBadFile(path).ok;
  if (!invalid || !preserved) blockedPaths.add(path); else blockedPaths.delete(path);
  const notice = `Your settings ${invalid ? "file is damaged" : "could not be read"}. Every tab now asks before changing files. `
    + (preserved ? "A copy of the original was kept. " : "The original could not be copied and has been left untouched. ")
    + (blockedPaths.has(path) ? "Settings cannot be saved until the original can be read safely or preserved. Try restarting the app." : "You can choose your settings again.");
  return { settings: { ...EMPTY_SETTINGS, permissionModes: {}, askUntilChosen: true }, recovered: true, notice };
}

class BadSettingsFile extends Error {}

function parsePersisted(contents: string): PersistedSettings {
  const value: unknown = JSON.parse(contents);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadSettingsFile("settings file is malformed");
  const raw = value as Record<string, unknown>;
  if ((raw.notesVaultPath !== null && raw.notesVaultPath !== undefined && typeof raw.notesVaultPath !== "string")
    || (raw.defaultProjectFolder !== undefined && typeof raw.defaultProjectFolder !== "string")
    || (raw.askUntilChosen !== undefined && typeof raw.askUntilChosen !== "boolean")
    || (raw.permissionModes !== undefined && (!raw.permissionModes || typeof raw.permissionModes !== "object" || Array.isArray(raw.permissionModes)))) {
    throw new BadSettingsFile("settings file is malformed");
  }
  const modes: Record<string, PermissionMode> = {};
  for (const [tabId, mode] of Object.entries((raw.permissionModes ?? {}) as Record<string, unknown>)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tabId) || !PERMISSION_MODES.has(mode as PermissionMode)) throw new BadSettingsFile("settings file has an invalid permission mode");
    modes[tabId] = mode as PermissionMode;
  }
  return {
    notesVaultPath: (raw.notesVaultPath as string | null | undefined) ?? null,
    defaultProjectFolder: (raw.defaultProjectFolder as string | undefined) ?? "",
    permissionModes: modes,
    ...(raw.askUntilChosen === true ? { askUntilChosen: true } : {}),
  };
}

export function persist(path: string, value: PersistedSettings): void {
  if (blockedPaths.has(path)) throw new Error("Settings cannot be saved because the original file could not be read or safely preserved. Try restarting the app.");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSynced(temporary, `${JSON.stringify(value, null, 2)}\n`);
    replaceFile(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* the atomic rename already consumed it */ }
  }
}
