import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertNoLinks, candidatesInProgress, managedRoot, removeCandidate } from "./paths.ts";
import type { ReleaseTool } from "./release-tools.ts";

export const SWEEP_WARNING = "Some old installation files could not be removed. Close programs that use them, then try again.";

// Admission is already held. A broken descriptor or locked/link entry makes
// cleanup conservative; cleanup must never prevent an installation attempt.
export async function sweepManagedInstalls(env: NodeJS.ProcessEnv, tool: ReleaseTool): Promise<boolean> {
  const root = managedRoot(env, tool);
  if (!root) return false;
  let incomplete = false;
  try {
    assertNoLinks(root);
    const descriptor = join(root, "active.json");
    let active: string | undefined;
    try {
      assertNoLinks(descriptor);
      if ((await lstat(descriptor)).size > 4096) return true;
      const value = JSON.parse(await readFile(descriptor, "utf8"));
      const layout = tool === "copilot" ? /^install-[a-f0-9-]+[\\/]copilot\.exe$/ : /^install-[a-f0-9-]+[\\/](?:opencode\.exe|npm[\\/]opencode\.cmd)$/;
      if (typeof value.executable !== "string" || !layout.test(value.executable)) return true;
      // Protect the candidate directory, including the nested npm executable layout.
      active = resolve(root, value.executable.split(/[\\/]/)[0]);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
    for (const name of await readdir(root)) {
      if (!/^install-[a-f0-9-]+$/.test(name)) continue;
      const dir = join(root, name);
      if (dir === active || candidatesInProgress.has(dir)) continue;
      try {
        assertNoLinks(dir);
        if (!(await lstat(dir)).isDirectory()) continue;
        await removeCandidate(dir);
      } catch { incomplete = true; /* best effort: locked files and links survive */ }
    }
  } catch (error) { incomplete = (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  return incomplete;
}

export async function sweepCopilotInstalls(env: NodeJS.ProcessEnv): Promise<void> {
  await sweepManagedInstalls(env, "copilot");
}
