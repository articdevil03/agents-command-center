import test from "node:test";
import assert from "node:assert/strict";
import { LoginOutput } from "../server/settings/cli-login-output.ts";
import { validateLoginUrl, loginProfile } from "../server/settings/cli-login-policy.js";
import { CLI_CATALOG } from "../server/settings/cli-catalog.ts";
import { LOGIN_MESSAGES, validateLoginRequest } from "../server/settings/cli-login.ts";
import { loginFixture, until, tick, start, cancel, codexOutput } from "./pack29-cli-login.setup.ts";
import { CliLogin } from "../server/settings/cli-login.ts";

test("cached-positive and fresh-positive sign-ins refuse before runner or opener and release admission", async () => {
  for (const source of ["cached", "fresh"]) for (const cli of source === "cached" ? ["claude", "codex", "copilot", "grok"] : ["claude", "codex"]) {
    const fx = loginFixture(); let runners = 0, opened = 0, detections = 0;
    const events: any[] = [];
    Object.assign(fx.service.state.catalogTools[cli], { installed: true, signedIn: source === "cached" ? true : null });
    const login = new CliLogin({ state: fx.service.state, env: fx.env, busy: () => false, publish() {}, refreshPath: async () => {},
      run: async (_bin, args) => { detections++; return { code: 0, stdout: args.includes("--version") ? "1.2.3" : cli === "claude" ? '{"loggedIn":true}' : "Logged in using ChatGPT", stderr: "" }; },
      runner: () => { runners++; return { done: Promise.resolve({ code: -1, stdout: "", stderr: "", cleanupConfirmed: true }), submit() {}, writable: () => false }; },
      open: async () => { opened++; return true; } });
    try {
      await assert.rejects(login.start(start(cli), (event) => events.push(event)), { message: "A credential is already saved." }, `${source} ${cli}`);
      assert.deepEqual([runners, opened, login.busy], [0, 0, false], `${source} ${cli}`);
      assert.equal(detections > 0, source === "fresh");
      assert.equal(events.at(-1).loginId, null); assert.equal(events.at(-1).reason, "existingCredentials");
    } finally { await login.drain(); await fx.cleanup(); }
  }
});

test("real codex device output with synthetic code parses every split, ANSI and no newline paste prompt", () => {
  for (let split = 1; split < codexOutput.length; split++) {
    const parser = new LoginOutput("codex"); parser.feed(codexOutput.slice(0, split)); parser.feed(codexOutput.slice(split));
    assert.deepEqual(parser.progress, { verificationUrl: "https://auth.openai.com/codex/device", deviceCode: "AB12-CD345", pasteRequired: false }, `split ${split}`);
  }
  const paste = new LoginOutput("claude");
  paste.feed("Opening browser to sign in...\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true\nPaste code here if prompted >");
  assert.equal(paste.progress.pasteRequired, true);
  assert.equal(paste.progress.verificationUrl, "https://claude.com/cai/oauth/authorize?code=true");
  const noise = new LoginOutput("codex"); noise.feed("https://auth.openai.com/codex/device\nAB12-CD345\n");
  assert.equal(noise.progress.verificationUrl, null); assert.equal(noise.progress.deviceCode, null);
});

test("URL validation refuses every hostile host/scheme/path and conflicting output before opener", async () => {
  const urls = ["http://auth.openai.com/codex/device", "https://user" + "@auth.openai.com/codex/device", "https://auth.openai.com.evil.com/codex/device", "https://github.com/login/device", "https://auth.openai.com:8443/codex/device", "https://auth.openai.com/wrong", "https://127.0.0.1/codex/device", "https://auth.openai.com/codex%2fdevice"];
  for (const url of urls) {
    let opened = 0; const fx = loginFixture({ open: async () => { opened++; return true; } });
    try {
      assert.equal(validateLoginUrl("codex", url), null, url);
      const done = fx.service.cliLogin(start(), fx.send); const failed = assert.rejects(done, /unsupported sign-in information/);
      await until(() => fx.spawns.length === 1);
      fx.proc().stdout.write(`Open this link in your browser\n${url}\n`);
      await failed; assert.equal(opened, 0, url); assert.equal(fx.service.login.busy, false);
    } finally { await fx.cleanup(); }
  }
  for (const [cli, hostile] of [["claude", "https://claude.com/oauth/a%2fb"], ["claude", "https://claude.com/oauth/a%5cb"], ["codex", "https://auth.openai.com/codex/device\n"], ["codex", "https://auth.openai.com/codex/device\u0000"]]) {
    assert.equal(validateLoginUrl(cli, hostile), null, JSON.stringify(hostile));
  }
  const parser = new LoginOutput("claude");
  assert.throws(() => parser.feed("If the browser didn't open, visit: https://claude.com/oauth/a https://platform.claude.com/oauth/b\n"), /unsafeOutput/);
  for (const value of ["AB12-CD34", "AB12-CD3456", "abcd-12345", "AB12-CD345_evil", "AB12-CD345/evil"]) {
    const parser = new LoginOutput("codex");
    assert.throws(() => parser.feed(`Open this link in your browser\nhttps://auth.openai.com/codex/device\nEnter this one-time code\n${value}\n`), /unsafeOutput/, value);
  }
});

test("all real catalog tools enabled or explicitly unsupported, without launching start", async () => {
  assert.ok(CLI_CATALOG.length > 0);
  for (const entry of CLI_CATALOG) {
    assert.equal(entry.signIn.managed, loginProfile(entry.id).managed, entry.id);
    assert.equal(entry.signIn.unsupportedMessage, entry.signIn.managed ? null : LOGIN_MESSAGES.unsupported, entry.id);
    if (!entry.recipe) continue;
    const fx = loginFixture(entry.id === "opencode" ? { status: "0 credentials" } : {});
    try {
      if (entry.id === "opencode") Object.assign(fx.service.state.catalogTools.opencode, { installed: true, supportedVersion: true, credentialSource: "none" });
      const done = fx.service.cliLogin(start(entry.id), fx.send);
      if (entry.id === "opencode") {
        const stopped = assert.rejects(done, /stopped/);
        await until(() => fx.events.at(-1)?.phase === "waitingKey");
        assert.equal(fx.spawns.length, 0);
        await fx.service.cliLogin(cancel("opencode"), fx.send); await stopped;
        continue;
      }
      if (entry.signIn.managed) {
        // A refusal before launch (for example a false "credential already saved") must fail HERE by assertion, not as an unhandled rejection.
        let refused = null as Error | null; done.catch((error: Error) => { refused = error; });
        await until(() => fx.spawns.length === 1 || refused !== null, entry.id);
        assert.equal(refused, null, `${entry.id}: a managed sign-in with no stored credential must launch, not be refused (${(refused as Error | null)?.message})`);
        await until(() => fx.spawns.length === 1, entry.id);
        const call = fx.spawns[0]; assert.equal(call.args.includes("start"), false, entry.id);
        assert.deepEqual(call.args, entry.signIn.command!.split(" ").slice(1), entry.id);
        fx.proc().finish(); await done;
        assert.equal(fx.events.at(-1).reason, ["claude", "codex"].includes(entry.id) ? null : "statusUnknown", entry.id);
        if (!["claude", "codex"].includes(entry.id)) assert.equal(fx.service.state.catalogTools[entry.id].signedIn, null, entry.id);
      } else { await assert.rejects(done, { message: LOGIN_MESSAGES.unsupported }, entry.id); assert.equal(fx.spawns.length, 0, entry.id); }
      console.log(`login catalog: ${entry.id}: ${entry.signIn.managed ? "enabled" : "unsupported"}`);
    } finally { await fx.cleanup(); }
  }
});

test("capability ownership, paste once, rate limit, private events and shared state secrecy", async () => {
  const fx = loginFixture(); const secret = "synthetic-authorization-secret";
  try {
    const done = fx.service.cliLogin(start("claude"), fx.send); await until(() => fx.spawns.length === 1);
    const req = (type: string, extra = {}) => fx.privateRequest(type, extra);
    await assert.rejects(fx.service.cliLogin(req("submitCliLoginCode", { code: secret }), fx.send), /not waiting/);
    fx.proc().stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=synthetic\nPaste code here if prompted >");
    assert.equal(fx.events.at(-1).phase, "waitingCode");
    await assert.rejects(fx.service.cliLogin(req("getCliLoginState", { loginId: "a".repeat(48) }), fx.send), /already running/);
    await assert.rejects(fx.service.cliLogin({ type: "getCliLoginState", cli: "claude", requestId: "missing" }, fx.send), /Invalid/);
    await assert.rejects(fx.service.cliLogin(req("submitCliLoginCode", { code: secret }), fx.send), /Wait/);
    await new Promise((resolve) => setTimeout(resolve, 2005));
    await fx.service.cliLogin(req("submitCliLoginCode", { code: secret }), fx.send);
    assert.equal(fx.events.at(-1).pasteRequired, false, "consumed before any echo arrives");
    assert.deepEqual(fx.writes, [secret + "\n"]);
    fx.proc().stdout.write(secret + "\n");
    await assert.rejects(fx.service.cliLogin(req("submitCliLoginCode", { code: secret }), fx.send), /Wait/);
    assert.equal(fx.events.at(-1).pasteRequired, false);
    assert.doesNotMatch(JSON.stringify(fx.events), new RegExp(secret));
    for (const snapshot of fx.snapshots) assert.doesNotMatch(snapshot, /verificationUrl|deviceCode|pasteRequired|expiresAt|loginId|synthetic|https:\/\/claude/);
    fx.proc().finish(); await done;
    assert.equal(fx.events.at(-1).loginId, null); assert.equal(fx.events.at(-1).verificationUrl, null);
  } finally { await fx.cleanup(); }
});

test("fixed exact request keys, synchronous admission, reload, cancel and install serialization", async () => {
  const fx = loginFixture();
  try {
    for (const extra of [{ command: "evil" }, { url: "evil" }, { env: {} }, { pid: 9 }, { timeout: 1 }]) {
      assert.throws(() => validateLoginRequest({ ...start(), ...extra }), /Invalid/);
      await assert.rejects(fx.service.cliLogin({ ...start(), ...extra }, fx.send), /Invalid/);
    }
    const done = fx.service.cliLogin(start(), fx.send); const ended = assert.rejects(done, /stopped/);
    assert.equal(fx.service.login.busy, true, "admission setter precedes the first await");
    await assert.rejects(fx.service.cliLogin(start("claude", "second"), fx.send), /Another/);
    await assert.rejects(fx.service.installCli("qwen", "install1", true), /blocked/);
    await until(() => fx.spawns.length === 1);
    await assert.rejects(fx.service.cliLogin(fx.privateRequest("getCliLoginState", { loginId: "0".repeat(48) }), fx.send), /already running/);
    await assert.rejects(fx.service.cliLogin(fx.privateRequest("getCliLoginState", { cli: "claude" }), fx.send), /already running/);
    const subscribed: any[] = [];
    await fx.service.cliLogin(fx.privateRequest("getCliLoginState"), (event) => subscribed.push(event));
    assert.ok(subscribed[0].loginId); await fx.service.cliLogin(cancel(), fx.send); await ended;
    assert.equal(fx.spawns.length, 1); assert.equal(fx.service.login.busy, false);
    assert.equal(subscribed.at(-1).reason, "cancelled");
  } finally { await fx.cleanup(); }
});

test("output bound, timeout, false-success and retained cleanup lock with Stop again", async () => {
  for (const mode of ["flood", "timeout", "exit", "cleanup"] as const) {
    const fx = loginFixture({ status: "not logged in", timeoutMs: mode === "timeout" ? 30 : 10000, cleanup: mode !== "cleanup" });
    try {
      const done = fx.service.cliLogin(start(), fx.send);
      const reason = { flood: "unsupported sign-in", timeout: "expired", exit: "did not finish", cleanup: "confirm sign-in stopped" }[mode];
      const failed = assert.rejects(done, new RegExp(reason));
      await until(() => fx.spawns.length === 1);
      if (mode === "flood") fx.proc().stdout.write(Buffer.alloc(1024 * 1024 + 1, 120));
      if (mode === "exit" || mode === "cleanup") fx.proc().finish();
      await failed;
      assert.notEqual(fx.service.state.catalogTools.codex.signedIn, true, mode);
      if (mode === "cleanup") {
        assert.equal(fx.service.login.busy, true);
        await assert.rejects(fx.service.cliLogin(start("claude", "next"), fx.send), /Another/);
        fx.setClean(true); await fx.service.cliLogin(cancel(), fx.send); assert.equal(fx.service.login.busy, false);
      }
    } finally { await fx.cleanup(); }
  }
});

test("server shutdown closes login admission synchronously, waits for login drain, and fails unknown cleanup", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const first = source.indexOf("let shutdownWork:"), last = source.indexOf('bindShutdown(requestShutdown);', first);
  assert.ok(first > 0 && last > first, "actual shutdown body found");
  for (const connected of [false, true]) for (const confirmed of [false, true]) {
    let release!: (ok: boolean) => void, closed = 0, drains = 0;
    const loginDrain = new Promise<boolean>((resolve) => { release = resolve; });
    const exits: number[] = [], noop = () => {};
    const shutdown = runInNewContext(`(() => { ${stripTypeScriptTypes(source.slice(first, last))}; return shutdown; })()`, {
      settingsService: { cliKeys: { close: () => {} }, models: { close: noop, drain: async () => {} }, installer: { close: noop, drain: async () => true }, login: { close: () => { closed++; }, drain: () => { drains++; return loginDrain; } } },
      fixedGitOperations: { close: noop, drain: async () => true }, closeWorkerAdmission: noop,
      console: { log: noop, error: noop }, folderActivity: { endAllOwn: noop, closeWatchers: noop }, leadersAndWaitingTurns: () => [],
      stopLeaderSession: noop, stopAllRunning: noop, drainWorkers: async () => true,
      process: { connected, exit: (code: number) => exits.push(code) }, clients: [], wss: { close: noop },
      server: { close: (done: () => void) => done(), closeAllConnections: noop }, stallTimer: undefined, backpressureTimer: undefined,
      setTimeout, clearTimeout, clearInterval, describeError: String, spawnSync: () => assert.fail("no parent-loss kill for this test") });
    const pending = shutdown("test");
    assert.equal(closed, 1, "admission closes without await"); assert.equal(drains, 1);
    await tick(); assert.deepEqual(exits, [], "root retained while login drain waits");
    release(confirmed); await pending; assert.deepEqual(exits, [confirmed ? 0 : 1]);
  }
});


test("parser carry bound, renewed paste prompts, secret input validation and five-attempt ceiling", async () => {
  const parser = new LoginOutput("claude"); parser.feed("x".repeat(50000));
  assert.ok(Buffer.byteLength((parser as any).buffer) <= 8192, "parser carry is bounded");
  parser.feed("?".repeat(50000));
  assert.ok(Buffer.byteLength((parser as any).buffer) <= 8192, "multibyte parser carry is byte bounded");
  const wide = new LoginOutput("claude"); wide.feed("\u00e9".repeat(5000));
  assert.ok(Buffer.byteLength((wide as any).buffer) <= 8192, "two-byte characters: the carry is bounded by bytes, not characters");
  parser.feed("Paste code here if prompted >"); parser.consumePaste(); parser.feed("synthetic-secret-echo\nPaste code he"); parser.feed("re if prompted >");
  assert.equal(parser.progress.pasteRequired, true, "a new prompt can be consumed once again");
  const fx = loginFixture({ timeoutMs: 30000 });
  try {
    const done = fx.service.cliLogin(start("claude"), fx.send); const stopped = assert.rejects(done, /stopped/);
    await until(() => fx.spawns.length === 1);
    fx.proc().stdout.write("Paste code here if prompted >");
    for (const code of ["", "line\ncode", "https://example.com/code", "x".repeat(2049), "bad\x7fcode"]) {
      await assert.rejects(fx.service.cliLogin(fx.privateRequest("submitCliLoginCode", { code }), fx.send), /not waiting/);
      await new Promise((resolve) => setTimeout(resolve, 2005));
    }
    await assert.rejects(fx.service.cliLogin(fx.privateRequest("submitCliLoginCode", { code: "valid-code" }), fx.send), /Wait/);
    assert.deepEqual(fx.writes, []);
    await fx.service.cliLogin(cancel("claude"), fx.send); await stopped;
    fx.service.login.close();
    await assert.rejects(fx.service.cliLogin(start(), fx.send), /Another/);
  } finally { await fx.cleanup(); }
});

test("contradictory and unrecognized status never means signed in, even after exit zero", async () => {
  for (const options of [{ status: "not signed in" }, { status: "Logged in using ChatGPT", statusCode: 1 }, { status: "successful mystery response" }]) {
    const fx = loginFixture(options);
    try {
      const done = fx.service.cliLogin(start(), fx.send); const failed = assert.rejects(done, /did not finish/);
      await until(() => fx.spawns.length === 1); fx.proc().finish(); await failed;
      assert.notEqual(fx.service.state.catalogTools.codex.signedIn, true, JSON.stringify(options));
      assert.equal(fx.events.at(-1).reason, "notSignedIn");
    } finally { await fx.cleanup(); }
  }
});

test("server opens only its owned validated URL, browser failure keeps login running", async () => {
  const opened: string[] = [], fx = loginFixture({ open: async (_cli, url) => { opened.push(url); return false; } });
  try {
    const done = fx.service.cliLogin(start(), fx.send), failed = assert.rejects(done, /stopped/);
    await until(() => fx.spawns.length === 1); fx.proc().stdout.write(codexOutput);
    await assert.rejects(fx.service.cliLogin(fx.privateRequest("openCliLogin", { url: "https://evil.example" }), fx.send), /Invalid/);
    assert.deepEqual(opened, []);
    await fx.service.cliLogin(fx.privateRequest("openCliLogin"), fx.send);
    assert.deepEqual(opened, ["https://auth.openai.com/codex/device"]);
    assert.equal(fx.events.at(-1).reason, "browserUnavailable"); assert.equal(fx.events.at(-1).status, "running");
    assert.equal(fx.service.state.catalogTools.codex.action?.status, "running");
    await fx.service.cliLogin(cancel(), fx.send); await failed;
  } finally { await fx.cleanup(); }
});

test("managed login refreshes PATH inside its held admission lock before detection and hidden spawn", async () => {
  let release!: () => void, refreshes = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fx = loginFixture({ refreshPath: async () => { refreshes++; await held; fx.env.PATH = fx.bin; } });
  fx.env.PATH = "";
  try {
    const done = fx.service.cliLogin(start(), fx.send);
    assert.equal(fx.service.login.busy, true); assert.equal(refreshes, 1);
    assert.equal(fx.probes(), 0); assert.equal(fx.spawns.length, 0); assert.equal(fx.service.state.catalogTools.codex.version, null);
    await assert.rejects(fx.service.cliLogin(start("claude", "concurrent"), fx.send), /Another/);
    release(); await until(() => fx.spawns.length === 1);
    assert.equal(fx.spawns[0].settings.env.PATH, fx.bin);
    fx.proc().finish(); await done;
    assert.equal(refreshes, 1); assert.equal(fx.service.state.catalogTools.codex.signedIn, true);
  } finally { release(); await fx.cleanup(); }
});

// A runner the test drives by hand: output() is called synchronously, writable() and the submit count are visible.
function handRunner(writable: boolean) {
  const hand: { output?: (chunk: Buffer) => void; submits: string[] } = { submits: [] };
  const runner = ((options: any) => {
    hand.output = options.output;
    return { done: new Promise((resolve) => options.signal.addEventListener("abort", () => resolve({ code: -1, stdout: "", stderr: "", cancelled: true, cleanupConfirmed: true }))),
      writable: () => writable, submit: (code: string) => { hand.submits.push(code); } };
  }) as any;
  return { hand, runner };
}
test("a code is never written to a child that is not writable, and no event is served once the sign-in is aborted", async () => {
  const { hand, runner } = handRunner(false), fx = loginFixture({ runner });
  try {
    const done = fx.service.cliLogin(start("claude"), fx.send), stopped = assert.rejects(done, /unsupported sign-in|stopped/);
    await until(() => !!hand.output, "runner started");
    hand.output!(Buffer.from("Paste code here if prompted >"));
    assert.equal(fx.events.at(-1).phase, "waitingCode");
    await assert.rejects(fx.service.cliLogin(fx.privateRequest("submitCliLoginCode", { code: "valid-code" }), fx.send), /not waiting/);
    assert.deepEqual(hand.submits, [], "nothing written to a child that cannot take input");
    // Unsafe output aborts at once; until the sign-in ends, the still-set capability must serve nothing.
    hand.output!(Buffer.from("If the browser didn't open, visit: https://evil.example/x\n"));
    await assert.rejects(fx.service.cliLogin(fx.privateRequest("getCliLoginState"), fx.send), /already running/);
    await stopped;
  } finally { await fx.cleanup(); }
});

test("login admission refuses while an installation runs or admission is closed", async () => {
  const { CliLogin } = await import("../server/settings/cli-login.ts");
  const fx = loginFixture();
  try {
    for (const deps of [{ busy: () => true }, { busy: () => false, admission: () => false }]) {
      const login = new CliLogin({ state: fx.service.state, run: async () => ({ code: 0, stdout: "1.2.3", stderr: "" }), env: fx.env, publish() {}, ...deps });
      await assert.rejects(login.start(start(), () => {}), /Another/);
      assert.equal(login.busy, false);
    }
  } finally { await fx.cleanup(); }
});
