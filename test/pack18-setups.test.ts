// Pack 18, Block 1: the setups engine without a server (what every file and every save goes through).
// S3 validateSetup refusals, S4 the migration of every old (kind, process) pair, S6 the templates against the model lists, S12 the sweep for literal CLI lists
// and old seat ids, S14 who may run the process. The server-side scenarios are in pack18-setups-engine.test.ts and pack18-setups-run.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_CAPS, HIDDEN_TEMPLATES, LEGACY, TEMPLATES, getProcessDefinition, validateSetup, type ProcessId, type ProcessKind } from "../server/process.ts";
import { importWithTempDataRoot } from "./temp-root.ts";
import { sourceFiles, sourceText } from "./source-text.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

// config.ts reads its data root at import: it is loaded on a fresh temp folder, never on the repo's own (live) config/.
// A config that cannot even start (its own example workspace must pass the strict check against the built-in lists) fails the first test, not the whole file.
const loaded = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") })).then((value) => ({ ...value, error: undefined as unknown }), (error) => ({ modules: undefined, error: error as unknown }));
const config: any = loaded.modules?.config ?? {};
const { readWorkspaces, writeWorkspaces, templateCopy, validateSetupValues, refreshDiscovery, workspacesPath, MODEL_OPTIONS } = config;

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = (): string => mkdtempSync(join(tmpdir(), "cc-p18-setups-"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const OUR = () => templateCopy("our-process");

test("S0 the config module starts: its example workspace is Our process and passes the strict check against the built-in lists", () => {
  assert.equal(loaded.error, undefined, `config.ts failed to load: ${String((loaded.error as Error | undefined)?.message)}`);
  assert.equal(typeof readWorkspaces, "function");
});

// ---- S3: validateSetup ----------------------------------------------------------------------------------------------------------

test("S3 validateSetup: Our process passes, and each broken shape is refused with its own reason", () => {
  const base = OUR();
  assert.deepEqual(validateSetup({ crew: base.crew, lookPause: base.lookPause }).steps.map((step) => step.type), ["work", "work", "work", "look", "rounds", "work", "finish"]);

  const cases: [string, (setup: any) => void, RegExp][] = [
    ["two leaders", (setup) => { setup.crew.find((seat: any) => seat.slot === "coder").isLeader = true; }, /exactly one leader/],
    ["no leader", (setup) => { setup.crew.find((seat: any) => seat.slot === "leader").isLeader = false; }, /exactly one leader/],
    ["a duplicate seat id", (setup) => { setup.crew[2].slot = "planner"; }, /duplicate seat id: planner/],
    ["an unsafe seat id", (setup) => { setup.crew[2].slot = "a/b"; }, /invalid seat id: a\/b/],
    ["the reserved seat id user", (setup) => { setup.crew[2].slot = "user"; }, /invalid seat id: user/],
    ["17 seats", (setup) => { for (let i = 0; i < 9; i++) setup.crew.push({ ...setup.crew[2], slot: `extra${i}` }); }, /1 to 16 seats/],
    ["an advisor on a Codex seat", (setup) => { setup.crew.find((seat: any) => seat.slot === "reviewer1").advisor = "claude-fable-5-1"; }, /cannot have an advisor/],
    ["an ACP seat that does not run its CLI's default", (setup) => { const seat = setup.crew.find((item: any) => item.slot === "coder"); seat.cli = "acp:fake"; }, /own default model and effort/],
  ];
  // The step-shape refusals (rounds placement, unknown owners, duplicate ids, a second look) are gone: steps are derived from the roles, so none of those shapes can be built (D1 walks the derivation).
  for (const [label, mutate, expected] of cases) {
    const setup = clone(base);
    mutate(setup);
    assert.throws(() => validateSetup(setup), expected, label);
  }
});

test("S3 the same refusals reach a saved file: readWorkspaces names the tab and the reason", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "workspaces.json");
    const tab = (setup: any) => ({ id: "p-dev", name: "Dev", kind: "dev", folder: "C:/work", setupName: "Mine", crew: setup.crew, lookPause: setup.lookPause, steps: setup.steps });
    const write = (setup: any) => writeFileSync(path, JSON.stringify({ projects: [{ id: "p", name: "P", folder: "C:/work", tabs: [tab(setup)] }] }));
    write(OUR());
    assert.equal(readWorkspaces(path).projects[0].tabs[0].steps.length, 7, "control: the untouched template loads");
    const two = OUR(); two.crew[2].isLeader = true; write(two);
    assert.throws(() => readWorkspaces(path), /invalid crew or steps in tab "p-dev" \(a crew needs exactly one leader\)/);
    const many = OUR(); for (let i = 0; i < 7; i++) many.crew.push({ ...many.crew[3], slot: `extra${i}` }); write(many);
    assert.throws(() => readWorkspaces(path), /invalid crew or steps in tab "p-dev" \(a crew can have at most 8 Reviewers and 8 Fixers\)/);
  } finally { removeWithRetry(dir); }
});

// ---- S4: every old (kind, process) pair migrates ---------------------------------------------------------------------------------

test("S4 every old kind/process pair in LEGACY loads with its saved names, models and pictures, the tab advisor on the leader, and a one-time backup", () => {
  const pairs = (Object.keys(LEGACY) as ProcessKind[]).flatMap((kind) => (Object.keys(LEGACY[kind]) as ProcessId[]).map((process) => [kind, process] as const));
  const printed: string[] = [];
  for (const [kind, process] of pairs) {
    const dir = tempDir();
    try {
      const definition = getProcessDefinition(kind, process);
      // Models other than the defaults, each one valid for its CLI, so a loader that put the defaults back would show.
      const other = (cli: string) => cli === "claude" ? "claude-opus-5" : cli === "codex" ? "gpt-6-luna" : "x/y";
      const crew = definition.seats.map((seat) => ({ slot: seat.slotId, name: `Custom ${seat.slotId}`, cli: seat.cli, model: other(seat.cli), effort: seat.cli === "claude" ? "high" : "low", pic: "avatars/atlas.svg" }));
      const old = JSON.stringify({ projects: [{ id: "alpha", name: "Alpha", folder: "C:/work/alpha", tabs: [{ id: "alpha-dev", name: "Dev", kind, process, folder: "C:/work/alpha", crew, advisor: { model: "claude-fable-5-1[1m]" } }] }] }, null, 2);
      const path = join(dir, "workspaces.json");
      writeFileSync(path, old);
      const tab = readWorkspaces(path).projects[0].tabs[0] as any;
      const template = (kind === "dev" && process === "main") ? templateCopy("classic-main") : templateCopy(LEGACY[kind][process]);
      printed.push(`${kind}/${process} -> ${LEGACY[kind][process]} (${tab.crew.length} seats, ${tab.steps.length} steps)`);
      assert.equal("process" in tab, false, `${kind}/${process} has no process id any more`);
      assert.equal("advisor" in tab, false, `${kind}/${process} has no tab advisor any more`);
      assert.equal(tab.setupName, template.name);
      assert.deepEqual(tab.steps, template.steps, `${kind}/${process} gets the typed steps of ${template.id}`);
      assert.deepEqual(tab.crew.map((seat: any) => seat.slot), template.crew.map((seat) => seat.slot));
      for (const seat of tab.crew) {
        const saved = crew.find((item) => item.slot === seat.slot)!;
        const fresh = template.crew.find((item) => item.slot === seat.slot)!;
        assert.deepEqual([seat.name, seat.cli, seat.model, seat.effort, seat.pic], [saved.name, saved.cli, saved.model, saved.effort, saved.pic], `${kind}/${process}/${seat.slot} keeps what the user saved`);
        assert.deepEqual([seat.role, seat.canWrite, seat.isLeader], [fresh.role, fresh.canWrite, fresh.isLeader]);
        assert.equal(seat.advisor, seat.isLeader ? "claude-fable-5-1[1m]" : undefined, `${kind}/${process}/${seat.slot}: the tab advisor ends up on the leader and nowhere else`);
      }
      // The first write over the old file keeps it once; a second write leaves that copy alone.
      const backup = join(dir, "workspaces.before-setups.json");
      assert.equal(existsSync(backup), false, "a read writes nothing");
      writeWorkspaces(readWorkspaces(path), path);
      assert.ok(existsSync(backup), `${kind}/${process}: the first write keeps the old file beside it`);
      assert.equal(readFileSync(backup, "utf8"), old, "the backup is the old file, byte for byte");
      assert.equal(JSON.parse(readFileSync(path, "utf8")).projects[0].tabs[0].steps.length, template.steps.length, "the new shape is on disk");
      writeWorkspaces(readWorkspaces(path), path);
      assert.equal(readFileSync(backup, "utf8"), old, "written only if missing: the second write keeps the first copy");
      assert.deepEqual(readdirSync(dir).sort(), ["workspaces.before-setups.json", "workspaces.json"]);
    } finally { removeWithRetry(dir); }
  }
  console.log(`S4 walked ${printed.length} legacy pairs:\n  ${printed.join("\n  ")}`);
  assert.equal(printed.length, Object.values(LEGACY).reduce((sum, row) => sum + Object.keys(row).length, 0), "the walk covers the whole LEGACY map");
  assert.equal(printed.length, 9);
});

// ---- S12: no literal CLI list or old seat id outside the places that may hold them ----------------------------------------------

// A line that spells out the seat CLIs as a list or a union. Lists that also name "gemini" are the install/skills/MCP lists of each CLI (not seats) and stay.
const CLI_LIST = /["'](claude)["']\s*(,|\|)\s*["']codex["']\s*(,|\|)\s*["']opencode["'](?!\s*(,|\|)\s*["']gemini["'])/;
// An object keyed by the seat CLIs on one line (the same list written as a map).
const CLI_MAP = /(?<![A-Za-z])claude\s*:[^,{}]*,\s*codex\s*:[^,{}]*,\s*opencode\s*:/;
const OLD_SEAT_ID = /["'](finalReviewer|secondOpinion|socialMedia|imageAndAssets|designReviewer|videoAndMotion)["']/;
// file -> a fragment of each line that may keep a literal list (type declarations; every other place reads the capability table).
const ALLOWED: Record<string, string[]> = {
  "server/process-types.ts": ["export type SeatCli =", "export const CLI_CAPS: Record<"],
  "server/config.ts": ["export type SeatKind =", "const SAVED_MODELS", "const SAVED_EFFORTS", "efforts: { claude: [...EFFORT_OPTIONS.claude]", "const found = { models:"],
  "server/leader-common.ts": ["export function leaderKindOf(cli: unknown)"],
};
const OLD_SEAT_FILES = new Set(["server/setup-templates.ts"]); // the hidden old crews and the templates
function sweepText(file: string, text: string): string[] {
  const found: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    if ((CLI_LIST.test(line) || (CLI_MAP.test(line) && !line.includes("gemini"))) && !(ALLOWED[file] ?? []).some((fragment) => line.includes(fragment))) found.push(`${where} CLI list: ${line.trim().slice(0, 100)}`);
    if (OLD_SEAT_ID.test(line) && !OLD_SEAT_FILES.has(file)) found.push(`${where} old seat id: ${line.trim().slice(0, 100)}`);
  });
  return found;
}
test("S12 sweep: server/ and public/ hold no literal CLI list or old seat id outside the allowed lines (every match printed)", { timeout: 60_000 }, () => {
  // Controls first: the scanner must catch a planted list and a planted seat id, and must see the capability table it exists to protect.
  assert.equal(sweepText("server/other.ts", 'const x = ["claude", "codex", "opencode"];').length, 1, "control: a planted CLI list is caught");
  assert.equal(sweepText("server/other.ts", 'type K = "claude" | "codex" | "opencode";').length, 1, "control: a planted union is caught");
  assert.equal(sweepText("server/other.ts", 'const s = "finalReviewer";').length, 1, "control: a planted old seat id is caught");
  assert.equal(sweepText("server/other.ts", 'const m = { claude: 1, codex: 2, opencode: 3 };').length, 1, "control: a planted CLI map is caught");
  assert.equal(sweepText("server/other.ts", 'const t = ["claude", "codex", "opencode", "gemini"];').length, 0, "control: the per-CLI install lists (they name gemini) are not seats");
  const process = readFileSync(join(repo, "server/process-types.ts"), "utf8");
  assert.match(process, /\/\/ CLI-CAPABILITIES-TABLE[^\n]*\r?\nexport const CLI_CAPS: Record</, "the capabilities-table line is where the sweep expects it");
  assert.equal(Object.keys(CLI_CAPS).length, 3);

  const scanned: string[] = [], matches: string[] = [];
  let scannedChars = 0;
  for (const file of sourceFiles(repo)) {
    const text = sourceText(file, repo);
    scanned.push(file);
    scannedChars += text.length;
    matches.push(...sweepText(file, text));
  }
  console.log(`S12 scanned ${scanned.length} files (${scanned.filter((f) => f.startsWith("public/")).length} in public/); matches outside the allowed lines: ${matches.length}\n  ${matches.join("\n  ") || "(none)"}`);
  assert.ok(scanned.includes("server/index.ts") && scanned.includes("public/app.js"), "the scan really reached the server and the page");
  assert.ok(scannedChars > 200_000, `control: the scan read the files' text (${scannedChars} characters)`);
  assert.deepEqual(matches, [], "no literal CLI list or old seat id outside the allowed lines");
});

// ---- S14: who may run the process ------------------------------------------------------------------------------------------------

test("S14 validateSetup: one seat runs the process, never the leader, only on a CLI with crew tools, and an ACP seat must be able to write", () => {
  const base = OUR();
  assert.equal(base.crew.filter((seat) => seat.orchestrates).map((seat) => seat.slot).join(), "planner", "control: Our process has exactly one");
  const withSeat = (change: (setup: any) => void) => { const setup = clone(base); change(setup); return setup; };
  const seatOf = (setup: any, slot: string) => setup.crew.find((seat: any) => seat.slot === slot);

  assert.throws(() => validateSetup(withSeat((s) => { seatOf(s, "coder").orchestrates = true; })), /only a Planner can run the process/);
  assert.throws(() => validateSetup(withSeat((s) => { seatOf(s, "planner").orchestrates = false; seatOf(s, "leader").orchestrates = true; })), /only a Planner can run the process/);
  // An ACP seat that runs the process and cannot write is refused; with write it passes.
  const acp = (canWrite: boolean) => withSeat((s) => { const seat = seatOf(s, "planner"); Object.assign(seat, { cli: "acp:fake", model: "default", effort: "default", canWrite }); delete seat.advisor; });
  assert.throws(() => validateSetup(acp(false)), /must be able to write/);
  assert.equal(validateSetup(acp(true)).crew.find((seat) => seat.slot === "planner")!.orchestrates, true);
  // A CLI whose crew tools do not work cannot run it (the far boundary is the capability table).
  const before = CLI_CAPS.opencode.crewTools;
  CLI_CAPS.opencode.crewTools = false;
  try {
    assert.throws(() => validateSetup(withSeat((s) => { Object.assign(seatOf(s, "planner"), { cli: "opencode", model: "a/b", effort: "max" }); delete seatOf(s, "planner").advisor; })), /cannot reach the crew tools/);
  } finally { CLI_CAPS.opencode.crewTools = before; }
  assert.equal(validateSetup(withSeat((s) => { Object.assign(seatOf(s, "planner"), { cli: "opencode", model: "a/b", effort: "max" }); delete seatOf(s, "planner").advisor; })).crew.length, 8, "control: the same seat passes once its CLI has the tools");
});

// ---- S6: the templates against the model lists (LAST: it replaces the live lists) ------------------------------------------------

test("S6 every template passes the strict check against the built-in lists, and still passes after a live list that leaves out Sonnet and Fable", async () => {
  const all = [...TEMPLATES, ...HIDDEN_TEMPLATES].map((template) => templateCopy(template.id));
  const checkAll = (label: string) => {
    for (const template of all) {
      assert.doesNotThrow(() => validateSetup(template), `${label}: ${template.id} is a valid setup`);
      assert.doesNotThrow(() => validateSetupValues(template, true), `${label}: ${template.id} passes the strict model check`);
    }
  };
  checkAll("built-in lists");
  const planner = OUR().crew.find((seat) => seat.slot === "planner")!;
  assert.deepEqual([planner.model, planner.advisor, OUR().crew.find((seat) => seat.slot === "coder")!.model], ["claude-opus-5-5[1m]", "claude-fable-5-1", "claude-sonnet-5-5[1m]"]);
  assert.ok(MODEL_OPTIONS.claude!.includes("claude-sonnet-5-5[1m]") && MODEL_OPTIONS.claude!.includes("claude-fable-5-1"), "the built-in list has them");

  // The workspace file the discovery reads back holds a crew without Sonnet or Fable, so only the templates themselves can keep them valid.
  writeFileSync(workspacesPath, JSON.stringify({ projects: [{ id: "solo", name: "Solo", folder: "C:/work", tabs: [{ id: "solo-dev", name: "Dev", kind: "dev", process: "solo", folder: "C:/work", crew: [{ slot: "leader", name: "Atlas", cli: "claude", model: "claude-opus-5-5[1m]", effort: "medium" }] }] }] }));
  // A model that only a saved setup holds (the "sonnet" alias) is adopted with it.
  const kept = templateCopy("solo");
  kept.crew[0].model = "sonnet";
  config.adoptSavedValues(readWorkspaces(), [{ id: "kept", name: "Kept", kind: "dev", crew: kept.crew, lookPause: kept.lookPause, steps: kept.steps }]);
  const liveClaude = { values: [{ value: "claude-opus-5-5[1m]", displayName: "Opus", supportsEffort: true }], fallback: false };
  await refreshDiscovery(() => ({ values: ["low", "medium", "high"], fallback: false }), () => ({ values: ["opencode/some-model"], fallback: false }), () => liveClaude);
  assert.deepEqual(config.CLAUDE_MODEL_INFO.map((item: any) => item.value).filter((value: string) => value.includes("sonnet-5-5") || value === "claude-fable-5-1").sort(), ["claude-fable-5-1", "claude-sonnet-5-5[1m]"], "the live list lacks them, the catalogue still has them");
  checkAll("after a live list without Sonnet and Fable");
  assert.equal(config.isValidModel("claude", "sonnet"), true, "the saved setup keeps its own model valid through the narrower live list");
  config.adoptSavedValues(readWorkspaces(), []);
  assert.equal(config.isValidModel("claude", "sonnet"), false, "control: without the saved setup the live list no longer has it");
});
