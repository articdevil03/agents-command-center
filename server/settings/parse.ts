import { PLUGIN_NAME } from "./constants.ts";
import type { CliId, CliResult, McpItem } from "./types.ts";

const COMMAND_META = /[;&|<>`$(){}\[\]*?~%!^\r\n]/;

export function parseVersion(text: string): string | null {
  const match = text.match(/(?:^|[^A-Za-z0-9])v?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)(?:$|[^A-Za-z0-9])/m);
  return match?.[1] ?? null;
}

export function knownAuthStatus(cli: CliId, result: CliResult): boolean | null {
  const text = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  // `claude auth status` prints JSON: {"loggedIn": true, ...}.
  if (cli === "claude") {
    try { const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown }; if (typeof parsed?.loggedIn === "boolean") return parsed.loggedIn; } catch { /* older CLIs print words: matched below */ }
  }
  const lower = text.toLowerCase();
  if (cli === "opencode") {
    if (result.code !== 0) return null;
    const count = lower.match(/\b(\d+)\s+credentials?\b/)?.[1];
    return count === undefined ? null : Number(count) > 0;
  }
  if (/not logged in|not authenticated|no credentials|logged out|unauthenticated|no providers configured/.test(lower)) return false;
  if (/logged in|authenticated|signed in|credentials found/.test(lower)) return true;
  // `opencode auth list` ends with "N credentials"; the box-drawing lines around it say nothing.
  return null;
}

export function parseGitHubAuthStatus(result: CliResult, reader: "login" | "settings" = "login"): { connected: boolean | null; account: string | null } {
  const text = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const loggedIn = text.match(/Logged in to github\.com account ([A-Za-z0-9-]{1,39})\b/i);
  const active = /Active account:\s*true\b/i.test(text);
  const negative = /not logged in|not logged into any github hosts|no authentication token|Active account:\s*false/i.test(text);
  if (reader === "settings" && (result.code === 124 || result.code === 127 || result.code < 0 || !text.trim())) return { connected: null, account: null };
  if (result.code === 0 && loggedIn && active && !negative) return { connected: true, account: loggedIn[1] };
  if (reader === "settings" && !negative) return { connected: null, account: null };
  return { connected: false, account: null };
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
