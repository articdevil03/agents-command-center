// Pack 26 final cleanup: the line cap on a fresh repository, and a missing ProcDump leaving no output behind.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { attachCrashCatcher, findProcdump } from "./crash-catcher.ts";
import { scratchDir, setEnv } from "./temp-root.ts";
import { envWithPath, freshRepo, git, lines, runLineCap, write } from "./pack26-final-tooling-helpers.ts";

test("P26F line cap checks fresh repositories", () => {
  // Control: a fresh main with no remote and every file <= 400 is green, announces the fallback and counts the exact-400 file.
  const green = freshRepo({ "README.md": "# Fresh\n", "src/exact.ts": lines(400) });
  const ok = runLineCap(green);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /origin\/master not found: no comparison base, checking every tracked and untracked file/);
  assert.match(ok.out, /^400 src\/exact\.ts$/m);
  assert.match(ok.out, /2 files checked, 0 over 400 lines/);
  // A committed 401-line file with no origin/master is named; so is an untracked one; an ignored one is not looked at.
  write(green, { "src/committed-big.ts": lines(401) });
  git(green, "add", "-A"); git(green, "commit", "-q", "-m", "big");
  write(green, { "src/é-untracked.ts": lines(401), ".gitignore": "ignored.ts\n", "ignored.ts": lines(900) });
  const red = runLineCap(green);
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /OVER 400: .*src\/committed-big\.ts \(401\)/);
  assert.match(red.out, /OVER 400: .*src\/é-untracked\.ts \(401\)/);
  assert.doesNotMatch(red.out, /ignored\.ts \(/);
  // A staged-then-trimmed file counts by its working content.
  write(green, { "src/committed-big.ts": lines(10) });
  git(green, "add", "src/committed-big.ts");
  write(green, { "src/é-untracked.ts": lines(5) });
  assert.equal(runLineCap(green).code, 0);
  // A valid comparison base keeps the changed-only behaviour: the unchanged 401-line file is not looked at.
  const base = freshRepo({ "README.md": "# Base\n", "src/old-big.ts": lines(401) });
  const sha = git(base, "rev-parse", "HEAD");
  write(base, { "src/new.ts": lines(3) });
  const changedOnly = runLineCap(base, sha);
  assert.equal(changedOnly.code, 0, changedOnly.out);
  assert.doesNotMatch(changedOnly.out, /old-big|not found/);
  assert.match(changedOnly.out, /^3 src\/new\.ts$/m);
  // An explicit bad base fails clearly and never falls back.
  const bad = runLineCap(base, "no-such-base");
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /CC_LINE_CAP_BASE no-such-base is not a commit/);
  assert.doesNotMatch(bad.out, /checking every tracked/);
  // A genuine Git error (not a repository) stays an error with no fallback announcement.
  const outside = runLineCap(scratchDir());
  assert.notEqual(outside.code, 0, outside.out);
  assert.doesNotMatch(outside.out, /checking every tracked/);
});

const catcherUrl = new URL("./crash-catcher.ts", import.meta.url).href;
const winOnly = { skip: process.platform === "win32" ? false : "the crash catcher is Windows only" };

test("P26F missing ProcDump makes no output changes", winOnly, () => {
  const root = scratchDir();
  const emptyPath = join(root, "empty-path"), dumps = join(root, "dumps"), keepDir = join(root, "keep"), log = join(root, "attach.log");
  mkdirSync(emptyPath); mkdirSync(keepDir);
  const old = Array.from({ length: 12 }, (_, i) => `old-${i}.dmp`);
  for (const name of old) writeFileSync(join(keepDir, name), "dump");
  const code = `const m = await import(${JSON.stringify(catcherUrl)}); m.attachCrashCatcher(process.pid, "p26f-missing", ${JSON.stringify(dumps)}); m.attachCrashCatcher(process.pid + 1, "p26f-missing-keep", ${JSON.stringify(keepDir)}); console.log("found=" + m.findProcdump());`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", windowsHide: true, timeout: 30_000, env: envWithPath(emptyPath, { CC_CRASH_CATCHER_LOG: log }) });
  const out = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, out);
  assert.match(out, /crash catcher off: procdump not found/, "the child must take the missing-tool branch, not another early return");
  assert.match(out, /found=null/);
  assert.equal(existsSync(dumps), false, "a missing ProcDump must not create the dump folder");
  assert.equal(existsSync(log), false, "a missing ProcDump must not write an attach log");
  assert.deepEqual(readdirSync(keepDir).sort(), [...old].sort(), "a missing ProcDump must not prune");
});

test("P26F a found ProcDump keeps the attachment arguments, one attach per pid and retention", winOnly, () => {
  const root = scratchDir();
  const bin = join(root, "bin"), dumps = join(root, "dumps"), log = join(root, "attach.log");
  mkdirSync(bin); mkdirSync(dumps);
  writeFileSync(join(bin, "procdump.exe"), "not a real program");
  assert.equal(findProcdump(bin), join(bin, "procdump.exe"));
  const names = Array.from({ length: 12 }, (_, i) => { const name = `d${i}.dmp`; writeFileSync(join(dumps, name), "dump"); utimesSync(join(dumps, name), 1_000 + i, 1_000 + i); return name; });
  const calls: Array<{ program: string; args: string[] }> = [];
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  Object.assign(proc.stdout, { unref() {} }); Object.assign(proc.stderr, { unref() {} });
  const spawnProcess = ((program: string, args: string[]) => { calls.push({ program, args }); return proc; }) as unknown as typeof import("node:child_process").spawn;
  const restore = setEnv({ CC_NO_CRASH_CATCHER: undefined, CC_CRASH_CATCHER_LOG: log });
  try {
    attachCrashCatcher(900_126, "p26f-found", dumps, { program: findProcdump(bin), spawnProcess });
    attachCrashCatcher(900_126, "p26f-found", dumps, { program: findProcdump(bin), spawnProcess });
    assert.deepEqual(calls, [{ program: join(bin, "procdump.exe"), args: ["-accepteula", "-e", "-mm", "900126", dumps] }]);
    assert.equal(readFileSync(log, "utf8"), "900126 p26f-found\n");
    assert.deepEqual(readdirSync(dumps).sort(), names.slice(2).sort(), "the two oldest dumps are pruned, the newest ten stay");
  } finally {
    restore();
    proc.emit("close", 0);
  }
});
