import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { serverNodeRuntime } from "../electron/node-runtime.js";
import { stripElectronNodeEnv } from "../server/runtime-env.ts";
import { leaderChildEnv } from "../server/leader-common/cli-path.ts";
import { createCliRunner } from "../server/settings/cli-runner.ts";
import { runGitCommand, setGitProcessBoundaryForTests } from "../server/fixed-crew/git-process.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { runtimeProofEnv } from "../scripts/pack29-runtime-proof.mjs";
import { plain, shellHarness, within } from "./electron-helpers.ts";

const electron = join(dirname(createRequire(import.meta.url).resolve("electron/package.json")), "dist/electron.exe");
const cleanKeys = (env) => Object.keys(env).filter((key) => key.toLowerCase() === "electron_run_as_node" && env[key] !== undefined);
function fakeChild() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
}
function sourceFunction(file, name, bindings) {
  const source = stripTypeScriptTypes(readFileSync(file, "utf8"));
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${file}: ${name} found`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `${file}: complete ${name} found`);
  return runInNewContext(source.slice(start, end + 2).replace("export ", "") + `\n${name}`, bindings);
}

test("production server launch uses the absolute bundled runtime and sets Node mode", async () => {
  const runtime = serverNodeRuntime(resolve("server/index.ts"), false);
  assert.equal(runtime.command, process.execPath);
  assert.ok(isAbsolute(runtime.command));
  assert.notEqual(runtime.command, "node");
  assert.equal(runtime.env.ELECTRON_RUN_AS_NODE, "1");
  const h = shellHarness();
  const started = h.startServer(); await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "runtime launch");
  assert.equal(h.spawns[0][0], "C:/bundled/electron.exe");
  assert.equal(h.spawns[0][2].env.ELECTRON_RUN_AS_NODE, "1");
});

test("first server import clears all mode spellings before the earliest child", () => {
  const first = readFileSync("server/index.ts", "utf8").split(/\r?\n/)[0];
  assert.equal(first, 'import "./runtime-env.ts";', "the env scrub must precede every spawn-capable server import");
  const script = `await import(${JSON.stringify(pathToFileURL(resolve("server/runtime-env.ts")).href)}); const {spawnSync}=await import('node:child_process'); const p=spawnSync(${JSON.stringify(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"))},['-NoProfile','-Command',"[Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -ieq 'ELECTRON_RUN_AS_NODE' } | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true}); console.log(JSON.stringify({code:p.status,keys:p.stdout.trim(),electron:process.versions.electron}));`;
  const run = spawnSync(electron, ["--input-type=module", "--eval", script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(run.status, 0, `${run.stdout} ${run.stderr}`);
  const record = JSON.parse(run.stdout);
  assert.equal(record.code, 0); assert.equal(record.keys, ""); assert.ok(record.electron, JSON.stringify(record));
  assert.deepEqual(stripElectronNodeEnv({ electron_RUN_as_NODE: "1", ELECTRON_RUN_AS_NODE: "1", keep: "yes" }), { keep: "yes" });
});

test("worker and settings children strip Node mode after every override", async () => {
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    assert.deepEqual(cleanKeys(leaderChildEnv({ eLeCtRoN_rUn_As_NoDe: "1" })), []);
    for (const env of [process.env, { ...process.env, electron_run_as_node: "1" }]) {
      let recorded;
      const fake = ((_bin, _args, options) => {
        recorded = options.env;
        const child = fakeChild(); queueMicrotask(() => child.emit("close", 0)); return child;
      }) as any;
      const result = await createCliRunner(fake, env)("p29-fake.exe", [], { timeoutMs: 500, env: { ELECTRON_RUN_AS_NODE: "1", eLeCtRoN_rUn_As_NoDe: "1" } });
      assert.equal(result.code, 0);
      assert.ok(recorded, "settings child was actually spawned");
      assert.deepEqual(cleanKeys(recorded), [], `settings path ${env === process.env ? "normal" : "supplied"}`);
    }
  } finally { if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = saved; }
});

test("git child receives a sanitized environment through its real call site", async () => {
  const temp = mkdtempSync(join(tmpdir(), "cc-p29-git-"));
  const saved = { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE, CC_TEST_FAKE_CLI: process.env.CC_TEST_FAKE_CLI };
  let recorded;
  try {
    mkdirSync(join(temp, "project")); writeFileSync(join(temp, "git.exe"), "");
    process.env.PATH = temp; process.env.ELECTRON_RUN_AS_NODE = "1"; process.env.CC_TEST_FAKE_CLI = "1";
    setGitProcessBoundaryForTests({ spawn: ((_bin, _args, options) => {
      recorded = options.env; const child = fakeChild(); queueMicrotask(() => child.emit("close", 0, null)); return child;
    }) as any, watch: () => { throw new Error("no fake pid to watch"); } });
    const op = { cancelled: false, cleanup: new Set(), treesEnded: true } as any;
    const result = await runGitCommand(op, join(temp, "project"), ["status"]);
    assert.equal(result.command, "success", result.reason ?? "");
    assert.ok(recorded, "git was actually spawned"); assert.deepEqual(cleanKeys(recorded), []);
  } finally {
    setGitProcessBoundaryForTests();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.ok(removeWithRetry(temp));
  }
});

test("SDK bundled cli.js uses Electron only under Electron, preserves argv and clears mode before its grandchild", () => {
  const temp = mkdtempSync(join(tmpdir(), "cc-p29-sdk-"));
  try {
    const entry = join(temp, "cli.mjs");
    writeFileSync(entry, `import {spawnSync} from 'node:child_process'; const child=spawnSync(${JSON.stringify(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"))},['-NoProfile','-Command',"[Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -ieq 'ELECTRON_RUN_AS_NODE' } | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true}); console.log(JSON.stringify({argv:process.argv.slice(1),keys:child.stdout.trim(),code:child.status}));`);
    for (const version of [undefined, "44.2.0"]) {
      let captured;
      const fn = sourceFunction("server/leader-common/children.ts", "spawnTrackedClaude", {
        process: { versions: { electron: version }, execPath: electron, cwd: () => temp }, pathToFileURL, resolve, stripElectronNodeEnv,
        spawn: (...args) => { captured = args; return fakeChild(); }, trackLeaderChild() {}, killProcessTree() {},
      });
      const args = [entry, "--a", "spaces and quotes ' \"", "", "--", "-flag"];
      fn({ command: "node", args, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, signal: new AbortController().signal });
      assert.ok(captured, "SDK spawn was called");
      assert.equal(captured[0], version ? electron : "node");
      if (!version) { assert.deepEqual(plain(captured[1]), args); assert.deepEqual(cleanKeys(captured[2].env), []); continue; }
      assert.equal(captured[2].env.ELECTRON_RUN_AS_NODE, "1", "SDK child alone gets mode");
      const run = spawnSync(captured[0], captured[1], { ...captured[2], encoding: "utf8", timeout: 10000, stdio: "pipe" });
      assert.equal(run.status, 0, `${run.stdout} ${run.stderr}`);
      assert.deepEqual(JSON.parse(run.stdout), { argv: args, keys: "", code: 0 });
    }
  } finally { assert.ok(removeWithRetry(temp)); }
});

test("test-only tree killer explicitly selects Node mode under Electron", () => {
  let captured;
  const fn = sourceFunction("server/leader-common/process-tree.ts", "killProcessTree", {
    process: { platform: "win32", versions: { electron: "44.2.0" }, execPath: electron, env: { CC_TEST_FAKE_CLI: "1", CC_TEST_KILLER_EXIT: "0" } },
    spawn: (...args) => { captured = args; return fakeChild(); }, windowsTaskkillPath: () => "unused", KILL_CONFIRM_MS: 10,
  });
  fn({ pid: 12345, exitCode: null });
  assert.ok(captured, "killer spawned");
  assert.equal(captured[0], electron);
  assert.equal(captured[2].env?.ELECTRON_RUN_AS_NODE, "1", "would launch GUI without child-only mode");
  const run = spawnSync(captured[0], captured[1], { ...captured[2], encoding: "utf8", timeout: 5000, stdio: "pipe" });
  assert.equal(run.status, 0, `${run.stdout} ${run.stderr}`);
});

test("stripped-PATH live proof passes and a missing runtime fails explicitly", () => {
  const env = runtimeProofEnv("temp", "data");
  assert.deepEqual(Object.keys(env).filter((key) => key.toLowerCase() === "path"), ["Path"]);
  assert.equal(env.CC_SKIP_DISCOVERY, undefined);
  const run = spawnSync(process.execPath, ["scripts/pack29-runtime-proof.mjs", "--electron", electron], { encoding: "utf8", windowsHide: true, timeout: 150000 });
  assert.equal(run.status, 0, `${run.stdout} ${run.stderr}`);
  assert.match(run.stdout, /GET \/=200; child keys="";.*IPC exit=0; port free/);
  const missing = spawnSync(process.execPath, ["scripts/pack29-runtime-proof.mjs", "--electron", resolve("missing-p29-runtime.exe")], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(missing.status, 1, `${missing.stdout} ${missing.stderr}`);
  assert.match(missing.stderr, /FAIL runtime proof:.*ENOENT/);
});
