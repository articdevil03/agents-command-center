import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { scriptRun } from '../scripts/installer-fixtures.mjs';
import { removeOwnedTree } from '../scripts/dist-installer.mjs';

const source = process.env.CC_P9_TOOLS_SOURCE ?? 'build/installer-tools.ps1';
const markerName = '.command-center-owner.json';
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'cc-p9-ownership-'));
  t.after(() => removeOwnedTree(root));
  const folder = join(root, 'Command Center/tools/opencode-v1'); mkdirSync(folder, { recursive: true });
  const entry = join(folder, 'install-abcd'); mkdirSync(entry);
  const record = { owner: 'com.agents.command-center', tool: 'opencode', format: 1, entry: 'install-abcd' };
  const marker = join(entry, markerName); writeFileSync(marker, JSON.stringify(record));
  return { root, folder, entry, marker, record };
}

for (const mode of ['tool', 'entry', 'format', 'extra', 'directory', 'link', 'oversize', 'entry-junction']) {
  test(`forged ownership ${mode} preserves the folder and reports leftovers`, (t) => {
    const f = fixture(t), unlink: string[] = [];
    let check = source;
    // Remove our exact regular marker before constructing directory/junction fixtures.
    if (['directory', 'link', 'entry-junction'].includes(mode)) {
      unlinkSync(f.marker);
      if (mode === 'entry-junction') rmdirSync(f.entry);
    }
    if (mode === 'directory') mkdirSync(f.marker);
    else if (mode === 'link' || mode === 'entry-junction') {
      const target = join(f.root, 'target'); mkdirSync(target);
      writeFileSync(join(target, 'SENTINEL'), 'keep');
      writeFileSync(join(target, markerName), JSON.stringify(f.record));
      const targetFile = join(target, 'record.json'); writeFileSync(targetFile, JSON.stringify(f.record));
      const link = mode === 'link' ? f.marker : f.entry;
      symlinkSync(target, link, 'junction'); unlink.push(link);
      if (mode === 'link') {
        // Windows file symlinks need privileges unavailable to the sandbox. Inject
        // a file-link's metadata at the actual marker boundary, retaining a real link target.
        const original = readFileSync(source, 'utf8');
        const anchor = "$marker = Get-Entry (Join-Path $entry.FullName '.command-center-owner.json')";
        assert.equal(original.split(anchor).length - 1, 1);
        check = join(f.root, 'file-link.ps1');
        writeFileSync(check, original.replace(anchor, anchor + '\n                if ($marker) { $marker = [PSCustomObject]@{PSIsContainer=$false; Length=100; Attributes=[IO.FileAttributes]::ReparsePoint; FullName=(Join-Path $marker.FullName "record.json")} }'));
      }
    } else if (mode === 'oversize') writeFileSync(f.marker, JSON.stringify(f.record) + ' '.repeat(4096));
    else if (!['directory'].includes(mode)) writeFileSync(f.marker, JSON.stringify({ ...f.record,
      ...(mode === 'tool' ? { tool: 'copilot' } : mode === 'entry' ? { entry: 'install-ffff' } : mode === 'format' ? { format: 2 } : mode === 'extra' ? { extra: true } : {}) }));
    if (['directory', 'link', 'oversize'].includes(mode)) {
      const original = readFileSync(check, 'utf8'), anchor = '$record = [IO.File]::ReadAllText($marker.FullName)';
      assert.equal(original.split(anchor).length - 1, 1, 'marker read boundary FOUND');
      check = join(f.root, 'observe-marker.ps1');
      writeFileSync(check, original.replace(anchor, '[IO.File]::WriteAllText($env:CC_READ_OBSERVER,"read"); ' + anchor));
    }
    try {
      const result = scriptRun(check, { LOCALAPPDATA: f.root, CC_READ_OBSERVER: join(f.root, 'marker-read') });
      assert.equal(result.status, 5, result.stdout + result.stderr);
      assert.match(result.stdout, /Some tool files were kept/);
      assert.equal(existsSync(f.entry), true, `${mode}: forged folder preserved`);
      if (['directory', 'link', 'oversize'].includes(mode)) assert.equal(existsSync(join(f.root, 'marker-read')), false, 'unsafe marker must not be opened');
      if (unlink.length) assert.equal(readFileSync(join(f.root, 'target/SENTINEL'), 'utf8'), 'keep');
    } finally { for (const link of unlink) { if (existsSync(link)) { assert.ok(lstatSync(link).isSymbolicLink()); rmdirSync(link); } } }
  });
}

for (const mode of ['valid', 'foreign-entry', 'version', 'extra', 'escape', 'foreign-executable', 'large', 'directory', 'link']) {
  test(`active descriptor ${mode} is removed only for an owned removed entry`, (t) => {
    const f = fixture(t), active = join(f.folder, 'active.json');
    const descriptor = { version: mode === 'version' ? '2.0.0' : '1.2.3', executable: mode === 'foreign-entry' ? 'install-ffff/opencode.exe' : mode === 'escape' ? '../opencode.exe' : mode === 'foreign-executable' ? 'install-abcd/foreign.exe' : 'install-abcd/opencode.exe', ...(mode === 'extra' ? { extra: true } : {}) };
    if (mode === 'directory') mkdirSync(active);
    else if (mode === 'link') { const target = join(f.root, 'target'); mkdirSync(target); writeFileSync(join(target, 'record.json'), JSON.stringify(descriptor)); symlinkSync(target, active, 'junction'); }
    else writeFileSync(active, JSON.stringify(descriptor) + (mode === 'large' ? ' '.repeat(4096) : ''));
    let original = readFileSync(source, 'utf8');
    if (mode === 'link') {
      const boundary = '            if ($active -and';
      assert.equal(original.split(boundary).length - 1, 1, 'active metadata boundary FOUND');
      original = original.replace(boundary, '            $active = [PSCustomObject]@{PSIsContainer=$false; Length=100; Attributes=[IO.FileAttributes]::ReparsePoint; FullName=(Join-Path $active.FullName "record.json")}\n' + boundary);
    }
    const anchor = '$descriptor = [IO.File]::ReadAllText($active.FullName)';
    assert.equal(original.split(anchor).length - 1, 1);
    const check = join(f.root, 'observe-active.ps1');
    writeFileSync(check, original.replace(anchor, '[IO.File]::WriteAllText($env:CC_READ_OBSERVER,"read"); ' + anchor));
    try {
      const result = scriptRun(check, { LOCALAPPDATA: f.root, CC_READ_OBSERVER: join(f.root, 'active-read') });
      assert.equal(result.status, mode === 'valid' ? 0 : 5, result.stdout + result.stderr);
      assert.equal(existsSync(active), mode !== 'valid', 'foreign or malformed active descriptor preserved');
      if (['large', 'directory', 'link'].includes(mode)) assert.equal(existsSync(join(f.root, 'active-read')), false, 'unsafe active descriptor must not be opened');
    } finally { if (mode === 'link') rmdirSync(active); }
  });
}

test('strict UUID temporary descriptors are removed; lookalike names are preserved', (t) => {
  for (const valid of [true, false]) {
    const f = fixture(t), name = valid ? 'active-12345678-1234-1234-1234-123456789abc.tmp' : 'active-foreign.tmp';
    const file = join(f.folder, name);
    writeFileSync(file, JSON.stringify({ version: '1.2.3', executable: 'install-abcd/opencode.exe' }));
    const result = scriptRun(source, { LOCALAPPDATA: f.root });
    assert.equal(result.status, valid ? 0 : 5, result.stdout + result.stderr);
    assert.equal(existsSync(file), !valid);
  }
});

test('failed final empty-folder deletion restores ownership and can retry', (t) => {
  const f = fixture(t), injected = join(f.root, 'last-delete.ps1');
  const original = readFileSync(source, 'utf8'), anchor = 'try { [IO.Directory]::Delete($Path, $false) }';
  assert.equal(original.split(anchor).length - 1, 1, 'final folder deletion FOUND');
  writeFileSync(injected, original.replace(anchor, "try { if ($Path -eq $env:CC_FAIL_DELETE) { throw 'Simulated final directory delete denied' }; [IO.Directory]::Delete($Path, $false) }"));
  const result = scriptRun(injected, { LOCALAPPDATA: f.root, CC_FAIL_DELETE: f.entry });
  assert.equal(result.status, 5, result.stdout + result.stderr);
  assert.equal(existsSync(f.marker), true, 'final failure retains marker for retry');
  assert.deepEqual(JSON.parse(readFileSync(f.marker, 'utf8')), f.record, 'final failure leaves entry marked');
  const retry = scriptRun(source, { LOCALAPPDATA: f.root });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(existsSync(f.entry), false);
});
