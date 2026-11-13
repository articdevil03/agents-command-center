import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { tempRoot } from "./temp-root.ts";
import { round2FixedTab } from "./round2-fixed-deps.ts";

export function fixtureTab(id: string, name: string, folder: string) {
  return round2FixedTab(id, folder, name);
}

// The "fixed" argument older callers pass is accepted and ignored: every fixture tab is a fixed-crew tab.
export function fixtureWorkspaces(_mode?: "fixed") {
  return { projects: [
    { id: "alpha", name: "Alpha", folder: "C:/work/alpha", tabs: [
      fixtureTab("alpha-dev", "Development", "C:/work/alpha"),
      fixtureTab("alpha-design", "Design", "C:/work/alpha/design"),
      fixtureTab("alpha-marketing", "Marketing", "C:/work/alpha/marketing"),
    ] },
    { id: "beta", name: "Beta", folder: "C:/work/beta", tabs: [
      fixtureTab("beta-dev", "Development", "C:/work/beta"),
    ] },
  ] };
}

export function tempWorkspaceFolders(_mode?: "fixed") {
  const root = tempRoot();
  const workspaces = fixtureWorkspaces();
  for (const project of workspaces.projects) for (const tab of project.tabs) {
    tab.folder = path.join(root, tab.id);
    mkdirSync(tab.folder, { recursive: true });
  }
  return workspaces;
}

