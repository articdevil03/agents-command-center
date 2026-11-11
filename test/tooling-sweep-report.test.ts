import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkControls, catchMapText, exitCodeFor, finalRecords, mergeCatchMap, needsEndCheck, readRecords, renderSummary, resultEntries, sweepFolderFor, testKey } from "../scripts/sweep/report.mjs";
import { checkedBefore } from "../scripts/sweep/history.mjs";
import { scratchDir } from "./temp-root.ts";

const entry = (name: string, status: string, extra: object = {}) => ({ name, status, ...extra });
const ALL_OK = { selected: ["guard-stale-entry", "ctl", "a", "b"], controlNames: ["ctl"], treeChanged: false };
const fine = [entry("guard-stale-entry", "RED"), entry("ctl", "SURVIVED"), entry("a", "RED"), entry("b", "RED")];
const failedIds = (controls: { id: number; ok: boolean }[]) => controls.filter((control) => !control.ok).map((control) => control.id);

test("controls: all five pass on a clean finished sweep, and each one fails on its own cause", () => {
  assert.deepEqual(failedIds(checkControls({ ...ALL_OK, results: fine }).controls), []);
  assert.deepEqual(failedIds(checkControls({ selected: [], results: [], controlNames: [], treeChanged: false }).controls), [1, 3], "a run that ran nothing fails (1), and has no canary (3)");
  assert.deepEqual(failedIds(checkControls({ ...ALL_OK, results: fine.slice(0, 3) }).controls), [2], "reported != selected: a row was silently dropped");
  assert.deepEqual(failedIds(checkControls({ ...ALL_OK, results: [...fine, entry("extra", "RED")] }).controls), [2], "a name nobody selected");
  assert.deepEqual(failedIds(checkControls({ ...ALL_OK, results: [...fine.slice(0, 3), entry("a", "RED")] }).controls), [2], "same count, one name twice and one missing");
  assert.deepEqual(failedIds(checkControls({ ...ALL_OK, results: [...fine.slice(0, 3), entry("other", "RED")] }).controls), [2], "equal counts and unique names still require the selected names");
  assert.deepEqual(failedIds(checkControls({ ...ALL_OK, results: [...fine, entry("b", "RED")] }).controls), [2], "all selected names present, but a duplicate is an extra report");
  assert.deepEqual(failedIds(checkControls({ ...ALL_OK, selected: ["guard-stale-entry", "ctl", "a", "a"], results: [...fine.slice(0, 3), entry("a", "RED")] }).controls), [2], "duplicate selection cannot excuse duplicate reports");
  assert.deepEqual(failedIds(checkControls({ ...ALL_OK, results: fine.map((e) => (e.name === "guard-stale-entry" ? entry(e.name, "SURVIVED") : e)) }).controls), [3], "the canary must be RED");
  assert.deepEqual(failedIds(checkControls({ ...ALL_OK, treeChanged: true, results: fine }).controls), [5]);
});

test("control rows that must survive: SURVIVED passes; RED fails the control and marks the sweep BROKEN; a missing one fails", () => {
  const redControl = fine.map((e) => (e.name === "ctl" ? entry("ctl", "RED") : e));
  const broken = checkControls({ ...ALL_OK, results: redControl });
  assert.deepEqual(failedIds(broken.controls), [4]);
  assert.equal(broken.broken, true);
  assert.equal(checkControls({ ...ALL_OK, results: fine }).broken, false);
  assert.deepEqual(failedIds(checkControls({ ...ALL_OK, results: fine.map((e) => (e.name === "ctl" ? entry("ctl", "ERROR") : e)) }).controls), [4]);
});

test("exit code: 0 only when complete, every row RED (SKIPPED allowed) and every control passes; 3 paused; 1 anything else", () => {
  const { controls } = checkControls({ ...ALL_OK, results: fine });
  const base = { complete: true, paused: false, failed: false, controls, results: fine, controlNames: ["guard-stale-entry", "ctl"] };
  assert.equal(exitCodeFor(base), 0);
  assert.equal(exitCodeFor({ ...base, results: [...fine, entry("d", "SKIPPED")] }), 0);
  for (const status of ["SURVIVED", "ERROR"]) assert.equal(exitCodeFor({ ...base, results: [...fine, entry("d", status)] }), 1, status);
  assert.equal(exitCodeFor({ ...base, controls: [{ id: 2, text: "x", ok: false }] }), 1);
  assert.equal(exitCodeFor({ ...base, failed: true }), 1);
  assert.equal(exitCodeFor({ ...base, complete: false, paused: true }), 3);
  assert.equal(exitCodeFor({ ...base, complete: false, paused: true, failed: true }), 1);
  assert.equal(exitCodeFor({ ...base, complete: false }), 1);
});

test("the catch map merges this sweep's catches, deletes names no longer in the catalogue, sorts keys and ends with a newline", () => {
  const merged = mergeCatchMap({ zeta: "test/z.test.ts", gone: "test/g.test.ts", alpha: "test/old.test.ts" }, [entry("alpha", "RED", { catching: { file: "test/new.test.ts" } }), entry("beta", "RED", { catching: { file: "test/b.test.ts" } }), entry("surv", "SURVIVED", { catching: null }), entry("err", "ERROR")], new Set(["zeta", "alpha", "beta", "surv", "err"]));
  assert.deepEqual(Object.entries(merged), [["alpha", "test/new.test.ts"], ["beta", "test/b.test.ts"], ["zeta", "test/z.test.ts"]]);
  assert.equal(catchMapText(merged), '{\n  "alpha": "test/new.test.ts",\n  "beta": "test/b.test.ts",\n  "zeta": "test/z.test.ts"\n}\n');
  assert.equal(catchMapText({}), "{}\n");
});

test("records: the latest record for a name wins, a line torn by a crash is skipped, and the end phase wants survivors and flaky catches", () => {
  const dir = scratchDir();
  writeFileSync(join(dir, "results.jsonl"), '{"type":"row","name":"a","status":"ERROR"}\n{"type":"flake","file":"f","name":"n"}\n{"type":"row","name":"a","status":"RED","catching":{"file":"f","name":"n"}}\n{"type":"row","name":"b","sta');
  const records = readRecords(dir);
  assert.equal(records.length, 3);
  const finals = finalRecords(records);
  assert.equal(finals.get("a")!.status, "RED");
  assert.equal(finals.has("b"), false);
  const flakyKeys = new Set([testKey({ file: "f", name: "n" })]);
  assert.equal(needsEndCheck(finals.get("a"), flakyKeys), true);
  assert.equal(needsEndCheck(finals.get("a"), new Set()), false);
  assert.equal(needsEndCheck({ status: "SURVIVED", catching: null }, new Set()), true);
  assert.equal(needsEndCheck({ status: "SURVIVED", catching: null, endChecked: true }, new Set()), false);
  assert.equal(needsEndCheck({ status: "ERROR", catching: null }, flakyKeys), false);
  assert.deepEqual(resultEntries(["a", "zz"], finals).map((e: any) => e.name), ["a"]);
  assert.equal("type" in resultEntries(["a"], finals)[0], false);
});

test("summary.txt starts with PAUSED and the exact resume command when the sweep is paused, and names the controls and the quiet-only list", () => {
  const base = { dir: "C:/audits/d/sweep-1", results: fine, selected: [...ALL_OK.selected, "later"], exitCode: 3, complete: false, paused: true, broken: false, priority: 10, flakes: [{ file: "f", name: "n" }], controls: checkControls({ ...ALL_OK, results: fine }).controls, controlNames: ["ctl"], leftovers: [], catchMapNote: null, problems: [], treeStart: "aaaaaaa clean", treeEnd: "unchanged", quietOnly: ["q1"], state: { head: "a".repeat(40), lanes: 3, slots: 12, parts: [{ part: 1, startedAt: "2026-10-30T20:00:00.000Z", endedAt: "2026-10-30T20:10:00.000Z", endReason: "stopped: STOP file" }] } };
  const text = renderSummary(base);
  assert.ok(text.startsWith('PAUSED: 4 of 5 rows finished. Resume: node scripts/mutation-proof.mjs --resume "C:/audits/d/sweep-1"\n'), text);
  assert.match(text, /Part 1: 600 s, stopped: STOP file/);
  assert.match(text, /own priority 10/);
  assert.match(text, /Flake list \(1\): f :: n/);
  assert.match(text, /Caught only when quiet \(1\): q1/);
  assert.match(text, /PASS 5\. tree unchanged/);
  assert.doesNotMatch(renderSummary({ ...base, paused: false, exitCode: 1 }), /PAUSED/);
  assert.match(renderSummary({ ...base, broken: true }), /BROKEN/);
});

test("the sweep folder is <out>/<local date>/sweep-<HHMMSS>", () => {
  assert.equal(sweepFolderFor("C:/out", new Date(2026, 9, 5, 7, 4, 9)), join("C:/out", "2026-10-05", "sweep-070409"));
});

// "Checked before" decides the order: never-checked rows go first.
test("checked before: the catch map, RED or SURVIVED records of earlier sweeps and today's old per-row log lines count; ERROR, other shapes and deeper folders do not", () => {
  const out = scratchDir();
  const write = (path: string[], text: string) => { mkdirSync(join(out, ...path.slice(0, -1)), { recursive: true }); writeFileSync(join(out, ...path), text); };
  write(["2026-10-01", "sweep-100000", "results.jsonl"], '{"type":"row","name":"red-before","status":"RED"}\n{"type":"row","name":"surv-before","status":"SURVIVED"}\n{"type":"row","name":"err-before","status":"ERROR"}\n{"type":"flake","name":"flaky-not-a-row","file":"x"}\nnot json\n');
  write(["2026-10-01", "sweep-110000", "results.jsonl"], '{"type":"row","name":"this-sweep","status":"RED"}\n');
  write(["2026-10-02", "old-sweep.log"], 'noise\n{"name":"old-red","red":1,"restored":0,"restoredRetried":false}\n{"name":"old-green","red":0,"restored":0}\n{"name":"old-bad-restore","red":1,"restored":1}\n{"name":"truncated","red":1,"rest');
  write(["2026-10-02", "old-sweep.out"], '{"name":"old-out","red":2,"restored":0}\n');
  write(["2026-10-02", "notes.txt"], '{"name":"wrong-extension","red":1,"restored":0}\n');
  write(["2026-10-02", "deep", "buried.log"], '{"name":"too-deep","red":1,"restored":0}\n');
  const names = checkedBefore({ out, catchMap: new Map([["in-map", "test/x.test.ts"]]), exclude: join(out, "2026-10-01", "sweep-110000") });
  assert.deepEqual([...names].sort(), ["in-map", "old-out", "old-red", "red-before", "surv-before"]);
  assert.deepEqual([...checkedBefore({ out: join(out, "missing"), catchMap: new Map() })], [], "a missing folder is nobody checked");
});
