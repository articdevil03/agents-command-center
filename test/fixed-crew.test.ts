import test from "node:test";
import assert from "node:assert/strict";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import { freshPreferences } from "../server/fixed-crew/assignment.ts";

// Independent expected values, including all slots, permissions and preferences.
const expected = [
  ["leader", "Leader", false, "claude", "claude-sonnet-5-5[1m]", "high"],
  ["planner", "Planner", false, "codex", "gpt-6.1-sol", "xhigh"],
  ["researcher", "Researcher", false, "claude", "claude-sonnet-5-5[1m]", "medium"],
  ["coder", "Coder", true, "codex", "gpt-6.1-sol", "medium"],
  ["designCoder", "Design coder", true, "claude", "claude-opus-5-5[1m]", "high"],
  ["helper", "Helper", false, "codex", "gpt-6.1-sol", "medium"],
  ["imageMaker", "Image maker", true, "codex", "gpt-6.1-sol", "medium"],
  ["socialMaker", "Social maker", true, "claude", "claude-sonnet-5-5[1m]", "medium"],
  ["videoMaker", "Video maker", true, "claude", "claude-opus-5-5[1m]", "high"],
  ["secondOpinion", "Second opinion", false, "codex", "gpt-6.1-sol", "medium"],
  ["reviewer1", "Reviewer", false, "claude", "claude-sonnet-5-5[1m]", "high"],
  ["fixer1", "Fixer", true, "codex", "gpt-6.1-sol", "medium"],
  ["reviewer2", "Reviewer", false, "claude", "claude-sonnet-5-5[1m]", "high"],
  ["fixer2", "Fixer", true, "claude", "claude-sonnet-5-5[1m]", "medium"],
  ["final", "Final reviewer", false, "claude", "claude-sonnet-5-5[1m]", "high"],
  ["designFinal", "Design final reviewer", false, "codex", "gpt-6.1-sol", "medium"],
  ["minimalFixer", "Minimal fixer", true, "codex", "gpt-6.1-sol", "low"],
  ["minimalReviewer", "Minimal reviewer", false, "claude", "claude-sonnet-5-5[1m]", "medium"],
];

test("FC roster has exactly 18 stable independent definitions", () => {
  assert.equal(FIXED_CREW.length, 18);
  assert.equal(new Set(FIXED_CREW.map((seat) => seat.slot)).size, 18);
  assert.deepEqual(FIXED_CREW.map((seat) => [seat.slot, seat.role, seat.canWrite,
    seat.preferred.cli, seat.preferred.model, seat.preferred.effort]), expected);
  assert.equal(FIXED_CREW[0].preferredAdvisor, "Fable 5.2");
  assert.equal(FIXED_CREW[0].preferred.advisor, undefined);
  assert.deepEqual(FIXED_CREW.filter((seat) => seat.reviews).map((seat) => [seat.slot, seat.reviews]), [
    ["reviewer1", "coder"], ["reviewer2", "fixer1"], ["final", "fixer2"],
    ["designFinal", "designCoder"], ["minimalReviewer", "minimalFixer"],
  ]);
});

test("FC definitions are deeply immutable and fresh assignments are separate nulls", () => {
  assert.ok(Object.isFrozen(FIXED_CREW));
  for (const seat of FIXED_CREW) {
    assert.ok(Object.isFrozen(seat));
    assert.ok(Object.isFrozen(seat.preferred));
  }
  const first = freshPreferences(), second = freshPreferences();
  assert.deepEqual(Object.keys(first), expected.map(([slot]) => slot));
  assert.equal(Object.values(first).length, 18);
  for (const slot of Object.keys(first)) {
    assert.deepEqual(first[slot], { assignment: null, source: "auto" });
    assert.notEqual(first[slot], second[slot]);
  }
  first.leader.source = "user";
  assert.equal(second.leader.source, "auto");
  assert.equal(FIXED_CREW[0].preferred.model, "claude-sonnet-5-5[1m]");
});
