import test from "node:test";
import assert from "node:assert/strict";
import { LoginOutput } from "../server/settings/cli-login-output.ts";
import { validateLoginUrl } from "../server/settings/cli-login-policy.js";
import { parseGitHubAuthStatus } from "../server/settings/parse.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";
import { GITHUB_LOGIN_ARGS, GITHUB_STATUS_ARGS, resolveGitHub } from "../server/settings/github-login.ts";
import { setCliSkipFolders } from "../server/leader-common/cli-path.ts";
import { CliLogin } from "../server/settings/cli-login.ts";
import { createCliRunner } from "../server/settings/cli-runner.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loginFixture, start, cancel, until } from "./pack29-cli-login.setup.ts";

export const URL = "https://github.com/login/device";
export const OUTPUT = `! First copy your one-time code: AB12-CD34\nPress Enter to open ${URL} in your browser...\n`;
export const POSITIVE = "github.com\n  Logged in to github.com account synthetic-user (keyring)\n  - Active account: true\n";
export function githubFixture(options: Parameters<typeof loginFixture>[0] = {}) {
  const fx = loginFixture({ status: POSITIVE, ...options }); fx.write("gh.exe"); return fx;
}

test("GitHub is an internal target; exact URL policy and native resolver reject projects", async () => {
  assert.throws(() => catalogTool("github"));
  const fx = githubFixture();
  try {
    assert.equal(resolveGitHub(fx.env), fx.bin + "\\gh.exe");
    setCliSkipFolders(() => [fx.bin]);
    assert.notEqual(resolveGitHub(fx.env), fx.bin + "\\gh.exe");
    const hostile = ["http://github.com/login/device", "https://github.com.evil.example/login/device", "https://user" + "@github.com/login/device", "https://github.com:443/login/device", URL + "/more", URL + "?x=1", URL + "#x"];
    for (const url of hostile) assert.equal(validateLoginUrl("github", url), null, url);
  } finally { setCliSkipFolders(() => []); await fx.cleanup(); }
});

test("stderr device output parses every split and Enter is consumed once only after its prompt", () => {
  for (let split = 1; split < OUTPUT.length; split++) {
    const parser = new LoginOutput("github");
    parser.feed(OUTPUT.slice(0, split), "stderr"); parser.feed(OUTPUT.slice(split), "stderr");
    assert.equal(parser.progress.deviceCode, "AB12-CD34", `split ${split}`);
    assert.equal(parser.progress.verificationUrl, URL, `split ${split}`);
    assert.equal(parser.takeEnterPrompt(), true); assert.equal(parser.takeEnterPrompt(), false);
  }
  const parser = new LoginOutput("github");
  parser.feed("! First copy your one-time co", "stderr");
  parser.feed(`Open ${URL} in your browser\n`, "stdout");
  parser.feed("de: AB12-CD34\n", "stderr");
  assert.equal(parser.progress.deviceCode, "AB12-CD34"); assert.equal(parser.progress.verificationUrl, URL);
  assert.equal(parser.takeEnterPrompt(), false);
  assert.throws(() => parser.feed("one-time code: ZZ99-YY88\n", "stderr"), /unsafeOutput/);
  const flood = new LoginOutput("github"); assert.throws(() => flood.feed("x".repeat(1024 * 1024 + 1)), /outputLimit/);
});

test("GitHub truth table requires successful exit and recognized active account", () => {
  for (const [code, text, expected] of [[0, POSITIVE, true], [1, POSITIVE, false], [0, "unknown", false], [0, "", false], [0, POSITIVE.replace("true", "false"), false], [0, "Logged in to github.com account synthetic-user", false]] as const) {
    const result = parseGitHubAuthStatus({ code, stdout: "", stderr: text });
    assert.equal(result.connected, expected, `${code}: ${text}`);
    assert.equal(result.account, expected ? "synthetic-user" : null);
  }
});

test("GitHub hidden attached runner, fixed argv, no speculative Enter, post-cleanup probe, private state cleared", async () => {
  for (const prompt of [true, false]) {
    const opened: string[] = [], fx = githubFixture({ open: async (_cli, url) => { opened.push(url); return true; } });
    try {
      const pending = fx.service.cliLogin(start("github"), fx.send);
      await until(() => fx.spawns.length === 1);
      const call = fx.spawns[0];
      assert.equal(call.bin, fx.bin + "\\gh.exe"); assert.deepEqual(call.args, GITHUB_LOGIN_ARGS);
      assert.equal(call.settings.shell, false); assert.equal(call.settings.windowsHide, true); assert.equal(call.settings.detached, false);
      assert.deepEqual(call.settings.stdio, ["pipe", "pipe", "pipe"]);
      assert.doesNotMatch(call.bin, /cmd\.exe/i); assert.equal(call.args.includes("start"), false);
      fx.proc().stderr.write("! First copy your one-time co");
      fx.proc().stdout.write("unrelated output\n");
      fx.proc().stderr.write(`de: AB12-CD34\n${prompt ? "Press Enter to open" : "Open"} ${URL} in your browser...\n`);
      assert.deepEqual(fx.writes, prompt ? ["\n"] : []);
      if (prompt) { fx.proc().stderr.write(`Press Enter to open ${URL} in your browser...\n`); assert.deepEqual(fx.writes, ["\n"]); }
      assert.equal(fx.events.at(-1).deviceCode, "AB12-CD34");
      assert.equal(fx.events.at(-1).verificationUrl, URL);
      assert.equal(fx.service.state.github.connected, null); assert.equal(fx.probes(), 0);
      await fx.service.cliLogin(fx.privateRequest("openCliLogin"), fx.send); assert.deepEqual(opened, [URL]);
      await assert.rejects(fx.service.cliLogin(start("github", "second"), fx.send), /Another/);
      fx.proc().finish(); await pending;
      assert.ok(fx.sweeps() > 0); assert.equal(fx.probes(), 1);
      assert.equal(fx.service.state.github.connected, true); assert.equal(fx.service.state.github.account, null);
      assert.equal(fx.events.at(-1).status, "done");
      for (const field of ["deviceCode", "verificationUrl", "loginId"]) assert.equal(fx.events.at(-1)[field], null, field);
      for (const snapshot of fx.snapshots) assert.doesNotMatch(snapshot, /AB12-CD34|login\/device|synthetic-user/);
      assert.equal(fx.service.login.busy, false);
    } finally { await fx.cleanup(); }
  }
});

test("GitHub hostile URLs are ignored and conflicting codes fail without opening", async () => {
  for (const text of ["http://github.com/login/device", "https://github.com.evil.example/login/device", "https://user" + "@github.com/login/device", "https://github.com:8443/login/device", URL + "/more", `${URL}\none-time code: ZZ99-YY88`]) {
    let opens = 0; const fx = githubFixture({ open: async () => { opens++; return true; } });
    try {
      const pending = fx.service.cliLogin(start("github"), fx.send);
      const conflict = text.includes("ZZ99-YY88");
      const failed = conflict ? assert.rejects(pending, /unsupported sign-in/) : null;
      await until(() => fx.spawns.length === 1);
      fx.proc().stderr.write(`! First copy your one-time code: AB12-CD34\n${"x".repeat(9000)}\n${text}\n`);
      if (failed) await failed;
      else {
        assert.equal(fx.events.at(-1).verificationUrl, null);
        await assert.rejects(fx.service.cliLogin(fx.privateRequest("openCliLogin"), fx.send));
        fx.proc().finish(); await pending;
      }
      assert.equal(opens, 0); assert.equal(fx.service.state.github.connected, conflict ? null : true);
    } finally { await fx.cleanup(); }
  }
});

test("GitHub failure, timeout, flood, Cancel, retained cleanup and Stop again", async () => {
  for (const mode of ["failure", "timeout", "flood", "cancel", "cleanup"] as const) {
    const fx = githubFixture({ cleanup: mode !== "cleanup", timeoutMs: mode === "timeout" ? 35 : 10000 });
    try {
      const pending = fx.service.cliLogin(start("github"), fx.send), failed = assert.rejects(pending);
      await until(() => fx.spawns.length === 1);
      if (mode === "failure") fx.proc().finish(1);
      if (mode === "flood") fx.proc().stderr.write("x".repeat(1024 * 1024 + 1));
      if (mode === "cancel" || mode === "cleanup") {
        const stopping = fx.service.cliLogin(cancel("github"), fx.send);
        if (mode === "cleanup") await assert.rejects(stopping, /confirm sign-in stopped/); else await stopping;
      }
      await failed;
      assert.equal(fx.service.state.github.connected, null);
      assert.ok(fx.sweeps() > 0);
      if (mode === "cleanup") {
        assert.equal(fx.service.login.busy, true); assert.equal(fx.events.at(-1).reason, "cleanupUnconfirmed");
        await assert.rejects(fx.service.cliLogin(start("github", "second"), fx.send), /Another/);
        fx.setClean(true); await fx.service.cliLogin(cancel("github"), fx.send);
      }
      assert.equal(fx.service.login.busy, false);
      assert.equal(fx.events.at(-1).deviceCode, null);
    } finally { await fx.cleanup(); }
  }
});

test("GitHub final status failure never connects; shutdown drains and closes admission", async () => {
  for (const options of [{ status: "unknown" }, { status: POSITIVE, statusCode: 1 }, { status: "" }]) {
    const fx = githubFixture(options);
    try {
      const pending = fx.service.cliLogin(start("github"), fx.send), failed = assert.rejects(pending, /did not finish/);
      await until(() => fx.spawns.length === 1); fx.proc().finish(); await failed;
      assert.equal(fx.service.state.github.connected, null);
    } finally { await fx.cleanup(); }
  }
  const fx = githubFixture();
  try {
    const pending = fx.service.cliLogin(start("github"), fx.send), stopped = assert.rejects(pending, /stopped/);
    await until(() => fx.spawns.length === 1); assert.equal(await fx.service.login.drain(), true); await stopped;
    await assert.rejects(fx.service.cliLogin(start("github", "next"), fx.send), /Another/);
    assert.equal(fx.service.login.busy, false);
  } finally { await fx.cleanup(); }
});

test("GitHub missing installation has a plain message without a launch", async () => {
  const fx = githubFixture({ installed: false });
  try { await assert.rejects(fx.service.cliLogin(start("github"), fx.send), /GitHub CLI is not installed on this PC\./); assert.equal(fx.spawns.length, 0); }
  finally { await fx.cleanup(); }
});

test("GitHub service deadline aborts even a runner without its own timeout", async () => {
  const fx = githubFixture(); let completed = false;
  const login = new CliLogin({ state: fx.service.state, env: fx.env, run: async () => ({ code: 0, stdout: "2.95.0", stderr: "" }),
    busy: () => false, publish() {}, refreshPath: async () => {}, timeoutMs: 35,
    runner: (options) => ({ writable: () => false, submit() {}, done: new Promise((resolve) => {
      options.signal.addEventListener("abort", () => resolve({ code: -1, stdout: "", stderr: "", cancelled: true, cleanupConfirmed: true }));
    }) }) });
  try {
    const pending = login.start(start("github"));
    const failed = assert.rejects(pending, /expired/).then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(completed, true, "the service deadline fires independently of the vendor runner"); await failed;
  } finally { await login.drain(); await fx.cleanup(); }
});

test("GitHub status runner resolves an absolute native executable and hides its window", async () => {
  const fx = githubFixture(); const calls: any[] = [];
  const runner = createCliRunner(((bin: string, args: string[], options: any) => {
    calls.push({ bin, args, options });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    setImmediate(() => { child.stdout.end(POSITIVE); child.emit("close", 0); }); return child;
  }) as any, fx.env);
  try {
    const result = await runner("gh", GITHUB_STATUS_ARGS, { timeoutMs: 1000, directExecutable: true });
    assert.equal(parseGitHubAuthStatus(result).connected, true);
    assert.equal(calls[0].bin, fx.bin + "\\gh.exe"); assert.deepEqual(calls[0].args, GITHUB_STATUS_ARGS);
    assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].args.includes("--show-token"), false);
  } finally { await fx.cleanup(); }
});
