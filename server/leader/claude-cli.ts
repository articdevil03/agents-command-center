import { statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { isFullyQualified } from "../leader-common.ts";

// The native installer puts claude.exe here for whoever runs the app.
const KNOWN_CLAUDE_CLI = `${homedir().replaceAll("\\", "/")}/.local/bin/claude.exe`;

// A .cmd/.bat wrapper cannot be handed to the SDK: pathToClaudeCodeExecutable
// is spawned directly, without a shell, and a script there fails with EINVAL
// on Windows. Only these count as a usable native binary. npm's global folder holds an
// extensionless `claude` (a sh script), claude.cmd and claude.ps1, none of which can be
// started without a shell; the package beside them carries the real claude.exe.
const NATIVE_CLI_NAMES = ["claude.exe", join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")];
const SCRIPT_CLI_NAMES = ["claude.cmd", "claude.bat", "claude"];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isNativeBinary(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext !== ".cmd" && ext !== ".bat";
}

function findInDir(dir: string, names: string[]): string | null {
  for (const name of names) {
    const candidate = join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function parsePathDirs(pathEnv: string): string[] {
  return pathEnv
    .split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1").replace(/[\\/]+$/, ""))
    .filter((entry) => entry && isFullyQualified(entry)); // a relative entry would resolve against whichever folder the SDK spawns in
}

// The SDK bundles its own cli.js, which does not support --effort. The real
// installed CLI does. Resolved once at startup and threaded through, rather
// than re-resolved per leader, so a project switch doesn't re-touch the disk.
export function resolveClaudeCli(env: NodeJS.ProcessEnv = process.env, knownPath: string = KNOWN_CLAUDE_CLI): string | null {
  const fromEnv = env.CLAUDE_CLI_PATH;
  if (fromEnv && isFullyQualified(fromEnv)) { // never a relative path: it would resolve against the tab folder
    if (isFile(fromEnv) && isNativeBinary(fromEnv)) return fromEnv;
    // fromEnv may name a directory (or a non-executable file); look inside it
    // rather than giving up, so CLAUDE_CLI_PATH can point at an install dir.
    const inside = findInDir(fromEnv, NATIVE_CLI_NAMES);
    if (inside) return inside;
  }

  if (isFullyQualified(knownPath) && isFile(knownPath) && isNativeBinary(knownPath)) return knownPath;

  const dirs = parsePathDirs(env.PATH ?? "");
  for (const dir of dirs) {
    const found = findInDir(dir, NATIVE_CLI_NAMES);
    if (found) return found;
  }

  // Nothing native anywhere: report why if a script-only install explains it,
  // then take the degraded (no --effort) path rather than handing the SDK
  // something that cannot start.
  for (const dir of dirs) {
    const script = findInDir(dir, SCRIPT_CLI_NAMES);
    if (script) {
      console.log(`Claude CLI resolution found only a script wrapper (${script}); the SDK cannot launch a .cmd/.bat without a shell on Windows, so it will run without --effort.`);
      return null;
    }
  }
  return null;
}
