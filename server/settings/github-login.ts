import { resolveCliPath } from "../leader-common/cli-path.ts";
import type { CliResult } from "./types.ts";

// Internal authentication target, deliberately absent from the AI catalog.
export const GITHUB_LOGIN_ARGS = ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https", "--skip-ssh-key"];
export const GITHUB_STATUS_ARGS = ["auth", "status", "--active", "--hostname", "github.com"];
export function resolveGitHub(env: NodeJS.ProcessEnv): string | null {
  const found = resolveCliPath("gh", env, process.cwd());
  if (found && /\.exe$/i.test(found) && !/["\r\n\0]/.test(found)) return found;
  const standard = resolveCliPath("gh", { PATH: "C:\\Program Files\\GitHub CLI" }, process.cwd());
  return standard && /\.exe$/i.test(standard) ? standard : null;
}
export function githubUnavailable(): CliResult { return { code: 127, stdout: "", stderr: "", cleanupConfirmed: true }; }
