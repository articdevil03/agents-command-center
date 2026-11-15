import { openSync, readFileSync, fstatSync, closeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Only the Go key enters the leader's private redactor. Never return the store.
export function goCredentialSecrets(env: NodeJS.ProcessEnv): string[] {
  let store: unknown, fd: number | undefined;
  try {
    if (env.OPENCODE_AUTH_CONTENT) store = JSON.parse(env.OPENCODE_AUTH_CONTENT);
    else {
      const home = env.USERPROFILE || env.HOME;
      const base = env.XDG_DATA_HOME || (home && join(home, ".local", "share"));
      if (!base || !isAbsolute(base)) return [];
      fd = openSync(join(base, "opencode", "auth.json"), "r");
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 1024 * 1024) return [];
      store = JSON.parse(readFileSync(fd, "utf8"));
    }
    const entry = (store as any)?.["opencode-go"];
    const key = entry?.type === "api" && typeof entry.key === "string" ? entry.key : "";
    return key ? [...new Set([key, JSON.stringify(key).slice(1, -1)])] : [];
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function hasCredentialOverride(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([name, value]) => /^(?:OPENCODE_API_KEY|OPENCODE_AUTH_CONTENT)$/i.test(name) && !!value);
}
