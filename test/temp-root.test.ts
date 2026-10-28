// The shared test helpers in temp-root.ts: what they copy, where they put things, and that they put everything back.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { importWithTempDataRoot, scratchDir, setEnv, stopOwnedChild, tempRoot } from "./temp-root.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const LIVE = ["workspaces.json", "client-prefs.json", "launch-safety.json"];

test("tempRoot copies a directory but never the live config files: the copy filter, run from the real source, drops each and keeps the rest", () => {
  // The real temp-root.ts source, with a recording cpSync under it: what tempRoot hands the copy is what is checked.
  const source = stripTypeScriptTypes(readFileSync(join(repo, "test/temp-root.ts"), "utf8"))
    .replace(/^import .*;\r?$/gm, "").replaceAll("import.meta.url", JSON.stringify(import.meta.url)).replaceAll("export ", "");
  const copies: Array<{ from: string; options: any }> = [];
  let cleanup: (() => void) | undefined;
  const allocate = runInNewContext(`${source}; tempRoot`, {
    assert, join, relative, realpathSync, isAbsolute, mkdtempSync, URL, fileURLToPath, Set,
    rmSync: () => assert.fail("a good folder is not removed"),
    after: (fn: () => void) => { cleanup = fn; },
    removeWithRetry,
    copyTree: (from: string, _to: string, options: any) => copies.push({ from, options }),
  });
  const dir = allocate(["config", "server"]);
  try {
    assert.deepEqual(copies.map((copy) => copy.from), [join(repo, "config"), join(repo, "server")], "every requested directory is copied");
    for (const { options } of copies) {
      assert.equal(options.recursive, true);
      assert.equal(typeof options.filter, "function", "the copy carries a filter");
      for (const name of LIVE) {
        assert.equal(options.filter(`C:\\repo\\config\\${name}`), false, `${name} (backslash path) is left out`);
        assert.equal(options.filter(`/repo/config/${name}`), false, `${name} (slash path) is left out`);
      }
      for (const name of [".gitkeep", "projects.json", "index.ts"]) assert.equal(options.filter(`C:\\repo\\config\\${name}`), true, `${name} is copied`);
      assert.equal(options.filter("C:\\repo\\config"), true, "the folder itself is copied");
    }
  } finally { cleanup?.(); }
  assert.equal(existsSync(dir), false, "the folder the call made is removed afterwards");
});

test("a real tempRoot(['config']) holds the bundled config files and none of the live ones", () => {
  const copy = tempRoot(["config"]);
  assert.equal(existsSync(join(copy, "config", ".gitkeep")), true, "control: the copy is not empty");
  for (const name of LIVE) assert.equal(existsSync(join(copy, "config", name)), false, `${name} was not copied`);
});

test("scratchDir is a fresh folder in the OS temp dir, not in the repo", () => {
  const a = scratchDir(), b = scratchDir();
  assert.notEqual(a, b);
  for (const dir of [a, b]) {
    assert.equal(existsSync(dir), true);
    assert.equal(relative(realpathSync(tmpdir()), dir).startsWith(".."), false, "inside the OS temp dir");
    assert.match(relative(realpathSync(tmpdir()), dir), /^cc-scratch-[^\\/]+$/);
  }
});

test("setEnv sets and deletes variables and its restore puts back exactly what was there, absent or not", () => {
  process.env.CC_TEST_ENV_A = "before";
  delete process.env.CC_TEST_ENV_B;
  try {
    const restore = setEnv({ CC_TEST_ENV_A: "during", CC_TEST_ENV_B: "new" });
    assert.deepEqual([process.env.CC_TEST_ENV_A, process.env.CC_TEST_ENV_B], ["during", "new"]);
    restore();
    assert.deepEqual([process.env.CC_TEST_ENV_A, Object.hasOwn(process.env, "CC_TEST_ENV_B")], ["before", false]);
    const removal = setEnv({ CC_TEST_ENV_A: undefined });
    assert.equal(Object.hasOwn(process.env, "CC_TEST_ENV_A"), false);
    removal();
    assert.equal(process.env.CC_TEST_ENV_A, "before", "a deleted variable comes back");
  } finally { delete process.env.CC_TEST_ENV_A; delete process.env.CC_TEST_ENV_B; }
});

test("importWithTempDataRoot hands the loader a fresh temp data root and puts the environment back, also when the import throws", async () => {
  const before = [process.env.CC_DATA_DIR, process.env.CC_TEST_FORCE_PACKAGED];
  let seen: Array<string | undefined> = [];
  const { dataDir, modules } = await importWithTempDataRoot(async () => { seen = [process.env.CC_DATA_DIR, process.env.CC_TEST_FORCE_PACKAGED]; return "loaded"; });
  assert.equal(modules, "loaded");
  assert.deepEqual(seen, [dataDir, "1"], "the loader sees the temp root and the packaged override");
  assert.equal(existsSync(dataDir), true);
  assert.deepEqual([process.env.CC_DATA_DIR, process.env.CC_TEST_FORCE_PACKAGED], before, "restored after a good import");
  await assert.rejects(importWithTempDataRoot(async () => { throw new Error("import failed"); }), /import failed/);
  assert.deepEqual([process.env.CC_DATA_DIR, process.env.CC_TEST_FORCE_PACKAGED], before, "restored after a failing import");
});

// stopOwnedChild: every child here is spawned by the test and stopped through its own object.
const idleWithChannel = (script = "process.on('message', () => {}); setInterval(() => {}, 1000);") => spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
const ended = (child: ReturnType<typeof idleWithChannel>) => child.exitCode !== null || child.signalCode !== null;

test("stopOwnedChild: a child that exits on 'shutdown' is left to exit by itself, not killed", { timeout: 20_000 }, async () => {
  const child = idleWithChannel("process.on('message', (m) => { if (m === 'shutdown') process.exit(0); }); setInterval(() => {}, 1000);");
  try {
    await stopOwnedChild(child, 5000);
    assert.equal(child.exitCode, 0, "it left through its own shutdown handler");
    assert.equal(child.signalCode, null, "and was never signalled");
  } finally { child.kill(); }
});

test("stopOwnedChild: a child that ignores 'shutdown' is killed once the grace is over, and the wait is bounded", { timeout: 20_000 }, async () => {
  const child = idleWithChannel();
  try {
    const started = Date.now();
    await stopOwnedChild(child, 300);
    assert.equal(ended(child), true, "the child is gone");
    assert.ok(Date.now() - started < 10_000, "it did not wait for ever");
  } finally { child.kill(); }
});

test("stopOwnedChild: a closed IPC channel never throws, and an already-exited child returns at once", { timeout: 20_000 }, async () => {
  const child = idleWithChannel();
  try {
    child.disconnect();
    await assert.doesNotReject(stopOwnedChild(child, 300));
    assert.equal(ended(child), true);
    await assert.doesNotReject(stopOwnedChild(child, 300));
  } finally { child.kill(); }
});

// A stand-in child for the two failures a real one cannot be made to show on demand. send() models Node: without a callback a failure
// is an unhandled 'error' event (counted here), with one it goes to the callback. kill() either works or does nothing.
function standInChild(options: { killWorks: boolean }) {
  const child: any = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, connected: true, pid: 424242, unhandledSendErrors: 0, kills: 0 });
  child.send = (_message: unknown, callback?: (error: Error | null) => void) => {
    queueMicrotask(() => { if (callback) callback(new Error("channel closed")); else child.unhandledSendErrors++; });
    return true;
  };
  child.kill = () => {
    child.kills++;
    if (options.killWorks) setImmediate(() => { child.exitCode = 1; child.emit("exit", 1, null); });
    return options.killWorks;
  };
  return child;
}

test("stopOwnedChild: a send failure that arrives after the connected check is consumed, and the child is still killed", async () => {
  const child = standInChild({ killWorks: true });
  await assert.doesNotReject(stopOwnedChild(child, 30, 200));
  await new Promise((done) => setImmediate(done));
  assert.equal(child.unhandledSendErrors, 0, "the send error went to a callback instead of becoming an unhandled 'error' event");
  assert.equal(child.kills, 1, "and the bounded kill still ran");
});

test("stopOwnedChild: a child that is still running after the kill and the bounded wait fails loudly instead of resolving", async () => {
  const child = standInChild({ killWorks: false });
  const started = Date.now();
  await assert.rejects(stopOwnedChild(child, 30, 60), /still running/);
  assert.equal(child.kills, 1, "the kill was tried");
  assert.ok(Date.now() - started < 5000, "and the wait stayed bounded");
});
