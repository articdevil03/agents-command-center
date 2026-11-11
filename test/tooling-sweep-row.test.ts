import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runRow, runEndPhase } from "../scripts/sweep/row.mjs";
import { scratchDir } from "./temp-root.ts";
import { assertion, CANARY_ROW, failure, makeWorld, pass, row, rowContext, SOURCE, type Call, type World } from "./tooling-sweep-fakes.ts";

// Rows are driven through runRow itself; only Block A's boundary (the lane copy, the test run) is faked. A fake run fails iff the mutation is in place
// and the run covers the catching file (a.js is caught by test/a.test.ts), so a row that leaves its mutation behind or runs the wrong files shows up.
const newLane = (world: World) => world.sweep.createLane(world.dir, ["src"], 1);
const isRestored = (call: Call) => call.mutated.length === 0;
const runsLeft = (world: World) => readdirSync(join(world.dir, "runs"));

test("C1 restore call writes pristine bytes before resync can hide an omitted restore", async () => {
  const world = makeWorld(scratchDir());
  const lane = newLane(world);
  const writes: Buffer[] = [];
  const write = world.sweep.writeVerified;
  world.sweep.writeVerified = (l: any, file: string, bytes: Buffer | string) => {
    writes.push(Buffer.from(bytes)); write(l, file, bytes);
  };
  await runRow(rowContext(world), lane, row("r1"));
  assert.equal(writes.length, 2, "mutation and explicit pristine restore both execute");
  assert.deepEqual(writes[1], lane.pristine.get("src/a.js"));
});

test("a catching scoped run is RED: the catching file first with early stop, then that file alone on the restored tree", async () => {
  const world = makeWorld(scratchDir());
  const lane = newLane(world);
  const rec = await runRow(rowContext(world, { catchMap: { r1: "test/a.test.ts" }, targets: { r1: "src/a.js" } }), lane, row("r1"));
  assert.equal(rec.status, "RED");
  assert.deepEqual(rec.catching, { file: "test/a.test.ts", name: "t1", message: "boom" });
  assert.deepEqual(world.calls.map((call) => [call.files, call.red, call.earlyStop]), [[["test/a.test.ts"], true, true], [["test/a.test.ts"], false, false]]);
  assert.deepEqual(rec.runs.map((run: any) => run.kind), ["red-scoped", "restored"]);
  assert.equal(lane.files.get("src/a.js"), SOURCE["src/a.js"], "restored byte for byte");
  assert.deepEqual(runsLeft(world), [], "a RED row keeps no run output");
});

test("with no candidate the whole suite runs first, and its catching file is learned for the next row on the same target", async () => {
  const world = makeWorld(scratchDir());
  const ctx = rowContext(world, { targets: { r1: "src/a.js", r2: "src/a.js", other: "src/b.js" } });
  const lane = newLane(world);
  assert.equal((await runRow(ctx, lane, row("r1"))).status, "RED");
  assert.equal(world.calls[0].files, null, "no candidate: straight to the whole suite");
  assert.equal(world.calls[0].earlyStop, true);
  world.calls.length = 0;
  assert.equal((await runRow(ctx, lane, row("r2"))).status, "RED");
  assert.deepEqual(world.calls[0].files, ["test/a.test.ts"], "the second row on the file runs the learned file scoped first");
  world.calls.length = 0;
  await runRow(ctx, lane, row("other", "src/b.js", "2", "8"));
  assert.equal(world.calls[0].files, null, "a row on another target file learned nothing");
});

test("a scoped run that misses falls back to the whole suite; only the whole suite can catch it then", async () => {
  const world = makeWorld(scratchDir());
  const rec = await runRow(rowContext(world, { catchMap: { r1: "test/elsewhere.test.ts" }, targets: { r1: "src/a.js" } }), newLane(world), row("r1"));
  assert.deepEqual(rec.runs.map((run: any) => [run.kind, run.files, run.outcome]), [["red-scoped", ["test/elsewhere.test.ts"], "pass"], ["red-whole", null, "assertion"], ["restored", ["test/a.test.ts"], "pass"]]);
  assert.equal(rec.status, "RED");
});

test("a whole suite that passes with the mutation in place is SURVIVED and keeps its run output", async () => {
  const world = makeWorld(scratchDir(), { behave: () => pass() });
  const rec = await runRow(rowContext(world), newLane(world), row("r1"));
  assert.equal(rec.status, "SURVIVED");
  assert.equal(rec.catching, null);
  assert.equal(rec.evidence.length, 1);
  assert.ok(existsSync(join(world.dir, rec.evidence[0])), "the log is kept under the sweep folder");
});

test("restored check: pass is RED; fail then a quiet pass is RED and the failing test joins the flake list; fail twice is ERROR", async () => {
  const flaky = { file: "test/a.test.ts", name: "flaky test" };
  const scenario = async (restoredAnswers: any[]) => {
    const world = makeWorld(scratchDir(), { behave: (call) => (isRestored(call) ? restoredAnswers.shift() : undefined) });
    const ctx = rowContext(world);
    const rec = await runRow(ctx, newLane(world), row("r1"));
    return { world, ctx, rec };
  };
  const green = await scenario([pass()]);
  assert.equal(green.rec.status, "RED");
  assert.deepEqual(green.ctx.flakes, []);
  const flake = await scenario([failure("ERR_ASSERTION", { failures: [{ ...flaky, cause: "ERR_ASSERTION", message: "x" }] }), pass()]);
  assert.equal(flake.rec.status, "RED");
  assert.deepEqual(flake.ctx.flakes, [flaky]);
  assert.equal(flake.world.acquired.at(-1), 12, "the re-run is quiet: it holds every slot");
  assert.deepEqual(flake.rec.runs.map((run: any) => run.kind), ["red-whole", "restored", "restored-retry"]);
  assert.ok(flake.rec.evidence.length >= 1 && flake.rec.runs.filter((run: any) => run.log).length === 1, "the failed restored run is kept as flake evidence, the rest is not");
  const twice = await scenario([failure(), failure()]);
  assert.equal(twice.rec.status, "ERROR");
  assert.match(twice.rec.notes.join("\n"), /restored file red twice \(test\/a\.test\.ts\)/);
  assert.equal(twice.rec.catching, null, "an ERROR row has no catching test");
});

test("a leak after a passing restored run is a failure (re-run quietly); a leak both times is ERROR", async () => {
  const leakOn = (leaks: number) => {
    let left = leaks;
    return makeWorld(scratchDir(), { behave: (call) => { if (isRestored(call) && left-- > 0) call.lane.leaked = [".cc-test-x"]; return undefined; } });
  };
  const once = leakOn(1);
  const rec = await runRow(rowContext(once), newLane(once), row("r1"));
  assert.equal(rec.status, "RED");
  assert.equal(once.calls.length, 3, "the leak cost a quiet re-run");
  assert.match(rec.notes.join("\n"), /leaked \.cc-test-x/);
  const both = leakOn(2);
  assert.equal((await runRow(rowContext(both), newLane(both), row("r1"))).status, "ERROR");
});

test("R1 a restored check whose run only wrote top-level app data folders (removed, not leaked) is clean", async () => {
  const world = makeWorld(scratchDir(), { behave: (call) => { if (isRestored(call)) call.lane.removed = ["chats", "logs"]; return undefined; } });
  const rec = await runRow(rowContext(world), newLane(world), row("r1"));
  assert.equal(rec.status, "RED");
  assert.equal(world.calls.length, 2, "no quiet re-run: the restored check was clean");
  assert.match(rec.notes.join("\n"), /pollution: removed chats, logs/);
});

test("a failure that is not an assertion is ERROR, never RED", async () => {
  for (const answer of [failure("TypeError"), { outcome: "timeout", exitCode: null, failures: [], catching: null }, { outcome: "runner-error", exitCode: null, failures: [], catching: null }]) {
    const world = makeWorld(scratchDir(), { behave: () => answer });
    const rec = await runRow(rowContext(world), newLane(world), row("r1"));
    assert.equal(rec.status, "ERROR", answer.outcome);
    assert.match(rec.notes[0], new RegExp(`whole-suite run ended ${answer.outcome}`));
    assert.equal(world.calls.length, 1, "no restored check for a row that never caught");
  }
});

test("a mutation that breaks parsing is ERROR with no red run and the file never touched; a missing or doubled target is ERROR too", async () => {
  const world = makeWorld(scratchDir());
  const lane = newLane(world);
  const ctx = rowContext(world);
  const broken = await runRow(ctx, lane, row("broken", "src/a.js", "1", "BROKEN"));
  assert.match(broken.notes[0], /broken: the mutation leaves src\/a\.js unparseable/);
  assert.equal((await runRow(ctx, lane, row("gone", "src/a.js", "NOT THERE", "x"))).notes[0], "gone: mutation target missing");
  const doubled = makeWorld(scratchDir(), { source: { "src/a.js": "x x\n" } });
  assert.match((await runRow(rowContext(doubled), newLane(doubled), row("twice", "src/a.js", "x", "y"))).notes[0], /twice: mutation target matches 2 times in src\/a\.js/);
  assert.equal((await runRow(ctx, lane, row("nofile", "src/none.js", "1", "2"))).status, "ERROR");
  assert.equal(world.calls.length, 0, "no run was started for any of them");
  assert.equal(lane.files.get("src/a.js"), SOURCE["src/a.js"]);
});

test("the canary's run is not red-flagged, every other row's red run is; $ patterns land literally; the pollution a run left is put back", async () => {
  const seen: string[] = [];
  const world = makeWorld(scratchDir(), { behave: (call) => { if (!isRestored(call)) seen.push(call.lane.files.get("src/a.js")!); if (call.mutated.length) call.lane.files.set("src/b.js", "polluted"); return undefined; } });
  const lane = newLane(world);
  const ctx = rowContext(world);
  const canary = await runRow(ctx, lane, CANARY_ROW);
  assert.equal(world.calls[0].red, false, "the canary's red run uses CC_MUTATION_PROOF empty");
  assert.equal(canary.status, "RED");
  world.calls.length = 0;
  const dollars = "$& $$ $' $`";
  const rec = await runRow(ctx, lane, row("dollars", "src/a.js", "1", dollars));
  assert.equal(world.calls[0].red, true);
  assert.equal(seen.at(-1), `const a = ${dollars};\n`);
  assert.equal(lane.files.get("src/b.js"), SOURCE["src/b.js"], "the lane is re-synced after the row");
  assert.match(rec.notes.join("\n"), /pollution: recopied src\/b\.js/);
});

test("an aborted run restores and re-syncs the lane and the row is not recorded", async () => {
  const world = makeWorld(scratchDir(), { behave: (call) => (call.mutated.length ? { outcome: "aborted", exitCode: null, failures: [], catching: null } : undefined) });
  const lane = newLane(world);
  assert.equal(await runRow(rowContext(world), lane, row("r1")), null);
  assert.equal(lane.files.get("src/a.js"), SOURCE["src/a.js"]);
  assert.equal(world.resyncs.length, 1);
});

// A finished row to re-check: the first row's own run decides how it ended.
async function finished(world: World, ctx: ReturnType<typeof rowContext>, lane: any, name = "r1") {
  const rec = await runRow(ctx, lane, row(name));
  return { entries: new Map([[name, row(name)]]), finals: new Map([[name, rec]]), rec };
}
const endPhase = async (world: World, ctx: any, lane: any, state: any, flakes: any[], shouldStop = () => false) => {
  const recorded: any[] = [];
  await runEndPhase(ctx, lane, { ...state, flakes, record: (rec: any) => recorded.push(rec), shouldStop });
  return recorded;
};

test("flake re-check: a RED whose catching test is on the flake list is re-run quietly, catching file only; still caught stays RED", async () => {
  const world = makeWorld(scratchDir());
  const ctx = rowContext(world);
  const lane = newLane(world);
  const state = await finished(world, ctx, lane);
  world.calls.length = 0;
  const [next] = await endPhase(world, ctx, lane, state, [{ file: "test/a.test.ts", name: "t1" }]);
  assert.equal(next.status, "RED");
  assert.equal(next.endChecked, true);
  assert.deepEqual(world.calls.map((call) => [call.files, call.earlyStop, call.slotsHeld]), [[["test/a.test.ts"], true, 12]]);
  assert.match(next.notes.join("\n"), /flake re-check: caught again when quiet/);
  const other = await endPhase(world, ctx, lane, state, [{ file: "test/a.test.ts", name: "another test" }]);
  assert.deepEqual(other, [], "a catching test that is not a known flake is not re-checked");
  assert.deepEqual(await endPhase(world, ctx, lane, state, [{ file: "test/a.test.ts", name: "t1" }], () => true), [], "a stop request skips the end phase");
});

test("flake re-check that no longer fails redoes the row from the whole suite, quietly: assertion RED, pass SURVIVED, anything else ERROR", async () => {
  for (const [whole, expected] of [[assertion("test/b.test.ts"), "RED"], [pass(), "SURVIVED"], [failure(), "ERROR"]] as const) {
    let recheck = false;
    const world = makeWorld(scratchDir(), { behave: (call) => { if (call.files && call.mutated.length) return pass(); if (call.files === null && recheck) return whole; return undefined; } });
    const ctx = rowContext(world, { catchMap: { r1: "test/a.test.ts" }, targets: { r1: "src/a.js" } });
    const lane = newLane(world);
    const state = await finished(world, ctx, lane);
    world.calls.length = 0;
    recheck = true;
    const [next] = await endPhase(world, ctx, lane, state, [{ file: "test/a.test.ts", name: "t1" }]);
    assert.equal(state.rec.status, "RED", "first pass: scoped miss, whole suite catches");
    assert.equal(next.status, expected, `whole suite ${whole.outcome}`);
    assert.deepEqual(world.calls.map((call) => [call.files, call.slotsHeld]), [[["test/a.test.ts"], 12], [null, 12]]);
  }
});

test("survivor re-check: one quiet whole-suite run; pass stays SURVIVED, an assertion is RED 'caught only when quiet', anything else ERROR", async () => {
  for (const [answer, expected, quietOnly] of [[pass(), "SURVIVED", undefined], [assertion("test/a.test.ts"), "RED", true], [failure(), "ERROR", undefined]] as const) {
    let first = true;
    const world = makeWorld(scratchDir(), { behave: () => { if (first) { first = false; return pass(); } return answer; } });
    const ctx = rowContext(world);
    const lane = newLane(world);
    const state = await finished(world, ctx, lane);
    assert.equal(state.rec.status, "SURVIVED");
    const [next] = await endPhase(world, ctx, lane, state, []);
    assert.equal(next.status, expected);
    assert.equal(next.quietOnly, quietOnly);
    assert.equal(next.endChecked, true);
    if (quietOnly) assert.match(next.notes.join("\n"), /caught only when quiet/);
    assert.deepEqual([world.calls.at(-1)!.files, world.calls.at(-1)!.earlyStop, world.calls.at(-1)!.slotsHeld], [null, true, 12]);
    assert.equal(lane.files.get("src/a.js"), SOURCE["src/a.js"], "the mutation is taken out again");
  }
});
