import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { resolveDataRoot } from "../server/data-root.ts";
import * as processEngine from "../server/process.ts";
import { freshFixedCrew } from "../server/fixed-crew/preferences.ts";
import type { Assignment, FixedSlot } from "../server/fixed-crew/roster.ts";
import type { WorkspaceProject, WorkspaceTab, Workspaces } from "../server/config.ts";

// Pure builders for saved fixed-crew workspaces. Nothing here imports config.ts at run time, so a test that only needs
// the shape of a saved file never loads (or seeds) a data root. Every call returns new objects, so a test may edit one tab freely.
export type FixedChoices = Partial<Record<FixedSlot, Assignment>>;

// Compatibility fields stay empty and lookPause false: a fixed tab has no legacy crew or steps.
export function fixedTab(id: string, folder: string, choices: FixedChoices = {}, name = "Development"): WorkspaceTab {
  const fixedCrew = freshFixedCrew();
  for (const [slot, assignment] of Object.entries(choices) as Array<[FixedSlot, Assignment]>) {
    fixedCrew.preferences[slot] = { assignment: { ...assignment }, source: "user" };
  }
  return { id, name, kind: "dev", folder, setupName: "Fixed crew", crew: [], lookPause: false, steps: [], fixedCrew };
}

export function fixedProject(id: string, folder: string, tabs: WorkspaceTab[] = [fixedTab(`${id}-development`, folder)]): WorkspaceProject {
  return { id, name: id[0].toUpperCase() + id.slice(1), folder, tabs };
}

export function fixedWorkspaces(projects: WorkspaceProject[] = [fixedProject("alpha", "C:/work/alpha")]): Workspaces {
  return { projects };
}

// config.ts and the modules it publishes through, evaluated in ONE context so a test can override a file-system boundary
// (writeFileSync, renameSync, linkSync ...) and reach the real write. The fixed-crew modules come first: config.ts seeds at load.
const SOURCES = ["safe-file", "config-files", "config-acp", "config-prefs",
  "fixed-crew/roster", "fixed-crew/assignment", "fixed-crew/recovery-backup", "fixed-crew/recovery", "fixed-crew/preferences", "config"];

export function launchConfig(copy: string, data: string, overrides = {}): any {
  const source = SOURCES.map((name) => stripTypeScriptTypes(fs.readFileSync(`server/${name}.ts`, "utf8"))
    .replace(/^(?:import .*|export (?:\{[^}]*\}|\*) from .*);\r?$/gm, "").replaceAll("import.meta.url", '"unused"').replaceAll("export ", "")).join("\n");
  return runInNewContext(`${source}; ({ workspacesPath, projectsPath, writeClientPrefs, readClientPrefs, workspaceRecovery })`, {
    ...fs, ...path, ...overrides, resolveDataRoot, ...processEngine, createHash, randomUUID, Buffer, console: { error() {}, log() {} },
    fileURLToPath: () => path.join(copy, "server/config.ts"),
    process: { env: { CC_DATA_DIR: data } },
  });
}
