// Item E: the origin/host/containment helpers in security.ts are unit-tested,
// but their only real callers (server/index.ts's HTTP handler, serveStatic,
// and the WebSocketServer's verifyClient) were not exercised at all. This
// file starts a real instance of the server as a child process on a
// dedicated port and drives it exactly like a real client would, so a
// mutation at any of those call sites (not just the helper) turns it red.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { readdirSync, readFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, cpSync, existsSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import http from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { WebSocket } from "ws";
import { newAppKey, keyedWsUrl } from "./temp-root.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

const HOST = "127.0.0.1";
// Every server this file spawns gets this as CC_APP_KEY; request() and keyedSocket() send it.
const APP_KEY = newAppKey();

// Reads the server's ready line the same way electron/main.js does, by
// extracting and running its real parseServerPort function rather than a
// second hand-rolled regex that could drift from it (see test/electron.test.ts
// for the same technique). electron/main.js imports the `electron` package at
// module scope, which cannot load outside an actual Electron process, so the
// function body is lifted out and evaluated on its own instead of imported.
const parseServerPort: (text: string) => number | null = (() => {
  const source = readFileSync("electron/main.js", "utf8");
  const match = source.match(/(?:export )?function parseServerPort\([^]*?^}/m);
  assert.ok(match, "parseServerPort must exist in electron/main.js");
  return runInNewContext(`${match[0].replace("export function", "function")};parseServerPort;`);
})();

let child: ChildProcess;
let PORT: number;
let BASE_ORIGIN: string;
let serverStderr = "";
let serverStdout = "";

async function stopChild(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const exited = once(proc, "exit", { signal: controller.signal });
    if (!proc.killed) proc.kill();
    await exited;
  } catch (err) {
    throw new Error(`server teardown timed out (pid ${proc.pid})`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

function waitReady(proc: ChildProcess, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const finish = (result: number | Error) => {
      clearTimeout(timer);
      proc.off("error", onError);
      proc.off("exit", onExit);
      proc.stdout?.off("data", onData);
      if (result instanceof Error) reject(result);
      else resolvePromise(result);
    };
    const onError = (err: Error) => finish(err);
    const onExit = (code: number | null) => finish(new Error(`server exited before ready: ${code}`));
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const port = parseServerPort(output);
      if (port !== null) finish(port);
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish(new Error(`server readiness timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once("error", onError);
    proc.once("exit", onExit);
    proc.stdout?.on("data", onData);
    if (proc.exitCode !== null || proc.signalCode !== null) onExit(proc.exitCode);
  });
}

// A directory junction is removed as a link (never recursively), so a recursive delete can never reach through it into the real folder it points at.
function removeTree(target: string): void {
  let isLink = false;
  try { isLink = lstatSync(target).isSymbolicLink(); } catch { return; }
  rmSync(target, isLink ? { force: true } : { recursive: true, force: true });
}
const root = mkdtempSync(join(tmpdir(), "cc-http-test-"));
let dependencyRoot = process.cwd();
after(async () => {
  try { if (child) await stopChild(child); }
  finally {
    removeTree(join(root, "node_modules"));
    try { assert.ok(existsSync(join(dependencyRoot, "node_modules")), "the real node_modules survived the teardown"); }
    finally { removeWithRetry(root); }
  }
});
// The live config files (workspaces, client preferences, launch safety) are never copied: the server seeds its own from the bundled defaults.
const LIVE_CONFIG_FILES = new Set(["workspaces.json", "client-prefs.json", "launch-safety.json"]);
for (const name of ["server", "config", "public", "package.json"]) cpSync(join(process.cwd(), name), join(root, name), { recursive: true, filter: (src) => !LIVE_CONFIG_FILES.has(src.replaceAll("\\", "/").split("/").pop()!) });
dependencyRoot = process.cwd();
while (!existsSync(join(dependencyRoot, "node_modules"))) {
  const parent = dirname(dependencyRoot);
  if (parent === dependencyRoot) throw new Error("could not locate node_modules for the HTTP test server");
  dependencyRoot = parent;
}
symlinkSync(join(dependencyRoot, "node_modules"), join(root, "node_modules"), "junction");
const testHome = join(root, "test-home");
mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.CC_TEST_FAKE_CLI = "1";

// CC_PORT=0 asks the OS to assign a free port. A fixed literal here used to
// mean a mutated run's leaked listener (see guard-server-shutdown-http in
// scripts/mutation-proof.mjs) was still holding that exact port when the next
// run started, failing it for a reason that had nothing to do with its own
// code. The server runs from an OS-temp folder (cc-http-test-*), so a process
// a broken shutdown leaves behind is found by that path in its command line,
// not by the sweep's own folder name.
function spawnServer(): ChildProcess {
  const proc = spawn(process.execPath, [join(root, "server", "index.ts")], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, HOME: testHome, USERPROFILE: testHome, CC_TEST_FAKE_CLI: "1", CC_DATA_DIR: join(root, "data"), CC_TEST_FORCE_PACKAGED: "1", CC_PORT: "0", CC_APP_KEY: APP_KEY, CC_SKIP_LEADER_CHECK: "1", CC_SKIP_DISCOVERY: "1" },
  });
  attachCrashCatcher(proc.pid, "http");
  proc.stdout?.on("data", (chunk: Buffer) => { serverStdout += chunk.toString(); });
  proc.stderr?.on("data", (chunk: Buffer) => { serverStderr += chunk.toString(); process.stderr.write(chunk); });
  return proc;
}

before(async () => {
  child = spawnServer();
  PORT = await waitReady(child);
  BASE_ORIGIN = `http://${HOST}:${PORT}`;
});

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

// appKey: the X-App-Key header every call sends by default; a string overrides it, null sends none.
function request(options: http.RequestOptions & { body?: string | Buffer; deadlineMs?: number; appKey?: string | null }): Promise<{ status: number; body: string; contentType: string }> {
  const { body, deadlineMs = 5000, appKey = APP_KEY, ...requestOptions } = options;
  if (appKey !== null) requestOptions.headers = { "X-App-Key": appKey, ...requestOptions.headers };
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: { status: number; body: string; contentType: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(result!);
    };
    const req = http.request({ host: HOST, port: PORT, ...requestOptions }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", (error) => finish(error));
      res.on("aborted", () => finish(new Error("HTTP response aborted")));
      res.on("end", () => finish(undefined, { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), contentType: String(res.headers["content-type"] ?? "") }));
    });
    timer = setTimeout(() => req.destroy(new Error("HTTP request timed out after " + deadlineMs + "ms")), deadlineMs);
    req.on("error", (error) => finish(error));
    if (body) req.write(body);
    req.end();
  });
}

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

test("WebSocket: a foreign Origin is rejected", async () => {
  const ws = keyedSocket({ origin: "https://evil.example" });
  const outcome = await new Promise((resolvePromise) => {
    ws.once("open", () => resolvePromise("open"));
    ws.once("unexpected-response", () => resolvePromise("rejected"));
    ws.once("error", () => resolvePromise("rejected"));
  });
  assert.equal(outcome, "rejected");
});

test("WebSocket: no Origin header (non-browser client) is accepted", async () => {
  const ws = keyedSocket();
  const outcome = await new Promise((resolvePromise, reject) => {
    ws.once("open", () => resolvePromise("open"));
    ws.once("error", reject);
  });
  assert.equal(outcome, "open");
  ws.close();
});

test("WebSocket: a loopback Origin is accepted", async () => {
  const ws = keyedSocket({ origin: BASE_ORIGIN });
  const outcome = await new Promise((resolvePromise, reject) => {
    ws.once("open", () => resolvePromise("open"));
    ws.once("error", reject);
  });
  assert.equal(outcome, "open");
  ws.close();
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

test("POST /api/avatar stores an image under avatars, GET serves it, and updateSeat accepts its generated route", async () => {
  const image = Buffer.from("isolated avatar bytes");
  const missingId = await request({ method: "POST", path: "/api/avatar", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "image/png",
  }, body: image });
  assert.equal(missingId.status, 400);
  assert.deepEqual(JSON.parse(missingId.body), { error: "a valid X-Request-Id header is required" });

  const uploaded = await request({ method: "POST", path: "/api/avatar", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "image/webp", "X-Request-Id": "avatar_upload_1",
  }, body: image });
  assert.equal(uploaded.status, 200);
  const result = JSON.parse(uploaded.body);
  assert.equal(result.requestId, "avatar_upload_1");
  assert.match(result.path, /^\/api\/avatar\/avatar-[0-9a-f-]{36}\.webp$/i);
  const filename = result.path.slice("/api/avatar/".length);
  const saved = join(root, "data", "avatars", filename);
  assert.equal(readFileSync(saved).toString(), image.toString());

  const served = await request({ path: result.path, headers: { Origin: BASE_ORIGIN } });
  assert.equal(served.status, 200);
  assert.equal(served.body, image.toString());
  const traversal = await request({ path: "/api/avatar/..%2fserver%2findex.ts", headers: { Origin: BASE_ORIGIN } });
  assert.equal(traversal.status, 403);
  writeFileSync(join(root, "outside.png"), "outside avatar target");
  const imageTraversal = await request({ path: "/api/avatar/..%2foutside.png", headers: { Origin: BASE_ORIGIN } });
  assert.equal(imageTraversal.status, 403, "an allowed image extension outside avatars is still refused");
  const oversized = await request({ method: "POST", path: "/api/avatar", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "avatar_too_large",
  }, body: Buffer.alloc(12 * 1024 * 1024 + 1, 0x78), deadlineMs: 15_000 });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).requestId, "avatar_too_large");

  const ws = await openWs();
  try {
    const initial = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: "hello" }));
    const [state] = await initial;
    assert.equal(state.settings.uploads.avatar_upload_1.status, "done");
    const tab = state.projects[0].tabs[0];
    const leader = tab.crew.find((seat: any) => seat.isLeader);
    const update = nextMessage(ws);
    ws.send(JSON.stringify({ type: "updateSeat", tabId: tab.id, slot: leader.slot, pic: result.path }));
    const changed = await update;
    assert.equal(changed.type, "state");
    assert.equal(changed.projects[0].tabs[0].crew.find((seat: any) => seat.slot === leader.slot).pic, result.path);

    const refused = nextMessage(ws);
    ws.send(JSON.stringify({ type: "updateSeat", tabId: tab.id, slot: leader.slot, pic: "avatar.png" }));
    const invalid = await refused;
    assert.equal(invalid.type, "error");
    assert.match(invalid.message, /invalid seat pic/);
  } finally { ws.close(); }
});

test("a vendored .woff2 font is served as font/woff2", async () => {
  const font = await request({ path: "/fonts/geist-latin-400-normal.woff2", headers: { Origin: BASE_ORIGIN } });
  assert.equal(font.status, 200);
  assert.match(font.contentType, /^font\/woff2/);
});

test("a new avatar upload deletes uploaded pictures no seat uses and keeps the new one", async () => {
  const upload = async (id: string) => JSON.parse((await request({ method: "POST", path: "/api/avatar", headers: { Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": id }, body: Buffer.from(id) })).body).path.slice("/api/avatar/".length);
  const first = await upload("avatar_prune_1");
  assert.ok(existsSync(join(root, "data", "avatars", first)), "control: the first upload landed");
  const second = await upload("avatar_prune_2");
  assert.ok(existsSync(join(root, "data", "avatars", first)), "a fresh unreferenced upload is kept (another window may not have saved its seat yet)");
  const longAgo = new Date(Date.now() - 11 * 60_000);
  utimesSync(join(root, "data", "avatars", first), longAgo, longAgo);
  await upload("avatar_prune_3");
  assert.equal(existsSync(join(root, "data", "avatars", first)), false, "an unreferenced upload older than 10 minutes is deleted");
  assert.ok(existsSync(join(root, "data", "avatars", second)), "the new upload stays");
});

test("GET /api/avatar refuses a generated route redirected outside avatars by a directory junction", async () => {
  const avatarDir = join(root, "data", "avatars");
  const outside = join(root, "outside-avatars");
  const filename = "avatar-00000000-0000-4000-8000-000000000001.png";
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, filename), "outside avatar");
  removeTree(avatarDir);
  symlinkSync(outside, avatarDir, "junction");
  try {
    const response = await request({ path: `/api/avatar/${filename}`, headers: { Origin: BASE_ORIGIN } });
    assert.equal(response.status, 403);
    assert.equal(response.body, "forbidden avatar path");
  } finally {
    removeTree(avatarDir);
    mkdirSync(avatarDir, { recursive: true });
  }
});

test("POST uploads refuse scratch and avatar directories junctioned outside the data root", async () => {
  const dataDir = join(root, "data");
  const outsideRoot = mkdtempSync(join(tmpdir(), "cc-http-outside-"));
  try {
  const outsideForImage = join(outsideRoot, "outside-image-upload");
  const outsideForFile = join(outsideRoot, "outside-file-upload");
  const outsideForAvatar = join(outsideRoot, "outside-avatar-upload");
  const withJunction = async (storage: string, outside: string, requestUpload: () => Promise<{ status: number }>) => {
    mkdirSync(outside, { recursive: true });
    removeTree(storage);
    symlinkSync(outside, storage, "junction");
    try {
      const response = await requestUpload();
      return { response, outsideFiles: readdirSync(outside) };
    } finally {
      removeTree(storage);
      mkdirSync(storage, { recursive: true });
    }
  };

  const image = await withJunction(join(dataDir, "scratch"), outsideForImage, () =>
    request({ method: "POST", path: "/api/paste-image", headers: {
      Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "junction_image_upload",
    }, body: "outside image" }));
  assert.ok(image.response.status >= 400 && image.response.status < 500, `paste-image refused junction target, received ${image.response.status}`);
  assert.deepEqual(image.outsideFiles, [], "paste-image must not write through scratch junction");

  const file = await withJunction(join(dataDir, "scratch"), outsideForFile, () =>
    request({ method: "POST", path: "/api/paste-file", headers: {
      Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "source.txt", "X-Request-Id": "junction_file_upload",
    }, body: "outside file" }));
  assert.ok(file.response.status >= 400 && file.response.status < 500, `paste-file refused junction target, received ${file.response.status}`);
  assert.deepEqual(file.outsideFiles, [], "paste-file must not write through scratch junction");

  const avatar = await withJunction(join(dataDir, "avatars"), outsideForAvatar, () =>
    request({ method: "POST", path: "/api/avatar", headers: {
      Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "junction_avatar_upload",
    }, body: "outside avatar" }));
  assert.ok(avatar.response.status >= 400 && avatar.response.status < 500, `avatar upload refused junction target, received ${avatar.response.status}`);
  assert.deepEqual(avatar.outsideFiles, [], "avatar upload must not write through avatars junction");
  } finally { removeWithRetry(outsideRoot); }
});

test("POST /api/paste-file enforces id, extension, name traversal and size, then stores generated files in scratch", async () => {
  const contents = Buffer.from("export const ok = true;\n");
  const uploaded = await request({ method: "POST", path: "/api/paste-file", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "source.ts", "X-Request-Id": "file_upload_1",
  }, body: contents });
  assert.equal(uploaded.status, 200);
  const result = JSON.parse(uploaded.body);
  assert.deepEqual([result.name, result.requestId], ["source.ts", "file_upload_1"]);
  assert.equal(dirname(result.path), join(root, "data", "scratch"));
  assert.equal(readFileSync(result.path).toString(), contents.toString());

  const traversal = await request({ method: "POST", path: "/api/paste-file", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "%2E%2E%2Fprivate.txt", "X-Request-Id": "file_traversal",
  }, body: "private" });
  assert.equal(traversal.status, 415);
  assert.equal(JSON.parse(traversal.body).requestId, "file_traversal");
  const unsafeExtension = await request({ method: "POST", path: "/api/paste-file", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "payload.exe", "X-Request-Id": "file_bad_extension",
  }, body: "unsafe" });
  assert.equal(unsafeExtension.status, 415);
  assert.equal(JSON.parse(unsafeExtension.body).requestId, "file_bad_extension");
  const missingId = await request({ method: "POST", path: "/api/paste-file", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "source.txt",
  }, body: "no id" });
  assert.equal(missingId.status, 400);
  assert.deepEqual(JSON.parse(missingId.body), { error: "a valid X-Request-Id header is required" });

  const oversize = await request({ method: "POST", path: "/api/paste-file", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "large.txt", "X-Request-Id": "file_too_large",
  }, body: Buffer.alloc(20 * 1024 * 1024 + 1, 0x78), deadlineMs: 15_000 });
  assert.equal(oversize.status, 413);
  assert.equal(JSON.parse(oversize.body).requestId, "file_too_large");
});

test("GET /api/paste-image returns an uploaded image and rejects paths outside scratch", async () => {
  const uploaded = await request({ method: "POST", path: "/api/paste-image",
    headers: { Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "upload_transcript" }, body: "transcript image" });
  assert.equal(uploaded.status, 200);
  const saved = JSON.parse(uploaded.body).path;
  const image = await request({ path: `/api/paste-image?path=${encodeURIComponent(saved)}`, headers: { Origin: BASE_ORIGIN } });
  assert.equal(image.status, 200, `generated scratch image path matched ${saved}`);
  assert.equal(image.body, "transcript image", "GET returned the exact uploaded bytes");
  const outside = await request({ path: `/api/paste-image?path=${encodeURIComponent(join(root, "outside.png"))}`, headers: { Origin: BASE_ORIGIN } });
  assert.equal(outside.status, 403, `outside path was rejected: ${outside.status}`);
});

test("GET missing transcript image ends with 404 without an unhandled rejection or broadcast", async () => {
  const ws = await openWs();
  const broadcasts: any[] = [];
  const beforeStderr = serverStderr.length;
  ws.on("message", (data) => broadcasts.push(JSON.parse(data.toString())));
  try {
    const missing = join(root, "data", "scratch", "paste-abcdef01-2345-6789-abcd-0123456789ab.png");
    const response = await request({ path: `/api/paste-image?path=${encodeURIComponent(missing)}`, headers: { Origin: BASE_ORIGIN } });
    assert.equal(response.status, 404);
    assert.equal(response.body, "not found");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.deepEqual(broadcasts, [], `missing image must not broadcast: ${JSON.stringify(broadcasts)}`);
    assert.doesNotMatch(serverStderr.slice(beforeStderr), /unhandled|rejection/i, "missing image must not cause an unhandled rejection");
  } finally { ws.close(); }
});

test("HTTP request helper fails when a server does not answer before its deadline", async () => {
  const stalled = http.createServer(() => {});
  await new Promise<void>((resolveListen, reject) => {
    stalled.once("error", reject);
    stalled.listen(0, HOST, resolveListen);
  });
  const address = stalled.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(request({ port: address.port, path: "/never-answers", deadlineMs: 100 }), /HTTP request timed out after 100ms/);
  } finally {
    stalled.closeAllConnections();
    await new Promise<void>((resolveClose) => stalled.close(() => resolveClose()));
  }
});

test("WebSocket helpers fail with a message when the server never answers, instead of waiting for the runner's timeout", { timeout: 10_000 }, async () => {
  const ws = await openWs();
  try {
    await assert.rejects(nextMessage(ws, 100), /no WebSocket message within 100ms/);
    await assert.rejects(nextMessages(ws, 2, 100), /only 0 of 2 WebSocket messages within 100ms/);
    assert.equal(ws.listenerCount("message"), 0, "the timed-out waits left no listener behind");
  } finally { ws.close(); }
});

test("HTTP request helper rejects a response that aborts mid-body", async () => {
  const interrupted = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": "100" });
    res.write("partial");
    setImmediate(() => res.destroy());
  });
  await new Promise<void>((resolveListen, reject) => {
    interrupted.once("error", reject);
    interrupted.listen(0, HOST, resolveListen);
  });
  const address = interrupted.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(request({ port: address.port, path: "/interrupted", deadlineMs: 1000 }), (error: Error) => {
      assert.match(error.message, /aborted|ECONNRESET|socket hang up/i);
      return true;
    });
  } finally {
    interrupted.closeAllConnections();
    await new Promise<void>((resolveClose) => interrupted.close(() => resolveClose()));
  }
});

test("Save error names the tab and action that failed", async () => {
  const ws = keyedSocket({ origin: BASE_ORIGIN });
  try {
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Save error response timed out")), 5000);
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type !== "error") return;
        clearTimeout(timer); resolve(message);
      });
      ws.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "save", tabId: "missing-tab" }));
    const error = await result;
    assert.equal(error.action, "save", `matched Save action metadata: ${JSON.stringify(error)}`);
    assert.equal(error.tabId, "missing-tab", `matched failed tab id: ${JSON.stringify(error)}`);
  } finally { ws.close(); }
});

test("refused requests name their action and target; history errors name no held action", async () => {
  const ws = await openWs();
  try {
    const refusedChat = nextMessage(ws);
    ws.send(JSON.stringify({ type: "chat", tabId: "missing-tab", text: "hi", images: Array.from({ length: 9 }, () => "x.png") }));
    const chatError = await refusedChat;
    assert.deepEqual([chatError.type, chatError.action, chatError.tabId, chatError.projectId], ["error", "chat", "missing-tab", undefined], `matched ${JSON.stringify(chatError)}`);
    const refusedProject = nextMessage(ws);
    ws.send(JSON.stringify({ type: "removeProject", projectId: "missing-project" }));
    const projectError = await refusedProject;
    assert.deepEqual([projectError.action, projectError.projectId, projectError.tabId], ["removeProject", "missing-project", undefined], `matched ${JSON.stringify(projectError)}`);
    const history = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyList", seatKey: "../outside/run" }));
    const historyError = await history;
    assert.equal(historyError.type, "error");
    assert.equal(historyError.action, undefined, `history lookups are not held actions: ${JSON.stringify(historyError)}`);
  } finally { ws.close(); }
});

test("setPermissionMode with no live leader saves for the next session", async () => {
  const ws = await openWs();
  try {
    const initialState = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: "hello" }));
    const [initial] = await initialState;
    const tabId = initial.projects[0].tabs[0].id;
    const requestId = "perm_no_leader";
    const changed = nextState(ws, (state) => {
      const tab = state.projects.flatMap((project: any) => project.tabs).find((item: any) => item.id === tabId);
      const action = state.settings.permissionActions[tabId];
      return tab?.permissionMode === "plan" && action?.requestId === requestId && action.status === "done";
    });
    ws.send(JSON.stringify({ type: "setPermissionMode", requestId, tabId, mode: "plan" }));
    const state = await changed;
    const tab = state.projects.flatMap((project: any) => project.tabs).find((item: any) => item.id === tabId);
    assert.equal(tab.permissionMode, "plan");
    assert.equal(state.settings.permissionActions[tabId].status, "done");
  } finally { ws.close(); }
});

// ---- guard 6 (P2): scratch (pasted images) must follow the same data root
// as config/logs, not the app's own re-extracted-on-every-launch directory --
// proven through a real running server, not the pure resolveDataRoot helper.
// This child needs CC_DATA_DIR honoured (real packaged behaviour), while
// NODE_TEST_CONTEXT stays set. CC_TEST_FORCE_PACKAGED is the narrow override
// that lets the data-root test exercise both conditions at once.
//
// Pure so the decision -- NODE_TEST_CONTEXT preserved, the override added --
// is provable without spawning anything real.
function packagedDataRootChildEnv(baseEnv: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  return { ...baseEnv, CC_PORT: "0", CC_APP_KEY: APP_KEY, CC_SKIP_LEADER_CHECK: "1", CC_SKIP_DISCOVERY: "1", CC_TEST_FAKE_CLI: "1", CC_DATA_DIR: dataDir, CC_TEST_FORCE_PACKAGED: "1" };
}

test("packaged-data-root child env keeps NODE_TEST_CONTEXT set while forcing the packaged data root", () => {
  const env = packagedDataRootChildEnv({ NODE_TEST_CONTEXT: "child-v8", PATH: "kept" }, "C:\\fake\\data-dir");
  assert.equal(env.NODE_TEST_CONTEXT, "child-v8");
  assert.equal(env.CC_TEST_FORCE_PACKAGED, "1");
  assert.equal(env.CC_DATA_DIR, "C:\\fake\\data-dir");
  assert.equal(env.PATH, "kept");
});

// Both the capture guard and the live test execute this exact spawn call.
function spawnPackagedServer(dataDir: string): ChildProcess {
  const options = {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"] as const,
    windowsHide: true,
    env: packagedDataRootChildEnv(process.env, dataDir),
  };
  // Fail before launching anything if a mutation removes the vault backstop.
  assert.ok(options.env.NODE_TEST_CONTEXT, "packaged spawn must retain NODE_TEST_CONTEXT");
  return spawn(process.execPath, [join(root, "server", "index.ts")], options);
}

test("packaged spawn actual options retain the test context", () => {
  const source = readFileSync("test/http.test.ts", "utf8");
  const match = source.match(/function spawnPackagedServer\([^]*?^}/m);
  assert.ok(match);
  let captured;
  const launch = runInNewContext(stripTypeScriptTypes(`${match[0]}; spawnPackagedServer`), {
    assert, root: "fake-root", join, packagedDataRootChildEnv, testHome: "fake-home",
    process: { execPath: "node", env: { NODE_TEST_CONTEXT: "child-v8", PATH: "kept", HOME: "fake-home", USERPROFILE: "fake-home", CC_TEST_FAKE_CLI: "1" } },
    spawn: (_command, _args, options) => { captured = options; return {}; },
  });
  launch("fake-data");
  assert.ok(captured, "must execute the real spawn call");
  assert.equal(captured.env.NODE_TEST_CONTEXT, "child-v8");
  assert.equal(captured.env.CC_TEST_FORCE_PACKAGED, "1");
  assert.equal(captured.env.CC_DATA_DIR, "fake-data");
  assert.equal(captured.env.HOME, "fake-home");
  assert.equal(captured.env.USERPROFILE, "fake-home");
  assert.equal(captured.env.CC_TEST_FAKE_CLI, "1");
  assert.equal(captured.env.PATH, "kept");
});

test("POST /api/paste-image: a packaged data root moves scratch with it", async () => {
  // Root this fixture under OS temp so a killed test worker cannot leave a .cc-test-* tree in the repo.
  const dataDir = mkdtempSync(join(tmpdir(), "cc-packaged-data-"));
  let proc: ChildProcess | undefined;
  try {
    proc = spawnPackagedServer(dataDir);
    attachCrashCatcher(proc.pid, "http-packaged");
    proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    const port = await waitReady(proc);
    const res = await request({ port, method: "POST", path: "/api/paste-image",
      headers: { Origin: `http://${HOST}:${port}`, "Content-Type": "image/png", "X-Request-Id": "upload_packaged" },
      body: "packaged test png", deadlineMs: 5000 });
    assert.equal(res.status, 200);
    const saved = JSON.parse(res.body).path;
    assert.equal(dirname(saved), join(dataDir, "scratch"), "scratch must follow CC_DATA_DIR, not the app's own root");
    assert.equal(readFileSync(saved, "utf8"), "packaged test png");
  } finally {
    try { if (proc) await stopChild(proc); }
    finally { removeWithRetry(dataDir); }
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

// ---- run history: a real running server, real files under logs/ -- proving
// the actual seatId allow-list and path containment (item 5), and the hard
// ceiling on an explicit "full" load (item 6), not just the pure helpers. ----

// A socket to the main test server with the app key in the URL (a browser page cannot set upgrade headers).
function keyedSocket(options?: ConstructorParameters<typeof WebSocket>[1]): WebSocket {
  return new WebSocket(keyedWsUrl(`ws://${HOST}:${PORT}`, APP_KEY), options);
}

async function openWs(): Promise<WebSocket> {
  const ws = keyedSocket();
  await new Promise((resolvePromise, reject) => {
    ws.once("open", resolvePromise);
    ws.once("error", reject);
  });
  return ws;
}

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const onMessage = (data: Buffer) => { clearTimeout(timer); resolvePromise(JSON.parse(data.toString())); };
    const timer = setTimeout(() => { ws.off("message", onMessage); reject(new Error(`no WebSocket message within ${timeoutMs}ms`)); }, timeoutMs);
    ws.once("message", onMessage);
  });
}

function nextState(ws: WebSocket, matches: (state: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const finish = (error?: Error, state?: any) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
      if (error) reject(error);
      else resolvePromise(state);
    };
    const onMessage = (data: Buffer) => {
      const message = JSON.parse(data.toString());
      if (message.type === "state" && matches(message)) {
        finish(undefined, message);
      }
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("WebSocket closed before matching state"));
    const timer = setTimeout(() => finish(new Error(`matching state timed out after ${timeoutMs}ms`)), timeoutMs);
    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

function nextMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<any[]> {
  return new Promise((resolvePromise, reject) => {
    const messages: any[] = [];
    const onMessage = (data: Buffer) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length === count) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolvePromise(messages);
      }
    };
    const timer = setTimeout(() => { ws.off("message", onMessage); reject(new Error(`only ${messages.length} of ${count} WebSocket messages within ${timeoutMs}ms`)); }, timeoutMs);
    ws.on("message", onMessage);
  });
}

test("WebSocket: history rejects an unsafe legacy seat id (path-traversal attempt)", async () => {
  const ws = await openWs();
  try {
    const reply1 = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyList", seatKey: "../outside/run" }));
    const listReply = await reply1;
    assert.equal(listReply.type, "error");
    assert.match(listReply.message, /invalid seat key/);

    const reply2 = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyRun", seatKey: "../outside/run", timestamp: 123 }));
    const runReply = await reply2;
    assert.equal(runReply.type, "error");
    assert.match(runReply.message, /invalid history run/);
  } finally {
    ws.close();
  }
});

test("WebSocket: historyList + historyRun round-trip for an old bare seat id and log file", async () => {
  const seatId = "sonny";
  const timestamp = Date.now();
  const logsDirPath = join(root, "data", "logs");
  mkdirSync(logsDirPath, { recursive: true });
  const logPath = join(logsDirPath, `${seatId}-${timestamp}.log`);
  writeFileSync(logPath, "hello from history\n[exit] status=done code=0\n");
  writeFileSync(join(logsDirPath, `${seatId}-${timestamp}.brief.txt`), "the brief");

  const ws = await openWs();
  try {
    const listReplyP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyList", seatKey: seatId }));
    const listReply = await listReplyP;
    assert.equal(listReply.type, "historyList");
    assert.ok(listReply.runs.some((e: { timestamp: number }) => e.timestamp === timestamp));

    const runReplyP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyRun", seatKey: seatId, timestamp }));
    const runReply = await runReplyP;
    assert.equal(runReply.type, "historyRun");
    assert.equal(runReply.seatKey, seatId);
    assert.equal(runReply.timestamp, timestamp);
    assert.equal(runReply.brief, "the brief");
    assert.match(runReply.output, /hello from history/);
    assert.equal(runReply.totalBytes, readFileSync(logPath, "utf8").length);
    assert.equal(runReply.full, false, "a plain request is echoed as not the fuller log");
  } finally {
    ws.close();
  }
});

test("WebSocket: an explicit 'full' history load still has a hard ceiling, never the entire (oversized) file", async () => {
  const seatId = "sonny";
  const timestamp = Date.now() + 1; // distinct from the round-trip test's file
  const logsDirPath = join(root, "data", "logs");
  mkdirSync(logsDirPath, { recursive: true });
  const oversized = "a".repeat(9 * 1024 * 1024); // bigger than the 8 MiB ceiling
  writeFileSync(join(logsDirPath, `${seatId}-${timestamp}.log`), oversized);

  const ws = await openWs();
  try {
    const replyP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyRun", seatKey: seatId, timestamp, full: true }));
    const reply = await replyP;
    assert.equal(reply.type, "historyRun");
    assert.equal(reply.truncated, true, "even an explicit full request must still be capped");
    assert.ok(reply.output.length < oversized.length, "must never ship the whole oversized file");
    assert.equal(reply.totalBytes, oversized.length);
    assert.equal(reply.full, true, "a fuller-log request is echoed so the page labels the reply from it");
  } finally {
    ws.close();
  }
});

// Legacy bare-id logs stay readable even though workspace seats now use tab-scoped keys.
test("WebSocket: history remains readable for a retired legacy bare seat id", async () => {
  const seatId = "retired-x";
  const timestamp = Date.now() + 2;
  const logsDirPath = join(root, "data", "logs");
  mkdirSync(logsDirPath, { recursive: true });
  writeFileSync(join(logsDirPath, `${seatId}-${timestamp}.log`), "the retired seat's own old output\n[exit] status=done code=0\n");
  writeFileSync(join(logsDirPath, `${seatId}-${timestamp}.brief.txt`), "the retired seat's old brief");

  const ws = await openWs();
  try {
    const listReplyP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyList", seatKey: seatId }));
    const listReply = await listReplyP;
    assert.equal(listReply.type, "historyList", "a removed seat's history must remain readable");
    assert.ok(listReply.runs.some((e: { timestamp: number }) => e.timestamp === timestamp));

    const runReplyP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyRun", seatKey: seatId, timestamp }));
    const runReply = await runReplyP;
    assert.equal(runReply.type, "historyRun");
    assert.equal(runReply.brief, "the retired seat's old brief");
    assert.match(runReply.output, /the retired seat's own old output/);
  } finally {
    ws.close();
  }
});

// Exercise validation through the real WebSocket call site: a rejected model
// update must not leave its accompanying name change in memory or on disk.
test("WebSocket: updateSeat applies no partial changes when its model is rejected", async () => {
  const ws = await openWs();
  try {
    const before = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: "hello" }));
    const [beforeState] = await before;
    const beforeTab = beforeState.projects[0].tabs[0];
    const beforeSeat = beforeTab.crew[0];

    const errorReplyP = nextMessage(ws);
    ws.send(JSON.stringify({ type: "updateSeat", tabId: beforeTab.id, slot: beforeSeat.slot, name: "Should roll back", model: "bad & echo INJECTED" }));
    const errorReply = await errorReplyP;
    assert.equal(errorReply.type, "error");

    const afterP = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: "hello" }));
    const [afterState] = await afterP;
    const afterTab = afterState.projects[0].tabs.find((tab: { id: string }) => tab.id === beforeTab.id);
    const afterSeat = afterTab.crew.find((seat: { slot: string }) => seat.slot === beforeSeat.slot);
    assert.deepEqual(afterSeat, beforeSeat, "the rejected update must leave the crew slot unchanged");
  } finally {
    ws.close();
  }
});

test("selected-tab instruction inventory stays scoped during a background folder refresh", async () => {
  const firstFolder = join(root, "settings-scope-first");
  const secondFolder = join(root, "settings-scope-second");
  const changedFirstFolder = join(root, "settings-scope-first-changed");
  for (const folder of [firstFolder, secondFolder, changedFirstFolder]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(firstFolder, "CLAUDE.md"), "first tab");
  writeFileSync(join(secondFolder, "CLAUDE.md"), "selected tab");
  writeFileSync(join(changedFirstFolder, "CLAUDE.md"), "background refresh");

  const ws = await openWs();
  try {
    const addFirst = nextState(ws, (state) => state.projects.some((project: any) => project.id === "settingsscopefirst"));
    ws.send(JSON.stringify({ type: "addProject", id: "settingsscopefirst", name: "First", folder: firstFolder, tabId: "settingsscopefirst-development" }));
    await addFirst;
    const addSecond = nextState(ws, (state) => state.projects.some((project: any) => project.id === "settingsscopesecond"));
    ws.send(JSON.stringify({ type: "addProject", id: "settingsscopesecond", name: "Second", folder: secondFolder, tabId: "settingsscopesecond-development" }));
    await addSecond;

    const changed = nextState(ws, (state) => state.projects.some((project: any) => project.id === "settingsscopefirst"
      && project.tabs.some((tab: any) => tab.folder === changedFirstFolder)));
    ws.send(JSON.stringify({ type: "changeFolder", tabId: "settingsscopefirst-development", folder: changedFirstFolder }));
    await changed;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    const fresh = await openWs();
    try {
      const statePromise = nextState(fresh, () => true);
      fresh.send(JSON.stringify({ type: "hello"}));
      const state = await statePromise;
      const projectInstructions = state.settings.skills.claude.instructionFiles.filter((item: any) => item.scope === "project");
      assert.equal(state.selectedTabId, "settingsscopesecond-development");
      assert.deepEqual(projectInstructions.map((item: any) => item.path), [join(secondFolder, "CLAUDE.md")]);
    } finally { fresh.close(); }
  } finally { ws.close(); }
});

test("updateSeat accepts a shipped preset portrait or a generated route, and refuses anything else including traversal", async () => {
  const ws = await openWs();
  try {
    const initial = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: "hello" }));
    const [state] = await initial;
    const tab = state.projects[0].tabs[0];
    const leader = tab.crew.find((seat: any) => seat.isLeader);
    for (const pic of ["avatars/atlas.svg", "avatars/ash.svg"]) {
      const update = nextMessage(ws);
      ws.send(JSON.stringify({ type: "updateSeat", tabId: tab.id, slot: leader.slot, pic }));
      const changed = await update;
      assert.equal(changed.type, "state", `${pic} is a shipped portrait and must be accepted`);
      assert.equal(changed.projects[0].tabs[0].crew.find((seat: any) => seat.slot === leader.slot).pic, pic);
    }
    // Old photo presets stay refused even when such a file exists in public/avatars.
    writeFileSync(join(root, "public", "avatars", "legacy.jpg"), "x");
    writeFileSync(join(root, "public", "avatars", "legacy.png"), "x");
    for (const pic of ["avatars/legacy.jpg", "avatars/legacy.png"]) {
      const refusedLegacy = nextMessage(ws);
      ws.send(JSON.stringify({ type: "updateSeat", tabId: tab.id, slot: leader.slot, pic }));
      assert.equal((await refusedLegacy).type, "error", `${pic} is an old preset and must be refused`);
    }
    for (const pic of ["avatars/nope.svg", "avatars/atlas.jpg", "avatars/sol.png", "avatars/../server/index.ts", "avatars/..%2fserver%2findex.ts", "../avatars/astra.jpg", "/avatars/astra.jpg", "avatars/astra.webp", "avatars\\astra.jpg", "avatars\\atlas.svg", "avatars/astra.jpg/x", "avatars/.jpg", "avatars/"]) {
      const refused = nextMessage(ws);
      ws.send(JSON.stringify({ type: "updateSeat", tabId: tab.id, slot: leader.slot, pic }));
      const invalid = await refused;
      assert.equal(invalid.type, "error", `${pic} must be refused`);
      assert.match(invalid.message, /invalid seat pic/);
    }
  } finally { ws.close(); }
});

test("POST /api/avatar refuses a non-image content type and stores nothing", async () => {
  const before = readdirSync(join(root, "data", "avatars")).length;
  for (const type of ["text/plain", "application/octet-stream", "image/svg+xml", ""]) {
    const refused = await request({ method: "POST", path: "/api/avatar", headers: {
      Origin: BASE_ORIGIN, "Content-Type": type, "X-Request-Id": "avatar_bad_type",
    }, body: Buffer.from("not an image") });
    assert.equal(refused.status, 415, `content type "${type}"`);
    assert.deepEqual(JSON.parse(refused.body), { error: "unsupported image type", requestId: "avatar_bad_type" });
  }
  assert.equal(readdirSync(join(root, "data", "avatars")).length, before);
});

test("uploads refused for a bad Host or Origin leave no status in state, and cannot overwrite a real upload's status", async () => {
  const ok = await request({ method: "POST", path: "/api/paste-image", headers: { Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "real_upload_kept" }, body: Buffer.from("real") });
  assert.equal(ok.status, 200);
  for (let index = 0; index < 40; index++) {
    const refused = await request({ method: "POST", path: "/api/paste-image", headers: { Host: "evil.example", Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": `refused_host_${index}` }, body: "x" });
    assert.equal(refused.status, 403);
  }
  const overwrite = await request({ method: "POST", path: "/api/paste-image", headers: { Origin: "https://evil.example", "Content-Type": "image/png", "X-Request-Id": "real_upload_kept" }, body: "x" });
  assert.equal(overwrite.status, 403);
  const ws = await openWs();
  try {
    const initial = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: "hello" }));
    const [state] = await initial;
    const ids = Object.keys(state.settings.uploads);
    assert.equal(ids.some((id) => id.startsWith("refused_host_")), false, "a refused Host must not record status");
    assert.equal(state.settings.uploads.real_upload_kept.status, "done", "a refused request cannot overwrite a real upload");
    assert.ok(ids.length <= 32);
  } finally { ws.close(); }
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
  for (const path of ["/", "/app.js", "/index.html"]) assert.equal((await request({ path, headers: { Origin: BASE_ORIGIN } })).body.includes(APP_KEY), false, path);
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
