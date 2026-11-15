import test from "node:test";
import assert from "node:assert/strict";
import { keyFixture, begin, KEY, until } from "./pack29-opencode-key.setup.ts";
import { startKeyServer } from "../server/settings/opencode/key-server.ts";

test("write attempt is marked before dispatch, never by the unauthenticated probe, and survives a lost response", async (t) => {
  let notified = 0;
  const fx = await keyFixture(t, { onRequest: (req: any, body: string, res: any) => {
    if (req.method !== "PUT") return;
    if (!req.headers.authorization) assert.equal(notified, 0, "401 probe cannot mark persistence");
    else { assert.equal(notified, 1, "notification precedes complete authenticated PUT"); assert.equal(JSON.parse(body).key, KEY); res.destroy(); }
  } });
  try {
    const result = await fx.runner({ env: fx.env, signal: new AbortController().signal, timeoutMs: 2000, apiKey: KEY, replace: false, onWriteAttempt: () => { notified++; } });
    assert.equal(notified, 1); assert.equal(result.persisted, true); assert.equal(result.saved, false); assert.equal(result.cleanupConfirmed, true);
    assert.equal(fx.requests.filter((r) => r.method === "PUT" && r.authorization).length, 1);
  } finally { await fx.close(); }
});

for (const mode of ["cancel", "deadline", "close", "disconnect"] as const) {
  test(`unacknowledged complete PUT reports possiblySaved immediately on ${mode}`, async (t) => {
    let received = false, release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    // Deadline mode: the key runner's own timer is held open so only the login deadline timer can end the run (no same-millisecond race).
    let fxRef: any;
    const fx = await keyFixture(t, { timeoutMs: mode === "deadline" ? 500 : 5000,
      runKey: mode === "deadline" ? (o: any) => fxRef.runner({ ...o, timeoutMs: 60_000 }) : undefined,
      onRequest: async (req: any, body: string, res: any) => {
        if (req.method === "PUT" && req.headers.authorization) {
          assert.equal(JSON.parse(body).key, KEY); received = true;
          if (mode === "disconnect") res.destroy(); else await held;
        }
      } });
    fxRef = fx;
    try {
      const pending = fx.service.cliLogin(begin(), fx.send), rejected = assert.rejects(pending, /may have been saved/);
      await until(() => fx.events.at(-1)?.phase === "waitingKey");
      const submit = fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send), failed = assert.rejects(submit, /may have been saved/);
      await until(() => received, "complete authenticated PUT received");
      if (mode === "cancel") {
        const stop = fx.service.cliLogin({ type: "cancelCliLogin", requestId: "cancel-inflight", cli: "opencode", loginRequestId: "key-start" }, fx.send);
        assert.equal(fx.events.at(-1).reason, "possiblySaved", "Cancel warns before cleanup resolves"); await stop;
      } else if (mode === "close") {
        fx.service.login.close(); assert.equal(fx.events.at(-1).reason, "possiblySaved", "close warns synchronously");
      } else if (mode === "deadline") {
        await until(() => fx.events.some((e) => e.phase === null), "deadline warning");
        assert.equal(fx.events.find((e) => e.phase === null).reason, "possiblySaved");
      }
      await rejected; await failed;
      if (mode === "deadline") {
        const reasons = [...new Set(fx.events.filter((e) => e.phase === null).map((e) => e.reason))];
        assert.deepEqual(reasons, ["possiblySaved"], "every phase-null event after the deadline warns possiblySaved, never timeout");
      }
      assert.equal(fx.events.at(-1).reason, "possiblySaved"); assert.equal(fx.service.login.busy, false); assert.equal(fx.proc().exitCode, 0);
    } finally { release(); await fx.close(); }
  });
}

test("key server rejects redirected, foreign-origin, wrong-route and 3xx response identities", async (t) => {
  for (const mode of ["redirected", "origin", "route", "status"]) {
    const fx = await keyFixture(t, { response: (response: Response, url: string) => {
      if (!url.endsWith("/global/health")) return response;
      Object.defineProperty(response, mode === "status" ? "status" : mode === "redirected" ? "redirected" : "url", {
        value: mode === "status" ? 302 : mode === "redirected" ? true : mode === "origin" ? "https://forbidden.invalid/global/health" : url + "/other",
      });
      return response;
    } });
    try {
      const outcome = await fx.runner({ env: fx.env, signal: new AbortController().signal, timeoutMs: 2000, apiKey: KEY, replace: false });
      assert.equal(outcome.saved, false, `${mode}: unsafe response identity cannot save a key`);
      assert.equal(outcome.persisted, false);
      assert.equal(outcome.cleanupConfirmed, true);
      assert.deepEqual(fx.requests.map((request) => [request.method, request.url]), [["GET", "/global/health"]]);
      assert.equal(fx.requests.some((request) => request.body.includes(KEY)), false);
      assert.equal(fx.proc().exitCode, 0);
    } finally { await fx.close(); }
  }
});

for (const [label, options, persisted] of [
  ["major two health", { healthVersion: "2.3.0" }, false],
  ["unknown health", { healthVersion: "unrecognized" }, false],
  ["unhealthy", { healthy: false }, false],
  ["missing authentication protection", { noProtection: true }, false],
  ["health redirect", { redirect: "/global/health" }, false],
  ["PUT redirect", { redirect: "/auth/opencode-go" }, true],
  ["non-true PUT", { put: false }, true],
  ["missing connected provider", { connected: [] }, true],
  ["dispose failure", { dispose: false }, true],
] as const) {
  test(label + " fails closed and confirms cleanup", async (t) => {
    const fx = await keyFixture(t, options);
    try {
      const pending = fx.service.cliLogin(begin(), fx.send), failed = assert.rejects(pending, persisted ? /may have been saved/ : /OpenCode 1|save the key/);
      await until(() => fx.events.at(-1)?.phase === "waitingKey");
      await assert.rejects(fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send));
      await failed;
      assert.equal(fx.events.at(-1).status, "failed"); assert.equal(fx.service.login.busy, false);
      assert.equal(fx.proc().exitCode, 0); assert.ok(fx.sweeps() > 0);
      if (!persisted) assert.equal(fx.requests.filter((r) => r.method === "PUT" && r.authorization).length, label === "PUT redirect" ? 1 : 0);
      if (label === "missing connected provider") assert.equal(fx.requests.at(-1).url, "/provider");
    } finally { await fx.close(); }
  });
}

test("success waits for owned-tree confirmation and retains the cleanup lock until Stop confirms", async (t) => {
  const options = { holdSweep: true, clean: false }, fx = await keyFixture(t, options);
  try {
    const pending = fx.service.cliLogin(begin(), fx.send), failed = assert.rejects(pending, /may have been saved/);
    await until(() => fx.events.at(-1)?.phase === "waitingKey");
    const submitted = fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send), rejected = assert.rejects(submitted, /may have been saved/);
    await until(() => fx.sweeps() > 0);
    assert.equal(fx.service.login.busy, true); assert.equal(fx.events.at(-1).status, "running");
    fx.releaseSweep(); await failed; await rejected;
    assert.equal(fx.service.login.busy, true); assert.equal(fx.events.at(-1).reason, "possiblySaved");
    assert.equal(await fx.service.login.drain(), false);
    assert.equal(fx.events.at(-1).reason, "possiblySaved");
    fx.setClean(true);
    await fx.service.cliLogin({ type: "cancelCliLogin", requestId: "stop-again", cli: "opencode", loginRequestId: "key-start" }, fx.send);
    assert.equal(fx.service.login.busy, false); assert.equal(fx.proc().exitCode, 0);
  } finally { await fx.close(); }
});

test("cancellation after acknowledged PUT reports possible persistence and shutdown waits for cleanup", async (t) => {
  let entered = false, release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const fx = await keyFixture(t, { onRequest: async (req: any) => { if (req.url === "/provider") { entered = true; await held; } } });
  try {
    const pending = fx.service.cliLogin(begin(), fx.send), failed = assert.rejects(pending, /may have been saved/);
    await until(() => fx.events.at(-1)?.phase === "waitingKey");
    const submitted = fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send), rejected = assert.rejects(submitted, /may have been saved/);
    await until(() => entered);
    fx.service.login.close();
    await assert.rejects(fx.service.cliLogin(begin({ requestId: "after-close" }), fx.send), /Another/);
    assert.equal(await fx.service.login.drain(), true);
    release(); await failed; await rejected;
    assert.equal(fx.events.at(-1).reason, "possiblySaved");
    assert.equal(fx.proc().exitCode, 0);
  } finally { release(); await fx.close(); }
});

test("startup announcement is exact loopback, bounded and deadline/cancellation stops the fake tree", async (t) => {
  for (const announcement of ["listening on http://0.0.0.0:1234\n", "listening on http://127.0.0.1:99999\n", "x".repeat(8193), "listening on http://127.0.0.1:12/evil\n"]) {
    const fx = await keyFixture(t, { announcement });
    const abort = new AbortController();
    try {
      const result = fx.runner({ env: fx.env, signal: abort.signal, timeoutMs: 50, apiKey: KEY, replace: false });
      const outcome = await result;
      assert.equal(outcome.saved, false); assert.equal(outcome.cleanupConfirmed, true);
      assert.equal(fx.requests.length, 0); assert.equal(fx.proc().exitCode, 0);
    } finally { await fx.close(); }
  }
});

test("fresh server password on each launch and chunked startup announcement", async (t) => {
  const options: any = {}, fx = await keyFixture(t, options);
  try {
    options.outputChunks = ["opencode server list", "ening on " + fx.origin + "\n"];
    for (let i = 0; i < 2; i++) {
      const result = await fx.runner({ env: fx.env, signal: new AbortController().signal, timeoutMs: 2000, apiKey: KEY, replace: false });
      assert.equal(result.saved, true); assert.equal(result.cleanupConfirmed, true);
    }
    assert.equal(fx.spawns.length, 2);
    const passwords = fx.spawns.map((s) => s.settings.env.OPENCODE_SERVER_PASSWORD);
    assert.match(passwords[0], /^[a-f0-9]{48}$/);
    assert.notEqual(passwords[0], passwords[1]);
  } finally { await fx.close(); }
});

test("split key echoes on stdout and stderr are discarded after startup", async (t) => {
  const fx = await keyFixture(t, { holdSweep: true });
  try {
    const pending = fx.service.cliLogin(begin(), fx.send);
    await until(() => fx.events.at(-1)?.phase === "waitingKey");
    const submitted = fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send);
    await until(() => fx.sweeps() > 0);
    for (const secret of fx.secretValues()) {
      fx.proc().stdout.write(secret.slice(0, 3)); fx.proc().stdout.write(secret.slice(3));
      fx.proc().stderr.write(secret);
    }
    fx.releaseSweep(); await submitted; await pending;
    const visible = JSON.stringify([fx.events, fx.snapshots]);
    for (const secret of fx.secretValues()) assert.equal(visible.includes(secret), false);
  } finally { await fx.close(); }
});
