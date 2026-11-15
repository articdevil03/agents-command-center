import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { cliSkipFolders, isFullyQualified, isInsideFolder, windowsSystem32 } from "./cli-path.ts";

const execute = promisify(execFile);
const REGISTRY_KEYS = ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "HKCU\\Environment"];

export function parseRegistryPath(output: string): string {
  const values = output.split(/\r?\n/).filter((line) => /^\s*Path\s+REG_/i.test(line));
  if (values.length !== 1) throw new Error("Registry PATH is unavailable");
  const match = values[0].match(/^\s*Path\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/i);
  if (!match) throw new Error("Registry PATH is malformed");
  return match[1].trim();
}

async function readWindowsRegistryPath(env: NodeJS.ProcessEnv): Promise<string[]> {
  return Promise.all(REGISTRY_KEYS.map(async (key) => {
    const result = await execute(join(windowsSystem32(), "reg.exe"), ["query", key, "/v", "Path"], {
      env, windowsHide: true, timeout: 5_000, shell: false,
    });
    return parseRegistryPath(result.stdout);
  }));
}

type RefreshOptions = {
  readRegistryPath?: (env: NodeJS.ProcessEnv) => string[] | Promise<string[]>;
  env?: NodeJS.ProcessEnv;
  isDirectory?: (path: string) => boolean;
  skipFolders?: string[];
  platform?: NodeJS.Platform;
};
const directoryExists = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
const pathKey = (path: string): string => win32.normalize(path.trim().replace(/^"(.*)"$/, "$1")).replace(/\\+$/, "").toLowerCase();

// Append only: existing PATH bytes and search order belong to the running app.
export async function refreshProcessPath({ readRegistryPath = readWindowsRegistryPath, env = process.env,
  isDirectory = directoryExists, skipFolders, platform = process.platform }: RefreshOptions = {}): Promise<{ added: string[] }> {
  if (env.CC_DEMO_ISOLATED === "1" || platform !== "win32") return { added: [] };
  if (readRegistryPath === readWindowsRegistryPath && (env.CC_TEST_FAKE_CLI === "1" || process.env.CC_TEST_FAKE_CLI === "1" || process.env.NODE_TEST_CONTEXT !== undefined)) return { added: [] };
  try {
    const paths = await readRegistryPath(env);
    if (!Array.isArray(paths) || paths.some((value) => typeof value !== "string")) return { added: [] };
    const key = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
    const previous = env[key] ?? "";
    const seen = new Set(previous.split(";").map(pathKey));
    const skip = [...cliSkipFolders(), ...(skipFolders ?? [])];
    const added: string[] = [];
    for (const raw of paths.flatMap((value) => value.split(";"))) {
      let unknown = false;
      const entry = raw.trim().replace(/^"(.*)"$/, "$1").replace(/%([^%]+)%/g, (_, name: string) => {
        const variable = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
        if (variable === undefined || env[variable] === undefined) { unknown = true; return ""; }
        return env[variable]!;
      });
      if (unknown || entry.includes("%") || /[;\u0000-\u001f]/.test(entry) || !isFullyQualified(entry)) continue;
      if (seen.has(pathKey(entry))) continue;
      if (!isDirectory(entry)) continue;
      if (skip.some((folder) => isInsideFolder(entry, folder))) continue;
      seen.add(pathKey(entry));
      added.push(entry);
    }
    const merged = previous + (previous && !previous.endsWith(";") && added.length ? ";" : "") + added.join(";");
    // Keep PATH below 8001 characters; reject the whole batch rather than partially refreshing.
    if (merged.length > 8000) return { added: [] };
    if (added.length) env[key] = merged;
    return { added };
  } catch { return { added: [] }; } // Best effort: registry/parse/filesystem failures must not break Settings.
}
