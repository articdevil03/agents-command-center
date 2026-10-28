// Shared between packaged-smoke.mjs (the real run) and packaged-smoke-proof.mjs
// (the write-containment guard) so the guard proves the exact flags the real
// run uses, never a hand-copied duplicate that could quietly drift from them.
//
// Reads are unrestricted: the packaged app's own directory placement (always
// copied outside this repository first, see packaged-smoke.mjs) is what makes
// a missing dependency fail for real instead of resolving via a repo ancestor
// -- the read permission was never the isolation, and scoping it also denied
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
