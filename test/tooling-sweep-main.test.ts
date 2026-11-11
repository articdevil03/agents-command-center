import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "./temp-root.ts";
import { CANARY_ROW, failure, finishedNames, go, makeWorld, outOf, pass, readJson, row, statusLines, statusOf, summaryOf, sweepFolder, type World } from "./tooling-sweep-fakes.ts";

// The sweep's real entry point (main) with Block A's functions, the lock, git, the clock and the signals faked. Nothing here starts a real run.
const survivesOnA = (call: any) => (call.lane.files.get("src/a.js")?.includes("= 9") ? pass() : undefined);
const catchMapOf = (world: World) => (existsSync(world.deps.catchMapPath) ? readJson(world.deps.catchMapPath) : null);

test("C1 failed controls cannot teach the catch map even when all rows and controls finished", async () => {
  const world = makeWorld(scratchDir(), { removeLane: () => { throw new Error("C1 cleanup failed"); } });
  await assert.rejects(go(world), /C1 cleanup failed/);
  assert.match(summaryOf(outOf(world)), /PASS 5\. tree unchanged/);
  assert.equal(catchMapOf(world), null, "a failed part cannot write the catch map");
});

test("a survivor does not stop the sweep: the next row still runs, the survivor is re-checked quietly at the end, and the exit code is 1", async () => {
  const world = makeWorld(scratchDir(), { rows: [CANARY_ROW, row("surv"), row("after", "src/b.js", "2", "8")], behave: survivesOnA });
  assert.equal(await go(world), 1);
  assert.deepEqual(statusOf(outOf(world)), { "guard-stale-entry": "RED", "control-must-survive": "SURVIVED", surv: "SURVIVED", after: "RED" });
  const names = statusLines(world).map((line) => line.name);
  assert.ok(names.indexOf("after") > names.indexOf("surv"), "the row after the survivor ran");
  assert.ok(names.lastIndexOf("surv") > names.indexOf("after"), "and the survivor got its quiet re-check in the end phase");
  const last = world.calls.at(-1)!;
  assert.deepEqual([last.files, last.earlyStop, last.slotsHeld], [null, true, 12], "a survivor re-check is a quiet whole-suite run");
  const lines = statusLines(world);
  assert.deepEqual([lines[0].of, lines.at(-1)!.done], [4, 4], "each finished row prints name, status, ms, lane, done, of");
});

test("a finished all-RED sweep exits 0, reports every selected name once, passes all five controls and writes the catch map", async () => {
  const world = makeWorld(scratchDir());
  writeFileSync(world.deps.catchMapPath, '{"stale-row":"test/old.test.ts"}\n');
  assert.equal(await go(world), 0);
  assert.deepEqual(statusOf(outOf(world)), { "guard-stale-entry": "RED", "control-must-survive": "SURVIVED", r1: "RED", r2: "RED", r3: "RED" });
  assert.match(summaryOf(outOf(world)), /Exit code 0 \(sweep complete\)/);
  assert.equal([...summaryOf(outOf(world)).matchAll(/PASS \d\./g)].length, 5);
  assert.deepEqual(catchMapOf(world), { "guard-stale-entry": "test/a.test.ts", r1: "test/a.test.ts", r2: "test/a.test.ts", r3: "test/b.test.ts" }, "this sweep's catches merged, the name no longer in the catalogue deleted");
  assert.match(summaryOf(outOf(world)), /Catch map updated \(4 rows\): commit scripts\/mutations\/catch-map\.json/);
  assert.equal(readFileSync(world.deps.catchMapPath, "utf8").endsWith("}\n"), true);
  assert.ok(readdirSync(join(sweepFolder(outOf(world)), "runs")).every((name) => name.includes("control-must-survive")), "RED rows leave no run output; only the surviving control keeps its logs");
});

test("rows on a target file run the file an earlier row's catch taught, scoped; only the control row (it survives) needs the whole suite", async () => {
  const world = makeWorld(scratchDir(), { rows: [CANARY_ROW, row("r1"), row("r2")] });
  await go(world);
  const scoped = world.calls.filter((call) => call.files?.length === 1 && call.mutated.includes("src/a.js") && call.red);
  assert.deepEqual(scoped.map((call) => call.files), [["test/a.test.ts"], ["test/a.test.ts"], ["test/a.test.ts"], ["test/a.test.ts"]], "r1 and r2 both ran the file the canary taught");
  const whole = world.calls.filter((call) => call.files === null && call.mutated.length && call.red);
  assert.ok(whole.length >= 1 && whole.every((call) => call.mutated.includes("src/c.js")), "the whole suite ran only for the control row");
});

test("never-checked rows go first, controls before everything, and a target file's rows stay together in one lane", async () => {
  const world = makeWorld(scratchDir(), { rows: [CANARY_ROW, row("r1"), row("r3", "src/b.js", "2", "8"), row("r2")] });
  mkdirSync(join(outOf(world), "2026-10-29", "sweep-090000"), { recursive: true });
  writeFileSync(join(outOf(world), "2026-10-29", "sweep-090000", "results.jsonl"), '{"type":"row","name":"r1","status":"RED"}\n');
  await go(world);
  assert.deepEqual(finishedNames(world), ["guard-stale-entry", "control-must-survive", "r3", "r2", "r1"], "controls, then never checked (r3, r2, in catalogue order), then r1 which an earlier sweep saw");
  const laneOf = new Map(statusLines(world).map((line) => [line.name, line.lane]));
  const two = makeWorld(scratchDir(), { rows: [CANARY_ROW, row("a1"), row("a2"), row("b1", "src/b.js", "2", "8")] });
  await go(two, ["--lanes", "2"]);
  const lanes = new Map(statusLines(two).map((line) => [line.name, line.lane]));
  assert.equal(lanes.get("a1"), lanes.get("a2"), "rows on one target file run in one lane");
  assert.equal(laneOf.size, 5);
});

test("a filter part that matches no row, or a bad option, is refused before the priority change, the lock, the copy and any run", async () => {
  for (const argv of [["--out", "x", "alpha-typo"], ["--lanes", "0"], ["--slots", "many"], ["--until", "25:99"], ["--lanes"], ["--nope", "1"], ["r1", "r2"], ["--resume", "x", "r1"]]) {
    const world = makeWorld(scratchDir());
    assert.equal(await (await import("../scripts/sweep/main.mjs")).main(argv, world.deps), 1, argv.join(" "));
    assert.deepEqual(world.events, [], `${argv.join(" ")}: nothing was started`);
    assert.equal(world.calls.length, 0);
  }
  const world = makeWorld(scratchDir());
  await go(world, ["alpha-typo"]);
  assert.match(world.logs.join("\n"), /no catalogue entry name contains alpha-typo/);
});

test("lowerOwnPriority runs before the lock and before any run, and its read-back is in summary.txt", async () => {
  const world = makeWorld(scratchDir());
  await go(world);
  assert.deepEqual(world.events.slice(0, 3), ["priority", "lock", "cleanup-leftovers"]);
  assert.equal(world.events.at(-1), "unlock");
  assert.match(summaryOf(outOf(world)), /own priority 10/);
});

test("a name part selects only matching rows, and the canary and the control row are always in", async () => {
  const world = makeWorld(scratchDir());
  await go(world, ["r3"]);
  assert.deepEqual(Object.keys(statusOf(outOf(world))).sort(), ["control-must-survive", "guard-stale-entry", "r3"]);
});

test("rows on design/ without a design folder are recorded as SKIPPED, never dropped, and still allow exit 0", async () => {
  const world = makeWorld(scratchDir(), { rows: [CANARY_ROW, row("design-row", "design/simple/mutate.py", "x", "y")] });
  world.deps.catalogue.hasDesignFolder = () => false;
  assert.equal(await go(world), 0);
  assert.equal(statusOf(outOf(world))["design-row"], "SKIPPED");
  assert.equal(world.calls.some((call) => call.mutated.includes("design/simple/mutate.py")), false);
});

test("a target that is missing is ERROR, not a thrown stop: the next row still runs and the exit code is 1", async () => {
  const world = makeWorld(scratchDir(), { rows: [CANARY_ROW, row("gone", "src/a.js", "NOT THERE", "x"), row("next", "src/b.js", "2", "8")] });
  assert.equal(await go(world), 1);
  assert.deepEqual(statusOf(outOf(world)), { "guard-stale-entry": "RED", "control-must-survive": "SURVIVED", gone: "ERROR", next: "RED" });
  assert.match(summaryOf(outOf(world)), /ERROR gone: gone: mutation target missing/);
});

test("baseline: red twice ends the part with ERROR, writes the report, runs no row, removes the lanes and releases the lock", async () => {
  const world = makeWorld(scratchDir(), { behave: (call) => (call.mutated.length ? undefined : failure("ERR_ASSERTION", { failures: [{ file: "test/q.test.ts", name: "q", cause: "ERR_ASSERTION", message: "x" }] })) });
  assert.equal(await go(world), 1);
  assert.equal(world.calls.length, 2, "the baseline and its one quiet retry, nothing else");
  assert.deepEqual(world.acquired, [12, 12], "both baseline runs are quiet");
  assert.match(summaryOf(outOf(world)), /baseline red twice/);
  assert.equal(readJson(join(sweepFolder(outOf(world)), "state.json")).parts[0].endReason, "ERROR baseline red twice");
  assert.deepEqual(world.removedLanes, [0]);
  assert.equal(world.events.at(-1), "unlock");
  assert.equal(catchMapOf(world), null, "no catch map from a failed sweep");
});

test("baseline: red once then green goes on; its failing tests join the flake list; a leaked folder counts as red", async () => {
  let first = true;
  const world = makeWorld(scratchDir(), { behave: (call) => { if (!call.mutated.length && first) { first = false; return failure("ERR_ASSERTION", { failures: [{ file: "test/q.test.ts", name: "q", cause: "ERR_ASSERTION", message: "x" }] }); } return undefined; } });
  assert.equal(await go(world), 0);
  assert.match(summaryOf(outOf(world)), /Flake list \(1\): test\/q\.test\.ts :: q/);
  const leaky = makeWorld(scratchDir(), { behave: (call) => { if (call.n <= 2) call.lane.leaked = [".cc-test-x"]; return undefined; } });
  assert.equal(await go(leaky), 1);
  assert.match(summaryOf(outOf(leaky)), /baseline red twice: pass, leaked \.cc-test-x/);
});

test("R1 baseline: top-level app data folders the run wrote (removed, not leaked) never make the baseline red", async () => {
  const world = makeWorld(scratchDir(), { behave: (call) => { if (!call.mutated.length) call.lane.removed = ["chats", "logs"]; return undefined; } });
  assert.equal(await go(world), 0);
  assert.doesNotMatch(summaryOf(outOf(world)), /baseline red/);
});

test("lanes are removed and the lock released on success, on error (a run that throws) and when a cleanup throws; an earlier failure is never hidden", async () => {
  const ok = makeWorld(scratchDir());
  await go(ok, ["--lanes", "2"]);
  assert.deepEqual(ok.removedLanes.sort(), [0, 1]);
  assert.equal(ok.events.at(-1), "unlock");
  const boom = makeWorld(scratchDir(), { behave: (call) => { if (call.n === 3) throw new Error("lane has live leftovers"); return undefined; } });
  assert.equal(await go(boom), 1, "a lane that throws makes the sweep fail, not hang");
  assert.equal(statusOf(outOf(boom))["guard-stale-entry"], "ERROR", "the row the lane died on is recorded as ERROR");
  assert.match(summaryOf(outOf(boom)), /lane 0 stopped on .*: lane has live leftovers/);
  assert.deepEqual(boom.removedLanes, [0]);
  assert.equal(boom.events.at(-1), "unlock");
  const dirty = makeWorld(scratchDir(), { removeLane: () => { throw new Error("cleanup boom"); } });
  await assert.rejects(go(dirty), /cleanup boom/);
  assert.equal(dirty.events.at(-1), "unlock", "the lock is released even when the cleanup throws");
  assert.ok(existsSync(join(sweepFolder(outOf(dirty)), "summary.txt")), "and the report was still written");
  const both = makeWorld(scratchDir(), { removeLane: () => { throw new Error("cleanup boom"); }, behave: (call) => { if (call.n === 1) throw new Error("baseline exploded"); return undefined; } });
  let bothExit;
  await assert.doesNotReject(async () => { bothExit = await go(both); }, "cleanup cannot replace the earlier failure with a thrown error");
  assert.equal(bothExit, 1, "the earlier failure is what comes back");
  assert.match(both.logs.join("\n"), /ERROR baseline exploded/);
  assert.match(both.logs.join("\n"), /ALSO: cleanup boom/);
});

const leavesTracked = (call: any, world: any) => { world.lanes[0].tracked.set(4242, 1); if (call.n === 1) throw new Error("baseline exploded"); return undefined; };

test("R1 cleanup kills a lane's tracked processes once, before removing the lane", async () => {
  const world = makeWorld(scratchDir(), { behave: leavesTracked });
  assert.equal(await go(world), 1);
  assert.deepEqual(world.kills, [[4242]], "one kill retry for the one lane with tracked entries");
  assert.ok(world.events.indexOf("kill-tracked") !== -1 && world.events.indexOf("kill-tracked") < world.events.indexOf("remove-lane-0"), "the kill came before removeLane");
  assert.doesNotMatch(summaryOf(outOf(world)), /kill retry/, "a kill that worked records no problem");
});

test("R1 a failed cleanup kill is recorded against its lane, the lane is still removed, and the sweep does not exit 0", async () => {
  const world = makeWorld(scratchDir(), { behave: leavesTracked, killTracked: () => { throw new Error("still alive after 5000 ms"); } });
  let exit;
  await assert.doesNotReject(async () => { exit = await go(world); });
  assert.equal(exit, 1);
  assert.match(summaryOf(outOf(world)), /lane 0 kill retry: still alive after 5000 ms/);
  assert.ok(world.events.indexOf("remove-lane-0") > world.events.indexOf("kill-tracked"), "removeLane still ran after the failed kill");
  assert.match(world.logs.join("\n"), /ALSO: still alive after 5000 ms/);
});

test("R1 a lane with no tracked processes gets no cleanup kill", async () => {
  const world = makeWorld(scratchDir());
  await go(world);
  assert.deepEqual(world.kills, []);
});

test("a dirty copied tree at the start is refused with exit 1 before any lane or sweep folder exists", async () => {
  const world = makeWorld(scratchDir());
  world.git.dirty = " M src/a.js";
  assert.equal(await go(world), 1);
  assert.match(world.logs.join("\n"), /REFUSED: copied paths have uncommitted changes/);
  assert.equal(world.lanes.length, 0);
  assert.equal(existsSync(outOf(world)), false);
  assert.equal(world.events.at(-1), "unlock");
});

test("the tree changing during the sweep is ERROR: control 5 fails, exit 1, and the catch map is not written", async () => {
  const world = makeWorld(scratchDir(), { behave: (call) => { if (call.n === 3) world.git.head = "b".repeat(40); return undefined; } });
  assert.equal(await go(world), 1);
  assert.match(summaryOf(outOf(world)), /FAIL 5\. tree unchanged/);
  assert.match(summaryOf(outOf(world)), /tree changed during the sweep/);
  assert.equal(catchMapOf(world), null);
});

test("a control row that must survive coming back RED marks the sweep BROKEN; a sweep with survivors still writes its catch map", async () => {
  const redControl = makeWorld(scratchDir(), { rows: [CANARY_ROW, row("r1")], behave: (call) => (call.mutated.includes("src/c.js") ? { outcome: "assertion", exitCode: 1, failures: [{ file: "test/a.test.ts", name: "t", cause: "ERR_ASSERTION", message: "m" }], catching: { file: "test/a.test.ts", name: "t" } } : undefined) });
  assert.equal(await go(redControl), 1);
  assert.match(summaryOf(outOf(redControl)), /BROKEN/);
  assert.match(summaryOf(outOf(redControl)), /FAIL 4\./);
  assert.equal(catchMapOf(redControl), null, "a broken sweep teaches nothing");
  const survivors = makeWorld(scratchDir(), { rows: [CANARY_ROW, row("surv")], behave: survivesOnA });
  assert.equal(await go(survivors), 1);
  assert.deepEqual(catchMapOf(survivors), { "guard-stale-entry": "test/a.test.ts" }, "complete sweeps write the map even with survivors");
});
