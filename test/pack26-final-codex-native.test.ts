import test from "node:test";
import assert from "node:assert/strict";
import { NATIVE, notRun, nativeServer, stillRunning } from "./pack26-final-native-helpers.ts";
import { planned, acted, logSize } from "./pack26-final-reports-helpers.ts";

notRun("P26F Codex-shaped log with real pipes, real process lists and real cleanup");
test("P26F native Codex-shaped log reaches report acceptance and evidence", { skip: !NATIVE, timeout: 300_000 }, async () => {
  assert.equal(process.platform, "win32", "Windows is required when native acceptance is enabled");
  const f = await nativeServer();
  try {
    // A real codex.cmd -> node worker: the brief echoed, 3 MiB of tool output and a 1 MiB non-report line on stderr, the report on stderr, then on stdout.
    const planning = await planned(f, { megabytes: 3, giantLineMb: 1 });
    assert.equal(f.journal().executions.find((entry: any) => entry.id === planning.runId).processEnded, true, "the production whole-tree check confirmed the end through the real process list");
    assert.ok(logSize(f, planning.runId) >= 4 * 1024 * 1024);
    const accepted = await planning.accept(); assert.equal(accepted.ok, true, accepted.text);
    await f.approve();
    const build = await acted(f, "build", { write: "after!", megabytes: 3, order: "stdout-first" });
    assert.equal(f.journal().executions.find((entry: any) => entry.id === build.runId).processEnded, true);
    const built = await build.verify(); assert.equal(built.ok, true, built.text);
    const check = await acted(f, "check", { megabytes: 3 });
    const checked = await check.verify("focused"); assert.equal(checked.ok, true, checked.text);
    assert.deepEqual(await stillRunning(f), [], "real process list: no worker is left running");
    console.log(`NATIVE CODEX LOG sizes: ${[planning.runId, build.runId, check.runId].map((id) => logSize(f, id)).join(", ")} bytes; real pipes; worker pids gone`);
  } finally { await f.close(); }
});
