import { waitForServerStart } from "./server-start.ts";
// Fix pack 2, block 1 (server core), shared setup: a real server on a temp data dir with its own app key, a websocket client and a data-dir maker.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export type Server = { port: number; key: string; data: string; child: ChildProcess; log: () => string; exited: Promise<number | null>; stop: () => Promise<void> };
// `data` is the data dir the server uses (CC_DATA_DIR); it is created and removed by the caller. `waitListening: false` is for a server that must not come up.
export async function boot(data: string, options: { port?: number; /* a port the caller holds on purpose, for the taken-port test; omit for an OS-picked one */ waitListening?: boolean; env?: Record<string, string> } = {}): Promise<Server> {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack2-home-"));
  const home = join(temp, "home"); mkdirSync(home, { recursive: true });
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: {} }));
  let port = options.port ?? 0;
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: options.port === undefined ? "0" : String(options.port), CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", FAKE_LEADER_LOG: join(temp, "fake-leader.log"),
    CC_APP_KEY: key, ...options.env,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: env as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack2-server");
  let log = "";
  child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  const exited = new Promise<number | null>((ok) => child.once("exit", (code) => ok(code)));
  if (options.waitListening !== false) {
    try { port = await waitForServerStart(child, () => log); }
    catch (error) { removeWithRetry(temp); throw error; }
  }
  return {
    port, key, data, child, log: () => log, exited,
    stop: async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.once("error", () => {});
          try { child.send("shutdown", () => {}); } catch { /* IPC already closed: fall through to kill */ }
          await Promise.race([exited, sleep(8000)]);
          if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, sleep(3000)]); }
        }
      } finally { removeWithRetry(temp); }
    },
  };
}

export async function connect(server: Server) {
  const messages: any[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${server.key}`, { origin: `http://127.0.0.1:${server.port}` });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(socket, "open");
  const wait = async <T>(fn: () => T, label: string, ms = 8000): Promise<NonNullable<T>> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${server.log().slice(-400)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-4))}`);
  };
  const send = (payload: any) => socket.send(JSON.stringify(payload));
  send({ type: "hello" });
  await wait(() => messages.find((m) => m.type === "state"), "first state");
  const state = () => messages.filter((m) => m.type === "state").at(-1);
  return { messages, send, wait, state, close: () => socket.terminate() };
}

export function makeData(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-pack2-data-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  return dir;
}
