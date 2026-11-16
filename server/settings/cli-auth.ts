import { managedCli } from "./opencode/paths.ts";
import { stripVTControlCharacters } from "node:util";
import { CLI_CATALOG } from "./cli-catalog.ts";
import { catalogTool } from "./cli-catalog-validation.ts";
import { AUTH_ARGS, CLI_TIMEOUT_MS } from "./constants.ts";
import { knownAuthStatus, parseVersion } from "./parse.ts";
import type { CliId, CliResult, RunCli, SettingsState } from "./types.ts";

// No documented read-only auth probe exists in the catalog for the other tools.
// Opening their login window never manufactures a signed-in result.
export async function detectCatalogTool(id: string, state: SettingsState, run: RunCli, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const entry = catalogTool(id), profile = entry.detection!;
  const result = await run(profile.program, profile.args, { timeoutMs: CLI_TIMEOUT_MS, ...(id === "opencode" ? { env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } } : {}) });
  const version = result.code === 0 ? parseVersion(result.stdout || result.stderr) : null;
  const installed = result.code === 0 ? true : result.code === 127 ? false : null;
  const supportedVersion = installed && version ? (profile.supportedMajor ? Number(version.split(".")[0]) === profile.supportedMajor : true) : null;
  let signedIn: boolean | null = null;
  let credentialSource: import("./types.ts").CredentialSource = "unknown";
  const auth = AUTH_ARGS[id as CliId];
  if (installed && supportedVersion && auth) {
    const result = await run(profile.program, auth, { timeoutMs: CLI_TIMEOUT_MS, ...(id === "opencode" ? { env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } } : {}) });
    signedIn = knownAuthStatus(id as CliId, result);
    if (id === "opencode") credentialSource = openCodeCredentialSource(result);
  }
  const managedInstall = (id === "opencode" || id === "copilot") && managedCli(env, id) !== null;
  const facts = { installed, version, signedIn, supportedVersion, ...(id === "opencode" ? { credentialSource } : {}) };
  Object.assign(state.catalogTools[id], facts, { managedInstall });
  if (Object.hasOwn(state.tools, id)) Object.assign(state.tools[id as CliId], facts);
}

export function openCodeCredentialSource(result: CliResult): import("./types.ts").CredentialSource {
  if (result.code !== 0) return "unknown";
  const text = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  const count = text.match(/\b(\d+)\s+credentials?\b/i)?.[1];
  if (count !== undefined && Number(count) > 0) return "stored";
  if (/\benvironment\b/i.test(text)) return "environment";
  return count === "0" ? "none" : "unknown";
}

export async function refreshCatalog(state: SettingsState, run: RunCli, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await Promise.all(CLI_CATALOG.filter((entry) => entry.recipe).map((entry) => detectCatalogTool(entry.id, state, run, env)));
}


// Managed login accepts only recognized probe responses, never the login child's text.
export function catalogLoginStatus(id: string, result: CliResult): boolean | null {
  const text = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`).trim();
  if (id === "claude") {
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed?.loggedIn === false) return false;
      if (parsed?.loggedIn === true) return result.code === 0 ? true : null;
    } catch { /* older versions emit a plain success line */ }
  }
  if (/not (?:logged|signed) in|not authenticated|unauthenticated|logged out/i.test(text)) return false;
  if (result.code !== 0) return null;
  if (id === "codex") return /^Logged in using (?:ChatGPT|an? API key)(?:\s|$)/i.test(text) ? true : null;
  if (id === "claude") return /^(?:Logged in successfully|Login successful)[.!]?$/i.test(text) ? true : null;
  return knownAuthStatus(id as CliId, result);
}
