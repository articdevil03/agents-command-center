import test from "node:test";
import assert from "node:assert/strict";
import { processFixture } from "./pack26-review1-run2-process-helpers.ts";
test("P26R6G automatic maintenance disabled spawn contract", async t => {
  const f = processFixture(t), pending = f.run(); f.exit();
  const result = await pending;
  assert.equal(result.treeEnded, true); assert.equal(result.command, "success");
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(f.spawns[0].args, ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false",
    "-c", "gc.auto=0", "-c", "maintenance.auto=false", "--literal-pathspecs", "-C", f.folder, "status"]);
});
