import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataRoot } from "./data-root.ts";
import { writeFileSynced } from "./safe-file.ts";
import type { PermissionMode } from "./settings.ts";
import type { UsageDelta } from "./usage.ts";

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

export const LEADER_START_TIMEOUT_MS = 20_000;

// ---- What the leader is doing, in plain words. A label comes from the KIND of step (this table) and never from its input or output:
// a command, a search, a path or a file's text can hold a secret. The one exception is a Claude Skill's name (an identifier), cleaned below. ----
export const ACTIVITY = { command: "Running a command", read: "Reading a file", search: "Searching files", edit: "Editing files", web: "Searching the web", page: "Reading a web page", plan: "Planning", think: "Thinking", tool: "Using a tool", skill: "Using a skill" } as const;
export type ActivityStep = { label: string; helper: boolean };
// The crew tools already show as crew runs in the side panel: no step line for them. Same name as OPENCODE_CREW_SERVER and the Claude mcpServers key.
const CREW_SERVER = "tab-crew";
// One table for all three CLIs' tool names (Claude: Bash, WebSearch, Task...; OpenCode: bash, websearch, task...). null = a crew tool, to be skipped.
export function toolActivity(name: unknown): ActivityStep | null {
  const raw = typeof name === "string" ? name : "";
  if (raw.startsWith(`mcp__${CREW_SERVER}__`) || raw.startsWith(`${CREW_SERVER}_`)) return null;
  const step = (label: string, helper = false): ActivityStep => ({ label, helper });
  switch (raw.toLowerCase().replace(/[^a-z0-9]/g, "")) {
    case "bash": case "powershell": case "bashoutput": case "killshell": case "killbash": case "shell": return step(ACTIVITY.command);
    case "read": case "notebookread": return step(ACTIVITY.read);
    case "glob": case "grep": case "ls": case "list": case "search": case "codesearch": return step(ACTIVITY.search);
    case "write": case "edit": case "multiedit": case "notebookedit": case "patch": case "applypatch": return step(ACTIVITY.edit);
    case "websearch": return step(ACTIVITY.web);
    case "webfetch": case "fetch": return step(ACTIVITY.page);
    case "task": case "agent": return step("helper", true);
    case "todowrite": case "todoread": case "exitplanmode": case "enterplanmode": return step(ACTIVITY.plan);
    case "skill": return step(ACTIVITY.skill);
    default: return step(ACTIVITY.tool);
  }
}
export const cleanSkillName = (value: unknown): string | null => String(value ?? "").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 40) || null;
// The steps running now, one label out: the newest step, or "N helpers working" when that is a helper. Nothing running = Thinking. Only a change is passed on.
// quiet: the answer itself is being written, nothing else to say while no step runs.
export type ActivityTracker = { start: (id: string, step: ActivityStep | null) => void; end: (id: string) => void; thinking: () => void; quiet: () => void; reset: () => void };
export function createActivityTracker(emit: (label: string | null) => void): ActivityTracker {
  const running = new Map<string, ActivityStep>();
  let shown: string | undefined;
  const show = (): void => {
    const steps = [...running.values()], last = steps.at(-1), helpers = steps.filter((item) => item.helper).length;
    const label = !last ? ACTIVITY.think : last.helper ? `${helpers} helper${helpers === 1 ? "" : "s"} working` : last.label;
    if (label !== shown) { shown = label; emit(label); }
  };
  return {
    start(id, step) { if (step) { running.set(id, step); show(); } },
    end(id) { if (running.delete(id)) show(); },
    thinking() { if (!running.size) show(); },
    quiet() { if (!running.size && shown !== null) { shown = null; emit(null); } },
    reset() { running.clear(); shown = undefined; },
  };
}

// Separate messages of one reply must not glue together ("one scene.Codex is drawing"): the first text of a new message / item / part, after text already said in this
// reply, starts on a new paragraph, unless the text so far already ends with a newline. The key names the message the text belongs to. The first text of a reply gets nothing.
export type Paragraphs = { text: (text: string, messageKey: string | number) => string; reset: () => void };
export function createParagraphs(): Paragraphs {
  let said = false, tail = "", lastKey: string | number | undefined;
  return {
    text(text, messageKey) {
      const fresh = messageKey !== lastKey;
      lastKey = messageKey;
      if (!text) return text;
      const out = fresh && said && !tail.endsWith("\n") ? `\n\n${text}` : text;
      said = true; tail = (tail + out).slice(-2);
      return out;
    },
    reset() { said = false; tail = ""; lastKey = undefined; },
  };
}

// A background job's description is written by the model: control characters out, 80 characters at most.
export const cleanJobDescription = (value: unknown): string => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "a background command";

// cmd.exe looks in the current folder before PATH, so a codex.cmd planted in a project folder would run instead of the real CLI.
// Resolve the CLI ourselves from PATH (never the cwd) and spawn that absolute path; cmd.exe is also told not to search the cwd.
const CLI_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"];
// Filesystem identity, not spelling: an 8.3 short name or a junction alias of a folder resolves to the same real path. A path that does not exist has nothing to find in it, so its resolved spelling is enough.
function realKey(path: string): string {
  try { return realpathSync.native(path).toLowerCase(); } catch { /* missing: resolve its nearest existing parent */ }
  const full = resolve(path);
  const parent = dirname(full);
  return parent === full ? full.toLowerCase() : join(realKey(parent), basename(full).toLowerCase());
}
export function isInsideFolder(path: string, folder: string): boolean {
  const entry = realKey(path);
  const root = realKey(folder);
  // A drive or share root holds the whole drive, so every program on it would count as "inside the project": there only the root itself is refused.
  // Callers pass an executable (leader) or a PATH directory (resolver): a file directly in the root counts as the root.
  if (dirname(root) === root) {
    let file: boolean;
    try { file = statSync(path).isFile(); } catch { file = CLI_EXTENSIONS.includes(extname(path).toLowerCase()); }
    return (file ? dirname(entry) : entry) === root;
  }
  return entry === root || entry.startsWith(root.endsWith(sep) ? root : root + sep);
}
// isAbsolute is also true for a drive-relative path like \Users\x (it resolves on whichever drive the spawn runs on). Only a drive letter + slash or a UNC share is fully qualified.
export function isFullyQualified(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(path);
}
// Every tab and project folder of the current workspace: a CLI that lies inside any of them is never used. The server registers the live list at startup.
let workspaceFolders: () => string[] = () => [];
export function setCliSkipFolders(getFolders: () => string[]): void { workspaceFolders = getFolders; }
export function cliSkipFolders(cwd?: string | string[]): string[] { return [...(cwd === undefined ? [] : [cwd].flat()), ...workspaceFolders()].filter(Boolean); }
export function resolveCliPath(name: string, env: NodeJS.ProcessEnv = process.env, cwd?: string | string[], ignoreSkip = false): string | null {
  const skip = ignoreSkip ? [] : cliSkipFolders(cwd);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  for (const raw of (pathKey ? env[pathKey] ?? "" : "").split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !isFullyQualified(dir)) continue;
    if (skip.some((folder) => isInsideFolder(dir, folder))) continue;
    for (const ext of CLI_EXTENSIONS) {
      const candidate = join(dir, `${name}${ext}`);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
    }
  }
  return null;
}
// Every CLI program name Command Center starts by name (settings calls included). A start by any of these goes through the safe resolution below.
export const KNOWN_CLI_NAMES = ["claude", "codex", "opencode", "gemini"] as const;
const KNOWN_CLI_START = new RegExp(`^(${KNOWN_CLI_NAMES.join("|")})(?=\\s|$)`);
// The absolute path of a CLI found on PATH outside every project folder; fails closed (a bare name would make cmd.exe search the inherited PATH, which may hold the project folder).
export function resolveCliOrThrow(name: string, env: NodeJS.ProcessEnv = process.env, cwd?: string | string[]): string {
  const found = resolveCliPath(name, env, cwd);
  if (!found) {
    const hidden = resolveCliPath(name, env, cwd, true);
    throw new Error(hidden
      ? `${name} was found only inside a project folder (${dirname(hidden)}), which is never used; install it outside your project folders or remove that project folder`
      : `${name} was not found on PATH`);
  }
  if (/["%]/.test(found)) throw new Error(`${name} was not found on PATH`);
  return found;
}
// Swaps the leading CLI name of a fixed command for its quoted absolute path. A CLI that cannot be resolved (or whose path cmd.exe would expand) fails closed.
export function withResolvedCli(command: string, env: NodeJS.ProcessEnv = process.env, cwd?: string | string[]): string {
  const name = command.match(KNOWN_CLI_START)?.[1];
  if (!name) return command;
  return `"${resolveCliOrThrow(name, env, cwd)}"${command.slice(name.length)}`;
}
export const spawnLeaderChild: LeaderSpawn = (command, options) => spawn(withResolvedCli(command, (options.env ?? process.env) as NodeJS.ProcessEnv, typeof options.cwd === "string" ? options.cwd : undefined), options);
// A CLI added from Settings (program + argument list, validated in config.ts): resolved the same safe way. An .exe/.com runs directly with no shell;
// a .cmd/.bat (npm's shims) can only run through cmd.exe, so there the validated plain-word arguments are put in one quoted command line.
export type AcpSpawn = (program: string, args: string[], options: SpawnOptions) => ChildProcess;
export const spawnAcpChild: AcpSpawn = (program, args, options) => {
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  const found = resolveCliOrThrow(program, env, typeof options.cwd === "string" ? options.cwd : undefined);
  if (/\.(?:cmd|bat)$/i.test(found)) return spawn(`"${found}"${args.map((arg) => ` ${arg}`).join("")}`, { ...options, shell: true });
  return spawn(found, args, { ...options, shell: false });
};

// Which adapter starts a leader CLI. An unknown kind fails closed: it is never started as Claude.
export function leaderKindOf(cli: unknown): "claude" | "codex" | "opencode" | "acp" {
  if (cli === "claude" || cli === "codex" || cli === "opencode") return cli;
  if (typeof cli === "string" && /^acp:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cli)) return "acp";
  throw new Error(`Unknown leader CLI "${String(cli).slice(0, 40)}". Pick another leader CLI.`);
}

// The leader child must never inherit the app's private data root, the app key or a stray server password (same strip as buildLeaderOptions).
export function leaderChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const { CC_DATA_DIR: _ccDataDir, CC_TEST_FORCE_PACKAGED: _ccTestForcePackaged, CC_APP_KEY: _ccAppKey, OPENCODE_SERVER_PASSWORD: _ocPassword, ...childEnv } = process.env;
  return { ...childEnv, NoDefaultCurrentDirectoryInExePath: "1", ...extra };
}

// Absolute System32 paths: a bare "taskkill" or "powershell" is looked for in the current folder first.
function systemRoot(): string { return process.env.SystemRoot || "C:\\Windows"; }
export function windowsSystem32(): string { return join(systemRoot(), "System32"); }
export function windowsTaskkillPath(): string { return join(windowsSystem32(), "taskkill.exe"); }
export function windowsPowerShellPath(): string { return join(windowsSystem32(), "WindowsPowerShell", "v1.0", "powershell.exe"); }

// A spawn failure for a missing tab folder reads "spawn cmd.exe ENOENT", which blames the shell: say what is really missing.
export function describeSpawnError(error: Error, folder?: string): string {
  if ((error as NodeJS.ErrnoException).code === "ENOENT" && folder && !existsSync(folder)) return `the tab folder no longer exists: ${folder}`;
  return error.message;
}

const KILL_CONFIRM_MS = 2_000;
// Same tree kill the runner uses: the shell wrapper's pid is not the real CLI.
// A killer that fails (other than "process not found", 128) is reported once through onUnconfirmed, never silent.
export function killProcessTree(child: ChildProcess, onUnconfirmed?: () => void): void {
  if (!child.pid || child.exitCode !== null) return;
  // kill() returns false when the signal could not be sent; a child that already ended is not a failure.
  const plainKill = (): void => {
    let sent = false;
    try { sent = child.kill(); } catch { /* reported below */ }
    if (!sent && child.exitCode === null && child.signalCode === null) onUnconfirmed?.();
  };
  if (process.platform !== "win32") { plainKill(); return; }
  const forced = process.env.CC_TEST_FAKE_CLI === "1" ? process.env.CC_TEST_KILLER_EXIT : undefined;
  const killer = forced !== undefined
    ? spawn(process.execPath, ["-e", `process.exit(${Number(forced) || 0})`], { windowsHide: true, stdio: "ignore" })
    : spawn(windowsTaskkillPath(), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  killer.on("error", plainKill);
  killer.on("exit", (code) => {
    if (code === 0 || code === 128) return;
    // Two overlapping taskkills on one tree can make one of them exit with another code though the tree is gone: the root still alive after a short wait is the only proof it was not stopped.
    const ended = (): boolean => child.exitCode !== null || child.signalCode !== null;
    if (ended()) return;
    const finish = (alive: boolean): void => { clearTimeout(timer); child.off("exit", onExit); if (alive) onUnconfirmed?.(); };
    const onExit = (): void => finish(false);
    const timer = setTimeout(() => finish(!ended()), KILL_CONFIRM_MS);
    timer.unref();
    child.once("exit", onExit);
  });
}

// A tracked child's end is two steps: the root exits, then its exit sweep stops what it left behind. Until the sweep finished clean the leader is not gone.
type ChildLife = { sweeping: boolean; failed: boolean; reported: boolean; recheck: () => Promise<void> };
const childLives = new WeakMap<ChildProcess, ChildLife>();
export type LeaderProcessState = { running: boolean; killFailed: boolean; recheck?: () => Promise<void> };
export function leaderProcessState(child: ChildProcess | null, killFailed: boolean): LeaderProcessState {
  const life = child ? childLives.get(child) : undefined;
  const rootRunning = Boolean(child?.pid) && child!.exitCode === null && child!.signalCode === null;
  return { running: rootRunning || Boolean(life?.sweeping || life?.failed), killFailed: killFailed || Boolean(life?.failed), ...(life ? { recheck: life.recheck } : {}) };
}

export function deadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

// ---- Process trees. Without a Windows job object, a CLI's descendants are found by parent pid. ----
// While a CLI lives, a shared poll remembers every descendant (pid + creation time). When the CLI is stopped or ends, the ones still
// alive with the SAME creation time (so a reused pid is never touched) are killed. The same list is kept in a registry file, so a
// server that died hard (the native crash skips every exit hook) has its leftovers killed by the next start.
// ponytail: a process started and orphaned between two polls (POLL_MS) is missed; a Windows job object would close that gap.
export type ProcInfo = { pid: number; ppid: number; created: number };
export type ProcessLister = () => Promise<ProcInfo[] | null>;
// sweep(endedAt): endedAt is when the watched process ended (ms); children it started before then are still found by parent pid after it is gone.
// failed: how many leftovers the latest sweep tried to stop and could not (sweep's number counts only the ones it did stop).
export type TreeWatch = { sweep: (endedAt?: number) => Promise<number | null>; release: () => void; readonly failed: number };
export type TreeDeps = { list: ProcessLister; kill: (pid: number) => Promise<boolean>; registryDir?: () => string | null; pollMs?: number; now?: () => number; sweepAtFirstWatch?: boolean };
// slow: a long-lived process (a leader) that is looked at every SLOW_POLL_MS instead of POLL_MS while no worker run needs the fast poll.
export type TreeTracker = { watch: (pid: number, startedAt?: number, slow?: boolean) => TreeWatch; flushRegistry: () => void };

const POLL_MS = 5_000;
const SLOW_POLL_MS = 30_000;
export const LIST_TIMEOUT_MS = 8_000;
export const KILL_TIMEOUT_MS = 4_000;
// A process is ours when it was created within this window around the moment we spawned it.
const BEFORE_SPAWN_MS = 5_000;
const AFTER_SPAWN_MS = 2_000;
const LIST_SCRIPT = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Where-Object { $_.CreationDate } | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }';

export function parseProcessList(text: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+),(\d+),(\d+)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), created: Number(match[3]) });
  }
  return rows;
}
// The descendants of rootPid by parent pid (the root itself excluded), a child only when created no earlier than its parent.
export function descendantsOf(list: ProcInfo[], rootPid: number): number[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const proc of list) byParent.set(proc.ppid, [...(byParent.get(proc.ppid) ?? []), proc]);
  const byPid = new Map(list.map((proc) => [proc.pid, proc]));
  const found: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const parentPid = queue.shift()!;
    const parent = byPid.get(parentPid);
    for (const child of byParent.get(parentPid) ?? []) {
      if (seen.has(child.pid) || (parent && child.created < parent.created)) continue;
      seen.add(child.pid); found.push(child.pid); queue.push(child.pid);
    }
  }
  return found;
}
// The process list through PowerShell (about 0.3 s): no compile step to time out on a cold start. null = it could not be read.
export function listProcesses(spawnFn: typeof spawn = spawn, timeoutMs = LIST_TIMEOUT_MS): Promise<ProcInfo[] | null> {
  return new Promise((done) => {
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: ProcInfo[] | null) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); done(value); };
    let child: ChildProcess;
    try { child = spawnFn(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", LIST_SCRIPT], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: leaderChildEnv() }); }
    catch { settle(null); return; }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { output += chunk; });
    timer = setTimeout(() => { try { child.kill(); } catch { /* the timeout answers null */ } settle(null); }, timeoutMs);
    child.once("error", () => settle(null));
    child.once("close", (code) => settle(code === 0 ? parseProcessList(output) : null));
  });
}
function killPid(pid: number): Promise<boolean> {
  return new Promise((done) => {
    let killer: ChildProcess;
    try { killer = spawn(windowsTaskkillPath(), ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { done(false); return; }
    const timer = setTimeout(() => { try { killer.kill(); } catch { /* answered below */ } done(false); }, KILL_TIMEOUT_MS);
    timer.unref();
    killer.once("error", () => { clearTimeout(timer); done(false); });
    killer.once("exit", (code) => { clearTimeout(timer); done(code === 0 || code === 128); });
  });
}

// Test seam (the fake-CLI runner only): CC_TEST_TREE_FILE names a JSON file { extra: ProcInfo[], failKill: number[] } read at every use. The listed
// made-up processes join the real process list, and their kill is only pretended (it fails for the pids in failKill). Real processes are untouched.
// listDelayMs slows every list by that long (a busy PC), failList: true makes it unreadable (null).
// Every pretended kill is also appended to <CC_TEST_TREE_FILE>.kills as one JSON line { pid, ok, at }, so a test can wait for a sweep's attempt.
const treeSeamFile = (): string | undefined => (process.env.CC_TEST_FAKE_CLI === "1" ? process.env.CC_TEST_TREE_FILE : undefined);
// A read that fails (the file is being replaced) keeps the last good value, so a race cannot make the made-up processes vanish for one read.
type TreeSeam = { extra: ProcInfo[]; failKill: number[]; listDelayMs?: number; failList?: boolean };
let lastSeam: TreeSeam = { extra: [], failKill: [] };
function treeSeam(): TreeSeam {
  try { lastSeam = { extra: [], failKill: [], ...JSON.parse(readFileSync(treeSeamFile()!, "utf8")) }; } catch { /* keep the last good one */ }
  return lastSeam;
}
// A leader child is watched when it is the real CLI (its pid is real); a test's fake CLI child only with the seam above, whose process is real too.
export const watchesLeaderChild = (spawnFn: unknown): boolean => spawnFn === undefined || treeSeamFile() !== undefined;
async function listWithSeam(): Promise<ProcInfo[] | null> {
  const list = await listProcesses();
  if (!treeSeamFile()) return list;
  const seam = treeSeam();
  if (seam.listDelayMs) await new Promise((done) => setTimeout(done, seam.listDelayMs));
  return list && !seam.failList ? [...list, ...seam.extra] : null;
}
function killWithSeam(pid: number): Promise<boolean> {
  if (treeSeamFile()) {
    const seam = treeSeam();
    if (seam.extra.some((proc) => proc.pid === pid)) {
      const ok = !seam.failKill.includes(pid);
      try { appendFileSync(`${treeSeamFile()}.kills`, JSON.stringify({ pid, ok, at: Date.now() }) + "\n"); } catch { /* the record is only for the tests */ }
      return Promise.resolve(ok);
    }
  }
  return killPid(pid);
}

type WatchedRoot = { pid: number; startedAt: number; slow: boolean; endedAt: number | null; rootCreated: number | null; known: Map<number, number> };
type RegistryFile = { owner: { pid: number; created: number | null }; roots: Array<{ pid: number; rootCreated: number | null; known: Array<[number, number]> }> };
const REGISTRY_FILE = /^\.children-(\d+)\.json$/;

export function createTreeTracker(deps: TreeDeps): TreeTracker {
  const roots = new Set<WatchedRoot>();
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;
  let timerMs = 0;
  let polling = false;
  let ownerCreated: number | null = null;
  let swept = !deps.sweepAtFirstWatch;

  function writeRegistry(): void {
    const dir = deps.registryDir?.();
    if (!dir) return;
    const file = join(dir, `.children-${process.pid}.json`);
    try {
      const keep = [...roots].filter((root) => root.known.size > 0 || root.rootCreated !== null);
      if (!keep.length) { try { unlinkSync(file); } catch { /* none written */ } return; }
      const body: RegistryFile = { owner: { pid: process.pid, created: ownerCreated }, roots: keep.map((root) => ({ pid: root.pid, rootCreated: root.rootCreated, known: [...root.known] })) };
      // Only the logs folder itself is created, never its parents: a data root that is gone (a test removed it) is not brought back by the exit hook.
      try { mkdirSync(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
      const temp = `${file}.tmp`;
      try { unlinkSync(temp); } catch { /* none left over */ }
      writeFileSynced(temp, JSON.stringify(body));
      renameSync(temp, file);
    } catch { /* the registry is a safety net; the live kill paths do not depend on it */ }
  }
  // Adds what the list shows under this root to its known set; true when something new was found.
  function discover(root: WatchedRoot, list: ProcInfo[]): boolean {
    const byPid = new Map(list.map((proc) => [proc.pid, proc]));
    const at = byPid.get(root.pid);
    // Once the root's creation time is known only that exact process is the root; a later one with the same pid is somebody else.
    const ours = at !== undefined && (root.rootCreated !== null
      ? at.created === root.rootCreated
      : at.created >= root.startedAt - BEFORE_SPAWN_MS && at.created <= root.startedAt + AFTER_SPAWN_MS && (root.endedAt === null || at.created <= root.endedAt));
    const byParent = new Map<number, ProcInfo[]>();
    for (const proc of list) byParent.set(proc.ppid, [...(byParent.get(proc.ppid) ?? []), proc]);
    const queue: ProcInfo[] = [];
    let changed = false;
    if (ours) { queue.push(at); if (root.rootCreated !== at.created) { root.rootCreated = at.created; changed = true; } }
    // The root is gone: what it started still names its pid as parent. Its pid cannot be reused before it ended, so anything created
    // between its start and its end is its child; anything created later (or after another process took the pid) is not.
    // A child older than the root belongs to an earlier owner of the pid: the root's own creation time when known, else the spawn moment.
    else if (root.endedAt !== null) {
      const notBefore = root.rootCreated ?? root.startedAt;
      for (const child of byParent.get(root.pid) ?? []) {
        if (child.created < notBefore || child.created >= root.endedAt || (at !== undefined && child.created >= at.created)) continue;
        queue.push(child);
        if (root.known.get(child.pid) !== child.created) { root.known.set(child.pid, child.created); changed = true; }
      }
    }
    for (const [pid, created] of root.known) { const proc = byPid.get(pid); if (proc && proc.created === created) queue.push(proc); }
    const seen = new Set<number>(queue.map((proc) => proc.pid));
    while (queue.length) {
      const parent = queue.shift()!;
      for (const child of byParent.get(parent.pid) ?? []) {
        if (seen.has(child.pid) || child.created < parent.created) continue;
        seen.add(child.pid); queue.push(child);
        if (root.known.get(child.pid) !== child.created) { root.known.set(child.pid, child.created); changed = true; }
      }
    }
    return changed;
  }
  function noteOwner(list: ProcInfo[]): void {
    if (ownerCreated === null) ownerCreated = list.find((proc) => proc.pid === process.pid)?.created ?? null;
  }
  let pollAgain = false;
  async function tick(): Promise<void> {
    if (polling) { pollAgain = true; return; } // a list already running may predate this ask: one more right after it
    polling = true;
    try {
      const list = await deps.list();
      if (!list) return;
      noteOwner(list);
      let changed = false;
      for (const root of roots) if (discover(root, list)) changed = true;
      if (changed) writeRegistry();
    } finally { polling = false; if (pollAgain) { pollAgain = false; void tick().catch(() => {}); } }
  }
  // One poll for every watched root: fast while any worker run is among them, slow when only leaders are.
  function reschedule(): void {
    if (!roots.size) { if (timer) clearInterval(timer); timer = null; return; }
    const ms = deps.pollMs ?? ([...roots].some((root) => !root.slow) ? POLL_MS : SLOW_POLL_MS);
    if (timer && timerMs === ms) return;
    if (timer) clearInterval(timer);
    timerMs = ms;
    timer = setInterval(() => { void tick().catch(() => {}); }, ms);
    timer.unref();
  }

  return {
    watch(pid, startedAt = now(), slow = false) {
      const root: WatchedRoot = { pid, startedAt, slow, endedAt: null, rootCreated: null, known: new Map() };
      let failed = 0;
      roots.add(root);
      reschedule();
      void tick().catch(() => {}); // record the root and its creation time at once, not after the first slow poll
      if (!swept) { swept = true; void sweepOrphanedChildren(deps).catch(() => {}); }
      return {
        get failed() { return failed; },
        // Kills what this root left alive; null = the process list could not be read, so nothing was touched.
        async sweep(endedAt) {
          failed = 0;
          if (!roots.has(root)) return 0;
          if (endedAt !== undefined) root.endedAt = endedAt;
          const list = await deps.list();
          if (!list) return null;
          noteOwner(list);
          discover(root, list);
          const alive = new Map(list.map((proc) => [proc.pid, proc.created]));
          const targets = [...root.known].filter(([knownPid, created]) => alive.get(knownPid) === created).map(([knownPid]) => knownPid);
          if (root.rootCreated !== null && alive.get(root.pid) === root.rootCreated) targets.push(root.pid);
          const results = await Promise.all(targets.map((target) => deps.kill(target)));
          // A target whose kill failed stays tracked (here and in the registry), so a later sweep or the next start retries it.
          failed = results.filter((ok) => !ok).length;
          targets.forEach((target, i) => { if (results[i]) root.known.delete(target); });
          if (results.every(Boolean)) roots.delete(root);
          reschedule();
          writeRegistry();
          return results.filter(Boolean).length;
        },
        release() { roots.delete(root); reschedule(); writeRegistry(); },
      };
    },
    // At process exit: a root with remembered leftovers keeps its registry file, so the next start can finish the job with verified pids.
    flushRegistry: writeRegistry,
  };
}

// Run at start: the registry files of servers that no longer exist name children that survived them. Each is killed only if it is still
// alive with the creation time that was recorded (a reused pid is left alone).
// The whole sweep has one cap (the server waits for it before listening, and Electron waits 15 s for the server); what is not done by then stays in its registry file for the next start.
export const SWEEP_CAP_MS = 8_000;
export async function sweepOrphanedChildren(deps: Pick<TreeDeps, "list" | "kill" | "registryDir"> & { capMs?: number }): Promise<{ checked: number; killed: number }> {
  const result = { checked: 0, killed: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((done) => { timer = setTimeout(done, deps.capMs ?? SWEEP_CAP_MS); timer.unref(); });
  try { await Promise.race([sweepFiles(deps, result), cap]); } finally { clearTimeout(timer); }
  return { ...result };
}
async function sweepFiles(deps: Pick<TreeDeps, "list" | "kill" | "registryDir">, result: { checked: number; killed: number }): Promise<void> {
  const dir = deps.registryDir?.();
  if (!dir) return;
  let names: string[];
  try { names = readdirSync(dir).filter((name) => REGISTRY_FILE.test(name) && name !== `.children-${process.pid}.json`); } catch { return; }
  if (!names.length) return;
  const list = await deps.list();
  if (!list) return;
  const alive = new Map(list.map((proc) => [proc.pid, proc.created]));
  // Every file's kills run at once, so one hung kill does not queue the others behind it.
  await Promise.all(names.map(async (name) => {
    const file = join(dir, name);
    let body: RegistryFile | null = null;
    try { body = JSON.parse(readFileSync(file, "utf8")) as RegistryFile; } catch { /* unreadable: removed below */ }
    if (body && Number.isSafeInteger(body.owner?.pid)) {
      const ownerCreated = alive.get(body.owner.pid);
      const ownerAlive = ownerCreated !== undefined && (body.owner.created === null || Math.abs(ownerCreated - body.owner.created) < 2_000);
      if (ownerAlive) return;
      const targets: number[] = [];
      for (const root of Array.isArray(body.roots) ? body.roots : []) {
        if (Number.isSafeInteger(root?.pid) && root.rootCreated !== null && alive.get(root.pid) === root.rootCreated) targets.push(root.pid);
        for (const entry of Array.isArray(root?.known) ? root.known : []) if (Array.isArray(entry) && alive.get(entry[0]) === entry[1]) targets.push(entry[0]);
      }
      result.checked += targets.length;
      const killed = await Promise.all(targets.map((pid) => deps.kill(pid)));
      result.killed += killed.filter(Boolean).length;
      if (!killed.every(Boolean)) return; // a failed kill keeps the file, so the next start retries
    }
    try { unlinkSync(file); } catch { /* a locked file is retried at the next start */ }
  }));
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultRegistryDir = (): string => join(resolveDataRoot(process.env, repoRoot), "logs");
let tracker: TreeTracker | null = null;
export function processTree(): TreeTracker {
  return tracker ??= createTreeTracker({ list: listWithSeam, kill: killWithSeam, registryDir: defaultRegistryDir, sweepAtFirstWatch: true });
}
export function setProcessTreeForTests(next: TreeTracker | null): void { tracker = next; }
export function watchProcessTree(pid: number, startedAt = Date.now(), slow = false): TreeWatch { return processTree().watch(pid, startedAt, slow); }
// For the server start: finish what a crashed server left behind (safe to call more than once).
export function sweepOrphans(): Promise<{ checked: number; killed: number }> {
  return sweepOrphanedChildren({ list: () => listProcesses(), kill: killPid, registryDir: defaultRegistryDir });
}

// A server shutdown must never leave a leader CLI behind: whatever is still alive when this process exits is killed.
const liveChildren = new Set<ChildProcess>();
// watch: also remember its descendants (real children only), so what it left behind is killed when it ends.
// How many tracked children are alive (the shutdown hook ends them).
export function trackedLeaderChildren(): number { return liveChildren.size; }
// onSweepFailed: said once when the exit sweep could not stop (or could not look for) what the child left behind; leaderProcessState keeps the leader "running" and the next check retries the sweep.
export function trackLeaderChild(child: ChildProcess, watch = false, onSweepFailed?: () => void): void {
  liveChildren.add(child);
  const handle = watch && child.pid ? watchProcessTree(child.pid, Date.now(), true) : null;
  const life: ChildLife = { sweeping: false, failed: false, reported: false, recheck: async () => {} };
  childLives.set(child, life);
  let exitedAt = 0; // taken once, in the exit event: a retry must not move the boundary, or a reused root pid's later children look like ours
  const settle = async (): Promise<void> => {
    life.sweeping = true;
    let failed = false;
    try { if (handle) failed = (await handle.sweep(exitedAt)) === null || handle.failed > 0; } catch { failed = true; }
    life.failed = failed; life.sweeping = false;
    if (failed && !life.reported) { life.reported = true; onSweepFailed?.(); }
  };
  life.recheck = async () => { if (life.failed && !life.sweeping) await settle(); };
  child.once("exit", () => {
    liveChildren.delete(child);
    exitedAt = Date.now();
    life.sweeping = true; // set in the exit event itself: no moment where the root is gone and the sweep has not begun
    void settle();
  });
}
// The SDK starts claude.exe itself and, on abort, kills only that one process: start it here instead so its whole tree is tracked and killed.
export function spawnTrackedClaude(options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }, onUnconfirmedKill?: () => void): ChildProcess {
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  trackLeaderChild(child, true, onUnconfirmedKill);
  const stop = (): void => killProcessTree(child, onUnconfirmedKill);
  if (options.signal.aborted) stop(); else options.signal.addEventListener("abort", stop, { once: true });
  child.once("exit", () => options.signal.removeEventListener("abort", stop));
  return child;
}
process.on("exit", () => {
  for (const child of liveChildren) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === "win32") spawnSync(windowsTaskkillPath(), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill();
  }
  tracker?.flushRegistry();
});
