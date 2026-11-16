import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importWithTempDataRoot } from "./temp-root.ts";
import { createCliRunner } from "../server/settings/cli-runner.ts";
import { createLoginRunner } from "../server/settings/cli-login-runner.ts";
import { createAcpLeader } from "../server/leader-acp.ts";
import { keyEnvFor } from "../server/settings/cli-key-profiles.ts";
import { fixture } from "./pack34-copilot.setup.ts";
import { managedCli } from "../server/settings/opencode/paths.ts";
import { leaderChildEnv, resolveCliPath } from "../server/leader-common/cli-path.ts";

const { modules: runner } = await importWithTempDataRoot(() => import("../server/runner.ts"));
function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null, signalCode: null, kill() { return true; } });
}
test("production installer runner preserves the isolated home and disables updates at native spawn", async (t) => {
  let run: ReturnType<typeof createCliRunner>;
  const fx = await fixture(t, { run: (...args) => run(...args) });
  const calls: any[] = [];
  try {
    run = createCliRunner(((bin: string, args: string[], options: any) => {
      calls.push({ bin, args, options }); const proc = child();
      queueMicrotask(() => { proc.stdout.end("GitHub Copilot CLI 1.0.112."); proc.emit("close", 0); });
      return proc;
    }) as any, fx.env);
    await fx.service.installCli(fx.request);
    assert.equal(calls.length, 1);
    const call = calls[0], home = join(call.bin, "..", "probe-home");
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) assert.equal(call.options.env[key], home, key);
    assert.equal(call.options.env.COPILOT_AUTO_UPDATE, "false");
    assert.equal(call.options.env.COPILOT_GITHUB_TOKEN, undefined);
    assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.detached, false);
  } finally { await fx.close(); }
});
test("managed detection, login, ACP leader and crew use the native descriptor with updates disabled and token only in env", async (t) => {
  const fx = await fixture(t), captured: { bin: string; args: string[]; options: any; proc: any }[] = [];
  const token = "p34-synthetic-token", before = { ...process.env };
  const spawnFake: typeof childProcess.spawn = ((bin: string, args: string[], options: any) => {
    const proc = child(); captured.push({ bin, args, options, proc });
    if (args[0] === "version" || args[0] === "--version") queueMicrotask(() => { proc.stdout.end("GitHub Copilot CLI 1.0.112."); proc.emit("close", 0); });
    return proc;
  }) as any;
  let leader: ReturnType<typeof createAcpLeader> | undefined;
  const restoreEnv = new Map<string, string | undefined>();
  try {
    await fx.service.installCli(fx.request); const native = managedCli(fx.env, "copilot"); assert.ok(native);
    const run = createCliRunner(spawnFake, { ...fx.env, copilot_auto_update: "true" });
    assert.equal((await run("copilot", ["--version"], { timeoutMs: 500 })).code, 0);
    const login = createLoginRunner(spawnFake)({ cli: "copilot", env: fx.env, timeoutMs: 500,
      signal: new AbortController().signal, output() {} });
    captured.at(-1)!.proc.emit("close", 0); assert.equal((await login.done).code, 0);
    // The default ACP spawn boundary performs real resolution; only spawn itself is fake.
    const spy = t.mock.method(childProcess, "spawn", spawnFake); syncBuiltinESMExports();
    for (const [key, value] of Object.entries(fx.env)) { restoreEnv.set(key, process.env[key]); if (value !== undefined) process.env[key] = value; }
    const launch = { env: keyEnvFor("copilot", { key: token }), secrets: [token] };
    const cli = { id: "p34-copilot", name: "Synthetic Copilot", program: "copilot", args: ["--acp"] };
    leader = createAcpLeader({ model: "default", effort: "default" }, join(fx.root, "data"),
      { onDelta() {}, onDone() {}, onUsage() {}, onError() {} }, { cli, keyLaunch: launch });
    const result = runner.runSeat({ runId: "p34-crew", seatKey: "p34.coder", slotId: "coder", name: "Synthetic", cli: "acp:p34-copilot",
      acp: cli, model: "default", effort: "default", folder: join(fx.root, "data"), canWrite: false, startedAt: Date.now() }, "synthetic brief",
      { onOutput() {}, onStatus() {} }, childProcess.spawn, { keyLaunch: launch });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(captured.length, 4, "all four launch kinds must reach native spawn");
    for (const [index, call] of captured.entries()) {
      assert.equal(call.bin, native, `launch ${index} resolves managed Copilot`);
      assert.equal(call.options.env.COPILOT_AUTO_UPDATE, "false", `launch ${index} disables updates`);
      assert.equal(call.options.env.copilot_auto_update, undefined);
      assert.equal(call.options.windowsHide, true); assert.equal(call.options.shell, false);
      assert.equal(JSON.stringify(call.args).includes(token), false);
      assert.equal(call.options.env.COPILOT_GITHUB_TOKEN, index >= 2 ? token : undefined);
    }
    leader.stop(); captured.at(-1)!.proc.emit("close", 0);
    assert.equal(runner.isRunning("p34-crew"), false);
    if (result.ok) for (const suffix of ["log", "brief.txt"]) {
      const path = join(runner.logsDir, `p34.coder-${result.timestamp}.${suffix}`);
      assert.equal(readFileSync(path, "utf8").includes(token), false); unlinkSync(path);
    }
    spy.mock.restore(); syncBuiltinESMExports();
  } finally {
    leader?.stop(); for (const call of captured) { call.proc.emit("close", 0); call.proc.stdout.destroy(); call.proc.stderr.destroy(); call.proc.stdin.destroy(); }
    for (const [key, value] of restoreEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.deepEqual({ ...process.env }, before, "launch environments never modify their parent"); await fx.close();
  }
});

test("PATH Copilot keeps the user's update environment and other tools never acquire the managed flag", async (t) => {
  const fx = await fixture(t), captured: any[] = [];
  const bin = join(fx.root, "bin"); mkdirSync(bin);
  for (const cli of ["copilot", "claude", "codex", "opencode"]) writeFileSync(join(bin, `${cli}.exe`), "inert");
  const fake = ((program: string, args: string[], options: any) => {
    const proc = child(); captured.push({ program, args, options });
    queueMicrotask(() => { proc.stdout.end("1.0.112"); proc.emit("close", 0); }); return proc;
  }) as any;
  const previous = new Map<string, string | undefined>();
  try {
    for (const value of [undefined, "true", "user-choice"]) {
      const env: NodeJS.ProcessEnv = { ...fx.env, PATH: bin, COPILOT_AUTO_UPDATE: value };
      if (value === undefined) delete env.COPILOT_AUTO_UPDATE;
      for (const cli of ["copilot", "claude", "codex", "opencode"]) {
        const run = createCliRunner(fake, env);
        assert.equal((await run(cli, ["--version"], { timeoutMs: 500 })).code, 0);
        assert.equal(captured.at(-1).options.env.COPILOT_AUTO_UPDATE, value, `detect ${cli}/${value}`);
        const login = createLoginRunner(fake)({ cli, env, timeoutMs: 500, signal: new AbortController().signal, output() {} });
        if (cli !== "opencode") { assert.equal((await login.done).code, 0); assert.equal(captured.at(-1).options.env.COPILOT_AUTO_UPDATE, value, `login ${cli}/${value}`); }
        else await login.done;
        const exe = join(bin, `${cli}.exe`);
        assert.equal((await run(exe, ["--version"], { timeoutMs: 500, cwd: fx.root, installer: { signal: new AbortController().signal } })).code, 0);
        assert.equal(captured.at(-1).options.env.COPILOT_AUTO_UPDATE, undefined, `installer ${cli} never forces a flag`);
      }
    }
    for (const [key, value] of Object.entries({ ...fx.env, COPILOT_AUTO_UPDATE: undefined })) {
      previous.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const cli of ["copilot", "claude", "codex", "opencode"]) assert.equal(leaderChildEnv({}, cli).COPILOT_AUTO_UPDATE, undefined, `leader/crew ${cli}`);
    // A Copilot that really resolves on PATH (inert stand-ins, never run) is not managed: the flag is not forced and the user's own value is kept.
    const cmdBin = join(fx.root, "cmd-bin"); mkdirSync(cmdBin); writeFileSync(join(cmdBin, "copilot.cmd"), "inert");
    for (const folder of [bin, cmdBin]) {
      process.env.PATH = folder;
      assert.ok(resolveCliPath("copilot", process.env), `a stand-in Copilot resolves in ${folder}`);
      assert.equal(leaderChildEnv({}, "copilot").COPILOT_AUTO_UPDATE, undefined, `PATH Copilot in ${folder} is not forced`);
      assert.equal(leaderChildEnv({ COPILOT_AUTO_UPDATE: "user-choice" }, "copilot").COPILOT_AUTO_UPDATE, "user-choice", `the user's own value is kept in ${folder}`);
    }
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fx.close();
  }
});
