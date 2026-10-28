import { timingSafeEqual } from "node:crypto";
import { sep } from "node:path";

// Same port the server actually binds to (see server/index.ts). CC_PORT=0
// asks the OS for a free port, so the real port isn't known at module load --
// setAllowedPort() is called from index.ts's listen() callback once it is.
let ALLOWED_ORIGINS = new Set<string>();
let ALLOWED_HOSTS = new Set<string>();

export function setAllowedPort(port: number): void {
  ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  ALLOWED_HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

setAllowedPort(Number(process.env.CC_PORT) || 4317);

// Origin and Host checks stop a page on another site (and DNS rebinding) from
// driving this server through the user's browser. They are not authentication: any
// local process can set those headers. The app key below is the authentication:
// 32 random bytes per app start, known only to the page (and the server), so a
// local process, including an agent the app started, cannot answer approvals or
// launch seats without it.
let APP_KEY = Buffer.alloc(0);

export function setAppKey(key: string): void { APP_KEY = Buffer.from(key, "utf8"); }

// Fails closed: no key set means nothing matches.
export function hasValidAppKey(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !APP_KEY.length) return false;
  const given = Buffer.from(candidate, "utf8");
  return given.length === APP_KEY.length && timingSafeEqual(given, APP_KEY);
}

// The WebSocket key travels as ?key= because a browser page cannot set upgrade headers.
export function wsKeyFromUrl(url: string | undefined): string | null {
  try { return new URL(url ?? "/", "http://127.0.0.1").searchParams.get("key"); } catch { return null; }
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // no Origin header => not a browser page (curl, wscat, ...)
  return ALLOWED_ORIGINS.has(origin);
}

export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  return ALLOWED_HOSTS.has(host);
}

// Windows paths are case-insensitive: C:\Data and c:\data are the same folder, so they compare the same.
export function isWithinDir(resolved: string, dir: string): boolean {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const candidate = fold(resolved), root = fold(dir);
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}
