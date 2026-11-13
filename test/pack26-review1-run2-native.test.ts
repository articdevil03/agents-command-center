import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ownedTemp } from "./pack26-review1-run2-helpers.ts";
import { createGitOperations } from "../server/fixed-crew/git-operations.ts";
import { runGitCommand, type GitCommandResult } from "../server/fixed-crew/git-process.ts";
import { resolveCliOrThrow, leaderChildEnv, windowsSystem32, setCliSkipFolders } from "../server/leader-common/cli-path.ts";
import { listProcesses } from "../server/leader-common/process-tree.ts";

const enabled = process.env.CC_P26_RUN2_NATIVE === "1";
if (!enabled) console.log("NOT RUN: native Windows Git/hooks/process-tree acceptance requires CC_P26_RUN2_NATIVE=1 outside the write sandbox.");
test("P26R2 native Git literal paths owner commit/push hooks and strict Stop tree confirmation", { skip: !enabled, timeout: 180_000 }, async (t) => {
  assert.equal(process.platform, "win32", "native acceptance requires Windows");
  let nativeCleanupConfirmed = true;
  const root = ownedTemp(t, () => nativeCleanupConfirmed), repo = join(root, "repo"), remote = join(root, "remote.git"); mkdirSync(repo);
  assert.notEqual(process.env.CC_FCX_GIT_BOUNDARY, "1", "native acceptance must not inherit the high-level Git fake");
  assert.notEqual(process.env.CC_FCX_TREE_BOUNDARY, "1", "native acceptance must not inherit injected process facts");
  const appData = join(root, "app-data"); mkdirSync(appData);
  // This isolated test process keeps its private root through its exit hook, including failure cleanup.
  const previousEnv = { CC_DATA_DIR: process.env.CC_DATA_DIR, CC_TEST_FORCE_PACKAGED: process.env.CC_TEST_FORCE_PACKAGED, PATH: process.env.PATH, GIT_TRACE2_EVENT: process.env.GIT_TRACE2_EVENT };
  t.after(() => { for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.CC_DATA_DIR = appData; process.env.CC_TEST_FORCE_PACKAGED = "1";
  setCliSkipFolders(() => [repo, remote]);
  t.after(() => setCliSkipFolders(() => []));
  const executable = resolveCliOrThrow("git", leaderChildEnv(), repo);
  assert.match(executable, /\.(exe|com)$/i);
  const sh = [resolve(dirname(executable), "../../usr/bin/sh.exe"), resolve(dirname(executable), "../usr/bin/sh.exe")].find(existsSync);
  assert.ok(sh, `Git bundled sh.exe resolved from ${executable}`);
  process.env.PATH = `${dirname(sh)};${process.env.PATH ?? ""}`;
  const bootstrap = (args: string[], input?: string) => execFileSync(executable, ["-C", repo, ...args], { cwd: windowsSystem32(), env: leaderChildEnv(), encoding: "utf8", input, windowsHide: true, timeout: 30_000 });
  bootstrap(["init"]); bootstrap(["config", "user.name", "Disposable Run2"]); bootstrap(["config", "user.email", "run2@example.com"]);
  bootstrap(["config", "commit.gpgSign", "false"]); // Disposable repository's owner-selected setup, not a production override.
  bootstrap(["init", "--bare", remote]); bootstrap(["remote", "add", "origin", remote]);
  writeFileSync(join(repo, "owned[1].txt"), "one"); writeFileSync(join(repo, "owned1.txt"), "unrelated");
  writeFileSync(join(repo, "unrelated.txt"), "staged"); bootstrap(["add", "unrelated.txt"]);
  const hookDir = join(repo, ".git", "hooks");
  bootstrap(["config", "core.hooksPath", hookDir]);
  for (const hook of ["pre-commit", "commit-msg", "pre-push"]) writeFileSync(join(hookDir, hook), `#!/bin/sh\nprintf '${hook}\\n' >> '${join(root, "hooks-observed").replaceAll("\\", "/")}'\n`);
  const registry = createGitOperations(), op = registry.register("native", "native-tab", {});
  const run = async (...args: string[]) => {
    const result = await runGitCommand(op, repo, args);
    nativeCleanupConfirmed &&= result.treeEnded;
    console.log(JSON.stringify({ args, command: result.command, code: result.code, treeEnd: result.treeEnded, reason: result.reason }));
    assert.equal(result.command, "success"); assert.equal(result.treeEnded, true); assert.equal(result.reason, null);
    return result.stdout;
  };
  await run("add", "--", "owned[1].txt");
  await run("commit", "--only", "-m", "checkpoint: disposable", "--", "owned[1].txt");
  assert.equal((await run("diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD")).trim(), "owned[1].txt");
  assert.equal((await run("diff", "--cached", "--name-only")).trim(), "unrelated.txt");
  await run("push", "-u", "origin", "HEAD");
  assert.match(readFileSync(join(root, "hooks-observed"), "utf8"), /pre-commit\ncommit-msg\npre-push\n/);
  const fixture = fileURLToPath(new URL("./pack26-review1-run2-git-fixture.cjs", import.meta.url));
  writeFileSync(join(hookDir, "pre-commit"), `#!/bin/sh\n'${process.execPath.replaceAll("\\", "/")}' '${fixture.replaceAll("\\", "/")}' native-hook '${root.replaceAll("\\", "/")}'\n`);
  writeFileSync(join(repo, "owned[1].txt"), "two");
  const held = runGitCommand(op, repo, ["commit", "--only", "-m", "held", "--", "owned[1].txt"]);
  let identities: { pid: number; created: number }[] = [];
  let result!: GitCommandResult;
  try {
    const until = Date.now() + 15_000;
    while (!existsSync(join(root, "native-hook-pids.json")) && Date.now() < until) await new Promise((done) => setTimeout(done, 20));
    assert.ok(existsSync(join(root, "native-hook-pids.json")), "native hung hook and descendant started");
    const pids = Object.values(JSON.parse(readFileSync(join(root, "native-hook-pids.json"), "utf8"))) as number[];
    const list = await listProcesses(); assert.ok(list, "native process list is required, never skipped");
    const owned = new Set(pids);
    // Record the Git root and intermediate hook shell too, walking the observed ancestry up to this test process.
    for (const pid of pids) {
      let row = list.find((entry) => entry.pid === pid);
      while (row && row.ppid !== process.pid) { owned.add(row.ppid); row = list.find((entry) => entry.pid === row!.ppid); }
    }
    identities = [...owned].map((pid) => { const found = list.find((row) => row.pid === pid); assert.ok(found, `native owned PID ${pid} observed`); return { pid, created: found.created }; });
    console.log(`NATIVE OWNED ${JSON.stringify(identities)}`);
  } finally {
    registry.cancel(op.id);
    result = await held;
    nativeCleanupConfirmed &&= result.treeEnded;
    console.log(`NATIVE STOP ${JSON.stringify(result)}`);
    assert.equal(result.treeEnded, true, "owned native Git cleanup must finish even when an earlier assertion fails");
  }
  assert.equal(result.treeEnded, true); assert.equal(op.cancelled, true);
  const after = await listProcesses(); assert.ok(after);
  for (const identity of identities) assert.equal(after.some((row) => row.pid === identity.pid && row.created === identity.created), false, `owned identity ${JSON.stringify(identity)} ended`);
  op.terminal = true; op.finalized = true; registry.complete(op); registry.close(); assert.equal(await registry.drain(), true);
});


test("P26R8G native automatic maintenance stays disabled", { skip: !enabled, timeout: 180_000 }, async t => {
  assert.equal(process.platform, "win32");
  let cleanupConfirmed = true;
  const root = ownedTemp(t, () => cleanupConfirmed), repo = join(root, "maintenance-repo"); mkdirSync(repo);
  const previous = { PATH: process.env.PATH, GIT_TRACE2_EVENT: process.env.GIT_TRACE2_EVENT };
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  assert.notEqual(process.env.CC_FCX_GIT_BOUNDARY, "1");
  assert.notEqual(process.env.CC_FCX_TREE_BOUNDARY, "1");
  const executable = resolveCliOrThrow("git", leaderChildEnv(), repo);
  const sh = [resolve(dirname(executable), "../../usr/bin/sh.exe"), resolve(dirname(executable), "../usr/bin/sh.exe")].find(existsSync);
  assert.ok(sh, `Git bundled sh.exe resolved from ${executable}`);
  process.env.PATH = `${dirname(sh)};${previous.PATH ?? ""}`;
  const bootstrap = (args: string[], input?: string) => execFileSync(executable, ["-C", repo, ...args],
    { cwd: windowsSystem32(), env: leaderChildEnv(), encoding: "utf8", input, windowsHide: true, timeout: 30_000 });
  bootstrap(["init"]); bootstrap(["config", "user.name", "Disposable maintenance"]);
  bootstrap(["config", "user.email", "maintenance@example.com"]); bootstrap(["config", "commit.gpgSign", "false"]);
  for (const [key, value] of [["maintenance.auto", "true"], ["gc.auto", "1"], ["gc.autoPackLimit", "1"],
    ["gc.autoDetach", "false"], ["maintenance.autoDetach", "false"]]) bootstrap(["config", key, value]);
  const prime = (label: string) => {
    for (let n = 0; n < 2; n++) {
      const oid = bootstrap(["hash-object", "-w", "--stdin"], `${label}-${n}`).trim();
      bootstrap(["pack-objects", ".git/objects/pack/pack"], oid + "\n");
    }
  };
  const traceEvents = (file: string) => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const automatic = (events: any[]) => events.filter(e => e.event === "child_start" && e.argv?.some(arg => arg === "maintenance" || arg === "gc"));
  prime("control");
  const control = join(root, "control.jsonl"); process.env.GIT_TRACE2_EVENT = control;
  writeFileSync(join(repo, "owned.txt"), "control"); bootstrap(["add", "owned.txt"]);
  bootstrap(["-c", "maintenance.auto=true", "commit", "-m", "control automatic maintenance"]);
  const observed = traceEvents(control), starts = automatic(observed);
  assert.ok(starts.length > 0, "positive control observes automatic maintenance with the same trace mechanism");
  for (const start of starts) assert.ok(observed.some(e => e.event === "child_exit" && e.sid === start.sid
    && e.child_id === start.child_id && e.code === 0), "control maintenance finished before production");
  delete process.env.GIT_TRACE2_EVENT;
  prime("production");
  const trace = join(root, "production.jsonl"); process.env.GIT_TRACE2_EVENT = trace;
  writeFileSync(join(repo, "owned.txt"), "production");
  const registry = createGitOperations(), op = registry.register("maintenance-native", "maintenance-tab", {});
  try {
    const result = await runGitCommand(op, repo, ["commit", "--only", "-m", "production maintenance disabled", "--", "owned.txt"]);
    cleanupConfirmed = result.treeEnded;
    assert.equal(result.command, "success", result.reason ?? result.stderr); assert.equal(result.treeEnded, true);
    const events = traceEvents(trace);
    assert.ok(events.some(e => e.event === "start" && e.argv?.includes("production maintenance disabled")), "production trace contains the expected Git commit");
    assert.deepEqual(automatic(events), [], "production invokes no automatic maintenance or gc, even a quick no-op");
    console.log(`NATIVE MAINTENANCE control=${JSON.stringify(starts)} production=${JSON.stringify(automatic(events))}`);
  } finally {
    op.terminal = true; op.finalized = true; registry.complete(op); registry.close();
    cleanupConfirmed &&= await registry.drain(); assert.equal(cleanupConfirmed, true, "native owned tree ended");
  }
});
