import test from "node:test";
import assert from "node:assert/strict";
import type { Assignment } from "../server/fixed-crew/roster.ts";
import {
  autoFillPreferences, freshPreferences, validateAssignment, validatePreference,
  requireAssignment, independenceNotice, assignmentCompany,
  type AssignmentCatalogue, type CliInventory, type CrewPreferences,
} from "../server/fixed-crew/assignment.ts";
import { importWithTempDataRoot } from "./temp-root.ts";

const SONNET = "claude-sonnet-5-5[1m]", OPUS = "claude-opus-5-5[1m]", SOL = "gpt-6.1-sol";
const claude = (extra: Partial<CliInventory> = {}): CliInventory => ({
  id: "claude", installed: true, models: [OPUS, SONNET], efforts: ["low", "medium", "high"], advisor: true, ...extra,
});
const codex = (extra: Partial<CliInventory> = {}): CliInventory => ({
  id: "codex", installed: true, models: [SOL], efforts: ["low", "medium", "high", "xhigh", "max"], advisor: false, ...extra,
});
const opencode = (extra: Partial<CliInventory> = {}): CliInventory => ({
  id: "opencode", installed: true, models: null, efforts: ["max"], advisor: false, ...extra,
});
const acp = (extra: Partial<CliInventory> = {}): CliInventory => ({
  id: "acp:custom", installed: true, models: ["default"], efforts: ["default"], advisor: false, ...extra,
});
const assignment = (cli = "codex", model = SOL, effort = "medium"): Assignment => ({ cli: cli as Assignment["cli"], model, effort });

function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
// Every resolver case freezes and compares all inputs, including nested arrays.
function fill(preferences: Partial<CrewPreferences>, catalogue: AssignmentCatalogue): CrewPreferences {
  const before = structuredClone({ preferences, catalogue });
  frozen(preferences); frozen(catalogue);
  const result = autoFillPreferences(preferences, catalogue);
  assert.deepEqual({ preferences, catalogue }, before, "resolver mutated inputs");
  return result;
}

test("FC zero and unknown installations stay null without throwing", () => {
  for (const clis of [[], [claude({ installed: null })], [codex({ installed: false }), opencode({ installed: null })]]) {
    let result!: CrewPreferences;
    assert.doesNotThrow(() => { result = fill(freshPreferences(), { clis }); });
    assert.deepEqual(result, freshPreferences(), "only installed === true may be auto-assigned");
  }
});

test("FC one installed CLI fills every auto seat with usable values", () => {
  for (const cli of [claude(), codex(), opencode(), acp()]) {
    const suggestions = ["vendor/custom-v1"];
    const result = fill(freshPreferences(), { clis: [cli], opencodeSuggestions: suggestions });
    assert.equal(Object.values(result).length, 18);
    for (const preference of Object.values(result)) {
      assert.ok(preference.assignment, `${cli.id} should fill all auto seats`);
      assert.equal(preference.assignment.cli, cli.id);
      assert.ok((cli.models ?? suggestions).includes(preference.assignment.model));
      assert.ok(cli.efforts.includes(preference.assignment.effort));
      assert.equal(preference.source, "auto");
      assert.deepEqual(validatePreference(frozen(preference)), preference);
    }
    if (cli.id === "acp:custom") assert.deepEqual(result.leader.assignment, assignment("acp:custom", "default", "default"));
  }
});

test("FC single CLI keeps preferred model when preferred effort is missing", () => {
  const result = fill({}, { clis: [codex({ models: ["gpt-6-a", SOL], efforts: ["medium"] })] });
  assert.deepEqual(result.planner.assignment, assignment("codex", SOL, "medium"));
});

test("FC several installed CLIs use approved preferred choices", () => {
  const result = fill({}, { clis: [codex(), claude(), opencode()] });
  const expected = {
    leader: assignment("claude", SONNET, "high"), planner: assignment("codex", SOL, "xhigh"),
    researcher: assignment("claude", SONNET), coder: assignment(), designCoder: assignment("claude", OPUS, "high"),
    helper: assignment(), imageMaker: assignment(), socialMaker: assignment("claude", SONNET),
    videoMaker: assignment("claude", OPUS, "high"), secondOpinion: assignment(),
    reviewer1: assignment("claude", SONNET, "high"), fixer1: assignment(),
    reviewer2: assignment("claude", SONNET, "high"), fixer2: assignment("claude", SONNET),
    final: assignment("codex", SOL, "high"), designFinal: assignment(),
    minimalFixer: assignment("codex", SOL, "low"), minimalReviewer: assignment("claude", SONNET),
  };
  for (const [slot, value] of Object.entries(expected)) assert.deepEqual(result[slot].assignment, value, slot);
  assert.equal(result.leader.assignment?.advisor, undefined, "never silently use Fable 5.1");
});

test("FC explicit user choices including null survive fill and refresh", () => {
  const preferences = freshPreferences();
  preferences.leader = { source: "user", assignment: null };
  preferences.coder = { source: "user", assignment: assignment("codex", "gpt-6-custom", "future") };
  const first = fill(preferences, { clis: [claude(), codex()] });
  assert.deepEqual(first.leader, preferences.leader);
  assert.deepEqual(first.coder, preferences.coder);
  const refreshed = fill(first, { clis: [claude({ installed: false }), codex({ models: [], efforts: [] })] });
  assert.deepEqual(refreshed, first, "assigned models omitted by later discovery survive");
  assert.deepEqual(fill(first, { clis: [] }), first, "unavailable discovery cannot erase assignments");
});

test("FC assignment setter fills through the public function and returns detached values", () => {
  const preferences = freshPreferences();
  const result = fill(preferences, { clis: [codex()] });
  assert.deepEqual(result.coder, { source: "auto", assignment: assignment() });
  assert.equal(preferences.coder.assignment, null);
  const refreshed = fill(result, { clis: [] });
  refreshed.coder.assignment!.model = "gpt-6-changed-output";
  assert.equal(result.coder.assignment?.model, SOL, "returned assignment must not alias input");
});

test("FC unavailable preferred model or effort falls back deterministically or stays null", () => {
  const clis = [claude({ models: ["claude-z", "claude-a"], efforts: ["low"] }), codex({ models: [], efforts: [] })];
  const first = fill({}, { clis });
  assert.deepEqual(first.leader.assignment, assignment("claude", "claude-a", "low"));
  assert.deepEqual(fill({}, { clis: [...clis].reverse() }), first);
  for (const cli of [claude({ models: [] }), codex({ efforts: [] }), opencode()]) {
    const result = fill({}, { clis: [cli] });
    assert.deepEqual(result, freshPreferences(), `${cli.id}: no fabricated usable values`);
  }
  assert.deepEqual(fill({}, { clis: [claude({ models: [] }), codex({ efforts: [] })] }), freshPreferences());
});

test("FC fallback order is stable with two usable CLIs in reversed input order", () => {
  const clis = [opencode({ models: ["vendor/custom"] }), claude()];
  const first = fill({}, { clis });
  assert.deepEqual(first.coder.assignment, assignment("claude", SONNET));
  assert.deepEqual(fill({}, { clis: [...clis].reverse() }), first);
});

test("FC installed preferred CLI substitutes missing model and effort among several CLIs", () => {
  const result = fill({}, { clis: [acp(), codex(), claude({ efforts: ["low", "medium"] })] });
  assert.deepEqual(result.leader.assignment, assignment("claude", SONNET));
  assert.deepEqual(result.designCoder.assignment, assignment("claude", OPUS));
  const missing = fill({}, { clis: [codex(), claude({ models: [OPUS], efforts: ["low"] })] });
  assert.deepEqual(missing.leader.assignment, assignment("claude", OPUS, "low"));
  const codexSubstitute = fill({}, { clis: [claude(), codex({ models: ["gpt-6-astra"], efforts: ["low"] })] });
  assert.deepEqual(codexSubstitute.coder.assignment, assignment("codex", "gpt-6-astra", "low"));
});

test("FC built-in CLIs precede ACP fallbacks with several installations", () => {
  const result = fill({}, { clis: [acp(), codex()] });
  for (const slot of ["leader", "reviewer1", "reviewer2", "final", "minimalReviewer"]) {
    assert.deepEqual(result[slot].assignment, assignment("codex", SOL, slot === "minimalReviewer" ? "medium" : "high"), slot);
  }
});

test("FC worker defaults prefer Sonnet then Opus and never Fable", () => {
  const realModels = [OPUS, SONNET, "claude-opus-5", "claude-opus-5[1m]",
    "claude-fable-5-1[1m]", "claude-fable-5-1", "sonnet", "claude-haiku-4-5-20251001"];
  assert.equal([...realModels].sort()[0], "claude-fable-5-1");
  for (const clis of [[claude({ models: realModels })], [opencode(), claude({ models: realModels })]]) {
    const result = fill({}, { clis });
    for (const slot of ["planner", "coder", "helper", "imageMaker", "secondOpinion", "fixer1", "designFinal", "minimalFixer"]) {
      assert.deepEqual(result[slot].assignment, assignment("claude", SONNET, slot === "minimalFixer" ? "low" : "medium"), slot);
    }
  }
  assert.deepEqual(fill({}, { clis: [claude({ models: ["claude-haiku-4-5", OPUS] })] }).coder.assignment,
    assignment("claude", OPUS));
  assert.equal(fill({}, { clis: [claude({ models: ["claude-fable-5-1", "fable"] })] }).coder.assignment, null);
  assert.deepEqual(fill({}, { clis: [opencode({ models: ["vendor/fable", "vendor/custom"] })] }).coder.assignment,
    assignment("opencode", "vendor/custom", "max"));
});

test("FC reviewers alternate company even when roster preference is available", () => {
  const fallbackWriter = fill({}, { clis: [claude(), opencode({ models: ["openai/gpt-6-astra"] })] });
  assert.deepEqual(fallbackWriter.coder.assignment, assignment("claude", SONNET));
  assert.deepEqual(fallbackWriter.reviewer1.assignment, assignment("opencode", "openai/gpt-6-astra", "max"));
  const chosen = { coder: { source: "user" as const, assignment: assignment("claude", OPUS, "high") } };
  const result = fill(chosen, { clis: [claude(), codex()] });
  assert.deepEqual(result.coder, chosen.coder);
  assert.deepEqual(result.reviewer1.assignment, assignment("codex", SOL, "high"));
  assert.deepEqual(fill({}, { clis: [claude(), codex()] }).final.assignment, assignment("codex", SOL, "high"));
  const explicit = { ...chosen, reviewer1: { source: "user" as const, assignment: assignment("claude", SONNET) } };
  assert.deepEqual(fill(explicit, { clis: [claude(), codex()] }).reviewer1, explicit.reviewer1);
  const one = fill({}, { clis: [claude()] });
  assert.equal(independenceNotice(one.coder.assignment, one.reviewer1.assignment).status, "same-model");
  const unknown = fill({ coder: { source: "user", assignment: assignment("opencode", "vendor/other", "max") } },
    { clis: [opencode({ models: ["vendor/custom"] }), acp()] });
  assert.deepEqual(unknown.reviewer1.assignment, assignment("opencode", "vendor/custom", "max"));
  assert.equal(independenceNotice(unknown.coder.assignment, unknown.reviewer1.assignment).status, "unknown");
});

test("FC OpenCode custom capability uses separately supplied safe suggestions", () => {
  const result = fill({}, { clis: [opencode()], opencodeSuggestions: ["bad & shell", "vendor/z", "vendor/a"] });
  assert.deepEqual(result.coder.assignment, assignment("opencode", "vendor/a", "max"));
  assert.deepEqual(fill({}, { clis: [opencode({ models: [] })], opencodeSuggestions: ["vendor/a"] }), freshPreferences());
  assert.deepEqual(fill({}, { clis: [opencode()], opencodeSuggestions: ["vendor/../bad"] }), freshPreferences());
});

test("FC advisor only selects catalogue-identified Fable 5.2", () => {
  const oldId = "claude-fable-5-1", actualId = "catalogue-fable-current";
  const clis = [claude({ models: [SONNET, oldId, actualId] })];
  const without = fill({}, { clis, claudeModels: [{ value: oldId, displayName: "Fable 5.1" }] });
  assert.equal(without.leader.assignment?.advisor, undefined);
  const withAdvisor = fill({}, { clis, claudeModels: [{ value: actualId, displayName: "Fable 5.2" }] });
  assert.equal(withAdvisor.leader.assignment?.advisor, actualId);
  assert.equal(withAdvisor.coder.assignment?.advisor, undefined);
  const absent = fill({}, { clis, claudeModels: [{ value: "missing-id", displayName: "Fable 5.2" }] });
  assert.equal(absent.leader.assignment?.advisor, undefined);
});

test("FC reviewer fallback selects known different company before same or unknown company", () => {
  const preferences = freshPreferences();
  preferences.coder = { source: "user", assignment: assignment() };
  const clis = [codex({ models: ["gpt-6-a"] }), opencode()];
  const result = fill(preferences, { clis, opencodeSuggestions: ["vendor/aaa-unknown", "vendor/gpt-6-b", "vendor/claude-sonnet-5"] });
  assert.deepEqual(result.reviewer1.assignment, assignment("opencode", "vendor/claude-sonnet-5", "max"));
  const sameOnly = fill(preferences, { clis, opencodeSuggestions: ["vendor/gpt-6-b"] });
  assert.equal(sameOnly.reviewer1.assignment?.cli, "codex", "same company remains allowed with deterministic fallback");
  const unknownOnly = fill(preferences, { clis: [codex({ models: [] }), opencode()], opencodeSuggestions: ["vendor/unknown"] });
  assert.equal(unknownOnly.reviewer1.assignment?.model, "vendor/unknown");
  assert.equal(independenceNotice(preferences.coder.assignment, unknownOnly.reviewer1.assignment).status, "unknown");
  const unknownWriter = { ...preferences, coder: { source: "user" as const, assignment: assignment("acp:custom", "default", "default") } };
  assert.equal(fill(unknownWriter, { clis, opencodeSuggestions: ["vendor/claude-sonnet-5"] }).reviewer1.assignment?.cli, "codex");
});

test("FC independence notices allow same models and never infer company from CLI id", () => {
  const writer = frozen(assignment());
  const cases: Array<[Assignment | null, string]> = [
    [assignment(), "same-model"], [assignment("opencode", `openai/${SOL}`, "max"), "same-model"],
    [assignment("opencode", "vendor/gpt-6-other", "max"), "same-company"],
    [assignment("claude", SONNET), "different-company"], [assignment("opencode", "vendor/unknown", "max"), "unknown"],
    [assignment("acp:custom", "default", "default"), "unknown"], [null, "unassigned"],
  ];
  for (const [reviewer, status] of cases) {
    const before = structuredClone(reviewer);
    const notice = independenceNotice(writer, frozen(reviewer));
    assert.equal(notice.status, status);
    assert.equal(notice.blocking, false);
    assert.ok(notice.message.length > 0);
    assert.deepEqual(reviewer, before);
  }
  assert.equal(assignmentCompany(assignment("acp:claude", "default", "default")), null);
  assert.equal(independenceNotice(assignment("acp:a", "default", "default"), assignment("acp:b", "default", "default")).status, "unknown");
});

test("FC company identity covers bare Claude aliases and provider-prefixed families", () => {
  for (const model of ["sonnet", "opus", "haiku", "fable", "sonnet[1m]"]) {
    assert.equal(assignmentCompany(assignment("claude", model)), "anthropic", model);
    assert.equal(assignmentCompany(assignment("opencode", model)), null, model);
  }
  for (const model of ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5", "anthropic/claude-haiku-4-5", "anthropic/claude-fable-5-1"]) {
    assert.equal(assignmentCompany(assignment("opencode", model)), "anthropic", model);
  }
  assert.equal(assignmentCompany(assignment("opencode", "openai/gpt-6-astra")), "openai");
});

test("FC rejects prototype slot names and ignores inherited user choices", () => {
  for (const slot of ["__proto__", "constructor"]) {
    const input = JSON.parse(`{"${slot}":{"source":"user","assignment":null}}`);
    assert.throws(() => autoFillPreferences(input, { clis: [codex()] }), /Unknown crew slot/, slot);
  }
  const preferences = Object.create({ coder: { source: "user", assignment: null } });
  const result = autoFillPreferences(preferences, { clis: [codex()] });
  assert.deepEqual(result.coder, { source: "auto", assignment: assignment() });
  assert.equal(Object.hasOwn(preferences, "coder"), false);
  assert.deepEqual(preferences.coder, { source: "user", assignment: null });
});

test("FC validation rejects malformed preferences and unsafe assignments without mutation", () => {
  for (const raw of [undefined, {}, { source: "manual", assignment: null }, { source: "auto" },
    { source: "auto", assignment: assignment("fake") }, { source: "auto", assignment: assignment("codex", "--flag") },
    { source: "auto", assignment: assignment("acp:custom", SOL) },
    { source: "auto", assignment: { ...assignment(), advisor: SONNET } }]) {
    const before = structuredClone(raw);
    assert.throws(() => validatePreference(frozen(raw)));
    assert.deepEqual(raw, before);
  }
  assert.throws(() => autoFillPreferences({ invented: { source: "auto", assignment: null } } as any, { clis: [] }), /Unknown crew slot/);
  const valid = frozen({ ...assignment("claude", SONNET, "high"), advisor: "catalogue-advisor" });
  assert.deepEqual(validateAssignment(valid), valid);
  assert.equal(validateAssignment(null), null);
});

test("FC null assignment is refused before future launch integration", () => {
  const preference = frozen({ source: "user" as const, assignment: null });
  assert.throws(() => requireAssignment(preference), { message: "Choose a model in Settings before running this seat." });
  const assigned = frozen({ source: "auto" as const, assignment: assignment() });
  assert.deepEqual(requireAssignment(assigned), assigned.assignment);
  assert.notEqual(requireAssignment(assigned), assigned.assignment);
});

test("FC Codex baseline supports xhigh and buildClis feeds the pure resolver", async () => {
  const { modules: config } = await importWithTempDataRoot(() => import("../server/config.ts"));
  assert.ok(config.EFFORT_OPTIONS.codex.includes("xhigh"), "Codex baseline must support the planner xhigh preference");
  const clis = config.buildClis((cli) => cli === "codex", []);
  const result = fill({}, { clis, opencodeSuggestions: config.OPENCODE_MODEL_SUGGESTIONS });
  assert.deepEqual(result.planner.assignment, assignment("codex", SOL, "xhigh"));
  const added = config.buildClis(() => false, [{ id: "custom", name: "Custom", program: "custom", args: [] }]);
  const acpResult = fill({}, { clis: added });
  assert.deepEqual(acpResult.leader.assignment, assignment("acp:custom", "default", "default"));
});
