import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { keepBadCopy, writeFileSynced, replaceFile } from "../safe-file.ts";
import { PERMISSION_MODES } from "./constants.ts";
import type { CliInventory, PermissionMode, PersistedSettings, SettingsState } from "./types.ts";

const EMPTY_SETTINGS: PersistedSettings = { notesVaultPath: null, defaultProjectFolder: "", permissionModes: {} };

function freshInventory(): CliInventory {
  return { instructionFiles: [], skills: [], mcpServers: [], plugins: [] };
}

export function freshState(saved: PersistedSettings): SettingsState {
  return {
    tools: {
      claude: { installed: null, version: null, signedIn: null },
      codex: { installed: null, version: null, signedIn: null },
      opencode: { installed: null, version: null, signedIn: null },
      gemini: { installed: null, version: null, signedIn: null },
    },
    github: { connected: null, account: null },
    vault: { path: saved.notesVaultPath },
    folders: { defaultProjectFolder: saved.defaultProjectFolder },
    skills: { claude: freshInventory(), codex: freshInventory(), opencode: freshInventory(), gemini: freshInventory() },
    permissionModes: { ...saved.permissionModes },
    permissionActions: {},
    uploads: {},
  };
}

// A settings file that is empty, unparsable or malformed starts the app on defaults; the bad file is kept first,
// so the next save never overwrites it blind. Its tabs' saved modes are lost, so none of them may fall back to auto-accepting edits.
export function readPersisted(path: string): { settings: PersistedSettings; recovered: boolean } {
  try { return { settings: parsePersisted(path), recovered: false }; }
  catch (error) {
    if (!(error instanceof BadSettingsFile)) throw error;
    keepBadCopy(path);
    return { settings: { ...EMPTY_SETTINGS, permissionModes: {}, askUntilChosen: true }, recovered: true };
  }
}

class BadSettingsFile extends Error {}

function parsePersisted(path: string): PersistedSettings {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_SETTINGS, permissionModes: {} };
    throw new BadSettingsFile(`settings file is unreadable: ${path}`);
  }
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
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSynced(temporary, `${JSON.stringify(value, null, 2)}\n`);
    replaceFile(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* the atomic rename already consumed it */ }
  }
}
