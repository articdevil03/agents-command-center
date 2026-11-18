import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

export const PATTERN_FILE_NAME = ".leak-patterns.local";
export const MIN_PACKAGED_FILES = 50;
export const FORBIDDEN_PACKAGED_ENTRIES = [
  "config/first-run.json", "config/workspaces.json", "config/projects.json", "config/setups.json",
  "config/launch-safety.json", "config/client-prefs.json", "config/own-sessions.json",
  "config/fixed-crew-recovery.json", "config/acp-clis.json", ".leak-patterns.local",
  "backups", "tasks", "executions", "execution-logs", "logs", "scratch", "chats", "avatars", "example-project", "Microsoft",
];
const refuse = (message) => { throw Object.assign(new Error(message), { exitCode: 2 }); };
export const CONFIG_SEED_ENTRIES = new Set(["config/.gitkeep"]);
const unknownConfig = (path) => path.startsWith("config/") && !CONFIG_SEED_ENTRIES.has(path);

export function assertConfigClean(root) {
  const config = join(root, "config");
  let info;
  try { info = lstatSync(config); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) refuse("private packaged entry: config must be a plain folder");
  for (const name of readdirSync(config)) {
    const path = `config/${name}`;
    if (unknownConfig(path)) refuse(`private packaged entry: forbidden entry ${path} (config seed allow-list)`);
    const seed = lstatSync(join(root, path));
    if (seed.isSymbolicLink() || !seed.isFile()) refuse(`private packaged entry: ${path} must be a plain file`);
  }
}
const PROFILE_OK = /^(example|runner|user|username|test|tester|x|public|default|me|you|name|yourname|someone)$/i;
const PROFILE_TOKEN = /^(?:%[A-Za-z_]+%|\$env:[A-Za-z_]+|\$\{[^}]*\})$/i; // %USERNAME%, $env:USERNAME, ${...}, nothing looser
const EMAIL_OK = /@(?:users\.noreply\.github\.com|noreply\.github\.com|(?:[a-z0-9-]+\.)*example(?:\.(?:com|org|net))?)$/i;

// npm's own upstream deprecation text for glob@7 names this address; exempt only that exact address, only in the lockfile, only inside a "deprecated" value.
const LOCKFILE_DEPRECATION_EMAIL = ["i", "izs.me"].join("@"); // built from parts: this file must not hold the address itself
function lockfileDeprecation(label, text, found) {
  if (label !== "package-lock.json" || found[0] !== LOCKFILE_DEPRECATION_EMAIL) return false;
  return /^\s*"deprecated":/.test(text.slice(text.lastIndexOf("\n", found.index) + 1, found.index));
}


export function loadPatterns(patternFile) {
  if (!existsSync(patternFile)) refuse(`refusing to export: the pattern file is missing (${basename(patternFile)}); nothing is exported unscanned`);
  const patterns = [];
  readFileSync(patternFile, "utf8").split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith("#")) return;
    try { patterns.push({ line: index + 1, regex: new RegExp(text, "i") }); }
    catch { refuse(`refusing to export: pattern file line ${index + 1} is not a valid regular expression`); }
  });
  if (patterns.length === 0) refuse("refusing to export: the pattern file has no patterns; nothing is exported unscanned");
  return patterns;
}

const reviewedPath = (path) => path.startsWith("node_modules/") && !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== "..");
export function loadReviewedFiles(file = process.env.CC_EXPORT_REVIEWED ?? new URL("./third-party-reviewed.json", import.meta.url)) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const keysAre = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    if (!keysAre(data, ["version", "files"]) || data.version !== 1 || !Array.isArray(data.files)) throw new Error("invalid schema");
    const seen = new Set();
    for (const entry of data.files) {
      if (!keysAre(entry, ["package", "version", "path", "sha256", "reason"])
        || !["package", "version", "path", "sha256", "reason"].every((key) => typeof entry[key] === "string" && entry[key].trim())
        || !reviewedPath(entry.path) || !/^[a-f0-9]{64}$/i.test(entry.sha256) || seen.has(entry.path)) throw new Error("invalid entry");
      seen.add(entry.path);
    }
    return data.files;
  } catch { refuse("refusing packaged scan: reviewed third-party allowlist is missing or malformed"); }
}

export function scanFiles(files, patterns, { packaged = false, reviewedFile, report = console.log } = {}) {
  const reviewed = packaged ? loadReviewedFiles(reviewedFile) : [];
  const byPath = new Map(reviewed.map((entry) => [entry.path, entry]));
  const seen = new Set();
  let exempt = 0;
  const hits = new Set(); // a set: the byte pass and the text pass may report the same place
  function scanText(label, text, lineOf, heuristics) {
    for (const { line, regex } of patterns) {
      const found = regex.exec(text);
      if (found) hits.add(`${label}${lineOf(found.index)}: pattern #${line} matched "${found[0].slice(0, 80)}"`);
    }
    if (!heuristics) return;
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
    if (unknownConfig(path)) hits.add(`${path}: forbidden config entry (config seed allow-list)`);
    const entry = byPath.get(path);
    if (entry) seen.add(path);
    if (packaged && reviewedPath(path) && entry) {
      if (createHash("sha256").update(bytes).digest("hex") === entry.sha256.toLowerCase()) { exempt++; continue; }
      report(`reviewed file changed, scanning it normally: ${path}`);
    }
    const heuristics = !packaged || !path.startsWith("node_modules/");
    scanText(`${path}`, path, () => " (file name)", heuristics);
    // latin1 keeps one char per byte, so a binary file is scanned byte for byte and the line number counts real newlines.
    const text = bytes.toString("latin1");
    const lineOf = (index) => `:${text.slice(0, index).split("\n").length}`;
    scanText(path, text, lineOf, heuristics);
    const utf8 = bytes.toString("utf8");
    if (utf8 !== text) scanText(path, utf8, (index) => `:${utf8.slice(0, index).split("\n").length}`, heuristics);
    // UTF-16 holds a NUL beside every ASCII letter, so the byte pass cannot see a word in it: decode both byte orders too.
    if (bytes.includes(0)) {
      const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
      for (const wide of [even.toString("utf16le"), Buffer.from(even).swap16().toString("utf16le")]) scanText(path, wide, (index) => `:${wide.slice(0, index).split("\n").length}`, heuristics);
    }
  }

  if (packaged) {
    report(`reviewed third-party files exempt from the word scan: ${exempt} of ${reviewed.length}`);
    for (const entry of reviewed) if (!seen.has(entry.path)) report(`reviewed entry not present: ${entry.path}`);
  }
  return hits;
}

// Config paths and the private list are forbidden at any depth; data folders only at the root.
export function packagedFiles(root) {
  if (!existsSync(root)) refuse("refusing packaged scan: folder is missing");
  assertConfigClean(root);
  const files = [];
  function walk(full, rel = "") {
    const info = lstatSync(full);
    if (info.isSymbolicLink()) refuse(`refusing packaged scan: ${rel || root} is a link`);
    const normalized = rel.toLowerCase();
    if (FORBIDDEN_PACKAGED_ENTRIES.some((entry) => entry.includes("/") || entry === PATTERN_FILE_NAME
      ? normalized === entry.toLowerCase() || normalized.endsWith("/" + entry.toLowerCase())
      : normalized === entry.toLowerCase())) refuse(`refusing packaged scan: forbidden entry ${rel}`);
    if (info.isDirectory()) {
      for (const name of readdirSync(full)) walk(join(full, name), rel ? rel + "/" + name : name);
    } else if (info.isFile() && rel) files.push({ path: rel, bytes: readFileSync(full) });
    else refuse(`refusing packaged scan: ${rel || root} is not a plain file or folder`);
  }
  if (!lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink()) refuse("refusing packaged scan: not a folder");
  walk(root);
  if (files.length < MIN_PACKAGED_FILES) refuse(`refusing packaged scan: only ${files.length} files; minimum ${MIN_PACKAGED_FILES} (empty or incomplete payload)`);
  return files;
}
