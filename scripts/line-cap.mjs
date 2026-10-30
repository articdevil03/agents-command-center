import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

// The size cap: no file a change touches may be over 400 lines. Changed = differs from CC_LINE_CAP_BASE (default origin/master), plus
// uncommitted and untracked files. `--all` checks every tracked file. Deleted files are ignored. Nothing is skipped silently.
const CAP = 400;
const SKIPPED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".json"]);
const SKIPPED_FILES = new Set(["public/logos.js"]);
const SKIPPED_FOLDERS = [["scripts/mutations/", "catalogue data"], ["design/", "private mockups"]];

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.split(args.includes("-z") ? "\0" : "\n").filter(Boolean);
}

export function skipReason(file) {
  if (SKIPPED_EXTENSIONS.has(extname(file).toLowerCase())) return "binary, art or json";
  if (SKIPPED_FILES.has(file)) return "one-line data";
  return SKIPPED_FOLDERS.find(([folder]) => file.startsWith(folder))?.[1];
}

// Line count = number of "\n", plus 1 when the text is not empty and does not end with "\n" (what `wc -l` shows for a file ending in a newline).
export function countLines(text) {
  const breaks = text.split("\n").length - 1;
  return text === "" || text.endsWith("\n") ? breaks : breaks + 1;
}

if (import.meta.main) {
  const root = git(process.cwd(), "rev-parse", "--show-toplevel")[0];
  const base = process.env.CC_LINE_CAP_BASE || "origin/master";
  const files = process.argv.includes("--all")
    ? git(root, "ls-files", "-z")
    : [...new Set([
        ...git(root, "diff", "--name-only", "-z", "--no-renames", base),
        ...git(root, "diff", "--name-only", "-z", "--no-renames"),
        ...git(root, "ls-files", "-z", "--others", "--exclude-standard"),
      ])].sort();
  const over = [];
  let checked = 0;
  for (const file of files) {
    let text;
    try { text = readFileSync(join(root, file), "utf8"); } catch (error) {
      if (error.code === "ENOENT") continue; // deleted
      console.error(`Cannot read ${file}: ${error.message}`);
      process.exit(1);
    }
    const reason = skipReason(file);
    if (reason) { console.log(`skipped ${file} (${reason})`); continue; }
    const lines = countLines(text);
    checked++;
    console.log(`${lines} ${file}`);
    if (lines > CAP) over.push(`${file} (${lines})`);
  }
  console.log(`${checked} files checked, ${over.length} over ${CAP} lines`);
  if (over.length) { console.log(`OVER ${CAP}: ${over.join(", ")}`); process.exit(1); }
}
