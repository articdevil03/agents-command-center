import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, appendFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { isValidModel, isValidEffort, isAcpKind, type SeatKind, type AcpKind } from "./config.ts";
import { formatExitMarker } from "./history.ts";
import type { UsageDelta } from "./usage.ts";
import { resolveDataRoot } from "./data-root.ts";
import { describeSpawnError, KILL_TIMEOUT_MS, LIST_TIMEOUT_MS, leaderChildEnv, spawnAcpChild, watchProcessTree, withResolvedCli, type AcpSpawn, type LeaderCallbacks, type LeaderHandle, type TreeWatch } from "./leader-common.ts";
import { createAcpLeader } from "./leader-acp.ts";
import { MCP_VAR, CREW_URL_VAR, CREW_TOKEN_VAR, CREW_SERVER, crewEnv, usesMcpFile, opencodeConfig, checkCrewTools } from "./runner-crew.ts";
import {
  createAgentUsageState, feedClaudeOutput, flushClaudeOutput, scanCodexTokens, flushCodexTokens,
  type AgentUsageState, type AgentUsageEvent, type RateLimitWindows,
} from "./agent-usage.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const logsDir = join(resolveDataRoot(process.env, repoRoot), "logs");
mkdirSync(logsDir, { recursive: true });

export type RunnerRun = {
  runId: string;
  seatKey: string;
  slotId: string;
  name: string;
  cli: SeatKind | AcpKind;
  model: string;
  effort: string;
  folder: string;
  canWrite: boolean;
  startedAt: number;
  // Claude only: the advisor model id (--advisor), checked against the Claude model list.
  advisor?: string;
  // An ACP crew seat: the CLI's start command (cli is then "acp:<id>"; model and effort are "default").
  acp?: { name: string; program: string; args: string[] };
  // Only on the run of the seat that runs the process: where the crew tools are and the token that opens them (never on a command line, never in a log).
  crewTools?: { url: string; token: string };
  // A Researcher seat: live web search on (Claude: WebSearch and WebFetch allowed even in read-only mode, probed 2026-10-29; Codex: its --search switch, parse-checked only).
  webSearch?: boolean;
};
export type RunnerCallbacks = {
  onUnconfirmedKill?: (run: RunnerRun, pid: number | undefined) => void;
  onReleasedClose?: (run: RunnerRun, exitCode?: number) => void;
  onOutput: (run: RunnerRun, chunk: string) => void;
  onStatus: (run: RunnerRun, status: "working" | "done" | "stopped" | "failed", exitCode?: number) => void;
  onUsage?: (run: RunnerRun, delta: UsageDelta) => void;
  onRateLimit?: (windows: RateLimitWindows) => void;
};
type Spawn = typeof spawn;
type RunningEntry = { run: RunnerRun; proc: ChildProcess; cb: RunnerCallbacks; logPath: string; flush: () => void; watch: TreeWatch | null; exitedAt?: number; unconfirmed?: boolean; stopRequested?: boolean; outcome?: "done" | "failed" };
const running = new Map<string, RunningEntry>();
const bySeat = new Map<string, Set<string>>();
const released = new Set<RunningEntry>();
const lastLogTs = new Map<string, number>();

const CLAUDE_READ_ONLY_FLAGS = "--permission-mode plan --permission-prompts none --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit";
// Plan mode blocks every MCP tool (probed 2026-10-28), so a read-only seat that runs the process uses default mode; the denied-tools list is its boundary.
const CLAUDE_READ_ONLY_CREW_FLAGS = "--permission-mode default --permission-prompts none --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit";
const CLAUDE_WRITE_FLAGS = "--permission-mode acceptEdits";

function commandTimestamp(seatKey: string): number {
  const ts = Math.max(Date.now(), (lastLogTs.get(seatKey) ?? 0) + 1);
  lastLogTs.set(seatKey, ts);
  return ts;
}

// The folder and the brief path travel in the environment, never on the command line: cmd expands %NAME% once and treats the result as plain
// text, so ( ) & ^ % in a path need no escaping at all. ponytail: a path holding !x! is wrong, not unsafe, if cmd's DelayedExpansion registry flag is on.
const BRIEF_VAR = "CC_BRIEF_PATH";
const DIR_VAR = "CC_RUN_DIR";
// A trailing backslash (a drive root such as D:\) is doubled so it cannot escape the closing quote of --dir "...".
export function commandEnv(run: RunnerRun, briefPath: string): NodeJS.ProcessEnv {
  return { [BRIEF_VAR]: briefPath, ...(run.cli === "opencode" ? { [DIR_VAR]: run.folder.replace(/\\+$/, (slashes) => slashes + slashes) } : {}), ...crewEnv(run) };
}
export function buildCommand(run: RunnerRun, briefPath: string): string {
  if (!run.runId || !/^[A-Za-z0-9._-]+$/.test(run.runId)) throw new Error("buildCommand: unsafe run id");
  if (!/^[A-Za-z0-9._-]+$/.test(run.seatKey)) throw new Error("buildCommand: unsafe seat key");
  if (!isValidModel(run.cli, run.model)) throw new Error(`buildCommand: refusing invalid model for "${run.seatKey}": ${run.model}`);
  if (!isValidEffort(run.cli, run.effort)) throw new Error(`buildCommand: refusing invalid effort for "${run.seatKey}": ${run.effort}`);
  if (typeof run.canWrite !== "boolean") throw new Error("buildCommand: slot permission is required");
  if (/[\u0000-\u001f\u007f"]/.test(run.folder)) throw new Error("buildCommand: refusing unsafe folder path");
  if (/[\u0000-\u001f\u007f"]/.test(briefPath)) throw new Error("buildCommand: refusing unsafe brief path");
  checkCrewTools(run);
  const instruction = `"Read the file at %${BRIEF_VAR}% and follow it exactly as your instructions."`;
  switch (run.cli) {
    case "claude": {
      // Only a Claude run takes an advisor; a value that is not a Claude model throws, it is never put on the command line.
      if (run.advisor !== undefined && !isValidModel("claude", run.advisor)) throw new Error(`buildCommand: refusing invalid advisor for "${run.seatKey}": ${run.advisor}`);
      const advisor = run.advisor !== undefined ? ` --advisor ${run.advisor}` : "";
      const mode = run.canWrite ? CLAUDE_WRITE_FLAGS : run.crewTools ? CLAUDE_READ_ONLY_CREW_FLAGS : CLAUDE_READ_ONLY_FLAGS;
      const crew = (run.crewTools ? ` --mcp-config "%${MCP_VAR}%" --allowedTools mcp__${CREW_SERVER}` : "") + (run.webSearch ? " --allowedTools WebSearch,WebFetch" : "");
      return `claude -p ${instruction} --model ${run.model} --effort ${run.effort}${advisor} ${mode}${crew} --output-format stream-json --verbose`;
    }
    case "codex": {
      // The token is only in the environment (bearer_token_env_var names it); without default_tools_approval_mode `exec` refuses every MCP call (probed 2026-10-28).
      const crew = run.crewTools ? ` -c "mcp_servers.${CREW_SERVER}.url=%${CREW_URL_VAR}%" -c mcp_servers.${CREW_SERVER}.bearer_token_env_var=${CREW_TOKEN_VAR} -c mcp_servers.${CREW_SERVER}.default_tools_approval_mode=approve` : "";
      // --skip-git-repo-check: a tab folder that is not a git repo would otherwise make every Codex run stop at once ("Not inside a trusted directory").
      return `codex ${run.webSearch ? "--search " : ""}exec --skip-git-repo-check --model ${run.model} -c model_reasoning_effort=${run.effort}${crew} --sandbox ${run.canWrite ? "workspace-write" : "read-only"} ${instruction}`;
    }
    case "opencode":
      return `opencode run --dir "%${DIR_VAR}%" -m ${run.model} --variant ${run.effort} --auto --print-logs ${instruction}`;
    // An ACP CLI never gets a shell command (runSeat starts it as a process with an argument list); any other kind never gets a command made up for it.
    default:
      throw new Error(`buildCommand: no command for CLI "${String(run.cli)}" on "${run.seatKey}"`);
  }
}

function ownsRun(runId: string, entry: RunningEntry): boolean { return running.get(runId) === entry; }
function removeRun(runId: string, entry: RunningEntry): void {
  if (!ownsRun(runId, entry)) return;
  running.delete(runId);
  const ids = bySeat.get(entry.run.seatKey);
  ids?.delete(runId);
  if (ids?.size === 0) bySeat.delete(entry.run.seatKey);
}

export function isRunning(runId: string): boolean { return running.has(runId); }
export function runIdsForSeat(seatKey: string): string[] { return [...(bySeat.get(seatKey) ?? [])]; }
export function canRunWrite(run: RunnerRun): boolean {
  // No CLI's read-only mode is an enforced boundary: a `codex exec --sandbox read-only`
  // probe wrote a file on this PC, and Claude and OpenCode write through tools or
  // configuration we do not control. So every run counts as able to write, and a
  // stalled run is never relaunched by itself; it escalates to the user.
  void run;
  return true;
}
export function unconfirmedPid(runId: string): number | undefined {
  const entry = running.get(runId);
  return entry?.unconfirmed ? entry.proc.pid : undefined;
}
export function releaseUnconfirmedRun(runId: string): boolean {
  const entry = running.get(runId);
  if (!entry?.unconfirmed || !entry.proc.pid) return false;
  released.add(entry);
  removeRun(runId, entry);
  return true;
}

// Hides the crew token from everything a run shows or saves. A token split across two chunks is still found: the end of a chunk that could be the start of the token waits for the next chunk.
type Hider = { push: (text: string) => string; end: () => string };
const passThrough: Hider = { push: (text) => text, end: () => "" };
function createHider(secret: string): Hider {
  if (!secret) return passThrough;
  const HIDDEN = "[hidden]";
  let held = "";
  return {
    push(text) {
      const clean = (held + text).split(secret).join(HIDDEN);
      let n = Math.min(secret.length - 1, clean.length);
      while (n > 0 && !secret.startsWith(clean.slice(clean.length - n))) n--;
      held = clean.slice(clean.length - n);
      return clean.slice(0, clean.length - n);
    },
    // A run that ended inside the token: a start of four or more characters is hidden rather than shown.
    end() { const rest = held; held = ""; return rest.length >= 4 ? HIDDEN : rest; },
  };
}
export function runSeat(run: RunnerRun, prompt: string, cb: RunnerCallbacks, spawnFn: Spawn = spawn): { ok: true; timestamp: number } | { ok: false; error: string } {
  run = Object.freeze({ ...run });
  if (running.has(run.runId)) return { ok: false, error: `run "${run.runId}" already exists` };
  if (!run.runId || !/^[A-Za-z0-9._-]+$/.test(run.runId) || !isSafeSeatKey(run.seatKey)) return { ok: false, error: "unsafe run or seat id" };
  // An ACP seat is started as a process with an argument list (no shell, no command line); buildCommand never sees it.
  const acp = isAcpKind(run.cli);
  if (acp && !run.acp) return { ok: false, error: `no start command for CLI "${run.cli}" on "${run.seatKey}"` };
  const timestamp = commandTimestamp(run.seatKey);
  const briefPath = join(logsDir, `${run.seatKey}-${timestamp}.brief.txt`);
  // Claude reads the crew tools from a config file that holds the token: it lives only as long as the run.
  const mcpPath = usesMcpFile(run) ? join(logsDir, `${run.seatKey}-${timestamp}.mcp.json`) : null;
  const command = acp ? "" : buildCommand(run, briefPath);
  const opencode = opencodeConfig(run);
  const env = leaderChildEnv({ ...commandEnv(run, briefPath), ...(run.cli === "opencode" && opencode ? { OPENCODE_CONFIG_CONTENT: opencode } : {}), ...(mcpPath ? { [MCP_VAR]: mcpPath } : {}) });
  // The CLI is spawned by absolute path from PATH, never found in the project folder (see resolveCliPath); no resolved path means nothing is spawned.
  let resolvedCommand = "";
  if (!acp) { try { resolvedCommand = withResolvedCli(command, env, run.folder); } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; } }
  const logPath = join(logsDir, `${run.seatKey}-${timestamp}.log`);
  const removeMcp = (): void => { if (mcpPath) try { unlinkSync(mcpPath); } catch { /* never written, or already gone */ } };

  // A failed log write (disk full, folder gone) must never stop the run from reporting its end; the first one per run is said on screen, once.
  let logFailed = false;
  function appendLog(text: string): void {
    try { appendFileSync(logPath, text); }
    catch (err) {
      if (logFailed) return;
      logFailed = true;
      try { cb.onOutput(run, `\n[log] could not save this run's output to disk (${(err as Error).message}); History will be missing it\n`); } catch { /* the run still reports its end */ }
    }
  }
  // The crew token never reaches the log or the page: every output chunk passes its stream's hider (a no-op for a run without crew tools).
  const outHider = createHider(run.crewTools?.token ?? ""), errHider = createHider(run.crewTools?.token ?? "");
  function emit(text: string, hider: Hider): void {
    const shown = hider.push(text);
    if (shown) { appendLog(shown); cb.onOutput(run, shown); }
  }

  let entry!: RunningEntry;
  let leader: LeaderHandle | null = null;
  let proc: ChildProcess;
  if (acp) {
    // The ACP CLI is spawned inside createAcpLeader (synchronously): its spawn is captured here so the run has a pid and can be stopped, swept and watched like any other.
    const started: { child: ChildProcess | null; error: Error | null } = { child: null, error: null };
    const acpSpawn: AcpSpawn = (program, args, options) => {
      try { return (started.child = spawnFn === spawn ? spawnAcpChild(program, args, options) : (spawnFn as unknown as AcpSpawn)(program, args, options)); }
      catch (error) { started.error = error as Error; throw error; }
    };
    const live = (): boolean => entry !== undefined && ownsRun(run.runId, entry);
    const note = (text: string): void => { appendLog(text); cb.onOutput(run, text); };
    const events: LeaderCallbacks = {
      onDelta: (text) => { if (live()) note(text); },
      // A normal end of the prompt is "done", whatever exit code the killed process then gives.
      onDone: () => { if (live()) { entry.outcome ??= "done"; leader?.stop(); } },
      onError: (message) => { if (live() && !entry.stopRequested) { note(`\n[error] ${message}\n`); entry.outcome ??= "failed"; leader?.stop(); } },
      onUsage: (delta) => { if (live()) cb.onUsage?.(run, delta); },
      onNotice: (message) => { if (live()) note(`\n[notice] ${message}\n`); },
    };
    writeFileSync(briefPath, prompt, "utf8");
    leader = createAcpLeader({ model: "default", effort: "default" }, run.folder, events, {
      cli: run.acp!, bridge: run.crewTools, needHttp: Boolean(run.crewTools), denyPermissions: !run.canWrite, spawnFn: acpSpawn,
    });
    if (!started.child) { leader.stop(); unlinkSync(briefPath); return { ok: false, error: describeSpawnError(started.error ?? new Error(`${run.acp!.name} could not start`), run.folder) }; }
    proc = started.child;
  } else {
    writeFileSync(briefPath, prompt, "utf8");
    if (mcpPath) writeFileSync(mcpPath, JSON.stringify({ mcpServers: { [CREW_SERVER]: { type: "http", url: run.crewTools!.url, headers: { Authorization: `Bearer ${run.crewTools!.token}` } } } }), { encoding: "utf8", mode: 0o600 });
    try { proc = spawnFn(resolvedCommand, { shell: true, cwd: run.folder, stdio: ["ignore", "pipe", "pipe"], env }); }
    catch (error) { removeMcp(); throw error; }
  }
  // Only a real child has descendants to find; a fake process (tests) has a made-up pid that could name something else.
  const watch = spawnFn === spawn && proc.pid ? watchProcessTree(proc.pid, Date.now()) : null;

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const claudeState: AgentUsageState | null = run.cli === "claude" ? createAgentUsageState() : null;
  const codexState: AgentUsageState | null = run.cli === "codex" ? createAgentUsageState() : null;

  function emitClaudeEvents(events: AgentUsageEvent[]): void {
    for (const event of events) {
      if (event.text) emit(event.text, outHider);
      if (event.usage) cb.onUsage?.(run, event.usage);
      if (event.rateLimit) cb.onRateLimit?.(event.rateLimit);
    }
  }
  function emitCodexTokenDeltas(deltas: UsageDelta[]): void { for (const delta of deltas) cb.onUsage?.(run, delta); }
  function flush(): void {
    const stdoutTail = stdoutDecoder.end();
    if (stdoutTail) {
      if (claudeState) emitClaudeEvents(feedClaudeOutput(claudeState, stdoutTail));
      else emit(stdoutTail, outHider);
    }
    const stderrTail = stderrDecoder.end();
    if (stderrTail) {
      emit(stderrTail, errHider);
      if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, stderrTail));
    }
    if (claudeState) emitClaudeEvents(flushClaudeOutput(claudeState));
    if (codexState) emitCodexTokenDeltas(flushCodexTokens(codexState));
    // What the hiders still held back (the start of a token that never completed) goes out last.
    for (const tail of [outHider.end(), errHider.end()]) if (tail) emit(tail, passThrough);
  }

  entry = { run, proc, cb, logPath, flush, watch };
  running.set(run.runId, entry);
  const ids = bySeat.get(run.seatKey) ?? new Set<string>();
  ids.add(run.runId);
  bySeat.set(run.seatKey, ids);
  // An ACP seat's stdout is the protocol, read by its adapter; only a shell run's output is the run's text.
  if (!acp) proc.stdout?.on("data", (chunk: Buffer) => {
    if (!ownsRun(run.runId, entry)) return;
    const text = stdoutDecoder.write(chunk);
    if (!text) return;
    if (claudeState) { emitClaudeEvents(feedClaudeOutput(claudeState, text)); return; }
    emit(text, outHider);
  });
  if (!acp) proc.stderr?.on("data", (chunk: Buffer) => {
    if (!ownsRun(run.runId, entry)) return;
    const text = stderrDecoder.write(chunk);
    if (!text) return;
    emit(text, errHider);
    if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, text));
  });
  // One finalizer for close, exit and spawn error: ownership makes it run once, and
  // either way buffered output is flushed and the log gets an exit marker.
  function finish(code: number | undefined, spawnError?: Error): void {
    if (!ownsRun(run.runId, entry)) return;
    removeRun(run.runId, entry);
    removeMcp();
    try { flush(); } catch { /* the end is still reported below */ }
    if (spawnError) {
      const message = `\n[spawn error] ${describeSpawnError(spawnError, run.folder)}\n`;
      appendLog(message); cb.onOutput(run, message);
    }
    const report = (): void => {
      const status = spawnError ? "failed" : entry.stopRequested ? "stopped" : entry.outcome ?? (code === 0 ? "done" : "failed");
      appendLog(formatExitMarker(status, code));
      cb.onStatus(run, status, code);
      letGoOfPipes();
    };
    if (!watch) { report(); return; }
    // Whatever the CLI left running (a dev server, a background shell) is stopped before the run is reported over; bounded, so a slow process list never holds the report.
    let capped: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolveBound) => { capped = setTimeout(resolveBound, SWEEP_WAIT_MS); capped.unref(); });
    // A check that could not finish (no process list, an error, the cap) never changes the run's outcome, but the log says so.
    let checked = false, said = false;
    const unchecked = (): void => { if (said) return; said = true; const message = "\n[cleanup] could not check for processes this run left running\n"; appendLog(message); cb.onOutput(run, message); };
    const swept = watch.sweep(entry.exitedAt ?? Date.now()).then((killed) => {
      checked = true;
      if (killed === null) return unchecked();
      // A leftover that could not be stopped is said, never a quiet Done: it may still be editing files.
      const failed = watch.failed;
      const say = (count: number, what: string): void => { const message = `\n[cleanup] ${what} ${count} process${count === 1 ? "" : "es"} this run left running\n`; appendLog(message); cb.onOutput(run, message); };
      if (killed) say(killed, "stopped");
      if (failed > 0) say(failed, "could not stop");
    }, () => { checked = true; unchecked(); });
    void Promise.race([swept, bounded]).then(() => { clearTimeout(capped); if (!checked) unchecked(); report(); });
  }
  // A leftover that inherited the CLI's output pipes would hold the server's handles after the run is over (it is stopped by the sweep, or said in the log when it could not be); output is flushed and the status reported before this runs.
  function letGoOfPipes(): void { proc.stdout?.destroy?.(); proc.stderr?.destroy?.(); }
  function ended(code: number | null): void {
    if (released.delete(entry)) {
      removeMcp();
      void watch?.sweep(entry.exitedAt ?? Date.now()).catch(() => {});
      letGoOfPipes();
      entry.cb.onReleasedClose?.(run, code ?? undefined);
      return;
    }
    // A close with no exit code (the process was killed from outside) is a failed run, not a failed spawn.
    finish(code ?? -1);
  }
  proc.on("close", (code) => { entry.exitedAt ??= Date.now(); ended(code); });
  // A grandchild that keeps stdout open delays "close" for ever: after the process itself exits, give the pipes a moment to drain, then finish.
  proc.on("exit", (code) => { entry.exitedAt ??= Date.now(); setTimeout(() => ended(code), EXIT_DRAIN_MS).unref(); });
  proc.on("error", (err) => finish(undefined, err));
  // The child is tracked above before anything here can throw, so a failing state write never orphans it.
  try { cb.onStatus(run, "working"); }
  catch (error) { appendLog(`\n[warning] the working state could not be saved: ${(error as Error).message}\n`); }
  // The brief is the one prompt an ACP seat gets (the shell CLIs are told to read the brief file instead).
  leader?.send(prompt, []);
  return { ok: true, timestamp };
}

function isSafeSeatKey(value: string): boolean { return value.length > 0 && /^[A-Za-z0-9._-]+$/.test(value); }
const KILL_GRACE_MS = 5000;
const EXIT_DRAIN_MS = 750;
// The cap must cover the work it waits for: one process list, then the kills (they run together), plus a margin.
const SWEEP_WAIT_MS = LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000;
function reportUnconfirmedKill(runId: string, entry: RunningEntry, reason: string): void {
  if (!ownsRun(runId, entry)) return;
  entry.unconfirmed = true;
  entry.cb.onUnconfirmedKill?.(entry.run, entry.proc.pid);
  entry.cb.onOutput(entry.run, `\n[kill] ${reason}\n`);
}
// taskkill is spawned from System32 without a shell: its lookup then finds that copy first, never one planted in the server's own folder.
function spawnTaskkill(spawnFn: Spawn, pid: number): ChildProcess {
  return spawnFn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, cwd: join(process.env.SystemRoot || "C:\\Windows", "System32") });
}
export function killRun(runId: string, spawnFn: Spawn = spawn): boolean {
  const entry = running.get(runId);
  if (!entry || !entry.proc.pid) return false;
  entry.stopRequested = true;
  const killer = spawnTaskkill(spawnFn, entry.proc.pid);
  killer.on("error", (err) => reportUnconfirmedKill(runId, entry, `taskkill could not be started: ${err.message}; the process may still be running -- press Kill to try again`));
  const grace = setTimeout(() => reportUnconfirmedKill(runId, entry, "process did not exit within the grace period; it may still be running -- press Kill to try again"), KILL_GRACE_MS);
  grace.unref();
  entry.proc.once("close", () => clearTimeout(grace));
  return true;
}
export function stopAllRunning(spawnFn: Spawn = spawn): void {
  for (const runId of [...running.keys()]) killRun(runId, spawnFn);
  for (const entry of released) {
    const killer = spawnTaskkill(spawnFn, entry.proc.pid!);
    killer.on("error", () => {});
    void entry.watch?.sweep(entry.exitedAt ?? Date.now()).catch(() => {});
  }
}
