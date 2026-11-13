import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { run4Fixture } from "./pack26-review1-run4-helpers.ts";
import { archiveCopy } from "./pack26-review1-run4-archive-helpers.ts";
import { archiveBase, archiveBytes, rewriteArchive, bothLists, bothRefuse } from "./pack26-review1-run5-archive-helpers.ts";
import { mutations } from "../scripts/mutation-proof.mjs";
import { SERVER_PROOFS } from "./tooling-sweep-proof-server.ts";

test("P26R5 list fields", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const task = f.task();
  assert.equal((await f.finish()).isError, false);
  const archive = await f.tool("get_task_archive", { kind: "task", id: task.id });
  assert.notEqual(task.plan.scope, archive.manifest.reason);
  const before = { live: f.disk(), archive: archiveBytes(f) };
  const page = await bothLists(f);
  assert.deepEqual(page, { items: [{ id: task.id, kind: "task", scope: task.plan.scope, completedAt: archive.manifest.completedAt }], nextCursor: null });
  assert.deepEqual(await f.tool("get_task_archive", { kind: "task", id: task.id }), archive);
  assert.deepEqual({ live: f.disk(), archive: archiveBytes(f) }, before, "reads preserve every live and archive byte");
  const executions = await f.tool("list_task_archives", { kind: "execution", cursor: null, limit: 50 });
  assert.ok(executions.items.length > 0);
  for (const item of executions.items) assert.deepEqual(Object.keys(item).sort(), ["id", "kind"]);
  const instance = f.server.leaderInstances.get(f.tabId);
  f.server.leaderInstances.set(f.tabId, {});
  try { assert.equal((await f.call("list_task_archives", { kind: "task" })).isError, true); }
  finally { f.server.leaderInstances.set(f.tabId, instance); }
  const requestId = "foreign-owner-tab";
  f.ws.message({ type: "listFixedTaskArchives", requestId, tabId: "missing-tab", cursor: null, limit: 50 });
  assert.equal(f.ws.messages.find((m: any) => m.requestId === requestId).type, "error");
});

test("P26R5 list rejects unverified archives", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const id = f.task().id;
  assert.equal((await f.finish()).isError, false);
  const base = archiveBase(f, id), files = ["source.json", "task.json", "manifest.json", "complete.json"];
  const original = Object.fromEntries(files.map((name) => [name, readFileSync(join(base, name))]));
  const restore = () => { for (const name of files) writeFileSync(join(base, name), original[name]); };
  try {
    for (const invalid of ["identity", "receipt", "hash", "scope-empty", "scope-type", "scope-long", "reason-long", "time-invalid", "time-empty", "time-long"]) {
      restore();
      if (invalid === "receipt") writeFileSync(join(base, "complete.json"), "{}");
      else if (invalid === "hash") writeFileSync(join(base, "task.json"), original["task.json"].toString() + " ");
      else rewriteArchive(f, id, (manifest, source) => {
        if (invalid === "identity") manifest.taskId = "foreign";
        if (invalid === "scope-empty") source.plan.scope = "";
        if (invalid === "scope-type") source.plan.scope = 4;
        if (invalid === "scope-long") source.plan.scope = "s".repeat(8193);
        if (invalid === "reason-long") manifest.reason = "r".repeat(8193);
        if (invalid === "time-invalid") manifest.completedAt = "not-a-date";
        if (invalid === "time-empty") manifest.completedAt = "";
        if (invalid === "time-long") manifest.completedAt = "2026-01-01" + " ".repeat(65);
      });
      await bothRefuse(f);
    }
    restore(); unlinkSync(join(base, "complete.json"));
    assert.deepEqual((await bothLists(f)).items, [], "unfinished receipt-less archive is never advertised");
    restore(); rewriteArchive(f, id, (_manifest, source) => { source.plan.scope = "s".repeat(8192); });
    assert.equal((await bothLists(f)).items[0].scope, "s".repeat(8192));
  } finally { restore(); }
});

test("P26R5 list pages and verified lookahead", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const task = f.task(), runs = f.journal().executions;
  assert.equal((await f.finish()).isError, false);
  for (let n = 0; n < 52; n++) archiveCopy(f.data, f.tabId, `aaa-${String(n).padStart(3, "0")}`, task, runs);
  const ids = [...Array.from({ length: 52 }, (_, n) => `aaa-${String(n).padStart(3, "0")}`), task.id].sort();
  const first = await bothLists(f); assert.equal(first.items.length, 50); assert.equal(first.nextCursor, ids[49]);
  assert.deepEqual(first.items.map((i: any) => i.id), ids.slice(0, 50));
  const next = await bothLists(f, first.nextCursor); assert.equal(next.nextCursor, null);
  assert.deepEqual(next.items.map((i: any) => i.id), ids.slice(50));
  assert.deepEqual([...first.items, ...next.items].map((i: any) => i.id), ids, "no duplicate or missing item");
  assert.deepEqual(await bothLists(f, ids.at(-1)), { items: [], nextCursor: null });
  const lookahead = join(archiveBase(f, ids[50]), "complete.json"), bytes = readFileSync(lookahead);
  try { writeFileSync(lookahead, "{}"); await bothRefuse(f); } finally { writeFileSync(lookahead, bytes); }
  for (const args of [{ cursor: "../bad", limit: 50 }, { cursor: null, limit: 51 }, { cursor: null, limit: 0 }]) {
    assert.equal((await f.call("list_task_archives", { kind: "task", ...args })).isError, true);
  }
});

test("P26R5 retired session proof", () => {
  assert.equal(mutations.some(([name]) => name === "p26r3-delivery-session"), false);
  assert.equal(Object.hasOwn(SERVER_PROOFS, "p26r3-delivery-session"), false);
});
