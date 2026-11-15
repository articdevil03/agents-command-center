// Shared between packaged-smoke.mjs (the real run) and packaged-smoke-proof.mjs
// (the write-containment guard) so the guard proves the exact flags the real
// run uses, never a hand-copied duplicate that could quietly drift from them.
//
// Reads are unrestricted. The isolated run also rejects module resolutions
// outside its copied app, including machine-wide ancestor node_modules.
// Scoping read permission also denied
// the real Claude CLI probe (a plain fs.statSync on a known path / PATH).
// --allow-child-process is on because the server's own shutdown starts
// taskkill (server/index.ts, on an IPC disconnect). Both smoke runs set CC_SKIP_DISCOVERY, so
// no real claude/opencode binary is started here. Dropping --permission
// entirely would remove the write containment, which we keep:
// --allow-fs-write stays scoped to dataDir and nothing else.
// Node disables fsync under --permission, so first-launch seeding of an EMPTY
// data folder cannot run with these flags: packaged-smoke.mjs seeds the folder
// in a first run without them, then uses them on the seeded folder.
export function packagedSmokePermissionArgs(dataDir) {
  return ["--permission", "--allow-addons", "--allow-child-process", "--allow-fs-read=*", `--allow-fs-write=${dataDir}`];
}

export function packagedSmokeResolutionGuard(app) {
  return `import { registerHooks } from 'node:module';
import { relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const app = ${JSON.stringify(app)};
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (result.url.startsWith('file:')) {
    const rel = relative(app, fileURLToPath(result.url));
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      const error = new Error('ERR_MODULE_NOT_FOUND: isolated package ' + specifier + ' resolved outside copied app: ' + result.url);
      error.code = 'ERR_MODULE_NOT_FOUND'; throw error;
    }
  }
  return result;
}});\n`;
}
