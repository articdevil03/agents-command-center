import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { join } from "node:path";
import { getProcessDefinition } from "../server/process.ts";
import { importWithTempDataRoot } from "./temp-root.ts";
import { crashCatcherDisabled } from "./crash-catcher.ts";
import * as overlap from "./overlap-helpers.ts";
import { fixture, hookFixture, source, between, cleanupSource } from "./tooling-temp-fixtures.ts";

const ownRoot = "owned-temp";
test("P24 immediate success and absent root never wait", () => {
  const f = fixture(); f.put(ownRoot); f.put(join(ownRoot, "child"), "file");
  assert.equal(f.context.removeWithRetry(ownRoot), true);
  assert.equal(f.entries.has(f.key(ownRoot)), false, "owned directory removed nonrecursively");
  assert.equal(f.context.removeWithRetry(ownRoot), true);
  assert.equal(f.waits.length, 0);
  assert.equal(f.proc.exitCode, undefined);
});

test("P24 budget and retry survive late EPERM and EBUSY", () => {
  for (const code of ["EPERM", "EBUSY", "ENOTEMPTY"]) {
    const f = fixture(); f.put(ownRoot);
    f.fail(() => f.waits.reduce((a, b) => a + b, 0) < 1500 ? code : undefined);
    assert.equal(f.context.removeWithRetry(ownRoot), true, `${code}: clears beyond old 1.2 second window`);
    assert.deepEqual(f.waits, [250, 250, 250, 250, 250, 250]);
    assert.equal(f.entries.has(f.key(ownRoot)), false);
  }
});

test("P24 permanent lock marks exact attempts and unsuccessful exit", () => {
  const f = fixture(); f.put(ownRoot); f.fail(() => "EPERM");
  assert.equal(f.context.removeWithRetry(ownRoot), false);
  assert.equal(f.failedCalls, 41, "41 actual attempts");
  assert.deepEqual(f.waits, Array(40).fill(250), "40 waits and no wait after exhaustion");
  assert.equal(f.proc.exitCode, 1, "failed cleanup makes passing process unsuccessful");
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0], `TEMP_CLEANUP_LEFTOVER: root="${ownRoot}" error=EPERM: fixture EPERM attempts=41`);
});

test("P24 locked child does not stop later siblings from being removed", () => {
  const f = fixture(); f.put(ownRoot);
  const locked = f.put(join(ownRoot, "a-locked"), "file");
  f.put(join(ownRoot, "b-plain"), "file");
  f.put(join(ownRoot, "c-nested")); f.put(join(ownRoot, "c-nested", "inner"), "file");
  assert.equal(f.context.readdirSync(ownRoot)[0], "a-locked", "locked child is listed first");
  f.fail((p) => p === f.key(locked) ? "EPERM" : undefined);
  assert.equal(f.context.removeWithRetry(ownRoot, 3, 0), false);
  assert.equal(f.failedCalls, 3, "locked entry attempted on each of 3 attempts");
  assert.equal(f.proc.exitCode, 1);
  assert.deepEqual(f.logs, [`TEMP_CLEANUP_LEFTOVER: root="${ownRoot}" error=EPERM: fixture EPERM attempts=3`]);
  assert.deepEqual([...f.entries.keys()].sort(), [f.key(ownRoot), f.key(locked)].sort(), "only the root and the locked child remain");
});

test("P24 explicit budget nonretryable errors and prior status", () => {
  for (const code of ["EACCES", "EINVAL", "EPERM"]) {
    const f = fixture(); f.put(ownRoot); f.proc.exitCode = 7; f.fail(() => code);
    assert.equal(f.context.removeWithRetry(ownRoot, 3, 9), false);
    assert.equal(f.failedCalls, code === "EPERM" ? 3 : 1);
    assert.deepEqual(f.waits, code === "EPERM" ? [9, 9] : []);
    assert.equal(f.proc.exitCode, 7, "prior error status preserved");
  }
});

test("P24 linked root refused without touching target or link", () => {
  const f = fixture(); f.put("outside"); f.put("outside/canary", "file", "keep");
  f.put(ownRoot, "link", undefined, "outside");
  assert.equal(f.context.removeWithRetry(ownRoot), false);
  assert.equal(f.proc.exitCode, 1);
  assert.equal(f.entries.has(f.key(ownRoot)), true, "root link refused");
  assert.equal(f.entries.get(f.key("outside/canary"))?.data, "keep");
  assert.deepEqual(f.touched, []);
});

test("P24 nested junction removed as exact link with target preserved", () => {
  const f = fixture(); f.put(ownRoot); f.put("outside"); f.put("outside/canary", "file", "keep");
  const link = join(ownRoot, "junction"); f.put(link, "link", undefined, "outside");
  // Model Windows refusing unlink on a directory junction; rmdir must remove only the link.
  const unlink = f.context.unlinkSync;
  f.context.unlinkSync = (p: string) => { if (f.key(p) === f.key(link)) throw Object.assign(new Error("junction"), { code: "EPERM" }); unlink(p); };
  assert.equal(f.context.removeWithRetry(ownRoot), true);
  assert.equal(f.entries.has(f.key(ownRoot)), false);
  assert.equal(f.entries.has(f.key(link)), false);
  assert.equal(f.entries.get(f.key("outside/canary"))?.data, "keep");
  assert.equal(f.touched.some((p) => p.startsWith(f.key("outside"))), false);
});

for (const allocator of ["tempRoot", "scratchDir"]) {
  test(`P24 ${allocator} registered hook makes failure visible`, () => {
    const f = hookFixture("test/temp-root.ts");
    const dir = f.api[allocator](); f.fail((p) => p === f.key(dir) ? "EPERM" : undefined);
    assert.doesNotThrow(() => { for (const hook of f.hooks) hook(); });
    assert.equal(f.proc.exitCode, 1, `${allocator}: actual after callback reports leftover`);
    assert.ok(f.logs.some((line) => line.includes(`root="${dir}"`)));
  });
}

test("P24 node test child fails after passing body and cleanup hook", () => {
  const f = fixture(); f.put(ownRoot); f.fail(() => "EPERM");
  // Serialize the same real helper and filesystem boundary into an actual node:test child.
  const script = `import test, { after } from "node:test";
const lstatSync = () => { throw Object.assign(new Error("locked"), { code: "EPERM" }); };
${cleanupSource()}
test("body passed", () => { after(() => removeWithRetry("child-owned", 2, 0)); });`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /body passed/);
  assert.match(run.stdout + run.stderr, /TEMP_CLEANUP_LEFTOVER:.*child-owned.*attempts=2/);
});

test("P24 overlap actual callback keeps startup error and unconditional cleanup", async () => {
  const f = fixture();
  Object.assign(f.context, overlap, { getProcessDefinition, once, SERVER_START_MS: 1000, attachCrashCatcher: () => {} });
  f.put(overlap.CHROME, "file");
  let spawned = 0;
  f.context.spawn = () => {
    spawned++;
    const child: any = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), exitCode: 23, signalCode: null, pid: 123 });
    queueMicrotask(() => child.emit("exit", 23)); return child;
  };
  f.fail((p) => p.includes("cc-overlap-") ? "EPERM" : undefined);
  f.evaluate(source("test/overlap.test.ts"));
  assert.equal(f.tests.length, 1, "real overlap callback registered");
  await assert.rejects(f.tests[0].fn({ skip: () => assert.fail("must execute") }), /server exited early \(23\)/, "original startup failure survives");
  assert.equal(spawned, 1, "only fake startup server, no Chrome");
  assert.equal(f.proc.exitCode, 1, "real finally cleanup makes run unsuccessful");
  assert.ok(f.logs.some((line) => line.startsWith("OVERLAP_TEMP_ROOT: ")));
  assert.ok(f.logs.some((line) => line.includes("TEMP_CLEANUP_LEFTOVER:")));
});

for (const [label, file, allocator] of [
  ["pack1", "test/pack1-process.test.ts", "scratch"],
  ["pack2", "test/pack2-process-helpers.ts", "scratch"],
  ] as const) {
  test(`P24 ${label} actual teardown continues after failed root`, async () => {
    const f = hookFixture(file);
    const a = f.api[allocator](), b = f.api[allocator]();
    f.fail((p) => p === f.key(b) ? "EPERM" : undefined);
    for (const hook of f.hooks) await hook();
    assert.equal(f.proc.exitCode, 1, `${label}: failing root reports failure`);
    assert.equal(f.entries.has(f.key(a)), false, `${label}: other root still cleaned`);
    assert.equal(f.entries.has(f.key(b)), true);
  });
}
test("P24 acp actual teardown continues after failed root", async () => {
  const f = hookFixture("test/pack18-acp-worker.test.ts");
  for (let i = 0; i < 2; i++) assert.throws(() => f.api.start("basic"), /allocated:/, "actual allocator reached before fake setup failure");
  const roots = [...f.entries.keys()].filter((p) => p.includes("cc-p18w-"));
  assert.equal(roots.length, 2, "real start allocated two registered log roots");
  f.fail((p) => p === roots[0] ? "EPERM" : undefined);
  for (const hook of f.hooks) await hook();
  assert.equal(f.proc.exitCode, 1, "acp: failing root reports failure");
  assert.equal(f.entries.has(roots[1]), false, "acp: later root cleaned after first failed");
});

for (const label of ["lanes", "run"]) {
  test(`P24 ${label} actual outer scratch teardown`, async () => {
    const f = hookFixture(`test/tooling-sweep-${label}.test.ts`);
    f.fail((p) => p === f.key(f.api.scratch) ? "EPERM" : undefined);
    for (const hook of f.hooks) await hook();
    assert.equal(f.proc.exitCode, 1, `${label}: real outer hook calls cleanup`);
    assert.equal(f.failedCalls, 41);
  });
}

test("P24 health actual preload callback cleans its allocated root", async () => {
  const f = fixture();
  f.context.crashCatcherDisabled = crashCatcherDisabled;
  f.context.LIST_TIMEOUT_MS = 1; f.context.PROBE_MS = 1;
  f.context.source = (file: string) => source(`test/${file}`);
  f.context.process.env = {};
  f.context.spawnSync = () => ({ status: 0, stderr: "" });
  const callback = between(source("test/pack16-health.test.ts"), 'test("pack 16 catcher: the test script', '\n});') + "\n});";
  f.put(join(f.proc.cwd(), "package.json"), "file", JSON.stringify({ scripts: { test: "node --import ./test/crash-catcher-self.ts --test" } }));
  f.evaluate(callback);
  f.fail((p) => p.includes("cc-preload-") ? "EPERM" : undefined);
  await assert.rejects(async () => f.tests[0].fn(), /stall.test.ts ran with no catcher/);
  assert.equal(f.proc.exitCode, 1, "actual preload finally reports failed cleanup");
});

test("P24 any-cli actual generation callback cleans its allocated root", async () => {
  const { modules: { createOpencodeLeader } } = await importWithTempDataRoot(() => import("../server/leader-opencode.ts"));
  const f = fixture(); let closed = 0, sleeps = 0, spawned = 0;
  const bridge = Object.assign(new EventEmitter(), {
    listen() { queueMicrotask(() => bridge.emit("listening")); },
    address: () => ({ port: 1 }), close: () => closed++,
  });
  Object.assign(f.context, {
    createHttpServer: () => bridge, once, createOpencodeLeader,
    sleep: async () => { if (++sleeps === 1) throw new Error("startup body error"); },
    spawn: () => { spawned++; throw new Error("fake spawn refused startup"); },
  });
  const callback = between(source("test/any-cli-final-fixes.test.ts"), 'test("OpenCode leader: a turn that started', '\ntest("OpenCode leader: a question');
  f.evaluate(callback); f.fail((p) => p.includes("cc-gen-") ? "EPERM" : undefined);
  await assert.rejects(f.tests[0].fn(), /startup body error/);
  assert.equal(spawned, 1, "real leader reached fake spawn boundary"); assert.equal(closed, 1);
  assert.equal(f.proc.exitCode, 1, "generation callback real finally calls cleanup");
});

test("P24 icon partial write and setup failure clean whole owned root", async () => {
  for (const cleanupFails of [false, true]) {
    const f = fixture(); f.put("fake-chrome", "file"); f.proc.env.CHROME_PATH = "fake-chrome";
    const read = f.context.readFileSync;
    f.context.readFileSync = (p: string) => p.endsWith("icon-source.svg") ? '<svg viewBox="0 0 64 64"></svg>' : read(p);
    f.context.writeFileSync = (p: string, value: string) => { f.put(p, "file", value); throw new Error("partial write error"); };
    f.context.spawnSync = () => assert.fail("partial write precedes fake Chrome");
    if (cleanupFails) f.fail((p) => p.includes("cc-icon-") ? "EPERM" : undefined);
    await assert.rejects(f.entry("scripts/make-icon.mjs"), /partial write error/, "body error not masked");
    if (cleanupFails) assert.equal(f.proc.exitCode, 1);
    else assert.equal([...f.entries.keys()].some((p) => p.includes("cc-icon-")), false, "partial file and owned root cleaned");
  }
});

test("P24 dist actual success cleanup failure sets local status and releases lock", async () => {
  const f = fixture(); const dir = f.key("dist-owned"), lock = f.key("dist-owned.lock");
  f.proc.env.CC_DIST_DIR_OVERRIDE = dir; f.proc.env.CC_DIST_LOCK_OVERRIDE = lock;
  let spawns = 0;
  f.context.spawn = (_program: string, _args: any, options: any) => {
    spawns++;
    if (spawns === 1) f.put(join(options.env.CC_DIST_BUILD_OUTPUT_DIR, "Command Center.exe"), "file", Buffer.from("verified exe"));
    const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 0)); return child;
  };
  f.fail((p) => p.includes(".cc-dist-stage-") ? "EPERM" : undefined);
  await f.entry("scripts/dist.mjs");
  assert.equal(spawns, 2, "actual build and smoke entry use fake child boundary");
  assert.ok(f.logs.some((line) => line.includes("build verified")), `success branch reached: ${f.logs}`);
  assert.equal(f.proc.exitCode, 1, "final local assignment cannot overwrite failed cleanup");
  assert.equal(f.entries.has(lock), false, "lock released despite failed cleanup");
  assert.ok(f.logs.some((line) => line.includes("TEMP_CLEANUP_LEFTOVER:")), "stage cleanup executed");
});
