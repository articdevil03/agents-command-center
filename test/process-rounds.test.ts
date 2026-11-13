import assert from "node:assert/strict";
import test from "node:test";
import { getWorkingSeats, getRunViews, getSeatTaskLine, startRun } from "../server/process.ts";
import { fixedProcess } from "./process-helpers.ts";

test("a leader run is visible as working, a worker run as working, and each seat's task line follows its live runs", () => {
  const leaderRun = startRun(fixedProcess(), { id: "leader-run", seatSlotId: "leader", label: "leader work", startedAt: 1 });
  assert.equal(leaderRun.runs[0].seatIsLeader, true);
  assert.equal(getWorkingSeats(leaderRun).some((item) => item.slotId === "leader" && item.isLeader), true);
  assert.equal(getSeatTaskLine(leaderRun, "leader"), "", "the leader has no task line");
  const worker = startRun(leaderRun, { id: "coder-run", seatSlotId: "coder", label: "coder work", startedAt: 2 });
  assert.deepEqual(getWorkingSeats(worker).map((item) => item.slotId).sort(), ["coder", "leader"]);
  assert.equal(getSeatTaskLine(worker, "coder"), "coder work");
  const second = startRun(worker, { id: "coder-run-2", seatSlotId: "coder", label: "more", startedAt: 3 });
  assert.equal(getSeatTaskLine(second, "coder"), "", "two live runs on one seat show no single task");
  assert.equal(getSeatTaskLine(second, "reviewer1"), "", "an idle seat shows no task");
  assert.deepEqual(Object.keys(getRunViews(second).liveBySeat).sort(), ["coder", "leader"]);
});
