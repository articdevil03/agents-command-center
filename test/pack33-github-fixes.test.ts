import test from "node:test";
import assert from "node:assert/strict";
import { SettingsService } from "../server/settings/service.ts";
import { parseGitHubAuthStatus } from "../server/settings/parse.ts";
import { LoginOutput } from "../server/settings/cli-login-output.ts";
import { loginEnv } from "../server/settings/cli-login-runner.ts";
import { fixture, injectedRunner } from "./pack29-cli-install.setup.ts";
import { loginFixture, start, until } from "./pack29-cli-login.setup.ts";

const DEVICE = "https://github.com/login/device";
const POSITIVE = "Logged in to github.com account private-synthetic-name\nActive account: true\n";

test("Settings reader distinguishes unavailable probes from definite auth; login fails closed", () => {
  for (const [code, text, settings, login] of [
    [0, POSITIVE, true, true], [1, POSITIVE, null, false],
    [124, POSITIVE, null, false], [127, "not logged in", null, false],
    [-1, "spawn error", null, false], [0, "", null, false],
    [0, "unknown", null, false], [1, "not logged in", false, false],
    [0, POSITIVE.replace("true", "false"), false, false],
  ] as const) {
    const result = { code, stdout: "", stderr: text };
    assert.equal(parseGitHubAuthStatus(result, "settings").connected, settings, `settings ${code}: ${text}`);
    assert.equal(parseGitHubAuthStatus(result).connected, login, `login ${code}: ${text}`);
  }
});

test("refreshAll never publishes account names and handles a thrown status probe as unknown", async () => {
  const fx = fixture(), frames: string[] = [];
  let fail = false;
  const service = new SettingsService({ dataRoot: fx.data, env: fx.env,
    runCli: async (bin) => {
      if (bin === "gh" && fail) throw new Error("spawn failed");
      return { code: 0, stdout: bin === "gh" ? POSITIVE : "", stderr: "" };
    }, onChange: () => frames.push(JSON.stringify(service.snapshot())) });
  try {
    await service.refreshAll(null);
    assert.equal(service.snapshot().github.connected, true);
    assert.equal(service.snapshot().github.account, null);
    assert.ok(frames.length > 0);
    for (const frame of [...frames, JSON.stringify(service.state), JSON.stringify(service.snapshot())]) assert.doesNotMatch(frame, /private-synthetic-name/);
    fail = true; await service.refreshAll(null);
    assert.equal(service.snapshot().github.connected, null);
  } finally { await service.login.drain(); await service.installer.drain(); fx.close(); }
});

test("GitHub ignores help links and accepts sentence punctuation without weakening other tools", async () => {
  for (const punctuation of [".", ",", ")", ";"]) {
    const parser = new LoginOutput("github");
    assert.doesNotThrow(() => parser.feed(`see https://github.com/cli/cli for help\nOpen ${DEVICE}${punctuation}\n`));
    assert.equal(parser.progress.verificationUrl, DEVICE, punctuation);
  }
  const other = new LoginOutput("codex");
  assert.throws(() => other.feed("Open this link in your browser\nhttps://evil.example/device\n"), /unsafeOutput/);
  const opened: string[] = [];
  const fx = loginFixture({ status: POSITIVE, open: async (_cli, url) => { opened.push(url); return true; } });
  fx.write("gh.exe");
  try {
    const pending = fx.service.cliLogin(start("github"), fx.send);
    await until(() => fx.spawns.length === 1);
    fx.proc().stderr.write(`see https://github.com/cli/cli for help\none-time code: AB12-CD34\n${DEVICE}.\n`);
    assert.equal(fx.events.at(-1).verificationUrl, DEVICE);
    await fx.service.cliLogin(fx.privateRequest("openCliLogin"), fx.send);
    assert.deepEqual(opened, [DEVICE]);
    fx.proc().finish(); await pending;
    assert.equal(fx.service.state.github.connected, true);
  } finally { await fx.cleanup(); }
});

test("GitHub login and status probe preserve custom config but exclude host and tokens", async () => {
  const fx = loginFixture(); fx.write("gh.exe");
  Object.assign(fx.env, { GH_CONFIG_DIR: fx.root, GH_HOST: "evil.example", GH_TOKEN: "synthetic-token", GITHUB_TOKEN: "synthetic-token" });
  const assertEnv = (env: NodeJS.ProcessEnv) => {
    assert.equal(env.GH_CONFIG_DIR, fx.root);
    for (const name of ["GH_HOST", "GH_TOKEN", "GITHUB_TOKEN"]) assert.equal(env[name], undefined, name);
  };
  try {
    const pending = fx.service.cliLogin(start("github"), fx.send);
    const stopped = assert.rejects(pending);
    await until(() => fx.spawns.length === 1); assertEnv(fx.spawns[0].settings.env);
    await fx.service.cliLogin({ type: "cancelCliLogin", requestId: "cancel-config", cli: "github", loginRequestId: "login1" }, fx.send);
    await stopped;
    let calls = 0;
    const run = injectedRunner(loginEnv(fx.env), (_bin, _args, options, child) => {
      calls++; assertEnv(options.env); setImmediate(() => child.end(0, POSITIVE));
    });
    await run("gh", ["auth", "status", "--active", "--hostname", "github.com"], { timeoutMs: 1000, directExecutable: true });
    assert.equal(calls, 1);
  } finally { await fx.cleanup(); }
});
