import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mutations, pendingMutations, COPIED_PATHS, hasDesignFolder } from "../scripts/mutation-proof.mjs";
import { tempRoot } from "./temp-root.ts";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

// A catalogue entry whose target text is gone aborts the sweep ("mutation target missing"), and one that matches twice may mutate the wrong
// place the moment file order shifts. So every entry, in every file, must find its text exactly once, and a stale one fails here by name.
// There is no list of files or entries that are exempt. pendingMutations (behaviour with no covering test yet) is checked the same way.
type CatalogueEntry = readonly string[];
function readTarget(file: string): string | null {
  try { return readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n"); } catch { return null; }
}
function targetProblems(entries: readonly CatalogueEntry[], read: (file: string) => string | null = readTarget): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const [name, file, from, to] of entries) {
    if (names.has(name)) problems.push(`${name}: listed twice`);
    names.add(name);
    const source = read(file);
    if (source === null) { problems.push(`${name}: target file ${file} does not exist`); continue; }
    if (!from) { problems.push(`${name}: empty target text`); continue; }
    const count = source.split(from).length - 1;
    if (count !== 1) problems.push(`${name}: target text ${count === 0 ? "is missing from" : `matches ${count} times in`} ${file} (expected exactly 1)`);
    if (to === from) problems.push(`${name}: the replacement equals the target, so it changes nothing`);
  }
  return problems;
}

// Intentional source mutations remove their own targets. They must fail a
// behavior test, not this catalogue check. Baseline/restored runs check all entries.
test("every mutation target exists exactly once", { skip: process.env.CC_MUTATION_PROOF === "1" }, () => {
  assert.ok(mutations.length > 500, "control: the catalogue is not empty");
  // Entries on the owner's private design/ folder are checked only where that folder exists (never because one file is missing).
  const present = [...mutations, ...pendingMutations].filter(([, file]) => !file.startsWith("design/") || hasDesignFolder(root));
  assert.ok(present.length > 500, "control: the checked entries are not empty");
  assert.deepEqual(targetProblems(present), []);
});

test("a stale entry is flagged whichever file it points at, and the guard-stale-entry canary injects exactly such an entry", () => {
  for (const file of ["server/index.ts", "server/config.ts", "server/runner.ts", "server/leader-tools.ts", "public/app/01-markdown-state.js", "public/index.html", "public/styles/01-base-bar-rail.css", "electron/main.js"]) {
    assert.deepEqual(targetProblems([["deliberately-stale", file, "THIS TARGET DOES NOT EXIST", ""]]), [`deliberately-stale: target text is missing from ${file} (expected exactly 1)`]);
  }
  assert.deepEqual(targetProblems([["gone", "server/no-such-file.ts", "x", "y"]]), ["gone: target file server/no-such-file.ts does not exist"]);
  assert.deepEqual(targetProblems([["twice", "f", "a", "b"]], () => "a a"), ["twice: target text matches 2 times in f (expected exactly 1)"]);
  assert.deepEqual(targetProblems([["same", "f", "a", "a"]], () => "a"), ["same: the replacement equals the target, so it changes nothing"]);
  const canary = mutations.find(([name]) => name === "guard-stale-entry");
  assert.ok(canary, "the canary entry exists");
  const [, file, from, to] = canary;
  const mutated = readTarget(file)!.replace(from, () => to);
  const injected = mutated.match(/\["deliberately-stale", "([^"]+)", "([^"]+)", ""\]/);
  assert.ok(injected, "mutating the catalogue with the canary injects a deliberately stale entry");
  assert.equal(targetProblems([["deliberately-stale", injected[1], injected[2], ""]]).length, 1, "the injected entry is flagged by the check above");
});

test("pending mutations say why no test covers them, and stay out of the swept catalogue", () => {
  const swept = new Set(mutations.map(([name]) => name));
  for (const [name, , , , why] of pendingMutations) {
    assert.ok(why && why.length > 20, `${name}: say what test is missing`);
    assert.equal(swept.has(name), false, `${name}: listed as both swept and pending`);
  }
});

test("the legacy browser-only environment cannot bypass real browser audits", () => {
  const browserFiles = readdirSync(join(root, "test")).filter((name) => /^browser-.*\.ts$/.test(name));
  assert.ok(browserFiles.length > 0 && browserFiles.includes("browser-real.test.ts") && browserFiles.includes("browser-real-steps-b2.ts"), "control: all browser test parts were found");
  const source = browserFiles.map((name) => readFileSync(join(root, "test", name), "utf8")).join("\n");
  assert.doesNotMatch(source, /if\s*\(\s*process\.env\.CC_BROWSER_ONLY\s*!==\s*["']b2["']\s*\)/, "remove the old CC_BROWSER_ONLY=b2 audit bypass");
  assert.match(source, /CC_BROWSER_DEBUG_ONLY/, "the only audit bypass is explicitly named for local debug use");
});

test("HTTP server and outside-upload roots use OS temp instead of the repository", () => {
  const httpFiles = ["http-helpers.ts", ...readdirSync(join(root, "test")).filter((name) => /^http-.*\.test\.ts$/.test(name))];
  assert.ok(httpFiles.length > 2, "control: the HTTP test files were found");
  const source = httpFiles.map((name) => readFileSync(join(root, "test", name), "utf8")).join("\n");
  assert.match(source, /const root = mkdtempSync\(join\(tmpdir\(\), "cc-http-test-"\)\)/);
  assert.match(source, /const outsideRoot = mkdtempSync\(join\(tmpdir\(\), "cc-http-outside-"\)\)/);
  assert.doesNotMatch(source, /tempRoot\s*\(/, "a killed HTTP test worker must not leave tempRoot directories in the repo");
});

// The mutation tool runs the suite in a disposable copy. A repo path a test reads at load
// that the copy lacks makes every baseline fail with ENOENT, so the copy list must cover them.
// Both syntaxes a test reads the repo with are scanned: join(<repo root>, "a", "b") and a bare relative literal such as
// readFileSync("electron/main.js"), through any of these calls, in the .ts and the .mjs test files. A name counts as the repo root only where
// the file defines it that way (a test's own mkdtemp "root" is not the repo).
const READ_CALLS = "readFileSync|readdirSync|existsSync|statSync|cpSync|createReadStream";
const BARE_READ = new RegExp(`\\b(?:${READ_CALLS})\\(\\s*"([^"/.:][^"]*)"`, "g");
const REPO_NAME_DEFINITION = /\b(?:const|let)\s+(\w+)\s*=\s*(?:realpathSync\()?(?:fileURLToPath\(new URL\("\.\.", import\.meta\.url\)\)|process\.cwd\(\)|resolve\("\."\))/g;
function repoReadsOf(source: string): string[] {
  const names = ["process\\.cwd\\(\\)", ...[...source.matchAll(REPO_NAME_DEFINITION)].map((m) => m[1])];
  const joined = new RegExp(`\\b(?:${READ_CALLS})\\(\\s*join\\(\\s*(?:${names.join("|")})\\s*((?:,\\s*"[^"]+"\\s*)+)\\)`, "g");
  return [
    ...[...source.matchAll(joined)].map((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((part) => part[1]).join("/")),
    ...[...source.matchAll(BARE_READ)].map((m) => m[1]),
  ];
}

test("mutation-proof copies every repo path a test file reads at load", () => {
  // node_modules is not copied: the copy sits inside the repo, so the dependencies resolve from the repo's own folder.
  const covered = (p: string) => /^node_modules(\/|$)/.test(p) || COPIED_PATHS.some((c) => p === c || p.startsWith(`${c}/`));
  for (const required of ["build/icon-source.svg", "build/icon.ico"]) assert.ok(covered(required), `${required} is outside the mutation tool's copy list ${JSON.stringify(COPIED_PATHS)}`);
  let found = 0;
  const uncovered: string[] = [];
  for (const file of readdirSync(join(root, "test")).filter((f) => /\.(ts|mjs)$/.test(f))) {
    for (const target of repoReadsOf(readFileSync(join(root, "test", file), "utf8"))) {
      found++;
      if (!covered(target)) uncovered.push(`test/${file} reads ${target}`);
    }
  }
  assert.deepEqual(uncovered, [], "the mutation tool's copy does not include these");
  assert.ok(found > 20, `control: the scan found only ${found} reads`);
  // The scan itself, on text built from pieces so this file does not match its own scan: a bare relative read and a join from the repo root are
  // seen, a join from some other name is not.
  const sample = "readFile" + 'Sync("electron/main.js", "utf8"); exists' + 'Sync(join(root, "design", "x.svg")); readdir' + 'Sync(join(tmp, "data"))';
  assert.deepEqual(repoReadsOf(`${sample}; const root = process.cwd();`).sort(), ["design/x.svg", "electron/main.js"]);
  assert.deepEqual(repoReadsOf(sample), ["electron/main.js"], "root is not the repo unless the file says so");
});
