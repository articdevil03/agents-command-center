import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "./temp-root.ts";

// Real script subprocesses in isolated throwaway repositories: scripts/line-cap.mjs is executed, never imported.
export const lineCapScript = fileURLToPath(new URL("../scripts/line-cap.mjs", import.meta.url));

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
export const lines = (count: number): string => "x\n".repeat(count);
export function write(repo: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(repo, name)), { recursive: true }); writeFileSync(join(repo, name), text); }
}

// A fresh repository on branch main: no remote and so no origin/master. `commit` holds the files committed first.
export function freshRepo(commit: Record<string, string> = { "README.md": "# Fresh\n" }): string {
  const repo = scratchDir();
  git(repo, "init", "-q", "-b", "main");
  write(repo, commit);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  return repo;
}

// `base` undefined = the DEFAULT base (CC_LINE_CAP_BASE not set at all).
export function runLineCap(cwd: string, base?: string, ...flags: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CC_LINE_CAP_BASE;
  if (base !== undefined) env.CC_LINE_CAP_BASE = base;
  const result = spawnSync(process.execPath, [lineCapScript, ...flags], { cwd, encoding: "utf8", windowsHide: true, env });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// The environment for a child process whose PATH is exactly `pathValue` (every case-variant of PATH removed first).
export function envWithPath(pathValue: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (key.toLowerCase() !== "path") env[key] = value;
  delete env.CC_NO_CRASH_CATCHER; delete env.CC_CRASH_CATCHER_LOG;
  return { ...env, PATH: pathValue, ...extra };
}
