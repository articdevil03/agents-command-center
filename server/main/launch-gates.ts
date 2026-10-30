import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { CrewMember } from "../config.ts";
import { isRunning } from "../runner.ts";
import { USER_DENIED } from "../leader-common.ts";
import type { LaunchResult } from "../leader-tools.ts";
import { chatMessageEvent, isSafeRequestId } from "../chat-store.ts";
import { relatedFolders, type Outside } from "../folder-activity.ts";
import { launchMayWrite } from "../process.ts";
import { askApproval, leaderNameOf, originAnswerable } from "./approvals.ts";
import { broadcast, stateMessage } from "./broadcast.ts";
import { WAIT_POLL_MS, hideTokens, orchestratorOf } from "./crew-tools.ts";
import { endRunRecord, launchWorker, trimRunRecords } from "./launch.ts";
import { sendLeaderTurn } from "./leader-turn.ts";
import {
  activeLeaderTurns, chatStore, describeError, folderActivity, leaders, runContexts, runRecords, userKilledRuns, type Launcher, type Origin,
} from "./state.ts";
import { crewDefinition, effectiveMode, leaderSeatOf, tabLocation } from "./tabs.ts";

// Per tab, within the window: a planner that runs the process starts several seats, and no other tab uses this tab's launches up.
export const LEADER_LAUNCH_LIMIT = 8;
export const LAUNCH_WINDOW_MS = 5 * 60 * 1000;
export const MAX_LAUNCH_NOTICES = 50;
export const NOTICE_BRIEF_MAX = 4000;
function leaderLaunch(tabId: string, slot: string, prompt: string): LaunchResult {
  return launchWorker(tabId, slot, prompt, "leader", false, undefined, announceFolderBusy(tabId));
}
// A seat that runs the process starts another seat: the notice and the run name the launching seat.
function seatLaunch(tabId: string, launcher: Launcher, slot: string, prompt: string): LaunchResult {
  return launchWorker(tabId, slot, prompt, "seat", false, undefined, announceFolderBusy(tabId), launcher);
}
// Another agent working in this folder: the person decides when they are at the keyboard (their message or Run is held until they answer);
// a leader-started run has nobody to ask, so it launches and says so once per outside session per 10 minutes.
export function folderBusyMessage(tabId: string, action: "chat" | "run", requestId: string | undefined, items: Outside[]): Record<string, unknown> {
  const now = Date.now();
  return { type: "folderBusy", action, tabId, ...(requestId ? { requestId } : {}), items: items.map((item) => { const agoMs = now - item.lastActiveAt; return { tool: item.tool, agoSeconds: Math.max(0, Math.round(agoMs / 1000)), ...(item.writer ? { writer: item.writer } : {}) }; }) };
}
// Another tab writing in a related folder: a writing seat or a leader doing the build. Reviewers and the asking tab never count.
function otherTabWriters(tabId: string, folder: string): Outside[] {
  const writers: Outside[] = [], now = Date.now();
  for (const context of runContexts.values()) {
    if (context.tabId === tabId || !context.run.canWrite || !relatedFolders(folder, context.run.folder)) continue;
    const other = tabLocation(context.tabId), roleLabel = other && crewDefinition(other.tab, context.slot)?.role;
    if (other && roleLabel) writers.push({ tool: null, sessionKey: context.run.runId, lastActiveAt: now, writer: { seatName: context.run.name, roleLabel, tabName: other.tab.name } });
  }
  for (const otherId of activeLeaderTurns) {
    const other = otherId === tabId ? null : tabLocation(otherId);
    // With no steps or with the leader owning Build, the leader writes the code itself.
    if (!other || !relatedFolders(folder, other.tab.folder)) continue;
    const leaderSeat = leaderSeatOf(other.tab);
    if (other.tab.steps.length && !other.tab.steps.some((step) => step.id === "build" && step.type === "work" && step.owners.includes(leaderSeat?.slot ?? ""))) continue;
    writers.push({ tool: null, sessionKey: `${otherId}:turn`, lastActiveAt: now, writer: { seatName: leaderNameOf(otherId), roleLabel: leaderSeat?.role ?? "Leader", tabName: other.tab.name } });
  }
  return writers;
}
export const pendingFor = (tabId: string, folder: string): Outside[] => folderActivity.pending(tabId, folder, otherTabWriters(tabId, folder));
export function refuseIfFolderBusy(ws: WebSocket, message: any, action: "chat" | "run", folder: string): boolean {
  if (message.confirmBusy === true) folderActivity.snoozeShown(message.tabId);
  const busy = pendingFor(message.tabId, folder);
  if (!busy.length) return false;
  folderActivity.remember(message.tabId, busy);
  ws.send(JSON.stringify(folderBusyMessage(message.tabId, action, isSafeRequestId(message.requestId) ? message.requestId : undefined, busy)));
  return true;
}
// Returns the heads-up text so the launch notice can keep it; "" when there is nothing to say. It is also a quiet line in the tab's chat (saved with it, never told to the leader); no pop-up, the line says it.
function announceFolderBusy(tabId: string): string {
  try {
    const folder = tabLocation(tabId)?.tab.folder;
    const fresh = folder ? folderActivity.toAnnounce(tabId, folder, otherTabWriters(tabId, folder)) : [];
    if (!fresh.length) return "";
    const what = fresh.map((item) => item.writer ? `${item.writer.seatName} (${item.writer.roleLabel}) in your ${item.writer.tabName} tab is writing code in this folder right now`
      : item.tool ? `${"AEIOU".includes(item.tool[0]) ? "an" : "a"} ${item.tool} session outside Command Center is active in this folder` : "something outside Command Center changed files in this folder");
    const message = `Heads up: ${what.join("; ")}.`;
    try { broadcast(chatMessageEvent(chatStore.appendMessage(tabId, "notice", message))); } catch { /* an unreadable chat still launches, and the Activity notice keeps the text */ }
    return what.join("; ");
  } catch { return ""; /* a notice that cannot be made never stops the launch */ }
}
const LEADER_JOB_PREFIX = "leader-job-";
// Leader jobs queued behind a reply, by job run id.
const waitingLeaderJobs = new Map<string, { tabId: string; plannerRunId: string; plannerName: string }>();
// Ends the waiting jobs that match (only those still working) as stopped, at once, with the outcome text the job gives.
export function endWaitingLeaderJobs(matches: (job: { tabId: string; plannerRunId: string }) => boolean, outcome: (job: { plannerName: string }) => string): void {
  for (const [runId, job] of waitingLeaderJobs) { if (matches(job) && runRecords.get(runId)?.status === "working") endRunRecord(runId, "stopped", undefined, outcome(job)); }
}
// Every user stop of a run: remembered as a user kill, and a leader job still waiting on that run (a Planner's) is cancelled now, not when a poll notices.
export function markUserKilled(runId: string): void {
  userKilledRuns.add(runId);
  endWaitingLeaderJobs((job) => job.plannerRunId === runId, (job) => `${job.plannerName} (Planner) was stopped before the leader took the job`);
}
// The run id of this tab's leader job that has not ended (queued or replying), if any.
export function workingLeaderJob(tabId: string): string | undefined {
  return [...runRecords].find(([, record]) => record.tabId === tabId && record.reply !== undefined && record.status === "working")?.[0];
}
// The refusal for a second job (or a step move) while the leader still has one: one text for the leader tool and the planner's step tools.
export const leaderJobBusyMessage = (tabId: string, runId: string): string => `${leaderNameOf(tabId)} is still working on the job you handed it (run ${runId}); wait_for_runs, then try again`;
// A step with no seat of its own is the leader's. The seat that runs the process hands it over as one job: the brief becomes one turn of the leader's chat, and the leader's reply is
// the report back (wait_for_runs on the returned run id). No process is started, so it is not in the launch budget.
function handToLeader(tabId: string, origin: { runId: string; slot: string }, leaderSlot: string, brief: string): LaunchResult {
  if (typeof brief !== "string" || !brief.trim()) return { ok: false, error: "run prompt is required" };
  const working = workingLeaderJob(tabId);
  if (working) return { ok: false, error: leaderJobBusyMessage(tabId, working) };
  const runId = `${LEADER_JOB_PREFIX}${randomUUID()}`;
  runRecords.set(runId, { tabId, seatKey: `${tabId}.${leaderSlot}`, status: "working", outcome: null, logPath: null, reply: "" });
  trimRunRecords();
  const plannerName = tabLocation(tabId)?.tab.crew.find((member) => member.slot === origin.slot)?.name ?? origin.slot;
  void runLeaderJob(tabId, runId, origin.runId, plannerName, hideTokens(brief));
  return { ok: true, runId };
}
// Waits for the leader to be free (never a second turn), then runs the job as the next turn. A job queued behind a reply is cancelled if its planner's run or the tab ends first.
async function runLeaderJob(tabId: string, runId: string, plannerRunId: string, plannerName: string, brief: string): Promise<void> {
  waitingLeaderJobs.set(runId, { tabId, plannerRunId, plannerName });
  try {
    for (;;) {
      if (runRecords.get(runId)?.status !== "working") return;
      if (!tabLocation(tabId)) return endRunRecord(runId, "stopped", undefined, "the tab is gone before the leader was free");
      if (!isRunning(plannerRunId)) return endRunRecord(runId, "stopped", undefined, `${plannerName}'s run ended before the leader was free`);
      if (!activeLeaderTurns.has(tabId)) break;
      await new Promise<void>((done) => setTimeout(done, WAIT_POLL_MS));
    }
  } finally { waitingLeaderJobs.delete(runId); }
  announceFolderBusy(tabId);
  const leaderName = leaderNameOf(tabId);
  const shown = brief.length > NOTICE_BRIEF_MAX ? `${brief.slice(0, NOTICE_BRIEF_MAX)}...` : brief;
  // The notice carries the whole brief; the fresh leader's chat context tells it from there, so this turn's own message must not repeat it (currentRevision).
  let noticeRevision: number | undefined;
  try {
    const notice = chatStore.appendJobNotice(tabId, `${plannerName} handed ${leaderName} a job:
${shown}`, { from: `${plannerName} (Planner)`, brief });
    noticeRevision = notice.revision;
    broadcast(chatMessageEvent(notice));
  } catch { /* an unreadable chat still runs the job */ }
  const text = `${plannerName} (Planner), who runs this tab's process, hands you a job. Do it yourself now; ${plannerName} is waiting for your reply, which is your report back to it, so end with what you did and what is left.

The job:
${brief}`;
  const record = runRecords.get(runId);
  const onReply = (said: string): void => { if (record) record.reply = said; };
  try {
    const turn = sendLeaderTurn(tabId, text, [], [], noticeRevision, onReply);
    broadcast(stateMessage()); // the page shows the leader replying from the first moment
    const ok = await turn;
    if (ok) endRunRecord(runId, "done"); else endRunRecord(runId, "failed", undefined, "the leader's reply failed or was stopped");
  } catch (err) { endRunRecord(runId, "failed", undefined, describeError(err)); }
}
// The ask/plan promise covers a seat that writes files too, not only the leader's own Edit/Write/Bash: launch_seat is pre-allowed for the leader, so the gate lives here, where the launch really happens.
// The asker is the tab's live leader or a seat's run (a planner that runs the process): the mode, the approval and the checks are the same, only who is asking differs.
export async function gatedLeaderLaunch(tabId: string, instance: object, slot: string, brief: string): Promise<LaunchResult> {
  return gatedLaunch(tabId, { kind: "leader", instance }, slot, brief);
}
export async function gatedLaunch(tabId: string, origin: Origin, slot: string, brief: string): Promise<LaunchResult> {
  const location = tabLocation(tabId);
  const member = location?.tab.crew.find((seat) => seat.slot === slot);
  const definition = location && crewDefinition(location.tab, slot);
  // What the seat was when this launch was decided: the seat can change while the user is asked.
  const was = member ? { cli: member.cli, canWrite: member.canWrite } : undefined;
  // Only the leader's own live mode (Claude's, which can differ from the saved one) is read, and only when the leader is the one asking.
  const currentLeader = origin.kind === "leader" ? leaders.get(tabId) : undefined;
  const asking = (): boolean => origin.kind === "seat" ? originAnswerable(tabId, origin) : Boolean(currentLeader && !currentLeader.isDead() && leaders.get(tabId) === currentLeader && originAnswerable(tabId, origin));
  if (!location || !asking()) return { ok: false, error: origin.kind === "seat" ? "the seat that asked has ended; launch cancelled" : "the tab or leader is no longer current; launch cancelled" };
  // A seat never launches itself (it would run twice on one brief). Where another seat runs the process, the leader only talks to it.
  if (origin.kind === "seat" && origin.slot === slot) return { ok: false, error: "a seat cannot launch itself" };
  // A step the leader owns goes to the leader as a job in its chat; there is no worker to start, so no write gate (the leader's own tools are gated by its own mode).
  if (origin.kind === "seat" && definition?.isLeader) return handToLeader(tabId, origin, slot, brief);
  const boss = orchestratorOf(location.tab);
  if (origin.kind === "leader" && boss && boss.slot !== slot) return { ok: false, error: `${boss.name} runs the process in this tab, so the leader can only launch ${boss.name}` };
  // A seat gates when it can write, or when its CLI cannot enforce read-only (Codex: its read-only sandbox is not a boundary, a read-only run wrote a file here; a CLI added in Settings: nothing is enforced).
  // Claude read-only uses enforced --disallowedTools and OpenCode an enforced deny config.
  const mayWrite = (cli: CrewMember["cli"] | undefined, canWrite: boolean | undefined) => cli !== undefined && launchMayWrite(cli, canWrite);
  const planNow = (): boolean => effectiveMode(tabId) === "plan" || currentLeader?.getPermissionMode() === "plan";
  if (member && definition && !definition.isLeader && mayWrite(member.cli, definition.canWrite)) {
    if (planNow()) return { ok: false, error: "this tab is in Plan mode, which changes nothing; switch the permission mode to launch a seat that can write files" };
    if (effectiveMode(tabId) === "ask" || currentLeader?.getPermissionMode() === "default") {
      const allow = await askApproval(tabId, origin, `launch:${member.name}`, { command: `${member.name} (${definition.role})
${brief}` });
      if (!allow) return { ok: false, error: USER_DENIED };
    }
  }
  const latest = tabLocation(tabId);
  if (!latest || !asking()) return { ok: false, error: origin.kind === "seat" ? "the seat that asked ended while approving; launch cancelled" : "the tab or leader changed while approving; launch cancelled" };
  const latestDefinition = crewDefinition(latest.tab, slot);
  const latestMember = latest.tab.crew.find((seat) => seat.slot === slot);
  if (!latestDefinition || latestDefinition.isLeader || latestMember?.cli !== was?.cli || latestDefinition.canWrite !== was?.canWrite) return { ok: false, error: "the seat capability changed while approving; launch cancelled" };
  if (mayWrite(latestMember.cli, latestDefinition.canWrite) && planNow()) return { ok: false, error: "this tab is now in Plan mode; launch cancelled" };
  return origin.kind === "leader" ? leaderLaunch(tabId, slot, brief) : seatLaunch(tabId, { slot: origin.slot, runId: origin.runId }, slot, brief);
}
