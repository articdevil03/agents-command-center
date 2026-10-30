import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { packagedSmokePermissionArgs } from "../packaged-smoke-permissions.mjs";
import { runIsolatedPackagedServer, runIsolatedProofs } from "../packaged-smoke.mjs";
import { tempOnly, packedAppSource } from "./context.mjs";
import { makeTemp, removeOwnedTemp, deadPid } from "./fixtures.mjs";
import assert from "node:assert/strict";

// 4m. The isolated-server run must report why readiness failed even when the server then refuses to stop.
{
  const { EventEmitter } = await import("node:events");
  const dir = makeTemp("cc-isolated-error-");
  try {
    const stuck = new EventEmitter();
    Object.assign(stuck, { pid: deadPid(), exitCode: null, signalCode: null, connected: false, stdout: new EventEmitter(), stderr: new EventEmitter() });
    let message = "";
    try {
      await runIsolatedPackagedServer({ app: dir, outsideRoot: dir, data: dir, spawnProcess: () => stuck, logger: { log() {} }, timeoutMs: 100, stopTimeoutMs: 100 });
    } catch (error) { message = error.message; }
    assert.match(message, /isolated server readiness timeout/, "the readiness failure must survive");
    assert.match(message, /did not close after shutdown and process-tree stop/, "the stop failure is reported too");
    assert.ok(message.indexOf("readiness timeout") < message.indexOf("did not close"), "the readiness failure comes first");
    console.log("ISOLATED STOP FAILURE KEEPS CAUSE GREEN: readiness error reported before the stop error");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 4n. The isolated server runs twice on one fresh folder: first without the permission flags (it seeds the folder, which needs
// fsync, disabled under --permission), then with them on the seeded folder. A permission run on an empty folder goes red here.
{
  const { EventEmitter } = await import("node:events");
  const dir = makeTemp("cc-isolated-order-");
  try {
    const folder = join(dir, "isolated-data");
    const runs = [];
    const spawnProcess = (_exe, args) => {
      const permission = args.includes("--permission");
      const child = new EventEmitter();
      Object.assign(child, { pid: 0, exitCode: null, signalCode: null, connected: true, stdout: new EventEmitter(), stderr: new EventEmitter() });
      child.disconnect = () => { child.connected = false; child.exitCode = 0; child.emit("exit", 0, null); };
      const run = { permission, seededBefore: null, write: args.find((a) => a.startsWith("--allow-fs-write=")) };
      runs.push(run);
      setImmediate(() => {
        run.seededBefore = readdirSync(folder).length > 0;
        if (permission && !run.seededBefore) { child.exitCode = 1; child.emit("exit", 1, null); return; } // Node: fsync is disabled under --permission
        if (!permission) writeFileSync(join(folder, "seed.json"), "{}");
        child.stdout.emit("data", "Command Center running at http://127.0.0.1:5\n");
      });
      return child;
    };
    const lines = [];
    await runIsolatedProofs({ app: dir, outsideRoot: dir, spawnProcess, logger: { log: (line) => lines.push(line) }, timeoutMs: 1000, stopTimeoutMs: 1000 });
    assert.deepEqual(runs.map((r) => r.permission), [false, true], "first launch without the permission flags, then with them");
    assert.deepEqual(runs.map((r) => r.seededBefore), [false, true], "the permission run happens only on an already seeded folder");
    assert.equal(runs[1].write, `--allow-fs-write=${folder}`, "write containment is scoped to the same folder");
    assert.equal(lines.filter((l) => l.startsWith("PASS")).length, 2, "each run logs its own PASS line");
    console.log("ISOLATED RUN ORDER GREEN: fresh-folder launch first, permission run on the seeded folder second, two PASS lines");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 5. Keep the real isolated server proof: removing zod from a temp copy must
// fail with ERR_MODULE_NOT_FOUND, while the untouched packaged copy reaches ready.
if (!tempOnly) {
  const dir = makeTemp("cc-packaged-server-proof-");
  try {
    const app = join(dir, "app");
    const data = join(dir, "data");
    cpSync(packedAppSource, app, { recursive: true });
    mkdirSync(data);
    const zod = realpathSync(join(app, "node_modules", "zod"));
    assert.equal(relative(dir, zod), join("app", "node_modules", "zod"));
    rmSync(zod, { recursive: true });
    let missingZod;
    try {
      await runIsolatedPackagedServer({ app, outsideRoot: dir, data, logger: { log() {} } });
    } catch (error) {
      missingZod = error;
    }
    assert.ok(missingZod, "removing zod must make the real isolated server fail");
    assert.match(missingZod.message, /ERR_MODULE_NOT_FOUND/);
    assert.match(missingZod.message, /zod/);
    assert.doesNotMatch(missingZod.message, /ERR_ACCESS_DENIED/);
    console.log("MISSING ZOD RED: exit 1, ERR_MODULE_NOT_FOUND, zod");

    const greenApp = join(dir, "green-app");
    const greenData = join(dir, "green-data");
    cpSync(packedAppSource, greenApp, { recursive: true });
    mkdirSync(greenData);
    await runIsolatedPackagedServer({ app: greenApp, outsideRoot: dir, data: greenData, logger: { log() {} } });
    console.log("PACKAGED SERVER GREEN: copied app reached ready using only its own files");
  } finally {
    removeOwnedTemp(dir);
  }
}

// 6. The actual Node permission flags used by the smoke allow writes only in
// the temporary data directory. Needs no build artifacts, so it runs in --temp-only too.
{
  const dir = makeTemp("cc-write-permission-proof-");
  try {
    const data = join(dir, "data");
    mkdirSync(data);
    const forbidden = join(dir, "should-not-write.txt");
    const bad = spawnSync(process.execPath, [
      ...packagedSmokePermissionArgs(data), "-e", 'require("node:fs").writeFileSync(process.argv[1], "nope")', forbidden,
    ], { encoding: "utf8", timeout: 10000 });
    assert.notEqual(bad.status, 0, "write outside the data dir must be denied");
    assert.match(bad.stderr, /ERR_ACCESS_DENIED/);
    assert.equal(existsSync(forbidden), false);
    console.log(`WRITE OUTSIDE DATA RED: exit ${bad.status}, ${bad.stderr.split("\n")[0]}`);

    const allowed = join(data, "ok.txt");
    const good = spawnSync(process.execPath, [
      ...packagedSmokePermissionArgs(data), "-e", 'require("node:fs").writeFileSync(process.argv[1], "ok")', allowed,
    ], { encoding: "utf8", timeout: 10000 });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(readFileSync(allowed, "utf8"), "ok");
    console.log("WRITE INSIDE DATA GREEN: exit 0");
  } finally {
    removeOwnedTemp(dir);
  }
}
