import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Explicit tool overrides prevent electron-builder from downloading on a cache miss.
export function cachedInstallerEnv(cache = process.env.ELECTRON_BUILDER_CACHE ?? join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache')) {
  function readable(path, directory = false) {
    const info = lstatSync(path);
    assert.ok(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()), 'Cached installer tool unavailable. No downloads are allowed.');
    accessSync(path, constants.R_OK);
    return path;
  }
  function find7zip(folder, depth = 0) {
    if (depth > 3) return;
    for (const entry of readdirSync(readable(folder, true), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(folder, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === '7za.exe') return readable(path);
      if (entry.isDirectory() && (depth > 0 || entry.name.startsWith(`7zip-win-${process.arch}`))) {
        const found = find7zip(path, depth + 1); if (found) return found;
      }
    }
  }
  function bundle(name, required) {
    const parent = readable(join(cache, name), true);
    if (existsSync(join(parent, required))) return parent;
    const candidates = readdirSync(parent, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(name + '-') && existsSync(join(parent, entry.name, required)));
    assert.equal(candidates.length, 1, 'Cached installer bundle unavailable or ambiguous. No downloads are allowed.');
    return readable(join(parent, candidates[0].name), true);
  }
  const nsis = bundle('nsis-3.0.4.1', 'Bin/makensis.exe');
  readable(join(nsis, 'Bin', 'makensis.exe'));
  const resources = bundle('nsis-resources-3.4.1', 'plugins');
  readable(join(resources, 'plugins'), true);
  const sevenZip = find7zip(join(cache, '7zip@1.0.0'));
  assert.ok(sevenZip, 'Cached 7-Zip unavailable. No downloads are allowed.');
  return { ELECTRON_BUILDER_NSIS_DIR: nsis, ELECTRON_BUILDER_NSIS_RESOURCES_DIR: resources, ELECTRON_BUILDER_7ZIP_PATH: sevenZip };
}
