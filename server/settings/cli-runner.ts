import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { descendantsOf, leaderChildEnv, listProcesses, trackLeaderChild, windowsTaskkillPath, withResolvedCli } from "../leader-common.ts";
import type { RunCli } from "./types.ts";

import { KILL_TIMEOUT_MS, KILL_CONFIRM_MS, LIST_TIMEOUT_MS } from "../leader-common/types.ts";

// On Windows shell:false only starts .exe/.com, but npm, codex and opencode are
// .cmd launchers: find the real file the way cmd would (PATH x PATHEXT-style).
function resolveLauncher(bin: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return bin;
  const names = /\.(?:com|exe|bat|cmd)$/i.test(bin) ? [bin] : [".com", ".exe", ".bat", ".cmd"].map((extension) => bin + extension);
  const dirs = /[\\/]/.test(bin) ? [""] : (env.PATH ?? env.Path ?? "").split(";").map((dir) => dir.replace(/^"|"$/g, "")).filter((dir) => dir && resolve(dir).toLowerCase() !== process.cwd().toLowerCase());
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? join(dir, name) : name;
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* not in this folder */ }
    }
  }
  return bin;
}

// A .cmd/.bat runs through cmd.exe /d /s /c with every part in double quotes, so
// & | < > ^ stay literal (no `call`: it would parse the line a second time and double every ^). An argument holding % is handed over
// through the environment, which cmd expands once as plain text. Characters that quotes cannot protect (" ! CR LF NUL) are refused instead of escaped.
const CMD_UNSAFE = /["!\r\n\0]/;
function cmdQuote(value: string): string { return `"${value.replace(/(\\+)$/, "$1$1")}"`; }

// The descendants of rootPid, for the fallback tree kill; null = the process list could not be read in time.
async function listWindowsProcessDescendants(spawnProcess: typeof spawn, rootPid: number): Promise<number[] | null> {
  const list = await listProcesses(spawnProcess, LIST_TIMEOUT_MS);
  return list ? descendantsOf(list, rootPid) : null;
}

export function createCliRunner(spawnProcess: typeof spawn = spawn, env: NodeJS.ProcessEnv = process.env): RunCli {
  return async (bin, args, options) => {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string") || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      return { code: -1, stdout: "", stderr: "invalid process arguments" };
    }
    // A claude/codex/opencode call resolves from PATH to an absolute path (never the project folder) and the child never sees the app key.
    let resolved: string;
    try { resolved = withResolvedCli(bin, env, process.cwd()); } catch (err) { return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) }; }
    const launcher = resolveLauncher(resolved.replace(/^"(.*)"$/, "$1"), env);
    const { CC_APP_KEY: _appKey, ...inherited } = env === process.env ? leaderChildEnv() : env;
    const childEnv: NodeJS.ProcessEnv = { ...inherited, ...options.env, NoDefaultCurrentDirectoryInExePath: "1" };
    const viaCmd = /\.(?:cmd|bat)$/i.test(launcher);
    if (viaCmd && ([launcher, ...args].some((part) => CMD_UNSAFE.test(part)) || launcher.includes("%"))) {
      return { code: -1, stdout: "", stderr: "unsupported characters in command arguments" };
    }
    const cmdCommand = viaCmd ? `"${[cmdQuote(launcher), ...args.map((arg, index) => {
      if (!arg.includes("%")) return cmdQuote(arg);
      childEnv[`CC_ARG_${index}`] = cmdQuote(arg).slice(1, -1);
      return `"%CC_ARG_${index}%"`;
    })].join(" ")}"` : undefined;
    return new Promise((resolveResult) => {
      let stdout = "", stderr = "", settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timingOut = false;
      let childClosed = false;
      let resolveChildClosed!: () => void;
      const childClosedPromise = new Promise<void>((resolve) => { resolveChildClosed = resolve; });
      const finish = (code: number, out = stdout, err = stderr) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveResult({ code, stdout: out, stderr: err });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = viaCmd
          ? spawnProcess(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdCommand!], { shell: false, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv })
          : spawnProcess(launcher, args, { shell: false, windowsHide: true, windowsVerbatimArguments: options.verbatimArgs === true, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
      }
      catch { finish(-1, "", "could not start command"); return; }
      // An npm install or a login can outlive a server shutdown: the exit hook ends it with the rest.
      trackLeaderChild(child);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      timer = setTimeout(() => {
        // A CLI that already exited (a descendant still holds its pipes, so `close` is late) has no tree to kill, and its pid may be someone else's by now.
        const exited = (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;
        if (exited) { child.stdout?.destroy(); child.stderr?.destroy(); }
        if (exited || process.platform !== "win32" || !child.pid) {
          try { child.kill(); } catch { /* the timeout result still settles if the process already exited */ }
          finish(124, stdout, "command timed out");
          return;
        }
        timingOut = true;
        void (async () => {
          let taskkillCode: number | null = null;
          try {
            const killer = spawnProcess(windowsTaskkillPath(), ["/pid", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
            taskkillCode = await new Promise<number | null>((resolveKill) => {
              let done = false;
              const settle = (code: number | null) => {
                if (done) return;
                done = true;
                clearTimeout(killTimer);
                resolveKill(code);
              };
              const killTimer = setTimeout(() => {
                try { killer.kill(); } catch { /* the bounded wait below reports the unconfirmed tree */ }
                settle(null);
              }, KILL_TIMEOUT_MS);
              killer.once("error", () => settle(null));
              killer.once("close", (code) => settle(code));
            });
          } catch { /* the bounded wait below reports the unconfirmed tree */ }

          if (taskkillCode !== 0 && child.pid) {
            // ponytail: taskkill is the normal tree kill; only enumerate when Windows denies it.
            try { child.kill(); } catch { /* the bounded wait below reports the unconfirmed tree */ }
            const descendants = await listWindowsProcessDescendants(spawnProcess, child.pid);
            for (const pid of descendants?.reverse() ?? []) {
              try { process.kill(pid, "SIGTERM"); } catch { /* the bounded wait below reports the unconfirmed tree */ }
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }

          const childGone = childClosed || await new Promise<boolean>((resolveGone) => {
            if (childClosed) { resolveGone(true); return; }
            let done = false;
            let closeTimer: ReturnType<typeof setTimeout>;
            const settle = (gone: boolean) => {
              if (done) return;
              done = true;
              clearTimeout(closeTimer);
              resolveGone(gone);
            };
            closeTimer = setTimeout(() => settle(false), KILL_CONFIRM_MS);
            childClosedPromise.then(() => settle(true));
          });
          const message = taskkillCode === 0 && childGone
            ? "command timed out; process tree terminated"
            : "command timed out; process tree exit not confirmed after bounded wait";
          finish(124, stdout, message);
        })();
      }, options.timeoutMs);
      child.once("error", (error) => {
        if (!timingOut) finish((error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : -1, stdout, "could not start command");
      });
      child.once("close", (code) => {
        childClosed = true;
        resolveChildClosed();
        if (!timingOut) finish(code ?? -1, stdout, stderr);
      });
    });
  };
}
export const runCli: RunCli = createCliRunner();
