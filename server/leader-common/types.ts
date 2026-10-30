import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { PermissionMode } from "../settings.ts";
import type { UsageDelta } from "../usage.ts";

// What every leader tells a CLI when the user refuses a change (one text, so the tests and the mutation catalogue name it once).
export const USER_DENIED = "The user denied this.";

// What every leader (Claude SDK, Codex app-server, OpenCode serve) hands back to the tab code.
export type LeaderHandle = {
  send: (text: string, images: string[]) => void;
  // Puts a message into the turn that runs now. false = nothing was sent (no open turn, or this CLI cannot take one mid-turn); a message it took
  // that the CLI then turned out to have ended without is handed back through LeaderCallbacks.onSteerMissed. Never use send for this.
  steer: (text: string, images: string[]) => boolean;
  stop: () => void;
  isDead: () => boolean;
  setModel: (model: string) => Promise<boolean>;
  setPermissionMode: (mode: PermissionMode) => Promise<boolean>;
  getPermissionMode: () => string;
  // True while the CLI cannot take a new permission mode (a Codex turn already runs on the old policy).
  modeLocked?: () => boolean;
  // What the leader's CLI process is doing, also after stop: running = not seen to exit; killFailed = a kill of it could not be confirmed.
  // recheck: retries the exit sweep of descendants that could not be stopped.
  process?: () => { running: boolean; killFailed: boolean; recheck?: () => Promise<void> };
};
export type LeaderCallbacks = {
  onDelta: (text: string) => void;
  onDone: () => void;
  onUsage: (delta: UsageDelta) => void;
  onError: (message: string) => void;
  onStop?: () => void;
  // A notice for the tab's chat that belongs to no turn (it never settles or fails one).
  onNotice?: (message: string) => void;
  // A message steer() took that the CLI could not put into its running turn (the turn had just ended, or the CLI refused it): the tab sends it as the next turn.
  onSteerMissed?: (text: string, images: string[]) => void;
  // The CLI session this leader (or a sub-agent of it) works in, so a scan of the tools' own records never mistakes it for an outsider.
  onSession?: (id: string) => void;
  // What the leader is doing right now, in plain words from the KIND of step only (never a command, query, path or content); null = nothing to say. Only while a reply runs.
  onActivity?: (label: string | null) => void;
  // Claude only: the background jobs the leader's CLI runs for it, the full current list each time. Codex and OpenCode start theirs detached where Command Center cannot see them, so their adapters never call this.
  onBackgroundJobs?: (jobs: BackgroundJob[]) => void;
  // ACP leaders only: the model the CLI says it runs (its own default), shown where the leader's model is shown.
  onModel?: (model: string) => void;
};
export type BackgroundJob = { id: string; description: string; startedAt: number };
export type LeaderSeat = { model: string; effort: string };
export type AskApproval = (tool: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<boolean>;
export type LeaderSpawn = (command: string, options: SpawnOptions) => ChildProcess;

// Time limits are sized for a busy PC (other terminals at 82-100% load): the process list took up to 3.1 s measured, so 30 s is ~10x; a limit that gives up fails a user action.
export const LIST_TIMEOUT_MS = 30_000;
export const KILL_TIMEOUT_MS = 10_000;
export const KILL_CONFIRM_MS = 2_000;
// The start-up sweep waits for one process list, then the kills (they run together), plus a margin.
export const SWEEP_CAP_MS = LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000;
export const LEADER_START_TIMEOUT_MS = 60_000;
