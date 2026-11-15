import { OpenCodeModelRefresh } from "./opencode/models.ts";
import { createTestCliRunner } from "../test-cli-runner.ts";
import { createKeyRunner } from "./opencode/key.ts";
import { CliInstaller } from "./cli-install.ts";
import { CliLogin } from "./cli-login.ts";
import { createCliRunner } from "./cli-runner.ts";
import { loginEnv } from "./cli-login-runner.ts";
import { windowsSystem32 } from "../leader-common/cli-path.ts";
import type { SettingsServiceOptions, SettingsState, RunCli } from "./types.ts";

export function createSetupActions(options: SettingsServiceOptions, state: SettingsState, env: NodeJS.ProcessEnv, publish: () => void) {
  const defaultRun = createCliRunner(undefined, env);
  const probeRun = createTestCliRunner(env) ?? createTestCliRunner(process.env) ?? defaultRun;
  const run = options.runCli ?? ((bin, args, settings) => {
    if (settings.installer && (env.CC_TEST_FAKE_CLI === "1" || process.env.CC_TEST_FAKE_CLI === "1")) return Promise.resolve({ code: -1, stdout: "", stderr: "", cleanupConfirmed: true });
    return (settings.installer ? defaultRun : probeRun)(bin, args, settings);
  });
  const models = new OpenCodeModelRefresh(run, (items, state) => { options.onOpenCodeModels?.(items, state); publish(); });
  const refreshModels = () => models.refresh(true);
  let login: CliLogin;
  const installer = new CliInstaller({ refreshModels, state, run, env, publish, refreshPath: options.refreshPath, installOptions: options.installOptions, admission: () => !login?.busy && options.installAdmission?.() !== false });
  const probeRunner = options.runCli ?? createTestCliRunner(env) ?? createTestCliRunner(process.env) ?? createCliRunner(undefined, loginEnv(env));
  const loginRun: RunCli = (bin, args, settings) => probeRunner(bin, args, { ...settings, cwd: process.platform === "win32" ? windowsSystem32() : "/" });
  login = new CliLogin({ refreshModels, state, run: loginRun,
    env, publish, busy: () => installer.busy, admission: options.installAdmission, refreshPath: options.refreshPath,
    runner: options.runLogin, runKey: options.runKey ?? createKeyRunner({ run: loginRun }), probeMs: options.loginRecheckMs, timeoutMs: options.loginTimeoutMs, open: options.openLogin });
  return { run, installer, login, models };
}
