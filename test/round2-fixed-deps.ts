import * as taskRequestProof from "../server/fixed-crew/task-request-proof.ts";
import assert from "node:assert/strict";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as assignment from "../server/fixed-crew/assignment.ts";
import * as preferences from "../server/fixed-crew/preferences.ts";
import * as prompts from "../server/fixed-crew/role-prompts.ts";
import * as gates from "../server/fixed-crew/task-gates.ts";
import * as journal from "../server/fixed-crew/task-execution.ts";
import * as reports from "../server/fixed-crew/task-reports.ts";
import * as revisions from "../server/fixed-crew/task-revision.ts";
import { ACTIONS, enumeration, id, integer, text } from "../server/fixed-crew/task-types.ts";
import { fixedTab, type FixedChoices } from "./fixed-server-fixture.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import { createGitOperations } from "../server/fixed-crew/git-operations.ts";
import { runGitCommand } from "../server/fixed-crew/git-process.ts";
import { assignmentsDigest } from "../server/fixed-crew/bulk-assignment.ts";
import * as archives from "../server/fixed-crew/task-archive-files.ts";
import { admitJournalExecution, completionExecutions } from "../server/fixed-crew/task-journal-archive.ts";

// The joined server owns current-leader identity, reservations and launch callbacks.
// Only its external imports are injected here, using their production implementations.
export const fixedDependencies = { z, execFileSync, ...assignment, ...preferences, ...prompts,
  ...gates, ...journal, ...taskRequestProof, ...reports, ...revisions, ACTIONS, enumeration, id, integer, text, createGitOperations, runGitCommand,
  appendFileSync, mkdirSync, writeFileSync, assignmentsDigest, ...archives, admitJournalExecution, completionExecutions };

export function round2FixedTab(id: string, folder: string, name: string) {
  const choices: FixedChoices = Object.fromEntries(FIXED_CREW.map(({ slot }) => [slot,
    slot === "leader" ? { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium" }
      : { cli: "codex", model: "gpt-6.1-sol", effort: "low" }]));
  return fixedTab(id, folder, choices, name);
}

async function until(check: () => boolean, what: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const ASSIST = { kind: "assist", route: "normal", change: "none" };
// A real fixed worker launch (the read-only Helper by default) through the current leader, the one path a worker starts on.
export async function startHelper(server: any, tabId = "alpha-dev", slot = "helper", brief = "work") {
  if (!server.leaderInstances.has(tabId)) server.createTabLeader(tabId);
  return server.launchFixedAction(server.currentActor(tabId), null, ASSIST, brief, slot);
}
// Closes a run and waits until its process tree is confirmed ended, so the next heavy execution may reserve.
export async function endRun(server: any, runId: string, tabId = "alpha-dev", code = 0) {
  server.closeRun(runId, code);
  await until(() => server.executionJournal(server.testRoot, tabId).activeExecutionId === null, "the run's process tree to be confirmed ended");
}
// Whole-assignment save through the real message; returns the answer once the action finished.
export async function setAssignment(ws: any, tabId: string, slot: string, assignment: any, requestId = `set_${slot}_${Math.random().toString(36).slice(2, 8)}`) {
  ws.message({ type: "setCrewAssignment", requestId, tabId, slot, assignment });
  const answered = () => ws.messages.some((message: any) => message.requestId === requestId && (message.type === "actionResult" || message.type === "error"));
  await until(answered, `${slot} assignment answer`);
  return ws.messages.find((message: any) => message.requestId === requestId && (message.type === "actionResult" || message.type === "error"));
}
// The fixed creation form of addTab / addProject: a version, the owner's own choices and a request id.
export function fixedCreation(extra: Record<string, unknown> = {}) {
  return { requestId: `create_${Math.random().toString(36).slice(2, 8)}`, fixedCrewVersion: 1, autoAssign: false,
    crewChoices: { leader: { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium" }, helper: { cli: "codex", model: "gpt-6.1-sol", effort: "low" } }, ...extra };
}
