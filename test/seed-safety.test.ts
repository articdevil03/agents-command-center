import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tempRoot } from "./temp-root.ts";
import { fixedWorkspaces, fixedProject, launchConfig as launch } from "./fixed-server-fixture.ts";

// A small valid fixed workspaces file of the test's own: the copies of config/ never carry the live one, so a test that needs the file there writes it.
function writeWorkspaceFixture(file: string, folder: string): void {
  fs.writeFileSync(file, JSON.stringify(fixedWorkspaces([fixedProject("fixture", folder)])));
}

test("preference writer stages complete data; partial write and failed publication preserve the previous file", () => {
  for (const boundary of ["writeFileSync", "renameSync"]) {
    const copy = tempRoot(["server", "config"]);
    writeWorkspaceFixture(path.join(copy, "config/workspaces.json"), copy);
    const final = path.join(copy, "config/client-prefs.json");
    const previous = '{"rightPanelWidth":555}\n';
    fs.writeFileSync(final, previous);
    let calls = 0;
    const loaded = launch(copy, copy, {
      [boundary]: (file, contents, options) => {
        calls++;
        if (boundary === "writeFileSync") fs.writeFileSync(file, contents.slice(0, 1), options);
        assert.equal(fs.readFileSync(final, "utf8"), previous, "old file must remain intact until publication succeeds");
        throw new Error("injected preference failure");
      },
    });
    assert.throws(() => loaded.writeClientPrefs({ rightPanelWidth: 320 }, final), /injected preference failure/);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(final, "utf8"), previous);
    launch(copy, copy).writeClientPrefs({ rightPanelWidth: 400 }, final);
    assert.equal(JSON.parse(fs.readFileSync(final, "utf8")).rightPanelWidth, 400);
  }
});

test("config startup: interrupted workspace seed leaves no final file; retry completes", () => {
  const copy = tempRoot(["server", "config"]), data = tempRoot();
  const final = path.join(data, "config/workspaces.json");
  const failure = Object.assign(new Error("injected disk full"), { code: "ENOSPC" });
  // The example workspaces (a string) is cut short.
  assert.throws(() => launch(copy, data, {
    writeFileSync: (file, contents, options) => {
      fs.writeFileSync(file, contents.slice(0, 1), options);
      assert.equal(fs.existsSync(final), false, "final must stay absent during the write");
      throw failure;
    },
  }), /injected disk full/);
  assert.equal(fs.existsSync(final), false);
  assert.deepEqual(fs.readdirSync(path.join(data, "config")), [], "the failed publish leaves nothing behind");
  const loaded = launch(copy, data);
  assert.equal(fs.existsSync(loaded.workspacesPath), true);
  assert.equal(fs.existsSync(loaded.projectsPath), false, "the bundled projects.json is never seeded");
  assert.deepEqual(fs.readdirSync(path.join(data, "config")), ["workspaces.json"], "no legacy file is seeded");
});

test("config publish: the temp file is flushed (fsync) after it is written and before it is renamed into place", () => {
  const copy = tempRoot(["server", "config"]);
  const final = path.join(copy, "config/client-prefs.json");
  const order: string[] = [];
  const loaded = launch(copy, copy, {
    writeFileSync: (file, contents, options) => { order.push("write"); return fs.writeFileSync(file, contents, options); },
    fsyncSync: (fd) => { order.push("fsync"); return fs.fsyncSync(fd); },
    renameSync: (from, to) => { order.push("rename"); return fs.renameSync(from, to); },
  });
  order.length = 0;
  loaded.writeClientPrefs({ rightPanelWidth: 400 }, final);
  assert.deepEqual(order, ["write", "fsync", "rename"]);
});

test("config startup: cleanup failure after successful publish never fails the launch", () => {
  const copy = tempRoot(["server", "config"]), data = tempRoot();
  let rmAttempts = 0;
  let loaded!: ReturnType<typeof launch>;
  assert.doesNotThrow(() => { loaded = launch(copy, data, { rmSync: () => { rmAttempts++; throw Object.assign(new Error("injected EBUSY"), { code: "EBUSY" }); } }); });
  assert.equal(rmAttempts, 1, "the workspaces publish attempts its temporary cleanup");
  assert.equal(fs.existsSync(loaded.workspacesPath), true);
});

test("config startup: an existing workspaces file wins an atomic publication race", () => {
  const copy = tempRoot(["server", "config"]), data = tempRoot();
  fs.mkdirSync(path.join(data, "config"), { recursive: true });
  const custom = '{"projects":[]}\n';
  let raced = 0;
  launch(copy, data, {
    linkSync: (temporary, final) => {
      fs.writeFileSync(final, custom);
      raced++;
      fs.linkSync(temporary, final);
    },
  });
  assert.equal(raced, 1, "only missing workspaces should be published in this setup");
  assert.equal(fs.readFileSync(path.join(data, "config/workspaces.json"), "utf8"), custom);
});

test("config startup: publication errors and directory collisions propagate and clean up", () => {
  for (const code of ["EACCES", "ENOSPC", "EEXIST"]) {
    const copy = tempRoot(["server", "config"]), data = tempRoot();
    const failure = Object.assign(new Error(`injected ${code}`), { code });
    assert.throws(() => launch(copy, data, {
      linkSync: (_temporary, final) => {
        if (code === "EEXIST") fs.mkdirSync(final);
        throw failure;
      },
    }), (err) => {
      assert.match((err as Error).message, new RegExp(`injected ${code}`));
      if (code !== "EEXIST") assert.match((err as Error).message, /config seeding: could not publish/);
      return true;
    });
  }
  const collided = tempRoot(["server", "config"]), collidedData = tempRoot();
  fs.mkdirSync(path.join(collidedData, "config/workspaces.json"), { recursive: true });
  // Recovery reads the destination first: a folder where the file belongs blocks the workspace (nothing is published over it) instead of failing the launch.
  const blocked = launch(collided, collidedData);
  assert.equal(blocked.workspaceRecovery().blocked, true);
  assert.equal(fs.statSync(path.join(collidedData, "config/workspaces.json")).isDirectory(), true, "the colliding folder is left untouched");
  assert.deepEqual(fs.readdirSync(path.join(collidedData, "config/workspaces.json")), []);
});
