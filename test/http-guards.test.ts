import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { keyedWsUrl } from "./temp-root.ts";
import { pageScripts } from "./source-text.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { HOST, APP_KEY, child, PORT, BASE_ORIGIN, serverStderr, serverStdout, stopChild, waitReady, root, testHome, spawnServer, request, keyedSocket, openWs, nextMessage } from "./http-helpers.ts";

test("two servers spawned at once bind different ports and never collide (guards against a hardcoded test port)", async () => {
  const proc2 = spawnServer();
  try {
    const port2 = await waitReady(proc2);
    assert.notEqual(port2, PORT, "two live servers must never be assigned the same port");
    const res = await request({ path: "/", headers: { Origin: BASE_ORIGIN } });
    assert.equal(res.status, 200, "the first server must still be reachable while a second one is up");
  } finally {
    await stopChild(proc2);
  }
});

test("server readiness timeout kills a silent child", async () => {
  const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
  try {
    await assert.rejects(waitReady(proc, 100), /readiness timed out after 100ms/);
    assert.equal(proc.killed, true, "readiness must request the kill before teardown runs");
  } finally {
    await stopChild(proc);
  }
  assert.ok(proc.exitCode !== null || proc.signalCode !== null);
});

test("server readiness rejects early exit and teardown accepts an already dead child", async () => {
  const proc = spawn(process.execPath, ["-e", "process.exit(3)"], { windowsHide: true });
  try {
    await assert.rejects(waitReady(proc), /server exited before ready: 3/);
    await stopChild(proc);
    await stopChild(proc);
  } finally {
    await stopChild(proc);
  }
});

test("server teardown has a deadline even when a killed child never reports exit", async () => {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, pid: 123, killed: true,
    kill() { throw new Error("must not kill twice"); },
  }) as unknown as ChildProcess;
  await assert.rejects(stopChild(proc, 50), /server teardown timed out \(pid 123\)/);
  assert.equal(proc.listenerCount("exit"), 0);
});

test("GET / with a foreign Origin is rejected (403)", async () => {
  const res = await request({ path: "/", headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});

test("GET / with a loopback Origin is served (200)", async () => {
  const res = await request({ path: "/", headers: { Origin: BASE_ORIGIN } });
  assert.equal(res.status, 200);
  assert.match(res.body, /Command Center/);
});

test("GET / with a foreign Host is rejected (403)", async () => {
  const res = await request({ path: "/", headers: { Host: "evil.example" } });
  assert.equal(res.status, 403);
});

test("POST /api/paste-image with a foreign Origin is rejected (403)", async () => {
  const res = await request({
    method: "POST",
    path: "/api/paste-image",
    headers: { Origin: "https://evil.example", "Content-Type": "image/png", "X-Request-Id": "upload_origin" },
    body: "x",
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).requestId, "upload_origin");
});

test("new upload routes enforce Host and Origin and echo the request id on refusal", async () => {
  const badOrigin = await request({ method: "POST", path: "/api/avatar", headers: {
    Origin: "https://evil.example", "Content-Type": "image/png", "X-Request-Id": "avatar_bad_origin",
  }, body: "x" });
  assert.equal(badOrigin.status, 403);
  assert.deepEqual(JSON.parse(badOrigin.body), { error: "forbidden origin", requestId: "avatar_bad_origin" });

  const badHost = await request({ method: "POST", path: "/api/paste-file", headers: {
    Host: "evil.example", Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "source.txt", "X-Request-Id": "file_bad_host",
  }, body: "x" });
  assert.equal(badHost.status, 403);
  assert.deepEqual(JSON.parse(badHost.body), { error: "forbidden host", requestId: "file_bad_host" });

  const ws = await openWs();
  try {
    const stateP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    const state = await stateP;
    assert.equal(state.settings.uploads.avatar_bad_origin, undefined, "a refused Origin records no status");
    assert.equal(state.settings.uploads.file_bad_host, undefined, "a refused Host records no status");
  } finally { ws.close(); }
});

// The WHATWG URL parser already collapses a literal or bare-%2e-encoded ".."
// segment, so that alone never reaches serveStatic. But it does NOT decode
// an encoded slash (%2f) while segmenting, so "..%2fserver%2findex.ts" (one
// opaque segment, no real "/" inside it) survives untouched as a pathname —
// and only becomes "../server/index.ts" after serveStatic's own
// decodeURIComponent runs, by which point the URL-level normalization has
// already happened. isWithinDir is what catches that at the real call site.
test("a request for a path outside public/ (encoded-slash traversal) is rejected (403)", async () => {
  const res = await request({ path: "/..%2fserver%2findex.ts", headers: { Origin: BASE_ORIGIN } });
  assert.equal(res.status, 403);
});

test("POST /api/paste-image writes only inside the temporary scratch directory", async () => {
  const res = await request({ method: "POST", path: "/api/paste-image",
    headers: { Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "upload_save" }, body: "test png" });
  assert.equal(res.status, 200);
  const saved = JSON.parse(res.body).path;
  assert.equal(JSON.parse(res.body).requestId, "upload_save");
  assert.equal(dirname(saved), join(root, "data", "scratch"));
  assert.equal(readFileSync(saved, "utf8"), "test png");
});

test("paste-image requires a valid request id, has no legacy missing-id route, and refuses malformed ids", async () => {
  const missing = await request({ method: "POST", path: "/api/paste-image", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "image/png",
  }, body: "missing id image" });
  assert.equal(missing.status, 400);
  assert.deepEqual(JSON.parse(missing.body), { error: "a valid X-Request-Id header is required" });

  const malformed = await request({ method: "POST", path: "/api/paste-image", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "../unsafe",
  }, body: "must not be stored" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(JSON.parse(malformed.body), { error: "a valid X-Request-Id header is required" });
});

test("SVG is served as a static preset but every upload path still refuses it", async () => {
  const preset = await request({ path: "/avatars/atlas.svg", headers: { Origin: BASE_ORIGIN } });
  assert.equal(preset.status, 200);
  assert.match(preset.contentType, /^image\/svg\+xml/);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  for (const path of ["/api/avatar", "/api/paste-image"]) {
    const refused = await request({ method: "POST", path, headers: {
      Origin: BASE_ORIGIN, "Content-Type": "image/svg+xml", "X-Request-Id": "svg_upload_1",
    }, body: svg });
    assert.equal(refused.status, 415, `${path} must refuse SVG`);
  }
});

test("WebSocket: a foreign Host with an allowed Origin is rejected (403)", async () => {
  const ws = keyedSocket({
    origin: BASE_ORIGIN, headers: { Host: "evil.example" }, handshakeTimeout: 2000,
  });
  try {
    const status = await new Promise((resolvePromise, reject) => {
      ws.once("open", () => resolvePromise(101));
      ws.once("unexpected-response", (req, res) => {
        res.resume();
        req.destroy();
        resolvePromise(res.statusCode);
      });
      ws.once("error", reject);
    });
    assert.equal(status, 403);
  } finally {
    ws.terminate();
  }
});

// ---- the per-launch app key (CC_APP_KEY): a page without it cannot use the WebSocket or any upload route ----

async function wsOutcome(url: string, options: ConstructorParameters<typeof WebSocket>[1]): Promise<number> {
  const ws = new WebSocket(url, { handshakeTimeout: 3000, ...options });
  try {
    return await new Promise<number>((resolvePromise, reject) => {
      ws.once("open", () => resolvePromise(101));
      ws.once("unexpected-response", (req, res) => { res.resume(); req.destroy(); resolvePromise(res.statusCode ?? 0); });
      ws.once("error", reject);
    });
  } finally { ws.terminate(); }
}

test("WebSocket: the right key opens (control), no key or a wrong key is refused 403 even from a loopback Origin", async () => {
  const base = `ws://${HOST}:${PORT}`;
  const options = { origin: BASE_ORIGIN };
  assert.equal(await wsOutcome(keyedWsUrl(base, APP_KEY), options), 101, "control: the right key connects");
  assert.equal(await wsOutcome(base, options), 403, "no key");
  assert.equal(await wsOutcome(`${base}/?key=`, options), 403, "empty key");
  assert.equal(await wsOutcome(keyedWsUrl(base, "0".repeat(64)), options), 403, "wrong key of the right length");
  assert.equal(await wsOutcome(keyedWsUrl(base, APP_KEY.slice(0, -1)), options), 403, "a key one character short");
  assert.equal(await wsOutcome(keyedWsUrl(base, APP_KEY + "0"), options), 403, "a key one character long");
});

test("WebSocket: the key is checked for a client with no Origin header at all too", async () => {
  assert.equal(await wsOutcome(`ws://${HOST}:${PORT}`, {}), 403);
  assert.equal(await wsOutcome(keyedWsUrl(`ws://${HOST}:${PORT}`, "f".repeat(64)), {}), 403);
});

const UPLOAD_ROUTES: Array<{ path: string; headers: Record<string, string> }> = [
  { path: "/api/paste-image", headers: { "Content-Type": "image/png" } },
  { path: "/api/paste-file", headers: { "Content-Type": "text/plain", "X-File-Name": "source.txt" } },
  { path: "/api/avatar", headers: { "Content-Type": "image/png" } },
];

test("every upload route refuses a missing or wrong X-App-Key (403) and writes nothing; the right key is accepted (control)", async () => {
  const stored = () => [join(root, "data", "scratch"), join(root, "data", "scratch"), join(root, "data", "avatars"), join(root, "data", "avatars")].flatMap((dir) => existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : []);
  for (const route of UPLOAD_ROUTES) {
    const before = stored().length;
    for (const [label, appKey] of [["no key", null], ["wrong key", "0".repeat(64)], ["empty key", ""]] as const) {
      const res = await request({ method: "POST", path: route.path, appKey, headers: { Origin: BASE_ORIGIN, "X-Request-Id": `key_${label.replace(" ", "_")}`, ...route.headers }, body: "keyed" });
      assert.equal(res.status, 403, `${route.path} with ${label}: ${res.body}`);
    }
    assert.equal(stored().length, before, `${route.path}: a refused upload stores nothing`);
    const ok = await request({ method: "POST", path: route.path, headers: { Origin: BASE_ORIGIN, "X-Request-Id": "key_control", ...route.headers }, body: "keyed" });
    assert.equal(ok.status, 200, `${route.path} with the right key: ${ok.body}`);
  }
});

test("any other non-GET request needs the key too, while the static page still loads without it", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await request({ method, path: "/api/something-else", appKey: null, headers: { Origin: BASE_ORIGIN } });
    assert.equal(res.status, 403, `${method} without a key`);
  }
  const page = await request({ path: "/", appKey: null, headers: { Origin: BASE_ORIGIN } });
  assert.equal(page.status, 200, "the page has to load without a key so it can read one");
});

test("the server never prints, logs or serves the app key it was given", async () => {
  assert.equal(serverStdout.includes(APP_KEY), false, "stdout");
  assert.equal(serverStderr.includes(APP_KEY), false, "stderr");
  const scriptPaths = pageScripts().map((script) => script.slice("public".length));
  assert.ok(scriptPaths.some((script) => /^\/app[./]/.test(script)), `the page scripts hold the app script: ${scriptPaths}`);
  for (const path of ["/", ...scriptPaths, "/index.html"]) assert.equal((await request({ path, headers: { Origin: BASE_ORIGIN } })).body.includes(APP_KEY), false, path);
});

test("bare start (no CC_APP_KEY): the server makes its own key and prints one Open line with it, and that key works", async () => {
  const env = { ...process.env, HOME: testHome, USERPROFILE: testHome, CC_TEST_FAKE_CLI: "1", CC_DATA_DIR: join(root, "data-bare"), CC_TEST_FORCE_PACKAGED: "1", CC_PORT: "0", CC_SKIP_LEADER_CHECK: "1", CC_SKIP_DISCOVERY: "1" } as NodeJS.ProcessEnv;
  delete env.CC_APP_KEY;
  const proc = spawn(process.execPath, [join(root, "server", "index.ts")], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
  attachCrashCatcher(proc.pid, "http-bare");
  let out = "";
  proc.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  try {
    const port = await waitReady(proc);
    for (const end = Date.now() + 3000; !/^Open /m.test(out) && Date.now() < end;) await new Promise((ok) => setTimeout(ok, 20));
    const opens = out.split(/\r?\n/).filter((line) => line.startsWith("Open "));
    assert.equal(opens.length, 1, `exactly one Open line: ${JSON.stringify(out)}`);
    const match = opens[0].match(/^Open http:\/\/127\.0\.0\.1:(\d+)\/#key=([0-9a-f]{64})$/);
    assert.ok(match, `the line has the form Open http://127.0.0.1:<port>/#key=<64 hex>: ${opens[0]}`);
    assert.equal(Number(match[1]), port);
    const origin = `http://${HOST}:${port}`;
    assert.equal(await wsOutcome(keyedWsUrl(`ws://${HOST}:${port}`, match[2]), { origin }), 101, "the printed key connects");
    assert.equal(await wsOutcome(keyedWsUrl(`ws://${HOST}:${port}`, "0".repeat(64)), { origin }), 403);
  } finally { await stopChild(proc); }
});
