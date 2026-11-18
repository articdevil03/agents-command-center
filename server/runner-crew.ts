import type { RunnerRun } from "./runner.ts";

// Ordinary read-only workers keep shell denial. An admitted check can run commands,
// which may write files even though the direct edit tool remains denied.
export function opencodeConfig(run: RunnerRun): string | undefined {
  if (run.canWrite) return undefined;
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: { edit: "deny", bash: run.executionCapability === "run-commands" ? "allow" : "deny" },
  });
}

const lastLogTs = new Map<string, number>();
export function commandTimestamp(seatKey: string): number {
  const ts = Math.max(Date.now(), (lastLogTs.get(seatKey) ?? 0) + 1);
  lastLogTs.set(seatKey, ts);
  return ts;
}
