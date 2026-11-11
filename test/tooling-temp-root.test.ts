import { fixture, hookFixture } from "./tooling-temp-fixtures.ts";
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

test("removeWithRetry: succeeds once the underlying failure clears, after backing off between attempts", () => {
  const f = fixture(); f.put("owned");
  f.fail(() => f.waits.length < 2 ? "EPERM" : undefined);
  assert.equal(f.context.removeWithRetry("owned", 5, 1), true);
  assert.deepEqual(f.waits, [1, 1]);
});

test("removeWithRetry: a permanently stuck removal reports failure and returns false, never throws", () => {
  const f = fixture(); f.put("owned"); f.fail(() => "EPERM");
  assert.equal(f.context.removeWithRetry("owned", 3, 1), false);
  assert.equal(f.failedCalls, 3);
  assert.equal(f.proc.exitCode, 1);
  assert.match(f.logs[0], /TEMP_CLEANUP_LEFTOVER:/);
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
      removeWithRetry, relative: () => "not-a-cc-test-dir",
      after: () => assert.fail("must not register cleanup on throw"),
      URL, fileURLToPath: () => scratchRoot,
    });
    assert.throws(() => allocate(), /unsafe test root/);
    assert.deepEqual(readdirSync(scratchRoot), [], "the mkdtemp'd directory must not survive the throw");
  } finally {
    removeWithRetry(scratchRoot);
  }
});

test("tempRoot: a permanently stuck cleanup handle makes the process unsuccessful without throwing", () => {
  const f = hookFixture("test/temp-root.ts");
  f.api.tempRoot(); f.fail(() => "EPERM");
  assert.doesNotThrow(() => f.hooks[0]());
  assert.equal(f.proc.exitCode, 1);
  assert.equal(f.failedCalls, 41);
});

test("tempRoot: a failing test is not masked by a cleanup failure", () => {
  const f = hookFixture("test/temp-root.ts");
  f.api.tempRoot(); f.fail(() => "EPERM");
  const bodyError = new Error("original body failure");
  assert.throws(() => { try { throw bodyError; } finally { f.hooks[0](); } }, (error) => error === bodyError);
  assert.equal(f.proc.exitCode, 1);
});
