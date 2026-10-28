import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
// Its own data root and port: the server never touches the owner's config, chats or settings, and an inherited CC_PORT or CC_APP_KEY changes nothing.
const dataDir = mkdtempSync(join(tmpdir(), "cc-live-null-"));
const key = "ab".repeat(32);
const { CC_TEST_FORCE_PACKAGED: _ccTestForcePackaged, NODE_TEST_CONTEXT: _nodeTestContext, ...childEnv } = process.env;
const child = spawn(process.execPath, ["server/index.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: { ...childEnv, CC_DATA_DIR: dataDir, CC_PORT: "0", CC_APP_KEY: key, CC_SKIP_LEADER_CHECK: "1" }, // this script proves crash-survival, not leader health
});
const exited = once(child, "exit");
let ws;
// Every wait below ends when the time is up, the server is gone or the socket closed: a killed server never answers, so a bare wait for a message would never end.
const abort = new AbortController();
const stop = (reason) => { if (!abort.signal.aborted) abort.abort(new Error(reason)); };
const timeout = setTimeout(() => { stop("timed out after 10 s"); killTree(); }, 10000);
child.once("exit", (code) => stop(`the server exited (code ${code})`));
const waitFor = (target, event) => once(target, event, { signal: abort.signal }).catch((error) => { throw abort.signal.aborted ? abort.signal.reason : error; });
function killTree() {
  // Discovery CLIs the server started are its children; a plain child.kill() would leave them running.
  if (child.exitCode === null && child.pid) spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}
try {
  let output = "";
  const port = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited before ready: ${code}`)));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
      const match = /Command Center running at http:\/\/[^:\s]+:(\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const before = await fetch(url);
  assert.equal(before.status, 200);
  assert.match(await before.text(), /Command Center/);
  console.log("GET / before null: 200, Command Center HTML served");
  ws = new WebSocket(`ws://127.0.0.1:${port}/?key=${key}`, { origin: url });
  ws.once("close", () => stop("the socket closed"));
  await waitFor(ws, "open");
  const reply = waitFor(ws, "message");
  ws.send("null");
  const [raw] = await reply;
  const error = JSON.parse(raw.toString());
  assert.equal(error.type, "error");
  assert.match(error.message, /expected an object with a string type/);
  console.log(`literal null reply: ${raw}`);
  const nextReply = waitFor(ws, "message");
  ws.send('{"type":"unknown-live-probe"}');
  const [next] = await nextReply;
  assert.match(JSON.parse(next.toString()).message, /unknown message type/);
  assert.equal((await fetch(url)).status, 200);
  assert.equal(child.exitCode, null);
  console.log("After null: same WebSocket responds; GET / = 200; server process alive");
} finally {
  ws?.terminate();
  killTree();
  let giveUp;
  await Promise.race([exited, new Promise((done) => { giveUp = setTimeout(done, 5000); })]);
  clearTimeout(giveUp);
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) {
    // Still running: its folder is in use, so it is kept and the run fails.
    console.error(`The test server (pid ${child.pid}) could not be stopped; its data folder was kept: ${dataDir}`);
    process.exitCode = 1;
  } else {
    // Only the folder made above.
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log("Test server stopped");
  }
}
