import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isSafeRequestId } from "./chat-store.ts";
import { keepBadCopy, writeFileSynced } from "./safe-file.ts";
import { descendantsOf, leaderChildEnv, listProcesses, trackLeaderChild, windowsPowerShellPath, windowsTaskkillPath, withResolvedCli } from "./leader-common.ts";

export { windowsPowerShellPath, windowsTaskkillPath };

export type CliId = "claude" | "codex" | "opencode" | "gemini";
export type CliResult = { code: number; stdout: string; stderr: string };
// env: extra variables for the child. verbatimArgs: Windows hands the args to the child exactly as written (the caller quotes them for cmd).
export type RunCli = (bin: string, args: string[], options: { timeoutMs: number; env?: Record<string, string>; verbatimArgs?: boolean }) => Promise<CliResult>;
export type PermissionMode = "ask" | "accept" | "plan" | "bypass";
export type ActionStatus = "running" | "done" | "failed";
export type ActionState = { requestId: string; status: ActionStatus; message: string };

export const CLI_IDS: CliId[] = ["claude", "codex", "opencode", "gemini"];
const PACKAGES: Record<CliId, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", opencode: "opencode-ai", gemini: "@google/gemini-cli" };
const AUTH_ARGS: Partial<Record<CliId, string[]>> = {
  claude: ["auth", "status"],
  codex: ["login", "status"],
  opencode: ["auth", "list"],
};
const LOGIN_ARGS: Partial<Record<CliId, string[]>> = {
  claude: ["auth", "login"],
  codex: ["login"],
  opencode: ["auth", "login"],
};
const CLI_TIMEOUT_MS = 8_000;
const DESCENDANTS_TIMEOUT_MS = 5_000;
const ACTION_TIMEOUT_MS = 180_000;
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@/-]{0,127}$/;
const COMMAND_META = /[;&|<>`$(){}\[\]*?~%!^\r\n]/;
const PERMISSION_MODES = new Set<PermissionMode>(["ask", "accept", "plan", "bypass"]);

export type InstalledTool = { installed: boolean | null; version: string | null; signedIn: boolean | null; action?: ActionState };
export type InstructionFile = { path: string; scope: "global" | "project" };
export type McpItem = { name: string; detail?: string };
export type CliInventory = {
  instructionFiles: InstructionFile[];
  skills: string[];
  mcpServers: McpItem[];
  plugins: string[];
  action?: ActionState;
  inventoryError?: string;
};
export type SettingsState = {
  tools: Record<CliId, InstalledTool>;
  github: { connected: boolean | null; account: string | null; action?: ActionState };
  vault: { path: string | null };
  folders: { defaultProjectFolder: string };
  skills: Record<CliId, CliInventory>;
  permissionModes: Record<string, PermissionMode>;
  permissionActions: Record<string, ActionState>;
  preferenceAction?: ActionState;
  uploads: Record<string, ActionState>;
};

type PersistedSettings = {
  notesVaultPath: string | null;
  defaultProjectFolder: string;
  permissionModes: Record<string, PermissionMode>;
  // Set when a damaged file was recovered: a tab with no saved mode asks before changing files until the owner picks a mode for it.
  askUntilChosen?: boolean;
};

const EMPTY_SETTINGS: PersistedSettings = { notesVaultPath: null, defaultProjectFolder: "", permissionModes: {} };

function freshInventory(): CliInventory {
  return { instructionFiles: [], skills: [], mcpServers: [], plugins: [] };
}

function freshState(saved: PersistedSettings): SettingsState {
  return {
    tools: {
      claude: { installed: null, version: null, signedIn: null },
      codex: { installed: null, version: null, signedIn: null },
      opencode: { installed: null, version: null, signedIn: null },
      gemini: { installed: null, version: null, signedIn: null },
    },
    github: { connected: null, account: null },
    vault: { path: saved.notesVaultPath },
    folders: { defaultProjectFolder: saved.defaultProjectFolder },
    skills: { claude: freshInventory(), codex: freshInventory(), opencode: freshInventory(), gemini: freshInventory() },
    permissionModes: { ...saved.permissionModes },
    permissionActions: {},
    uploads: {},
  };
}

// A settings file that is empty, unparsable or malformed starts the app on defaults; the bad file is kept first,
// so the next save never overwrites it blind. Its tabs' saved modes are lost, so none of them may fall back to auto-accepting edits.
function readPersisted(path: string): { settings: PersistedSettings; recovered: boolean } {
  try { return { settings: parsePersisted(path), recovered: false }; }
  catch (error) {
    if (!(error instanceof BadSettingsFile)) throw error;
    keepBadCopy(path);
    return { settings: { ...EMPTY_SETTINGS, permissionModes: {}, askUntilChosen: true }, recovered: true };
  }
}

class BadSettingsFile extends Error {}

function parsePersisted(path: string): PersistedSettings {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_SETTINGS, permissionModes: {} };
    throw new BadSettingsFile(`settings file is unreadable: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadSettingsFile("settings file is malformed");
  const raw = value as Record<string, unknown>;
  if ((raw.notesVaultPath !== null && raw.notesVaultPath !== undefined && typeof raw.notesVaultPath !== "string")
    || (raw.defaultProjectFolder !== undefined && typeof raw.defaultProjectFolder !== "string")
    || (raw.askUntilChosen !== undefined && typeof raw.askUntilChosen !== "boolean")
    || (raw.permissionModes !== undefined && (!raw.permissionModes || typeof raw.permissionModes !== "object" || Array.isArray(raw.permissionModes)))) {
    throw new BadSettingsFile("settings file is malformed");
  }
  const modes: Record<string, PermissionMode> = {};
  for (const [tabId, mode] of Object.entries((raw.permissionModes ?? {}) as Record<string, unknown>)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tabId) || !PERMISSION_MODES.has(mode as PermissionMode)) throw new BadSettingsFile("settings file has an invalid permission mode");
    modes[tabId] = mode as PermissionMode;
  }
  return {
    notesVaultPath: (raw.notesVaultPath as string | null | undefined) ?? null,
    defaultProjectFolder: (raw.defaultProjectFolder as string | undefined) ?? "",
    permissionModes: modes,
    ...(raw.askUntilChosen === true ? { askUntilChosen: true } : {}),
  };
}

function persist(path: string, value: PersistedSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSynced(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* the atomic rename already consumed it */ }
  }
}

function parseVersion(text: string): string | null {
  const match = text.match(/(?:^|[^A-Za-z0-9])v?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)(?:$|[^A-Za-z0-9])/m);
  return match?.[1] ?? null;
}

function knownAuthStatus(cli: CliId, result: CliResult): boolean | null {
  const text = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  // `claude auth status` prints JSON: {"loggedIn": true, ...}.
  if (cli === "claude") {
    try { const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown }; if (typeof parsed?.loggedIn === "boolean") return parsed.loggedIn; } catch { /* older CLIs print words: matched below */ }
  }
  const lower = text.toLowerCase();
  if (/not logged in|not authenticated|no credentials|logged out|unauthenticated|no providers configured/.test(lower)) return false;
  if (/logged in|authenticated|signed in|credentials found/.test(lower)) return true;
  // `opencode auth list` ends with "N credentials"; the box-drawing lines around it say nothing.
  if (cli === "opencode" && result.code === 0) {
    const count = lower.match(/(\d+)\s+credentials?\b/)?.[1];
    if (count !== undefined) return Number(count) > 0;
  }
  return null;
}

export function parseGitHubAuthStatus(result: CliResult): { connected: boolean | null; account: string | null } {
  const text = `${result.stdout}\n${result.stderr}`;
  const loggedIn = text.match(/Logged in to github\.com account ([A-Za-z0-9-]{1,39})\b/i);
  if (loggedIn) return { connected: true, account: loggedIn[1] };
  if (/not logged in|not logged into any github hosts|no authentication token/i.test(text)) return { connected: false, account: null };
  return { connected: null, account: null };
}

export function parseMcpList(cli: CliId, text: string): McpItem[] {
  const rows: McpItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(checking|no mcp|mcp servers?|name\b|[-=]+|warning:)/i.test(line)) continue;
    let name: string | undefined;
    if (cli === "claude") {
      const match = line.match(/^([A-Za-z0-9_-]{1,64}):(?:\s*(.*))?$/);
      if (match) name = match[1];
    } else {
      const clean = line.replace(/^(?:[-*\u2022]\s*)?(?:\[?(?:connected|failed|disabled)\]?\s+)?/i, "");
      const match = clean.match(/^([A-Za-z0-9_-]{1,64})(?::\s*|\s+|$)(.*)$/);
      if (match) name = match[1];
    }
    if (name && !rows.some((item) => item.name === name)) rows.push({ name });
  }
  return rows;
}

export function parsePluginList(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:[-*\u2022]\s*)/, "");
    if (!line || /^(installed plugins?|no plugins|plugins? not installed|name\b|[-=]+)\s*:?$/i.test(line)) continue;
    const name = line.match(/^([A-Za-z0-9_.@/-]{1,128})(?=\s|$)/)?.[1];
    if (name && PLUGIN_NAME.test(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

export function parseMcpCommand(value: unknown): { type: "url"; url: string } | { type: "command"; argv: string[] } {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error("MCP command or URL is required");
  const input = value.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input) && !/^https:\/\//i.test(input)) throw new Error("MCP URL must be a valid https URL");
  if (/^https:\/\//i.test(input)) {
    let url: URL;
    try { url = new URL(input); } catch { throw new Error("MCP URL must be a valid https URL"); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error("MCP URL must be a valid https URL without credentials");
    return { type: "url", url: url.toString() };
  }
  if (COMMAND_META.test(input)) throw new Error("MCP command contains shell metacharacters");
  const argv: string[] = [];
  let current = "", quote = "", started = false;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "\"" || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) { argv.push(current); current = ""; started = false; }
    } else { current += char; started = true; }
  }
  if (quote) throw new Error("MCP command has an unmatched quote");
  if (started) argv.push(current);
  if (!argv.length || argv.some((part) => !part)) throw new Error("MCP command must include a program and arguments");
  return { type: "command", argv };
}

// On Windows shell:false only starts .exe/.com, but npm, codex and opencode are
// .cmd launchers: find the real file the way cmd would (PATH x PATHEXT-style).
function resolveLauncher(bin: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return bin;
  const names = /\.(?:com|exe|bat|cmd)$/i.test(bin) ? [bin] : [".com", ".exe", ".bat", ".cmd"].map((extension) => bin + extension);
  const dirs = /[\\/]/.test(bin) ? [""] : (env.PATH ?? env.Path ?? "").split(";").map((dir) => dir.replace(/^"|"$/g, "")).filter((dir) => dir && resolve(dir).toLowerCase() !== process.cwd().toLowerCase());
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? join(dir, name) : name;
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* not in this folder */ }
    }
  }
  return bin;
}

// A .cmd/.bat runs through cmd.exe /d /s /c with every part in double quotes, so
// & | < > ^ stay literal (no `call`: it would parse the line a second time and double every ^). An argument holding % is handed over
// through the environment, which cmd expands once as plain text. Characters that quotes cannot protect (" ! CR LF NUL) are refused instead of escaped.
const CMD_UNSAFE = /["!\r\n\0]/;
function cmdQuote(value: string): string { return `"${value.replace(/(\\+)$/, "$1$1")}"`; }

// The descendants of rootPid, for the fallback tree kill; null = the process list could not be read in time.
async function listWindowsProcessDescendants(spawnProcess: typeof spawn, rootPid: number): Promise<number[] | null> {
  const list = await listProcesses(spawnProcess, DESCENDANTS_TIMEOUT_MS);
  return list ? descendantsOf(list, rootPid) : null;
}

export function createCliRunner(spawnProcess: typeof spawn = spawn, env: NodeJS.ProcessEnv = process.env): RunCli {
  return async (bin, args, options) => {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string") || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      return { code: -1, stdout: "", stderr: "invalid process arguments" };
    }
    // A claude/codex/opencode call resolves from PATH to an absolute path (never the project folder) and the child never sees the app key.
    let resolved: string;
    try { resolved = withResolvedCli(bin, env, process.cwd()); } catch (err) { return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) }; }
    const launcher = resolveLauncher(resolved.replace(/^"(.*)"$/, "$1"), env);
    const { CC_APP_KEY: _appKey, ...inherited } = env === process.env ? leaderChildEnv() : env;
    const childEnv: NodeJS.ProcessEnv = { ...inherited, ...options.env, NoDefaultCurrentDirectoryInExePath: "1" };
    const viaCmd = /\.(?:cmd|bat)$/i.test(launcher);
    if (viaCmd && ([launcher, ...args].some((part) => CMD_UNSAFE.test(part)) || launcher.includes("%"))) {
      return { code: -1, stdout: "", stderr: "unsupported characters in command arguments" };
    }
    const cmdCommand = viaCmd ? `"${[cmdQuote(launcher), ...args.map((arg, index) => {
      if (!arg.includes("%")) return cmdQuote(arg);
      childEnv[`CC_ARG_${index}`] = cmdQuote(arg).slice(1, -1);
      return `"%CC_ARG_${index}%"`;
    })].join(" ")}"` : undefined;
    return new Promise((resolveResult) => {
      let stdout = "", stderr = "", settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timingOut = false;
      let childClosed = false;
      let resolveChildClosed!: () => void;
      const childClosedPromise = new Promise<void>((resolve) => { resolveChildClosed = resolve; });
      const finish = (code: number, out = stdout, err = stderr) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveResult({ code, stdout: out, stderr: err });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = viaCmd
          ? spawnProcess(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdCommand!], { shell: false, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv })
          : spawnProcess(launcher, args, { shell: false, windowsHide: true, windowsVerbatimArguments: options.verbatimArgs === true, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
      }
      catch { finish(-1, "", "could not start command"); return; }
      // An npm install or a login can outlive a server shutdown: the exit hook ends it with the rest.
      trackLeaderChild(child);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      timer = setTimeout(() => {
        // A CLI that already exited (a descendant still holds its pipes, so `close` is late) has no tree to kill, and its pid may be someone else's by now.
        const exited = (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;
        if (exited) { child.stdout?.destroy(); child.stderr?.destroy(); }
        if (exited || process.platform !== "win32" || !child.pid) {
          try { child.kill(); } catch { /* the timeout result still settles if the process already exited */ }
          finish(124, stdout, "command timed out");
          return;
        }
        timingOut = true;
        void (async () => {
          let taskkillCode: number | null = null;
          try {
            const killer = spawnProcess(windowsTaskkillPath(), ["/pid", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
            taskkillCode = await new Promise<number | null>((resolveKill) => {
              let done = false;
              const settle = (code: number | null) => {
                if (done) return;
                done = true;
                clearTimeout(killTimer);
                resolveKill(code);
              };
              const killTimer = setTimeout(() => {
                try { killer.kill(); } catch { /* the bounded wait below reports the unconfirmed tree */ }
                settle(null);
              }, 2000);
              killer.once("error", () => settle(null));
              killer.once("close", (code) => settle(code));
            });
          } catch { /* the bounded wait below reports the unconfirmed tree */ }

          if (taskkillCode !== 0 && child.pid) {
            // ponytail: taskkill is the normal tree kill; only enumerate when Windows denies it.
            try { child.kill(); } catch { /* the bounded wait below reports the unconfirmed tree */ }
            const descendants = await listWindowsProcessDescendants(spawnProcess, child.pid);
            for (const pid of descendants?.reverse() ?? []) {
              try { process.kill(pid, "SIGTERM"); } catch { /* the bounded wait below reports the unconfirmed tree */ }
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }

          const childGone = childClosed || await new Promise<boolean>((resolveGone) => {
            if (childClosed) { resolveGone(true); return; }
            let done = false;
            let closeTimer: ReturnType<typeof setTimeout>;
            const settle = (gone: boolean) => {
              if (done) return;
              done = true;
              clearTimeout(closeTimer);
              resolveGone(gone);
            };
            closeTimer = setTimeout(() => settle(false), 1500);
            childClosedPromise.then(() => settle(true));
          });
          const message = taskkillCode === 0 && childGone
            ? "command timed out; process tree terminated"
            : "command timed out; process tree exit not confirmed after bounded wait";
          finish(124, stdout, message);
        })();
      }, options.timeoutMs);
      child.once("error", (error) => {
        if (!timingOut) finish((error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : -1, stdout, "could not start command");
      });
      child.once("close", (code) => {
        childClosed = true;
        resolveChildClosed();
        if (!timingOut) finish(code ?? -1, stdout, stderr);
      });
    });
  };
}
export const runCli: RunCli = createCliRunner();

export class SettingsActionError extends Error {
  readonly requestId: string;

  constructor(message: string, requestId: string) {
    super(message);
    this.requestId = requestId;
    this.name = "SettingsActionError";
  }
}

export type SettingsServiceOptions = {
  dataRoot: string;
  env?: NodeJS.ProcessEnv;
  runCli?: RunCli;
  onChange?: () => void;
  permissionTimeoutMs?: number;
  // How often the sign-in status is read again after a login window opened (default 3 s, for up to 3 minutes).
  loginRecheckMs?: number;
};

const LIVE_TIMEOUT = Symbol("live permission mode change timed out");
// The live leader cannot take a mode right now (a Codex turn runs on its old policy): a plain refusal, not a failed apply, so the chat is never stopped for it.
export class ModeBusyError extends Error {}

export class SettingsService {
  readonly path: string;
  readonly state: SettingsState;
  private readonly saved: PersistedSettings;
  // Said to the owner once, at the first page that connects (takeRecoveryNotice).
  private recoveryNotice: string | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: RunCli;
  private onChange: () => void;
  private readonly permissionTimeoutMs: number;
  private readonly loginRecheckMs: number;
  private readonly loginWatchers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly permissionModeSequences = new Map<string, number>();
  private readonly permissionModeTails = new Map<string, Promise<void>>();

  constructor(options: SettingsServiceOptions) {
    this.path = join(resolve(options.dataRoot), "settings.json");
    const read = readPersisted(this.path);
    this.saved = read.settings;
    if (read.recovered) this.recoveryNotice = "The settings file was damaged, so your saved permission modes were lost. A copy was kept beside it. Every tab without a saved mode now asks before changing files; pick a mode for each tab to change that.";
    this.state = freshState(this.saved);
    this.env = options.env ?? process.env;
    this.run = options.runCli ?? runCli;
    this.onChange = options.onChange ?? (() => {});
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 15_000;
    this.loginRecheckMs = options.loginRecheckMs ?? 3_000;
  }

  // A login window opens and the user takes a while: read the status again every few seconds until it says signed in (or 3 minutes pass).
  private watchSignIn(key: string, read: () => Promise<boolean | null>): void {
    clearTimeout(this.loginWatchers.get(key));
    const deadline = Date.now() + 180_000;
    const step = (): void => {
      const timer = setTimeout(() => {
        void read().then((signedIn) => {
          this.publish();
          if (signedIn === true || Date.now() >= deadline || this.loginWatchers.get(key) !== timer) { if (this.loginWatchers.get(key) === timer) this.loginWatchers.delete(key); return; }
          step();
        }, () => { this.loginWatchers.delete(key); });
      }, this.loginRecheckMs);
      timer.unref();
      this.loginWatchers.set(key, timer);
    };
    step();
  }

  setOnChange(onChange: () => void): void { this.onChange = onChange; }
  snapshot(): SettingsState { return JSON.parse(JSON.stringify(this.state)) as SettingsState; }
  permissionMode(tabId: string): PermissionMode { return this.state.permissionModes[tabId] ?? (this.saved.askUntilChosen ? "ask" : "accept"); }
  takeRecoveryNotice(): string | null { const notice = this.recoveryNotice; this.recoveryNotice = null; return notice; }

  private applyBounded(applyLive: (mode: PermissionMode) => Promise<boolean>, mode: PermissionMode): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((_resolve, reject) => {
      timer = setTimeout(() => reject(LIVE_TIMEOUT), this.permissionTimeoutMs);
    });
    return Promise.race([Promise.resolve().then(() => applyLive(mode)), timeout])
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  private serializePermissionMode<T>(tabId: string, work: () => Promise<T>): Promise<T> {
    const sequence = (this.permissionModeSequences.get(tabId) ?? 0) + 1;
    this.permissionModeSequences.set(tabId, sequence);
    const isCurrent = () => this.permissionModeSequences.get(tabId) === sequence;
    const previous = this.permissionModeTails.get(tabId) ?? Promise.resolve();
    const operation = previous.then(() => {
      if (!isCurrent()) throw new Error("permission mode request superseded");
      return work();
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.permissionModeTails.set(tabId, tail);
    void tail.then(() => {
      if (this.permissionModeTails.get(tabId) !== tail) return;
      this.permissionModeTails.delete(tabId);
      if (this.permissionModeSequences.get(tabId) === sequence) this.permissionModeSequences.delete(tabId);
    });
    return operation;
  }

  private home(): string { return this.env.USERPROFILE || this.env.HOME || homedir(); }
  private save(next: PersistedSettings = this.saved): void {
    const snapshot = { ...next, permissionModes: { ...next.permissionModes } };
    persist(this.path, snapshot);
    this.saved.notesVaultPath = snapshot.notesVaultPath;
    this.saved.defaultProjectFolder = snapshot.defaultProjectFolder;
    this.saved.permissionModes = snapshot.permissionModes;
  }

  removePermissionModes(tabIds: readonly string[]): void {
    const permissionModes = { ...this.saved.permissionModes };
    let changed = false;
    for (const tabId of tabIds) {
      if (!Object.hasOwn(permissionModes, tabId)) continue;
      delete permissionModes[tabId];
      changed = true;
    }
    if (changed) this.save({ ...this.saved, permissionModes });
    for (const tabId of tabIds) {
      delete this.state.permissionModes[tabId];
      delete this.state.permissionActions[tabId];
    }
  }
  private publish(): void { this.onChange(); }

  private async call(bin: string, args: string[], timeoutMs = CLI_TIMEOUT_MS, extra: { env?: Record<string, string>; verbatimArgs?: boolean } = {}): Promise<CliResult> {
    try { return await this.run(bin, args, { timeoutMs, ...extra }); }
    catch { return { code: -1, stdout: "", stderr: "command failed" }; }
  }

  private async updateTool(cli: CliId): Promise<void> {
    const versionResult = await this.call(cli, ["--version"]);
    const installed = versionResult.code === 0 ? true : versionResult.code === 127 ? false : null;
    const version = installed ? parseVersion(versionResult.stdout || versionResult.stderr) : null;
    let signedIn: boolean | null = null;
    const authArgs = AUTH_ARGS[cli];
    if (installed && authArgs) signedIn = knownAuthStatus(cli, await this.call(cli, authArgs));
    Object.assign(this.state.tools[cli], { installed, version, signedIn });
  }

  private skillNames(directory: string): string[] {
    try { return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter((name) => /^[A-Za-z0-9_.-]{1,128}$/.test(name)).sort(); }
    catch { return []; }
  }

  refreshProjectInstructions(folder: string | null): void {
    const home = this.home();
    const definitions: Record<CliId, Array<[string, "global" | "project"]>> = {
      claude: [[join(home, ".claude", "CLAUDE.md"), "global"], ...(folder ? [[join(folder, "CLAUDE.md"), "project"] as [string, "project"]] : [])],
      codex: [[join(home, ".codex", "AGENTS.md"), "global"], ...(folder ? [[join(folder, "AGENTS.md"), "project"] as [string, "project"]] : [])],
      opencode: [...(folder ? [[join(folder, "AGENTS.md"), "project"] as [string, "project"]] : [])],
      gemini: [[join(home, ".gemini", "GEMINI.md"), "global"], ...(folder ? [[join(folder, "GEMINI.md"), "project"] as [string, "project"]] : [])],
    };
    for (const cli of CLI_IDS) {
      this.state.skills[cli].instructionFiles = definitions[cli].filter(([path]) => {
        try { return statSync(path).isFile(); } catch { return false; }
      }).map(([path, scope]) => ({ path, scope }));
    }
  }

  private refreshLocalSkills(): void {
    const home = this.home();
    this.state.skills.claude.skills = this.skillNames(join(home, ".claude", "skills"));
    this.state.skills.codex.skills = this.skillNames(join(home, ".codex", "skills"));
    this.state.skills.opencode.skills = this.skillNames(join(home, ".config", "opencode", "skills"));
  }

  async refreshCliInventory(cli: CliId): Promise<void> {
    const inventory = this.state.skills[cli];
    if (cli === "gemini") {
      inventory.skills = []; inventory.mcpServers = []; inventory.plugins = [];
      delete inventory.inventoryError;
      return;
    }
    const mcp = await this.call(cli, ["mcp", "list"]);
    if (mcp.code === 0) { inventory.mcpServers = parseMcpList(cli, `${mcp.stdout}\n${mcp.stderr}`); delete inventory.inventoryError; }
    else inventory.inventoryError = "MCP list is unavailable";
    if (cli === "claude") {
      const plugins = await this.call(cli, ["plugin", "list"]);
      if (plugins.code === 0) inventory.plugins = parsePluginList(`${plugins.stdout}\n${plugins.stderr}`);
      else inventory.inventoryError = [inventory.inventoryError, "plugin list is unavailable"].filter(Boolean).join("; ");
    } else inventory.plugins = [];
  }

  async refreshAll(folder: string | null): Promise<void> {
    this.refreshProjectInstructions(folder);
    this.refreshLocalSkills();
    await Promise.all([...CLI_IDS.map((cli) => this.updateTool(cli)), ...CLI_IDS.map((cli) => this.refreshCliInventory(cli))]);
    const gh = await this.call("gh", ["auth", "status"]);
    Object.assign(this.state.github, parseGitHubAuthStatus(gh));
    this.publish();
  }

  private async action<T>(target: { action?: ActionState }, requestId: string, work: () => Promise<T>): Promise<T> {
    if (!isSafeRequestId(requestId)) throw new Error("invalid request id");
    const ownsAction = () => target.action?.requestId === requestId;
    target.action = { requestId, status: "running", message: "Working" };
    this.publish();
    try {
      const result = await work();
      if (ownsAction()) target.action = { requestId, status: "done", message: "Done" };
      this.publish();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Action failed";
      if (ownsAction()) target.action = { requestId, status: "failed", message };
      this.publish();
      throw new SettingsActionError(message, requestId);
    }
  }

  async installCli(cli: CliId, requestId: string, confirm: unknown): Promise<void> {
    if (!CLI_IDS.includes(cli)) throw new SettingsActionError("unknown CLI", requestId);
    return this.action(this.state.tools[cli], requestId, async () => {
      await this.updateTool(cli);
      if (this.state.tools[cli].installed === true) throw new Error("CLI is already installed");
      if (this.state.tools[cli].installed === null) throw new Error("CLI installation status is unknown");
      if (confirm !== true) throw new Error("install confirmation is required");
      const result = await this.call("npm", ["install", "-g", PACKAGES[cli]], ACTION_TIMEOUT_MS);
      if (result.code !== 0) throw new Error("CLI installation failed");
      await this.updateTool(cli);
      if (!this.state.tools[cli].installed) throw new Error("installation finished but the CLI was not found");
    });
  }

  async loginCli(cli: CliId, requestId: string, folder: string | null): Promise<void> {
    if (!CLI_IDS.includes(cli)) throw new SettingsActionError("unknown CLI", requestId);
    return this.action(this.state.tools[cli], requestId, async () => {
      if (cli === "gemini") throw new Error("Gemini sign-in status is unknown and sign-in is unavailable");
      const loginArgs = LOGIN_ARGS[cli];
      if (!loginArgs) throw new Error("CLI sign-in is unavailable");
      await this.updateTool(cli);
      if (this.state.tools[cli].installed !== true) throw new Error(this.state.tools[cli].installed === false ? "CLI is not installed" : "CLI installation status is unknown");
      // `start` would look for a bare name in the current folder and on PATH, project folders included: hand it the path the status check uses.
      const program = withResolvedCli(cli, this.env, process.cwd()).replace(/^"(.*)"$/, "$1");
      if (/["\u0000-\u001f]/.test(program)) throw new Error(`${cli} sits at a path with characters the login window cannot take: ${program}`);
      // The path travels in an environment variable that cmd expands once, inside quotes, so & ^ ( ) % and spaces in it stay plain text.
      const result = await this.call("cmd", ["/c", "start", '""', '"%CC_LOGIN_PROGRAM%"', ...loginArgs], 5_000, { env: { CC_LOGIN_PROGRAM: program }, verbatimArgs: true });
      if (result.code !== 0) throw new Error("could not open the CLI login window");
      // The window has only just opened: nothing has changed yet, so the status is read again while the user signs in.
      this.watchSignIn(cli, async () => { await this.updateTool(cli); return this.state.tools[cli].signedIn; });
    });
  }

  async loginGitHub(requestId: string): Promise<void> {
    return this.action(this.state.github, requestId, async () => {
      const result = await this.call("cmd", ["/c", "start", "", "gh", "auth", "login", "--web"], 5_000);
      if (result.code !== 0) throw new Error("could not open the GitHub login window");
      this.watchSignIn("gh", async () => {
        const parsed = parseGitHubAuthStatus(await this.call("gh", ["auth", "status"]));
        this.state.github.connected = parsed.connected;
        this.state.github.account = parsed.account;
        return parsed.connected;
      });
    });
  }

  async addMcp(cli: CliId, requestId: string, name: unknown, commandOrUrl: unknown): Promise<void> {
    if (!CLI_IDS.includes(cli)) throw new SettingsActionError("unknown CLI", requestId);
    const target = this.state.skills[cli];
    return this.action(target, requestId, async () => {
      if (cli === "gemini") throw new Error("Gemini MCP changes are unavailable");
      if (typeof name !== "string" || !MCP_NAME.test(name)) throw new Error("invalid MCP name");
      const parsed = parseMcpCommand(commandOrUrl);
      let args: string[];
      if (cli === "codex") args = ["mcp", "add", name, ...(parsed.type === "url" ? ["--url", parsed.url] : ["--", ...parsed.argv])];
      // -s user: the default "local" scope is keyed to the server's own working folder, so the server would be invisible to every tab and lost on restart.
      else if (cli === "claude") args = ["mcp", "add", "-s", "user", ...(parsed.type === "url" ? ["--transport", "http", name, parsed.url] : [name, "--", ...parsed.argv])];
      else args = ["mcp", "add", name, ...(parsed.type === "url" ? ["--url", parsed.url] : ["--", ...parsed.argv])];
      const result = await this.call(cli, args, ACTION_TIMEOUT_MS);
      await this.refreshCliInventory(cli);
      if (result.code !== 0) throw new Error("MCP add failed");
    });
  }

  async removeMcp(cli: CliId, requestId: string, name: unknown, confirm: unknown): Promise<void> {
    if (cli !== "claude" && cli !== "codex") throw new SettingsActionError("MCP removal is unavailable for this CLI", requestId);
    const target = this.state.skills[cli];
    return this.action(target, requestId, async () => {
      if (typeof name !== "string" || !MCP_NAME.test(name)) throw new Error("invalid MCP name");
      if (confirm !== true) throw new Error("MCP removal confirmation is required");
      const result = await this.call(cli, ["mcp", "remove", ...(cli === "claude" ? ["-s", "user"] : []), name], ACTION_TIMEOUT_MS);
      await this.refreshCliInventory(cli);
      if (result.code !== 0) throw new Error("MCP removal failed");
    });
  }

  async installPlugin(requestId: string, name: unknown): Promise<void> {
    const target = this.state.skills.claude;
    return this.action(target, requestId, async () => {
      if (typeof name !== "string" || !PLUGIN_NAME.test(name)) throw new Error("invalid plugin name");
      const result = await this.call("claude", ["plugin", "install", name], ACTION_TIMEOUT_MS);
      await this.refreshCliInventory("claude");
      if (result.code !== 0) throw new Error("plugin install failed");
    });
  }

  async uninstallPlugin(requestId: string, name: unknown, confirm: unknown): Promise<void> {
    const target = this.state.skills.claude;
    return this.action(target, requestId, async () => {
      if (typeof name !== "string" || !PLUGIN_NAME.test(name)) throw new Error("invalid plugin name");
      if (confirm !== true) throw new Error("plugin removal confirmation is required");
      const result = await this.call("claude", ["plugin", "uninstall", name], ACTION_TIMEOUT_MS);
      await this.refreshCliInventory("claude");
      if (result.code !== 0) throw new Error("plugin uninstall failed");
    });
  }

  private async canonicalDirectory(value: unknown, label: string): Promise<string> {
    if (typeof value === "string" && !value.trim()) throw new Error(`${label} is required`);
    if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be an absolute directory path`);
    const candidate = value.trim();
    if (!isAbsolute(candidate) || candidate.split(/[\\/]+/).includes("..")) throw new Error(`${label} must be an absolute directory path without traversal`);
    let canonical: string;
    try { canonical = await realpath(candidate); }
    catch { throw new Error(`${label} folder does not exist`); }
    try { if (!(await stat(canonical)).isDirectory()) throw new Error(`${label} must be a directory`); }
    catch (error) { if (error instanceof Error && error.message.includes("must be a directory")) throw error; throw new Error(`${label} folder is unavailable`); }
    return canonical;
  }

  async setNotesVault(requestId: string, value: unknown): Promise<void> {
    const state = this.state;
    const target = { get action() { return state.preferenceAction; }, set action(value: ActionState | undefined) { state.preferenceAction = value; } };
    return this.action(target, requestId, async () => {
      const path = value === null || value === "" ? null : await this.canonicalDirectory(value, "Notes vault");
      this.save({ ...this.saved, notesVaultPath: path });
      this.state.vault.path = path;
    });
  }

  async setDefaultProjectFolder(requestId: string, value: unknown): Promise<void> {
    const state = this.state;
    const target = { get action() { return state.preferenceAction; }, set action(action: ActionState | undefined) { state.preferenceAction = action; } };
    return this.action(target, requestId, async () => {
      const path = await this.canonicalDirectory(value, "Default project folder");
      this.save({ ...this.saved, defaultProjectFolder: path });
      this.state.folders.defaultProjectFolder = path;
    });
  }

  async setPermissionMode(tabId: string, requestId: string, mode: unknown, confirm: unknown, applyLive: (mode: PermissionMode) => Promise<boolean>, stopLiveSession: (reason: string) => boolean, isTabCurrent: () => boolean = () => true): Promise<PermissionMode> {
    const state = this.state;
    const target = { get action() { return state.permissionActions[tabId]; }, set action(action: ActionState | undefined) { if (action) state.permissionActions[tabId] = action; else delete state.permissionActions[tabId]; } };
    if (typeof tabId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tabId) || !isSafeRequestId(requestId)) throw new SettingsActionError("invalid tab or request id", requestId);
    return this.action(target, requestId, async () => {
      if (!PERMISSION_MODES.has(mode as PermissionMode)) throw new Error("invalid permission mode");
      const permissionMode = mode as PermissionMode;
      if (permissionMode === "bypass" && confirm !== true) throw new Error("bypass mode confirmation is required");
      return this.serializePermissionMode(tabId, async () => {
        const fail = (reason: "timed out" | "failed" | "could not be saved" | "tab was removed"): never => {
          if (reason === "tab was removed") throw new Error("Permission mode change failed because its tab was removed.");
          const chatStopped = stopLiveSession(`Permission mode change ${reason}.`);
          const savedMode = this.permissionMode(tabId);
          const recovery = chatStopped
            ? `The chat was stopped. The next message starts a fresh session in saved mode ${savedMode}; conversation context is lost.`
            : `No chat was running; the saved mode remains ${savedMode}.`;
          throw new Error(`Permission mode change ${reason}. ${recovery}`);
        };
        if (!isTabCurrent()) fail("tab was removed");
        let applied: boolean;
        try { applied = await this.applyBounded(applyLive, permissionMode); }
        catch (error) {
          if (error instanceof ModeBusyError) throw error;
          fail(error === LIVE_TIMEOUT ? "timed out" : "failed");
        }
        if (!isTabCurrent()) fail("tab was removed");
        if (!applied) fail("failed");
        try {
          this.save({ ...this.saved, permissionModes: { ...this.saved.permissionModes, [tabId]: permissionMode } });
        } catch { fail("could not be saved"); }
        this.state.permissionModes[tabId] = permissionMode;
        return permissionMode;
      });
    });
  }

  recordFailure(action: string, cli: unknown, tabId: unknown, requestId: string, message: string): void {
    if (!isSafeRequestId(requestId)) return;
    const target: { action?: ActionState } | null = action === "installCli" || action === "cliLogin"
      ? CLI_IDS.includes(cli as CliId) ? this.state.tools[cli as CliId] : null
      : action === "ghLogin" ? this.state.github
      : action === "mcpAdd" || action === "mcpRemove" || action === "pluginInstall" || action === "pluginUninstall"
        ? CLI_IDS.includes(cli as CliId) ? this.state.skills[cli as CliId] : null
        : action === "setNotesVault" || action === "setDefaultProjectFolder" ? this.preferenceTarget()
        : action === "setPermissionMode" && typeof tabId === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tabId) ? this.permissionTarget(tabId) : null;
    if (target && (!target.action || target.action.requestId === requestId)) { target.action = { requestId, status: "failed", message }; this.publish(); }
  }

  private preferenceTarget(): { action?: ActionState } {
    const state = this.state;
    return { get action() { return state.preferenceAction; }, set action(value: ActionState | undefined) { state.preferenceAction = value; } };
  }

  private permissionTarget(tabId: string): { action?: ActionState } {
    const state = this.state;
    return { get action() { return state.permissionActions[tabId]; }, set action(action: ActionState | undefined) { if (action) state.permissionActions[tabId] = action; else delete state.permissionActions[tabId]; } };
  }

  beginUpload(requestId: string): void {
    if (!isSafeRequestId(requestId)) throw new Error("invalid request id");
    this.state.uploads[requestId] = { requestId, status: "running", message: "Uploading" };
    this.trimUploads();
    this.publish();
  }
  finishUpload(requestId: string, ok: boolean, message: string): void {
    this.state.uploads[requestId] = { requestId, status: ok ? "done" : "failed", message };
    this.trimUploads();
    this.publish();
  }
  private trimUploads(): void {
    const entries = Object.keys(this.state.uploads);
    for (const old of entries.slice(0, Math.max(0, entries.length - 32))) delete this.state.uploads[old];
  }
}

export function permissionModeForSdk(value: PermissionMode): "default" | "acceptEdits" | "plan" | "bypassPermissions" {
  return value === "ask" ? "default" : value === "plan" ? "plan" : value === "bypass" ? "bypassPermissions" : "acceptEdits";
}

// Uploaded picture files are named avatar-<uuid>.<ext>. When a new one is saved, the ones no seat points at any more
// (and that are not the new one) are deleted: exact files only, never a folder.
// A file younger than AVATAR_MIN_AGE_MS is kept: another window may have just uploaded it and not yet saved the seat that uses it.
const AVATAR_MIN_AGE_MS = 10 * 60_000;
const AVATAR_FILE = /^avatar-[0-9a-f-]{36}\.(?:png|jpg|webp)$/i;
export function pruneAvatars(avatarDir: string, referencedPics: Iterable<string>, keepFile: string): string[] {
  const referenced = new Set<string>([keepFile]);
  for (const pic of referencedPics) if (typeof pic === "string" && pic.startsWith("/api/avatar/")) referenced.add(pic.slice("/api/avatar/".length));
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(avatarDir); } catch { return removed; }
  for (const name of names) {
    if (!AVATAR_FILE.test(name) || referenced.has(name)) continue;
    try { if (Date.now() - statSync(join(avatarDir, name)).mtimeMs < AVATAR_MIN_AGE_MS) continue; } catch { continue; }
    try { unlinkSync(join(avatarDir, name)); removed.push(name); } catch { /* a locked file stays for the next save */ }
  }
  return removed;
}
