import { stripElectronNodeEnv } from "../runtime-env.ts";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { descendantsOf, leaderChildEnv, listProcesses, trackLeaderChild, windowsTaskkillPath, withResolvedCli } from "../leader-common.ts";
import type { RunCli } from "./types.ts";

import { KILL_TIMEOUT_MS, KILL_CONFIRM_MS, LIST_TIMEOUT_MS } from "../leader-common/types.ts";
import { createTreeTracker, watchProcessTree, type ProcInfo } from "../leader-common/process-tree.ts";
import { cliSkipFolders, isInsideFolder, resolveCliOrThrow, resolveCliPath } from "../leader-common/cli-path.ts";
import { CLI_CATALOG } from "./cli-catalog.ts";
import { INSTALL_OUTPUT_CAP } from "./cli-installers.ts";

// Installers receive only OS/runtime locations, never app or provider credentials.
export function installEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|home|appdata|localappdata|programfiles|programfiles\(x86\)|programdata|homedrive|homepath|processor_architecture|number_of_processors)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key)));
}
export function posixCli(name: string, env: NodeJS.ProcessEnv, includeProjects = false): string | null {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!isAbsolute(dir) || (!includeProjects && cliSkipFolders(process.cwd()).some((folder) => isInsideFolder(dir, folder)))) continue;
    const path = join(dir, name);
    try { if (statSync(path).isFile()) return path; } catch { /* not in this directory */ }
  }
  return null;
}

export function installerTree(pid: number, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32") return watchProcessTree(pid, Date.now());
  // The same identity-aware strict tracker, with POSIX process enumeration.
  // This keeps the existing fixed npm route usable outside Windows.
  const list = (): Promise<ProcInfo[] | null> => new Promise((done) => {
    let output = "", overflow = false;
    const helper = spawn("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
      shell: false, stdio: ["ignore", "pipe", "ignore"], env: { ...installEnv(env), LC_ALL: "C" }, cwd: "/",
    });
    trackLeaderChild(helper);
    const timer = setTimeout(() => { helper.kill(); done(null); }, LIST_TIMEOUT_MS);
    helper.stdout?.on("data", (chunk) => {
      if (output.length + chunk.length > 1024 * 1024) { overflow = true; helper.kill(); return; }
      output += chunk;
    });
    helper.once("error", () => { clearTimeout(timer); done(null); });
    helper.once("close", (code) => {
      clearTimeout(timer);
      const rows = output.trim().split(/\r?\n/).map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/));
      if (code !== 0 || overflow || !rows.length || rows.some((row) => !row || !Number.isFinite(Date.parse(row[3])))) { done(null); return; }
      done(rows.map((row) => ({ pid: Number(row![1]), ppid: Number(row![2]), created: Date.parse(row![3]) })));
    });
  });
  return createTreeTracker({ list, kill: async (ownedPid) => {
    try { process.kill(ownedPid, "SIGKILL"); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    await new Promise((done) => setTimeout(done, 100));
    return true;
  } }).watch(pid, Date.now());
}

async function runTrackedInstaller(spawnProcess: typeof spawn, bin: string, args: string[], options: Parameters<RunCli>[2], env: NodeJS.ProcessEnv): ReturnType<RunCli> {
  const signal = options.installer!.signal;
  if (signal.aborted) return { code: -1, stdout: "", stderr: "", cancelled: true, cleanupConfirmed: true };
  if (!options.cwd || cliSkipFolders(process.cwd()).some((folder) => isInsideFolder(options.cwd!, folder))) return { code: -1, stdout: "", stderr: "", cleanupConfirmed: true };
  const shim = /\.(cmd|bat)$/i.test(bin);
  if (shim) {
    if ([bin, ...args].some((value) => /["!%\r\n\0]/.test(value))) return { code: -1, stdout: "", stderr: "", cleanupConfirmed: true };
    args = ["/d", "/s", "/c", `"${[bin, ...args].map(cmdQuote).join(" ")}"`];
    bin = join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  }
  return new Promise((done) => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false, stopping = false, timedOut = false, closed = false, endedAt: number | undefined;
    let child: ReturnType<typeof spawn>;
    try { child = spawnProcess(bin, args, { shell: false, windowsHide: true, detached: false, windowsVerbatimArguments: shim,
      stdio: ["ignore", "pipe", "pipe"], cwd: options.cwd, env: { ...installEnv(env), OPENCODE_DISABLE_AUTOUPDATE: "1", NoDefaultCurrentDirectoryInExePath: "1" } }); }
    catch { done({ code: -1, stdout: "", stderr: "", cleanupConfirmed: true }); return; }
    trackLeaderChild(child);
    const tree = child.pid ? installerTree(child.pid, env) : null;
    const cleanup = async (): Promise<boolean> => {
      if (!child.pid) return true;
      try {
        const swept = await tree!.sweep(endedAt, true);
        if (swept === null || tree!.failed !== 0) return false;
        if (!closed) await new Promise<void>((resolve) => {
          const end = () => { clearTimeout(wait); child.off("close", end); resolve(); };
          const wait = setTimeout(end, KILL_CONFIRM_MS);
          child.once("close", end);
        });
        return closed;
      } catch { return false; }
    };
    const finish = async (code: number, cleaned?: boolean) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      const cleanupConfirmed = cleaned ?? await cleanup();
      done({ code: timedOut ? 124 : code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"),
        cancelled: signal.aborted, cleanupConfirmed, retryCleanup: cleanup });
    };
    const stop = () => {
      if (stopping || finished) return;
      stopping = true;
      // The tracker kills by PID plus creation time and confirms a fresh list.
      void (async () => { const confirmed = await cleanup(); await finish(-1, confirmed); })();
    };
    signal.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", (chunk) => { stdout = Buffer.concat([stdout, Buffer.from(chunk).subarray(0, Math.max(0, INSTALL_OUTPUT_CAP - stdout.length))]); });
    child.stderr?.on("data", (chunk) => { stderr = Buffer.concat([stderr, Buffer.from(chunk).subarray(0, Math.max(0, INSTALL_OUTPUT_CAP - stderr.length))]); });
    child.once("exit", () => { endedAt = Date.now(); });
    child.once("close", (code) => { closed = true; endedAt ??= Date.now(); if (!stopping) void finish(code ?? -1); });
    child.once("error", () => { if (!child.pid) { closed = true; void finish(-1); } else stop(); });
    timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    if (signal.aborted) stop();
  });
}

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
export function cmdQuote(value: string): string { return `"${value.replace(/(\\+)$/, "$1$1")}"`; }

// The descendants of rootPid, for the fallback tree kill; null = the process list could not be read in time.
async function listWindowsProcessDescendants(spawnProcess: typeof spawn, rootPid: number): Promise<number[] | null> {
  const list = await listProcesses(spawnProcess, LIST_TIMEOUT_MS);
  return list ? descendantsOf(list, rootPid) : null;
}

export function createCliRunner(spawnProcess: typeof spawn = spawn, env: NodeJS.ProcessEnv = process.env): RunCli {
  return async (bin, args, options) => {
    if (spawnProcess === spawn && (env.CC_TEST_FAKE_CLI === "1" || process.env.CC_TEST_FAKE_CLI === "1")) return { code: -1, stdout: "", stderr: "", cleanupConfirmed: true };
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string") || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      return { code: -1, stdout: "", stderr: "invalid process arguments" };
    }
    if (options.installer) {
      const installer = process.platform !== "win32" && bin === "npm" ? posixCli(bin, env) : bin;
      if (!installer) return { code: 127, stdout: "", stderr: "", cleanupConfirmed: true };
      return runTrackedInstaller(spawnProcess, installer, args, options, env);
    }
    // A claude/codex/opencode call resolves from PATH to an absolute path (never the project folder) and the child never sees the app key.
    let resolved: string;
    const catalogProgram = CLI_CATALOG.some((entry) => entry.detection?.program === bin);
    try {
      if (process.platform !== "win32" && catalogProgram) {
        const found = posixCli(bin, env);
        if (!found) return { code: posixCli(bin, env, true) ? -1 : 127, stdout: "", stderr: "CLI is unavailable" };
        resolved = found;
      } else resolved = catalogProgram ? resolveCliOrThrow(bin, env, process.cwd(), options.directExecutable === true) : withResolvedCli(bin, env, process.cwd());
    } catch (err) { return { code: catalogProgram && resolveCliPath(bin, env, process.cwd(), true) ? -1 : 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) }; }
    const launcher = resolveLauncher(resolved.replace(/^"(.*)"$/, "$1"), env);
    const { CC_APP_KEY: _appKey, CC_DATA_DIR: _dataRoot, OPENCODE_SERVER_PASSWORD: _password, ...inherited } = env === process.env ? leaderChildEnv() : env;
    const childEnv: NodeJS.ProcessEnv = stripElectronNodeEnv({ ...inherited, ...options.env, OPENCODE_DISABLE_AUTOUPDATE: "1", NoDefaultCurrentDirectoryInExePath: "1" });
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
          ? spawnProcess(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdCommand!], { shell: false, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv, cwd: options.cwd })
          : spawnProcess(launcher, args, { shell: false, windowsHide: true, windowsVerbatimArguments: options.verbatimArgs === true, stdio: ["ignore", "pipe", "pipe"], env: childEnv, cwd: options.cwd });
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
        if (!timingOut) finish((error as NodeJS.ErrnoException).code === "ENOENT" && !catalogProgram ? 127 : -1, stdout, "could not start command");
      });
      child.once("close", (code) => {
        childClosed = true;
        resolveChildClosed();
        if (!timingOut) finish(catalogProgram && code === 127 ? -1 : code ?? -1, stdout, stderr);
      });
    });
  };
}
export const runCli: RunCli = createCliRunner();
