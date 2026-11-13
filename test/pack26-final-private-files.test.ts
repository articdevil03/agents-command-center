import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownedTemp } from "./pack26-review1-run2-helpers.ts";

// A file beside this test's folder; a mutation-proof lane copies only some folders, so a root file it did not copy is read from the repository that holds the lane.
const read = (name: string) => {
  for (const up of ["../", "../../"]) {
    try { return readFileSync(fileURLToPath(new URL(`${up}${name}`, import.meta.url)), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error(`${name} not found`);
};
const PRIVATE = "config/acp-clis.json"; // the owner's added CLI start commands: never read or copied by these tests

test("P26F ACP config is gitignored", (t) => {
  const repo = ownedTemp(t);
  execFileSync("git", ["init", "-q"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, ".gitignore"), read(".gitignore")); // the project's real ignore rules, in an isolated repository
  mkdirSync(join(repo, "config"));
  writeFileSync(join(repo, PRIVATE), "{}"); writeFileSync(join(repo, "config", "workspaces-example.json"), "{}");
  const ignores = (file: string) => spawnSync("git", ["check-ignore", "-q", "--", file], { cwd: repo, windowsHide: true }).status;
  assert.equal(ignores(PRIVATE), 0, "git ignores the ACP config");
  assert.equal(ignores("config/workspaces-example.json"), 1, "control: an ordinary config file is not ignored");
  const status = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: repo, windowsHide: true, encoding: "utf8" });
  assert.ok(!status.includes("acp-clis"), "git status never offers the ACP config for commit");
});

test("P26F ACP config is excluded from package", () => {
  const files: string[] = JSON.parse(read("package.json")).build.files;
  const exclusion = files.indexOf(`!${PRIVATE}`);
  assert.ok(exclusion >= 0, "the package build excludes the ACP config");
  assert.ok(exclusion > files.indexOf("config/**/*"), "the exclusion comes after the config include, so it wins");
});

test("P26F ACP config is excluded from export", () => {
  const script = read("scripts/export-public.mjs");
  const prefixes = script.match(/const EXCLUDE_PREFIXES = (\[[^;]+\]);/)?.[1];
  const names = script.match(/const EXCLUDE_FILES = new Set\((\[[\s\S]*?\])\);/)?.[1];
  const predicate = script.match(/const excluded = (\(path\) => [^;]+);/)?.[1];
  assert.ok(prefixes && names && predicate, "the export selection source was found");
  // The exporter's own predicate, run on its own lists. The exporter drops a path this predicate names even when git tracks it
  // (tracked files are listed by `ls-files -c`, and `excluded(path)` is checked before anything else).
  const excluded = new Function(`const PATTERN_FILE_NAME=".leak-patterns.local"; const EXCLUDE_PREFIXES=${prefixes}; const EXCLUDE_FILES=new Set(${names}); return ${predicate};`)();
  assert.equal(excluded(PRIVATE), true, "a tracked ACP config is still never exported");
  assert.equal(excluded("config/.gitkeep"), false, "control: the tracked placeholder still ships");
  assert.match(script, /if \(excluded\(path\) \|\| ignored\.has\(path\)/, "the exclusion is applied before the ignore list, not instead of it");
});
