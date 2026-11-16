import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, realpathSync, writeFileSync, utimesSync, symlinkSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { scratchDir, importWithTempDataRoot } from "./temp-root.ts";
import { resolvedVault, vaultHandoverPath, vaultSlug, verifiedVaultCopy, vaultSaveInstruction, vaultNotice } from "../server/vault.ts";
import { checkVaultStatus } from "../server/settings/vault.ts";

test("safe slugs and fixed app-owned paths for hostile and long names", () => {
  const root = scratchDir();
  for (const name of ["My Project", "a.b", "..", "../../escape", "你好", "CON", "prn", "COM1", "trailing...", "A".repeat(1000)]) {
    const slug = vaultSlug(name);
    assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(slug.length <= 64, slug);
    assert.doesNotMatch(slug, /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i);
    assert.equal(vaultSlug(name), slug);
    assert.equal(relative(root, vaultHandoverPath(root, name, name)), join("Command Center", slug, `${slug} RESUME.md`));
  }
});

test("verify regular, fresh, contained vault handovers and reject stale, missing, linked and traversal files", async (t) => {
  const root = scratchDir(), outside = scratchDir();
  mkdirSync(join(root, ".obsidian"));
  writeFileSync(join(root, "User.md"), "user notes");
  writeFileSync(join(root, "User (conflict).md"), "conflict notes");
  const file = vaultHandoverPath(root, "Project", "Tab");
  mkdirSync(dirname(file), { recursive: true });
  const started = Date.now() - 2000;
  assert.equal(await verifiedVaultCopy(root, file, started), false);
  writeFileSync(file, "handover");
  assert.equal(await verifiedVaultCopy(root, file, started), true);
  utimesSync(file, new Date(1000), new Date(1000));
  assert.equal(await verifiedVaultCopy(root, file, started), false, "stale copy never counts as done");
  writeFileSync(join(outside, "note.md"), "outside");
  assert.equal(await verifiedVaultCopy(root, join(root, "..", "note.md"), started), false);
  // Test canonical containment separately from the link check, at the real fs boundary.
  utimesSync(file, new Date(), new Date());
  t.mock.method(fsPromises, "realpath", async (path: any) => String(path) === file ? join(outside, "note.md") : realpathSync(path));
  syncBuiltinESMExports();
  try { assert.equal(await verifiedVaultCopy(root, file, started), false, "realpath escape is refused"); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  unlinkSync(file);
  try { symlinkSync(outside, join(dirname(file), "linked"), "junction"); }
  catch (error) { t.diagnostic(`SKIP junction creation refused by OS: ${(error as Error).message}`); return; }
  assert.equal(await verifiedVaultCopy(root, join(dirname(file), "linked", "note.md"), started), false, "junction escape refused");
  unlinkSync(join(dirname(file), "linked"));
});

test("vault settings validate real directories, write access and remove the unique probe; legacy paths load with status", async (t) => {
  const { dataDir, modules: { SettingsService } } = await importWithTempDataRoot(() => import("../server/settings.ts"));
  const root = scratchDir(), missing = join(root, "missing"), file = join(root, "file");
  writeFileSync(file, "not a folder");
  const service = new SettingsService({ dataRoot: dataDir, runCli: async () => { throw new Error("No vendor calls allowed"); } });
  await assert.rejects(service.setNotesVault("missing", missing), /does not exist/);
  await assert.rejects(service.setNotesVault("file", file), /directory/);
  const before = readdirSync(root);
  await service.setNotesVault("ok", root);
  assert.equal(service.snapshot().vault.status, "connected");
  assert.equal(service.snapshot().vault.path, realpathSync(root));
  assert.deepEqual(readdirSync(root), before, "probe cleanup preserves all preexisting files");
  assert.equal(new SettingsService({ dataRoot: dataDir }).snapshot().vault.status, "connected");
  assert.equal(checkVaultStatus(missing), "missing");
  assert.equal(resolvedVault(missing), null);
  chmodSync(root, 0o555);
  try {
    if (checkVaultStatus(root) !== "readonly") t.diagnostic("SKIP read-only directory: OS permits writes despite mode 0555");
    else await assert.rejects(service.setNotesVault("readonly", root), /cannot save notes/);
  } finally { chmodSync(root, 0o755); }
  await service.setNotesVault("off", null);
  assert.deepEqual(service.snapshot().vault, { path: null, status: "disconnected" });
});

test("notice and Save additions are absent without a vault and in Plan Save", () => {
  assert.equal(vaultNotice(null), "");
  assert.match(vaultNotice("C:\\vault"), /guide note first/);
  assert.equal(vaultSaveInstruction(null, "accept", "p", "t", "2026-11-16T00:00:00Z"), "");
  assert.equal(vaultSaveInstruction("C:\\vault\\note.md", "plan", "p", "t", "2026-11-16T00:00:00Z"), "");
  const instruction = vaultSaveInstruction("C:\\vault\\note.md", "accept", "p", "t", "2026-11-16T00:00:00Z");
  for (const required of ["type: command-center-handover", 'project: "p"', 'tab: "t"', 'saved: "2026-11-16T00:00:00Z"', "Only if", "append one line", "Never rewrite"]) assert.ok(instruction.includes(required), required);
});

test("a vault path typed in a different case still verifies on Windows", { skip: process.platform !== "win32" && "SKIP: case-insensitive paths exist on Windows only" }, async () => {
  const canonical = realpathSync.native(scratchDir()), typed = canonical.toLowerCase() === canonical ? canonical.toUpperCase() : canonical.toLowerCase();
  const file = vaultHandoverPath(typed, "Project", "Tab");
  mkdirSync(dirname(vaultHandoverPath(canonical, "Project", "Tab")), { recursive: true });
  const started = Date.now() - 2000;
  writeFileSync(vaultHandoverPath(canonical, "Project", "Tab"), "handover");
  assert.equal(await verifiedVaultCopy(typed, file, started), true, "case alone never flags a good copy");
});
