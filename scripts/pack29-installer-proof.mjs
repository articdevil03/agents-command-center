import { isMain } from "./is-main.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPackageClean, builderCli, removeOwnedTree, run, scanPackaged, sha256 } from "./dist-installer.mjs";
import { launchInstalled } from "./installer-shell-proof.mjs";
import { compileFixture, fakeWork } from "./installer-fixtures.mjs";
import { lifecycleWork } from "./installer-lifecycle-proof.mjs";
import { cachedInstallerEnv } from "./installer-cache.mjs";

// All junctions and saved-data fixtures live under this run's disposable root.
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
  return JSON.parse(ps(String.raw`$ErrorActionPreference='Stop'; $keys=@(if (Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall') { Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty -LiteralPath $_.PSPath).DisplayName -match '^${product}(?: [0-9].*)?$' } | ForEach-Object { $_.PSChildName } }); ConvertTo-Json -InputObject $keys -Compress`));
}

async function waitUntil(check, message) {
  const deadline = Date.now() + 60000;
  while (!check() && Date.now() < deadline) await delay(200);
  assert.ok(check(), message);
}

export async function proveInstaller({ launch = false, once = false } = {}) {
  assert.equal(process.platform, "win32", "native Windows lifecycle required");
  const cachedTools = cachedInstallerEnv();
  assert.ok(name !== "command-center" && /^command-center-p29test$/.test(name), "scratch package identity required");
  const appdata = ps("[Environment]::GetFolderPath('ApplicationData')");
  const localappdata = ps("[Environment]::GetFolderPath('LocalApplicationData')");
  const desktop = ps("[Environment]::GetFolderPath('Desktop')");
  const programs = ps("[Environment]::GetFolderPath('Programs')");
  assert.ok(appdata && localappdata && desktop && programs, "real shell folders resolved");
  let defaultInstall = join(localappdata, "Programs", name);
  assert.equal(existsSync(defaultInstall), false, `default folder already exists, not ours: ${defaultInstall}`);
  const shortcuts = [join(desktop, product + ".lnk"), join(programs, product + ".lnk")];
  assert.equal(existsSync(join(appdata, name)), false, "scratch variant saved data already exists, not ours");
  assert.deepEqual(registryKeys(), [], "scratch registry already exists, not ours");
  for (const link of shortcuts) assert.equal(existsSync(link), false, `scratch shortcut already exists: ${link}`);
  const running = ps(`@(Get-Process -Name '${product}' -ErrorAction SilentlyContinue).Count`);
  assert.equal(running, "0", "scratch app must not be running");
  const temp = mkdtempSync(join(tmpdir(), "cc-p29-install-"));
  const scratchRoaming = join(temp, "roaming"); mkdirSync(scratchRoaming);
  const data = join(scratchRoaming, name);
  const sentinel = join(temp, "SENTINEL"); writeFileSync(sentinel, "outside install: preserve");
  const sentinels = new Map([[sentinel, "outside install: preserve"]]);
  const checkSentinel = () => { for (const [file, bytes] of sentinels) assert.equal(readFileSync(file, "utf8"), bytes); };
  // Same production hooks, with only the saved-data shell folder redirected.
  const scratchInclude = join(temp, "installer.nsh");
  const scratchLifecycle = join(temp, "installer-lifecycle.nsh");
  // Exercise the identical production logic with a shorter refusal wait in this disposable variant.
  writeFileSync(scratchLifecycle, readFileSync("build/installer-lifecycle.nsh", "utf8")
    .replace('installer-process.ps1"\'', 'installer-process.ps1" -TimeoutMs 3000\''));
  writeFileSync(scratchInclude, readFileSync("build/installer.nsh", "utf8")
    .replace('${BUILD_RESOURCES_DIR}\\installer-lifecycle.nsh', scratchLifecycle)
    .replaceAll('$APPDATA\\${APP_PACKAGE_NAME}', '$R9\\${APP_PACKAGE_NAME}')
    .replace('!macro customInit', '!macro customInit\n  ReadEnvStr $R9 CC_P4_APPDATA'));
  // The installer and uninstaller get their own LOCALAPPDATA, so the tools folder they remove is a scratch one, never the real one.
  const scratchLocal = join(temp, "localappdata"); mkdirSync(scratchLocal);
  // The installer appends refusals to $TEMP\command-center-setup.log: give it a scratch TEMP so the real user's log is never touched.
  const scratchTemp = join(temp, "temp"); mkdirSync(scratchTemp);
  const scratchEnv = { ...process.env, LOCALAPPDATA: scratchLocal, CC_P4_APPDATA: scratchRoaming, TEMP: scratchTemp, TMP: scratchTemp };
  const runScratch = async (command, args) => { try { return await run(command, args, { env: scratchEnv }); } finally { checkSentinel(); } };
  const appLocal = join(scratchLocal, "Command Center"), toolsDir = join(appLocal, "tools"), toolsLink = join(toolsDir, "linked"), outside = join(temp, "outside-target"), outsideLinked = join(temp, "outside-linked");
  const setupLog = join(scratchTemp, 'command-center-setup.log');
  let toolLogOffset = 0;
  const seedTools = () => {
    const candidate = join(toolsDir, "opencode-v1", "install-abcdef");
    mkdirSync(candidate, { recursive: true }); writeFileSync(join(candidate, "opencode.exe"), "tool");
    writeFileSync(join(candidate, ".command-center-owner.json"), JSON.stringify({ owner: "com.agents.command-center", format: 1, tool: "opencode", entry: "install-abcdef" }));
    mkdirSync(join(toolsDir, "foreign")); writeFileSync(join(toolsDir, "foreign", "SENTINEL"), "foreign");
    writeFileSync(join(toolsDir, "SENTINEL"), "not managed");
    writeFileSync(join(appLocal, "other.txt"), "not ours"); mkdirSync(outside); writeFileSync(join(outside, "canary.txt"), "keep");
    sentinels.set(join(outside, "canary.txt"), "keep");
    symlinkSync(outside, join(candidate, "linked"), "junction");
  };
  const toolsKept = (step) => { assert.ok(existsSync(join(toolsDir, "opencode-v1", "install-abcdef", "opencode.exe")), `${step}: the installed tools were removed`); console.log(`PASS ${step}: installed tools kept`); };
  const toolsRemoved = (step) => {
    assert.match(readFileSync(setupLog, 'utf8').slice(toolLogOffset), /Some tool files were kept because they could not be safely removed/);
    assert.equal(existsSync(join(toolsDir, "opencode-v1", "install-abcdef")), false, `${step}: owned candidate remains`);
    assert.equal(readFileSync(join(toolsDir, "foreign", "SENTINEL"), "utf8"), "foreign");
    assert.equal(readFileSync(join(toolsDir, "SENTINEL"), "utf8"), "not managed");
    assert.ok(existsSync(join(outside, "canary.txt")), `${step}: a link inside the tools folder was followed and its target emptied`);
    assert.equal(readFileSync(join(outside, "canary.txt"), "utf8"), "keep", `${step}: a link inside the tools folder was followed`);
    assert.equal(readFileSync(join(appLocal, "other.txt"), "utf8"), "not ours", `${step}: another file in the app folder was removed`);
    console.log(`PASS ${step}: owned tools removed, foreign entries, link target and sibling file untouched`);
    unlinkSync(join(toolsDir, "foreign", "SENTINEL")); rmdirSync(join(toolsDir, "foreign"));
    unlinkSync(join(toolsDir, "SENTINEL")); rmdirSync(toolsDir);
  };
  const junction = join(temp, "junction"), junctionTarget = join(temp, "junction-target");
  let junctionCreated = false;
  let install = join(temp, "installed"), defaultOwned = false;
  const seededFiles = [], seededDirs = [], scratchInstalls = new Set();
  let expected, installed = false, failure;
  const compare = (step) => {
    assert.ok(existsSync(data), `${step}: seeded data root was deleted: ${data}`);
    const actual = manifest(data);
    assert.deepEqual(actual, expected, `${step}: data manifest changed`);
    console.log(`PASS ${step}: ${actual.filter((e) => e.hash).length} files, ${actual.filter((e) => !e.hash).length} folders, manifest SHA-256=${sha256(JSON.stringify(actual))}`);
  };
  const installVersion = async (setup, useDefault = false) => {
    scratchInstalls.add(install);
    installed = true;
    await runScratch(setup, useDefault ? ["/S"] : ["/S", `/D=${install}`]);
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
    await runScratch(registered, ["/S", ...(registration[2] ? [registration[2]] : [])]);
    await waitUntil(() => !existsSync(install) && registryKeys().length === 0 && shortcuts.every((f) => !existsSync(f)), "variant uninstall left files, shortcuts or registry");
    installed = false;
  };
  try {
    const setups = [];
    for (const version of once ? ["0.0.291"] : ["0.0.291", "0.0.292"]) {
      const out = join(temp, version);
      await run(process.execPath, [builderCli, "--win", "nsis", "--x64", "--config.compression=store", "--config.npmRebuild=false",
        `--config.electronDist=${resolve("node_modules/electron/dist")}`, "--config.win.signAndEditExecutable=false",
        `--config.directories.output=${out}`, `--config.productName=${product}`, "--config.appId=com.agents.command-center.p29test",
        `--config.extraMetadata.name=${name}`, `--config.extraMetadata.version=${version}`,
        `--config.nsis.include=${scratchInclude}`, `--config.nsis.shortcutName=${product}`, `--config.nsis.artifactName=P29-Test-${version}.exe`],
      { env: { ...process.env, ...cachedTools, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
      const packed = JSON.parse(readFileSync(join(out, "win-unpacked/resources/app/package.json"), "utf8"));
      assert.equal(packed.name, name, "built scratch package identity before any install");
      defaultInstall = join(localappdata, "Programs", packed.name);
      assert.equal(packed.version, version, "built scratch package version");
      assert.ok(existsSync(join(out, "win-unpacked", product + ".exe")), "scratch executable identity");
      setups.push(join(out, `P29-Test-${version}.exe`));
    }
    // Both paths must be absent to expose the original empty-normalization bug.
    mkdirSync(junctionTarget); symlinkSync(junctionTarget, junction, "junction"); junctionCreated = true;
    install = join(junction, "installed");
    await installVersion(setups[0]); await uninstall();
    checkSentinel();
    rmdirSync(junction); junctionCreated = false; removeEmptyFolders(junctionTarget);
    console.log("PASS linked ancestor install succeeds and uninstalls safely");
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
    const refuse = async (target, label) => {
      let rejected = false;
      try {
        await runScratch(setups[0], ["/S", `/D=${target}`]);
      }
      catch (error) { assert.match(error.message, /exit=3/); rejected = true; }
      finally {
        // A broken refusal may register an install even when Setup exits non-zero.
        if (registryKeys().length) { install = target; scratchInstalls.add(target); installed = true; }
      }
      assert.ok(rejected, `${label}: install must be refused`);
      compare(label); checkSentinel(); assert.deepEqual(registryKeys(), []);
      for (const link of shortcuts) assert.equal(existsSync(link), false);
      console.log(`PASS ${label}: exit=3, data and external sentinel unchanged`);
    };
    // The alias is above the selected leaf, so only real-path overlap catches it.
    symlinkSync(scratchRoaming, junction, "junction"); junctionCreated = true;
    for (const target of [join(junction, name), join(junction, name, "empty"), junction]) await refuse(target, "aliased overlap");
    rmdirSync(junction); junctionCreated = false; checkSentinel();
    await refuse(scratchRoaming, "install contains saved data");
    mkdirSync(junctionTarget); writeFileSync(join(junctionTarget, "SENTINEL"), "external target survives");
    sentinels.set(join(junctionTarget, "SENTINEL"), "external target survives");
    const checkTarget = () => assert.equal(readFileSync(join(junctionTarget, "SENTINEL"), "utf8"), "external target survives");
    symlinkSync(junctionTarget, junction, "junction"); junctionCreated = true;
    await refuse(junction, "link at install root");
    rmdirSync(junction); junctionCreated = false; checkSentinel(); checkTarget();
    const existingInstall = join(temp, "existing-install"); mkdirSync(existingInstall);
    symlinkSync(junctionTarget, join(existingInstall, "linked"), "junction");
    try { await refuse(existingInstall, "link inside install root"); }
    finally { assert.ok(lstatSync(join(existingInstall, "linked")).isSymbolicLink()); rmdirSync(join(existingInstall, "linked")); checkSentinel(); checkTarget(); }
    rmdirSync(existingInstall); unlinkSync(join(junctionTarget, "SENTINEL")); sentinels.delete(join(junctionTarget, "SENTINEL")); rmdirSync(junctionTarget);
    mkdirSync(appLocal, { recursive: true }); symlinkSync(scratchRoaming, toolsDir, "junction");
    const toolsSentinel = join(scratchRoaming, "TOOLS-SENTINEL");
    writeFileSync(toolsSentinel, "linked target survives"); sentinels.set(toolsSentinel, "linked target survives");
    install = join(temp, "tools-linked-install");
    try {
      const before = manifest(scratchRoaming);
      await installVersion(setups[0]); compare("linked tools install");
      assert.ok(lstatSync(toolsDir).isSymbolicLink());
      assert.equal(readFileSync(join(toolsDir, "TOOLS-SENTINEL"), "utf8"), "linked target survives");
      assert.deepEqual(manifest(scratchRoaming), before, "linked tools target untouched by install");
      await uninstall(); compare("linked tools uninstall");
      assert.ok(lstatSync(toolsDir).isSymbolicLink());
      assert.equal(readFileSync(join(toolsDir, "TOOLS-SENTINEL"), "utf8"), "linked target survives");
      assert.deepEqual(manifest(scratchRoaming), before, "linked tools target untouched by uninstall");
      checkSentinel();
      console.log("PASS install and uninstall succeed with linked tools; target and sentinels untouched");
    }
    finally { assert.ok(lstatSync(toolsDir).isSymbolicLink()); rmdirSync(toolsDir); checkSentinel(); unlinkSync(toolsSentinel); sentinels.delete(toolsSentinel); }
    // Test against owned existing paths. The template calls SetOutPath before customInit,
    // so a nonexistent /D child would be created before our rejection callback runs.
    // Never attempt APPDATA itself: a broken guard could affect unrelated applications.
    for (const target of [data, join(data, "empty")]) await refuse(target, "protected directory rejection");
    install = defaultInstall; defaultOwned = true;
    await installVersion(setups[0], true); compare("default-location install");
    await uninstall(); compare("default-location uninstall");
    const spacedParent = join(temp, "p29 O'Connor $ & ; (test) % ^ ` !"); mkdirSync(spacedParent);
    install = join(spacedParent, "installed");
    await installVersion(setups[0]); compare("spaced-path install");
    await uninstall(); compare("spaced-path uninstall");
    install = join(temp, "installed");
    await installVersion(setups[0]); compare("install v1");
    const drainTemp = join(temp, 'installed-shell-drain'); mkdirSync(drainTemp);
    await launchInstalled(join(install, product + ".exe"), drainTemp, { installerDrain: true });
    seedTools();
    const binary = compileFixture(temp);
    const active = (mode, label, operation) => lifecycleWork({ binary, install, temp, mode, label, operation, manifest, setupLog, checkSaved: () => compare(label) });
    const upgrade = () => runScratch(setups[once ? 0 : 1], ["/S", `/D=${install}`]);
    await active('refuse', 'refused-upgrade', upgrade);
    await active('failed', 'failed-drain-upgrade', upgrade);
    if (launch) await launchInstalled(join(install, product + ".exe"), temp);
    // An install over an existing one runs the old uninstaller the way the updater does (--updated, /KEEP_APP_DATA): the tools must survive it.
    const sibling = await fakeWork(binary, install + '2', join(temp, 'sibling-work'), 'refuse');
    try {
      const update = once ? "reinstall over v1" : "upgrade v2";
      await active('graceful', 'active-upgrade', () => installVersion(setups[once ? 0 : 1])); compare(update); toolsKept(update);
      assert.doesNotThrow(() => process.kill(sibling.child.pid, 0));
      assert.equal(existsSync(join(sibling.root, 'requested')), false, 'sibling-prefix process not selected');
    } finally { await sibling.stop(); removeOwnedTree(install + '2'); }
    const uninstallInPlace = () => runScratch(join(install, `Uninstall ${product}.exe`), ["/S", `_?=${install}`]);
    await active('refuse', 'refused-uninstall', uninstallInPlace);
    await active('failed', 'failed-drain-uninstall', uninstallInPlace);
    toolLogOffset = existsSync(setupLog) ? readFileSync(setupLog, 'utf8').length : 0;
    await active('graceful', 'active-uninstall', uninstall); compare("uninstall default"); toolsRemoved("uninstall default");
    await installVersion(setups.at(-1)); compare("reinstall");
    // A link in place of the tools folder is left alone: the folder stays and nothing behind it is touched.
    mkdirSync(outsideLinked); writeFileSync(join(outsideLinked, "canary.txt"), "keep"); symlinkSync(outsideLinked, toolsDir, "junction");
    sentinels.set(join(outsideLinked, "canary.txt"), "keep");
    let rejected = false;
    // _?= keeps this rejection check in the process we await. Without it NSIS's
    // copy-to-temp bootstrap returns 0 before the real uninstaller rejects the switch.
    try { await runScratch(join(install, `Uninstall ${product}.exe`), ["/S", "--delete-app-data", `_?=${install}`]); }
    catch (e) { assert.match(e.message, /exit=2/); rejected = true; }
    assert.ok(rejected, "--delete-app-data was not rejected"); compare("uninstall destructive switch rejected");
    await uninstall(); compare("final uninstall");
    assert.ok(existsSync(join(outsideLinked, "canary.txt")), "a linked tools folder was followed and its target emptied");
    assert.equal(readFileSync(join(outsideLinked, "canary.txt"), "utf8"), "keep", "a linked tools folder was followed");
    const stillLinked = (() => { try { return lstatSync(toolsDir).isSymbolicLink(); } catch { return false; } })();
    assert.ok(stillLinked, "a linked tools folder was removed instead of being left alone"); rmdirSync(toolsDir);
    console.log("PASS final uninstall: a link in place of the tools folder was left alone");
  } catch (e) { failure = e; }
  finally {
    try {
      try { await uninstall(); }
      finally {
        if (junctionCreated) { assert.ok(lstatSync(junction).isSymbolicLink()); rmdirSync(junction); junctionCreated = false; checkSentinel(); }
        if (existsSync(junctionTarget)) {
          const file = join(junctionTarget, "SENTINEL");
          if (sentinels.has(file)) { checkSentinel(); unlinkSync(file); sentinels.delete(file); }
          removeEmptyFolders(junctionTarget);
        }
        if (defaultOwned && existsSync(defaultInstall)) removeOwnedTree(defaultInstall);
      }
      assert.equal(existsSync(defaultInstall), false, "default install folder remains");
      for (const file of seededFiles) if (existsSync(file)) { assert.ok(!lstatSync(file).isSymbolicLink()); unlinkSync(file); console.log(`REMOVED seeded file ${file}`); }
      for (const dir of seededDirs.reverse()) if (existsSync(dir)) { assert.ok(!lstatSync(dir).isSymbolicLink()); assert.equal(readdirSync(dir).length, 0, `unexpected data remains: ${dir}`); rmdirSync(dir); console.log(`REMOVED empty seeded folder ${dir}`); }
      assert.deepEqual(registryKeys(), [], "variant registry cleanup");
      for (const link of shortcuts) assert.equal(existsSync(link), false, `variant shortcut remains: ${link}`);
      for (const target of scratchInstalls) assert.equal(existsSync(target), false, `variant install folder remains: ${target}`);
      // A link left in the scratch tools folder is removed as a link before the tree is, so the tree removal never reaches its target.
      for (const link of [join(toolsDir, 'opencode-v1', 'install-abcdef', 'linked'), toolsLink, toolsDir]) { try { if (lstatSync(link).isSymbolicLink()) rmdirSync(link); } catch { /* no link */ } }
      // The NSIS template keeps a copy of the installer in the REAL shell LocalAppData under the variant's own name (about 440 MB per run): remove that scratch-named folder, exact files first, then the empty folder.
      const updaterDir = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, `${name}-updater`) : "";
      if (updaterDir && existsSync(updaterDir)) {
        assert.ok(!lstatSync(updaterDir).isSymbolicLink() && lstatSync(updaterDir).isDirectory(), `expected the scratch updater folder: ${updaterDir}`);
        for (const leaf of readdirSync(updaterDir)) { const file = join(updaterDir, leaf); assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), `unexpected entry in the scratch updater folder: ${file}`); unlinkSync(file); }
        rmdirSync(updaterDir); console.log(`REMOVED scratch updater folder ${updaterDir}`);
      }
      checkSentinel(); removeOwnedTree(temp); console.log(`REMOVED owned build temp ${temp}; variant registry and shortcuts absent`);
    } catch (e) { failure = failure ? new AggregateError([failure, e], "lifecycle and cleanup failed") : e; }
  }
  if (failure) throw failure;
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--help")) { console.log("Usage: node scripts/pack29-installer-proof.mjs"); process.exit(0); }
  proveInstaller({ launch: process.argv.includes("--launch"), once: process.argv.includes("--once") }).catch((e) => { console.error(e); process.exitCode = 1; });
}
