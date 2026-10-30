// split by job (each file under 400 lines, in ./leader-common/); every other file keeps importing from here.
export { USER_DENIED, LEADER_START_TIMEOUT_MS, KILL_CONFIRM_MS } from "./leader-common/types.ts";
export type { LeaderHandle, LeaderCallbacks, BackgroundJob, LeaderSeat, AskApproval, LeaderSpawn } from "./leader-common/types.ts";
export { ACTIVITY, toolActivity, cleanSkillName, createActivityTracker, createParagraphs, cleanJobDescription } from "./leader-common/activity.ts";
export type { ActivityStep, ActivityTracker, Paragraphs } from "./leader-common/activity.ts";
export {
  isInsideFolder, isFullyQualified, setCliSkipFolders, cliSkipFolders, resolveCliPath, KNOWN_CLI_NAMES, resolveCliOrThrow, withResolvedCli,
  spawnLeaderChild, spawnAcpChild, leaderKindOf, leaderChildEnv, windowsSystem32, windowsTaskkillPath, windowsPowerShellPath, describeSpawnError,
} from "./leader-common/cli-path.ts";
export type { AcpSpawn } from "./leader-common/cli-path.ts";
export {
  killProcessTree, deadline, LIST_TIMEOUT_MS, KILL_TIMEOUT_MS, parseProcessList, descendantsOf, listProcesses, watchesLeaderChild, createTreeTracker,
  processTree, setProcessTreeForTests, watchProcessTree, sweepOrphans,
} from "./leader-common/process-tree.ts";
export type { ProcInfo, ProcessLister, TreeWatch, TreeDeps, TreeTracker } from "./leader-common/process-tree.ts";
export { SWEEP_CAP_MS, sweepOrphanedChildren, describeStartupSweep, reportStartupSweep } from "./leader-common/orphans.ts";
export { leaderProcessState, trackedLeaderChildren, trackLeaderChild, spawnTrackedClaude } from "./leader-common/children.ts";
export type { LeaderProcessState } from "./leader-common/children.ts";
