import { statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { cliSkipFolders, isInsideFolder, resolveCliOrThrow, windowsPowerShellPath, windowsSystem32 } from "../leader-common/cli-path.ts";
import type { CatalogEntry, CatalogRecipe } from "./cli-catalog.ts";
import type { CliResult, InstallReason, RunCli } from "./types.ts";

export const INSTALL_TIMEOUT_MS = 600_000;
export const INSTALL_OUTPUT_CAP = 64 * 1024;
export const INSTALL_MESSAGES: Record<InstallReason, string> = {
  needsNode: "This tool needs Node.js and npm. Install Node.js from nodejs.org, then try again.",
  needsGit: "Kimi needs Git for Windows including Git Bash. Install it, then try again.",
  needsWinget: "This tool needs WinGet. Install it, then try again.",
  needsPowerShell: "This tool needs a supported PowerShell installation. Install it, then try again.",
  downloadFailed: "The download failed. Check your connection and try again.",
  blockedByWindows: "Windows or an administrator blocked installation, or a non-elevated installation could not be verified.",
  notFoundAfterInstall: "The installer finished, but Command Center could not find the tool.",
  cancelled: "Installation stopped. Changes already made may remain.",
  cleanupUnconfirmed: "Could not confirm the installer stopped. Installation remains blocked.",
  timeout: "Installation timed out. Try again after checking the tool.",
  installFailed: "Installation failed. Check your connection and Windows security settings before trying again.",
};
export class InstallFailure extends Error {
  readonly reason: InstallReason;
  constructor(reason: InstallReason) { super(INSTALL_MESSAGES[reason]); this.reason = reason; }
}
function file(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
function safeFile(path: string): boolean {
  return isAbsolute(path) && file(path) && !cliSkipFolders(process.cwd()).some((folder) => isInsideFolder(path, folder));
}
function resolved(name: string, env: NodeJS.ProcessEnv, reason: InstallReason): string {
  try { const path = resolveCliOrThrow(name, env, process.cwd()); if (!safeFile(path)) throw new Error(); return path; }
  catch { throw new InstallFailure(reason); }
}

export function externalNpm(env: NodeJS.ProcessEnv): { node: string; npm: string } {
  const node = resolved("node", env, "needsNode");
  if (!/node(?:\.exe)?$/i.test(node) || (process.versions.electron && node.toLowerCase() === process.execPath.toLowerCase())) throw new InstallFailure("needsNode");
  const shim = resolved("npm", env, "needsNode");
  const npm = [join(dirname(shim), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js")].find(safeFile);
  if (!npm) throw new InstallFailure("needsNode");
  return { node, npm };
}

export async function checkInstallPrerequisites(entry: CatalogEntry, run: RunCli, env: NodeJS.ProcessEnv): Promise<void> {
  if (entry.id === "kimi") {
    // Git Bash, not an arbitrary git.exe, is the required Windows shell.
    let bash: string | undefined;
    const gitBash = env.KIMI_CODE_GIT_BASH_PATH;
    if (gitBash && /(?:^|[\\/])bash\.exe$/i.test(gitBash) && safeFile(gitBash)) bash = gitBash;
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]) {
      if (base && safeFile(join(base, "Git", "bin", "bash.exe"))) bash = join(base, "Git", "bin", "bash.exe");
    }
    if (!bash) throw new InstallFailure("needsGit");
    if ((await run(bash, ["--version"], { timeoutMs: 8_000, cwd: windowsSystem32() })).code !== 0) throw new InstallFailure("needsGit");
  }
  if (entry.recipe?.kind === "winget") {
    resolved("winget", env, "needsWinget");
    const pwsh = resolved("pwsh", env, "needsPowerShell");
    const version = await run(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { timeoutMs: 8_000, cwd: windowsSystem32() });
    if (version.code !== 0 || !/^\s*(?:[6-9]|\d{2,})\s*$/.test(version.stdout)) throw new InstallFailure("needsPowerShell");
    // Copilot's current WinGet manifest has not been qualified for a user-only,
    // non-elevated install. Do not let WinGet fall back to an elevated route.
    throw new InstallFailure("blockedByWindows");
  }
}

export async function runInstallRecipe(recipe: CatalogRecipe, run: RunCli, env: NodeJS.ProcessEnv,
  signal: AbortSignal, refreshPath: () => Promise<unknown>, deadline = Date.now() + INSTALL_TIMEOUT_MS): Promise<CliResult> {
  const timeoutMs = deadline - Date.now();
  if (signal.aborted) throw new InstallFailure("cancelled");
  if (timeoutMs <= 0) throw new InstallFailure("timeout");
  const options = { timeoutMs, cwd: process.platform === "win32" ? windowsSystem32() : "/", installer: { signal } };
  switch (recipe.kind) {
    case "opencode": throw new InstallFailure("installFailed"); // Transactional route is owned by CliInstaller.
    case "powershell": {
      const program = windowsPowerShellPath();
      if (!safeFile(program)) throw new InstallFailure("needsPowerShell");
      const url = new URL(recipe.url);
      if (url.protocol !== "https:" || url.username || url.password || !/^https:\/\/[A-Za-z0-9./_-]+$/.test(recipe.url)) throw new InstallFailure("installFailed");
      const bypass = /(?:-ExecutionPolicy|-ep)\s+Bypass/i.test(recipe.command);
      return run(program, ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", ...(bypass ? ["-ExecutionPolicy", "Bypass"] : []),
        "-Command", `$ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; irm ${recipe.url} | iex; if (-not $?) { exit 1 }; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`], options);
    }
    case "npm": {
      if (process.platform !== "win32") return run("npm", ["install", "-g", recipe.package, "--registry=https://registry.npmjs.org"], options);
      const { node, npm } = externalNpm(env);
      const probe = await run(node, ["--version"], { timeoutMs: 8_000, cwd: windowsSystem32() });
      const major = Number(probe.stdout.trim().match(/^v(\d+)\./)?.[1]);
      if (probe.code !== 0 || !major || (recipe.package === "@google/gemini-cli" && major < 20)) throw new InstallFailure("needsNode");
      const npmProbe = await run(node, [npm, "--version"], { timeoutMs: 8_000, cwd: windowsSystem32() });
      if (npmProbe.code !== 0 || !/^\d+\.\d+/.test(npmProbe.stdout.trim())) throw new InstallFailure("needsNode");
      return run(node, [npm, "install", "-g", recipe.package, "--registry=https://registry.npmjs.org"], options);
    }
    case "uv": return run(resolved("uv", env, "installFailed"), ["tool", "install", recipe.package], options);
    case "winget": throw new InstallFailure("blockedByWindows");
    case "ordered": {
      const first = await runInstallRecipe(recipe.steps[0], run, env, signal, refreshPath, deadline);
      if (first.code !== 0 || first.cleanupConfirmed !== true || signal.aborted) return first;
      await refreshPath();
      return runInstallRecipe(recipe.steps[1], run, env, signal, refreshPath, deadline);
    }
  }
}
