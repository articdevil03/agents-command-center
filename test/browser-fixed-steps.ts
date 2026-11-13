import assert from "node:assert/strict";
import { join } from "node:path";
import { assertAuditFinished, phase } from "./browser-constants.ts";
import { chromeAudit, listen, proxyServer, shutProxy } from "./browser-helpers.ts";
import type { BrowserProxy } from "./browser-real-types.ts";
import { fixedMembers, fixedState } from "../server/fixed-crew/runtime.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import { getRunViews } from "../server/process-views.ts";

// ---- Fixed seed scenarios (host side, on a copy of the server's state) ----
// A fixed tab runs at most ONE heavy execution at a time, so no scenario here claims two. Each one keeps tab.runs, processState, the seat keys,
// the derived views, the seat card and the fixed busy observation telling the same story. The state passed in is never changed.
const fixedTabOf = (state: any, tabId: string) => {
  const tab = state.projects.flatMap((project: any) => project.tabs).find((item: any) => item.id === tabId);
  assert.ok(tab?.fixedCrew?.preferences, `fixed tab ${tabId} is in the state`);
  return tab;
};
function assignedSeat(tab: any, slot: string) {
  const seat = tab.crew.find((item: any) => item.slot === slot);
  assert.ok(seat, `${tab.id}.${slot} has an assigned model, so it can have a run`);
  return seat;
}
function runRecords(tab: any, seat: any, runId: string, label: string, status: "working" | "done" | "stopped" | "failed", startedAt: number) {
  const base = { id: runId, crewGenerationId: tab.processState.crewGenerationId, seatSlotId: seat.slot, seatName: seat.name, seatIsLeader: seat.isLeader, label, status,
    outcome: status === "working" ? null : status, cli: seat.cli, model: seat.model, effort: seat.effort, folderPath: tab.folder, startedAt, endedAt: status === "working" ? null : startedAt + 1000 };
  return { engine: { ...base, runId, seatKey: `${tab.id}.${seat.slot}`, output: `real runner output for ${label}`, launchedBy: null }, process: base };
}
function finishViews(tab: any) {
  const live = tab.processState.runs.filter((run: any) => run.status === "working");
  tab.derived.runViews = { liveBySeat: Object.fromEntries([...new Set(live.map((run: any) => run.seatSlotId))].map((slot) => [slot, live.filter((run: any) => run.seatSlotId === slot)])),
    history: tab.processState.runs.filter((run: any) => run.status !== "working"), retiredHistory: [] };
  tab.derived.busy = live.length > 0; tab.activeWork = live.length > 0;
  tab.derived.workingSeats = live.map((run: any) => ({ slotId: run.seatSlotId, name: run.seatName, isLeader: run.seatIsLeader }));
}
// One fixed run working on one assigned position of one tab.
export function withActiveFixedRun(state: any, tabId = "alpha-dev", slot = "coder", runId = "fixed-run-1") {
  const copy = structuredClone(state), tab = fixedTabOf(copy, tabId), seat = assignedSeat(tab, slot);
  assert.equal(tab.processState.runs.some((run: any) => run.status === "working"), false, `${tabId} already has an active run: a fixed tab runs one heavy execution at a time`);
  const { engine, process } = runRecords(tab, seat, runId, `Fixed run on ${slot}`, "working", Date.now());
  tab.runs.push(engine); tab.processState.runs.push(process);
  Object.assign(seat, { status: "working", task: `Working · ${engine.label}`, runs: [runId] });
  tab.processState.seats.find((item: any) => item.slotId === slot).status = "working";
  tab.fixedCrew.busy[slot] = true;
  finishViews(tab);
  return copy;
}
// A finished run kept in history (done, stopped or failed); the position is idle again.
export function withRetainedFixedRun(state: any, tabId = "alpha-dev", slot = "coder", outcome: "done" | "stopped" | "failed" = "done", runId = "fixed-history-1") {
  const copy = structuredClone(state), tab = fixedTabOf(copy, tabId), seat = assignedSeat(tab, slot);
  const { engine, process } = runRecords(tab, seat, runId, `Finished run on ${slot}`, outcome, Date.now() - 60_000);
  tab.runs.push(engine); tab.processState.runs.push(process);
  finishViews(tab);
  return copy;
}
// A run whose stop the server could not confirm: still working, and listed as uncertain so the page offers its own release.
export function withUnconfirmedStop(state: any, tabId = "alpha-dev", slot = "coder", runId = "fixed-unconfirmed-1") {
  const copy = withActiveFixedRun(state, tabId, slot, runId);
  copy.launchSafety.uncertain.push({ seatId: `${tabId}.${slot}`, pid: 4242, runId });
  return copy;
}
// The server's compact task summary for a tab, matching the record the fake socket answers getFixedTask with.
export function withFixedTask(state: any, tabId: string, task: any) {
  const copy = structuredClone(state);
  fixedTabOf(copy, tabId).fixedTask = { taskId: task.id, planVersion: task.planVersion, detailRevision: task.recordRevision, stage: task.stage };
  return copy;
}
// An idle state built from saved workspaces the way the server derives it (seat keys, process state, derived views), for checks that start no server.
export function idleFixedState(data: any) {
  return { type: "state", selectedTabId: data.projects[0].tabs[0].id, launchSafety: { blocked: [], uncertain: [], released: [], notices: [] },
    fixedCrewDefinitions: FIXED_CREW.map(({ slot, role, canWrite, reviews }) => ({ slot, label: role, canWrite, reviews })),
    projects: data.projects.map((project: any) => ({ ...project, tabs: project.tabs.map((tab: any) => {
      const processState = fixedState(tab), members = fixedMembers(tab);
      return { ...structuredClone(tab), crew: members.map((member) => ({ ...member, seatKey: `${tab.id}.${member.slot}`, status: "idle", task: "Ready", runs: [] })), runs: [], processState,
        pendingApprovals: [], fixedTask: null, activeWork: false, fixedCrew: { ...structuredClone(tab.fixedCrew), busy: Object.fromEntries(FIXED_CREW.map(({ slot }) => [slot, false])), notices: {} },
        derived: { busy: false, workingSeats: [], runViews: getRunViews(processState), leaderTurnActive: false } };
    }) })) };
}

// ---- Browser cases ----
const checkNames = (audit: any, prefix: string) => audit.checks.map((item: any) => item.name).filter((name: string) => name.startsWith(prefix));
async function runCase(proxy: BrowserProxy, temp: string, folder: string, mode: string, caseName: string, profile: string) {
  const port = await listen(proxy.proxy);
  try {
    const audit = await chromeAudit({ port, mode, folder, width: 1600, profile: join(temp, profile), caseName, virtualMs: 60_000 });
    assert.equal(audit.failure, undefined, `${caseName} (${mode}) audit failed: ${audit.failure}`);
    assertAuditFinished(audit, caseName);
    assert.deepEqual(audit.errors, [], `${caseName} (${mode}) page errors`);
    assert.deepEqual(audit.failures ?? [], [], `${caseName} (${mode}) check failures`);
    assert.ok(audit.checks.length > 0, `${caseName} (${mode}) ran no checks`);
    shutProxy(proxy);
    return audit;
  } catch (error) { proxy.wss.close(); proxy.proxy.close(); throw error; }
}
// The fixed smoke: both entries run it against the real server's state (mode real, no chat) and the fake transport (mode fake, one chat round trip).
export async function fixedSmoke(port: number, temp: string, folder: string, seed: any, script: string) {
  if (!phase("fixed-smoke")) return;
  console.log("FIXED SMOKE (announced): the seeded fixed tabs, seat identity, 18 Settings positions, chat rendering and an empty error list, real then fake page");
  for (const [mode, expected] of [["real", 5], ["fake", 6]] as const) {
    const proxy = proxyServer(port, { folder, mode, ...(mode === "fake" ? { seed } : {}) }, script);
    const audit = await runCase(proxy, temp, folder, mode, "fixed-smoke", `chrome-fixed-smoke-${mode}`);
    const names = checkNames(audit, `fixed smoke (${mode}):`);
    assert.equal(names.length, expected, `fixed smoke (${mode}) ran ${names.length} of its ${expected} checks: ${JSON.stringify(audit.checks.map((item: any) => item.name))}`);
    assert.ok(audit.checks.every((item: any) => item.passed === true), `fixed smoke (${mode}) checks passed`);
    console.log(`Fixed smoke ${mode}: ${audit.checks.length} checks GREEN`);
  }
}
// Bounded partial runs for later conversions. Each runs only when CC_BROWSER_PHASES names it, so a default run is unchanged, and each is announced as partial.
const PARTIALS: Record<string, { mode: string; caseName: string; about: string }> = {
  "fixed-real-render": { mode: "real", caseName: "render", about: "the real-server render only" },
  "fixed-b2-notifications": { mode: "fake", caseName: "b2-notifications", about: "B2 through the notification checks" },
  "fixed-c2-through-r7": { mode: "fake", caseName: "c2-through-r7", about: "C2 through Pack C, tool approvals, R6 and R7 (no R1)" },
  "fixed-real-requests": { mode: "real", caseName: "c2-requests", about: "the real requests checks only" },
};
export async function fixedPartialCases(port: number, temp: string, folder: string, seed: any, script: string) {
  for (const [name, { mode, caseName, about }] of Object.entries(PARTIALS)) {
    if (!process.env.CC_BROWSER_PHASES?.split(",").includes(name)) continue;
    console.log(`PARTIAL BROWSER RUN (announced, not a full run): ${about}`);
    const proxy = proxyServer(port, { folder, mode, ...(mode === "fake" ? { seed } : {}) }, script);
    const audit = await runCase(proxy, temp, folder, mode, caseName, `chrome-${name}`);
    console.log(`${name}: ${audit.checks.length} checks GREEN`);
  }
}
