import { open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isTabSlug } from "./chat-store.ts";
import { isWithinDir } from "./security.ts";
import { runCli, type RunCli } from "./settings.ts";

export type ChangedFile = { status: string; path: string };
export type LastCommit = { hash: string; subject: string };
export type GitChanges = {
  repo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  lastCommit: LastCommit | null;
  uncommittedFiles: ChangedFile[];
};
export type TabNotes = { path: string | null; content: string; truncated: boolean };

const CHANGE_TIMEOUT_MS = 5_000;
const NOTES_MAX_BYTES = 64 * 1024;
// A project's own .git/config can name a program git would run (core.fsmonitor); status and log here only read, so that is switched off.
// log.showSignature would put the signature check in front of the hash.
const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false"];
const NOT_A_REPO: GitChanges = { repo: false, branch: null, ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [] };

// `status --porcelain=v1 -z -b`: stable machine output. Entries end in NUL, paths are never quoted or escaped, and renames are split (--no-renames).
function parseStatus(text: string): Omit<GitChanges, "lastCommit"> | null {
  const lines = text.split("\0");
  const header = lines.find((line) => line.startsWith("## "));
  if (!header) return null;
  let branchLine = header.slice(3).trim();
  const counts = branchLine.match(/\s+\[(.*?)\]$/);
  const ahead = counts?.[1].match(/ahead (\d+)/)?.[1];
  const behind = counts?.[1].match(/behind (\d+)/)?.[1];
  if (counts) branchLine = branchLine.slice(0, counts.index).trim();
  const tracking = branchLine.indexOf("...");
  let branch: string | null = tracking >= 0 ? branchLine.slice(0, tracking) : branchLine;
  const unborn = branch.match(/^No commits yet on (.+)$/);
  if (unborn) branch = unborn[1];
  if (!branch || branch === "HEAD (no branch)") branch = branch === "HEAD (no branch)" ? "(detached)" : null;
  const uncommittedFiles: ChangedFile[] = [];
  for (const line of lines) {
    if (line.startsWith("## ") || line.length < 4) continue;
    const status = line.slice(0, 2).trim() || "?";
    const path = line.slice(3);
    if (path) uncommittedFiles.push({ status, path });
  }
  return { repo: true, branch, ahead: Number(ahead ?? 0), behind: Number(behind ?? 0), uncommittedFiles };
}

export async function readGitChanges(folder: string, runner: RunCli = runCli): Promise<GitChanges> {
  if (typeof folder !== "string" || !folder.trim()) return { ...NOT_A_REPO };
  let status;
  try { status = await runner("git", [...GIT_SAFE, "--no-optional-locks", "-C", folder, "status", "--porcelain=v1", "-z", "-b", "--no-renames"], { timeoutMs: CHANGE_TIMEOUT_MS }); }
  catch { return { ...NOT_A_REPO }; }
  if (status.code !== 0) return { ...NOT_A_REPO };
  const parsed = parseStatus(status.stdout);
  if (!parsed) return { ...NOT_A_REPO };
  let lastCommit: LastCommit | null = null;
  let log;
  try { log = await runner("git", [...GIT_SAFE, "-C", folder, "log", "-1", "--format=%h%x00%s"], { timeoutMs: CHANGE_TIMEOUT_MS }); }
  catch { log = { code: -1, stdout: "", stderr: "" }; }
  if (log.code === 0) {
    const text = log.stdout.replace(/[\r\n]+$/, "");
    const split = text.indexOf("\0");
    if (split >= 0) lastCommit = { hash: text.slice(0, split), subject: text.slice(split + 1) };
    else if (text) lastCommit = { hash: text.split(/\s+/, 1)[0], subject: text.slice(text.indexOf(" ") + 1) };
  }
  return { ...parsed, lastCommit };
}

// One handover per tab, so two tabs on one folder never overwrite each other's. The folder's older shared file is only ever read.
export function handoverPath(folder: string, tabId: string): string {
  if (!isTabSlug(tabId)) throw new Error(`unsafe tab id: ${tabId}`);
  return join(folder, ".command-center", tabId, "RESUME.md");
}
export function legacyHandoverPath(folder: string): string { return join(folder, ".command-center", "RESUME.md"); }

// The tab's own handover; until it has saved one, the folder's older shared file (read only, so an existing handover is not lost).
export async function readTabNotes(folder: string, tabId: string, maxBytes = NOTES_MAX_BYTES): Promise<TabNotes> {
  const none: TabNotes = { path: null, content: "", truncated: false };
  if (typeof folder !== "string" || !folder.trim()) return none;
  try {
    const base = await realpath(folder);
    for (const candidate of [handoverPath(folder, tabId), legacyHandoverPath(folder)]) {
      let file: string;
      try { file = await realpath(candidate); } catch { continue; } // not there: the next one
      // A file that is there but refused (outside the folder, not a file) is the answer: nothing falls through to the other one.
      if (!isWithinDir(file, base) || !(await stat(file)).isFile()) return none;
      const handle = await open(file, "r");
      try {
        const bytes = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const truncated = bytesRead > maxBytes;
        return { path: file, content: bytes.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"), truncated };
      } finally { await handle.close(); }
    }
  } catch { /* unreadable: no notes */ }
  return none;
}
