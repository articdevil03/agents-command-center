// Run against a separate electron-builder output directory:
//   node scripts/packaged-smoke.mjs <win-unpacked/resources/app> <Command Center.exe>
//
// What this proves:
//   1. It launches the portable exe itself, waits for Electron's server-ready
//      handshake, makes one GET / that must return 200, and checks the exe and
//      its server process have exited.
//   2. It separately runs server/index.ts under plain node from a copy outside
//      this repository, first on a fresh empty data folder (clean first launch),
//      then on that seeded folder under the write-containment permission flags.
//      That catches missing packaged dependencies such as zod without ancestor
//      node_modules rescuing the import.
//
// It proves startup readiness only. CLI discovery is disabled for this smoke,
// so this does not claim that external CLIs or their discovery work. The
// leader health check is also skipped to avoid live API work.
//
// Keep all writes inside this run's temp data directory and remove the exact
// temp workspace in finally, including when allocation or copying fails.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { packagedSmokePermissionArgs } from "./packaged-smoke-permissions.mjs";

const projectRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

export function isOutsideRepo(repoRoot, candidate, pathApi = path) {
  const rel = pathApi.relative(repoRoot, candidate);
  return rel === ".." || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel);
}

export function assertMatchingBuildArtifacts(appPath, exePath, pathApi = path, publishDir = path.join(projectRoot, "dist")) {
  const app = pathApi.resolve(appPath);
  const exe = pathApi.resolve(exePath);
  const buildOutput = pathApi.resolve(app, "../../..");
  const unpackedName = pathApi.basename(pathApi.dirname(pathApi.dirname(app)));
  assert.ok(unpackedName.toLowerCase() === "win-unpacked", `app path must end in win-unpacked/resources/app: ${app}`);
  assert.ok(statSync(app).isDirectory(), `app path is not a directory: ${app}`);
  assert.ok(statSync(exe).isFile(), `exe path is not a file: ${exe}`);
  const sameOutput = process.platform === "win32"
    ? pathApi.dirname(exe).toLowerCase() === buildOutput.toLowerCase()
    : pathApi.dirname(exe) === buildOutput;
  assert.ok(sameOutput,
    `app and exe must come from the same electron-builder output directory (expected exe beside win-unpacked): app=${app}; exe=${exe}`);
  const published = existsSync(publishDir) ? realpathSync(publishDir) : pathApi.resolve(publishDir);
  const actualOutput = realpathSync(buildOutput);
  const isPublished = process.platform === "win32"
    ? actualOutput.toLowerCase() === published.toLowerCase()
    : actualOutput === published;
  assert.ok(!isPublished,
    `the published dist/ folder can contain an exe and win-unpacked from different builds; point both paths at a fresh electron-builder output folder: ${buildOutput}`);
  return { app, exe, buildOutput };
}

export function removeSmokeTemp(dir) {
  const resolved = realpathSync(dir);
  const tempRoot = realpathSync(tmpdir());
  const rel = path.relative(tempRoot, resolved);
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), `refusing smoke cleanup outside OS temp: ${resolved}`);
  try {
    rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    if (process.platform !== "win32") throw error;
    const cleanup = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$p = $env:CC_SMOKE_CLEANUP_PATH; $lastError = $null; for ($i = 0; $i -lt 40; $i++) { try { if (!(Test-Path -LiteralPath $p)) { exit 0 }; Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop } catch { $lastError = $_ }; if (!(Test-Path -LiteralPath $p)) { exit 0 }; Start-Sleep -Milliseconds 250 }; Write-Error $lastError; exit 1",
    ], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, CC_SMOKE_CLEANUP_PATH: resolved },
    });
    if (cleanup.error || cleanup.status !== 0 || existsSync(resolved)) {
      throw new Error(`could not remove smoke temp workspace "${resolved}": ${cleanup.error?.message ?? cleanup.stderr ?? error.message}`);
    }
  }
  assert.equal(existsSync(resolved), false, `smoke temp workspace remains: ${resolved}`);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH" && error?.code !== "EINVAL";
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    // Absolute path: a bare name is looked for in the current folder first.
    spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true, encoding: "utf8", timeout: 10000,
    });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForChildExit(child, exited, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)]);
}

async function waitForProcessExit(pid, timeoutMs, isRunning) {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await delay(25);
  }
  return !isRunning(pid);
}

async function waitForReadyFile(file, child, getSpawnError, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return readFileSync(file, "utf8");
    if (getSpawnError()) throw getSpawnError();
    if (child.exitCode !== null) throw new Error(`portable exe exited ${child.exitCode} before server readiness`);
    await delay(25);
  }
  throw new Error(`portable exe readiness timeout (${timeoutMs}ms)`);
}

// permission: run under Node's permission model (write containment). Off for a first launch on an empty data folder,
// because Node disables fsync under --permission and first-launch seeding needs it.
export async function runIsolatedPackagedServer({ app, outsideRoot, data, spawnProcess = spawn, logger = console, timeoutMs = 15000, stopTimeoutMs = 10000, permission = false }) {
  let child;
  let exited;
  let stdout = "";
  let stderr = "";
  let spawnError;
  let failure;
  try {
    const env = { ...process.env, CC_DATA_DIR: data, CC_PORT: "0", CC_SKIP_LEADER_CHECK: "1", CC_SKIP_DISCOVERY: "1" };
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT", "CC_TEST_FORCE_PACKAGED"]) delete env[key];
    child = spawnProcess(process.execPath, [...(permission ? packagedSmokePermissionArgs(data) : []), path.join(app, "server/index.ts")], {
      // Keep the OS temp directory removable on Windows; module resolution
      // follows the copied entry file, not this working directory.
      cwd: projectRoot, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.once("error", (error) => { spawnError = error; });
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.stdout?.setEncoding?.("utf8");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`isolated server readiness timeout (${timeoutMs}ms)`)), timeoutMs);
      const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once("error", finish);
      child.once("exit", (code) => finish(new Error(`isolated server exited ${code} before ready`)));
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
        if (/(?:^|\n)Command Center running at http:\/\/127\.0\.0\.1:[1-9]\d*\r?\n/.test(stdout)) finish();
      });
    });
    assert.equal(child.exitCode, null, "isolated server exited at readiness");
    logger.log(stdout.trim());
    logger.log(permission
      ? "PASS isolated packaged server reached ready with writes contained to its data folder"
      : "PASS isolated packaged server reached ready on a fresh data folder using only its copied files");
  } catch (error) {
    failure = new Error(`${error.message}\n${stdout}\n${stderr}${spawnError ? `\n${spawnError.message}` : ""}`);
  }
  // A server that will not stop must not hide why the run failed: both messages are reported, the readiness one first.
  let stopFailure;
  if (child?.pid && child.exitCode === null) {
    // The server's disconnect handler owns full-tree shutdown on Windows.
    // Closing IPC also lets Node close its IPC handle after the server stops.
    if (child.connected) child.disconnect();
    if (!exited || !(await waitForChildExit(child, exited, stopTimeoutMs))) {
      killTree(child.pid);
      if (!exited || !(await waitForChildExit(child, exited, stopTimeoutMs))) {
        stopFailure = new Error(`isolated packaged server process ${child.pid} did not close after shutdown and process-tree stop`);
      }
    }
  }
  if (failure) {
    if (stopFailure) failure.message += `\n${stopFailure.message}`;
    throw failure;
  }
  if (stopFailure) throw stopFailure;
}

// Two runs on one fresh folder: a clean first launch (seeds the folder), then the same folder under the write-containment permissions.
export async function runIsolatedProofs({ app, outsideRoot, ...options }) {
  const data = path.join(outsideRoot, "isolated-data");
  mkdirSync(data);
  await runIsolatedPackagedServer({ app, outsideRoot, data, ...options, permission: false });
  await runIsolatedPackagedServer({ app, outsideRoot, data, ...options, permission: true });
}

export async function runPackagedSmoke({
  root = projectRoot,
  source,
  exe,
  spawnProcess = spawn,
  fetchPage = globalThis.fetch,
  isRunning = processIsRunning,
  createTempDir = (prefix) => mkdtempSync(path.join(realpathSync(tmpdir()), prefix)),
  copyTree = cpSync,
  removeTemp = removeSmokeTemp,
  logger = console,
  readyTimeoutMs = 15000,
  exeReadyTimeoutMs = 45000,
  shutdownTimeoutMs = 10000,
  runIsolated = true,
} = {}) {
  assert.ok(typeof source === "string" && source.length > 0, "supply the app path from the same electron-builder output as the exe");
  assert.ok(typeof exe === "string" && exe.length > 0, "supply the exe path from the same electron-builder output as the app");
  const resolvedRoot = realpathSync(root);
  const packedApp = realpathSync(source);
  const portableExe = realpathSync(exe);
  assertMatchingBuildArtifacts(packedApp, portableExe);
  let outsideRoot;
  let child;
  let exited;
  let ready;
  let stopFile;
  let failure;
  let portableStopped = false;
  let stdout = "";
  let stderr = "";
  let spawnError;

  const stopPortable = async () => {
    if (!child || portableStopped) return;
    if (ready && child.exitCode === null) {
      try { writeFileSync(stopFile, "stop\n", { flag: "wx" }); }
      catch (error) { failure ??= new Error(`could not request portable exe shutdown: ${error.message}`); }
    } else if (child.exitCode === null) {
      killTree(child.pid);
      failure ??= new Error("portable exe did not publish readiness and was force-stopped");
    }

    if (exited && !(await waitForChildExit(child, exited, shutdownTimeoutMs))) {
      killTree(child.pid);
      failure ??= new Error("portable exe process did not exit after the smoke stop request; its process tree was force-stopped");
      if (!(await waitForChildExit(child, exited, shutdownTimeoutMs))) {
        failure ??= new Error("portable exe process remained after its process tree was force-stopped");
      }
    }
    if (child.exitCode !== 0 && !failure) failure = new Error(`portable exe exited ${child.exitCode} after smoke shutdown`);

    if (ready?.serverPid && !(await waitForProcessExit(ready.serverPid, shutdownTimeoutMs, isRunning))) {
      killTree(ready.serverPid);
      failure ??= new Error(`portable exe server process ${ready.serverPid} remained after shutdown; its process tree was force-stopped`);
      if (!(await waitForProcessExit(ready.serverPid, shutdownTimeoutMs, isRunning))) {
        failure ??= new Error(`portable exe server process ${ready.serverPid} remained after its process tree was force-stopped`);
      }
    }
    portableStopped = true;
  };

  try {
    outsideRoot = createTempDir("cc-packaged-smoke-");
    const app = path.join(outsideRoot, "app");
    const data = path.join(outsideRoot, "data");
    const readyFile = path.join(outsideRoot, "ready.json");
    stopFile = path.join(outsideRoot, "stop");
    copyTree(packedApp, app, { recursive: true });
    mkdirSync(data);
    assert.ok(isOutsideRepo(resolvedRoot, app), "packed app copy must live outside the repository so no ancestor node_modules can rescue a missing dependency");

    const env = { ...process.env, CC_DATA_DIR: data, CC_SMOKE_READY_FILE: readyFile, CC_SMOKE_STOP_FILE: stopFile, CC_SKIP_LEADER_CHECK: "1", CC_SKIP_DISCOVERY: "1" };
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT", "CC_TEST_FORCE_PACKAGED"]) delete env[key];
    child = spawnProcess(portableExe, [], {
      cwd: outsideRoot, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.once("error", (error) => { spawnError = error; });
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });

    const rawReady = await waitForReadyFile(readyFile, child, () => spawnError, exeReadyTimeoutMs);
    ready = JSON.parse(rawReady);
    assert.ok(Number.isInteger(ready.port) && ready.port > 0 && ready.port <= 65535, `portable exe returned an invalid ready port: ${rawReady}`);
    assert.ok(Number.isInteger(ready.serverPid) && ready.serverPid > 0, `portable exe returned an invalid server pid: ${rawReady}`);
    assert.equal(child.exitCode, null, "portable exe exited as soon as it published readiness");

    const response = await fetchPage(`http://127.0.0.1:${ready.port}/`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `portable exe server GET / returned ${response.status}`);
    logger.log(`PASS portable exe launched; GET / returned 200 on port ${ready.port}`);
    await stopPortable();
    if (runIsolated) {
      // A fresh data dir: the one above was already seeded by the exe, which would hide a first launch that needs files the copy lacks.
      await runIsolatedProofs({ app, outsideRoot, spawnProcess, logger, timeoutMs: readyTimeoutMs });
    }
  } catch (error) {
    failure = new Error(`${error.message}\n${stdout}\n${stderr}${spawnError ? `\n${spawnError.message}` : ""}`);
  } finally {
    if (outsideRoot && child) {
      await stopPortable();
    }
    if (outsideRoot) {
      try { removeTemp(outsideRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
      catch (error) { failure ??= new Error(`could not remove this run's temp workspace "${outsideRoot}": ${error.message}`); }
    }
  }

  if (failure) throw failure;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error("Usage: node scripts/packaged-smoke.mjs <win-unpacked/resources/app> <matching Command Center.exe>");
    process.exitCode = 2;
  } else runPackagedSmoke({ source: args[0], exe: args[1] }).catch((error) => {
    console.error(`${error.message}`);
    process.exitCode = 1;
  });
}
