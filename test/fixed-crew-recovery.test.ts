import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { importWithTempDataRoot, scratchDir } from "./temp-root.ts";
const { modules: { config, recovery, backup } } = await importWithTempDataRoot(async () => {
  const paths = await import("../server/config-files.ts");
  assert.match(relative(resolve(tmpdir()), paths.dataRoot), /^cc-scratch-[^\\/]+$/, "resolved import root before config startup writes");
  return {
  config: await import("../server/config.ts"), recovery: await import("../server/fixed-crew/recovery.ts"), backup: await import("../server/fixed-crew/recovery-backup.ts"),
}; });
function fixture() {
  const root = scratchDir();
  assert.match(relative(resolve(tmpdir()), root), /^cc-scratch-[^\\/]+$/, "resolved scratch root before any write");
  mkdirSync(join(root, "config")); return root;
}
const read = (root: string) => JSON.parse(readFileSync(join(root, "config", "workspaces.json"), "utf8"));
test("FC4 old and mixed workspaces preserve whole private inventory and restart only once", () => {
  for (const mixed of [false, true]) {
    const root = fixture(), workspace = config.defaultWorkspaces(root);
    const old: any = { id: "old", name: "Old", crew: [{ private: "old seat" }] };
    workspace.projects[0].tabs = mixed ? [workspace.projects[0].tabs[0], old] : [old];
    const originals: Record<string, string | Buffer> = {
      "config/workspaces.json": JSON.stringify(workspace), "config/projects.json": "old projects",
      "config/setups.json": "unparseable saved setups", "config/launch-safety.json": "old safety bytes",
      "requests.json": "private requests", "avatars/avatar-old.png": Buffer.from([0, 255, 32, 80]),
      "chats/old.jsonl": "private chat", "logs/old.coder-1.log": "private log", "tasks/old.json": "task",
      "executions/old.json": "journal", "config/client-prefs.json": "prefs", "settings.json": "settings",
      "config/acp-clis.json": "ACP", "config/own-sessions.json": "sessions", "unknown.bin": "unknown",
    };
    for (const [path, bytes] of Object.entries(originals)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), bytes); }
    const result = recovery.recoverWorkspace(root, config.defaultWorkspaces);
    assert.equal(result.blocked, false, result.notice); assert.equal(result.recovered, true);
    assert.match(result.archive!, /backups[\\/]fixed-crew-v1-.*Z-[0-9a-f-]{36}$/);
    const manifest = JSON.parse(readFileSync(join(result.archive!, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "complete", "recovery completion setter must persist");
    for (const entry of manifest.entries) {
      assert.deepEqual(readFileSync(join(result.archive!, entry.path)), Buffer.from(originals[entry.path]));
      assert.equal(entry.sha256, backup.hashBytes(Buffer.from(originals[entry.path])));
      assert.equal(entry.size, Buffer.byteLength(originals[entry.path]));
    }
    for (const [path, bytes] of Object.entries(originals)) if (path !== "config/workspaces.json") assert.deepEqual(readFileSync(join(root, path)), Buffer.from(bytes), `${path} stays in place`);
    const fresh = read(root), tab = fresh.projects[0].tabs[0];
    assert.equal(fresh.projects.length, 1); assert.equal(fresh.projects[0].tabs.length, 1);
    assert.match(tab.id, /^fresh-/); assert.notEqual(tab.id, "example-development"); assert.equal(tab.fixedCrew.version, 1);
    assert.deepEqual(tab.crew, []); assert.deepEqual(tab.steps, []);
    const published = readFileSync(join(root, "config", "workspaces.json"));
    assert.equal(recovery.recoverWorkspace(root, config.defaultWorkspaces).archive, result.archive);
    assert.deepEqual(readFileSync(join(root, "config", "workspaces.json")), published);
    assert.equal(readdirSync(join(root, "backups")).length, 1);
  }
});
test("FC4 malformed data and missing workspace with old projects are preserved without migration", () => {
  for (const bytes of ["{bad", "null", '{"projects":[null]}', null]) {
    const root = fixture();
    if (bytes !== null) writeFileSync(join(root, "config", "workspaces.json"), bytes);
    else writeFileSync(join(root, "config", "projects.json"), "not valid JSON");
    const result = recovery.recoverWorkspace(root, config.defaultWorkspaces);
    assert.equal(result.blocked, false, result.notice); assert.equal(read(root).projects[0].tabs[0].fixedCrew.version, 1);
    const record = JSON.parse(readFileSync(join(result.archive!, "manifest.json"), "utf8"));
    assert.ok(record.entries.some((entry: any) => entry.path === "config/setups.json" && entry.size === null && entry.sha256 === null), "missing optional paths are recorded");
    if (bytes !== null) assert.equal(readFileSync(join(result.archive!, "config", "workspaces.json"), "utf8"), bytes);
  }
});
test("FC4 supported and future fixed workspaces never reset and fresh installations need no archive", () => {
  for (const version of [1, 99, null]) {
    const root = fixture(), workspace = config.defaultWorkspaces(root);
    if (version !== null) {
      (workspace.projects[0].tabs[0].fixedCrew as any).version = version;
      writeFileSync(join(root, "config", "workspaces.json"), JSON.stringify(workspace));
    }
    if (version !== null) writeFileSync(join(root, "config", "setups.json"), "unparseable");
    const original = version === null ? null : readFileSync(join(root, "config", "workspaces.json"));
    const result = recovery.recoverWorkspace(root, config.defaultWorkspaces);
    assert.deepEqual(result, { blocked: false, recovered: false });
    assert.equal(existsSync(join(root, "backups")), false);
    if (original) assert.deepEqual(readFileSync(join(root, "config", "workspaces.json")), original);
  }
});
test("FC4 a missing workspace with orphaned history gets a new identity", () => {
  const root = fixture(); mkdirSync(join(root, "chats"));
  writeFileSync(join(root, "chats", "example-development.jsonl"), "old transcript");
  const result = recovery.recoverWorkspace(root, config.defaultWorkspaces);
  assert.equal(result.blocked, false, result.notice); assert.equal(result.recovered, true);
  assert.notEqual(read(root).projects[0].tabs[0].id, "example-development");
  assert.equal(readFileSync(join(root, "chats", "example-development.jsonl"), "utf8"), "old transcript");
});
test("FC4 fresh identity checks all history stores and old safety keys before publication", () => {
  const root = fixture();
  writeFileSync(join(root, "config", "workspaces.json"), "legacy");
  const ids = [0, 1, 2, 3, 4, 5].map((n) => `${n}0000000-0000-4000-8000-000000000000`);
  for (const [n, dir] of ["chats", "logs", "tasks", "executions"].entries()) {
    mkdirSync(join(root, dir)); writeFileSync(join(root, dir, `fresh-${ids[n]}${dir === "logs" ? ".coder-1.log" : ".json"}`), "history");
  }
  writeFileSync(join(root, "config", "launch-safety.json"), JSON.stringify({ blocked: [`fresh-${ids[4]}.coder`] }));
  let n = 0;
  const result = recovery.recoverWorkspace(root, config.defaultWorkspaces, () => ids[n++]);
  assert.equal(result.blocked, false, result.notice);
  assert.equal(read(root).projects[0].tabs[0].id, `fresh-${ids[5]}`, "fresh identity must skip every history collision");
});
test("FC4 real config startup detects legacy bytes before validation or projects migration", () => {
  const root = fixture(); writeFileSync(join(root, "config", "workspaces.json"), "old invalid bytes");
  writeFileSync(join(root, "config", "setups.json"), "saved setups must not be parsed");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'const c=await import("./server/config.ts"); console.log(JSON.stringify(c.readWorkspaces()));'], {
    env: { ...process.env, CC_DATA_DIR: root, CC_TEST_FORCE_PACKAGED: "1" }, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fresh-/); assert.equal(read(root).projects[0].tabs[0].fixedCrew.version, 1);
  assert.equal(readdirSync(join(root, "backups")).length, 1);
});
