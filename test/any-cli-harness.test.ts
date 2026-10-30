import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { setEnv } from "./temp-root.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { moduleDataDir, config, leaderCommon, CLAUDE_LEADER, sleep, pidsFromQuery, pidsHolding, boot, withServer, script } from "./any-cli-helpers.ts";
import type { Harness } from "./any-cli-helpers.ts";
import { SERVER_START_MS } from "./server-start.ts";
import { KILL_TIMEOUT_MS, LIST_TIMEOUT_MS } from "../server/leader-common/types.ts";

const SERVER_TEARDOWN_MS = KILL_TIMEOUT_MS + 5_000 + 7_000; // death wait, two drains, crash facts
const SERVER_BOOT_MS = SERVER_START_MS + KILL_TIMEOUT_MS + 5_000; // start, initial state
const GRANDCHILD_WAIT_MS = 12_000;

// ---- the harness itself ----

test("harness: the server modules this file imports keep their data in a temp folder, not the repo's config/", () => {
  assert.equal(path.dirname(path.dirname(config.workspacesPath)).toLowerCase(), moduleDataDir.toLowerCase());
  assert.equal(path.dirname(path.dirname(config.clientPrefsPath)).toLowerCase(), moduleDataDir.toLowerCase());
});

test("harness: a server that dies mid-test fails the test with its exit facts and log tail, keeps the body error, and still removes the temp folder", { timeout: 2 * (SERVER_BOOT_MS + SERVER_TEARDOWN_MS) + 10_000 }, async () => {
  let temp = "";
  await assert.rejects(
    withServer({ leader: CLAUDE_LEADER }, async (h) => {
      temp = h.temp;
      h.child.kill();
      await h.wait(() => h.exit(), "server death seen");
      assert.fail("body error survives");
    }),
    (error: Error) => {
      assert.match(error.message, /body error survives/, "the body's error is kept");
      assert.match(error.message, /server exited before the test finished: code=\S+ signal=\S+/);
      assert.match(error.message, /server log \(last 3000 chars\):\n[\s\S]*127\.0\.0\.1/, "the log tail is attached");
      return true;
    },
  );
  assert.ok(temp && !existsSync(temp), "temp folder removed although the server was already gone");
  // A body that passes against a server that died is still a failure.
  await assert.rejects(
    withServer({ leader: CLAUDE_LEADER }, async (h) => { h.child.kill(); await h.wait(() => h.exit(), "server death seen"); }),
    /server exited before the test finished/,
  );
});

test("harness: output the server writes just before it dies, and its node crash report, appear in the failure text", { timeout: SERVER_BOOT_MS + SERVER_TEARDOWN_MS + GRANDCHILD_WAIT_MS + 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-anycli-preload-"));
  const preload = join(dir, "die.cjs");
  const pidFile = join(dir, "grandchild.pid");
  // The grandchild shares the server's stderr pipe and speaks only after it has SEEN the server gone (polls its pid), so "close" (pipe released) comes last; it gives up after 10 s. Detached, or Windows ends it together with the server. Its pid goes to a file so the test can kill it.
  const lateScript = "const p = +process.argv[1], t = Date.now(); const i = setInterval(() => { let alive = true; try { process.kill(p, 0); } catch { alive = false; } if (!alive) { process.stderr.write('LATE-WORDS-AFTER-EXIT'); clearInterval(i); } else if (Date.now() - t > 10000) clearInterval(i); }, 20);";
  writeFileSync(preload, `process.on("message", (m) => { if (m !== "die-now") return; process.stderr.write("LAST-WORDS-BEFORE-DEATH\\n"); process.report.writeReport("report.fake.json"); const { NODE_OPTIONS, ...env } = process.env; const gc = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(lateScript)}, String(process.pid)], { stdio: ["ignore", "ignore", 2], windowsHide: true, detached: true, env }); require("node:fs").writeFileSync(${JSON.stringify(pidFile.replaceAll("\\", "/"))}, String(gc.pid)); gc.unref(); process.exit(9); });`);
  try {
    await assert.rejects(
      withServer({ leader: CLAUDE_LEADER, env: { NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll("\\", "/"))}` } }, async (h) => {
        h.child.send("die-now");
        await h.wait(() => h.exit(), "server death seen");
      }),
      (error: Error) => {
        assert.match(error.message, /server exited before the test finished: code=9/);
        assert.match(error.message, /LAST-WORDS-BEFORE-DEATH/, "stderr written just before death is in the failure text");
        assert.match(error.message, /LATE-WORDS-AFTER-EXIT/, "stderr that arrives after the server's exit but before its pipes close is in the failure text");
        assert.match(error.message, /node crash report: event=JavaScript API trigger=API/, "the crash report header is attached");
        return true;
      },
    );
  } finally {
    // The grandchild gives up by itself after 10 s: it is waited for (bounded), never killed by a bare pid that may have been reused.
    let grandchild = NaN;
    try { grandchild = Number(readFileSync(pidFile, "utf8")); } catch { /* no pid file */ }
    for (const end = Date.now() + GRANDCHILD_WAIT_MS; Number.isFinite(grandchild) && Date.now() < end;) {
      try { process.kill(grandchild, 0); } catch { break; }
      await sleep(50);
    }
    rmSync(preload, { force: true }); rmSync(pidFile, { force: true }); rmdirSync(dir);
  }
});

test("harness: a server killed by the body that is not awaited still fails the test", { timeout: SERVER_BOOT_MS + SERVER_TEARDOWN_MS + 10_000 }, async () => {
  await assert.rejects(
    withServer({ leader: CLAUDE_LEADER }, async (h) => { h.child.kill(); }),
    /server exited before the test finished/,
  );
});

test("harness: a process query that failed or timed out throws with its stderr instead of reading as an empty list", () => {
  assert.throws(() => pidsFromQuery({ status: 1, stdout: "", stderr: "CIM-QUERY-BROKE" }), /did not complete.*CIM-QUERY-BROKE/);
  assert.throws(() => pidsFromQuery({ status: null, stdout: "", stderr: "", error: new Error("spawnSync ETIMEDOUT") }), /ETIMEDOUT/);
  assert.deepEqual(pidsFromQuery({ status: 0, stdout: "12\r\n34\r\n", stderr: "" }), [12, 34], "control: a completed query is parsed");
});

test("harness: a boot that fails after the server started stops that server and removes its temp folder", { timeout: SERVER_START_MS + LIST_TIMEOUT_MS + 30_000 }, async () => {
  // The boot gets its own TEMP/TMP, so the only folder in it and the only processes holding it are this boot's.
  const privateTmp = mkdtempSync(join(tmpdir(), "cc-anycli-private-"));
  const restore = setEnv({ TEMP: privateTmp, TMP: privateTmp });
  let running: number[] = [], unexpected: Harness | undefined;
  try {
    try {
      // A key the server was not given: the socket is refused, which is a connection error inside boot, before any handle exists.
      await assert.rejects(boot({ leader: CLAUDE_LEADER, env: { CC_APP_KEY: "f".repeat(64) } }).then((h) => { unexpected = h; return h; }), (error: unknown) => error instanceof Error);
    } finally { restore(); }
    running = pidsHolding(privateTmp);
    assert.deepEqual(readdirSync(privateTmp), [], "the failed boot left no temp folder behind");
    assert.deepEqual(running, [], "and its server is no longer running");
  } finally {
    // A boot that unexpectedly succeeded is shut down through its own handle; anything found by a folder only this test knows is stopped here, so a failing run leaves nothing behind.
    await unexpected?.close().catch(() => {});
    for (const pid of running) { try { process.kill(pid); } catch { /* gone */ } }
    removeWithRetry(privateTmp);
  }
});

test("harness: a boot failure whose server cannot be stopped says so, as a cleanup failure", { timeout: SERVER_START_MS + LIST_TIMEOUT_MS + 30_000 }, async () => {
  const privateTmp = mkdtempSync(join(tmpdir(), "cc-anycli-private-"));
  const restore = setEnv({ TEMP: privateTmp, TMP: privateTmp });
  let running: number[] = [];
  try {
    try {
      await assert.rejects(boot({ leader: CLAUDE_LEADER, killDoesNothing: true, env: { CC_APP_KEY: "f".repeat(64) } }), /cleanup failed: server \d+ is still running/);
    } finally { restore(); running = pidsHolding(privateTmp); }
    assert.equal(running.length > 0, true, "control: the server really was still running");
  } finally {
    for (const pid of running) { try { process.kill(pid); } catch { /* gone */ } }
    removeWithRetry(privateTmp, 20, 250);
  }
});

const TEARDOWN_KILL_WAIT_MS = 8000;

test("harness: teardown kills a leftover fake CLI only while its pid still has the creation time it logged and its command line names the fake", { timeout: SERVER_START_MS + 5 * LIST_TIMEOUT_MS + TEARDOWN_KILL_WAIT_MS + 30_000 }, async () => {
  // All four are children of this test, so even a bug in the teardown only ever touches them. Three carry the fake's script name in their command line:
  // `same` (this run's folder) is logged with its real creation time, `reused` (this run's folder) with a wrong one (a reused pid), and `foreign`
  // (ANOTHER run's folder) with its real time. The fourth has the right time but is not a fake at all.
  const idle = (...extra: string[]) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...extra], { windowsHide: true, stdio: "ignore" });
  const bystander = idle(), foreign = idle("fake-codex-app-server.mjs", join(tmpdir(), "cc-anycli-another-run", "work"));
  let same: ReturnType<typeof idle> | undefined, reused: ReturnType<typeof idle> | undefined;
  const exited = (proc: ReturnType<typeof idle>) => proc.exitCode !== null || proc.signalCode !== null;
  try {
    await withServer({ leader: CLAUDE_LEADER }, async (h) => {
      same = idle("fake-codex-app-server.mjs", join(h.temp, "work")); reused = idle("fake-codex-app-server.mjs", join(h.temp, "work"));
      const all = [same, reused, bystander, foreign];
      let created: Map<number, number>;
      for (let attempt = 0; ; attempt++) {
        created = new Map((await leaderCommon.listProcesses() ?? []).map((item: any) => [item.pid, item.created]));
        if (all.every((proc) => created.has(proc.pid!))) break;
        assert.ok(attempt < 100, "the process list shows all idle children");
        await sleep(100);
      }
      const line = (pid: number, startedAt: number) => JSON.stringify({ cli: "codex", started: true, pid, startedAt }) + "\n";
      appendFileSync(join(h.temp, "fake-cli.log"), line(same.pid!, created.get(same.pid!)!) + line(reused.pid!, created.get(reused.pid!)! - 3_600_000) + line(bystander.pid!, created.get(bystander.pid!)!) + line(foreign.pid!, created.get(foreign.pid!)!));
      assert.equal(h.cliEntries().filter((entry) => entry.started).length, 4, "control: all four are in the CLI log");
    });
    for (const end = Date.now() + TEARDOWN_KILL_WAIT_MS; !exited(same!) && Date.now() < end;) await sleep(50);
    assert.equal(exited(same!), true, "the process whose creation time matches its log line is killed by the teardown");
    assert.equal(exited(reused!), false, "a pid whose creation time differs from the logged one (a reused pid) is left alone");
    assert.equal(exited(bystander), false, "a process with the logged creation time whose command line is not a fake CLI is left alone");
    assert.equal(exited(foreign), false, "another run's fake (same script name, right creation time, a different folder) is left alone");
  } finally { same?.kill(); reused?.kill(); bystander.kill(); foreign.kill(); }
});
