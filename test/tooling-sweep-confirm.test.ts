import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRow, runEndPhase } from "../scripts/sweep/row.mjs";
import { scratchDir } from "./temp-root.ts";
import { assertion, CANARY_ROW, failure, folderOf, go, makeWorld, outOf, pass, readJson, results, row, rowContext, SOURCE, summaryOf, sweepFolder } from "./tooling-sweep-fakes.ts";

const catching = { file: "test/a.test.ts", name: "t1" };
const laneOf = (world: any) => world.sweep.createLane(world.dir, ["src"], 1);
const isConfirm = (call: any) => call.logPath.endsWith("-red-confirm.log");
async function end(ctx: any, lane: any, prior: any, flakes: any[] = []) {
  const records: any[] = [];
  await runEndPhase(ctx, lane, { entries: new Map([[prior.name, row(prior.name)]]), finals: new Map([[prior.name, prior]]), flakes: new Map(flakes.map((f) => [`${f.file}\n${f.name}`, f])), record: (rec: any) => records.push(rec), shouldStop: () => false });
  return records[0];
}

test("P23 stable scoped and whole catches confirm exactly once while mutated, before restored validation and learning", async () => {
  for (const scoped of [false, true]) {
    const world = makeWorld(scratchDir());
    const ctx = rowContext(world, scoped ? { catchMap: { r1: catching.file } } : {});
    const lane = laneOf(world);
    const rec = await runRow(ctx, lane, row("r1"));
    assert.equal(rec.status, "RED");
    assert.deepEqual(rec.runs.map((r: any) => r.kind), [scoped ? "red-scoped" : "red-whole", "red-confirm", "restored"]);
    const confirm = world.calls[1];
    assert.deepEqual([confirm.files, confirm.earlyStop, confirm.concurrency, confirm.slotsHeld, confirm.mutated], [[catching.file], true, 1, 1, ["src/a.js"]]);
    assert.deepEqual(rec.runs[1].catching, catching, "confirmation metadata records the actual catching identity");
    assert.deepEqual(world.calls[2].mutated, []);
    assert.equal(lane.files.get("src/a.js"), SOURCE["src/a.js"]);
    assert.equal(ctx.learned.get("src/a.js")?.get(catching.file), 1);
  }
});

test("P23 same identity confirms even with a different message; canary confirmation keeps red=false", async () => {
  const world = makeWorld(scratchDir(), { behave: (call) => isConfirm(call) ? assertion(catching.file, catching.name, { failures: [{ ...catching, cause: "ERR_ASSERTION", message: "changed" }] }) : undefined });
  const rec = await runRow(rowContext(world), laneOf(world), CANARY_ROW);
  assert.equal(rec.status, "RED");
  assert.deepEqual(world.calls.map((c) => c.red), [false, false, false]);
});

for (const [label, second] of [
  ["pass", pass()],
  ["same file different test", assertion(catching.file, "another")],
  ["same test different file", assertion("test/b.test.ts", catching.name)],
] as const) {
  test(`P23 inconsistent ${label} is provisional SURVIVED with flakes, evidence and no learning for the following row`, async () => {
    const world = makeWorld(scratchDir(), { behave: (call) => isConfirm(call) ? second : undefined });
    const ctx = rowContext(world);
    const lane = laneOf(world);
    const rec = await runRow(ctx, lane, row("r1"));
    assert.equal(rec.status, "SURVIVED");
    assert.equal(rec.catching, null);
    assert.equal(rec.quietOnly, undefined);
    assert.deepEqual(ctx.flakes, second.catching ? [catching, second.catching] : [catching]);
    assert.equal(rec.evidence.length, 2);
    for (const path of rec.evidence) assert.ok(existsSync(join(world.dir, path)));
    assert.match(rec.notes.join("\n"), /confirmation mismatch/);
    assert.equal(ctx.learned.size, 0);
    const before = world.calls.length;
    await runRow(ctx, lane, row("r2"));
    assert.equal(world.calls[before].files, null, "a false catch never teaches the following row");
  });
}

test("P23 provisional survivor resolves quietly to SURVIVED or confirmed RED or inconsistent ERROR", async () => {
  for (const resolution of ["pass", "confirmed", "inconsistent"]) {
    let phase = false;
    const world = makeWorld(scratchDir(), { behave: (call) => {
      if (!phase) return isConfirm(call) ? pass() : undefined;
      return resolution === "pass" || (resolution === "inconsistent" && isConfirm(call)) ? pass() : undefined;
    } });
    const ctx = rowContext(world);
    const lane = laneOf(world);
    const prior = await runRow(ctx, lane, row("r1"));
    assert.equal(prior.status, "SURVIVED");
    phase = true;
    const before = world.calls.length;
    const rec = await end(ctx, lane, prior);
    assert.equal(rec.status, resolution === "pass" ? "SURVIVED" : resolution === "confirmed" ? "RED" : "ERROR");
    assert.equal(rec.endChecked, true);
    assert.equal(rec.quietOnly, resolution === "confirmed" ? true : undefined);
    const calls = world.calls.slice(before);
    assert.equal(calls.filter(isConfirm).length, resolution === "pass" ? 0 : 1);
    assert.ok(calls.every((c) => c.slotsHeld === 12));
    if (resolution !== "pass") assert.deepEqual([calls[1].files, calls[1].concurrency], [[catching.file], 1]);
    if (resolution === "inconsistent") {
      assert.equal(rec.catching, null);
      assert.equal(rec.evidence.length, 4);
    }
    assert.equal(lane.files.get("src/a.js"), SOURCE["src/a.js"]);
  }
});

test("P23 both flaky end-phase paths confirm once and reserve all slots", async () => {
  for (const fallback of [false, true]) {
    let phase = false;
    const world = makeWorld(scratchDir(), { behave: (call) => phase && fallback && call.logPath.endsWith("-flake-recheck.log") ? pass() : undefined });
    const ctx = rowContext(world);
    const lane = laneOf(world);
    const prior = await runRow(ctx, lane, row("r1"));
    phase = true;
    const before = world.calls.length;
    const rec = await end(ctx, lane, prior, [catching]);
    assert.equal(rec.status, "RED");
    assert.deepEqual(rec.runs.slice(prior.runs.length).map((r: any) => r.kind), fallback ? ["flake-recheck", "flake-recheck-whole", "red-confirm"] : ["flake-recheck", "red-confirm"]);
    const calls = world.calls.slice(before);
    assert.ok(calls.every((c) => c.slotsHeld === 12));
    assert.deepEqual(calls.at(-1)!.mutated, ["src/a.js"]);
  }
});

test("P23 confirmation timeout, runner error, non-assertion and abort restore the lane", async () => {
  for (const answer of [failure(), pass({ outcome: "timeout" }), pass({ outcome: "runner-error" }), pass({ outcome: "aborted" })]) {
    const world = makeWorld(scratchDir(), { behave: (call) => isConfirm(call) ? answer : undefined });
    const ctx = rowContext(world);
    const lane = laneOf(world);
    const rec = await runRow(ctx, lane, row("r1"));
    if (answer.outcome === "aborted") assert.equal(rec, null);
    else {
      assert.equal(rec.status, "ERROR");
      assert.match(rec.notes.join("\n"), new RegExp(`confirmation ended ${answer.outcome}`));
      assert.equal(rec.evidence.length, 2);
    }
    assert.equal(lane.files.get("src/a.js"), SOURCE["src/a.js"]);
    assert.equal(ctx.learned.size, 0);
    assert.deepEqual(ctx.flakes, []);
  }
});

test("P23 end phase checks a later RED against flakes added by an earlier quiet confirmation", async () => {
  const world = makeWorld(scratchDir(), { rows: [CANARY_ROW, row("r1"), row("r2", "src/b.js", "2", "8")], behave: (call) => {
    if (call.logPath.endsWith("-r1-restored.log")) return assertion(catching.file);
    if (!call.mutated.includes("src/a.js") || call.lane.files.get("src/a.js")!.includes("let a")) return undefined;
    if (isConfirm(call) && call.slotsHeld === 12) return assertion("test/b.test.ts");
    return undefined;
  } });
  assert.equal(await go(world), 1, "an inconsistent quiet pair remains an ERROR");
  const records = results(outOf(world));
  assert.equal(records.find((r) => r.name === "r1")!.status, "ERROR");
  assert.equal(records.find((r) => r.name === "r2")!.endChecked, true, "R2 is end-checked in the same pass after X2 becomes a flake");
  assert.equal(records.find((r) => r.name === "r2")!.status, "RED");
  assert.match(summaryOf(outOf(world)), /Exit code 1 \(sweep complete\)/);
  assert.equal(readJson(world.deps.catchMapPath).r2, "test/b.test.ts");
});

test("P23 main reports flakes, preserves inconsistent logs and excludes false catches from the map", async () => {
  const world = makeWorld(scratchDir(), { rows: [CANARY_ROW, row("false", "src/b.js", "2", "8")], behave: (call) => call.mutated.includes("src/b.js") && (isConfirm(call) || call.logPath.endsWith("-survivor-recheck.log")) ? pass() : undefined });
  assert.equal(await go(world), 1);
  const rec = results(outOf(world)).find((r) => r.name === "false")!;
  assert.equal(rec.status, "SURVIVED");
  assert.equal(rec.catching, null);
  assert.equal(rec.evidence.length, 3);
  for (const path of rec.evidence) assert.ok(existsSync(join(sweepFolder(outOf(world)), path)));
  assert.match(summaryOf(outOf(world)), /Flake list \(1\): test\/b.test.ts :: t1/);
  assert.equal(readJson(world.deps.catchMapPath).false, undefined);
  assert.deepEqual(rec.runs[1].catching, null);
});

test("P23 pause before end phase then resume resolves the false candidate without learning it", async () => {
  let resumed = false;
  const world = makeWorld(scratchDir(), { rows: [CANARY_ROW, row("false", "src/b.js", "2", "8")], behave: (call) => {
    if (!call.mutated.includes("src/b.js")) return undefined;
    if (resumed) return pass();
    if (isConfirm(call)) { writeFileSync(join(folderOf(call), "STOP"), ""); return pass(); }
    return undefined;
  } });
  assert.equal(await go(world), 3);
  const folder = sweepFolder(outOf(world));
  const first = results(outOf(world)).find((r) => r.name === "false")!;
  assert.equal(first.status, "SURVIVED");
  assert.equal(first.catching, null);
  assert.equal(existsSync(world.deps.catchMapPath), false);
  resumed = true;
  const before = world.calls.length;
  assert.equal(await go(world, ["--resume", folder]), 1);
  assert.ok(world.calls.slice(before).filter((c) => c.mutated.includes("src/b.js")).every((c) => c.files === null));
  assert.equal(results(outOf(world)).find((r) => r.name === "false")!.endChecked, true);
  assert.equal(readJson(world.deps.catchMapPath).false, undefined);
  assert.match(readFileSync(join(folder, "results.jsonl"), "utf8"), /"type":"flake"/);
});

test("P23 transient control catch recovers while repeatedly confirmed control catches report BROKEN", async () => {
  for (const stable of [false, true]) {
    let seen = false;
    const world = makeWorld(scratchDir(), { rows: [CANARY_ROW], behave: (call) => {
      if (!call.mutated.includes("src/c.js")) return undefined;
      if (stable || !seen) { seen = true; return assertion(catching.file); }
      return pass();
    } });
    assert.equal(await go(world), stable ? 1 : 0);
    const summary = summaryOf(outOf(world));
    if (stable) assert.match(summary, /BROKEN/); else {
      assert.doesNotMatch(summary, /BROKEN/);
      assert.match(summary, /Flake list \(1\)/);
      assert.equal(results(outOf(world)).find((r) => r.name === "control-must-survive")!.status, "SURVIVED");
    }
  }
});
