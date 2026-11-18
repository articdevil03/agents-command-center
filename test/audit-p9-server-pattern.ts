import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { serverNodeRuntime } from '../electron/node-runtime.js';

// The installer script finds the server by pattern on its command line. The shell builds that command line
// in electron/node-runtime.js. Both sides are read from the real files so they cannot drift apart.
function scriptServerPattern(): RegExp {
  const found = readFileSync('build/installer-process.ps1', 'utf8').match(/\$row\.CommandLine -match '([^']+)'\) \{ \$servers\[\$id\] = \$true \}/);
  assert.ok(found, 'server identification pattern FOUND in build/installer-process.ps1');
  return new RegExp(found![1], 'i'); // PowerShell -match is case-insensitive
}

test('the installer server pattern matches the real server command line, in both launch modes', () => {
  const pattern = scriptServerPattern();
  assert.ok(readFileSync('electron/server-process.js', 'utf8').includes('join(root, "server", "index.ts")'),
    'real server caller must build join(root, "server", "index.ts"); update installer identification if the entry changes');
  const bases = [String.raw`C:\Program Files\Command Center\resources\app`, String.raw`d:\My Apps\O'Connor $x\Command Center\resources\app`, String.raw`\\host\share\Command Center\app`];
  assert.ok(bases[2].startsWith('\\\\'), 'UNC base must start with two backslashes');
  for (const base of bases) {
    assert.ok(base.includes('\\'), `base must contain real Windows separators: ${base}`);
    assert.ok(!/[\r\n]/.test(base), 'base must not contain escaped control characters');
    const entry = win32.join(base, 'server', 'index.ts');
    for (const skipDiscovery of [false, true]) {
      const runtime = serverNodeRuntime(entry, skipDiscovery, String.raw`D:\Program Files\Command Center\Command Center.exe`);
      const commandLine = [runtime.command, ...runtime.args].map((part) => `"${part}"`).join(' ');
      assert.match(commandLine, pattern, `skipDiscovery=${skipDiscovery}: ${commandLine}`);
    }
  }
  assert.doesNotMatch(String.raw`"C:\Program Files\Command Center\Command Center.exe" --type=renderer`, pattern, 'helpers are not servers');
});

test('the script prints the server role and the native proof requires that line from the real installed processes', () => {
  assert.match(readFileSync('build/installer-process.ps1', 'utf8'), /exit=\$exitCode\$\(if \(\$servers\.ContainsKey\(\$id\)\) \{ '; role=server' \}\)/);
  assert.match(readFileSync('scripts/installer-lifecycle-proof.mjs', 'utf8'), /assert\.match\(result\.stdout, \/inside: exit=.d\+; role=server\//); // the dot stands for the backslash of the digit class
});
