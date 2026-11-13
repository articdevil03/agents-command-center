import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fixedServer } from "./fixed-crew-execution-helpers.ts";
import { resolveCliOrThrow, leaderChildEnv, windowsSystem32 } from "../server/leader-common/cli-path.ts";
import { listProcesses } from "../server/leader-common/process-tree.ts";

const enabled = process.env.CC_P26_RUN3_NATIVE === "1";
if (!enabled) console.log("NOT RUN: native Windows Run3 recovery requires CC_P26_RUN3_NATIVE=1. Injected tree facts do not satisfy native acceptance.");
for (const restart of [false, true]) test(`P26R3 native real Git confirmed finalization recovery restart=${restart}`, { skip: !enabled, timeout: 180_000 }, async () => {
  assert.equal(process.platform, "win32", "Windows prerequisite is mandatory");
  const git = resolveCliOrThrow("git", leaderChildEnv(), process.cwd());
  const shell = resolveCliOrThrow("sh", leaderChildEnv(), process.cwd());
  assert.match(git, /\.exe$/i, "real native Git prerequisite is mandatory");
  const fixture = fileURLToPath(new URL("./pack26-review1-run3-fixture.cjs", import.meta.url));
  const preload = new URL("./pack26-review1-run3-preload.ts", import.meta.url).href;
  let temp = "";
  const old = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${old ?? ""} --import ${preload}`;
  let f: Awaited<ReturnType<typeof fixedServer>>;
  const nativeEnv = { PATH: `${dirname(git)};${dirname(shell)};${dirname(process.execPath)};${windowsSystem32()}` };
  try {
    f = await fixedServer({ nativeProcess: true, secondTab: true, env: nativeEnv, extra({ work, temp: root }) {
      temp = root;
      const run = (...args: string[]) => execFileSync(git, ["-C", work, ...args], { cwd: windowsSystem32(), env: leaderChildEnv(), windowsHide: true, timeout: 30_000, encoding: "utf8" });
      run("init"); run("config", "user.name", "Disposable Run3"); run("config", "user.email", "run3@example.com"); run("config", "commit.gpgSign", "false");
      writeFileSync(join(work, "owned.txt"), "first!"); run("add", "owned.txt"); run("commit", "-m", "Disposable initial commit");
      run("config", "core.hooksPath", join(work, ".git", "hooks").replaceAll("\\", "/"));
      const hook = `#!/bin/sh\nunset NODE_OPTIONS\n'${process.execPath.replaceAll("\\", "/")}' '${fixture.replaceAll("\\", "/")}' edit-after-add '${root.replaceAll("\\", "/")}' '${work.replaceAll("\\", "/")}'\n`;
      writeFileSync(join(work, ".git", "hooks", "pre-commit"), hook);
    } });
  } finally { if (old === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = old; }
  const identities: { pid: number; created: number }[] = [];
  let pending: ReturnType<typeof f.action> | undefined;
  try {
    await f.planning(); await f.approve();
    pending = f.action("checkpoint");
    try {
      await f.c.wait(() => existsSync(join(temp, "native-run3-held.json")) || f.c.messages.some((m) => m.type === "chatDelta" && /request_task_action failed/.test(m.text)), "real pre-commit hook hold");
      assert.ok(existsSync(join(temp, "native-run3-held.json")), `native hook failed before hold: ${readFileSync(f.journal().executions.at(-1).logPath, "utf8")}`);
      const hookPid = JSON.parse(readFileSync(join(temp, "native-run3-held.json"), "utf8")).pid;
      const listed = await listProcesses(); assert.ok(listed, "native process list must succeed");
      let row = listed.find((p) => p.pid === hookPid); assert.ok(row, "owned native hook must be found");
      while (row && row.pid !== f.server.child.pid) {
        assert.ok(row.created > 0, "native creation time is required");
        identities.push({ pid: row.pid, created: row.created });
        row = listed.find((p) => p.pid === row!.ppid);
      }
      assert.equal(row?.pid, f.server.child.pid, "ancestry binds hook/Git identities to our server");
      console.log(`NATIVE RUN3 OWNED ${JSON.stringify(identities)}`);
    } finally { writeFileSync(join(temp, "native-run3-release"), "release"); }
    const failed = await pending; assert.equal(failed.ok, false, failed.text);
    const j = f.journal(), runId = j.activeExecutionId;
    assert.ok(runId); assert.equal(j.executions.at(-1).processEnded, true, "real whole-operation callback confirmed tree end");
    assert.equal(j.executions.at(-1).status, "interrupted");
    const after = await listProcesses(); assert.ok(after);
    for (const identity of identities) assert.equal(after.some((p) => p.pid === identity.pid && p.created === identity.created), false, "observed owned identity ended");
    const log = readFileSync(j.executions.at(-1).logPath);
    if (restart) await f.restart();
    const read = await f.tool("get_fixed_task"); assert.equal(read.ok, true); assert.equal(read.value.executions.at(-1).processEnded, true);
    const result = await f.tool("reconcile_task_execution", { expected: f.expected(), runId, reason: "Abandon failed native Git finalization" });
    assert.equal(result.ok, true, result.text);
    assert.equal(f.task().executions.at(-1).status, "failed"); assert.equal(f.journal().activeExecutionId, null);
    assert.deepEqual(readFileSync(j.executions.at(-1).logPath), log);
    const other = await f.tool("begin_planning", { expected: null, brief: "Read and plan" }, "fixed-second");
    assert.equal(other.ok, true, other.text); await f.ended(other.value.runId, "fixed-second");
  } finally {
    writeFileSync(join(temp, "native-run3-release"), "release"); await pending?.catch(() => {}); await f.close();
    console.log(`NATIVE RUN3 CLEANED ${temp}; server ended; observed identities=${JSON.stringify(identities)}`);
  }
});
