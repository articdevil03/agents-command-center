import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { serverNodeRuntime } from "../electron/node-runtime.js";
import { removeWithRetry } from "./mutation-proof.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export function runtimeProofEnv(temp, data) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(path|node_path|node_options|node_test_context|electron_run_as_node)$/i.test(key)
      || /^cc_/i.test(key) || /(?:claude|codex|opencode|gemini).*path/i.test(key)) delete env[key];
  }
  const sys = process.env.SystemRoot || "C:\\Windows";
  return { ...env, Path: `${sys}\\System32;${sys};${sys}\\System32\\WindowsPowerShell\\v1.0`,
    TEMP: temp, TMP: temp, HOME: temp, USERPROFILE: temp, APPDATA: temp, LOCALAPPDATA: temp, CC_DATA_DIR: data, CC_PORT: "0", CC_APP_KEY: randomBytes(32).toString("hex") };
}
async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function proveRuntime(electron = join(root, "node_modules/electron/dist/electron.exe")) {
  assert.ok(resolve(electron) === electron, `runtime path must be absolute: ${electron}`);
  const temp = mkdtempSync(join(tmpdir(), "cc-p29-proof-"));
  const data = join(temp, "data"); mkdirSync(data);
  let child, ended, port, output = "", errors = "";
  try {
    // This preloaded observer runs its child on the first event-loop turn, after static server imports.
    const observer = join(temp, "observe.mjs");
    writeFileSync(observer, `import { spawnSync } from "node:child_process";
import { join } from "node:path";
setImmediate(() => {
 const result = spawnSync(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -ieq 'ELECTRON_RUN_AS_NODE' } | ConvertTo-Json -Compress"], { env: process.env, encoding: "utf8", windowsHide: true });
 console.log("P29_CHILD_ENV=" + JSON.stringify({ code: result.status, keys: result.stdout.trim(), electron: process.versions.electron }));
});\n`);
    // Execute the app's production launch wiring with isolated Electron app dependencies.
    // This also catches a regression at the spawn call site, rather than testing a duplicate launch.
    const source = readFileSync(join(root, "electron/server-process.js"), "utf8").replace(/^import .*;$/gm, "").replaceAll("export ", "");
    let runtimeCommand;
    const startServer = runInNewContext(source + ";startServer", {
      app: { isPackaged: true, getPath: () => data }, randomBytes, createServer, join,
      root, smokeReadyFile: undefined, process: { env: runtimeProofEnv(temp, data) },
      serverNodeRuntime: (entry, skip) => serverNodeRuntime(entry, skip, electron),
      setTimeout, clearTimeout,
      spawn: (command, args, options) => {
        runtimeCommand = command;
        child = spawn(command, ["--import", pathToFileURL(observer).href, ...args], options);
        ended = new Promise((done) => { child.once("error", (error) => done({ error: error.message })); child.once("close", (code, signal) => done({ code, signal })); });
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { errors += chunk; });
        return child;
      },
    });
    const ready = await startServer();
    assert.equal(ready.ok, true, ready.reason);
    port = ready.port;
    await bounded(new Promise((done, reject) => {
      const inspect = () => { if (/P29_CHILD_ENV=([^\r\n]+)/.test(output)) done(); };
      inspect(); child.stdout.on("data", inspect);
      ended.then((result) => reject(new Error("runtime ended before child observation: " + JSON.stringify(result))));
    }), 10000, "child observation exhausted");
    const record = JSON.parse(/P29_CHILD_ENV=([^\r\n]+)/.exec(output)[1]);
    assert.equal(record.code, 0, `child observer failed: ${JSON.stringify(record)}`);
    assert.equal(record.keys, "", `child inherited Node mode: ${JSON.stringify(record)}`);
    assert.ok(record.electron, `Electron runtime signal absent: ${JSON.stringify(record)}`);
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `GET / returned ${response.status}`);
    child.send("shutdown");
    const exit = await bounded(ended, 130000, "IPC shutdown exhausted");
    assert.equal(exit.code, 0, `IPC shutdown: ${JSON.stringify(exit)} ${errors}`);
    await new Promise((done, reject) => {
      const probe = createServer(); probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(done));
    });
    console.log(`PASS runtime=${runtimeCommand}; ready port=${port}; GET /=200; child keys=${JSON.stringify(record.keys)}; electron=${record.electron}; IPC exit=0; port free`);
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await bounded(ended, 10000, `owned server ${child.pid} did not end after taskkill`);
    }
    assert.ok(removeWithRetry(temp), `proof temp not removed: ${temp}`);
  }
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--electron")) { console.error("Usage: node scripts/pack29-runtime-proof.mjs [--electron <absolute exe>]"); process.exitCode = 1; }
  else proveRuntime(args[1]).catch((error) => { console.error(`FAIL runtime proof: ${error.message}`); process.exitCode = 1; });
}
