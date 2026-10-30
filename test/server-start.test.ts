import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { listProcesses } from "../server/leader-common/process-tree.ts";
import { waitForServerStart } from "./server-start.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A pid can be handed to another process once it is free: the grandchild counts as alive only while that pid still has the creation time read when it started.
async function createdOf(pid: number): Promise<number | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const found = (await listProcesses())?.find((proc) => proc.pid === pid);
    if (found) return found.created;
    await sleep(200);
  }
  return null;
}
const mayBeAlive = async (pid: number, created: number | null) => alive(pid) && (created === null || [null, created].includes(await createdOf(pid))); // an unreadable list counts as alive: a survivor is never hidden
const verifiedSame = async (pid: number, created: number | null) => created !== null && await createdOf(pid) === created;

test("a start timeout stops the child and its grandchild before rejecting, at the bound", { timeout: 90_000 }, async () => {
  const script = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });"
    + " console.log('grandchild=' + c.pid); setTimeout(() => {}, 60000)";
  const child = spawn(process.execPath, ["-e", script], { windowsHide: true });
  let log = "";
  child.stdout.on("data", (data) => { log += data; });
  let grandchild = 0, created: number | null = null;
  try {
    const logDeadline = Date.now() + 20_000;
    while (!/grandchild=(\d+)/.test(log) && child.exitCode === null && child.signalCode === null && Date.now() < logDeadline) await sleep(20);
    assert.match(log, /grandchild=(\d+)/, `child exited or did not print its grandchild PID within 20 s: ${log}`);
    grandchild = Number(/grandchild=(\d+)/.exec(log)![1]);
    created = await createdOf(grandchild);
    assert.notEqual(created, null, "could not read the grandchild's creation time; its pid cannot be checked safely");
    const bound = 500, stopMs = 15_000;
    const started = Date.now();
    await assert.rejects(waitForServerStart(child, () => log, bound, () => false, stopMs), /server did not start/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 450 && elapsed < bound + 2 * stopMs + 10_000, `rejected after ${elapsed} ms, outside the startup and cleanup bounds`);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "timed-out child still alive");
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
    const stopDeadline = Date.now() + stopMs;
    while (await mayBeAlive(grandchild, created) && Date.now() < stopDeadline) await sleep(50);
    assert.ok(!await mayBeAlive(grandchild, created), `grandchild ${grandchild} survived the stop`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (grandchild && await verifiedSame(grandchild, created)) { try { process.kill(grandchild); } catch { /* already gone */ } }
  }
});

test("a child that exits at once rejects well before the bound", { timeout: 35_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "console.log('boom')"], { windowsHide: true });
  let log = "";
  child.stdout.on("data", (data) => { log += data; });
  const started = Date.now();
  await assert.rejects(waitForServerStart(child, () => log, 120_000, () => false), /server did not start/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 30_000, `an exited child took ${elapsed} ms to reject; the bound is 120000`);
});

test("a surviving child reports cleanup failed", { timeout: 5_000 }, async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined, exitCode: null, signalCode: null, kill() { return false; },
  }) as unknown as ChildProcess;
  await assert.rejects(waitForServerStart(child, () => "stuck child", 20, () => false, 200),
    /server did not start, and cleanup failed: server undefined is still running: stuck child/);
});

test("a ready child resolves with the port its ready line printed", { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "console.log('Command Center running at http://127.0.0.1:40123'); setTimeout(() => {}, 60000)"], { windowsHide: true });
  let log = "";
  child.stdout.on("data", (data) => { log += data; });
  try { assert.equal(await waitForServerStart(child, () => log), 40123); }
  finally {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill(); await exited;
  }
});

test("a bind error naming 127.0.0.1 is not a ready server", { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "console.error('server error: listen EADDRINUSE: address already in use 127.0.0.1:40123'); setTimeout(() => process.exit(1), 300)"], { windowsHide: true });
  let log = "";
  child.stderr.on("data", (data) => { log += data; });
  await assert.rejects(waitForServerStart(child, () => log), /server did not start/);
});

// Files that spawn the server without the shared wait. Each stops its server on every failure path (read 2026-10-30), so a slow start cannot hang the gate.
const OWN_CLEANUP: Record<string, string> = {
  "browser-approval.test.ts": "finally: stopServer(child)",
  "browser-real.test.ts": "finally: stopServer(child)",
  "http-guards.test.ts": "finally: stopChild(proc)",
  "http-helpers.ts": "after(): stopChild(child)",
  "http-requests-packaged.test.ts": "finally: stopChild(proc)",
  "overlap.test.ts": "finally: kills the server and waits for exit",
  "pack10-markdown-helpers.ts": "finally: kills the server and waits for exit",
  "pack12-page-helpers.ts": "finally: kills the server and waits for exit",
  "pack13-page.test.ts": "finally: kills the server and waits for exit",
  "pack14-page.test.ts": "finally: kills the server and waits for exit",
  "pack18-editor-harness.ts": "finally: kills the server and waits for exit",
  "pack9-page-helpers.ts": "finally: kills the server and waits for exit",
  "stream-perf-helpers.ts": "finally: kills the server and waits for exit",
};
const HELPER_USERS = 12;

test("every file that spawns the server uses the shared wait or has its own stop-on-failure", () => {
  const directory = new URL("./", import.meta.url);
  const imports = /import\s+\{[^}]*waitForServerStart[^}]*\}\s+from\s+["']\.\/server-start\.ts["']/;
  const spawnsServer = /\bspawn\([^;]{0,400}?(?:server\/index\.ts|"server",\s*"index\.ts")/;
  const helperUsers: string[] = [], listed: string[] = [], problems: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(ts|mjs|js)$/.test(entry.name)) continue;
    if (["server-start.ts", "server-start.test.ts"].includes(entry.name)) continue;
    const path = `${entry.parentPath}/${entry.name}`;
    const source = readFileSync(path, "utf8");
    const usesHelper = source.includes("waitForServerStart(");
    if (usesHelper) {
      helperUsers.push(entry.name);
      if (!imports.test(source)) problems.push(`${path}: calls waitForServerStart without importing it from ./server-start.ts`);
      if (source.includes("while (!log.includes(")) problems.push(`${path}: still has its own inline ready loop`);
    } else if (spawnsServer.test(source)) {
      if (OWN_CLEANUP[entry.name]) listed.push(entry.name);
      else problems.push(`${path}: spawns server/index.ts without waitForServerStart and is not in OWN_CLEANUP`);
    }
  }
  console.log(`helper users (${helperUsers.length}): ${helperUsers.join(", ")}
listed own-cleanup files (${listed.length}): ${listed.join(", ")}`);
  assert.deepEqual(problems, []);
  assert.equal(helperUsers.length, HELPER_USERS, `helper users: ${helperUsers.join(", ")}`);
  assert.deepEqual(listed.sort(), Object.keys(OWN_CLEANUP).sort(), "a listed file no longer spawns the server (or the scan missed it)");
});

// A port the test found free and handed to the server can be taken by another test's server before the first listens (EADDRINUSE, or a test talking to the wrong server).
// CC_PORT "0" makes the OS pick at the server's own listen; the test reads the port from the ready line.
const FIXED_PORT_ALLOWED: Record<string, string> = {
  "pack2-server-helpers.ts": 'boot({ port }) is the taken-port test: it passes a port the test itself holds so the server must fail with EADDRINUSE; every other caller gets "0"',
};
// Sets CC_PORT but starts no child server: its env feeds the server source run in-process.
const NOT_SPAWNING = ["round2-helpers.ts"];

test("every file that spawns the server lets the OS pick its port (CC_PORT 0), except the named fixed-port test", () => {
  const directory = new URL("./", import.meta.url);
  const spawnsServer = /\bspawn(?:Sync)?\([^;]{0,400}?(?:server\/index\.ts|"server",\s*"index\.ts")/;
  const spawning: string[] = [], settingPort: string[] = [], problems: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(ts|mjs|js)$/.test(entry.name) || ["server-start.test.ts", "tooling-catalogue.test.ts"].includes(entry.name)) continue;
    const source = readFileSync(`${entry.parentPath}/${entry.name}`, "utf8");
    const values = [...source.matchAll(/\bCC_PORT:\s*([^,}\n]+)/g)].map((match) => match[1].trim());
    const spawns = spawnsServer.test(source);
    if (values.length) settingPort.push(entry.name);
    if (spawns) spawning.push(entry.name);
    // Only the explicit taken-port branch is exempt. The default still must use the OS.
    if (FIXED_PORT_ALLOWED[entry.name]) {
      assert.ok(source.includes('CC_PORT: options.port === undefined ? "0" : String(options.port)'), `${entry.name}: taken-port expression must default to "0"`);
    }
    if (spawns && !values.length) problems.push(`${entry.name}: spawns server/index.ts and never sets CC_PORT (the server would take 4317)`);
    for (const value of values) if (value !== '"0"' && !(FIXED_PORT_ALLOWED[entry.name] && value === 'options.port === undefined ? "0" : String(options.port)')) problems.push(`${entry.name}: CC_PORT: ${value} (use "0" and read the port from the ready line)`);
    if (spawns && /\bfreePort\b/.test(source)) problems.push(`${entry.name}: still has a freePort probe`);
  }
  console.log(`spawn files checked (${spawning.length}): ${spawning.sort().join(", ")}`);
  assert.deepEqual(problems, []);
  // Controls: a scan that found nothing, or fewer files than set CC_PORT (measured a second way), proves nothing.
  assert.ok(spawning.length > 0, "control: the scan found no file that spawns the server");
  assert.deepEqual(spawning.sort(), settingPort.filter((name) => !NOT_SPAWNING.includes(name)).sort(), "control: the files that spawn the server and the files that set CC_PORT must be the same set");
  assert.deepEqual(Object.keys(FIXED_PORT_ALLOWED).filter((name) => !spawning.includes(name)), [], "an allowed fixed-port file no longer spawns the server");
});
