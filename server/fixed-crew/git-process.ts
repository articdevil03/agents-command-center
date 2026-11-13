import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { dirname, extname, isAbsolute, parse, resolve as resolvePath } from "node:path";
import { cliSkipFolders, isInsideFolder, leaderChildEnv, resolveCliOrThrow, windowsSystem32 } from "../leader-common/cli-path.ts";
import { watchProcessTree, type TreeWatch } from "../leader-common/process-tree.ts";
import { GIT_SWEEP_MS, type GitOperation } from "./git-operations.ts";

export const GIT_TIMEOUT_MS = 30_000;
export const GIT_OUTPUT_BYTES = 1024 * 1024;
export const GIT_EXIT_DRAIN_MS = 750;
export type GitCommandResult = {
  command: "success" | "failure" | "unknown"; treeEnded: boolean;
  stdout: string; stderr: string; reason: string | null; code: number | null; signal: string | null;
};
type SpawnGit = (program: string, args: string[], options: SpawnOptions) => ChildProcess;
type Boundary = { spawn: SpawnGit; watch: (pid: number, at: number) => TreeWatch; timeoutMs?: number; drainMs?: number; sweepMs?: number };
let testBoundary: Boundary | undefined;
export function setGitProcessBoundaryForTests(boundary?: Boundary): void {
  if (process.env.CC_TEST_FAKE_CLI !== "1") throw new Error("Git process injection requires the fake CLI harness.");
  testBoundary = boundary;
}
// Hooks, filters, signing, credentials and transports keep their repository semantics.
// Suppress fsmonitor and signature display, and disable automatic maintenance for this command.
export function runGitCommand(op: GitOperation, folder: string, args: string[]): Promise<GitCommandResult> {
  if (op.cancelled) throw new Error("Git operation was cancelled.");
  const env = leaderChildEnv();
  const executable = resolveCliOrThrow("git", env, folder);
  const cwd = windowsSystem32();
  const inside = (file: string, root: string) => isInsideFolder(file, root)
    || dirname(resolvePath(root)) === resolvePath(root) && parse(file).root.toLowerCase() === parse(resolvePath(root)).root.toLowerCase();
  if (!isAbsolute(executable) || /\.(cmd|bat)$/i.test(extname(executable))
    || cliSkipFolders(folder).some((root) => inside(executable, root) || inside(cwd, root))) {
    throw new Error("Git requires an absolute native executable and trusted cwd outside all project folders; batch wrappers are unsupported.");
  }
  // Global literal pathspecs preserve pack paths containing [, *, ? or :(magic).
  const argv = ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "--literal-pathspecs", "-C", folder, ...args];
  const boundary = testBoundary;
  return new Promise((resolve) => {
    let child: ChildProcess | undefined, watch: TreeWatch | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, drain: ReturnType<typeof setTimeout> | undefined;
    let finalizing = false, exitedAt: number | undefined, bytes = 0;
    let completed = false, rootObserved = false;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    let command: GitCommandResult["command"] = "unknown", code: number | null = null, signal: string | null = null;
    let reason: string | null = null;
    function observeRoot(exitCode: number | null, exitSignal: string | null): void {
      if (completed || rootObserved) return;
      rootObserved = true;
      code = exitCode; signal = exitSignal; exitedAt = Date.now();
      if (command !== "failure") command = exitCode === 0 ? "success" : "failure";
    }
    const finish = (failure?: string): void => {
      if (finalizing) return;
      finalizing = true;
      reason ??= failure ?? null;
      clearTimeout(timer); clearTimeout(drain);
      const cleanup = async () => {
        let treeEnded = !child?.pid;
        if (watch) {
          let cap: ReturnType<typeof setTimeout> | undefined;
          // Retain the underlying sweep even when the reporting cap wins.
          const swept = watch.sweep(exitedAt, true);
          op.cleanup.add(swept);
          void swept.then(() => op.cleanup.delete(swept), () => op.cleanup.delete(swept));
          try {
            const result = await Promise.race([swept,
              new Promise<null>((done) => { cap = setTimeout(() => done(null), boundary?.sweepMs ?? GIT_SWEEP_MS); })]);
            treeEnded = result !== null && watch.failed === 0;
          } catch { treeEnded = false; }
          finally { clearTimeout(cap); }
        }
        if (!treeEnded && child?.pid && child.exitCode === null && child.signalCode === null && exitedAt === undefined) {
          // An unreadable list cannot prove descendants gone, but must not prevent Stop of the OWNED root handle.
          try { child.kill(); } catch { /* unknown tree and its tracked identities remain retained */ }
        }
        op.treesEnded &&= treeEnded;
        op.cancelChild = null;
        child?.stdout?.off("data", onStdout); child?.stderr?.off("data", onStderr);
        child?.stdout?.destroy(); child?.stderr?.destroy();
        // Retain an error listener for late error/exit/close races. It cannot finalize twice.
        completed = true;
        resolve({ command, code, signal, reason, treeEnded, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
      };
      void cleanup().catch((error) => {
        op.treesEnded = false; op.cancelChild = null;
        completed = true;
        resolve({ command, code, signal, treeEnded: false, stdout: "", stderr: "", reason: String(error) });
      });
    };
    const output = (chunk: Buffer | string, error: boolean) => {
      if (finalizing) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > GIT_OUTPUT_BYTES) { finish("Git output exceeded 1 MiB."); return; }
      if (error) stderr = Buffer.concat([stderr, data]); else stdout = Buffer.concat([stdout, data]);
    };
    const onStdout = (chunk: Buffer) => output(chunk, false);
    const onStderr = (chunk: Buffer) => output(chunk, true);
    try {
      if (op.cancelled) { finish("Git operation was cancelled."); return; }
      child = (boundary?.spawn ?? spawn)(executable, argv, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      if (child.pid) watch = (boundary?.watch ?? watchProcessTree)(child.pid, Date.now());
      child.stdout?.on("data", onStdout); child.stderr?.on("data", onStderr);
      child.on("error", (error) => { if (completed) return; command = "failure"; finish(`Git spawn/process error: ${error.message}`); });
      child.once("exit", (exitCode, exitSignal) => {
        observeRoot(exitCode, exitSignal);
        if (finalizing) return;
        drain = setTimeout(() => finish("Git exit pipe drain reached its bound."), boundary?.drainMs ?? GIT_EXIT_DRAIN_MS);
      });
      child.once("close", (exitCode, exitSignal) => {
        observeRoot(exitCode, exitSignal);
        if (finalizing) return;
        finish();
      });
      op.cancelChild = () => finish("Git operation was cancelled.");
      timer = setTimeout(() => finish("Git command timed out after 30,000 ms; external result is unknown."), boundary?.timeoutMs ?? GIT_TIMEOUT_MS);
      if (op.cancelled) op.cancelChild();
    } catch (error) { command = "failure"; finish(`Git spawn failed: ${(error as Error).message}`); }
  });
}
