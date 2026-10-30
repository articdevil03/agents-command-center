// Pack 18 rework: the crew decides the steps. D1 walks EVERY row of the agreed table (plus three mixes the table does not list) through deriveSteps and validateSetup,
// D7 the templates (every one passes the check; Our process derives exactly what it was agreed to).
import test from "node:test";
import assert from "node:assert/strict";
import { importWithTempDataRoot } from "./temp-root.ts";
import { deriveSteps, validateSetup, reviewsOwnWork, TEMPLATES, HIDDEN_TEMPLATES, ROLES, type Seat, type Step } from "../server/process.ts";

const { modules: { config } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));

// A crew of the leader and one seat per listed role (slot `s1`, `s2`, ... in order); a role may be a custom text.
const leader: Seat = { slot: "L", name: "Lead", role: "Leader", cli: "claude", model: "claude-opus-5-5[1m]", effort: "low", canWrite: false, isLeader: true };
const crewOf = (...roles: string[]): Seat[] => [leader, ...roles.map((role, i) => ({ slot: `s${i + 1}`, name: `N${i + 1}`, role, cli: "claude" as const, model: "claude-sonnet-5-5[1m]", effort: "medium", canWrite: role === "Coder" || role === "Fixer" || role === "Design coder", isLeader: false }))];

type Plan = { plan: string[]; build: string[]; pairs: string; final: string[]; ship: string[] };
const stepsOf = (steps: Step[]): Plan => {
  const owners = (id: string) => { const step = steps.find((item) => item.id === id); return step && step.type !== "rounds" ? step.owners : ["MISSING"]; };
  const rounds = steps.find((step) => step.type === "rounds");
  return { plan: owners("plan"), build: owners("build"), pairs: rounds?.type === "rounds" ? rounds.pairs.map((pair) => `${pair.reviewer}>${pair.fixers.join("+")}`).join(" ") : "MISSING", final: owners("final"), ship: owners("ship") };
};
const L = ["L"];

// The owner's agreed table, row by row (the number is the row). expected = null: no steps at all; "refused": validateSetup refuses the crew;
// "own-work": the crew derives, but a seat would review its own work, so a save refuses it (the owner's rule of 2026-10-29 supersedes the old rows 8, 9, 10: nobody reviews their own work).
const TABLE: { row: number; crew: string[]; expected: Plan | null | "refused" | "own-work"; note: string }[] = [
  { row: 1, crew: [], expected: null, note: "none: the leader does everything" },
  { row: 2, crew: ["Coder"], expected: { plan: L, build: ["s1"], pairs: "L>s1", final: L, ship: L }, note: "coder builds, leader reviews, coder fixes, leader final" },
  { row: 3, crew: ["Coder", "Reviewer"], expected: { plan: L, build: ["s1"], pairs: "s2>s1", final: L, ship: L }, note: "reviewer every round, coder fixes, leader final" },
  { row: 4, crew: ["Coder", "Reviewer", "Fixer"], expected: { plan: L, build: ["s1"], pairs: "s2>s3", final: L, ship: L }, note: "reviewer rounds, fixer fixes, leader final" },
  { row: 5, crew: ["Coder", "Reviewer", "Fixer", "Final reviewer"], expected: { plan: L, build: ["s1"], pairs: "s2>s3", final: ["s4"], ship: L }, note: "+ Final reviewer: that seat does the final" },
  { row: 6, crew: ["Coder", "Reviewer", "Fixer", "Final reviewer", "Planner"], expected: { plan: ["s5"], build: ["s1"], pairs: "s2>s3", final: ["s4"], ship: ["s5"] }, note: "+ Planner: owns Plan, Gate and Ship" },
  { row: 7, crew: ["Coder", "Coder"], expected: { plan: L, build: ["s1", "s2"], pairs: "L>s1 L>s2", final: L, ship: L }, note: "2 Coders: both build; with no Fixer they alternate fixing" },
  { row: 8, crew: ["Reviewer", "Reviewer", "Fixer", "Fixer"], expected: { plan: L, build: L, pairs: "s1>s3 s2>s4", final: ["s1"], ship: L }, note: "2 Reviewers + 2 Fixers: odd rounds pair 1, even rounds pair 2" },
  { row: 9, crew: ["Reviewer"], expected: { plan: L, build: L, pairs: "s1>L", final: ["s1"], ship: L }, note: "Reviewer, no Coder: leader builds, reviewer reviews, leader fixes, and the Reviewer does the final (the leader built it)" },
  { row: 10, crew: ["Fixer"], expected: "own-work", note: "Fixer, no Reviewer: the leader would review its own build, refused on save" },
  { row: 11, crew: ["Design coder", "Coder"], expected: { plan: L, build: ["s1", "s2"], pairs: "L>s1 L>s2", final: L, ship: L }, note: "Design coder + Coder: both build" },
  { row: 12, crew: ["Researcher"], expected: null, note: "Researcher: no step, used by name" },
  { row: 13, crew: ["Helper", "Some custom role"], expected: null, note: "Helper / Custom: no step, handed work by name" },
  { row: 14, crew: ["Planner", "Planner"], expected: "refused", note: "2 Planners: refused" },
];
// Mixes the table does not list.
const EXTRA: { crew: string[]; expected: Plan; note: string }[] = [
  { crew: ["Reviewer", "Reviewer", "Fixer"], expected: { plan: L, build: L, pairs: "s1>s3 s2>s3", final: ["s1"], ship: L }, note: "2 Reviewers + 1 Fixer: the one fixer takes both pairs" },
  { crew: ["Reviewer", "Coder", "Coder"], expected: { plan: L, build: ["s2", "s3"], pairs: "s1>s2 s1>s3", final: L, ship: L }, note: "1 Reviewer + 2 Coders: the coders fix in turn" },
  { crew: ["Coder", "Coder", "Coder"], expected: { plan: L, build: ["s1", "s2", "s3"], pairs: "L>s1 L>s2 L>s3", final: L, ship: L }, note: "3 Coders, no Fixer" },
];
const AGREED_ROWS = 14; // the rows of the agreed table in the rework contract (section 4)

test("D1 deriveSteps reproduces every row of the agreed table and three more mixes, and the look step sits between Gate and Review only when asked for", () => {
  assert.deepEqual(TABLE.map((entry) => entry.row), Array.from({ length: AGREED_ROWS }, (_, i) => i + 1), "the walk has every row of the agreed table, no more and no fewer");
  const printed: string[] = [];
  for (const entry of [...TABLE, ...EXTRA.map((extra, i) => ({ ...extra, row: 100 + i }))]) {
    const crew = crewOf(...entry.crew);
    if (entry.expected === "refused") {
      assert.throws(() => validateSetup({ crew, lookPause: false }), /at most one Planner/, `row ${entry.row}: ${entry.note}`);
      printed.push(`row ${entry.row}: refused (${entry.note})`);
      continue;
    }
    const derived = validateSetup({ crew, lookPause: false }).steps;
    if (entry.expected === "own-work") {
      assert.equal(reviewsOwnWork(derived), "L", `row ${entry.row}: ${entry.note}`);
      printed.push(`row ${entry.row}: own work, refused on save (${entry.note})`);
      continue;
    }
    assert.deepEqual(derived, deriveSteps(crew, false), `row ${entry.row}: validateSetup and deriveSteps agree`);
    if (entry.expected === null) assert.deepEqual(derived, [], `row ${entry.row}: ${entry.note}`);
    else {
      assert.deepEqual(derived.map((step) => step.id), ["plan", "build", "gate", "review", "final", "ship"], `row ${entry.row}: the step ids`);
      assert.deepEqual(stepsOf(derived), entry.expected, `row ${entry.row}: ${entry.note}`);
      assert.deepEqual(stepsOf(derived).plan, (derived.find((step) => step.id === "gate") as { owners: string[] }).owners, `row ${entry.row}: Gate belongs to whoever owns Plan`);
      assert.deepEqual(deriveSteps(crew, true).map((step) => step.id), ["plan", "build", "gate", "look", "review", "final", "ship"], `row ${entry.row}: lookPause adds the look step after Gate`);
    }
    const shown = entry.expected === null ? "no steps" : `plan ${entry.expected.plan} build ${entry.expected.build} pairs [${entry.expected.pairs}] final ${entry.expected.final} ship ${entry.expected.ship}`;
    printed.push(`row ${entry.row}: ${shown} (${entry.note})`);
  }
  console.log(`D1 walked ${printed.length} crews:\n  ${printed.join("\n  ")}`);
  assert.equal(printed.length, AGREED_ROWS + EXTRA.length);
  assert.deepEqual(deriveSteps(crewOf("Coder"), true).find((step) => step.id === "look"), { id: "look", label: "Your look", type: "look", owners: ["user"] });
});

test("D7 every template passes the check, and Our process derives exactly what was agreed", () => {
  const all = [...TEMPLATES, ...HIDDEN_TEMPLATES];
  assert.deepEqual(all.map((template) => template.id), ["blank", "our-process", "duo", "design", "marketing", "classic-main", "solo"]);
  for (const template of all) {
    const checked = validateSetup({ crew: template.crew, lookPause: template.lookPause });
    assert.deepEqual(checked.steps, template.steps, `${template.id}: the template's steps are the crew's derived steps`);
    assert.doesNotThrow(() => config.validateSetupValues({ crew: JSON.parse(JSON.stringify(template.crew)), steps: [] }, true), `${template.id}: models and efforts are valid`);
    for (const seat of template.crew) assert.ok(seat.isLeader ? seat.role === "Leader" : ROLES.some((role) => role.name === seat.role), `${template.id}/${seat.slot}: role "${seat.role}" is one of the exact role names`);
  }
  assert.deepEqual([config.visibleTemplates().map((template: any) => template.id), TEMPLATES.map((template) => template.id)], [["blank", "our-process", "duo", "design", "marketing"], ["blank", "our-process", "duo", "design", "marketing"]], "solo is hidden; blank comes first");
  const blank = TEMPLATES[0];
  assert.deepEqual([blank.crew.length, blank.steps.length, blank.lookPause], [1, 0, false], "Start blank is the leader alone");

  const our = TEMPLATES.find((template) => template.id === "our-process")!;
  const nameOf = (slot: string) => our.crew.find((seat) => seat.slot === slot)!.name;
  const rounds = our.steps.find((step) => step.type === "rounds");
  const agreed = {
    look: our.lookPause,
    steps: our.steps.map((step) => step.type === "rounds" ? `${step.label}: ${step.pairs.map((pair) => `${nameOf(pair.reviewer)}>${pair.fixers.map(nameOf).join("+")}`).join(", ")}` : `${step.label}: ${step.owners.map((owner) => owner === "user" ? "you" : nameOf(owner)).join("+")}`),
  };
  assert.ok(rounds);
  assert.deepEqual(agreed, { look: true, steps: ["Plan: Sage", "Build: Sonny", "Gate: Sage", "Your look: you", "Review: Vera>Juno, Sol>Nova", "Final review: Terra", "Ship: Sage"] });
  assert.deepEqual(our.crew.filter((seat) => seat.orchestrates).map((seat) => seat.name), ["Sage"], "the Planner runs the process");
  console.log(`D7 Our process: ${agreed.steps.join(" | ")} (look ${agreed.look})`);
});

test("D6 role instructions match the exact agreed contract", () => {
  assert.deepEqual(ROLES.map(({ name, instruction }) => [name, instruction]), [
  [
    "Planner",
    "Your role: Planner. You run the process for this tab: hand each step to the seat that owns it, wait for their runs, and move the steps on. You never write code yourself."
  ],
  [
    "Coder",
    "Your role: Coder. Build exactly what you are given: no more, no less. Do not change anything outside the task."
  ],
  [
    "Design coder",
    "Your role: Design coder. Build exactly the design work you are given: no more, no less. Do not change anything outside the task."
  ],
  [
    "Fixer",
    "Your role: Fixer. Fix exactly the findings you are given: no more, no less. Do not change anything outside the findings."
  ],
  [
    "Reviewer",
    "Your role: Reviewer. Review only: never edit, create or delete a file. Report each finding with its file and line."
  ],
  [
    "Final reviewer",
    "Your role: Final reviewer. Review the whole piece of work only: never edit, create or delete a file. Report each finding with its file and line."
  ],
  [
    "Researcher",
    "Your role: Researcher. Research what you are given, using the web where it helps. Do not edit project files. Your final message is your report: findings first, then sources."
  ],
  [
    "Helper",
    ""
  ]
]);
});
