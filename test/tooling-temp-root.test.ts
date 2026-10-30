import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { tempRoot } from "./temp-root.ts";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

// test/temp-root.ts as a plain script for a fake-context run: types stripped, imports and exports removed.
function tempRootSource(): string {
  return stripTypeScriptTypes(readFileSync(join(root, "test/temp-root.ts"), "utf8"))
    .replace(/^import .*;\r?$/gm, "").replaceAll("import.meta.url", JSON.stringify(import.meta.url))
    .replace(/\bexport (async )?function\b/g, "$1function");
}

// Real behavior, real import: removeWithRetry against a real directory it can
// actually delete must succeed on the first attempt and report so.
test("removeWithRetry: a real removable directory is deleted on the first attempt", async () => {
  const { removeWithRetry } = await import("../scripts/mutation-proof.mjs");
  const dir = mkdtempSync(join(root, ".cc-test-removeWithRetry-"));
  writeFileSync(join(dir, "marker.txt"), "x");
  assert.equal(removeWithRetry(dir), true);
  assert.equal(existsSync(dir), false);
});

// Guard: a stuck handle that clears after a couple of retries must not be
// treated as a permanent failure -- this is the shape of the real EPERM race
// (AV scan, a child's handle not yet released) the retry exists to survive.
test("removeWithRetry: succeeds once the underlying failure clears, after backing off between attempts", () => {
  const source = readFileSync(join(root, "scripts/mutation-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("export function removeWithRetry");
  const end = source.indexOf("\n}\n", start) + "\n}\n".length;
  const body = source.slice(start, end).replaceAll("export function", "function");
  let calls = 0;
  const waits = [];
  const removeWithRetry = runInNewContext(`${body}; removeWithRetry`, {
    rmSync: () => { calls++; if (calls < 3) throw new Error("EPERM: resource busy or locked"); },
    console: { log: () => {} },
    Atomics: { wait: (_buf, _idx, _val, ms) => waits.push(ms) },
    SharedArrayBuffer, Int32Array,
  });
  assert.equal(removeWithRetry("C:/fake/dir", 5, 1), true);
  assert.equal(calls, 3, "must retry exactly until the underlying rmSync stops throwing");
  assert.deepEqual(waits, [1, 1], "must back off between the two failed attempts, not the succeeding one");
});

// Guard: exhausting every attempt on a permanently stuck handle must warn and
// return false -- never throw. This is the actual crash the brief describes
// (an uncaught EPERM in the sweep's own finally block, after every mutation
// had already been verified) -- reverting to a bare rmSync here must fail
// this test by throwing instead of returning.
test("removeWithRetry: a permanently stuck removal warns and returns false, never throws", () => {
  const source = readFileSync(join(root, "scripts/mutation-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("export function removeWithRetry");
  const end = source.indexOf("\n}\n", start) + "\n}\n".length;
  const body = source.slice(start, end).replaceAll("export function", "function");
  let calls = 0;
  const warnings = [];
  const removeWithRetry = runInNewContext(`${body}; removeWithRetry`, {
    rmSync: () => { calls++; throw new Error("EPERM: resource busy or locked"); },
    console: { log: (msg) => warnings.push(msg) },
    Atomics: { wait: () => {} },
    SharedArrayBuffer, Int32Array,
  });
  let result;
  assert.doesNotThrow(() => { result = removeWithRetry("C:/fake/dir", 3, 1); });
  assert.equal(result, false);
  assert.equal(calls, 3);
  assert.match(warnings[0], /WARNING.*could not remove/);
});

test("tempRoot isolates copied directories and removes them afterwards", async (t) => {
  let dir = "";
  await t.test("allocate and copy", () => {
    dir = tempRoot(["server", "config", "public"]);
    const actual = realpathSync(dir);
    assert.notEqual(actual, root, "tempRoot must not return the repository root");
    assert.equal(dirname(actual), root);
    assert.match(relative(root, actual), /^\.cc-test-[^\\/]+$/);
    assert.ok(statSync(actual).isDirectory());
    for (const [folder, file] of [["server", "index.ts"], ["config", ".gitkeep"], ["public", "index.html"]]) {
      assert.ok(statSync(join(dir, folder)).isDirectory());
      assert.deepEqual(readFileSync(join(dir, folder, file)), readFileSync(join(root, folder, file)));
    }
  });
  assert.equal(existsSync(dir), false, "tempRoot cleanup must remove the directory");
});

test("temporary test directories are gitignored", () => {
  assert.ok(readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(".cc-test-*/"));
  const proof = readFileSync(join(root, "scripts/electron-process-proof.mjs"), "utf8");
  const statement = proof.match(/const screenshotPath = .*;/)?.[0];
  assert.ok(statement);
  assert.equal(runInNewContext(`${statement}; screenshotPath`, { dir: "temporary", root: "repository", join }), join("temporary", "electron-process-proof.png"));
});

test("tempRoot rejects repository and parent paths before registering destructive cleanup", () => {
  const source = tempRootSource();
  for (const unsafe of [root, dirname(root)]) {
    let cleanupRegistered = false;
    const allocate = runInNewContext(`${source}; tempRoot`, {
      assert, join, relative, realpathSync, isAbsolute, URL, fileURLToPath: () => root,
      mkdtempSync: () => unsafe,
      after: () => { cleanupRegistered = true; },
      rmSync: () => assert.fail("must never remove the repository"),
      cpSync: () => assert.fail("must reject before copying"),
    });
    assert.throws(() => allocate(), /unsafe test root/);
    assert.equal(cleanupRegistered, false);
  }
});

// A private scratch root, never the shared repo, so this can safely prove real
// cleanup without any risk of racing other test files' own .cc-test-* dirs.
test("tempRoot removes the real directory it created when the safety check fails for a reason other than root/parent", () => {
  const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "cc-temproot-guard-")));
  try {
    const source = tempRootSource();
    const allocate = runInNewContext(`${source}; tempRoot`, {
      assert, join, isAbsolute, realpathSync, mkdtempSync, rmSync, cpSync: () => assert.fail("must reject before copying"),
      relative: () => "not-a-cc-test-dir",
      after: () => assert.fail("must not register cleanup on throw"),
      URL, fileURLToPath: () => scratchRoot,
    });
    assert.throws(() => allocate(), /unsafe test root/);
    assert.deepEqual(readdirSync(scratchRoot), [], "the mkdtemp'd directory must not survive the throw");
  } finally {
    removeWithRetry(scratchRoot);
  }
});

// Same shape as mutation-proof.mjs's own EPERM race, one level down: a test's
// tempRoot()-created directory can still have a handle held on it (AV scan, a
// just-exited child) when its `after()` cleanup runs. Splices the real
// removeWithRetry source in next to the real tempRoot source (not a
// reimplementation of either) so the call site under test is the real
// integration between them.
function buildSandboxedTempRoot(rmSyncImpl) {
  const rwrSource = readFileSync(join(root, "scripts/mutation-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  const rwrStart = rwrSource.indexOf("export function removeWithRetry");
  const rwrEnd = rwrSource.indexOf("\n}\n", rwrStart) + "\n}\n".length;
  const removeWithRetrySource = rwrSource.slice(rwrStart, rwrEnd).replaceAll("export function", "function");
  const trSource = tempRootSource();

  let afterCallback = null;
  const tempRoot = runInNewContext(`${removeWithRetrySource}\n${trSource}\ntempRoot`, {
    assert, join, relative, realpathSync, isAbsolute, mkdtempSync,
    URL, fileURLToPath: () => root,
    after: (cb) => { afterCallback = cb; },
    rmSync: rmSyncImpl,
    console: { log: () => {} },
    Atomics: { wait: () => {} }, SharedArrayBuffer, Int32Array,
  });
  return { tempRoot, runAfter: () => afterCallback() };
}

test("tempRoot: a permanently stuck cleanup handle warns instead of failing the test", () => {
  let calls = 0;
  const { tempRoot, runAfter } = buildSandboxedTempRoot(() => {
    calls++;
    throw new Error("EPERM: resource busy or locked");
  });
  const dir = tempRoot();
  try {
    assert.doesNotThrow(() => runAfter(), "a stuck Windows handle during cleanup must never fail a test that already passed");
    assert.ok(calls > 1, "cleanup must be routed through removeWithRetry's retries, not a single bare rmSync call");
  } finally {
    removeWithRetry(dir);
  }
});

test("tempRoot: a failing test is not masked by a cleanup failure", () => {
  const { tempRoot, runAfter } = buildSandboxedTempRoot(() => { throw new Error("EPERM: resource busy or locked"); });
  const dir = tempRoot();
  try {
    let bodyError;
    try {
      assert.equal(1, 2, "the real assertion this test is checking");
    } catch (err) {
      bodyError = err;
    }
    assert.ok(bodyError, "the test body's own failure must be recorded first");
    assert.doesNotThrow(() => runAfter(), "cleanup must never add a masking throw on top of a real test failure");
  } finally {
    removeWithRetry(dir);
  }
});
