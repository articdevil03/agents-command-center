import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixedServer } from "./fixed-crew-execution-helpers.ts";
import { bridgeCall } from "./pack18-orch-harness.ts";

export async function socketGitFixture(options: Record<string, unknown> = {}) {
  const f = await fixedServer({ gitProcess: true, secondTab: true, extra({ bin, temp }) {
    writeFileSync(join(bin, "git.exe"), "test boundary executable, never executed");
    writeFileSync(join(temp, "git-process-options.json"), JSON.stringify(options));
  } });
  try { await f.planning(); await f.approve(); }
  catch (error) { console.error(f.server.log()); await f.close(); throw error; }
  await f.c.wait(() => f.c.tab("fixed").fixedTask?.detailRevision === f.expected()!.recordRevision, "approved task state publication");
  const bridge = await f.control("bridge");
  const call = (kind = "checkpoint") => bridgeCall(`http://127.0.0.1:${f.server.port}/api/leader-mcp/fcx-test`, bridge.token,
    "tools/call", { name: "request_task_action", arguments: { expected: f.expected(), kind, brief: "Approved Git operation" } });
  const rows = (name: string) => existsSync(join(f.server.temp, name)) ? readFileSync(join(f.server.temp, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const release = () => {
    writeFileSync(join(f.server.temp, "git-release"), "release");
    writeFileSync(join(f.server.temp, "git-cleanup-release"), "release");
  };
  const waitHeld = () => f.c.wait(() => existsSync(join(f.server.temp, "git-held")), "external Git hold");
  const pendingId = () => f.journal().activeExecutionId;
  const terminal = () => {
    const execution = f.journal().executions.at(-1);
    return readFileSync(execution.logPath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { const record = JSON.parse(line); return record.type === "git-terminal" ? [record] : []; } catch { return []; }
    });
  };
  const close = async () => {
    release();
    await f.close();
    const line = f.server.log().split(/\r?\n/).find((line) => line.startsWith("P26R2_OWNERSHIP "));
    assert.ok(line, "owned server must report fixture cleanup before exiting");
    const audit = JSON.parse(line.slice("P26R2_OWNERSHIP ".length));
    for (const events of [audit.children, audit.git]) for (const start of events.filter((entry: any) => entry.event === "start")) {
      assert.ok(events.some((entry: any) => entry.event === "close" && entry.pid === start.pid), `owned fixture PID ${start.pid} must close`);
    }
    console.log(line); console.log(`CLEANED SOCKET TEMP ${f.server.temp}`);
    // The fixture's original helper verifies owned handles before removing its task-owned temp folder.
    assert.ok(f.server.child.exitCode !== null || f.server.child.signalCode !== null);
  };
  return { ...f, call, rows, release, waitHeld, pendingId, terminal, close };
}
