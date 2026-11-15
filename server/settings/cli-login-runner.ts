import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { trackLeaderChild } from "../leader-common.ts";
import { resolveCliOrThrow as resolveSafeCliOrThrow, windowsSystem32 } from "../leader-common/cli-path.ts";
import { KILL_CONFIRM_MS } from "../leader-common/types.ts";
import { cmdQuote, installEnv, installerTree, posixCli } from "./cli-runner.ts";
import { catalogTool } from "./cli-catalog-validation.ts";
import type { CliResult } from "./types.ts";
// Authentication always opts into direct native execution; keep the resolved-call boundary shared by login guards.
const resolveCliOrThrow: typeof resolveSafeCliOrThrow = (name, env, cwd) => resolveSafeCliOrThrow(name, env, cwd, true);
export type LoginRunOptions = { cli: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number; output: (chunk: Buffer) => void };
export type LoginChild = { done: Promise<CliResult>; writable: () => boolean; submit: (code: string) => void };
export type RunLogin = (options: LoginRunOptions) => LoginChild;
export function loginEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const vendor = /^(?:CODEX_HOME|CLAUDE_CONFIG_DIR|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  return { ...installEnv(env), ...Object.fromEntries(Object.entries(env).filter(([key]) => vendor.test(key))), OPENCODE_DISABLE_AUTOUPDATE: "1", NoDefaultCurrentDirectoryInExePath: "1" };
}
export function createLoginRunner(spawnProcess?: typeof spawn, treeFactory = installerTree): RunLogin {
  return (options) => {
    let child: ChildProcess | undefined;
    const done = new Promise<CliResult>((resolve) => {
      let entry, program: string, args: string[], bin: string, argv: string[];
      const env = loginEnv(options.env);
      const failed = () => resolve({ code: -1, stdout: "", stderr: "", cleanupConfirmed: true });
      if (!spawnProcess && (options.env.CC_TEST_FAKE_CLI === "1" || process.env.CC_TEST_FAKE_CLI === "1")) { failed(); return; }
      try {
        entry = catalogTool(options.cli);
        if (!entry.signIn.managed || !entry.signIn.command) { failed(); return; }
        const [name, ...fixedArgs] = entry.signIn.command.split(" ");
        if (name !== entry.detection?.program || fixedArgs.some((arg) => !/^[a-z-]+$/.test(arg))) { failed(); return; }
        program = process.platform === "win32" ? resolveCliOrThrow(name, env, process.cwd()) : posixCli(name, env)!;
        if (!program) { failed(); return; }
        args = fixedArgs;
        const shim = /\.(cmd|bat)$/i.test(program);
        if ((shim ? /["!%\r\n\0]/ : /["\r\n\0]/).test(program)) { failed(); return; }
        bin = shim ? join(windowsSystem32(), "cmd.exe") : program;
        argv = shim ? ["/d", "/s", "/c", `"${[program, ...args].map(cmdQuote).join(" ")}"`] : args;
        if (options.signal.aborted) { resolve({ code: -1, stdout: "", stderr: "", cancelled: true, cleanupConfirmed: true }); return; }
        child = (spawnProcess ?? spawn)(bin, argv, { shell: false, windowsHide: true, detached: false, windowsVerbatimArguments: shim,
          cwd: process.platform === "win32" ? windowsSystem32() : "/", env, stdio: ["pipe", "pipe", "pipe"] });
      } catch { failed(); return; }
      trackLeaderChild(child);
      const tree = child.pid ? treeFactory(child.pid, env) : null;
      let closed = false, finished = false, stopping = false, timedOut = false, endedAt: number | undefined;
      let total = 0, timer: ReturnType<typeof setTimeout>;
      const cleanup = async (): Promise<boolean> => {
        if (!child?.pid) return true;
        try {
          const swept = await tree!.sweep(endedAt, true);
          if (swept === null || tree!.failed !== 0) return false;
          if (!closed) await new Promise<void>((done) => {
            const finish = () => { clearTimeout(wait); child!.off("close", finish); done(); };
            const wait = setTimeout(finish, KILL_CONFIRM_MS); child!.once("close", finish);
          });
          return closed;
        } catch { return false; }
      };
      const finish = async (code: number) => {
        if (finished) return;
        finished = true; clearTimeout(timer); options.signal.removeEventListener("abort", stop);
        const cleanupConfirmed = await cleanup();
        child?.stdin?.destroy();
        resolve({ code: timedOut ? 124 : code, stdout: "", stderr: "", cancelled: options.signal.aborted, cleanupConfirmed, retryCleanup: cleanup });
      };
      const stop = () => { if (stopping) return; stopping = true; void finish(-1); };
      const output = (chunk: Buffer) => {
        total += chunk.length;
        if (stopping || finished) return; // drain while cleanup runs
        try {
          options.output(chunk);
          if (total > 1024 * 1024) throw new Error("outputLimit");
        } catch { stop(); }
      };
      child.stdout?.on("data", output); child.stderr?.on("data", output);
      child.stdin?.on("error", stop);
      child.once("exit", (code) => { endedAt = Date.now(); void finish(code ?? -1); });
      child.once("close", (code) => { closed = true; endedAt ??= Date.now(); void finish(code ?? -1); });
      child.once("error", () => { if (!child?.pid) closed = true; stop(); });
      options.signal.addEventListener("abort", stop, { once: true });
      timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
      if (options.signal.aborted) stop();
    });
    return { done, writable: () => !!child?.stdin?.writable && !child.stdin.destroyed && child.exitCode === null && child.signalCode === null,
      submit: (code) => { if (!child?.stdin?.writable || child.stdin.destroyed) throw new Error("Sign-in is not waiting for a code."); child.stdin.write(code + "\n"); } };
  };
}
export const runLogin = createLoginRunner();

// The launcher owns no pipes: a new window may keep running after cmd exits.
export function createDetachedLoginLauncher(spawnProcess?: typeof spawn, env: NodeJS.ProcessEnv = process.env) {
  return async (): Promise<boolean> => {
    if (!spawnProcess && (env.CC_TEST_FAKE_CLI === "1" || process.env.CC_TEST_FAKE_CLI === "1")) return false;
    return new Promise((resolve) => {
      try {
        const child = (spawnProcess ?? spawn)(join(windowsSystem32(), "cmd.exe"), ["/d", "/c", "start", "", "gh", "auth", "login", "--web"],
          { detached: true, stdio: "ignore", windowsHide: true, shell: false, cwd: windowsSystem32(), env: loginEnv(env) });
        child.once("error", () => resolve(false));
        child.once("spawn", () => { child.unref(); resolve(true); });
      } catch { resolve(false); }
    });
  };
}
