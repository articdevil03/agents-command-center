import { closeSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isBroadVault, resolvedVault } from "../vault.ts";

export type VaultStatus = "disconnected" | "connected" | "missing" | "broad" | "readonly";

// Startup trusts the saved connection until the first async refresh. Never touch the saved share here.
export function initialVaultStatus(path: string | null): VaultStatus {
  if (!path) return "disconnected";
  if (!isAbsolute(path) || path.split(/[\\/]+/).includes("..")) return "missing";
  return isBroadVault(path) ? "broad" : "connected";
}

// A stalled share cannot hold Settings open. This checks presence only, never writeability.
export async function readVaultStatus(path: string | null, timeoutMs = 1500): Promise<VaultStatus> {
  if (!path) return "disconnected";
  if (!isAbsolute(path) || path.split(/[\\/]+/).includes("..")) return "missing";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<VaultStatus> => {
    try {
      const root = await realpath(path);
      if (isBroadVault(root)) return "broad";
      return (await stat(root)).isDirectory() ? "connected" : "missing";
    } catch { return "missing"; }
  };
  try { return await Promise.race([read(), new Promise<VaultStatus>((done) => { timer = setTimeout(() => done("missing"), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export async function canonicalDirectory(value: unknown, label: string): Promise<string> {
  if (typeof value === "string" && !value.trim()) throw new Error(`${label} is required`);
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be an absolute directory path`);
  const candidate = value.trim();
  if (!isAbsolute(candidate) || candidate.split(/[\\/]+/).includes("..")) throw new Error(`${label} must be an absolute directory path without traversal`);
  let canonical: string;
  try { canonical = await realpath(candidate); }
  catch { throw new Error(`${label} folder does not exist`); }
  try { if (!(await stat(canonical)).isDirectory()) throw new Error(`${label} must be a directory`); }
  catch (error) { if (error instanceof Error && error.message.includes("must be a directory")) throw error; throw new Error(`${label} folder is unavailable`); }
  return canonical;
}

// Explicit Connect/Change only. Cleanup owns precisely the file opened with wx, never another probe.
export function checkVaultStatus(path: string | null, unlink: typeof unlinkSync = unlinkSync): VaultStatus {
  if (!path) return "disconnected";
  let root: string;
  try { root = realpathSync(path); if (!statSync(root).isDirectory()) return "missing"; }
  catch { return "missing"; }
  if (isBroadVault(root)) return "broad";
  if (!resolvedVault(root)) return "missing";
  const probe = join(root, `.command-center-write-probe-${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(probe, "wx");
    created = true;
    closeSync(fd);
  } catch { return "readonly"; }
  finally {
    if (created) {
      try { unlink(probe); }
      catch { setTimeout(() => { try { unlink(probe); } catch { /* A unique empty probe may stay locked by a sync tool. */ } }, 100); }
    }
  }
  return "connected";
}
