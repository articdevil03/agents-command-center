import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileFixture, fakeWork, scriptRun, powershell } from '../scripts/installer-fixtures.mjs';
import { removeOwnedTree } from '../scripts/dist-installer.mjs';
import { createCandidate, normalizeWindowsBase } from '../server/settings/opencode/paths.ts';
import { cachedInstallerEnv } from '../scripts/installer-cache.mjs';
import './audit-p9-ownership.ts';
import './audit-p9-drain.ts';
import './audit-p9-server-pattern.ts';

const processScript = process.env.CC_P9_PROCESS_SOURCE ?? 'build/installer-process.ps1';
const toolsScript = process.env.CC_P9_TOOLS_SOURCE ?? 'build/installer-tools.ps1';
// Tests that expect success never race the script's own timeout when the whole suite loads the PC.
const SUCCESS_TIMEOUT = '60000';
let root: string, binary: string;
before(() => {
  assert.ok(existsSync(processScript), 'project-owned process script exists');
  assert.ok(existsSync(toolsScript), 'project-owned ownership cleanup script exists');
  root = mkdtempSync(join(tmpdir(), 'cc-p9-installer-test-'));
  binary = compileFixture(root);
});
after(() => { if (root) removeOwnedTree(root); });

for (const mode of ['graceful', 'refuse', 'failed']) {
  test(`normal closure ${mode}: waits for drain or refuses without changing old files`, async () => {
    const install = join(root, mode), work = await fakeWork(binary, install, join(root, mode + '-work'), mode);
    const before = readFileSync(work.exe);
    try {
      const result = scriptRun(processScript, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe' }, ['-TimeoutMs', mode === 'refuse' ? '3000' : SUCCESS_TIMEOUT, '-Verbose']);
      assert.equal(result.status, mode === 'graceful' ? 0 : 4, result.stdout + result.stderr);
      assert.ok(existsSync(join(work.root, 'requested')), 'normal window close was requested: ' + result.stdout + result.stderr);
      if (mode === 'refuse') {
        assert.equal(work.child.exitCode, null, 'refused process still alive');
        assert.doesNotThrow(() => process.kill(work.child.pid!, 0));
        assert.equal(existsSync(join(work.root, 'drained')), false);
      } else {
        assert.ok(existsSync(join(work.root, 'drained')), 'server drain finished before returning');
        assert.equal(readFileSync(join(work.root, 'drained'), 'utf8'), 'drained');
      }
      assert.deepEqual(readFileSync(work.exe), before, 'no old application bytes changed');
      assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'plain message has no user path');
    } finally { await work.stop(); }
  });
}

test('sibling prefix is never selected, and metacharacter install path stays data', async () => {
  const install = join(root, "O'Connor $ & ; (test) % ^ ` !"), sibling = install + '2';
  const work = await fakeWork(binary, sibling, join(root, 'sibling-work'), 'refuse');
  mkdirSync(install);
  try {
    const result = scriptRun(processScript, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe' }, ['-TimeoutMs', '1000']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotThrow(() => process.kill(work.child.pid!, 0));
    assert.equal(existsSync(join(work.root, 'requested')), false, 'sibling was not asked to close');
    const inside = await fakeWork(binary, install, join(root, 'metachar-work'));
    try {
      const close = scriptRun(processScript, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe' }, ['-TimeoutMs', SUCCESS_TIMEOUT, '-Verbose']);
      assert.equal(close.status, 0, close.stdout + close.stderr);
      assert.ok(existsSync(join(inside.root, 'drained')), 'metacharacter-path server finished draining');
      assert.equal(readFileSync(join(inside.root, 'drained'), 'utf8'), 'drained');
      assert.equal(existsSync(join(work.root, 'requested')), false);
    } finally { await inside.stop(); }
  } finally { await work.stop(); }
});

test('unknown or invalid process identity refuses safely', () => {
  const result = scriptRun(processScript, { CC_INSTALL_DIR: 'relative', CC_INSTALL_EXE: 'cc-p9-fabricated.exe' });
  assert.equal(result.status, 6);
  assert.match(result.stdout, /could not check whether/);
  // A double quote cannot be a Windows filename. It must be refused as data.
  const invalid = scriptRun(processScript, { CC_INSTALL_DIR: root + '";exit 0;#', CC_INSTALL_EXE: 'cc-p9-fabricated.exe' });
  assert.equal(invalid.status, 6);
});

test('a process exiting after the snapshot is accepted, but a changed creation identity is refused', async () => {
  for (const changed of [false, true]) {
    // The identity case uses a shell that refuses to close, so it is really alive on the second pass: no sleeping, no race.
    const install = join(root, 'snapshot-' + changed), work = await fakeWork(binary, install, join(root, 'snapshot-work-' + changed), changed ? 'refuse' : 'graceful');
    const source = readFileSync(processScript, 'utf8');
    const anchor = '        $snapshot = @([CCInstallPath]::Snapshot())';
    assert.equal(source.split(anchor).length - 1, 1, 'snapshot boundary found exactly once');
    const script = join(root, 'snapshot-' + changed + '.ps1');
    writeFileSync(script, source.replace(anchor, anchor + (changed
      ? '\n        if ($tracked.Count -gt 0) { foreach ($row in $snapshot) { if ($tracked.ContainsKey([int]$row.ProcessId) -and -not $tracked[[int]$row.ProcessId].HasExited) { $row.CreationDate = $row.CreationDate.AddSeconds(1) } } }'
      : '\n        if ($requested.Count -gt 0) { Start-Sleep -Milliseconds 700 }')));
    try {
      const result = scriptRun(script, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe' }, ['-TimeoutMs', SUCCESS_TIMEOUT, '-Verbose']);
      assert.equal(result.status, changed ? 4 : 0, result.stdout + result.stderr);
      if (changed) assert.match(result.stdout, /Process identity changed/);
      else assert.equal(readFileSync(join(work.root, 'drained'), 'utf8'), 'drained');
    } finally { await work.stop(); }
  }
});

test('unreadable identity of a matching live process refuses without requesting closure', async () => {
  const install = join(root, 'unknown-identity'), work = await fakeWork(binary, install, join(root, 'unknown-work'));
  try {
  const script = join(root, 'unknown-process.ps1');
  const source = readFileSync(processScript, 'utf8');
  const anchor = '            if (-not $row.ExecutablePath) {';
  assert.equal(source.split(anchor).length - 1, 1, 'snapshot trust boundary found exactly once');
  writeFileSync(script, source.replace(anchor, `            if ($row.Name -eq $env:CC_INSTALL_EXE) { $row.ExecutablePath = $null }\n${anchor}`));
    const result = scriptRun(script, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe' }, ['-TimeoutMs', '1000']);
    assert.equal(result.status, 4, result.stdout + result.stderr);
    assert.equal(existsSync(join(work.root, 'requested')), false);
    assert.doesNotThrow(() => process.kill(work.child.pid!, 0));
  } finally { await work.stop(); }
});

test('in-place setup excludes only its verified caller PID and refuses a mismatched caller', () => {
  const install = join(root, 'in-place-setup'); mkdirSync(install);
  const caller = join(install, 'cc-p9-setup.exe'); copyFileSync(process.execPath, caller);
  const bridge = `const {spawnSync}=require('node:child_process'); const r=spawnSync(process.env.CC_P9_PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',process.env.CC_P9_SCRIPT,'-TimeoutMs','1000'],{encoding:'utf8',env:{...process.env,CC_SETUP_PID:String(process.pid)}}); process.stdout.write(r.stdout+r.stderr); process.exit(r.status ?? 9);`;
  const run = spawnSync(caller, ['-e', bridge], { encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, CC_P9_PS: powershell, CC_P9_SCRIPT: resolve(processScript), CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe' } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const mismatch = scriptRun(processScript, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe', CC_SETUP_PID: '1' }, ['-TimeoutMs', '1000']);
  assert.equal(mismatch.status, 6, mismatch.stdout + mismatch.stderr);
});

test('ownership is written by the real candidate setter; cleanup preserves foreign and malformed entries and link targets', async () => {
  const local = join(root, "owned O'Connor $ & ; (x) % ^ ` !"); mkdirSync(local);
  const candidate = await createCandidate({ LOCALAPPDATA: local });
  assert.ok(existsSync(join(candidate.dir, '.command-center-owner.json')), 'real candidate setter writes ownership');
  const record = JSON.parse(readFileSync(join(candidate.dir, '.command-center-owner.json'), 'utf8'));
  assert.deepEqual(record, { owner: 'com.agents.command-center', format: 1, tool: 'opencode', entry: candidate.dir.slice(candidate.root.length + 1) });
  writeFileSync(join(candidate.dir, 'opencode.exe'), 'owned');
  const tools = join(local, 'Command Center', 'tools'), target = join(root, 'external-target'); mkdirSync(target);
  writeFileSync(join(target, 'SENTINEL'), 'preserve target');
  writeFileSync(join(tools, 'SENTINEL'), 'preserve tools sentinel');
  const foreign = join(tools, 'foreign'); mkdirSync(foreign); writeFileSync(join(foreign, 'value'), 'foreign');
  const malformed = join(candidate.root, 'install-abcdef'); mkdirSync(malformed);
  writeFileSync(join(malformed, '.command-center-owner.json'), '{broken');
  const missing = join(candidate.root, 'install-abcd'); mkdirSync(missing); writeFileSync(join(missing, 'opencode.exe'), 'foreign lookalike');
  const wrongOwner = join(candidate.root, 'install-fedcba'); mkdirSync(wrongOwner);
  const wrongRecord = JSON.stringify({ owner: 'another-product', format: 1, tool: 'opencode', entry: 'install-fedcba' });
  writeFileSync(join(wrongOwner, '.command-center-owner.json'), wrongRecord);
  const wrongType = join(candidate.root, 'install-aaaccc'); mkdirSync(wrongType);
  writeFileSync(join(wrongType, '.command-center-owner.json'), JSON.stringify({ owner: 'com.agents.command-center', format: '1', tool: 'opencode', entry: 'install-aaaccc' }));
  const insideLink = join(candidate.dir, 'linked'), rootLink = join(tools, 'copilot');
  symlinkSync(target, insideLink, 'junction'); symlinkSync(target, rootLink, 'junction');
  try {
    const result = scriptRun(toolsScript, { LOCALAPPDATA: local.replaceAll('\\', '/') + '/' });
    assert.equal(result.status, 5, result.stdout + result.stderr);
    assert.equal(existsSync(candidate.dir), false, 'positively owned candidate removed');
    assert.equal(readFileSync(join(target, 'SENTINEL'), 'utf8'), 'preserve target');
    assert.equal(readFileSync(join(tools, 'SENTINEL'), 'utf8'), 'preserve tools sentinel');
    assert.equal(readFileSync(join(foreign, 'value'), 'utf8'), 'foreign');
    assert.equal(readFileSync(join(malformed, '.command-center-owner.json'), 'utf8'), '{broken');
    assert.equal(readFileSync(join(missing, 'opencode.exe'), 'utf8'), 'foreign lookalike');
    assert.ok(existsSync(wrongOwner), 'valid foreign ownership must be preserved');
    assert.ok(existsSync(wrongType), 'malformed ownership types must be preserved');
    assert.equal(readFileSync(join(wrongOwner, '.command-center-owner.json'), 'utf8'), wrongRecord);
    assert.match(result.stdout, /Some tool files were kept/);
  } finally { rmdirSync(rootLink); if (existsSync(insideLink)) rmdirSync(insideLink); }
});

test('Windows base normalization agrees for forward, mixed, trailing and UNC strings', () => {
  for (const value of ['C:/', 'C:/Users/x/AppData/Local/', 'C:\\Users/x\\AppData/Local\\', '\\\\server\\share\\local\\', '//server/share/local/', "C:/O'Connor $ & ; (x) % ^ ` !/"]) {
    const normalized = normalizeWindowsBase(value);
    const result = scriptRun(toolsScript, { LOCALAPPDATA: value }, ['-NormalizeOnly']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), normalized, value);
  }
  for (const value of ['relative', 'C:relative', '";exit 0;#', '\\\\server']) {
    assert.equal(normalizeWindowsBase(value), null);
    assert.equal(scriptRun(toolsScript, { LOCALAPPDATA: value }, ['-NormalizeOnly']).status, 5);
  }
  const inaccessible = scriptRun(toolsScript, { LOCALAPPDATA: join(root, 'absent-base') });
  assert.equal(inaccessible.status, 5);
  assert.match(inaccessible.stdout, /Some tool files were kept/);
});

test('cleanup permits a relocated base and refuses links at either owned boundary', async () => {
  const target = join(root, 'relocated-base'), alias = join(root, 'relocated-alias'); mkdirSync(target);
  symlinkSync(target, alias, 'junction');
  try {
    const candidate = await createCandidate({ LOCALAPPDATA: alias });
    writeFileSync(join(candidate.dir, 'opencode.exe'), 'owned');
    const removed = scriptRun(toolsScript, { LOCALAPPDATA: alias });
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(existsSync(candidate.dir), false);
  } finally { rmdirSync(alias); }
  const external = join(root, 'boundary-target'); mkdirSync(external); writeFileSync(join(external, 'SENTINEL'), 'keep');
  for (const boundary of ['app', 'tools']) {
    const base = join(root, 'boundary-' + boundary); mkdirSync(base);
    const app = join(base, 'Command Center');
    if (boundary === 'tools') mkdirSync(app);
    const link = boundary === 'app' ? app : join(app, 'tools'); symlinkSync(external, link, 'junction');
    try {
      const result = scriptRun(toolsScript, { LOCALAPPDATA: base });
      assert.equal(result.status, 5, result.stdout + result.stderr);
      assert.equal(readFileSync(join(external, 'SENTINEL'), 'utf8'), 'keep');
      assert.ok(existsSync(link), 'linked boundary is preserved');
    } finally { rmdirSync(link); }
  }
});

test('offline localhost UNC cleanup uses the same ownership policy when the share is accessible', async (t) => {
  const base = join(root, 'unc-base'); mkdirSync(base);
  const unc = `\\\\localhost\\${base[0]}$${base.slice(2)}`;
  if (!existsSync(unc)) { t.skip('Offline localhost administrative share unavailable; UNC string normalization tested separately'); return; }
  const candidate = await createCandidate({ LOCALAPPDATA: unc });
  writeFileSync(join(candidate.dir, 'opencode.exe'), 'inert UNC fixture');
  const result = scriptRun(toolsScript, { LOCALAPPDATA: unc });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(candidate.dir), false);
});

test('locked owned files report leftovers and retain ownership for a successful retry', async () => {
  const local = join(root, 'locked-local'); mkdirSync(local);
  const candidate = await createCandidate({ LOCALAPPDATA: local });
  const executable = join(candidate.dir, 'opencode.exe'); writeFileSync(executable, 'inert locked file');
  const wrapper = join(root, 'hold-file.ps1');
  writeFileSync(wrapper, `$ErrorActionPreference='Stop'\n$handle=[IO.File]::Open($env:CC_LOCK_FILE, 'Open', 'Read', 'None')\ntry { & "$PSHOME\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $env:CC_TOOLS_SCRIPT; exit $LASTEXITCODE } finally { $handle.Dispose() }\n`);
  const result = scriptRun(wrapper, { LOCALAPPDATA: local, CC_LOCK_FILE: executable, CC_TOOLS_SCRIPT: resolve(toolsScript) });
  assert.equal(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, /Some tool files were kept/);
  assert.equal(readFileSync(executable, 'utf8'), 'inert locked file');
  assert.ok(existsSync(join(candidate.dir, '.command-center-owner.json')), 'failed cleanup retains ownership');
  const retry = scriptRun(toolsScript, { LOCALAPPDATA: local });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(existsSync(candidate.dir), false);
});

test('NSIS embeds scripts at compile time, passes install paths through environment, and aborts before template termination', () => {
  const hook = readFileSync('build/installer-lifecycle.nsh', 'utf8');
  assert.match(hook, /!macro customCheckAppRunning/);
  assert.match(hook, /SetEnvironmentVariableW\(w "CC_INSTALL_DIR", w "\$INSTDIR"\)/);
  for (const script of ['installer-process.ps1', 'installer-tools.ps1']) {
    assert.ok(hook.includes(`"\${BUILD_RESOURCES_DIR}\\${script}"`));
    assert.ok(hook.includes(`-File "$PLUGINSDIR\\${script}"`));
  }
  assert.match(hook, /SetErrorLevel 4\s+Quit/);
  assert.doesNotMatch(hook, /taskkill|Stop-Process|-Command|cmd\.exe/);
  assert.ok(readFileSync('build/installer.nsh', 'utf8').includes('!include "${BUILD_RESOURCES_DIR}\\installer-lifecycle.nsh"'));
});

test('installer proof requires cached tool overrides before starting any build or download', () => {
  const cache = join(root, 'fake-cache'); mkdirSync(cache);
  assert.throws(() => cachedInstallerEnv(cache));
  for (const directory of ['nsis-3.0.4.1/Bin', 'nsis-resources-3.4.1/plugins', '7zip@1.0.0/7zip-win-x64/bin']) mkdirSync(join(cache, directory), { recursive: true });
  for (const file of ['nsis-3.0.4.1/Bin/makensis.exe', '7zip@1.0.0/7zip-win-x64/bin/7za.exe']) writeFileSync(join(cache, file), 'inert fixture');
  const env = cachedInstallerEnv(cache);
  assert.equal(env.ELECTRON_BUILDER_NSIS_DIR, join(cache, 'nsis-3.0.4.1'));
  assert.equal(env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR, join(cache, 'nsis-resources-3.4.1'));
  assert.equal(env.ELECTRON_BUILDER_7ZIP_PATH, join(cache, '7zip@1.0.0/7zip-win-x64/bin/7za.exe'));
});

test('installer proof resolves suffixed cached bundles without modifying or downloading them', () => {
  const cache = join(root, 'nested-cache'); mkdirSync(cache);
  for (const directory of ['nsis-3.0.4.1/nsis-3.0.4.1-abc/Bin', 'nsis-resources-3.4.1/nsis-resources-3.4.1-abc/plugins', '7zip@1.0.0/7zip-win-x64-abc/bin']) mkdirSync(join(cache, directory), { recursive: true });
  for (const file of ['nsis-3.0.4.1/nsis-3.0.4.1-abc/Bin/makensis.exe', '7zip@1.0.0/7zip-win-x64-abc/bin/7za.exe']) writeFileSync(join(cache, file), 'inert fixture');
  let env: ReturnType<typeof cachedInstallerEnv>;
  assert.doesNotThrow(() => { env = cachedInstallerEnv(cache); }, 'suffixed cached bundles must resolve without a cache miss');
  assert.equal(env!.ELECTRON_BUILDER_NSIS_DIR, join(cache, 'nsis-3.0.4.1/nsis-3.0.4.1-abc'));
  assert.equal(env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR, join(cache, 'nsis-resources-3.4.1/nsis-resources-3.4.1-abc'));
  assert.equal(env.ELECTRON_BUILDER_7ZIP_PATH, join(cache, '7zip@1.0.0/7zip-win-x64-abc/bin/7za.exe'));
  mkdirSync(join(cache, 'nsis-3.0.4.1/nsis-3.0.4.1-other/Bin'), { recursive: true });
  writeFileSync(join(cache, 'nsis-3.0.4.1/nsis-3.0.4.1-other/Bin/makensis.exe'), 'inert fixture');
  assert.throws(() => cachedInstallerEnv(cache), /ambiguous/);
});
