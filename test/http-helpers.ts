import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import http from "node:http";
import { WebSocket } from "ws";
import { newAppKey, keyedWsUrl } from "./temp-root.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { SERVER_START_MS } from "./server-start.ts";

// Item E: the origin/host/containment helpers in security.ts are unit-tested,
// but their only real callers (handleHttpRequest in server/main/http.ts, serveStatic,
// and the WebSocketServer's verifyClient) were not exercised at all. This
// file starts a real instance of the server as a child process on a
// dedicated port and drives it exactly like a real client would, so a
// mutation at any of those call sites (not just the helper) turns it red.

export const HOST = "127.0.0.1";
// Every server this file spawns gets this as CC_APP_KEY; request() and keyedSocket() send it.
export const APP_KEY = newAppKey();

// Reads the server's ready line the same way electron/server-process.js does, by
// extracting and running its real parseServerPort function rather than a
// second hand-rolled regex that could drift from it (see test/electron-helpers.ts
// for the same technique). electron/server-process.js imports the `electron` package at
// module scope, which cannot load outside an actual Electron process, so the
// function body is lifted out and evaluated on its own instead of imported.
export const parseServerPort: (text: string) => number | null = (() => {
  const source = readFileSync("electron/server-process.js", "utf8");
  const match = source.match(/(?:export )?function parseServerPort\([^]*?^}/m);
  assert.ok(match, "parseServerPort must exist in electron/server-process.js");
  return runInNewContext(`${match[0].replace("export function", "function")};parseServerPort;`);
})();

export let child: ChildProcess;
export let PORT: number;
export let BASE_ORIGIN: string;
export let serverStderr = "";
export let serverStdout = "";

export async function stopChild(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
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

export function waitReady(proc: ChildProcess, timeoutMs = SERVER_START_MS): Promise<number> {
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
      // Infrastructure timeout stays a plain Error, never a caught mutation.
      finish(new Error(`server readiness timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once("error", onError);
    proc.once("exit", onExit);
    proc.stdout?.on("data", onData);
    if (proc.exitCode !== null || proc.signalCode !== null) onExit(proc.exitCode);
  });
}

// A directory junction is removed as a link (never recursively), so a recursive delete can never reach through it into the real folder it points at.
export function removeTree(target: string): void {
  let isLink = false;
  try { isLink = lstatSync(target).isSymbolicLink(); } catch { return; }
  rmSync(target, isLink ? { force: true } : { recursive: true, force: true });
}
export const root = mkdtempSync(join(tmpdir(), "cc-http-test-"));
export let dependencyRoot = process.cwd();
after(async () => {
  try { if (child) await stopChild(child); }
  finally {
    removeTree(join(root, "node_modules"));
    try { assert.ok(existsSync(join(dependencyRoot, "node_modules")), "the real node_modules survived the teardown"); }
    finally { removeWithRetry(root); }
  }
});
// The live config files (workspaces, client preferences, launch safety) are never copied: the server seeds its own from the bundled defaults.
export const LIVE_CONFIG_FILES = new Set(["workspaces.json", "client-prefs.json", "launch-safety.json"]);
for (const name of ["server", "config", "public", "package.json"]) cpSync(join(process.cwd(), name), join(root, name), { recursive: true, filter: (src) => !LIVE_CONFIG_FILES.has(src.replaceAll("\\", "/").split("/").pop()!) });
dependencyRoot = process.cwd();
while (!existsSync(join(dependencyRoot, "node_modules"))) {
  const parent = dirname(dependencyRoot);
  if (parent === dependencyRoot) throw new Error("could not locate node_modules for the HTTP test server");
  dependencyRoot = parent;
}
symlinkSync(join(dependencyRoot, "node_modules"), join(root, "node_modules"), "junction");
export const testHome = join(root, "test-home");
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
export function spawnServer(): ChildProcess {
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

// appKey: the X-App-Key header every call sends by default; a string overrides it, null sends none.
export function request(options: http.RequestOptions & { body?: string | Buffer; deadlineMs?: number; appKey?: string | null }): Promise<{ status: number; body: string; contentType: string }> {
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

// ---- run history: a real running server, real files under logs/ -- proving
// the actual seatId allow-list and path containment (item 5), and the hard
// ceiling on an explicit "full" load (item 6), not just the pure helpers. ----

// A socket to the main test server with the app key in the URL (a browser page cannot set upgrade headers).
export function keyedSocket(options?: ConstructorParameters<typeof WebSocket>[1]): WebSocket {
  return new WebSocket(keyedWsUrl(`ws://${HOST}:${PORT}`, APP_KEY), options);
}

export async function openWs(): Promise<WebSocket> {
  const ws = keyedSocket();
  await new Promise((resolvePromise, reject) => {
    ws.once("open", resolvePromise);
    ws.once("error", reject);
  });
  return ws;
}

export function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const onMessage = (data: Buffer) => { clearTimeout(timer); resolvePromise(JSON.parse(data.toString())); };
    const timer = setTimeout(() => { ws.off("message", onMessage); reject(new assert.AssertionError({ message: `no WebSocket message within ${timeoutMs}ms` })); }, timeoutMs);
    ws.once("message", onMessage);
  });
}

export function nextState(ws: WebSocket, matches: (state: any) => boolean, timeoutMs = 5000): Promise<any> {
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
    const timer = setTimeout(() => finish(new assert.AssertionError({ message: `matching state timed out after ${timeoutMs}ms` })), timeoutMs);
    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

export function nextMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<any[]> {
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
    const timer = setTimeout(() => { ws.off("message", onMessage); reject(new assert.AssertionError({ message: `only ${messages.length} of ${count} WebSocket messages within ${timeoutMs}ms` })); }, timeoutMs);
    ws.on("message", onMessage);
  });
}
