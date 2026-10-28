// Packaged builds (electron-builder's portable target) extract the app to a
// fresh temp directory on every launch, so anything that resolves its state
// from the app's own install directory -- config, logs, scratch -- would be
// silently wiped on every relaunch. electron/main.js passes CC_DATA_DIR
// (Electron's per-user app data directory) to the spawned server, but only
// when packaged; running from source (npm run app, npm run start, npm test)
// never sets it, so every caller here falls back to the repo root exactly as
// it always has. The single shared resolution, so config.ts, runner.ts and
// index.ts can never drift into using two different roots for the same launch.
import { resolve } from "node:path";

// Filesystem-free decision: tests can prove both outcomes without touching
// the directory whose protection they are checking.
//
// CC_TEST_FORCE_PACKAGED is a narrow, test-only escape hatch: a suite proving
// the real packaged-data-root path through an actual spawned server child
// (see http.test.ts's packagedDataRootChildEnv) needs CC_DATA_DIR honoured
// there while keeping NODE_TEST_CONTEXT itself intact so the test exercises
// the override path. The override is inert outside node --test by
// construction: the test-context gate returns before reading it. Any non-empty
// string (including "0") is the signal, only inside that gate.
export function ignoresDataRootUnderTestRunner(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_TEST_CONTEXT === undefined || env.NODE_TEST_CONTEXT === "") return false;
  return env.CC_TEST_FORCE_PACKAGED === undefined || env.CC_TEST_FORCE_PACKAGED === "";
}

export function resolveDataRoot(env: NodeJS.ProcessEnv, repoRoot: string): string {
  if (ignoresDataRootUnderTestRunner(env)) return repoRoot;
  const dir = env.CC_DATA_DIR?.trim();
  // resolve() turns a relative CC_DATA_DIR into an absolute path (against the server's cwd) before anything uses it, so every
  // caller compares the same absolute root (history.ts, runner.ts); it is a no-op on an already-absolute path.
  return dir ? resolve(dir) : repoRoot;
}
