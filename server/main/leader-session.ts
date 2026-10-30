import { writeAcpClis, acpKindOf } from "../config.ts";
import { KILL_TIMEOUT_MS, KILL_CONFIRM_MS, SWEEP_CAP_MS } from "../leader-common/types.ts";
import { createLeader } from "../leader.ts";
import { leaderKindOf, type LeaderCallbacks, type LeaderHandle } from "../leader-common.ts";
import { createAcpLeader } from "../leader-acp.ts";
import { createCodexLeader } from "../leader-codex.ts";
import { createOpencodeLeader } from "../leader-opencode.ts";
import { buildLeaderToolSpecs, createLeaderTools, LEADER_ALLOWED_TOOLS, type LeaderToolDeps } from "../leader-tools.ts";
import { addUsage, zeroUsage, bankUsage } from "../usage.ts";
import { endTurnWindow, openUnpromptedReply, setLeaderActivity } from "./activity.ts";
import { askLeaderApproval, denyLeaderApprovals } from "./approvals.ts";
import { broadcast, broadcastUsageState, stateMessage } from "./broadcast.ts";
import { baseToolDeps, openBridge, orchestratorOf } from "./crew-tools.ts";
import { endWaitingLeaderJobs, gatedLeaderLaunch } from "./launch-gates.ts";
import { finishLeaderTurn, handleMissedSteer, noteUnansweredSteer, settleLeaderTurnWaiters } from "./leader-turn.ts";
import {
  HOST, acpClis, acpSpawn, activeLeaderTurns, boundPort, chatStore, claudeCliPath, describeError, folderActivity, handoverReadTurns, lateSteers,
  leaderInstances, leaderJobs, leaderModels, leaderQuery, leaderSeats, leaderSpawn, leaderStartTimeoutMs, leaderTurnResolvers, leaderTurnTimeoutMs, leaderTurnText, leaderUsage,
  leaders, pendingHandoverReads, queuedLeaderChanges, setAcpClis, steeredTurns,
} from "./state.ts";
import { effectiveMode, leaderSeatOf, tabLocation } from "./tabs.ts";

// A leader that fails to start leaves nothing registered: no instance, no live seat settings, no bridge token.
export function createTabLeader(tabId: string): LeaderHandle {
  const revoke: { run: () => void } = { run: () => {} };
  try { return startTabLeader(tabId, revoke); }
  catch (err) {
    leaderInstances.delete(tabId); leaderSeats.delete(tabId); leaders.delete(tabId);
    revoke.run();
    throw err;
  }
}
// Leaders stopped on a tab whose process (or a descendant its tracker knows) was not yet seen to be gone. A new leader never starts beside one:
// it waits for the old one to finish exiting, and a kill or sweep that could not be confirmed blocks it until the old one is gone.
const retiredLeaders = new Map<string, Set<LeaderHandle>>();
// Allow the old leader its tree kill, kill confirmation, and exit sweep, plus scheduling time.
const RETIRED_LEADER_WAIT_MS = KILL_TIMEOUT_MS + KILL_CONFIRM_MS + SWEEP_CAP_MS + 5_000;
export function retiredLeaderState(tabId: string): "clear" | "pending" | "failed" {
  const retired = retiredLeaders.get(tabId);
  if (!retired) return "clear";
  let result: "clear" | "pending" | "failed" = "clear";
  for (const old of [...retired]) {
    const state = old.process?.();
    if (!state?.running) retired.delete(old);
    else if (state.killFailed) result = "failed";
    else if (result === "clear") result = "pending";
  }
  if (!retired.size) retiredLeaders.delete(tabId);
  return result;
}
function stuckLeaderError(tabId: string): string | null {
  const state = retiredLeaderState(tabId);
  if (state === "clear") return null;
  const cause = state === "failed" ? "could not be confirmed stopped" : `did not exit within ${RETIRED_LEADER_WAIT_MS / 1000} seconds`;
  return `The previous leader on this tab ${cause} and may still be running, so a new one will not start yet. Close it in Task Manager; the next message starts a new leader once it has exited.`;
}
// Resolves once no retired leader of the tab is left, one failed (its sweep is retried once first), or the wait ran out; startTabLeader then decides.
export async function waitForRetiredLeaders(tabId: string): Promise<void> {
  const until = Date.now() + RETIRED_LEADER_WAIT_MS;
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  let rechecked = false;
  for (;;) {
    let state = retiredLeaderState(tabId);
    if (state === "failed" && !rechecked) {
      rechecked = true;
      await Promise.race([Promise.all([...(retiredLeaders.get(tabId) ?? [])].map((old) => old.process?.().recheck?.().catch(() => {}))), sleep(Math.max(0, until - Date.now()))]);
      state = retiredLeaderState(tabId);
    }
    if (state !== "pending" || Date.now() >= until) return;
    await sleep(25);
  }
}
// Only sendLeaderTurn gets here, after it retired the tab's old leader and waited for it.
function startTabLeader(tabId: string, revokeOnFailure: { run: () => void }): LeaderHandle {
  const stuckError = stuckLeaderError(tabId);
  if (stuckError) throw new Error(stuckError);
  const instance = {};
  leaderInstances.set(tabId, instance);
  const location = tabLocation(tabId);
  if (!location) throw new Error(`unknown tab: ${tabId}`);
  const lead = leaderSeatOf(location.tab);
  if (!lead) throw new Error(`tab "${tabId}" has no leader slot`);
  const toolDeps: LeaderToolDeps = {
    ...baseToolDeps(tabId, location.tab.name),
    // Where another seat runs the process the leader only talks: it may launch that seat and nothing else.
    onlyLaunchable: () => { const now = tabLocation(tabId); return now ? orchestratorOf(now.tab)?.slot : undefined; },
    launch: (slot, brief) => gatedLeaderLaunch(tabId, instance, slot, brief),
  };
  // OpenCode reaches the crew tools through the bridge; its token lives exactly as long as this leader.
  let revokeBridge = () => {};
  revokeOnFailure.run = () => revokeBridge();
  // A turn callback from a leader that is no longer this tab's leader belongs to a turn that is gone: it must not touch the new one.
  // onStop and onNotice are about that old process itself, so they always get through.
  let leader: LeaderHandle;
  const current = (): boolean => leaders.get(tabId) === leader;
  // Only the Claude CLI starts a turn by itself (probed 2026-10-17: a finished background job makes it answer with no message of ours).
  const opensOwnReplies = lead.cli === "claude";
  const callbacks: LeaderCallbacks = {
    onStop: () => {
      denyLeaderApprovals(tabId, instance); revokeBridge();
      // Background jobs end with their leader. The Claude adapter calls onStop once more when its stream ends, which can be after a newer leader started: only the tab's own leader clears.
      if (current()) leaderJobs.delete(tabId);
      // A leader that ended on its own (isDead is already set) must not keep showing "ready". A Stop removes the instance first; a turn still waiting gets its state from finishLeaderTurn, which the error that follows reaches.
      if (current() && leaderInstances.get(tabId) === instance && !leaderTurnResolvers.has(tabId)) broadcast(stateMessage());
    },
    onNotice: (message) => broadcast({ type: "chatNotice", tabId, message }),
    onSteerMissed: (text, images) => { if (current()) handleMissedSteer(tabId, text, images); },
    onSession: (id) => folderActivity.noteSession(id),
    onModel: (model) => { if (current()) { leaderModels.set(tabId, model);
      const known = acpClis.find((item) => acpKindOf(item) === lead.cli);
      if (known && known.lastModel !== model) { try { const next = { ...known, lastModel: model }; writeAcpClis(acpClis.map((item) => item === known ? next : item)); setAcpClis(acpClis.map((item) => item === known ? next : item)); } catch (err) { console.error(describeError(err)); } } broadcast(stateMessage()); } },
    onDelta: (raw) => {
      if (!current()) return;
      if (opensOwnReplies) openUnpromptedReply(tabId);
      // A reply, and the part of it after a steer, never starts with blank lines (the adapters put a paragraph break between separate messages).
      const text = leaderTurnText.get(tabId) ? raw : raw.replace(/^\n+/, "");
      if (!text) return;
      leaderTurnText.set(tabId, (leaderTurnText.get(tabId) ?? "") + text);
      broadcast({ type: "chatDelta", tabId, text });
    },
    onActivity: (label) => {
      if (!current()) return;
      if (label !== null && opensOwnReplies) openUnpromptedReply(tabId);
      if (activeLeaderTurns.has(tabId)) setLeaderActivity(tabId, label);
    },
    onBackgroundJobs: (jobs) => {
      if (!current()) return;
      if (jobs.length) leaderJobs.set(tabId, jobs); else leaderJobs.delete(tabId);
      broadcast(stateMessage());
    },
    // A result with no reply open (a Claude CLI answering with no message of ours) is not a stray: onDelta / onActivity opened that reply, so this ends and saves it.
    // A result with nothing open at all ends nothing: no stray chatDone.
    onDone: () => { if (current() && leaderTurnResolvers.has(tabId)) finishLeaderTurn(tabId, false); },
    onUsage: (delta) => {
      if (!current()) return;
      const usage = leaderUsage.get(tabId) ?? zeroUsage();
      leaderUsage.set(tabId, addUsage(usage, delta));
      broadcastUsageState();
    },
    onError: (message) => {
      if (!current()) return;
      const pending = leaderTurnResolvers.get(tabId);
      if (pending) finishLeaderTurn(tabId, true, message);
      else broadcast({ type: "chatError", tabId, message });
    },
  };
  const mode = effectiveMode(tabId);
  const ask = (tool: string, input: Record<string, unknown>, signal?: AbortSignal) => askLeaderApproval(tabId, instance, tool, input, signal);
  const savedAsks = () => effectiveMode(tabId) === "ask";
  const seat = { model: lead.model, effort: lead.effort };
  // Codex and OpenCode read the seat's effort on every turn: updateSeatPrefs keeps this object current.
  leaderSeats.set(tabId, seat);
  const leaderKind = leaderKindOf(lead.cli);
  if (leaderKind === "acp") {
    const acp = acpClis.find((cli) => acpKindOf(cli) === lead.cli);
    if (!acp) throw new Error(`The CLI "${lead.cli.slice(4)}" was removed in Settings. Pick another leader CLI for ${lead.name}.`);
    const bridge = openBridge(tabId, buildLeaderToolSpecs(toolDeps));
    revokeBridge = bridge.revoke;
    leader = createAcpLeader(seat, location.tab.folder, callbacks, { cli: acp, bridge: { url: `http://${HOST}:${boundPort}/api/leader-mcp/${encodeURIComponent(tabId)}`, token: bridge.token }, spawnFn: acpSpawn, startTimeoutMs: leaderStartTimeoutMs });
  } else if (leaderKind === "codex") {
    leader = createCodexLeader(seat, location.tab.folder, callbacks, { tools: buildLeaderToolSpecs(toolDeps), mode, ask, savedAsks, spawnFn: leaderSpawn, startTimeoutMs: leaderStartTimeoutMs, turnTimeoutMs: leaderTurnTimeoutMs });
  } else if (leaderKind === "opencode") {
    const bridge = openBridge(tabId, buildLeaderToolSpecs(toolDeps));
    revokeBridge = bridge.revoke;
    leader = createOpencodeLeader(seat, location.tab.folder, callbacks, { bridge: { url: `http://${HOST}:${boundPort}/api/leader-mcp/${encodeURIComponent(tabId)}`, token: bridge.token }, mode, ask, savedAsks, spawnFn: leaderSpawn, startTimeoutMs: leaderStartTimeoutMs });
  } else {
    // The advisor is read when the Claude session starts: a change applies from the next session.
    leader = createLeader({ ...seat, ...(lead.advisor ? { advisor: lead.advisor } : {}) }, location.tab.folder, claudeCliPath, callbacks, { mcpServers: { "tab-crew": createLeaderTools(toolDeps) }, allowedTools: LEADER_ALLOWED_TOOLS }, mode, ask, leaderQuery, savedAsks);
  }
  leaders.set(tabId, leader);
  return leader;
}
// A turn waiting for a retired leader to exit has a resolver but no leader yet: Stop all and shutdown must end it too.
export function leadersAndWaitingTurns(): string[] { return [...new Set([...leaders.keys(), ...leaderTurnResolvers.keys()])]; }
export function stopLeaderSession(tabId: string, clearUsage = false, interruptedTurnError?: string): void {
  endWaitingLeaderJobs((job) => job.tabId === tabId, () => "the leader was stopped before it took the job");
  queuedLeaderChanges.delete(tabId);
  // Handed-back steers still waiting behind the reply being stopped are dropped with it (the notice below says so); a failed finish below reads them first.
  const waitingBehind = (lateSteers.get(tabId)?.length ?? 0) > 0;
  denyLeaderApprovals(tabId);
  leaderInstances.delete(tabId);
  // Stop, folder change, process change, CLI switch, Clear, Undo and a replaced dead leader all end up here: the next leader has no memory.
  pendingHandoverReads.add(tabId); handoverReadTurns.delete(tabId);
  const pending = leaderTurnResolvers.get(tabId);
  if (pending) {
    if (interruptedTurnError) finishLeaderTurn(tabId, true, interruptedTurnError);
    else {
      // What the leader had already said is kept in the chat, marked as cut short, instead of vanishing with the draft.
      leaders.get(tabId)?.stop(); // a leader's stop releases text it still held back; stopping twice is harmless
      const partial = leaderTurnText.get(tabId) ?? "";
      leaderTurnResolvers.delete(tabId);
      activeLeaderTurns.delete(tabId);
      endTurnWindow(tabId);
      leaderTurnText.delete(tabId);
      if (partial.trim()) {
        try { broadcast({ type: "chatMessage", ...chatStore.appendMessage(tabId, "assistant", `${partial}\n\n(Stopped before it finished.)`) }); }
        catch (err) { broadcast({ type: "error", message: `could not save the stopped answer to the chat log: ${describeError(err)}` }); }
      }
      // A Clear or Undo empties the chat, so there is nothing to explain; any other stop leaves the steered message in the chat.
      if ((steeredTurns.has(tabId) || waitingBehind) && !clearUsage) noteUnansweredSteer(tabId);
      pending.onReply?.((pending.earlier ?? "") + partial);
      pending.resolve(false);
      settleLeaderTurnWaiters(tabId);
      broadcast({ type: "chatError", tabId, message: "leader turn stopped" });
    }
  }
  lateSteers.delete(tabId);
  steeredTurns.delete(tabId);
  // What this leader was doing ends with it (Stop, Clear, a new folder or CLI, a replaced dead leader); its background jobs end in its onStop.
  setLeaderActivity(tabId, null);
  const leader = leaders.get(tabId);
  if (leader) {
    const usage = leaderUsage.get(tabId);
    if (usage && !clearUsage) leaderUsage.set(tabId, bankUsage(usage));
    leader.stop();
    if (leader.process) retiredLeaders.set(tabId, (retiredLeaders.get(tabId) ?? new Set()).add(leader));
    leaders.delete(tabId);
    leaderSeats.delete(tabId);
    leaderModels.delete(tabId);
  }
  if (clearUsage) leaderUsage.delete(tabId);
}
// Runs when an answer ends: a model/effort change asked for while it was being written now reaches the live leader.
export function applyQueuedLeaderChange(tabId: string): void {
  const queued = queuedLeaderChanges.get(tabId);
  if (!queued) return;
  queuedLeaderChanges.delete(tabId);
  // A leader that was replaced or died in the meantime has nothing to change: its successor reads the saved seat.
  if (leaders.get(tabId) !== queued.liveLeader || queued.liveLeader.isDead()) return;
  if (queued.effort !== undefined) { const liveSeat = leaderSeats.get(tabId); if (liveSeat) liveSeat.effort = queued.effort; }
  if (queued.model === undefined) return;
  void queued.liveLeader.setModel(queued.model)
    .then((ok) => { if (!ok) broadcast({ type: "error", message: "leader model change failed: it applies from the next session" }); })
    .catch((err) => broadcast({ type: "error", message: `leader model change failed: ${describeError(err)}` }));
}
