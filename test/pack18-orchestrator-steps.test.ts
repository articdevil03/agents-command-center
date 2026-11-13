// Fixed workers have no crew tools, and the current leader launches one execution at a time.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixedServer, plan } from "./fixed-crew-execution-helpers.ts";

test("S13 fixed Planner and coder get no crew tools; a working execution refuses another, and confirmed end allows the next", { timeout: 60_000 }, async () => {
  const f = await fixedServer({ assignments: {
    coder: { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium" },
  } });
  try {
    const workers = () => f.children().filter((entry: any) => entry.worker && entry.event === "start").length;
    const journalBytes = () => readFileSync(join(f.server.data, "executions", "fixed.json"));
    const observe = async (runId: string, role: string) => {
      const observed = await f.c.wait(() => f.observation(runId), `${role}: real worker recorded its input`);
      assert.ok(observed.pid > 0, `${role}: actual worker observation`);
      assert.equal(observed.bridge, null, `${role}: worker received no crew URL`);
      assert.equal(observed.tokenPresent, false, `${role}: worker received no crew token`);
      assert.equal(observed.mcp, null, `${role}: worker received no MCP configuration`);
      assert.equal(observed.opencodeConfigPresent, false, `${role}: worker received no OpenCode MCP configuration`);
      const execution = f.journal().executions.find((entry: any) => entry.id === runId);
      assert.equal(execution.role, role);
      assert.equal(execution.status, "running");
      assert.equal(execution.processEnded, false);
      assert.equal(f.c.tab("fixed").runs.find((run: any) => run.id === runId).status, "working");
      const before = journalBytes(), count = workers();
      const starts = f.c.messages.filter((message) => message.type === "runStart").length;
      const refused = await f.tool("begin_planning", { expected: f.expected(), brief: "Must wait for the active execution" });
      assert.equal(refused.ok, false, `${role}: another execution must be refused`);
      assert.match(refused.text, /not been confirmed ended|already reserved/);
      assert.deepEqual(journalBytes(), before, `${role}: refusal made no journal reservation`);
      assert.equal(workers(), count, `${role}: refusal spawned no worker`);
      assert.equal(f.c.messages.filter((message) => message.type === "runStart").length, starts, `${role}: refusal started no run`);
      return observed;
    };
    const confirmedEnd = async (runId: string, pid: number) => {
      assert.equal((await f.ended(runId)).status, "done");
      const execution = f.journal().executions.find((entry: any) => entry.id === runId);
      assert.equal(execution.status, "done");
      assert.equal(execution.processEnded, true, "owned-process boundary confirmed execution end");
      assert.equal(f.journal().activeExecutionId, null);
      await f.c.wait(() => f.children().some((entry: any) => entry.pid === pid && entry.event === "close"), "owned worker closed");
    };

    f.worker({ plan: plan(), delay: 5000 });
    const planner = await f.tool("begin_planning", { expected: null, brief: "Inspect and return a plan" });
    assert.equal(planner.ok, true, planner.text);
    const plannerInput = await observe(planner.value.runId, "planner");
    await confirmedEnd(planner.value.runId, plannerInput.pid);
    const accepted = await f.tool("accept_planner_report", { expected: null, runId: planner.value.runId });
    assert.equal(accepted.ok, true, accepted.text);
    await f.approve();

    f.worker({ delay: 5000 });
    const coder = await f.action("build");
    assert.equal(coder.ok, true, `confirmed Planner end permits the next valid execution: ${coder.text}`);
    assert.notEqual(coder.value.runId, planner.value.runId, "next execution is fresh");
    const coderInput = await observe(coder.value.runId, "coder");
    await confirmedEnd(coder.value.runId, coderInput.pid);
    assert.equal(workers(), 2, "exactly the sequential Planner and coder were spawned");
    console.log("S13: real Planner and coder observed without crew URL, token or MCP config; busy refusals reserved and spawned nothing; both owned workers closed");
  } finally { await f.close(); }
});
