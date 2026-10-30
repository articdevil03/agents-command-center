import { readdirSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isSafeRequestId } from "../chat-store.ts";
import { withResolvedCli } from "../leader-common.ts";
import { runCli } from "./cli-runner.ts";
import { ACTION_TIMEOUT_MS, AUTH_ARGS, CLI_IDS, CLI_TIMEOUT_MS, LOGIN_ARGS, MCP_NAME, PACKAGES, PERMISSION_MODES, PLUGIN_NAME } from "./constants.ts";
import { applyBounded, LIVE_TIMEOUT, ModeBusyError, serializePermissionMode } from "./permissions.ts";
import { knownAuthStatus, parseGitHubAuthStatus, parseMcpCommand, parseMcpList, parsePluginList, parseVersion } from "./parse.ts";
import { freshState, persist, readPersisted } from "./store.ts";
import type { ActionState, CliId, CliResult, PermissionMode, PersistedSettings, RunCli, SettingsServiceOptions, SettingsState } from "./types.ts";

export class SettingsActionError extends Error {
  readonly requestId: string;

  constructor(message: string, requestId: string) {
    super(message);
    this.requestId = requestId;
    this.name = "SettingsActionError";
  }
}

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
      return serializePermissionMode(this.permissionModeSequences, this.permissionModeTails, tabId, async () => {
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
        try { applied = await applyBounded(this.permissionTimeoutMs, applyLive, permissionMode); }
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
