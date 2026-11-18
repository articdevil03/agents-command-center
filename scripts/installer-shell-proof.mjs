import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeProofEnv } from './pack29-runtime-proof.mjs';
import { captureFixtureProcesses, stopFixtureProcesses, until } from './installer-fixtures.mjs';
import { checkInstalledDrain } from './installer-lifecycle-proof.mjs';
const waitUntil = (check, message) => until(check, message, 60000);

// Drive the existing shell smoke protocol. It bypasses the ordinary GUI, using the installed exe.
export async function launchInstalled(exe, temp, { installerDrain = false } = {}) {
  const { spawn } = await import("node:child_process");
  const data = join(temp, "launch-data"); mkdirSync(data);
  const ready = join(temp, "ready.json"), stop = join(temp, "stop");
  const env = { ...runtimeProofEnv(temp, data), CC_SMOKE_READY_FILE: ready, CC_SMOKE_STOP_FILE: stop, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1" };
  const child = spawn(exe, [], { env, cwd: temp, windowsHide: true, stdio: "ignore" });
  let error;
  child.once("error", (e) => { error = e; });
  const ended = new Promise((done) => child.once("close", done));
  let serverPid;
  let identities = [];
  try {
    identities = captureFixtureProcesses(temp, [child.pid]);
    await waitUntil(() => existsSync(ready) || error || child.exitCode !== null, "installed shell readiness timeout");
    assert.ok(existsSync(ready), `installed shell failed: ${error?.message ?? child.exitCode}`);
    const record = JSON.parse(readFileSync(ready, "utf8")); serverPid = record.serverPid;
    assert.ok(Number.isInteger(serverPid) && serverPid > 0, "installed shell returned server PID");
    identities.push(...captureFixtureProcesses(temp, [serverPid]));
    for (const identity of identities) assert.equal(identity.path.toLowerCase(), exe.toLowerCase(), 'scratch installed image identity');
    const response = await fetch(`http://127.0.0.1:${record.port}/`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    if (installerDrain) {
      // Smoke has no window. Its existing 30-second quit drives the real before-quit
      // drain while the identical upgrade script retains and waits on its handles.
      checkInstalledDrain(exe);
    } else writeFileSync(stop, "stop", { flag: "wx" });
    let stopTimer;
    const code = await Promise.race([ended, new Promise((done) => { stopTimer = setTimeout(() => done("timeout"), 135000); })]).finally(() => clearTimeout(stopTimer));
    assert.equal(code, 0, "installed shell smoke shutdown exit");
    console.log(`PASS installed shell CC_SMOKE protocol, stripped PATH, GET /=200; server PID=${serverPid}; exit=0`);
  } finally {
    stopFixtureProcesses(temp, identities);
    await ended;
  }
}

