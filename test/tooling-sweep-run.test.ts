import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fakeRun } from "./tooling-sweep-run-fakes.ts";
import { runTests, SWEEP_PRIORITY, lowerOwnPriority } from "../scripts/sweep/run.mjs";

// A fake lane in the OS temp dir: the run only needs dir (cwd), temp (TEMP/TMP) and the empty --import file; fixture test files are written per test.
const REAL_TMP = tmpdir();
const scratch = mkdtempSync(join(REAL_TMP, "cc-run-test-"));
after(() => { removeWithRetry(scratch); });

function fakeLane() {
  const dir = mkdtempSync(join(scratch, "lane-"));
  const temp = mkdtempSync(join(scratch, "temp-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "crash-catcher-self.ts"), "");
  return { index: 1, dir, temp, source: scratch, copiedPaths: [], pristine: new Map(), hashes: new Map(), tracked: new Map() };
}
const addFile = (lane: { dir: string }, name: string, body: string) => writeFileSync(join(lane.dir, "test", name), `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { spawn } from "node:child_process";\nimport { existsSync, writeFileSync } from "node:fs";\nimport os from "node:os";\n${body}`);
const options = (lane: ReturnType<typeof fakeLane>, files: string[] | null, extra: object = {}) => ({ lane, files, red: false, earlyStop: true, timeoutMs: 60_000, concurrency: 4, logPath: join(lane.temp, "run.log"), ...extra });

const FAILS_ASSERTION = `test("catches", () => assert.equal(1, 2));`;
const PASSES = `test("fine", () => {});`;
const THROWS_TYPE_ERROR = `test("thrower", () => { throw new TypeError("boom"); });`;
const CRASHES_AT_LOAD = `throw new Error("crash at load");`;
// The watchdog is a failure, never a successful natural completion.
const PENDING = `
async function pending(name) {
  const marker = (suffix) => process.env.TEMP + "/" + name + "-" + suffix;
  writeFileSync(marker("ready"), "1");
  for (let i = 0; i < 600; i++) {
    if (existsSync(marker("release"))) { writeFileSync(marker("completed"), "1"); return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  writeFileSync(marker("expired"), "1");
  assert.fail(name + " fixture watchdog expired before release");
}`;
const SLEEPS_PENDING = `${PENDING} test("slow", () => pending("slow"));`;
const PASSES_AFTER_2S = `test("late pass", async () => { await new Promise((r) => setTimeout(r, 2000)); });`;
const HOLDER = `const fs = require("fs"); fs.writeFileSync(process.env.TEMP + "/holder-started", "1"); setTimeout(() => { fs.writeFileSync(process.env.TEMP + "/holder-expired", "1"); process.exit(1); }, 60000);`;
const SLEEPS_WITH_HOLDER = `${PENDING} test("slow with a child", async () => {
  const holder = spawn(process.execPath, ["-e", ${JSON.stringify(HOLDER)}], { stdio: "ignore" });
  writeFileSync(process.env.TEMP + "/holder-pid", String(holder.pid));
  await pending("slow");
});`;
const LEAVES_ORPHAN_HOLDER = `${PENDING} test("leaves an orphan", async () => {
  const holder = spawn(process.execPath, ["-e", ${JSON.stringify(HOLDER)}], { stdio: "ignore", detached: true });
  holder.unref();
  writeFileSync(process.env.TEMP + "/orphan-pid", String(holder.pid));
  await pending("orphan");
});`;
const FAILS_ONCE_HOLDER_RUNS = `test("catches once the holder runs", async () => {
  for (let i = 0; i < 600 && !existsSync(process.env.TEMP + "/holder-started"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(existsSync(process.env.TEMP + "/holder-started"), true, "holder readiness exhausted");
  assert.equal(1, 2);
});`;
async function waitForReady(check: () => boolean, label: string) {
  for (let i = 0; i < 600; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${label}: readiness exhausted`);
}
const release = (lane: ReturnType<typeof fakeLane>, name: string) => writeFileSync(join(lane.temp, `${name}-release`), "go");
const notExpired = (lane: ReturnType<typeof fakeLane>, name: string) => assert.equal(existsSync(join(lane.temp, `${name}-expired`)), false, `${name}: watchdog must not expire`);
const stillPending = (lane: ReturnType<typeof fakeLane>, name: string) => {
  notExpired(lane, name);
  assert.equal(existsSync(join(lane.temp, `${name}-completed`)), false, `${name}: fixture was not released`);
};

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; } };

test("early stop: the first real assertion kills the run, names the catching test, and leaves no process of the lane behind", { skip: process.platform !== "win32" }, async () => {
  const lane = fakeLane();
  addFile(lane, "a-fails.test.mjs", FAILS_ONCE_HOLDER_RUNS);
  addFile(lane, "b-slow.test.mjs", SLEEPS_WITH_HOLDER);
  const result = await runTests(options(lane, ["test/a-fails.test.mjs", "test/b-slow.test.mjs"], { concurrency: 2 }));
  const holderPid = Number(readFileSync(join(lane.temp, "holder-pid"), "utf8"));
  // Independent evidence only: a read-only Win32_Process query (SELECT and print), never piped into a stop.
  const strays = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains('${lane.dir}') -or $_.CommandLine.Contains('${lane.temp}')) } | Select-Object ProcessId, CommandLine | Format-List`], { encoding: "utf8", windowsHide: true });
  console.log(`LIVE PROBE: outcome=${result.outcome} ms=${result.ms} exitCode=${result.exitCode} catching=${JSON.stringify(result.catching)}; holder pid ${holderPid} alive=${isAlive(holderPid)}; strays after return (read-only query): ${JSON.stringify(strays.stdout.trim())}`);
  assert.equal(existsSync(join(lane.temp, "holder-started")), true, "the holder was running when the failure arrived");
  assert.equal(result.outcome, "assertion");
  assert.equal(result.stoppedEarly, true);
  assert.deepEqual(result.catching, { file: "test/a-fails.test.mjs", name: "catches once the holder runs" });
  assert.equal(existsSync(join(lane.temp, "slow-ready")), true, "pending fixture started");
  stillPending(lane, "slow");
  notExpired(lane, "holder");
  // No exitCode check: the 5 s give-up can return null under load; P25 in tooling-sweep-run-order.test.ts proves kill ordering with a virtual clock.
  assert.equal(isAlive(holderPid), false, "the holder the test file started is gone");
  assert.equal(strays.status, 0);
  assert.equal(strays.stdout.trim(), "", "no process whose command line holds the lane folder or its temp");
});

test("a process a test file leaves running after the file ended is stopped when the run ends", { skip: process.platform !== "win32" }, async () => {
  const lane = fakeLane();
  addFile(lane, "orphan.test.mjs", LEAVES_ORPHAN_HOLDER);
  const running = runTests(options(lane, ["test/orphan.test.mjs"]));
  let orphanPid = 0;
  try {
    await waitForReady(() => existsSync(join(lane.temp, "orphan-pid")), "orphan PID publication");
    orphanPid = Number(readFileSync(join(lane.temp, "orphan-pid"), "utf8"));
    await waitForReady(() => lane.tracked.has(orphanPid) && existsSync(join(lane.temp, "holder-started")), "orphan discovery by the real poller");
    assert.equal(isAlive(orphanPid), true, "holder was live before releasing its parent");
  } finally { release(lane, "orphan"); await running; }
  const result = await running;
  assert.equal(result.outcome, "pass");
  assert.notEqual(result.exitCode, null);
  assert.equal(existsSync(join(lane.temp, "orphan-completed")), true, "parent observed release");
  notExpired(lane, "orphan"); notExpired(lane, "holder");
  assert.equal(isAlive(orphanPid), false, "the holder that outlived its test file is gone");
});

test("a failure that is not an assertion never stops the run early and never makes the outcome 'assertion'", async () => {
  for (const [label, body] of [["TypeError", THROWS_TYPE_ERROR], ["crash at load", CRASHES_AT_LOAD]] as const) {
    const lane = fakeLane();
    addFile(lane, "a-bad.test.mjs", body);
    addFile(lane, "b-late.test.mjs", PASSES_AFTER_2S);
    const result = await runTests(options(lane, ["test/a-bad.test.mjs", "test/b-late.test.mjs"], { concurrency: 2 }));
    assert.equal(result.outcome, "failure", label);
    assert.equal(result.stoppedEarly, false, label);
    assert.equal(result.catching, null, label);
    assert.ok(result.failures.length >= 1 && result.failures.every((failure) => failure.cause !== "ERR_ASSERTION"), label);
    assert.ok("test/b-late.test.mjs" in result.fileMs, `${label}: the run went on to the end and the late file finished`);
  }
});

test("with earlyStop off the run goes to the end even after an assertion; the outcome is still 'assertion'", async () => {
  const lane = fakeLane();
  addFile(lane, "a-fails.test.mjs", FAILS_ASSERTION);
  addFile(lane, "b-late.test.mjs", PASSES_AFTER_2S);
  const result = await runTests(options(lane, ["test/a-fails.test.mjs", "test/b-late.test.mjs"], { earlyStop: false, concurrency: 2 }));
  assert.equal(result.outcome, "assertion");
  assert.equal(result.stoppedEarly, false);
  assert.deepEqual(Object.keys(result.fileMs).sort(), ["test/a-fails.test.mjs", "test/b-late.test.mjs"], "every file finished, with its time");
  assert.deepEqual(result.catching, { file: "test/a-fails.test.mjs", name: "catches" });
  assert.match(readFileSync(result.logPath, "utf8"), /catches/, "the human-readable log holds the spec output");
});

test("an assertion and a TypeError together: assertion wins; a clean run is 'pass'; the file time is lane-relative with forward slashes", async () => {
  const lane = fakeLane();
  addFile(lane, "a.test.mjs", `${FAILS_ASSERTION}\n${THROWS_TYPE_ERROR}`);
  const mixed = await runTests(options(lane, ["test/a.test.mjs"], { earlyStop: false }));
  assert.equal(mixed.outcome, "assertion");
  assert.deepEqual(mixed.failures.map((failure) => failure.cause).sort(), ["ERR_ASSERTION", "ERR_TEST_FAILURE"]);
  assert.match(mixed.failures.find((failure) => failure.cause === "ERR_ASSERTION")!.message, /Expected values to be strictly equal/);
  const cleanLane = fakeLane();
  addFile(cleanLane, "ok.test.mjs", PASSES);
  const clean = await runTests(options(cleanLane, ["test/ok.test.mjs"]));
  assert.equal(clean.outcome, "pass");
  assert.equal(clean.exitCode, 0);
  assert.deepEqual(Object.keys(clean.fileMs), ["test/ok.test.mjs"]);
  assert.ok(clean.fileMs["test/ok.test.mjs"] >= 0);
});

test("files = null runs the whole suite glob test/*.test.ts", async () => {
  const lane = fakeLane();
  writeFileSync(join(lane.dir, "test", "one.test.ts"), `import test from "node:test";\ntest("one", () => {});\n`);
  writeFileSync(join(lane.dir, "test", "two.test.ts"), `import test from "node:test";\ntest("two", () => {});\n`);
  const result = await runTests(options(lane, null));
  assert.equal(result.outcome, "pass");
  assert.deepEqual(Object.keys(result.fileMs).sort(), ["test/one.test.ts", "test/two.test.ts"]);
});

test("red sets CC_MUTATION_PROOF for the test processes, and CC_DATA_DIR from the parent never reaches them", async () => {
  const lane = fakeLane();
  addFile(lane, "env.test.mjs", `test("env", () => { assert.equal(process.env.CC_MUTATION_PROOF, process.env.EXPECTED_PROOF); assert.equal(process.env.CC_DATA_DIR, undefined); assert.equal(process.env.TEMP, process.env.EXPECTED_TEMP); });`);
  process.env.CC_DATA_DIR = "must-not-leak";
  try {
    for (const red of [false, true]) {
      process.env.EXPECTED_PROOF = red ? "1" : "";
      process.env.EXPECTED_TEMP = lane.temp;
      const result = await runTests(options(lane, ["test/env.test.mjs"], { red }));
      assert.equal(result.outcome, "pass", `red=${red}: ${JSON.stringify(result.failures)}`);
    }
  } finally { delete process.env.CC_DATA_DIR; delete process.env.EXPECTED_PROOF; delete process.env.EXPECTED_TEMP; }
});

test("a run past timeoutMs is tree-killed and reported as 'timeout', never as pass or assertion", async () => {
  const lane = fakeLane();
  addFile(lane, "slow.test.mjs", SLEEPS_PENDING);
  const result = await runTests(options(lane, ["test/slow.test.mjs"], { timeoutMs: 1500 }));
  assert.equal(result.outcome, "timeout");
  assert.equal(result.stoppedEarly, false);
  stillPending(lane, "slow");
  assert.ok(lane.tracked.size > 0, "owned processes were actually discovered");
  assert.ok([...lane.tracked.keys()].every((pid) => !isAlive(pid)), "all discovered owned processes are gone");
});

test("abort: the signal tree-kills the run at once as 'aborted'; an already-aborted signal never spawns", async () => {
  const lane = fakeLane();
  addFile(lane, "slow.test.mjs", SLEEPS_PENDING);
  const controller = new AbortController();
  const running = runTests(options(lane, ["test/slow.test.mjs"], { signal: controller.signal }));
  try {
    await waitForReady(() => existsSync(join(lane.temp, "slow-ready")), "abort fixture");
    controller.abort();
  } finally { controller.abort(); await running; }
  const result = await running;
  stillPending(lane, "slow");
  assert.ok(lane.tracked.size > 0, "owned processes were actually discovered");
  assert.ok([...lane.tracked.keys()].every((pid) => !isAlive(pid)), "all discovered owned processes are gone");
  assert.equal(result.outcome, "aborted");
  const never = await runTests(options(lane, ["test/slow.test.mjs"], { signal: AbortSignal.abort() }));
  assert.equal(never.outcome, "aborted");
  assert.equal(never.exitCode, null);
  assert.equal(existsSync(never.logPath.replace("run.log", "never.log")), false);
});

test("a spawn that fails is 'runner-error'", async () => {
  const lane = fakeLane();
  const result = await runTests(options({ ...lane, dir: join(lane.dir, "does-not-exist") }, ["test/x.test.mjs"]));
  assert.equal(result.outcome, "runner-error");
});

test("priority: the sweep and every test process under it run below normal, seen from inside and from outside", { skip: process.platform !== "win32" }, async () => {
  assert.equal(SWEEP_PRIORITY, 10);
  const lane = fakeLane();
  addFile(lane, "priority.test.mjs", `${PENDING} test("reports its own priority", async () => {
  writeFileSync(process.env.TEMP + "/priority.json", JSON.stringify({ pid: process.pid, inside: os.getPriority(0) }));
  await pending("priority");
});`);
  const running = runTests(options(lane, ["test/priority.test.mjs"]));
  const marker = join(lane.temp, "priority.json");
  try {
    await waitForReady(() => existsSync(marker) && existsSync(join(lane.temp, "priority-ready")), "priority fixture");
    const { pid, inside } = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(isAlive(pid), true, "priority fixture is held live for the outside query");
    const query = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).PriorityClass`], { encoding: "utf8", windowsHide: true });
    assert.equal(query.status, 0, query.stderr);
    assert.equal(inside, 10, "os.getPriority(0) inside the per-file process");
    assert.equal(query.stdout.trim(), "BelowNormal", "outside priority while held live");
  } finally { release(lane, "priority"); await running; }
  assert.equal((await running).outcome, "pass");
  assert.equal(existsSync(join(lane.temp, "priority-completed")), true, "fixture observed release");
  notExpired(lane, "priority");
});

test("lowerOwnPriority puts the sweep process itself at below normal and says so", { skip: process.platform !== "win32" }, () => {
  assert.equal(lowerOwnPriority(), SWEEP_PRIORITY);
});

// The real runner body with fake process boundaries and a controlled clock.
test("C1 fake runner registers its root, lowers child priority, cleans every exit and propagates cleanup errors", async () => {
  for (const scenario of ["pass", "assertion", "TypeError", "import", "timeout", "early-cleanup-error", "final-cleanup-error"]) {
    const world = fakeRun();
    world.onKill = (_root, early) => {
      if ((scenario === "early-cleanup-error" && early) || (scenario === "final-cleanup-error" && !early)) throw new Error(`C1 ${scenario}`);
    };
    const saved = process.env.CC_DATA_DIR;
    process.env.CC_DATA_DIR = "must-not-leak";
    let result;
    try {
      const running = world.start({ timeoutMs: 20 });
      assert.ok(world.spawnArgs.includes("--test-concurrency=1"));
      if (scenario === "timeout") await world.advance(20);
      else {
        if (["assertion", "early-cleanup-error", "TypeError", "import"].includes(scenario)) {
          world.emit({ type: "fail", file: "fake-lane/test/fake.test.ts", name: "fixture", cause: scenario === "TypeError" || scenario === "import" ? "ERR_TEST_FAILURE" : "ERR_ASSERTION", message: "fixture assertion" });
        }
        world.emit({ type: "summary", pass: 1, fail: scenario === "pass" ? 0 : 1 });
        world.close(scenario === "pass" ? 0 : 1);
      }
      if (scenario.endsWith("cleanup-error")) await assert.rejects(running, new RegExp(`C1 ${scenario}`));
      else result = await running;
    } finally {
      if (saved === undefined) delete process.env.CC_DATA_DIR; else process.env.CC_DATA_DIR = saved;
      await world.finish().catch((err) => { if (!scenario.endsWith("cleanup-error")) throw err; });
    }
    const { events, child } = world;
    assert.deepEqual(events.find(([event]) => event === "watch"), ["watch", 0, child.pid], world.message());
    assert.deepEqual(events.find(([event]) => event === "priority"), ["priority", 0, child.pid, 10], world.message());
    assert.equal(world.spawnEnv.CC_DATA_DIR, undefined, "spawn uses isolated laneEnv, not parent env");
    assert.ok(events.some(([event, , root, early]) => event === "kill" && root === undefined && !early), world.message());
    if (scenario === "assertion") {
      assert.ok(events.some(([event, , root]) => event === "kill" && root === child.pid), world.message());
      assert.equal(result.stoppedEarly, true); assert.equal(result.outcome, "assertion");
    }
    if (scenario === "pass") assert.equal(result.outcome, "pass");
    if (scenario === "TypeError" || scenario === "import") {
      assert.equal(result.outcome, "failure"); assert.equal(result.stoppedEarly, false);
    }
    if (scenario === "timeout") assert.equal(result.outcome, "timeout");
  }
});

test("R1 fake runner passes root only before child exit when abort precedes close", async () => {
  for (const exited of [false, true, "signal"]) {
    const world = fakeRun();
    const controller = new AbortController();
    const running = world.start({ signal: controller.signal, earlyStop: false, timeoutMs: 1000 });
    try {
      if (exited === true) { world.child.exitCode = 0; world.child.emit("exit", 0); }
      if (exited === "signal") { world.child.signalCode = "SIGTERM"; world.child.emit("exit", null, "SIGTERM"); }
      controller.abort();
      const result = await running;
      assert.equal(result.outcome, "aborted");
      assert.deepEqual(world.events.filter(([kind, , , early]) => kind === "kill" && early).map(([, , root]) => root), [exited === false ? world.child.pid : undefined], `exited=${exited}: ${world.message()}`);
    } finally { await world.finish(); }
  }
});
