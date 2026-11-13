import assert from "node:assert/strict";
import { mkdtempSync, lstatSync, readdirSync, unlinkSync, rmdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../server/fixed-crew/task-types.ts";

export function ownedTemp(t: { after: (fn: () => void) => void }, canRemove: () => boolean = () => true) {
  const root = mkdtempSync(join(tmpdir(), "cc-p26r2-"));
  console.log(`OWNED TEMP ${root}`);
  function remove(dir: string) {
    assert.equal(lstatSync(dir).isSymbolicLink(), false, `cleanup refuses link ${dir}`);
    for (const name of readdirSync(dir)) {
      const file = join(dir, name), info = lstatSync(file);
      assert.equal(info.isSymbolicLink(), false, `cleanup refuses link ${file}`);
      if (info.isDirectory()) remove(file); else unlinkSync(file);
    }
    assert.deepEqual(readdirSync(dir), []); rmdirSync(dir);
  }
  t.after(() => { assert.equal(canRemove(), true, `INCOMPLETE: retaining ${root} and its registry because owned process end is unknown`); remove(root); console.log(`CLEANED TEMP ${root}`); });
  return root;
}
export const testPlan = (paths = ["owned.txt"]): Plan => ({ id: "pack", scope: "Change owned files", criteria: ["Correct"],
  blocks: [{ id: "one", scope: "Files", paths }], risk: { level: "small", reason: "Contained", paths, verification: ["focused"] },
  visibleWork: false, large: false, integration: false, design: false, paths, consumers: [], sharedInputs: [], checks: ["focused"],
  shipping: ["commit", "push"], reviewReason: "Independent review" });
export function populate(root: string, count: number, size: number) {
  mkdirSync(root);
  const bytes = Buffer.alloc(size, 97);
  for (let i = 0; i < count; i++) writeFileSync(join(root, `${i}.txt`), bytes);
}
