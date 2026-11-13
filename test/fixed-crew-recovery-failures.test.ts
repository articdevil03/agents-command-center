import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { importWithTempDataRoot, scratchDir } from "./temp-root.ts";
const { modules: { config, recovery } } = await importWithTempDataRoot(async () => {
  const paths = await import("../server/config-files.ts");
  assert.match(relative(resolve(tmpdir()), paths.dataRoot), /^cc-scratch-[^\\/]+$/, "resolved import root before config startup writes");
  return {
  config: await import("../server/config.ts"), recovery: await import("../server/fixed-crew/recovery.ts"),
}; });
function fixture() {
  const root = scratchDir();
  assert.match(relative(resolve(tmpdir()), root), /^cc-scratch-[^\\/]+$/, "resolved scratch root before writes");
  fs.mkdirSync(join(root, "config"));
  fs.writeFileSync(join(root, "config", "workspaces.json"), "original legacy bytes");
  fs.writeFileSync(join(root, "config", "projects.json"), "old project bytes");
  return root;
}
const marker = (root: string) => JSON.parse(fs.readFileSync(join(root, "config", "fixed-crew-recovery.json"), "utf8"));
function patch<K extends "copyFileSync" | "renameSync" | "readFileSync">(key: K, fn: any) {
  const previous = fs[key]; (fs as any)[key] = fn; syncBuiltinESMExports();
  return () => { (fs as any)[key] = previous; syncBuiltinESMExports(); };
}
test("FC4F copy failure preserves originals and resumes the prepared archive", () => {
  const root = fixture(), copy = fs.copyFileSync;
  let count = 0;
  const restore = patch("copyFileSync", (from: any, to: any, flags: any) => {
    if (++count === 2) throw new Error("injected copy failure");
    return copy(from, to, flags);
  });
  try {
    const failed = recovery.recoverWorkspace(root, config.defaultWorkspaces);
    assert.equal(failed.blocked, true, "copy failure must block publication");
    assert.match(failed.notice!, /Workspace unavailable/);
    assert.equal(fs.readFileSync(join(root, "config", "workspaces.json"), "utf8"), "original legacy bytes");
    assert.equal(marker(root).status, "prepared");
  } finally { restore(); }
  const archive = marker(root).archive;
  fs.writeFileSync(join(root, "backups", archive, "config", "workspaces.json"), "partial copy after interruption");
  const resumed = recovery.recoverWorkspace(root, config.defaultWorkspaces);
  assert.equal(resumed.blocked, false, resumed.notice);
  assert.equal(marker(root).archive, archive); assert.equal(marker(root).status, "complete");
  assert.equal(fs.readdirSync(join(root, "backups")).length, 1);
});
test("FC4F same-size corrupted backup cannot pass hash verification or publish fresh data", () => {
  const root = fixture(), copy = fs.copyFileSync;
  const restore = patch("copyFileSync", (from: any, to: any, flags: any) => {
    copy(from, to, flags);
    const bytes = fs.readFileSync(to); bytes[0] ^= 1; fs.writeFileSync(to, bytes);
  });
  try {
    const result = recovery.recoverWorkspace(root, config.defaultWorkspaces);
    assert.equal(result.blocked, true, "same-size backup corruption must fail SHA-256 verification");
    assert.equal(fs.readFileSync(join(root, "config", "workspaces.json"), "utf8"), "original legacy bytes");
    assert.equal(marker(root).status, "prepared");
  } finally { restore(); }
});
test("FC4F failed publication leaves original bytes and restarts from the verified backup", () => {
  const root = fixture(), rename = fs.renameSync;
  const restore = patch("renameSync", (from: any, to: any) => {
    if (String(to) === join(root, "config", "workspaces.json")) throw new Error("injected publication failure");
    return rename(from, to);
  });
  try {
    const result = recovery.recoverWorkspace(root, config.defaultWorkspaces);
    assert.equal(result.blocked, true, "publication failure must block");
    assert.equal(fs.readFileSync(join(root, "config", "workspaces.json"), "utf8"), "original legacy bytes");
  } finally { restore(); }
  const archive = marker(root).archive;
  const result = recovery.recoverWorkspace(root, config.defaultWorkspaces);
  assert.equal(result.blocked, false, result.notice); assert.equal(marker(root).archive, archive);
});
test("FC4F interruption after publication finishes the same identity without recopying fresh bytes", () => {
  const root = fixture(), rename = fs.renameSync;
  const restore = patch("renameSync", (from: any, to: any) => {
    if (String(to) === join(root, "config", "fixed-crew-recovery.json") && fs.existsSync(to)) throw new Error("injected completion failure");
    return rename(from, to);
  });
  try { assert.equal(recovery.recoverWorkspace(root, config.defaultWorkspaces).blocked, true); }
  finally { restore(); }
  const before = fs.readFileSync(join(root, "config", "workspaces.json")), record = marker(root);
  assert.equal(record.status, "prepared"); assert.match(before.toString(), /fresh-/);
  const result = recovery.recoverWorkspace(root, config.defaultWorkspaces);
  assert.equal(result.blocked, false, result.notice);
  assert.deepEqual(fs.readFileSync(join(root, "config", "workspaces.json")), before);
  assert.equal(marker(root).archive, record.archive);
  assert.equal(fs.readFileSync(join(result.archive!, "config", "workspaces.json"), "utf8"), "original legacy bytes");
});
test("FC4F source changes after copying refuse replacement and retain the changed original", () => {
  const root = fixture(), copy = fs.copyFileSync;
  const restore = patch("copyFileSync", (from: any, to: any, flags: any) => {
    copy(from, to, flags);
    if (String(from).endsWith("projects.json")) fs.writeFileSync(join(root, "config", "workspaces.json"), "changed source");
  });
  try {
    assert.equal(recovery.recoverWorkspace(root, config.defaultWorkspaces).blocked, true);
    assert.equal(fs.readFileSync(join(root, "config", "workspaces.json"), "utf8"), "changed source");
  } finally { restore(); }
  assert.equal(recovery.recoverWorkspace(root, config.defaultWorkspaces).blocked, true, "restart cannot overwrite changed preparation sources");
});
test("FC4F future mixed data is archived but never downgraded", () => {
  const root = fixture(), future: any = config.defaultWorkspaces(root);
  future.projects[0].tabs[0].fixedCrew = { version: 9, private: "future fields" };
  future.projects[0].tabs.push({ id: "old", crew: [] });
  const bytes = JSON.stringify(future); fs.writeFileSync(join(root, "config", "workspaces.json"), bytes);
  const result = recovery.recoverWorkspace(root, config.defaultWorkspaces);
  assert.equal(result.blocked, true);
  assert.equal(fs.readFileSync(join(root, "config", "workspaces.json"), "utf8"), bytes);
  assert.equal(fs.readFileSync(join(root, "backups", marker(root).archive, "config", "workspaces.json"), "utf8"), bytes);
});
test("FC4F unreadable sources and malformed recovery journals remain blocked without rewriting bytes", () => {
  const root = fixture(), read = fs.readFileSync;
  const restore = patch("readFileSync", (file: any, ...args: any[]) => {
    if (String(file) === join(root, "config", "workspaces.json")) throw new Error("read refused");
    return (read as any)(file, ...args);
  });
  try { assert.equal(recovery.recoverWorkspace(root, config.defaultWorkspaces).blocked, true); }
  finally { restore(); }
  fs.writeFileSync(join(root, "config", "fixed-crew-recovery.json"), "bad journal");
  assert.equal(recovery.recoverWorkspace(root, config.defaultWorkspaces).blocked, true);
  assert.equal(fs.readFileSync(join(root, "config", "workspaces.json"), "utf8"), "original legacy bytes");
  assert.equal(fs.readFileSync(join(root, "config", "fixed-crew-recovery.json"), "utf8"), "bad journal");
});
