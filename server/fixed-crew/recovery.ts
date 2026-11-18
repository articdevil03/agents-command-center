import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataRoot, liveFilesProtected, publishConfigFile } from "../config-files.ts";
import { backupInventory, copyBackup, hashBytes, noLinks, saveRecoveryRecord, verifyBackup, type BackupEntry } from "./recovery-backup.ts";
import type { Workspaces } from "../config.ts";
import { readFileWithRetry } from "../safe-file.ts";

type RecoveryRecord = { version: 1; status: "prepared" | "complete"; archive: string; entries: BackupEntry[]; freshBytes: string };
export type RecoveryState = { blocked: boolean; recovered: boolean; notice?: string; archive?: string };
let state: RecoveryState = { blocked: false, recovered: false };
let launchSafetyHeld = false;
export function holdLaunchSafety(held = true): void { launchSafetyHeld = held; }
export function workspaceRecovery(): RecoveryState { return { ...state }; }
export function blockWorkspaceRecovery(notice = "Workspace unavailable. Your old files have been kept. Recovery could not safely finish. Check the data folder and restart Command Center."): void {
  state = { ...state, blocked: true, notice };
}
export function assertWorkspaceRecoveryReady(operation: string): void {
  if (state.blocked) throw new Error(`${state.notice} (${operation})`);
  if (launchSafetyHeld && operation !== "workspace") throw new Error("Launch safety is held because earlier process history could not be read. No process has been confirmed ended. Your saved tasks are available to inspect.");
}
export function restoreWorkspaceRecovery(previous: RecoveryState): void { state = { ...previous }; }
export function assertTaskRecoveryReady(): void { assertWorkspaceRecoveryReady("task-action"); }

// Presence is the discriminator. Damaged fixed preferences are handled by the
// fixed settings reader; future fixed formats must never become legacy data.
export function workspaceFormat(bytes: string | null): "missing" | "old" | "fixed" | "future-mixed" {
  if (bytes === null) return "missing";
  let raw: any;
  try { raw = JSON.parse(bytes); } catch { return "old"; }
  if (!raw || !Array.isArray(raw.projects)) return "old";
  let old = false, future = false;
  for (const project of raw.projects) {
    if (!project || !Array.isArray(project.tabs) || !project.tabs.length) { old = true; continue; }
    for (const tab of project.tabs) {
      if (!tab || typeof tab !== "object" || !Object.hasOwn(tab, "fixedCrew")) old = true;
      else if (tab.fixedCrew?.version > 1) future = true;
    }
  }
  return old ? future ? "future-mixed" : "old" : "fixed";
}
function optionalBytes(path: string, root: string): string | null {
  noLinks(path, root);
  try { return readFileWithRetry(path).toString("utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function freshId(root: string, entries: BackupEntry[], uuid: () => string): string {
  const sourceText = entries.filter((entry) => entry.sha256 && !entry.path.startsWith("avatars/"))
    .map((entry) => readFileSync(join(root, entry.path), "utf8")).join("\n");
  const histories = ["chats", "logs", "tasks", "executions"].flatMap((folder) => {
    const dir = join(root, folder); noLinks(dir, root);
    try { return readdirSync(dir).map((name) => name.toLowerCase()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = `fresh-${uuid()}`;
    if (!/^fresh-[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid recovery identity.");
    if (sourceText.toLowerCase().includes(id) || histories.some((name) => name.startsWith(`${id}.`) || name.startsWith(`${id}-`))) continue;
    return id;
  }
  throw new Error("Could not allocate a history-free workspace identity.");
}
function readRecord(path: string, root: string): RecoveryRecord | null {
  const bytes = optionalBytes(path, root);
  if (bytes === null) return null;
  const record = JSON.parse(bytes) as RecoveryRecord;
  if (record.version !== 1 || !["prepared", "complete"].includes(record.status)
    || !/^fixed-crew-v1-[0-9TZ-]+-[0-9a-f-]{36}$/.test(record.archive)
    || !Array.isArray(record.entries) || typeof record.freshBytes !== "string" || workspaceFormat(record.freshBytes) !== "fixed") throw new Error("Invalid recovery record.");
  for (const entry of record.entries) {
    if (!entry || !/^(?:config\/(?:workspaces|projects|setups|launch-safety)\.json|requests\.json|avatars\/[^/\\]+)$/.test(entry.path)
      || entry.path.includes("..") || !(entry.size === null && entry.sha256 === null || Number.isSafeInteger(entry.size) && entry.size! >= 0 && /^[0-9a-f]{64}$/.test(entry.sha256!))) throw new Error("Invalid recovery inventory.");
  }
  if (new Set(record.entries.map((entry) => entry.path)).size !== record.entries.length) throw new Error("Duplicate recovery entries.");
  return record;
}
function hasLogEntries(root: string): boolean {
  const logs = join(root, "logs");
  noLinks(logs, root);
  try { return readdirSync(logs).length > 0; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export function recoverWorkspace(root: string, defaults: (folder: string) => Workspaces, uuid: () => string = randomUUID): RecoveryState {
  const workspace = join(root, "config", "workspaces.json"), marker = join(root, "config", "fixed-crew-recovery.json");
  try {
    noLinks(root, root);
    for (const folder of ["config", "tasks", "executions", "backups"]) noLinks(join(root, folder), root);
    let record = readRecord(marker, root);
    if (record?.status === "complete") {
      if (workspaceFormat(optionalBytes(workspace, root)) !== "fixed") throw new Error("Completed workspace is missing or was replaced with legacy data.");
      return { blocked: false, recovered: true, archive: join(root, "backups", record.archive) };
    }
    const current = optionalBytes(workspace, root), format = workspaceFormat(current);
    const priorData = () => ["config/projects.json", "config/setups.json", "config/launch-safety.json", "requests.json", "chats", "tasks", "executions", "avatars"]
      .some((path) => existsSync(join(root, path))) || hasLogEntries(root);
    if (!record && (format === "fixed" || format === "missing" && !priorData())) return { blocked: false, recovered: false };
    if (!record) {
      const entries = backupInventory(root);
      const fresh = defaults(join(root, "example-project"));
      const id = freshId(root, entries, uuid);
      fresh.projects[0].id = `${id}-project`; fresh.projects[0].tabs[0].id = id;
      fresh.projects[0].folder = join(root, "example-project", id);
      fresh.projects[0].tabs[0].folder = fresh.projects[0].folder;
      const archive = `fixed-crew-v1-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      noLinks(join(root, "backups"), root);
      mkdirSync(join(root, "backups"), { recursive: true });
      mkdirSync(join(root, "backups", archive));
      record = { version: 1, status: "prepared", archive, entries, freshBytes: JSON.stringify(fresh, null, 2) + "\n" };
      saveRecoveryRecord(marker, record, root);
    }
    const archive = join(root, "backups", record.archive);
    noLinks(archive, root);
    // After publication, restart may only finish the journal, never recopy the
    // new workspace over its old backup or allocate another history identity.
    const published = current !== null && hashBytes(current) === hashBytes(record.freshBytes);
    if (!published) copyBackup(root, archive, record.entries, root);
    verifyBackup(archive, record.entries, root);
    saveRecoveryRecord(join(archive, "manifest.json"), record, root);
    const expected = record.entries.map((entry) => published && entry.path === "config/workspaces.json"
      ? { ...entry, size: Buffer.byteLength(record!.freshBytes), sha256: hashBytes(record!.freshBytes) } : entry);
    if (JSON.stringify(backupInventory(root)) !== JSON.stringify(expected)) throw new Error("Recovery source changed during preparation.");
    if (format === "future-mixed") throw new Error("A newer fixed workspace cannot be replaced.");
    if (!published) {
      const folder = JSON.parse(record.freshBytes).projects[0].folder;
      if (typeof folder !== "string" || folder !== join(root, "example-project", JSON.parse(record.freshBytes).projects[0].tabs[0].id)) throw new Error("Invalid fresh workspace folder.");
      noLinks(folder, root);
      mkdirSync(folder, { recursive: true });
      const freshBytes = record.freshBytes;
      publishConfigFile(freshBytes, workspace, true);
      if (optionalBytes(workspace, root) !== freshBytes) throw new Error("Fresh workspace publication failed.");
    }
    record.status = "complete";
    saveRecoveryRecord(marker, record, root);
    saveRecoveryRecord(join(archive, "manifest.json"), record, root);
    return { blocked: false, recovered: true, archive };
  } catch {
    return { blocked: true, recovered: false, notice: "Workspace unavailable. Your old files have been kept. Recovery could not safely finish. Check the data folder and restart Command Center." };
  }
}
export function initializeWorkspaceRecovery(defaults: (folder: string) => Workspaces): void {
  if (liveFilesProtected()) return;
  state = recoverWorkspace(dataRoot, defaults);
}
export function unavailableWorkspace(defaults: (folder: string) => Workspaces): Workspaces {
  const workspace = defaults(join(dataRoot, "example-project"));
  const id = `unavailable-${randomUUID()}`;
  workspace.projects[0].id = id;
  workspace.projects[0].tabs[0].id = id;
  workspace.projects[0].tabs[0].name = "Workspace unavailable";
  workspace.projects[0].tabs[0].fixedCrew = { version: 0 } as any;
  return workspace;
}
