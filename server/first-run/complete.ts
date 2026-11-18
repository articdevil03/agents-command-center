import { existsSync } from "node:fs";
import { assertCatalogLeaderEligible } from "../settings/catalog-acp.ts";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { dataRoot } from "../config-files.ts";
import { isAcpKind, acpKindOf, validateAcpCli } from "../config.ts";
import { isTabSlug } from "../chat-store.ts";
import { autoFillPreferences } from "../fixed-crew/assignment.ts";
import { assertWorkspaceRecoveryReady } from "../fixed-crew/recovery.ts";
import { fixedCatalogue } from "../main/fixed-crew.ts";
import { createProject } from "../main/messages/projects.ts";
import { resolveCliOrThrow } from "../leader-common.ts";
import { acpClis, chatStore, settingsService, workspaces } from "../main/state.ts";
import { tabHasActiveWork, validateFolderPath } from "../main/workspace.ts";
import { exampleHasFiles, finishFirstRun, firstRunMarker, isSeededExample, workspaceHasRealProject } from "./state.ts";

export function assertFirstRunPending(): void {
  assertWorkspaceRecoveryReady("first-run");
  if (firstRunMarker()?.status !== "pending" || workspaceHasRealProject(workspaces)) throw new Error("setup is already finished");
}
function exampleUntouched(project: typeof workspaces.projects[number]): boolean {
  if (!isSeededExample(project) || exampleHasFiles() || tabHasActiveWork("example-development")) return false;
  // Even an unreadable/empty transcript or task record is history worth keeping.
  if ([join(chatStore.directory, "example-development.jsonl"), ...["tasks", "executions"].map((dir) => join(dataRoot, dir, "example-development.json"))].some(existsSync)) return false;
  try { return chatStore.snapshotOrEmpty("example-development").messages.length === 0; }
  catch { return false; }
}
// The tool is named the way the wizard shows it (an added tool by its own name), never by its internal id such as "acp:qwen".
export function notReadyMessage(cli: string, registered?: { name: string }): string { return `${registered?.name ?? cli} is not ready: no supported leader model`; }
export function completeFirstRun(ws: WebSocket, message: any): void {
  assertFirstRunPending();
  const cli = message.cli;
  const acp = isAcpKind(cli);
  const registered = acp ? acpClis.find((item) => acpKindOf(item) === cli) : undefined;
  if (acp && !registered) throw new Error(`unknown leader CLI: ${String(cli).slice(0, 40)}`);
  if (registered) assertCatalogLeaderEligible(registered, settingsService.state);
  if (!acp) {
    if (typeof cli !== "string" || !Object.hasOwn(settingsService.state.tools, cli)) throw new Error(`unknown leader CLI: ${String(cli).slice(0, 40)}`);
    const tool = settingsService.state.tools[cli as keyof typeof settingsService.state.tools];
    if (tool.installed !== true || tool.signedIn !== true) {
      throw new Error(`${cli} is not ready: ${tool.installed !== true ? tool.installed === false ? "not installed" : "installation status unknown" : tool.signedIn === false ? "not signed in" : "sign-in status unknown"}`);
    }
  }
  if (typeof message.name !== "string" || !message.name.trim() || message.name.trim().length > 100
    || /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B\uFEFF]/u.test(message.name)) throw new Error("project name is required and must be at most 100 characters without control or invisible formatting characters");
  const name = message.name.trim();
  if (!/[\p{L}\p{N}]/u.test(name)) throw new Error("project name must contain a letter or number");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  if (!isTabSlug(slug)) throw new Error(`invalid or duplicate project id: ${slug}`);
  let id = slug;
  for (let suffix = 2; workspaces.projects.some((project) => project.id.toLowerCase() === id); suffix++) id = `${slug}-${suffix}`;
  const folder = validateFolderPath(message.folder, "project folder");
  if (acp) {
    const checked = validateAcpCli(registered);
    resolveCliOrThrow(checked.program, process.env, [process.cwd(), folder]);
    if (message.acpConsent !== true) throw new Error(`Choose Full access to use ${checked.name}: it can edit files and run commands without asking.`);
  }
  const catalogue = fixedCatalogue();
  const leader = autoFillPreferences({}, { ...catalogue, clis: catalogue.clis.filter((item) => item.id === cli) }, true).leader.assignment;
  if (!leader || leader.cli !== cli) throw new Error(notReadyMessage(cli, registered));
  createProject(ws, { type: "addProject", requestId: message.requestId, id, name, folder,
    fixedCrewVersion: 1, crewChoices: { leader }, autoAssign: true, projectOnly: message.projectOnly }, {
    prepareDraft(draft) { draft.projects = draft.projects.filter((project) => !exampleUntouched(project)); },
    afterSave: finishFirstRun,
  });
}
