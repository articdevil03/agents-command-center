import type { WebSocket } from "ws";
import { writeProjectRules } from "../../project-rules.ts";
import { isTabSlug } from "../../chat-store.ts";
import { broadcast, stateMessage } from "../broadcast.ts";
import { stopLeaderSession } from "../leader-session.ts";
import type { MessageHandler } from "./types.ts";
import { crewSetup } from "../seats.ts";
import { chatStore, requestsStore, selectedTabId, setSelectedTabId, settingsService, tabs, workspaces } from "../state.ts";
import { tabLocation } from "../tabs.ts";
import {
  makeTabId, refreshTabDetails, requiredRequestId, runAsyncAction, saveWorkspaceDraft, syncWorkspace, tabHasActiveWork, validateFolderPath,
} from "../workspace.ts";

function onSendRequest(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  runAsyncAction(ws, message.type, requestId, () => {
    if (message.fromTabId !== selectedTabId) throw new Error("source tab must be the selected tab");
    const request = requestsStore.send({ fromTabId: message.fromTabId, toTabId: message.toTabId, title: message.title, body: message.body }, (tabId) => tabLocation(tabId) !== null);
    return { id: request.id, status: request.status, fromTabId: request.fromTabId, toTabId: request.toTabId };
  });
  return;
}
function onResolveRequest(ws: WebSocket, message: any): void {
  const requestId = requiredRequestId(message.requestId);
  runAsyncAction(ws, message.type, requestId, () => {
    // The request's own destination tab answers it, whichever tab is open: Needs you lists requests for every tab.
    if (typeof message.tabId !== "string") throw new Error("tabId is required: the tab the request was sent to");
    const request = requestsStore.resolve(message.id, message.status, message.tabId, (tabId) => tabLocation(tabId) !== null);
    return { id: request.id, status: request.status, toTabId: request.toTabId };
  });
  return;
}
function onAddProject(ws: WebSocket, message: any): void {
  const id = message.id;
  if (!isTabSlug(id) || workspaces.projects.some((project) => project.id.toLowerCase() === id.toLowerCase())) throw new Error(`invalid or duplicate project id: ${String(id)}`);
  const folder = validateFolderPath(typeof message.folder === "string" && message.folder.trim() ? message.folder.trim() : settingsService.state.folders.defaultProjectFolder, "project folder");
  if (typeof message.name !== "string" || !message.name.trim()) throw new Error("project name is required");
  const template = crewSetup.pickTemplate(message);
  const kind = message.kind ?? template.kind;
  const tabId = makeTabId(message.tabId, `${id}-development`);
  const tabFolder = validateFolderPath(message.tabFolder ?? folder, "tab folder");
  const tab = crewSetup.newTab(tabId, "Development", kind, tabFolder, template);
  const draft = saveWorkspaceDraft();
  draft.projects.push({ id, name: message.name.trim(), folder, tabs: [tab] });
  syncWorkspace(draft); setSelectedTabId(tabId); broadcast(stateMessage()); void refreshTabDetails(tabId);
  // After the save: a rules file that cannot be written is reported, never a reason to undo the project.
  if (message.projectOnly === true) ws.send(JSON.stringify({ type: "projectRules", tabId, ...writeProjectRules(tabFolder, message.name.trim()) }));
  return;
}
function onRenameProject(ws: WebSocket, message: any): void {
  const draft = saveWorkspaceDraft();
  const project = draft.projects.find((item) => item.id === message.projectId);
  if (!project || typeof message.name !== "string" || !message.name.trim()) throw new Error("invalid project or name");
  project.name = message.name.trim(); syncWorkspace(draft); broadcast(stateMessage()); return;
}
function onRemoveProject(ws: WebSocket, message: any): void {
  const project = workspaces.projects.find((item) => item.id === message.projectId);
  if (!project) throw new Error(`unknown project: ${String(message.projectId)}`);
  if (workspaces.projects.length <= 1) throw new Error("cannot remove the last project");
  if (project.tabs.some((tab) => tabHasActiveWork(tab.id, true))) throw new Error("cannot remove a busy project");
  const draft = saveWorkspaceDraft(); draft.projects = draft.projects.filter((item) => item.id !== message.projectId); syncWorkspace(draft); broadcast(stateMessage()); return;
}
function onAddTab(ws: WebSocket, message: any): void {
  const projectId = message.projectId;
  const template = crewSetup.pickTemplate(message);
  const kind = message.kind ?? template.kind;
  const tabId = makeTabId(message.tabId, `${projectId}-tab`);
  const project = workspaces.projects.find((item) => item.id === projectId);
  if (!project) throw new Error(`unknown project: ${String(projectId)}`);
  const folder = validateFolderPath(typeof message.folder === "string" ? message.folder : project.folder || settingsService.state.folders.defaultProjectFolder, "tab folder");
  const tab = crewSetup.newTab(tabId, typeof message.name === "string" && message.name.trim() ? message.name.trim() : template.name, kind, folder, template);
  const draft = saveWorkspaceDraft(); draft.projects.find((item) => item.id === projectId)!.tabs.push(tab); syncWorkspace(draft); setSelectedTabId(tabId); broadcast(stateMessage()); void refreshTabDetails(tabId);
  if (message.projectOnly === true) ws.send(JSON.stringify({ type: "projectRules", tabId, ...writeProjectRules(folder, project.name) }));
  return;
}
function onRenameTab(ws: WebSocket, message: any): void {
  const draft = saveWorkspaceDraft();
  const tab = draft.projects.flatMap((project) => project.tabs).find((item) => item.id === message.tabId);
  if (!tab || typeof message.name !== "string" || !message.name.trim()) throw new Error("invalid tab or name");
  tab.name = message.name.trim(); syncWorkspace(draft); broadcast(stateMessage()); return;
}
function onRemoveTab(ws: WebSocket, message: any): void {
  const location = tabLocation(message.tabId);
  if (!location) throw new Error(`unknown tab: ${String(message.tabId)}`);
  if (location.project.tabs.length <= 1) throw new Error("cannot remove the last tab in a project");
  if (tabHasActiveWork(message.tabId, true)) throw new Error("cannot remove a busy tab");
  const removedSelectedTab = selectedTabId === message.tabId;
  // The leader stops inside syncWorkspace, after the write holds: a failed write must leave the tab and its leader alone.
  const draft = saveWorkspaceDraft();
  draft.projects.find((project) => project.id === location.project.id)!.tabs = location.project.tabs.filter((tab) => tab.id !== message.tabId);
  syncWorkspace(draft);
  if (removedSelectedTab && selectedTabId) ws.send(JSON.stringify({ type: "chatHistory", tabId: selectedTabId, ...chatStore.snapshotOrEmpty(selectedTabId) }));
  broadcast(stateMessage()); return;
}
function onChangeFolder(ws: WebSocket, message: any): void {
  // Deliberately no "Work on this project only" rules file here: changing a folder later is not part of that feature (owner, 2026-10-17).
  const folder = validateFolderPath(message.folder, "tab folder");
  const location = tabLocation(message.tabId); if (!location) throw new Error(`unknown tab: ${String(message.tabId)}`);
  if (tabHasActiveWork(message.tabId)) throw new Error("cannot change the folder while the tab is busy");
  // The new folder's leader starts on the tab's next chat message, so its project hooks never run unasked.
  stopLeaderSession(message.tabId);
  const draft = saveWorkspaceDraft();
  draft.projects.find((project) => project.id === location.project.id)!.tabs.find((tab) => tab.id === message.tabId)!.folder = folder;
  syncWorkspace(draft);
  const runtime = tabs.get(message.tabId)!; runtime.state.folderPath = folder;
  broadcast(stateMessage()); void refreshTabDetails(message.tabId); return;
}
function onChangeProjectFolder(ws: WebSocket, message: any): void {
  // Deliberately no "Work on this project only" rules file here: changing a folder later is not part of that feature (owner, 2026-10-17).
  const folder = validateFolderPath(message.folder, "project folder");
  if (!workspaces.projects.some((item) => item.id === message.projectId)) throw new Error("unknown project: " + String(message.projectId));
  const draft = saveWorkspaceDraft();
  draft.projects.find((item) => item.id === message.projectId)!.folder = folder;
  syncWorkspace(draft); broadcast(stateMessage()); return;
}
export function projectMessages(): Array<[string, MessageHandler]> {
  return [
    ["sendRequest", onSendRequest],
    ["resolveRequest", onResolveRequest],
    ["addProject", onAddProject],
    ["renameProject", onRenameProject],
    ["removeProject", onRemoveProject],
    ["addTab", onAddTab],
    ["renameTab", onRenameTab],
    ["removeTab", onRemoveTab],
    ["changeFolder", onChangeFolder],
    ["changeProjectFolder", onChangeProjectFolder],
  ];
}
