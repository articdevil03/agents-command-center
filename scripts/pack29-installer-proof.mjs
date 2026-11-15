import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPackageClean, builderCli, removeOwnedTree, run, scanPackaged, sha256 } from "./dist-installer.mjs";
import { runtimeProofEnv } from "./pack29-runtime-proof.mjs";

const name = "command-center-p29test", product = "Command Center P29 Test";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function removeEmptyFolders(dir) {
  assert.ok(!lstatSync(dir).isSymbolicLink() && lstatSync(dir).isDirectory(), `expected owned empty folder: ${dir}`);
  for (const leaf of readdirSync(dir)) removeEmptyFolders(join(dir, leaf));
  assert.equal(readdirSync(dir).length, 0); rmdirSync(dir);
}

export function manifest(dir, prefix = "") {
  assert.ok(!lstatSync(dir).isSymbolicLink(), `linked data folder: ${dir}`);
  const entries = [];
  for (const leaf of readdirSync(dir).sort()) {
    const file = join(dir, leaf), rel = prefix + leaf, info = lstatSync(file);
    assert.ok(!info.isSymbolicLink(), `linked data entry: ${file}`);
    if (info.isDirectory()) entries.push({ path: rel + "/", bytes: 0, hash: null }, ...manifest(file, rel + "/"));
    else entries.push({ path: rel, bytes: info.size, hash: sha256(readFileSync(file)) });
  }
  return entries;
}

function ps(source) {
  const result = spawnSync(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", source], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, `PowerShell exit=${result.status}: ${result.stderr}`);
  return result.stdout.trim();
}

function registryKeys() {
  return JSON.parse(ps(String.raw`$ErrorActionPreference='Stop'; $keys=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty -LiteralPath $_.PSPath).DisplayName -match '^${product}(?: [0-9].*)?$' } | ForEach-Object { $_.PSChildName }); ConvertTo-Json -InputObject $keys -Compress`));
}

async function waitUntil(check, message) {
  const deadline = Date.now() + 60000;
  while (!check() && Date.now() < deadline) await delay(200);
  assert.ok(check(), message);
}

// Drive the existing shell smoke protocol. It bypasses the ordinary GUI, using the installed exe.
async function launchInstalled(exe, temp) {
  const { spawn } = await import("node:child_process");
  const data = join(temp, "launch-data"); mkdirSync(data);
  const ready = join(temp, "ready.json"), stop = join(temp, "stop");
  const env = { ...runtimeProofEnv(temp, data), CC_SMOKE_READY_FILE: ready, CC_SMOKE_STOP_FILE: stop, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1" };
  const child = spawn(exe, [], { env, cwd: temp, windowsHide: true, stdio: "ignore" });
  let error;
  child.once("error", (e) => { error = e; });
  const ended = new Promise((done) => child.once("close", done));
  let serverPid;
  try {
    await waitUntil(() => existsSync(ready) || error || child.exitCode !== null, "installed shell readiness timeout");
    assert.ok(existsSync(ready), `installed shell failed: ${error?.message ?? child.exitCode}`);
    const record = JSON.parse(readFileSync(ready, "utf8")); serverPid = record.serverPid;
    assert.ok(Number.isInteger(serverPid) && serverPid > 0, "installed shell returned server PID");
    const response = await fetch(`http://127.0.0.1:${record.port}/`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    writeFileSync(stop, "stop", { flag: "wx" });
    let stopTimer;
    const code = await Promise.race([ended, new Promise((done) => { stopTimer = setTimeout(() => done("timeout"), 135000); })]).finally(() => clearTimeout(stopTimer));
    assert.equal(code, 0, "installed shell smoke shutdown exit");
    console.log(`PASS installed shell CC_SMOKE protocol, stripped PATH, GET /=200; server PID=${serverPid}; exit=0`);
  } finally {
    for (const pid of [child.pid, serverPid].filter(Boolean)) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) { if (!["ESRCH", "EINVAL"].includes(e.code)) throw e; }
      if (alive) {
        await run(join(process.env.SystemRoot, "System32/taskkill.exe"), ["/pid", String(pid), "/T", "/F"]);
        await waitUntil(() => { try { process.kill(pid, 0); return false; } catch (e) { return ["ESRCH", "EINVAL"].includes(e.code); } }, `PID ${pid} still alive`);
      }
    }
    await ended;
  }
}

export async function proveInstaller({ launch = false, once = false } = {}) {
  assert.equal(process.platform, "win32", "native Windows lifecycle required");
  assert.ok(name !== "command-center" && /^command-center-p29test$/.test(name), "scratch package identity required");
  const appdata = ps("[Environment]::GetFolderPath('ApplicationData')");
  const localappdata = ps("[Environment]::GetFolderPath('LocalApplicationData')");
  const desktop = ps("[Environment]::GetFolderPath('Desktop')");
  const programs = ps("[Environment]::GetFolderPath('Programs')");
  assert.ok(appdata && localappdata && desktop && programs, "real shell folders resolved");
  const data = join(appdata, name);
  let defaultInstall = join(localappdata, "Programs", name);
  assert.equal(existsSync(defaultInstall), false, `default folder already exists, not ours: ${defaultInstall}`);
  const shortcuts = [join(desktop, product + ".lnk"), join(programs, product + ".lnk")];
  assert.equal(existsSync(data), false, `scratch data already exists, not ours: ${data}`);
  assert.deepEqual(registryKeys(), [], "scratch registry already exists, not ours");
  for (const link of shortcuts) assert.equal(existsSync(link), false, `scratch shortcut already exists: ${link}`);
  const running = ps(`@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${product}.exe' }).Count`);
  assert.equal(running, "0", "scratch app must not be running");
  const temp = mkdtempSync(join(tmpdir(), "cc-p29-install-"));
  const junction = join(temp, "junction"), junctionTarget = join(temp, "junction-target");
  let junctionCreated = false;
  let install = join(temp, "installed"), defaultOwned = false;
  const seededFiles = [], seededDirs = [];
  let expected, installed = false, failure;
  const compare = (step) => {
    assert.ok(existsSync(data), `${step}: seeded data root was deleted: ${data}`);
    const actual = manifest(data);
    assert.deepEqual(actual, expected, `${step}: data manifest changed`);
    console.log(`PASS ${step}: ${actual.filter((e) => e.hash).length} files, ${actual.filter((e) => !e.hash).length} folders, manifest SHA-256=${sha256(JSON.stringify(actual))}`);
  };
  const installVersion = async (setup, useDefault = false) => {
    installed = true;
    await run(setup, useDefault ? ["/S"] : ["/S", `/D=${install}`]);
    assert.ok(existsSync(join(install, product + ".exe")), "installed variant exe exists");
    assert.equal(registryKeys().length, 1, "one variant uninstall registry key");
    for (const link of shortcuts) assert.ok(existsSync(link), `installed shortcut exists: ${link}`);
    assertPackageClean(join(install, "resources/app"));
    await scanPackaged(join(install, "resources/app"));
  };
  const uninstall = async () => {
    if (!installed) return;
    const file = join(install, `Uninstall ${product}.exe`);
    if (!existsSync(install) && registryKeys().length === 0 && shortcuts.every((f) => !existsSync(f))) { installed = false; return; }
    // An intentionally destructive _?= mutation can remove its registry and all
    // files except its own running executable. Remove only that known remnant.
    if (existsSync(install) && registryKeys().length === 0 && shortcuts.every((f) => !existsSync(f))
      && JSON.stringify(readdirSync(install)) === JSON.stringify([`Uninstall ${product}.exe`])) {
      assert.ok(!lstatSync(install).isSymbolicLink() && !lstatSync(file).isSymbolicLink());
      unlinkSync(file); assert.equal(readdirSync(install).length, 0); rmdirSync(install);
      installed = false; console.log(`REMOVED known uninstaller remnant ${file} and empty owned install folder`); return;
    }
    assert.ok(existsSync(file), `owned variant uninstaller missing: ${file}`);
    const keys = registryKeys();
    assert.equal(keys.length, 1, "registered variant uninstaller required");
    const command = ps(`(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${keys[0]}').UninstallString`);
    const registration = command.match(/^"([^"]+)"(?: (\/currentuser))?$/i);
    assert.ok(registration, `unexpected scratch uninstall command: ${command}`);
    const registered = registration[1];
    assert.equal(registered.toLowerCase(), file.toLowerCase(), "registered uninstaller belongs to owned install");
    await run(registered, ["/S", ...(registration[2] ? [registration[2]] : [])]);
    await waitUntil(() => !existsSync(install) && registryKeys().length === 0 && shortcuts.every((f) => !existsSync(f)), "variant uninstall left files, shortcuts or registry");
    installed = false;
  };
  try {
    const setups = [];
    for (const version of once ? ["0.0.291"] : ["0.0.291", "0.0.292"]) {
      const out = join(temp, version);
      await run(process.execPath, [builderCli, "--win", "nsis", "--x64", "--config.compression=store",
        `--config.directories.output=${out}`, `--config.productName=${product}`, "--config.appId=com.agents.command-center.p29test",
        `--config.extraMetadata.name=${name}`, `--config.extraMetadata.version=${version}`,
        `--config.nsis.shortcutName=${product}`, `--config.nsis.artifactName=P29-Test-${version}.exe`],
      { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
      const packed = JSON.parse(readFileSync(join(out, "win-unpacked/resources/app/package.json"), "utf8"));
      assert.equal(packed.name, name, "built scratch package identity before any install");
      defaultInstall = join(localappdata, "Programs", packed.name);
      assert.equal(packed.version, version, "built scratch package version");
      assert.ok(existsSync(join(out, "win-unpacked", product + ".exe")), "scratch executable identity");
      setups.push(join(out, `P29-Test-${version}.exe`));
    }
    // Both paths must be absent to expose the original empty-normalization bug.
    mkdirSync(junctionTarget); symlinkSync(junctionTarget, junction, "junction"); junctionCreated = true;
    install = join(junction, "installed"); installed = true;
    let junctionExit = 0;
    try { await run(setups[0], ["/S", `/D=${install}`]); }
    catch (error) { assert.match(error.message, /exit=3/); junctionExit = 3; }
    assert.equal(junctionExit, 3, "junction install exit code must be 3");
    assert.equal(manifest(junctionTarget).filter((entry) => entry.hash !== null).length, 0, "junction target must contain no files");
    assert.equal(existsSync(join(install, product + ".exe")), false, "no junction installed executable");
    assert.deepEqual(registryKeys(), [], "no junction uninstall registry key");
    for (const link of shortcuts) assert.equal(existsSync(link), false, "no junction shortcut");
    installed = false;
    rmdirSync(junction); junctionCreated = false; removeEmptyFolders(junctionTarget);
    console.log("PASS real junction install rejected: exit=3, no files, registry or shortcuts");
    install = defaultInstall; defaultOwned = true;
    await installVersion(setups[0], true);
    assert.equal(existsSync(data), false, "first-time default install preserves absent data manifest");
    console.log("PASS first-time default-location install: data manifest remains absent");
    await uninstall();
    assert.equal(existsSync(data), false, "first-time default uninstall preserves absent data manifest");
    mkdirSync(data); seededDirs.push(data);
    for (const rel of ["empty", "nested", "nested/deeper"]) { const dir = join(data, rel); mkdirSync(dir); seededDirs.push(dir); }
    for (const [rel, content] of [["settings.json", "{\"sentinel\":true}"], ["nested/data.bin", "\u0000\u00ff\n"], ["nested/deeper/odd name # [test].txt", "preserve me"]]) {
      const file = join(data, rel); writeFileSync(file, content, { flag: "wx" }); seededFiles.push(file);
    }
    expected = manifest(data); compare("seed");
    // Test against owned existing paths. The template calls SetOutPath before customInit,
    // so a nonexistent /D child would be created before our rejection callback runs.
    // Never attempt APPDATA itself: a broken guard could affect unrelated applications.
    for (const target of [data, join(data, "empty")]) {
      let refused = false;
      try { await run(setups[0], ["/S", `/D=${target}`]); } catch (e) { assert.match(e.message, /exit=3/); refused = true; }
      assert.ok(refused, `protected install directory accepted: ${target}`); compare("protected directory rejection");
    }
    install = defaultInstall; defaultOwned = true;
    await installVersion(setups[0], true); compare("default-location install");
    await uninstall(); compare("default-location uninstall");
    const spacedParent = join(temp, "p29 spaced dir"); mkdirSync(spacedParent);
    install = join(spacedParent, "installed");
    await installVersion(setups[0]); compare("spaced-path install");
    await uninstall(); compare("spaced-path uninstall");
    install = join(temp, "installed");
    await installVersion(setups[0]); compare("install v1");
    if (launch) await launchInstalled(join(install, product + ".exe"), temp);
    if (!once) { await installVersion(setups[1]); compare("upgrade v2"); }
    await uninstall(); compare("uninstall default");
    await installVersion(setups.at(-1)); compare("reinstall");
    let rejected = false;
    // _?= keeps this rejection check in the process we await. Without it NSIS's
    // copy-to-temp bootstrap returns 0 before the real uninstaller rejects the switch.
    try { await run(join(install, `Uninstall ${product}.exe`), ["/S", "--delete-app-data", `_?=${install}`]); }
    catch (e) { assert.match(e.message, /exit=2/); rejected = true; }
    assert.ok(rejected, "--delete-app-data was not rejected"); compare("uninstall destructive switch rejected");
    await uninstall(); compare("final uninstall");
  } catch (e) { failure = e; }
  finally {
    try {
      try { await uninstall(); }
      finally {
        if (junctionCreated) { rmdirSync(junction); junctionCreated = false; }
        if (existsSync(junctionTarget)) removeEmptyFolders(junctionTarget);
        if (defaultOwned && existsSync(defaultInstall)) removeOwnedTree(defaultInstall);
      }
      assert.equal(existsSync(defaultInstall), false, "default install folder remains");
      for (const file of seededFiles) if (existsSync(file)) { assert.ok(!lstatSync(file).isSymbolicLink()); unlinkSync(file); console.log(`REMOVED seeded file ${file}`); }
      for (const dir of seededDirs.reverse()) if (existsSync(dir)) { assert.ok(!lstatSync(dir).isSymbolicLink()); assert.equal(readdirSync(dir).length, 0, `unexpected data remains: ${dir}`); rmdirSync(dir); console.log(`REMOVED empty seeded folder ${dir}`); }
      assert.deepEqual(registryKeys(), [], "variant registry cleanup");
      for (const link of shortcuts) assert.equal(existsSync(link), false, `variant shortcut remains: ${link}`);
      assert.equal(existsSync(install), false, "variant install folder remains");
      removeOwnedTree(temp); console.log(`REMOVED owned build temp ${temp}; variant registry and shortcuts absent`);
    } catch (e) { failure = failure ? new AggregateError([failure, e], "lifecycle and cleanup failed") : e; }
  }
  if (failure) throw failure;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  proveInstaller({ launch: process.argv.includes("--launch"), once: process.argv.includes("--once") }).catch((e) => { console.error(e); process.exitCode = 1; });
}
