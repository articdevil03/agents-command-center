import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { SettingsService, type CliId, type RunCli } from "../server/settings.ts";

// An empty PATH keeps the fake-spawn runner tests independent of what is installed here.
export const NO_PATH = { PATH: "" } as NodeJS.ProcessEnv;
// A CLI that cannot be found on PATH is refused before any spawn, so fake-spawn tests of a known CLI put an (empty) fake of it on an absolute PATH.
export const fakeCliDirs: string[] = [];
export function fakeCliEnv(name: string): { env: NodeJS.ProcessEnv; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "cc-fakecli-")); fakeCliDirs.push(dir);
  const path = join(dir, `${name}.exe`); writeFileSync(path, "");
  return { env: { PATH: dir } as NodeJS.ProcessEnv, path };
}
after(() => { for (const dir of fakeCliDirs) removeWithRetry(dir); });
export type Call = { bin: string; args: string[]; timeoutMs: number; env?: Record<string, string>; verbatimArgs?: boolean };
export const LOGIN_START = ["/c", "start", '""', '"%CC_LOGIN_PROGRAM%"'];
export const PKGS: Record<CliId, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", opencode: "opencode-ai", gemini: "@google/gemini-cli" };

export function harness(initiallyInstalled: CliId[] = ["claude", "codex", "opencode"]) {
  const root = mkdtempSync(join(tmpdir(), "cc-settings-test-"));
  const home = join(root, "home"), dataRoot = join(root, "data"), project = join(root, "project"), vault = join(root, "vault");
  mkdirSync(home, { recursive: true }); mkdirSync(dataRoot, { recursive: true }); mkdirSync(project, { recursive: true }); mkdirSync(vault, { recursive: true });
  // The login window is started by the CLI's resolved path, so the CLIs must be found on an (absolute) PATH.
  const binDir = join(root, "bin"); mkdirSync(binDir, { recursive: true });
  for (const name of ["claude", "codex", "opencode"]) writeFileSync(join(binDir, `${name}.exe`), "");
  const env = { HOME: home, USERPROFILE: home, PATH: binDir, APPDATA: join(root, "appdata") } as NodeJS.ProcessEnv;
  const installed = new Set<CliId>(initiallyInstalled);
  const signedIn: Record<CliId, boolean | null> = { claude: true, codex: false, opencode: false, gemini: null };
  const calls: Call[] = [];
  const runner: RunCli = async (bin, args, options) => {
    calls.push({ bin, args: [...args], timeoutMs: options.timeoutMs, env: options.env, verbatimArgs: options.verbatimArgs });
    if (bin === "npm" && args[0] === "install") {
      const cli = (Object.keys(PKGS) as CliId[]).find((id) => args[2] === PKGS[id]);
      if (cli) installed.add(cli);
      return { code: 0, stdout: "added", stderr: "" };
    }
    if (bin === "cmd" && args[0] === "/c" && args[1] === "start") {
      if (args[3] === "gh") githubConnected = true;
      const started = basename(String(options.env?.CC_LOGIN_PROGRAM ?? args[3]), ".exe") as CliId;
      if (started === "claude" || started === "codex" || started === "opencode") signedIn[started] = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (bin === "gh" && args.join(" ") === "auth status") {
      return githubConnected
        ? { code: 0, stdout: "Logged in to github.com account octocat (keyring)\nToken: ghp_SHOULD_NEVER_LEAK", stderr: "" }
        : { code: 1, stdout: "You are not logged into any GitHub hosts.", stderr: "" };
    }
    if (bin === "gh") return { code: 0, stdout: "", stderr: "" };
    if (bin === "claude" || bin === "codex" || bin === "opencode" || bin === "gemini") {
      if (args.length === 1 && args[0] === "--version") return installed.has(bin) ? { code: 0, stdout: `${bin} 1.2.3\n`, stderr: "" } : { code: 127, stdout: "", stderr: "missing" };
      if (args[0] === "auth" || args[0] === "login") {
        const yes = signedIn[bin];
        return yes ? { code: 0, stdout: "Logged in successfully", stderr: "" } : { code: 1, stdout: "Not logged in", stderr: "" };
      }
      if (args[0] === "mcp" && args[1] === "list") return { code: 0, stdout: "demo-server: stdio connected\n", stderr: "" };
      if (args[0] === "plugin" && args[1] === "list") return { code: 0, stdout: "Installed plugins:\n  - helper@official enabled\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  let githubConnected = true;
  return {
    root, home, dataRoot, project, vault, env, installed, signedIn, calls, runner,
    service: (onChange?: () => void, permissionTimeoutMs?: number) => new SettingsService({ dataRoot, env, runCli: runner, onChange, permissionTimeoutMs, loginRecheckMs: 10 }),
    close: () => removeWithRetry(root),
    setGithub: (connected: boolean) => { githubConnected = connected; },
  };
}

export function persistedPermissionMode(path: string, tabId: string): string {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { permissionModes?: Record<string, string> };
    return value.permissionModes?.[tabId] ?? "accept";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "accept";
    throw error;
  }
}
