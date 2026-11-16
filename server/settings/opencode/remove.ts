import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assertNoLinks, managedRoot } from "./paths.ts";
import type { ReleaseTool } from "./release-tools.ts";

export const NO_MANAGED_INSTALL = "Nothing installed by Command Center to remove.";
export const PARTIAL_REMOVAL = "Some files could not be removed. Close programs that use them and try again.";
export type RemoveIo = { unlink: typeof unlink };

// Paths are generated here, never taken from active.json or the request.
export async function removeManagedInstall(env: NodeJS.ProcessEnv, tool: ReleaseTool, io: RemoveIo = { unlink }): Promise<void> {
  const root = managedRoot(env, tool);
  if (!root) throw new Error(NO_MANAGED_INSTALL);
  function checked(path: string): string {
    const rel = relative(root!, resolve(path));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe installation location.");
    assertNoLinks(path);
    return path;
  }
  async function info(path: string) {
    return lstat(checked(path)).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  }
  async function inspect(path: string): Promise<void> {
    const stat = await info(path);
    if (!stat) return;
    if (stat.isDirectory()) for (const name of await readdir(checked(path))) await inspect(join(path, name));
    else if (!stat.isFile()) throw new Error("Unsafe installation entry.");
  }
  if (!(await info(root))?.isDirectory()) throw new Error(NO_MANAGED_INSTALL);
  const descriptor = join(root, "active.json");
  const names = await readdir(checked(root));
  for (const name of names) checked(join(root, name));
  const dirs = names.filter((name) => /^install-[a-f0-9-]+$/.test(name)).map((name) => join(root, name));
  if (!await info(descriptor) && !dirs.length) throw new Error(NO_MANAGED_INSTALL);
  // Refuse links throughout the selected trees before changing anything.
  for (const dir of dirs) {
    if (!(await info(dir))?.isDirectory()) throw new Error("Unsafe installation entry.");
    await inspect(dir);
  }
  if ((await info(descriptor))?.isDirectory()) throw new Error("Unsafe installation descriptor.");
  let failed = false;
  async function removeFile(path: string) {
    try { await io.unlink(checked(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true; }
  }
  await removeFile(descriptor); // Deactivate FIRST, including partial cleanup failures.
  if (failed) throw new Error(PARTIAL_REMOVAL);
  async function removeTree(path: string): Promise<void> {
    try {
      if (!(await info(path))?.isDirectory()) throw new Error("Unsafe installation entry.");
      for (const name of await readdir(checked(path))) {
        const child = join(path, name), stat = await info(child);
        if (stat?.isDirectory()) await removeTree(child);
        else if (stat?.isFile()) await removeFile(child);
        else if (stat) throw new Error("Unsafe installation entry.");
      }
      if (!(await readdir(checked(path))).length) await rmdir(checked(path));
    } catch { failed = true; }
  }
  for (const dir of dirs) await removeTree(dir);
  try { if (!(await readdir(checked(root))).length) await rmdir(checked(root)); }
  catch { failed = true; }
  if (failed) throw new Error(PARTIAL_REMOVAL);
}
