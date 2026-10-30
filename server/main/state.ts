import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { WebSocket } from "ws";
import type { readWorkspaces, ClientPrefs, LaunchSafety, AcpCli, SavedSetup } from "../config.ts";
import type { RunnerRun } from "../runner.ts";
import type { resolveClaudeCli } from "../leader.ts";
import type { AcpSpawn, BackgroundJob, LeaderHandle, LeaderSpawn } from "../leader-common.ts";
import { createLeaderBridge } from "../leader-bridge.ts";
import type { UsageTotals } from "../usage.ts";
import { createStallTrackers } from "../stall.ts";
import type { ChatStore, ChatSnapshot } from "../chat-store.ts";
import type { RequestsStore } from "../requests.ts";
import type { createFolderActivity } from "../folder-activity.ts";
import type { GitChanges, TabNotes } from "../changes.ts";
import type { SettingsService, RunCli } from "../settings.ts";
import type { ProcessState } from "../process.ts";

export function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "message" in value && typeof (value as { message: unknown }).message === "string") return (value as { message: string }).message;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
export const clients = new Set<WebSocket>();
export let publicDir: string;
export function setPublicDir(value: string): void { publicDir = value; }
export let dataRoot: string;
export function setDataRoot(value: string): void { dataRoot = value; }
export let scratchDir: string;
export function setScratchDir(value: string): void { scratchDir = value; }
export let avatarDir: string;
export function setAvatarDir(value: string): void { avatarDir = value; }
export let chatStore: ChatStore;
export function setChatStore(value: ChatStore): void { chatStore = value; }
export let folderActivity: ReturnType<typeof createFolderActivity>;
export function setFolderActivity(value: ReturnType<typeof createFolderActivity>): void { folderActivity = value; }
export const PORT = Number(process.env.CC_PORT ?? 4317);
export const HOST = "127.0.0.1";
export let claudeCliPath: ReturnType<typeof resolveClaudeCli>;
export function setClaudeCliPath(value: ReturnType<typeof resolveClaudeCli>): void { claudeCliPath = value; }
export let workspaces: ReturnType<typeof readWorkspaces>;
export function setWorkspaces(value: ReturnType<typeof readWorkspaces>): void { workspaces = value; }
// The leader CLIs added in Settings by their start command (Agent Client Protocol). An unreadable list is kept aside and the app starts with none.
export let acpClis: AcpCli[] = [];
export function setAcpClis(value: AcpCli[]): void { acpClis = value; }
// The setups the user saved by name (config/setups.json). An unreadable list is kept aside and the app starts with none.
export let savedSetups: SavedSetup[] = [];
export function setSavedSetups(value: SavedSetup[]): void { savedSetups = value; }
export let selectedTabId: string;
export function setSelectedTabId(value: string): void { selectedTabId = value; }
export type TabRuntime = { state: ProcessState; stalledRuns: Set<string> };
export const tabs = new Map<string, TabRuntime>();
export const leaders = new Map<string, LeaderHandle>();
export const leaderSeats = new Map<string, { model: string; effort: string }>();
export const leaderBridge = createLeaderBridge();
export let boundPort = PORT;
export function setBoundPort(value: number): void { boundPort = value; }
export const leaderInstances = new Map<string, object>();
// Who asks: the tab's live leader (named by its instance), or a seat's run (a planner that runs the process). The answer, the liveness and the cleanup all go by origin.
export type Origin = { kind: "leader"; instance: object } | { kind: "seat"; runId: string; slot: string };
export const pendingApprovals = new Map<string, { approvalId: string; tabId: string; origin: Origin; tool: string; summary: string; createdAt: number; settle: (allow: boolean) => void }>();
export const approvalSettledListeners = new Map<string, Set<() => void>>();
export let leaderQuery: typeof query | undefined;
export function setLeaderQuery(value: typeof query | undefined): void { leaderQuery = value; }
export let leaderSpawn: LeaderSpawn | undefined;
export function setLeaderSpawn(value: LeaderSpawn | undefined): void { leaderSpawn = value; }
export let acpSpawn: AcpSpawn | undefined;
export function setAcpSpawn(value: AcpSpawn | undefined): void { acpSpawn = value; }
// Only the fake-CLI test runner may shorten the start deadline (LEADER_START_TIMEOUT_MS), to prove a CLI that never answers ends the turn.
export const leaderStartTimeoutMs = process.env.CC_TEST_FAKE_CLI === "1" && process.env.CC_TEST_LEADER_START_TIMEOUT_MS ? Number(process.env.CC_TEST_LEADER_START_TIMEOUT_MS) : undefined;
export const leaderTurnTimeoutMs = process.env.CC_TEST_FAKE_CLI === "1" && process.env.CC_TEST_LEADER_TURN_TIMEOUT_MS ? Number(process.env.CC_TEST_LEADER_TURN_TIMEOUT_MS) : undefined;
export const leaderUsage = new Map<string, UsageTotals>();
// unprompted: a reply the Claude CLI started by itself (a background job finished); no message of ours waits for it, so its resolver does nothing.
export const leaderTurnResolvers = new Map<string, { resolve: (ok: boolean) => void; text: string; earlier?: string; unprompted?: true; onReply?: (text: string) => void }>();
export const leaderTurnText = new Map<string, string>();
// What each tab's running reply is doing right now (plain words from the kind of step, see leader-common.ts). Only while a reply runs; never written to the chat log.
export const leaderActivity = new Map<string, string>();
// The background jobs a Claude leader's CLI runs (the full list each time); kept while that leader lives.
export const leaderJobs = new Map<string, BackgroundJob[]>();
// The model an ACP leader's CLI says it runs (its own default), kept while that leader lives.
export const leaderModels = new Map<string, string>();
// A leader model/effort change asked for mid-answer waits here until that answer ends (finishLeaderTurn applies it).
export const queuedLeaderChanges = new Map<string, { model?: string; effort?: string; liveLeader: LeaderHandle }>();
export const activeLeaderTurns = new Set<string>();
// Steered messages the CLI handed back while their turn was still running (it ended them first): each goes out as the next turn when this one finishes. They are already in the chat.
export const lateSteers = new Map<string, Array<{ text: string; images: string[] }>>();
// Tabs whose running reply took a steered message: if that reply fails or is stopped, the chat says the steer may be unanswered (nothing a steer did is ever dropped silently).
export const steeredTurns = new Set<string>();
export const savingTabs = new Map<string, number>();
export const leaderTurnWaiters = new Map<string, Set<() => void>>();
export const pendingHandoverReads = new Set<string>();
export const handoverReadTurns = new Set<string>();
export const CLEAR_UNDO_MS = 10_000;
export const pendingClearUndos = new Map<string, { snapshot: ChatSnapshot; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
export const expiredClearUndos = new Set<string>();
export const chatClearGenerations = new Map<string, number>();
export type Launcher = { slot: string; runId: string };
export const runContexts = new Map<string, { tabId: string; slot: string; run: RunnerRun; prompt: string; source: "client" | "leader" | "seat" | "stall"; launcher?: Launcher; relaunchUsed: boolean }>();
// What wait_for_runs reports about a run, kept after the run ends (capped). reply is set only on a leader job (a job the process-running seat handed the leader): the leader's answer, in place of a log.
export type RunRecord = { tabId: string; seatKey: string; status: "working" | "done" | "stopped" | "failed"; outcome: string | null; logPath: string | null; reply?: string };
export const runRecords = new Map<string, RunRecord>();
export const RUN_RECORDS_KEPT = 200;
// The crew tools of every live bridge entry: leaders by tab id, seat runs by `${tabId}.${runId}`. Their tokens are hidden wherever a run's output is shown back.
export const bridgeTokens = new Map<string, string>();
export const runBridgeRevokers = new Map<string, () => void>();
// Command Center's own activity windows (see folder-activity.ts): a leader turn per tab and a crew run per run id, so none of it reads as an outsider.
export const turnWindows = new Map<string, number>();
export const runWindows = new Map<string, number>();
export const runOutput = new Map<string, string>();
export const runUsage = new Map<string, UsageTotals>();
export const userKilledRuns = new Set<string>();
export const pendingRelaunch = new Map<string, { tabId: string; slot: string; prompt: string; originSource: "client" | "leader" | "seat"; launcher?: Launcher; relaunchUsed: true }>();
export const stallKillRuns = new Set<string>();
export const stallTrackers = createStallTrackers();
export const MAX_RUN_OUTPUT = 200 * 1024;
export const FILE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
export const FILE_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".pdf", ".csv", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css", ".scss", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".c", ".h", ".cc", ".cpp", ".cs", ".swift", ".kt", ".sql", ".sh", ".ps1", ".bat", ".log", ".diff", ".patch"]);
export const BACKPRESSURE_LIMIT = 8 * 1024 * 1024;
export const laggingClients = new Set<WebSocket>();
export let clientPrefs: ClientPrefs;
export function setClientPrefs(value: ClientPrefs): void { clientPrefs = value; }
export let cliRunner: RunCli;
export function setCliRunner(value: RunCli): void { cliRunner = value; }
export let settingsService: SettingsService;
export function setSettingsService(value: SettingsService): void { settingsService = value; }
export let requestsStore: RequestsStore;
export function setRequestsStore(value: RequestsStore): void { requestsStore = value; }
export const changesByTab = new Map<string, GitChanges>();
export const notesByTab = new Map<string, TabNotes>();
export const changeGeneration = new Map<string, number>();
export const requestActions: Record<string, { requestId: string; status: "running" | "done" | "failed"; message: string }> = {};
export const EMPTY_CHANGES: GitChanges = { repo: false, branch: null, ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [] };
export const EMPTY_NOTES: TabNotes = { path: null, content: "", truncated: false };
export let launchSafety: LaunchSafety;
export function setLaunchSafety(value: LaunchSafety): void { launchSafety = value; }
export let blockedSeatKeys: Set<string>;
export function setBlockedSeatKeys(value: Set<string>): void { blockedSeatKeys = value; }
export let unconfirmedRunIds: Set<string>;
export function setUnconfirmedRunIds(value: Set<string>): void { unconfirmedRunIds = value; }
export const reportedChatProblems = new Set<string>();
export type WorkspacesShape = typeof workspaces;
