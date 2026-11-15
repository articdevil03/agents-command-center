import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { lstatSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export const modelOutput = (id = "provider/model", variants: string[] = ["none", "thinking"]) => {
  const slash = id.indexOf("/");
  return `${id}\n${JSON.stringify({ providerID: id.slice(0, slash), id: id.slice(slash + 1), name: id,
    variants: Object.fromEntries(variants.map((variant) => [variant, {}])) }, null, 2)}\n`;
};
export function noVendor(t: TestContext): void {
  const spy = t.mock.method(childProcess, "spawn", () => { throw new Error("FORBIDDEN vendor spawn"); });
  syncBuiltinESMExports();
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("FORBIDDEN network"); });
  t.after(() => { assert.equal(spy.mock.callCount(), 0); assert.equal(fetch.mock.callCount(), 0);
    spy.mock.restore(); fetch.mock.restore(); syncBuiltinESMExports(); });
}
export function ownedTemp(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "cc-w8-models-"));
  t.after(() => {
    // Only files made inside this test's fresh directory. Refuse links and
    // remove each verified-empty folder with the non-recursive primitive.
    const remove = (dir: string) => {
      assert.equal(lstatSync(dir).isSymbolicLink(), false);
      for (const name of readdirSync(dir)) {
        const file = join(dir, name), info = lstatSync(file);
        assert.equal(info.isSymbolicLink(), false);
        if (info.isDirectory()) remove(file); else unlinkSync(file);
      }
      assert.deepEqual(readdirSync(dir), []); rmdirSync(dir);
    };
    remove(root);
  });
  return root;
}
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
