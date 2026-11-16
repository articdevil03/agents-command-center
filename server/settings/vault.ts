import { closeSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isBroadVault, resolvedVault } from "../vault.ts";

export type VaultStatus = "disconnected" | "connected" | "missing" | "broad" | "readonly";
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
