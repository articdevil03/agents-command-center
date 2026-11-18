import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { CliLogin } from "../server/settings/cli-login.ts";
import { loginFixture, start, cancel, until } from "./pack29-cli-login.setup.ts";
import { keyFixture, begin, KEY } from "./pack29-opencode-key.setup.ts";

// Recreate the controller with only public server state, as a page reload does.
function reloadedUi(settings: unknown) {
  const window: any = { addEventListener() {} };
  runInNewContext(readFileSync(new URL("../public/first-run/login.js", import.meta.url), "utf8"), {
    window, document: { body: {} }, MutationObserver: class { observe() {} },
  });
  const sent: any[] = [];
  const ui = window.CC_CLI_LOGIN.create({ state: { settings, cliCatalog: [{ id: "opencode" }] }, settingsActionId: () => null,
    sendSettingsAction: (_key: string, message: any) => { sent.push(message); return "stop-request"; } });
  return { ui, sent };
}

test("P6 GitHub keeps every previous status during start and cancel", async () => {
  for (const connected of [true, false, null]) {
    const fx = loginFixture(); fx.write("gh.exe");
    fx.service.state.github.connected = connected;
    try {
      const pending = fx.service.cliLogin(start("github"), fx.send), stopped = assert.rejects(pending, /stopped/);
      await until(() => fx.spawns.length === 1);
      assert.equal(fx.service.snapshot().github.connected, connected, "start must not invent a status");
      await fx.service.cliLogin(cancel("github"), fx.send); await stopped;
      assert.equal(fx.service.snapshot().github.connected, connected, "cancel must not invent a status");
    } finally { await fx.cleanup(); }
  }
});

test("P6 GitHub failed or thrown authentication probe is unknown", async () => {
  for (const result of [{ code: 124, stdout: "", stderr: "" }, { code: 1, stdout: "unrecognized", stderr: "" }, null]) {
    const fx = loginFixture();
    let finish!: (value: any) => void;
    const login = new CliLogin({ state: fx.service.state, env: fx.env, publish() {}, busy: () => false, refreshPath: async () => {},
      run: async (_bin, args) => {
        if (args[0] === "--version") return { code: 0, stdout: "2.95.0", stderr: "" };
        if (!result) throw new Error("private probe failure");
        return result;
      }, runner: () => ({ writable: () => false, submit() {}, done: new Promise((resolve) => { finish = resolve; }) }) });
    fx.service.state.github.connected = true;
    try {
      const pending = login.start(start("github")), failed = assert.rejects(pending);
      await until(() => Boolean(finish)); finish({ code: 0, stdout: "", stderr: "", cleanupConfirmed: true }); await failed;
      assert.equal(fx.service.state.github.connected, null);
    } finally { await login.drain(); await fx.cleanup(); }
  }
});

test("P6 direct key submission trims outer spaces and newlines before authenticated PUT", async (t) => {
  const fx = await keyFixture(t);
  try {
    const pending = fx.service.cliLogin(begin(), fx.send);
    const settled = pending.catch(() => {});
    await until(() => fx.events.at(-1)?.phase === "waitingKey");
    await assert.doesNotReject(fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: ` \n${KEY}\r\n ` }), fx.send));
    await pending; await settled;
    const writes = fx.requests.filter((r) => r.method === "PUT" && r.authorization);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].body).key === KEY, true, "private boundary must receive the normalized key");
    assert.equal(JSON.stringify([fx.events, fx.snapshots]).includes(KEY), false);
  } finally { await fx.close(); }
});

test("P6 private runner also normalizes keys when called without the page or login controller", async (t) => {
  const fx = await keyFixture(t);
  try {
    const result = await fx.runner({ env: fx.env, signal: new AbortController().signal, timeoutMs: 2000,
      apiKey: ` \n${KEY}\n `, replace: false });
    assert.equal(result.saved, true);
    assert.equal(fx.requests.some((r) => r.authorization && r.method === "PUT" && JSON.parse(r.body).key === KEY), true);
  } finally { await fx.close(); }
});

test("P6 direct invalid keys are refused with plain secret-free messages and no write", async (t) => {
  for (const apiKey of [" \n\r ", "bad\u0000key", "bad\u0085key", "bad\nkey", "x".repeat(4097), "é".repeat(2049)]) {
    const fx = await keyFixture(t);
    try {
      const pending = fx.service.cliLogin(begin(), fx.send), stopped = assert.rejects(pending, /stopped/);
      await until(() => fx.events.at(-1)?.phase === "waitingKey");
      const request = fx.request("submitCliLoginKey", { apiKey });
      await assert.rejects(fx.service.cliLogin(request, fx.send), (error: Error) => {
        assert.equal(error.message, "Enter an OpenCode Go API key.");
        assert.equal(error.message.includes(apiKey), false); return true;
      });
      assert.equal(Object.hasOwn(request, "apiKey"), false);
      assert.equal(fx.requests.length, 0);
      await fx.service.cliLogin({ type: "cancelCliLogin", requestId: "stop-invalid", cli: "opencode", loginRequestId: "key-start" }, fx.send);
      await stopped;
    } finally { await fx.close(); }
  }
});

for (const persisted of [false, true]) test(`P6 repeated failed cleanup retains lock and reload Stop again, persisted=${persisted}`, async (t) => {
  let clean = false, throwCleanup = false;
  const fx = await keyFixture(t, { runKey: async (options: any) => {
    if (persisted) options.onWriteAttempt();
    return { saved: false, persisted, cleanupConfirmed: false, retryCleanup: async () => {
      if (throwCleanup) throw new Error("private cleanup failure"); return clean;
    } };
  } });
  const stop = () => fx.service.cliLogin({ type: "cancelCliLogin", requestId: "stop-again", cli: "opencode", loginRequestId: "key-start" }, fx.send);
  try {
    const pending = fx.service.cliLogin(begin(), fx.send), failed = assert.rejects(pending);
    await until(() => fx.events.at(-1)?.phase === "waitingKey");
    await assert.rejects(fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send)); await failed;
    for (const throws of [false, false, true]) {
      const { ui, sent } = reloadedUi(fx.service.snapshot());
      assert.equal(ui.viewOf("opencode").state, "stuck", "public state must rebuild recovery after reload");
      assert.equal(ui.busy(), true);
      ui.cancel("opencode"); assert.equal(sent[0].loginRequestId, "key-start");
      throwCleanup = throws;
      await assert.rejects(stop(), { message: "Could not confirm sign-in stopped." });
      assert.equal(fx.service.login.busy, true);
      assert.equal(fx.events.at(-1).status, "failed");
      assert.equal(fx.events.at(-1).cleanupPending, true);
      assert.equal(fx.events.at(-1).reason, persisted ? "possiblySaved" : "cleanupUnconfirmed");
      await assert.rejects(fx.service.cliLogin(begin({ requestId: "blocked" }), fx.send), /Another/);
      await assert.rejects(fx.service.installCli("qwen", "blocked-install", true), /blocked/);
    }
    clean = true; throwCleanup = false; await stop();
    assert.equal(fx.service.login.busy, false);
    assert.equal(fx.events.at(-1).cleanupPending, false);
    assert.equal(reloadedUi(fx.service.snapshot()).ui.viewOf("opencode").state, "failed");
    if (persisted) {
      assert.equal(fx.events.at(-1).reason, "possiblySaved");
      assert.match(fx.service.state.catalogTools.opencode.action!.message, /may have been saved/);
      assert.doesNotMatch(fx.service.state.catalogTools.opencode.action!.message, /removed|rolled back|not saved/i);
    }
  } finally { clean = true; throwCleanup = false; await fx.close(); }
});

test("P6 real wizard and Settings show Stop again after reload with possibly saved key", async (t) => {
  const { withPage, skipped, J, click } = await import("./pack18-editor-harness.ts");
  const { showFirstRun, catalogChange, signInPolicy, sentCount, sentSince, stepOf } = await import("./pack29-onboarding-page.setup.ts");
  const { toToolStep } = await import("./pack29-onboarding-page-acp.setup.ts");
  if (skipped(t)) return;
  await withPage(async ({ ev, seed, reload, page }) => {
    const action = { requestId: "retained-key", kind: "login", status: "failed", phase: null, reason: "possiblySaved", cleanupPending: true };
    const facts = () => signInPolicy(["opencode"]) + catalogChange({ opencode: {
      installed: true, supportedVersion: true, version: "1.9.0", signedIn: false, credentialSource: "none", action,
    } });
    const show = () => showFirstRun(ev, seed, { opencode: [true, false] }, facts());
    await show(); if (await stepOf(ev) !== "tools") await toToolStep(ev, "C:\\work\\P6");
    await reload(); await show();
    const scope = '#frunTools [data-cli="opencode"] .cli-login';
    const stop = `${scope} [data-login-act="stop"]`;
    assert.equal(await ev(`document.querySelector(${J(stop)}).checkVisibility()`), true);
    assert.match(await ev(`document.querySelector(${J(scope)}).innerText`), /may have been saved.*Could not confirm sign-in stopped.*Stop again/s);
    const mark = await sentCount(ev); await click(ev, stop);
    assert.equal((await sentSince(ev, "cancelCliLogin", mark))[0].loginRequestId, "retained-key");
    await reload(); await show();
    await ev("(()=>{openSettings(undefined,'tools');return true})()");
    const settings = '#s-tools [data-tool-row][data-cli="opencode"] .cli-login';
    assert.equal(await ev(`document.querySelector(${J(settings + ' [data-login-act="stop"]')}).checkVisibility()`), true);
    const screenshot = await page("Page.captureScreenshot", { format: "png" });
    assert.ok(Buffer.from(screenshot.result.data, "base64").length > 1000, "rough rendered in a real browser");
  });
});

test("P6 controller normalizes before handing the key to an independent runner", async (t) => {
  let received: string | undefined;
  const fx = await keyFixture(t, { runKey: async (options: any) => { received = options.apiKey; return { saved: true, persisted: true, cleanupConfirmed: true }; } });
  try {
    const pending = fx.service.cliLogin(begin(), fx.send);
    await until(() => fx.events.at(-1)?.phase === "waitingKey");
    await fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: ` \n${KEY}\r\n ` }), fx.send);
    await pending;
    assert.equal(received === KEY, true, "runner receives only normalized key");
  } finally { await fx.close(); }
});
