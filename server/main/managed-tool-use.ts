import { acpKindOf } from "../config-acp.ts";
import { isRunning } from "../runner.ts";
import { acpClis, fixedLeaderSettings, leaders, runContexts } from "./state.ts";
import { leaderSeatOf, tabLocation } from "./tabs.ts";

export function managedToolInUse(tool: string): boolean {
  const matches = (cli: string | undefined) => cli === tool || acpClis.some((entry) => acpKindOf(entry) === cli && entry.program === tool);
  for (const [tabId, leader] of leaders) {
    if (leader.isDead() && !leader.process?.().running) continue;
    // The live leader may still have the assignment from before a Settings change.
    const signature = fixedLeaderSettings.get(tabId);
    if (signature) {
      try { if (matches(JSON.parse(signature).assignment?.cli)) return true; }
      catch { return true; } // Unknown live assignment: do not delete its executable.
    }
    const tab = tabLocation(tabId)?.tab;
    if (tab && matches(leaderSeatOf(tab)?.cli)) return true;
  }
  return [...runContexts.values()].some(({ run }) => isRunning(run.runId) && (matches(run.cli) || run.acp?.program === tool));
}
