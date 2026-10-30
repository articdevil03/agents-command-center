import type { RunnerRun } from "./runner.ts";

// The crew tools: Claude reads a config file (path in MCP_VAR, holds the token), Codex and OpenCode read the url and token from the environment.
export const MCP_VAR = "CC_MCP_CONFIG";
export const CREW_URL_VAR = "CC_CREW_URL";
export const CREW_TOKEN_VAR = "CC_CREW_TOKEN";
export const CREW_SERVER = "tab-crew";

// Codex and OpenCode read the crew tools' url and token from the environment (the token is never on a command line); Claude reads a config file, see usesMcpFile.
export function crewEnv(run: RunnerRun): NodeJS.ProcessEnv {
  const crew = run.crewTools;
  if (!crew) return {};
  switch (run.cli) {
    case "codex": case "opencode": return { [CREW_URL_VAR]: crew.url, [CREW_TOKEN_VAR]: crew.token };
    default: return {};
  }
}
export function usesMcpFile(run: RunnerRun): boolean {
  switch (run.cli) {
    case "claude": return Boolean(run.crewTools);
    default: return false;
  }
}
// One config for OpenCode: the read-only deny part (read-only seats) and the crew tools (the seat that runs the process), merged, never two variables.
export function opencodeConfig(run: RunnerRun): string | undefined {
  const crew = run.crewTools;
  if (run.canWrite && !crew) return undefined;
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    ...(run.canWrite ? {} : { permission: { edit: "deny", bash: "deny" } }),
    ...(crew ? { mcp: { [CREW_SERVER]: { type: "remote", url: crew.url, headers: { Authorization: `Bearer {env:${CREW_TOKEN_VAR}}` }, oauth: false } } } : {}),
  });
}
// The url goes into a quoted command argument and a config file, the token into the environment and one config file: both must be plain words.
export function checkCrewTools(run: RunnerRun): void {
  const crew = run.crewTools;
  if (!crew) return;
  if (!/^http:\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9._~\/%-]*$/.test(crew.url)) throw new Error("buildCommand: refusing unsafe crew tools url");
  if (!/^[A-Za-z0-9._~+-]{8,256}$/.test(crew.token)) throw new Error("buildCommand: refusing unsafe crew tools token");
}
