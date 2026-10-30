import { randomUUID } from "node:crypto";
import type { WorkspaceTab, CrewMember } from "../config.ts";
import { isRunning } from "../runner.ts";
import {
  WAIT_MAX_RUNS, WAIT_MAX_SECONDS, type LeaderToolSeat, type LeaderToolSpec, type LeaderToolDeps, type StepResult, type StepOps, type ProcessView,
  type WaitedRun,
} from "../leader-tools.ts";
import { readTail } from "../history.ts";
import { advanceStep, reviewFindings, finishFix, reviewClean, getStepBar, getStepOwners, type ProcessState } from "../process.ts";
import { broadcast, stateMessage } from "./broadcast.ts";
import { gatedLaunch, leaderJobBusyMessage, workingLeaderJob } from "./launch-gates.ts";
import { bridgeTokens, describeError, leaderBridge, pendingRelaunch, requestsStore, runContexts, runRecords, stallTrackers, tabs } from "./state.ts";
import { clone, crewDefinition, leaderSeatOf, tabLocation } from "./tabs.ts";
import { rememberRequestAction } from "./workspace.ts";

function tabToolCrew(tabId: string): LeaderToolSeat[] {
  const location = tabLocation(tabId);
  if (!location) return [];
  return location.tab.crew.map((member) => ({ ...member, seatKey: `${tabId}.${member.slot}` }));
}
// The seat that runs the process on this tab, if any; with none, the leader runs it as before.
export function orchestratorOf(tab: WorkspaceTab): CrewMember | undefined {
  return tab.crew.find((member) => member.orchestrates === true && !crewDefinition(tab, member.slot)?.isLeader);
}
function processViewOf(tabId: string): ProcessView {
  const location = tabLocation(tabId), state = tabs.get(tabId)?.state;
  const step = state?.steps[state.currentStepIndex];
  const hasLook = Boolean(state?.steps.some((item) => item.type === "look"));
  const look = !hasLook ? "none" : state!.approval.state === "approved" ? "approved" : state!.approval.state === "pending" ? "waiting" : "not reached";
  return { stepId: step?.id ?? null, stepLabel: step?.label ?? null, stepType: step?.type ?? null, phase: state?.phase ?? "review", round: state?.round ?? 1, look, orchestrator: location ? orchestratorOf(location.tab)?.slot ?? null : null };
}
// What every caller's crew tools share: the crew, the steps, who is working, requests to other tabs.
export function baseToolDeps(tabId: string, tabName: string) {
  return {
    tabName,
    crew: () => tabToolCrew(tabId),
    steps: () => clone(tabLocation(tabId)?.tab.steps ?? []),
    processView: () => processViewOf(tabId),
    statusOf: (seatKey: string) => {
      if (runRecords.get(workingLeaderJob(tabId) ?? "")?.seatKey === seatKey) return "working";
      const active = [...runContexts.values()].filter((context) => context.run.seatKey === seatKey && isRunning(context.run.runId));
      return active.some((context) => tabs.get(tabId)?.stalledRuns.has(context.run.runId)) ? "stalled" : active.length ? "working" : "idle";
    },
    sendRequest: (toTabId: string, title: string, body: string) => {
      const requestId = randomUUID();
      rememberRequestAction(requestId, "running", "Working");
      broadcast(stateMessage());
      try {
        const request = requestsStore.send({ fromTabId: tabId, toTabId, title, body }, (id) => tabLocation(id) !== null);
        rememberRequestAction(requestId, "done", "Done");
        broadcast(stateMessage());
        return { ok: true as const, request, requestId };
      } catch (error) {
        const message = describeError(error);
        rememberRequestAction(requestId, "failed", message);
        broadcast(stateMessage());
        throw error;
      }
    },
    listRequests: () => requestsStore.incoming(tabId),
  };
}
// One bridge entry per key; its token is remembered so no run's output is ever shown back with a live token in it.
export function openBridge(key: string, specs: LeaderToolSpec[], onCall?: () => void): { token: string; revoke: () => void } {
  const bridge = leaderBridge.open(key, specs, onCall);
  bridgeTokens.set(key, bridge.token);
  return { token: bridge.token, revoke: () => { bridge.revoke(); if (bridgeTokens.get(key) === bridge.token) bridgeTokens.delete(key); } };
}
// Every call a seat's run makes on its bridge counts as output for its stall check (a planner that waits on others is working, not stalled).
export function noteRunActivity(tabId: string, runId: string): void {
  const wasStalled = tabs.get(tabId)?.stalledRuns.has(runId) ?? false;
  if (stallTrackers.noteOutput(runId, 1, Date.now(), wasStalled)) { tabs.get(tabId)?.stalledRuns.delete(runId); pendingRelaunch.delete(runId); }
}
export function hideTokens(text: string): string {
  let out = text;
  for (const token of bridgeTokens.values()) out = out.split(token).join("[hidden]");
  return out;
}
const WAIT_TAIL_BYTES = 8 * 1024;
export const WAIT_POLL_MS = 250;
// Waits until EVERY listed run has ended (or the time is up, or the asking seat itself ended), then reports each one.
async function waitForRuns(tabId: string, callerRunId: string, runIds: string[], maxWaitSeconds: number): Promise<WaitedRun[]> {
  const ids = [...new Set(runIds)].slice(0, WAIT_MAX_RUNS);
  for (const id of ids) if (runRecords.get(id)?.tabId !== tabId) throw new Error(`not a run of this tab: ${id}`);
  const deadline = Date.now() + Math.min(WAIT_MAX_SECONDS, Math.max(1, maxWaitSeconds)) * 1000;
  while (Date.now() < deadline && isRunning(callerRunId)) {
    noteRunActivity(tabId, callerRunId);
    if (ids.every((id) => runRecords.get(id)!.status !== "working")) break;
    await new Promise<void>((done) => setTimeout(done, WAIT_POLL_MS));
  }
  return Promise.all(ids.map(async (id): Promise<WaitedRun> => {
    const record = runRecords.get(id)!;
    let tail = "";
    if (record.reply !== undefined) tail = hideTokens(record.reply.slice(-WAIT_TAIL_BYTES));
    else if (record.logPath) { try { tail = hideTokens((await readTail(record.logPath, WAIT_TAIL_BYTES)).text); } catch { /* a log that is not there yet has no tail */ } }
    return { runId: id, seatKey: record.seatKey, status: record.status, outcome: record.outcome, logPath: record.logPath, tail };
  }));
}
// Why a step tool changed nothing, in plain words (the engine answers with an unchanged state, never a reason).
function whyStuck(state: ProcessState, what: "advance" | "findings" | "clean" | "fix", callerSlot: string): string {
  const step = state.steps[state.currentStepIndex];
  const nameOf = (slot: string) => state.seats.find((seat) => seat.slotId === slot)?.name ?? slot;
  const busy = (slots: readonly string[]) => slots.filter((slot) => slot !== "user" && slot !== callerSlot && state.runs.some((run) => run.seatSlotId === slot && run.status === "working")).map(nameOf);
  const working = (names: string[], where: string) => `${names.join(" and ")} still ${names.length === 1 ? "has a run" : "have runs"} working on ${where}; wait_for_runs, then try again`;
  if (what === "advance") {
    if (!step) return "there is no current step";
    if (step.type === "look") return "the current step is the user's look: only the user approves it";
    if (step.type === "rounds") return "the review step moves with report_round and finish_fix, not advance_step";
    if (state.currentStepIndex >= state.steps.length - 1) return "this is the last step";
    const names = busy(getStepOwners(state));
    return names.length ? working(names, step.label) : "the step did not move";
  }
  if (step?.type !== "rounds") return "the review rounds are not the current step";
  if (state.approval.state !== "approved") return "the user has not approved the look yet";
  const names = busy(getStepOwners(state));
  if (what === "fix") return state.phase !== "fix" ? `round ${state.round} is not in the fix phase` : names.length ? working(names, `round ${state.round}`) : "the fix could not finish (its seat is stopped or failed)";
  if (state.phase !== "review") return `round ${state.round} is in the fix phase: finish_fix comes first`;
  if (state.approval.reviewWaits) return "the round is waiting for earlier runs to finish";
  return names.length ? working(names, `round ${state.round}`) : "the round could not be reported (its reviewer is stopped or failed)";
}
// The step tools of the seat that runs the process: the same engine functions as the page's buttons, and the same guard (advanceStep refuses while an owner's run works).
function stepOpsFor(tabId: string, runId: string, callerSlot: string): StepOps {
  const move = (what: "advance" | "findings" | "clean" | "fix", op: (state: ProcessState) => ProcessState, early: (state: ProcessState) => string | null): StepResult => {
    const runtime = tabs.get(tabId), location = tabLocation(tabId);
    if (!runtime || !location) return { changed: false, reason: "this tab is gone", stepBar: [] };
    // Only the seat that runs the process, while its own run is going, moves the steps.
    if (!isRunning(runId) || orchestratorOf(location.tab)?.slot !== callerSlot) return { changed: false, reason: "only the seat that runs the process, while its run is going, can move the steps", stepBar: [...getStepBar(runtime.state)] };
    const before = runtime.state;
    const jobId = workingLeaderJob(tabId), leaderSlot = leaderSeatOf(location.tab)?.slot;
    if (jobId && leaderSlot && getStepOwners(before).includes(leaderSlot)) return { changed: false, reason: leaderJobBusyMessage(tabId, jobId), stepBar: [...getStepBar(runtime.state)] };
    const refusal = early(before);
    const after = refusal === null ? op(before) : before;
    const changed = refusal === null && JSON.stringify(after) !== JSON.stringify(before);
    if (changed) { runtime.state = after; broadcast(stateMessage()); }
    return { changed, ...(changed ? {} : { reason: refusal ?? whyStuck(before, what, callerSlot) }), stepBar: [...getStepBar(runtime.state)] };
  };
  const roundIs = (round: number) => (state: ProcessState): string | null => round === state.round ? null : `round ${round} is not the current round (it is round ${state.round})`;
  return {
    advance: (fromStepId) => move("advance", (state) => advanceStep(state, callerSlot), (state) => { const step = state.steps[state.currentStepIndex]; return !step ? whyStuck(state, "advance", callerSlot) : step.id === fromStepId ? null : `the current step is "${step.id}", not "${fromStepId}"`; }),
    reportRound: (round, outcome) => move(outcome, (state) => (outcome === "findings" ? reviewFindings : reviewClean)(state, callerSlot), roundIs(round)),
    finishFix: (round) => move("fix", finishFix, roundIs(round)),
  };
}
// The crew tools of a seat's run that runs the process: it launches other seats (through the same gate as the leader), waits for them and moves the steps.
export function runToolDeps(tabId: string, runId: string, slot: string): LeaderToolDeps {
  return {
    ...baseToolDeps(tabId, tabLocation(tabId)?.tab.name ?? tabId),
    callerSlot: slot,
    leaderTakesJobs: true,
    launch: (target, brief) => gatedLaunch(tabId, { kind: "seat", runId, slot }, target, brief),
    stepOps: stepOpsFor(tabId, runId, slot),
    waitForRuns: (runIds, maxWaitSeconds) => waitForRuns(tabId, runId, runIds, maxWaitSeconds),
  };
}
