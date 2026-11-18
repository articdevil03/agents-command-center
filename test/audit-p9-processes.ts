import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scriptRun } from '../scripts/installer-fixtures.mjs';
import { recordTree, killTracked } from '../scripts/sweep/proctree.mjs';

// The sandbox cannot reliably use WMI. Reuse the installer's native snapshot,
// while retaining the sweep's PID + creation-time ownership checks.
export async function runOwnedProof(command: string, args: string[], temp: string, options: any = {}) {
  const { timeoutMs = 240000, ...spawnOptions } = options;
  const source = readFileSync('build/installer-process.ps1', 'utf8');
  const native = source.match(/    Add-Type @'[\s\S]*?\r?\n'@/)?.[0];
  assert.ok(native, 'native snapshot source FOUND');
  const script = join(temp, 'processes.ps1');
  writeFileSync(script, "$ErrorActionPreference='Stop'\n" + native + '\nConvertTo-Json -Compress -InputObject @([CCInstallPath]::Snapshot() | Where-Object { $_.CreationDate.Year -gt 1970 } | ForEach-Object { @{ pid=$_.ProcessId; ppid=$_.ParentProcessId; created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } })');
  const list = async () => {
    const result = scriptRun(script, {});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const tracked = new Map();
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
  const result = { status: null as number | null, stdout: '', stderr: '', cleanupKilled: [] as number[], error: undefined as Error | undefined };
  child.stdout!.on('data', (bytes) => { result.stdout += bytes; });
  child.stderr!.on('data', (bytes) => { result.stderr += bytes; });
  const closed = new Promise<number | null>((done, reject) => { child.once('close', done); child.once('error', reject); });
  const poll = async () => recordTree(await list(), child.pid, tracked);
  let pollError: unknown;
  const timer = setInterval(() => { void poll().catch((error) => { pollError = error; }); }, 1500);
  let timeout: ReturnType<typeof setTimeout>;
  const expired = new Promise<null>((done) => { timeout = setTimeout(() => { result.error = new Error('Owned proof timed out'); done(null); }, timeoutMs); });
  try {
    await poll();
    result.status = await Promise.race([closed, expired]);
    return result;
  } finally {
    clearInterval(timer); clearTimeout(timeout!);
    const root = child.exitCode === null && child.signalCode === null ? child.pid : undefined;
    const cleanup = await killTracked(tracked, { root, list });
    result.cleanupKilled = cleanup.killed;
    if (cleanup.killed.length) console.log('Stopped proof-owned leftovers by verified PID:', cleanup.killed);
    if (pollError) throw pollError;
  }
}
