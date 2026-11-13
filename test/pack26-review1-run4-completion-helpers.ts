import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Run4Fixture } from "./pack26-review1-run4-helpers.ts";

export async function assertFinishRefused(f: Run4Fixture, args = {}) {
  const expected = f.expected(), before = f.disk();
  const reply = await f.finish({ expected, ...args });
  assert.equal(reply.isError, true, `unsafe finish must refuse: ${reply.text}`);
  assert.deepEqual(f.disk(), before, "unsafe finish preserves task and journal bytes");
  assert.equal(existsSync(join(f.data, "tasks", `${f.tabId}.rollover.json`)), false, "refusal creates no rollover transaction");
  return reply;
}
export function rewriteTask(f: Run4Fixture, change: (task: any) => void) {
  const task = f.task(); change(task); f.writeTask(task); f.task();
}
export function applyRun4(f: Run4Fixture, event: any, role = "leader", session = "test-leader") {
  const store = f.server.fixedTasks;
  return store.apply({ tabId: f.tabId, ...f.expected(), requestId: `run4-${Math.random().toString(36).slice(2)}` }, event, store.actor(role, session));
}
