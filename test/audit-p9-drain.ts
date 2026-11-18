import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileFixture, fakeWork, scriptRun } from '../scripts/installer-fixtures.mjs';
import { removeOwnedTree } from '../scripts/dist-installer.mjs';

// Success-path tests never race the script's own timeout under whole-suite load; only a dedicated timeout test uses a short one.
const SUCCESS_TIMEOUT = '60000';
const source = process.env.CC_P9_PROCESS_SOURCE ?? 'build/installer-process.ps1';
let root: string, binary: string;
before(() => { root = mkdtempSync(join(tmpdir(), 'cc-p9-drain-')); binary = compileFixture(root); });
after(() => { if (root) removeOwnedTree(root); });

test('process API failures recover only after confirmed exit, including access errors', () => {
  const original = readFileSync(source, 'utf8');
  const start = original.indexOf('function Test-ProcessExited('), end = original.indexOf('$failureCode = 6');
  assert.ok(start >= 0 && end > start, 'race-safe process helpers FOUND');
  const check = join(root, 'process-api-errors.ps1');
  writeFileSync(check, "$ErrorActionPreference='Stop'\n" + original.slice(start, end) + `
foreach ($exited in @($true, $false)) {
    $proc = [pscustomobject]@{ HasExited = $exited }
    foreach ($kind in @('invalid', 'access')) {
        $caught = $false; $recovered = $false
        try {
            $recovered = Invoke-ProcessCall $proc {
                if ($kind -eq 'access') { throw [ComponentModel.Win32Exception]::new(5) }
                throw [InvalidOperationException]::new('process exited')
            } { $true }
        } catch { $caught = $true }
        if ($exited -and (-not $recovered -or $caught)) { throw 'Exited process did not recover' }
        if (-not $exited -and (-not $caught -or $recovered)) { throw 'Live process failure was ignored' }
    }
}
$unknown = New-Object PSObject
$unknown | Add-Member ScriptProperty HasExited { throw [InvalidOperationException]::new('state unknown') }
$caught = $false
try { Invoke-ProcessCall $unknown { throw [InvalidOperationException]::new('operation failed') } { $true } } catch { $caught = $true }
if (-not $caught) { throw 'Unknown process state was ignored' }
Write-Output 'exited recovered; live and unknown refused'
`);
  const result = scriptRun(check, {});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /exited recovered; live and unknown refused/);
});

test('a process exiting immediately before CloseMainWindow is accepted; a live close failure refuses', async () => {
  for (const mode of ['graceful', 'failed', 'live']) {
    const exited = mode !== 'live';
    const install = join(root, 'close-race-' + mode);
    const work = await fakeWork(binary, install, join(root, 'close-race-work-' + mode), mode === 'live' ? 'graceful' : mode);
    const original = readFileSync(source, 'utf8');
    const anchor = 'Request-Close $proc';
    assert.equal(original.split(anchor).length - 1, 1, 'close call FOUND exactly once');
    const check = join(root, 'close-race-' + mode + '.ps1');
    // Test copy only: normal close and a retained-handle wait make the exit
    // deterministic before the real close call, without a production test hook.
    const injected = exited
      ? "$null = $proc.CloseMainWindow(); if (-not $proc.WaitForExit(10000)) { throw 'Fixture did not exit' }; $proc.Refresh(); "
      : "throw [InvalidOperationException]::new('Simulated live close failure'); ";
    writeFileSync(check, original.replace(anchor, injected + anchor));
    try {
      const result = scriptRun(check, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe' }, ['-TimeoutMs', SUCCESS_TIMEOUT, '-Verbose']);
      assert.equal(result.status, mode === 'graceful' ? 0 : 4, mode + ': ' + result.stdout + result.stderr);
      if (exited) assert.equal(readFileSync(join(work.root, 'drained'), 'utf8'), 'drained');
      else {
        assert.match(result.stdout, /Simulated live close failure/);
        assert.doesNotThrow(() => process.kill(work.child.pid!, 0), 'live failure must leave the process alone');
        assert.equal(existsSync(join(work.root, 'requested')), false);
      }
    } finally { await work.stop(); }
  }
});

test('outside descendant window stays alive and never receives a close request', async () => {
  const outside = join(root, 'outside'); mkdirSync(outside);
  const exe = join(outside, 'outside.exe'); copyFileSync(binary, exe);
  const install = join(root, 'installed'), work = await fakeWork(binary, install, join(root, 'work'), 'outside', exe);
  try {
    const result = scriptRun(source, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe' }, ['-TimeoutMs', SUCCESS_TIMEOUT, '-Verbose']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /outside: ignored/);
    assert.equal(existsSync(join(work.root, 'outside-requested')), false, 'outside window must not receive CloseMainWindow');
    assert.doesNotThrow(() => process.kill(work.pids[2]!, 0), 'outside descendant left alive');
  } finally { await work.stop(); }
});

test('an inside helper nonzero exit is allowed; only server drain code 1 refuses', async () => {
  const install = join(root, 'helper-install'), work = await fakeWork(binary, install, join(root, 'helper-work'), 'helper-failed');
  try {
    const result = scriptRun(source, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe' }, ['-TimeoutMs', SUCCESS_TIMEOUT, '-Verbose']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /inside: exit=7/);
  } finally { await work.stop(); }
});

test('an unreadable outside descendant with a different image is ignored', async () => {
  const outside = join(root, 'unreadable-outside'); mkdirSync(outside);
  const exe = join(outside, 'outside.exe'); copyFileSync(binary, exe);
  const install = join(root, 'unreadable-installed'), work = await fakeWork(binary, install, join(root, 'unreadable-work'), 'outside', exe);
  try {
  const original = readFileSync(source, 'utf8'), anchor = '            if (-not $row.ExecutablePath) {';
  assert.equal(original.split(anchor).length - 1, 1);
  const check = join(root, 'unreadable.ps1');
  writeFileSync(check, original.replace(anchor, "            if ($row.Name -eq 'outside.exe') { $row.ExecutablePath = $null }\n" + anchor));
    const result = scriptRun(check, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe' }, ['-TimeoutMs', SUCCESS_TIMEOUT]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(join(work.root, 'outside-requested')), false);
    assert.doesNotThrow(() => process.kill(work.pids[2]!, 0));
  } finally { await work.stop(); }
});

test('inspection failure has its own code and plain NSIS message before changing files', () => {
  const broken = join(root, 'blocked.ps1');
  const original = readFileSync(source, 'utf8');
  const anchor = "    Add-Type @'";
  assert.equal(original.split(anchor).length - 1, 1);
  writeFileSync(broken, original.replace(anchor, "    throw 'Simulated blocked compiler'\n" + anchor));
  const result = scriptRun(broken, { CC_INSTALL_DIR: root });
  assert.equal(result.status, 6, result.stdout + result.stderr);
  assert.match(result.stdout, /Setup could not check whether Command Center is running/);
  assert.doesNotMatch(result.stdout, /close Command Center|Keep your work open/i);
  const hook = readFileSync('build/installer-lifecycle.nsh', 'utf8');
  assert.match(hook, /\$R0 != 4[\s\S]*Process check could not run, exit=\$R0[\s\S]*SetErrorLevel 6\s+Quit/);
  assert.match(hook, /Deliberately refuse uninstall too/);
  assert.match(hook, /SetErrorLevel 4\s+Quit/);
});

test('a reused exited PID is ignored outside; a new inside image refuses without closing it', async () => {
  for (const inside of [false, true]) {
    const install = join(root, 'reuse-install-' + inside), work = await fakeWork(binary, install, join(root, 'reuse-work-' + inside));
    const original = readFileSync(source, 'utf8'), anchor = '        $snapshot = @([CCInstallPath]::Snapshot())';
    assert.equal(original.split(anchor).length - 1, 1);
    const check = join(root, 'reused-' + inside + '.ps1');
    writeFileSync(check, original.replace(anchor, anchor + `
        if ($requested.Count -gt 0) {
            Start-Sleep -Milliseconds 700
            foreach ($id in @($tracked.Keys)) {
                if ($tracked[$id].HasExited) {
                    $replacement = New-Object CCInstallPath+ProcessRow
                    $replacement.ProcessId = $id
                    $replacement.CreationDate = [DateTime]::UtcNow
                    $replacement.Name = 'replacement.exe'
                    $replacement.ExecutablePath = $env:CC_REUSED_IMAGE
                    $snapshot += $replacement
                }
            }
        }`));
    try {
      const result = scriptRun(check, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe', CC_REUSED_IMAGE: inside ? work.exe : binary }, ['-TimeoutMs', SUCCESS_TIMEOUT, '-Verbose']);
      assert.equal(result.status, inside ? 4 : 0, result.stdout + result.stderr);
      if (inside) assert.match(result.stdout, /New application process identity/);
    } finally { await work.stop(); }
  }
});

// Fabricated windows for exit-timing races. Each edits a COPY of the real script at one anchor.
const countOnce = (text: string, anchor: string) => { assert.equal(text.split(anchor).length - 1, 1, 'anchor found exactly once: ' + anchor); };
const aliveAnchor = '        if ($alive.Count -eq 0) {';

test('a server that exits with the drain code after the exit pass and before the final check still refuses', async () => {
  for (const mode of ['failed', 'graceful']) {
    const install = join(root, 'late-' + mode), work = await fakeWork(binary, install, join(root, 'late-work-' + mode), mode);
    const original = readFileSync(source, 'utf8');
    countOnce(original, aliveAnchor);
    const check = join(root, 'late-' + mode + '.ps1');
    // Wait here, after the exit pass and the close request, until every tracked inside process has really exited.
    writeFileSync(check, original.replace(aliveAnchor, `        $waitEnd = [DateTime]::UtcNow.AddSeconds(20)
        while ([DateTime]::UtcNow -lt $waitEnd -and @($tracked.Keys | Where-Object { $closeable.ContainsKey($_) -and -not $tracked[$_].HasExited }).Count -gt 0) { Start-Sleep -Milliseconds 50 }
        $alive = @($tracked.Keys | Where-Object { $closeable.ContainsKey($_) -and -not $tracked[$_].HasExited })
${aliveAnchor}`));
    try {
      const result = scriptRun(check, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe' }, ['-TimeoutMs', SUCCESS_TIMEOUT, '-Verbose']);
      assert.equal(result.status, mode === 'failed' ? 4 : 0, mode + ': ' + result.stdout + result.stderr);
      if (mode === 'failed') assert.match(result.stdout, /could not close safely/);
      else assert.equal(readFileSync(join(work.root, 'drained'), 'utf8'), 'drained');
    } finally { await work.stop(); }
  }
});

test('a PID first tracked outside that is reused by a new image inside the install refuses', async () => {
  const outside = join(root, 'reuse-outside'); mkdirSync(outside);
  const exe = join(outside, 'outside.exe'); copyFileSync(binary, exe);
  const install = join(root, 'reuse-out-install'), work = await fakeWork(binary, install, join(root, 'reuse-out-work'), 'outside', exe);
  const original = readFileSync(source, 'utf8'), snapshotAnchor = '        $snapshot = @([CCInstallPath]::Snapshot())';
  countOnce(original, snapshotAnchor); countOnce(original, aliveAnchor);
  const check = join(root, 'reuse-outside.ps1');
  // First pass: keep the loop going and end the tracked outside descendant. Next pass: its PID shows a new in-folder image.
  writeFileSync(check, original.replace(snapshotAnchor, snapshotAnchor + `
        foreach ($id in @($ended.Keys)) {
            $replacement = New-Object CCInstallPath+ProcessRow
            $replacement.ProcessId = $id
            $replacement.CreationDate = [DateTime]::UtcNow
            $replacement.Name = 'replacement.exe'
            $replacement.ExecutablePath = $env:CC_REUSED_IMAGE
            $snapshot += $replacement
        }`).replace(aliveAnchor, `        if (-not $forced) {
            $forced = $true; $alive = @($alive) + 0
            foreach ($id in @($tracked.Keys)) { if (-not $closeable.ContainsKey($id)) { $tracked[$id].Kill(); $tracked[$id].WaitForExit(); $ended[$id] = $true } }
        }
${aliveAnchor}`).replace('    $requested = @{}\n', '    $requested = @{}\n    $ended = @{}\n'));
  try {
    const result = scriptRun(check, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe', CC_REUSED_IMAGE: work.exe }, ['-TimeoutMs', SUCCESS_TIMEOUT, '-Verbose']);
    assert.equal(result.status, 4, result.stdout + result.stderr);
    assert.match(result.stdout, /could not close safely/);
  } finally { await work.stop(); }
});

// Slice of the real script holding the process helpers (Test-ProcessExited, Invoke-ProcessCall, Request-Close, Get-TrackedProcess).
function helperScript(body: string) {
  const original = readFileSync(source, 'utf8');
  const start = original.indexOf('function Test-ProcessExited('), end = original.indexOf('$failureCode = 6');
  assert.ok(start >= 0 && end > start, 'race-safe process helpers FOUND');
  return "$ErrorActionPreference='Stop'\n" + original.slice(start, end) + body;
}

test('a close call that returns false refuses only while the process is still running', () => {
  const check = join(root, 'request-close.ps1');
  writeFileSync(check, helperScript(`
function Try-Close($exited, $result) {
    $proc = [pscustomobject]@{ HasExited = $exited }
    $proc | Add-Member ScriptMethod CloseMainWindow ({ $result }).GetNewClosure()
    try { Request-Close $proc; return 'accepted' } catch { return $_.Exception.Message }
}
$exitedFalse = Try-Close $true $false
$liveFalse = Try-Close $false $false
$liveTrue = Try-Close $false $true
if ($exitedFalse -ne 'accepted') { throw "Exited process was refused: $exitedFalse" }
if ($liveFalse -ne 'Application refused closure') { throw "Live process without a close was accepted: $liveFalse" }
if ($liveTrue -ne 'accepted') { throw "Honoured close was refused: $liveTrue" }
$unknown = New-Object PSObject
$unknown | Add-Member ScriptProperty HasExited { throw [InvalidOperationException]::new('state unknown') }
$unknown | Add-Member ScriptMethod CloseMainWindow { $false }
$refused = $false
try { Request-Close $unknown } catch { $refused = $true }
if (-not $refused) { throw 'Unknown process state was accepted' }
Write-Output 'false from exited accepted; live false refused'
`));
  const result = scriptRun(check, {});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /false from exited accepted; live false refused/);
});

// A server that exits between the snapshot row and its handle being taken: the test copy cannot obtain the process object for one PID.
async function runWithMissingHandle(mode: string, pickPid: (pids: number[]) => number) {
  const install = join(root, 'gone-' + mode), work = await fakeWork(binary, install, join(root, 'gone-work-' + mode), mode);
  const original = readFileSync(source, 'utf8'), anchor = '        $snapshot = @([CCInstallPath]::Snapshot())';
  countOnce(original, anchor);
  const check = join(root, 'gone-' + mode + '.ps1');
  writeFileSync(check, original.replace(anchor, anchor + `
        function Get-TrackedProcess($Id) { if ([string]$Id -eq $env:CC_NO_HANDLE_PID) { return $null }; try { return [Diagnostics.Process]::GetProcessById($Id) } catch [ArgumentException] { return $null } }`));
  try {
    const result = scriptRun(check, { CC_INSTALL_DIR: install, CC_INSTALL_EXE: 'cc-p9-fabricated.exe', CC_NO_HANDLE_PID: String(pickPid(work.pids as number[])) }, ['-TimeoutMs', SUCCESS_TIMEOUT, '-Verbose']);
    return { result, work };
  } finally { await work.stop(); }
}

test('an inside server whose handle cannot be taken refuses and closes nothing; a vanished helper is skipped', async () => {
  const server = await runWithMissingHandle('failed', (pids) => pids[1]);
  assert.equal(server.result.status, 4, server.result.stdout + server.result.stderr);
  assert.match(server.result.stdout, /Application drain not confirmed/);
  assert.match(server.result.stdout, /could not close safely/);
  assert.equal(existsSync(join(server.work.root, 'requested')), false, 'nothing was asked to close');
  // Control: the same disappearance for a non-server inside process is not a refusal.
  const helper = await runWithMissingHandle('helper-failed', (pids) => pids[2]);
  assert.equal(helper.result.status, 0, helper.result.stdout + helper.result.stderr);
  assert.doesNotMatch(helper.result.stdout, /drain not confirmed/);
});

test('a live process whose exit state cannot be read is never treated as exited', () => {
  // PowerShell 5.1 turns a throwing property getter (script or .NET) into $null, so an unreadable HasExited reads as 'not exited'.
  // That is the safe side and is pinned here: it must refuse, never recover. (The recheck inside Test-ProcessExited's catch is therefore
  // unreachable defence and has no mutation row: it would be an equivalent mutant.)
  const check = join(root, 'unreadable-exit-state.ps1');
  writeFileSync(check, helperScript(`
Add-Type -TypeDefinition 'using System; public class CCUnreadableProcess { public bool HasExited { get { throw new InvalidOperationException("state unknown"); } } }'
$unreadable = New-Object CCUnreadableProcess
$refused = $false; $recovered = $false
try { $recovered = Invoke-ProcessCall $unreadable { throw [InvalidOperationException]::new('operation failed') } { $true } } catch { $refused = $true }
if (-not $refused -or $recovered) { throw 'Unreadable exit state was treated as exited' }
Write-Output 'unreadable exit state refused'
`));
  const result = scriptRun(check, {});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /unreadable exit state refused/);
});
