import type { RunnerRun } from "./runner.ts";

// OpenCode's run configuration: a read-only seat is denied file edits and shell commands; a seat that may write needs none.
export function opencodeConfig(run: RunnerRun): string | undefined {
  if (run.canWrite) return undefined;
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: { edit: "deny", bash: "deny" },
  });
}
