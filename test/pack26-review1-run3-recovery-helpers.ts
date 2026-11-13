import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { socketGitFixture } from "./pack26-review1-run2-git-helpers.ts";
import { bridgeCall } from "./pack18-orch-harness.ts";

export async function recoveryGitFixture(options: Record<string, unknown> = {}) {
  const old = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${old ?? ""} --import ${new URL("./pack26-review1-run3-preload.ts", import.meta.url).href}`;
  let f: Awaited<ReturnType<typeof socketGitFixture>>;
  try { f = await socketGitFixture(options); }
  finally { if (old === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = old; }
  let n = 0;
  const control = (run3Control: string, args = {}) => new Promise<any>((resolve, reject) => {
    const id = ++n;
    const timer = setTimeout(() => { f.server.child.off("message", receive); reject(new Error(`Run 3 control ${run3Control} did not answer`)); }, 5000);
    function receive(m: any) {
      if (m.run3Reply !== id) return;
      clearTimeout(timer); f.server.child.off("message", receive);
      if (m.error) reject(new Error(m.error)); else resolve(m.value);
    }
    f.server.child.on("message", receive); f.server.child.send({ run3Control, id, ...args });
  });
  const reconcile = async (runId: string) => {
    await f.tool("get_fixed_task");
    const bridge = await f.control("bridge");
    const reply = await bridgeCall(`http://127.0.0.1:${f.server.port}/api/leader-mcp/fcx-test`, bridge.token, "tools/call",
      { name: "reconcile_task_execution", arguments: { expected: f.expected(), runId, reason: "Abandon rejected finalization without retrying Git" } });
    assert.equal(reply.status, 200);
    return reply.body.result;
  };
  const otherTab = async (allowed: boolean) => {
    const reply = await f.tool("begin_planning", { expected: null, brief: "Read and plan" }, "fixed-second");
    assert.equal(reply.ok, allowed, reply.text);
    if (allowed) { assert.ok(reply.value.runId); await f.ended(reply.value.runId, "fixed-second"); }
  };
  return { ...f, control3: control, reconcile, otherTab, taskBytes: () => readFileSync(join(f.server.data, "tasks", "fixed.json")) };
}
