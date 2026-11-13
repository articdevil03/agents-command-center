import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { socketGitFixture } from "./pack26-review1-run2-git-helpers.ts";
import { processFixture } from "./pack26-review1-run2-process-helpers.ts";
import { setCliSkipFolders } from "../server/leader-common/cli-path.ts";
import { createTreeTracker } from "../server/leader-common/process-tree.ts";

test("P26R2G await executable cwd options responsive real socket and production spawn", async () => {
  const f = await socketGitFixture({ hold: "rev-parse", releaseMs: 2200 });
  let result: Promise<any> | undefined;
  try {
    let finished = false;
    const publishedRevision = f.c.tab("fixed").fixedTask.detailRevision;
    result = f.call().then((value) => { finished = true; return value; });
    await f.waitHeld();
    assert.equal(finished, false, "Git tool must await the held command");
    const before = f.c.messages.length;
    f.c.send({ type: "testFolderBusy", tabId: "fixed-second" });
    await f.c.wait(() => f.c.messages.slice(before).some((m) => m.type === "testFolderBusyResult"), "socket reads while Git pending");
    assert.equal(existsSync(join(f.server.temp, "git-released")), false, "socket reply observed BEFORE independent finite external release");
    assert.equal(finished, false, "no completion publication before command completion");
    assert.equal(f.c.tab("fixed").fixedTask.detailRevision, publishedRevision, "Git completion state must not be broadcast before awaited Git finishes");
    const contract = f.rows("git-spawn.jsonl")[0];
    assert.equal(contract.program, join(f.server.temp, "bin", "git.exe"));
    assert.equal(contract.cwd, join(process.env.SystemRoot ?? "C:\\Windows", "System32"));
    assert.deepEqual(contract.args.slice(0, 12), ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "--literal-pathspecs", "-C", f.server.work, "rev-parse"]);
    assert.equal(contract.shell, false); assert.equal(contract.windowsHide, true);
    assert.deepEqual(contract.stdio, ["ignore", "pipe", "pipe"]); assert.deepEqual(contract.privateEnv, []);
    f.release(); const reply = await result;
    assert.equal(reply.body.result.isError, undefined, JSON.stringify(reply));
    assert.equal(f.terminal().length, 1); assert.equal(f.terminal()[0].verification, "accepted");
  } finally { f.release(); await result; await f.close(); }
});

test("P26R2G executable rejects missing batch and every workspace executable before spawning", async (t) => {
  const f = processFixture(t);
  unlinkSync(join(f.bin, "git.exe"));
  assert.throws(f.run, /not found on PATH/);
  writeFileSync(join(f.bin, "git.cmd"), "@echo off");
  assert.throws(f.run, /batch wrappers are unsupported/); unlinkSync(join(f.bin, "git.cmd"));
  const second = join(f.root, "another-project"); mkdirSync(second); writeFileSync(join(second, "git.exe"), "bad");
  writeFileSync(join(f.folder, "git.exe"), "bad");
  process.env.PATH = `${f.folder};${second}`; setCliSkipFolders(() => [f.folder, second]);
  assert.throws(f.run, /only inside a project folder/); assert.equal(f.spawns.length, 0);
});

for (const mode of ["spawn", "nonzero", "timeout", "output", "drain", "race"] as const) {
  test(`P26R2G ${mode} production process boundary keeps result tree and finalization separate`, async (t) => {
      const f = processFixture(t, { spawnThrows: mode === "spawn", timeoutMs: mode === "timeout" ? 15 : 1000, drainMs: 15 });
      const pending = f.run();
      if (mode === "nonzero") f.exit(7);
      if (mode === "output") { f.child.stdout.write("é".repeat(300_000)); f.child.stderr.write("é".repeat(300_000)); }
      let lateClose = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (mode === "timeout" || mode === "output") timer = setTimeout(() => f.exit(0), 80); // Finite release also makes blocking/missing-guard mutants reach an assertion.
      if (mode === "drain") { f.exit(0, false); timer = setTimeout(() => { lateClose = true; f.child.emit("close", 0, null); }, 5000); }
      if (mode === "race") { f.child.emit("error", new Error("process failure")); f.exit(0); }
      try {
        const result = await pending;
        assert.equal(result.treeEnded, true, `${mode}: fresh injected list confirms absence`);
        if (mode === "spawn" || mode === "nonzero" || mode === "race") assert.equal(result.command, "failure", `${mode}: known failure is durable independently of cleanup`);
        if (mode === "timeout") { assert.equal(result.command, "unknown"); assert.match(result.reason!, /timed out/); }
        if (mode === "output") { assert.match(result.reason ?? "accepted oversized output", /1 MiB/); assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024 * 1024); }
        if (mode === "drain") { assert.equal(lateClose, false, "settles during drain phase before independent late close"); assert.match(result.reason!, /pipe drain/); }
        assert.equal(f.op.cleanup.size, 0);
        assert.equal(f.sweepCalls(), mode === "spawn" ? 0 : 1, "error/exit/close may own only ONE command finalization sweep");
      } finally { clearTimeout(timer); f.exit(1); }
  });
}

test("P26R2G tree strict postkill confirmation retains surviving identity and default sweep stays compatible", async (t) => {
  const f = processFixture(t, { survives: true });
  const pending = f.run(); f.child.emit("close", 7, null);
  const result = await pending;
  assert.equal(result.command, "failure"); assert.equal(result.treeEnded, false, "accepted taskkill with live owned identity is NOT confirmation");
  assert.ok(f.listCalls() >= 2); assert.equal(f.killCalls(), 1);
  assert.equal(f.op.treesEnded, false);
});

test("P26R2G result nonzero plus unreadable tree remains known failure unknown end", async (t) => {
  const f = processFixture(t, { listFails: true });
  const pending = f.run(); f.child.emit("close", 9, null);
  const result = await pending;
  assert.equal(result.command, "failure"); assert.equal(result.code, 9); assert.equal(result.treeEnded, false);
});

test("P26R2G tree cleanup cap retains its owned promise and never upgrades an unknown result", async (t) => {
  const f = processFixture(t, { holdCleanup: true, sweepMs: 15 });
  const pending = f.run(); f.exit(0);
  try {
    const result = await pending;
    assert.equal(result.command, "success"); assert.equal(result.treeEnded, false);
    assert.equal(f.op.cleanup.size, 1, "cap must not discard or cancel its underlying cleanup promise");
    f.releaseCleanup();
    await Promise.allSettled([...f.op.cleanup]);
    assert.equal(f.op.cleanup.size, 0); assert.equal(f.op.treesEnded, false, "late completion cannot promote an unknown reported tree end");
  } finally { f.releaseCleanup(); }
});

test("P26R2G timeout unreadable process list still stops the owned root without claiming tree end", async (t) => {
  const f = processFixture(t, { listFails: true, timeoutMs: 15 });
  const release = setTimeout(() => f.exit(0), 80);
  try {
    const result = await f.run();
    assert.equal(f.rootStops(), 1, "unreadable listing cannot prevent Stop of the owned root handle");
    assert.equal(result.command, "failure"); assert.equal(result.code, 1); assert.equal(result.treeEnded, false);
  } finally { clearTimeout(release); f.exit(1); }
});

test("P26R2G tree unreadable owned creation time cannot masquerade as absent or reused PID", async (t) => {
  const f = processFixture(t, { unreadableCreation: true });
  const pending = f.run(); f.child.emit("close", 7, null);
  const result = await pending;
  assert.equal(result.command, "failure"); assert.equal(result.treeEnded, false);
});

test("P26R2G tree serial strict sweeps share their owned completion", async () => {
  let release!: () => void, lists = 0;
  const hold = new Promise<void>((done) => { release = done; });
  const tracker = createTreeTracker({ list: async () => { lists++; await hold; return []; }, kill: async () => { assert.fail("no listed owned process may be killed"); } });
  const watch = tracker.watch(12345), first = watch.sweep(Date.now(), true), second = watch.sweep(Date.now(), true);
  try {
    assert.equal(first, second, "concurrent strict sweeps must not run competing cleanup passes");
    release(); assert.equal(await first, 0); assert.equal(lists, 3, "one initial poll and one strict two-list sweep");
  } finally { release(); await Promise.allSettled([first, second]); }
});
