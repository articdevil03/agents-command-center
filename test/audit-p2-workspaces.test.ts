import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tempRoot } from "./temp-root.ts";
import { fixedWorkspaces, launchConfig } from "./fixed-server-fixture.ts";

for (const code of ["EBUSY", "EACCES", "EIO"]) test(`workspace seed ${code} keeps saved workspace and blocks recovery`, () => {
  const root = tempRoot(), config = join(root, "config"); fs.mkdirSync(config);
  const path = join(config, "workspaces.json"), bytes = JSON.stringify(fixedWorkspaces()); fs.writeFileSync(path, bytes);
  let reads = 0;
  const loaded = launchConfig(root, root, { readFileSync: (p: any, ...args: any[]) => {
    // Recovery's initial format read succeeds. Seeding encounters the lock.
    if (String(p) === path && ++reads > 1) throw Object.assign(new Error("locked"), { code });
    return (fs.readFileSync as any)(p, ...args);
  } });
  assert.equal(loaded.workspaceRecovery().blocked, true);
  assert.equal(reads, 4); assert.equal(fs.readFileSync(path, "utf8"), bytes);
  assert.equal(fs.readdirSync(config).some((name) => name.includes(".bad-")), false);
});

test("workspace seed retries a transient lock instead of replacing saved values", () => {
  const root = tempRoot(); fs.mkdirSync(join(root, "config"));
  const path = join(root, "config", "workspaces.json"), bytes = JSON.stringify(fixedWorkspaces()); fs.writeFileSync(path, bytes);
  let reads = 0;
  const loaded = launchConfig(root, root, { readFileSync: (p: any, ...args: any[]) => {
    if (String(p) === path && ++reads === 2) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    return (fs.readFileSync as any)(p, ...args);
  } });
  assert.equal(loaded.workspaceRecovery().blocked, false); assert.equal(reads, 3);
  assert.equal(fs.readFileSync(path, "utf8"), bytes);
});

test("initial workspace format read retries a transient lock before seeding", () => {
  const root = tempRoot(); fs.mkdirSync(join(root, "config"));
  const path = join(root, "config", "workspaces.json"), bytes = JSON.stringify(fixedWorkspaces()); fs.writeFileSync(path, bytes);
  let reads = 0;
  const loaded = launchConfig(root, root, { readFileSync: (p: any, ...args: any[]) => {
    if (String(p) === path && ++reads === 1) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    return (fs.readFileSync as any)(p, ...args);
  } });
  assert.equal(loaded.workspaceRecovery().blocked, false); assert.equal(reads, 3);
  assert.equal(fs.readFileSync(path, "utf8"), bytes);
});

for (const failure of ["damage", "read", "copy"]) test(`workspace write preserves an unreadable original before replacement: ${failure}`, () => {
  const root = tempRoot(); fs.mkdirSync(join(root, "config"));
  const path = join(root, "config", "workspaces.json"); fs.writeFileSync(path, JSON.stringify(fixedWorkspaces()));
  let active = false;
  const loaded = launchConfig(root, root, {
    readFileSync: (p: any, ...args: any[]) => {
      if (active && failure === "read" && String(p) === path) throw Object.assign(new Error("locked"), { code: "EIO" });
      return (fs.readFileSync as any)(p, ...args);
    },
    copyFileSync: (...args: any[]) => { if (active && failure === "copy") throw new Error("copy refused"); return (fs.copyFileSync as any)(...args); },
  });
  const bytes = failure === "read" ? JSON.stringify(fixedWorkspaces()) : "invalid saved workspace";
  fs.writeFileSync(path, bytes); active = true;
  if (failure === "copy") {
    assert.throws(() => loaded.writeWorkspaces(fixedWorkspaces()), /could not be safely preserved/);
    assert.equal(fs.readFileSync(path, "utf8"), bytes);
  } else {
    loaded.writeWorkspaces(fixedWorkspaces());
    const copies = fs.readdirSync(join(root, "config")).filter((name) => name.startsWith("workspaces.json.bad-"));
    assert.equal(copies.length, 1); assert.equal(fs.readFileSync(join(root, "config", copies[0]), "utf8"), bytes);
  }
});

test("launch safety retries a transient read lock and preserves known process facts", () => {
  const root = tempRoot(), path = join(root, "safety.json");
  fs.writeFileSync(path, JSON.stringify({ blocked: ["tab.coder"], live: [{ seatId: "tab.coder", runId: "run-one" }] }));
  let reads = 0;
  const loaded = launchConfig(root, root, { readFileSync: (p: any, ...args: any[]) => {
    if (String(p) === path && ++reads === 1) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    return (fs.readFileSync as any)(p, ...args);
  } });
  let restored: any;
  assert.doesNotThrow(() => { restored = loaded.readLaunchSafety(path); });
  assert.deepEqual(JSON.parse(JSON.stringify(restored)).live, [{ seatId: "tab.coder", runId: "run-one" }]);
  assert.equal(reads, 2);
});

test("workspace writer can create a missing destination", () => {
  const root = tempRoot(), target = join(root, "new-workspace.json");
  const loaded = launchConfig(root, root); loaded.writeWorkspaces(fixedWorkspaces(), target);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), fixedWorkspaces());
});
