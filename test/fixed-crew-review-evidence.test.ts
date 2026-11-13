import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixedServer } from "./fixed-crew-execution-helpers.ts";

test("FCXE report intake rejects wrong run, malformed, wrong-version, duplicate and failed-auth reports through the tool route", { timeout: 120_000 }, async () => {
  const f = await fixedServer();
  try {
    for (const options of [{ report: { runId: "another-run" } }, { report: { version: 2 } }, { duplicate: "different" }, { exit: 2 }, { report: { extra: "forged" } }]) {
      f.worker(options);
      const started = await f.tool("begin_planning", { expected: null, brief: "plan" });
      assert.equal(started.ok, true, started.text); await f.ended(started.value.runId);
      const accepted = await f.tool("accept_planner_report", { expected: null, runId: started.value.runId });
      assert.equal(accepted.ok, false, JSON.stringify(options));
      if (options.report?.runId) assert.match(accepted.text, /Report belongs to another run/);
      if (options.exit) assert.match(accepted.text, /did not finish successfully/);
      assert.equal(f.task(), null, "rejected evidence never creates a plan");
    }
  } finally { await f.close(); }
});

test("FCXE same-size edits stale a real check report, and missing or caller-supplied paths never become evidence", { timeout: 120_000 }, async () => {
  const f = await fixedServer();
  try {
    await f.planning(); await f.approve(); f.worker({ write: "after!" });
    const built = await f.action("build"); assert.equal(built.ok, true, built.text); await f.ended(built.value.runId);
    assert.equal((await f.verify(built.value.runId)).ok, true);
    f.worker({}); const check = await f.action("check"); assert.equal(check.ok, true, check.text); await f.ended(check.value.runId);
    writeFileSync(join(f.server.work, "owned.txt"), "other!");
    assert.match((await f.verify(check.value.runId, "focused")).text, /Evidence is stale/);
    const missing = await f.tool("verify_task_evidence", { expected: f.expected(), runId: "invented", logPath: "owned.txt", checkName: "focused" });
    assert.equal(missing.ok, false); assert.match(missing.text, /Unknown server-bound/);
    assert.equal(f.task().checks.length, 0);
  } finally { await f.close(); }
});
