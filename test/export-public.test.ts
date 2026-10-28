import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "./temp-root.ts";

// Drives the real scripts/export-public.mjs against a small throwaway git repo (the real repo's HEAD only turns clean once this pack is committed),
// with a TEST pattern file: the owner's real word list is never read here.
const script = fileURLToPath(new URL("../scripts/export-public.mjs", import.meta.url));
const WORD = "zebracorn";
const NEUTRAL = "Agents Command Center contributors|noreply@users.noreply.github.com|Agents Command Center contributors|noreply@users.noreply.github.com|Initial public release";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

// A committed repo holding: normal files, a design/ folder and the pattern file itself (both must never be exported, and the planted word in them must not be scanned).
function makeRepo(files: Record<string, string> = {}): string {
  const repo = scratchDir();
  const all: Record<string, string> = {
    "README.md": "# Sample\n",
    "src/app.js": "export const hello = 1;\n",
    "notes/sample.txt": "plain text\n",
    ".packC-map.md": "internal map\n",
    "design/private.txt": `${WORD} lives in design only\n`,
    ".leak-patterns.local": `${WORD}\n`,
    ...files,
  };
  for (const [name, text] of Object.entries(all)) { mkdirSync(dirname(join(repo, name)), { recursive: true }); writeFileSync(join(repo, name), text); }
  git(repo, "init", "-q");
  git(repo, "add", "-A", "-f");
  git(repo, "commit", "-q", "-m", "fixture");
  return repo;
}

function patternFile(text = `# test list\nzebra.?corn\n`): string {
  const file = join(scratchDir(), "patterns.txt");
  writeFileSync(file, text);
  return file;
}

function run(repo: string, target: string, patterns: string, ...flags: string[]) {
  const result = spawnSync(process.execPath, [script, target, ...flags], { encoding: "utf8", windowsHide: true, env: { ...process.env, CC_EXPORT_SOURCE: repo, CC_EXPORT_PATTERNS: patterns } });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const newTarget = () => join(scratchDir(), "out");
const names = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && !entry.parentPath.includes(`${join(dir, ".git")}`)).map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1).replaceAll("\\", "/")).sort();

test("a clean export is one commit by the neutral author, without design/, the pattern file or the internal files, and holds the committed content", () => {
  const repo = makeRepo();
  // Uncommitted edits and new files must never leak: the export reads HEAD.
  writeFileSync(join(repo, "src/app.js"), `export const hello = "${WORD}";\n`);
  writeFileSync(join(repo, "untracked.txt"), `${WORD}\n`);
  const target = newTarget();
  const { code, out, err } = run(repo, target, patternFile());
  assert.equal(code, 0, err);
  const tracked = git(repo, "ls-files").split("\n").filter(Boolean);
  const expected = tracked.filter((name) => !name.startsWith("design/") && name !== ".leak-patterns.local" && name !== ".packC-map.md").sort();
  assert.deepEqual(expected, ["README.md", "notes/sample.txt", "src/app.js"], "control: the fixture tracks the files the test assumes");
  assert.deepEqual(names(target), expected, "tracked files minus the exclusions, nothing else");
  assert.equal(existsSync(join(target, "design")), false);
  assert.equal(existsSync(join(target, ".leak-patterns.local")), false);
  assert.equal(readFileSync(join(target, "src/app.js"), "utf8"), "export const hello = 1;\n", "committed content, not the working tree");
  assert.equal(git(target, "rev-list", "--count", "HEAD").trim(), "1");
  assert.equal(git(target, "log", "-1", "--format=%an|%ae|%cn|%ce|%s").trim(), NEUTRAL);
  assert.match(out, new RegExp(`exported ${expected.length} files, commit ${git(target, "rev-parse", "HEAD").trim()}`));
});

test("a personal word in a copied file stops the export: non-zero, file:line and pattern number printed, nothing written, no git", () => {
  const repo = makeRepo({ "src/bad.js": `one\ntwo\nconst name = "ZebraCorn";\n` });
  const target = newTarget();
  const { code, err } = run(repo, target, patternFile());
  assert.notEqual(code, 0);
  assert.match(err, /src\/bad\.js:3: pattern #2 matched "ZebraCorn"/);
  assert.doesNotMatch(err, /zebra\.\?corn/, "the pattern text itself never reaches the log");
  assert.equal(existsSync(target), false, "nothing was written");
});

test("a personal word in a file NAME stops the export", () => {
  const repo = makeRepo({ [`notes/${WORD}.txt`]: "harmless\n" });
  const target = newTarget();
  const { code, err } = run(repo, target, patternFile());
  assert.notEqual(code, 0);
  assert.match(err, /\(file name\): pattern #2/);
  assert.equal(existsSync(target), false);
});

for (const [label, text, shown] of [
  // Built from parts so this file itself holds no email address or profile path for the export's own scan to find.
  ["an email address", `contact: person@${"gmail"}.com\n`, "person@"],
  ["a Windows user-profile path", `path: ${["C:", "Users", "jdoe"].join("\\\\")}\\\\Documents\n`, "Users"],
  ["a slash-style user-profile path", `path: ${["", "c", "Users", "jdoe"].join("/")}/Documents\n`, "Users"],
  ["a profile folder name with a space", `path: ${["C:", "Users", "example Doe", "x"].join("\\")}\n`, "Users"],
  ["a profile folder name with a dollar sign", `path: ${["C:", "Users", "Jane$Doe", "x"].join("\\")}\n`, "Users"],
  ["a personal gmail address with noreply in the local part", `contact: jane.noreply@${"gmail"}.com\n`, "jane\\.noreply@"],
] as const) {
  test(`the built-in check stops the export on ${label}, with an unrelated test word list`, () => {
    const repo = makeRepo({ "src/leak.js": text });
    const target = newTarget();
    const { code, err } = run(repo, target, patternFile());
    assert.notEqual(code, 0);
    assert.match(err, new RegExp(`src/leak\\.js:1: built-in .*${shown}`));
    assert.equal(existsSync(target), false);
  });
}

test("noreply addresses, example domains and placeholder profile names are not hits", () => {
  const repo = makeRepo({ "src/ok.js": "a noreply@users.noreply.github.com b person@example.com c C:\\\\Users\\\\example\\\\x d C:/Users/runner/work e /c/Users/%USERNAME%/x\n" });
  const { code, err } = run(repo, newTarget(), patternFile());
  assert.equal(code, 0, err);
});

test("a non-empty target, a target inside the repo, a missing pattern file and an empty pattern list are all refused before anything is written", () => {
  const repo = makeRepo();
  const busy = scratchDir();
  writeFileSync(join(busy, "keep.txt"), "mine\n");
  const refusedBusy = run(repo, busy, patternFile());
  assert.equal(refusedBusy.code, 2);
  assert.match(refusedBusy.err, /not empty/);
  assert.deepEqual(readdirSync(busy), ["keep.txt"], "the existing folder is untouched");
  const inside = run(repo, join(repo, "out"), patternFile());
  assert.equal(inside.code, 2);
  assert.match(inside.err, /inside the repo/);
  assert.equal(existsSync(join(repo, "out")), false);
  const missing = run(repo, newTarget(), join(scratchDir(), "nope.txt"));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /pattern file is missing/);
  const target = newTarget();
  const empty = run(repo, target, patternFile("# only a comment\n\n"));
  assert.equal(empty.code, 2);
  assert.match(empty.err, /no patterns/);
  assert.equal(existsSync(target), false);
});

// Built from parts so this file itself holds no email address for the export's own scan to find.
const IZS = `${"i"}@${"izs"}.me`;
test("npm's own glob deprecation text (the one named address, in a lockfile \"deprecated\" value) exports clean", () => {
  const repo = makeRepo({ "package-lock.json": `{\n  "deprecated": "Please update. Support may be purchased by contacting ${IZS}",\n  "x": 1\n}\n` });
  const { code, err } = run(repo, newTarget(), patternFile());
  assert.equal(code, 0, err);
});

for (const [label, file, text] of [
  ["a lockfile author field", "package-lock.json", `{ "author": "${IZS}" }\n`],
  ["a lockfile line after a deprecated line", "package-lock.json", `{ "deprecated": "x",\n  "note": "${IZS}" }\n`],
  ["a different address inside a lockfile deprecated value", "package-lock.json", `{ "deprecated": "write to other@${"izs"}.me" }\n`],
  ["a file that is not the lockfile", "src/deprecated.json", `{ "deprecated": "contact ${IZS}" }\n`],
] as const) {
  test(`the glob deprecation address is still a hit in ${label}`, () => {
    const repo = makeRepo({ [file]: text });
    const target = newTarget();
    const { code, err } = run(repo, target, patternFile());
    assert.notEqual(code, 0);
    assert.match(err, /built-in email address/);
    assert.equal(existsSync(target), false);
  });
}

test("a personal word in a UTF-16 file (either byte order) stops the export", () => {
  for (const [label, encode] of [["LE", (text: string) => Buffer.from(`﻿${text}`, "utf16le")], ["BE", (text: string) => Buffer.from(`﻿${text}`, "utf16le").swap16()]] as const) {
    const repo = makeRepo();
    writeFileSync(join(repo, "notes/wide.txt"), encode(`line one\nconst name = "${WORD}";\n`));
    git(repo, "add", "-A", "-f");
    git(repo, "commit", "-q", "-m", "wide");
    const target = newTarget();
    const { code, err } = run(repo, target, patternFile());
    assert.notEqual(code, 0, `UTF-16${label}`);
    assert.match(err, /notes\/wide\.txt:2: pattern #2/, `UTF-16${label}`);
    assert.equal(existsSync(target), false);
  }
});

test("a target folder whose name merely starts with two dots, inside the repo, is still inside the repo", () => {
  const repo = makeRepo();
  const inside = run(repo, join(repo, "..public"), patternFile());
  assert.equal(inside.code, 2);
  assert.match(inside.err, /inside the repo/);
  assert.equal(existsSync(join(repo, "..public")), false);
});

test("--working-tree scans and copies the working tree (a new file counts, an uncommitted word is caught) and never runs git", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "added.txt"), "new and clean\n");
  const clean = newTarget();
  const ok = run(repo, clean, patternFile(), "--working-tree");
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(names(clean), ["README.md", "added.txt", "notes/sample.txt", "src/app.js"]);
  assert.equal(existsSync(join(clean, ".git")), false, "no git in a working-tree run");
  writeFileSync(join(repo, "src/app.js"), `export const hello = "${WORD}";\n`);
  const bad = newTarget();
  const caught = run(repo, bad, patternFile(), "--working-tree");
  assert.notEqual(caught.code, 0);
  assert.match(caught.err, /src\/app\.js:1: pattern #2/);
  assert.equal(existsSync(bad), false);
});
