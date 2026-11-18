import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, rmdir, unlink, writeFile, rename, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { randomUUID } from "node:crypto";

import { RELEASE_TOOLS, type ReleaseTool } from "./release-tools.ts";
import { assertOwnedPath, resolveOwnedRoot } from "../../owned-path.js";
export const candidatesInProgress = new Set<string>();
const locations = new Map<string, string>();
const boundaries = new Map<string, ReturnType<typeof resolveOwnedRoot>>();
// Keep successful pins after refusal. Only a restart may adopt a replaced root.
const contains = (root: string, path: string) => {
  const rel = relative(root, resolve(path));
  return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
function pinned(root: string, allowRootLink = false) {
  const key = `${allowRootLink}:${process.platform === "win32" ? root.toLowerCase() : root}`;
  let handle = boundaries.get(key);
  if (!handle) { handle = resolveOwnedRoot(root, { allowRootLink }); boundaries.set(key, handle); }
  return handle;
}

export function normalizeWindowsBase(base: string | undefined): string | null {
  if (!base || /["\r\n\0]/.test(base) || !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(base)) return null;
  const normalized = win32.normalize(base.replaceAll("/", "\\"));
  return /^[A-Za-z]:\\$/.test(normalized) ? normalized : normalized.replace(/\\+$/, "");
}
export function managedRoot(env: NodeJS.ProcessEnv, tool: ReleaseTool = "opencode"): string | null {
  const base = process.platform === "win32" ? normalizeWindowsBase(env.LOCALAPPDATA) : env.LOCALAPPDATA;
  if (!base || !isAbsolute(base) || /["\r\n\0]/.test(base)) return null;
  const app = join(base, "Command Center"), root = join(app, "tools", RELEASE_TOOLS[tool].folder);
  locations.set(root, app);
  return root;
}
export function assertNoLinks(path: string): void {
  for (const [root, app] of locations) {
    if (!contains(root, path)) continue;
    assertOwnedPath(pinned(dirname(app), true), path, { allowMissingLeaf: true });
    // Pin both owned boundaries. Only ancestors ABOVE Command Center may relocate.
    assertOwnedPath(pinned(app), path, { allowMissingLeaf: true });
    assertOwnedPath(pinned(join(app, "tools")), path, { allowMissingLeaf: true });
    return;
  }
  throw new Error("Unknown installation location");
}
export function managedCli(env: NodeJS.ProcessEnv, tool: ReleaseTool = "opencode"): string | null {
  const root = managedRoot(env, tool);
  if (!root) return null;
  try {
    assertNoLinks(root);
    const descriptor = join(root, "active.json");
    if (lstatSync(descriptor).size > 4096) return null;
    assertNoLinks(descriptor);
    const value = JSON.parse(readFileSync(descriptor, "utf8"));
    if (Object.keys(value).sort().join(",") !== "executable,version" || !/^1\.\d+\.\d+$/.test(value.version)) return null;
    if (tool === "copilot" && (typeof value.executable !== "string" || !/^install-[a-f0-9-]+[\\/]copilot\.exe$/.test(value.executable))) return null;
    if (tool === "opencode" && (typeof value.executable !== "string" || !/^(?:install-[a-f0-9-]+)[\\/](?:opencode\.exe|npm[\\/]opencode\.cmd)$/.test(value.executable))) return null;
    const path = resolve(root, value.executable), rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    assertNoLinks(path);
    if (!lstatSync(path).isFile() || !realpathSync(path).toLowerCase().startsWith(realpathSync(root).toLowerCase() + sep)) return null;
    return path;
  } catch { return null; }
}
export async function createCandidate(env: NodeJS.ProcessEnv, tool: ReleaseTool = "opencode"): Promise<{ root: string; dir: string }> {
  const root = managedRoot(env, tool);
  if (!root) throw new Error("Missing installation profile");
  assertNoLinks(root);
  await mkdir(root, { recursive: true });
  assertNoLinks(root);
  const dir = join(root, `install-${randomUUID()}`);
  await mkdir(dir);
  assertNoLinks(dir);
  assertNoLinks(join(dir, ".command-center-owner.json"));
  await writeFile(join(dir, ".command-center-owner.json"), JSON.stringify({
    owner: "com.agents.command-center", format: 1, tool, entry: dir.slice(root.length + 1),
  }), { flag: "wx" });
  assertNoLinks(join(dir, ".command-center-owner.json"));
  candidatesInProgress.add(dir);
  return { root, dir };
}
export async function publishCandidate(root: string, executable: string, version: string): Promise<() => Promise<void>> {
  if (!contains(root, executable)) throw new Error("Installation executable escapes its root");
  assertNoLinks(root); assertNoLinks(executable);
  const active = join(root, "active.json");
  assertNoLinks(active);
  const old = await readFile(active).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (old && old.length > 4096) throw new Error("Invalid previous descriptor");
  const path = join(root, `active-${randomUUID()}.tmp`);
  const value = JSON.stringify({ executable: relative(root, executable), version });
  try {
    assertNoLinks(path);
    await writeFile(path, value, { flag: "wx" });
    assertNoLinks(active);
    await rename(path, active);
  } finally { assertNoLinks(path); await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  return async () => {
    assertNoLinks(active);
    if (await readFile(active, "utf8") !== value) throw new Error("Installation descriptor changed");
    assertNoLinks(active);
    if (old === null) await unlink(active);
    else {
      const restore = join(root, `active-${randomUUID()}.tmp`);
      try { assertNoLinks(restore); await writeFile(restore, old, { flag: "wx" }); assertNoLinks(active); await rename(restore, active); }
      finally { assertNoLinks(restore); await unlink(restore).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    }
  };
}
// Only call for a directory created by this operation. Refuse links, delete files,
// then remove verified empty directories non-recursively.
export async function removeCandidate(dir: string): Promise<void> {
  // Also used for caller-owned scratch folders. Keep one handle through recursion.
  const managed = [...locations.keys()].some((root) => contains(root, dir));
  const handle = managed ? null : resolveOwnedRoot(dir);
  function checked(path: string) {
    if (handle) assertOwnedPath(handle, path, { allowMissingLeaf: true }); else assertNoLinks(path);
    return path;
  }
  async function remove(path: string): Promise<void> {
    const info = await lstat(checked(path)).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (!info) return;
    if (!info.isDirectory()) throw new Error("Invalid cleanup directory");
    for (const name of await readdir(checked(path))) {
      const child = join(path, name), entry = await lstat(checked(child));
      if (entry.isSymbolicLink()) throw new Error("Linked cleanup entry");
      if (entry.isDirectory()) await remove(child); else await unlink(checked(child));
    }
    if ((await readdir(checked(path))).length) throw new Error("Cleanup directory is not empty");
    await rmdir(checked(path));
    candidatesInProgress.delete(path);
  }
  await remove(dir);
}
