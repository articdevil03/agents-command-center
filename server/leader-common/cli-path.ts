import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { LeaderSpawn } from "./types.ts";

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
