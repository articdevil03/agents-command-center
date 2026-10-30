import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { KILL_TIMEOUT_MS } from "../server/leader-common/types.ts";
import { stopChromeTree, chromeStopBoundMs, CHROME_CLOSE_GRACE_MS } from "./chrome-stop.ts";

// A stand-in Chrome root: exit() plays the process ending; calls records the order of taskkill attempts and proc.kill().
function fakeRoot() {
  const proc: any = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null as number | null, signalCode: null, kills: [] as [number, number][], calls: [] as string[] });
  proc.exit = () => { proc.exitCode = 1; proc.emit("exit", 1, null); };
  proc.kill = () => { proc.calls.push("proc.kill"); return true; };
  return proc;
}
const SMALL = { killMs: 50, exitMs: 80 };

test("a first taskkill that times out while the root is alive is retried once, and the root's exit then counts as stopped", async () => {
  const proc = fakeRoot();
  const outcomes = ["timed out after 0 s", "exit 0"];
  const result = await stopChromeTree(proc, { ...SMALL, kill: async (pid, limitMs) => { proc.kills.push([pid, limitMs]); proc.calls.push("taskkill"); const outcome = outcomes.shift()!; if (outcome === "exit 0") setTimeout(() => proc.exit(), 5); return outcome; } });
  assert.deepEqual(proc.kills, [[4242, SMALL.killMs], [4242, SMALL.killMs]]);
  assert.equal(result.stopped, true);
  assert.deepEqual(proc.calls, ["taskkill", "taskkill"], "exactly one retry, and no proc.kill() once the retry worked");
  assert.equal(result.facts.filter((fact) => fact.startsWith("taskkill")).length, 2, `both attempts are in the facts: ${result.facts.join("; ")}`);
});

test("a failed taskkill that exits the root is not retried on a potentially reused pid", async () => {
  const proc = fakeRoot();
  const result = await stopChromeTree(proc, { graceMs: 0, ...SMALL, kill: async (pid, limitMs) => { proc.kills.push([pid, limitMs]); proc.calls.push("taskkill"); proc.exit(); return "timed out after 0 s"; } });
  assert.deepEqual(proc.kills, [[4242, SMALL.killMs]], "exactly one kill, even though it reported failure");
  assert.deepEqual(proc.calls, ["taskkill"], "no retry and no proc.kill() after the root exits");
  assert.equal(result.stopped, true);
});

test("two failed taskkills fall back to proc.kill(), and only after the second taskkill", async () => {
  const proc = fakeRoot();
  const result = await stopChromeTree(proc, { ...SMALL, kill: async (pid, limitMs) => { proc.kills.push([pid, limitMs]); proc.calls.push("taskkill"); return "error spawn failed"; } });
  assert.deepEqual(proc.kills, [[4242, SMALL.killMs], [4242, SMALL.killMs]]);
  assert.deepEqual(proc.calls, ["taskkill", "taskkill", "proc.kill"]);
  assert.equal(result.stopped, false, "proc.kill() here does not end the fake, so the stop reports failure");
});

test("a root that never exits gives stopped: false within the helper's own bound", async () => {
  const proc = fakeRoot();
  const result = await stopChromeTree(proc, { graceMs: 20, ...SMALL, kill: async (pid, limitMs) => { proc.kills.push([pid, limitMs]); return "exit 0"; } });
  assert.deepEqual(proc.kills, [[4242, SMALL.killMs]]);
  assert.equal(result.stopped, false);
  assert.ok(result.ms < 20 + SMALL.exitMs + 500, `gave up at its exit limit, not later: ${result.ms} ms`);
  assert.ok(result.facts.some((fact) => /no exit within 80 ms/.test(fact)), result.facts.join("; "));
  assert.ok(chromeStopBoundMs(CHROME_CLOSE_GRACE_MS) > chromeStopBoundMs(), "the bound grows with the grace");
});

test("an already-exited root runs no taskkill", async () => {
  const proc = fakeRoot(); proc.exit();
  const result = await stopChromeTree(proc, { kill: async (pid, limitMs) => { proc.kills.push([pid, limitMs]); proc.calls.push("taskkill"); return "exit 0"; } });
  assert.equal(result.stopped, true);
  assert.deepEqual(proc.kills, []);
  assert.deepEqual(proc.calls, []);
});

test("a root that exits during the grace runs no kill and no proc.kill()", async () => {
  const proc = fakeRoot(); setTimeout(() => proc.exit(), 10);
  const result = await stopChromeTree(proc, { graceMs: 50, ...SMALL, kill: async (pid, limitMs) => { proc.kills.push([pid, limitMs]); proc.calls.push("taskkill"); return "exit 0"; } });
  assert.deepEqual(proc.kills, []);
  assert.deepEqual(proc.calls, []);
  assert.equal(result.stopped, true);
  assert.ok(result.facts.some((fact) => /exit \d+ ms into the 50 ms grace/.test(fact)), result.facts.join("; "));
  assert.ok(!result.facts.some((fact) => /after the kill/.test(fact)), result.facts.join("; "));
});

test("the default kill allowance reaches the killer unchanged", async () => {
  const proc = fakeRoot();
  const result = await stopChromeTree(proc, { exitMs: SMALL.exitMs, kill: async (pid, limitMs) => { proc.kills.push([pid, limitMs]); proc.exit(); return "exit 0"; } });
  assert.equal(result.stopped, true);
  assert.deepEqual(proc.kills, [[4242, KILL_TIMEOUT_MS]]);
});

test("only exit 0 or 128 counts as a tree kill: exit 1 is retried", async () => {
  const proc = fakeRoot();
  const outcomes = ["exit 1", "exit 0"];
  const result = await stopChromeTree(proc, { ...SMALL, kill: async (pid, limitMs) => { proc.kills.push([pid, limitMs]); proc.calls.push("taskkill"); const outcome = outcomes.shift()!; if (outcome === "exit 0") setTimeout(() => proc.exit(), 5); return outcome; } });
  assert.deepEqual(proc.kills, [[4242, SMALL.killMs], [4242, SMALL.killMs]]);
  assert.deepEqual(proc.calls, ["taskkill", "taskkill"], "no proc.kill()");
  assert.equal(result.stopped, true);
});

test("exit 128 waits for the root to exit without retrying or calling proc.kill()", async () => {
  const proc = fakeRoot();
  const result = await stopChromeTree(proc, { ...SMALL, kill: async (pid, limitMs) => { proc.kills.push([pid, limitMs]); proc.calls.push("taskkill"); setTimeout(() => proc.exit(), 5); return "exit 128"; } });
  assert.deepEqual(proc.kills, [[proc.pid, SMALL.killMs]], "exactly one kill with the root's pid");
  assert.deepEqual(proc.calls, ["taskkill"], "no retry and no proc.kill()");
  assert.equal(result.stopped, true);
});

test("a live root with no pid says taskkill was skipped", async () => {
  const proc = fakeRoot(); proc.pid = undefined;
  const result = await stopChromeTree(proc, { ...SMALL, kill: async () => { proc.calls.push("taskkill"); return "exit 0"; } });
  assert.ok(result.facts.includes("no pid: taskkill skipped"), result.facts.join("; "));
  assert.deepEqual(proc.calls, ["proc.kill"]);
});
