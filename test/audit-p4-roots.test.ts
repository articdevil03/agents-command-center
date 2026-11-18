import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOwnedRoot, assertOwnedPath } from "../server/owned-path.js";
import { resolveDataRoot } from "../server/data-root.ts";
import { noLinks, verifyBackup, copyBackup, saveRecoveryRecord } from "../server/fixed-crew/recovery-backup.ts";
import { recoverWorkspace } from "../server/fixed-crew/recovery.ts";
import { fingerprint, refuseLinks } from "../server/fixed-crew/task-revision.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";
import { saveJournal, readJournalSnapshot } from "../server/fixed-crew/task-execution.ts";
import { listTaskArchives } from "../server/fixed-crew/task-archive-files.ts";
import { publishExecutionArchive } from "../server/fixed-crew/task-journal-archive.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import type { Plan } from "../server/fixed-crew/task-types.ts";
import { launchConfig } from "./fixed-server-fixture.ts";

const plan: Plan = { id: "plan1", scope: "Boundary check", criteria: ["Works"],
  blocks: [{ id: "b1", scope: "Check", paths: ["a.txt"] }],
  risk: { level: "small", reason: "Contained", paths: ["a.txt"], verification: ["unit"] },
  visibleWork: false, large: false, integration: false, design: false, paths: ["a.txt"],
  consumers: [], sharedInputs: [], checks: ["unit"], shipping: ["commit"], reviewReason: "Independent" };
const defaults = (folder: string): any => ({ projects: [{ id: "project", folder,
  tabs: [{ id: "tab1", folder, fixedCrew: { version: 1 } }] }] });
function fixture(t: TestContext) {
  const base = fs.mkdtempSync(join(tmpdir(), "cc-p4-roots-"));
  const real = join(base, "real"), alias = join(base, "alias"), external = join(base, "external");
  fs.mkdirSync(real); fs.mkdirSync(external);
  const sentinel = join(external, "SENTINEL"); fs.writeFileSync(sentinel, "untouched");
  const links: string[] = [];
  const link = (target: string, name: string) => { fs.symlinkSync(target, name, "junction"); links.push(name); };
  link(real, alias);
  const root = join(alias, "data"), project = join(alias, "project");
  fs.mkdirSync(root); fs.mkdirSync(project); fs.writeFileSync(join(project, "a.txt"), "one");
  t.after(() => {
    for (const name of [...new Set(links)].reverse()) {
      try { assert.ok(fs.lstatSync(name).isSymbolicLink()); fs.rmdirSync(name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      assert.equal(fs.readFileSync(sentinel, "utf8"), "untouched");
    }
    assert.equal(fs.readFileSync(sentinel, "utf8"), "untouched");
    function clean(dir: string) {
      assert.equal(fs.lstatSync(dir).isSymbolicLink(), false);
      for (const name of fs.readdirSync(dir)) {
        const file = join(dir, name), info = fs.lstatSync(file);
        assert.equal(info.isSymbolicLink(), false);
        if (info.isDirectory()) clean(file); else fs.unlinkSync(file);
      }
      assert.deepEqual(fs.readdirSync(dir), []); fs.rmdirSync(dir);
    }
    clean(base);
  });
  return { base, real, alias, root, project, external, sentinel, link };
}
function allowed(f: ReturnType<typeof fixture>) {
  assert.doesNotThrow(() => refuseLinks(join(f.root, "tasks", "future.json"), f.root), "linked ancestor must work first");
}

test("P4 linked data ancestor loads recovery, writes verified backup, saves tasks and journals, lists archives", (t) => {
  const f = fixture(t); allowed(f);
  fs.mkdirSync(join(f.root, "config")); fs.writeFileSync(join(f.root, "config/workspaces.json"), "old bytes");
  const result = recoverWorkspace(f.root, defaults);
  assert.equal(result.blocked, false); assert.equal(result.recovered, true);
  assert.equal(fs.readFileSync(join(result.archive!, "config/workspaces.json"), "utf8"), "old bytes");
  assert.equal(recoverWorkspace(f.root, defaults).blocked, false);
  const store = createTaskStore(f.root, () => f.project);
  const seats = Object.fromEntries(FIXED_CREW.map((seat) => [seat.slot, seat.preferred]));
  const task = store.create("tab1", plan, seats, store.actor("planner"));
  assert.equal(createTaskStore(f.root, () => f.project).get("tab1")!.id, task.id);
  const journal = { version: 1 as const, activeExecutionId: null, executions: [] };
  saveJournal(f.root, "tab1", journal); assert.deepEqual(readJournalSnapshot(f.root, "tab1"), journal);
  assert.deepEqual(listTaskArchives(f.root, "tab1", "task"), { items: [], nextCursor: null });
  publishExecutionArchive(f.root, "tab1", { id: "old-run", tabId: "tab1", taskId: null, planVersion: 0,
    role: "coder", selectedSlot: "coder", selectionReason: "Earlier failed run", assignment: seats.coder,
    kind: "build", status: "failed", processEnded: true, consumed: false, logPath: null });
  assert.deepEqual(listTaskArchives(f.root, "tab1", "execution"), { items: [{ id: "old-run", kind: "execution" }], nextCursor: null });
});

test("P4 data root canonicalizes linked ancestors and future leaves", (t) => {
  const f = fixture(t);
  assert.equal(resolveDataRoot({ CC_DATA_DIR: f.root }, f.base), join(f.real, "data"));
  assert.equal(resolveDataRoot({ CC_DATA_DIR: join(f.root, "future/child") }, f.base), join(f.real, "data/future/child"));
});

for (const folder of ["tasks", "executions", "tasks/finished", "backups", "config"]) {
  test(`P4 linked ancestor allowed but internal ${folder} junction refused`, (t) => {
    const f = fixture(t); allowed(f);
    const target = join(f.root, folder); fs.mkdirSync(join(target, ".."), { recursive: true }); f.link(f.external, target);
    if (folder === "backups" || folder === "config") {
      assert.equal(recoverWorkspace(f.root, defaults).blocked, true);
    } else if (folder === "executions") {
      assert.throws(() => readJournalSnapshot(f.root, "tab1"), /[Ll]ink/);
    } else if (folder === "tasks/finished") {
      assert.throws(() => listTaskArchives(f.root, "tab1", "task"), /[Ll]ink/);
    } else assert.throws(() => createTaskStore(f.root, () => f.project).get("tab1"), /[Ll]ink/);
  });
}

test("P4 relocated data root loads workspace, writes backup and reloads tasks", (t) => {
  const f = fixture(t); allowed(f);
  const linkedRoot = join(f.alias, "linked-data"); f.link(join(f.real, "data"), linkedRoot);
  assert.doesNotThrow(() => resolveDataRoot({ CC_DATA_DIR: linkedRoot }, f.base));
  assert.equal(resolveDataRoot({ CC_DATA_DIR: linkedRoot }, f.base), join(f.real, "data"));
  fs.mkdirSync(join(linkedRoot, "config")); fs.writeFileSync(join(linkedRoot, "config/workspaces.json"), "old bytes");
  const recovered = recoverWorkspace(linkedRoot, defaults);
  assert.equal(recovered.blocked, false); assert.equal(recovered.recovered, true);
  assert.equal(fs.readFileSync(join(recovered.archive!, "config/workspaces.json"), "utf8"), "old bytes");
  assert.equal(recoverWorkspace(linkedRoot, defaults).blocked, false);
  const projectLink = join(f.alias, "linked-project"); f.link(f.project, projectLink);
  assert.throws(() => fingerprint(projectLink, plan), /Linked task paths are refused/);
  const store = createTaskStore(linkedRoot, () => f.project);
  const seats = Object.fromEntries(FIXED_CREW.map((seat) => [seat.slot, seat.preferred]));
  const task = store.create("tab1", plan, seats, store.actor("planner"));
  assert.equal(createTaskStore(linkedRoot, () => f.project).get("tab1")!.id, task.id);
  const journal = { version: 1 as const, activeExecutionId: null, executions: [] };
  saveJournal(linkedRoot, "tab1", journal); assert.deepEqual(readJournalSnapshot(linkedRoot, "tab1"), journal);
  assert.deepEqual(listTaskArchives(linkedRoot, "tab1", "task"), { items: [], nextCursor: null });
});

test("P4 default owned root policy refuses a root junction and linked file leaves", (t) => {
  const f = fixture(t); allowed(f);
  const linkedRoot = join(f.alias, "linked-data"); f.link(join(f.real, "data"), linkedRoot);
  assert.throws(() => resolveOwnedRoot(linkedRoot), /[Ll]ink/);
  fs.mkdirSync(join(f.root, "tasks")); f.link(f.external, join(f.root, "tasks/tab1.json"));
  assert.throws(() => createTaskStore(f.root, () => f.project).get("tab1"), /[Ll]ink/);
});

test("P4 relocated root stays pinned to its link and real directory identities", (t) => {
  const f = fixture(t);
  const linkedRoot = join(f.alias, "linked-data"); f.link(join(f.real, "data"), linkedRoot);
  let boundary: ReturnType<typeof resolveOwnedRoot>;
  assert.doesNotThrow(() => { boundary = resolveOwnedRoot(linkedRoot, { allowRootLink: true }); });
  const root = boundary!;
  assert.equal(assertOwnedPath(root, linkedRoot), join(f.real, "data"));
  fs.renameSync(join(f.real, "data"), join(f.real, "old-data")); fs.mkdirSync(join(f.real, "data"));
  assert.throws(() => assertOwnedPath(root, linkedRoot), /changed/);
  fs.rmdirSync(linkedRoot); f.link(f.external, linkedRoot);
  assert.throws(() => assertOwnedPath(root, linkedRoot), /changed/);
});

test("P4 relocated root still refuses internal folder junctions and escapes", (t) => {
  const f = fixture(t);
  const linkedRoot = join(f.alias, "linked-data"); f.link(join(f.real, "data"), linkedRoot);
  let boundary: ReturnType<typeof resolveOwnedRoot>;
  assert.doesNotThrow(() => { boundary = resolveOwnedRoot(linkedRoot, { allowRootLink: true }); });
  f.link(f.external, join(linkedRoot, "tasks"));
  assert.throws(() => assertOwnedPath(boundary!, join(linkedRoot, "tasks/SENTINEL")), /[Ll]ink/);
  assert.throws(() => assertOwnedPath(boundary!, f.sentinel), /escapes/);
  assert.throws(() => createTaskStore(linkedRoot, () => f.project).get("tab1"), /[Ll]ink/);
  assert.equal(recoverWorkspace(linkedRoot, defaults).blocked, true);
});

test("P4 replacing a relocation link to the same target is refused", (t) => {
  const f = fixture(t);
  const linkedRoot = join(f.alias, "linked-data"), oldLink = join(f.alias, "old-link");
  f.link(join(f.real, "data"), linkedRoot);
  let boundary: ReturnType<typeof resolveOwnedRoot>;
  assert.doesNotThrow(() => { boundary = resolveOwnedRoot(linkedRoot, { allowRootLink: true }); });
  fs.renameSync(linkedRoot, oldLink);
  try { f.link(join(f.real, "data"), linkedRoot); }
  finally { assert.ok(fs.lstatSync(oldLink).isSymbolicLink()); fs.rmdirSync(oldLink); }
  assert.equal(fs.readFileSync(f.sentinel, "utf8"), "untouched");
  assert.throws(() => assertOwnedPath(boundary!, linkedRoot), /changed/);
});

test("P4 project fingerprint permits ancestor junction and refuses an internal junction", (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() => fingerprint(f.project, plan));
  f.link(f.external, join(f.project, "linked"));
  assert.throws(() => fingerprint(f.project, { ...plan, paths: ["linked/SENTINEL"] }), /[Ll]ink/);
});

test("P4 task store and recovery refuse a replaced root between calls", (t) => {
  const f = fixture(t); allowed(f);
  const store = createTaskStore(f.root, () => f.project);
  assert.equal(store.get("tab1"), null);
  assert.equal(recoverWorkspace(f.root, defaults).blocked, false);
  fs.renameSync(join(f.real, "data"), join(f.real, "old-data")); fs.mkdirSync(join(f.real, "data"));
  assert.throws(() => store.get("tab1"), /changed/);
  assert.equal(recoverWorkspace(f.root, defaults).blocked, true);
});

test("P4 linked journal and workspace file leaves refuse without touching targets", (t) => {
  const f = fixture(t); allowed(f);
  fs.mkdirSync(join(f.root, "executions")); f.link(f.external, join(f.root, "executions/tab1.json"));
  assert.throws(() => readJournalSnapshot(f.root, "tab1"), /[Ll]ink/);
  fs.mkdirSync(join(f.root, "config")); f.link(f.external, join(f.root, "config/workspaces.json"));
  assert.equal(recoverWorkspace(f.root, defaults).blocked, true);
});

test("P4 trusted store root wins over storage-named ancestors for journals and archives", (t) => {
  const f = fixture(t); allowed(f);
  fs.mkdirSync(join(f.base, "tasks"));
  const alias = join(f.base, "tasks/profile"); f.link(f.real, alias);
  const root = join(alias, "data"), store = createTaskStore(root, () => f.project);
  assert.doesNotThrow(() => assert.equal(store.get("tab1"), null), "store must establish its explicit root before journals or archives");
  const journal = { version: 1 as const, activeExecutionId: null, executions: [] };
  assert.doesNotThrow(() => saveJournal(root, "tab1", journal));
  assert.deepEqual(readJournalSnapshot(root, "tab1"), journal);
  assert.deepEqual(listTaskArchives(root, "tab1", "task"), { items: [], nextCursor: null });
});

test("P4 recovery helpers and unknown task paths require a trusted root", (t) => {
  const f = fixture(t);
  assert.throws(() => (noLinks as any)(f.root), /root is required/);
  assert.throws(() => (verifyBackup as any)(f.root, []), /root is required/);
  assert.throws(() => (copyBackup as any)(f.root, f.root, []), /root is required/);
  assert.throws(() => (saveRecoveryRecord as any)(join(f.root, "record.json"), {}), /root is required/);
  assert.throws(() => refuseLinks(join(f.external, "tasks/file.json")), /root is required/);
  assert.equal(fs.existsSync(join(f.root, "record.json")), false);
});

for (const mode of ["dangling", "file", "missing-drive"]) test(`P4 unavailable ${mode} data root reaches recovery notice without a load-time throw`, (t) => {
  const f = fixture(t);
  let dir = join(f.base, "unavailable");
  if (mode === "dangling") f.link(join(f.base, "missing-target"), dir);
  if (mode === "file") fs.writeFileSync(dir, "preserve file");
  if (mode === "missing-drive") {
    if (process.platform !== "win32") { t.skip("Windows drive semantics"); return; }
    const drive = "ZYXWVUTSRQPONMLKJIHGFED".split("").find((letter) => !fs.existsSync(`${letter}:\\`));
    assert.ok(drive, "unused drive FOUND"); dir = `${drive}:\\CommandCenterData`;
  }
  let root = "";
  assert.doesNotThrow(() => { root = resolveDataRoot({ CC_DATA_DIR: dir }, f.base); });
  assert.equal(root, dir);
  let result: ReturnType<typeof recoverWorkspace>;
  assert.doesNotThrow(() => { result = recoverWorkspace(root, defaults); });
  assert.equal(result!.blocked, true); assert.match(result!.notice!, /^Workspace unavailable\./);
  let loaded: any;
  assert.doesNotThrow(() => { loaded = launchConfig(f.base, dir); });
  assert.equal(loaded.workspaceRecovery().blocked, true);
  assert.match(loaded.workspaceRecovery().notice, /^Workspace unavailable\./);
});

test("P4 pinned root refuses ancestor retarget, replacement and canonical escape", (t) => {
  const f = fixture(t); allowed(f);
  const root = resolveOwnedRoot(f.root);
  assert.equal(assertOwnedPath(root, join(f.root, "missing/leaf"), { allowMissingLeaf: true }), join(f.real, "data/missing/leaf"));
  assert.throws(() => assertOwnedPath(root, join(f.external, "SENTINEL")), /escapes/);
  fs.renameSync(join(f.real, "data"), join(f.real, "old-data")); fs.mkdirSync(join(f.real, "data"));
  assert.throws(() => assertOwnedPath(root, f.root), /changed/);
  fs.rmdirSync(f.alias); f.link(f.external, f.alias);
  assert.throws(() => assertOwnedPath(root, f.root), /changed/);
});

test("P4 injected canonical escape and root retarget during traversal fail closed", (t) => {
  const f = fixture(t); allowed(f);
  let escape = false, retarget = false, visited = false;
  const io = { ...fs, realpathSync(path: fs.PathLike) {
    if (escape && String(path) === join(f.real, "data")) return f.external;
    if (retarget && String(path) === join(f.real, "data")) visited = true;
    if (visited && String(path) === f.root) return f.external;
    return fs.realpathSync(path);
  } };
  const root = resolveOwnedRoot(f.root, { io });
  escape = true;
  assert.throws(() => assertOwnedPath(root, f.root), /escapes|changed/);
  escape = false; retarget = true;
  assert.throws(() => assertOwnedPath(root, f.root), /changed/);
});
