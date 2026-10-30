import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "./temp-root.ts";

// Drives the real scripts/line-cap.mjs inside a small throwaway git repo (cwd), with its base set to the first commit.
const script = fileURLToPath(new URL("../scripts/line-cap.mjs", import.meta.url));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
const lines = (count: number): string => "x\n".repeat(count);
function write(repo: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(repo, name)), { recursive: true }); writeFileSync(join(repo, name), text); }
}

// A committed base holding an unchanged 401-line file; returns the repo and the base commit.
function makeRepo(): { repo: string; base: string } {
  const repo = scratchDir();
  write(repo, { "README.md": "# Sample\n", "src/old-big.ts": lines(401) });
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return { repo, base: git(repo, "rev-parse", "HEAD") };
}

function run(repo: string, base: string, ...flags: string[]) {
  const result = spawnSync(process.execPath, [script, ...flags], { cwd: repo, encoding: "utf8", windowsHide: true, env: { ...process.env, CC_LINE_CAP_BASE: base } });
  return { code: result.status, out: result.stdout + result.stderr };
}

test("a changed non-ASCII 401-line file goes red and is named", () => {
  const { repo, base } = makeRepo();
  git(repo, "config", "core.quotePath", "true");
  write(repo, { "src/é-big.ts": lines(401) });
  git(repo, "add", "-A");
  const { code, out } = run(repo, base);
  assert.equal(code, 1, out);
  assert.match(out, /^401 src\/é-big\.ts$/m);
  assert.match(out, /OVER 400: src\/é-big\.ts \(401\)/);
});

test("a changed 401-line file goes red and is named with 401; a changed 400-line file stays green and prints 400", () => {
  const { repo, base } = makeRepo();
  write(repo, { "src/big.ts": lines(401), "src/exact.ts": lines(400) });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  const { code, out } = run(repo, base);
  assert.equal(code, 1);
  assert.match(out, /^401 src\/big\.ts$/m);
  assert.match(out, /^400 src\/exact\.ts$/m);
  assert.match(out, /OVER 400: src\/big\.ts \(401\)$/m);
  assert.doesNotMatch(out, /OVER 400:.*exact/);
  assert.doesNotMatch(out, /old-big/, "an unchanged file is not looked at without --all");
});

test("a changed 400-line file alone is green", () => {
  const { repo, base } = makeRepo();
  write(repo, { "src/exact.ts": lines(400) });
  const { code, out } = run(repo, base);
  assert.equal(code, 0);
  assert.match(out, /^400 src\/exact\.ts$/m);
  assert.match(out, /1 files checked/);
});

test("images, json, the catalogue folder and design/ are reported as skipped, never checked", () => {
  const { repo, base } = makeRepo();
  const skipped = ["public/big.png", "scripts/mutations/page.mjs", "design/mock.html", "data.json"];
  write(repo, Object.fromEntries(skipped.map((file) => [file, lines(900)])));
  const { code, out } = run(repo, base);
  assert.equal(code, 0);
  for (const file of skipped) assert.ok(out.includes(`skipped ${file} (`), `${file} not reported as skipped:\n${out}`);
  assert.match(out, /0 files checked/);
});

test("nothing changed exits 0 and says 0 files checked", () => {
  const { repo, base } = makeRepo();
  const { code, out } = run(repo, base);
  assert.equal(code, 0);
  assert.match(out, /0 files checked/);
});

test("an untracked 401-line file and an uncommitted edit of a tracked one go red", () => {
  const first = makeRepo();
  write(first.repo, { "src/new-big.ts": lines(401) });
  const untracked = run(first.repo, first.base);
  assert.equal(untracked.code, 1);
  assert.match(untracked.out, /OVER 400: src\/new-big\.ts \(401\)/);
  const second = makeRepo();
  write(second.repo, { "README.md": lines(402) });
  const edited = run(second.repo, second.base);
  assert.equal(edited.code, 1);
  assert.match(edited.out, /OVER 400: README\.md \(402\)/);
});

test("--all sees an unchanged 401-line committed file", () => {
  const { repo, base } = makeRepo();
  const { code, out } = run(repo, base, "--all");
  assert.equal(code, 1);
  assert.match(out, /^401 src\/old-big\.ts$/m);
  assert.match(out, /OVER 400: src\/old-big\.ts \(401\)/);
});

test("a deleted file is ignored", () => {
  const { repo, base } = makeRepo();
  git(repo, "rm", "-q", "src/old-big.ts");
  const { code, out } = run(repo, base);
  assert.equal(code, 0);
  assert.match(out, /0 files checked/);
});
