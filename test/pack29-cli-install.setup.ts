import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after } from "node:test";
import { SettingsService } from "../server/settings/service.ts";
import { CLI_CATALOG } from "../server/settings/cli-catalog.ts";
import { createCliRunner } from "../server/settings/cli-runner.ts";
import type { CliResult, RunCli } from "../server/settings/types.ts";

export const logRoot = mkdtempSync(join(tmpdir(), "cc-pack29-install-"));
after(() => {
  assert.equal(lstatSync(logRoot).isSymbolicLink(), false);
  assert.deepEqual(readdirSync(logRoot), []); rmdirSync(logRoot);
});
export function fixture(rootDir = logRoot) {
  mkdirSync(rootDir, { recursive: true });
  const root = mkdtempSync(join(rootDir, "fixture-"));
  const bin = join(root, "bin"), data = join(root, "data"); mkdirSync(bin); mkdirSync(data);
  // Run from the isolated empty data directory, outside the repository.
  const previousCwd = process.cwd(); process.chdir(data);
  const env = { PATH: bin, USERPROFILE: root, HOME: root, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
    TEMP: root, TMP: root, CC_APP_KEY: "private-app", OPENAI_API_KEY: "private-provider", ELECTRON_RUN_AS_NODE: "1" };
  const write = (name: string, body = "") => { const path = join(bin, name); writeFileSync(path, body); return path; };
  const close = () => {
    process.chdir(previousCwd);
    // Only the task-owned unique fixture, no links and no recursive directory removal.
    const remove = (dir: string) => {
      assert.equal(lstatSync(dir).isSymbolicLink(), false, dir);
      for (const name of readdirSync(dir)) {
        const path = join(dir, name), info = lstatSync(path);
        assert.equal(info.isSymbolicLink(), false, path);
        if (info.isDirectory()) remove(path); else retryBusy(() => unlinkSync(path));
      }
      assert.deepEqual(readdirSync(dir), []); retryBusy(() => rmdirSync(dir));
    };
    // Windows can hold a folder for a moment after a child that used it has ended (indexer, scanner): retry only a busy or denied removal, briefly, then fail with the real error.
    const retryBusy = (action: () => void) => {
      for (let attempt = 0; ; attempt++) {
        try { action(); return; } catch (error: any) {
          if (attempt >= 40 || (error?.code !== "EBUSY" && error?.code !== "EPERM")) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
      }
    };
    remove(root);
  };
  return { root, bin, data, env, write, close };
}
export function child() {
  const proc = new EventEmitter() as any;
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => true;
  proc.end = (code = 0, stdout = "", stderr = "") => {
    proc.stdout.end(stdout); proc.stderr.end(stderr); proc.emit("exit", code); proc.emit("close", code);
  };
  return proc;
}
export function serviceFixture(options: { installed?: boolean | null; result?: Partial<CliResult>; hold?: boolean; admission?: () => boolean } = {}) {
  const fx = fixture(), calls: any[] = [], phases: string[] = [];
  let installed = options.installed ?? false, versionCode = options.installed === null ? -1 : 127, refreshes = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  // Resolution prerequisites use harmless files. The injected runner executes none.
  fx.write("node.exe"); fx.write("npm.cmd");
  mkdirSync(join(fx.bin, "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(join(fx.bin, "node_modules", "npm", "bin", "npm-cli.js"), "");
  const run: RunCli = async (bin, args, settings) => {
    calls.push({ bin, args, ...settings });
    if (settings.installer) {
      if (options.hold) await waiting;
      installed = true;
      return { code: 0, stdout: "sensitive-output", stderr: "secret-token", cleanupConfirmed: true, ...options.result };
    }
    if (/node.exe$/i.test(bin)) return { code: 0, stdout: "v24.1.0", stderr: "" };
    if (CLI_CATALOG.some((entry) => entry.detection?.program === bin)) return { code: installed ? 0 : versionCode, stdout: installed ? "tool 1.2.3" : "", stderr: "" };
    throw new Error(`Unexpected call: ${bin} ${args.join(" ")}`);
  };
  const service = new SettingsService({ dataRoot: fx.data, env: fx.env, runCli: run, installAdmission: options.admission,
    refreshPath: async () => { refreshes++; }, onChange: () => { phases.push(service.state.catalogTools.qwen.action?.phase ?? "null"); } });
  return { ...fx, service, run, calls, phases, release, setInstalled: (value: boolean) => { installed = value; }, refreshes: () => refreshes };
}
export const request = (cli = "qwen", requestId = "install1") => ({ type: "installCli", requestId, cli, confirm: true });
export const cancel = (cli = "qwen", installRequestId = "install1") => ({ type: "cancelCliInstall", requestId: "cancel1", cli, installRequestId });
export function injectedRunner(env: NodeJS.ProcessEnv, capture: (bin: string, args: string[], options: any, proc: any) => void) {
  return createCliRunner(((bin: string, args: string[], options: any) => { const proc = child(); capture(bin, args, options, proc); return proc; }) as any, env);
}
