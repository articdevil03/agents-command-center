import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The sweep's own proof that it is not lying lives here: the state file, the append-only results, the five controls and the exit code.
export const CANARY = "guard-stale-entry";
const pad = (n) => String(n).padStart(2, "0");
export const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const sweepFolderFor = (out, d) => join(out, localDate(d), `sweep-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
export const testKey = ({ file, name }) => `${file}\n${name}`;

export function writeState(dir, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}
export function readState(dir) {
  if (!existsSync(join(dir, "state.json"))) throw new Error(`${dir}: no state.json, so this is not a sweep folder`);
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}
// One line per finished row the moment it is final, so a crash loses at most the row in flight.
export function appendRecord(dir, record) { appendFileSync(join(dir, "results.jsonl"), JSON.stringify(record) + "\n"); }
export function readRecords(dir) {
  const path = join(dir, "results.jsonl");
  if (!existsSync(path)) return [];
  // A line torn by a crash is skipped, never fatal.
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
// The latest record for a name wins.
export function finalRecords(records) {
  const finals = new Map();
  for (const record of records) if (record.type === "row") finals.set(record.name, record);
  return finals;
}
export function flakeList(records) {
  const flakes = new Map();
  for (const record of records) if (record.type === "flake") flakes.set(testKey(record), { file: record.file, name: record.name });
  return [...flakes.values()];
}

// Rows the end phase still has to re-check: every survivor, and every RED whose catching test is a known flake.
export function needsEndCheck(record, flakeKeys) {
  if (record.endChecked) return false;
  return record.status === "SURVIVED" || (record.status === "RED" && record.catching !== null && flakeKeys.has(testKey(record.catching)));
}

export function checkControls({ selected, results, controlNames, treeChanged }) {
  const byName = new Map(results.map((entry) => [entry.name, entry]));
  const reported = results.length === selected.length && byName.size === results.length && selected.every((name) => byName.has(name));
  const controls = [
    { id: 1, text: "selected > 0", ok: selected.length > 0 },
    { id: 2, text: `reported == selected (${results.length} of ${selected.length}, each name once)`, ok: reported },
    { id: 3, text: `${CANARY} is RED`, ok: byName.get(CANARY)?.status === "RED" },
    { id: 4, text: `control rows survive (${controlNames.join(", ")})`, ok: controlNames.every((name) => byName.get(name)?.status === "SURVIVED") },
    { id: 5, text: "tree unchanged from start to end", ok: !treeChanged },
  ];
  // A control row that is RED means everything is going red for a wrong reason.
  const broken = controlNames.some((name) => byName.get(name)?.status === "RED");
  return { controls, broken };
}

// 0 only when everything is final and RED (SKIPPED design rows allowed), every control passes; 3 paused; 1 anything else.
export function exitCodeFor({ complete, paused, failed, controls, results, controlNames }) {
  if (failed) return 1;
  if (!complete) return paused ? 3 : 1;
  const rowsOk = results.every((entry) => controlNames.includes(entry.name) || entry.status === "RED" || entry.status === "SKIPPED");
  return rowsOk && controls.every((control) => control.ok) ? 0 : 1;
}

export function resultEntries(selected, finals) {
  return selected.filter((name) => finals.has(name)).map((name) => { const { type: _type, ...entry } = finals.get(name); return entry; });
}

// The merged catch map: this sweep's catches added, names no longer in the catalogue deleted, keys sorted.
export function mergeCatchMap(existing, results, catalogueNames) {
  const merged = { ...existing };
  for (const name of Object.keys(merged)) if (!catalogueNames.has(name)) delete merged[name];
  for (const entry of results) if (entry.status === "RED" && entry.catching?.file) merged[entry.name] = entry.catching.file;
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)));
}
export const catchMapText = (map) => JSON.stringify(map, null, 2) + "\n";

const seconds = (part) => (part.endedAt ? Math.round((Date.parse(part.endedAt) - Date.parse(part.startedAt)) / 1000) : null);

export function renderSummary(m) {
  const counts = { RED: 0, SURVIVED: 0, ERROR: 0, SKIPPED: 0 };
  for (const entry of m.results) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  const lines = [];
  if (m.paused) lines.push(`PAUSED: ${m.results.length} of ${m.selected.length} rows finished. Resume: node scripts/mutation-proof.mjs --resume "${m.dir}"`);
  lines.push(`Exit code ${m.exitCode}${m.complete ? " (sweep complete)" : ""}`);
  if (m.broken) lines.push("BROKEN: a control row that must survive came back RED, so rows are going red for a wrong reason.");
  lines.push(`Selected ${m.selected.length}, reported ${m.results.length}. RED ${counts.RED}, SURVIVED ${counts.SURVIVED}, ERROR ${counts.ERROR}, SKIPPED ${counts.SKIPPED}`);
  lines.push(`HEAD ${m.state.head}`, `Tree check at start: ${m.treeStart}`, `Tree check at end: ${m.treeEnd}`);
  lines.push(`Lanes ${m.state.lanes}, slots ${m.state.slots}, own priority ${m.priority}`);
  m.state.parts.forEach((part) => lines.push(`Part ${part.part}: ${seconds(part) ?? "?"} s, ${part.endReason ?? "did not end cleanly"}`));
  lines.push(`Flake list (${m.flakes.length}): ${m.flakes.map((flake) => `${flake.file} :: ${flake.name}`).join("; ") || "none"}`);
  lines.push(`Caught only when quiet (${m.quietOnly.length}): ${m.quietOnly.join(", ") || "none"}`);
  lines.push("Controls:", ...m.controls.map((control) => `  ${control.ok ? "PASS" : "FAIL"} ${control.id}. ${control.text}`));
  if (m.leftovers.length) lines.push(`Lane leftovers, not forced: ${m.leftovers.join("; ")}`);
  if (m.catchMapNote) lines.push(m.catchMapNote);
  for (const entry of m.results) if (entry.status !== "RED" && !m.controlNames.includes(entry.name)) lines.push(`${entry.status} ${entry.name}: ${(entry.notes ?? []).join(" | ")}`);
  for (const problem of m.problems) lines.push(`ERROR ${problem}`);
  return lines.join("\n") + "\n";
}

export function writeReports(dir, m) {
  writeFileSync(join(dir, "results.json"), JSON.stringify(m.results, null, 2) + "\n");
  writeFileSync(join(dir, "summary.txt"), renderSummary(m));
}
