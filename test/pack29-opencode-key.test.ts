import test from "node:test";
import assert from "node:assert/strict";
import { validateLoginRequest } from "../server/settings/cli-login.ts";
import { validApiKey } from "../server/settings/opencode/key.ts";
import { keyFixture, begin, KEY, until } from "./pack29-opencode-key.setup.ts";

test("key panel takes admission synchronously, waits without spawn, supports private reload and fixed opener", async (t) => {
  const opened: any[] = [], fx = await keyFixture(t, { open: async (...args: any[]) => { opened.push(args); return true; } });
  try {
    const pending = fx.service.cliLogin(begin(), fx.send), stopped = assert.rejects(pending, /stopped/);
    assert.equal(fx.service.login.busy, true);
    await assert.rejects(fx.service.cliLogin(begin({ requestId: "second" }), fx.send), /Another/);
    await assert.rejects(fx.service.installCli("qwen", "install-key", true), /blocked/);
    await until(() => fx.events.at(-1)?.phase === "waitingKey");
    assert.equal(fx.spawns.length, 0);
    assert.equal(fx.probes.length, 0, "opening the panel performs no vendor probes");
    assert.equal(fx.requests.length, 0);
    const reload: any[] = [];
    await fx.service.cliLogin(fx.request("getCliLoginState"), (e) => reload.push(e));
    assert.equal(reload[0].phase, "waitingKey");
    await fx.service.cliLogin(fx.request("openCliLogin"), fx.send);
    assert.deepEqual(opened, [["opencode", "https://opencode.ai/auth"]]);
    await fx.service.cliLogin({ type: "cancelCliLogin", requestId: "cancel-key", cli: "opencode", loginRequestId: "key-start" }, fx.send);
    await stopped; assert.equal(fx.service.login.busy, false);
    await assert.rejects(fx.service.cliLogin(fx.request("getCliLoginState"), fx.send), /already running/);
  } finally { await fx.close(); }
});

test("exact key contracts reject missing, extra, wrong-tool, invalid IDs and unconfirmed replacement", async () => {
  const capability = "a".repeat(48);
  const shapes = [begin(), begin({ type: "replaceCliLogin", confirm: true }),
    { type: "submitCliLoginKey", requestId: "submit", cli: "opencode", loginId: capability, apiKey: KEY },
    { type: "openCliLogin", requestId: "open", cli: "opencode", loginId: capability },
    { type: "getCliLoginState", requestId: "read", cli: "opencode", loginId: capability },
    { type: "cancelCliLogin", requestId: "cancel", cli: "opencode", loginRequestId: "key-start" }];
  for (const shape of shapes) {
    validateLoginRequest(shape);
    for (const field of Object.keys(shape)) {
      const missing = { ...shape }; delete missing[field];
      assert.throws(() => validateLoginRequest(missing), /Invalid|already running/, "missing " + field);
    }
    for (const extra of [{ url: "https://evil.invalid" }, { revision: 0 }, { command: "evil" }, { env: {} }])
      assert.throws(() => validateLoginRequest({ ...shape, ...extra }), /Invalid/);
  }
  for (const type of ["replaceCliLogin", "submitCliLoginKey"]) {
    const shape = shapes.find((s) => s.type === type)!;
    assert.throws(() => validateLoginRequest({ ...shape, cli: "codex" }), /Invalid/);
  }
  assert.throws(() => validateLoginRequest(begin({ type: "replaceCliLogin", confirm: false })), /Invalid/);
  for (const invalid of ["", " ", "x\n", "x\0", "x".repeat(4097), "α".repeat(2049), null]) assert.equal(validApiKey(invalid), false);
  assert.equal(validApiKey("any-vendor-prefix-is-allowed"), true);
  assert.equal(validApiKey("α".repeat(2048)), true);
});

test("one submitted key follows authenticated sequence and cannot leak through state or vendor echoes", async (t) => {
  const leaks: string[] = [];
  let publications = 0;
  const inspect = (state: unknown) => {
    publications++;
    const serialized = JSON.stringify(state);
    if ([KEY, JSON.stringify(KEY).slice(1, -1)].some((secret) => serialized.includes(secret)) || /"apiKey"\s*:/.test(serialized)) leaks.push(serialized);
  };
  const fx = await keyFixture(t, { onPublish: inspect });
  try {
    const pending = fx.service.cliLogin(begin(), fx.send);
    await until(() => fx.events.at(-1)?.phase === "waitingKey");
    const message = fx.request("submitCliLoginKey", { apiKey: KEY });
    const submission = fx.service.cliLogin(message, fx.send);
    assert.equal(Object.hasOwn(message, "apiKey"), false, "parsed request relinquishes key synchronously");
    await assert.rejects(fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send), /Wait|not waiting/);
    await submission; await pending;
    inspect(fx.service.snapshot());
    assert.ok(publications > 3, "whole-state snapshots were inspected at each publication");
    assert.deepEqual(leaks, [], "every published whole state conceals the key and any apiKey property");
    assert.deepEqual(fx.requests.map((r) => [r.method, r.url]), [
      ["GET", "/global/health"], ["PUT", "/auth/opencode-go"], ["PUT", "/auth/opencode-go"], ["GET", "/provider"], ["POST", "/instance/dispose"]]);
    assert.equal(fx.requests[1].authorization, undefined);
    assert.deepEqual(JSON.parse(fx.requests[1].body), {});
    assert.deepEqual(JSON.parse(fx.requests[2].body), { type: "api", key: KEY });
    for (const i of [0, 2, 3, 4]) assert.equal(fx.requests[i].authorization, fx.requests[0].authorization);
    assert.match(fx.requests[0].authorization, /^Basic /);
    const call = fx.spawns[0];
    assert.deepEqual(call.argv, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    assert.equal(call.settings.shell, false); assert.equal(call.settings.windowsHide, true);
    assert.equal(call.settings.env.OPENCODE_SERVER_USERNAME, "opencode");
    assert.equal(call.settings.env.OPENCODE_DISABLE_AUTOUPDATE, "1");
    assert.equal(call.settings.env.OPENAI_API_KEY, undefined);
    assert.equal(call.settings.env.CC_APP_KEY, undefined);
    assert.equal(call.settings.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(fx.events.at(-1).status, "done"); assert.equal(fx.events.at(-1).loginId, null);
    assert.equal(fx.service.state.tools.opencode.action?.message, "Key saved. OpenCode will check it when you first chat.");
    assert.ok(fx.sweeps() > 0, "owned tree sweep FOUND");
    assert.equal(fx.proc().exitCode, 0);
    for (const secret of fx.secretValues()) {
      assert.equal(JSON.stringify([fx.events, fx.snapshots, call.argv]).includes(secret), false, "private outputs conceal synthetic secret");
    }
    for (const value of Object.values(call.settings.env)) assert.notEqual(value, KEY, "no key in child environment");
    for (const value of fx.probes) assert.equal(value.settings.env?.OPENCODE_DISABLE_AUTOUPDATE, "1");
    assert.equal(fx.authReads(), 3, "submitted protection, runner protection, pre-PUT recheck");
  } finally { await fx.close(); }
});

for (const [label, options, reason] of [
  ["stored", { auth: "1 credentials" }, /already saved/],
  ["unknown", { auth: "unrecognized" }, /check saved/],
  ["environment only", { auth: "0 credentials\nEnvironment\nOpenCode" }, /outside Command Center/],
  ["environment override with stored", { auth: "1 credentials", env: { OPENCODE_API_KEY: "synthetic-environment" } }, /outside Command Center/],
  ["auth content override", { env: { OPENCODE_AUTH_CONTENT: "{}" } }, /outside Command Center/],
  ["major two", { version: "2.3.0" }, /OpenCode 1/],
  ["unknown version", { version: "unrecognized" }, /OpenCode 1/],
] as const) {
  test("panel refuses " + label + " before credential writes", async (t) => {
    const fx = await keyFixture(t, options);
    try {
      await assert.rejects(fx.service.cliLogin(begin(), fx.send), reason);
      assert.equal(fx.spawns.length, 0); assert.equal(fx.requests.length, 0);
      if (label.includes("version") || label === "major two") assert.equal(fx.authReads(), 0);
      if (label === "environment only") assert.equal(fx.service.state.tools.opencode.signedIn, false);
    } finally { await fx.close(); }
  });
}

test("explicit replacement saves, but a credential appearing after the panel blocks an ordinary save", async (t) => {
  for (const replace of [false, true]) {
    const fx = await keyFixture(t, { authAt: (read: number) => replace || read >= 3 ? "1 credentials" : "0 credentials" });
    try {
      const pending = fx.service.cliLogin(begin(replace ? { type: "replaceCliLogin", confirm: true } : {}), fx.send);
      const caught = replace ? pending : assert.rejects(pending, /already saved/);
      await until(() => fx.events.at(-1)?.phase === "waitingKey");
      const submission = fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send);
      if (replace) await submission; else await assert.rejects(submission, /already saved/);
      await caught;
      assert.equal(fx.requests.filter((r) => r.body && JSON.parse(r.body)?.key === KEY).length, replace ? 1 : 0);
      assert.equal(fx.requests.filter((r) => r.method === "PUT" && r.authorization).length, replace ? 1 : 0);
    } finally { await fx.close(); }
  }
});

test("key attempt spacing and ceiling setters and phase consumption reject repeat submits", async (t) => {
  const fx = await keyFixture(t);
  const realNow = Date.now; let time = realNow();
  try {
    const pending = fx.service.cliLogin(begin(), fx.send), stopped = assert.rejects(pending, /stopped/);
    await until(() => fx.events.at(-1)?.phase === "waitingKey");
    const clock = t.mock.method(Date, "now", () => time);
    for (let i = 0; i < 5; i++) {
      if (i) time += 2001;
      await assert.rejects(fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: "" }), fx.send), /Enter/);
      await assert.rejects(fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send), /Wait/);
    }
    time += 2001;
    await assert.rejects(fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send), /Wait/);
    clock.mock.restore();
    await fx.service.cliLogin({ type: "cancelCliLogin", requestId: "cancel-key", cli: "opencode", loginRequestId: "key-start" }, fx.send);
    await stopped; assert.equal(fx.spawns.length, 0);
  } finally { await fx.close(); }
});

test("credentials and version are checked again at submission before a server can start", async (t) => {
  for (const changed of ["version", "environment", "stored"]) {
    const options: any = {}, fx = await keyFixture(t, options);
    try {
      const pending = fx.service.cliLogin(begin(), fx.send), failed = assert.rejects(pending, /OpenCode 1|outside Command Center|already saved/);
      await until(() => fx.events.at(-1)?.phase === "waitingKey");
      if (changed === "version") options.version = "2.3.0";
      if (changed === "environment") fx.env.OPENCODE_API_KEY = "synthetic-external-key";
      if (changed === "stored") options.auth = "1 credentials";
      await assert.rejects(fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send));
      await failed;
      assert.equal(fx.spawns.length, 0); assert.equal(fx.requests.length, 0);
    } finally { await fx.close(); }
  }
});
test("environment source is explicit even when hidden probes have no inherited provider key", async (t) => {
  const fx = await keyFixture(t, { env: { OPENCODE_API_KEY: "synthetic-env-only" } });
  try {
    await assert.rejects(fx.service.cliLogin(begin(), fx.send), /outside Command Center/);
    assert.equal(fx.service.state.tools.opencode.credentialSource, "environment");
    assert.equal(fx.service.state.tools.opencode.signedIn, false);
    assert.equal(JSON.stringify(fx.snapshots).includes("synthetic-env-only"), false);
  } finally { await fx.close(); }
});
