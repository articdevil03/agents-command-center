// Builds the shareable copy: `npm run export:public -- <targetDir>` copies the committed files into a new folder, scans every one for the
// owner's personal words (a local list, never exported) plus generic personal-data checks, and only on a clean scan makes a fresh
// single-commit repo there. Any hit prints file:line and stops with nothing written and no git run.
//   --working-tree  proof only: copies and scans the working tree (tracked + new, not ignored) instead of HEAD, and runs no git in the target.
// Test-only env: CC_EXPORT_SOURCE (repo to export, default this one), CC_EXPORT_PATTERNS (pattern file, default <repo>/.leak-patterns.local).
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AUTHOR = "Agents Command Center contributors";
const EMAIL = "noreply@users.noreply.github.com";
const PATTERN_FILE_NAME = ".leak-patterns.local";
// Never exported: the design workspace, the private word list, and internal-only files (each named, with its reason).
const EXCLUDE_PREFIXES = ["design/"];
const EXCLUDE_FILES = new Set([
  PATTERN_FILE_NAME,
  ".packC-map.md", // an internal pack state map, only meaningful to the build process that wrote it
]);
const PROFILE_OK = /^(example|runner|user|username|test|tester|x|public|default|me|you|name|yourname|someone)$/i;
const PROFILE_TOKEN = /^(?:%[A-Za-z_]+%|\$env:[A-Za-z_]+|\$\{[^}]*\})$/i; // %USERNAME%, $env:USERNAME, ${...}, nothing looser
const EMAIL_OK = /@(?:users\.noreply\.github\.com|noreply\.github\.com|(?:[a-z0-9-]+\.)*example(?:\.(?:com|org|net))?)$/i;

// npm's own upstream deprecation text for glob@7 names this address; exempt only that exact address, only in the lockfile, only inside a "deprecated" value.
const LOCKFILE_DEPRECATION_EMAIL = ["i", "izs.me"].join("@"); // built from parts: this file must not hold the address itself
function lockfileDeprecation(label, text, found) {
  if (label !== "package-lock.json" || found[0] !== LOCKFILE_DEPRECATION_EMAIL) return false;
  return /^\s*"deprecated":/.test(text.slice(text.lastIndexOf("\n", found.index) + 1, found.index));
}

const fail = (code, message) => { console.error(message); process.exit(code); };

const args = process.argv.slice(2);
const workingTree = args.includes("--working-tree");
const positional = args.filter((arg) => !arg.startsWith("--"));
if (positional.length !== 1 || args.some((arg) => arg.startsWith("--") && arg !== "--working-tree")) fail(2, "usage: node scripts/export-public.mjs <targetDir> [--working-tree]");
const sourceRoot = resolve(process.env.CC_EXPORT_SOURCE ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const patternFile = resolve(process.env.CC_EXPORT_PATTERNS ?? join(sourceRoot, PATTERN_FILE_NAME));
const target = resolve(positional[0]);

const git = (cwd, gitArgs, options = {}) => execFileSync("git", gitArgs, { cwd, maxBuffer: 1 << 30, windowsHide: true, ...options });
const list = (gitArgs) => git(sourceRoot, gitArgs).toString("utf8").split("\0").filter(Boolean);

// ---- the word list: never exports unscanned ----
if (!existsSync(patternFile)) fail(2, `refusing to export: the pattern file is missing (${basename(patternFile)}); nothing is exported unscanned`);
const patterns = [];
readFileSync(patternFile, "utf8").split(/\r?\n/).forEach((line, index) => {
  const text = line.trim();
  if (!text || text.startsWith("#")) return;
  try { patterns.push({ line: index + 1, regex: new RegExp(text, "i") }); }
  catch { fail(2, `refusing to export: pattern file line ${index + 1} is not a valid regular expression`); }
});
if (patterns.length === 0) fail(2, "refusing to export: the pattern file has no patterns; nothing is exported unscanned");

// ---- the target: new or empty, outside the repo, not a link ----
function existingAncestor(path) { let dir = path; while (!existsSync(dir)) dir = dirname(dir); return dir; }
{
  const resolved = join(realpathSync(existingAncestor(target)), relative(existingAncestor(target), target));
  const inside = relative(realpathSync(sourceRoot), resolved);
  if (inside === "" || (inside.split(/[\\/]/)[0] !== ".." && !isAbsolute(inside))) fail(2, `refusing to export: ${target} is inside the repo`);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) fail(2, `refusing to export: ${target} is a link`);
    if (!lstatSync(target).isDirectory()) fail(2, `refusing to export: ${target} is not a folder`);
    if (readdirSync(target).length > 0) fail(2, `refusing to export: ${target} is not empty`);
  }
}

// ---- what is exported ----
const excluded = (path) => EXCLUDE_FILES.has(path) || EXCLUDE_PREFIXES.some((prefix) => path.startsWith(prefix));
const ignored = new Set(list(["ls-files", "-z", "-c", "-i", "--exclude-standard"]));
const files = []; // { path, bytes }
if (workingTree) {
  for (const path of new Set(list(["ls-files", "-z", "-c", "-o", "--exclude-standard"]))) {
    const full = join(sourceRoot, path);
    if (excluded(path) || ignored.has(path) || !existsSync(full)) continue;
    if (lstatSync(full).isSymbolicLink()) fail(2, `refusing to export: ${path} is a link`);
    files.push({ path, bytes: readFileSync(full) });
  }
} else {
  for (const entry of list(["ls-tree", "-r", "-z", "HEAD"])) {
    const [meta, path] = entry.split("\t");
    if (excluded(path) || ignored.has(path)) continue;
    if (!meta.startsWith("100")) fail(2, `refusing to export: ${path} is not a plain file (${meta.split(" ")[0]})`);
    files.push({ path, bytes: git(sourceRoot, ["show", `HEAD:${path}`]) });
  }
}

// ---- the scan: every byte and every name; a hit stops everything ----
const hits = new Set(); // a set: the byte pass and the text pass may report the same place
function scanText(label, text, lineOf) {
  for (const { line, regex } of patterns) {
    const found = regex.exec(text);
    if (found) hits.add(`${label}${lineOf(found.index)}: pattern #${line} matched "${found[0].slice(0, 80)}"`);
  }
  for (const found of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
    // Only GitHub's own noreply domains and the reserved example domains are not personal data.
    if (!EMAIL_OK.test(found[0]) && !lockfileDeprecation(label, text, found)) hits.add(`${label}${lineOf(found.index)}: built-in email address "${found[0].slice(0, 80)}"`);
  }
  // The whole folder name (spaces included) up to the next separator or closing quote; only a complete placeholder or token is exempt.
  for (const found of text.matchAll(/(?:[A-Za-z]:|\/[a-z])[\\/]+Users[\\/]+([^\\/\r\n"'`<>|*?;,)]+)/gi)) {
    const name = found[1].trim();
    if (!PROFILE_OK.test(name) && !PROFILE_TOKEN.test(name)) hits.add(`${label}${lineOf(found.index)}: built-in Windows user-profile path "${found[0].slice(0, 80)}"`);
  }
}
for (const { path, bytes } of files) {
  scanText(`${path}`, path, () => " (file name)");
  // latin1 keeps one char per byte, so a binary file is scanned byte for byte and the line number counts real newlines.
  const text = bytes.toString("latin1");
  const lineOf = (index) => `:${text.slice(0, index).split("\n").length}`;
  scanText(path, text, lineOf);
  const utf8 = bytes.toString("utf8");
  if (utf8 !== text) scanText(path, utf8, (index) => `:${utf8.slice(0, index).split("\n").length}`);
  // UTF-16 holds a NUL beside every ASCII letter, so the byte pass cannot see a word in it: decode both byte orders too.
  if (bytes.includes(0)) {
    const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
    for (const wide of [even.toString("utf16le"), Buffer.from(even).swap16().toString("utf16le")]) scanText(path, wide, (index) => `:${wide.slice(0, index).split("\n").length}`);
  }
}
if (hits.size > 0) {
  console.error([...hits].join("\n"));
  fail(1, `export stopped: ${hits.size} hit(s) in ${files.length} files; nothing was written`);
}

// ---- copy ----
for (const { path, bytes } of files) {
  const out = join(target, ...path.split("/"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
}
mkdirSync(target, { recursive: true });
if (workingTree) {
  console.log(`working-tree scan clean: 0 hits, ${files.length} files copied to ${target} (no git run)`);
  process.exit(0);
}

// ---- one fresh commit with a neutral author, never touching the global git config ----
const identity = { GIT_AUTHOR_NAME: AUTHOR, GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: AUTHOR, GIT_COMMITTER_EMAIL: EMAIL };
const run = (gitArgs) => git(target, ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...gitArgs], { env: { ...process.env, ...identity } });
run(["init", "-q", "--initial-branch=main"]);
run(["add", "-A", "-f"]);
run(["commit", "-q", "-m", "Initial public release"]);
const tracked = run(["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean).length;
if (tracked !== files.length) fail(1, `export stopped: the new repo holds ${tracked} files but ${files.length} were copied`);
console.log(`exported ${tracked} files, commit ${run(["rev-parse", "HEAD"]).toString("utf8").trim()}, in ${target}`);
