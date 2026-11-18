// Fabricated Windows GUI and server processes. Never launches a vendor tool.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
export function scriptRun(script, env, args = []) {
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(script), ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 140000, env: { ...process.env, CC_SETUP_PID: '', ...env },
  });
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await delay(50);
  assert.ok(check(), message);
}
export function compileFixture(root) {
  const source = join(root, 'fixture.cs'), compiler = join(root, 'compile.ps1'), exe = join(root, 'cc-p9-fabricated.exe');
  writeFileSync(source, String.raw`
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Windows.Forms;
class Fixture {
 [STAThread] static int Main(string[] args) {
  var dir=Environment.GetEnvironmentVariable("CC_FAKE_ROOT");
  var mode=Environment.GetEnvironmentVariable("CC_FAKE_MODE");
  if(args.Length>0 && args[0]=="outside") {
   var outside=new Form(); outside.WindowState=FormWindowState.Minimized;
   outside.Shown+=(s,e)=>File.WriteAllText(Path.Combine(dir,"outside.pid"),Process.GetCurrentProcess().Id.ToString());
   outside.FormClosing+=(s,e)=>{File.WriteAllText(Path.Combine(dir,"outside-requested"),"unsafe close"); e.Cancel=true;};
   Application.Run(outside); return 0;
  }
  if(args.Length>0) {
   if(args[0]=="helper") {
    File.WriteAllText(Path.Combine(dir,"helper.pid"),Process.GetCurrentProcess().Id.ToString());
    while(!File.Exists(Path.Combine(dir,"close"))) Thread.Sleep(20);
    return 7;
   }
   File.WriteAllText(Path.Combine(dir,"server.pid"),Process.GetCurrentProcess().Id.ToString());
   while(!File.Exists(Path.Combine(dir,"close"))) Thread.Sleep(20);
   Thread.Sleep(350);
   File.WriteAllText(Path.Combine(dir,"drained"),"drained");
   return mode=="failed" ? 1 : 0;
  }
  var start=new ProcessStartInfo(Application.ExecutablePath,"server/index.ts");
  start.UseShellExecute=false;
  var server=Process.Start(start);
  if(mode=="outside") {
   var extra=new ProcessStartInfo(Environment.GetEnvironmentVariable("CC_FAKE_OUTSIDE"),"outside"); extra.UseShellExecute=false; Process.Start(extra);
  }
  if(mode=="helper-failed") { var extra=new ProcessStartInfo(Application.ExecutablePath,"helper"); extra.UseShellExecute=false; Process.Start(extra); }
  var form=new Form(); form.Text="Disposable installer fixture";
  form.WindowState=FormWindowState.Minimized;
  form.Shown+=(s,e)=>File.WriteAllText(Path.Combine(dir,"ready"),Process.GetCurrentProcess().Id.ToString());
  form.FormClosing+=(s,e)=>{
   File.WriteAllText(Path.Combine(dir,"requested"),"normal close");
   if(mode=="refuse") { e.Cancel=true; return; }
   File.WriteAllText(Path.Combine(dir,"close"),"close");
   if(mode=="failed") { server.WaitForExit(); Environment.Exit(0); }
  };
  Application.Run(form); return 0;
 }
}`);
  writeFileSync(compiler, `$ErrorActionPreference='Stop'\nAdd-Type -Path $env:CC_FIXTURE_SOURCE -ReferencedAssemblies System.Windows.Forms -OutputAssembly $env:CC_FIXTURE_EXE -OutputType WindowsApplication\n`);
  const result = scriptRun(compiler, { CC_FIXTURE_SOURCE: source, CC_FIXTURE_EXE: exe });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return exe;
}
// Readiness is a positive file signal from the fixture; the wait is generous so a loaded PC never fails it.
const READY_MS = 60000;
export async function fakeWork(binary, install, root, mode = 'graceful', outside) {
  mkdirSync(install, { recursive: true }); mkdirSync(root);
  const exe = join(install, 'cc-p9-fabricated.exe');
  if (!existsSync(exe)) copyFileSync(binary, exe);
  const child = spawn(exe, [], { env: { ...process.env, CC_FAKE_ROOT: root, CC_FAKE_MODE: mode, ...(outside ? { CC_FAKE_OUTSIDE: outside } : {}) }, stdio: 'ignore', windowsHide: true });
  const ended = new Promise((done) => { child.once('exit', done); child.once('error', done); });
  await until(() => existsSync(join(root, 'ready')) && existsSync(join(root, 'server.pid')), 'fabricated shell and server ready', READY_MS);
  const pids = [child.pid, Number(readFileSync(join(root, 'server.pid'), 'utf8'))];
  const extra = mode === 'outside' ? 'outside.pid' : mode === 'helper-failed' ? 'helper.pid' : null;
  if (extra) { await until(() => existsSync(join(root, extra)), 'fabricated descendant ready', READY_MS); pids.push(Number(readFileSync(join(root, extra), 'utf8'))); }
  const identities = captureFixtureProcesses(root, pids);
  assert.equal(identities.length, pids.length);
  for (const [index, identity] of identities.entries()) assert.equal(identity.path.toLowerCase(), (outside && index === 2 ? outside : exe).toLowerCase());
  return { child, ended, pids, identities, exe, root, async stop() {
    stopFixtureProcesses(root, identities);
    await ended;
  } };
}

// Pin creation time and image path while the caller's processes are known to be ours.
export function captureFixtureProcesses(root, pids) {
  const identityScript = join(root, 'identity.ps1');
  writeFileSync(identityScript, `$ErrorActionPreference='Stop'\n$rows=@($env:CC_FIXTURE_PIDS.Split(',') | ForEach-Object { $p=Get-Process -Id ([int]$_); @{pid=$p.Id; start=$p.StartTime.ToUniversalTime().Ticks.ToString(); path=$p.Path} }); ConvertTo-Json -InputObject $rows -Compress\n`);
  const result = scriptRun(identityScript, { CC_FIXTURE_PIDS: pids.join(',') });
  assert.equal(result.status, 0, result.stderr);
  const identities = JSON.parse(result.stdout);
  return identities;
}
export function stopFixtureProcesses(root, identities) {
    // Only verified PID + creation time + exact image, never an image-name kill.
    const stopScript = join(root, 'stop.ps1');
    writeFileSync(stopScript, `$ErrorActionPreference='Stop'\nforeach($row in ($env:CC_FIXTURE_IDENTITIES | ConvertFrom-Json)) { $p=Get-Process -Id $row.pid -ErrorAction SilentlyContinue; if($p) { if($p.StartTime.ToUniversalTime().Ticks.ToString() -cne $row.start -or $p.Path -ine $row.path) { throw 'PID changed' }; $p.Kill(); if(-not $p.WaitForExit(5000)) { throw 'Owned process still running' } } }\n`);
    const stopped = scriptRun(stopScript, { CC_FIXTURE_IDENTITIES: JSON.stringify(identities) });
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
}
