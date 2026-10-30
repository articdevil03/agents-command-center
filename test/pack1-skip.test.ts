import { waitForServerStart } from "./server-start.ts";
// Call-site guard for server/index.ts setCliSkipFolders(...): a real server start, a codex.cmd planted in a workspace
// folder that is on PATH but is NOT the leader's own folder. Deleting the registration makes the server run it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

test("the server registers every workspace folder: a codex.cmd inside another tab's folder on PATH is never run", async () => {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack1-skip-"));
  let child: ChildProcess | undefined;
  let log = "";
  // Installed right after the folder exists: the hook removes the folder and the server even when this process dies on an uncaught error.
  const cleanupAtExit = () => { try { child?.kill(); } catch { /* already gone */ } try { rmSync(temp, { recursive: true, force: true }); } catch { /* nothing more to try */ } };
  process.once("exit", cleanupAtExit);
  const messages: any[] = [];
  let socket: WebSocket | undefined;
  let port = 0;
  const other = join(temp, "other");
  const marker = join(other, "PLANTED.txt");
  try {
    const data = join(temp, "data"), home = join(temp, "home"), work = join(temp, "work");
    for (const dir of [home, work, other, join(data, "config")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(other, "codex.cmd"), `@echo off\r\necho planted> "%~dp0PLANTED.txt"\r\n`);
    const crew = getProcessDefinition("dev", "main").seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort, ...(seat.isLeader ? { cli: "codex", model: "gpt-6-sol", effort: "high" } : {}) }));
    const tabs = [
      { id: "t-codex", name: "t-codex", kind: "dev", process: "main", folder: work, crew },
      { id: "t-other", name: "t-other", kind: "dev", process: "main", folder: other, crew },
    ];
    writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p1", name: "P1", folder: work, tabs }] }));
    const key = randomBytes(32).toString("hex");
    const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    // CC_PORT=0: the OS picks the port at the server's own listen, so no other test can take it first.
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32, other].join(";"),
      CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: "0", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1", CC_APP_KEY: key,
    } as NodeJS.ProcessEnv;
    delete env.CC_TEST_FAKE_CLI; // the real spawn path (withResolvedCli) must run
    const spawned = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env });
    attachCrashCatcher(spawned.pid, "pack1-skip");
    child = spawned;
    spawned.on("error", (error) => { log += `
spawn error: ${error.message}`; });
    spawned.stdout!.on("data", (d) => { log += d; }); spawned.stderr!.on("data", (d) => { log += d; });
    port = await waitForServerStart(spawned, () => log);
    socket = new WebSocket(`ws://127.0.0.1:${port}/?key=${key}`, { origin: `http://127.0.0.1:${port}` });
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    socket.on("error", (error) => messages.push({ type: "socketError", message: error.message }));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "hello" }));
    socket.send(JSON.stringify({ type: "chat", tabId: "t-codex", text: "hi" }));
    const stop = Date.now() + 15000;
    while (Date.now() < stop && !JSON.stringify(messages).match(/found only inside|exited before it started|chatDone/)) await sleep(20);
    await sleep(500); // a planted codex.cmd, if it ran, has written by now
    const seen = JSON.stringify(messages.filter((m) => m.type !== "state"));
    assert.equal(existsSync(marker), false, `the planted codex.cmd ran. messages=${seen.slice(-600)}`);
    assert.match(seen, /codex was found only inside a project folder/, `the launch was refused with the real reason. messages=${seen.slice(-600)}`);
  } finally {
    socket?.terminate();
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const running = child;
        const exited = new Promise((ok) => running.once("exit", ok)); // resolve-only: once() would reject on an IPC "error"
        running.once("error", () => {});
        try { running.send("shutdown", () => {}); } catch { /* IPC already closed: fall through to kill */ }
        await Promise.race([exited, sleep(8000)]);
        if (running.exitCode === null && running.signalCode === null) { running.kill(); await Promise.race([exited, sleep(3000)]); }
      }
    } finally {
      try { unlinkSync(marker); } catch { /* never written */ }
      // If this still throws, the exit hook stays installed for one more try at exit and the error surfaces.
      rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      process.removeListener("exit", cleanupAtExit);
    }
  }
});
