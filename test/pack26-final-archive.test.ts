import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { listTaskArchives } from "../server/fixed-crew/task-archive-files.ts";
import { run4Fixture } from "./pack26-review1-run4-helpers.ts";
import { archiveCopy } from "./pack26-review1-run4-archive-helpers.ts";
import { archiveBase, archiveBytes, bothLists, bothRefuse } from "./pack26-review1-run5-archive-helpers.ts";

test("P26F archive list ignores unrelated entries", async (t) => {
  const f = await run4Fixture(t); await f.ready(); const task = f.task(), runs = f.journal().executions;
  assert.equal((await f.finish()).isError, false);
  const finished = join(f.data, "tasks", "finished", f.tabId), executions = join(finished, "_executions");
  for (let n = 0; n < 52; n++) archiveCopy(f.data, f.tabId, `aaa-${String(n).padStart(3, "0")}`, task, runs);
  const ids = [...Array.from({ length: 52 }, (_, n) => `aaa-${String(n).padStart(3, "0")}`), task.id].sort();
  const executionIds = (await f.tool("list_task_archives", { kind: "execution", cursor: null, limit: 50 })).items.map((item: any) => item.id);
  const archives = archiveBytes(f);
  // Strays an ordinary folder collects: a Windows thumbnail cache, an invalid name, a valid-ID FILE where a task folder belongs,
  // a valid-ID folder where an execution file belongs, and a non-JSON entry. None is an archive; none may be touched.
  const strays = { files: [join(finished, "Thumbs.db"), join(finished, "zzz-valid-id-file"), join(executions, "notes.txt"), join(executions, "Thumbs.db")],
    folders: [join(finished, "not a valid id!"), join(executions, "valid-id-folder.json")] };
  for (const file of strays.files) writeFileSync(file, "stray");
  for (const folder of strays.folders) mkdirSync(folder);
  try {
    const first = await bothLists(f);
    assert.equal(first.items.length, 50); assert.equal(first.nextCursor, ids[49]);
    const next = await bothLists(f, first.nextCursor);
    assert.deepEqual([...first.items, ...next.items].map((item: any) => item.id), ids, "every real archive is listed once, in order, across the pages");
    assert.equal(next.nextCursor, null);
    const after = await f.tool("list_task_archives", { kind: "execution", cursor: null, limit: 50 });
    assert.deepEqual(after.items.map((item: any) => item.id), executionIds, "execution listing ignores the stray entries too");
    assert.deepEqual(archiveBytes(f), { ...archives, ...Object.fromEntries(strays.files.map((file) => [file, Buffer.from("stray").toString("hex")])) }, "no archive byte changed");
    assert.ok(strays.files.every((file) => existsSync(file)) && strays.folders.every((folder) => existsSync(folder)), "strays are never deleted or repaired");
    // A real archive that is damaged still refuses (the ID-shaped candidate is verified, never skipped), and an unfinished one stays unlisted.
    const receipt = join(archiveBase(f, "aaa-000"), "complete.json")  /* always on the first page */, bytes = readFileSync(receipt);
    try { writeFileSync(receipt, "{}"); await bothRefuse(f); } finally { writeFileSync(receipt, bytes); }
    try { unlinkSync(receipt); assert.equal((await bothLists(f)).items.some((item: any) => item.id === "aaa-000"), false, "a receipt-less archive is never advertised"); }
    finally { writeFileSync(receipt, bytes); }
    console.log(`ARCHIVE FILTER strays ignored: ${strays.files.length + strays.folders.length}; 53 archives over 2 pages; corrupt receipt refused; receipt-less unlisted; links not exercised (links are forbidden in this run)`);
  } finally {
    for (const file of strays.files) if (existsSync(file)) unlinkSync(file);
    for (const folder of strays.folders) if (existsSync(folder) && readdirSync(folder).length === 0) rmdirSync(folder);
  }
});

test("P26F archive list refuses a linked candidate", async (t) => {
  const f = await run4Fixture(t); await f.ready();
  assert.equal((await f.finish()).isError, false);
  const base = join(f.data, "tasks", "finished", f.tabId);
  assert.ok(listTaskArchives(f.data, f.tabId, "task").items.length > 0, "a valid archive is beside the link");
  const target = join(f.root, "linked-archive-target");
  mkdirSync(target);
  const taskLink = join(base, "linked-task-candidate");
  try {
    symlinkSync(target, taskLink, "junction");
    try {
      assert.throws(() => listTaskArchives(f.data, f.tabId, "task"), /link/i);
      const reply = await f.call("list_task_archives", { kind: "task", cursor: null, limit: 50 });
      assert.equal(reply.isError, true); assert.match(reply.text, /link/i);
    } finally { rmdirSync(taskLink); }
    // A junction with a JSON candidate name also proves execution links refuse before the file-type skip, without symlink privileges.
    const executionLink = join(base, "_executions", "linked-execution-candidate.json");
    symlinkSync(target, executionLink, "junction");
    try { assert.throws(() => listTaskArchives(f.data, f.tabId, "execution"), /link/i); }
    finally { rmdirSync(executionLink); }
  } finally { rmdirSync(target); }
});
