import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fakeWork, scriptRun } from './installer-fixtures.mjs';

export function checkInstalledDrain(exe) {
  const result = scriptRun(resolve('build/installer-process.ps1'), {
    CC_INSTALL_DIR: dirname(exe), CC_INSTALL_EXE: basename(exe), CC_SETUP_PID: String(process.pid),
  }, ['-Verbose']);
  console.log(result.stdout + result.stderr);
  assert.equal(result.status, 0, 'Installed real shell could not close safely through the upgrade process check.');
  assert.match(result.stdout, /inside: exit=/, 'Real installed processes and exit codes must be recorded.');
  // The server shares the shell's image, so only its command line tells them apart. The script names the role it
  // recognised; if the real server is not named, the drain rule would silently cover nothing.
  assert.match(result.stdout, /inside: exit=\d+; role=server/, 'The installed server was not recognised as the app server, so setup would not check that it finished saving.');
}

export async function lifecycleWork({ binary, install, temp, mode, label, operation, manifest, setupLog, checkSaved }) {
  const work = await fakeWork(binary, install, join(temp, label), mode);
  const before = manifest(install);
  const previousLog = existsSync(setupLog) ? readFileSync(setupLog, 'utf8').length : 0;
  try {
    let failure;
    try { await operation(); } catch (error) { failure = error; }
    assert.ok(existsSync(join(work.root, 'requested')), `${label}: normal closure requested`);
    if (mode !== 'graceful') {
      assert.ok(failure, `${label}: unsafe shutdown must refuse`);
      assert.match(failure.message, /exit=4/);
      assert.deepEqual(manifest(install), before, `${label}: refusal preserves every old installed file`);
      assert.ok(existsSync(setupLog), `${label}: refusal log exists`);
      const detail = readFileSync(setupLog, 'utf8').slice(previousLog);
      assert.match(detail, /Command Center could not close safely\. Setup stopped/);
      assert.equal(detail.includes(install), false, 'plain refusal log contains no user path');
      if (mode === 'refuse') assert.doesNotThrow(() => process.kill(work.child.pid, 0));
    } else {
      assert.equal(failure, undefined, failure?.message);
      assert.equal(readFileSync(join(work.root, 'drained'), 'utf8'), 'drained');
    }
    checkSaved();
    console.log(`PASS ${label}: normal closure, ${mode === 'graceful' ? 'drain confirmed' : 'exit=4 and old install unchanged'}`);
  } finally {
    await work.stop();
    if (existsSync(work.exe)) unlinkSync(work.exe);
  }
}
