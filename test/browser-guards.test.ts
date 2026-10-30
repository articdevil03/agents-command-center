import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { CHROME, REPO, NARROWED, narrowedRunError, assertAuditFinished } from "./browser-constants.ts";
import { listen, chromeAudit } from "./browser-helpers.ts";
import { CHROME_EXIT_MS, chromeStopBoundMs } from "./chrome-stop.ts";
import { LIST_TIMEOUT_MS } from "../server/leader-common/types.ts";

async function waitForEmpty(query: () => string, label: string): Promise<void> {
  const started = Date.now();
  let left = query();
  while (left && Date.now() - started < 2 * LIST_TIMEOUT_MS) {
    await new Promise((ok) => setTimeout(ok, 250));
    left = query();
  }
  assert.equal(left, "", `${label}: waited ${Date.now() - started} ms; leftovers: ${left}`);
}

function chromeProcesses(profile: string): string {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profile.replaceAll("'", "''")}*' } | ForEach-Object { $kind = 'browser'; if ($_.CommandLine -match '--type=([^ ]+)') { $kind = $Matches[0] }; "$($_.ProcessId) $kind" }`], { encoding: "utf8", windowsHide: true, timeout: LIST_TIMEOUT_MS });
  assert.equal(result.status, 0, `Chrome query failed: ${result.stderr} ${result.error ?? ""}`);
  return result.stdout.trim();
}

test("the audit guards go RED on a cut-short report, a narrowed run under npm test, and a Chrome that outlives its cap", async () => {
  // A report with checks and no failure, but without the harness's finished marker, is what the virtual-time budget leaves behind.
  assert.throws(() => assertAuditFinished({ checks: [{ name: "the last check that ran" }] }, "control"), /control: the audit did not finish.*the last check that ran/);
  assert.throws(() => assertAuditFinished({ checks: [], failure: undefined }, "control"), /did not finish/);
  assertAuditFinished({ checks: [], finished: true }, "control");
  // CC_BROWSER_PHASES, CC_BROWSER_WIDTHS and CC_BROWSER_DEBUG_ONLY skip browser phases: that is refused under npm test and only announced elsewhere.
  assert.match(narrowedRunError({ npm_lifecycle_event: "test" }, ["CC_BROWSER_PHASES=b2"]) ?? "", /npm test must run the whole browser suite.*CC_BROWSER_PHASES=b2/);
  assert.equal(narrowedRunError({ npm_lifecycle_event: "test" }, []), null, "nothing narrowed: allowed under npm test");
  assert.equal(narrowedRunError({}, ["CC_BROWSER_PHASES=b2"]), null, "a mutation sweep or a debug run is not npm test: announced, not refused");
  assert.equal(narrowedRunError(process.env, NARROWED) === null, !(NARROWED.length && process.env.npm_lifecycle_event === "test"), "this very run is not narrowed under npm test");
  if (process.env.CC_SKIP_BROWSER === "1") return;
  assert.ok(existsSync(CHROME), `Headless Chrome is required at ${CHROME}`);
  // A page whose request never answers keeps Chrome waiting past a 3 s cap: the audit must reject at the cap, and nothing of that Chrome may be left running.
  // This leg proves the cap fires with the installed Chrome; whether the whole process TREE is stopped is proven by the next test, which cannot be fooled by a Chrome whose helpers happen to exit with it.
  const temp = mkdtempSync(join(tmpdir(), "cc-chromecap-"));
  const profile = join(temp, "profile");
  const hung = new Set<import("node:net").Socket>();
  let hangRequestedAt = 0, hangRequested = () => {};
  const hangStarted = new Promise<void>((ok) => { hangRequested = ok; });
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/__audit")) { response.writeHead(200, { "Content-Type": "text/html" }); response.end('<!doctype html><pre id="AUDIT">running</pre><img src="/hang">'); } // /hang never answers
    else if (request.url === "/hang" && !hangRequestedAt) { hangRequestedAt = Date.now(); hangRequested(); }
  });
  server.on("connection", (socket) => { hung.add(socket); socket.on("close", () => hung.delete(socket)); });
  try {
    const port = await listen(server);
    // The cap is armed once Chrome has asked for /hang (waited for up to 60 s, separately from the cap): the page is then really hung.
    const requested = Promise.race([hangStarted, new Promise((_, no) => setTimeout(() => no(new Error("Chrome never requested /hang within 60 s")), 60_000).unref())]);
    // virtualMs is far past any bound, so a budget exit can never be mistaken for the cap or hide a slow stop.
    await assert.rejects(chromeAudit({ port, mode: "fake", folder: temp, width: 800, profile, virtualMs: 600_000, capMs: 3000, capStartsAfter: requested }), (error: any) => {
      assert.match(error.message, /Chrome exceeded 3000ms and exited after termination/);
      assert.ok(hangRequestedAt > 0, "Chrome requested /hang before the cap fired");
      assert.ok(error.capFiredAt - hangRequestedAt >= 2990, `the cap counted from the hung request, not from Chrome's start: ${error.capFiredAt - hangRequestedAt} ms`);
      assert.ok(error.capFiredAt - hangRequestedAt < 3000 + 5_000, `the cap fired at its 3 s, not later: ${error.capFiredAt - hangRequestedAt} ms`);
      assert.ok(Date.now() - error.capFiredAt < chromeStopBoundMs(), `the stop finished within the helper's own bound: ${Date.now() - error.capFiredAt} ms; ${error.stopFacts.join("; ")}`);
      return true;
    });
    await waitForEmpty(() => chromeProcesses(profile), "no Chrome from this test after the cap");
  } finally {
    const left = chromeProcesses(profile);
    if (left) spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${left.split(/\r?\n/).map((line) => line.split(" ")[0]).join(",")} -Force`], { windowsHide: true, timeout: LIST_TIMEOUT_MS });
    await waitForEmpty(() => chromeProcesses(profile), "Chrome cleanup");
    for (const socket of hung) socket.destroy();
    server.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test("the cap stops the whole tree of a Chrome, not just its first process: a helper that outlives a plain kill is gone", async () => {
  // A stand-in Chrome that starts one helper and never ends. Killing only its own pid (what proc.kill() does) leaves the helper running.
  const temp = mkdtempSync(join(tmpdir(), "cc-chrometree-"));
  const marker = `cc-tree-marker-${process.pid}-${Date.now()}`, pidFile = join(temp, "helper.pid");
  const helperProcesses = () => {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }) -join ','`], { encoding: "utf8", windowsHide: true, timeout: LIST_TIMEOUT_MS });
    assert.equal(result.status, 0, `helper query failed: ${result.stderr} ${result.error ?? ""}`);
    return result.stdout.trim();
  };
  // The cap is armed once the stand-in has written its helper's pid (waited for up to 60 s, separately from the cap).
  let helperSeenAt = 0;
  const helperStarted = (async () => {
    for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((ok) => setTimeout(ok, 20))) {
      if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()) { helperSeenAt = Date.now(); return; }
    }
    assert.fail("the stand-in Chrome never wrote its helper's pid within 60 s");
  })();
  try {
    await assert.rejects(
      chromeAudit({ port: 1, mode: "fake", folder: temp, width: 800, profile: join(temp, "profile"), virtualMs: 1, capMs: 2500, capStartsAfter: helperStarted, chrome: { exe: process.execPath, args: [join(REPO, "test", "fake-chrome-tree.mjs"), marker, pidFile, "1500"] } }),
      /Chrome exceeded 2500ms and exited after termination/);
    assert.ok(helperSeenAt > 0 && existsSync(pidFile), "the stand-in started its helper before the cap");
    assert.ok(Date.now() - helperSeenAt >= 2490, `the cap counted from the helper's start (written 1.5 s after the stand-in's spawn), not from the spawn: ${Date.now() - helperSeenAt} ms`);
    const helperPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(helperPid) && helperPid > 0, `the helper's pid was recorded: ${helperPid}`);
    const end = Date.now() + CHROME_EXIT_MS;
    let alive = true;
    while (alive && Date.now() < end) { try { process.kill(helperPid, 0); await new Promise((ok) => setTimeout(ok, 100)); } catch { alive = false; } }
    assert.equal(alive, false, `the helper (pid ${helperPid}) was still running after the cap: only the first process was stopped`);
    await waitForEmpty(helperProcesses, "no process carrying the marker is left");
  } finally {
    // Whatever carries this test's own marker (and nothing else) is stopped, so a failure here leaves nothing behind.
    const left = helperProcesses();
    if (left) spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${left} -Force`], { windowsHide: true, timeout: LIST_TIMEOUT_MS });
    await waitForEmpty(helperProcesses, "helper cleanup");
    rmSync(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test("the browser suite is not narrowed under npm test", () => {
  const error = narrowedRunError(process.env, NARROWED);
  assert.equal(error, null, error ?? "");
});
