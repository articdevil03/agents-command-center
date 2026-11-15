import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataRoot, liveFilesProtected, publishConfigFile, workspacesPath } from "../config-files.ts";
import { workspaceRecovery } from "../fixed-crew/recovery.ts";
import type { WorkspaceProject, Workspaces } from "../config.ts";

export const firstRunPath = join(dataRoot, "config", "first-run.json");
type Marker = { version: 1; status: "pending" | "complete"; createdAt: string };
export function firstRunMarker(): Marker | null {
  try {
    const raw = JSON.parse(readFileSync(firstRunPath, "utf8"));
    if (raw?.version !== 1 || !["pending", "complete"].includes(raw.status)
      || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) return null;
    return raw;
  } catch { return null; } // Unreadable and future markers never re-onboard an existing user.
}
export function firstRunRequired(workspace: Workspaces): boolean {
  return firstRunMarker()?.status === "pending" && !workspaceRecovery().blocked && !workspaceHasRealProject(workspace);
}
export function finishFirstRun(): void {
  const marker = firstRunMarker();
  if (marker?.status !== "pending") throw new Error("setup is already finished");
  publishConfigFile(JSON.stringify({ ...marker, status: "complete" }) + "\n", firstRunPath, true);
}
function hasContents(path: string): boolean {
  try {
    const info = lstatSync(path);
    return !info.isDirectory() || info.isSymbolicLink() || readdirSync(path).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true; // An unreadable path cannot prove a pristine root.
  }
}
function hasPriorAppData(): boolean {
  const paths = ["config/projects.json", "config/setups.json", "config/launch-safety.json", "config/workspaces.json",
    "config/client-prefs.json", "config/own-sessions.json", "config/acp-clis.json", "config/fixed-crew-recovery.json",
    "settings.json", "requests.json", "chats", "tasks", "executions", "avatars", "backups"];
  return paths.some((path) => existsSync(join(dataRoot, path)))
    || hasContents(join(dataRoot, "logs")) || hasContents(join(dataRoot, "example-project"));
}
export function isSeededExample(project: WorkspaceProject): boolean {
  const folder = resolve(dataRoot, "example-project");
  return project.id === "example" && project.tabs.length === 1 && project.tabs[0].id === "example-development"
    && resolve(project.folder) === folder && resolve(project.tabs[0].folder) === folder;
}
export function exampleHasFiles(): boolean { return hasContents(join(dataRoot, "example-project")); }
export function workspaceHasRealProject(workspace: Workspaces): boolean {
  return Array.isArray(workspace.projects) && workspace.projects.some((project) => !isSeededExample(project));
}

// Called before seeding. Empty logs are startup scaffolding; any log entry is prior history.
// Recovery must still run on pristine roots to enforce its data-root link guard.
export function initializeFirstRun(recover: () => void): void {
  if (liveFilesProtected()) return;
  const pristine = !hasPriorAppData();
  recover();
  const recovery = workspaceRecovery();
  if (recovery.blocked || recovery.recovered) return;
  if (!existsSync(firstRunPath) && pristine) {
    publishConfigFile(JSON.stringify({ version: 1, status: "pending", createdAt: new Date().toISOString() }) + "\n", firstRunPath);
  }
  if (firstRunMarker()?.status !== "pending" || !existsSync(workspacesPath)) return;
  try {
    const saved = JSON.parse(readFileSync(workspacesPath, "utf8"));
    if (workspaceHasRealProject(saved)) finishFirstRun();
  } catch { /* Damaged workspaces are handled by config/recovery, never repaired here. */ }
}
