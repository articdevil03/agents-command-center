import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { writeFileSynced } from "./safe-file.ts";

// "Work on this project only": the AGENTS.md written into a new tab's folder. One file reaches every leader CLI (Claude, Codex and OpenCode all read it).
export type RulesOutcome = { outcome: "added" | "ours" | "other" | "failed"; message: string };

const FIRST_LINE = /^This folder is the (.+) project\.$/;
const cleanName = (name: string, folder: string): string => name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim() || basename(folder) || "this";

export function rulesText(name: string, folder: string): string {
  return [
    `This folder is the ${cleanName(name, folder)} project.`,
    "Work only on this project, inside this folder.",
    "Do not read or change files outside this folder unless the user names them.",
    "Keep this project's notes and progress in this folder.",
    "",
  ].join("\r\n");
}

// What is already at the path, judged without following a link: a file of ours names its project, anything else is someone else's and is never touched.
function existing(path: string): RulesOutcome | null {
  let info;
  try { info = lstatSync(path); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  const other: RulesOutcome = { outcome: "other", message: "This folder already has an AGENTS.md of its own, left alone" };
  if (!info.isFile()) return other;
  const head = Buffer.alloc(400);
  let used = 0;
  try { const fd = openSync(path, "r"); try { used = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); } } catch { return other; }
  const name = FIRST_LINE.exec(head.toString("utf8", 0, used).split(/\r?\n/, 1)[0])?.[1];
  return name ? { outcome: "ours", message: `This folder already has rules for ${name}, left alone` } : other;
}

const REASONS: Record<string, string> = { EACCES: "no permission to write there", EPERM: "no permission to write there", EROFS: "the folder is read-only", ENOSPC: "the disk is full" };

// Never throws: a failed write must not undo the project or tab that was just saved.
export function writeProjectRules(folder: string, projectName: string): RulesOutcome {
  const path = join(folder, "AGENTS.md");
  try {
    const found = existing(path);
    if (found) return found;
    try { writeFileSynced(path, rulesText(projectName, folder)); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return existing(path) ?? { outcome: "other", message: "This folder already has an AGENTS.md of its own, left alone" };
      throw err;
    }
    return { outcome: "added", message: "Added AGENTS.md" };
  } catch (err) {
    return { outcome: "failed", message: `Could not write AGENTS.md: ${REASONS[(err as NodeJS.ErrnoException).code ?? ""] ?? "the folder did not allow it"}` };
  }
}
