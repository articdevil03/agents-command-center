import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { FORBIDDEN_PACKAGED_ENTRIES } from "./export-public/scan.mjs";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const builderCli = createRequire(import.meta.url).resolve("electron-builder/cli.js");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Only call for this invocation's uniquely allocated stage or temp tree.
export function removeOwnedTree(dir) {
  if (!existsSync(dir)) return;
  assert.ok(!lstatSync(dir).isSymbolicLink(), `refusing linked cleanup: ${dir}`);
  for (const name of readdirSync(dir)) {
    const entry = join(dir, name), info = lstatSync(entry);
    assert.ok(!info.isSymbolicLink(), `refusing linked cleanup: ${entry}`);
    if (info.isDirectory()) removeOwnedTree(entry);
    else unlinkSync(entry);
  }
  assert.equal(readdirSync(dir).length, 0, `cleanup folder not empty: ${dir}`);
  rmdirSync(dir);
}

// No shell. A failed child prevents all later publish operations.
export async function run(command, args, { env = process.env, timeoutMs = 600000, capture = false } = {}) {
  const started = Date.now();
  // NSIS requires the final /D= argument to remain unquoted, even with spaces.
  const verbatim = process.platform === "win32" && args.some((arg) => arg.startsWith("/D=") || arg.startsWith("_?="));
  const child = spawn(command, args, { cwd: root, env, ...(verbatim ? { argv0: `"${command}"` } : {}), windowsVerbatimArguments: verbatim, windowsHide: true, stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"] });
  let output = "", timedOut = false, spawnError;
  child.stdout?.on("data", (s) => { output += s; });
  child.stderr?.on("data", (s) => { output += s; });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32") {
      // Only the PID owned by this invocation and its descendants.
      const killed = spawnSync(join(process.env.SystemRoot, "System32/taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
      if (killed.status !== 0) child.kill();
    } else child.kill("SIGKILL");
  }, timeoutMs);
  child.on("error", (error) => { spawnError = error; });
  const code = await new Promise((done) => child.once("close", done));
  clearTimeout(timer);
  assert.ok(!spawnError && !timedOut && code === 0, `${command} exit=${code} timeout=${timedOut} ${spawnError?.message ?? ""}\n${output}`);
  console.log(`CHECK exit=${code} wall=${((Date.now() - started) / 1000).toFixed(2)}s: ${command} ${args.join(" ")}`);
  return output;
}

export function assertPackageClean(app) {
  assert.ok(lstatSync(app).isDirectory(), `packaged app missing: ${app}`);
  for (const entry of FORBIDDEN_PACKAGED_ENTRIES) assert.equal(existsSync(join(app, entry)), false, `private packaged entry: ${entry}`);
  const names = readdirSync(app).sort();
  console.log(`resources/app top level: ${JSON.stringify(names)}`);
  return names;
}

export async function scanPackaged(app) {
  const patterns = resolve(process.env.CC_EXPORT_PATTERNS ?? join(root, ".leak-patterns.local"));
  if (!existsSync(patterns)) {
    if (process.env.CC_EXPORT_PATTERNS !== undefined) throw new Error(`CC_EXPORT_PATTERNS file is missing: ${patterns}`);
    console.log("leak scan skipped: no private word list on this machine (only the owner's release build runs it)");
    return;
  }
  console.log("leak scan running: packaged resources/app");
  await run(process.execPath, [join(root, "scripts/export-public.mjs"), "--scan-packaged", app]);
}

export async function buildInstaller() {
  const dist = resolve(process.env.CC_INSTALLER_DIST ?? join(root, "dist"));
  mkdirSync(dist, { recursive: true });
  const lock = join(dist, ".dist-installer.lock");
  // ponytail: exclusive lock never steals an ambiguous or stale PID. Remove a confirmed stale lock manually.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, started: Date.now() }), { flag: "wx" });
  let stage, published = false;
  try {
    stage = mkdtempSync(join(dist, "installer-stage-"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const artifact = `Command Center Setup ${pkg.version}.exe`;
    const env = { ...process.env, CC_INSTALLER_STAGE: stage, CC_INSTALLER_ARTIFACT: artifact, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
    const builder = process.env.CC_INSTALLER_BUILDER ?? builderCli;
    await run(process.execPath, [builder, "--win", "nsis", "--x64", `--config.directories.output=${stage}`], { env });
    const exe = join(stage, "win-unpacked/Command Center.exe");
    const proof = process.env.CC_INSTALLER_PROOF ?? join(root, "scripts/pack29-runtime-proof.mjs");
    await run(process.execPath, [proof, "--electron", exe], { env });
    assertPackageClean(join(stage, "win-unpacked/resources/app"));
    await scanPackaged(join(stage, "win-unpacked/resources/app"));
    const candidate = join(stage, artifact);
    const hash = sha256(readFileSync(candidate));
    const output = join(dist, "installers");
    mkdirSync(output, { recursive: true });
    const destination = join(output, artifact);
    // All build/proof/scan work finishes before either public file is changed.
    const sidecar = join(output, `${artifact}.${process.pid}.sha256.tmp`);
    writeFileSync(sidecar, `${hash}  ${artifact}\n`);
    try {
      // Remove the old hash before replacing its installer, so interrupted publication
      // can never pair a new installer with the previous release's checksum.
      if (existsSync(destination + ".sha256")) unlinkSync(destination + ".sha256");
      renameSync(candidate, destination);
      try { renameSync(sidecar, destination + ".sha256"); }
      catch (error) { throw new Error(`could not publish checksum ${sidecar} to ${destination}.sha256 for installer ${destination}: ${error.message}`, { cause: error }); }
      const actualHash = sha256(readFileSync(destination));
      assert.equal(readFileSync(destination + ".sha256", "utf8"), `${actualHash}  ${artifact}\n`, `published checksum mismatch: ${destination} and ${destination}.sha256`);
      published = true;
    } finally { if (existsSync(sidecar)) unlinkSync(sidecar); }
    console.log(`SHA-256 ${hash}\nInstaller: ${destination}`);
    return destination;
  } finally {
    try {
      if (stage) {
        try { removeOwnedTree(stage); }
        catch (error) {
          if (!published) throw error;
          console.warn(`warning: could not remove the stage folder ${stage}: ${error.message}`);
        }
      }
    }
    finally { unlinkSync(lock); }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildInstaller().catch((error) => { console.error(error); process.exitCode = 1; });
}
