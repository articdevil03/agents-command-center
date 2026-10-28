import { after } from "node:test";
import type { ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { cpSync as copyTree, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import "./crash-catcher-self.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

// Copy current source unchanged so import.meta.url isolates all disk writes,
// including during mutation runs. Parent node_modules supplies dependencies.
export function tempRoot(directories: string[] = []): string {
  const dir = mkdtempSync(join(root, ".cc-test-"));
  const rel = relative(realpathSync(root), realpathSync(dir));
  try {
    assert.match(rel, /^\.cc-test-[^\\/]+$/, "unsafe test root");
  } catch (err) {
    // rel is "" for root itself and starts with ".." for a parent -- never remove those.
    // Anything else here is a real subdirectory mkdtempSync just created, safe to remove.
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  // A test that passed must not be failed by Windows still holding a handle
  // inside dir afterwards -- removeWithRetry (see its own comment) retries
  // and warns instead of throwing.
  after(() => removeWithRetry(dir));
  for (const name of directories) cpSync(join(root, name), join(dir, name), { recursive: true });
  return dir;
}

// Every copy made here leaves the live files out: a copy of the app's own config/ must not carry the user's workspaces, preferences or
// launch-safety state (a killed test would leave them lying in the repo folder).
const LIVE_CONFIG_FILES = new Set(["workspaces.json", "client-prefs.json", "launch-safety.json"]);
function cpSync(from: string, to: string, options: { recursive: boolean }): void {
  copyTree(from, to, { ...options, filter: (item) => !LIVE_CONFIG_FILES.has(item.replaceAll("\\", "/").split("/").pop()!) });
}

// A plain scratch folder under the OS temp dir, for a test that copies no source and needs no node_modules above it:
// a killed test leaves nothing in the repo. Removed (with retry) after the file's tests.
export function scratchDir(): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "cc-scratch-")));
  after(() => removeWithRetry(folder));
  return folder;
}

// Sets (or, for undefined, deletes) environment variables and returns the function that puts every one back exactly as it was.
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  return () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

// Loads server modules that read their data root at import (config.ts and everything importing it) with a fresh temp folder as that root,
// so no test file ever runs them on the repo's own live config/. The env is put back even when the import throws.
export async function importWithTempDataRoot<T>(load: () => Promise<T>): Promise<{ dataDir: string; modules: T }> {
  const dataDir = scratchDir();
  const restore = setEnv({ CC_DATA_DIR: dataDir, CC_TEST_FORCE_PACKAGED: "1" });
  try { return { dataDir, modules: await load() }; } finally { restore(); }
}

// The per-launch app key (CC_APP_KEY). Every test that spawns the server makes its own, passes it in the child env
// and sends it through these helpers: `?key=` on the WebSocket URL, `X-App-Key` on POST routes.
export function newAppKey(): string { return randomBytes(32).toString("hex"); }
export function keyedWsUrl(base: string, key: string): string { return `${base}/?key=${key}`; }
export function keyHeaders<T extends Record<string, string>>(key: string, headers: T = {} as T): T & { "X-App-Key": string } { return { "X-App-Key": key, ...headers }; }

// A test that drives runSeat with a fake spawn still needs claude/codex/opencode to RESOLVE on PATH (the runner refuses a launch otherwise),
// so a machine without those CLIs must not decide the result. One absolute folder of do-nothing .cmd files goes first on PATH for the file;
// afterwards PATH is restored and exactly those files and the empty folder are removed.
export function fakeCliOnPath(): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-fakecli-")));
  const files = ["claude", "codex", "opencode"].map((name) => join(dir, `${name}.cmd`));
  for (const file of files) writeFileSync(file, "@echo off\r\n");
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previous ?? ""}`;
  after(() => {
    process.env.PATH = previous;
    // The folder is ours (just made by mkdtempSync): removed with whatever a failed test left in it, so a red run leaves no cc-fakecli-* behind.
    removeWithRetry(dir);
  });
}

// Stops a server child THIS test spawned, through its ChildProcess object only: asks it to shut down over IPC (when it has a channel), waits a bounded
// time, then kills it. Never waits for ever, and a closed channel or a kill that throws never skips the cleanup after it. It throws in one case only:
// the child is still running after the kill and the bounded wait, because callers go on to delete the folder it is using.
export async function stopOwnedChild(child: ChildProcess, graceMs = 8000, killWaitMs = 5000): Promise<void> {
  const gone = (): boolean => child.exitCode !== null || child.signalCode !== null;
  if (gone()) return;
  const exited = new Promise<void>((done) => { child.once("exit", () => done()); });
  const within = (ms: number) => new Promise<void>((done) => { const timer = setTimeout(done, ms); void exited.then(() => clearTimeout(timer)); });
  // A channel that closes between the check and the send reports the failure later, to the callback (without one it is an unhandled 'error' event).
  try { if (child.connected) child.send("shutdown", () => { /* the kill below stops a child that did not hear it */ }); } catch { /* the channel is already closed: the kill below stops it */ }
  await Promise.race([exited, within(graceMs)]);
  if (!gone()) { try { child.kill(); } catch { /* already gone */ } await Promise.race([exited, within(killWaitMs)]); }
  assert.ok(gone(), `child ${child.pid} is still running after the shutdown request, the kill and a ${killWaitMs} ms wait`);
}
