import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("dist staging, quarantine, restore, locks and publish ordering use temp fixtures", () => {
  const proof = fileURLToPath(new URL("../scripts/packaged-smoke-proof.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [proof, "--temp-only"], { encoding: "utf8", timeout: 120000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  for (const marker of ["BUILDER FAILURE RED", "SMOKE FAILURE RED", "DIST SUCCESS GREEN", "EXE FINGERPRINT GREEN", "EXE FINGERPRINT FAILURE GREEN", "RESTORE FINGERPRINT GREEN",
    "SMOKE ORDER PREVIOUS BUILD GREEN", "DIST OVERLAP RED", "DIST INTERRUPTION GREEN",
    "DISPLACED EXE EPERM GREEN", "FAILED PUBLISH CLEANUP GREEN", "AGED LIVE LOCK RED",
    "REUSED PID LOCK GREEN", "AMBIGUOUS LOCK RED", "MISSING RECORD IDENTITY RED",
    "MISSING LOOKUP IDENTITY RED", "MISSING MALFORMED IDENTITY RED", "MISSING NUMBER IDENTITY RED",
    "MISSING ARRAY IDENTITY RED", "RESTORE CANDIDATE CLEANUP GREEN",
    "LAST-GOOD CANDIDATE CLEANUP GREEN", "RESTORE ROLLBACK RETAINED GREEN",
    "LAST-GOOD ROLLBACK RETAINED GREEN", "SIBLING CANDIDATE SWEEP GREEN", "LOCK TAKEOVER RACE RED",
    "LEFTOVER SWEEP GREEN", "HUNG BUILDER RED", "HUNG SMOKE RED", "ISOLATED STOP FAILURE KEEPS CAUSE GREEN", "ISOLATED RUN ORDER GREEN",
    "WRITE OUTSIDE DATA RED", "WRITE INSIDE DATA GREEN", "ALL PACKAGED SMOKE GUARDS PASSED"]) {
    assert.ok(run.stdout.includes(marker), `missing ${marker}: ${run.stdout}`);
  }
});

test("the exe never ships the owner's own projects, and workspaces.json stays out of git", async () => {

  const files: string[] = JSON.parse(readFileSync("package.json", "utf8")).build.files;
  for (const excluded of ["!config/workspaces.json", "!config/client-prefs.json", "!config/projects.json", "!config/own-sessions.json", "!config/own-sessions.json.tmp"]) assert.ok(files.includes(excluded), `build.files holds ${excluded}`);
  assert.ok(readFileSync(".gitignore", "utf8").split(/\r?\n/).includes("config/workspaces.json"), ".gitignore lists config/workspaces.json");
  assert.ok(files.includes("!**/*.bad-*"), "build.files excludes recovery copies (*.bad-*) everywhere");
  assert.ok(readFileSync(".gitignore", "utf8").split(/\r?\n/).includes("*.bad-*"), ".gitignore lists *.bad-*");
});

// runLimited is a function inside the build script (which builds as soon as it loads), so the real source text is run here with a fake child.
async function runLimitedWith(options: { killStatus: number; closesAfterKill: boolean }, timeoutMs: number, stopWaitMs: number) {
  const source = readFileSync(fileURLToPath(new URL("../scripts/dist.mjs", import.meta.url)), "utf8");
  const text = source.slice(source.indexOf("function runLimited"), source.indexOf("function updateLastGood"));
  assert.ok(text.includes("new Promise"), "the real runLimited source was found");
  const child: any = new EventEmitter();
  child.pid = 4711; child.killed = 0; child.kill = () => { child.killed++; };
  const taskkillCalls: string[][] = [];
  const run = runInNewContext(`${text}; runLimited`, {
    spawn: () => child,
    spawnSync: (_command: string, args: string[]) => { taskkillCalls.push(args); if (options.closesAfterKill) setImmediate(() => child.emit("close", 1)); return { status: options.killStatus }; },
    taskkill: "taskkill", setTimeout, clearTimeout, Promise, Math, Error, String,
  });
  // A runLimited that never settles must fail this test by assertion, not hang the file.
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const never = new Promise<never>((_, reject) => { giveUp = setTimeout(() => { try { assert.fail("runLimited never settled"); } catch (error) { reject(error); } }, 3000); });
  try {
    const result = await Promise.race([run("build", [], {}, timeoutMs, "the builder", stopWaitMs), never]);
    return { result, taskkillCalls, child };
  } finally { clearTimeout(giveUp); }
}

test("runLimited: a timed-out child whose kill failed and that never closes is reported as not stopped, not waited for for ever", async () => {
  const started = Date.now();
  const { result, taskkillCalls, child } = await runLimitedWith({ killStatus: 1, closesAfterKill: false }, 20, 60);
  assert.match(result.error.message, /timed out after .* and could not be stopped \(pid 4711/);
  assert.equal(JSON.stringify(taskkillCalls), JSON.stringify([["/pid", "4711", "/T", "/F"]]), "the tree kill was tried once");
  assert.equal(child.killed, 1, "and the direct child was killed as the fallback");
  assert.ok(Date.now() - started < 5000, "the wait for the exit stayed bounded");
});

test("runLimited: a timed-out child that the kill ended is reported as stopped, and a normal exit passes its status through", async () => {
  const stopped = await runLimitedWith({ killStatus: 0, closesAfterKill: true }, 20, 5000);
  assert.match(stopped.result.error.message, /and its process tree was stopped/);
  assert.equal(stopped.child.killed, 0, "no fallback kill when the tree kill worked");
  const source = readFileSync(fileURLToPath(new URL("../scripts/dist.mjs", import.meta.url)), "utf8");
  const text = source.slice(source.indexOf("function runLimited"), source.indexOf("function updateLastGood"));
  const quick: any = new EventEmitter(); quick.pid = 1;
  const run = runInNewContext(`${text}; runLimited`, { spawn: () => quick, spawnSync: () => assert.fail("no kill on a normal exit"), taskkill: "taskkill", setTimeout, clearTimeout, Promise, Math, Error, String });
  const pending = run("build", [], {}, 60_000, "the builder");
  quick.emit("close", 3);
  assert.equal(JSON.stringify(await pending), JSON.stringify({ status: 3 }));
});
