import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE, notRun, nativeServer, stillRunning } from "./pack26-final-native-helpers.ts";

notRun("P26F native shutdown with a live worker");
test("P26F native shutdown ends a live worker through real taskkill and real process lists", { skip: !NATIVE, timeout: 300_000 }, async () => {
  assert.equal(process.platform, "win32", "Windows is required when native acceptance is enabled");
  const f = await nativeServer();
  try {
    await f.planning(); await f.approve();
    f.worker({ delay: 12_000, write: "after!" });
    const run = await f.action("build"); assert.equal(run.ok, true, run.text);
    await f.c.wait(() => f.observation(run.value.runId), "native worker observation");
    assert.equal((await stillRunning(f)).length, 1, "the real worker is in the real process list");
    const exit = once(f.server.child, "exit");
    f.server.child.send("shutdown");
    const [code] = await exit;
    assert.equal(code, 0, f.server.log());
    const ended = JSON.parse(readFileSync(join(f.server.data, "executions", "fixed.json"), "utf8"));
    const entry = ended.executions.find((row: any) => row.id === run.value.runId);
    assert.equal(entry.processEnded, true, "the real sweep confirmed the end and the journal was published before exit");
    assert.equal(ended.activeExecutionId, null);
    assert.deepEqual(await stillRunning(f), [], "real process list: nothing of the worker remains");
  } finally { await f.close(); }
});
