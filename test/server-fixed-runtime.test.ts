import assert from "node:assert/strict";
import test from "node:test";
import { fixedMembers, fixedState } from "../server/fixed-crew/runtime.ts";
import { startRun, stopSeat } from "../server/process.ts";
import { fixedTab } from "./fixed-server-fixture.ts";
import { seat, fixedProcess } from "./process-helpers.ts";

const PREFERRED = { cli: "codex", model: "gpt-6.1-sol", effort: "medium" } as const;

test("a rebuilt fixed state keeps the previous runs and each seat's status and task, but takes the current assignment", () => {
  let previous = fixedProcess({ tabId: "tab-a", folderPath: "C:\\work\\a" });
  previous = startRun(previous, { id: "run-1", seatSlotId: "coder", label: "Build", startedAt: 1 });
  previous = startRun(previous, { id: "run-2", seatSlotId: "reviewer1", label: "Review", startedAt: 2 });
  previous = stopSeat(previous, "reviewer1", 3);
  const tab = fixedTab("tab-a", "C:\\work\\b", {
    leader: { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "high" },
    coder: { cli: "claude", model: "claude-opus-5-5[1m]", effort: "high" },
    reviewer1: { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "high" },
  });
  const next = fixedState(tab, previous);
  assert.equal(next.folderPath, "C:\\work\\b");
  assert.strictEqual(next.runs, previous.runs, "the runs carry over");
  assert.deepEqual(next.runs.map((run) => [run.id, run.folderPath, run.model]), [["run-1", "C:\\work\\a", "gpt-6.1-sol"], ["run-2", "C:\\work\\a", "claude-sonnet-5-5[1m]"]], "an old run keeps its own snapshot");
  assert.deepEqual([seat(next, "coder").status, seat(next, "coder").task], ["working", "Build"]);
  assert.equal(seat(next, "coder").model, "claude-opus-5-5[1m]", "the seat shows the current assignment");
  assert.equal(seat(next, "reviewer1").status, "stopped");
  assert.equal(seat(next, "leader").status, "idle");
  assert.equal(next.seats.some((item) => item.slotId === "reviewer2"), false, "a slot no longer assigned has no seat");
});

test("only assigned slots become fixed seats, in roster order, and unavailable crew data gives a state with no seats", () => {
  const tab = fixedTab("tab-b", "C:\\work", { reviewer1: PREFERRED, leader: PREFERRED, coder: PREFERRED });
  assert.deepEqual(fixedMembers(tab).map((member) => member.slot), ["leader", "coder", "reviewer1"]);
  assert.deepEqual(fixedMembers(tab).map((member) => [member.name, member.isLeader]), [["Leader", true], ["Coder", false], ["Reviewer", false]]);
  assert.deepEqual(fixedState(fixedTab("tab-c", "C:\\work")).seats, [], "a fresh tab with nothing assigned has no seats");

  const broken = { ...tab, fixedCrew: { version: 9 } } as any;
  assert.throws(() => fixedMembers(broken), /Unsupported fixed crew version/);
  const state = fixedState(broken);
  assert.deepEqual(state.seats, []);
  assert.equal(state.tabId, "tab-b");
  assert.equal(state.folderPath, "C:\\work");
});
