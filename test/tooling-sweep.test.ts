import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRealRed } from "../scripts/mutation-proof.mjs";
import { parseArgs, resolveUntil } from "../scripts/sweep/main.mjs";
import { scratchDir } from "./temp-root.ts";
import { CANARY_ROW, finishedNames, folderOf, go, makeWorld, outOf, readJson, row, SOURCE, statusOf, summaryOf, sweepFolder, type Call, type World } from "./tooling-sweep-fakes.ts";

test("isRealRed: only exit code 1 with a real AssertionError counts; a crash, a timeout or a leak note does not", () => {
  const assertion = "✖ fails (0.9ms)\n  AssertionError [ERR_ASSERTION]: msg\n      at x";
  assert.equal(isRealRed(1, assertion), true);
  assert.equal(isRealRed(1, `npm warn\n${assertion}\n`), true);
  assert.equal(isRealRed(0, assertion), false, "a passing exit code is never red");
  assert.equal(isRealRed(null, assertion), false, "a timeout has no exit code");
  assert.equal(isRealRed(2, assertion), false, "only node:test's failing-tests code");
  assert.equal(isRealRed(1, "SyntaxError: Unexpected token '='\n✖ b.test.mjs (168ms)"), false, "a syntax error is not an assertion");
  assert.equal(isRealRed(1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'\n✖ b.test.mjs"), false, "an import crash is not an assertion");
  assert.equal(isRealRed(1, "✖ thrower\n  TypeError: boom"), false, "a thrown error is not an assertion");
  assert.equal(isRealRed(1, "LEAK: x-red: .cc-test-* directories remained after the run: .cc-test-a\nAssertionError: not a real report"), false, "the leak note and prose are not an assertion report");
  assert.equal(isRealRed(1, ""), false);
});

test("arguments: defaults, values and every refusal", () => {
  const parsed = parseArgs(["alpha,beta", "--lanes", "2", "--slots", "6", "--until", "7:05", "--out", "C:/somewhere"], "C:/default");
  assert.deepEqual({ ...parsed, out: parsed.out.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "") }, { filters: ["alpha", "beta"], lanes: 2, slots: 6, until: "7:05", out: "/somewhere", resume: null });
  const bare = parseArgs([], "C:/default");
  assert.deepEqual([bare.filters, bare.lanes, bare.slots, bare.until, bare.resume], [[], null, null, null, null], "lanes and slots stay unset so a resume can take them from state.json");
  for (const bad of [["--lanes", "9"], ["--lanes", "1.5"], ["--slots", "0"], ["--until", "24:00"], ["--until", "9"], ["--out"], ["--bogus", "1"], ["a", "b"], ["--resume", "x", "alpha"]]) assert.throws(() => parseArgs(bad, "C:/default"), undefined, bad.join(" "));
});

test("--until: a time ahead of now is today, a time that already passed (or is now) means tomorrow", () => {
  const now = new Date(2026, 9, 30, 22, 0, 0);
  assert.deepEqual(resolveUntil("22:30", now), new Date(2026, 9, 30, 22, 30));
  assert.deepEqual(resolveUntil("21:00", now), new Date(2026, 9, 31, 21, 0));
  assert.deepEqual(resolveUntil("22:00", now), new Date(2026, 9, 31, 22, 0));
  assert.deepEqual(resolveUntil("0:05", now), new Date(2026, 9, 31, 0, 5));
});

// The control row runs second (after the canary), so a hook on its first mutated run lands "between rows 2 and 3" of a one-lane sweep.
const onControlRun = (act: (call: Call, world: World) => void, once = { done: false }) => (call: Call, world: World) => {
  if (!once.done && call.mutated.includes("src/c.js")) { once.done = true; act(call, world); }
  return undefined;
};
const resultNames = (world: World) => Object.keys(statusOf(outOf(world)));

test("a STOP file stops between rows: the row in flight finishes and is recorded, no new row starts, the file is deleted, exit 3 with PAUSED, no catch map", async () => {
  const world = makeWorld(scratchDir(), { behave: onControlRun((call) => writeFileSync(join(folderOf(call), "STOP"), "")) });
  assert.equal(await go(world), 3);
  assert.deepEqual(resultNames(world), ["guard-stale-entry", "control-must-survive"]);
  assert.ok(summaryOf(outOf(world)).startsWith(`PAUSED: 2 of 5 rows finished. Resume: node scripts/mutation-proof.mjs --resume "${sweepFolder(outOf(world))}"`));
  assert.equal(existsSync(join(sweepFolder(outOf(world)), "STOP")), false, "honoured, so deleted: a resume does not stop at once");
  assert.equal(readJson(join(sweepFolder(outOf(world)), "state.json")).parts[0].endReason, "stopped: STOP file");
  assert.equal(existsSync(world.deps.catchMapPath), false);
  assert.deepEqual(world.removedLanes, [0]);
  assert.equal(world.events.at(-1), "unlock");
});

test("a stop after the last row but before the end phase is paused, not complete: every control passes yet no catch map is written", async () => {
  let stopped = false;
  const world = makeWorld(scratchDir(), { behave: (call) => { if (!stopped && call.mutated.includes("src/b.js")) { stopped = true; writeFileSync(join(folderOf(call), "STOP"), ""); } return undefined; } });
  assert.equal(await go(world), 3);
  assert.equal(resultNames(world).length, 5, "every row has a result");
  assert.doesNotMatch(summaryOf(outOf(world)), /FAIL/);
  assert.equal(existsSync(world.deps.catchMapPath), false);
});

test("--until stops between rows once the clock passes it, and prints the resolved deadline at the start", async () => {
  const world = makeWorld(scratchDir(), { behave: onControlRun((_call, w) => { w.clock = new Date(2026, 9, 30, 22, 31); }) });
  assert.equal(await go(world, ["--until", "22:30"]), 3);
  assert.deepEqual(resultNames(world), ["guard-stale-entry", "control-must-survive"], "the row in flight finished and was recorded");
  assert.match(world.logs.join("\n"), /Stops after the rows in flight at .*22:30:00/);
  assert.equal(readJson(join(sweepFolder(outOf(world)), "state.json")).parts[0].endReason, "stopped: --until");
});

test("the first Ctrl-C finishes the row in flight; the second aborts it: its file is restored and the row is not recorded; handlers are removed", async () => {
  const first = makeWorld(scratchDir(), { behave: onControlRun((_call, w) => { w.signals.emit("SIGINT"); }) });
  assert.equal(await go(first), 3);
  assert.deepEqual(resultNames(first), ["guard-stale-entry", "control-must-survive"]);
  assert.match(first.logs.join("\n"), /Ctrl-C: finishing the rows in flight/);
  assert.deepEqual([first.signals.listenerCount("SIGINT"), first.signals.listenerCount("SIGHUP")], [0, 0]);
  for (const hardStop of [["SIGINT", "SIGINT"], ["SIGHUP"]]) {
    const world = makeWorld(scratchDir(), { behave: onControlRun((_call, w) => { for (const signal of hardStop) w.signals.emit(signal); }) });
    assert.equal(await go(world), 3, hardStop.join("+"));
    assert.deepEqual(resultNames(world), ["guard-stale-entry"], "the aborted row stays unfinished for a resume");
    assert.equal(world.lanes[0].files.get("src/c.js"), SOURCE["src/c.js"], "restored");
    assert.equal(world.events.at(-1), "unlock");
  }
});

// Part 1 paused after two rows by a STOP file, then resumed.
async function pausedSweep() {
  let armed = true;
  const mutatedTexts: string[] = [];
  const world = makeWorld(scratchDir(), { behave: (call, w) => { if (call.mutated.includes("src/a.js")) mutatedTexts.push(call.lane.files.get("src/a.js")!); return armed ? onControlRun((c) => writeFileSync(join(folderOf(c), "STOP"), ""))(call, w) : undefined; } });
  assert.equal(await go(world), 3);
  armed = false;
  return { world, folder: sweepFolder(outOf(world)), mutatedTexts };
}
const resumeAgain = (world: World, folder: string, deps: object = {}) => go(world, ["--resume", folder], deps);
const attempt = async (world: World, folder: string, deps: object = {}) => {
  const before = { calls: world.calls.length, lanes: world.lanes.length, state: readFileSync(join(folder, "state.json"), "utf8") };
  const code = await resumeAgain(world, folder, deps);
  assert.equal(world.calls.length, before.calls, "nothing was run");
  assert.equal(world.lanes.length, before.lanes, "no lane was created");
  assert.equal(readFileSync(join(folder, "state.json"), "utf8"), before.state, "state.json untouched");
  assert.equal(world.events.at(-1), "unlock");
  return code;
};

test("resume: skips finished rows, runs its own baseline first, and reported == selected holds only after part 2 (part 1 exits 3 with PAUSED)", async () => {
  const { world, folder, mutatedTexts } = await pausedSweep();
  assert.match(summaryOf(outOf(world)), /FAIL 2\. reported == selected \(2 of 5/);
  const callsBefore = world.calls.length;
  assert.equal(await resumeAgain(world, folder), 0);
  const part2 = world.calls.slice(callsBefore);
  assert.deepEqual([part2[0].files, part2[0].mutated, part2[0].slotsHeld], [null, [], 12], "part 2 starts with its own quiet baseline");
  assert.equal(mutatedTexts.filter((text) => text.includes("let a")).length, 1, "the canary was not run again");
  assert.deepEqual(resultNames(world).sort(), ["control-must-survive", "guard-stale-entry", "r1", "r2", "r3"]);
  assert.match(summaryOf(outOf(world)), /PASS 2\. reported == selected \(5 of 5/);
  assert.match(summaryOf(outOf(world)), /Exit code 0 \(sweep complete\)/);
  const state = readJson(join(folder, "state.json"));
  assert.deepEqual(state.parts.map((part: any) => [part.part, part.endReason]), [[1, "stopped: STOP file"], [2, "finished"]]);
  assert.deepEqual(finishedNames(world).slice(0, 2), ["guard-stale-entry", "control-must-survive"]);
  assert.equal(world.lanes.length, 2, "one lane per part");
});

test("resume refuses, with nothing started, on a different HEAD, a dirty copied path, a row that left the catalogue, or a sweep that is already complete", async () => {
  const { world, folder } = await pausedSweep();
  world.git.head = "b".repeat(40);
  assert.equal(await attempt(world, folder), 1);
  assert.match(world.logs.join("\n"), /REFUSED: HEAD is bbbbbbb but this sweep started at aaaaaaa/);
  world.git.head = "a".repeat(40);
  world.git.dirty = " M src/a.js";
  assert.equal(await attempt(world, folder), 1);
  assert.match(world.logs.join("\n"), /REFUSED: copied paths have uncommitted changes, so the results would mix two trees/);
  world.git.dirty = "";
  const smaller = { ...world.deps.catalogue, mutations: [CANARY_ROW, row("r1")] };
  assert.equal(await attempt(world, folder, { catalogue: smaller }), 1);
  assert.match(world.logs.join("\n"), /REFUSED: rows no longer in the catalogue: r2, r3/);
  assert.equal(await resumeAgain(world, folder), 0, "control: with the tree back, the resume runs");
  assert.equal(await attempt(world, folder), 1);
  assert.match(world.logs.join("\n"), /REFUSED: this sweep is already complete/);
  assert.equal(await go(world, ["--resume", join(world.dir, "nowhere")]), 1, "not a sweep folder");
});
