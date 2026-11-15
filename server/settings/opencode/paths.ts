import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, rmdir, unlink, writeFile, rename, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export function managedRoot(env: NodeJS.ProcessEnv): string | null {
  const base = env.LOCALAPPDATA;
  if (!base || !isAbsolute(base) || /["%\r\n\0]/.test(base) ||
    (process.platform === "win32" && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(base))) return null;
  return join(base, "Command Center", "tools", "opencode-v1");
}
export function assertNoLinks(path: string): void {
  let current = resolve(path);
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Linked installation location"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function managedCli(env: NodeJS.ProcessEnv): string | null {
  const root = managedRoot(env);
  if (!root) return null;
  try {
    assertNoLinks(root);
    const descriptor = join(root, "active.json");
    if (lstatSync(descriptor).size > 4096) return null;
    assertNoLinks(descriptor);
    const value = JSON.parse(readFileSync(descriptor, "utf8"));
    if (Object.keys(value).sort().join(",") !== "executable,version" || !/^1\.\d+\.\d+$/.test(value.version)) return null;
    if (typeof value.executable !== "string" || !/^(?:install-[a-f0-9-]+)[\\/](?:opencode\.exe|npm[\\/]opencode\.cmd)$/.test(value.executable)) return null;
    const path = resolve(root, value.executable), rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    assertNoLinks(path);
    if (!lstatSync(path).isFile() || !realpathSync(path).toLowerCase().startsWith(realpathSync(root).toLowerCase() + sep)) return null;
    return path;
  } catch { return null; }
}
export async function createCandidate(env: NodeJS.ProcessEnv): Promise<{ root: string; dir: string }> {
  const root = managedRoot(env);
  if (!root) throw new Error("Missing installation profile");
  assertNoLinks(root);
  await mkdir(root, { recursive: true });
  assertNoLinks(root);
  const dir = join(root, `install-${randomUUID()}`);
  await mkdir(dir);
  return { root, dir };
}
export async function publishCandidate(root: string, executable: string, version: string): Promise<() => Promise<void>> {
  assertNoLinks(root); assertNoLinks(executable);
  const active = join(root, "active.json");
  assertNoLinks(active);
  const old = await readFile(active).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (old && old.length > 4096) throw new Error("Invalid previous descriptor");
  const path = join(root, `active-${randomUUID()}.tmp`);
  const value = JSON.stringify({ executable: relative(root, executable), version });
  try {
    await writeFile(path, value, { flag: "wx" });
    await rename(path, active);
  } finally { await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  return async () => {
    assertNoLinks(active);
    if (await readFile(active, "utf8") !== value) throw new Error("Installation descriptor changed");
    if (old === null) await unlink(active);
    else {
      const restore = join(root, `active-${randomUUID()}.tmp`);
      try { await writeFile(restore, old, { flag: "wx" }); await rename(restore, active); }
      finally { await unlink(restore).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    }
  };
}
// Only call for a directory created by this operation. Refuse links, delete files,
// then remove verified empty directories non-recursively.
export async function removeCandidate(dir: string): Promise<void> {
  assertNoLinks(dir);
  const info = await lstat(dir).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (!info) return;
  if (!info.isDirectory()) throw new Error("Invalid cleanup directory");
  for (const name of await readdir(dir)) {
    const path = join(dir, name), entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error("Linked cleanup entry");
    if (entry.isDirectory()) await removeCandidate(path); else await unlink(path);
  }
  if ((await readdir(dir)).length) throw new Error("Cleanup directory is not empty");
  await rmdir(dir);
}
