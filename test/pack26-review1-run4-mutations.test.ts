import test from "node:test";
import assert from "node:assert/strict";
import { run4Fixture } from "./pack26-review1-run4-helpers.ts";
import { assertFinishRefused, rewriteTask, applyRun4 } from "./pack26-review1-run4-completion-helpers.ts";
import { readFileSync, writeFileSync, statSync, utimesSync, existsSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { failPublication } from "./pack26-review1-run4-archive-helpers.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { archiveHash, archiveJson, byteIdentity } from "../server/fixed-crew/task-archive-files.ts";

test("P26R4M 01 dispatch", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const reply = await f.finish(); assert.equal(reply.isError, false, reply.text);
  assert.equal(f.disk().task, "null\n", "registered finish tool must durably empty the live task");
});

test("P26R4M 02 identity", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  for (const expected of [{ ...f.expected(), taskId: "foreign" }, { ...f.expected(), planVersion: 99 }, { ...f.expected(), recordRevision: 1 }]) await assertFinishRefused(f, { expected });
  writeFileSync(join(f.data, "tasks", `${f.tabId}.json`), f.disk().task + " ");
  await assertFinishRefused(f);
});
test("P26R4M 03 owner", async (t) => {
  for (const missing of ["ownerScopeApproval", "ownerRoughApproval"]) {
    const f = await run4Fixture(t, { visibleWork: true }); await f.ready();
    rewriteTask(f, (task) => { task[missing] = null; });
    await assertFinishRefused(f);
  }
});
test("P26R4M 04 results", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const id = applyRun4(f, { type: "action", action: { kind: "build", route: "normal", change: "none" }, sessionId: "unverified-session", batch: [] }).executionId;
  applyRun4(f, { type: "start", executionId: id });
  applyRun4(f, { type: "result", executionId: id, taskId: f.task().id, planVersion: f.task().planVersion, role: "coder", success: true, processEnd: "confirmed", evidence: ["owned.txt"] }, "coder", "unverified-session");
  // Bind ended journal provenance so only task evidence acceptance is missing.
  const journal = f.journal(), base = journal.executions.find((e: any) => e.kind === "build");
  journal.executions.push({ ...base, id, consumed: true }); f.setJournal(journal);
  await assertFinishRefused(f);
});
test("P26R4M 05 checks", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  rewriteTask(f, (task) => { task.checks = []; }); await assertFinishRefused(f);
});
test("P26R4M 06 review", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  rewriteTask(f, (task) => { task.reviews = []; }); await assertFinishRefused(f);
});
test("P26R4M 07 final", async (t) => {
  const f = await run4Fixture(t, { integration: true }); await f.ready();
  rewriteTask(f, (task) => { task.reviews = task.reviews.filter((r: any) => !r.final); }); await assertFinishRefused(f);
});
test("P26R4M 08 findings", async (t) => {
  for (const outcome of [null, "FIX"]) {
    const f = await run4Fixture(t); await f.ready();
    // A real finding outside the clean accepted review still needs triage
    // and an accepted FIX still needs resolution by a subsequent review.
    rewriteTask(f, (task) => {
      task.findings.push({ id: "untriaged", executionId: task.reviews[0].executionId, text: "Observed defect", real: true, minimal: false });
      if (outcome) task.triage.untriaged = { outcome, reason: "Real behavior must be corrected" };
    });
    await assertFinishRefused(f);
  }
});
test("P26R4M 09 shipping", async (t) => {
  const f = await run4Fixture(t, { shipping: ["commit"] });
  await f.worker("build"); await f.worker("check"); await f.worker("review");
  await assertFinishRefused(f);
});
test("P26R4M 10 content", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const file = join(f.folder, "owned.txt"), info = statSync(file);
  writeFileSync(file, "after!"); utimesSync(file, info.atime, info.mtime);
  assert.equal(statSync(file).size, info.size);
  await assertFinishRefused(f);
});
test("P26R4M 11 journal", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const before = f.journal();
  for (const state of ["active", "reserved", "running", "interrupted", "unended", "unconsumed"]) {
    const journal = structuredClone(before), run = journal.executions[0];
    if (state === "active") journal.activeExecutionId = run.id;
    else if (state === "unended") run.processEnded = false;
    else if (state === "unconsumed") run.consumed = false;
    else run.status = state;
    f.setJournal(journal); await assertFinishRefused(f);
  }
});
test("P26R4M 12 runtime", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const id = f.journal().executions[0].id;
  const op = f.controls.fixedGitOperations.register(id, f.tabId, {});
  op.terminal = true; // A retained terminal finalization brake also blocks finish.
  try { await assertFinishRefused(f); } finally { op.terminal = true; f.controls.fixedGitOperations.retireConfirmed(id); }
  f.controls.savingTabs.set(f.tabId, 1);
  try { await assertFinishRefused(f); } finally { f.controls.savingTabs.delete(f.tabId); }
  f.controls.pendingApprovals.set("pending", { tabId: f.tabId });
  try { await assertFinishRefused(f); } finally { f.controls.pendingApprovals.delete("pending"); }
  f.controls.runContexts.set(id, { tabId: f.tabId, run: { runId: id } });
  try { await assertFinishRefused(f); } finally { f.controls.runContexts.delete(id); }
});
test("P26R4M 13 source", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const id = f.task().id, source = f.disk().task;
  const reply = await f.finish(); assert.equal(reply.isError, false, reply.text);
  assert.equal(readFileSync(join(f.data, "tasks", "finished", f.tabId, id, "source.json"), "utf8"), source);
});
test("P26R4M 14 verify", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const id = f.task().id;
  const file = join(f.data, "tasks", "finished", f.tabId, id, "source.json");
  // A conflicting immutable destination is never overwritten or accepted.
  fs.mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "corrupt");
  const before = f.disk(); const reply = await f.finish();
  assert.equal(reply.isError, true); assert.deepEqual(f.disk(), before);
  assert.equal(readFileSync(file, "utf8"), "corrupt");
});
test("P26R4M 15 marker", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const reply = await failPublication("/executions/alpha-dev.json", () => f.finish());
  assert.equal(reply.isError, true);
  assert.equal(f.disk().task, "null\n");
  f.controls.initialize();
  assert.equal((await f.tool("get_fixed_task")).task, null);
  assert.equal(f.journal().executions.length, 0, "startup resumes the durable marker after empty replacement");
});
test("P26R4M 16 source recheck", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const original = fs.linkSync, taskFile = join(f.data, "tasks", `${f.tabId}.json`);
  let changed = false;
  fs.linkSync = (from, to) => {
    original(from, to);
    if (String(to).endsWith("manifest.json")) { writeFileSync(taskFile, f.disk().task + " "); changed = true; }
  };
  syncBuiltinESMExports();
  let reply;
  try { reply = await f.finish(); } finally { fs.linkSync = original; syncBuiltinESMExports(); }
  assert.equal(changed, true); assert.equal(reply.isError, true, reply.text);
  assert.notEqual(f.disk().task, "null\n", "replacement refuses the source changed at publication boundary");
});
test("P26R4M 17 empty", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const reply = await f.finish(); assert.equal(reply.isError, false, reply.text);
  assert.equal(f.disk().task, "null\n");
});
test("P26R4M 18 prune", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const before = f.journal();
  f.setJournal({ ...before, executions: [...before.executions, { ...before.executions[0], id: "unrelated-ended", taskId: "other-task", planVersion: 1, status: "failed", consumed: false }] });
  const reply = await f.finish(); assert.equal(reply.isError, false, reply.text);
  assert.deepEqual(f.journal().executions.map((e: any) => e.id), ["unrelated-ended"]);
});
test("P26R4M 19 cache", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const reply = await f.finish(); assert.equal(reply.isError, false, reply.text);
  assert.equal(f.server.fixedTasks.summary(f.tabId), null, "completion updates the already primed cache before any subsequent get");
  assert.equal((await f.tool("get_fixed_task")).task, null);
});
test("P26R4M 20 resume", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  assert.equal((await failPublication("/executions/alpha-dev.json", () => f.finish())).isError, true);
  f.controls.initialize();
  assert.equal((await f.tool("get_fixed_task")).task, null);
  assert.equal(f.journal().executions.length, 0);
  assert.equal(existsSync(join(f.data, "tasks", `${f.tabId}.rollover.json`)), false);
});
test("P26R4M 21 receipt", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const taskId = f.task().id;
  const result = await f.finish(); assert.equal(result.isError, false, result.text);
  const receipt = join(f.data, "tasks", "finished", f.tabId, taskId, "complete.json");
  assert.equal(existsSync(receipt), true);
  const read = await f.call("get_task_archive", { kind: "task", id: taskId });
  assert.equal(read.isError, false, read.text);
});
test("P26R4M 22 admission", async (t) => {
  const f = await run4Fixture(t), planner = f.journal().executions[0];
  f.setJournal({ version: 1, activeExecutionId: null, executions: Array.from({ length: 2000 }, (_, n) => ({ ...planner, id: `settled-${n}`, taskId: null, planVersion: 0 })) });
  const reply = await f.call("request_task_action", { expected: f.expected(), kind: "build", brief: "Reclaim before reserve" });
  assert.equal(reply.isError, false, reply.text);
  assert.equal(f.journal().executions.length, 1);
});
test("P26R4M 23 cap", async (t) => {
  const f = await run4Fixture(t), planner = f.journal().executions[0];
  f.setJournal({ version: 1, activeExecutionId: null, executions: Array.from({ length: 2000 }, (_, n) => ({ ...planner, id: `unconsumed-${n}`, consumed: false })) });
  const before = f.disk(), launches = f.server.launched.length;
  const reply = await f.call("request_task_action", { expected: f.expected(), kind: "build", brief: "Refuse full capacity" });
  assert.equal(reply.isError, true, "a full journal with no safe candidate refuses before reservation");
  assert.deepEqual(f.disk(), before); assert.equal(f.server.launched.length, launches);
});
test("P26R4M 24 journal durability", async (t) => {
  const f = await run4Fixture(t), planner = f.journal().executions[0];
  f.setJournal({ version: 1, activeExecutionId: null, executions: Array.from({ length: 2000 }, (_, n) => ({ ...planner, id: `settled-${n}`, taskId: null, planVersion: 0 })) });
  const before = f.disk(), launches = f.server.launched.length;
  await failPublication("/_executions/settled-0.json", async () => {
    const result = await f.call("request_task_action", { expected: f.expected(), kind: "build", brief: "Archive must be durable first" });
    assert.equal(result.isError, true, "failed archive publication refuses admission before task write or spawn");
    assert.deepEqual(f.disk(), before); assert.equal(f.server.launched.length, launches);
    return result;
  });
});
test("P26R4M 25 late callback", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const entries = [...f.server.launched];
  assert.equal((await f.finish()).isError, false);
  await f.worker("planning", { plan: f.plan }); const before = f.disk();
  for (const entry of entries) assert.doesNotThrow(() => {
    entry.callback.onTreeEnd(entry.run, "unknown");
    entry.callback.onStatus(entry.run, "done", 0);
    f.controls.callbacks.log(f.tabId, entry.run.runId, "ignored-late.log");
  }, "verified archived executions accept harmless late callbacks");
  assert.deepEqual(f.disk(), before);
  assert.throws(() => f.controls.callbacks.status(f.tabId, "unknown-current-id", "done"), /ENOENT|Unknown/);
});
test("P26R4M 26 read binding", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const id = f.task().id;
  assert.equal((await f.finish()).isError, false);
  const base = join(f.data, "tasks", "finished", f.tabId, id);
  const manifest = JSON.parse(readFileSync(join(base, "manifest.json"), "utf8"));
  for (const leaf of ["source.json", "task.json"]) {
    const value = JSON.parse(readFileSync(join(base, leaf), "utf8")); value.tabId = "foreign-tab";
    const bytes = archiveJson(value); writeFileSync(join(base, leaf), bytes);
    manifest[leaf === "source.json" ? "source" : "task"] = byteIdentity(bytes);
  }
  manifest.tabId = "foreign-tab";
  const bytes = archiveJson(manifest); writeFileSync(join(base, "manifest.json"), bytes);
  writeFileSync(join(base, "complete.json"), archiveJson({ version: 1, tabId: f.tabId, taskId: id, manifestHash: archiveHash(bytes) }));
  const reply = await f.call("get_task_archive", { kind: "task", id });
  assert.equal(reply.isError, true, "Leader reads reject internally foreign archive identity");
  f.ws.message({ type: "getFixedTaskArchive", requestId: "wrong-binding", tabId: f.tabId, taskId: id });
  assert.equal(f.ws.messages.find((m: any) => m.requestId === "wrong-binding").type, "error", "owner reads use the same identity binding");
});
