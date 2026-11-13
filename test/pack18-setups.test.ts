// Pack 26 block 5 run 10: the dynamic setups engine tests (S0, S3, S4, S6, S14: validateSetup, templates, old kind/process migration) are retired with the
// dynamic crew; this file keeps S12, the source sweep: no literal CLI list or old seat id outside the allowed lines.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_CAPS } from "../server/process.ts";
import { sourceFiles, sourceText } from "./source-text.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- S12: no literal CLI list or old seat id outside the places that may hold them ----------------------------------------------

// A line that spells out the seat CLIs as a list or a union. Lists that also name "gemini" are the install/skills/MCP lists of each CLI (not seats) and stay.
const CLI_LIST = /["'](claude)["']\s*(,|\|)\s*["']codex["']\s*(,|\|)\s*["']opencode["'](?!\s*(,|\|)\s*["']gemini["'])/;
// An object keyed by the seat CLIs on one line (the same list written as a map).
const CLI_MAP = /(?<![A-Za-z])claude\s*:[^,{}]*,\s*codex\s*:[^,{}]*,\s*opencode\s*:/;
const OLD_SEAT_ID = /["'](finalReviewer|secondOpinion|socialMedia|imageAndAssets|designReviewer|videoAndMotion)["']/;
// file -> a fragment of each line that may keep a literal list (type declarations; every other place reads the capability table).
const ALLOWED: Record<string, string[]> = {
  "server/process-types.ts": ["export type SeatCli =", "export const CLI_CAPS: Record<"],
  "server/config.ts": ["export type SeatKind =", "const SAVED_MODELS", "const SAVED_EFFORTS", "efforts: { claude: [...EFFORT_OPTIONS.claude]"],
  "server/leader-common.ts": ["export function leaderKindOf(cli: unknown)"],
  "server/fixed-crew/assignment.ts": ['return isAcpCli(id) ? 3 : ["claude", "codex", "opencode"].indexOf(id);'],
};
function sweepText(file: string, text: string): string[] {
  const found: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    if ((CLI_LIST.test(line) || (CLI_MAP.test(line) && !line.includes("gemini"))) && !(ALLOWED[file] ?? []).some((fragment) => line.includes(fragment))) found.push(`${where} CLI list: ${line.trim().slice(0, 100)}`);
    const fixedSecondOpinion = (file === "server/fixed-crew/roster.ts" && (line.includes('| "imageMaker"') || line.includes('seat("secondOpinion"')))
      || (file === "server/index.ts" && line.includes('group: ["leader", "planner", "researcher", "helper", "secondOpinion"]'));
    const scannedLine = fixedSecondOpinion ? line.replaceAll('"secondOpinion"', '""') : line;
    if (OLD_SEAT_ID.test(scannedLine)) found.push(`${where} old seat id: ${line.trim().slice(0, 100)}`);
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
