import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, writeFileSync, unlinkSync, readdirSync, linkSync, symlinkSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { scratchDir, importWithTempDataRoot } from "./temp-root.ts";
import { BROAD_VAULT_MESSAGE, resolvedVault, setVaultProjectFolders, vaultSlug, verifiedVaultCopy } from "../server/vault.ts";
import { checkVaultStatus } from "../server/settings/vault.ts";
import { freshState } from "../server/settings/store.ts";

test("broad vaults are rejected at connect and on load; a vault inside a project is allowed", async () => {
  const root = scratchDir(), project = join(root, "project"), tab = join(root, "separate-tab"), normal = scratchDir();
  const inside = join(project, "notes");
  for (const folder of [project, tab, inside]) mkdirSync(folder, { recursive: true });
  const { dataDir, modules: { SettingsService } } = await importWithTempDataRoot(() => import("../server/settings.ts"));
  setVaultProjectFolders(() => [project, tab]);
  try {
    const service = new SettingsService({ dataRoot: dataDir, runCli: async () => { throw new Error("No vendor calls"); } });
    for (const broad of [parse(root).root, homedir(), dirname(homedir()), root, project, tab, process.cwd()]) {
      assert.equal(resolvedVault(broad), null, `no saved grant: ${broad}`);
      await assert.rejects(service.setNotesVault("broad", broad), { message: BROAD_VAULT_MESSAGE }, broad);
      writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ notesVaultPath: broad, permissionModes: {} }));
      assert.equal(new SettingsService({ dataRoot: dataDir }).state.vault.status, "broad", broad);
    }
    for (const accepted of [normal, inside]) {
      await service.setNotesVault("normal", accepted);
      assert.equal(resolvedVault(accepted), realpathSync(accepted));
      assert.equal(service.state.vault.status, "connected");
    }
  } finally { setVaultProjectFolders(() => []); }
});

test("locked probe cleanup never throws from status or freshState and retries once", async () => {
  const root = scratchDir();
  const calls: string[] = [];
  const lockedUnlink = (path: fs.PathLike) => { calls.push(String(path)); throw Object.assign(new Error("locked"), { code: "EBUSY" }); };
  assert.doesNotThrow(() => {
    assert.equal(checkVaultStatus(root, lockedUnlink), "connected");
    const state = freshState({ notesVaultPath: root, defaultProjectFolder: "", permissionModes: {} }, (path) => checkVaultStatus(path, lockedUnlink));
    assert.equal(state.vault.status, "connected");
  });
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(calls.length, 4, "each unique probe gets exactly one retry");
  assert.equal(new Set(calls).size, 2);
  for (const probe of new Set(calls)) unlinkSync(probe);
  assert.deepEqual(readdirSync(root), []);
});

test("settings refuses readonly and missing status after directory validation", async (t) => {
  const { dataDir, modules: { SettingsService } } = await importWithTempDataRoot(() => import("../server/settings.ts"));
  const root = scratchDir();
  const service = new SettingsService({ dataRoot: dataDir });
  for (const kind of ["readonly", "missing"]) {
    const method = kind === "readonly" ? "openSync" : "statSync";
    t.mock.method(fs, method, () => { throw new Error(kind); }); syncBuiltinESMExports();
    try { await assert.rejects(service.setNotesVault(kind, root), kind === "readonly" ? /cannot save notes/ : /folder is missing/); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(service.state.vault.path, null, "refused setting never persisted");
  }
});

test("slug information loss gets a hash while case and whitespace stay readable", () => {
  assert.notEqual(vaultSlug("Ünï"), vaultSlug("n"));
  assert.notEqual(vaultSlug("Café"), vaultSlug("Caf"));
  assert.notEqual(vaultSlug("CON."), vaultSlug("CON"));
  assert.equal(vaultSlug(" My   Project "), "my-project");
  assert.equal(vaultSlug("MY-PROJECT"), "my-project");
});

test("vault verification rejects hardlinks and links that stay inside the vault", async (t) => {
  const root = scratchDir(), file = join(root, "note.md"), linked = join(root, "alias.md");
  writeFileSync(file, "note");
  linkSync(file, linked);
  assert.equal(await verifiedVaultCopy(root, file, 0), false, "hardlink count refuses both names");
  unlinkSync(linked);
  const folder = join(root, "notes"), alias = join(root, "alias"); mkdirSync(folder);
  writeFileSync(join(folder, "note.md"), "note");
  try { symlinkSync(folder, alias, "junction"); }
  catch (error) { t.diagnostic(`SKIP junction refused: ${(error as Error).message}`); return; }
  try { assert.equal(await verifiedVaultCopy(root, join(alias, "note.md"), 0), false, "even an internal junction is refused"); }
  finally { fs.rmdirSync(alias); }
});
