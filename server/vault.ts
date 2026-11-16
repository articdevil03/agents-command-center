import { realpathSync, statSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isWithinDir } from "./security.ts";
import type { PermissionMode } from "./settings/types.ts";

// Missing/disconnected roots grant no additional access. Never create a vault.
let projectFolders: () => string[] = () => [];
export function setVaultProjectFolders(read: () => string[]): void { projectFolders = read; }
export const BROAD_VAULT_MESSAGE = "That folder is too broad to use as a notes vault. Choose the folder that holds your notes.";
export function isBroadVault(root: string): boolean {
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const contains = (path: string) => { const rel = relative(root, canonical(path)); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };
  return root === parse(root).root || [homedir(), process.cwd(), ...projectFolders()].some(contains);
}
export function resolvedVault(path: string | null | undefined): string | null {
  if (!path || !isAbsolute(path) || path.split(/[\\/]+/).includes("..")) return null;
  try { const root = realpathSync(path); return !isBroadVault(root) && statSync(root).isDirectory() ? root : null; }
  catch { return null; }
}

export function vaultNotice(path: string | null): string {
  if (!path) return "";
  return `\n\nConnected notes vault: ${JSON.stringify(path)}. Read the vault's own guide note first if it has one (for example VAULT-INDEX.md or README.md) and follow its rules for where notes go. Daily notes are append-only. Never delete or overwrite a note you did not create. Never write secrets, passwords or keys into notes.`;
}

export function vaultSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(slug);
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 10);
  const lostInformation = name.trim().toLowerCase().replace(/\s+/g, "-") !== slug;
  const base = !slug ? "note" : reserved ? `note-${slug}` : slug;
  const safe = !slug || lostInformation || base.length > 64 ? `${base.slice(0, 53).replace(/-+$/, "")}-${hash}` : base;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(safe)) throw new Error("Invalid vault note name");
  return safe;
}

export function vaultHandoverPath(root: string, project: string, tab: string): string {
  return join(root, "Command Center", vaultSlug(project), `${vaultSlug(tab)} RESUME.md`);
}

export function vaultSaveInstruction(path: string | null, mode: PermissionMode, project: string, tab: string, saved: string): string {
  if (!path || mode === "plan") return "";
  const frontmatter = `---\ntype: command-center-handover\nproject: ${JSON.stringify(project)}\ntab: ${JSON.stringify(tab)}\nsaved: ${JSON.stringify(saved)}\n---`;
  return `\n\nAlso write the same handover as a note at ${path}. Create folders as needed. Overwrite only this app-owned handover file. Begin it with this YAML frontmatter:\n${frontmatter}\nRead the vault's guide first. Only if it describes a daily-notes folder convention, append one line linking this handover to today's daily note. Never rewrite that daily note. Never write secrets, passwords or keys into notes.`;
}

// Check every component, including the leaf: a junction inside the vault is not
// an app-owned handover, even when its target happens to remain inside the root.
export async function verifiedVaultCopy(root: string, candidate: string, startedAt: number): Promise<boolean> {
  try {
    if (candidate.split(/[\\/]+/).includes("..") || !isWithinDir(resolve(candidate), root)) return false;
    // realpathSync keeps the typed case but fs.promises.realpath canonicalises it: on Windows the same folder compares equal either way.
    const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
    if (fold(await realpath(root)) !== fold(root) || (await lstat(root)).isSymbolicLink()) return false;
    const parts = relative(root, candidate).split(sep);
    let component = root;
    for (const part of parts) {
      component = join(component, part);
      if ((await lstat(component)).isSymbolicLink()) return false;
    }
    const actual = await realpath(candidate);
    if (!isWithinDir(actual, root)) return false;
    const file = await stat(actual);
    return file.isFile() && file.nlink === 1 && file.mtimeMs > startedAt;
  } catch { return false; }
}
