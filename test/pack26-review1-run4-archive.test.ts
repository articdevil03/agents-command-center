import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run4Fixture } from "./pack26-review1-run4-helpers.ts";
import { failPublication, archiveCopy } from "./pack26-review1-run4-archive-helpers.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { unlinkSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

for (const point of [".rollover.json", "/source.json", "/task.json", "execution", "/manifest.json", "/tasks/alpha-dev.json", "/executions/alpha-dev.json", "/complete.json", "retire"] as const) {
  test(`P26R4 rollover publication failure and startup retry ${point}`, async (t) => {
    const f = await run4Fixture(t); await f.ready();
    const previous = f.task(), before = f.disk(), taskFile = join(f.data, "tasks", `${f.tabId}.json`);
    const launches = f.server.launched.length;
    const suffix = point === "retire" ? ".rollover.json" : point === "execution" ? `/_executions/${f.journal().executions[0].id}.json` : point;
    // The marker uses link publication; retirement uses unlink. Receipt and
    // task/journal steps have earlier durable archives available for recovery.
    let result;
    if (point === "retire") {
      // Fail after the receipt, using the actual unlink of the marker.
      const fs = await import("node:fs");
      const original = fs.default.unlinkSync;
      const { syncBuiltinESMExports } = await import("node:module");
      fs.default.unlinkSync = (file) => { if (String(file).endsWith(".rollover.json")) throw new Error("retire failure"); return original(file); };
      syncBuiltinESMExports();
      try { result = await f.finish(); } finally { fs.default.unlinkSync = original; syncBuiltinESMExports(); }
    } else result = await failPublication(suffix, () => f.finish());
    assert.equal(result.isError, true, result.text);
    assert.equal(f.server.launched.length, launches, "publication failure spawns no action");
    const marker = join(f.data, "tasks", `${f.tabId}.rollover.json`);
    const hasMarker = existsSync(marker);
    if (hasMarker) assert.equal(f.server.fixedTasks.summary(f.tabId).blocked, true, "an incomplete rollover never advertises an empty successful task in cache");
    const live = readFileSync(taskFile, "utf8");
    assert.ok(live === before.task || live === "null\n", "original source or exact empty format survives");
    console.log(JSON.stringify({ point, task: live === "null\n" ? "empty" : "original", journal: f.disk().journal === before.journal ? "original" : "pruned", marker: hasMarker, spawn: f.server.launched.length - launches }));
    if (hasMarker) {
      // New TaskStore with no cache, through the production startup get loop.
      f.controls.initialize();
      assert.equal((await f.tool("get_fixed_task")).task, null);
      assert.equal(existsSync(marker), false);
    } else {
      f.restart(); assert.equal((await f.finish()).isError, false);
    }
    const archived = await f.tool("get_task_archive", { kind: "task", id: previous.id });
    assert.equal(archived.task.stage, "complete");
    assert.equal(f.disk().task, "null\n"); assert.equal(f.journal().executions.length, 0);
    assert.equal(f.server.launched.length, launches, "startup and retry never replay an external action");
  });
}

test("P26R4 source-byte mismatch, stale identity and replaced Leader preserve published bytes", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  for (const expected of [{ ...f.expected(), taskId: "foreign" }, { ...f.expected(), planVersion: 50 }, { ...f.expected(), recordRevision: 1 }]) {
    const before = f.disk(); assert.equal((await f.finish({ expected })).isError, true); assert.deepEqual(f.disk(), before);
  }
  const instance = f.server.leaderInstances.get(f.tabId), intact = f.disk();
  f.server.leaderInstances.set(f.tabId, {});
  try { assert.equal((await f.finish()).isError, true); assert.deepEqual(f.disk(), intact); }
  finally { f.server.leaderInstances.set(f.tabId, instance); }
  const changed = f.task(); changed.plan.scope = "Different source";
  writeFileSync(join(f.data, "tasks", `${f.tabId}.json`), JSON.stringify(changed));
  const before = f.disk(); assert.equal((await f.finish()).isError, true); assert.deepEqual(f.disk(), before);
});

test("P26R4 archive routes refuse linked ancestors and oversized bytes before parsing", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const taskId = f.task().id;
  assert.equal((await f.finish()).isError, false);
  const base = join(f.data, "tasks", "finished", f.tabId, taskId), original = fs.lstatSync;
  // No link is created. The actual filesystem boundary reports a linked
  // ancestor, exercising archive tools' real refuseLinks call site.
  fs.lstatSync = ((file: any, options: any) => {
    const info = original(file, options);
    return String(file) === base ? Object.assign(Object.create(info), { isSymbolicLink: () => true }) : info;
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  try {
    const result = await f.call("get_task_archive", { kind: "task", id: taskId });
    assert.equal(result.isError, true); assert.match(result.text, /Linked/);
    f.ws.message({ type: "getFixedTaskArchive", requestId: "linked-archive", tabId: f.tabId, taskId });
    assert.equal(f.ws.messages.find((m: any) => m.requestId === "linked-archive").type, "error");
  } finally { fs.lstatSync = original; syncBuiltinESMExports(); }
  const source = join(base, "source.json"); writeFileSync(source, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  const result = await f.call("get_task_archive", { kind: "task", id: taskId });
  assert.equal(result.isError, true); assert.match(result.text, /read budget/, "bounded read refuses before JSON parsing");
});

for (const corruption of ["new-task", "journal", "marker", "archive-hash", "missing-archive"] as const) {
  test(`P26R4 pending rollover fails closed on ${corruption}`, async (t) => {
    const f = await run4Fixture(t); await f.ready(); const taskId = f.task().id;
    const interruption = corruption === "missing-archive" ? "/executions/alpha-dev.json" : "/tasks/alpha-dev.json";
    assert.equal((await failPublication(interruption, () => f.finish())).isError, true);
    const marker = join(f.data, "tasks", `${f.tabId}.rollover.json`);
    const source = join(f.data, "tasks", "finished", f.tabId, taskId, "source.json");
    if (corruption === "new-task") {
      const newer = JSON.parse(f.disk().task); newer.id = "newer-task";
      for (const run of newer.executions) run.taskId = newer.id;
      writeFileSync(join(f.data, "tasks", `${f.tabId}.json`), JSON.stringify(newer));
    }
    if (corruption === "journal") writeFileSync(join(f.data, "executions", `${f.tabId}.json`), f.disk().journal + " ");
    if (corruption === "marker") writeFileSync(marker, "{}");
    if (corruption === "archive-hash") writeFileSync(source, "conflict");
    if (corruption === "missing-archive") unlinkSync(source);
    const before = f.disk(), transaction = readFileSync(marker), launches = f.server.launched.length;
    const result = await f.call("get_fixed_task"); assert.equal(result.isError, true, result.text);
    assert.deepEqual(f.disk(), before); assert.deepEqual(readFileSync(marker), transaction);
    assert.equal(f.server.launched.length, launches);
  });
}

test("P26R4 pending recovery runs ahead of an already primed cache", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const other = createTaskStore(f.data, () => f.folder); assert.ok(other.get(f.tabId));
  assert.equal((await failPublication("/source.json", () => f.finish())).isError, true);
  f.install(other);
  assert.equal((await f.tool("get_fixed_task")).task, null);
  assert.equal(other.summary(f.tabId), null); assert.equal(f.journal().executions.length, 0);
});

test("P26R4 more than 500 completed directories remain readable in bounded stable pages", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const task = f.task(), runs = f.journal().executions;
  assert.equal((await f.finish()).isError, false);
  for (let n = 0; n < 501; n++) archiveCopy(f.data, f.tabId, `page-${String(n).padStart(4, "0")}`, task, runs);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await f.tool("list_task_archives", { kind: "task", cursor, limit: 50 });
    assert.ok(page.items.length <= 50); seen.push(...page.items.map((item: any) => item.id)); cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(seen.length, 502); assert.equal(new Set(seen).size, 502); assert.deepEqual(seen, [...seen].sort());
  const last = await f.tool("get_task_archive", { kind: "task", id: "page-0500" });
  assert.equal(last.task.id, "page-0500"); assert.equal(last.executions.length, runs.length);
  for (const args of [{ kind: "task", cursor: "../escape", limit: 50 }, { kind: "task", cursor: null, limit: 51 }]) {
    assert.equal((await f.call("list_task_archives", args)).isError, true);
  }
  assert.equal((await f.call("get_task_archive", { kind: "task", id: "../escape" })).isError, true);
});

test("P26R4 a completed task at list request and exact source byte limits needs no append", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  const task = f.task();
  const journal = f.journal(), writer = task.executions.find((run: any) => run.kind === "build");
  const bound = journal.executions.find((run: any) => run.id === writer.id);
  while (task.executions.length < 500) {
    const id = `historical-writer-${task.executions.length}`;
    task.executions.push({ ...writer, id, sessionId: id });
    journal.executions.push({ ...bound, id });
  }
  f.setJournal(journal);
  task.checks = Array.from({ length: 500 }, () => structuredClone(task.checks[0]));
  task.reviews = Array.from({ length: 500 }, () => structuredClone(task.reviews[0]));
  task.recordRevision = 3000;
  task.requests = Array.from({ length: 2000 }, (_, n) => ({ id: `request-at-limit-${n}`, digest: task.planDigest, result: { recordRevision: n + 1, executionId: null } }));
  f.writeTask(task);
  const file = join(f.data, "tasks", `${f.tabId}.json`), bytes = readFileSync(file, "utf8");
  writeFileSync(file, bytes + " ".repeat(4 * 1024 * 1024 - Buffer.byteLength(bytes)));
  f.restart(); assert.equal(f.task().requests.length, 2000);
  const original = readFileSync(file); assert.equal(original.length, 4 * 1024 * 1024);
  const reply = await f.finish(); assert.equal(reply.isError, false, reply.text);
  assert.deepEqual(readFileSync(join(f.data, "tasks", "finished", f.tabId, task.id, "source.json")), original);
  const archived = await f.tool("get_task_archive", { kind: "task", id: task.id });
  assert.equal(archived.task.recordRevision, 3000); assert.equal(archived.task.requests.length, 2000);
  assert.equal(archived.task.checks.length, 500); assert.equal(archived.task.reviews.length, 500);
  assert.equal(archived.task.executions.length, 500); assert.equal(archived.executions.length, 501);
});
