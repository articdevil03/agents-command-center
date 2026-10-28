// Asks the CLIs themselves what they support instead of hand-typing lists
// that go stale (see server/config.ts's MODEL_OPTIONS/EFFORT_OPTIONS): the
// claude CLI documents its own --effort choices in --help, and opencode
// prints its full model list via `opencode models`. Both are pure string
// parsers here, proven against real captured output (see
// test/cli-discovery.test.ts), plus an async spawn-based runner that never
// throws and never blocks the event loop -- a missing/broken/hung CLI
// degrades to "no result", never a crash and never a frozen server (see the
// brief: "Nothing in the app may wait on a CLI that might hang" -- this used
// to shell out via spawnSync, which froze output delivery, socket commands
// and kill requests for up to ~20s combined at startup and on every refresh).
//
// codex has no discoverable model or effort list (its --help documents only
// a free-form `-c key=value` override, no enum), so it stays on the
// hand-typed fallback list in config.ts with no discovery attempt at all --
// there is nothing here to ask it.
import { spawn } from "node:child_process";
import { cliSkipFolders, isInsideFolder, leaderChildEnv, spawnTrackedClaude, windowsTaskkillPath, withResolvedCli } from "./leader-common.ts";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, Options } from "@anthropic-ai/claude-agent-sdk";

// Pure: pulls the comma-separated choices out of claude --help's
// "--effort <level> ... (low, medium, high, xhigh, max)" line. --help wraps
// that option across several lines before the parenthetical choices appear,
// so this searches a bounded window after the flag rather than the same line.
export function parseClaudeEffortLevels(helpText: string): string[] | null {
  const match = helpText.match(/--effort <level>[\s\S]{0,400}?\(([a-z][a-z, ]*)\)/i);
  if (!match) return null;
  const levels = match[1].split(",").map((s) => s.trim()).filter(Boolean);
  return levels.length > 0 ? levels : null;
}

// Mirrors server/config.ts's OPENCODE_MODEL_PATTERN/OPENCODE_MODEL_MAX_LEN --
// duplicated rather than imported (config.ts already imports this module, so
// the reverse import would be a cycle). `opencode models` output is a
// subprocess's stdout, not trusted input (see the brief: "treat discovery
// output as untrusted input... parse it strictly and reject anything that is
// not a plain model id") -- a line shaped like shell syntax (spaces, `&`,
// quotes) must never reach OPENCODE_MODEL_SUGGESTIONS, since
// applySeatKindUpdate's cascade assigns suggestion[0] into a seat's model
// field without re-validating it, and that value can end up on a `shell:
// true` command line (see server/runner.ts's buildCommand).
const OPENCODE_MODEL_LINE_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/;
const OPENCODE_MODEL_LINE_MAX_LEN = 100;

// Pure: `opencode models` prints one model id per line and nothing else.
// A line that doesn't look like a plain "provider/model" id is dropped, not
// merely trimmed -- see the pattern's own comment.
export function parseOpencodeModels(stdout: string): string[] | null {
  const lines = stdout.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length <= OPENCODE_MODEL_LINE_MAX_LEN && OPENCODE_MODEL_LINE_PATTERN.test(l));
  return lines.length > 0 ? lines : null;
}

export type Discovered = { values: string[]; fallback: boolean };
type SpawnFn = typeof spawn;

// Never throws, never hangs the event loop, never blocks it either: a missing
// binary, a non-zero exit, or a timeout all just read as "no output" to the
// caller, which is what turns into a `fallback: true` result below. 10s is
// generous for a --help/list call that normally returns in well under a
// second; the timer kills the child rather than leaving it to finish on its
// own, so a genuinely hung CLI can never hold a slot open indefinitely.
// `spawnFn` is injectable (same pattern as runner.ts's `spawnFn: Spawn =
// spawn`) so a test can prove the fallback path fires on a real captured
// failure, without touching PATH or the event loop.
//
// shell:true is required here (proven live: opencode is a Windows .cmd shim
// and fails ENOENT without it; claude happens to work either way) -- but
// Node deprecates (DEP0190) passing a separate `args` array together with
// shell:true, since the shell then concatenates them unsafely. `cmd` and
// `args` are always this module's own hardcoded literals ("claude"/
// "--help", "opencode"/"models"), never user input, so building one command
// string ourselves is exactly the safe pattern Node's own warning asks for.
// The real CLI path is resolved only for the real spawn: an injected fake gets the bare command, so tests never depend on what is installed.
function runCaptured(cmd: string, args: string[], spawnFn: SpawnFn): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    let proc;
    try {
      const env = leaderChildEnv();
      const command = `${cmd} ${args.join(" ")}`;
      proc = spawnFn(spawnFn === spawn ? withResolvedCli(command, env, process.cwd()) : command, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: true, env });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      // Like killSeat: shell:true wraps the CLI, so killing only proc orphans it.
      finish(null); // A late close must not turn a timeout into a successful result.
      if (proc.pid) {
        try {
          const killer = spawnFn(windowsTaskkillPath(), ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
          killer.on("error", () => {}); // Discovery still degrades if taskkill cannot start.
        } catch {
          // A synchronous spawn failure must not crash the server's timer callback.
        }
      }
    }, 10_000);
    timer.unref?.(); // never keeps the process alive on its own if the server is shutting down
    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    proc.on("error", () => finish(null));
    proc.on("close", (code: number | null) => finish(code === 0 && stdout ? stdout : null));
  });
}

// Real discovery. `fallback` names which of the two happened, so the UI can
// say so instead of silently passing off a hardcoded list as a live one.
export async function discoverClaudeEffort(fallback: readonly string[], spawnFn: SpawnFn = spawn): Promise<Discovered> {
  const out = await runCaptured("claude", ["--help"], spawnFn);
  const parsed = out ? parseClaudeEffortLevels(out) : null;
  return parsed ? { values: parsed, fallback: false } : { values: [...fallback], fallback: true };
}

export async function discoverOpencodeModels(fallback: readonly string[], spawnFn: SpawnFn = spawn): Promise<Discovered> {
  const out = await runCaptured("opencode", ["models"], spawnFn);
  const parsed = out ? parseOpencodeModels(out) : null;
  return parsed ? { values: parsed, fallback: false } : { values: [...fallback], fallback: true };
}

// ---- claude's own model list ----
//
// Unlike --effort, claude's --help has no model enum to parse (--model's help
// text is prose: "Provide an alias... or a model's full name"). The real
// catalogue only exists behind the Agent SDK's streaming-input control
// protocol -- Query.supportedModels(), the same handle that carries setModel
// and supportedCommands (see leader.ts) -- which means discovery here has to
// spin up a real (but promptless) Query against the real installed CLI
// rather than parse captured text.
export type ClaudeModelInfo = { value: string; displayName: string; supportsEffort: boolean };
export type DiscoveredClaudeModels = { values: ClaudeModelInfo[]; fallback: boolean };

// Pure: the CLI's init response is untrusted subprocess output like any other
// (see parseOpencodeModels' own comment) -- an entry missing a real `value`
// is dropped rather than passed through with a blank/undefined model id.
export function parseSupportedModels(raw: unknown): ClaudeModelInfo[] | null {
  if (!Array.isArray(raw)) return null;
  const parsed: ClaudeModelInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.value !== "string" || e.value.length === 0) continue;
    const displayName = typeof e.displayName === "string" && e.displayName.length > 0 ? e.displayName : e.value;
    parsed.push({ value: e.value, displayName, supportsEffort: e.supportsEffort === true });
  }
  return parsed.length > 0 ? parsed : null;
}

// An async iterable that is handed to query() purely to satisfy its streaming-
// input-mode requirement (supportedModels() is documented as "only available
// in streaming input mode") -- it must never actually yield a message, since
// yielding one is what sends a real user turn (and a real API call) to the
// CLI. Discovery only wants the CLI's own capability handshake, never a turn.
async function* neverYields(): AsyncGenerator<never> {
  await new Promise<never>(() => {});
}

type QueryFn = (args: { prompt: AsyncIterable<unknown>; options: Options }) => Query;

// Same never-throw/never-hang contract as runCaptured above, for the same
// reason: a missing CLI, a hung child, or a rejected call must all degrade to
// the fallback, never crash the caller or block the event loop past the same
// 10s ceiling. `cliPath` is the real installed CLI (see leader.ts's
// resolveClaudeCli) -- with no real CLI resolved there is nothing to ask, so
// this returns the fallback immediately without ever spawning anything.
// `queryFn` is injectable (default: the real SDK `query`) so a test can prove
// every branch (parse success, empty/rejected result, timeout) without
// spawning a real `claude` subprocess.
export async function discoverClaudeModels(
  fallback: readonly ClaudeModelInfo[],
  cliPath: string | null,
  queryFn: QueryFn = query
): Promise<DiscoveredClaudeModels> {
  if (!cliPath) return { values: [...fallback], fallback: true };
  // Same refusal as the leaders and the health check: a CLI inside a tab or project folder is never started.
  const folder = cliSkipFolders().find((f) => isInsideFolder(cliPath, f));
  if (folder) { console.error(`Claude model discovery skipped: the Claude CLI (${cliPath}) lies inside the workspace folder (${folder})`); return { values: [...fallback], fallback: true }; }
  return new Promise((resolvePromise) => {
    let settled = false;
    const abortController = new AbortController();
    let handle: Query | null = null;
    const finish = (result: DiscoveredClaudeModels) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
      abortController.abort();
      void handle?.return().catch(() => {});
    };
    const timer = setTimeout(() => finish({ values: [...fallback], fallback: true }), 10_000);
    timer.unref?.();
    try {
      // Our own spawn, so aborting also ends whatever the probe's claude.exe started (MCP servers from the user's settings); and the same environment strip as every other child (no data root, no app key).
      handle = queryFn({ prompt: neverYields(), options: { abortController, pathToClaudeCodeExecutable: cliPath, spawnClaudeCodeProcess: spawnTrackedClaude, env: leaderChildEnv() } });
    } catch {
      finish({ values: [...fallback], fallback: true });
      return;
    }
    handle.supportedModels().then(
      (models) => {
        const parsed = parseSupportedModels(models);
        finish(parsed ? { values: parsed, fallback: false } : { values: [...fallback], fallback: true });
      },
      () => finish({ values: [...fallback], fallback: true })
    );
  });
}
