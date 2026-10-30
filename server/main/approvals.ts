import { randomUUID } from "node:crypto";
import { isRunning } from "../runner.ts";
import { broadcast, stateMessage } from "./broadcast.ts";
import { noteRunActivity } from "./crew-tools.ts";
import { settleLeaderTurnWaiters } from "./leader-turn.ts";
import { approvalSettledListeners, leaderInstances, pendingApprovals, runContexts, type Origin } from "./state.ts";
import { leaderSeatOf, tabLocation } from "./tabs.ts";

// The tab's leader seat name, as the page shows it ("The leader" only if the tab has no leader seat).
export function leaderNameOf(tabId: string): string {
  const location = tabLocation(tabId);
  return (location && leaderSeatOf(location.tab))?.name?.trim() || "The leader";
}
// Who is asking, as the page shows it.
export function askerOf(tabId: string, origin: Origin): { kind: "leader" | "seat"; slot: string; name: string } {
  const location = tabLocation(tabId);
  if (origin.kind === "seat") return { kind: "seat", slot: origin.slot, name: location?.tab.crew.find((member) => member.slot === origin.slot)?.name ?? origin.slot };
  return { kind: "leader", slot: (location && leaderSeatOf(location.tab))?.slot ?? "leader", name: leaderNameOf(tabId) };
}
export function approvalWaitMessage(tabId: string, leaderOnly = false): string {
  const first = [...pendingApprovals.values()].find((item) => item.tabId === tabId && (!leaderOnly || item.origin.kind === "leader"));
  return `${first ? askerOf(tabId, first.origin).name : leaderNameOf(tabId)} is waiting for your answer on a change`;
}
// Any approval blocks Save; only the leader's blocks chatting with the leader (a planner's waits on its own).
export function hasPendingApproval(tabId: string, leaderOnly = false): boolean {
  return [...pendingApprovals.values()].some((item) => item.tabId === tabId && (!leaderOnly || item.origin.kind === "leader"));
}
export function denyLeaderApprovals(tabId: string, instance?: object): void {
  for (const item of [...pendingApprovals.values()]) if (item.tabId === tabId && item.origin.kind === "leader" && (!instance || item.origin.instance === instance)) item.settle(false);
}
// A run that ended, or was stopped, has nobody left to answer for: what it was waiting on is refused.
export function denyRunApprovals(runId: string): void {
  for (const item of [...pendingApprovals.values()]) if (item.origin.kind === "seat" && item.origin.runId === runId) item.settle(false);
}
const APPROVAL_SUMMARY_MAX = 20000;
// Allow approves the whole operation, so the text names all of it, as a plain terminal would show the diff.
function changeApprovalText(tool: string, input: Record<string, unknown>): string | undefined {
  const text = (value: unknown) => typeof value === "string" ? value : undefined;
  const path = text(input.file_path) ?? text(input.notebook_path);
  const replacing = (old: unknown, next: unknown, all: unknown) => `${all === true ? "Replaces every match\n" : ""}Replace:\n${String(old)}\n\nWith:\n${String(next)}`;
  if (tool === "Write" && path && text(input.content) !== undefined) return `${path}\n\nNew content:\n${input.content}`;
  if (tool === "Edit" && path && text(input.old_string) !== undefined && text(input.new_string) !== undefined) return `${path}\n\n${replacing(input.old_string, input.new_string, input.replace_all)}`;
  if (tool === "MultiEdit" && path && Array.isArray(input.edits) && input.edits.length) {
    const edits = input.edits.map((edit: any, index: number) => `Edit ${index + 1} of ${input.edits.length}:\n${replacing(edit?.old_string, edit?.new_string, edit?.replace_all)}`);
    return `${path}\n\n${edits.join("\n\n")}`;
  }
  if (tool === "NotebookEdit" && path && text(input.new_source) !== undefined) {
    const lines = [path, "", ...(text(input.cell_id) ? [`Cell: ${input.cell_id}`] : []), ...(text(input.cell_type) ? [`Cell type: ${input.cell_type}`] : []), `Edit mode: ${text(input.edit_mode) ?? "replace"}`, "", "New source:", String(input.new_source)];
    return lines.join("\n");
  }
  // OpenCode: the file, every pattern it asked about, then the diff.
  if (tool === "Edit" && path && (Array.isArray(input.patterns) || text(input.diff) !== undefined)) {
    const patterns = Array.isArray(input.patterns) ? input.patterns.map(String).filter((pattern) => pattern !== path) : [];
    return [path, ...patterns, ...(text(input.diff) !== undefined ? ["", String(input.diff)] : [])].join("\n");
  }
  if ((tool === "Bash" || tool === "PowerShell") && text(input.command) !== undefined) {
    const why = text(input.description) ?? text(input.reason);
    return `${input.command}${text(input.cwd) ? `\n\nRuns in: ${input.cwd}` : ""}${why ? `\n\n${text(input.description) ? "Description" : "Reason"}: ${why}` : ""}`;
  }
  return undefined;
}
// The user answers on what this shows, so it is the whole text (line breaks kept), never a first line or a clipped tail.
function approvalSummary(input: Record<string, unknown>, tool = ""): string {
  // A multi-file change lists every path first, one per line, then the change text.
  const pathList = Array.isArray(input.paths) && input.paths.length ? input.paths.map(String) : [];
  const extra = typeof input.grantRoot === "string" && input.grantRoot ? `
Also asks for write access to: ${input.grantRoot.slice(0, 500)}` : "";
  const room = APPROVAL_SUMMARY_MAX - extra.length;
  let paths = pathList.join("\n");
  if (pathList.length && paths.length > room) {
    // Never hide a path silently: keep whole paths while they fit (leaving room for the notice), then say how many are not shown.
    const notice = (n: number, chars: number) => `\n... and ${n} more files not shown (${chars} characters)`;
    const reserve = notice(pathList.length, paths.length).length;
    let used = 0, shown = 0;
    while (shown < pathList.length && used + pathList[shown].length + 1 <= room - reserve) used += pathList[shown++].length + 1;
    const hidden = pathList.slice(shown);
    return `${pathList.slice(0, shown).join("\n")}${notice(hidden.length, hidden.join("\n").length)}${extra}`;
  }
  const raw = paths ? (typeof input.changes === "string" && input.changes ? `${paths}\n\n${input.changes}` : paths) : changeApprovalText(tool, input) ?? input.file_path ?? input.notebook_path ?? input.command ?? JSON.stringify(input);
  const main = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (main.length <= room) return main + extra;
  return `${main.slice(0, room)}${extra}
... (${main.length - room} more characters not shown)`;
}
export function askLeaderApproval(tabId: string, instance: object, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
  return askApproval(tabId, { kind: "leader", instance }, tool, input, signal);
}
export function askApproval(tabId: string, origin: Origin, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || !tabLocation(tabId) || !originAnswerable(tabId, origin)) return Promise.resolve(false);
  return new Promise((resolveApproval) => {
    const approvalId = randomUUID();
    const summary = approvalSummary(input, tool);
    const abort = () => settle(false);
    const settle = (allow: boolean) => {
      if (!pendingApprovals.delete(approvalId)) return;
      if (origin.kind === "seat") noteRunActivity(tabId, origin.runId);
      for (const reset of approvalSettledListeners.get(tabId) ?? []) reset();
      signal?.removeEventListener("abort", abort);
      resolveApproval(allow);
      broadcast(stateMessage());
    };
    pendingApprovals.set(approvalId, { approvalId, tabId, origin, tool, summary, createdAt: Date.now(), settle });
    signal?.addEventListener("abort", abort, { once: true });
    settleLeaderTurnWaiters(tabId);
    broadcast(stateMessage());
  });
}
// The asker can still be answered: the leader instance is the tab's current one, or the seat's run is still going.
export function originAnswerable(tabId: string, origin: Origin): boolean {
  return origin.kind === "seat" ? isRunning(origin.runId) && runContexts.get(origin.runId)?.tabId === tabId : leaderInstances.get(tabId) === origin.instance;
}
