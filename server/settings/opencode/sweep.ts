import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertNoLinks, candidatesInProgress, managedRoot, removeCandidate } from "./paths.ts";

// Admission is already held. A broken descriptor or locked/link entry makes
// cleanup conservative; cleanup must never prevent an installation attempt.
export async function sweepCopilotInstalls(env: NodeJS.ProcessEnv): Promise<void> {
  const root = managedRoot(env, "copilot");
  if (!root) return;
  try {
    assertNoLinks(root);
    const descriptor = join(root, "active.json");
    let active: string | undefined;
    try {
      assertNoLinks(descriptor);
      if ((await lstat(descriptor)).size > 4096) return;
      const value = JSON.parse(await readFile(descriptor, "utf8"));
      if (typeof value.executable !== "string" || !/^install-[a-f0-9-]+[\\/]copilot\.exe$/.test(value.executable)) return;
      active = dirname(resolve(root, value.executable));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    for (const name of await readdir(root)) {
      if (!/^install-[a-f0-9-]+$/.test(name)) continue;
      const dir = join(root, name);
      if (dir === active || candidatesInProgress.has(dir)) continue;
      try {
        assertNoLinks(dir);
        if (!(await lstat(dir)).isDirectory()) continue;
        await removeCandidate(dir);
      } catch { /* best effort: locked files and links survive */ }
    }
  } catch { /* root missing or inaccessible: installation handles its own error */ }
}
