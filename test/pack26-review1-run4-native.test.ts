import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixedServer } from "./fixed-crew-execution-helpers.ts";
import { resolveCliOrThrow, leaderChildEnv, windowsSystem32 } from "../server/leader-common/cli-path.ts";
import { listProcesses } from "../server/leader-common/process-tree.ts";

const enabled = process.env.CC_P26_RUN4_NATIVE === "1";
if (!enabled) console.log("NOT RUN: Run 4 native Windows worker/Git shipping and startup recovery require CC_P26_RUN4_NATIVE=1.");
test("P26R4 native worker Git finish startup and fresh task", { skip: !enabled, timeout: 180_000 }, async () => {
  assert.equal(process.platform, "win32", "Windows is required when native acceptance is enabled");
  const git = resolveCliOrThrow("git", leaderChildEnv(), process.cwd());
  assert.match(git, /\.exe$/i, "native git.exe is required");
  const candidates = [resolve(dirname(git), "../../usr/bin/sh.exe"), resolve(dirname(git), "../usr/bin/sh.exe"), join(dirname(git), "sh.exe")];
  const shell = candidates.find((file) => existsSync(file) && statSync(file).isFile());
  assert.ok(shell, `Git bundled shell is required; checked ${candidates.join(", ")}`);
  execFileSync(shell, ["-c", "exit 0"], { cwd: windowsSystem32(), windowsHide: true });
  const hookFixture = fileURLToPath(new URL("./pack26-review1-run4-fixture.cjs", import.meta.url));
  const preload = new URL("./pack26-review1-run4-preload.ts", import.meta.url).href;
  const f = await fixedServer({ nativeProcess: true, git: false, shipping: ["commit"], secondTab: true,
    env: { PATH: `${dirname(git)};${dirname(shell)};${dirname(process.execPath)};${windowsSystem32()}`,
      CC_P26_RUN4_PRELOAD: "1", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${preload} --import ${new URL("./fixed-crew-execution-helpers.ts", import.meta.url).href}` },
    extra({ work, temp }) {
      writeFileSync(join(work, "owned.txt"), "before");
      const run = (...args: string[]) => execFileSync(git, ["-C", work, ...args], { cwd: windowsSystem32(), env: leaderChildEnv(), windowsHide: true, encoding: "utf8" });
      run("init"); run("config", "user.name", "Disposable Run4"); run("config", "user.email", "run4@example.com");
      run("config", "commit.gpgSign", "false"); run("add", "owned.txt"); run("commit", "-m", "Disposable initial state");
      run("config", "core.hooksPath", join(work, ".git", "hooks").replaceAll("\\", "/"));
      writeFileSync(join(work, ".git", "hooks", "pre-commit"), `#!/bin/sh\nunset NODE_OPTIONS\n'${process.execPath.replaceAll("\\", "/")}' '${hookFixture.replaceAll("\\", "/")}' '${temp.replaceAll("\\", "/")}'\n`);
    } });
  const identities: { pid: number; created: number }[] = [];
  const capture = async (pid: number) => {
    const listed = await listProcesses(); assert.ok(listed, "native process list must succeed");
    let row = listed.find((p) => p.pid === pid); assert.ok(row, "owned live process must be found");
    while (row && row.pid !== f.server.child.pid) {
      assert.ok(row.created > 0); identities.push({ pid: row.pid, created: row.created });
      row = listed.find((p) => p.pid === row!.ppid);
    }
    assert.equal(row?.pid, f.server.child.pid, "native ancestry binds this identity to the owned server");
  };
  let pending: ReturnType<typeof f.action> | undefined;
  try {
    await f.planning(); await f.approve();
    for (const kind of ["build", "check", "review"]) {
      f.worker({ delay: kind === "build" ? 2500 : 10, ...(kind === "build" ? { write: "after!" } : {}) });
      const run = await f.action(kind); assert.equal(run.ok, true, run.text);
      if (kind === "build") {
        await f.c.wait(() => f.observation(run.value.runId), "native worker observation");
        await capture(f.observation(run.value.runId).pid);
      }
      await f.ended(run.value.runId);
      assert.equal(f.journal().executions.at(-1).processEnded, true, "production whole-tree callback confirmed end");
      const verified = await f.verify(run.value.runId, kind === "check" ? "focused" : null);
      assert.equal(verified.ok, true, verified.text);
    }
    pending = f.action("commit");
    try {
      await f.c.wait(() => existsSync(join(f.server.temp, "run4-native-hook.json")), "native Git hook hold");
      const pid = JSON.parse(readFileSync(join(f.server.temp, "run4-native-hook.json"), "utf8")).pid;
      await capture(pid);
    } finally { writeFileSync(join(f.server.temp, "run4-native-release"), "release"); }
    const shipped = await pending; assert.equal(shipped.ok, true, shipped.text);
    assert.equal((await f.verify(shipped.value.runId)).ok, true);
    const log = readFileSync(f.journal().executions.at(-1).logPath, "utf8");
    assert.match(log, /"verification":"accepted"/); assert.match(log, /"finalized":true/);
    const listed = await listProcesses(); assert.ok(listed);
    for (const identity of identities) assert.equal(listed.some((p) => p.pid === identity.pid && p.created === identity.created), false, "owned native identity ended");
    console.log(`NATIVE RUN4 ENDED ${JSON.stringify(identities)}`);
    const previous = f.task(), before = readFileSync(join(f.server.data, "tasks", "fixed.json"));
    await new Promise<void>((resolveArm, reject) => {
      const timer = setTimeout(() => { f.server.child.off("message", receive); reject(new Error("native prune arm was not acknowledged")); }, 5000);
      function receive(message: any) { if (message.run4Reply !== 1) return; clearTimeout(timer); f.server.child.off("message", receive); resolveArm(); }
      f.server.child.on("message", receive); f.server.child.send({ run4Control: "arm-prune", id: 1 });
    });
    const interrupted = await f.tool("finish_fixed_task", { expected: f.expected(), reason: "Native shipping verified" });
    assert.equal(interrupted.ok, false); assert.equal(f.task(), null);
    assert.ok(existsSync(join(f.server.data, "tasks", "fixed.rollover.json")));
    const restarted = await f.restart(); assert.notEqual(restarted.oldPid, restarted.newPid);
    const read = await f.tool("get_fixed_task"); assert.equal(read.ok, true); assert.deepEqual(read.value, { task: null, executions: [] });
    const archive = await f.tool("get_task_archive", { kind: "task", id: previous.id }); assert.equal(archive.ok, true, archive.text);
    assert.deepEqual(readFileSync(join(f.server.data, "tasks", "finished", "fixed", previous.id, "source.json")), before);
    await f.planning(); assert.notEqual(f.task().id, previous.id); assert.equal(f.task().ownerScopeApproval, null);
    const denied = await f.action("build"); assert.equal(denied.ok, false); assert.match(denied.text, /Approve/);
  } finally {
    writeFileSync(join(f.server.temp, "run4-native-release"), "release");
    await pending?.catch(() => {}); await f.close();
    console.log(`NATIVE RUN4 CLEANED ${f.server.temp}; owned server and worker handles ended`);
  }
});
