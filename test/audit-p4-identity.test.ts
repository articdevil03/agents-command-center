import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveOwnedRoot, assertOwnedPath } from "../server/owned-path.js";

function fixture(t: any) {
  const base = fs.mkdtempSync(join(tmpdir(), "cc-p4-identity-"));
  const first = join(base, "first"), second = join(base, "second");
  fs.mkdirSync(first); fs.mkdirSync(second);
  t.after(() => { fs.rmdirSync(first); fs.rmdirSync(second); fs.rmdirSync(base); });
  return { base, first, second };
}

test("P4 directory identities are exact strings, stable across calls and distinct between directories", (t) => {
  const { first, second } = fixture(t);
  const seen = new Map<string, string>();
  const io = { ...fs, lstatSync(file: any, options: any) {
    assert.equal(options?.bigint, true, "owned identity reads must request bigint stats");
    const info = fs.lstatSync(file, options) as fs.BigIntStats;
    const id = `${info.dev}:${info.ino}`;
    if (seen.has(String(file))) assert.equal(id, seen.get(String(file)), "same directory has same identity");
    seen.set(String(file), id);
    return info;
  } };
  for (const dir of [first, second]) {
    const root = resolveOwnedRoot(dir, { io });
    assert.equal(assertOwnedPath(root, dir), dir);
    assert.doesNotThrow(() => JSON.stringify(root), "public handle contains no bigint");
  }
  assert.ok(seen.has(first) && seen.has(second), "both directory identities FOUND");
  assert.notEqual(seen.get(first), seen.get(second), "different directories have different identities");
});

test("P4 real root must remain a directory independently of its pinned identity", (t) => {
  const { first } = fixture(t);
  // Distinct source and real spellings isolate the canonical-root stat check.
  const source = join(first, "alias");
  let invalid = false;
  const io = { ...fs,
    realpathSync(file: any) { return String(file) === source ? first : fs.realpathSync(file); },
    lstatSync(file: any, options: any) {
      const info = fs.lstatSync(String(file) === source ? first : file, options);
      if (invalid && String(file) === first) return { ...info, isSymbolicLink: () => false, isDirectory: () => false };
      return info;
    },
  };
  const root = resolveOwnedRoot(source, { io });
  invalid = true;
  assert.throws(() => assertOwnedPath(root, first), /Owned root changed or linked/);
});

test("P4 lexical escape refuses missing outside paths before traversal", (t) => {
  const { first, second } = fixture(t);
  const io = { ...fs, lstatSync(file: any, options: any) {
    assert.equal(String(file), first, "lexical escape must not inspect anything outside its root");
    return fs.lstatSync(file, options);
  } };
  const root = resolveOwnedRoot(first, { io });
  assert.throws(() => assertOwnedPath(root, resolve(second, "future"), { allowMissingLeaf: true }), /escapes/);
});
