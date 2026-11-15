import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lstatSync, mkdtempSync, readdirSync, rmdirSync } from "node:fs";
import { after } from "node:test";
import { fixture } from "./pack29-cli-install.setup.ts";
import { SettingsService } from "../server/settings/service.ts";
import { createLoginRunner, type RunLogin } from "../server/settings/cli-login-runner.ts";
export const loginRoot = mkdtempSync(join(tmpdir(), "cc-pack29-login-"));
after(() => {
  assert.equal(lstatSync(loginRoot).isSymbolicLink(), false);
  assert.deepEqual(readdirSync(loginRoot), []); rmdirSync(loginRoot);
});
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export async function until(check: () => boolean, label = "condition", ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail(`Timed out: ${label}`);
}
export const start = (cli = "codex", requestId = "login1") => ({ type: "cliLogin", requestId, cli });
export const cancel = (cli = "codex", loginRequestId = "login1") => ({ type: "cancelCliLogin", requestId: "stop1", cli, loginRequestId });
export const codexOutput = '\nWelcome to Codex [v\x1b[90m0.167.0\x1b[0m]\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mAB12-CD345\x1b[0m\n\nContinue only if you started this login in Codex.\n';
export function loginFixture(options: { status?: string; statusCode?: number; installed?: boolean | null; timeoutMs?: number; refreshPath?: () => Promise<unknown>; cleanup?: boolean; runner?: RunLogin; open?: (cli: string, url: string) => Promise<boolean> } = {}) {
  const fx = fixture(loginRoot), spawns: any[] = [], writes: string[] = [], events: any[] = [], snapshots: string[] = [];
  let loginStarted = false;
  let current: any, clean = options.cleanup !== false, probes = 0, sweeps = 0;
  for (const cli of ["claude", "codex", "grok", "copilot"]) fx.write(`${cli}.exe`);
  const runner = createLoginRunner(((bin: string, args: string[], settings: any) => {
    const proc = new EventEmitter() as any;
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.stdin.on("data", (data: Buffer) => writes.push(data.toString()));
    proc.exitCode = null; proc.signalCode = null;
    proc.pid = 998877; proc.kill = () => true;
    proc.finish = (code = 0, close = true) => { proc.exitCode = code; proc.emit("exit", code); if (close) { proc.emit("close", code); proc.stdout.end(); proc.stderr.end(); } };
    spawns.push({ bin, args, settings, proc }); current = proc; return proc;
  }) as any, (() => ({ failed: 0, release() {}, sweep: async () => {
    sweeps++;
    if (clean && current?.exitCode === null) current.finish(-1);
    return clean ? 0 : null;
  } })) as any);
  const optionsRunner = options.runner ?? runner;
  const service = new SettingsService({ dataRoot: fx.data, env: fx.env, runLogin: (options) => { loginStarted = true; return (optionsRunner)(options); },
    openLogin: options.open ?? (async () => true), refreshPath: options.refreshPath ?? (async () => {}), loginRecheckMs: 10, loginTimeoutMs: options.timeoutMs ?? 10000,
    runCli: async (bin, args) => {
      if (args.includes("--version") || args[0] === "version") return { code: options.installed === false ? 127 : options.installed === null ? -1 : 0, stdout: options.installed === false || options.installed === null ? "" : "1.2.3", stderr: "" };
      probes++; if (!loginStarted) return { code: 1, stdout: "not logged in", stderr: "" };
      return { code: options.statusCode ?? 0, stdout: options.status ?? (bin === "claude" ? '{"loggedIn":true}' : "Logged in using ChatGPT"), stderr: "" };
    }, onChange: () => snapshots.push(JSON.stringify(service.snapshot())) });
  const send = (event: any) => events.push(event);
  return { ...fx, service, spawns, writes, events, snapshots, send, probes: () => probes, sweeps: () => sweeps, proc: () => current,
    privateRequest: (type: string, extra = {}) => ({ type, requestId: "private1", cli: events[0].cli, loginId: events[0].loginId, ...extra }),
    setClean: (value: boolean) => { clean = value; },
    cleanup: async () => { clean = true; await service.login.drain(); await service.installer.drain(); fx.close(); } };
}
