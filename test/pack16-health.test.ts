// Pack 16, test health: (A) no teardown deletes a temp folder with a bare rmSync that Windows can fail once; (C) every test that starts a
// Command Center server hooks the crash catcher, and the catcher really reports a crash on purpose.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { attachCrashCatcher, crashCatcherDisabled, crashDumpPaths, crashFactsAfterDeath, waitCatcherMonitoring, watchCatcher } from "./crash-catcher.ts";
import { scratchDir } from "./temp-root.ts";

const testDir = resolve("test");
const files = readdirSync(testDir).filter((name) => /\.(ts|mjs|js)$/.test(name) && name !== "pack16-health.test.ts").sort();
const source = (name: string): string => readFileSync(join(testDir, name), "utf8");

// ---- Block A: teardown deletes retry ----

// A recursive rmSync of a folder that is neither retried by rmSync itself (maxRetries) nor routed through removeWithRetry.
const ALLOWED_BARE_RMSYNC: Array<{ file: string; contains: string; reason: string }> = [
  { file: "pack1-skip.test.ts", contains: "cleanupAtExit", reason: "process-exit handler, already inside try/catch: it cannot fail a test and must not sleep at exit" },
  { file: "temp-root.ts", contains: "!isAbsolute(rel)", reason: "the unsafe-root path: a folder mkdtempSync just made, removed before the failure is raised; its exact text is pinned by guard-temp-root-leak-cleanup" },
  { file: "http.test.ts", contains: "isLink ?", reason: "removes a link itself with force only, or a plain folder; a retry loop must never follow a link" },
];

test("pack 16 inventory: no teardown deletes a temp folder with a bare rmSync that fails once (every site listed)", () => {
  const retried: string[] = [], bare: string[] = [], allowed: string[] = [];
  for (const name of files) {
    const text = source(name);
    for (const match of text.matchAll(/\brmSync\(/g)) {
      const rest = text.slice(match.index, match.index + 240);
      const call = rest.slice(0, rest.search(/;|\n\s*\n/) < 0 ? undefined : rest.search(/;|\n\s*\n/));
      if (!/recursive:\s*true/.test(call)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      const lineText = text.split("\n")[line - 1]!;
      const where = `${name}:${line}`;
      if (/maxRetries/.test(call)) { retried.push(where); continue; }
      const allow = ALLOWED_BARE_RMSYNC.find((a) => a.file === name && lineText.includes(a.contains));
      if (allow) { allowed.push(`${where} (${allow.reason})`); continue; }
      bare.push(`${where}: ${lineText.trim().slice(0, 140)}`);
    }
  }
  const helperCalls = files.reduce((n, name) => n + (source(name).match(/\bremoveWithRetry\(/g)?.length ?? 0), 0);
  console.log(`pack16 rmSync inventory: ${files.length} files scanned, ${helperCalls} removeWithRetry calls, ${retried.length} rmSync with maxRetries, allowlisted ${allowed.length}:\n  ${allowed.join("\n  ")}`);
  assert.ok(helperCalls >= 60, `control: the scan must find the retry helper's call sites (found ${helperCalls})`);
  assert.deepEqual(bare, [], `a recursive rmSync of a temp folder with no retry (use removeWithRetry):\n${bare.join("\n")}`);
});

// ---- Block C: the crash catcher ----

// Where a spawn of the node binary starts a Command Center server but the catcher is hooked somewhere else, or cannot be (reason required).
const ALLOWED_UNHOOKED_SERVERS: Array<{ file: string; contains: string; reason: string; alsoIn?: RegExp }> = [
  { file: "http.test.ts", contains: "return spawn(process.execPath", reason: "the function body is executed alone by a capture guard; its caller hooks the pid", alsoIn: /spawnPackagedServer\(dataDir\);\s*attachCrashCatcher\(proc\.pid/ },
  { file: "pack1-server.test.ts", contains: "spawnSync(process.execPath", reason: "synchronous run to completion: no pid exists while it runs, nothing to attach to" },
];

test("pack 16 inventory: every spawn of a Command Center server in test/ hooks the crash catcher (every site listed)", () => {
  const hooked: string[] = [], skipped: string[] = [], missing: string[] = [];
  for (const name of files) {
    if (name === "crash-catcher.ts") continue;
    const text = source(name);
    for (const match of text.matchAll(/\bspawn(?:Sync)?\(process\.execPath/g)) {
      const head = text.slice(match.index, match.index + 200);
      const line = text.slice(0, match.index).split("\n").length;
      const where = `${name}:${line}`;
      if (!/server["']?\s*[,/\\]\s*["']?index\.ts|server\/index\.ts/.test(head)) { skipped.push(`${where} not a server`); continue; }
      const lineText = text.split("\n")[line - 1]!;
      const allow = ALLOWED_UNHOOKED_SERVERS.find((a) => a.file === name && lineText.includes(a.contains));
      if (allow) {
        if (allow.alsoIn && !allow.alsoIn.test(text)) missing.push(`${where}: allowlisted (${allow.reason}) but the caller's hook is gone`);
        else skipped.push(`${where} ${allow.reason}`);
        continue;
      }
      if (/attachCrashCatcher\(/.test(text.slice(match.index, match.index + 1100))) hooked.push(where);
      else missing.push(`${where}: starts the server with no attachCrashCatcher within 1100 chars`);
    }
  }
  console.log(`pack16 server-spawn inventory: hooked ${hooked.length}: ${hooked.join(", ")}\n  not hooked (${skipped.length}), non-servers listed by count only: ${skipped.filter((s) => !s.endsWith("not a server")).join(" | ")}`);
  assert.ok(hooked.length >= 20, `control: the scan must find the server spawns (found ${hooked.length})`);
  assert.deepEqual(missing, [], `server spawns without the crash catcher:\n${missing.join("\n")}`);
});

// Control: a child that crashes on purpose; the catcher must report the exception AND leave a dump (deleted here, by exact file).
const procdumpMissing = (): string | null => {
  const off = crashCatcherDisabled();
  if (off) return off;
  return spawnSync("procdump", ["-accepteula", "-?"], { windowsHide: true, timeout: 20000 }).error ? "procdump not found" : null;
};
const crashes: Array<{ name: string; command: string; args: string[] }> = [
  { name: "fast-fail", command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "[Console]::In.ReadLine() | Out-Null; Add-Type -Name K -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern void RaiseFailFastException(System.IntPtr a, System.IntPtr b, uint c);'; [W.K]::RaiseFailFastException([IntPtr]::Zero,[IntPtr]::Zero,0)"] },
  { name: "access violation", command: "python", args: ["-c", "import sys, faulthandler; sys.stdin.readline(); faulthandler._read_null()"] },
];
const CRASH_EXIT_WAIT_MS = 20000;
for (const crash of crashes) {
  test(`pack 16 control: the crash catcher reports a deliberate ${crash.name} and leaves a dump file`, { timeout: 90000 }, async (t) => {
    const missing = procdumpMissing();
    if (missing) return t.skip(`crash catcher control skipped: ${missing}`);
    if (crash.command === "python" && spawnSync("python", ["-I", "-c", "pass"], { windowsHide: true }).error) return t.skip("python not found");
    const dumps = scratchDir();
    // The child waits for a line on stdin, so it crashes only after procdump says it is monitoring (a slow attach on a busy PC cannot miss the crash).
    const child = spawn(crash.command, crash.args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    attachCrashCatcher(child.pid, `control-${crash.name}`, dumps);
    const alive = (): boolean => child.exitCode === null && child.signalCode === null;
    let paths: string[] = [];
    try {
      const monitoring = await waitCatcherMonitoring(child.pid, 60000);
      assert.ok(monitoring, `step not reached: procdump was not attached to, or never reported monitoring, pid ${child.pid} (waited up to 60 s)`);
      child.stdin!.end("go\n");
      // Bounded well inside the 90 s test timeout (60 s monitoring wait + this), so the finally below always gets to run.
      let timer: NodeJS.Timeout | undefined;
      const exited = alive() ? await Promise.race([once(child, "exit").then(() => true), new Promise<boolean>((done) => { timer = setTimeout(() => done(false), CRASH_EXIT_WAIT_MS); })]) : true;
      clearTimeout(timer);
      assert.ok(exited, `step not reached: the deliberate crash did not happen within ${CRASH_EXIT_WAIT_MS / 1000} s (pid ${child.pid} still running)`);
      const facts = await crashFactsAfterDeath(child.pid, 20000);
      paths = crashDumpPaths(child.pid);
      console.log(`pack16 control (${crash.name}): ${facts.replace(/\n/g, " | ")} dumps=${paths.join(",")}`);
      assert.match(facts, /(Exception|Unhandled): /, `no exception line from procdump:${facts}`);
      assert.ok(paths.length >= 1, `no dump file reported/found in ${dumps}:${facts}`);
    } finally {
      // Kill only the child this test spawned; its procdump ends by itself once the target is gone.
      if (alive()) { child.kill(); await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 5000))]); }
      await crashFactsAfterDeath(child.pid, 5000);
      for (const path of [...paths, ...crashDumpPaths(child.pid), ...readdirSync(dumps).filter((f) => f.endsWith(".dmp")).map((f) => join(dumps, f))]) { try { if (existsSync(path)) unlinkSync(path); } catch { /* removed by scratchDir's retry */ } }
    }
  });
}

// ---- Catcher internals: each test fails when its fix is removed ----

// A fake procdump process: the pipes carry text, exit and close are emitted by the test.
const fakeProcdump = () => {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  Object.assign(proc.stdout, { unref() {} }); Object.assign(proc.stderr, { unref() {} });
  return proc;
};

test("pack 16 catcher: output that arrives after procdump's exit event still counts (the end is close, not exit)", async () => {
  const proc = fakeProcdump();
  watchCatcher(900001, "late-output", proc as unknown as ChildProcess);
  proc.emit("exit", 0);
  setTimeout(() => { proc.stdout.write(Buffer.from("Unhandled: 0xC0000409\r\n", "utf16le")); proc.stdout.end(); proc.emit("close", 0); }, 150);
  const facts = await crashFactsAfterDeath(900001, 5000);
  assert.match(facts, /Unhandled: 0xC0000409/, `the late exception line was lost:${facts}`);
});

test("pack 16 catcher: a finished catcher does not hold the process open for the wait it was given", () => {
  const url = new URL("./crash-catcher.ts", import.meta.url).href;
  const script = `import { watchCatcher, crashFactsAfterDeath } from ${JSON.stringify(url)};
import { EventEmitter } from "node:events"; import { PassThrough } from "node:stream";
const p = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
p.stdout.unref = () => {}; p.stderr.unref = () => {};
watchCatcher(900002, "done", p); p.emit("close", 0);
await crashFactsAfterDeath(900002, 20000);`;
  const started = Date.now();
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true, timeout: 40000, encoding: "utf8" });
  const took = Date.now() - started;
  assert.equal(run.status, 0, `child failed: ${run.stderr}`);
  assert.ok(took < 10000, `the helper held the process open ${took} ms of a 20000 ms wait`);
});

test("pack 16 catcher: attaching keeps the 10 newest dumps and deletes only older .dmp files directly in the folder", { skip: crashCatcherDisabled() ?? false }, () => {
  const dir = scratchDir();
  const now = Date.now() / 1000;
  const names = Array.from({ length: 12 }, (_, i) => `d${String(i).padStart(2, "0")}.dmp`);
  names.forEach((name, i) => { writeFileSync(join(dir, name), "x"); utimesSync(join(dir, name), now - 1000 + i, now - 1000 + i); });
  writeFileSync(join(dir, "notes.txt"), "keep"); mkdirSync(join(dir, "old.dmp"));
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { windowsHide: true, stdio: "ignore" });
  attachCrashCatcher(sleeper.pid, "retention", dir);
  const left = readdirSync(dir).sort();
  assert.deepEqual(left.filter((f) => f.endsWith(".dmp") && f !== "old.dmp"), names.slice(2), `retention kept: ${left.join(",")}`);
  assert.ok(left.includes("notes.txt") && left.includes("old.dmp"), `a non-dump file or a folder was touched: ${left.join(",")}`);
});

test("pack 16 catcher: a test process that imports temp-root.ts is attached to by procdump (self-attach is wired)", { timeout: 90000 }, async (t) => {
  const missing = procdumpMissing();
  if (missing) return t.skip(`self-attach check skipped: ${missing}`);
  const url = new URL("./temp-root.ts", import.meta.url).href;
  // The child stays alive until this test has its answer (it ends on stdin close), however slow the process queries are.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(url)}; process.stdin.resume(); setTimeout(() => process.exit(0), 80000);`], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
  try {
    let seen = "";
    for (const end = Date.now() + 60000; Date.now() < end && !seen; ) {
      await new Promise((r) => setTimeout(r, 500));
      const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name like 'procdump%'\" | ForEach-Object { $_.CommandLine }"], { windowsHide: true, encoding: "utf8", timeout: 20000 });
      seen = (ps.stdout ?? "").split(/\r?\n/).find((l) => new RegExp(`\\b${child.pid}\\b`).test(l)) ?? "";
    }
    console.log(`pack16 self-attach: matched procdump command line: ${seen.trim()}`);
    assert.ok(seen, `no procdump process names pid ${child.pid} within 60 s: importing temp-root.ts no longer attaches the catcher to the test process`);
  } finally { child.kill(); }
});

// The test script preloads the catcher into EVERY test file process. stall.test.ts does not import temp-root.ts, so only the preload can attach it.
test("pack 16 catcher: the test script's preload attaches the catcher to a test file that does not import temp-root.ts (stall.test.ts)", { skip: crashCatcherDisabled() ?? false, timeout: 120000 }, () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  assert.ok(!/temp-root/.test(source("stall.test.ts")), "control: stall.test.ts must not import temp-root.ts");
  const script: string = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts.test;
  const flags = script.match(/^node\s+(.*?)\s*--test\b/)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env; // inside a test run this would make the nested run skip its files
  const dir = mkdtempSync(join(tmpdir(), "cc-preload-"));
  const log = join(dir, "attach.log");
  try {
    const run = spawnSync(process.execPath, [...flags, "--test", "--test-name-pattern=^no test has this name$", "test/stall.test.ts"], { cwd: repo, windowsHide: true, encoding: "utf8", timeout: 100000, env: { ...env, CC_CRASH_CATCHER_LOG: log } });
    const lines = existsSync(log) ? readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean) : [];
    console.log(`pack16 preload: flags=[${flags.join(" ")}] exit=${run.status} attach log: ${lines.join(" | ")}`);
    assert.ok(lines.some((l) => /^\d+ test-file:stall\.test\.ts$/.test(l)), `stall.test.ts ran with no catcher attached; the test script (${script}) no longer preloads test/crash-catcher-self.ts:\n${lines.join("\n")}\n${run.stderr}`);
  } finally { try { unlinkSync(log); } catch { /* never written */ } try { rmdirSync(dir); } catch { /* left for the OS temp cleanup */ } }
});
