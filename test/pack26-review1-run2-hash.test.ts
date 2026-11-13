import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, writeFileSync, readFileSync, statSync, utimesSync, unlinkSync, appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fingerprint, digest } from "../server/fixed-crew/task-revision.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import { ownedTemp, populate, testPlan } from "./pack26-review1-run2-helpers.ts";

function measured(root: string, plan: ReturnType<typeof testPlan>) {
  let bytesRead = 0, reads = 0;
  const original = fs.readSync, originalStat = fs.lstatSync;
  const visited = new Map<string, number | null>();
  const prefix = resolve(root) + sep;
  fs.lstatSync = ((file: string, ...args: any[]) => {
    const info = (originalStat as any)(file, ...args);
    const name = String(file);
    if (name.startsWith(prefix)) visited.set(name, info.isFile() ? info.size : null);
    return info;
  }) as typeof originalStat;
  fs.readSync = ((...args: any[]) => { const count = (original as any)(...args); bytesRead += count; reads++; return count; }) as typeof original;
  syncBuiltinESMExports();
  const start = performance.now();
  try {
    const revision = fingerprint(root, plan);
    return { ms: performance.now() - start, entries: Object.keys(revision.files).length,
      content: Object.values(revision.files).filter((v) => /^[a-f0-9]{64}$/.test(v)).length, bytesRead, reads, revision, reason: null };
  } catch (error) {
    return { ms: performance.now() - start, entries: visited.size, content: 0, bytesRead, reads, revision: null, reason: String(error) };
  } finally { fs.readSync = original; fs.lstatSync = originalStat; syncBuiltinESMExports(); }
}

for (const dimension of ["entries", "bytes"] as const) test(`P26R2H ${dimension} real store refuses without publishing partial disk/cache`, (t) => {
  const root = ownedTemp(t), project = join(root, "project"); mkdirSync(project);
  writeFileSync(join(project, "owned.txt"), "one");
  const store = createTaskStore(join(root, "data"), () => project), plan = testPlan();
  const seats = Object.fromEntries(FIXED_CREW.map((s) => [s.slot, s.preferred]));
  const actor = store.actor("planner");
  const task = store.create("tab", plan, seats, actor);
  const file = join(root, "data", "tasks", "tab.json"), before = readFileSync(file);
  populate(join(project, "large"), dimension === "entries" ? 5000 : 65, dimension === "entries" ? 1 : 1024 * 1024);
  const oversized = testPlan(["large"]);
  const result = measured(project, oversized);
  assert.match(result.reason ?? "ACCEPTED", new RegExp(`exceeds the ${dimension} dimension`));
  assert.equal(result.bytesRead, 0, "metadata refusal must precede ALL content reads");
  assert.match(result.reason!, /4,096-entry\/64-MiB.*No partial fingerprint was accepted/);
  assert.throws(() => store.create("new-tab", oversized, seats, actor), /fingerprint budget/);
  assert.equal(store.get("new-tab"), null);
  assert.throws(() => store.apply({ tabId: "tab", taskId: task.id, planVersion: 1, recordRevision: task.recordRevision, requestId: "change" },
    { type: "plan", plan: oversized }, actor), /fingerprint budget/);
  assert.deepEqual(readFileSync(file), before); assert.deepEqual(store.get("tab"), task);
});

test("P26R2H stored historical 10000-entry revisions still load unchanged", (t) => {
  const root = ownedTemp(t), project = join(root, "project"); mkdirSync(project); writeFileSync(join(project, "owned.txt"), "one");
  const data = join(root, "data"), store = createTaskStore(data, () => project);
  const task = store.create("tab", testPlan(), { leader: FIXED_CREW[0].preferred }, store.actor("planner"));
  const files = Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [`historical/${index}`, "missing"]));
  const historical = { files, digest: digest(files) };
  task.revision = historical; task.revisions = [historical];
  const file = join(data, "tasks", "tab.json"); writeFileSync(file, JSON.stringify(task));
  const before = readFileSync(file), reloaded = createTaskStore(data, () => project).get("tab")!;
  assert.equal(Object.keys(reloaded.revision.files).length, 10000); assert.deepEqual(readFileSync(file), before);
});

test("P26R2H preflight accepted full hashes cover overlaps missing membership and restored timestamps", (t) => {
  const root = ownedTemp(t); mkdirSync(join(root, "covered"));
  const file = join(root, "covered", "a.txt"); writeFileSync(file, "one");
  const plan = { ...testPlan(["covered", "covered/a.txt"]), consumers: ["missing"], sharedInputs: ["shared.txt"] };
  writeFileSync(join(root, "shared.txt"), "shared");
  const before = measured(root, plan);
  assert.equal(before.reason, null); assert.equal(before.bytesRead, 9); assert.equal(before.entries, 4);
  assert.equal(before.revision!.files["covered/a.txt"], createHash("sha256").update("one").digest("hex"));
  const old = statSync(file); writeFileSync(file, "two"); utimesSync(file, old.atime, old.mtime);
  const changed = fingerprint(root, plan); assert.notEqual(changed.digest, before.revision!.digest);
  writeFileSync(join(root, "missing"), "added"); assert.notEqual(fingerprint(root, plan).digest, changed.digest);
  writeFileSync(join(root, "covered", "new"), "new"); const added = fingerprint(root, plan);
  assert.ok(added.files["covered/new"]); unlinkSync(file); const removed = fingerprint(root, plan); assert.notEqual(removed.digest, added.digest);
  writeFileSync(join(root, "shared.txt"), "SHARED"); assert.notEqual(fingerprint(root, plan).digest, removed.digest);
});

for (const change of ["growth", "membership", "identity"] as const) test(`P26R2H observed ${change} during read refuses complete scan`, (t) => {
  const root = ownedTemp(t), covered = join(root, "covered"); mkdirSync(covered);
  const file = join(covered, "one.txt"); writeFileSync(file, Buffer.alloc(1024, 97));
  // Make the observed directory metadata change deterministic even when both writes land in one filesystem clock tick.
  if (change === "membership") utimesSync(covered, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
  const read = fs.readSync; let changed = false, bytes = 0;
  fs.readSync = ((...args: any[]) => {
    const count = (read as any)(...args); bytes += count;
    if (!changed) {
      changed = true;
      if (change === "growth") appendFileSync(file, Buffer.alloc(1024 * 1024, 98));
      if (change === "membership") writeFileSync(join(covered, "new.txt"), "new");
      if (change === "identity") { unlinkSync(file); writeFileSync(file, "replacement"); }
    }
    return count;
  }) as typeof read;
  syncBuiltinESMExports();
  try {
    assert.throws(() => fingerprint(root, testPlan(["covered"])), /changed during fingerprint/);
    assert.equal(changed, true); assert.equal(bytes, 1024, "reads remain bounded by the preflight size even after observed growth");
  } finally { fs.readSync = read; syncBuiltinESMExports(); }
});

test("P26R2H measurements real scanner three runs excluding fixture creation", (t) => {
  const root = ownedTemp(t);
  for (const [name, count, size] of [["mid", 3000, 8192], ["near", 4000, 16 * 1024], ["flat", 5000, 1], ["bytes", 65, 1024 * 1024]] as const) populate(join(root, name), count, size);
  const cases = [
    { name: "ordinary-owned", root, paths: ["mid/0.txt", "mid/1.txt"], accepted: true },

    ...["mid", "near", "flat", "bytes"].map((name) => ({ name, root, paths: [name], accepted: ["mid", "near"].includes(name) })),

  ];
  for (const item of cases) {
    const results = Array.from({ length: 3 }, () => measured(item.root, testPlan(item.paths)));
    const durations = results.map((r) => r.ms), sorted = [...durations].sort((a, b) => a - b);
    console.log(JSON.stringify({ case: item.name, durations, min: sorted[0], median: sorted[1], max: sorted[2], runs: results.map(({ revision, ...r }) => r) }));
    for (const result of results) {
      if (item.accepted) { assert.equal(result.reason, null); assert.ok(result.content > 0); }
      else { assert.match(result.reason!, /fingerprint budget|Unsupported task input/); assert.equal(result.bytesRead, 0); }
    }
  }
});
